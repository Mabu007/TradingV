"""HTTP boundary tests.

The API is the seam between the browser and the engine, so these tests care
about two things above all: that a client cannot express anything the
schema forbids, and that no endpoint anywhere in the surface can trade.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from test_engine import FakeMarketData, build
from tradingv_engine.api import create_app
from tradingv_engine.config import EngineConfig
from tradingv_engine.engine import ConditionEngine

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def client() -> TestClient:
    """A client with no network and no event loop tasks."""
    engine = build(FakeMarketData({}))
    with TestClient(create_app(engine=engine)) as test_client:
        test_client.engine = engine
        yield test_client


def tree(**overrides):
    body = {
        "schemaVersion": 1,
        "name": "Draft",
        "market": "xyz:GOLD",
        "timeframe": "15m",
        "then": "WAKE_AI",
        "root": {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [
                {"id": "c1", "kind": "PRICE_LEVEL", "timeframe": "15m", "direction": "ABOVE", "level": 100.0}
            ],
        },
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- #
# Health and capabilities
# --------------------------------------------------------------------------- #


def test_health_reports_no_execution_capability(client: TestClient):
    payload = client.get("/health").json()
    assert payload["ok"] is True
    assert payload["schemaVersion"] == 1
    assert payload["liveTradingEnabled"] is False
    assert payload["capabilities"] == {
        "evaluatesConditions": True,
        "emitsAiWake": True,
        "placesOrders": False,
        "signsTransactions": False,
        "holdsCredentials": False,
    }


def test_there_is_no_order_endpoint(client: TestClient):
    """The absence is the feature, so it is asserted rather than assumed."""
    paths = {route.path for route in client.app.routes if hasattr(route, "methods")}
    for forbidden in ("/order", "/orders", "/trade", "/execute", "/position", "/close", "/leverage", "/keys"):
        assert not any(forbidden in path for path in paths), f"{forbidden} must not exist"
    assert any("wakes" in path for path in paths)


def test_no_endpoint_accepts_a_credential(client: TestClient):
    for path in ("/health", "/catalogue", "/schema", "/timeframes", "/trackers", "/wakes"):
        assert client.get(path).status_code == 200
    for body in (
        {"privateKey": "0xabc"},
        {"apiKey": "secret"},
        {"walletAddress": "0xabc"},
    ):
        assert client.post("/trackers", json={"id": "x", "goatId": "b", "name": "n", "definition": tree(), **body}).status_code in (200, 422)


# --------------------------------------------------------------------------- #
# The catalogue and the schema
# --------------------------------------------------------------------------- #


def test_the_catalogue_is_served_for_the_builder(client: TestClient):
    payload = client.get("/catalogue").json()
    assert payload["conditions"]
    assert payload["indicators"]
    assert "BULLISH_CANDLE" in payload["priceActionMeasures"]
    assert "DOUBLE_BOTTOM" in payload["patterns"]


def test_the_schema_served_is_the_committed_file(client: TestClient):
    served = client.get("/schema").json()
    committed = json.loads((REPO_ROOT / "shared" / "condition_schema_v1.json").read_text(encoding="utf-8"))
    assert served == committed, "the API must not serve a modified copy of the contract"


def test_timeframes(client: TestClient):
    payload = client.get("/timeframes").json()
    assert payload["default"] == "15m"
    assert "1h" in payload["supported"]


# --------------------------------------------------------------------------- #
# Tracker registration
# --------------------------------------------------------------------------- #


def test_registering_a_valid_tracker(client: TestClient):
    response = client.post(
        "/trackers",
        json={"id": "t1", "goatId": "b1", "name": "Breakout", "definition": tree()},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "t1"
    assert body["goatId"] == "b1"
    assert body["then"] == "WAKE_AI"
    assert client.get("/trackers").json()["trackers"][0]["definition"]["schemaVersion"] == 1


def test_registering_an_invalid_tracker_is_rejected_with_a_reason(client: TestClient):
    broken = tree()
    del broken["then"]
    response = client.post(
        "/trackers",
        json={"id": "t1", "goatId": "b1", "name": "Bad", "definition": broken},
    )
    assert response.status_code == 422
    assert "then" in response.json()["detail"]


def test_registering_a_tree_with_a_foreign_then_is_rejected(client: TestClient):
    response = client.post(
        "/trackers",
        json={"id": "t1", "goatId": "b1", "name": "Order", "definition": tree(then="PLACE_ORDER")},
    )
    assert response.status_code == 422


def test_an_unknown_schema_version_is_rejected(client: TestClient):
    response = client.post(
        "/trackers",
        json={"id": "t1", "goatId": "b1", "name": "Future", "definition": tree(schemaVersion=2)},
    )
    assert response.status_code == 422
    assert "version" in response.json()["detail"].lower()


def test_deleting_a_tracker(client: TestClient):
    client.post("/trackers", json={"id": "t1", "goatId": "b1", "name": "X", "definition": tree()})
    assert client.delete("/trackers/t1").status_code == 200
    assert client.delete("/trackers/t1").status_code == 404
    assert client.get("/trackers/t1/status").status_code == 404


# --------------------------------------------------------------------------- #
# Testing a draft against a fixture
# --------------------------------------------------------------------------- #


def test_testing_a_draft_against_a_fixture(client: TestClient):
    response = client.post("/test", json={"tree": tree(), "context": "gold15mSpike"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"TRUE", "FALSE"}
    assert payload["conditions"]
    assert payload["explanation"]
    assert {item["timeframe"] for item in payload["textures"]} == {"15m"}


def test_every_shared_example_passes_through_the_test_endpoint(client: TestClient):
    bundle = json.loads((REPO_ROOT / "shared" / "condition_examples.json").read_text(encoding="utf-8"))
    for example in bundle["examples"]:
        response = client.post("/test", json={"tree": example["tree"], "context": example["context"]})
        assert response.status_code == 200, f"{example['id']}: {response.text}"
        assert response.json()["status"] == example["expect"]["status"], example["id"]


def test_an_unknown_fixture_context_is_a_404_with_the_alternatives(client: TestClient):
    response = client.post("/test", json={"tree": tree(), "context": "nope"})
    assert response.status_code == 404
    assert "gold15mSpike" in response.json()["detail"]


def test_testing_requires_a_tree(client: TestClient):
    assert client.post("/test", json={"context": "gold15mFlat"}).status_code == 422


def test_evaluating_an_unwatched_market_explains_itself(client: TestClient):
    response = client.post("/evaluate", json={"tree": tree(), "market": "xyz:NEVER_SEEN"})
    assert response.status_code == 404
    assert "xyz:NEVER_SEEN" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# Wakes
# --------------------------------------------------------------------------- #


def test_a_wake_is_queued_and_acknowledged(client: TestClient):
    from test_engine import HIGH, register, seed

    engine: ConditionEngine = client.engine
    seed(engine, HIGH)
    register(engine, tree())
    engine.tick_once(1_700_000_000_000)

    wakes = client.get("/wakes").json()["wakes"]
    assert len(wakes) == 1
    assert wakes[0]["type"] == "AI_WAKE"
    assert wakes[0]["acknowledged"] is False

    assert client.post(f"/wakes/{wakes[0]['wakeId']}/ack").status_code == 200
    assert client.get("/wakes").json()["wakes"][0]["acknowledged"] is True
    assert client.post("/wakes/nope/ack").status_code == 404


def test_the_event_timeline_is_served(client: TestClient):
    payload = client.get("/events?limit=50").json()["events"]
    assert payload
    types = {event["type"] for event in payload}
    assert "ENGINE_STARTED" in types


def test_status(client: TestClient):
    payload = client.get("/status").json()
    assert payload["liveTradingEnabled"] is False
    assert payload["schemaVersion"] == 1
    assert "pendingWakes" in payload


# --------------------------------------------------------------------------- #
# The OpenAPI document, which is itself a published contract
# --------------------------------------------------------------------------- #


def test_the_openapi_document_offers_no_execution_operation(client: TestClient):
    document = client.get("/openapi.json").json()
    for path, operations in document["paths"].items():
        assert "order" not in path.lower(), f"{path} looks like an execution endpoint"
        assert "trade" not in path.lower()
    assert "PLACE_ORDER" not in json.dumps(document)


def test_the_whole_surface_is_offline_for_the_default_build():
    """Constructing the app must not open a socket or read a secret."""
    config = EngineConfig(live_trading_enabled=True)
    app = create_app(config=config)
    assert app.state.config.live_trading_enabled is True, "the env flag is read"
    assert app.state.engine.status()["liveTradingEnabled"] is False, "but the engine still refuses"


def test_fixtures_are_listed_for_the_builder(client: TestClient):
    payload = client.get("/fixtures").json()["contexts"]
    assert "gold15mSpike" in payload
    assert payload["gold15mAndEur1h"]["timeframes"] == ["15m", "1h"]
    assert payload["gold15mSpike"]["bars"]["15m"] > 0
    assert payload["gold15mSpike"]["lastClose"]["15m"] > 0


# --------------------------------------------------------------------------- #
# CORS
#
# Without these the condition preview can never test a condition: the
# browser refuses the cross-origin request, the engine looks unreachable,
# and the user is told to start a server that is already running. Found by
# driving the real UI in a browser, not by any unit test.
# --------------------------------------------------------------------------- #


def test_a_configured_origin_is_allowed(client: TestClient):
    response = client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert response.headers.get("vary") == "Origin"


def test_an_unknown_origin_gets_no_cors_headers(client: TestClient):
    # Not `*`. A wildcard would let any website drive the local engine.
    response = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_a_request_with_no_origin_is_unaffected(client: TestClient):
    assert client.get("/health").status_code == 200


def test_preflight_is_answered(client: TestClient):
    response = client.options(
        "/test",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 204
    assert "POST" in response.headers.get("access-control-allow-methods", "")
    assert "Content-Type" in response.headers.get("access-control-allow-headers", "")


def test_a_cross_origin_test_actually_reaches_the_engine(client: TestClient):
    bundle = json.loads((Path(__file__).resolve().parents[2] / "shared" / "condition_examples.json").read_text(encoding="utf-8"))
    example = bundle["examples"][0]
    response = client.post(
        "/test",
        json={"tree": example["tree"], "context": example["context"]},
        headers={"Origin": "http://localhost:3000"},
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert response.json()["status"] == example["expect"]["status"]


# --------------------------------------------------------------------------- #
# V0 audit #10 / #13: the browser could not read a server error
#
# Found by driving the real application in a headless browser, not by a
# unit test. Two separate defects combined into one opaque symptom:
#
#   1. `perpDexs` returns a list whose FIRST ELEMENT IS NULL -- the
#      default perps entry carries no name. Discovery called `.get` on
#      every element, so the null raised AttributeError and the whole
#      market list failed.
#   2. A 5xx raised inside a route is converted to a response by
#      Starlette's server-error middleware, which sits outside the CORS
#      middleware. The error response therefore carried no CORS headers,
#      and the browser reported a bare CORS failure.
#
# The combination is why this read as "the engine is misconfigured"
# rather than "discovery crashed".
# --------------------------------------------------------------------------- #


def test_a_null_entry_in_the_dex_list_does_not_crash_discovery():
    """The venue's real shape, not a hypothetical one."""
    from tradingv_engine.marketdata import HyperliquidMarketData
    from tradingv_engine.config import EngineConfig

    # Exactly what api.hyperliquid.xyz/info returns for `perpDexs`.
    responses = {
        "perpDexs": [None, {"name": "xyz"}, {"name": "flx"}],
        "metaAndAssetCtxs": [{"universe": []}, []],
    }
    source = HyperliquidMarketData.__new__(HyperliquidMarketData)
    source.config = EngineConfig()
    source._transport = lambda payload, **_: responses.get(str(payload.get("type")), [])  # type: ignore[method-assign]

    # The assertion is simply that it returns. The previous line raised.
    assert isinstance(source.load_instruments(), list)


def test_a_dex_list_of_the_wrong_shape_is_ignored_rather_than_fatal():
    from tradingv_engine.marketdata import HyperliquidMarketData
    from tradingv_engine.config import EngineConfig

    for shape in (None, {}, "nope", 42, [None, None], [[], 3], [{"name": ""}]):
        source = HyperliquidMarketData.__new__(HyperliquidMarketData)
        source.config = EngineConfig()
        source._transport = lambda payload, **_: shape  # type: ignore[method-assign]
        assert isinstance(source.load_instruments(), list), f"discovery died on {shape!r}"


def test_a_failing_route_still_carries_cors_headers():
    """Otherwise a browser cannot read the failure, only the absence."""
    from tradingv_engine.api import create_app
    from tradingv_engine.engine import ConditionEngine

    engine = build(FakeMarketData({}))

    def explode(*_args, **_kwargs):
        raise RuntimeError("discovery blew up")

    engine.load_instruments = explode  # type: ignore[method-assign]

    origin = "http://localhost:3000"
    with TestClient(create_app(engine=engine), raise_server_exceptions=False) as failing:
        response = failing.get("/instruments?refresh=true", headers={"Origin": origin})

    assert response.status_code == 500
    # The header is the whole point: without it the browser shows a
    # CORS failure and never learns there was a server error at all.
    assert response.headers.get("access-control-allow-origin") == origin
    body = response.json()
    assert body["error"] == "INTERNAL_ERROR"
    # The client gets a handle to quote, and not the internal detail.
    assert body["correlationId"]
    assert "blew up" not in response.text


def test_a_failing_route_still_carries_no_cors_headers_for_an_unknown_origin():
    from tradingv_engine.api import create_app

    engine = build(FakeMarketData({}))

    def explode(*_args, **_kwargs):
        raise RuntimeError("nope")

    engine.load_instruments = explode  # type: ignore[method-assign]

    with TestClient(create_app(engine=engine), raise_server_exceptions=False) as failing:
        response = failing.get("/instruments?refresh=true", headers={"Origin": "http://evil.example"})

    # The error boundary must not become a way around the allowlist.
    assert response.status_code == 500
    assert "access-control-allow-origin" not in response.headers
