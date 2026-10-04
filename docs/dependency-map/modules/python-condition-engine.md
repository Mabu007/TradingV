# Module 15 — Python Condition Engine

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `server/tradingv_engine/` (20 modules, 6 201 production LOC)

**Purpose:** the canonical three-state condition-tree evaluator. It polls Hyperliquid
candles on an asyncio loop, evaluates registered trigger trees, applies cooldown and
rate caps, and enqueues wake events over a bounded deque. FastAPI exposes 17 HTTP
routes. It binds to loopback only and has no signing path.

---

## Contains

| Module | Lines | Purpose |
| --- | --- | --- |
| `__init__.py` | 70 | lazy re-exports via `__getattr__` `:38`; avoids importing numpy at import time |
| `__main__.py` | 101 | `main()` `:19`; the console script `tradingv_engine.__main__:main` (`pyproject.toml:45`) |
| `api.py` | 429 | `create_app()` `:145`; 17 routes `:216-389`; CORS `:168-202`; lifespan `:206-212` |
| `engine.py` | 409 | `ConditionEngine` `:59`; the poll loop `:268`; the wake deque |
| `monitor.py` | 492 | `MarketMonitor` `:125`; one tick; `TriggerSpec` `:33`; `WakeEvent` `:90` |
| `evaluator.py` | 1207 | `evaluate_tree` `:208`; 24 leaf handlers `_LEAF_HANDLERS` `:1058-1083`; `Status` enum `:51-54` |
| `catalogue.py` | 516 | 24 `ConditionSpec` `SPECS` `:87-428`; `spec_for` `:433`; `indicators_required` `:437` |
| `contract.py` | 177 | `load_schema` `:43` (`lru_cache`); `validate_tree` `:74`; `condition_textures` `:126` |
| `math_expr.py` | 476 | a bounded recursive-descent expression parser; **no** `eval`/`exec`/`compile` |
| `indicators/engine.py` | 568 | 27 indicators in `INDICATORS` `:464-492`; `compute` `:515` |
| `patterns.py` | 378 | 14 patterns `PATTERNS` `:56-71`; `evaluate` `:137` |
| `price_action.py` | 271 | 26 measures `MEASURES` `:19-46`; `compute` `:111` |
| `marketdata.py` | 346 | `HyperliquidMarketData` `:117`; the only egress |
| `store.py` | 240 | `CandleStore` `:47`; `IndicatorCache` `:110`; `MonitorContextBuilder` `:150` |
| `edge.py` | 264 | `EdgeDetector` `:120`; `WakePolicy` `:43`; `EdgeState` `:73`; `Decision` `:34` |
| `events.py` | 107 | `EventLog` `:55`; `event_log` singleton `:107` |
| `config.py` | 161 | `EngineConfig` `:70`; `load_config` `:111`; `assert_local_only` `:144` |
| `series.py` | 185 | `Series` `:40`; `ComputedSeries` `:126`; `Validity` `:26` |
| `indicators/__init__.py` | 12 | re-exports `INDICATORS`, `compute`, `required_history` |

Tests: `server/tests/` — 10 files plus 6 JSON fixtures and `conftest.py`.

---

## API surface — `api.py`

**Framework** FastAPI `api.py:24` + pydantic `:26` + uvicorn `__main__.py:86`.
`app.state.engine = engine` `:165`; `app.state.config = resolved` `:166`.
No `lifespan` context manager; both hooks use `@app.on_event` `:206`, `:210`.
CORS is hand-rolled (`add_cors` `:169`, `cors_headers` `:55-73`), not
`starlette.middleware.cors.CORSMiddleware`. The error boundary is a bare
`except Exception` with a `uuid4().hex[:12]` correlation id `:175-199`.

**Request/response models**

| Model | Line |
| --- | --- |
| `RegisterTriggerRequest` | `:81-89` (alias `botId` `:83`, `populate_by_name` `:89`) |
| `AccountSnapshot` | `:92-105` — **never referenced** |
| `TestConditionRequest` | `:108-120` |
| `LiveEvaluateRequest` | `:122-129` (alias `nowMs` `:127`) |
| `EvaluateResult` | `:132-137` |

**No route declares `response_model=`**; every handler returns `dict[str, Any]`, and
`EvaluateResult` is built and `.model_dump()`ed manually at `api.py:398-404`.

**Routes** — 17, listed in full in [Entry Points §4](../entry-points.md).

The two routes another in-repo process actually calls:
`POST /evaluate` (`watchers/src/evaluator.ts:66`) and `POST /test` + `GET /health` +
`GET /fixtures` + `GET /instruments` (`src/components/triggers/TriggerCard.tsx:116, 121, 135`).

---

## Data flow

```
asyncio Task (engine.py:268 _loop)
   ↓ await asyncio.to_thread(tick_once)                    engine.py:279
ConditionEngine.tick_once                                   engine.py:298
   ↓ MarketMonitor.tick                                     monitor.py:319
      ├ refresh()                                           monitor.py:254
      │    └ CandleStore.get → _fetch → HyperliquidMarketData.candles
      │        → _transport → _http_post → urllib.urlopen   marketdata.py:137-149
      │    └ cache.invalidate on success                    monitor.py:272
      └ evaluate_all()                                      monitor.py:282
           └ MonitorContextBuilder.for_symbol                store.py:168
           └ evaluate_tree                                  evaluator.py:208
           └ EdgeDetector.observe                           edge.py:134
                ↓ Decision.FIRED
           ConditionEngine._enqueue (deque, cap 200)         engine.py:237
```

Full step detail in [chains/python-engine-tick.md](../chains/python-engine-tick.md).

---

## State

| Object | Defined at | Written by | Read by | Reset |
| --- | --- | --- | --- | --- |
| `event_log` (2000 cap) | `events.py:107` | `record` `:68`, `emit` `:74` | `recent` `:82`, `for_bot` `:99`; `api.py:369` | never |
| `load_schema` memo | `contract.py:43` | first call | `schema_errors` `:54`; `api.py:242` | never |
| `_validator` memo | `contract.py:49` | first call | `schema_errors` `:66` | never |
| `ConditionEngine._queue` | `engine.py:87` | `_enqueue` `:237-246` | `pending_wakes` `:218` | `acknowledge_wake` `:221-235` |
| `_sequence` | `engine.py:88` | `_enqueue` `:243` | wake id | never |
| `_stopping` | `engine.py:90` | `start` `:251`, `stop` `:259` | `_loop` `:270`, sleep `:286` | `start` |
| `_wake_listeners` | `engine.py:91` | `on_wake` `:214-216` | `_enqueue` `:244` | never |
| `_fixture_contexts` | `engine.py:92` | `_load_fixture_contexts` `:346-409` | `fixture_context` `:181` | never |
| `MonitorMonitor.store` | `monitor.py:145` | `CandleStore.get` `store.py:87` | `entry_for` `store.py:100` | `seed` `store.py:90`; no eviction |
| `Monitor.cache` | `monitor.py:147` | `get_or_compute` `store.py:117-132` | `invalidate` `store.py:134-137` | invalidate on every successful refresh |
| `triggers` / `detectors` | `monitor.py:148-149` | `register` `:172/:175` | `evaluate_all` `:282` | `unregister` `:178/:180` |
| `EdgeState` | `edge.py:73-88` | `observe` `:165-236` | `snapshot` `:253` | `prune` `:86-88` (>24 h) |

**Note (CONFIRMED)** — an `UNKNOWN` result does not update `EdgeState.last_status`
(`edge.py:167-177`), so the latch is only re-based on a definite TRUE or FALSE.

---

## Events

`EventLog` is **query-based, not subscribed**. `EventType` — 15 members, `events.py:20-35`.
`EngineEvent` fields `events.py:38-47`; `to_json()` drops `None`/`{}`/`""` `:49-52`.
`MarketMonitor` holds the shared log at `monitor.py:143`; `ConditionEngine` aliases it
at `engine.py:86`. Exposed as `GET /events` — `api.py:360-370`.

`on_wake(listener)` — `engine.py:214-216`, invoked from `_enqueue` `engine.py:244` —
has **no in-repo subscriber**.

---

## Expression evaluation — `math_expr.py`

A bounded recursive-descent parser plus an AST interpreter. No `eval`, `exec`, or
`compile` anywhere in the module.

| Limit | Line |
| --- | --- |
| `MAX_EXPRESSION_LENGTH = 400` | `:35` |
| `MAX_AST_NODES = 64` | `:36` |
| `MAX_DEPTH = 12` | `:37` |
| `ALLOWED_FIELDS` (8) | `:40` |
| `ALLOWED_INDICATORS` (24) | `:43-51` |
| `INDICATOR_SYMBOLS` (34 surface→canonical) | `:54-64` |
| `ALLOWED_NODES` | `:153` |
| `FUNCTIONS` (8) | `:157-166` |
| `ALLOWED_FUNCTIONS` | `:168` |
| `ExpressionError` | `:67` |
| `_TOKEN_RE` | `:75-83` |

Invoked from `evaluator.py:44` (module import), `:778` (`referenced_indicators`),
`:1168` (`describe`), and `catalogue.py:478`.

---

## External dependencies

| Package | Used by |
| --- | --- |
| `fastapi` | `api.py:24` |
| `uvicorn` | `__main__.py:86`, `api.py:424` |
| `pydantic` | `api.py:26` |
| `numpy` | `series.py:20`, `indicators/engine.py:23`, `evaluator.py:41`, `patterns.py:50`, `price_action.py:14`, `marketdata.py:26` |
| `pandas` | `indicators/engine.py:510` (local), `price_action.py:229, 235, 241, 247` (local), `series.py:21` |
| `ta` | `indicators/engine.py:24` — `ta.trend.{EMA,MACD,ADX,PSAR}`, `ta.momentum.{RSI,StochasticOscillator,WilliamsR,ROC}`, `ta.volatility.{AverageTrueRange,BollingerBands}` |
| `jsonschema` | `contract.py:27` — `Draft202012Validator` |
| `pytest` | test-only |

**Network egress is stdlib-only** — `urllib.request` `marketdata.py:19, 146`.
No `requests`, `httpx`, or `aiohttp`.

**Env vars** — read at `EngineConfig` construction `config.py:70-108`:
`TRADINGV_NETWORK`, `TRADINGV_HYPERLIQUID_API`, `TRADINGV_HTTP_TIMEOUT`,
`TRADINGV_POLL_INTERVAL`, `TRADINGV_HISTORY`, `TRADINGV_ENGINE_HOST`,
`TRADINGV_ENGINE_PORT`, `TRADINGV_LIVE_TRADING`, plus
`TRADINGV_HYPERLIQUID_API_TESTNET` at call time `config.py:104-107`,
`TRADINGV_ENGINE_ALLOW_PUBLIC` `config.py:153`, and
`TRADINGV_ALLOWED_ORIGINS` `api.py:50`.

**Files read** — `shared/condition_schema_v1.json` `contract.py:34`;
`server/tests/fixtures/{name}.json` `engine.py:359`.

---

## Depends on

`shared/condition_schema_v1.json` (JSON, at import-time of `load_schema`) ·
`watchers/` **inbound only** — the worker calls this service; there is no import edge
in the other direction.

## Used by

| Consumer | Mechanism |
| --- | --- |
| `watchers/src/evaluator.ts:66` | `POST {ENGINE_URL}/evaluate` |
| `src/engine/conditions/engineClient.ts:131` | `fetch` to `127.0.0.1:8099` — from `TriggerCard` |
| 10 pytest files | direct import |

## Entry points

`main()` `__main__.py:19` · `create_app()` `api.py:145` · `uvicorn.run` `__main__.py:90` ·
`ConditionEngine._loop` `engine.py:268` · 17 HTTP routes `api.py:216-389`.

## Exit points

- 17 HTTP responses.
- `EventLog` → `GET /events`.
- `pending_wakes()` → `GET /wakes`; `acknowledge_wake` → `POST /wakes/{id}/ack`.
- `on_wake(listener)` callbacks.
- The single network egress: `urllib` to the Hyperliquid `/info` endpoint.

---

## Notable observations (factual)

- **Three independent indicator implementations exist**: Python
  `indicators/engine.py` (27), browser `src/engine/indicators/index.ts` (7), and the
  capability-level recomputation in `capabilities/indicators.ts`.
- **The evaluator bypasses the `IndicatorCache`** — every leaf handler calls
  `indicator_module.compute(...)` directly (`evaluator.py:421, 487, 552, 574, 600-608,
  627-628, 644-648, 807, 815`); the cache is only invalidated wholesale by
  `monitor.py:272`.
- **Pattern results are length-1 arrays** — `patterns.py:121`, `:131`; patterns are
  evaluated on the last bar only.
- **`price_action.compute` accepts `count` but never uses it** (`price_action.py:111`,
  only `period` at `:124, 183, 186, 189, 192`).
- **Unused symbols** — `WILDCARD_HOSTS` `config.py:133`; `is_finite_number`
  `contract.py:81-82`; `Series.frame()` `series.py:89-100`; `required_history`
  `indicators/engine.py:561`; `MarketMonitor.instrument()` `monitor.py:216-217`;
  `as_float_array`/`last_finite`/`finite_count` `series.py:166-185`;
  `AccountSnapshot` `api.py:92-105`; `ContractError` imported but unused
  `__main__.py:16`.
- **`README.md` in `server/` lists 14 routes; the code declares 17** — `GET /triggers`
  and `POST /triggers/{id}/evaluate` are omitted from the README table.
