# Application Dependency Map

> **Historical snapshot — not the current architecture.**
>
> This directory was generated against the pre-GOAT application, in which
> a *bot* definition carried a list of hand-authored *triggers*. Both of
> those architectures have since been deleted. The symbol names here
> (`BotDefinition`, `AgentTrigger`, `TriggerEngine`, `TriggerRegistry`,
> `registerBotTriggers`, `/triggers`, …) are how the code was named at the
> time of the snapshot, and they are kept verbatim rather than rewritten,
> because a half-renamed map of a deleted architecture is harder to read
> than an honestly dated one.
>
> For the architecture that exists today, read
> [architecture.md](../architecture.md), [goat.md](../goat.md) and
> [trackers.md](../trackers.md). The current Tracker equivalents are:
> `BotDefinition` → `GoatDefinition`, `AgentTrigger` → `Tracker`,
> `TriggerEngine` → `TrackerRuntime`, `TriggerRegistry` →
> `TrackerRegistry`, `evaluateTrigger` → `evaluateTracker`, and
> `POST /triggers` → `POST /trackers`.

TradingVibe — a browser trading workspace (`src/`), a Python condition engine
(`server/tradingv_engine/`), a Cloudflare Workers watcher fleet (`watchers/`), and a
shared condition schema (`shared/`).

This directory documents the repository **as it existed when the map was
generated**. It is not a review.

---

## Start Here

1. [System Map](system-map.md) — the four subsystems and how they connect
2. [Module Map](module-map.md) — logical modules with depends-on / used-by edges
3. [Runtime Chains](runtime-chains.md) — end-to-end execution flows
4. [Call Graph](call-graph.md) — function-level forward calls
5. [Mutation Map](mutation-map.md) — where state changes and who consumes it
6. [Data Flow](data-flow.md) — how important objects travel and are transformed
7. [Event Flow](event-flow.md) — every emitter, listener and payload
8. [Reverse Dependencies](reverse-dependencies.md) — "who depends on this?"
9. [Entry Points](entry-points.md) — where execution enters the system
10. [External Dependencies](external-dependencies.md) — packages, APIs, env vars

Supporting documents:

- [State Owners](state-owners.md) — every state container, its writers and readers
- [Registries & Factories](registries-and-factories.md) — indirect-dependency mechanisms
- [Coverage](coverage.md) — what was mapped and what was not

---

## Major Systems

| System | Root | Runtime | Purpose |
| --- | --- | --- | --- |
| **Browser App** | `src/` | Browser (React 19 + Vite) | UI, agent runtime, tracker runtime, Hyperliquid DEMO adapter |
| **Condition Engine** | `server/tradingv_engine/` | Python 3.12 (FastAPI + uvicorn) | Canonical condition-tree evaluation, indicators, patterns, wake edge detection |
| **Watcher Fleet** | `watchers/` | Cloudflare Workers (Durable Objects) | Per-deployment watcher lifecycle, market-feed ingestion, wake queue |
| **Shared Contract** | `shared/` | Data only | `condition_schema_v1.json` + canonical condition examples |

The browser app and the Python engine are **separate processes**. They share a
data contract (`shared/condition_schema_v1.json`) and a three-state vocabulary,
not code. The watcher fleet calls the Python engine over HTTP.

```
        shared/condition_schema_v1.json  (data contract, imported by nothing)
                       ▲
        ┌──────────────┴───────────────┐
        │                              │
   src/ (browser)            server/tradingv_engine/
   in-browser TS evaluator   Python evaluator (authoritative)
        │                              ▲
        │  HTTP :8099 /evaluate        │ HTTP :8099/evaluate
        └──────────────────────────────┼──────────────────┐
                                       │                  │
                              watchers/ (Workers)   (TriggerCard only,
                                       │             legacy/unmounted)
                                       ▼
                                 wake queue in DO storage
```

**Evidence**
- `src/engine/conditions/engineClient.ts:129` — `DEFAULT_ENGINE_URL = 'http://127.0.0.1:8099'`
- `server/tradingv_engine/config.py:90` — default `port = 8099`
- `watchers/wrangler.toml:23` — `ENGINE_URL = "http://127.0.0.1:8099"`
- `server/tradingv_engine/contract.py:34` — `SCHEMA_PATH = <repo>/shared/condition_schema_v1.json`
- `watchers/src/contract.ts:159` — `conditionTree: unknown` (the worker does **not** import the schema)

---

## Major Runtime Chains

| Chain | Document | Trigger |
| --- | --- | --- |
| Application startup | [chains/application-startup.md](chains/application-startup.md) | `index.html` script load |
| Instrument discovery | [chains/instrument-discovery.md](chains/instrument-discovery.md) | `hyperliquidMarketData.getInstruments()` |
| Realtime quote → UI | [chains/realtime-quote-to-ui.md](chains/realtime-quote-to-ui.md) | Hyperliquid WebSocket message |
| Manual order placement | [chains/manual-order-placement.md](chains/manual-order-placement.md) | User taps "Place Order" |
| Position close | [chains/position-close.md](chains/position-close.md) | User taps close / kill switch |
| Trigger fire → agent wake | [chains/pre-goat-trigger-to-agent-wake.md](chains/pre-goat-trigger-to-agent-wake.md) | `MARKET_QUOTE` / `BAR_UPDATE` event |
| Agent decision → order | [chains/agent-decision-to-order.md](chains/agent-decision-to-order.md) | `AgentRuntime.step` |
| Bot creation & deployment | [chains/bot-creation-and-deployment.md](chains/bot-creation-and-deployment.md) | `BotBuilderModal` deploy step |
| Bot backtest | [chains/bot-backtest.md](chains/bot-backtest.md) | "Run backtest" |
| Kill switch flatten-all | [chains/kill-switch-flatten.md](chains/kill-switch-flatten.md) | Kill switch engaged |
| AI copilot chat | [chains/ai-copilot-chat.md](chains/ai-copilot-chat.md) | Sparkle button / `onAskAI` |
| Python engine tick | [chains/python-engine-tick.md](chains/python-engine-tick.md) | `asyncio` poll loop |
| Watcher feed → wake | [chains/watcher-feed-to-wake.md](chains/watcher-feed-to-wake.md) | `POST /feed` |
| Condition parity (TS ↔ Python) | [chains/condition-parity.md](chains/condition-parity.md) | `bun run test:conditions` |

---

## Important Entry Points

Full detail in [Entry Points](entry-points.md).

| Entry point | File | Symbol |
| --- | --- | --- |
| Browser boot | `src/main.tsx:27` | `createRoot(...).render(...)` |
| App shell | `src/App.tsx:2084` | `App()` |
| Trigger engine start | `src/App.tsx:399-409` | `useEffect` → `ensureTriggerEngineStarted()` |
| Agent step | `src/engine/agents/runtime.ts:389` | `AgentRuntime.step()` |
| Agent wake entry | `src/engine/agents/runtime.ts:1710` | `AgentRuntime.handleEvent()` |
| Agent tool exec | `src/engine/agents/capabilities/registry.ts:34` | `CapabilityRegistry.execute()` |
| Order submission | `src/adapters/hyperliquid/demo.ts:442` | `HyperliquidDemoAdapter.placeMarketOrder()` |
| Python server | `server/tradingv_engine/__main__.py:19` | `main()` |
| Python app factory | `server/tradingv_engine/api.py:145` | `create_app()` |
| Python poll loop | `server/tradingv_engine/engine.py:268` | `ConditionEngine._loop()` |
| Worker fetch | `watchers/src/index.ts:79` | `default.fetch()` |
| Worker feed ingest | `watchers/src/index.ts:147` | `handleFeed()` |
| Watcher tick | `watchers/src/watcher.ts:261` | `Watcher.tick()` |

---

## Important State

Full detail in [State Owners](state-owners.md).

| State | Defined at | Shape | Reset by |
| --- | --- | --- | --- |
| `eventBus` | `src/types/events.ts:75` | `Map<string, Set<fn>>` | never (module singleton) |
| `AgentRuntime.instances` | `src/engine/agents/runtime.ts:42` | `Map<agentId, AgentInstance>` | `clearAuditTrail()` only clears audit |
| `AgentRuntime.auditLog` | `src/engine/agents/runtime.ts:43` | `AgentAuditRecord[]` ring buffer, cap 200 | `clearAuditTrail()` `runtime.ts:1776` |
| `TriggerRegistry.triggers` | `src/engine/agents/triggers/registry.ts:15` | `Map<id, AgentTrigger>` + symbol index | `unregister()` `registry.ts:52` |
| `TriggerEngine.evaluationStates` | `src/engine/agents/triggers/engine.ts:43` | `Map<env:triggerId, state>` | `disposeAgent()` `engine.ts:348` |
| `riskManager` | `src/engine/execution/risk.ts:288` | limits, order timestamps, daily P&L | `resetDailyLoss()` `risk.ts:128` |
| `appContextStore` | `src/services/aiContext/store.ts:134` | sanitised `AppContextState` | `publish(patch)` `store.ts:98` |
| `hyperliquidDemoAdapter` | `src/adapters/hyperliquid/demo.ts` | positions, account, orders | none exposed |
| `conditionEngine` module log | `server/tradingv_engine/events.py:107` | `EventLog(capacity=2000)` | never (process lifetime) |
| `ConditionEngine._queue` | `server/tradingv_engine/engine.py:87` | `deque` of `QueuedWake`, cap 200 | `acknowledge_wake()` `engine.py:221` |
| `WatcherObject` storage | `watchers/src/durable-object.ts:37-39` | 3 KV keys | `save()` `durable-object.ts:118` |
| `WakeQueue` | `watchers/src/wake-queue.ts:115` | `Map<wakeId, Wake>` + terminal array | `expire()` / `resolve()` |

---

## Documentation Conventions

| Marker | Meaning |
| --- | --- |
| **CONFIRMED** | Directly supported by the code at the cited line. |
| **INFERRED** | Follows strongly from surrounding code but is not directly provable statically. |
| **DYNAMIC / UNCERTAIN** | Runtime behaviour that cannot be established from static analysis. |

Relationship verbs used throughout:

```
imports · references · extends · implements · instantiates · calls · returns
passes-to · reads · writes · mutates · emits · subscribes · awaits
```

Rules applied when writing this map:

- Every relationship carries evidence (`file:line`) or is marked `INFERRED`.
- Names are not treated as evidence. `Manager`, `Engine`, `Service`, `Helper`
  describe intent; behaviour was read from the implementation.
- Secrets are referenced by **variable name only**. No values are recorded.
- Test-only relationships are labelled as such and kept separate from the
  production graph.
- Async boundaries are drawn explicitly (`await`, callback, WebSocket, timer).

---

## Repository Statistics

| Metric | Count |
| --- | --- |
| TypeScript / TSX source files (`src/`) | 79 |
| Python source files (`server/tradingv_engine/`) | 20 |
| Python test files (`server/tests/`) | 10 |
| Cloudflare Worker source files (`watchers/src/`) | 9 |
| Worker test files (`watchers/test/`, `watchers/test-runtime/`) | 7 |
| TypeScript in-tree test/acceptance runners | 21 |
| `package.json` scripts | 30 |
| Logical modules documented | 17 |
| Runtime chains documented | 14 |
