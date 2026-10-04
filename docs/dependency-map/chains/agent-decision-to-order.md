# Chain: Agent Decision → Order

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** `AgentRuntime.step(agentId, event)`, reached from a trigger wake or from
the backtest replay loop.

**Confidence:** CONFIRMED. Which specific `finalDecision` an agent produces depends on
the LLM response and is therefore DYNAMIC; the gate order is fixed.

---

```
[1] AgentRuntime.step(agentId, event?)                     runtime.ts:389-412
    ├─ instance lookup; throw if missing                    runtime.ts:393-397
    ├─ if activeCycles.has(agentId) → throw
    │    "already processing a cycle"                       runtime.ts:399-403
    ├─ activeCycles.add(agentId)                            runtime.ts:405
    └─ return runStep(...)  finally activeCycles.delete     runtime.ts:408-411
```

## Stage 1 — wake normalisation and correlation

| | |
| --- | --- |
| **Input** | `event?: AgentWakeEvent` |
| **Action** | default wake `{ type:'MANUAL_TRIGGER', timestamp: Date.now(), symbol: symbols[0] }` — `runtime.ts:419-424`; `triggerId` from `event.data.triggerId`; `correlationId` from `event.data.correlationId` or a generated fallback — `runtime.ts:426-440` |
| **Mutation** | none yet |

## Stage 2 — observation

```
[2] this.observe(agentId)                                   runtime.ts:264-382  (called :445)
    ├─ symbol = instance.agent.symbols[0] || 'EURUSD'       runtime.ts:271
    ├─ policy boundary: every configured symbol must be in
    │    policy.allowedSymbols when the list is non-empty    runtime.ts:273-285
    ├─ env.getMarketQuote(symbol)                           runtime.ts:287
    ├─ env.getMarketBars(symbol, agent.timeframe || '5m', 15)  runtime.ts:289-293
    │    └─ bar sanity: all OHLC + time must be finite       runtime.ts:295-305  (else throw)
    ├─ quote sanity: bid>0, ask>=bid, all finite            runtime.ts:307-317  (else throw)
    ├─ env.getAccountState()                                runtime.ts:319
    ├─ env.getPositions()                                   runtime.ts:320
    ├─ env.getOrders()                                      runtime.ts:321
    ├─ account finiteness check                             runtime.ts:323-334
    └─ if 'market.getSession' ∈ allowedCapabilities:
         capabilities.execute('market.getSession', …)        runtime.ts:338-361
    ↓
    AgentObservation { timestamp, environment,
       market{quotes, quote, recentBars, spread, session},
       account, positions, orders,
       availableCapabilities, availableSkills,
       recentMemories }                                     runtime.ts:363-381
```

**Clock selection (CONFIRMED)** — `nowFor(instance)` `runtime.ts:1371-1382`:
if `env.mode === 'BACKTEST'` the observation timestamp is the backtest bar's timestamp;
otherwise `Date.now()`.

**Failure path** — a throw inside `observe` produces a timeline `ERROR` with
`code: 'OBSERVATION_ERROR'` (`runtime.ts:452-462`), an `AGENT_ERROR` emit
(`:464-471`), and returns `WAIT` (`:473-477`). No model call, no order.

**Memory read** — `instance.memory.export()` is embedded as
`recentMemories` (`runtime.ts:381`).

## Stage 3 — observation timeline

`timeline.append({ type: 'OBSERVATION', data: observationSnapshot(observation) })` —
`runtime.ts:480-488`; `observationSnapshot` trims bars to the last 50
(`runtime.ts:1922-1949`).

## Stage 4 — the reasoning loop

```
[4] for iteration in 0..maxIterations(=5)                   runtime.ts:497-508
    ├─ eventBus.emit({type:'AGENT_REASONING', …})           runtime.ts:510-517
    │
    ├─ await this.model.run({ … })                          runtime.ts:522-548
    │    payload: agent, observation, instructions, skillsInstructions,
    │             toolHistory, capabilitySchemas, iteration, wakeReason
    │    capabilitySchemas built from
    │      capabilities.get(id).description / .inputSchema    runtime.ts:528-542
    │    ↓ agentModel.run                                   agents/model/openrouter.ts:6
    │    ↓ openRouterProvider.chat                          adapters/openrouter/provider.ts:150
    │    ↓ await fetch(openrouter)                          provider.ts:194
    │
    ├─ model throws → WAIT (:555-559), AGENT_ERROR (:561-568),
    │                  timeline ERROR {code:'MODEL_ERROR'} (:570-581), break (:583)
```

`IAgentModel` is constructor-injected at `runtime.ts:57` with the default
`agentModel` (`agents/model/openrouter.ts`).

### Branch 4a — tool call

```
[4a] tool-call branch                                       runtime.ts:589-785
     ├─ malformed capabilityId/input → error into toolHistory, continue  :595-611
     ├─ capability ∉ instance.allowedCapabilities
     │    → "Permission denied" entry, continue             :613-624
     ├─ capability = this.capabilities.get(capId)           :626
     ├─ if capability.category === 'execution':
     │      await this.observe(agentId)                     :628-631
     ├─ await this.validateExecutionTool(instance, toolObservation, capId, input)  :633-641
     │    → implementation runtime.ts:1508-1704
     │       orders.market        → synthesise an OPEN_POSITION decision :1515-1544
     │                                → validator.validate       :1549
     │                                → riskManager.validateOrder :1561  (recordAcceptedOrder=false)
     │       positions.close      → position must exist       :1606-1613
     │       positions.partialClose → 0 < volume ≤ position   :1615-1635
     │       positions.modify*    → MODIFY_POSITION validation :1649-1684
     │       orders.limit / orders.cancel → always INVALID_PARAMS :1686-1696
     │       anything else        → UNKNOWN_CAPABILITY       :1698-1703
     │    invalid → toolHistory REJECTED (:643-655),
     │              timeline RISK_CHECK {status:'REJECTED'} (:657-669), continue (:671)
     ├─ eventBus.emit({type:'AGENT_TOOL_REQUESTED'})        :674-682
     ├─ timeline CAPABILITY_CALL                            :684-695
     ├─ await this.capabilities.execute(capId, input, ctx)  :702-717 → registry.ts:34
     │      validateCapabilityInput  registry.ts:59
     │      validateCapabilityScope  registry.ts:93
     │      capability.execute(input, ctx)   e.g. capabilities/execution.ts:26
     │         └─ env.placeMarketOrder(...)  environment/demo.ts:42 → demo.ts:442
     ├─ duration: BACKTEST uses the env clock               :727-734
     ├─ toolHistory.push(sanitised)                         :736-741
     ├─ eventBus.emit({type:'AGENT_TOOL_RESULT'})           :743-751
     ├─ timeline CAPABILITY_RESULT                          :753-766
     │    (error results also timeline ERROR {code:'CAPABILITY_ERROR'} :768-782)
     └─ continue                                            :784
```

### Branch 4b — decision

```
[4b] decision branch                                        runtime.ts:790-874
     ├─ isAgentDecision(decision) guard (runtime.ts:1794)
     │    malformed → WAIT + break                          :791-799
     ├─ ANALYZE: capability must be BOTH in
     │    instance.allowedCapabilities AND registered         :809-826
     │    executed, result into toolHistory, continue         :828-867
     └─ otherwise finalDecision = decision; break            :870-873

     (no model response at all → break)                      :876
```

`AgentDecision` shape — `agents/types.ts:161-194`; the action union at
`types.ts:243` (`AgentAction`).

## Stage 5 — instrument resolution and policy validation

```
[5] resolveInstruments(instance)                            runtime.ts:886-887 → :1352-1369
    (reads env.getInstruments() when the environment exposes it)
    ↓
[6] instance.validator.validate(finalDecision, agent.policy, observation,
                                { instruments })               runtime.ts:893-899
        → policy/validator.ts:40-279   (18 ordered checks)
```

`ActionValidator` check order (`policy/validator.ts:40`):

| # | Check | Line | Code on failure |
| --- | --- | --- | --- |
| 1 | `WAIT` is always valid | `:47-49` | — |
| 2 | `ANALYZE` capability must be available | `:52-61` | `UNKNOWN_CAPABILITY` |
| 3 | `!policy.allowTrading` + `OPEN_POSITION` | `:64-70` | `TRADING_DISABLED` |
| 4 | orders-per-minute rate limit | `:73-83` | `RATE_LIMITED` |
| 5 | daily loss | `:86-95` | `POLICY_VIOLATION` |
| 6 | drawdown | `:97-103` | `POLICY_VIOLATION` |
| 7 | finite positive volume + positive finite stop | `:108-110` | `INVALID_PARAMS` |
| 8 | BUY stop below ask | `:111-113` | `INVALID_PARAMS` |
| 9 | SELL stop above bid | `:114-116` | `INVALID_PARAMS` |
| 10 | symbol in `policy.allowedSymbols` | `:119-125` | `DISALLOWED_SYMBOL` |
| 11 | session in `policy.allowedSessions` | `:128-141` | `DISALLOWED_SESSION` |
| 12 | open positions < `maxOpenPositions` | `:144-150` | `POLICY_VIOLATION` |
| 13 | exposure incl. the intended leg | `:154-186` | `POLICY_VIOLATION` |
| 14 | exposure cap | `:188-194` | `POLICY_VIOLATION` |
| 15 | mandatory stop-loss recheck | `:198-204` | `INVALID_PARAMS` |
| 16 | instrument-aware risk available | `:220-234` | `POLICY_VIOLATION` |
| 17 | dollar risk ≤ `equity * maxRiskPerTrade` | `:236-244` | `POLICY_VIOLATION` |
| 18 | record the order timestamp, approve | `:247-248` | `APPROVED` |

`MODIFY_POSITION` `:251-264`; `CLOSE_POSITION` `:266-276`; fallback approve `:278`.
`referencePrice(observation, symbol)` `:14-27` asks first then falls back to bid — the
agent never supplies the reference price.

**Mutation (CONFIRMED)** — `recentOrderTimestamps` is pushed on approval
(`policy/validator.ts:247-248`).

## Stage 6 — the deterministic risk gate

```
[7] only for OPEN_POSITION:
    riskManager.validateOrder({symbol, side, volume, stopLoss, takeProfit},
                              observation.positions, false, {
                                instruments:   lookupFrom(...),
                                referencePrices: referencePricesFrom(observation)
                              })                                 runtime.ts:901-932
        → execution/risk.ts:139-204
    invalid → validation is OVERRIDDEN to
             { valid: false, code: 'RISK_REJECTED', reason }     runtime.ts:925-931
```

**`RISK_REJECTED` is produced by the runtime, not by the validator.**

`RiskManager.validateOrder` order (`execution/risk.ts:139`):

| # | Check | Line | Code |
| --- | --- | --- | --- |
| 1 | kill switch | `:149-153` | `KILL_SWITCH` |
| 2 | max single order size | `:156-160` | `ORDER_SIZE_INVALID` |
| 3 | max concurrent positions | `:163-167` | `MAX_POSITIONS_EXCEEDED` |
| 4 | exposure via `validateExposure` → `aggregateExposure` | `:171-184` | `EXPOSURE_LIMIT_EXCEEDED`, `MARKET_DATA_UNAVAILABLE` |
| 5 | orders per minute | `:187-193` | `RATE_LIMITED` |
| 6 | daily loss | `:196-200` | `DAILY_LOSS_LIMIT` |
| 7 | record timestamp + approve | `:202-203` | — |

`recordAcceptedOrder = false` here means the risk manager does **not** push its own
order timestamp on this path; the policy validator owns that.

Daily-loss rollover: `rollDailyPnLIfNeeded` `risk.ts:60-66` resets on a UTC-day change
on both read and write.

## Stage 7 — RISK_CHECK timeline

`runtime.ts:934-963` — `NOT_REQUIRED` for `WAIT`, otherwise `PASS` or `REJECTED`.

## Stage 8 — execution

```
[8] if validation.valid && validation.code === 'APPROVED'   runtime.ts:970
    ├─ OPEN_POSITION:
    │    await instance.env.placeMarketOrder({
    │        symbol, side, volume, stopLoss, takeProfit,
    │        comment: `Agent: ${agent.name}` })              runtime.ts:978-986
    │       → environment/demo.ts:42-51 → demo.ts:442
    │    eventBus.emit({type:'AGENT_ORDER_SUBMITTED'})       runtime.ts:988-995
    │    timeline ORDER                                      runtime.ts:1002-1039
    │    on success and a string positionId:
    │       positionCorrelations.set(positionId, {agentId, triggerId, correlationId})
    │                                                        runtime.ts:1050-1057
    │       timeline POSITION_UPDATE {status:'OPENED'}       runtime.ts:1059-1076
    │       eventBus.emit({type:'AGENT_ORDER_FILLED'})       runtime.ts:1079-1101
    ├─ MODIFY_POSITION → env.modifyPosition(positionId, changes)   runtime.ts:1107-1111
    ├─ CLOSE_POSITION  → env.closePosition(positionId)            runtime.ts:1116-1119
    ├─ { success: false, error } → cycleError                   runtime.ts:1122-1129
    └─ throw → AGENT_ERROR + timeline ERROR {code:'EXECUTION_ERROR'}  runtime.ts:1130-1163
```

## Stage 9 — memory, audit, timeline

```
[9] memory writes                                            runtime.ts:1169-1210
    ├─ lastDecision                                          :1169
    ├─ decisionHistory.push(decision)                        :1174-1181
    ├─ lastDecisionTimestamp                                 :1183
    ├─ lastWakeEvent                                         :1188
    ├─ lastCycleAt                                           :1193
    └─ lastActionResult                                      :1198-1210
    ↓
[10] audit record + emits                                   runtime.ts:1215-1243
    ├─ AGENT_OBSERVED                                        :1245-1251
    ├─ AGENT_DECISION                                        :1256-1263
    └─ AGENT_ACTION_APPROVED / _REJECTED (non-WAIT)          :1265-1287
    ↓
[11] auditLog.unshift + cap 200                             runtime.ts:1289-1296
    ↓
[12] timeline DECISION                                      runtime.ts:1298-1313
    ↓
[13] post-fill position lookup + notifyAgentPosition(...,
        'POSITION_OPEN', …)                                  runtime.ts:1315-1342
    ↓
[14] return finalDecision                                    runtime.ts:1344
```

## Gate summary — the invariant

```
model output
   ↓
capabilities.execute  (tool path, execution category re-observes + pre-validates)
   ↓
ActionValidator.validate        policy/validator.ts:40
   ↓
RiskManager.validateOrder       execution/risk.ts:139
   ↓
ITradingEnvironment  →  adapter  →  simulated fill
```

**CONFIRMED** — there is no code path from the model to the adapter that skips the
policy validator or the risk manager. `validateExecutionTool` (`runtime.ts:1508`)
repeats both gates for the execution-category tool path specifically.

## State summary

| State | Written at | Read by |
| --- | --- | --- |
| `instance.memory` | `runtime.ts:1169-1210` | `observation.recentMemories` `:381` |
| `auditLog` | `runtime.ts:1289` | `getAuditTrail` `:1766` |
| `positionCorrelations` | `runtime.ts:1050`, deleted `:1502` | `:1443`, `:1481` |
| `actionValidator.recentOrderTimestamps` | `policy/validator.ts:247-248` | `:73-83` |
| `riskManager.currentDailyPnL` | `risk.ts:124` (on realised P&L) | `:196` |
| adapter positions/account | `demo.ts` | App effect #8, other agents |
| timeline | `runtime.ts:480, 684, 753, 934, 1002, 1298` | `handleGetBotActivity` `App.tsx:1723` |

## Exit points

- `eventBus` `AGENT_ORDER_SUBMITTED` / `AGENT_ORDER_FILLED` →
  `TriggerEngine.processOrderFill` `engine.ts:380-383` → `ORDER_FILLED` triggers.
- App effect #8 mirrors the new position into React state.
- Nothing is sent to any external order endpoint.
