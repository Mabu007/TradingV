"""Price-action and candle-analysis primitives.

Every measure is a deterministic function of the candle series. Nothing
here involves visual judgement, and every function reports ``UNKNOWN``
rather than a number when it does not have the candles it needs.

Measures are computed as a full array so a condition can ask about the
current bar, a historical bar, or a count of consecutive bars without the
caller reshaping anything.
"""

from __future__ import annotations

import numpy as np

from .series import ComputedSeries, Series, Validity

#: Every price-action measure the engine can produce.
MEASURES = (
    "BULLISH_CANDLE",
    "BEARISH_CANDLE",
    "BODY_PERCENT",
    "BODY_SIZE",
    "BODY_TO_RANGE",
    "UPPER_WICK",
    "LOWER_WICK",
    "UPPER_WICK_PERCENT",
    "LOWER_WICK_PERCENT",
    "RANGE",
    "CLOSE_POSITION",
    "CONSECUTIVE_UP",
    "CONSECUTIVE_DOWN",
    "HIGHER_HIGH",
    "LOWER_HIGH",
    "HIGHER_LOW",
    "LOWER_LOW",
    "HIGHER_CLOSE",
    "LOWER_CLOSE",
    "DISTANCE_FROM_HIGH",
    "DISTANCE_FROM_LOW",
    "DISTANCE_FROM_SMA",
    "DISTANCE_FROM_EMA",
    "PERCENT_CHANGE",
    "ABSOLUTE_CHANGE",
    "TRUE_RANGE",
)

#: Measures that are booleans rather than magnitudes. A condition that
#: tests ``BULLISH_CANDLE`` with ``GT 0.5`` is asking whether the candle
#: closed up, and the catalogue says so.
BOOLEAN_MEASURES = frozenset(
    {"BULLISH_CANDLE", "BEARISH_CANDLE", "HIGHER_HIGH", "LOWER_HIGH", "HIGHER_LOW", "LOWER_LOW", "HIGHER_CLOSE", "LOWER_CLOSE"}
)

#: Minimum candles each measure needs before it means anything.
WARMUP = {
    "BULLISH_CANDLE": 1,
    "BEARISH_CANDLE": 1,
    "BODY_PERCENT": 2,
    "BODY_SIZE": 1,
    "BODY_TO_RANGE": 1,
    "UPPER_WICK": 1,
    "LOWER_WICK": 1,
    "UPPER_WICK_PERCENT": 1,
    "LOWER_WICK_PERCENT": 1,
    "RANGE": 1,
    "CLOSE_POSITION": 1,
    "CONSECUTIVE_UP": 1,
    "CONSECUTIVE_DOWN": 1,
    "HIGHER_HIGH": 2,
    "LOWER_HIGH": 2,
    "HIGHER_LOW": 2,
    "LOWER_LOW": 2,
    "HIGHER_CLOSE": 2,
    "LOWER_CLOSE": 2,
    "DISTANCE_FROM_HIGH": 1,
    "DISTANCE_FROM_LOW": 1,
    "DISTANCE_FROM_SMA": 2,
    "DISTANCE_FROM_EMA": 2,
    "PERCENT_CHANGE": 2,
    "ABSOLUTE_CHANGE": 2,
    "TRUE_RANGE": 2,
}


def _invalid(series: Series, measure: str, reason: str) -> ComputedSeries:
    return ComputedSeries(
        name=measure,
        timeframe=series.timeframe,
        values=np.full(len(series), np.nan, dtype=float),
        validity=Validity.INSUFFICIENT_DATA,
        reason=reason,
    )


def _safe_div(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(denominator != 0, numerator / np.where(denominator == 0, 1.0, denominator), np.nan)


def _consecutive(flags: np.ndarray) -> np.ndarray:
    """For each bar, how many consecutive preceding bars share its flag."""
    out = np.zeros(flags.size, dtype=float)
    run = 0.0
    for index, flag in enumerate(flags):
        run = run + 1.0 if flag else 0.0
        out[index] = run
    return out


def compute(series: Series, measure: str, period: int = 20, count: int = 1) -> ComputedSeries:
    """
    Compute one price-action measure.

    ``period`` is the moving-average length for the distance measures and
    the lookback for the rolling extremes. ``count`` is the consecutive
    bar count for the streak measures.
    """
    if measure not in MEASURES:
        raise KeyError(f"Unknown price-action measure: {measure}")

    warmup = WARMUP[measure]
    if measure in {"DISTANCE_FROM_SMA", "DISTANCE_FROM_EMA"}:
        warmup = max(warmup, period + 2)

    if len(series) < warmup:
        return _invalid(series, measure, f"Not enough {series.timeframe} candles for {measure}. Need at least {warmup}, have {len(series)}.")
    if not series.has_finite():
        return _invalid(series, measure, f"{series.timeframe} candles contain non-finite values, so {measure} cannot be calculated.")

    open_ = series.open
    high = series.high
    low = series.low
    close = series.close
    body = np.abs(close - open_)
    candle_range = high - low
    upper_wick = high - np.maximum(open_, close)
    lower_wick = np.minimum(open_, close) - low

    if measure == "BULLISH_CANDLE":
        values = (close > open_).astype(float)
    elif measure == "BEARISH_CANDLE":
        values = (close < open_).astype(float)
    elif measure == "BODY_PERCENT":
        # Share of the close-to-close move that is body, not wick.
        moved = np.abs(close - np.roll(close, 1))
        moved[0] = np.nan
        values = _safe_div(body, moved) * 100.0
    elif measure == "BODY_SIZE":
        values = body
    elif measure == "BODY_TO_RANGE":
        values = _safe_div(body, candle_range)
    elif measure == "UPPER_WICK":
        values = upper_wick
    elif measure == "LOWER_WICK":
        values = lower_wick
    elif measure == "UPPER_WICK_PERCENT":
        values = _safe_div(upper_wick, candle_range) * 100.0
    elif measure == "LOWER_WICK_PERCENT":
        values = _safe_div(lower_wick, candle_range) * 100.0
    elif measure == "RANGE":
        values = candle_range
    elif measure == "CLOSE_POSITION":
        # 1.0 closed on the high, 0.0 closed on the low.
        values = _safe_div(close - low, candle_range)
    elif measure == "CONSECUTIVE_UP":
        values = _consecutive(close > np.roll(close, 1))
    elif measure == "CONSECUTIVE_DOWN":
        values = _consecutive(close < np.roll(close, 1))
    elif measure == "HIGHER_HIGH":
        values = (high > np.roll(high, 1)).astype(float)
    elif measure == "LOWER_HIGH":
        values = (high < np.roll(high, 1)).astype(float)
    elif measure == "HIGHER_LOW":
        values = (low > np.roll(low, 1)).astype(float)
    elif measure == "LOWER_LOW":
        values = (low < np.roll(low, 1)).astype(float)
    elif measure == "HIGHER_CLOSE":
        values = (close > np.roll(close, 1)).astype(float)
    elif measure == "LOWER_CLOSE":
        values = (close < np.roll(close, 1)).astype(float)
    elif measure == "DISTANCE_FROM_HIGH":
        rolling_high = pd_rolling_max(high, period)
        values = _safe_div(close, rolling_high) - 1.0
    elif measure == "DISTANCE_FROM_LOW":
        rolling_low = pd_rolling_min(low, period)
        values = _safe_div(close, rolling_low) - 1.0
    elif measure == "DISTANCE_FROM_SMA":
        average = _rolling_mean(close, period)
        values = _safe_div(close, average) - 1.0
    elif measure == "DISTANCE_FROM_EMA":
        average = _rolling_ema(close, period)
        values = _safe_div(close, average) - 1.0
    elif measure == "PERCENT_CHANGE":
        previous = np.roll(close, 1)
        previous[0] = np.nan
        values = _safe_div(close - previous, previous) * 100.0
    elif measure == "ABSOLUTE_CHANGE":
        values = close - np.roll(close, 1)
        values[0] = np.nan
    elif measure == "TRUE_RANGE":
        previous_close = np.roll(close, 1)
        previous_close[0] = np.nan
        values = np.maximum.reduce(
            [
                high - low,
                np.abs(high - previous_close),
                np.abs(low - previous_close),
            ]
        )
    else:  # pragma: no cover - exhaustive above
        raise KeyError(measure)

    return ComputedSeries(
        name=measure,
        timeframe=series.timeframe,
        values=np.asarray(values, dtype=float),
        validity=Validity.OK,
        warmup=warmup - 1,
    )


# --------------------------------------------------------------------------- #
# Rolling helpers
# --------------------------------------------------------------------------- #


def _rolling_mean(values: np.ndarray, window: int) -> np.ndarray:
    import pandas as pd

    return pd.Series(values).rolling(window=window, min_periods=window).mean().to_numpy()


def _rolling_ema(values: np.ndarray, window: int) -> np.ndarray:
    import pandas as pd

    return pd.Series(values).ewm(span=window, min_periods=window, adjust=False).mean().to_numpy()


def pd_rolling_max(values: np.ndarray, window: int) -> np.ndarray:
    import pandas as pd

    return pd.Series(values).rolling(window=window, min_periods=window).max().to_numpy()


def pd_rolling_min(values: np.ndarray, window: int) -> np.ndarray:
    import pandas as pd

    return pd.Series(values).rolling(window=window, min_periods=window).min().to_numpy()


def swing_points(high: np.ndarray, low: np.ndarray, lookback: int) -> tuple[list[int], list[int]]:
    """
    Fractal swing highs and swing lows.

    A swing high at bar ``i`` is one whose high is the strict maximum of
    the ``lookback`` bars either side. This is the deterministic definition
    used everywhere in this engine; there is no discretionary pivoting.
    """
    highs: list[int] = []
    lows: list[int] = []
    size = high.size

    for index in range(lookback, size - lookback):
        window = slice(index - lookback, index + lookback + 1)
        if high[index] == high[window].max() and (high[window] == high[index]).sum() == 1:
            highs.append(index)
        if low[index] == low[window].min() and (low[window] == low[index]).sum() == 1:
            lows.append(index)

    return highs, lows
