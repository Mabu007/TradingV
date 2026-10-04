"""Indicator tests.

Every assertion runs against a committed fixture. Live market data is
never used for a mathematical test, so a failure is always a real change
in behaviour rather than a market move.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from conftest import fixture_series, make_series
from tradingv_engine.indicators import compute
from tradingv_engine.series import Validity

TREND = fixture_series("gold_15m_flat")
DOWN = fixture_series("gold_15m_downtrend")
UP = fixture_series("gold_15m_uptrend")
SHORT = fixture_series("gold_15m_short")
EUR = fixture_series("eur_1h_flat")


def approx(value, expected, tolerance=1e-6):
    assert value is not None, "value was not measurable"
    assert abs(value - expected) <= tolerance * max(1.0, abs(expected)), f"{value} != {expected}"


# --------------------------------------------------------------------------- #
# Determinism
# --------------------------------------------------------------------------- #


def test_repeated_computation_is_identical():
    first = compute(TREND, "EMA", period=20)
    second = compute(TREND, "EMA", period=20)
    assert np.array_equal(first.values, second.values, equal_nan=True)


def test_indicator_carries_name_timeframe_and_warmup():
    computed = compute(TREND, "RSI", period=14)
    assert computed.name == "RSI(14)"
    assert computed.timeframe == "15m"
    assert computed.warmup == 14
    assert computed.validity is Validity.OK
    assert computed.reason == ""


def test_timeframe_is_preserved_and_never_mixed():
    assert compute(EUR, "RSI", period=14).timeframe == "1h"
    assert compute(TREND, "RSI", period=14).timeframe == "15m"


# --------------------------------------------------------------------------- #
# Trend
# --------------------------------------------------------------------------- #


def test_sma_matches_hand_calculation():
    closes = [1, 2, 3, 4, 5, 6]
    series = make_series(closes)
    computed = compute(series, "SMA", period=3)
    assert math.isnan(computed.values[1])
    approx(computed.values[2], 2.0)
    approx(computed.values[5], 5.0)


def test_ema_recovers_a_constant_offset_series():
    # On a linear ramp the EMA trails the SMA predictably but stays finite.
    series = make_series([float(value) for value in range(1, 101)])
    computed = compute(series, "EMA", period=10)
    assert computed.last() is not None
    assert 85 < computed.last() < 100


def test_wma_reacts_faster_than_sma_on_a_ramp():
    closes = [float(value) for value in range(1, 101)]
    series = make_series(closes)
    wma = compute(series, "WMA", period=10).last()
    sma = compute(series, "SMA", period=10).last()
    assert wma > sma


def test_macd_is_zero_for_a_constant_series():
    series = make_series([100.0] * 80)
    computed = compute(series, "MACD")
    approx(computed.last(), 0.0, 1e-9)
    approx(computed.extras["signal"][-1], 0.0, 1e-9)
    approx(computed.extras["histogram"][-1], 0.0, 1e-9)


def test_macd_rejects_a_fast_period_above_its_slow_period():
    computed = compute(TREND, "MACD", fast=26, slow=12)
    assert computed.validity is Validity.INVALID_INPUT
    assert "fast period below" in computed.reason


def test_adx_is_zero_for_a_flat_series():
    series = make_series([100.0] * 80)
    assert compute(series, "ADX", period=14).last() is not None
    assert compute(series, "PLUS_DI", period=14).last() is not None


def test_plus_di_beats_minus_di_in_an_uptrend():
    plus = compute(UP, "PLUS_DI", period=14).last()
    minus = compute(UP, "MINUS_DI", period=14).last()
    assert plus > minus


def test_psar_sits_below_price_in_an_uptrend():
    sar = compute(UP, "PSAR").last()
    assert sar < float(UP.close[-1])


# --------------------------------------------------------------------------- #
# Momentum
# --------------------------------------------------------------------------- #


def test_rsi_is_100_when_every_bar_gains():
    series = make_series([float(value) for value in range(1, 60)])
    approx(compute(series, "RSI", period=14).last(), 100.0, 1e-9)


def test_rsi_is_0_when_every_bar_loses():
    series = make_series([float(value) for value in range(60, 1, -1)])
    approx(compute(series, "RSI", period=14).last(), 0.0, 1e-9)


def test_rsi_is_bounded():
    for series in (TREND, DOWN, UP, EUR):
        value = compute(series, "RSI", period=14).last()
        assert 0.0 <= value <= 100.0


def test_stochastic_is_bounded_and_carries_k_and_d():
    computed = compute(TREND, "STOCHASTIC", period=14, smooth=3)
    assert 0.0 <= computed.last() <= 100.0
    assert "k" in computed.extras and "d" in computed.extras


def test_williams_r_is_negative_and_bounded():
    value = compute(TREND, "WILLIAMS_R", period=14).last()
    assert -100.0 <= value <= 0.0


def test_roc_is_positive_in_an_uptrend():
    assert compute(UP, "ROC", period=12).last() > 0


def test_momentum_is_the_plain_difference():
    series = make_series([float(value) for value in range(1, 60)])
    approx(compute(series, "MOMENTUM", period=10).last(), 10.0, 1e-9)


# --------------------------------------------------------------------------- #
# Volatility
# --------------------------------------------------------------------------- #


def test_atr_is_positive_for_every_fixture():
    for series in (TREND, DOWN, UP, EUR):
        assert compute(series, "ATR", period=14).last() > 0


def test_atr_of_a_constant_series_is_zero_when_there_is_no_range():
    closes = [100.0] * 60
    series = make_series(closes, opens=closes, highs=closes, lows=closes)
    approx(compute(series, "ATR", period=14).last(), 0.0, 1e-9)


def test_atr_equals_the_constant_range_of_a_flat_but_wide_series():
    closes = [100.0] * 60
    series = make_series(closes, opens=closes, highs=[102.0] * 60, lows=[98.0] * 60)
    approx(compute(series, "ATR", period=14).last(), 4.0, 1e-9)


def test_bollinger_bands_are_ordered_around_the_middle():
    bands = compute(TREND, "BOLLINGER", period=20, deviations=2.0)
    upper = bands.extras["upper"][-1]
    middle = bands.extras["middle"][-1]
    lower = bands.extras["lower"][-1]
    assert lower < middle < upper


def test_bollinger_width_matches_the_bands():
    bands = compute(TREND, "BOLLINGER", period=20, deviations=2.0)
    width = compute(TREND, "BOLLINGER_WIDTH", period=20, deviations=2.0).last()
    expected = (bands.extras["upper"][-1] - bands.extras["lower"][-1]) / abs(bands.extras["middle"][-1])
    approx(width, expected, 1e-9)


def test_stddev_of_a_constant_series_is_zero():
    series = make_series([7.0] * 40)
    approx(compute(series, "STDDEV", period=10).last(), 0.0, 1e-9)


def test_historical_volatility_is_a_percentage():
    value = compute(TREND, "HISTORICAL_VOLATILITY", period=20).last()
    assert value > 0
    assert value < 10_000


# --------------------------------------------------------------------------- #
# Volume
# --------------------------------------------------------------------------- #


def test_volume_ratio_is_around_one_for_constant_volume():
    series = make_series([100.0] * 60, volumes=[1000.0] * 60)
    approx(compute(series, "VOLUME_RATIO", period=20).last(), 1.0, 1e-9)


def test_volume_indicators_are_unknown_without_volume():
    series = make_series([100.0] * 60, volumes=None)
    assert series.has_volume is False
    for name in ("VOLUME_SMA", "VOLUME_CHANGE", "OBV", "VOLUME_RATIO"):
        computed = compute(series, name)
        assert computed.validity is Validity.INSUFFICIENT_DATA
        assert computed.last() is None
        assert "volume" in computed.reason.lower()


def test_obv_follows_the_close_direction():
    series = make_series([1.0, 2.0, 3.0], volumes=[10.0, 10.0, 10.0])
    approx(compute(series, "OBV").last(), 20.0, 1e-9)


def test_vwap_needs_volume():
    series = make_series([100.0] * 40, volumes=None)
    assert compute(series, "VWAP").last() is None


# --------------------------------------------------------------------------- #
# Warmup and failure modes
# --------------------------------------------------------------------------- #


def test_every_indicator_reports_insufficient_data_on_a_short_series():
    short = make_series([100.0] * 5)
    for name in ("SMA", "EMA", "WMA", "RSI", "ATR", "ADX", "MACD", "STOCHASTIC", "WILLIAMS_R", "ROC", "MOMENTUM", "STDDEV", "HISTORICAL_VOLATILITY"):
        computed = compute(short, name)
        assert not computed.ok, f"{name} should not be measurable on five candles"
        assert computed.last() is None
        assert computed.reason


def test_empty_series_is_unknown_not_a_crash():
    empty = make_series([])
    for name in ("SMA", "EMA", "RSI", "ATR"):
        assert compute(empty, name).validity is not Validity.OK


def test_non_finite_input_is_rejected():
    closes = [100.0] * 30
    closes[10] = float("nan")
    series = make_series(closes)
    assert series.has_finite() is False
    assert compute(series, "EMA", period=20).validity is Validity.INVALID_INPUT


def test_malformed_parameters_are_rejected_by_the_series():
    series = make_series([100.0] * 30)
    computed = compute(series, "SMA", period=0)
    assert not computed.ok


def test_unknown_indicator_raises_rather_than_guessing():
    with pytest.raises(KeyError):
        compute(TREND, "NOT_AN_INDICATOR")


def test_infinite_input_is_rejected():
    closes = [100.0] * 30
    closes[5] = float("inf")
    series = make_series(closes)
    assert series.has_finite() is False


def test_malformed_period_is_rejected_for_every_period_based_indicator():
    series = make_series([100.0 + index * 0.1 for index in range(80)])
    for name in ("SMA", "EMA", "WMA", "RSI", "ATR", "ADX", "PLUS_DI", "MINUS_DI", "WILLIAMS_R", "ROC", "MOMENTUM", "STDDEV", "HISTORICAL_VOLATILITY", "VOLUME_SMA", "VOLUME_CHANGE"):
        for bad in (0, -3, 5000):
            computed = compute(series, name, period=bad)
            assert computed.validity is Validity.INVALID_INPUT, f"{name}({bad}) should be invalid"
            assert computed.last() is None


def test_broken_spine_is_rejected():
    """A period of 0 must not silently produce an all-NaN series."""
    series = make_series([100.0] * 30)
    assert compute(series, "EMA", period=0).validity is Validity.INVALID_INPUT
    assert compute(series, "RSI", period=0).validity is Validity.INVALID_INPUT
    assert compute(series, "MACD", fast=0, slow=26, signal=9).validity is Validity.INVALID_INPUT


# --------------------------------------------------------------------------- #
# V0 audit #21: ATR is Wilder's RMA, not an EMA of true range
#
# The finding was reported as "may be" and was worth checking rather than
# assuming. It was real, but on one side only: this engine was already
# correct, while the TypeScript implementation smoothed true range with
# an EMA. The two agree on the seed bar and then diverge, because an EMA
# uses alpha = 2/(period + 1) and Wilder uses alpha = 1/period.
# --------------------------------------------------------------------------- #

#: Deterministic OHLC bars. Bar 3 gaps up and bar 7 gaps down, so on both
#: the previous close dominates the bar's own range. That is the case
#: which distinguishes a correct true range from a naive high-low, and
#: it is the case a hand-written reference must include.
ATR_AUDIT_BARS = [
    (10.0, 12.0, 9.5, 11.0),
    (11.0, 13.0, 10.5, 12.5),
    (12.0, 14.0, 11.0, 13.0),
    (13.0, 34.0, 12.5, 31.0),
    (31.0, 33.0, 25.0, 32.0),
    (32.0, 36.0, 30.5, 35.0),
    (33.0, 37.0, 32.0, 34.0),
    (34.0, 24.0, 18.0, 22.0),
    (22.0, 26.0, 20.5, 25.0),
    (25.0, 27.0, 21.0, 22.5),
    (22.5, 29.0, 22.0, 28.0),
    (28.0, 30.0, 23.0, 24.0),
    (24.0, 32.0, 24.5, 31.0),
    (31.0, 33.0, 25.0, 32.5),
    (32.5, 35.0, 26.5, 34.0),
    (34.0, 36.0, 27.0, 28.0),
    (28.0, 38.0, 28.5, 37.0),
    (37.0, 39.0, 29.0, 30.0),
    (30.0, 41.0, 30.5, 40.0),
]


def _atr_audit_series(period: int = 14):
    opens = [bar[0] for bar in ATR_AUDIT_BARS]
    highs = [bar[1] for bar in ATR_AUDIT_BARS]
    lows = [bar[2] for bar in ATR_AUDIT_BARS]
    closes = [bar[3] for bar in ATR_AUDIT_BARS]
    return make_series(closes, highs=highs, lows=lows, opens=opens)


def _true_range_reference(bars) -> list[float]:
    """True range, written from the definition rather than from a library."""
    out = [bars[0][1] - bars[0][2]]
    for index in range(1, len(bars)):
        _, high, low, _ = bars[index]
        previous_close = bars[index - 1][3]
        out.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    return out


def _wilder_reference(true_range: list[float], period: int) -> list[float]:
    """Wilder's smoothing: SMA seed, then alpha = 1/period."""
    out = [float("nan")] * len(true_range)
    out[period - 1] = sum(true_range[:period]) / period
    for index in range(period, len(true_range)):
        out[index] = (out[index - 1] * (period - 1) + true_range[index]) / period
    return out


def _ema_reference(true_range: list[float], period: int) -> list[float]:
    """The smoothing the TypeScript implementation used, kept as the counter-example."""
    multiplier = 2 / (period + 1)
    out = [float("nan")] * len(true_range)
    out[period - 1] = sum(true_range[:period]) / period
    for index in range(period, len(true_range)):
        out[index] = (true_range[index] - out[index - 1]) * multiplier + out[index - 1]
    return out


def test_atr_matches_wilders_rma_on_a_hand_written_reference():
    period = 14
    computed = compute(_atr_audit_series(period), "ATR", period=period)
    assert computed.ok
    expected = _wilder_reference(_true_range_reference(ATR_AUDIT_BARS), period)
    for index in range(period - 1, len(ATR_AUDIT_BARS)):
        assert computed.values[index] == pytest.approx(expected[index], abs=1e-9), f"ATR[{index}]"


def test_atr_is_not_an_ema_of_true_range():
    """The reference test above would also pass an EMA if the two agreed.

    They do not. This pins the distinction so reverting to an EMA
    cannot pass, and so nobody 'simplifies' the smoothing away.
    """
    period = 14
    computed = compute(_atr_audit_series(period), "ATR", period=period)
    true_range = _true_range_reference(ATR_AUDIT_BARS)
    wilder = _wilder_reference(true_range, period)
    ema = _ema_reference(true_range, period)
    diverged = [index for index in range(period, len(true_range)) if abs(wilder[index] - ema[index]) > 1e-6]
    assert diverged, "fixture is no longer discriminating between RMA and EMA"
    for index in diverged:
        assert computed.values[index] == pytest.approx(wilder[index], abs=1e-9)
        assert computed.values[index] != pytest.approx(ema[index], abs=1e-6), f"ATR[{index}] looks like an EMA"


def test_atr_does_not_invent_a_zero_before_it_can_be_computed():
    """A fabricated 0.0 is a value a condition can compare against.

    ``ta`` seeds ATR with np.zeros, so before the first real sample the
    engine used to report 0.0 -- indistinguishable from a real ATR of
    zero. ``ATR(14) < 2`` would then have been TRUE during warmup.
    """
    period = 14
    computed = compute(_atr_audit_series(period), "ATR", period=period)
    early = np.asarray(computed.values[: period - 1], dtype=float)
    assert early.size > 0
    assert not np.any(np.isfinite(early)), f"ATR reports a value before it is computable: {early}"


def test_no_indicator_reports_a_fabricated_value_before_its_warmup_boundary():
    """A placeholder that ignores its input is a value a condition can compare against.

    Two signals are conflated by a naive "is it NaN" check, and only one
    of them is a bug:

    * a *fabricated* value, which is constant no matter what the candles
      say. That is the ``np.zeros`` seed this suite exists to catch.
    * a *conservatively declared* warmup, where a genuine value is
      available earlier than the indicator admits to. That is safe --
      it only makes the engine ask for more history than it needs.

    The two are told apart by perturbation: a real value moves when the
    input moves, a placeholder does not.
    """
    import numpy as _np
    from tradingv_engine import indicators as _indicators

    def build(scale: float, phase: float):
        length = 60
        ramp = _np.arange(length, dtype=float)
        closes = (scale + _np.sin((ramp + phase) / 3.0) * 4.0 + ramp * 0.05).tolist()
        return make_series(
            closes,
            highs=[value + 1.5 + abs(float(_np.sin(index + phase))) for index, value in enumerate(closes)],
            lows=[value - 1.5 - abs(float(_np.cos(index + phase))) for index, value in enumerate(closes)],
            opens=[value - 0.4 for value in closes],
            volumes=[1000.0 * scale + abs(float(_np.sin(index / 2.0))) * 500 for index in range(length)],
        )

    first = build(100.0, 0.0)
    second = build(250.0, 1.7)

    fabricated: list[str] = []
    for name in sorted(_indicators.INDICATORS):
        left = _indicators.compute(first, name)
        right = _indicators.compute(second, name)
        if not (left.ok and right.ok) or left.values.size == 0 or right.values.size == 0:
            continue
        boundary = max(left.warmup - 1, 0)
        for index in range(min(boundary, left.values.size, right.values.size)):
            a, b = left.values[index], right.values[index]
            if _np.isfinite(a) and _np.isfinite(b) and abs(float(a) - float(b)) < 1e-9:
                fabricated.append(f"{name}[{index}] is {a:g} for two different markets")
                break
    assert not fabricated, "indicators reporting a value that ignores its input: " + "; ".join(fabricated)
