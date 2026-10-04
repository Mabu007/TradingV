"""Mathematical expression tests.

The security-relevant assertions are at the bottom: no arbitrary code
execution, and a hard refusal of anything outside the grammar.
"""

from __future__ import annotations

import pytest

from tradingv_engine import math_expr
from tradingv_engine.math_expr import (
    Binary,
    Call,
    ExpressionError,
    Unary,
    evaluate_ast,
    parse,
    referenced_indicators,
)

VALUES = {
    "close": 100.0,
    "open": 99.0,
    "high": 101.0,
    "low": 98.0,
    "volume": 1000.0,
    "hl2": 99.5,
    "RSI(14)": 27.4,
    "EMA(50)": 105.0,
    "ATR(14)": 2.0,
}


@pytest.mark.parametrize(
    "source,expected",
    [
        ("close + 0", 100.0),
        ("close*2", 200.0),
        ("close/4", 25.0),
        ("close - 10", 90.0),
        ("close + 1", 101.0),
        ("-close", -100.0),
        ("close % 7", 100.0 % 7),
        ("2 ** 3", 8.0),
        ("abs(close - 105)", 5.0),
        ("min(close, 50)", 50.0),
        ("max(close, 50)", 100.0),
        ("sqrt(close)", 10.0),
        ("log10(100)", 2.0),
    ],
)
def test_arithmetic(source, expected):
    assert evaluate_ast(parse(source), VALUES) == pytest.approx(expected)


def test_indicator_references_resolve():
    # A comparison inside an expression yields 1 or 0.
    assert evaluate_ast(parse("RSI(14) < 30"), VALUES) == 1.0
    assert evaluate_ast(parse("RSI(14) > 30"), VALUES) == 0.0
    assert evaluate_ast(parse("close - EMA(50)"), VALUES) == pytest.approx(-5.0)


def test_atr_normalised_distance():
    result = evaluate_ast(parse("abs(close - EMA(50)) / ATR(14)"), VALUES)
    assert result == pytest.approx(2.5)


def test_price_above_a_scaled_ema():
    assert evaluate_ast(parse("close > EMA(50) * 1.01"), {"close": 110.0, "EMA(50)": 100.0}) == 1.0
    assert evaluate_ast(parse("close > EMA(50) * 1.01"), {"close": 100.0, "EMA(50)": 100.0}) == 0.0


def test_operator_precedence_is_normal():
    assert evaluate_ast(parse("2 + 3 * 4"), {}) == pytest.approx(14.0)
    assert evaluate_ast(parse("(2 + 3) * 4"), {}) == pytest.approx(20.0)


def test_comparison_operators_are_supported():
    assert evaluate_ast(parse("close > 99"), VALUES) == 1.0
    assert evaluate_ast(parse("close < 99"), VALUES) == 0.0
    assert evaluate_ast(parse("close >= 100"), VALUES) == 1.0
    assert evaluate_ast(parse("close <= 100"), VALUES) == 1.0
    assert evaluate_ast(parse("close == 100"), VALUES) == 1.0
    assert evaluate_ast(parse("close != 100"), VALUES) == 0.0


def test_division_by_zero_is_unknown_not_infinity():
    assert evaluate_ast(parse("close / 0"), VALUES) is None


def test_missing_operand_is_unknown():
    assert evaluate_ast(parse("close + EMA(999)"), VALUES) is None


def test_sqrt_of_a_negative_is_unknown():
    assert evaluate_ast(parse("sqrt(0 - 100)"), VALUES) is None


def test_log_of_a_negative_is_unknown():
    assert evaluate_ast(parse("log(0 - 100)"), VALUES) is None


@pytest.mark.parametrize(
    "source",
    [
        "__import__('os').system('ls')",
        "open('/etc/passwd').read()",
        "exec('1+1')",
        "eval('1+1')",
        "close.__class__",
        "().__class__.__bases__",
        "globals()",
        "locals()",
        "compile('1','<s>','eval')",
        "lambda: 1",
        "[x for x in range(10)]",
        "close if True else 0",
        "print(close)",
        "os.system('ls')",
        "import os",
    ],
)
def test_arbitrary_code_is_refused(source):
    with pytest.raises(ExpressionError):
        parse(source)


@pytest.mark.parametrize(
    "source",
    [
        "unknown_name",
        "SIN(close)",
        "close ^ 2",
        "close & 1",
        "close | 1",
        "close $ 1",
        "close; 1",
        "close, 1",
        "",
        "   ",
        "close ~ 1",
        "close %%% 2",
    ],
)
def test_non_grammar_input_is_refused(source):
    with pytest.raises(ExpressionError):
        parse(source)


def test_only_whitelisted_node_types_are_produced():
    def audit(node):
        assert isinstance(node, math_expr.ALLOWED_NODES), f"{type(node).__name__} is not allowed"
        if isinstance(node, Unary):
            audit(node.operand)
        elif isinstance(node, Binary):
            audit(node.left)
            audit(node.right)
        elif isinstance(node, Call):
            for argument in node.args:
                audit(argument)

    for source in ("close > 1", "abs(RSI(14) - 30) / ATR(14)", "EMA(20) * 1.01 - close"):
        audit(parse(source))


def test_expression_length_is_bounded():
    with pytest.raises(ExpressionError):
        parse("1 + " * 200 + "1")


def test_node_count_is_bounded():
    with pytest.raises(ExpressionError):
        parse("+".join(["1"] * (math_expr.MAX_AST_NODES + 10)))


def test_nesting_depth_is_bounded():
    with pytest.raises(ExpressionError):
        parse("(" * (math_expr.MAX_DEPTH + 5) + "1" + ")" * (math_expr.MAX_DEPTH + 5))


def test_unknown_field_is_refused():
    with pytest.raises(ExpressionError):
        parse("closeTime")


def test_unknown_indicator_is_refused():
    with pytest.raises(ExpressionError):
        parse("SUPERINDICATOR(14)")


def test_referenced_indicators_are_reported():
    found = referenced_indicators(parse("abs(RSI(14) - close) / ATR(14) + EMA(50)"))
    assert ("RSI", 14) in found
    assert ("ATR", 14) in found
    assert ("EMA", 50) in found
    assert ("VWAP", None) not in found


def test_no_dynamic_execution_in_the_module():
    """
    The module must not execute user text as Python.

    `re.compile` is a regex construction, not code execution, so the
    builtins are matched as bare calls rather than as substrings.
    """
    import inspect
    import re as re_module

    source = inspect.getsource(math_expr)
    # Strip attribute calls such as `re.compile(` before scanning.
    scrubbed = re_module.sub(r"\b\w+\.(compile|eval|exec)\(", "SAFE(", source)
    scrubbed = re_module.sub(r"^\s*#.*$", "", scrubbed, flags=re_module.MULTILINE)

    for forbidden in ("eval(", "exec(", "compile(", "__import__", "globals()", "locals()", "getattr(", "setattr("):
        assert forbidden not in scrubbed, f"{forbidden!r} appears in the expression module"
