"""The canonical condition contract.

The schema at ``shared/condition_schema_v1.json`` is the single source of
truth for the TradingVibe condition language. The web app builds trees in
that shape and this package validates and evaluates them. There is no
second, engine-only condition language.

Design rules enforced here:

* Only supported schema versions are accepted. An unknown version is a
  hard failure, not a best-effort parse.
* Validation is *structural*. Values that the schema cannot express -
  a non-finite number, a lookback of zero, a timeframe the venue does not
  serve - are rejected with a reason rather than coerced.
* Live trading is not expressible. There is no schema path that can
  produce an order.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .config import DEFAULT_TIMEFRAME, SUPPORTED_SCHEMA_VERSIONS, SUPPORTED_TIMEFRAMES

#: Where the schema lives. Resolved from the repository root so both the
#: engine and its tests read the same committed file.
_REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = _REPO_ROOT / "shared" / "condition_schema_v1.json"

SCHEMA_VERSION = SUPPORTED_SCHEMA_VERSIONS[-1]


class ContractError(ValueError):
    """The condition tree does not satisfy the canonical schema."""


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    return Draft202012Validator(load_schema())


def schema_errors(tree: Any) -> list[str]:
    """Return every structural problem with ``tree``, human readable."""
    if not isinstance(tree, dict):
        return ["Condition tree must be a JSON object."]

    version = tree.get("schemaVersion")
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        return [
            f"Unsupported condition schema version {version!r}. "
            f"This engine implements {list(SUPPORTED_SCHEMA_VERSIONS)}."
        ]

    validator = _validator()
    messages: list[str] = []
    for error in sorted(validator.iter_errors(tree), key=lambda e: list(e.absolute_path)):
        location = ".".join(str(part) for part in error.absolute_path) or "root"
        messages.append(f"{location}: {error.message}")
    return messages


def validate_tree(tree: Any) -> None:
    """Raise :class:`ContractError` if the tree is not canonical."""
    problems = schema_errors(tree)
    if problems:
        raise ContractError("; ".join(problems))


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def walk(node: dict[str, Any]):
    """Depth-first walk over a tree, yielding ``(node, depth)``."""
    stack: list[tuple[dict[str, Any], int]] = [(node, 0)]
    while stack:
        current, depth = stack.pop()
        yield current, depth
        if current.get("kind") == "GROUP":
            for child in reversed(current.get("children", [])):
                stack.append((child, depth + 1))


def leaf_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item, _ in walk(node) if item.get("kind") != "GROUP"]


#: Leaf kinds that read the raw candle series, so the monitor must have
#: fetched that timeframe even when no indicator is named.
_SERIES_KINDS = frozenset(
    {
        "PRICE_LEVEL",
        "PRICE_CROSS",
        "PRICE_ACTION",
        "CONSECUTIVE",
        "STRUCTURE",
        "PATTERN",
        "BREAKOUT",
        "SPREAD",
        "PROXIMITY",
        "MATH_EXPR",
        "VOLATILITY",
        "VOLATILITY_COMPARE",
        "VOLUME",
        "INDICATOR_THRESHOLD",
        "INDICATOR_COMPARE",
        "MOMENTUM_BAND",
        "TREND_DIRECTION",
        "ADX_STRENGTH",
    }
)


def condition_textures(node: dict[str, Any]) -> list[dict[str, str]]:
    """Every (timeframe, indicator) pair the tree needs.

    The monitor uses this to compute only the series that active bots
    actually reference, instead of every indicator for every market. The
    result is a compute plan, not a validation result: an unknown
    indicator is simply not scheduled, and the evaluator reports it as
    ``UNKNOWN`` when the tree is actually run.
    """
    from .catalogue import indicators_required  # local import avoids a cycle

    if not isinstance(node, dict) or "kind" not in node and "root" not in node:
        # Returning an empty plan here would make the monitor compute
        # nothing while still looking healthy, so it is a hard failure.
        raise ContractError("condition_textures expects a condition node or a tree with a root.")

    # Accept either the wrapper document or the root node itself. Silently
    # returning an empty plan for a wrapper would make the monitor compute
    # nothing at all while still looking healthy.
    root = node.get("root") if isinstance(node, dict) and "root" in node else node

    required: dict[tuple[str, str], dict[str, str]] = {}

    def note(timeframe: Any, indicator: str) -> None:
        # A leaf may not name a timeframe; the tracker default applies.
        resolved = timeframe if timeframe in SUPPORTED_TIMEFRAMES else DEFAULT_TIMEFRAME
        required.setdefault((resolved, indicator), {"timeframe": resolved, "indicator": indicator})

    for leaf in leaf_nodes(root):
        if leaf.get("enabled") is False:
            continue

        timeframe = leaf.get("timeframe")

        if leaf.get("kind") in _SERIES_KINDS:
            note(timeframe, "__SERIES__")

        # An indicator side may override the leaf's timeframe, so each
        # side is scheduled against its own.
        for side in ("left", "right"):
            spec = leaf.get(side)
            if isinstance(spec, dict) and isinstance(spec.get("indicator"), str):
                note(spec.get("timeframe") or timeframe, spec["indicator"])

        for name in sorted(indicators_required(leaf)):
            note(timeframe, name)

    return sorted(required.values(), key=lambda item: (item["timeframe"], item["indicator"]))


def supported_timeframes() -> tuple[str, ...]:
    return SUPPORTED_TIMEFRAMES
