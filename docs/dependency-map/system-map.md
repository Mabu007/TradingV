# System Map

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

The repository is a **four-part system** with one shared data contract.

```
TradingVibe
│
├── Shared Contract
│   ├── shared/condition_schema_v1.json     JSON Schema (v1) for condition trees
│   └── shared/condition_examples.json      20 canonical trees + expected results
│
├── Browser Application            src/          React 19 + Vite, single page
│   │
│   ├── Presentation
│   │   ├── App shell .............. src/App.tsx (2918 lines, 35 useState)
│   │   ├── Navigation ............. components/navigation/{BottomNav,MobileHeader}
│   │   ├── Views ................. components/views/*  (TradesTab, QuotesTab,
│   │   │                            BotsTab, HistoryTab, SettingsTab, + overlays)
│   │   ├── Trading surfaces ....... components/{chart,modals,terminal}
│   │   ├── Trigger surfaces ....... components/triggers/*
│   │   ├── Editor ................. components/editor/*
│   │   ├── AI surfaces ............ components/ai/FloatingAIAssistant
│   │   └── Layout ................. components/layout/*
│   │
│   ├── Application Services       src/services/
│   │   ├── MarketDataService ..... services/marketData.ts        (singleton)
│   │   ├── Wallet abstraction ..... services/wallet/*             (Privy boundary)
│   │   ├── Theme .................. services/theme/*              (provider + tokens)
│   │   ├── AI context ............. services/aiContext/*          (read-only projection)
│   │   ├── User profile ........... services/userService.ts       (localStorage)
│   │   └── Strategy catalogue ..... services/strategies.ts
│   │
│   ├── Agent Runtime              src/engine/agents/
│   │   ├── AgentRuntime .......... agents/runtime.ts             (the cycle)
│   │   ├── Capabilities .......... agents/capabilities/*         (31 tools)
│   │   ├── Policy ................. agents/policy/validator.ts   (18 checks)
│   │   ├── Skills ................ agents/skills/*
│   │   ├── Memory ................ agents/memory/memory.ts
│   │   ├── Timeline .............. agents/timeline/store.ts      (activity log)
│   │   ├── Model ................. agents/model/openrouter.ts
│   │   ├── Bot definitions ....... agents/botDefinition.ts
│   │   └── Environments .......... agents/environment/{demo,backtest,live}
│   │
│   ├── Trigger Engine             src/engine/agents/triggers/
│   │   ├── TriggerRegistry ....... registry.ts                   (register/validate)
│   │   ├── TriggerEngine ......... engine.ts                     (evaluate/fire/wake)
│   │   ├── Trigger evaluator ...... evaluator.ts                  (18-type switch)
│   │   ├── Condition tree ........ conditions.ts                  (in-browser, legacy)
│   │   └── Proximity ............. proximity.ts
│   │
│   ├── Deterministic Core         src/engine/
│   │   ├── Risk .................. execution/risk.ts             (RiskManager)
│   │   ├── Valuation ............. execution/valuation.ts        (FX, exposure, margin)
│   │   ├── Rejection vocabulary .. execution/errors.ts
│   │   ├── Indicators ............ indicators/index.ts           (7 indicator fns)
│   │   ├── Condition contract .... conditions/{contract,tree}.ts (local schema check)
│   │   ├── Engine HTTP client .... conditions/engineClient.ts     (:8099)
│   │   ├── Backtester ............ backtester/{simulator,historical}.ts
│   │   ├── Core plumbing ......... core/{execution,errors,logger,credentials}.ts
│   │   └── Strategy sandbox ...... sandbox/sandboxEnv.ts         (new Function)
│   │
│   ├── Adapters (external)        src/adapters/
│   │   ├── Hyperliquid market ... adapters/hyperliquid/marketData.ts  (REST + WS)
│   │   ├── Hyperliquid DEMO ..... adapters/hyperliquid/demo.ts       (fills, positions)
│   │   ├── Normalizer ........... adapters/hyperliquid/normalizer.ts
│   │   ├── OpenRouter AI ........ adapters/openrouter/provider.ts    (chat)
│   │   └── Provider contract .... adapters/marketData.ts
│   │
│   ├── Types                     src/types/     events.ts holds the EventBus
│   ├── Config                    src/config/env.ts
│   └── Utils                     src/utils/     orderSize, positionSize, csvExport
│
├── Condition Engine (Python)      server/tradingv_engine/
│   ├── HTTP boundary ............. api.py                 (FastAPI, 18 routes)
│   ├── Orchestrator .............. engine.py              (poll loop, wake queue)
│   ├── Monitor ................... monitor.py             (one tick)
│   ├── Evaluator ................. evaluator.py           (24 leaf kinds, 3-state)
│   ├── Catalogue ................ catalogue.py            (24 ConditionSpec)
│   ├── Contract ................. contract.py            (schema load + textures)
│   ├── Math expression .......... math_expr.py           (recursive-descent parser)
│   ├── Indicators ............... indicators/engine.py    (27 indicators)
│   ├── Patterns ................. patterns.py             (14 patterns)
│   ├── Price action ............. price_action.py         (26 measures)
│   ├── Market data .............. marketdata.py           (Hyperliquid /info)
│   ├── Store .................... store.py               (CandleStore, IndicatorCache)
│   ├── Edge detector ............ edge.py                 (cooldown, caps)
│   ├── Events ................... events.py              (EventLog singleton)
│   ├── Config ................... config.py              (env-driven EngineConfig)
│   ├── Series ................... series.py              (Series, ComputedSeries)
│   └── CLI ...................... __main__.py
│
├── Watcher Fleet (Workers)       watchers/
│   ├── HTTP router .............. src/index.ts            (routes, CORS, auth, buckets)
│   ├── Durable Object ........... src/durable-object.ts  (WatcherObject)
│   ├── Watcher state machine .... src/watcher.ts         (lifecycle, tick, health)
│   ├── Condition evaluator ...... src/evaluator.ts       (HTTP client → engine)
│   ├── Contract ................. src/contract.ts        (config validation, transitions)
│   ├── Wake queue ............... src/wake-queue.ts      (pending + terminal)
│   ├── Rate limit ............... src/rate-limit.ts       (fixed window)
│   ├── Health ................... src/health.ts           (8 checks)
│   └── IDs ...................... src/ids.ts              (FNV-1a digests)
│
└── Documentation                  docs/    (pre-existing, not authored by this pass)
```

---

## Subsystem Reference

### 1. Browser Application — `src/`

**Purpose as observed from code.** A single-page, mobile-first trading workspace. It
holds a live WebSocket market feed, renders a chart and an order ticket, and hosts an
in-browser agent runtime that can propose and (in DEMO) execute orders. All order flow
is bounded by a deterministic policy validator, a risk manager, and a size/execution
guard.

**Important files**
- `src/main.tsx:27` — the only React mount point.
- `src/App.tsx:2084` — the App component; owns 35 `useState` variables and 9 effects.
- `src/types/events.ts:75` — `eventBus`, the application's only pub/sub primitive.
- `src/engine/agents/runtime.ts:1781` — `agentRuntime` module singleton.
- `src/engine/execution/risk.ts:288` — `riskManager` module singleton.
- `src/adapters/hyperliquid/demo.ts` — the DEMO execution adapter (single source of
  truth for positions/balance in this app).

**Important symbols**
`App` (`App.tsx:2084`), `EventBus`/`eventBus` (`types/events.ts:29/75`),
`AgentRuntime` (`agents/runtime.ts:41`), `TriggerEngine` (`triggers/engine.ts`),
`TriggerRegistry` (`triggers/registry.ts:14`), `CapabilityRegistry`
(`capabilities/registry.ts:3`), `ActionValidator` (`policy/validator.ts:37`),
`RiskManager` (`execution/risk.ts:34`), `HyperliquidMarketDataAdapter`
(`adapters/hyperliquid/marketData.ts:34`), `HyperliquidDemoAdapter`
(`adapters/hyperliquid/demo.ts`), `OpenRouterProvider` (`adapters/openrouter/provider.ts:96`).

**Dependencies (out)**
- Hyperliquid REST + WebSocket (`adapters/hyperliquid/marketData.ts:54,180`).
- OpenRouter chat completions (`adapters/openrouter/provider.ts:194`).
- Privy SDK (only inside `services/wallet/WalletProvider.tsx`).
- Local Python condition engine at `http://127.0.0.1:8099`
  (`engine/conditions/engineClient.ts:129`) — reached only by
  `components/triggers/TriggerCard.tsx`, which is rendered by `BotBuilderModal`.

**Dependents (in)** — nothing outside `src/` imports browser code.

**Entry points** — `src/main.tsx:27`, `src/App.tsx:2084`.

**Outputs** — `eventBus` emissions; `Position`, `Trade`, `Order` objects held in
`hyperliquidDemoAdapter`; audit + timeline records.

**State it owns or mutates**
- React state: 35 variables in `App.tsx` (see [State Owners](state-owners.md#1-apptsx-react-state)).
- Engine singletons: `agentRuntime.instances`, `riskManager.limits`,
  `TriggerRegistry.triggers`, `appContextStore.state`.

**Major runtime relationships**

```
Hyperliquid WS ──emit MARKET_QUOTE/BAR_UPDATE──▶ eventBus
                                                      │
                     ┌────────────────────────────────┴───────────────────┐
                     ▼                                                    ▼
        App effects (:605,:714) → React state → UI        TriggerEngine.start() onAll
                     │                                                    │
                     │                                          process(input) → fire
                     │                                                    │
                     │                                          AgentRuntime.handleEvent
                     │                                                    │
                     │                                          step → model → capability
                     │                                                    │
                     │                                          policy → risk → env.placeMarketOrder
                     │                                                    │
                     └──────────── emit POSITION_OPEN/UPDATE/CLOSE ◀────────┘
                                                   │
                                            App effect (:793) → setPositions/…
```

---

### 2. Condition Engine (Python) — `server/tradingv_engine/`

**Purpose as observed from code.** A standalone FastAPI service that owns the
canonical implementation of condition-tree evaluation. It polls Hyperliquid candles on
an asyncio loop, evaluates registered trigger trees against a three-state model
(`TRUE` / `FALSE` / `UNKNOWN`), applies cooldown + rate caps, and enqueues wake events.
It has no signing path and refuses any non-loopback bind.

**Important files**
- `server/tradingv_engine/api.py:145` — `create_app()`, 18 HTTP routes.
- `server/tradingv_engine/engine.py:59` — `ConditionEngine`, the poll loop and wake queue.
- `server/tradingv_engine/monitor.py:125` — `MarketMonitor`, one tick.
- `server/tradingv_engine/evaluator.py:208` — `evaluate_tree`, 24 leaf handlers.
- `server/tradingv_engine/contract.py:74` — `validate_tree` against the shared schema.
- `server/tradingv_engine/events.py:107` — `event_log` singleton.
- `server/tradingv_engine/marketdata.py:117` — `HyperliquidMarketData`, the only
  network egress.

**Important symbols**
`ConditionEngine` (`engine.py:59`), `MarketMonitor` (`monitor.py:125`),
`evaluate_tree` (`evaluator.py:208`), `EdgeDetector` (`edge.py:120`),
`CandleStore` (`store.py:47`), `IndicatorCache` (`store.py:110`),
`MonitorContextBuilder` (`store.py:150`), `SPECS` (`catalogue.py:87`),
`INDICATORS` (`indicators/engine.py:464`), `FUNCTIONS` (`math_expr.py:157`).

**Dependencies (out)**
- `urllib.request` POST to `config.resolved_api_url()`
  (`marketdata.py:146`; default `https://api.hyperliquid.xyz/info`).
- `numpy`, `pandas`, `ta`, `jsonschema`, `fastapi`, `pydantic`, `uvicorn`.

**Dependents (in)**
- `watchers/src/evaluator.ts:66` POSTs `/evaluate` to `ENGINE_URL`.
- `src/engine/conditions/engineClient.ts:131` — a TS client for the same routes,
  used by the unmounted-by-default `TriggerCard` path.

**Entry points** — `python -m tradingv_engine` (`__main__.py:19`),
`uvicorn.run` (`__main__.py:90`), `create_app` (`api.py:145`).

**Outputs** — HTTP JSON; internal `EventLog`; wake deque.

**State it owns or mutates**
- `event_log` (`events.py:107`) — 2000-entry ring buffer.
- `ConditionEngine._queue` (`engine.py:87`) — `deque`, cap 200.
- `ConditionEngine._sequence` (`engine.py:88`) — monotonic wake id counter.
- Per-monitor: `CandleStore` entries (`monitor.py:145`), `IndicatorCache`
  (`monitor.py:147`), trigger list + `EdgeDetector` map (`monitor.py:148-149`),
  `wakes` list (`monitor.py:156`).

**Major runtime relationships**

```
asyncio Task (engine.py:268 _loop)
   ↓ await asyncio.to_thread(tick_once)   engine.py:279
ConditionEngine.tick_once                  engine.py:298
   ↓ MarketMonitor.tick                    monitor.py:319
      ├ refresh()   → CandleStore.get → HyperliquidMarketData.candles → urllib POST
      └ evaluate_all() → evaluate_tree → EdgeDetector.observe
                              ↓ Decision.FIRED
                       ConditionEngine._enqueue (engine.py:237)
```

---

### 3. Watcher Fleet (Cloudflare Workers) — `watchers/`

**Purpose as observed from code.** A durable, per-deployment watcher. Market events
arrive via an authenticated `POST /feed`, are fanned out by market index to the
matching watcher Durable Objects, and each watcher asks the Python engine whether its
condition tree is currently true. A true edge produces a `Wake` that an external agent
pulls over HTTP. No candle history is stored in the worker.

**Important files**
- `watchers/src/index.ts:79` — `default.fetch`, the whole HTTP surface.
- `watchers/src/durable-object.ts:69` — `WatcherObject` (3 KV keys).
- `watchers/src/watcher.ts:261` — `Watcher.tick`, the per-event state machine.
- `watchers/src/evaluator.ts:60` — `HttpConditionEvaluator.evaluate`.
- `watchers/src/wake-queue.ts:115` — `WakeQueue`.
- `watchers/src/contract.ts:303` — `shouldProcessEvent`.
- `watchers/src/ids.ts:24` — `digest`, the FNV-1a id derivation.

**Important symbols**
`WatcherObject` (`durable-object.ts:69`), `Watcher` (`watcher.ts`),
`HttpConditionEvaluator` (`evaluator.ts:36`), `WakeQueue` (`wake-queue.ts:115`),
`RateLimitObject` (`index.ts:396`), `UserRegistryObject` (`index.ts:358`),
`MarketIndexObject` (`index.ts:463`), `assessHealth` (`health.ts:98`),
`consume` (`rate-limit.ts:77`).

**Dependencies (out)**
- `fetch` to `ENGINE_URL` (`evaluator.ts:66`).
- Durable Object storage (`durable-object.ts:121-125`).
- Environment: `ENGINE_URL`, `ALLOWED_ORIGINS` (`wrangler.toml:23,25`),
  secrets `AUTH_TOKEN`, `MARKET_FEED_TOKEN` (names only).

**Dependents (in)** — an external market-feed producer and an external wake consumer.
Neither is implemented in this repository. **INFERRED** from
`POST /feed` and `GET /watchers/{id}/wakes` having no in-repo caller.

**Entry points** — `default.fetch` (`index.ts:79`), DO RPC methods
(`deploy`, `act`, `onMarketEvent`, `claimWakes`, `resolveWake`).

**Outputs** — `Wake` records in DO storage; HTTP responses; no pushes.

**State it owns or mutates**
- `WatcherObject`: `watcher:state`, `watcher:terminal-wakes`, `watcher:pending-wakes`
  (`durable-object.ts:37-39`).
- `UserRegistryObject`: `identities` (`index.ts:359`).
- `MarketIndexObject`: `identities` (`index.ts:464`).
- `RateLimitObject`: `window` (`index.ts:397`).

**Major runtime relationships**

```
POST /feed (index.ts:147)
   ↓ MarketIndexObject.list()          index.ts:211
   ↓ per identity → WatcherObject RPC  index.ts:193
WatcherObject.onMarketEvent           durable-object.ts:242
   ↓ Watcher.tick                      watcher.ts:261
      ├ shouldProcessEvent             contract.ts:303
      ├ queue.expire                   wake-queue.ts:291
      ├ HttpConditionEvaluator.evaluate  evaluator.ts:60
      │     ↓ HTTP POST {ENGINE_URL}/evaluate
      │        → server/tradingv_engine/api.py:344
      ├ latch / cap / cooldown         watcher.ts:342-390
      └ WakeQueue.enqueue              wake-queue.ts:171
   ↓ save()                            durable-object.ts:118
Agent pulls GET /watchers/{id}/wakes   index.ts:316
```

---

### 4. Shared Contract — `shared/`

**Purpose.** `condition_schema_v1.json` is the JSON Schema that both evaluators
validate against. `condition_examples.json` holds 20 canonical trees with expected
three-state results, consumed by the Python contract tests and the TypeScript parity
runner.

**Consumers (CONFIRMED)**
- `server/tradingv_engine/contract.py:34` — resolved as `<repo>/shared/condition_schema_v1.json`.
- `server/tests/test_contract.py:25-26`.
- `src/engine/conditions/conditionParity.ts` — reads the examples over the engine
  client (`test:conditions` script, `package.json:20`).

**Not a consumer (CONFIRMED)**
- `watchers/` — no import of either file anywhere in `watchers/src`
  (only a test-fixture path reference in `watchers/test/source-hygiene.test.ts:21`).
  The worker validates `conditionTree` for **size only** (`contract.ts:204-211`).
- `src/engine/agents/triggers/conditions.ts` — implements its own 9-kind catalogue
  (`conditions.ts:256-275`), not the 24-kind shared schema.

**Hand-copied bounds (CONFIRMED)** — `watchers/src/contract.ts:174-180` duplicates
`cooldownMs`, `maxWakesPerHour`, `maxWakesPerDay` from the schema, but uses
`minEvaluationIntervalMs {1_000, 3_600_000}` where the schema declares
`{0, 86_400_000}`.

---

## Cross-Subsystem Data Contracts

| Object | Produced by | Consumed by | Shape anchor |
| --- | --- | --- | --- |
| `Quote` | `src/adapters/hyperliquid/marketData.ts:192` | App state, `QuotesTab`, `TradingChart`, capabilities | `src/types/trading.ts` |
| `Bar` | `fromHyperliquidCandle` `normalizer.ts:31` | chart, capabilities, trigger engine | `src/types/trading.ts` |
| `Position` | `demo.ts` (adapter) | `eventBus` `POSITION_*`, App, `TradesTab` | `src/types/trading.ts` |
| `Trade` | adapter on close | `POSITION_CLOSE` payload, `HistoryTab` | `src/types/trading.ts` |
| `ConditionTree` | `TriggerBuilder`, `BotBuilderModal` | in-browser evaluator **and** `/evaluate` | `shared/condition_schema_v1.json` |
| `EvaluateResult` | `server/.../api.py:396-404` | `watchers/src/evaluator.ts:78-89` | `api.py:132-137` |
| `MarketEvent` | external feed producer | `watchers/src/contract.ts:263-276` | — |
| `Wake` | `buildWake` `wake-queue.ts:328-355` | external agent consumer | `wake-queue.ts:61-80` |
| `AgentDecision` | LLM via `agentModel.run` | policy → risk → execution | `agents/types.ts:161-194` |
