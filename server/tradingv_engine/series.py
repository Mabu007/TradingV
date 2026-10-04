"""Time-series primitives.

A :class:`Series` is the only shape the indicator engine accepts. It
carries its own timeframe, so candles from different timeframes can never
be mixed by accident, and it reports whether it has enough history to
produce a value at all.

The three-state discipline starts here: a series that is too short, or
that contains non-finite values, reports ``UNKNOWN`` rather than a
fabricated number.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Sequence

import numpy as np
import pandas as pd

from .config import TIMEFRAME_SECONDS


class Validity(str, Enum):
    """Whether a computed value can be trusted."""

    OK = "OK"
    #: Not enough history for the requested warmup.
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    #: The input contained NaN or infinity where a number was required.
    INVALID_INPUT = "INVALID_INPUT"
    #: The market itself is unavailable, so nothing was computed.
    MARKET_UNAVAILABLE = "MARKET_UNAVAILABLE"
    #: A configuration problem, e.g. an unsupported timeframe.
    UNSUPPORTED = "UNSUPPORTED"


@dataclass(frozen=True)
class Series:
    """A named OHLCV series on one market and one timeframe."""

    symbol: str
    timeframe: str
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray | None = None
    #: Bar open times in epoch milliseconds, ascending.
    times: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.int64))

    def __post_init__(self) -> None:
        length = len(self.close)
        for name in ("open", "high", "low"):
            value = getattr(self, name)
            if len(value) != length:
                raise ValueError(f"{name} length {len(value)} != close length {length}")
        if self.volume is not None and len(self.volume) != length:
            raise ValueError("volume length does not match close length")
        if len(self.times) not in (0, length):
            raise ValueError("times length must be zero or match close length")

    def __len__(self) -> int:
        return len(self.close)

    @property
    def timeframe_seconds(self) -> int:
        return TIMEFRAME_SECONDS[self.timeframe]

    @property
    def has_volume(self) -> bool:
        """
        Whether volume is meaningful for this series.

        Hyperliquid publishes a synthetic trade-count volume rather than
        real traded size for its perps, so volume is treated as available
        but never as a liquidity measure.
        """
        return self.volume is not None and bool(np.any(self.volume))

    def has_finite(self) -> bool:
        arrays = [self.open, self.high, self.low, self.close]
        if self.volume is not None:
            arrays.append(self.volume)
        return all(bool(np.all(np.isfinite(array))) for array in arrays)

    def frame(self) -> pd.DataFrame:
        data = {
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
        }
        if self.volume is not None:
            data["volume"] = self.volume
        if len(self.times):
            data["time"] = self.times
        return pd.DataFrame(data)

    def tail(self, count: int) -> "Series":
        if count >= len(self):
            return self
        return Series(
            symbol=self.symbol,
            timeframe=self.timeframe,
            open=self.open[-count:],
            high=self.high[-count:],
            low=self.low[-count:],
            close=self.close[-count:],
            volume=None if self.volume is None else self.volume[-count:],
            times=self.times[-count:] if len(self.times) else self.times,
        )

    def validate_for(self, warmup: int) -> Validity:
        if self.timeframe not in TIMEFRAME_SECONDS:
            return Validity.UNSUPPORTED
        if len(self) < max(1, warmup):
            return Validity.INSUFFICIENT_DATA
        if not self.has_finite():
            return Validity.INVALID_INPUT
        return Validity.OK


@dataclass(frozen=True)
class ComputedSeries:
    """An indicator result plus the state needed to trust it."""

    name: str
    timeframe: str
    values: np.ndarray
    validity: Validity
    #: Number of leading bars that are warmup padding.
    warmup: int = 0
    #: Optional extra outputs, e.g. Bollinger upper/lower.
    extras: dict[str, np.ndarray] = field(default_factory=dict)
    #: Plain-language explanation of a non-OK state.
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.validity is Validity.OK

    def last(self) -> float | None:
        """Most recent finite value, or ``None`` when not measurable."""
        if not self.ok or self.values.size == 0:
            return None
        value = self.values[-1]
        if value is None or not math.isfinite(float(value)):
            return None
        return float(value)

    def at(self, index: int) -> float | None:
        if not self.ok or index < 0 or index >= self.values.size:
            return None
        value = self.values[index]
        if value is None or not math.isfinite(float(value)):
            return None
        return float(value)

    def previous(self, offset: int = 1) -> float | None:
        return self.at(len(self.values) - 1 - offset)


def as_float_array(values: Iterable[float]) -> np.ndarray:
    array = np.asarray(list(values), dtype=float)
    if array.size == 0:
        return array
    if not np.all(np.isfinite(array)):
        raise ValueError("series contains non-finite values")
    return array


def last_finite(values: Sequence[float] | np.ndarray) -> float | None:
    array = np.asarray(values, dtype=float)
    for index in range(array.size - 1, -1, -1):
        value = array[index]
        if math.isfinite(value):
            return float(value)
    return None


def finite_count(values: np.ndarray) -> int:
    return int(np.count_nonzero(np.isfinite(values)))
