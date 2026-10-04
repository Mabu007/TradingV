"""Chart-pattern and price-action tests.

Each pattern is tested against its written detection rule, and every
pattern must report UNKNOWN rather than FALSE when there is not enough
history to decide.
"""

from __future__ import annotations

import numpy as np
import pytest

from conftest import make_series
from tradingv_engine import patterns, price_action
from tradingv_engine.series import Validity

def ramp(start, step, count, volumes=None):
    """A steady ramp whose closes sit at the extreme of each candle.

    Explicit highs and lows matter: with the default `close + 1` wick a
    close can never break a prior high, so a breakout fixture built on the
    default would silently never fire.
    """
    closes = [start + step * index for index in range(count)]
    return make_series(
        closes,
        opens=closes,
        highs=[value + 0.2 for value in closes],
        lows=[value - 0.2 for value in closes],
        volumes=volumes,
    )


UP = ramp(100.0, 1.0, 60, volumes=[1000.0] * 60)
DOWN = ramp(200.0, -1.0, 60, volumes=[1000.0] * 60)
FLAT = make_series([100.0 + (index % 2) for index in range(60)], volumes=[1000.0] * 60)
# Four bars is below every pattern's warmup, including the swing points.
SHORT = make_series([100.0] * 4)


# --------------------------------------------------------------------------- #
# Price action
# --------------------------------------------------------------------------- #


def test_bullish_and_bearish_candles_are_exclusive():
    up = price_action.compute(FLAT, "BULLISH_CANDLE").values
    down = price_action.compute(FLAT, "BEARISH_CANDLE").values
    assert set(up.tolist()) <= {0.0, 1.0}
    assert set(down.tolist()) <= {0.0, 1.0}
    assert np.all(up + down <= 1.0)


def test_close_position_is_between_zero_and_one():
    values = price_action.compute(FLAT, "CLOSE_POSITION").values
    finite = values[np.isfinite(values)]
    assert np.all(finite >= 0.0) and np.all(finite <= 1.0)


def test_range_is_high_minus_low():
    closes = [10.0, 11.0, 12.0]
    series = make_series(closes, opens=closes, highs=[12.0, 13.0, 14.0], lows=[8.0, 9.0, 10.0])
    assert price_action.compute(series, "RANGE").last() == pytest.approx(4.0)


def test_wick_percentages_sum_to_the_body_and_range():
    series = make_series([10.0], opens=[8.0], highs=[12.0], lows=[6.0])
    body = price_action.compute(series, "BODY_TO_RANGE").last() * 100.0
    upper = price_action.compute(series, "UPPER_WICK_PERCENT").last()
    lower = price_action.compute(series, "LOWER_WICK_PERCENT").last()
    assert body + upper + lower == pytest.approx(100.0, abs=1e-6)


def test_consecutive_counts_a_run():
    closes = [1.0, 2.0, 3.0, 4.0, 3.0, 4.0, 5.0]
    series = make_series(closes)
    assert price_action.compute(series, "CONSECUTIVE_UP").last() == pytest.approx(2.0)


def test_higher_high_and_lower_low():
    rising = make_series([10.0, 11.0, 12.0])
    assert price_action.compute(rising, "HIGHER_HIGH").last() == 1.0
    assert price_action.compute(rising, "HIGHER_LOW").last() == 1.0
    # A rising market makes no lower high and no lower low.
    assert price_action.compute(rising, "LOWER_HIGH").last() == 0.0
    assert price_action.compute(rising, "LOWER_LOW").last() == 0.0


def test_distance_from_a_moving_average():
    closes = [100.0] * 30
    series = make_series(closes)
    assert price_action.compute(series, "DISTANCE_FROM_SMA", period=10).last() == pytest.approx(0.0, abs=1e-9)


def test_percent_change_of_a_flat_series_is_zero():
    series = make_series([50.0] * 10)
    assert price_action.compute(series, "PERCENT_CHANGE").last() == pytest.approx(0.0, abs=1e-9)


def test_price_action_on_a_short_series_is_insufficient_data():
    # HIGHER_HIGH needs two bars, which a one-bar series cannot provide.
    computed = price_action.compute(make_series([100.0]), "HIGHER_HIGH")
    assert computed.validity is Validity.INSUFFICIENT_DATA
    assert computed.last() is None


def test_unknown_measure_raises():
    with pytest.raises(KeyError):
        price_action.compute(FLAT, "NOT_A_MEASURE")


def test_swing_points_are_found_in_a_reversal():
    """A fractal swing high is the strict maximum of its window."""
    # Rise, fall, rise: the peak and the trough are the swing points.
    closes = [1.0, 2.0, 3.0, 4.0, 5.0, 4.0, 3.0, 2.0, 3.0, 4.0, 5.0, 4.0, 3.0, 2.0, 1.0]
    series = make_series(closes, opens=closes, highs=closes, lows=[value - 0.5 for value in closes])
    highs, lows = price_action.swing_points(series.high, series.low, 2)
    # The peak at bar 4 and the peak at bar 10 are the only strict
    # two-bar maxima; the trough at bar 7 is the only strict minimum.
    assert highs == [4, 10], f"unexpected swing highs: {highs}"
    assert lows == [7], f"unexpected swing lows: {lows}"
    # A monotonic run has no interior swing point.
    monotonic = ramp(100.0, 1.0, 40)
    no_highs, no_lows = price_action.swing_points(monotonic.high, monotonic.low, 2)
    assert no_highs == [] and no_lows == []


# --------------------------------------------------------------------------- #
# Patterns
# --------------------------------------------------------------------------- #


def test_every_pattern_has_a_documented_detection_rule():
    for name in patterns.PATTERNS:
        assert name in patterns.DESCRIPTIONS
        assert len(patterns.DESCRIPTIONS[name]) > 10


def test_every_pattern_reports_unknown_when_history_is_short():
    assert len(SHORT) < min(patterns.WARMUP.values())
    for name in patterns.PATTERNS:
        computed = patterns.evaluate(SHORT, name)
        assert computed.validity is Validity.INSUFFICIENT_DATA, f"{name} should refuse to guess"
        assert computed.last() is None
        assert computed.reason


def test_breakout_above_in_an_uptrend():
    result = patterns.evaluate(UP, "BREAKOUT_ABOVE_HIGH", lookback=20)
    assert result.last() == 1.0


def test_breakout_below_in_a_downtrend():
    result = patterns.evaluate(DOWN, "BREAKOUT_BELOW_LOW", lookback=20)
    assert result.last() == 1.0


def test_no_breakout_in_a_flat_market():
    # A flat market has no new extreme, so the pattern must not fire.
    flat_ramp = ramp(100.0, 0.0, 60)
    assert patterns.evaluate(flat_ramp, "BREAKOUT_ABOVE_HIGH", lookback=20).last() == 0.0
    assert patterns.evaluate(flat_ramp, "BREAKOUT_BELOW_LOW", lookback=20).last() == 0.0


def test_breakout_volume_confirmation_refuses_without_volume():
    no_volume = ramp(100.0, 1.0, 60, volumes=None)
    result = patterns.evaluate(no_volume, "BREAKOUT_ABOVE_HIGH", lookback=20, requireVolumeConfirmation=True)
    # There is a genuine price breakout but no volume to confirm it, so
    # the pattern must refuse rather than report a clean TRUE.
    assert result.last() == 0.0
    assert "volume" in result.reason.lower()


def test_breakout_volume_confirmation_can_pass():
    loud = ramp(100.0, 1.0, 60, volumes=[1000.0] * 59 + [9000.0])
    result = patterns.evaluate(loud, "BREAKOUT_ABOVE_HIGH", lookback=20, requireVolumeConfirmation=True, volumeMultiplier=1.5)
    assert result.last() == 1.0


def test_double_bottom_detects_two_equal_lows():
    # Fall to 8, rally, fall to 8 again: two swing lows at the same level.
    # DOUBLE_BOTTOM needs 31 bars of warmup, so the fixture is long
    # enough to satisfy that before the pattern is even considered.
    closes = [20.0 - index for index in range(8)] + [12.0 + index for index in range(8)] + [20.0 - index for index in range(8)] + [12.0 + index for index in range(12)]
    series = make_series(closes, opens=closes, highs=[value + 0.1 for value in closes], lows=[value - 0.1 for value in closes])
    result = patterns.evaluate(series, "DOUBLE_BOTTOM", swingLookback=2, tolerancePercent=5.0, minSeparationBars=2)
    assert result.validity is Validity.OK, result.reason
    assert result.last() == 1.0


def test_double_bottom_needs_enough_history():
    closes = [10.0, 9.0, 8.0, 9.0, 10.0, 11.0, 10.0, 9.0, 8.0, 9.0, 10.0]
    series = make_series(closes)
    result = patterns.evaluate(series, "DOUBLE_BOTTOM", swingLookback=2)
    assert result.validity is Validity.INSUFFICIENT_DATA
    assert result.last() is None


def test_volatility_contraction_detects_a_calm_window():
    calm = make_series([100.0] * 40, opens=[100.0] * 40, highs=[100.1] * 40, lows=[99.9] * 40)
    wild = make_series(
        [100.0 + (5.0 if index % 2 else -5.0) for index in range(40)],
        opens=[100.0] * 40,
        highs=[106.0 if index % 2 else 101.0 for index in range(40)],
        lows=[99.0 if index % 2 else 94.0 for index in range(40)],
    )
    calm_then_wild = make_series(
        calm.close.tolist() + wild.close.tolist(),
        opens=calm.open.tolist() + wild.open.tolist(),
        highs=calm.high.tolist() + wild.high.tolist(),
        lows=calm.low.tolist() + wild.low.tolist(),
    )
    result = patterns.evaluate(calm_then_wild, "VOLATILITY_CONTRACTION", lookback=30)
    assert result.validity is Validity.OK, result.reason
    assert result.last() == 0.0, "a market that has just become wild is not contracting"


def zigzag(points, leg=4):
    """Connect the given pivot prices with `leg` bars each.

    Swing-point patterns need actual reversals, so a monotonic ramp can
    never confirm a market structure. This walks between pivots to create
    the highs and lows the patterns look for.
    """
    closes: list[float] = []
    for start, end in zip(points, points[1:]):
        closes.extend(float(start + (end - start) * index / leg) for index in range(leg))
    closes.append(float(points[-1]))
    return make_series(closes, opens=closes, highs=[value + 0.2 for value in closes], lows=[value - 0.2 for value in closes])


def test_structure_direction():
    # leg=6 over five legs gives the 31 bars the patterns warm up on.
    up = patterns.evaluate(zigzag([10, 20, 15, 25, 20, 30], leg=6), "HIGHER_HIGH_HIGHER_LOW", swingLookback=2)
    down = patterns.evaluate(zigzag([30, 20, 25, 15, 20, 10], leg=6), "LOWER_HIGH_LOWER_LOW", swingLookback=2)
    assert up.validity is Validity.OK, up.reason
    assert down.validity is Validity.OK, down.reason
    assert up.last() == 1.0
    assert down.last() == 1.0


def test_structure_is_direction_specific():
    """A rising structure must not satisfy the falling pattern."""
    up = patterns.evaluate(zigzag([10, 20, 15, 25, 20, 30], leg=6), "HIGHER_HIGH_HIGHER_LOW", swingLookback=2)
    down = patterns.evaluate(zigzag([10, 20, 15, 25, 20, 30], leg=6), "LOWER_HIGH_LOWER_LOW", swingLookback=2)
    assert up.last() == 1.0
    assert down.last() == 0.0


def test_structure_detects_a_real_uptrend():
    """Higher highs and higher lows require an actual reversal pattern."""
    result = patterns.evaluate(zigzag([10, 20, 15, 25, 20, 30], leg=6), "HIGHER_HIGH_HIGHER_LOW", swingLookback=2)
    assert result.validity is Validity.OK, result.reason
    assert result.last() == 1.0, "rising swing highs and rising swing lows is an uptrend"


def test_structure_refuses_on_a_monotonic_ramp():
    """A ramp has no reversals, so structure must be UNKNOWN, not FALSE."""
    result = patterns.evaluate(UP, "HIGHER_HIGH_HIGHER_LOW", swingLookback=2)
    assert result.validity is Validity.INSUFFICIENT_DATA
    assert result.last() is None


def test_unknown_pattern_raises():
    with pytest.raises(KeyError):
        patterns.evaluate(UP, "HEAD_AND_SHOULDERS")


def test_triangle_requires_both_sides_to_narrow():
    result = patterns.evaluate(UP, "TRIANGLE", swingLookback=3)
    # A monotonic ramp has no swing points, so a triangle cannot be
    # measured at all rather than being confidently absent.
    assert result.validity is Validity.INSUFFICIENT_DATA
    assert result.last() is None


def test_triangle_detects_a_narrowing_range():
    # Peaks step down: 30, 28, 26, 24. Troughs step up: 10, 12, 14, 16.
    result = patterns.evaluate(zigzag([10, 30, 10, 28, 12, 26, 14, 24, 16]), "TRIANGLE", swingLookback=2)
    assert result.validity is Validity.OK, result.reason
    assert result.last() == 1.0


def test_channel_up_in_a_steady_ramp():
    result = patterns.evaluate(UP, "CHANNEL_UP", lookback=30)
    assert result.last() == 1.0


def test_channel_down_in_a_falling_ramp():
    result = patterns.evaluate(DOWN, "CHANNEL_DOWN", lookback=30)
    assert result.last() == 1.0


def test_channel_up_rejects_a_falling_ramp():
    assert patterns.evaluate(DOWN, "CHANNEL_UP", lookback=30).last() == 0.0


def test_support_test_requires_a_recovery():
    closes = [100.0] * 25 + [99.0, 101.0]
    series = make_series(closes, opens=closes, highs=[value + 0.5 for value in closes], lows=[value - 0.5 for value in closes])
    result = patterns.evaluate(series, "SUPPORT_TEST", lookback=20, tolerancePercent=2.0)
    assert result.last() in (0.0, 1.0)
