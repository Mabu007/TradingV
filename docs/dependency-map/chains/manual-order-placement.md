# Chain: Manual Order Placement

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the user taps "Place BUY/SELL Order" in the order ticket.

**Confidence:** CONFIRMED for every step.

---

```
[1] User taps "Place BUY/SELL Order"
    TradeOrderModal.handleExecute            components/modals/TradeOrderModal.tsx:249
```

## Stage 1 — order ticket input

| | |
| --- | --- |
| **Input** | the live `quote` for the selected symbol, the chosen side, lot count, optional SL/TP |
| **Action** | derive the entry price, convert lots → instrument units, validate size |
| **Detail** | `entryPrice = side === 'BUY' ? quote.ask : quote.bid` — `TradeOrderModal.tsx:91-101`; `volumeUnits` via `lotsToInstrumentUnits` / `snapOrderSize` — `:109-121`; `sizeCheck = validateOrderSize(...)` — `:123`; `stopLoss` / `takeProfit` state `:170`, `:183`; `canExecute` gate `:209` |
| **Mutation** | `TradeOrderModal` local state only |
| **Next** | `props.onExecuteOrder(...)` |

## Stage 2 — the App handler

| | |
| --- | --- |
| **Input** | `{ symbol, side, volume, stopLoss?, takeProfit? }` |
| **Action** | `App.handleExecuteOrder` — `src/App.tsx:849-909` |
| **Calls** | `hyperliquidDemoAdapter.placeMarketOrder(params)` — `App.tsx:871` |
| **On failure** | `eventBus.emit({type:'LOG', id:'order-rejected:…'})` — `App.tsx:884-899`; returns `{ success: false, message, category }` built from `execution.rejection` — `App.tsx:901-905` |
| **On success** | returns `{ success: true }` — `App.tsx:908` |
| **Mutation** | none in App state — the mirror effect does the writing |

## Stage 3 — the DEMO adapter

`hyperliquidDemoAdapter.placeMarketOrder` — `src/adapters/hyperliquid/demo.ts:442`

```
[3] hyperliquidDemoAdapter.placeMarketOrder(params)      demo.ts:442
    ├─ getInstrument(symbol)                             demo.ts:457 → marketData.ts:398
    ├─ validateOrderSize(...)                            utils/orderSize.ts:92
    ├─ await marketData.getQuote(symbol)                 marketData.ts:192
    │      └─ await fetch POST {REST}/info {type:'l2Book'}  marketData.ts:195
    │         (BUY fills at quote.ask, SELL at quote.bid)
    ├─ riskManager.isKillSwitchActive()                  execution/risk.ts:81
    ├─ riskManager.validateOrder(order, positions, …)    execution/risk.ts:139
    │      └─ validateExposure → aggregateExposure       execution/valuation.ts:346
    ├─ account.balance -= commission
    ├─ positions.push(newPosition)
    └─ eventBus.emit({type:'ORDER'})                     demo.ts
       eventBus.emit({type:'POSITION_OPEN', data})       demo.ts
```

**Gate order inside the adapter (CONFIRMED)** — instrument resolution, then size
validation, then the quote fetch, then the kill-switch and risk checks. The quote fetch
happens **before** the risk gate, so a rejected order has already paid one HTTP round
trip to the venue.

**The deterministic gates on this path (UI orders)**

| Gate | Location | Rejection codes |
| --- | --- | --- |
| instrument exists | `demo.ts:457` | — |
| size precision | `utils/orderSize.ts:92` | — |
| kill switch | `execution/risk.ts:149-153` | `KILL_SWITCH` |
| max single order size | `execution/risk.ts:156-160` | `ORDER_SIZE_INVALID` |
| max concurrent positions | `execution/risk.ts:163-167` | `MAX_POSITIONS_EXCEEDED` |
| exposure notional | `execution/risk.ts:171-184` | `EXPOSURE_LIMIT_EXCEEDED`, `MARKET_DATA_UNAVAILABLE` |
| orders per minute | `execution/risk.ts:187-193` | `RATE_LIMITED` |
| daily loss | `execution/risk.ts:196-200` | `DAILY_LOSS_LIMIT` |

Rejection vocabulary: `RejectionCategory` — 11 categories, `execution/errors.ts:14-25`;
user-safe messages `:35-58`; `rejection(category, detail?)` `:61-70`.

**Note (CONFIRMED)** — the UI order path does **not** pass through
`ActionValidator.validate`. That gate is agent-only
(`runtime.ts:894`, `:1549`). The UI path is bounded by the adapter's own
instrument/size checks and by `RiskManager`.

## Stage 4 — the execution mirror effect

```
[4] eventBus 'POSITION_OPEN' reaches App effect #8       App.tsx:793-842
    ├─ listener registered at App.tsx:811
    ↓
refreshFromAdapter()                                     App.tsx:794-808
    ├─ hyperliquidDemoAdapter.getPositions()             :796
    │     └─ setPositions(...)                           :798
    └─ hyperliquidDemoAdapter.getAccountState()          :802
          ├─ setBalance(...)                             :804
          ├─ setMargin(...)                              :805
          └─ setFreeMargin(...)                          :806
```

| | |
| --- | --- |
| **Mutation** | `App.positions`, `App.balance`, `App.margin`, `App.freeMargin` |
| **Downstream reads** | `equity` memo `App.tsx:763-778`; `TradesTab` `:2289-2305`; `BottomNav.openPositionsCount` `:2120`; `QuotesTab.positions` `:2379`; `KillSwitchModal.openPositionsCount` `:2866`; `FloatingAIAssistant.openPositions` `:2652`; AI context `:1887` |

## Stage 5 — the trigger engine also sees the order

Because `TriggerEngine` subscribes with `eventBus.onAll` (`engine.ts:78`), the
`POSITION_OPEN` emission reaches `process()`:

```
[5] TriggerEngine (if running — started at App.tsx:155)
    ├─ inputFromDomainEvent(event, now, sequence)         engine.ts:484-505
    │    (handles MARKET_QUOTE :485, BAR_UPDATE :490, AGENT_ORDER_FILLED :495)
    └─ process(input)                                    engine.ts:113 → :178
         └─ POSITION_OPEN-type triggers for the agent     evaluator.ts:64
```

Note: `inputFromDomainEvent` does **not** handle `POSITION_OPEN` directly — a
`POSITION_OPEN` event reaches the engine through `processPositionEvent`
(`engine.ts:360-367`), which maps `positionId → agentId` into `agentByPosition`
(`engine.ts:51`).

## Stage 6 — UI feedback

| Outcome | Result |
| --- | --- |
| Success | `TradeOrderModal` closes — `TradeOrderModal.tsx:267` |
| Rejection | the modal stays open and renders `submitError` — `:271`, `:667-680` |

## State summary

| State | Writer | Reader |
| --- | --- | --- |
| adapter `positions` / account | `demo.ts` | `App` effect #8, capabilities, agents |
| `App.positions/balance/margin/freeMargin` | `App.tsx:798, 804-806` | views, AI context |
| `riskManager.recentOrderTimestamps` | `risk.ts:202` | `risk.ts:187-193` |
| `TriggerEngine.agentByPosition` | `engine.ts:51` | `processPositionEvent` |

## Exit points

The result terminates in the browser. No order, fill, or acknowledgement is sent to any
external endpoint — `src/adapters/hyperliquid/demo.ts` has no network write path, and
`server/tradingv_engine/marketdata.py` only reads the public `/info` endpoint.
