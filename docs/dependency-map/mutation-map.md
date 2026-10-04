# Mutation Map

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Where application state changes, who performs the change, and what consumes the result.
Mechanisms are grouped by kind. No judgement is expressed on any entry.

---

## 1. In-memory singletons (module scope)

### `eventBus`

| Property | Value |
| --- | --- |
| Defined at | `src/types/events.ts:29` (class), `:75` (`export const eventBus = new EventBus()`) |
| State | `private listeners: Map<string, Set<(event:any)=>void>>` — `types/events.ts:30` |
| Created by | module import |
| Initialized by | `new Map()` — `types/events.ts:30` |
| Written by | `EventBus.on()` (`:36-39`), `EventBus.onAll()` (`:65-68`) |
| Reset by | the unsubscribe closures returned by `on()` (`:40-42`) and `onAll()` (`:69-71`); no global reset exists |
| Read by | `EventBus.emit()` (`:46`, `:58`) |
| Consumed by | every emitter/listener pair in §4 below |

**Mutation chain**

```
module import
   ↓
eventBus.listeners.set(type, new Set())        types/events.ts:37
   ↓ listener registration
eventBus.listeners.get(type).add(listener)     types/events.ts:39
   ↓ emit
handlers.forEach(h => h(event))                types/events.ts:48-51   (each wrapped in try/catch :49-53)
allHandlers.forEach(h => h(event))             types/events.ts:60     ('*' channel, NOT wrapped in try/catch)
```

Note (CONFIRMED): listeners on the wildcard `'*'` channel are invoked without the
try/catch that typed listeners get (`types/events.ts:60` vs `:48-53`).

---

### `agentRuntime`

| Property | Value |
| --- | --- |
| Defined at | `src/engine/agents/runtime.ts:1781-1782` — `export const agentRuntime = new AgentRuntime(undefined, undefined, undefined, undefined, new PersistentAgentTimelineStore())` |
| State | `instances: Map<string, AgentInstance>` `:42`; `auditLog: AgentAuditRecord[]` `:43`; `maxAuditEntries = 200` `:44`; `activeCycles: Set<string>` `:45`; `timelineSequence = 0` `:46`; `positionCorrelations: Map` `:48-51` |

| Field | Written at | Read at | Reset by |
| --- | --- | --- | --- |
| `instances` | `instances.set(agent.id, instance)` `runtime.ts:185` | `getAgent` `:200`, `listAgents` `:204`, internal lookups | never (no unregister method) |
| `auditLog` | `auditLog.unshift(record)` `runtime.ts:1289` | `getAuditTrail` `:1766` | `clearAuditTrail()` `runtime.ts:1776-1778` |
| `activeCycles` | `.add` `runtime.ts:405`, `.delete` `runtime.ts:409` | re-entrancy guard `:399` | automatic via `finally` `:409-411` |
| `timelineSequence` | `++` `runtime.ts:1401` | timeline id construction | never |
| `positionCorrelations` | `.set` `runtime.ts:1050`, `.delete` `runtime.ts:1502` | `:1443`, `:1481` | `.delete` on position close |

**Constructor side effects** — `runtime.ts:60-77` subscribes two `eventBus` listeners
(`POSITION_UPDATE`, `POSITION_CLOSE`). The unsubscribe closures returned by
`eventBus.on` are not captured, so there is no teardown path for them.

---

### `riskManager`

| Property | Value |
| --- | --- |
| Defined at | `src/engine/execution/risk.ts:288` — `export const riskManager = new RiskManager()` |
| State | `limits` `:35`, `recentOrderTimestamps: number[]` `:36`, `currentDailyPnL` `:37`, `currentDailyPnLUtcDay` `:48` |

| Field | Written at | Read at | Reset by |
| --- | --- | --- | --- |
| `limits.killSwitchActive` | `setKillSwitch()` `risk.ts:102-112`; also from the `App.tsx:2879` state updater | `isKillSwitchActive()` `:81-83`; `validateOrder()` `:149` | `setKillSwitch(false)` |
| `limits` (all others) | `updateLimits()` `:91-93` | `getLimits()` `:68-70` | `DEFAULT_RISK_LIMITS` `risk.ts:7-24` |
| `recentOrderTimestamps` | push + prune `risk.ts:73-83` (policy) and `risk.ts:187-193` | same | 60 s window prune |
| `currentDailyPnL` | `recordPnL()` `:122-126`; `rollDailyPnLIfNeeded()` `:60-66` | `realisedToday()` `:86-89`; `validateOrder()` `:196` | `resetDailyLoss()` `:128-131`; UTC-day rollover |

**Mutation chain — kill switch**

```
KillSwitchModal.tsx:94  button
   ↓ onToggleKillSwitch (App.tsx:2869)
setIsKillSwitchActive(prev => { riskManager.setKillSwitch(next); return next })
   ↓
riskManager.setKillSwitch(true)                execution/risk.ts:102
   ↓ mutates  riskManager.limits.killSwitchActive
   ↓ eventBus.emit({type:'STATUS_CHANGE'})     risk.ts:110
   ↓
downstream readers:
   App isKillSwitchActive state       → MobileHeader, KillSwitchModal, SettingsTab, AI riskState
   HyperliquidDemoAdapter order gate  → every order rejected
   ActionValidator (via observation) → policy surface
```

---

### `TriggerRegistry`

| Property | Value |
| --- | --- |
| Defined at | `src/engine/agents/triggers/registry.ts:14` (class). **Instance is created in `App.tsx:99-101`**, not as a module singleton. |
| State | `triggers: Map<string, AgentTrigger>` `:15`; `bySymbol: Map<string, Set<string>>` `:16`; `unscoped: Set<string>` `:17` |

| Field | Written at | Read at | Reset by |
| --- | --- | --- | --- |
| `triggers` | `register()` `:33-39` (stores `cloneTrigger(trigger)` `:33`) | `get()` `:64-67`, `list()` `:69-71`, `listForAgent()` `:73-75` | `unregister(id)` `:52-62` |
| `bySymbol` | `register()` `:37` | `candidates(symbol)` `:85-86` | `unregister()` `:59-60` |
| `unscoped` | `register()` `:38` | `candidates()` `:85` | `unregister()` `:61` |
| stored trigger `enabled` | `setEnabled()` `:92-98` (re-validates owner `:96`) | `candidates()` filter in `engine.ts:188-192` | `enable()` `:89` / `disable()` `:90` |

---

### `TriggerEngine`

| Property | Value |
| --- | --- |
| Defined at | `src/engine/agents/triggers/engine.ts` (class). **Instance created in `App.tsx:103-107`.** |
| State | `evaluationStates: Map` `:43`; `lastFired: Map` `:44`; `firingHistory: Map` `:45`; `inFlightTriggers: Set` `:46`; `agentByPosition: Map` `:51`; `recentInputIds: Map` `:52`; `processedEvents: Map<triggerId, Set>` `:53`; `instrumentCache: Map` `:54`; `domainEventSequence = 0` `:55`; `sourceEnvironment` `:49` |

| Field | Written at | Read at | Reset by |
| --- | --- | --- | --- |
| `evaluationStates` | `process()` `engine.ts:209-211` | `evaluateTrigger(trigger, input, state)` `:215` | `disposeAgent(agentId)` `:348-358`; `dispose()` `:32-42` |
| `lastFired` | `markFired()` `:445-453` | `canFire()` `:432,438` | clock-wind detection `:432-437`; `dispose()` `:34` |
| `firingHistory` | `markFired()` `:448` | `canFire()` `:439-442` | prune older than 60 s `:439-441` |
| `inFlightTriggers` | `.add` `:219`; `.delete` `:260` (finally) | re-entrancy gate `:218` | `finally` |
| `processedEvents` | `.add` `:200` | dedup `:196-198` | `clear()` when the set exceeds 10 000 `:199` |
| `recentInputIds` | `rememberInputId()` `:165-176` | position-event dedup | bounded FIFO eviction at 10 000 |
| `instrumentCache` | `withInstrument()` `:394-408` | `resolveInstrument()` `:410-429` | `disposeAgent()` `:354-357` |
| `sourceEnvironment` | `setEnvironment()` `:139` | agent filter `:82`, `:121`, `:203`, `:285` | — |
| `unsubscribe` | `start()` `:78` | `stop()` `:148` | `stop()` |

**Latch mutation** lives inside the evaluator's state object, not the engine:
`state.lastBar` (`evaluator.ts:155-157`), `state.conditionTrees` (`:113-121`),
`state.proximity` (`:332-338`), `state.sessionStarts` / `sessionEnds` (`:350-358`),
`state.lastSchedule` (`:365-380`).

---

### `CapabilityRegistry` / `SkillRegistry` / `ActionValidator` / `agentModel`

| Singleton | Defined at | State mutated | Reset |
| --- | --- | --- | --- |
| `capabilityRegistry` | `capabilities/registry.ts:91` | `capabilities: Map` `:4` — filled by `initializeDefaultCapabilities()` at `capabilities/index.ts:38` (module-load side effect) | never; `register()` rejects duplicates `:8` |
| `skillRegistry` | `skills/registry.ts` | builtin skills registered on module import | never |
| `actionValidator` | `policy/validator.ts:282` | `recentOrderTimestamps: number[]` `:38` | 60 s prune `:73-83` |
| `agentModel` | `agents/model/openrouter.ts` | delegates to `openRouterProvider` config | config from `localStorage` |
| `openRouterProvider` | `adapters/openrouter/provider.ts:291` | `this.config` `:105` (load) / `:131` (save) | `localStorage` write `provider.ts:131` |

---

### `marketDataService`

| Property | Value |
| --- | --- |
| Defined at | `src/services/marketData.ts:79` — `export const marketDataService = new MarketDataService()` |
| State | symbol list + last prices inside `MarketDataService` (`:31` constructor) |
| Written by | `setSymbols()` `:35` ← `App.tsx:436`; `updateLastPrice()` `:65` ← `App.tsx:624` on every quote tick |
| Read by | `getSymbol()` `:40` ← `App.tsx:1636` (backtest pip/lot lookup); `findSymbol()` `:50`; `getAllSymbols()` `:54` |
| Reset by | none exposed |

---

### `appContextStore`

| Property | Value |
| --- | --- |
| Defined at | `src/services/aiContext/store.ts:134` — `export const appContextStore = new AppContextStore()` |
| State | `AppContextState` (interface `store.ts:60-97`) |
| Written by | `publish(patch)` `store.ts:98` — called **only** from the App effect at `App.tsx:1853` |
| Read by | the 11 read-only AI tools in `services/aiContext/tools.ts:32-161`, consumed by `FloatingAIAssistant` |
| Reset by | every publish replaces the whole snapshot (a patch merge) |

**Write direction is one-way (CONFIRMED)**: App → store → AI tools. No AI tool writes.

---

## 2. Python module-level state

| Object | Defined at | Written by | Read by | Reset |
| --- | --- | --- | --- | --- |
| `event_log = EventLog()` | `server/tradingv_engine/events.py:107` | `EventLog.record()` `:68`, `EventLog.emit()` `:74` | `EventLog.recent()` `:82`, `for_bot()` `:99`; API `/events` `api.py:369` | never (2000-entry ring buffer) |
| `load_schema` memo | `contract.py:43-46` `@lru_cache(maxsize=1)` | first call only | `schema_errors()` `:54`; API `/schema` `api.py:242` | never |
| `_validator` memo | `contract.py:49-51` `@lru_cache(maxsize=1)` | first call only | `schema_errors()` `:66` | never |
| `SPECS` / `BY_KIND` | `catalogue.py:87` / `:430` | module load | `spec_for()` `:433`; evaluator `:47` | never |
| `INDICATORS` / `WARMUP` | `indicators/engine.py:464` / `:530` | module load | `compute()` `:515`; `required_history()` `:561` | never |
| `PATTERNS` / `HANDLERS` | `patterns.py:56` / `:363` | module load | `evaluate()` `:137` | never |

### `ConditionEngine` instance state

| Field | Defined at | Written at | Read at | Reset |
| --- | --- | --- | --- | --- |
| `monitor` | `engine.py:80-85` | constructor | every proxy method | — |
| `_queue` (deque, cap 200) | `engine.py:87` | `_enqueue()` `:237-246` | `pending_wakes()` `:218` | `acknowledge_wake()` `:221-235` |
| `_sequence` | `engine.py:88` | `_enqueue()` `:243` | wake id | never |
| `_task` | `engine.py:89` | `start()` `:252` | `stop()` `:262` | `stop()` |
| `_stopping` (asyncio.Event) | `engine.py:90` | `start()` clears `:251`; `stop()` sets `:259` | `_loop()` `:270`; sleep `:286` | `start()` |
| `_wake_listeners` | `engine.py:91` | `on_wake()` `:214-216` | `_enqueue()` `:244` | never |
| `_fixture_contexts` | `engine.py:92` | `_load_fixture_contexts()` `:346-409` | `fixture_context()` `:181` | never |

### `MarketMonitor` instance state

| Field | Defined at | Written at | Reset |
| --- | --- | --- | --- |
| `store` (`CandleStore`) | `monitor.py:145` | `CandleStore.get()` `store.py:87` | `seed()` `store.py:90`; no eviction |
| `cache` (`IndicatorCache`) | `monitor.py:147` | `get_or_compute()` `store.py:117-132` | `invalidate()` `store.py:134-137` ← `monitor.py:272` on every successful refresh |
| `triggers` | `monitor.py:148` | `register()` `:172`, `replace()` `:182` | `unregister()` `:178` |
| `detectors` | `monitor.py:149` | `register()` `:175` | `unregister()` `:180` |
| `_instruments` | `monitor.py:150` | `load_instruments()` `:167` | never |
| `_account` / `_positions` / `_spread` | `monitor.py:151-153` | `set_account()` `:192`, `set_positions()` `:195`, `set_spread()` `:198` | overwritten by the next set |
| `_running` | `monitor.py:154` | `start()` `:221`, `stop()` `:227` | — |
| `wakes` | `monitor.py:156` | `_evaluate_trigger` on FIRED | appended only |

### `EdgeDetector` / `EdgeState`

| Field | Defined at | Written at | Read at |
| --- | --- | --- | --- |
| `last_status` | `edge.py:78` | `observe()` `:190` (TRUE), `:179-187` (FALSE) | `snapshot()` `:253` |
| `last_evaluation_ms` | `edge.py:80` | `observe()` `:165` | `snapshot()` `:253` |
| `last_fire_ms` | `edge.py:82` | `observe()` `:234` | `snapshot()` `:253` |
| `fire_count` | `edge.py:83` | `observe()` `:235` (`+= 1`) | `snapshot()` `:253` |
| `wakes` (deque) | `edge.py:84` | `observe()` `:236` | `wakes_last_hour()` `:90`, `wakes_today()` `:93` |
| `WakePolicy` | `edge.py:43-44` | `from_definition()` `:53-61` | `observe()` `:145`, `:150-232` |

**Note (CONFIRMED)** — an `UNKNOWN` result does **not** update `last_status`
(`edge.py:167-177`), so the latch is only re-based on a definite TRUE or FALSE.

---

## 3. Durable Object storage (Cloudflare Workers)

| Key | Class | Written at | Read at | Reset |
| --- | --- | --- | --- | --- |
| `watcher:state` | `WatcherObject` `durable-object.ts:37` | `save()` `:121` | `readStored()` `:212` | `ready()` recreates via `Watcher.restore` `:98` |
| `watcher:terminal-wakes` | `WatcherObject` `durable-object.ts:38` | `save()` `:122` | `readStored()` `:214` | `restoreTerminal()` `wake-queue.ts:215-224`; trimmed to `historyLimit` `:321-323` |
| `watcher:pending-wakes` | `WatcherObject` `durable-object.ts:39` | `save()` `:125` | `readStored()` `:215` | `resolve()` `wake-queue.ts:249`; `expire()` `:291-301` |
| `identities` | `UserRegistryObject` `index.ts:359` | `add()` `:365-373` | `list()` `:382` | `remove()` `:375-380` (no HTTP route calls it) |
| `identities` | `MarketIndexObject` `index.ts:464` | `add()` `:470-475` | `list()` `:477` | no `remove` method exists |
| `window` | `RateLimitObject` `index.ts:397` | `take()` `:406` (every call, incl. refusals) | `take()` `:404` | window expiry `rate-limit.ts:88` |

**Write-trigger condition (CONFIRMED)** — `WatcherObject.onMarketEvent` only calls
`save()` when a change-detector snapshot differs (`durable-object.ts:245,248,249`).
A no-op tick performs zero storage writes.

### In-memory watcher state mutated per tick

`watcher.ts:262-263` `lastHeartbeatAt`, `updatedAt`; `:268` prune; `:290` `lastMarketDataAt`;
`:291` `lastSequence`; `:292` `lastTimestamp`; `:312` `lastEvaluationAt`;
`:324` `consecutiveEvaluationFailures += 1`; `:325-329` `lastError`;
`:338-340` `lastSuccessfulEvaluationAt`, `consecutiveEvaluationFailures = 0`, `lastError = null`;
`:342-344` `lastConditionStatus`; `:407-409` `fireTimestamps.push`, `lastWakeAt`.

---

## 4. Event emissions and the state each causes

Full emitter/listener detail is in [Event Flow](event-flow.md). Mutation-focused summary:

| Event | Emitted at | Direct state mutation caused |
| --- | --- | --- |
| `MARKET_QUOTE` | `marketData.ts` (quote path) | `App.quotes` `App.tsx:614`; `marketDataService` last price `:624`; demo positions mark-to-market `:637` |
| `BAR_UPDATE` | `marketData.ts` (bar path) | `App.bars` `App.tsx:724-749` |
| `ORDER` | `demo.ts` | none observed in `App` (typed at `types/events.ts:19`, no App listener) |
| `POSITION_OPEN` | `demo.ts` | `App.positions/balance/margin/freeMargin` `App.tsx:798,804-806` |
| `POSITION_UPDATE` | `demo.ts` | same as above `App.tsx:815`; `AgentRuntime.recordPositionEvent` `runtime.ts:60-70` |
| `POSITION_CLOSE` | `demo.ts` | `App.trades` unshift `App.tsx:822-828`, then account mirror `:834`; `AgentRuntime.recordPositionEvent` `runtime.ts:71-77` |
| `RISK_VIOLATION` | `risk.ts:276-285` | none in `App` (consumed by `TriggerEngine` via `processRiskState` `engine.ts:339-346`) |
| `STATUS_CHANGE` | `risk.ts:110`; `marketData.ts` status | `App.connectionStatus` `App.tsx:513-518` |
| `AGENT_*` (12 variants) | `runtime.ts:217,245,464,510,561,674,743,988,1079,1245,1256,1265-1287` | `TriggerEngine` via `onAll`; timeline records; no `App` state |
| `LOG` | `App.tsx:460,499,560,690,884,931` + others | **none** — `App.logs` (`App.tsx:215-216`) has no writer |

---

## 5. Browser persistence (`localStorage`)

| Key | Written at | Read at | Owner |
| --- | --- | --- | --- |
| `tradingvibe_theme` | `services/theme/theme.ts` (`THEME_STORAGE_KEY` `:21`) | `resolveInitialTheme()` at `main.tsx:16` and by `ThemeProvider` | user preference |
| `tradingvibe_openrouter_config` | `adapters/openrouter/provider.ts:131` | `provider.ts:105` | user-supplied AI key |
| `tradingvibe_user_profile` | `services/userService.ts:25` (`STORAGE_KEY`) | `userService.getCurrentUser()` ← `App.tsx:487` | user profile |

No `sessionStorage`, `IndexedDB`, or `document.cookie` usage was found in `src/`
(CONFIRMED by repo-wide grep).

## 6. External write boundaries

| Boundary | Method | Where |
| --- | --- | --- |
| Hyperliquid `/info` | `POST` (read-only RPC shape) | `marketdata.py:137-149` (Python); `marketData.ts:54,195,213` (browser) |
| Hyperliquid WebSocket | subscribe/unsubscribe frames | `marketData.ts:180-230` |
| OpenRouter `/chat/completions` | `POST` | `provider.ts:194` |
| Python engine | `GET`/`POST`/`DELETE` | `engineClient.ts:189-313`; `api.py:216-389` |
| Watcher worker | `POST /feed`, `POST /watchers`, `POST …/wakes:claim`, `POST …/wakes:resolve` | `index.ts:147, 233, 321, 327` |

There is **no** write to any Hyperliquid private/order endpoint. The DEMO adapter
(`src/adapters/hyperliquid/demo.ts`) simulates fills locally and never contacts a
signing endpoint. Evidence: no signing code path exists in `src/adapters/hyperliquid/`
and `riskManager`/policy are the only gates.

---

## 7. Mutations hidden behind functions (writer is not the state owner)

| Caller believes it is calling | Actually mutates | Chain |
| --- | --- | --- |
| `agentRuntime.start(agentId)` | `instance.isRunning` | `runtime.ts:208` → `:215` |
| `agentRuntime.stop(agentId)` | `instance.isRunning` | `runtime.ts:236` → `:243` |
| `agentRuntime.step(...)` | `instance.memory`, `auditLog`, `timelineSequence`, `positionCorrelations`, `instances[id].lastCycleAt` | `runtime.ts:389` → `:1169-1210`, `:1289`, `:1401`, `:1050` |
| `triggerEngine.start()` | `unsubscribe` field | `engine.ts:76` → `:78` |
| `triggerEngine.process(input)` | `evaluationStates`, `lastFired`, `firingHistory`, `inFlightTriggers`, `processedEvents` | `engine.ts:178` → `:209`, `:220`, `:219`, `:200` |
| `riskManager.validateOrder(...)` | `recentOrderTimestamps` (when `recordAcceptedOrder` is true) | `risk.ts:139` → `:202` |
| `riskManager.recordPnL(...)` | `currentDailyPnL` | `risk.ts:122` → `:124` |
| `actionValidator.validate(...)` | `recentOrderTimestamps` | `policy/validator.ts:40` → `:247-248` |
| `hyperliquidDemoAdapter.placeMarketOrder()` | `positions`, `orders`, account balance, and emits `ORDER` + `POSITION_OPEN` | `demo.ts:442` |
| `hyperliquidDemoAdapter.closePosition()` | `positions`, `trades`, account balance, emits `POSITION_CLOSE` | `demo.ts` |
| `hyperliquidDemoAdapter.markToMarket(quote)` | open position unrealised P&L | `demo.ts`, called `App.tsx:637` |
| `marketDataService.setSymbols()` | internal symbol list | `services/marketData.ts:35` |
| `appContextStore.publish()` | the whole `AppContextState` | `store.ts:98` |
| `WatcherObject.onMarketEvent()` | 3 DO storage keys (conditionally) | `durable-object.ts:242` → `:249` → `:118-126` |
| `WakeQueue.enqueue()` | `pending` map + terminal list | `wake-queue.ts:171-205` |
| `RateLimitObject.take()` | `window` KV key | `index.ts:403` → `:406` |
| `ConditionEngine.tick_once()` | monitor store, indicator cache, edge states, wake deque | `engine.py:298` |
| `EventLog.emit()` | the 2000-entry deque | `events.py:74` → `:68` |
| `setIsKillSwitchActive(fn)` in `App.tsx:2869` | `riskManager.limits` **inside a React state updater** | `App.tsx:2879-2883` |
