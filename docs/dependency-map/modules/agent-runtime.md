# Module 5 — Agent Runtime

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/runtime.ts` (2020 lines), plus `types.ts`,
`memory/memory.ts`, `model/openrouter.ts`, `model/types.ts`, `timeline/*`

**Purpose:** the observe → reason → tool-call → decide → validate → execute cycle for
one agent, one wake. Exports the `AgentRuntime` class and the `agentRuntime` module
singleton.

---

## Contains

### `runtime.ts`

| Symbol | Line | Kind |
| --- | --- | --- |
| `AgentInstance` | `:29-39` | interface — `{ agent, env, memory, isRunning, allowedCapabilities, skillsInstructions, validator, botId?, deploymentId? }` |
| `AgentRuntime` | `:41` | class |
| `agentRuntime` | `:1781-1782` | module singleton: `new AgentRuntime(undefined, undefined, undefined, undefined, new PersistentAgentTimelineStore())` |

Module-private helpers: `isRecord` `:1784` · `isAgentDecision` `:1794` ·
`isSuccessfulExecution` `:1865` · `isErrorResult` `:1879` ·
`sanitizeAuditValue` `:1888` · `observationSnapshot` `:1922` · `summarize` `:1951` ·
`referencePricesFrom` `:2003`.

### `types.ts` (295 lines)

`TradingEnvironmentMode` `:6` · `AgentState` `:8` · `AgentMemoryRecord` `:15` ·
`AgentPolicy` `:26-42` · `AgentSkill` `:47` · `CapabilityContext` `:61-69` ·
`AgentCapability` `:74-82` · `ITradingEnvironment` `:91-128` · `AgentObservation`
`:133-156` · `AgentDecision` `:161-194` · `AgentActionValidationResult` `:199-212` ·
`AgentWakeEventType` `:217-230` (13 values) · `AgentWakeEvent` `:232-238` ·
`AgentAction` `:243` · `AgentMemory` `:245-251` · `AgentAuditRecord` `:256-273` ·
`TradingAgent` `:278-295`.

### `memory/memory.ts`
`ScopedAgentMemory` — per-agent. Read at `runtime.ts:381` as
`observation.recentMemories`; written at `runtime.ts:1169-1210`.

### `model/openrouter.ts` + `model/types.ts`
`agentModel` — the default `IAgentModel`. `IAgentModel.run` is the LLM entry point,
called at `runtime.ts:522`.

### `timeline/store.ts` (302 lines) + `types.ts` + `index.ts`
`AgentTimelineStore` interface, `InMemoryAgentTimelineStore`,
`PersistentAgentTimelineStore`. The `agentRuntime` singleton uses the persistent
variant (`runtime.ts:1782`); the constructor default is in-memory (`runtime.ts:58`).
Read by `App.handleGetBotActivity` — `App.tsx:1723-1731`.

---

## Class state

| Field | Line | Holds | Cap / reset |
| --- | --- | --- | --- |
| `instances` | `:42` | `Map<agentId, AgentInstance>` | never |
| `auditLog` | `:43` | `AgentAuditRecord[]`, newest first (`unshift` `:1289`) | `maxAuditEntries = 200` `:44`; `clearAuditTrail()` `:1776-1778` |
| `activeCycles` | `:45` | `Set<string>` re-entrancy guard | `finally` `:409-411` |
| `timelineSequence` | `:46` | monotonic id counter | never |
| `positionCorrelations` | `:48-51` | `Map<positionId, { agentId, triggerId?, correlationId }>` | deleted on close `:1502` |

**Constructor-injected dependencies** — `runtime.ts:53-59`

| Parameter | Line | Default |
| --- | --- | --- |
| `capabilities` | `:54` | `capabilityRegistry` |
| `skills` | `:55` | `skillRegistry` |
| `validator` | `:56` | `actionValidator` |
| `model` | `:57` | `agentModel` |
| `timeline` | `:58` | `new InMemoryAgentTimelineStore()` |

**Constructor side effects** — `runtime.ts:60-77`

```
eventBus.on('POSITION_UPDATE', e => recordPositionEvent(e.data.positionId, 'UPDATED', e.data))
eventBus.on('POSITION_CLOSE',    e => recordPositionEvent(e.data.position.id, 'CLOSED',
                                                        { position, tradeId }))
```

The unsubscribe closures returned by `eventBus.on` are **not captured** — there is no
teardown path for these two subscriptions.

---

## Lifecycle

### create / register — `registerAgent(agent, env)` `:84-188`

| Step | Line | Rule |
| --- | --- | --- |
| deep-freeze the agent, its arrays and policy | `:88-110` | |
| `env.mode === 'LIVE'` → throw | `:112-116` | |
| `!agent.enabled` → throw | `:118-120` | |
| `skills.resolveCapabilities(agent.skills)` | `:122-124` | |
| unknown or disabled skill → throw | `:126-134` | |
| `allowedCapabilities` = agentCaps ∩ skillCaps ∩ registeredCaps | `:136-140` | |
| reject any field matching `/secret\|token\|password\|api.?key\|credential/i` | `:142-152` | |
| `skillsInstructions = skills.compileInstructions(...)` | `:154-155` | |
| `memory = new ScopedAgentMemory()` | `:157` | |
| per-agent `ActionValidator` clone when the singleton was used | `:159-162` | |
| build `AgentInstance` | `:164-174` | |
| duplicate capability-id check | `:176-183` | |
| `instances.set(agent.id, instance)` | `:185` | |

`registerBot(definition, deployment, runtimeSymbol, env)` `:190-198` →
`compileBotDefinition(...)` `:196` → `registerAgent` `:197`.

### initialize / start — `start(agentId)` `:208-234`

`isRunning = true` `:215` · emit `AGENT_STARTED` `:217-223` · emit `LOG` `:225-233`.
No timer is created — agents have no intervals.

### stop — `stop(agentId)` `:236-262`

`isRunning = false` `:243` · emit `AGENT_STOPPED` `:245-251` · emit `LOG` `:253-261`.

### wake — `handleEvent(agentId, event)` `:1710-1764`

| Gate | Line |
| --- | --- |
| agent registered AND `isRunning` | `:1717-1722` |
| wake type ∈ a 12-value allow-list | `:1724-1738` |
| event symbol ∈ `agent.symbols` (unless the event has no symbol) | `:1748-1756` |
| → `await this.step(agentId, event)` | `:1758` |

### run — `step` `:389-412` → `runStep` `:414-1345`

Full step-by-step is in
[chains/agent-decision-to-order.md](../chains/agent-decision-to-order.md).

---

## Depends on

| Module | Import / injection |
| --- | --- |
| Trigger Engine | receives the wake from `TriggerEngine`'s injected `delivery` closure (`engine.ts:57`); the engine holds the runtime, not the reverse |
| Capabilities | `this.capabilities.get/execute` `:626, 703, 830, 343` |
| Policy & Risk | `this.validator.validate` `:894`, `:1549`; `riskManager.validateOrder` `:906`, `:1561` |
| Environments | `instance.env.*` `:287-321`, `:979`, `:1107`, `:1116` |
| Bot Definitions | `compileBotDefinition` `:196` |
| AI Copilot | `agentModel` → `openRouterProvider` |
| Services & State | `eventBus` via `types/events.ts` |

## Used by

| Consumer | Line |
| --- | --- |
| `App` | `App.tsx:975, 1025, 1185, 1200, 1519, 1723, 1784` |
| `TriggerEngine` | injected as the wake target `engine.ts:57, 71` |
| `BacktestEnvironment.replayAgentBacktest` | `environment/backtest.ts:377-395` |
| Builtin registration | `builtins/register.ts:5-10` |
| Test runners (test-only) | `test-runner/run.ts`, `pipelineAcceptance.ts`, `activityTests.ts`, `backtestTests.ts`, `tests.ts`, `triggers/auditRegressionTests.ts`, `triggers/tests.ts`, `triggers/conditionTests.ts` |

## Reads

| Source | Line |
| --- | --- |
| `instance.agent` (deep-frozen) | throughout `runStep` |
| `instance.allowedCapabilities` | `:613`, `:809` |
| `instance.memory.export()` | `:381` |
| `instance.env.getMarketQuote/getMarketBars/getAccountState/getPositions/getOrders` | `:287, 289, 319, 320, 321` |
| `instance.env.getInstruments()` | `:1352-1369` |
| `this.capabilities.get(id)` | `:626` |
| `this.auditLog` | `:1766` |
| `this.positionCorrelations` | `:1443`, `:1481` |
| `eventBus` `POSITION_UPDATE` / `POSITION_CLOSE` | `:60-77` |

## Writes

| Target | Line |
| --- | --- |
| `instances.set(...)` | `:185` |
| `instance.isRunning` | `:215`, `:243` |
| `instance.allowedCapabilities` / `skillsInstructions` / `memory` / `validator` | `:136-140, 154-157, 159-162` |
| `instance.memory` fields | `:1169-1210` |
| `auditLog.unshift` | `:1289` |
| `activeCycles` | `:405`, `:409` |
| `timelineSequence` | `:1401` |
| `positionCorrelations` | `:1050`, `:1502` |
| timeline records | `:452, 480, 570, 657, 684, 753, 768, 934, 1002, 1059, 1130, 1298, 1315` |

## Mutates (state hidden behind methods)

| Caller | Actually mutates | Line |
| --- | --- | --- |
| `start(agentId)` | `instance.isRunning` | `:215` |
| `stop(agentId)` | `instance.isRunning` | `:243` |
| `step(...)` | memory, auditLog, timelineSequence, positionCorrelations, `lastCycleAt` | `:1169-1210, 1289, 1401, 1050` |
| `recordPositionEvent(...)` | the timeline | `:1384` |
| `notifyAgentPosition(...)` | the timeline + `positionCorrelations` reads | `:1422-1473` |

## Creates

- `ScopedAgentMemory` `:157`
- `AgentInstance` `:164-174`
- `AgentAuditRecord` `:1215-1243`
- per-agent `ActionValidator` clone `:159-162`

## Destroys

Nothing. There is no `unregisterAgent`, no `dispose`, and no teardown for the two
constructor `eventBus` subscriptions.

## Emits

12 `AGENT_*` events:

| Event | Line |
| --- | --- |
| `AGENT_STARTED` | `:217-223` |
| `AGENT_STOPPED` | `:245-251` |
| `AGENT_OBSERVED` | `:1245-1251` |
| `AGENT_REASONING` | `:510-517` |
| `AGENT_TOOL_REQUESTED` | `:674-682` |
| `AGENT_TOOL_RESULT` | `:743-751` |
| `AGENT_DECISION` | `:1256-1263` |
| `AGENT_ACTION_APPROVED` / `_REJECTED` | `:1265-1287` |
| `AGENT_ORDER_SUBMITTED` | `:988-995` |
| `AGENT_ORDER_FILLED` | `:1079-1101` |
| `AGENT_ERROR` | `:464-471`, `:561-568`, `:1130-1163` |
| `LOG` | `:225-233`, `:253-261` |

## Subscribes to

`eventBus.on('POSITION_UPDATE')` `:60-70` · `eventBus.on('POSITION_CLOSE')` `:71-77`.
Both unsubscribe closures are discarded.

## Returns

`step` → the `finalDecision` `:1344` · `observe` → an `AgentObservation` `:363-381` ·
`getAuditTrail(agentId?)` → `AgentAuditRecord[]` `:1766-1774`.

## Consumes

`AgentWakeEvent` from the trigger engine · the LLM response from `agentModel.run` ·
capability results from `this.capabilities.execute`.

## External boundaries

| Boundary | Line | Kind |
| --- | --- | --- |
| OpenRouter chat completions | `agentModel.run` → `adapters/openrouter/provider.ts:194` | `await fetch` |
| Hyperliquid REST | via `ITradingEnvironment` → `demo.ts` → `marketData.ts:192` | `await fetch` |

No database, no storage, no filesystem.

---

## The gate invariant (CONFIRMED)

```
model output
   ↓
capabilities.execute  (execution category → re-observe :628-631 + pre-validate :633)
   ↓
ActionValidator.validate            policy/validator.ts:40     runtime.ts:894
   ↓
RiskManager.validateOrder           execution/risk.ts:139      runtime.ts:906
   ↓
ITradingEnvironment  →  adapter  →  simulated fill          runtime.ts:979
```

`validateExecutionTool` — `runtime.ts:1508-1704` — repeats the policy and risk gates
for the execution-category tool path:

| Tool | Line | Behaviour |
| --- | --- | --- |
| `orders.market` | `:1515-1579` | synthesises an `OPEN_POSITION` decision from the tool input, then `validator.validate` `:1549` + `riskManager.validateOrder(..., recordAcceptedOrder=false)` `:1561` |
| `positions.close` | `:1596-1613` | the position must exist, else `INVALID_PARAMS` |
| `positions.partialClose` | `:1615-1635` | volume must be finite, > 0, and ≤ the position's volume |
| `positions.modifyStopLoss` / `modifyTakeProfit` | `:1649-1684` | `MODIFY_POSITION` validation |
| `orders.limit` / `orders.cancel` | `:1686-1696` | **always** `INVALID_PARAMS` |
| anything else | `:1698-1703` | `UNKNOWN_CAPABILITY` |

---

## Observation and clock

`observe(agentId)` — `runtime.ts:264-382`

| Element | Line | Source |
| --- | --- | --- |
| symbol | `:271` | `symbols[0] \|\| 'EURUSD'` |
| policy boundary | `:273-285` | every configured symbol must be in `policy.allowedSymbols` when non-empty |
| quote | `:287` | `env.getMarketQuote` |
| bars | `:289-293` | `env.getMarketBars(symbol, timeframe \|\| '5m', 15)` |
| account | `:319` | `env.getAccountState()` |
| positions | `:320` | `env.getPositions()` |
| orders | `:321` | `env.getOrders()` |
| session | `:338-361` | `capabilities.execute('market.getSession', …)`, only if the capability is in `allowedCapabilities` |
| memories | `:381` | `instance.memory.export()` |

Sanity gates: bars all finite `:295-305`; quote `bid > 0`, `ask >= bid`, all finite
`:307-317`; account finite `:323-334`. A violation throws, and the cycle becomes
`WAIT` with a timeline `ERROR { code: 'OBSERVATION_ERROR' }` `:452-462`.

**Clock** — `nowFor(instance)` `:1371-1382`: `env.mode === 'BACKTEST'` →
`env.getMarketQuote(...).timestamp`; otherwise `Date.now()`.

---

## Loop bound

`maxIterations = 5` — `runtime.ts:497`; counter at `:508`. The loop exits on a final
decision `:873`, on a model error `:583`, on a malformed decision `:799`, or when the
model returns nothing `:876`.
