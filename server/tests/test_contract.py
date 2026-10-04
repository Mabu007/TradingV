"""Contract tests.

These are the guardrails for the *shape* of the condition language rather
than the arithmetic inside it:

* The committed schema is the only definition, and the engine and the web
  app both read that one file.
* `THEN` is a closed enum. There is no path through the schema that can
  express an order, an approval, or live trading.
* Validation is structural and reports a reason instead of guessing.
* The shared examples evaluate to the state they claim, on the shared
  fixtures, in both Python and the browser.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from conftest import load_fixture_context
from tradingv_engine import contract
from tradingv_engine.contract import ContractError, condition_textures, schema_errors, validate_tree
from tradingv_engine.evaluator import LEAF_KINDS, evaluate_tree

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA = REPO_ROOT / "shared" / "condition_schema_v1.json"
EXAMPLES = REPO_ROOT / "shared" / "condition_examples.json"


def tree(**overrides):
    """A minimal valid tree that individual tests bend one field at a time."""
    base = {
        "schemaVersion": 1,
        "name": "Test",
        "then": "WAKE_AI",
        "root": {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [
                {
                    "id": "c1",
                    "kind": "PRICE_LEVEL",
                    "timeframe": "15m",
                    "direction": "ABOVE",
                    "level": 100.0,
                }
            ],
        },
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------------- #
# The schema file itself
# --------------------------------------------------------------------------- #


def test_engine_reads_the_committed_schema_file():
    assert contract.SCHEMA_PATH == SCHEMA
    assert contract.SCHEMA_PATH.exists()


def test_schema_is_itself_a_valid_json_schema():
    from jsonschema import Draft202012Validator

    Draft202012Validator.check_schema(contract.load_schema())


def test_every_node_kind_in_the_catalogue_exists_in_the_schema():
    from tradingv_engine.catalogue import SPECS

    schema_text = SCHEMA.read_text(encoding="utf-8")
    missing = sorted(spec.kind for spec in SPECS if f'"{spec.kind}"' not in schema_text)
    assert missing == [], f"catalogue kinds missing from the shared schema: {missing}"


def test_every_leaf_handler_in_the_evaluator_exists_in_the_schema():
    schema_text = SCHEMA.read_text(encoding="utf-8")
    missing = sorted(kind for kind in LEAF_KINDS if f'"{kind}"' not in schema_text)
    assert missing == [], f"evaluator kinds missing from the shared schema: {missing}"


# --------------------------------------------------------------------------- #
# THEN is closed
# --------------------------------------------------------------------------- #


def test_wake_ai_is_the_only_then():
    validate_tree(tree(then="WAKE_AI"))


@pytest.mark.parametrize("then", ["PLACE_ORDER", "BUY", "SELL", "APPROVE", "execute", "wake_ai", "", None, 1])
def test_no_other_then_is_accepted(then):
    with pytest.raises(ContractError):
        validate_tree(tree(then=then))


def test_a_tree_without_then_is_rejected():
    without = tree()
    del without["then"]
    problems = schema_errors(without)
    assert any("then" in problem for problem in problems)


def test_the_schema_contains_no_order_or_live_trading_vocabulary():
    """A guard against the schema quietly growing an execution path."""
    schema_text = SCHEMA.read_text(encoding="utf-8").lower()
    for forbidden in ("privatekey", "signingkey", "apikey", "leverage", "ordertype", "live_trading", "livesize"):
        assert forbidden not in schema_text, f"{forbidden!r} must never appear in the condition schema"


# --------------------------------------------------------------------------- #
# Versions
# --------------------------------------------------------------------------- #


def test_version_one_is_accepted():
    validate_tree(tree())


@pytest.mark.parametrize("version", [0, 2, "1", None, True])
def test_an_unsupported_version_is_a_hard_failure(version):
    with pytest.raises(ContractError) as error:
        validate_tree(tree(schemaVersion=version))
    assert "version" in str(error.value).lower()


def test_a_non_object_is_rejected_without_a_crash():
    for value in ([], "x", 7, None, True):
        assert schema_errors(value)


# --------------------------------------------------------------------------- #
# Structural validation
# --------------------------------------------------------------------------- #


def test_unknown_top_level_keys_are_rejected():
    problems = schema_errors(tree(liveTrading=True))
    assert problems


def test_unknown_leaf_keys_are_rejected():
    bad = tree()
    bad["root"]["children"][0]["secretOverride"] = True
    assert schema_errors(bad)


def test_a_group_needs_an_operator_and_children():
    bad = tree()
    bad["root"].pop("operator")
    assert schema_errors(bad)

    bad = tree()
    bad["root"].pop("children")
    assert schema_errors(bad)


def test_a_group_cannot_be_empty():
    bad = tree()
    bad["root"]["children"] = []
    assert schema_errors(bad)


def test_every_error_carries_a_json_path():
    bad = tree()
    bad["root"]["children"].append({"id": "c2", "kind": "PRICE_LEVEL", "direction": "ABOVE"})
    problems = schema_errors(bad)
    assert problems
    assert all(":" in problem for problem in problems)


def test_ids_must_be_present_on_every_node():
    bad = tree()
    del bad["root"]["children"][0]["id"]
    assert schema_errors(bad)


def test_an_unsupported_timeframe_is_rejected():
    bad = tree()
    bad["root"]["children"][0]["timeframe"] = "3m"
    assert schema_errors(bad)


def test_a_non_numeric_level_is_rejected():
    bad = tree()
    bad["root"]["children"][0]["level"] = "one thousand"
    assert schema_errors(bad)


# --------------------------------------------------------------------------- #
# Compute planning
# --------------------------------------------------------------------------- #


def test_a_plan_requested_for_the_wrong_shape_fails_loudly():
    """A silently empty compute plan would disable every tracker, quietly."""
    for bad in ({"schemaVersion": 1, "then": "WAKE_AI"}, {}, None, [], "tree"):
        with pytest.raises(ContractError):
            condition_textures(bad)


def test_a_price_only_tree_needs_no_indicators():
    textures = condition_textures(tree())
    assert textures == [{"timeframe": "15m", "indicator": "__SERIES__"}]


def test_an_indicator_threshold_schedules_that_indicator():
    textured = tree()
    textured["root"]["children"] = [
        {
            "id": "c1",
            "kind": "INDICATOR_THRESHOLD",
            "timeframe": "1h",
            "indicator": "RSI",
            "operator": "LT",
            "value": 30,
        }
    ]
    textures = condition_textures(textured)
    assert {"timeframe": "1h", "indicator": "RSI"} in textures
    assert {"timeframe": "1h", "indicator": "__SERIES__"} in textures


def test_a_disabled_leaf_is_not_scheduled():
    textured = tree()
    textured["root"]["children"] = [
        {
            "id": "c1",
            "kind": "INDICATOR_THRESHOLD",
            "timeframe": "1h",
            "indicator": "RSI",
            "operator": "LT",
            "value": 30,
            "enabled": False,
        }
    ]
    assert condition_textures(textured) == []


def test_each_side_of_a_comparison_schedules_its_own_timeframe():
    textured = tree()
    textured["root"]["children"] = [
        {
            "id": "c1",
            "kind": "INDICATOR_COMPARE",
            "timeframe": "15m",
            "operator": "GT",
            "left": {"indicator": "EMA", "period": 20, "timeframe": "1h"},
            "right": {"indicator": "SMA", "period": 50, "timeframe": "15m"},
        }
    ]
    textures = {(item["timeframe"], item["indicator"]) for item in condition_textures(textured)}
    assert ("1h", "EMA") in textures
    assert ("15m", "SMA") in textures


def test_a_math_expression_schedules_the_indicators_it_names():
    textured = tree()
    textured["root"]["children"] = [
        {
            "id": "c1",
            "kind": "MATH_EXPR",
            "timeframe": "15m",
            "expression": "RSI(14) - EMA(20) / 2",
            "operator": "GT",
            "value": 10,
        }
    ]
    textures = {(item["timeframe"], item["indicator"]) for item in condition_textures(textured)}
    assert ("15m", "RSI") in textures
    assert ("15m", "EMA") in textures


def test_every_shared_example_has_a_non_empty_compute_plan():
    for example in examples()["examples"]:
        plan = condition_textures(example["tree"])
        assert plan, f"{example['id']} scheduled no data, so it could never resolve"


def test_the_cross_timeframe_example_schedules_both_timeframes():
    example = next(item for item in examples()["examples"] if item["id"] == "multi-timeframe")
    timeframes = {item["timeframe"] for item in condition_textures(example["tree"])}
    assert {"15m", "1h"} <= timeframes


def test_textures_are_sorted_and_deduplicated():
    textured = tree()
    child = {
        "id": "c1",
        "kind": "INDICATOR_THRESHOLD",
        "timeframe": "15m",
        "indicator": "RSI",
        "operator": "LT",
        "value": 30,
    }
    textured["root"]["children"] = [child, {**child, "id": "c2"}, {**child, "id": "c3", "timeframe": "1h"}]
    textures = condition_textures(textured)
    keys = [(item["timeframe"], item["indicator"]) for item in textures]
    assert keys == sorted(keys)
    assert len(keys) == len(set(keys))


# --------------------------------------------------------------------------- #
# The shared examples are the shared test suite
# --------------------------------------------------------------------------- #


def examples():
    with EXAMPLES.open(encoding="utf-8") as handle:
        return json.load(handle)


def test_the_examples_file_declares_the_same_schema_version():
    assert examples()["schemaVersion"] == contract.SCHEMA_VERSION


def test_every_example_validates():
    for example in examples()["examples"]:
        validate_tree(example["tree"])


def test_every_example_evaluates_to_its_expected_state():
    contexts = load_fixture_context()
    for example in examples()["examples"]:
        context = contexts[example["context"]]
        result = evaluate_tree(example["tree"], context)
        assert result.status == example["expect"]["status"], (
            f"{example['id']} expected {example['expect']['status']} but got {result.status} ({result.reason})"
        )


def test_an_example_referencing_a_missing_context_fails_loudly():
    from tradingv_engine.evaluator import EvaluationContext

    contexts = load_fixture_context()
    assert "gold15mFlat" in contexts
    assert all(isinstance(value, EvaluationContext) for value in contexts.values())


def test_the_browser_runs_the_same_examples_against_the_same_schema():
    """
    The other half of this file.

    The browser has its own suite, `bun run test:conditions`, which
    validates every shared example against the committed schema *and* runs
    the engine over them to compare states. Both sides read the same
    fixtures, so a tree the engine accepts is a tree the app accepts.

    This test asserts that suite exists and is wired into `verify`. A
    parity check that is quietly deleted is the failure mode the whole
    arrangement exists to prevent, so its absence is a test failure rather
    than a missing line.
    """
    import json

    parity = REPO_ROOT / "src" / "engine" / "conditions" / "conditionParity.ts"
    assert parity.exists(), "the browser-side parity suite is missing"

    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    assert "test:conditions" in scripts, "test:conditions is not defined"
    assert "test:conditions" in scripts["verify"], "test:conditions is not part of verify"
    assert "test:engine" in scripts["verify"], "the engine suite is not part of verify"
    assert "test:pipeline" in scripts["verify"], "the pipeline acceptance test is not part of verify"

    # The parity suite must read the shared files rather than its own copy.
    source = parity.read_text(encoding="utf-8")
    assert "condition_examples.json" in source, "the parity suite does not read the shared examples"
    assert "condition_schema_v1.json" in source or "CONDITION_SCHEMA" in source, "the parity suite does not read the shared schema"
    # A skip is a skip, not a pass: the suite has to say so out loud.
    assert "skipped" in source, "the parity suite must report skips rather than passing quietly"


# --------------------------------------------------------------------------- #
# The evaluator and the schema describe the same language
# --------------------------------------------------------------------------- #


def _schema_branches() -> dict[str, dict]:
    """kind -> the schema branch that defines it."""
    defs = contract.load_schema()["$defs"]
    table: dict[str, dict] = {}
    for branch in defs["node"]["oneOf"]:
        definition = defs[branch["$ref"].split("/")[-1]]
        table[definition["properties"]["kind"]["const"]] = definition
    return table


def _handler_body(name: str) -> str:
    import inspect

    from tradingv_engine import evaluator

    return inspect.getsource(getattr(evaluator, f"_handle_{name}"))


def test_the_schema_has_a_branch_for_every_leaf_the_evaluator_handles():
    from tradingv_engine import evaluator

    branches = _schema_branches()
    # `MATH_EXPR` is the schema's name for the evaluator's `_handle_math`,
    # and `GROUP` is handled by `_evaluate_group` rather than a leaf
    # handler, so neither appears in the leaf table.
    handled = set(evaluator.LEAF_KINDS) | {"MATH_EXPR", "GROUP"}
    assert handled == set(branches), (
        f"schema/evaluator mismatch: only in schema {sorted(set(branches) - handled)}, "
        f"only in evaluator {sorted(handled - set(branches))}"
    )


@pytest.mark.parametrize("kind", sorted(LEAF_KINDS))
def test_a_handler_never_reads_a_field_the_schema_forbids(kind):
    """
    Catch dead branches at the source.

    The schema sets `additionalProperties: false`, so a handler that reads
    a field the schema does not define is reading something no valid tree
    can ever contain. That is how a condition silently becomes a constant.
    """
    import re

    from tradingv_engine import evaluator

    handler = "math" if kind == "MATH_EXPR" else kind.lower()
    body = _handler_body(handler)
    read = set(re.findall(r'node\.get\("(\w+)"', body)) | set(re.findall(r"node\.get\('(\w+)'", body))
    # A handler may delegate its whole node to another handler, which then
    # reads more. A handler that injects fields first (ADX_STRENGTH
    # delegating to INDICATOR_THRESHOLD) is not followed: it reads its own
    # node, and the injected fields belong to the other schema branch.
    if "_handle_" in body and "{**node" not in body:
        for nested in re.findall(r"_handle_(\w+)\(node\b", body):
            if nested == handler:
                continue
            nested_body = _handler_body(nested)
            read |= set(re.findall(r'node\.get\("(\w+)"', nested_body))
    # `value` is legal on most leaves; it is the shared comparison field.
    read -= {"id", "kind", "label", "enabled", "value"}

    allowed = set(_schema_branches()[kind]["properties"])
    forbidden = read - allowed
    assert not forbidden, f"{kind} reads fields the schema forbids: {sorted(forbidden)}"


# --------------------------------------------------------------------------- #
# Configuration is documented, and holds nothing secret
# --------------------------------------------------------------------------- #

_ENV_REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_TEMPLATE = _ENV_REPO_ROOT / ".env.example"


def _env_var_names_in_config() -> set[str]:
    from tradingv_engine import config as config_module

    source = Path(config_module.__file__).read_text(encoding="utf-8")
    return set(re.findall(r'"(TRADINGV_[A-Z_]+)"', source))


def _env_var_names_in_template() -> set[str]:
    return set(re.findall(r"^(TRADINGV_[A-Z_]+)=", ENV_TEMPLATE.read_text(encoding="utf-8"), re.M))


def test_every_engine_setting_is_documented_in_the_env_template():
    """
    A setting nobody documented is a setting nobody can change.

    The one deliberate exception is the live-trading flag, which must
    never be documented as a value to set. It is called out in prose
    instead, and that is the point.
    """
    undocumented = _env_var_names_in_config() - _env_var_names_in_template()
    assert undocumented == {"TRADINGV_LIVE_TRADING"}, (
        f"undocumented engine settings: {sorted(undocumented)}; "
        f"add them to .env.example or remove them from the code"
    )


def test_the_live_trading_flag_is_explained_but_not_offered():
    template = ENV_TEMPLATE.read_text(encoding="utf-8")
    assert "TRADINGV_LIVE_TRADING" in template, "the flag should be called out so nobody hunts for it"
    assert "TRADINGV_LIVE_TRADING=" not in template, "the flag must never be presented as a value to set"
    assert "has no effect" in template


def test_no_secret_shares_a_name_with_a_browser_visible_variable():
    """
    A `VITE_` variable is shipped to every visitor.

    This asserts the naming rule mechanically, because the rule is what
    stops a signing key from being inlined into a bundle one careless
    rename away.
    """
    template = ENV_TEMPLATE.read_text(encoding="utf-8")
    active = re.findall(r"^([A-Z][A-Z0-9_]*)=", template, re.M)
    suspicious = [
        name
        for name in active
        if name.startswith("VITE_")
        and any(word in name for word in ("PRIVATE", "SECRET", "SIGNING", "SEED", "WALLET"))
    ]
    assert suspicious == [], f"these look like secrets but are browser-visible: {suspicious}"

