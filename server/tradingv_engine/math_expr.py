"""Bounded mathematical expressions.

A user may want "price is more than two ATRs away from EMA(50)" or
"price is above EMA(20) x 1.01", which no fixed-arity indicator
comparison can express. That is what this module is for.

Security model
--------------

**There is no ``eval``, no ``exec``, no ``compile``, and no import of
user text as Python.** A user expression is tokenised, parsed by a
recursive-descent parser into an AST of whitelisted node types, and then
*interpreted* by :func:`evaluate_ast` using a dict of series values.

Specifically:

* Operands are a closed set: named indicators, named series fields, and
  numeric literals.
* Operators are a closed set: ``+ - * / % **`` and the comparison set.
* Functions are a closed set, each implemented in this file.
* Depth, node count, and expression length are all bounded.
* Division by zero, NaN, and infinity produce ``None`` (UNKNOWN), never
  a crash and never a fabricated number.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import numpy as np

MAX_EXPRESSION_LENGTH = 400
MAX_AST_NODES = 64
MAX_DEPTH = 12

#: Series fields a user expression may reference.
ALLOWED_FIELDS = frozenset({"open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"})

#: Indicator names a user expression may reference.
ALLOWED_INDICATORS = frozenset(
    {
        "SMA", "EMA", "WMA", "VWAP", "MACD", "MACD_SIGNAL", "MACD_HIST",
        "ADX", "PLUS_DI", "MINUS_DI", "PSAR", "RSI", "STOCHASTIC",
        "WILLIAMS_R", "ROC", "MOMENTUM", "ATR",
        "BB_UPPER", "BB_MIDDLE", "BB_LOWER", "BB_WIDTH",
        "STDDEV", "HIST_VOL",
    }
)

#: Named indicator symbols that may appear in an expression.
INDICATOR_SYMBOLS = {
    "SMA": "SMA", "EMA": "EMA", "WMA": "WMA", "VWAP": "VWAP",
    "MACD": "MACD", "SIGNAL": "MACD_SIGNAL", "HIST": "MACD_HIST",
    "ADX": "ADX", "PLUS_DI": "PLUS_DI", "PLUSDI": "PLUS_DI",
    "MINUS_DI": "MINUS_DI", "MINUSDI": "MINUS_DI",
    "PSAR": "PSAR", "RSI": "RSI", "STOCH": "STOCHASTIC", "STOCHASTIC": "STOCHASTIC",
    "WILLR": "WILLIAMS_R", "WILLIAMS_R": "WILLIAMS_R",
    "ROC": "ROC", "MOM": "MOMENTUM", "MOMENTUM": "MOMENTUM", "ATR": "ATR",
    "BB_UPPER": "BB_UPPER", "BB_MIDDLE": "BB_MIDDLE", "BB_LOWER": "BB_LOWER", "BB_WIDTH": "BB_WIDTH",
    "STDDEV": "STDDEV", "HIST_VOL": "HIST_VOL", "HV": "HIST_VOL",
}


class ExpressionError(ValueError):
    """The expression is not a permitted mathematical expression."""


# --------------------------------------------------------------------------- #
# Tokeniser
# --------------------------------------------------------------------------- #

_TOKEN_RE = re.compile(
    r"""
    (?P<space>\s+)
  | (?P<number>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
  | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>\*\*|<=|>=|==|!=|[-+*/%()<>,])
    """,
    re.VERBOSE,
)


@dataclass(frozen=True)
class Token:
    kind: str
    value: str


def tokenize(source: str) -> list[Token]:
    if len(source) > MAX_EXPRESSION_LENGTH:
        raise ExpressionError(f"Expression is longer than {MAX_EXPRESSION_LENGTH} characters.")

    tokens: list[Token] = []
    position = 0
    while position < len(source):
        match = _TOKEN_RE.match(source, position)
        if match is None:
            raise ExpressionError(f"Unexpected character {source[position]!r} at position {position}.")
        position = match.end()
        if match.lastgroup == "space":
            continue
        assert match.lastgroup is not None
        tokens.append(Token(kind=match.lastgroup, value=match.group()))

    return tokens


# --------------------------------------------------------------------------- #
# AST
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Num:
    value: float


@dataclass(frozen=True)
class Field:
    name: str


@dataclass(frozen=True)
class IndicatorRef:
    name: str
    period: int | None
    secondary: int | None


@dataclass(frozen=True)
class Unary:
    op: str
    operand: Any


@dataclass(frozen=True)
class Binary:
    op: str
    left: Any
    right: Any


@dataclass(frozen=True)
class Call:
    name: str
    args: tuple[Any, ...]


#: Every node type the parser may emit. A node outside this set is a bug.
ALLOWED_NODES = (Num, Field, IndicatorRef, Unary, Binary, Call)

#: Whitelisted functions. Each is total: it returns ``None`` rather than
#: raising on a bad argument.
FUNCTIONS: dict[str, Callable[..., float | None]] = {
    "abs": lambda x: None if x is None else abs(x),
    "log": lambda x: None if x is None or x <= 0 else math.log(x),
    "log10": lambda x: None if x is None or x <= 0 else math.log10(x),
    "sqrt": lambda x: None if x is None or x < 0 else math.sqrt(x),
    "min": lambda a, b: None if a is None or b is None else min(a, b),
    "max": lambda a, b: None if a is None or b is None else max(a, b),
    "sign": lambda x: None if x is None else float(np.sign(x)),
    "round": lambda x, n=0: None if x is None else round(x, int(n)),
}

ALLOWED_FUNCTIONS = frozenset(FUNCTIONS)


class _Parser:
    def __init__(self, tokens: Sequence[Token]) -> None:
        self.tokens = list(tokens)
        self.index = 0
        self.nodes = 0

    def peek(self) -> Token | None:
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def take(self) -> Token:
        token = self.peek()
        if token is None:
            raise ExpressionError("Expression ended unexpectedly.")
        self.index += 1
        return token

    def expect(self, value: str) -> None:
        token = self.take()
        if token.value != value:
            raise ExpressionError(f"Expected {value!r} but found {token.value!r}.")

    def count(self) -> None:
        self.nodes += 1
        if self.nodes > MAX_AST_NODES:
            raise ExpressionError(f"Expression has more than {MAX_AST_NODES} nodes.")

    # expression := comparison
    def parse(self, depth: int = 0) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        node = self.parse_sum(depth + 1)
        token = self.peek()
        if token and token.value in {"<", ">", "<=", ">=", "==", "!="}:
            self.take()
            right = self.parse_sum(depth + 1)
            self.count()
            return Binary(token.value, node, right)
        return node

    def parse_sum(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        node = self.parse_product(depth + 1)
        while True:
            token = self.peek()
            if not token or token.value not in {"+", "-"}:
                return node
            self.take()
            right = self.parse_product(depth + 1)
            self.count()
            node = Binary(token.value, node, right)

    def parse_product(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        node = self.parse_unary(depth + 1)
        while True:
            token = self.peek()
            if not token or token.value not in {"*", "/", "%"}:
                return node
            self.take()
            right = self.parse_unary(depth + 1)
            self.count()
            node = Binary(token.value, node, right)

    def parse_unary(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        token = self.peek()
        if token and token.value in {"-", "+"}:
            self.take()
            operand = self.parse_unary(depth + 1)
            self.count()
            return Unary(token.value, operand)
        return self.parse_power(depth + 1)

    def parse_power(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        base = self.parse_atom(depth + 1)
        token = self.peek()
        if token and token.value == "**":
            self.take()
            exponent = self.parse_unary(depth + 1)
            self.count()
            return Binary("**", base, exponent)
        return base

    def parse_atom(self, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ExpressionError(f"Expression nests deeper than {MAX_DEPTH} levels.")

        token = self.take()

        if token.kind == "number":
            self.count()
            return Num(float(token.value))

        if token.value == "(":
            node = self.parse(depth + 1)
            self.expect(")")
            return node

        if token.kind == "name":
            self.count()
            name = token.value
            upper = name.upper()

            following = self.peek()

            if upper in INDICATOR_SYMBOLS and following and following.value == "(":
                self.take()
                period = int(float(self.take().value))
                self.expect(")")
                return self._indicator(upper, period)

            if following and following.value == "(":
                if name not in ALLOWED_FUNCTIONS:
                    raise ExpressionError(
                        f"Function {name!r} is not allowed. Allowed: {sorted(ALLOWED_FUNCTIONS)}."
                    )
                self.take()
                args: list[Any] = []
                if not (self.peek() and self.peek().value == ")"):  # type: ignore[union-attr]
                    args.append(self.parse(depth + 1))
                    while self.peek() and self.peek().value == ",":  # type: ignore[union-attr]
                        self.take()
                        args.append(self.parse(depth + 1))
                self.expect(")")
                self.count()
                return Call(name, tuple(args))

            if following and following.kind == "number" and upper in INDICATOR_SYMBOLS:
                self.take()
                return self._indicator(upper, int(float(following.value)))

            if upper in INDICATOR_SYMBOLS:
                return self._indicator(upper, None)

            if name in ALLOWED_FIELDS:
                return Field(name)

            raise ExpressionError(
                f"Unknown name {name!r}. Allowed indicators: {sorted(INDICATOR_SYMBOLS)}. "
                f"Allowed fields: {sorted(ALLOWED_FIELDS)}. Allowed functions: {sorted(ALLOWED_FUNCTIONS)}."
            )

        raise ExpressionError(f"Unexpected token {token.value!r}.")

    def _indicator(self, symbol: str, period: int | None) -> IndicatorRef:
        name = INDICATOR_SYMBOLS[symbol]
        if name not in ALLOWED_INDICATORS:
            raise ExpressionError(f"Indicator {name!r} is not available in expressions.")
        return IndicatorRef(name=name, period=period, secondary=None)


def parse(source: str) -> Any:
    """
    Parse a user expression into a whitelisted AST.

    Raises :class:`ExpressionError` on anything the grammar does not
    allow. The returned object contains only the node types in
    :data:`ALLOWED_NODES` and references only names in the allow-lists.
    """
    if not isinstance(source, str) or not source.strip():
        raise ExpressionError("Expression must be a non-empty string.")

    tokens = tokenize(source)
    if not tokens:
        raise ExpressionError("Expression contains no tokens.")

    parser = _Parser(tokens)
    node = parser.parse()
    if parser.peek() is not None:
        raise ExpressionError(f"Unexpected trailing input {parser.peek().value!r}.")  # type: ignore[union-attr]
    return node


# --------------------------------------------------------------------------- #
# Interpreter
# --------------------------------------------------------------------------- #


def evaluate_ast(node: Any, values: dict[str, float | None]) -> float | None:
    """
    Interpret a whitelisted AST against a value map.

    Returns ``None`` for anything unmeasurable, which the evaluator maps
    to ``UNKNOWN``. Never raises for a bad value.
    """
    if isinstance(node, Num):
        return node.value

    if isinstance(node, Field):
        return values.get(node.name)

    if isinstance(node, IndicatorRef):
        return values.get(_indicator_key(node.name, node.period))

    if isinstance(node, Unary):
        operand = evaluate_ast(node.operand, values)
        if operand is None:
            return None
        return -operand if node.op == "-" else operand

    if isinstance(node, Binary):
        left = evaluate_ast(node.left, values)
        right = evaluate_ast(node.right, values)
        if left is None or right is None:
            return None
        return _binary(node.op, left, right)

    if isinstance(node, Call):
        arguments = [evaluate_ast(argument, values) for argument in node.args]
        if any(argument is None for argument in arguments):
            return None
        try:
            return FUNCTIONS[node.name](*arguments)
        except Exception:
            return None

    raise ExpressionError(f"Node type {type(node).__name__} is not permitted in an expression.")


def _binary(op: str, left: float, right: float) -> float | None:
    try:
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            return None if right == 0 else left / right
        if op == "%":
            return None if right == 0 else math.fmod(left, right)
        if op == "**":
            result = left**right
            return result if math.isfinite(result) else None
        # A comparison inside an expression yields 1.0 or 0.0, so an
        # expression can be combined arithmetically, e.g. `(RSI(14) < 30) * 1`.
        if op == ">":
            return 1.0 if left > right else 0.0
        if op == "<":
            return 1.0 if left < right else 0.0
        if op == ">=":
            return 1.0 if left >= right else 0.0
        if op == "<=":
            return 1.0 if left <= right else 0.0
        if op == "==":
            return 1.0 if left == right else 0.0
        if op == "!=":
            return 1.0 if left != right else 0.0
    except (OverflowError, ValueError, ZeroDivisionError):
        return None

    raise ExpressionError(f"Operator {op!r} is not permitted in an expression.")


def _indicator_key(name: str, period: int | None) -> str:
    return f"{name}({period})" if period is not None else name


def indicator_key(name: str, period: int | None) -> str:
    """Public helper: the value-map key for an indicator reference."""
    return _indicator_key(name, period)


def describe(source: str) -> str:
    """
    Normalise an expression for display.

    Whitespace is collapsed and the expression is echoed back, so the UI
    always shows exactly what the engine will parse - never a separately
    maintained "pretty" version that could drift.
    """
    try:
        parse(source)
    except ExpressionError:
        return " ".join(source.split())
    return " ".join(source.split())


def referenced_indicators(node: Any) -> set[tuple[str, int | None]]:
    """Every (indicator, period) an AST touches. Used to plan computation."""
    found: set[tuple[str, int | None]] = set()

    def visit(current: Any) -> None:
        if isinstance(current, IndicatorRef):
            found.add((current.name, current.period))
        elif isinstance(current, Unary):
            visit(current.operand)
        elif isinstance(current, Binary):
            visit(current.left)
            visit(current.right)
        elif isinstance(current, Call):
            for argument in current.args:
                visit(argument)

    visit(node)
    return found
