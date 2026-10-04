"""The HTTP boundary between the web app and the condition engine.

The split is deliberate and one-directional:

* **The engine decides *when*.** It reads market data, evaluates condition
  trees, and emits an ``AI_WAKE`` event. That is all it does.
* **The app decides *what*.** On a wake it runs the existing policy, risk,
  and DEMO execution guard, and the AI proposes an action. The engine is
  never told what to trade, never holds a wallet, and never signs.

There is therefore no endpoint here that places, sizes, approves, or
cancels an order, and no endpoint that accepts a key. Adding one would
break the property the whole design rests on.
"""

from __future__ import annotations

import contextlib
import logging
import os
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import contract
from .catalogue import catalogue_json
from .config import DEFAULT_TIMEFRAME, EngineConfig, load_config
from .engine import ConditionEngine
from .evaluator import EvaluationContext, evaluate_tree
from .marketdata import HyperliquidMarketData, MarketDataError

API_VERSION = "1"

#: Browser origins allowed to call the engine. The engine holds no
#: credential, so the risk here is a website being able to make the
#: browser read market state - which it can do over the public Hyperliquid
#: API anyway. The list exists so a *local* process other than the app
#: cannot quietly drive it.
DEFAULT_ALLOWED_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")

#: Records the traceback for a failed request. The client gets a
#: correlation id; the detail stays on this side.
logger = logging.getLogger(__name__)


def allowed_origins() -> tuple[str, ...]:
    raw = os.environ.get("TRADINGV_ALLOWED_ORIGINS", "")
    configured = [item.strip() for item in raw.split(",") if item.strip()]
    return tuple(configured) if configured else DEFAULT_ALLOWED_ORIGINS


def cors_headers(origin: str | None) -> dict[str, str]:
    """
    CORS for the engine.

    Added because without it the condition preview can never test a
    condition: the browser refuses the cross-origin request, the engine
    looks unreachable, and the user is permanently told to start a server
    that is already running. An allowlist, never a wildcard, so an
    arbitrary website cannot drive the local engine.
    """
    if not origin or origin not in allowed_origins():
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #


class RegisterTrackerRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    goat_id: str = Field(min_length=1, max_length=64, alias="goatId")
    name: str = Field(min_length=1, max_length=120)
    #: The canonical condition tree from `shared/condition_schema_v1.json`.
    definition: dict[str, Any]
    version: int = 1

    model_config = {"populate_by_name": True}


class AccountSnapshot(BaseModel):
    equity: float | None = None
    balance: float | None = None
    free_margin: float | None = Field(default=None, alias="freeMargin")
    margin_used: float | None = Field(default=None, alias="marginUsed")
    daily_pnl: float | None = Field(default=None, alias="dailyPnL")
    exposure: float | None = None
    max_exposure_notional: float | None = Field(default=None, alias="maxExposureNotional")
    drawdown_percent: float | None = Field(default=None, alias="drawdownPercent")
    kill_switch_active: bool = Field(default=False, alias="killSwitchActive")
    risk_state: str = Field(default="NORMAL", alias="riskState")
    orders_last_minute: int = Field(default=0, alias="ordersLastMinute")

    model_config = {"populate_by_name": True}


class TestConditionRequest(BaseModel):
    """Evaluate a tree against a named committed fixture.

    Testing against a fixture rather than live data is what makes a
    tracker's behaviour reviewable: the same request always produces the
    same result, in CI and in the browser.
    """

    tree: dict[str, Any] | None = None
    context: str = "gold15mFlat"
    market: str = "xyz:GOLD"
    spread: float | None = 0.25


class LiveEvaluateRequest(BaseModel):
    """Evaluate a tree against the engine's current cached series."""

    tree: dict[str, Any]
    market: str
    now_ms: int | None = Field(default=None, alias="nowMs")

    model_config = {"populate_by_name": True}


class EvaluateResult(BaseModel):
    status: str
    summary: str
    conditions: list[dict[str, Any]]
    explanation: str = ""
    textures: list[dict[str, str]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


def create_app(
    engine: ConditionEngine | None = None,
    config: EngineConfig | None = None,
) -> FastAPI:
    resolved = config or (engine.config if engine else load_config())

    if engine is None:
        engine = ConditionEngine(
            config=resolved,
            market_data=HyperliquidMarketData(resolved),
        )

    app = FastAPI(
        title="TradingVibe condition engine",
        version=API_VERSION,
        description=(
            "Evaluates TradingVibe condition trees and emits AI_WAKE events. "
            "It has no execution capability of any kind."
        ),
    )
    app.state.engine = engine
    app.state.config = resolved

    @app.middleware("http")
    async def add_cors(request: "Request", call_next):
        # Preflight is answered before the route, so a POST with a JSON
        # content type reaches the engine at all.
        origin = request.headers.get("origin")
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=cors_headers(origin))
        try:
            response = await call_next(request)
        except Exception:
            # A 5xx raised inside a route is turned into a response by
            # Starlette's server-error middleware, which sits outside this
            # one. The error response therefore never reaches the header
            # merge below, and a browser reports a bare CORS failure with
            # no status, no body, and nothing to act on. That is how a
            # crashed market-discovery call looked like a misconfigured
            # engine to the person looking at it.
            #
            # The traceback is logged in full and the client gets a
            # correlation id to quote. The error is not swallowed: it is
            # made legible instead of invisible.
            identifier = uuid.uuid4().hex[:12]
            logger.exception("unhandled error serving %s %s [%s]", request.method, request.url.path, identifier)
            return JSONResponse(
                status_code=500,
                content={
                    "error": "INTERNAL_ERROR",
                    "message": "The engine could not complete this request.",
                    "correlationId": identifier,
                },
                headers=cors_headers(origin),
            )
        for key, value in cors_headers(origin).items():
            response.headers[key] = value
        return response

    # ----------------------------------------------------------- lifecycle

    @app.on_event("startup")
    async def _startup() -> None:
        await engine.start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await engine.stop()

    # -------------------------------------------------------------- health

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "apiVersion": API_VERSION,
            "schemaVersion": contract.SCHEMA_VERSION,
            "running": engine.running,
            # Said plainly, and enforced in code, not just documented.
            "liveTradingEnabled": False,
            "capabilities": {
                "evaluatesConditions": True,
                "emitsAiWake": True,
                "placesOrders": False,
                "signsTransactions": False,
                "holdsCredentials": False,
            },
        }

    # ------------------------------------------------------------- catalogue

    @app.get("/catalogue")
    async def catalogue() -> dict[str, Any]:
        return catalogue_json()

    @app.get("/schema")
    async def schema() -> dict[str, Any]:
        return contract.load_schema()

    @app.get("/timeframes")
    async def timeframes() -> dict[str, Any]:
        return {
            "default": DEFAULT_TIMEFRAME,
            "supported": list(contract.supported_timeframes()),
        }

    # ----------------------------------------------------------- instruments

    @app.get("/instruments")
    async def instruments(refresh: bool = Query(default=False)) -> dict[str, Any]:
        if refresh or not engine.instrument_json():
            try:
                await engine.load_instruments()
            except MarketDataError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
        payload = engine.instrument_json()
        return {
            "count": len(payload),
            "tradeable": sorted(symbol for symbol, item in payload.items() if item["availability"] == "TRADEABLE"),
            "instruments": payload,
        }

    # -------------------------------------------------------------- trackers

    @app.get("/trackers")
    async def list_trackers() -> dict[str, Any]:
        return {
            "trackers": [tracker.to_json() | {"definition": tracker.definition} for tracker in engine.trackers.values()]
        }

    @app.post("/trackers")
    async def register_tracker(request: RegisterTrackerRequest) -> dict[str, Any]:
        try:
            contract.validate_tree(request.definition)
        except contract.ContractError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        tracker = engine.register(request.model_dump(by_alias=True))
        return tracker.to_json()

    @app.delete("/trackers/{tracker_id}")
    async def delete_tracker(tracker_id: str) -> dict[str, Any]:
        if not engine.unregister(tracker_id):
            raise HTTPException(status_code=404, detail=f"No tracker {tracker_id!r}.")
        return {"deleted": tracker_id}

    @app.get("/trackers/{tracker_id}/status")
    async def tracker_status(tracker_id: str) -> dict[str, Any]:
        status = engine.tracker_status(tracker_id)
        if status is None:
            raise HTTPException(status_code=404, detail=f"No tracker {tracker_id!r}.")
        return status

    # ------------------------------------------------------------- evaluate

    @app.post("/trackers/{tracker_id}/evaluate")
    async def evaluate_tracker(tracker_id: str, now_ms: int | None = None) -> dict[str, Any]:
        tracker = engine.trackers.get(tracker_id)
        if tracker is None:
            raise HTTPException(status_code=404, detail=f"No tracker {tracker_id!r}.")
        return _evaluate(tracker.definition, engine.context_for(tracker, now_ms))

    @app.post("/test")
    async def test_condition(request: TestConditionRequest) -> dict[str, Any]:
        """Run a draft tree against a committed fixture.

        This is the endpoint the condition preview calls while the user
        is still editing, so it is scoped to fixtures: a half-finished tree
        can be checked without pointing the engine at a live market.
        """
        tree = request.tree
        if tree is None:
            raise HTTPException(status_code=422, detail="A condition tree is required.")
        try:
            contract.validate_tree(tree)
        except contract.ContractError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        try:
            context = engine.fixture_context(request.context)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        return _evaluate(tree, context)

    @app.get("/fixtures")
    async def fixtures() -> dict[str, Any]:
        """
        The contexts a tree can be tested against.

        Served so the builder offers the same list the engine can actually
        load, rather than a hardcoded copy that drifts.
        """
        return {
            "contexts": {
                name: engine.describe_fixture_context(name) for name in engine.fixture_context_names()
            }
        }

    @app.post("/evaluate")
    async def evaluate_live(request: LiveEvaluateRequest) -> dict[str, Any]:
        try:
            contract.validate_tree(request.tree)
        except contract.ContractError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        tracker = engine.trackers_for_market(request.market)
        if tracker is None:
            raise HTTPException(
                status_code=404,
                detail=f"No registered tracker watches {request.market!r}, so no data is being kept for it.",
            )
        return _evaluate(request.tree, engine.context_for(tracker, request.now_ms))

    # ---------------------------------------------------------------- events

    @app.get("/events")
    async def events(
        limit: int = Query(default=100, ge=1, le=1000),
        goat_id: str | None = Query(default=None, alias="goatId"),
        tracker_id: str | None = Query(default=None, alias="trackerId"),
    ) -> dict[str, Any]:
        return {
            "events": [
                event.to_json()
                for event in engine.log.recent(limit=limit, goat_id=goat_id, tracker_id=tracker_id)
            ]
        }

    @app.get("/wakes")
    async def wakes(limit: int = Query(default=20, ge=1, le=200)) -> dict[str, Any]:
        return {"wakes": engine.latest_wakes(limit)}

    @app.post("/wakes/{wake_id}/ack")
    async def acknowledge_wake(wake_id: str) -> dict[str, Any]:
        """Record that the app received a wake.

        The acknowledgement is the only thing that crosses back. The
        engine never learns what the app decided, because what the app
        decides is not its business.
        """
        if not engine.acknowledge_wake(wake_id):
            raise HTTPException(status_code=404, detail=f"No unacknowledged wake {wake_id!r}.")
        return {"acknowledged": wake_id}

    @app.get("/status")
    async def status() -> dict[str, Any]:
        return engine.status()

    return app


def _evaluate(tree: dict[str, Any], context: EvaluationContext) -> dict[str, Any]:
    result = evaluate_tree(tree, context)
    return EvaluateResult(
        status=result.status,
        summary=result.summary,
        conditions=[item.to_json() for item in result.flat()],
        explanation=_explain(tree),
        textures=contract.condition_textures(tree),
    ).model_dump()


def _explain(tree: dict[str, Any]) -> str:
    """A plain-English rendering of the whole tree, for the builder UI."""
    from .evaluator import explain

    return explain(tree.get("root") or tree)


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #


def main() -> None:  # pragma: no cover - process entrypoint
    import uvicorn

    config = load_config()
    app = create_app(config=config)
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    with contextlib.suppress(KeyboardInterrupt):
        main()
