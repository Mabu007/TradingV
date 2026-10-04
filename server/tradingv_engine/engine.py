"""The condition engine.

This is the piece that runs continuously. It owns:

* the shared :class:`MarketMonitor`, which decides when a condition tree
  has produced a new ``FALSE -> TRUE`` edge;
* one polling loop, rather than one loop per tracker or per market;
* the wake queue, which hands structured ``AI_WAKE`` events to the web app
  and remembers which ones were acknowledged.

The engine has no execution capability. It cannot place, size, approve or
cancel an order, it holds no credentials, and it never receives a price to
trade at. The furthest thing it does is say "the conditions the user
wrote are now true, and here is the evidence". What happens next belongs
to the app, behind the existing policy, risk and DEMO execution guard.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from . import contract
from .config import EngineConfig, load_config
from .edge import WakePolicy
from .evaluator import EvaluationContext
from .events import EventLog, EventType
from .marketdata import HyperliquidMarketData, MarketDataError
from .monitor import MarketMonitor, TrackerSpec, WakeEvent
from .store import MonitorContextBuilder

_REPO_ROOT = Path(__file__).resolve().parents[2]
_EXAMPLES_PATH = _REPO_ROOT / "shared" / "condition_examples.json"


@dataclass
class QueuedWake:
    """A wake plus its delivery bookkeeping."""

    id: str
    event: WakeEvent
    acknowledged: bool = False
    acknowledged_at_ms: int = 0

    def to_json(self) -> dict[str, Any]:
        payload = self.event.to_json()
        payload["wakeId"] = self.id
        payload["acknowledged"] = self.acknowledged
        if self.acknowledged:
            payload["acknowledgedAt"] = self.acknowledged_at_ms
        return payload


class ConditionEngine:
    """
    Owns the monitor, the polling loop, and the wake queue.

    Constructing an engine does no I/O. ``start`` begins the loop; nothing
    runs until then, so tests can drive ``tick_once`` directly with fixtures
    and never touch the network or a clock.
    """

    #: How many wakes are retained for the UI to collect.
    WAKE_CAPACITY = 200

    def __init__(
        self,
        config: EngineConfig | None = None,
        market_data: HyperliquidMarketData | None = None,
        log: EventLog | None = None,
        clock: Callable[[], int] | None = None,
        monitor: MarketMonitor | None = None,
    ) -> None:
        self.config = config or load_config()
        self.monitor = monitor or MarketMonitor(
            market_data=market_data or HyperliquidMarketData(self.config),
            config=self.config,
            log=log,
            clock=clock,
        )
        self.log = self.monitor.log
        self._queue: list[QueuedWake] = []
        self._sequence = 0
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._wake_listeners: list[Callable[[QueuedWake], Any]] = []
        self._fixture_contexts: dict[str, EvaluationContext] | None = None

    # --------------------------------------------------------- convenience

    @property
    def trackers(self) -> dict[str, TrackerSpec]:
        return self.monitor.trackers

    @property
    def running(self) -> bool:
        return self.monitor.running

    def set_clock(self, clock: Callable[[], int]) -> None:
        self.monitor.set_clock(clock)

    # ------------------------------------------------------------- wiring

    async def load_instruments(self) -> list[Any]:
        """Discover the tradable universe. Public metadata only."""
        try:
            instruments = await asyncio.to_thread(self.monitor.load_instruments)
        except MarketDataError as error:
            self.log.emit(
                EventType.MARKET_DATA_UNAVAILABLE,
                f"Could not read the market list: {error}",
            )
            raise
        self.log.emit(
            EventType.MARKET_DATA_UPDATED,
            f"Loaded {len(instruments)} markets.",
            data={"count": len(instruments)},
        )
        return instruments

    def register(self, payload: Mapping[str, Any]) -> TrackerSpec:
        """Register a tracker from a request body, validating first."""
        definition = dict(payload.get("definition") or {})
        if not definition.get("market"):
            definition["market"] = str(payload.get("market", ""))
        contract.validate_tree(definition)

        tracker = TrackerSpec(
            id=str(payload["id"]),
            goat_id=str(payload.get("goatId") or payload.get("goat_id") or ""),
            name=str(payload.get("name") or definition.get("name") or payload["id"]),
            definition=definition,
            version=int(payload.get("version") or 1),
        )
        self.monitor.register(tracker)
        return tracker

    def unregister(self, tracker_id: str) -> bool:
        return self.monitor.unregister(tracker_id)

    def set_account(self, account: Mapping[str, Any] | None) -> None:
        self.monitor.set_account(account)

    def set_positions(self, positions: Any) -> None:
        self.monitor.set_positions(positions)

    def set_spread(self, spread: float | None) -> None:
        self.monitor.set_spread(spread)

    # ---------------------------------------------------------- evaluation

    def trackers_for_market(self, market: str) -> TrackerSpec | None:
        for tracker in self.trackers.values():
            if tracker.market == market:
                return tracker
        return None

    def context_for(self, tracker: TrackerSpec, now_ms: int | None = None) -> EvaluationContext:
        """Build the evaluation context a tracker would see right now."""
        moment = now_ms if now_ms is not None else int(time.time() * 1000)
        builder = MonitorContextBuilder(
            store=self.monitor.store,
            cache=self.monitor.cache,
            instruments=self.monitor.instrument_json(),
            account=self.monitor.account,
            positions=self.monitor.positions,
            spread=self.monitor.spread,
        )
        return builder.for_symbol(
            tracker.market,
            set(tracker.timeframes()),
            moment,
            require_tradeable=bool(tracker.definition.get("requireTradeableMarket", True)),
        )

    def fixture_context(self, name: str) -> EvaluationContext:
        """
        An evaluation context built from a committed OHLCV fixture.

        Testing against fixtures is what makes a draft tracker's behaviour
        reviewable: the same request produces the same result today, in CI,
        and in six months.
        """
        if self._fixture_contexts is None:
            self._fixture_contexts = _load_fixture_contexts()
        try:
            return self._fixture_contexts[name]
        except KeyError as error:
            available = ", ".join(sorted(self._fixture_contexts))
            raise KeyError(f"Unknown fixture context {name!r}. Available: {available}.") from error

    def fixture_context_names(self) -> list[str]:
        if self._fixture_contexts is None:
            self._fixture_contexts = _load_fixture_contexts()
        return sorted(self._fixture_contexts)

    def describe_fixture_context(self, name: str) -> dict[str, Any]:
        """Enough about a fixture for the builder to label a picker entry."""
        context = self.fixture_context(name)
        return {
            "symbol": context.symbol,
            "timeframes": sorted(context.series),
            "bars": {timeframe: len(series) for timeframe, series in sorted(context.series.items())},
            "lastClose": {timeframe: float(series.close[-1]) for timeframe, series in sorted(context.series.items()) if len(series.close)},
        }

    # ------------------------------------------------------------ wake queue

    def on_wake(self, listener: Callable[[QueuedWake], Any]) -> Callable[[QueuedWake], Any]:
        self._wake_listeners.append(listener)
        return listener

    def pending_wakes(self) -> list[dict[str, Any]]:
        return [item.to_json() for item in self._queue if not item.acknowledged]

    def acknowledge_wake(self, wake_id: str) -> bool:
        for item in self._queue:
            if item.id == wake_id and not item.acknowledged:
                item.acknowledged = True
                item.acknowledged_at_ms = int(time.time() * 1000)
                self.log.emit(
                    EventType.GOAT_STATE_CHANGED,
                    "The app acknowledged an AI wake.",
                    goat_id=item.event.goat_id,
                    tracker_id=item.event.tracker_id,
                    symbol=item.event.market,
                    data={"wakeId": wake_id},
                )
                return True
        return False

    def _enqueue(self, wake: WakeEvent) -> QueuedWake:
        self._sequence += 1
        queued = QueuedWake(id=f"wake_{self._sequence:06d}", event=wake)
        self._queue.append(queued)
        if len(self._queue) > self.WAKE_CAPACITY:
            del self._queue[: len(self._queue) - self.WAKE_CAPACITY]
        for listener in self._wake_listeners:
            with contextlib.suppress(Exception):
                listener(queued)
        return queued

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        """Begin monitoring. Idempotent."""
        if self._task is not None:
            return
        self.monitor.start()
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="tradingv-condition-engine")

    async def stop(self) -> None:
        self._stopping.set()
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.monitor.stop()

    async def _loop(self) -> None:
        """
        One loop for every tracker.

        The interval is the minimum of the venue poll interval and the
        shortest evaluation interval any tracker asked for, so a 1m
        tracker is not evaluated on a 5m cadence. The sleep is interruptible
        so ``stop`` does not have to wait out a full interval.
        """
        while not self._stopping.is_set():
            try:
                await asyncio.to_thread(self.tick_once)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # pragma: no cover - defensive
                self.log.emit(EventType.ERROR, f"Monitor cycle failed: {error}")

            interval = self._effective_interval_s()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stopping.wait(), timeout=interval)

    def _effective_interval_s(self) -> float:
        """Never evaluate a tracker faster than it asked to be evaluated."""
        floor = self.config.poll_interval_s
        for tracker in self.trackers.values():
            interval_ms = tracker.definition.get("minEvaluationIntervalMs")
            if isinstance(interval_ms, (int, float)) and interval_ms > 0:
                floor = min(floor, interval_ms / 1000.0)
        return max(floor, 1.0)

    def tick_once(self, now_ms: int | None = None) -> list[QueuedWake]:
        """
        One full monitor cycle, synchronous.

        Kept synchronous and injectable so the whole engine can be tested
        against fixtures and a fake clock, with no threads, no sleeping and
        no network.
        """
        produced = self.monitor.tick(now_ms)
        return [self._enqueue(wake) for wake in produced]

    # ------------------------------------------------------------ inspection

    def instrument_json(self) -> dict[str, dict[str, Any]]:
        return self.monitor.instrument_json()

    def tracker_status(self, tracker_id: str, now_ms: int | None = None) -> dict[str, Any] | None:
        return self.monitor.tracker_status(tracker_id, now_ms)

    def latest_wakes(self, limit: int = 20) -> list[dict[str, Any]]:
        return [item.to_json() for item in reversed(self._queue[-limit:])]

    def status(self, now_ms: int | None = None) -> dict[str, Any]:
        payload = self.monitor.status(now_ms)
        payload.update(
            {
                "apiVersion": "1",
                "schemaVersion": contract.SCHEMA_VERSION,
                "liveTradingEnabled": False,
                "pendingWakes": sum(1 for item in self._queue if not item.acknowledged),
                "wakeCapacity": self.WAKE_CAPACITY,
            }
        )
        return payload

    def catalogue(self) -> dict[str, Any]:
        return self.monitor.catalogue()

    def policy_for(self, tracker_id: str) -> WakePolicy | None:
        tracker = self.trackers.get(tracker_id)
        return tracker.policy if tracker else None


# --------------------------------------------------------------------------- #
# Fixture contexts, shared with the test suite
# --------------------------------------------------------------------------- #


def _load_fixture_contexts() -> dict[str, EvaluationContext]:
    """
    Build every context declared in ``shared/condition_examples.json``.

    The definitions live in the shared file rather than in this module, so
    the TypeScript suite builds the identical contexts from the same
    fixtures and the two cannot quietly test against different data.
    """
    import numpy as np

    from .series import Series

    def load(name: str) -> Series:
        path = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / f"{name}.json"
        with path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        return Series(
            symbol=payload["symbol"],
            timeframe=payload["timeframe"],
            open=np.asarray(payload["open"], dtype=float),
            high=np.asarray(payload["high"], dtype=float),
            low=np.asarray(payload["low"], dtype=float),
            close=np.asarray(payload["close"], dtype=float),
            volume=np.asarray(payload["volume"], dtype=float) if payload.get("volume") else None,
            times=np.asarray(payload.get("times", []), dtype=np.int64),
        )

    with _EXAMPLES_PATH.open(encoding="utf-8") as handle:
        contexts = json.load(handle)["contexts"]

    built: dict[str, EvaluationContext] = {}
    for name, spec in contexts.items():
        series_map = {timeframe: load(fixture) for timeframe, fixture in spec["series"].items()}
        reference = next(iter(series_map.values()))
        built[name] = EvaluationContext(
            symbol=spec["symbol"],
            series=series_map,
            price=float(reference.close[-1]),
            spread=0.25,
            instrument={
                "symbol": "Gold",
                "providerSymbol": spec["symbol"],
                "assetClass": "COMMODITY",
                "availability": "TRADEABLE",
                "tickSize": 0.01,
                "pricePrecision": 2,
            },
            account={
                "equity": 10000.0,
                "balance": 10000.0,
                "freeMargin": 9000.0,
                "marginUsed": 1000.0,
                "dailyPnL": -50.0,
                "exposure": 20000.0,
                "maxExposureNotional": 250000.0,
                "drawdownPercent": 1.2,
                "killSwitchActive": False,
                "riskState": "NORMAL",
                "ordersLastMinute": 1,
            },
            positions=(),
            timestamp=1_700_000_000_000,
        )
    return built
