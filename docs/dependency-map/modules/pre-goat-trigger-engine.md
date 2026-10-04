# Module 6 — Trigger Engine

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/triggers/`

**Purpose:** register triggers against agents, decide whether a trigger's condition
is currently met given a market/event input, apply cooldown and per-minute caps, and
deliver a wake to the agent runtime. The instance is created by `App.tsx:103-107` —
this module exports the classes, not a singleton.

---

## Contains

| File | Lines | Exports |
| --- | --- | --- |
| `types.ts` | 83 | `TriggerType` (18), `PriceOperator`, `CrossDirection`, `AgentTrigger`, `TriggerMarketState`, `TriggerInput`, `AgentTriggerEvent`, `TriggerDelivery` |
| `registry.ts` | 202 | `SUPPORTED_TYPES`, `TriggerRegistry`, `TriggerAgentResolver` |
| `engine.ts` | 529 | `TriggerEngine` |
| `evaluator.ts` | 415 | `TriggerEvaluationState`, `TriggerMarketStateSnapshot`, `evaluateTrigger`, `newEvaluationState`, `evaluateConditionTreeTrigger`, `describeTreeOutcome`, `calculateTriggerIndicators`, `triggerInputFromEvent` |
| `conditions.ts` | 973 | the in-browser condition-tree evaluator (9 kinds) |
| `proximity.ts` | 285 | `ProximityLevel`, `ProximityConfig`, `evaluateProximity`, `describeProximity` |
| `backtest.ts` | — | trigger replay helper for backtests |
| `index.ts` | 7 | barrel |

---

## `TriggerRegistry` — `registry.ts:14-99`

**State**
`triggers: Map<string, AgentTrigger>` `:15` ·
`bySymbol: Map<string, Set<string>>` `:16` ·
`unscoped: Set<string>` `:17`

**Registers:** `register(trigger)` `:23-40` · `registerBotTriggers(definition, agentId, runtimeSymbol)` `:42-50`

**Resolves:** `getAgent` `:21` · `get` `:64-67` · `list` `:69-71` ·
`listForAgent` `:73-75` · `countForAgent` `:77-81` · `candidates(symbol?)` `:83-87`

**Mutates:** `setEnabled` `:92-98` · `enable` `:89` · `disable` `:90`

**Creates:** `cloneTrigger(trigger)` — `structuredClone`, `:182-184`, stored at `:33`

**Registration gate (CONFIRMED, in order)**

1. `validateDefinition(trigger)` `:24` → `:101-164`
2. owner is a registered, enabled, non-LIVE agent `:25-26`
3. `trigger.symbol` ∈ agent.symbols ∩ `policy.allowedSymbols` `:27-28`
4. an unscoped trigger requires the owner to have symbols `:29`
5. `trigger.timeframe` ∈ `1m|5m|15m|30m|1h|4h|1d` (`isTimeframe` `:196-198`) and
   must equal `agent.timeframe` when the agent has one `:30`
6. id not already registered `:31`
7. the agent has fewer than **100** triggers `:32`

**`validateDefinition` per-type rules** — `:111-162`

| Type | Line | Rule |
| --- | --- | --- |
| `PRICE_THRESHOLD` | `:111` | requires a threshold |
| `PRICE_CROSS` | `:112` | requires a level and a direction |
| `INDICATOR_CROSS` | `:113-134` | pair or level form; MACD key required `:122`; positive integer periods `:123`; allowed types EMA/SMA/RSI/ATR/MACD `:128`; period bounds `:129-131`; mutual exclusivity `:133` |
| `BREAKOUT` | `:135-138` | lookback 1..1000 |
| `SPREAD_CHANGE` | `:139-141` | threshold |
| `VOLATILITY_CHANGE` | `:142-144` | threshold |
| proximity types | `:145` | ≥1 non-negative threshold (`hasProximityThreshold` `:174-180`) |
| `SCHEDULED` | `:146-149` | `everyMs ≥ 1000`, or `at` `HH:mm` + a valid IANA zone |
| `NEW_BAR` | `:150` | requires `timeframe` |
| `INDICATOR_CROSS` | `:151` | requires `timeframe` |
| session types | `:152-156` | timezone, sessionId, increasing epoch bounds |
| `conditionTree` | `:157-162` | must be a `GROUP` with children |
| `CUSTOM` | `:163` | **always refused** |

Cross-cutting: identity/type `:102`, timestamps `:103`, cooldown `:104`,
`maxFiringsPerMinute` `:105`, priority `:106`, `config` must be a **plain object**
`:107`, and no secret-shaped keys (`containsSensitiveKey` `:186-190`) `:108-109`.

Timezone validation uses `Intl.DateTimeFormat` — `:192-194`.

---

## `TriggerEngine` — `engine.ts`

**Constructor** `:57-74`

| Field | Line | Holds |
| --- | --- | --- |
| `evaluationStates` | `:43` | `Map<`${env}:${triggerId}`, TriggerEvaluationState>` |
| `lastFired` | `:44` | `Map<triggerId, ts>` |
| `firingHistory` | `:45` | `Map<triggerId, Firing[]>` |
| `inFlightTriggers` | `:46` | `Set<evaluationKey>` |
| `unsubscribe` | `:47` | the `onAll` teardown |
| `delivery` | `:48` | the wake closure built at `:64-73` |
| `sourceEnvironment` | `:49` | `'BACKTEST' \| 'DEMO'` |
| `resolveAgent` | `:50` | injected |
| `agentByPosition` | `:51` | `Map<positionId, agentId>` |
| `recentInputIds` | `:52` | bounded dedup, cap 10 000 (`:19`) |
| `processedEvents` | `:53` | `Map<triggerId, Set<deliveryKey>>` |
| `instrumentCache` | `:54` | `Map<`${agentId}:${symbol}`, Promise<InstrumentMetadata\|undefined>>` |
| `domainEventSequence` | `:55` | monotonic counter |

**`delivery.wake` built at `:64-73`**

```
wake(triggerEvent)
   ├─ wakeType(trigger.type) → the 13-value wake enum        engine.ts:466-482
   ├─ build AgentWakeEvent with data{ triggerId, triggerType, reason,
   │      sourceEventId, correlationId }                     engine.ts:66-70
   │    correlationId precedence                              engine.ts:69
   │      1) `${agentId}:trade:${tradeId}`
   │      2) `${agentId}:position:${positionId}`
   │      3) `${agentId}:${triggerId}:${timestamp}`
   └─ if runtime.getAgent(agentId)?.isRunning
         await runtime.handleEvent(agentId, event)           engine.ts:71
```

**Methods**

| Method | Line | Purpose |
| --- | --- | --- |
| `dispose()` | `:32-42` | clear every map/set + unsubscribe |
| `start()` | `:76-116` | idempotent `:77`; `eventBus.onAll` `:78` |
| `stop()` | `:147-150` | `unsubscribe()` |
| `setEnvironment(env)` | `:139` | |
| `ingest(event, environment)` | `:141-145` | public entry |
| `process(input)` | `:178-267` | **the lifecycle** |
| `tickScheduled(timestamp, environment)` | `:269-317` | `SCHEDULED` triggers only |
| `emitSessionBoundaries(input)` | `:319-337` | within 60 s of a boundary |
| `processRiskState(agentId, ts, env, reason)` | `:339-346` | from `RISK_VIOLATION` |
| `disposeAgent(agentId)` | `:348-358` | both `DEMO:` and `BACKTEST:` keys |
| `processPositionEvent(...)` | `:360-367` | `agentByPosition` mapping |
| `processTradingEvent(event, env, ts)` | `:369-378` | |
| `processOrderFill(input)` | `:380-383` | |
| `dispatchMarketInput(input)` | `:118-137` | fetches 1000 bars for `BAR_UPDATE` `:127` |
| `canFire(trigger, timestamp)` | `:431-443` | cooldown + per-minute cap |
| `markFired(trigger, timestamp)` | `:445-453` | |
| `safeSnapshot(state, indicators)` | `:513-525` | last 50 bars + indicator values |
| `redactMessage(...)` | `:527-529` | `bearer …` → `[REDACTED]` |
| `inputFromDomainEvent(event, now, sequence)` | `:484-505` | `MARKET_QUOTE` / `BAR_UPDATE` / `AGENT_ORDER_FILLED` only |

**`canFire` / `markFired` — exact rules (CONFIRMED)**

```
canFire(trigger, timestamp)                     engine.ts:431-443
   ├─ clock-wind: timestamp < lastFired
   │    → delete lastFired and firingHistory for the trigger     :432-437
   ├─ timestamp - lastFired < (trigger.cooldownMs ?? 1000) → false  :438
   └─ prune firings older than 60 000;
      times.length >= (trigger.maxFiringsPerMinute ?? 10) → false   :439-442
```

**`process` step order** — see
[Call Graph §6](../call-graph.md) and
[chains/pre-goat-trigger-to-agent-wake.md](../chains/pre-goat-trigger-to-agent-wake.md).

---

## `evaluateTrigger` — `evaluator.ts:38-78`

```
evaluateTrigger(trigger, input, state)                   evaluator.ts:38
   ├─ conditionTreeOf(trigger) is a GROUP node
   │    → evaluateConditionTreeTrigger(...)               evaluator.ts:49-53
   │        returns undefined unless the tree is TRUE now
   │        AND was not TRUE previously                   evaluator.ts:113-121
   │        → evaluateConditionTree                        conditions.ts:755
   └─ else: switch over 18 trigger types                   evaluator.ts:55-75
   ↓
state written back                                        evaluator.ts:76
Returns: string | undefined  (a reason string = fired)
```

**Trigger-type count: 18** in `TriggerType` `types.ts:4-9`, `SUPPORTED_TYPES`
`registry.ts:7-12`, `SUPPORTED_TRIGGER_TYPES` `botDefinition.ts:60-87`, and the switch
`evaluator.ts:56-73`.

**Latch fields held in the evaluation state**

| Field | Line | Semantics |
| --- | --- | --- |
| `previous` | `types.ts` / `evaluator.ts:12-26` | the prior definite status |
| `lastBar` | `evaluator.ts:155-157` | timeframe-bucket latch for `NEW_BAR` |
| `conditionTrees` | `evaluator.ts:113-121` | per-tree previous truth value |
| `proximity` | `evaluator.ts:332-338` | one-shot latch for stop/target proximity |
| `sessionStarts` / `sessionEnds` | `evaluator.ts:350-358` | one-shot sets |
| `lastSchedule` | `evaluator.ts:365-380` | `SCHEDULED` dedup |
| `lastSession` | `evaluator.ts:12-26` | |

---

## `conditions.ts` — the in-browser tree evaluator

`conditions.ts:1-63` states in its own header that this is the legacy evaluator and
that the Python engine is authoritative for builder previews (`:37-61`).

**Catalogue** — 9 kinds, `CONDITION_CATALOGUE` `:256-275`:
`PRICE_LEVEL`, `PRICE_CROSS`, `INDICATOR_THRESHOLD`, `INDICATOR_CROSS`, `BREAKOUT`,
`VOLATILITY`, `SPREAD`, `PROXIMITY`, `EVENT`.

**Statuses** — `ConditionStatus = TRUE | FALSE | UNKNOWN | DISABLED` `:202`.
`DISABLED` is browser-only and propagates through `evaluateNode` `:691-693`, `:709-711`.

**Functions**

| Function | Line |
| --- | --- |
| `evaluateConditionTree` | `:755-766` |
| `evaluateNode` | `:689-714` |
| `evaluateLeaf` | `:388-616` — one case per kind |
| `combine` (UNKNOWN contagion) | `:716-740` |
| `flatten` | `:742-748` |
| `summariseTree` / `summariseNode` | `:831-838` / `:840-857` |
| `describe` | `:789-824` |
| `validateConditionTree` | `:916-973` |
| `walkTree` / `countConditions` / `countGroups` | `:887-897` / `:899-905` / `:907-913` |
| `conditionId` (module `let idCounter = 0` at `:863`) | `:865-868` |
| `indicatorValue` | `:347-381` |
| `lastPair` (named pair, avoids tuple-order bugs) | `:646-663` |
| `withinTolerance` | `:302-305` |
| `seriesFor` | `:618-628` |
| `positionFor` | `:383-386` |
| `readEventType` / `labelForEvent` | `:665-671` / `:673-680` |
| `barCloses` / `atrSeries` | `:314-327` / `:329-336` |

**Indicators used** — `src/engine/indicators/index.ts`:
`calculateSMA` `:8`, `calculateEMA` `:27`, `calculateRSI` `:48`, `calculateMACD` `:97`,
`calculateATR` `:181`, `calculateRMA` `:166`, `calculateBollingerBands` `:134`.

---

## `proximity.ts`

| Symbol | Line |
| --- | --- |
| `ProximityLevel` | `:29` |
| `ProximityPosition` | `:31-39` |
| `ProximityConfig` (`withinPrice\|withinPips\|withinTicks\|withinPercent\|withinValue`) | `:41-52` |
| `ProximityLimit` | `:54-59` |
| `ProximityEvaluation` | `:61-72` |
| `evaluateProximity` | `:91-237` |
| `withinLimit` (1e-9 relative tolerance) | `:248-251` |
| `describeProximity` | `:258-279` |

**Any unmeasurable threshold blocks the whole evaluation** — `proximity.ts:212-229`.

---

## Depends on

| Module | Imports |
| --- | --- |
| Agent Runtime | `AgentInstance` shape via the injected `resolveAgent`; the wake callback captures the runtime (`engine.ts:57`) |
| Conditions (contract) | `botDefinition.ts:1034-1039` → `validateConditionTree` (reverse direction) |
| Indicators | `evaluator.ts:1` → `src/engine/indicators/index.ts` |
| Services & State | `eventBus` via `types/events.ts` |
| UI | `TriggerBuilder` imports the evaluator and proximity helpers directly |

## Used by

| Consumer | Line |
| --- | --- |
| `App` (owns the instances) | `App.tsx:99-107`, `:1192`, `:1462`, `:155` |
| `AgentRuntime` | receives the wake via the injected `delivery` — `engine.ts:71` |
| Trigger Lab UI | `components/triggers/TriggerBuilder.tsx:96` |
| `botDefinition` | `validateBotTrigger` `botDefinition.ts:984-1041` |
| Test runners | `triggers/tests.ts`, `triggers/conditionTests.ts`, `triggers/auditRegressionTests.ts`, `agents/tests.ts`, `pipelineAcceptance.ts` (all test-only) |

## Reads

`registry.ts`: the injected `resolveAgent` closure (`App.tsx:100` → `agentRuntime.getAgent`).
`engine.ts`: `eventBus` (via `onAll`), `runtime.listAgents()` `:81`, `runtime.getAgent()` `:71`.

## Writes

`registry.ts`: `triggers` `:33`, `bySymbol` `:37`, `unscoped` `:38`, and the stored
trigger's `enabled` / `updatedAt` `:92-98`.
`engine.ts`: `evaluationStates` `:209-211`, `lastFired` `:445-453`,
`firingHistory` `:448`, `inFlightTriggers` `:219` / `:260`,
`processedEvents` `:200`, `recentInputIds` `:165-176`, `instrumentCache` `:394-408`,
`agentByPosition` `:51`, `domainEventSequence` `:487`, `unsubscribe` `:78`.

## Mutates

The evaluator's latch fields, written back at `evaluator.ts:76`.

## Emits

None directly. The engine writes to the agent timeline (`engine.ts:241`) and, through
`delivery.wake`, to `AgentRuntime`, which emits `AGENT_*` events.

## Subscribes to

`eventBus.onAll(...)` — `engine.ts:78`. Torn down by `stop()` `:147-150`.

## External dependencies

None. This module performs no network or storage I/O.

## Entry points

`TriggerEngine.start` `engine.ts:76` · `TriggerEngine.ingest` `:141` ·
`TriggerEngine.process` `:178` · `TriggerRegistry.register` `registry.ts:23` ·
`evaluateTrigger` `evaluator.ts:38` · `evaluateConditionTree` `conditions.ts:755`.

## Exit points

`delivery.wake(...)` → `AgentRuntime.handleEvent` `runtime.ts:1710`.
