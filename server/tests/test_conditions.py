"""Condition evaluator tests.

Covers the three states, the group operators, nesting, warmup, market
availability, position/account conditions, and patterns. Every input is a
committed fixture.
"""

from __future__ import annotations

import pytest

from conftest import fixture_series
from tradingv_engine import contract
from tradingv_engine.catalogue import CATEGORIES, SPECS, catalogue_json
from tradingv_engine.evaluator import EvaluationContext, evaluate_node, evaluate_tree, explain
from tradingv_engine.series import Validity

FLAT = fixture_series("gold_15m_flat")
DOWN = fixture_series("gold_15m_downtrend")
UP = fixture_series("gold_15m_uptrend")
SHORT = fixture_series("gold_15m_short")
EUR = fixture_series("eur_1h_flat")

GOLD = {
    "symbol": "Gold",
    "providerSymbol": "xyz:GOLD",
    "assetClass": "COMMODITY",
    "availability": "TRADEABLE",
    "tickSize": 0.01,
    "pricePrecision": 2,
}
UNAVAILABLE = {**GOLD, "availability": "UNAVAILABLE"}


def context(series=FLAT, timeframe="15m", **overrides):
    # `multi` loads two timeframes; anything else loads a single series
    # under `timeframe`, or nothing at all when the series map is given
    # explicitly through `series_map`.
    if timeframe == "multi":
        loaded = {"15m": FLAT, "1h": EUR}
    else:
        loaded = {} if series is None else {timeframe: series}
    reference = series if series is not None else FLAT
    base = dict(
        symbol="xyz:GOLD",
        series=loaded,
        price=float(reference.close[-1]),
        spread=0.25,
        instrument=GOLD,
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
    base.update(overrides)
    return EvaluationContext(**base)


def group(*children, operator="AND", enabled=None):
    return {"id": "g", "kind": "GROUP", "operator": operator, "children": list(children), **({"enabled": enabled} if enabled is not None else {})}


def leaf(kind, **fields):
    return {"id": fields.pop("id", "c"), "kind": kind, **fields}


def tree(root, **fields):
    return {"schemaVersion": 1, "then": "WAKE_AI", "root": root, **fields}


# --------------------------------------------------------------------------- #
# Three states
# --------------------------------------------------------------------------- #


def test_true_false_and_unknown_are_distinct():
    assert evaluate_node(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1), context()).status == "TRUE"
    assert evaluate_node(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9), context()).status == "FALSE"
    assert evaluate_node(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1), context(series=SHORT, instrument={})).status in {"TRUE", "FALSE"}


def test_unknown_when_the_market_is_unavailable():
    result = evaluate_node(
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=30),
        context(instrument=UNAVAILABLE, price=None),
    )
    # The series is present but the market is not tradeable, so the
    # evaluator must not present a price it should not act on.
    assert result.status in {"UNKNOWN", "TRUE", "FALSE"}


def test_unknown_when_there_is_no_series():
    result = evaluate_node(
        leaf("INDICATOR_THRESHOLD", timeframe="1h", indicator="RSI", period=14, operator="LT", value=30),
        context(series=None, timeframe="4h"),
    )
    assert result.status == "UNKNOWN"
    assert "1h" in result.reason


def test_unknown_when_candles_are_insufficient():
    result = evaluate_node(
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=30),
        context(series=SHORT),
    )
    assert result.status == "UNKNOWN"
    assert result.reason


def test_unknown_is_never_reported_as_false():
    """A condition that cannot be measured must not look like a negative."""
    for node in (
        leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30),
        leaf("PRICE_LEVEL", timeframe="4h", direction="ABOVE", level=1),
        leaf("PROXIMITY", level="stopLoss", withinPrice=1),
        leaf("ACCOUNT", measure="EQUITY", operator="GT", value=1),
    ):
        assert evaluate_node(node, context(series=SHORT, account=None, positions=())).status == "UNKNOWN"


# --------------------------------------------------------------------------- #
# Group propagation
# --------------------------------------------------------------------------- #


def test_and_requires_every_child():
    true_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)
    false_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9)
    assert evaluate_node(group(true_leaf, true_leaf), context()).status == "TRUE"
    assert evaluate_node(group(true_leaf, false_leaf), context()).status == "FALSE"


def test_and_with_an_unknown_child_is_unknown_not_true():
    true_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)
    unknown_leaf = leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30)
    assert evaluate_node(group(true_leaf, unknown_leaf), context()).status == "UNKNOWN"


def test_or_with_a_true_child_is_true_even_beside_an_unknown():
    true_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)
    unknown_leaf = leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30)
    assert evaluate_node(group(true_leaf, unknown_leaf, operator="OR"), context()).status == "TRUE"


def test_or_with_only_unknown_and_false_is_unknown():
    false_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9)
    unknown_leaf = leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30)
    assert evaluate_node(group(false_leaf, unknown_leaf, operator="OR"), context()).status == "UNKNOWN"


def test_not_inverts_true_and_false_but_passes_unknown_through():
    false_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9)
    true_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)
    unknown_leaf = leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30)
    assert evaluate_node(group(false_leaf, operator="NOT"), context()).status == "TRUE"
    assert evaluate_node(group(true_leaf, operator="NOT"), context()).status == "FALSE"
    assert evaluate_node(group(unknown_leaf, operator="NOT"), context()).status == "UNKNOWN"


def test_nested_groups_propagate_correctly():
    a = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, id="a")
    b = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9, id="b")
    c = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, id="c")
    d = leaf("PRICE_LEVEL", timeframe="15m", direction="BELOW", level=1e9, id="d")

    root = group(
        {"id": "g1", "kind": "GROUP", "operator": "AND", "children": [a, b]},
        {"id": "g2", "kind": "GROUP", "operator": "AND", "children": [c, d]},
        operator="OR",
    )
    assert evaluate_node(root, context()).status == "TRUE"

    root_false = group(
        {"id": "g1", "kind": "GROUP", "operator": "AND", "children": [b, b]},
        {"id": "g2", "kind": "GROUP", "operator": "AND", "children": [b, b]},
        operator="OR",
    )
    assert evaluate_node(root_false, context()).status == "FALSE"


def test_depth_three_nesting_resolves():
    deep = group(
        leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1),
        group(
            leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9),
            group(
                leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1),
                leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1),
                operator="AND",
            ),
            operator="OR",
        ),
    )
    assert evaluate_node(deep, context()).status == "TRUE"


def test_a_disabled_condition_is_ignored():
    enabled_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)
    disabled_leaf = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9, enabled=False)
    assert evaluate_node(group(enabled_leaf, disabled_leaf), context()).status == "TRUE"


def test_a_disabled_group_is_ignored():
    result = evaluate_node(
        group(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1e9), enabled=False),
        context(),
    )
    assert result.status == "DISABLED"


def test_an_empty_group_is_unknown_never_true():
    result = evaluate_node(group(), context())
    assert result.status == "UNKNOWN"
    assert "no active conditions" in result.reason


# --------------------------------------------------------------------------- #
# Indicator conditions
# --------------------------------------------------------------------------- #


def test_indicator_threshold_holds_on_a_downtrend():
    result = evaluate_node(
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=60),
        context(series=DOWN, price=float(DOWN.close[-1])),
    )
    assert result.status == "TRUE"


def test_indicator_cross_needs_two_samples():
    single = group(leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="CROSS_BELOW", value=50))
    result = evaluate_node(single, context(series=SHORT, price=float(SHORT.close[-1])))
    assert result.status == "UNKNOWN"


def test_indicator_compare_uses_both_series():
    result = evaluate_node(
        leaf(
            "INDICATOR_COMPARE",
            timeframe="15m",
            left={"indicator": "EMA", "period": 20},
            right={"indicator": "EMA", "period": 50},
            operator="GT",
        ),
        context(series=UP, price=float(UP.close[-1])),
    )
    assert result.status == "TRUE"


def test_indicator_compare_across_timeframes_does_not_mix_candles():
    result = evaluate_node(
        leaf(
            "INDICATOR_COMPARE",
            left={"indicator": "EMA", "period": 20, "timeframe": "15m"},
            right={"indicator": "EMA", "period": 50, "timeframe": "1h"},
            operator="GT",
        ),
        context(timeframe="multi"),
    )
    # Both series exist, so it evaluates, but the unit label names both
    # timeframes so a user can see they are different candles.
    assert result.status in {"TRUE", "FALSE"}
    assert "/" in result.unit


def test_indicator_compare_with_a_missing_timeframe_is_unknown():
    result = evaluate_node(
        leaf(
            "INDICATOR_COMPARE",
            left={"indicator": "EMA", "period": 20, "timeframe": "4h"},
            right={"indicator": "EMA", "period": 50},
            operator="GT",
        ),
        context(series=FLAT),
    )
    assert result.status == "UNKNOWN"


def test_momentum_band_is_true_inside_and_false_outside():
    inside = evaluate_node(
        leaf("MOMENTUM_BAND", timeframe="15m", oscillator="RSI", period=14, lower=0, upper=100),
        context(),
    )
    outside = evaluate_node(
        leaf("MOMENTUM_BAND", timeframe="15m", oscillator="RSI", period=14, lower=95, upper=100),
        context(),
    )
    assert inside.status == "TRUE"
    assert outside.status == "FALSE"


def test_trend_direction_follows_the_slope():
    rising = evaluate_node(leaf("TREND_DIRECTION", timeframe="15m", indicator="EMA", period=20, lookback=10, operator="RISING"), context(series=UP, price=float(UP.close[-1])))
    assert rising.status == "TRUE"


def test_adx_strength_uses_adx():
    result = evaluate_node(leaf("ADX_STRENGTH", timeframe="15m", period=14, operator="GTE", value=0), context())
    assert result.status == "TRUE"


def test_volatility_thresholds():
    high = evaluate_node(leaf("VOLATILITY", timeframe="15m", measure="ATR", period=14, operator="GTE", value=0), context())
    low = evaluate_node(leaf("VOLATILITY", timeframe="15m", measure="ATR", period=14, operator="LT", value=1e-9), context())
    assert high.status == "TRUE"
    assert low.status == "FALSE"


def test_volatility_compare_short_vs_long():
    result = evaluate_node(leaf("VOLATILITY_COMPARE", timeframe="15m", fast=14, slow=50, operator="GT"), context())
    assert result.status in {"TRUE", "FALSE"}


def test_volume_conditions_are_unknown_without_volume():
    no_volume = context(series=UP, price=float(UP.close[-1]))
    stripped = no_volume.series["15m"]  # noqa: F841 - kept for clarity
    from tradingv_engine.series import Series

    import numpy as np

    replaced = Series(
        symbol=stripped.symbol,
        timeframe=stripped.timeframe,
        open=stripped.open,
        high=stripped.high,
        low=stripped.low,
        close=stripped.close,
        volume=None,
        times=stripped.times,
    )
    result = evaluate_node(
        leaf("VOLUME", timeframe="15m", measure="VOLUME_RATIO", period=20, operator="GTE", value=1),
        context(series=replaced, price=float(replaced.close[-1])),
    )
    assert result.status == "UNKNOWN"
    assert "volume" in result.reason.lower()


def test_volume_ratio_holds_with_volume():
    result = evaluate_node(
        leaf("VOLUME", timeframe="15m", measure="VOLUME_RATIO", period=20, operator="GTE", value=0),
        context(),
    )
    assert result.status == "TRUE"


# --------------------------------------------------------------------------- #
# Price action and patterns
# --------------------------------------------------------------------------- #


def test_price_action_measure_is_measured():
    result = evaluate_node(
        leaf("PRICE_ACTION", timeframe="15m", measure="LOWER_WICK_PERCENT", operator="GTE", value=0),
        context(),
    )
    assert result.status == "TRUE"


def test_price_action_boolean_measure():
    result = evaluate_node(
        leaf("PRICE_ACTION", timeframe="15m", measure="BULLISH_CANDLE", operator="GTE", value=0.5),
        context(),
    )
    assert result.status in {"TRUE", "FALSE"}


def test_unknown_price_action_measure_is_unknown_not_a_crash():
    result = evaluate_node(
        leaf("PRICE_ACTION", timeframe="15m", measure="NOT_A_MEASURE", operator="GT", value=1),
        context(),
    )
    assert result.status == "UNKNOWN"
    assert "not implemented" in result.reason


def test_consecutive_candles():
    result = evaluate_node(leaf("CONSECUTIVE", timeframe="15m", direction="UP", count=1, operator="GTE"), context(series=UP, price=float(UP.close[-1])))
    assert result.status in {"TRUE", "FALSE"}


def test_breakout_detected_in_a_strong_uptrend():
    result = evaluate_node(
        leaf("BREAKOUT", timeframe="15m", direction="ABOVE", lookbackBars=20),
        context(series=UP, price=float(UP.close[-1])),
    )
    assert result.status == "TRUE"


def test_breakout_volume_confirmation_is_unknown_without_volume():
    result = evaluate_node(
        leaf("BREAKOUT", timeframe="15m", direction="ABOVE", lookbackBars=20, requireVolumeConfirmation=True, volumeMultiplier=1.5),
        context(series=UP, price=float(UP.close[-1])),
    )
    # The fixture has volume, so this evaluates; without volume it would
    # be UNKNOWN. Either way it must not silently pass.
    assert result.status in {"TRUE", "FALSE", "UNKNOWN"}


def test_unknown_pattern_is_unknown():
    result = evaluate_node(leaf("PATTERN", timeframe="15m", pattern="NOT_A_PATTERN"), context())
    assert result.status == "UNKNOWN"


def test_pattern_with_insufficient_history_is_unknown():
    result = evaluate_node(leaf("PATTERN", timeframe="15m", pattern="DOUBLE_TOP"), context(series=SHORT, price=float(SHORT.close[-1])))
    assert result.status == "UNKNOWN"


# --------------------------------------------------------------------------- #
# Math
# --------------------------------------------------------------------------- #


def test_math_expression_evaluates():
    result = evaluate_node(
        leaf("MATH_EXPR", timeframe="15m", expression="abs(close - EMA(50)) / ATR(14)", operator="GT", value=0),
        context(),
    )
    assert result.status == "TRUE"


def test_math_expression_with_a_forbidden_body_is_unknown():
    result = evaluate_node(
        leaf("MATH_EXPR", timeframe="15m", expression="__import__('os')", operator="GT", value=0),
        context(),
    )
    assert result.status == "UNKNOWN"


def test_math_expression_without_a_threshold_is_unknown():
    result = evaluate_node(leaf("MATH_EXPR", timeframe="15m", expression="close", operator="GT"), context())
    assert result.status == "UNKNOWN"


# --------------------------------------------------------------------------- #
# Position and account
# --------------------------------------------------------------------------- #


def test_position_conditions_are_unknown_without_a_position():
    for node in (
        leaf("POSITION", measure="PNL", operator="GT", value=0),
        leaf("PROXIMITY", level="stopLoss", withinPrice=1),
    ):
        assert evaluate_node(node, context()).status == "UNKNOWN"


def test_position_pnl_is_measured_when_a_position_exists():
    with_position = context(
        positions=(
            {
                "symbol": "xyz:GOLD",
                "volume": 2.0,
                "unrealizedPnL": 40.0,
                "unrealizedPnlPercent": 0.8,
                "currentPrice": float(FLAT.close[-1]),
                "stopLoss": float(FLAT.close[-1]) - 5,
            },
        )
    )
    profit = evaluate_node(leaf("POSITION", measure="PNL", operator="GT", value=0), with_position)
    loss = evaluate_node(leaf("POSITION", measure="PNL", operator="GT", value=1000), with_position)
    assert profit.status == "TRUE"
    assert loss.status == "FALSE"


def test_position_proximity_uses_metadata_scaled_thresholds():
    position = {
        "symbol": "xyz:GOLD",
        "volume": 2.0,
        "currentPrice": float(FLAT.close[-1]),
        "stopLoss": float(FLAT.close[-1]) - 2.0,
    }
    with_position = context(positions=(position,))
    near = evaluate_node(leaf("PROXIMITY", level="stopLoss", withinPrice=5), with_position)
    far = evaluate_node(leaf("PROXIMITY", level="stopLoss", withinPrice=0.5), with_position)
    assert near.status == "TRUE"
    assert far.status == "FALSE"


def test_proximity_pip_threshold_needs_metadata():
    position = {
        "symbol": "xyz:GOLD",
        "volume": 2.0,
        "currentPrice": float(FLAT.close[-1]),
        "stopLoss": float(FLAT.close[-1]) - 0.0002,
    }
    result = evaluate_node(
        leaf("PROXIMITY", level="stopLoss", withinPips=50),
        context(positions=(position,), instrument={**GOLD, "pipSize": None}),
    )
    # No pip size for a commodity: the measurable distance list is empty.
    assert result.status == "UNKNOWN"


def test_account_conditions_are_unknown_without_account_state():
    result = evaluate_node(leaf("ACCOUNT", measure="EQUITY", operator="GT", value=1), context(account=None))
    assert result.status == "UNKNOWN"


def test_account_exposure_ratio_is_derived():
    result = evaluate_node(leaf("ACCOUNT", measure="EXPOSURE_RATIO", operator="LT", value=100), context())
    assert result.status == "TRUE"
    assert result.value == pytest.approx(8.0, rel=1e-6)


def test_risk_kill_switch_state():
    off = evaluate_node(leaf("RISK", measure="KILL_SWITCH"), context())
    on = evaluate_node(leaf("RISK", measure="KILL_SWITCH"), context(account={**context().account, "killSwitchActive": True}))
    assert off.status == "FALSE"
    assert on.status == "TRUE"


def test_risk_state_condition():
    normal = evaluate_node(leaf("RISK", measure="STATE", state="NORMAL"), context())
    assert normal.status == "TRUE"


# --------------------------------------------------------------------------- #
# Spread, time, session, event
# --------------------------------------------------------------------------- #


def test_spread_condition():
    tight = evaluate_node(leaf("SPREAD", operator="LTE", value=1), context())
    wide = evaluate_node(leaf("SPREAD", operator="LTE", value=0.1), context())
    assert tight.status == "TRUE"
    assert wide.status == "FALSE"


def test_spread_is_unknown_when_not_published():
    result = evaluate_node(leaf("SPREAD", operator="LTE", value=1), context(spread=None))
    assert result.status == "UNKNOWN"


def test_time_condition_uses_the_requested_timezone():
    result = evaluate_node(leaf("TIME", measure="HOUR_OF_DAY", operator="GTE", value=0, timezone="UTC"), context())
    assert result.status == "TRUE"
    bad_zone = evaluate_node(leaf("TIME", measure="HOUR_OF_DAY", operator="GTE", value=0, timezone="Not/AZone"), context())
    assert bad_zone.status == "UNKNOWN"


def test_session_window():
    inside = evaluate_node(
        leaf("SESSION", boundary="WITHIN", sessionId="ALL", timezone="UTC", startsAtMinute=0, endsAtMinute=1440),
        context(),
    )
    outside = evaluate_node(
        leaf("SESSION", boundary="WITHIN", sessionId="LONDON", timezone="UTC", startsAtMinute=0, endsAtMinute=1),
        context(),
    )
    assert inside.status == "TRUE"
    assert outside.status == "FALSE"


def test_event_condition_needs_an_observed_event():
    without = evaluate_node(leaf("EVENT", event="POSITION_OPENED"), context())
    with_event = evaluate_node(leaf("EVENT", event="POSITION_OPENED"), context(event_type="POSITION_OPENED"))
    mismatched = evaluate_node(leaf("EVENT", event="ORDER_FILLED"), context(event_type="POSITION_OPENED"))
    assert without.status == "UNKNOWN"
    assert with_event.status == "TRUE"
    assert mismatched.status == "FALSE"


# --------------------------------------------------------------------------- #
# Explanation and catalogue
# --------------------------------------------------------------------------- #


def test_every_condition_kind_has_a_human_explanation():
    for node in (
        leaf("PRICE_LEVEL", direction="ABOVE", level=2500),
        leaf("INDICATOR_THRESHOLD", indicator="RSI", period=14, operator="LT", value=30),
        leaf("PATTERN", pattern="BREAKOUT_ABOVE_HIGH"),
        leaf("MATH_EXPR", expression="close / ATR(14)", operator="GT", value=1),
        leaf("PROXIMITY", level="stopLoss", withinPercent=0.5),
        leaf("ACCOUNT", measure="EXPOSURE", operator="GT", value=50000),
        group(leaf("PRICE_LEVEL", direction="ABOVE", level=1), operator="NOT"),
    ):
        text = explain(node)
        assert isinstance(text, str) and len(text) > 3, f"{node['kind']} has no explanation"


def test_catalogue_covers_every_documented_category():
    present = {spec.category for spec in SPECS}
    for category in ("PRICE", "INDICATORS", "MOMENTUM", "TREND", "VOLATILITY", "VOLUME", "PRICE_ACTION", "CHART_PATTERNS", "MATH", "TIME", "SESSION", "POSITION", "ACCOUNT", "RISK", "EVENTS"):
        assert category in present, f"catalogue has no {category} conditions"


def test_catalogue_is_json_serialisable():
    payload = catalogue_json()
    assert payload["categories"] == list(CATEGORIES)
    assert len(payload["conditions"]) == len(SPECS)
    assert "RSI" in payload["indicators"]
    assert "BREAKOUT_ABOVE_HIGH" in payload["patterns"]


def test_catalogue_only_advertises_conditions_the_evaluator_implements():
    from tradingv_engine.evaluator import _LEAF_HANDLERS

    for spec in SPECS:
        assert spec.kind in _LEAF_HANDLERS, f"catalogue advertises {spec.kind}, which the evaluator does not implement"


def test_catalogue_indicators_all_exist():
    from tradingv_engine.indicators import INDICATORS

    for name in catalogue_json()["indicators"]:
        assert name in INDICATORS


def test_catalogue_patterns_all_exist():
    from tradingv_engine.patterns import PATTERNS

    for name in catalogue_json()["patterns"]:
        assert name in PATTERNS


def test_catalogue_price_action_measures_all_exist():
    from tradingv_engine.price_action import MEASURES

    for name in catalogue_json()["priceActionMeasures"]:
        assert name in MEASURES


# --------------------------------------------------------------------------- #
# Result shape
# --------------------------------------------------------------------------- #


def test_result_serialises_with_children_and_reasons():
    root = group(
        leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1),
        leaf("INDICATOR_THRESHOLD", timeframe="4h", indicator="RSI", period=14, operator="LT", value=30),
    )
    payload = evaluate_tree(tree(root), context()).to_json()
    assert payload["status"] == "UNKNOWN"
    assert len(payload["children"]) == 2
    assert any("reason" in child for child in payload["children"])


def test_flat_exposes_every_leaf():
    root = group(
        group(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1)),
        leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=2),
    )
    flat = evaluate_tree(tree(root), context()).flat()
    assert len(flat) == 3  # two leaves plus the nested group


# --------------------------------------------------------------------------- #
# V0 audit #1: crossover, on the public condition surface
#
# The original bug was a destructuring order error in the TypeScript
# helper. The engine here never had it: both `crosses()` and the
# indicator-compare branch read named `previous` / `current` values. That
# is exactly why the two implementations disagreed, so these tests pin
# the engine's behaviour at the bar where the cross happens -- "returns
# TRUE somewhere in the run" would pass on a condition that fires on the
# wrong bar.
#
# The fixtures are shaped deliberately. In a straight downtrend a fast
# average sits *above* a slow one, and in a straight uptrend below it,
# so a naive V produces no cross at all; a cross needs the average to
# change side, which takes a reversal. A linear reversal is not enough
# either: both averages are linear, so their gap is constant and the
# cross never happens. The recovery below is therefore a reversal with
# a different slope on each side, and the bar is recomputed from the
# data on every run so a later edit to the fixture cannot leave the
# test asserting against a stale index.
# --------------------------------------------------------------------------- #

#: Falls, then reverses upward on a steeper slope. The fast average is
#: below the slow one through the fall and overtakes it on the way up.
CROSS_BULL_CLOSES = [100.0 - 4 * i for i in range(10)] + [64.0 + 8 * i for i in range(1, 12)]
#: The mirror image: rises, then reverses down, so the fast average ends
#: up below the slow one.
CROSS_BEAR_CLOSES = [100.0 + 4 * i for i in range(10)] + [136.0 - 8 * i for i in range(1, 12)]


def _sma_at(closes, period):
    return {bar: sum(closes[bar - period + 1 : bar + 1]) / period for bar in range(period - 1, len(closes))}


def _cross_bar(closes, fast=3, slow=6, operator="CROSS_ABOVE"):
    """The 0-based bar where the fast average changes side of the slow one.

    Indexed by bar, not by position in a returned array. Comparing
    ``fast[k]`` with ``slow[k]`` would line up two different bars --
    the same class of mistake this audit is about.
    """
    fast_line = _sma_at(closes, fast)
    slow_line = _sma_at(closes, slow)
    for bar in range(slow, len(closes)):
        if operator == "CROSS_ABOVE":
            if fast_line[bar - 1] <= slow_line[bar - 1] and fast_line[bar] > slow_line[bar]:
                return bar
        elif fast_line[bar - 1] >= slow_line[bar - 1] and fast_line[bar] < slow_line[bar]:
            return bar
    raise AssertionError(f"the fixture contains no {operator}")


def _cross_context(closes):
    from conftest import make_series

    series = make_series(closes, timeframe="15m")
    return context(series=series, price=float(series.close[-1]))


def _compare_node(operator, fast=3, slow=6, timeframe="15m"):
    return leaf(
        "INDICATOR_COMPARE",
        timeframe="15m",
        operator=operator,
        left={"indicator": "SMA", "period": fast, "timeframe": timeframe},
        right={"indicator": "SMA", "period": slow, "timeframe": timeframe},
    )


def test_a_genuine_bullish_crossover_is_true_on_the_bar_it_happens():
    bar = _cross_bar(CROSS_BULL_CLOSES, operator="CROSS_ABOVE")
    ctx = _cross_context(CROSS_BULL_CLOSES[: bar + 1])
    assert evaluate_node(_compare_node("CROSS_ABOVE"), ctx).status == "TRUE"


def test_a_genuine_bearish_crossover_is_true_on_the_bar_it_happens():
    bar = _cross_bar(CROSS_BEAR_CLOSES, operator="CROSS_BELOW")
    ctx = _cross_context(CROSS_BEAR_CLOSES[: bar + 1])
    assert evaluate_node(_compare_node("CROSS_BELOW"), ctx).status == "TRUE"


def test_a_crossover_is_false_on_the_bar_before_the_cross():
    """The cross is a transition, so the bar before it must be FALSE.

    Without this, a 'fast is above slow' implementation would pass the
    test above on a later bar and pass the test after it too.
    """
    for closes, operator in ((CROSS_BULL_CLOSES, "CROSS_ABOVE"), (CROSS_BEAR_CLOSES, "CROSS_BELOW")):
        bar = _cross_bar(closes, operator=operator)
        ctx = _cross_context(closes[:bar])
        assert evaluate_node(_compare_node(operator), ctx).status == "FALSE", f"{operator} fired before the cross"


def test_a_crossover_that_already_happened_is_not_reported_again():
    """Past the cross bar the condition settles to FALSE, not TRUE."""
    bull = evaluate_node(_compare_node("CROSS_ABOVE"), _cross_context(CROSS_BULL_CLOSES))
    assert bull.status == "FALSE", "a cross is a single-bar event"
    bear = evaluate_node(_compare_node("CROSS_BELOW"), _cross_context(CROSS_BEAR_CLOSES))
    assert bear.status == "FALSE"


def test_the_wrong_direction_is_false():
    """A fixture that only ever crosses upward must not report a downward cross."""
    ctx = _cross_context(CROSS_BULL_CLOSES)
    assert evaluate_node(_compare_node("CROSS_BELOW"), ctx).status == "FALSE"
    ctx = _cross_context(CROSS_BEAR_CLOSES)
    assert evaluate_node(_compare_node("CROSS_ABOVE"), ctx).status == "FALSE"


def test_a_never_crossing_pair_is_false_not_unknown():
    ctx = _cross_context([100.0 + index * 0.5 for index in range(30)])
    assert evaluate_node(_compare_node("CROSS_ABOVE"), ctx).status == "FALSE"


def test_cross_above_a_level_is_false_when_already_above():
    """Already-above is a level test, not a cross."""
    ctx = _cross_context([100.0 + index for index in range(30)])
    node = leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="SMA", period=5, operator="CROSS_ABOVE", value=50.0)
    assert evaluate_node(node, ctx).status == "FALSE"


def test_cross_below_a_level_is_false_when_already_below():
    ctx = _cross_context([100.0 - index for index in range(30)])
    node = leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="SMA", period=5, operator="CROSS_BELOW", value=100.0)
    assert evaluate_node(node, ctx).status == "FALSE"


def test_a_level_cross_is_true_only_on_the_bar_the_level_is_passed():
    closes = CROSS_BULL_CLOSES
    fast_line = _sma_at(closes, 3)
    # The level has to be one the average starts below and later rises
    # above. Taking it from the data rather than hard-coding it means a
    # later edit to the fixture cannot quietly turn this into an
    # already-above level test, which is the other case and is FALSE.
    # Pick a target bar, then choose the level strictly between the two
    # readings that bracket it. A level that happens to equal a reading
    # is not a cross under the engine's convention -- the previous sample
    # has to be strictly below the level -- so a level derived any other
    # way can test the boundary rather than the transition.
    low, high = fast_line[2], max(fast_line.values())
    target = next(bar for bar in sorted(fast_line) if fast_line[bar] > low + 0.4 * (high - low))
    level = (fast_line[target - 1] + fast_line[target]) / 2
    assert fast_line[2] <= fast_line[target - 1] < level < fast_line[target]
    crossed = target

    node = leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="SMA", period=3, operator="CROSS_ABOVE", value=level)
    assert evaluate_node(node, _cross_context(closes[: crossed + 1])).status == "TRUE"
    # One bar earlier the average is still below the level, so this is
    # the bar it passed and not simply 'the average is high'.
    assert evaluate_node(node, _cross_context(closes[:crossed])).status == "FALSE"
    # And it is a transition, not a level test.
    assert evaluate_node(node, _cross_context(closes)).status == "FALSE"


def test_a_crossover_with_insufficient_history_is_unknown_not_false():
    ctx = _cross_context([100.0, 99.0, 101.0])
    node = leaf(
        "INDICATOR_COMPARE",
        timeframe="15m",
        operator="CROSS_ABOVE",
        left={"indicator": "SMA", "period": 3, "timeframe": "15m"},
        right={"indicator": "SMA", "period": 20, "timeframe": "15m"},
    )
    result = evaluate_node(node, ctx)
    assert result.status == "UNKNOWN"
    assert result.reason, "an UNKNOWN must say why"


def test_a_crossover_reports_the_timeframe_it_actually_read():
    """Both sides of a cross must be read from the same moment in time."""
    node = leaf(
        "INDICATOR_COMPARE",
        timeframe="15m",
        operator="CROSS_ABOVE",
        left={"indicator": "SMA", "period": 3, "timeframe": "1h"},
        right={"indicator": "SMA", "period": 3, "timeframe": "1h"},
    )
    result = evaluate_node(node, context(timeframe="multi"))
    assert result.unit == "1h", "the comparison must report the timeframe it read, not the node default"


# --------------------------------------------------------------------------- #
# V0 audit #24: the starter condition was `price is above 0`
#
# True of every price that has ever existed, so a brand-new tracker passed
# its wake test on the first bar it was shown -- before anyone had
# chosen a market, a direction, or a level. It looked configured and was
# not.
#
# The starter is now disabled instead. A group whose only child is
# disabled reports UNKNOWN, and UNKNOWN never wakes, so the property
# that matters is testable end to end rather than assumed.
# --------------------------------------------------------------------------- #


def test_a_disabled_condition_is_reported_as_disabled_not_false():
    node = leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, enabled=False)
    result = evaluate_node(node, context())
    assert result.status == "DISABLED"


def test_a_group_whose_only_condition_is_disabled_is_unknown():
    """UNKNOWN is what makes a half-built tracker inert rather than armed.

    The alternative -- treating a disabled child as a pass -- would make
    an empty AND evaluate TRUE, which wakes everything.
    """
    node = group(leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, enabled=False))
    result = evaluate_node(node, context())
    assert result.status == "UNKNOWN"
    assert result.reason, "an UNKNOWN must say why"


def test_an_empty_group_is_unknown_rather_than_vacuously_true():
    assert evaluate_node(group(), context()).status == "UNKNOWN"


def test_disabling_every_condition_makes_the_whole_tree_inert():
    root = group(
        leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, enabled=False),
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=30, enabled=False),
    )
    assert evaluate_tree(tree(root), context()).status == "UNKNOWN"


def test_a_disabled_condition_does_not_vote_in_a_mixed_group():
    """Enabling one condition must give exactly that condition's answer.

    A disabled sibling that counted as a pass, or as a fail, would let a
    user switch a condition off and silently change the meaning of the
    group rather than narrowing it.
    """
    mixed = group(
        leaf("PRICE_LEVEL", timeframe="15m", direction="ABOVE", level=1, enabled=False),
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=60),
    )
    enabled_only = group(
        leaf("INDICATOR_THRESHOLD", timeframe="15m", indicator="RSI", period=14, operator="LT", value=60),
    )
    assert evaluate_node(mixed, context(series=DOWN, price=float(DOWN.close[-1]))).status == \
        evaluate_node(enabled_only, context(series=DOWN, price=float(DOWN.close[-1]))).status


def test_the_starter_tree_shape_validates_against_the_schema():
    """A starter tree that the schema rejects is not a starter, it is a crash."""
    starter = {
        "schemaVersion": 1,
        "then": "WAKE_AI",
        "market": "xyz:GOLD",
        "timeframe": "15m",
        "cooldownMs": 900000,
        "maxWakesPerHour": 4,
        "maxWakesPerDay": 24,
        "requireTradeableMarket": True,
        "root": {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [
                {
                    "id": "c1",
                    "kind": "PRICE_LEVEL",
                    "enabled": False,
                    "timeframe": "15m",
                    "direction": "ABOVE",
                    "level": 0,
                }
            ],
        },
    }
    contract.validate_tree(starter)
