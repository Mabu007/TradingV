"""Shared candle store and indicator cache.

The monitor watches many markets and many trackers. Two rules keep that
cheap:

1. **One series per (market, timeframe).** A new Gold 15m candle is
   fetched once and every Gold 15m tracker reads it, instead of each
   tracker polling the venue.
2. **Only the indicators that are needed.** The set of (timeframe,
   indicator) pairs is derived from the *active* trackers, so a
   configuration that uses RSI and EMA on Gold 15m computes RSI and EMA
   and nothing else.

Nothing here spawns a loop per condition. Everything is a lookup into a
cache keyed by what was actually requested.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from . import indicators as indicator_module
from .config import EngineConfig
from .evaluator import EvaluationContext
from .series import ComputedSeries, Series, Validity

#: A series older than this is treated as stale, and conditions that
#: depend on it report UNKNOWN rather than a stale value.
DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000


@dataclass
class CandleEntry:
    series: Series
    fetched_at_ms: int
    last_bar_time_ms: int

    def age_ms(self, now_ms: int) -> int:
        return now_ms - self.last_bar_time_ms

    def is_stale(self, now_ms: int, stale_after_ms: int = DEFAULT_STALE_AFTER_MS) -> bool:
        return self.age_ms(now_ms) > stale_after_ms


class CandleStore:
    """
    Caches one series per (symbol, timeframe).

    The fetch is injected so tests drive it from fixtures.
    """

    def __init__(
        self,
        fetch: Callable[[str, str], Series],
        config: EngineConfig | None = None,
    ) -> None:
        self._fetch = fetch
        self._config = config or EngineConfig()
        self._entries: dict[tuple[str, str], CandleEntry] = {}
        self._clock: Callable[[], int] = lambda: int(time.time() * 1000)
        self.fetch_count = 0

    def set_clock(self, clock: Callable[[], int]) -> None:
        """Inject a clock. Tests use this to make staleness deterministic."""
        self._clock = clock

    def get(self, symbol: str, timeframe: str, refresh: bool = False) -> CandleEntry | None:
        key = (symbol, timeframe)
        entry = self._entries.get(key)

        if entry is not None and not refresh:
            return entry

        try:
            series = self._fetch(symbol, timeframe)
        except Exception:
            # A failed refresh keeps the last good series so the caller can
            # decide whether it is stale, rather than dropping history.
            return entry

        now = self._clock()
        self.fetch_count += 1
        last_bar = int(series.times[-1]) if len(series.times) else now
        new_entry = CandleEntry(series=series, fetched_at_ms=now, last_bar_time_ms=last_bar)
        self._entries[key] = new_entry
        return new_entry

    def seed(self, symbol: str, timeframe: str, series: Series) -> None:
        """Insert a series directly. Used by fixtures and the backtester."""
        now = self._clock()
        last_bar = int(series.times[-1]) if len(series.times) else now
        self._entries[(symbol, timeframe)] = CandleEntry(series=series, fetched_at_ms=now, last_bar_time_ms=last_bar)

    def series_for(self, symbol: str, timeframe: str) -> Series | None:
        entry = self._entries.get((symbol, timeframe))
        return entry.series if entry else None

    def entry_for(self, symbol: str, timeframe: str) -> CandleEntry | None:
        return self._entries.get((symbol, timeframe))

    def tracked(self) -> list[tuple[str, str]]:
        return sorted(self._entries)

    def __len__(self) -> int:
        return len(self._entries)


class IndicatorCache:
    """Memoises one computed indicator per (symbol, timeframe, key)."""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str, str], ComputedSeries] = {}
        self.computation_count = 0

    def get_or_compute(
        self,
        series: Series,
        indicator: str,
        params: Mapping[str, Any] | None = None,
    ) -> ComputedSeries:
        cleaned = {key: value for key, value in (params or {}).items() if value is not None}
        key = (series.symbol, series.timeframe, _cache_key(indicator, cleaned))
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        self.computation_count += 1
        computed = indicator_module.compute(series, indicator, **cleaned)
        self._cache[key] = computed
        return computed

    def invalidate(self, symbol: str, timeframe: str | None = None) -> None:
        prefix = (symbol, timeframe)
        for key in [key for key in self._cache if key[0] == symbol and (timeframe is None or key[1] == timeframe)]:
            del self._cache[key]

    def __len__(self) -> int:
        return len(self._cache)


def _cache_key(indicator: str, params: Mapping[str, Any]) -> str:
    if not params:
        return indicator
    parts = ",".join(f"{key}={value}" for key, value in sorted(params.items()))
    return f"{indicator}({parts})"


@dataclass
class MonitorContextBuilder:
    """
    Assembles an :class:`EvaluationContext` for one symbol.

    This is the seam between the shared data layer and the condition
    evaluator. A context is built per (GOAT, tracker) evaluation, but it
    reads from the shared store, so building it is cheap.
    """

    store: CandleStore
    cache: IndicatorCache
    instruments: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    account: Mapping[str, Any] | None = None
    positions: tuple[Mapping[str, Any], ...] = ()
    spread: float | None = None
    event_type: str | None = None

    def for_symbol(
        self,
        symbol: str,
        timeframes: Iterable[str],
        now_ms: int,
        require_tradeable: bool = True,
    ) -> EvaluationContext:
        series_map: dict[str, Series] = {}
        stale: list[str] = []

        for timeframe in timeframes:
            entry = self.store.entry_for(symbol, timeframe)
            if entry is None:
                continue
            if entry.is_stale(now_ms):
                stale.append(timeframe)
                continue
            series_map[timeframe] = entry.series

        price = None
        base = series_map.get("15m") or next(iter(series_map.values()), None)
        if base is not None and len(base.close):
            candidate = float(base.close[-1])
            if candidate > 0:
                price = candidate

        instrument = self.instruments.get(symbol)
        tradeable = instrument is not None and instrument.get("availability") == "TRADEABLE"

        if require_tradeable and not tradeable:
            # A market the venue will not trade has no usable price and no
            # usable spread. Handing the evaluator a price anyway would let
            # a condition resolve TRUE off the last close of a market that
            # is halted, delisted, or out of session, which is exactly the
            # case where waking the AI is most dangerous.
            reason = (
                f"{symbol} is not tradeable, so its conditions cannot be evaluated."
                if instrument is not None
                else f"{symbol} is not a known market, so its conditions cannot be evaluated."
            )
            return EvaluationContext(
                symbol=symbol,
                series={},
                price=None,
                spread=None,
                instrument=instrument,
                account=self.account,
                positions=self.positions,
                timestamp=now_ms,
                event_type=None,
                unavailable_reason=reason,
            )

        is_stale = bool(stale)
        return EvaluationContext(
            symbol=symbol,
            series=series_map,
            price=price,
            spread=None if is_stale else self.spread,
            instrument=instrument,
            account=self.account,
            positions=self.positions,
            timestamp=now_ms,
            event_type=None if is_stale else self.event_type,
            # Every requested timeframe went stale, so say that plainly
            # rather than letting the caller read "no data loaded" and
            # assume the market was never watched.
            unavailable_reason=(
                f"Every candle loaded for {symbol} is stale ({', '.join(stale)}); the market is not updating."
                if is_stale and not series_map
                else None
            ),
        )
