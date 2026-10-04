# Chain: Kill Switch → Flatten All

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the user engages the kill switch and then taps "Close All Positions" in
`KillSwitchModal`. Engaging and flattening are two separate actions.

**Confidence:** CONFIRMED.

---

## Part A — engage the kill switch

```
[1] KillSwitchModal "Engage" / "Resume" button          KillSwitchModal.tsx:94
    └─ onToggleKillSwitch                                App.tsx:2869-2885
       └─ setIsKillSwitchActive(prev => {
            const next = !prev;
            riskManager.setKillSwitch(next);   ← engine write inside a React updater
            return next;
          })                                             App.tsx:2879-2883
```

| | |
| --- | --- |
| **Input** | the current `isKillSwitchActive` React value |
| **Action** | `riskManager.setKillSwitch(next)` — `App.tsx:2881` |
| **Mutation** | `riskManager.limits.killSwitchActive` — `execution/risk.ts:102-112` |
| **Emit** | `eventBus.emit({ type: 'STATUS_CHANGE' })` — `risk.ts:110` |
| **React mutation** | `App.isKillSwitchActive` — `App.tsx:296-297` |

**The engine write happens inside the React state updater function** (`App.tsx:2879-2883`).
Because the updater may be invoked more than once per render pass in some React
scheduling situations, this places a side effect on the engine singleton inside a
pure-function position. The observable ordering in the current code is
`riskManager.setKillSwitch` first, then the state value is returned.

The alternate write site is `handleEmergencyKillSwitch` — `App.tsx:1751` — which calls
`riskManager.setKillSwitch(true)` outside any updater.

### Who reads the flag

| Reader | Line |
| --- | --- |
| `RiskManager.validateOrder` — the first check | `execution/risk.ts:149-153` |
| `HyperliquidDemoAdapter` order gate | `demo.ts` (inside `placeMarketOrder`) |
| `MobileHeader.isKillSwitchActive` | `App.tsx:2200` |
| `KillSwitchModal.isEngaged` | `App.tsx:2861` |
| `SettingsTab.isKillSwitchActive` | `App.tsx:2612` |
| AI context `riskState` / `riskLimits.killSwitchActive` | `App.tsx:1881`, `:1987` |

**Consequence** — once engaged, `validateOrder` rejects at
`execution/risk.ts:149-153` with reason `KILL_SWITCH` and calls
`notifyViolation('KILL_SWITCH')` (`risk.ts:150`), which emits `RISK_VIOLATION`
(`risk.ts:276-285`). That emission reaches `TriggerEngine.processRiskState`
(`engine.ts:339-346`), so `RISK_STATE_CHANGED` triggers can fire off the kill switch
itself.

---

## Part B — flatten all

```
[2] KillSwitchModal "Close All Positions"                 KillSwitchModal.tsx:77
    └─ onFlattenAllPositions = App.handleEmergencyKillSwitch     App.tsx:2888
       ↓
[3] App.handleEmergencyKillSwitch()                       App.tsx:1740-1807
```

| Step | Line | Action | Mutation |
| --- | --- | --- | --- |
| 1 | `:1751` | `riskManager.setKillSwitch(true)` — **first**, so any in-flight order is blocked before closing starts | `riskManager.limits` |
| 2 | `:1758` | `setIsKillSwitchActive(riskManager.isKillSwitchActive())` — reads the engine back rather than assuming | `App.isKillSwitchActive` |
| 3 | `:1771-1777` | `positions.forEach(p => { handleClosePosition(p.id).catch(fn) })` | each close mutates adapter positions/trades/account and emits `POSITION_CLOSE` |
| 4 | `:1784-1794` | `bots.forEach(b => agentRuntime.stop(b.agentId))` for bots whose status is `RUNNING` **and** which have an `agentId` | `instance.isRunning` `runtime.ts:243`; emits `AGENT_STOPPED` `:245-251` |
| 5 | `:1779` | `setSafetyNotice(...)` — only when `flattenFailures.length > 0` | `App.safetyNotice` |
| 6 | `:1796` | `setBots(all → status 'STOPPED')` | `App.bots` |
| 7 | `:1804` | `setShowKillSwitchModal(false)` | `App.showKillSwitchModal` |

### Observable ordering detail (CONFIRMED)

Step 3 dispatches **fire-and-forget** promises: `handleClosePosition` is `async`
(`App.tsx:916`) and the `.catch` handlers only push into `flattenFailures` when they
run. Because step 5 reads `flattenFailures.length` synchronously on the same tick,
the array is empty at that point unless a rejection happened synchronously.

Step 6 sets every bot to `STOPPED` in React state, including bots that were not
running. Step 4 only calls `agentRuntime.stop` for `RUNNING` agent bots.

## Downstream effects

| Effect | Path |
| --- | --- |
| positions removed | `App` effect #8 → `setPositions([])` and an account re-mirror — `App.tsx:798, 804-806` |
| realised P&L booked | `riskManager.recordPnL` — `execution/risk.ts:122-126` |
| agents stopped | `eventBus` `AGENT_STOPPED` — `runtime.ts:245-251` → `TriggerEngine.onAll` |
| no further wakes | `TriggerEngine.process` agent gate `agent.isRunning` — `engine.ts:203` |
| future orders rejected | `execution/risk.ts:149-153`; the adapter gate in `demo.ts` |
| AI sees it | `riskState` `App.tsx:1881`, `riskLimits` `App.tsx:1987` |
| `equity` recomputes | `App.tsx:763-778` |

## Resuming

The only resume path is the same `KillSwitchModal` toggle — `KillSwitchModal.tsx:94` →
`App.tsx:2869-2885` with `next = false`, which calls
`riskManager.setKillSwitch(false)`.

**CONFIRMED** — resuming does **not** restart stopped bots; the bots remain
`STOPPED` in `App.bots` (written at `App.tsx:1796`) and their `AgentInstance.isRunning`
is `false` (`runtime.ts:243`). Restarting requires `handleToggleBotStatus`
(`App.tsx:951`) or `agentRuntime.start` (`App.tsx:1025`).

## State summary

| State | Writer | Reset |
| --- | --- | --- |
| `riskManager.limits.killSwitchActive` | `risk.ts:102-112` ← `App.tsx:1751`, `:2881` | `setKillSwitch(false)` |
| `App.isKillSwitchActive` | `App.tsx:1758`, `:2882` | — |
| `App.positions` | `App.tsx:798` after the closes | `refreshFromAdapter` |
| `App.bots[].status` | `App.tsx:1796` | `handleToggleBotStatus` |
| `AgentInstance.isRunning` | `runtime.ts:243` | `start` `runtime.ts:215` |
| `riskManager.currentDailyPnL` | `risk.ts:124` (from the closes) | `resetDailyLoss` `risk.ts:128`; UTC rollover |

## Exit points

None external. Closing positions is entirely local to the DEMO adapter; no cancel or
settle request reaches Hyperliquid.
