"""The condition catalogue.

One catalogue, two consumers:

* the web app renders it as the "Add Condition" picker, and
* the evaluator dispatches on it.

There is no frontend-only condition type. If a condition is not in this
catalogue, the UI cannot offer it and the engine cannot evaluate it.

Each entry states its category, the data it needs, its parameters, the
operators it supports, its output type, and a plain-language
explanation. The explanation is generated from the same data the
evaluator uses, so the two cannot drift.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

CATEGORIES = (
    "PRICE",
    "INDICATORS",
    "MOMENTUM",
    "TREND",
    "VOLATILITY",
    "VOLUME",
    "PRICE_ACTION",
    "CHART_PATTERNS",
    "MATH",
    "TIME",
    "SESSION",
    "POSITION",
    "ACCOUNT",
    "RISK",
    "EVENTS",
)

COMPARISON_OPERATORS = ("GT", "GTE", "LT", "LTE", "EQ", "NEQ")
CROSS_OPERATORS = ("CROSS_ABOVE", "CROSS_BELOW")
ALL_OPERATORS = COMPARISON_OPERATORS + CROSS_OPERATORS

#: Human labels for the operators, shared by the UI and the explainer.
OPERATOR_LABELS = {
    "GT": "is above",
    "GTE": "is at or above",
    "LT": "is below",
    "LTE": "is at or below",
    "EQ": "equals",
    "NEQ": "does not equal",
    "CROSS_ABOVE": "crosses above",
    "CROSS_BELOW": "crosses below",
    "RISING": "is rising",
    "FALLING": "is falling",
}


@dataclass(frozen=True)
class ConditionSpec:
    """Everything the UI and the evaluator need to know about a condition."""

    kind: str
    category: str
    label: str
    #: How many candles (or how much account state) it needs.
    requires_candles: bool
    requires_volume: bool
    requires_instrument_metadata: bool
    requires_position: bool
    requires_account: bool
    #: Parameter names the condition accepts.
    parameters: tuple[str, ...] = ()
    #: Operators the condition accepts.
    operators: tuple[str, ...] = COMPARISON_OPERATORS
    #: ``SCALAR`` (a number), ``BOOLEAN`` (true/false), or ``EVENT``.
    output: str = "SCALAR"
    #: Timeframe is meaningful for this condition.
    supports_timeframe: bool = True
    explanation: str = ""
    #: A short example, shown under search results.
    example: str = ""

    def to_json(self) -> dict:
        return asdict(self)


SPECS: tuple[ConditionSpec, ...] = (
    # ---------------------------------------------------------------- PRICE
    ConditionSpec(
        kind="PRICE_LEVEL",
        category="PRICE",
        label="Price level",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("level",),
        explanation="the current price compared with a fixed level",
        example="Price is at or above 2500",
    ),
    ConditionSpec(
        kind="PRICE_CROSS",
        category="PRICE",
        label="Price crosses a level",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("level",),
        operators=("CROSS_ABOVE", "CROSS_BELOW"),
        explanation="price moving through a fixed level on this candle",
        example="Price crosses above 2500",
    ),
    ConditionSpec(
        kind="SPREAD",
        category="PRICE",
        label="Spread",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("value", "unit"),
        explanation="the live bid/ask spread",
        example="Spread is at or below 0.5",
    ),
    # ------------------------------------------------------------ INDICATORS
    ConditionSpec(
        kind="INDICATOR_THRESHOLD",
        category="INDICATORS",
        label="Indicator threshold",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("indicator", "period", "value", "fastPeriod", "slowPeriod", "signalPeriod", "component", "lengthDeviation", "stdDevMultiple", "lookback"),
        explanation="an indicator compared with a constant",
        example="RSI(14) is below 30",
    ),
    ConditionSpec(
        kind="INDICATOR_COMPARE",
        category="INDICATORS",
        label="Compare two indicators",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("left", "right"),
        operators=ALL_OPERATORS,
        explanation="two indicators compared with each other",
        example="EMA(20) crosses above EMA(50)",
    ),
    # -------------------------------------------------------------- MOMENTUM
    ConditionSpec(
        kind="MOMENTUM_BAND",
        category="MOMENTUM",
        label="Oscillator band",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("oscillator", "lower", "upper"),
        explanation="an oscillator sitting inside a band, e.g. RSI between 30 and 70",
        example="RSI(14) is between 30 and 70",
    ),
    # ------------------------------------------------------------- TREND
    ConditionSpec(
        kind="TREND_DIRECTION",
        category="TREND",
        label="Trend direction",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("indicator", "period", "lookback"),
        operators=("RISING", "FALLING"),
        explanation="a moving average rising or falling over a lookback",
        example="EMA(50) is rising over 10 candles",
    ),
    ConditionSpec(
        kind="ADX_STRENGTH",
        category="TREND",
        label="Trend strength (ADX)",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("period", "value"),
        explanation="ADX, which measures trend strength regardless of direction",
        example="ADX(14) is at or above 25",
    ),
    # ---------------------------------------------------------- VOLATILITY
    ConditionSpec(
        kind="VOLATILITY",
        category="VOLATILITY",
        label="Volatility threshold",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("measure", "period", "lookback", "value"),
        explanation="ATR, standard deviation, historical volatility, or Bollinger width against a threshold",
        example="ATR(14) is at or above 2.5",
    ),
    ConditionSpec(
        kind="VOLATILITY_COMPARE",
        category="VOLATILITY",
        label="Volatility vs its own history",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("fast", "slow"),
        explanation="short-term volatility compared with longer-term volatility",
        example="ATR(14) is at or above ATR(50)",
    ),
    # -------------------------------------------------------------- VOLUME
    ConditionSpec(
        kind="VOLUME",
        category="VOLUME",
        label="Volume",
        requires_candles=True,
        requires_volume=True,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("measure", "period", "value"),
        explanation="volume, volume change, or volume relative to its own average",
        example="Volume is at or above 1.5x its 20-candle average",
    ),
    # -------------------------------------------------------- PRICE ACTION
    ConditionSpec(
        kind="PRICE_ACTION",
        category="PRICE_ACTION",
        label="Price action",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("measure", "operator", "value", "count", "period", "lookback"),
        explanation="candle shape, wick size, structure, or distance from a moving average",
        example="Lower wick is more than 60% of the candle range",
    ),
    ConditionSpec(
        kind="CONSECUTIVE",
        category="PRICE_ACTION",
        label="Consecutive candles",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("direction", "count"),
        explanation="a run of same-direction candles",
        example="3 consecutive bullish candles",
    ),
    ConditionSpec(
        kind="STRUCTURE",
        category="PRICE_ACTION",
        label="Market structure",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("structure", "lookback"),
        operators=("RISING", "FALLING"),
        explanation="swing highs and lows stepping in the same direction",
        example="Market structure is rising",
    ),
    # ------------------------------------------------------ CHART PATTERNS
    ConditionSpec(
        kind="PATTERN",
        category="CHART_PATTERNS",
        label="Chart pattern",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("pattern", "lookback", "tolerancePercent", "minSeparationBars", "swingLookback", "volumeMultiplier"),
        output="BOOLEAN",
        explanation="a deterministically detected chart pattern",
        example="Breakout above the rolling 20-candle high",
    ),
    # ------------------------------------------------------------- MATH
    ConditionSpec(
        kind="MATH_EXPR",
        category="MATH",
        label="Mathematical expression",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("expression", "value"),
        explanation="a bounded arithmetic expression over indicators and price",
        example="abs(close - EMA(50)) / ATR(14) is above 2",
    ),
    # -------------------------------------------------------------- TIME
    ConditionSpec(
        kind="TIME",
        category="TIME",
        label="Time of day / week",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("measure", "operator", "value", "timezone"),
        supports_timeframe=False,
        explanation="the current time, evaluated in a named timezone",
        example="Hour of day is at or above 13",
    ),
    ConditionSpec(
        kind="EVENT",
        category="EVENTS",
        label="Position or order event",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("event",),
        output="EVENT",
        supports_timeframe=False,
        explanation="a position or order event rather than a continuous reading",
        example="On position opened",
    ),
    # ----------------------------------------------------------- SESSION
    ConditionSpec(
        kind="SESSION",
        category="SESSION",
        label="Trading session",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("boundary", "sessionId", "timezone", "startsAtMinute", "endsAtMinute"),
        supports_timeframe=False,
        output="BOOLEAN",
        explanation="whether the market is inside a named session window",
        example="Session LONDON: within",
    ),
    # ---------------------------------------------------------- POSITION
    ConditionSpec(
        kind="PROXIMITY",
        category="POSITION",
        label="Position near a level",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=True,
        requires_position=True,
        requires_account=False,
        parameters=("level", "withinPrice", "withinPips", "withinTicks", "withinPercent", "withinValue"),
        explanation="distance from a position's stop loss or take profit",
        example="Position is within 0.3% of its stop loss",
    ),
    ConditionSpec(
        kind="POSITION",
        category="POSITION",
        label="Position state",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=True,
        requires_account=False,
        parameters=("measure", "operator", "value"),
        supports_timeframe=False,
        explanation="open P&L, size, holding time, or how many positions exist",
        example="Position P&L percent is below -2",
    ),
    # ----------------------------------------------------------- ACCOUNT
    ConditionSpec(
        kind="ACCOUNT",
        category="ACCOUNT",
        label="Account state",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=True,
        parameters=("measure", "operator", "value"),
        supports_timeframe=False,
        explanation="equity, balance, margin, or aggregate exposure",
        example="Exposure is above 50000",
    ),
    ConditionSpec(
        kind="RISK",
        category="RISK",
        label="Risk state",
        requires_candles=False,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=True,
        parameters=("measure", "operator", "value", "state"),
        supports_timeframe=False,
        explanation="drawdown, daily loss, kill switch, or how much of the exposure limit is used",
        example="Drawdown percent is at or above 3",
    ),
    # -------------------------------------------------------------- BREAKOUT
    ConditionSpec(
        kind="BREAKOUT",
        category="CHART_PATTERNS",
        label="Breakout",
        requires_candles=True,
        requires_volume=False,
        requires_instrument_metadata=False,
        requires_position=False,
        requires_account=False,
        parameters=("direction", "lookbackBars", "level", "requireVolumeConfirmation", "volumeMultiplier"),
        output="BOOLEAN",
        explanation="price breaking a fixed level or the recent range",
        example="Breakout above the last 20 candles",
    ),
)

BY_KIND: dict[str, ConditionSpec] = {spec.kind: spec for spec in SPECS}


def spec_for(kind: str) -> ConditionSpec | None:
    return BY_KIND.get(kind)


def indicators_required(leaf: dict) -> set[str]:
    """Which indicator names a leaf needs, for compute planning."""
    from . import indicators as indicator_module
    from . import patterns as pattern_module
    from . import price_action as price_action_module

    kind = leaf.get("kind")
    names: set[str] = set()

    if kind in {"INDICATOR_THRESHOLD", "VOLATILITY", "VOLUME"}:
        measure = leaf.get("measure") or leaf.get("indicator")
        if isinstance(measure, str) and measure in indicator_module.INDICATORS:
            names.add(measure)
        if kind == "VOLATILITY" and measure in {"ATR", "STDDEV", "HISTORICAL_VOLATILITY", "BOLLINGER_WIDTH", "RANGE"}:
            names.add("ATR" if measure == "ATR" else "STDDEV")
    if kind == "TREND_DIRECTION":
        indicator = leaf.get("indicator")
        if isinstance(indicator, str) and indicator in indicator_module.INDICATORS:
            names.add(indicator)
    if kind == "ADX_STRENGTH":
        names.add("ADX")
    if kind == "MOMENTUM_BAND":
        oscillator = leaf.get("oscillator")
        if isinstance(oscillator, str) and oscillator in indicator_module.INDICATORS:
            names.add(oscillator)
    if kind == "VOLATILITY_COMPARE":
        names.update({"ATR", "ATR"})
    if kind == "INDICATOR_COMPARE":
        for side in ("left", "right"):
            entry = leaf.get(side)
            if isinstance(entry, dict) and isinstance(entry.get("indicator"), str):
                names.add(entry["indicator"])
    if kind in {"PRICE_ACTION", "STRUCTURE"}:
        measure = leaf.get("measure")
        if isinstance(measure, str) and measure in {"DISTANCE_FROM_SMA", "DISTANCE_FROM_EMA"}:
            names.add("SMA" if measure.endswith("SMA") else "EMA")
    if kind == "PATTERN" and leaf.get("pattern") == "VOLATILITY_CONTRACTION":
        names.add("ATR")
    if kind == "BREAKOUT" and leaf.get("requireVolumeConfirmation"):
        names.add("VOLUME_RATIO")
    if kind == "MATH_EXPR":
        from .math_expr import parse, referenced_indicators

        try:
            for name, _period in referenced_indicators(parse(leaf.get("expression", ""))):
                names.add(name)
        except Exception:
            pass

    return names


def price_action_measures() -> tuple[str, ...]:
    from .price_action import MEASURES

    return MEASURES


def pattern_names() -> tuple[str, ...]:
    from .patterns import PATTERNS

    return PATTERNS


def indicator_names() -> tuple[str, ...]:
    from .indicators.engine import INDICATORS

    return tuple(sorted(INDICATORS))


def catalogue_json() -> dict:
    """The catalogue, serialised for the web app."""
    return {
        "categories": list(CATEGORIES),
        "operators": [{"id": key, "label": value} for key, value in OPERATOR_LABELS.items()],
        "conditions": [spec.to_json() for spec in SPECS],
        "indicators": list(indicator_names()),
        "priceActionMeasures": list(price_action_measures()),
        "patterns": list(pattern_names()),
    }
