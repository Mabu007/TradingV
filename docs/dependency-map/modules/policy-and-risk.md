# Module 8 — Policy & Risk

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/policy/validator.ts`,
`src/engine/execution/{risk,valuation,errors}.ts`, `src/engine/core/execution.ts`,
`src/utils/{orderSize,positionSize}.ts`

**Purpose:** the deterministic gates that bound every order, whether it originates
from the UI, an agent tool call, or an agent final decision. These modules contain no
I/O, no network calls, and no React code.

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `policy/validator.ts` | 282 | `ActionValidator`, `actionValidator`, `referencePrice`, `ActionValidationContext` |
| `execution/risk.ts` | 288 | `RiskManager`, `riskManager`, `DEFAULT_RISK_LIMITS`, `RiskValuationContext` |
| `execution/valuation.ts` | 474 | `ACCOUNT_CURRENCY`, `aggregateExposure`, `valueQuantity`, `valuePriceDistance`, `riskToStop`, `leverageRequirement`, `marginForPosition`, `lookupFrom`, `quoteToAccountFactor` |
| `execution/errors.ts` | — | `RejectionCategory` (11), `ExecutionRejection`, `MESSAGES`, `rejection`, `rejectionMessage` |
| `core/execution.ts` | 188 | `OrderRequest` (idempotencyKey required), `assertExecutable` |
| `utils/orderSize.ts` | 202 | `lotsToInstrumentUnits`, `snapOrderSize`, `validateOrderSize` |
| `utils/positionSize.ts` | — | position sizing helpers |
| `utils/csvExport.ts` | — | CSV serialisation for history export |

---

## `ActionValidator` — `policy/validator.ts:37-280`

**Singleton** `actionValidator` `:282`. **Injected** as the `AgentRuntime` default
constructor arg (`runtime.ts:56`); a per-agent clone is made when the singleton was
used (`runtime.ts:159-162`).

**State** `recentOrderTimestamps: number[]` `:38` — pruned to a 60 s window at `:73-83`.

**`validate(decision, policy, observation, context = {})` — `:40-279`**

| # | Check | Line | Failure code |
| --- | --- | --- | --- |
| 1 | `WAIT` is always valid | `:47-49` | — |
| 2 | `ANALYZE` capability must be in `observation.availableCapabilities` | `:52-61` | `UNKNOWN_CAPABILITY` |
| 3 | `!policy.allowTrading` + `OPEN_POSITION` | `:64-70` | `TRADING_DISABLED` |
| 4 | orders-per-minute rate limit | `:73-83` | `RATE_LIMITED` |
| 5 | `\|dailyPnL\| >= policy.maxDailyLoss` | `:86-95` | `POLICY_VIOLATION` |
| 6 | drawdown > `maxDrawdown * 100` | `:97-103` | `POLICY_VIOLATION` |
| 7 | finite positive volume **and** positive finite `stopLoss` | `:108-110` | `INVALID_PARAMS` |
| 8 | BUY stop must be below the ask | `:111-113` | `INVALID_PARAMS` |
| 9 | SELL stop must be above the bid | `:114-116` | `INVALID_PARAMS` |
| 10 | symbol ∈ `policy.allowedSymbols` (when non-empty) | `:119-125` | `DISALLOWED_SYMBOL` |
| 11 | session ∈ `policy.allowedSessions` (skipped when the list contains `'ALL'`) | `:128-141` | `DISALLOWED_SESSION` |
| 12 | `positions.length >= maxOpenPositions` | `:144-150` | `POLICY_VIOLATION` |
| 13 | exposure including the intended leg; incomplete valuation rejects | `:154-186` | `POLICY_VIOLATION` |
| 14 | exposure cap | `:188-194` | `POLICY_VIOLATION` |
| 15 | mandatory stop-loss recheck | `:198-204` | `INVALID_PARAMS` |
| 16 | instrument-aware risk (`riskToStop`) must be computable | `:220-234` | `POLICY_VIOLATION` |
| 17 | dollar risk ≤ `equity * maxRiskPerTrade` | `:236-244` | `POLICY_VIOLATION` |
| 18 | record the order timestamp, approve | `:247-248` | `APPROVED` |

`MODIFY_POSITION` `:251-264` — at least one finite change `:253-255` and an existing
position `:256-262`.
`CLOSE_POSITION` `:266-276` — an existing position is required.
Fallback `APPROVED` `:278`.

`referencePrice(observation, symbol)` `:14-27` — ask first, then bid. The agent never
supplies the reference price.

`ActionValidationContext` `:29-35` — `{ instruments?: InstrumentLookup | InstrumentMetadata[] }`.

**Codes** — `APPROVED`, `POLICY_VIOLATION`, `RISK_REJECTED`, `INVALID_PARAMS`,
`UNKNOWN_CAPABILITY`, `DISALLOWED_SYMBOL`, `DISALLOWED_SESSION`, `TRADING_DISABLED`,
`RATE_LIMITED` (`agents/types.ts:199-212`).

`RISK_REJECTED` is produced by the **runtime**, not this validator:
`runtime.ts:925-931` overrides an approved validation when the deterministic risk
gate rejects.

---

## `RiskManager` — `execution/risk.ts:34-286`

**Singleton** `riskManager` `:288`.

`DEFAULT_RISK_LIMITS` `:7-24`: `maxOrderSize 100000`, `maxOpenPositions 5`,
`maxExposureNotional 250000`, `maxOrdersPerMinute 20`, `maxDailyLoss 1000`,
`killSwitchActive false`.

| Field | Line | Written | Read | Reset |
| --- | --- | --- | --- | --- |
| `limits` | `:35` | `updateLimits` `:91-93`, `setKillSwitch` `:102-112` | `getLimits` `:68-70`, `validateOrder` `:149-200` | `DEFAULT_RISK_LIMITS` |
| `recentOrderTimestamps` | `:36` | `:73-83`, `:187-193`, `:202` | same | 60 s prune |
| `currentDailyPnL` | `:37` | `recordPnL` `:122-126`, `rollDailyPnLIfNeeded` `:60-66` | `realisedToday` `:86-89`, `validateOrder` `:196` | `resetDailyLoss` `:128-131`; UTC-day rollover `utcDay` `:55-57` |
| `currentDailyPnLUtcDay` | `:48` | `rollDailyPnLIfNeeded` `:60-66` | `:62` | rollover |

Methods: `getLimits` `:68-70` · `isKillSwitchActive` `:81-83` · `realisedToday` `:86-89`
· `updateLimits` `:91-93` · `setKillSwitch` `:102-112` · `recordPnL` `:122-126` ·
`resetDailyLoss` `:128-131` · `validateOrder` `:139-204` ·
`validateExposure` `:217-274` · `notifyViolation` `:276-285` ·
`rollDailyPnLIfNeeded` `:60-66` · `utcDay` `:55-57`.

**`validateOrder(order, openPositions, recordAcceptedOrder = true, context?)` — `:139-204`**

| # | Check | Line | Code |
| --- | --- | --- | --- |
| 1 | kill switch | `:149-153` | `KILL_SWITCH` |
| 2 | max single order size | `:156-160` | `ORDER_SIZE_INVALID` |
| 3 | max concurrent positions | `:163-167` | `MAX_POSITIONS_EXCEEDED` |
| 4 | `validateExposure` → `aggregateExposure` | `:171-184` | `EXPOSURE_LIMIT_EXCEEDED`, `MARKET_DATA_UNAVAILABLE` |
| 5 | orders per minute | `:187-193` | `RATE_LIMITED` |
| 6 | daily loss `currentDailyPnL <= -maxDailyLoss` | `:196-200` | `DAILY_LOSS_LIMIT` |
| 7 | record the timestamp and approve | `:202-203` | — |

`recordAcceptedOrder` is `false` on the agent paths (`runtime.ts:906`, `:1561`) so the
risk manager does not double-count the order; the policy validator owns that counter.

`validateExposure` `:217-274` builds legs from the open positions plus the new order
(`:235-253`), values each with `aggregateExposure` (`valuation.ts:346`); an
incomplete valuation yields `MARKET_DATA_UNAVAILABLE` (`:255-261`); over the limit
yields `EXPOSURE_LIMIT_EXCEEDED` (`:265-271`).

`notifyViolation` `:276-285` emits `RISK_VIOLATION` on the `eventBus`.

---

## `valuation.ts` — instrument-aware money math

| Symbol | Line | Role |
| --- | --- | --- |
| `ACCOUNT_CURRENCY = 'USD'` | `:23` | |
| `DEMO_FALLBACK_LEVERAGE = 10` | `:30` | |
| `QuantityValuation` | `:32-50` | |
| `effectiveMultiplier` | `:53-56` | |
| `quoteToAccountFactor` | `:70-98` | only 1, or `1/price` when the base is the account currency — no hardcoded pair |
| `isUnconvertible` | `:106-119` | |
| `valueQuantity` | `:122-203` | |
| `valuePriceDistance` | `:214-294` | |
| `riskToStop` | `:300-320` | used by policy check 16 |
| `ExposureLeg` / `ExposureSummary` | `:322-327` / `:329-337` | |
| `aggregateExposure` | `:346-377` | called by risk, policy, and `account.getExposure` |
| `LeverageRequirement` / `leverageRequirement` | `:379-382` / `:389-406` | |
| `marginForPosition` | `:415-445` | used by `demo.ts` |
| `resolveMetadata` | `:448-453` | |
| `lookupFrom` | `:459-474` | used by `runtime.ts:906` |

---

## `errors.ts` — the rejection vocabulary

`RejectionCategory` — 11 categories, `execution/errors.ts:14-25` ·
`ExecutionRejection { category, message, detail? }` `:27-33` ·
user-safe `MESSAGES` `:35-58` · `rejection(category, detail?)` `:61-70` ·
`rejectionMessage` `:72-76`.

Consumed by `App.handleExecuteOrder` — `App.tsx:901-905` — which turns
`execution.rejection(...)` into the `{ success, message, category }` the order modal
renders (`TradeOrderModal.tsx:667-680`).

---

## `core/execution.ts` — the execution-boundary guard

`OrderRequest` `:35-55` requires a **mandatory `idempotencyKey`** `:48`; it also
carries `wakeId`, `botId`, `deploymentId`, `configVersion`.

`assertExecutable(request)` `:160-170`:
missing idempotency key `:161-163` · non-positive or non-finite volume `:164-166` ·
a limit order without a positive `limitPrice` `:167-169`.

---

## `utils/orderSize.ts` — the size/execution guard

`lotsToInstrumentUnits` · `snapOrderSize` · `validateOrderSize` (called at
`demo.ts:22`, from `demo.ts` order paths and from `TradeOrderModal.tsx:123`).

`utils/positionSize.ts` — position sizing helpers consumed by
`capabilities/risk.ts:13-200` and the backtest path.

`utils/csvExport.ts` — CSV serialisation, used by `HistoryTab` export.

---

## Depends on

| Module | How |
| --- | --- |
| Valuation | intra-module |
| Services & State | `eventBus` (`risk.ts:276-285`, `:110`) |
| Hyperliquid Adapters | the reverse: `demo.ts:16` imports `riskManager`, `valuation`, `errors`, `utils/orderSize` |
| Agent Runtime | the reverse: `runtime.ts` imports both validators |

## Used by

| Consumer | Line |
| --- | --- |
| `AgentRuntime` — final decision | `runtime.ts:894` (policy), `:906` (risk) |
| `AgentRuntime` — execution tool pre-check | `runtime.ts:1549` (policy), `:1561` (risk) |
| `HyperliquidDemoAdapter` — order + close | `demo.ts:16, 17-20, 21, 22, 515` |
| `capabilities/risk.ts` — verdict-only tools | `risk.ts:13-577` (reads env data, not the manager) |
| `App` — kill switch and limits display | `App.tsx:1751, 1758, 2881, 1986` |
| `TradeOrderModal` — size validation | `TradeOrderModal.tsx:123` |
| Test runners (test-only) | `engine/execution/tests.ts`, `engine/core/securityTests.ts`, `agents/tests.ts` |

## Reads

| Source | Line |
| --- | --- |
| `observation` (account, positions, quote) | `policy/validator.ts:108-244` |
| `policy` (the agent's hard boundaries) | `policy/validator.ts:64-244` |
| `context.instruments` / `context.referencePrices` | `risk.ts:27-32` |
| `env.recentOrderTimestamps` | `risk.ts:73-83`, `:187-193` |

## Writes

| Target | Line |
| --- | --- |
| `riskManager.limits` | `risk.ts:91-93`, `:102-112` |
| `riskManager.recentOrderTimestamps` | `risk.ts:202` |
| `riskManager.currentDailyPnL` | `risk.ts:124` |
| `actionValidator.recentOrderTimestamps` | `policy/validator.ts:247-248` |

## Mutates

- `setKillSwitch(true/false)` — `risk.ts:102-112`; called from `App.tsx:1751` and from
  the `setIsKillSwitchActive` state updater `App.tsx:2881`.
- `recordPnL(...)` — `risk.ts:122-126`; called when a position closes.
- `updateLimits(...)` — `risk.ts:91-93`; no caller outside the module.
- `resetDailyLoss()` — `risk.ts:128-131`; no in-`src` caller.

## Emits

| Event | Line | Trigger |
| --- | --- | --- |
| `RISK_VIOLATION` | `risk.ts:276-285` | any rejected order |
| `STATUS_CHANGE` | `risk.ts:110` | `setKillSwitch` |

## Subscribes to

Nothing.

## External dependencies

None. This module performs no network or storage I/O.

## Entry points

`ActionValidator.validate` `policy/validator.ts:40` ·
`RiskManager.validateOrder` `execution/risk.ts:139` ·
`RiskManager.setKillSwitch` `execution/risk.ts:102` ·
`RiskManager.recordPnL` `execution/risk.ts:122` ·
`assertExecutable` `core/execution.ts:160` ·
`validateOrderSize` `utils/orderSize.ts:92` ·
`rejection` `execution/errors.ts:61`.

## Exit points

`eventBus` `RISK_VIOLATION` → `TriggerEngine.processRiskState` `engine.ts:339-346` →
`RISK_STATE_CHANGED` triggers. The gate verdicts themselves terminate in the caller.
