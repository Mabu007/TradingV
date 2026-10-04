"""The condition evaluator.

Produces exactly three states:

``TRUE``   the condition is satisfied
``FALSE``  the condition is satisfied's opposite, on real data
``UNKNOWN`` it could not be determined

``UNKNOWN`` is never silently collapsed into ``FALSE``, and never into
``TRUE``. A condition that cannot be measured - not enough candles, an
unavailable market, no volume, no open position - reports ``UNKNOWN``
with a reason, and an unknown child makes the enclosing group unknown in
a way that can never produce a wake.

Group propagation
-----------------

=========  ==========================  ==============================
operator   children                    result
=========  ==========================  ==============================
``AND``    any FALSE                   FALSE
``AND``    otherwise any UNKNOWN       UNKNOWN
``AND``    all TRUE                    TRUE
``OR``     any TRUE                    TRUE
``OR``     otherwise any UNKNOWN       UNKNOWN
``OR``     all FALSE                   FALSE
``NOT``    child UNKNOWN               UNKNOWN
``NOT``    child FALSE                 TRUE
``NOT``    child TRUE                  FALSE
=========  ==========================  ==============================

An empty or all-disabled group is ``UNKNOWN``, not ``TRUE``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

import numpy as np

from . import indicators as indicator_module
from . import math_expr
from . import patterns as pattern_module
from . import price_action as price_action_module
from .catalogue import OPERATOR_LABELS, spec_for
from .series import ComputedSeries, Series, Validity


class Status(str):
    TRUE = "TRUE"
    FALSE = "FALSE"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class EvaluationContext:
    """
    Everything a tree may read.

    Deliberately narrow: a market series, the account snapshot, open
    positions, and the instrument's canonical metadata. There is no
    execution handle, no wallet handle, and no signing material.
    """

    symbol: str
    series: Mapping[str, Series]
    price: float | None = None
    spread: float | None = None
    instrument: Mapping[str, Any] | None = None
    account: Mapping[str, Any] | None = None
    positions: tuple[Mapping[str, Any], ...] = ()
    timestamp: float = 0.0
    #: Latest event type observed, for EVENT conditions.
    event_type: str | None = None
    #: Set when the market itself could not be evaluated, for example a
    #: market the venue will not trade. Every price-based condition then
    #: reports UNKNOWN with this reason instead of reading a stale value.
    unavailable_reason: str | None = None

    def series_for(self, timeframe: str) -> Series | None:
        return self.series.get(timeframe)


@dataclass
class ConditionResult:
    id: str
    kind: str
    status: str
    summary: str
    value: float | None = None
    threshold: float | None = None
    unit: str = ""
    reason: str = ""
    children: list["ConditionResult"] = field(default_factory=list)
    operator: str | None = None

    def to_json(self) -> dict:
        payload: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "summary": self.summary,
        }
        if self.value is not None:
            payload["value"] = self.value
        if self.threshold is not None:
            payload["threshold"] = self.threshold
        if self.unit:
            payload["unit"] = self.unit
        if self.reason:
            payload["reason"] = self.reason
        if self.operator:
            payload["operator"] = self.operator
        if self.children:
            payload["children"] = [child.to_json() for child in self.children]
        return payload

    def flat(self) -> list["ConditionResult"]:
        out: list[ConditionResult] = []
        for child in self.children:
            out.append(child)
            out.extend(child.flat())
        return out


def _unknown(node: dict, reason: str) -> ConditionResult:
    return ConditionResult(
        id=node.get("id", "unknown"),
        kind=node.get("kind", "UNKNOWN"),
        status=Status.UNKNOWN,
        summary=explain(node),
        reason=reason,
    )


def _result(node: dict, status: str, value: float | None = None, threshold: float | None = None, unit: str = "", reason: str = "") -> ConditionResult:
    return ConditionResult(
        id=node.get("id", "unknown"),
        kind=node.get("kind", "UNKNOWN"),
        status=status,
        summary=explain(node),
        value=value,
        threshold=threshold,
        unit=unit,
        reason=reason,
    )


# --------------------------------------------------------------------------- #
# Comparisons
# --------------------------------------------------------------------------- #


def compare(operator: str, left: float | None, right: float | None) -> str | None:
    """Apply one comparison. ``None`` on either side is UNKNOWN."""
    if left is None or right is None:
        return None
    if not (math.isfinite(left) and math.isfinite(right)):
        return None

    if operator == "GT":
        return Status.TRUE if left > right else Status.FALSE
    if operator == "GTE":
        return Status.TRUE if left >= right else Status.FALSE
    if operator == "LT":
        return Status.TRUE if left < right else Status.FALSE
    if operator == "LTE":
        return Status.TRUE if left <= right else Status.FALSE
    if operator == "EQ":
        return Status.TRUE if _approximately_equal(left, right) else Status.FALSE
    if operator == "NEQ":
        return Status.FALSE if _approximately_equal(left, right) else Status.TRUE
    if operator == "CROSS_ABOVE":
        return None  # needs two samples; handled by the caller
    if operator == "CROSS_BELOW":
        return None
    if operator == "RISING":
        return Status.TRUE if left > right else Status.FALSE
    if operator == "FALLING":
        return Status.TRUE if left < right else Status.FALSE

    raise ValueError(f"Unknown operator {operator!r}")


def _approximately_equal(left: float, right: float) -> bool:
    tolerance = max(1e-9, abs(right) * 1e-9)
    return abs(left - right) <= tolerance


def crosses(operator: str, previous: float | None, current: float | None, level: float) -> str:
    """A cross is a *transition*, not a level test."""
    if previous is None or current is None or not math.isfinite(level):
        return Status.UNKNOWN
    if operator == "CROSS_ABOVE":
        return Status.TRUE if previous < level <= current else Status.FALSE
    if operator == "CROSS_BELOW":
        return Status.TRUE if previous > level >= current else Status.FALSE
    raise ValueError(f"{operator!r} is not a cross operator")


# --------------------------------------------------------------------------- #
# Tree evaluation
# --------------------------------------------------------------------------- #


def evaluate_tree(tree: dict, context: EvaluationContext) -> ConditionResult:
    """Evaluate a canonical condition tree."""
    return evaluate_node(tree["root"], context)


def evaluate_node(node: dict, context: EvaluationContext) -> ConditionResult:
    if node.get("kind") == "GROUP":
        return _evaluate_group(node, context)

    if node.get("enabled") is False:
        return ConditionResult(
            id=node.get("id", "unknown"),
            kind=node.get("kind", "UNKNOWN"),
            status="DISABLED",
            summary=explain(node),
        )

    handler = _LEAF_HANDLERS.get(node.get("kind", ""))
    if handler is None:
        return _unknown(node, f"Condition type {node.get('kind')!r} is not implemented.")

    try:
        return handler(node, context)
    except Exception as error:  # a bug in a handler must not become a wake
        return _unknown(node, f"Condition could not be evaluated: {error}")


def _evaluate_group(node: dict, context: EvaluationContext) -> ConditionResult:
    if node.get("enabled") is False:
        return ConditionResult(
            id=node.get("id", "group"),
            kind="GROUP",
            status="DISABLED",
            summary=explain(node),
            operator=node.get("operator"),
        )

    operator = node.get("operator", "AND")
    children = node.get("children", [])

    results = [evaluate_node(child, context) for child in children]
    active = [result for result in results if result.status != "DISABLED"]

    if not active:
        return ConditionResult(
            id=node.get("id", "group"),
            kind="GROUP",
            status=Status.UNKNOWN,
            summary="empty group",
            operator=operator,
            children=results,
            reason="This group has no active conditions, so it cannot be evaluated.",
        )

    statuses = [result.status for result in active]

    if operator == "AND":
        if Status.FALSE in statuses:
            status = Status.FALSE
        elif Status.UNKNOWN in statuses:
            status = Status.UNKNOWN
        else:
            status = Status.TRUE
    elif operator == "OR":
        if Status.TRUE in statuses:
            status = Status.TRUE
        elif Status.UNKNOWN in statuses:
            status = Status.UNKNOWN
        else:
            status = Status.FALSE
    elif operator == "NOT":
        if len(active) != 1:
            return ConditionResult(
                id=node.get("id", "group"),
                kind="GROUP",
                status=Status.UNKNOWN,
                summary="invalid NOT group",
                operator=operator,
                children=results,
                reason="A NOT group must contain exactly one condition.",
            )
        only = active[0].status
        status = Status.UNKNOWN if only == Status.UNKNOWN else (Status.FALSE if only == Status.TRUE else Status.TRUE)
    else:
        return ConditionResult(
            id=node.get("id", "group"),
            kind="GROUP",
            status=Status.UNKNOWN,
            summary="invalid operator",
            operator=operator,
            children=results,
            reason=f"Unknown group operator {operator!r}.",
        )

    return ConditionResult(
        id=node.get("id", "group"),
        kind="GROUP",
        status=status,
        summary=explain(node),
        operator=operator,
        children=results,
    )


# --------------------------------------------------------------------------- #
# Leaf handlers
# --------------------------------------------------------------------------- #


def _timeframe(node: dict, context: EvaluationContext, default: str = "15m") -> str:
    return node.get("timeframe") or default


def _series(node: dict, context: EvaluationContext) -> tuple[Series | None, str]:
    if context.unavailable_reason:
        return None, context.unavailable_reason
    timeframe = _timeframe(node, context)
    series = context.series_for(timeframe)
    if series is None:
        return None, f"No {timeframe} candle data is loaded for {context.symbol}."
    return series, ""


def _handle_spread(node: dict, context: EvaluationContext) -> ConditionResult:
    if context.unavailable_reason:
        return _unknown(node, context.unavailable_reason)
    if context.spread is None or not math.isfinite(context.spread):
        return _unknown(node, f"No spread is published for {context.symbol}.")
    value = context.spread
    if node.get("unit") == "PERCENT":
        mark = context.price
        if mark is None or mark <= 0:
            return _unknown(node, "No reference price is available to express the spread as a percentage.")
        value = (context.spread / mark) * 100.0
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No spread threshold is set.")
    status = compare(node.get("operator", "LTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), "%" if node.get("unit") == "PERCENT" else "price")


def _handle_price_level(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    price = _price(node, context, series)
    if price is None:
        return _unknown(node, f"No {series.timeframe} price is available for {context.symbol}.")
    level = node.get("level")
    if level is None:
        return _unknown(node, "No price level is set.")
    operator = "GTE" if node.get("direction") == "ABOVE" else "LTE"
    status = compare(operator, price, float(level))
    return _result(node, status or Status.UNKNOWN, price, float(level), "price")


def _handle_price_cross(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    closes = series.close
    if closes.size < 2:
        return _unknown(node, f"Need at least two {series.timeframe} candles to detect a cross.")
    level = node.get("level")
    if level is None:
        return _unknown(node, "No price level is set.")
    current = float(closes[-1])
    previous = float(closes[-2])
    operator = "CROSS_ABOVE" if node.get("direction") == "ABOVE" else "CROSS_BELOW"
    status = crosses(operator, previous, current, float(level))
    return _result(node, status, current, float(level), "price")


def _price(node: dict, context: EvaluationContext, series: Series) -> float | None:
    if context.price is not None and math.isfinite(context.price) and context.price > 0:
        return context.price
    if series.close.size and math.isfinite(float(series.close[-1])) and series.close[-1] > 0:
        return float(series.close[-1])
    return None


def _indicator_params(node: dict) -> dict:
    mapping = {
        "period": "period",
        "fastPeriod": "fast",
        "slowPeriod": "slow",
        "signalPeriod": "signal",
    }
    params: dict[str, Any] = {}
    for source, target in mapping.items():
        value = node.get(source)
        if value is not None:
            params[target] = value
    return params


def _handle_indicator_threshold(node: dict, context: EvaluationContext) -> ConditionResult:
    indicator = node.get("indicator")
    if not isinstance(indicator, str):
        return _unknown(node, "No indicator is selected.")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)

    params = _indicator_params(node)
    if indicator in {"BOLLINGER_UPPER", "BOLLINGER_MIDDLE", "BOLLINGER_LOWER", "BOLLINGER_WIDTH"}:
        params.setdefault("period", node.get("period", 20))
        params.setdefault("deviations", node.get("stdDevMultiple", 2.0))
    component = node.get("component")
    if component:
        params["component"] = component

    try:
        computed = indicator_module.compute(series, indicator, **params)
    except KeyError:
        return _unknown(node, f"Indicator {indicator!r} is not available.")

    if computed.name.startswith("MACD") and component:
        values = computed.extras.get(component)
        if values is None or not np.all(np.isfinite(values[-2:])):
            return _unknown(node, computed.reason or f"MACD {component} is not available yet.")
        current = float(values[-1])
        previous = float(values[-2])
    else:
        current = computed.last()
        previous = computed.previous()
        if current is None:
            return _unknown(node, computed.reason or f"{computed.name} is not available yet.")

    operator = node.get("operator", "GT")
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")

    if operator in {"CROSS_ABOVE", "CROSS_BELOW"}:
        if previous is None:
            return _unknown(node, f"Need two {series.timeframe} samples of {computed.name} to detect a cross.")
        status = crosses(operator, previous, current, float(threshold))
    else:
        status = compare(operator, current, float(threshold)) or Status.UNKNOWN

    return _result(node, status, current, float(threshold), computed.name)


class SideReading:
    """One side of an indicator comparison, with both samples available."""

    __slots__ = ("current", "previous", "timeframe", "reason")

    def __init__(self, current: float | None, previous: float | None, timeframe: str, reason: str) -> None:
        self.current = current
        self.previous = previous
        self.timeframe = timeframe
        self.reason = reason

    @property
    def ok(self) -> bool:
        return self.current is not None


def _indicator_side_value(side: dict, context: EvaluationContext, default_timeframe: str) -> tuple[SideReading | None, str]:
    indicator = side.get("indicator")
    timeframe = side.get("timeframe") or default_timeframe
    if not isinstance(indicator, str):
        return None, "No indicator is selected."

    series = context.series_for(timeframe)
    if series is None:
        return None, f"No {timeframe} candle data is loaded for {context.symbol}."

    params = _indicator_params(side)
    if indicator in {"BOLLINGER_UPPER", "BOLLINGER_MIDDLE", "BOLLINGER_LOWER", "BOLLINGER_WIDTH"}:
        params.setdefault("period", side.get("period", 20))
        params.setdefault("deviations", side.get("stdDevMultiple", 2.0))
    component = side.get("component")
    if component:
        params["component"] = component

    try:
        computed = indicator_module.compute(series, indicator, **params)
    except KeyError:
        return None, f"Indicator {indicator!r} is not available."

    if computed.name.startswith("MACD") and component:
        values = computed.extras.get(component)
        if values is None or not np.all(np.isfinite(values[-2:])):
            return SideReading(None, None, timeframe, computed.reason or "MACD component is not available yet."), ""
        return SideReading(float(values[-1]), float(values[-2]), timeframe, ""), ""

    current = computed.last()
    previous = computed.previous()
    if current is None:
        return SideReading(None, None, timeframe, computed.reason or f"{computed.name} is not available yet."), ""
    return SideReading(current, previous, timeframe, ""), ""


def _handle_indicator_compare(node: dict, context: EvaluationContext) -> ConditionResult:
    timeframe = _timeframe(node, context)
    left_side = node.get("left") or {}
    right_side = node.get("right") or {}

    left_timeframe = left_side.get("timeframe") or timeframe
    right_timeframe = right_side.get("timeframe") or timeframe

    left, left_reason = _indicator_side_value(left_side, context, left_timeframe)
    right, right_reason = _indicator_side_value(right_side, context, right_timeframe)

    if left is None or right is None or not left.ok or not right.ok:
        return _unknown(node, left_reason or right_reason or (left.reason if left else "") or (right.reason if right else "") or "One of the indicators is not available yet.")

    operator = node.get("operator", "GT")

    if operator in {"CROSS_ABOVE", "CROSS_BELOW"}:
        # A cross is a transition between the two series, not a level test.
        if left.previous is None or right.previous is None:
            return _unknown(node, "Need two samples of both indicators to detect a cross.")
        if operator == "CROSS_ABOVE":
            status = Status.TRUE if left.previous <= right.previous and left.current > right.current else Status.FALSE
        else:
            status = Status.TRUE if left.previous >= right.previous and left.current < right.current else Status.FALSE
        difference = left.current - right.current
    else:
        # The schema has no `value` on this node and forbids extra
        # properties, so a comparison is always between the two sides.
        # Reading an optional threshold here would be a branch the contract
        # can never reach.
        status = compare(operator, left.current, right.current) or Status.UNKNOWN
        difference = left.current - right.current

    unit = left.timeframe
    if left.timeframe != right.timeframe:
        unit = f"{left.timeframe}/{right.timeframe}"
    # There is no threshold on a comparison node; the two readings are the
    # whole question. `threshold` stays None so the UI does not draw a
    # line the condition never had.
    return _result(node, status, difference, None, unit)


def _handle_momentum_band(node: dict, context: EvaluationContext) -> ConditionResult:
    oscillator = node.get("oscillator", "RSI")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    try:
        computed = indicator_module.compute(series, str(oscillator), **_indicator_params(node))
    except KeyError:
        return _unknown(node, f"Oscillator {oscillator!r} is not available.")
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or f"{computed.name} is not available yet.")
    lower = node.get("lower")
    upper = node.get("upper")
    if lower is None or upper is None:
        return _unknown(node, "Both band edges are required.")
    inside = lower <= value <= upper
    return _result(node, Status.TRUE if inside else Status.FALSE, value, upper, computed.name)


def _handle_trend_direction(node: dict, context: EvaluationContext) -> ConditionResult:
    indicator = node.get("indicator", "EMA")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    period = int(node.get("period", 50))
    lookback = int(node.get("lookback", 10))
    try:
        computed = indicator_module.compute(series, str(indicator), period=period)
    except KeyError:
        return _unknown(node, f"Indicator {indicator!r} is not available.")
    if computed.values.size < lookback + 1:
        return _unknown(node, f"Need {lookback + 1} {series.timeframe} candles to judge the trend; have {computed.values.size}.")
    current = computed.at(len(computed.values) - 1)
    previous = computed.at(len(computed.values) - 1 - lookback)
    if current is None or previous is None:
        return _unknown(node, f"{computed.name} does not have enough values yet.")
    status = Status.TRUE if current > previous else Status.FALSE
    if node.get("operator") == "FALLING":
        status = Status.FALSE if status == Status.TRUE else Status.TRUE
    return _result(node, status, current, previous, computed.name)


def _handle_adx_strength(node: dict, context: EvaluationContext) -> ConditionResult:
    return _handle_indicator_threshold({**node, "indicator": "ADX", "operator": node.get("operator", "GTE")}, context)


def _handle_volatility(node: dict, context: EvaluationContext) -> ConditionResult:
    measure = node.get("measure", "ATR")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    period = int(node.get("period", 14))
    if measure == "ATR":
        computed = indicator_module.compute(series, "ATR", period=period)
    elif measure == "STDDEV":
        computed = indicator_module.compute(series, "STDDEV", period=period)
    elif measure == "HISTORICAL_VOLATILITY":
        computed = indicator_module.compute(series, "HISTORICAL_VOLATILITY", period=period)
    elif measure == "BOLLINGER_WIDTH":
        computed = indicator_module.compute(series, "BOLLINGER_WIDTH", period=period)
    elif measure == "RANGE":
        computed = indicator_module.compute(series, "TRUE_RANGE")
    else:
        return _unknown(node, f"Volatility measure {measure!r} is not implemented.")
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or f"{computed.name} is not available yet.")
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")
    status = compare(node.get("operator", "GT"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), computed.name)


def _handle_volatility_compare(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    fast = node.get("fast", 14)
    slow = node.get("slow", 50)
    short = indicator_module.compute(series, "ATR", period=int(fast))
    long = indicator_module.compute(series, "ATR", period=int(slow))
    if short.last() is None or long.last() is None:
        return _unknown(node, short.reason or long.reason or "ATR is not available on both windows yet.")
    status = compare(node.get("operator", "GT"), short.last(), long.last()) or Status.UNKNOWN
    return _result(node, status, short.last(), long.last(), f"ATR({fast})/ATR({slow})")


def _handle_volume(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    if not series.has_volume:
        return _unknown(node, f"{context.symbol} does not provide volume, so volume conditions cannot be measured.")
    measure = node.get("measure", "VOLUME_RATIO")
    period = int(node.get("period", 20))
    if measure == "VOLUME_SMA":
        computed = indicator_module.compute(series, "VOLUME_SMA", period=period)
    elif measure == "VOLUME_CHANGE":
        computed = indicator_module.compute(series, "VOLUME_CHANGE", period=period)
    else:
        computed = indicator_module.compute(series, "VOLUME_RATIO", period=period)
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or f"{computed.name} is not available yet.")
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")
    status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), computed.name)


def _handle_price_action(node: dict, context: EvaluationContext) -> ConditionResult:
    measure = node.get("measure")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    if not isinstance(measure, str) or measure not in price_action_module.MEASURES:
        return _unknown(node, f"Price-action measure {measure!r} is not implemented.")
    computed = price_action_module.compute(
        series,
        measure,
        period=int(node.get("period", 20)),
        count=int(node.get("count", 1)),
    )
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or f"{measure} is not available yet.")
    operator = node.get("operator", "GT")
    threshold = node.get("value")

    if measure in price_action_module.BOOLEAN_MEASURES:
        if threshold is None:
            threshold = 0.5
        status = compare(operator, value, float(threshold)) or Status.UNKNOWN
    else:
        if threshold is None:
            return _unknown(node, "No threshold is set.")
        status = compare(operator, value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), measure)


def _handle_consecutive(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    count = int(node.get("count", 3))
    direction = node.get("direction", "UP")
    measure = "CONSECUTIVE_UP" if direction == "UP" else "CONSECUTIVE_DOWN"
    computed = price_action_module.compute(series, measure)
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or "Not enough candles to count a run.")
    status = compare(node.get("operator", "GTE"), value, float(count)) or Status.UNKNOWN
    return _result(node, status, value, float(count), "candles")


def _handle_structure(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    pattern = "HIGHER_HIGH_HIGHER_LOW" if node.get("structure", "UPTREND") == "UPTREND" else "LOWER_HIGH_LOWER_LOW"
    computed = pattern_module.evaluate(series, pattern, swingLookback=int(node.get("lookback", 2)))
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or "Market structure is not measurable yet.")
    status = Status.TRUE if value > 0.5 else Status.FALSE
    if node.get("operator") == "FALLING":
        status = Status.FALSE if status == Status.TRUE else Status.TRUE
    return _result(node, status, value, None, pattern)


def _handle_pattern(node: dict, context: EvaluationContext) -> ConditionResult:
    pattern = node.get("pattern")
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    if not isinstance(pattern, str) or pattern not in pattern_module.PATTERNS:
        return _unknown(node, f"Pattern {pattern!r} is not implemented.")
    computed = pattern_module.evaluate(
        series,
        pattern,
        lookback=node.get("lookback"),
        tolerancePercent=node.get("tolerancePercent"),
        minSeparationBars=node.get("minSeparationBars"),
        swingLookback=node.get("swingLookback"),
        volumeMultiplier=node.get("volumeMultiplier"),
    )
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or f"{pattern} is not measurable yet.")
    return _result(node, Status.TRUE if value > 0.5 else Status.FALSE, value, 0.5, pattern)


def _handle_breakout(node: dict, context: EvaluationContext) -> ConditionResult:
    series, reason = _series(node, context)
    if series is None:
        return _unknown(node, reason)
    direction = node.get("direction", "ABOVE")
    if node.get("requireVolumeConfirmation") and not series.has_volume:
        return _unknown(node, f"{context.symbol} does not provide volume, so volume confirmation cannot be measured.")
    pattern = "BREAKOUT_ABOVE_HIGH" if direction == "ABOVE" else "BREAKOUT_BELOW_LOW"
    computed = pattern_module.evaluate(
        series,
        pattern,
        lookback=node.get("lookbackBars"),
        volumeMultiplier=node.get("volumeMultiplier"),
        requireVolumeConfirmation=node.get("requireVolumeConfirmation"),
    )
    value = computed.last()
    if value is None:
        return _unknown(node, computed.reason or "Breakout is not measurable yet.")
    return _result(node, Status.TRUE if value > 0.5 else Status.FALSE, value, 0.5, pattern)


def _expression_values(node: dict, context: EvaluationContext) -> tuple[dict[str, float | None], str]:
    series, reason = _series(node, context)
    if series is None:
        return {}, reason

    values: dict[str, float | None] = {
        "open": float(series.open[-1]) if series.open.size else None,
        "high": float(series.high[-1]) if series.high.size else None,
        "low": float(series.low[-1]) if series.low.size else None,
        "close": float(series.close[-1]) if series.close.size else None,
        "volume": float(series.volume[-1]) if series.has_volume and series.volume is not None and series.volume.size else None,
    }
    values["hl2"] = None if values["high"] is None or values["low"] is None else (values["high"] + values["low"]) / 2
    values["hlc3"] = None if values["hl2"] is None or values["close"] is None else (values["high"] + values["low"] + values["close"]) / 3
    values["ohlc4"] = None if values["hlc3"] is None or values["open"] is None else (values["open"] + values["high"] + values["low"] + values["close"]) / 4

    from .math_expr import referenced_indicators

    try:
        ast = math_expr.parse(node.get("expression", ""))
    except math_expr.ExpressionError as error:
        return values, str(error)

    for name, period in referenced_indicators(ast):
        key = math_expr.indicator_key(name, period)
        values[key] = _expression_indicator(series, name, period)
    return values, ""


def _expression_indicator(series: Series, name: str, period: int | None) -> float | None:
    mapped = {
        "MACD_SIGNAL": ("MACD", "signal"),
        "MACD_HIST": ("MACD", "histogram"),
        "BB_UPPER": ("BOLLINGER_UPPER", None),
        "BB_MIDDLE": ("BOLLINGER_MIDDLE", None),
        "BB_LOWER": ("BOLLINGER_LOWER", None),
        "BB_WIDTH": ("BOLLINGER_WIDTH", None),
        "HIST_VOL": ("HISTORICAL_VOLATILITY", None),
    }
    if name in mapped:
        target, component = mapped[name]
        params: dict[str, Any] = {"period": period} if period else {}
        if target.startswith("BOLLINGER"):
            params.pop("period", None)
            params["period"] = period or 20
        computed = indicator_module.compute(series, target, **params)
        if component:
            values = computed.extras.get(component)
            return None if values is None or not np.all(np.isfinite(values[-1:])) else float(values[-1])
        return computed.last()

    params = {"period": period} if period is not None else {}
    try:
        return indicator_module.compute(series, name, **params).last()
    except KeyError:
        return None


def _handle_math(node: dict, context: EvaluationContext) -> ConditionResult:
    values, reason = _expression_values(node, context)
    if reason:
        return _unknown(node, reason)
    try:
        ast = math_expr.parse(node.get("expression", ""))
    except math_expr.ExpressionError as error:
        return _unknown(node, str(error))

    result = math_expr.evaluate_ast(ast, values)
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")
    if result is None or not math.isfinite(result):
        return _unknown(node, "The expression could not be evaluated with the available data.")
    status = compare(node.get("operator", "GT"), result, float(threshold)) or Status.UNKNOWN
    return _result(node, status, result, float(threshold), math_expr.describe(node.get("expression", "")))


def _handle_time(node: dict, context: EvaluationContext) -> ConditionResult:
    if context.timestamp <= 0:
        return _unknown(node, "No evaluation timestamp is available.")
    measure = node.get("measure", "HOUR_OF_DAY")
    timezone = node.get("timezone", "UTC")
    try:
        from zoneinfo import ZoneInfo

        moment = __import__("datetime").datetime.fromtimestamp(context.timestamp / 1000.0, tz=ZoneInfo(timezone))
    except Exception:
        return _unknown(node, f"Timezone {timezone!r} is not available.")

    if measure == "HOUR_OF_DAY":
        value = float(moment.hour)
    elif measure == "DAY_OF_WEEK":
        value = float(moment.weekday())
    elif measure == "MINUTES_INO_BAR":
        value = float(moment.minute)
    else:
        return _unknown(node, f"Time measure {measure!r} is not implemented.")

    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")
    status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), timezone)


def _handle_session(node: dict, context: EvaluationContext) -> ConditionResult:
    if context.timestamp <= 0:
        return _unknown(node, "No evaluation timestamp is available.")
    timezone = node.get("timezone", "UTC")
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo

        moment = datetime.fromtimestamp(context.timestamp / 1000.0, tz=ZoneInfo(timezone))
    except Exception:
        return _unknown(node, f"Timezone {timezone!r} is not available.")

    start = int(node.get("startsAtMinute", 0))
    end = int(node.get("endsAtMinute", 1440))
    minute = moment.hour * 60 + moment.minute
    within = start <= minute < end if start < end else (minute >= start or minute < end)

    boundary = node.get("boundary", "WITHIN")
    if boundary == "WITHIN":
        status = Status.TRUE if within else Status.FALSE
    else:
        window = 60
        if boundary == "START":
            status = Status.TRUE if abs(minute - start) <= window and within else Status.FALSE
        else:
            status = Status.TRUE if abs(minute - end) <= window and not within else Status.FALSE

    return _result(node, status, float(minute), float(start), f"{node.get('sessionId', 'session')} {timezone}")


def _matching_position(context: EvaluationContext) -> Mapping[str, Any] | None:
    for position in context.positions:
        if position.get("symbol") == context.symbol:
            return position
    return None


def _handle_proximity(node: dict, context: EvaluationContext) -> ConditionResult:
    position = _matching_position(context)
    if position is None:
        return _unknown(node, f"There is no open position on {context.symbol}.")

    level = node.get("level", "stopLoss")
    target = position.get(level)
    if target is None or not isinstance(target, (int, float)) or not math.isfinite(float(target)):
        label = "stop loss" if level == "stopLoss" else "take profit"
        return _unknown(node, f"This position has no {label}.")

    mark = position.get("currentPrice")
    if mark is None or not isinstance(mark, (int, float)) or not math.isfinite(float(mark)) or mark <= 0:
        mark = context.price
    if mark is None or not math.isfinite(mark) or mark <= 0:
        return _unknown(node, "No executable or mark price is available for this position.")

    instrument = context.instrument or {}
    distance = abs(float(mark) - float(target))
    checks: list[tuple[str, float, float]] = []

    if node.get("withinPrice") is not None:
        checks.append(("price", distance, float(node["withinPrice"])))
    if node.get("withinPips") is not None:
        pip_size = instrument.get("pipSize")
        if isinstance(pip_size, (int, float)) and pip_size > 0:
            checks.append(("pips", distance / float(pip_size), float(node["withinPips"])))
    if node.get("withinTicks") is not None:
        tick_size = instrument.get("tickSize")
        if isinstance(tick_size, (int, float)) and tick_size > 0:
            checks.append(("ticks", distance / float(tick_size), float(node["withinTicks"])))
    if node.get("withinPercent") is not None:
        checks.append(("%", (distance / float(mark)) * 100.0, float(node["withinPercent"])))
    if node.get("withinValue") is not None:
        quantity = position.get("volume")
        if isinstance(quantity, (int, float)) and quantity:
            checks.append(("USD", distance * abs(float(quantity)), float(node["withinValue"])))

    if not checks:
        return _unknown(node, "No measurable proximity threshold is configured for this instrument.")

    unit, value, limit = checks[0]
    within = all(value <= limit * (1 + 1e-9) for _, value, limit in checks)
    return _result(node, Status.TRUE if within else Status.FALSE, value, limit, unit)


def _handle_position(node: dict, context: EvaluationContext) -> ConditionResult:
    measure = node.get("measure", "POSITION_COUNT")
    positions = context.positions

    if measure == "POSITION_COUNT":
        value = float(len(positions))
        threshold = node.get("value", 0)
        status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
        return _result(node, status, value, float(threshold), "positions")

    position = _matching_position(context)
    if position is None:
        if measure == "PNL" or measure == "PNL_PERCENT":
            return _unknown(node, f"There is no open position on {context.symbol}.")
        return _unknown(node, f"There is no open position on {context.symbol}.")

    if measure == "PNL":
        value = _numeric(position.get("unrealizedPnL"))
    elif measure == "PNL_PERCENT":
        value = _numeric(position.get("unrealizedPnlPercent"))
    elif measure == "SIZE":
        value = _numeric(position.get("volume"))
    elif measure == "HELD_BARS":
        opened = _numeric(position.get("timestamp"))
        if opened is None or context.timestamp <= 0:
            return _unknown(node, "The position open time is not available.")
        value = (context.timestamp / 1000.0 - opened / 1000.0) / 900.0
    else:
        return _unknown(node, f"Position measure {measure!r} is not implemented.")

    if value is None:
        return _unknown(node, f"Position {measure} is not available for {context.symbol}.")

    threshold = node.get("value", 0)
    status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), measure)


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _handle_account(node: dict, context: EvaluationContext) -> ConditionResult:
    account = context.account
    if account is None:
        return _unknown(node, "No account state is available.")
    measure = node.get("measure", "EQUITY")
    value = _numeric(account.get(measure))
    if value is None and measure == "MARGIN_RATIO":
        used = _numeric(account.get("marginUsed")) or 0.0
        equity = _numeric(account.get("equity")) or 0.0
        value = None if equity <= 0 else used / equity * 100.0
    if value is None and measure == "EXPOSURE_RATIO":
        exposure = _numeric(account.get("exposure")) or 0.0
        limit = _numeric(account.get("maxExposureNotional")) or 0.0
        value = None if limit <= 0 else exposure / limit * 100.0
    if value is None:
        return _unknown(node, f"Account measure {measure!r} is not available.")
    threshold = node.get("value")
    if threshold is None:
        return _unknown(node, "No threshold is set.")
    status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), str(measure))


def _handle_risk(node: dict, context: EvaluationContext) -> ConditionResult:
    account = context.account
    if account is None:
        return _unknown(node, "No risk state is available.")
    measure = node.get("measure", "DRAWDOWN_PERCENT")

    if measure == "STATE":
        state = account.get("riskState")
        expected = node.get("state", "NORMAL")
        return _result(node, Status.TRUE if state == expected else Status.FALSE, 1.0, 1.0, str(state))
    if measure == "KILL_SWITCH":
        active = bool(account.get("killSwitchActive"))
        return _result(node, Status.TRUE if active else Status.FALSE, 1.0 if active else 0.0, 0.5, "kill switch")

    if measure == "DRAWDOWN_PERCENT":
        value = _numeric(account.get("drawdownPercent"))
    elif measure == "DAILY_LOSS":
        value = _numeric(account.get("dailyPnL"))
        if value is not None and value > 0:
            value = 0.0
    elif measure == "ORDERS_LAST_MINUTE":
        value = _numeric(account.get("ordersLastMinute"))
    else:
        value = _numeric(account.get(measure))

    if value is None:
        return _unknown(node, f"Risk measure {measure!r} is not available.")
    threshold = node.get("value", 0)
    status = compare(node.get("operator", "GTE"), value, float(threshold)) or Status.UNKNOWN
    return _result(node, status, value, float(threshold), str(measure))


def _handle_event(node: dict, context: EvaluationContext) -> ConditionResult:
    expected = node.get("event")
    observed = context.event_type
    if observed is None:
        return _unknown(node, "No event has been observed in this evaluation window.")
    return _result(node, Status.TRUE if observed == expected else Status.FALSE, 1.0, 1.0, str(observed))


_LEAF_HANDLERS: dict[str, Callable[[dict, EvaluationContext], ConditionResult]] = {
    "PRICE_LEVEL": _handle_price_level,
    "PRICE_CROSS": _handle_price_cross,
    "SPREAD": _handle_spread,
    "INDICATOR_THRESHOLD": _handle_indicator_threshold,
    "INDICATOR_COMPARE": _handle_indicator_compare,
    "MOMENTUM_BAND": _handle_momentum_band,
    "TREND_DIRECTION": _handle_trend_direction,
    "ADX_STRENGTH": _handle_adx_strength,
    "VOLATILITY": _handle_volatility,
    "VOLATILITY_COMPARE": _handle_volatility_compare,
    "VOLUME": _handle_volume,
    "PRICE_ACTION": _handle_price_action,
    "CONSECUTIVE": _handle_consecutive,
    "STRUCTURE": _handle_structure,
    "PATTERN": _handle_pattern,
    "BREAKOUT": _handle_breakout,
    "MATH_EXPR": _handle_math,
    "TIME": _handle_time,
    "SESSION": _handle_session,
    "PROXIMITY": _handle_proximity,
    "POSITION": _handle_position,
    "ACCOUNT": _handle_account,
    "RISK": _handle_risk,
    "EVENT": _handle_event,
}

#: The leaf kinds this build can evaluate. The contract tests use it to
#: prove every handler has a matching branch in the shared schema, so the
#: two cannot drift apart silently.
LEAF_KINDS: tuple[str, ...] = tuple(sorted(_LEAF_HANDLERS))


# --------------------------------------------------------------------------- #
# Explanation
# --------------------------------------------------------------------------- #


def explain(node: dict) -> str:
    """
    One line describing what a node means.

    Generated from the node itself, so the string a user reads in the
    builder is produced by the same data the evaluator dispatches on.
    """
    kind = node.get("kind")
    label = node.get("label")
    if label:
        return str(label)

    if kind == "GROUP":
        operator = node.get("operator", "AND")
        count = len(node.get("children", []))
        return {"AND": "all of", "OR": "any of", "NOT": "not"}[operator] + f" {count} condition{'s' if count != 1 else ''}"

    def operator_text(default: str = "is") -> str:
        return OPERATOR_LABELS.get(node.get("operator", ""), default)

    if kind in {"PRICE_LEVEL", "PRICE_CROSS"}:
        direction = "at or above" if node.get("direction") == "ABOVE" else "at or below"
        verb = "crosses above" if kind == "PRICE_CROSS" and node.get("direction") == "ABOVE" else (
            "crosses below" if kind == "PRICE_CROSS" else direction
        )
        return f"price {verb} {node.get('level')}"
    if kind == "SPREAD":
        return f"spread {operator_text()} {node.get('value')}"
    if kind in {"INDICATOR_THRESHOLD", "MOMENTUM_BAND", "ADX_STRENGTH"}:
        name = node.get("indicator") or node.get("oscillator") or "indicator"
        period = node.get("period")
        symbol = f"{name}({period})" if period else name
        if kind == "MOMENTUM_BAND":
            return f"{symbol} between {node.get('lower')} and {node.get('upper')}"
        operator = node.get("operator", "GT")
        if operator in {"CROSS_ABOVE", "CROSS_BELOW"}:
            return f"{symbol} {OPERATOR_LABELS[operator]} {node.get('value')}"
        return f"{symbol} {operator_text()} {node.get('value')}"
    if kind == "INDICATOR_COMPARE":
        left = node.get("left") or {}
        right = node.get("right") or {}
        return f"{_side_label(left)} {operator_text()} {_side_label(right)}"
    if kind == "TREND_DIRECTION":
        period = node.get("period", 50)
        return f"{node.get('indicator', 'EMA')}({period}) {operator_text('direction')} over {node.get('lookback', 10)} candles"
    if kind == "VOLATILITY":
        return f"{node.get('measure', 'ATR')}({node.get('period', 14)}) {operator_text()} {node.get('value')}"
    if kind == "VOLATILITY_COMPARE":
        return f"ATR({node.get('fast', 14)}) {operator_text()} ATR({node.get('slow', 50)})"
    if kind == "VOLUME":
        return f"{node.get('measure', 'VOLUME_RATIO')}({node.get('period', 20)}) {operator_text()} {node.get('value')}"
    if kind == "PRICE_ACTION":
        measure = str(node.get("measure", "")).replace("_", " ").lower()
        threshold = node.get("value")
        if threshold is None:
            return measure
        return f"{measure} {operator_text()} {threshold}"
    if kind == "CONSECUTIVE":
        direction = "bullish" if node.get("direction", "UP") == "UP" else "bearish"
        return f"{node.get('count', 3)} consecutive {direction} candles"
    if kind == "STRUCTURE":
        structure = "uptrend" if node.get("structure", "UPTREND") == "UPTREND" else "downtrend"
        return f"market structure is a confirmed {structure}"
    if kind == "PATTERN":
        from .patterns import DESCRIPTIONS

        return DESCRIPTIONS.get(str(node.get("pattern")), "chart pattern")
    if kind == "BREAKOUT":
        verb = "above" if node.get("direction", "ABOVE") == "ABOVE" else "below"
        level = node.get("level")
        return f"breakout {verb} {level}" if level is not None else f"breakout {verb} the last {node.get('lookbackBars', 20)} candles"
    if kind == "MATH_EXPR":
        from .math_expr import describe as describe_expression

        return f"{describe_expression(str(node.get('expression', '')))} {operator_text()} {node.get('value')}"
    if kind == "TIME":
        return f"{str(node.get('measure', '')).replace('_', ' ').lower()} {operator_text()} {node.get('value')}"
    if kind == "SESSION":
        return f"session {node.get('sessionId', 'custom')}: {str(node.get('boundary', 'WITHIN')).lower()}"
    if kind == "PROXIMITY":
        level = "stop loss" if node.get("level", "stopLoss") == "stopLoss" else "take profit"
        thresholds = [
            f"{node[key]} price units" for key in ("withinPrice",) if node.get(key) is not None
        ] + [
            f"{node[key]}%" for key in ("withinPercent",) if node.get(key) is not None
        ] + [
            f"{node[key]} pips" for key in ("withinPips",) if node.get(key) is not None
        ] + [
            f"{node[key]} ticks" for key in ("withinTicks",) if node.get(key) is not None
        ] + [
            f"${node[key]} of value" for key in ("withinValue",) if node.get(key) is not None
        ]
        return f"position is within {' and '.join(thresholds) or 'an unconfigured distance'} of its {level}"
    if kind == "POSITION":
        return f"position {str(node.get('measure', '')).replace('_', ' ').lower()} {operator_text()} {node.get('value', 0)}"
    if kind == "ACCOUNT":
        return f"account {str(node.get('measure', '')).replace('_', ' ').lower()} {operator_text()} {node.get('value')}"
    if kind == "RISK":
        return f"risk {str(node.get('measure', '')).replace('_', ' ').lower()} {operator_text()} {node.get('value', 0)}"
    if kind == "EVENT":
        return f"on {str(node.get('event', '')).replace('_', ' ').lower()}"

    spec = spec_for(str(kind))
    return spec.label if spec else str(kind)


def _side_label(side: dict) -> str:
    name = side.get("indicator", "indicator")
    period = side.get("period")
    timeframe = side.get("timeframe")
    base = f"{name}({period})" if period else name
    return f"{timeframe} {base}" if timeframe else base
