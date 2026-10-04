"""Deterministic chart patterns.

Every pattern has a written detection rule. The rule is the
documentation: what the function tests is exactly what the user is told.
None of these are subjective or visual judgements, and none of them
claim more certainty than the arithmetic supports.

Catalogue
---------

``BREAKOUT_ABOVE_HIGH``
    ``close[-1] > max(high[-2-N .. -2])`` - the current bar closed above
    the rolling high of the N bars *before* it. Optionally confirmed by
    ``volume[-1] > volumeSMA[-1] * multiplier`` where volume exists.

``BREAKOUT_BELOW_LOW``
    The mirror image.

``SUPPORT_TEST`` / ``RESISTANCE_TEST``
    The bar's low (high) came within ``tolerancePercent`` of the rolling
    low (high) and the bar closed back above it (below it).

``DOUBLE_TOP`` / ``DOUBLE_BOTTOM``
    Two swing extremes within ``tolerancePercent`` of each other, at least
    ``minSeparationBars`` apart, with a meaningful trough (peak) between
    them.

``HIGHER_HIGH_HIGHER_LOW`` / ``LOWER_HIGH_LOWER_LOW``
    The last two confirmed swing highs and lows both step in the same
    direction. This is the strictest structural definition of an uptrend,
    and deliberately so.

``TRIANGLE``
    Rising lows and falling highs over the lookback: the range narrows.

``CHANNEL_UP`` / ``CHANNEL_DOWN``
    Regression slope of closes over the lookback is positive (negative)
    and both regression bounds are respected by most bars.

``VOLATILITY_CONTRACTION``
    ATR of the most recent ``max(3, lookback/4)`` bars is below ATR over
    the full lookback by more than 20%.

``SWING_HIGH`` / ``SWING_LOW``
    The last bar is a confirmed fractal swing point.
"""

from __future__ import annotations

import numpy as np

from .indicators.engine import atr
from .price_action import pd_rolling_max, pd_rolling_min, swing_points
from .series import ComputedSeries, Series, Validity

PATTERNS = (
    "BREAKOUT_ABOVE_HIGH",
    "BREAKOUT_BELOW_LOW",
    "SUPPORT_TEST",
    "RESISTANCE_TEST",
    "DOUBLE_TOP",
    "DOUBLE_BOTTOM",
    "HIGHER_HIGH_HIGHER_LOW",
    "LOWER_HIGH_LOWER_LOW",
    "TRIANGLE",
    "CHANNEL_UP",
    "CHANNEL_DOWN",
    "VOLATILITY_CONTRACTION",
    "SWING_HIGH",
    "SWING_LOW",
)

#: Detection rule, surfaced in the catalogue and shown in the UI.
DESCRIPTIONS = {
    "BREAKOUT_ABOVE_HIGH": "close > the highest high of the previous N candles",
    "BREAKOUT_BELOW_LOW": "close < the lowest low of the previous N candles",
    "SUPPORT_TEST": "the bar tested the rolling low within tolerance and closed back above it",
    "RESISTANCE_TEST": "the bar tested the rolling high within tolerance and closed back below it",
    "DOUBLE_TOP": "two swing highs within tolerance, separated by at least N bars, with a trough between them",
    "DOUBLE_BOTTOM": "two swing lows within tolerance, separated by at least N bars, with a peak between them",
    "HIGHER_HIGH_HIGHER_LOW": "the last two swing highs and the last two swing lows both step higher",
    "LOWER_HIGH_LOWER_LOW": "the last two swing highs and the last two swing lows both step lower",
    "TRIANGLE": "rising lows and falling highs over the lookback: the range narrows",
    "CHANNEL_UP": "positive regression slope of closes and both regression bounds respected",
    "CHANNEL_DOWN": "negative regression slope of closes and both regression bounds respected",
    "VOLATILITY_CONTRACTION": "recent ATR is materially below ATR over the full lookback",
    "SWING_HIGH": "the last bar is a confirmed fractal swing high",
    "SWING_LOW": "the last bar is a confirmed fractal swing low",
}

WARMUP = {
    "BREAKOUT_ABOVE_HIGH": 21,
    "BREAKOUT_BELOW_LOW": 21,
    "SUPPORT_TEST": 21,
    "RESISTANCE_TEST": 21,
    "DOUBLE_TOP": 31,
    "DOUBLE_BOTTOM": 31,
    "HIGHER_HIGH_HIGHER_LOW": 31,
    "LOWER_HIGH_LOWER_LOW": 31,
    "TRIANGLE": 21,
    "CHANNEL_UP": 21,
    "CHANNEL_DOWN": 21,
    "VOLATILITY_CONTRACTION": 30,
    "SWING_HIGH": 6,
    "SWING_LOW": 6,
}

DEFAULT_PARAMS = {
    "lookback": 20,
    "tolerancePercent": 0.5,
    "minSeparationBars": 5,
    "swingLookback": 2,
    "volumeMultiplier": 1.5,
}


def _boolean(series: Series, pattern: str, hit: bool, reason_if_not: str = "") -> ComputedSeries:
    return ComputedSeries(
        name=pattern,
        timeframe=series.timeframe,
        values=np.array([1.0 if hit else 0.0]),
        validity=Validity.OK,
        reason="" if hit else (reason_if_not or f"{pattern} is not present on the last {series.timeframe} candle."),
    )


def _unknown(series: Series, pattern: str, reason: str) -> ComputedSeries:
    return ComputedSeries(
        name=pattern,
        timeframe=series.timeframe,
        values=np.full(1, np.nan, dtype=float),
        validity=Validity.INSUFFICIENT_DATA,
        reason=reason,
    )


def evaluate(series: Series, pattern: str, **params: object) -> ComputedSeries:
    """Evaluate one pattern on the most recent candle."""
    if pattern not in PATTERNS:
        raise KeyError(f"Unknown pattern: {pattern}")

    settings = dict(DEFAULT_PARAMS)
    settings.update({key: value for key, value in params.items() if value is not None})

    warmup = WARMUP[pattern]
    if len(series) < warmup:
        return _unknown(
            series,
            pattern,
            f"Not enough {series.timeframe} candles to detect {pattern}. Need at least {warmup}, have {len(series)}.",
        )
    if not series.has_finite():
        return _unknown(series, pattern, f"{series.timeframe} candles contain non-finite values.")

    handler = _HANDLERS[pattern]
    return handler(series, settings)  # type: ignore[operator]


def _volume_confirmed(series: Series, multiplier: float) -> bool | None:
    """True/False when volume exists, None when it does not."""
    if not series.has_volume:
        return None
    from .indicators.engine import volume_sma

    average = volume_sma(series, 20)
    if not average.ok:
        return None
    baseline = average.previous()
    current = series.volume[-1]  # type: ignore[index]
    if baseline is None or baseline <= 0:
        return None
    return bool(current > baseline * multiplier)


def _breakout_above(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    previous_high = pd_rolling_max(series.high[:-1], lookback)
    level = previous_high[-1] if previous_high.size else np.nan
    if not np.isfinite(level):
        return _unknown(series, "BREAKOUT_ABOVE_HIGH", "The rolling high is not defined yet.")
    hit = bool(series.close[-1] > level)
    if hit and settings.get("requireVolumeConfirmation"):
        confirmation = _volume_confirmed(series, float(settings["volumeMultiplier"]))
        if confirmation is not True:
            detail = (
                "This market does not provide volume, so the confirmation cannot be measured."
                if confirmation is None
                else "Price broke out but volume did not confirm it."
            )
            return _boolean(series, "BREAKOUT_ABOVE_HIGH", False, detail)
    return _boolean(series, "BREAKOUT_ABOVE_HIGH", hit)


def _breakout_below(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    previous_low = pd_rolling_min(series.low[:-1], lookback)
    level = previous_low[-1] if previous_low.size else np.nan
    if not np.isfinite(level):
        return _unknown(series, "BREAKOUT_BELOW_LOW", "The rolling low is not defined yet.")
    hit = bool(series.close[-1] < level)
    if hit and settings.get("requireVolumeConfirmation"):
        confirmation = _volume_confirmed(series, float(settings["volumeMultiplier"]))
        if confirmation is not True:
            detail = (
                "This market does not provide volume, so the confirmation cannot be measured."
                if confirmation is None
                else "Price broke down but volume did not confirm it."
            )
            return _boolean(series, "BREAKOUT_BELOW_LOW", False, detail)
    return _boolean(series, "BREAKOUT_BELOW_LOW", hit)


def _support_test(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    tolerance = float(settings["tolerancePercent"]) / 100.0
    previous_low = pd_rolling_min(series.low[:-1], lookback)
    level = previous_low[-1] if previous_low.size else np.nan
    if not np.isfinite(level):
        return _unknown(series, "SUPPORT_TEST", "The rolling low is not defined yet.")
    touched = series.low[-1] <= level * (1.0 + tolerance)
    recovered = series.close[-1] > level
    return _boolean(series, "SUPPORT_TEST", bool(touched and recovered))


def _resistance_test(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    tolerance = float(settings["tolerancePercent"]) / 100.0
    previous_high = pd_rolling_max(series.high[:-1], lookback)
    level = previous_high[-1] if previous_high.size else np.nan
    if not np.isfinite(level):
        return _unknown(series, "RESISTANCE_TEST", "The rolling high is not defined yet.")
    touched = series.high[-1] >= level * (1.0 - tolerance)
    rejected = series.close[-1] < level
    return _boolean(series, "RESISTANCE_TEST", bool(touched and rejected))


def _double_extreme(series: Series, settings: dict, kind: str) -> ComputedSeries:
    swing = int(settings["swingLookback"])
    separation = int(settings["minSeparationBars"])
    tolerance = float(settings["tolerancePercent"]) / 100.0
    highs, lows = swing_points(series.high, series.low, swing)

    if kind == "DOUBLE_TOP":
        pivots = highs
        values = series.high
    else:
        pivots = lows
        values = series.low

    if len(pivots) < 2:
        return _unknown(series, kind, f"Need at least two confirmed swing points to detect {kind}; found {len(pivots)}.")

    first, second = pivots[-2], pivots[-1]
    if second - first < separation:
        return _boolean(series, kind, False, f"The two swing points are only {second - first} bars apart, fewer than the required {separation}.")

    first_level = values[first]
    second_level = values[second]
    if first_level == 0:
        return _unknown(series, kind, "The reference level is zero, so a relative tolerance cannot be applied.")

    close_enough = abs(second_level - first_level) / abs(first_level) <= tolerance

    if kind == "DOUBLE_TOP":
        between = series.low[first : second + 1].min()
        meaningful = (first_level - between) / abs(first_level) >= tolerance / 100.0
    else:
        between = series.high[first : second + 1].max()
        meaningful = (between - first_level) / abs(first_level) >= tolerance / 100.0

    return _boolean(series, kind, bool(close_enough and meaningful))


def _structure(series: Series, settings: dict, direction: str) -> ComputedSeries:
    swing = int(settings["swingLookback"])
    highs, lows = swing_points(series.high, series.low, swing)
    name = "HIGHER_HIGH_HIGHER_LOW" if direction == "up" else "LOWER_HIGH_LOWER_LOW"

    if len(highs) < 2 or len(lows) < 2:
        return _unknown(series, name, f"Need at least two swing highs and two swing lows; found {len(highs)} highs and {len(lows)} lows.")

    highs_step = series.high[highs[-1]] > series.high[highs[-2]]
    lows_step = series.low[lows[-1]] > series.low[lows[-2]]

    if direction == "up":
        hit = bool(highs_step and lows_step)
    else:
        hit = bool(not highs_step and not lows_step)

    return _boolean(series, name, hit)


def _triangle(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    swing = int(settings["swingLookback"])
    highs, lows = swing_points(series.high, series.low, swing)
    name = "TRIANGLE"

    if len(highs) < 2 or len(lows) < 2:
        return _unknown(series, name, "A triangle needs at least two swing highs and two swing lows inside the lookback.")

    falling_highs = series.high[highs[-1]] < series.high[highs[-2]]
    rising_lows = series.low[lows[-1]] > series.low[lows[-2]]
    return _boolean(series, name, bool(falling_highs and rising_lows))


def _channel(series: Series, settings: dict, direction: str) -> ComputedSeries:
    lookback = int(settings["lookback"])
    name = "CHANNEL_UP" if direction == "up" else "CHANNEL_DOWN"
    close = series.close[-lookback:]
    x = np.arange(close.size, dtype=float)
    slope, intercept = np.polyfit(x, close, 1)
    residual = close - (slope * x + intercept)

    # A channel means the bars sit inside the regression bounds, with some
    # slack. The slack is twice the residual spread plus a small floor
    # scaled to the price, because a perfect line still has floating
    # point noise and a zero-width tolerance would reject it.
    scale = max(float(np.nanmax(np.abs(close))), 1.0)
    tolerated = float(np.nanstd(residual)) * 2.0 + scale * 1e-9

    if direction == "up":
        hit = bool(slope > 0 and np.all(residual >= -tolerated))
    else:
        hit = bool(slope < 0 and np.all(residual <= tolerated))

    return _boolean(series, name, hit)


def _contraction(series: Series, settings: dict) -> ComputedSeries:
    lookback = int(settings["lookback"])
    recent_window = max(3, lookback // 4)
    name = "VOLATILITY_CONTRACTION"

    full = atr(series, lookback)
    recent = atr(series.tail(recent_window), max(2, recent_window - 1))

    if not full.ok or not recent.ok:
        return _unknown(series, name, "ATR is not measurable over the requested windows yet.")

    baseline = full.previous()
    current = recent.last()

    if baseline is None or current is None or baseline <= 0:
        return _unknown(series, name, "ATR has no usable baseline yet.")

    return _boolean(series, name, bool(current < baseline * 0.8))


def _swing(series: Series, settings: dict, kind: str) -> ComputedSeries:
    swing = int(settings["swingLookback"])
    name = "SWING_HIGH" if kind == "high" else "SWING_LOW"
    highs, lows = swing_points(series.high, series.low, swing)

    if len(series) < 2 * swing + 1:
        return _unknown(series, name, f"A confirmed swing point needs at least {2 * swing + 1} candles; have {len(series)}.")

    index = len(series) - swing - 1
    hit = index in (highs if kind == "high" else lows)
    return _boolean(series, name, bool(hit))


_HANDLERS = {
    "BREAKOUT_ABOVE_HIGH": _breakout_above,
    "BREAKOUT_BELOW_LOW": _breakout_below,
    "SUPPORT_TEST": _support_test,
    "RESISTANCE_TEST": _resistance_test,
    "DOUBLE_TOP": lambda s, c: _double_extreme(s, c, "DOUBLE_TOP"),
    "DOUBLE_BOTTOM": lambda s, c: _double_extreme(s, c, "DOUBLE_BOTTOM"),
    "HIGHER_HIGH_HIGHER_LOW": lambda s, c: _structure(s, c, "up"),
    "LOWER_HIGH_LOWER_LOW": lambda s, c: _structure(s, c, "down"),
    "TRIANGLE": _triangle,
    "CHANNEL_UP": lambda s, c: _channel(s, c, "up"),
    "CHANNEL_DOWN": lambda s, c: _channel(s, c, "down"),
    "VOLATILITY_CONTRACTION": _contraction,
    "SWING_HIGH": lambda s, c: _swing(s, c, "high"),
    "SWING_LOW": lambda s, c: _swing(s, c, "low"),
}
