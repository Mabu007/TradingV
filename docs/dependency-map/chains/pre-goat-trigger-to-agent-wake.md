# Chain: Trigger Fire → Agent Wake

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** any domain event on the `eventBus` that the `TriggerEngine` recognises.

**Confidence:** CONFIRMED for the code path. The *set* of triggers that fire at runtime
depends on user configuration and is therefore DYNAMIC.

---

```
[1] eventBus.emit({ type: 'MARKET_QUOTE' | 'BAR_UPDATE' | 'AGENT_ORDER_FILLED', … })
```

## Stage 0 — the subscription

`triggerEngine.start()` — `src/engine/agents/triggers/engine.ts:76-116`

| | |
| --- | --- |
| **Input** | none |
| **Action** | idempotent guard `:77`; `eventBus.onAll(...)` `:78` |
| **Mutation** | `this.unsubscribe` `:78`; `this.delivery` was built in the constructor `:64-73` |
| **Started by** | `App.tsx:155` (`ensureTriggerEngineStarted`), called from effect #1 `:399-409` and from `handleCreateBot` `:1198` / `handleToggleBotStatus` `:1014` |
| **Environment** | `triggerEngine.setEnvironment('DEMO')` at `App.tsx:109` sets `sourceEnvironment` — `engine.ts:139` |

## Stage 1 — input construction

`engine.ts:78-137` has two paths.

**Path A — `MARKET_QUOTE`** (`engine.ts:80-110`)

```
[1a] eventBus MARKET_QUOTE
     ↓ iterate runtime.listAgents()                        engine.ts:81
     ↓ filter: agent.env.mode === sourceEnvironment        engine.ts:82
     ↓ filter: agent.symbols includes quote.symbol
     ↓ build quoteEvent with delivery id
     │    `quote:${symbol}:${ts}:${agentId}`               engine.ts:102-105
     ↓
     this.process(input)                                   engine.ts:106
```

The delivery id is **agent-scoped**, so N agents produce N separate `process` calls for
the same quote.

**Path B — everything else** (`engine.ts:111-113`)

```
[1b] inputFromDomainEvent(event, now, sequence)            engine.ts:484-505
     ├─ MARKET_QUOTE     → :485-489
     ├─ BAR_UPDATE       → :490-494
     ├─ AGENT_ORDER_FILLED → :495-502
     └─ anything else    → undefined   (chain stops here)
     ↓
     dispatchMarketInput(input)                            engine.ts:113 → :118-137
       ├─ filter active agents by symbol + env             :121-133
       ├─ for BAR_UPDATE with a timeframe:
       │    fetch 1000 bars from env.getMarketBars         engine.ts:127
       │    attach them to the input                       :128
       └─ re-key the input per agent                       :134
       ↓
       this.process(input)                                 engine.ts:116
```

**Also direct entry points to `process`** (not via `onAll`):
`ingest(event, environment)` `engine.ts:141-145`; `tickScheduled(timestamp, environment)`
`engine.ts:269-317`; `processPositionEvent(...)` `engine.ts:360-367`;
`processTradingEvent(...)` `engine.ts:369-378`; `processOrderFill(...)` `engine.ts:380-383`.

## Stage 2 — candidate selection and gating

`TriggerEngine.process` — `engine.ts:178-267`

| Step | Line | Rule |
| --- | --- | --- |
| refuse `CUSTOM` | `:179-182` | records a `TRIGGER_ERROR` and returns `[]` |
| validate input | `:183-186` | environment must match; timestamp finite; id present; `state.symbol` a string; symbols agree; not LIVE |
| delivery key | `:187` | `` `${input.environment}:${input.id}` `` |
| candidates | `:188` | `registry.candidates(symbol)` (`registry.ts:83`) = `unscoped ∪ bySymbol.get(symbol)` |
| filter | `:188-192` | by `agentId`, `enabled`, symbol, timeframe, explicit `triggerId` |
| sort | `:193` | by `priority`, then by id |
| dedup | `:196-201` | `processedEvents.get(triggerId)`; cleared when the set exceeds 10 000 `:199` |
| agent gates | `:203-205` | `agent.enabled`, `agent.isRunning`, `agent.env.mode === input.environment` |
| type↔input compatibility | `:206-208` | proximity/position triggers require `POSITION_OPEN\|POSITION_UPDATE\|POSITION_CLOSE`; `ORDER_FILLED` requires an `ORDER_FILLED` input |
| evaluation state | `:209-211` | created for `` `${environment}:${trigger.id}` `` if absent |
| bar bound | `:214` | the input's bars are truncated to the last 1000 |
| evaluate | `:215` | `evaluateTrigger(trigger, boundedInput, evaluationState)` |

## Stage 3 — evaluation

`evaluateTrigger` — `src/engine/agents/triggers/evaluator.ts:38-78`

```
[3] evaluateTrigger(trigger, input, state)                 evaluator.ts:38
    ├─ if trigger.conditionTree is a GROUP node:            evaluator.ts:49-53
    │     → evaluateConditionTreeTrigger(trigger, input, state)  evaluator.ts:101
    │         (edge-triggered: returns undefined unless the tree
    │          is TRUE now and was not TRUE previously)     evaluator.ts:113-121
    │     → evaluateConditionTree → evaluateNode → evaluateLeaf  conditions.ts:755, :689, :388
    │         → calculateSMA / EMA / RSI / ATR / MACD       engine/indicators/index.ts
    │
    └─ else: switch over 18 trigger types                   evaluator.ts:55-75
          NEW_BAR             :56  → evaluateNewBar            :148
          PRICE_THRESHOLD     :57  → evaluatePriceThreshold    :161
          PRICE_CROSS         :58  → evaluatePriceCross        :172
          INDICATOR_CROSS     :59  → evaluateIndicatorCross    :183
          BREAKOUT            :60  → evaluateBreakout          :244
          SPREAD_CHANGE       :61  → evaluateSpread            :264
          VOLATILITY_CHANGE   :62  → evaluateVolatility        :276
          POSITION_UPDATE     :63  → evaluatePositionUpdate    :290
          POSITION_OPEN       :64  → inline
          POSITION_CLOSE      :65  → inline
          RISK_STATE_CHANGED  :66  → inline
          ORDER_FILLED        :67  → inline (requires state.order.status === 'FILLED')
          STOP_APPROACHING    :68  → evaluatePositionProximity(…,'stopLoss')  :310
          TARGET_APPROACHING  :69  → evaluatePositionProximity(…,'takeProfit')
          SESSION_START       :70  → evaluateSession(…, true)   :343
          SESSION_END         :71  → evaluateSession(…, false)  :343
          SCHEDULED           :72  → evaluateScheduled          :362
          CUSTOM              :73  → evaluateCustom             :392
          default             :74  → assertNever
    ↓
    state written back                                      evaluator.ts:76
    Returns: string | undefined  (a reason string = "fired")
```

**Latch state is held in the evaluation state object, not the engine** —
`state.lastBar` (`evaluator.ts:155-157`), `state.conditionTrees` (`:113-121`),
`state.proximity` (`:332-338`), `state.sessionStarts` / `sessionEnds` (`:350-358`),
`state.lastSchedule` (`:365-380`).

**Note (CONFIRMED)** — the trigger-type count is **18** in `TriggerType`
(`triggers/types.ts:4-9`), `SUPPORTED_TYPES` (`registry.ts:7-12`),
`SUPPORTED_TRIGGER_TYPES` (`botDefinition.ts:60-87`), and the switch
(`evaluator.ts:56-73`).

## Stage 4 — the fire gate

```
[4] canFire(trigger, timestamp)                             engine.ts:431-443
    ├─ clock-wind detection: timestamp < lastFired
    │    → delete lastFired and firingHistory for that trigger   engine.ts:432-437
    ├─ cooldown: timestamp - lastFired < (trigger.cooldownMs ?? 1000) → refuse   :438
    └─ per-minute cap: prune firings older than 60 000;
         times.length >= (trigger.maxFiringsPerMinute ?? 10) → refuse           :439-442
    ↓ passes
    markFired(trigger, timestamp)                           engine.ts:445-453
    ↓ mutates lastFired + firingHistory
```

**Default cooldown is 1000 ms when `cooldownMs` is unset** (`engine.ts:438`).
**Default per-minute cap is 10** (`engine.ts:441`).

`inFlightTriggers` provides the re-entrancy gate: `engine.ts:218` refuses, `:219` adds,
`:260` deletes in a `finally`.

## Stage 5 — event construction

```
[5] build AgentTriggerEvent                                  engine.ts:222-238
    ├─ marketSnapshot: safeSnapshot(state,
    │      calculateTriggerIndicators(trigger, input))       engine.ts:222, :513-525
    │     (last 50 bars + indicator values; evaluator.ts:144
    │      → computeConfiguredIndicators :206 → assignIndicator :221)
    └─ data: { triggerId, triggerType, reason, sourceEventId, correlationId }
    ↓
    pushed to `fired`                                         engine.ts:239
    ↓
    timeline.append(TRIGGER)                                  engine.ts:241
```

**correlationId precedence** (`engine.ts:69`, and again at `:245-250`):

1. `` `${agentId}:trade:${tradeId}` `` (for an `AGENT_ORDER_FILLED` input)
2. `` `${agentId}:position:${positionId}` ``
3. `` `${agentId}:${triggerId}:${timestamp}` ``

## Stage 6 — delivery (fire → wake)

```
[6] await this.delivery.wake(triggerEvent)                   engine.ts:252
    delivery was built in the constructor                    engine.ts:64-73:
      wakeType(triggerType) maps 18 trigger types → 13 wake types  engine.ts:466-482
        NEW_BAR             → NEW_BAR
        PRICE_CROSS / PRICE_THRESHOLD → PRICE_THRESHOLD
        POSITION_OPEN       → POSITION_OPENED
        POSITION_UPDATE / POSITION_CLOSE → TRIGGER_FIRED
        STOP_APPROACHING    → POSITION_APPROACHING_STOP
        TARGET_APPROACHING  → POSITION_REACHED_PROFIT_TARGET
        ORDER_FILLED        → ORDER_FILLED
        SPREAD_CHANGE       → SPREAD_CHANGED
        SESSION_START / SESSION_END → SESSION_CHANGED
        RISK_STATE_CHANGED  → RISK_STATE_CHANGED
        SCHEDULED           → TIMER_TICK
        (default)           → TRIGGER_FIRED
      if runtime.getAgent(agentId)?.isRunning
        → await runtime.handleEvent(agentId, event)          engine.ts:71
    ↓
AgentRuntime.handleEvent                                    runtime.ts:1710
    ├─ agent registered AND isRunning                       runtime.ts:1717-1722
    ├─ wake type ∈ a 12-value allow-list                    runtime.ts:1724-1738
    └─ event symbol ∈ agent.symbols (unless the event has none)  runtime.ts:1748-1756
    ↓ await step(agentId, event)                            runtime.ts:1758
```

`AgentWakeEventType` — 13 values, `agents/types.ts:217-230`.
`handleEvent`'s allow-list is 12 values (`runtime.ts:1724-1738`).

## Stage 7 — wake failure handling

| Failure | Handling | Line |
| --- | --- | --- |
| `evaluateTrigger` throws | `recordError` and skip | `engine.ts:217` |
| `delivery.wake` throws | timeline `ERROR { code: 'AGENT_WAKE_ERROR' }`, `recordError`; `inFlightTriggers.delete` in a `finally` | `engine.ts:253-260` |
| any other throw in `process` | outer catch | `engine.ts:261-264` |

## State summary

| State | Written at | Reset |
| --- | --- | --- |
| `TriggerEngine.evaluationStates` | `engine.ts:209-211` | `disposeAgent` `:348`; `dispose` `:32-42` |
| `TriggerEngine.lastFired` | `engine.ts:445-453` | clock-wind `:432-437` |
| `TriggerEngine.firingHistory` | `engine.ts:448` | 60 s prune `:439-441` |
| `TriggerEngine.inFlightTriggers` | `engine.ts:219` | `finally` `:260` |
| `TriggerEngine.processedEvents` | `engine.ts:200` | `clear()` at >10 000 `:199` |
| evaluator latch fields | `evaluator.ts:76` | `disposeAgent` |
| timeline | `engine.ts:241` | per-store |
| `AgentInstance.isRunning` | `runtime.ts:215`, `:243` | — |

## Exit point

`AgentRuntime.step` — the agent cycle, documented in
[agent-decision-to-order.md](agent-decision-to-order.md).
