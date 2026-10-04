# Chain: Position Close

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** one of three user actions — the position detail modal's close button, the
kill switch "Close All", or the AI copilot's "Confirm and close {symbol}" button.

**Confidence:** CONFIRMED.

---

```
[1] one of:
    ├─ PositionDetailModal.onClosePosition     TradesTab.tsx:316 → modal :45
    ├─ KillSwitchModal "Close All Positions"   KillSwitchModal.tsx:77
    └─ FloatingAIAssistant "Confirm and close" FloatingAIAssistant.tsx:463-481
       ↓ all three converge on
[2] App.handleClosePosition(positionId)                   App.tsx:916-943
```

## Stage 1 — App handler

| | |
| --- | --- |
| **Input** | `positionId: string` |
| **Action** | `await hyperliquidDemoAdapter.closePosition(positionId)` — `App.tsx:926` |
| **On failure** | `eventBus.emit({type:'LOG', id:'close-rejected:…'})` — `App.tsx:931-941` |
| **Mutation** | none in App state — the mirror effect performs the writes |
| **Evidence** | `App.tsx:916-943` |

`handleClosePosition` is passed down unchanged in three places:
`TradesTab.onClosePosition` `App.tsx:2317`;
`PositionDetailModal.onClosePosition` via `TradesTab.tsx:316`;
`FloatingAIAssistant.onClosePosition` `App.tsx:2656`.

## Stage 2 — the adapter

`hyperliquidDemoAdapter.closePosition(positionId)` — `src/adapters/hyperliquid/demo.ts`

```
[2] closePosition(positionId)
    ├─ kill-switch gate
    ├─ remove from this.positions
    ├─ compute realised P&L
    ├─ this.trades.unshift(trade)  (or push)
    └─ eventBus.emit({ type: 'POSITION_CLOSE',
                       data: { position, trade } })          demo.ts
```

| | |
| --- | --- |
| **Mutation** | adapter `positions`, adapter `trades`, adapter account balance |
| **Downstream** | `riskManager.recordPnL(...)` — `execution/risk.ts:122-126`; this is what feeds the daily-loss budget |
| **Output** | one `eventBus` emission |

## Stage 3 — the execution mirror effect

```
[3] eventBus 'POSITION_CLOSE' → App effect #8 listener       App.tsx:819
    ├─ trades.unshift(event.data.trade)                       App.tsx:822-828
    │     (deduplicated by trade id)
    └─ refreshFromAdapter()                                   App.tsx:834
          ├─ hyperliquidDemoAdapter.getPositions()            App.tsx:796
          │     └─ setPositions(...)                          App.tsx:798
          └─ hyperliquidDemoAdapter.getAccountState()         App.tsx:802
                ├─ setBalance(...)                            App.tsx:804
                ├─ setMargin(...)                             App.tsx:805
                └─ setFreeMargin(...)                         App.tsx:806
```

| | |
| --- | --- |
| **Mutation** | `App.trades` `:221-222`; `App.positions` `:218-219`; `App.balance/margin/freeMargin` `:194-207` |
| **Memo** | `equity` recomputes — `App.tsx:763-778` |

## Stage 4 — downstream consumers of the closed trade

| Consumer | Line |
| --- | --- |
| `TradesTab.trades` | `App.tsx:2309` |
| `HistoryTab.trades` | `App.tsx:2553` |
| `QuotesTab.trades` | `App.tsx:2387` |
| `accountStats.tradesCount` memo | `App.tsx:2635` |
| AI context `trades[]` | `App.tsx:1869`, `:1902` |
| AI tool `getRecentTrades(limit)` | `services/aiContext/tools.ts:65` |
| `equity` memo | `App.tsx:763` |

## Stage 5 — engine consumers

### 5a. `AgentRuntime` (constructor subscription)

```
AgentRuntime constructor → eventBus.on('POSITION_CLOSE')     runtime.ts:71-77
   → recordPositionEvent(positionId, 'CLOSED',
                          { position, tradeId })
   → timeline record
```

The corresponding unsubscribe closures are not captured — no teardown path exists
(`runtime.ts:60-77`).

### 5b. `TriggerEngine`

```
TriggerEngine.onAll handler                                   engine.ts:78
   → processPositionEvent(...)                                 engine.ts:360-367
       ├─ agentByPosition.set(positionId, agentId)             engine.ts:51
       ├─ dedup via recentInputIds                             engine.ts:52
       └─ resolveInstrument via withInstrument/resolveInstrument  engine.ts:394-429
   → this.process(input)                                       engine.ts:178
       → POSITION_CLOSE triggers                               evaluator.ts:65
       → POSITION_UPDATE triggers                              evaluator.ts:63
       → STOP_APPROACHING / TARGET_APPROACHING (proximity latch)  evaluator.ts:68-69
```

`AgentRuntime` also deletes its correlation record:
`positionCorrelations.delete(positionId)` — `runtime.ts:1502`.

## The three entry points, side by side

| Entry | UI site | Handler | Notes |
| --- | --- | --- | --- |
| Single position | `TradesTab` → `PositionDetailModal` close button | `App.tsx:916` | the modal's own close |
| Bulk | `KillSwitchModal` "Close All Positions" — `KillSwitchModal.tsx:77` | `App.handleEmergencyKillSwitch` `App.tsx:1740` | `positions.forEach(p => handleClosePosition(p.id))` at `App.tsx:1771`, with `.catch` collectors at `:1772-1777` |
| AI-confirmed | `FloatingAIAssistant` "Confirm and close {symbol}" — `FloatingAIAssistant.tsx:463-481` | `App.tsx:916` | gated behind `setActionableTrade` — `FloatingAIAssistant.tsx:247` — which is set only when the model response is parsed as a close request |

## Bulk-close detail (CONFIRMED)

`handleEmergencyKillSwitch` — `App.tsx:1740-1807`:

| Step | Line | Action |
| --- | --- | --- |
| 1 | `:1751` | `riskManager.setKillSwitch(true)` — first, so any in-flight order is blocked |
| 2 | `:1758` | `setIsKillSwitchActive(riskManager.isKillSwitchActive())` |
| 3 | `:1771-1777` | `positions.forEach(p => { handleClosePosition(p.id).catch(...) })` — fire-and-forget; the promises are not awaited |
| 4 | `:1784-1794` | `bots.forEach(b => agentRuntime.stop(b.agentId))` for `RUNNING` agent bots |
| 5 | `:1779` | `setSafetyNotice(...)` — only when `flattenFailures.length > 0`; because step 3 is fire-and-forget, that array is empty at this point |
| 6 | `:1796` | `setBots(all → status 'STOPPED')` |
| 7 | `:1804` | `setShowKillSwitchModal(false)` |

## State summary

| State | Writer | Reset |
| --- | --- | --- |
| adapter `positions` | `demo.ts` close | removal |
| adapter `trades` | `demo.ts` close | appended only |
| `App.trades` | `App.tsx:822-828` | reload |
| `App.positions/balance/margin/freeMargin` | `App.tsx:798, 804-806` | `refreshFromAdapter` overwrites |
| `riskManager.currentDailyPnL` | `risk.ts:124` | `resetDailyLoss` `:128`; UTC rollover `:60-66` |
| `AgentRuntime.positionCorrelations` | deleted `runtime.ts:1502` | — |
| `TriggerEngine.agentByPosition` | `engine.ts:51` | `disposeAgent` |

## Exit points

None external. No close, cancel, or settlement request is sent to any venue endpoint.
