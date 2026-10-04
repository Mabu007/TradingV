"""The server-side market monitor.

One loop, not one per tracker. Each tick it:

1. refreshes the candle series that *active* trackers actually need,
2. builds one evaluation context per symbol from the shared store,
3. evaluates every enabled tracker for that symbol, and
4. asks each tracker's edge detector whether this is a wake.

A wake produces a structured ``AI_WAKE`` event and nothing else. The
engine has no execution path. Turning a wake into a trade happens in the
application, through the existing policy, risk, and demo adapter.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from . import contract
from .catalogue import CATEGORIES
from .config import EngineConfig, load_config
from .edge import EdgeDetector, WakePolicy
from .evaluator import EvaluationContext, evaluate_tree, explain
from .events import EventLog, EventType, event_log
from .marketdata import HyperliquidMarketData, Instrument, MarketDataError
from .store import CandleStore, IndicatorCache, MonitorContextBuilder

DEFAULT_TIMEFRAMES = ("5m", "15m", "1h")


@dataclass
class TrackerSpec:
    """A configured tracker, as the monitor sees it."""

    id: str
    goat_id: str
    name: str
    definition: dict[str, Any]
    #: Frozen at enable time so a running GOAT is not mutated by an edit.
    version: int = 1

    @property
    def market(self) -> str:
        return str(self.definition.get("market", ""))

    @property
    def timeframe(self) -> str | None:
        value = self.definition.get("timeframe")
        return str(value) if value else None

    @property
    def policy(self) -> WakePolicy:
        return WakePolicy.from_definition(self.definition)

    def timeframes(self) -> list[str]:
        """Every timeframe this tracker's tree references."""
        found: set[str] = set()
        if self.timeframe:
            found.add(self.timeframe)

        root = self.definition.get("root") or {}
        for leaf in contract.leaf_nodes(root):
            if leaf.get("enabled") is False:
                continue
            for key in ("timeframe",):
                value = leaf.get(key)
                if value:
                    found.add(str(value))
            for side in ("left", "right"):
                entry = leaf.get(side)
                if isinstance(entry, dict) and entry.get("timeframe"):
                    found.add(str(entry["timeframe"]))

        return sorted(found or {self.timeframe or DEFAULT_TIMEFRAMES[1]})

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "goatId": self.goat_id,
            "name": self.name,
            "version": self.version,
            "market": self.market,
            "timeframe": self.timeframe,
            "then": "WAKE_AI",
        }


@dataclass
class WakeEvent:
    """A structured request to wake the AI. It is not an order."""

    type: str = "AI_WAKE"
    goat_id: str = ""
    tracker_id: str = ""
    tracker_name: str = ""
    tracker_version: int = 1
    market: str = ""
    timeframe: str = ""
    timestamp: int = 0
    environment: str = "DEMO"
    reason: str = ""
    conditions: dict[str, Any] = field(default_factory=dict)
    #: Compact investigation context for the AI. Deliberately small.
    context: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "goatId": self.goat_id,
            "trackerId": self.tracker_id,
            "trackerName": self.tracker_name,
            "trackerVersion": self.tracker_version,
            "market": self.market,
            "timeframe": self.timeframe,
            "timestamp": self.timestamp,
            "environment": self.environment,
            "reason": self.reason,
            "conditions": self.conditions,
            "context": self.context,
        }


class MarketMonitor:
    """
    Shared market monitor.

    ``tick`` is synchronous and side-effect free apart from the caches,
    which makes the whole monitor testable with fixture candles and a
    fake clock, with no threads and no sleeping.
    """

    def __init__(
        self,
        market_data: HyperliquidMarketData | None = None,
        config: EngineConfig | None = None,
        log: EventLog | None = None,
        clock: Callable[[], int] | None = None,
    ) -> None:
        self.config = config or load_config()
        self.market_data = market_data or HyperliquidMarketData(self.config)
        self.log = log or event_log
        self._clock = clock or (lambda: int(time.time() * 1000))
        self.store = CandleStore(self._fetch, self.config)
        self.store.set_clock(self._clock)
        self.cache = IndicatorCache()
        self.trackers: dict[str, TrackerSpec] = {}
        self.detectors: dict[str, EdgeDetector] = {}
        self._instruments: dict[str, Instrument] = {}
        self._account: Mapping[str, Any] | None = None
        self._positions: tuple[Mapping[str, Any], ...] = ()
        self._spread: float | None = None
        self._running = False
        #: Wakes produced since start, newest last. Bounded.
        self.wakes: list[WakeEvent] = []

    # ------------------------------------------------------------ wiring

    def _fetch(self, symbol: str, timeframe: str) -> Any:
        return self.market_data.candles(symbol, timeframe, limit=self.config.history)

    def set_clock(self, clock: Callable[[], int]) -> None:
        self._clock = clock
        self.store.set_clock(clock)

    def load_instruments(self) -> list[Instrument]:
        instruments = self.market_data.load_instruments()
        self._instruments = {item.provider_symbol: item for item in instruments}
        return instruments

    def register(self, tracker: TrackerSpec) -> None:
        """Register a tracker. Its condition tree must be canonical."""
        contract.validate_tree(tracker.definition)
        self.trackers[tracker.id] = tracker
        self.detectors[tracker.id] = EdgeDetector(tracker.id, tracker.policy)

    def unregister(self, tracker_id: str) -> bool:
        self.detectors.pop(tracker_id, None)
        return self.trackers.pop(tracker_id, None) is not None

    def replace(self, tracker: TrackerSpec) -> None:
        """
        Swap a tracker for a new version.

        The debounce state is deliberately *reset*, because a new
        condition tree is a different question as far as the user is
        concerned and should get a fresh chance to be observed.
        """
        self.register(tracker)

    def set_account(self, account: Mapping[str, Any] | None) -> None:
        self._account = account

    def set_positions(self, positions: Iterable[Mapping[str, Any]]) -> None:
        self._positions = tuple(positions)

    def set_spread(self, spread: float | None) -> None:
        self._spread = spread

    @property
    def account(self) -> Mapping[str, Any] | None:
        return self._account

    @property
    def positions(self) -> tuple[Mapping[str, Any], ...]:
        return self._positions

    @property
    def spread(self) -> float | None:
        return self._spread

    def instrument_json(self) -> dict[str, dict[str, Any]]:
        return {symbol: item.to_json() for symbol, item in self._instruments.items()}

    def instrument(self, symbol: str) -> Instrument | None:
        return self._instruments.get(symbol)

    # -------------------------------------------------------------- state

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self.log.emit(EventType.ENGINE_STARTED, "Condition engine started.", data={"liveTrading": False})

    def stop(self) -> None:
        self._running = False
        self.log.emit(EventType.ENGINE_STOPPED, "Condition engine stopped.")

    @property
    def running(self) -> bool:
        return self._running

    def required_series(self) -> list[tuple[str, str]]:
        """
        Every (market, timeframe) an enabled tracker needs.

        The monitor prefetches exactly this set, so an unused market is
        never polled and an unused indicator is never computed.
        """
        needed: set[tuple[str, str]] = set()
        for tracker in self.trackers.values():
            if not tracker.policy.enabled:
                continue
            if not tracker.market:
                continue
            for timeframe in tracker.timeframes():
                needed.add((tracker.market, timeframe))
        return sorted(needed)

    # ---------------------------------------------------------------- tick

    def refresh(self) -> list[str]:
        """Refresh every required series once. Returns the failures."""
        failures: list[str] = []
        for symbol, timeframe in self.required_series():
            instrument = self._instruments.get(symbol)
            if instrument is not None and not instrument.tradeable:
                continue
            before = self.store.fetch_count
            entry = self.store.get(symbol, timeframe, refresh=True)
            if entry is None or self.store.fetch_count == before:
                failures.append(f"{symbol} {timeframe}")
                self.log.emit(
                    EventType.MARKET_DATA_UNAVAILABLE,
                    f"No candle data for {symbol} {timeframe}.",
                    symbol=symbol,
                    timeframe=timeframe,
                )
            else:
                self.cache.invalidate(symbol, timeframe)
                self.log.emit(
                    EventType.MARKET_DATA_UPDATED,
                    f"Refreshed {symbol} {timeframe}.",
                    symbol=symbol,
                    timeframe=timeframe,
                    data={"bars": len(entry.series)},
                )
        return failures

    def evaluate_all(self, now_ms: int | None = None) -> list[WakeEvent]:
        """Evaluate every registered tracker once. Returns new wakes."""
        moment = now_ms if now_ms is not None else self._clock()
        produced: list[WakeEvent] = []

        by_symbol: dict[str, list[TrackerSpec]] = {}
        for tracker in self.trackers.values():
            if not tracker.policy.enabled or not tracker.market:
                continue
            by_symbol.setdefault(tracker.market, []).append(tracker)

        for symbol, trackers in by_symbol.items():
            builder = MonitorContextBuilder(
                store=self.store,
                cache=self.cache,
                instruments=self.instrument_json(),
                account=self._account,
                positions=self._positions,
                spread=self._spread,
            )
            context = builder.for_symbol(
                symbol,
                {timeframe for tracker in trackers for timeframe in tracker.timeframes()},
                moment,
                require_tradeable=bool(tracker_requiring_tradeable(trackers)),
            )

            for tracker in trackers:
                wake = self._evaluate_tracker(tracker, context, moment)
                if wake is not None:
                    produced.append(wake)

        self.wakes.extend(produced)
        if len(self.wakes) > 500:
            del self.wakes[: len(self.wakes) - 500]
        return produced

    def tick(self, now_ms: int | None = None) -> list[WakeEvent]:
        """One full cycle: refresh, then evaluate."""
        self.refresh()
        return self.evaluate_all(now_ms)

    def _evaluate_tracker(self, tracker: TrackerSpec, context: EvaluationContext, moment: int) -> WakeEvent | None:
        try:
            result = evaluate_tree(tracker.definition, context)
        except Exception as error:
            self.log.emit(
                EventType.ERROR,
                f"Condition evaluation failed: {error}",
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                symbol=tracker.market,
            )
            return None

        detector = self.detectors.get(tracker.id)
        if detector is None:
            detector = self.detectors[tracker.id] = EdgeDetector(tracker.id, tracker.policy)

        decision = detector.observe(result.status, moment)

        payload = {
            "overall": result.status,
            "summary": result.summary,
            "conditions": [item.to_json() for item in result.flat()],
        }

        self.log.emit(
            EventType.CONDITION_EVALUATED,
            f"{tracker.name}: {result.status}",
            goat_id=tracker.goat_id,
            tracker_id=tracker.id,
            symbol=tracker.market,
            timeframe=tracker.timeframe,
            data={"overall": result.status, "wakeDecision": decision.decision.value},
        )

        if decision.decision.value == "FIRED":
            wake = WakeEvent(
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                tracker_name=tracker.name,
                tracker_version=tracker.version,
                market=tracker.market,
                timeframe=tracker.timeframe or "",
                timestamp=moment,
                reason=self._reason(tracker, result),
                conditions=payload,
                context=self._investigation_context(tracker, context, result),
            )
            self.log.emit(
                EventType.TRACKER_OBSERVED,
                wake.reason,
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                symbol=tracker.market,
                timeframe=tracker.timeframe,
                data={"conditions": payload["overall"]},
            )
            self.log.emit(
                EventType.AI_WAKE_REQUESTED,
                wake.reason,
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                symbol=tracker.market,
                timeframe=tracker.timeframe,
                data=wake.to_json(),
            )
            return wake

        if result.status == "UNKNOWN":
            self.log.emit(
                EventType.TRACKER_UNKNOWN,
                "Conditions could not be evaluated; the AI was not woken.",
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                symbol=tracker.market,
                data={"reason": result.reason or "A condition could not be measured."},
            )
        else:
            self.log.emit(
                EventType.TRACKER_SUPPRESSED,
                decision.reason,
                goat_id=tracker.goat_id,
                tracker_id=tracker.id,
                symbol=tracker.market,
                data=decision.to_json(),
            )

        return None

    def _reason(self, tracker: TrackerSpec, result: Any) -> str:
        held = [item.summary for item in result.flat() if item.status == "TRUE"]
        base = result.summary
        if held:
            return f"{base} ({'; '.join(held)})"
        return base

    def _investigation_context(self, tracker: TrackerSpec, context: EvaluationContext, result: Any) -> dict[str, Any]:
        """
        The investigation context handed to the AI.

        Small and read-only: what was observed, the current price and spread, the
        recent candles, and the account/position facts the condition
        engine already holds. No keys, no signing material, no internals.
        """
        series = context.series.get(tracker.timeframe or "15m") if tracker.timeframe else None
        recent: list[dict[str, float]] = []
        if series is not None and len(series.close):
            start = max(0, len(series.close) - 20)
            recent = [
                {
                    "open": float(series.open[index]),
                    "high": float(series.high[index]),
                    "low": float(series.low[index]),
                    "close": float(series.close[index]),
                }
                for index in range(start, len(series.close))
            ]

        positions = [dict(item) for item in context.positions if item.get("symbol") == tracker.market]

        return {
            "tracker": tracker.definition.get("name", tracker.name),
            "market": tracker.market,
            "timeframe": tracker.timeframe,
            "conditions": [{"summary": item.summary, "status": item.status, "value": item.value} for item in result.flat()],
            "price": context.price,
            "spread": context.spread,
            "recentCandles": recent,
            "positions": positions,
            "account": dict(context.account) if context.account else None,
        }

    # ---------------------------------------------------------- inspection

    def status(self, now_ms: int | None = None) -> dict[str, Any]:
        moment = now_ms if now_ms is not None else self._clock()
        return {
            "running": self._running,
            "liveTradingEnabled": False,
            "trackedSeries": [{"symbol": symbol, "timeframe": timeframe} for symbol, timeframe in self.store.tracked()],
            "requiredSeries": [{"symbol": symbol, "timeframe": timeframe} for symbol, timeframe in self.required_series()],
            "trackers": [self.tracker_status(tracker.id, moment) for tracker in self.trackers.values()],
            "fetchCount": self.store.fetch_count,
            "indicatorComputations": self.cache.computation_count,
            "wakeCount": len(self.wakes),
        }

    def tracker_status(self, tracker_id: str, now_ms: int | None = None) -> dict[str, Any] | None:
        tracker = self.trackers.get(tracker_id)
        detector = self.detectors.get(tracker_id)
        if tracker is None or detector is None:
            return None
        moment = now_ms if now_ms is not None else self._clock()
        payload = detector.snapshot(moment)
        payload["tracker"] = tracker.to_json()
        return payload

    def latest_wakes(self, limit: int = 20) -> list[dict[str, Any]]:
        return [wake.to_json() for wake in reversed(self.wakes[-limit:])]

    def catalogue(self) -> dict[str, Any]:
        from .catalogue import catalogue_json

        return catalogue_json()


def tracker_requiring_tradeable(trackers: Iterable[TrackerSpec]) -> bool:
    """True when any tracker asked to require a tradeable market."""
    return any(bool(tracker.definition.get("requireTradeableMarket", True)) for tracker in trackers)
