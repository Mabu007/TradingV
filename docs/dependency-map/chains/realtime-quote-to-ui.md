# Chain: Realtime Quote → UI

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** a message arrives on the Hyperliquid WebSocket.

**Confidence:** CONFIRMED.

---

```
[1] socket.onmessage = (message) => this.handleMessage(message.data)   marketData.ts:184
```

## Stage 1 — the WebSocket

| | |
| --- | --- |
| **URL** | `wss://${host}/ws` — `marketData.ts:75` (mainnet), `:82` (testnet) |
| **Created** | `new WebSocket(this.wsUrl)` — `marketData.ts:180` |
| **Handler** | `socket.onmessage` — `marketData.ts:184` |
| **Started by** | `hyperliquidMarketData.connect()` — `App.tsx:520` (mount effect #3) |
| **Status** | `onStatusChange(listener)` — `marketData.ts:168`; App subscribes at `App.tsx:514` and unsubscribes at `:524`; the callback sets `App.connectionStatus` `:516` |

## Stage 2 — normalisation and emit

```
[2] handleMessage(raw)
    ├─ parse the subscription frame
    ├─ normalizer.quoteFromBook(...)   → Quote    (quote channel)
    └─ normalizer.fromHyperliquidCandle(...) → Bar (candle channel)
    ↓
    eventBus.emit({ type: 'MARKET_QUOTE', data: quote })                 marketData.ts
    eventBus.emit({ type: 'BAR_UPDATE', symbol, timeframe, bar, isClosed })  marketData.ts
```

Both handlers are **synchronous** — there is no `await` between the socket message and
the `eventBus` emission.

## Stage 3a — the UI branch

```
[3a] App effect #5 callback                                App.tsx:611-643
    ├─ setQuotes(prev => ({ ...prev, [quote.symbol]: quote }))    App.tsx:614-617
    ├─ marketDataService.updateLastPrice(sym, (bid+ask)/2)          App.tsx:624
    └─ hyperliquidDemoAdapter.markToMarket(quote)                   App.tsx:637
```

| | |
| --- | --- |
| **Mutation 1** | `App.quotes` — `App.tsx:236-237` |
| **Mutation 2** | `MarketDataService` last price — `services/marketData.ts:65` |
| **Mutation 3** | open positions' `unrealizedPnL` inside the demo adapter — `demo.ts` `markToMarket` |
| **Reads before writing** | `equity` memo recomputes from `balance + Σ unrealizedPnL` — `App.tsx:763-778` |

Downstream readers of `App.quotes`:

| Reader | Line |
| --- | --- |
| `QuotesTab.quotes` → market rows + the order ticket's live price | `App.tsx:2371` |
| `TradeOrderModal` entry price (`ask` for BUY, `bid` for SELL) | `TradeOrderModal.tsx:91-101` |
| `triggerTestContext` — the `ConditionContext` the Trigger Lab previews against | `App.tsx:2021` |
| AI context `markets[].bid` / `markets[].ask` | `App.tsx:1923-1924` |

`TriggerBuilder` re-evaluates its condition tree on every context change
(`TriggerBuilder.tsx:96`), so a tick re-runs `evaluateConditionTree` and updates the
"WOULD FIRE / WOULD NOT FIRE / CANNOT MEASURE" verdict (`TriggerBuilder.tsx:347-363`).

## Stage 3b — the trigger-engine branch

```
[3b] TriggerEngine MARKET_QUOTE branch                     engine.ts:80-110
    ├─ iterate runtime.listAgents()                        engine.ts:81
    ├─ filter: agent.env.mode === this.sourceEnvironment   engine.ts:82
    ├─ filter: agent.symbols includes quote.symbol
    ├─ build quoteEvent with a per-agent delivery id
    │     `quote:${symbol}:${ts}:${agentId}`               engine.ts:102-105
    └─ this.process(input)                                 engine.ts:106
          → the trigger lifecycle, see
            [pre-goat-trigger-to-agent-wake.md](trigger-to-agent-wake.md)
```

Because the delivery id is agent-scoped, one quote produces N `process` calls.

## Stage 4 — bars on the same socket

```
[4] App effect #7 callback                                  App.tsx:720-749
    ├─ upsert by bar.time, or append
    ├─ cap: .slice(-260)                                   App.tsx:749
    └─ setBars(...)
```

| | |
| --- | --- |
| **Mutation** | `App.bars` — `App.tsx:209-210` |
| **Cleanup** | `unsubscribeBars()` — `App.tsx:754` |
| **Downstream** | `QuotesTab.bars` `:2375` → `TradingChart`; `triggerTestContext.bars` `:2034` |

## Stage 5 — the engine's bar path

`BAR_UPDATE` reaches the engine through `inputFromDomainEvent` (`engine.ts:490-494`)
→ `dispatchMarketInput` (`engine.ts:118-137`), which, when the input has a timeframe,
**fetches 1000 bars from the environment** before evaluation:

```
engine.getMarketBars(symbol, timeframe, 1000)              engine.ts:127
   → DemoEnvironment → marketData.getBars
```

This is a per-agent, per-event REST call, distinct from the browser's WebSocket bar
stream.

## Historical bars (the other source of `App.bars`)

```
App effect #4                                               App.tsx:533-577
    await hyperliquidMarketData.getBars(symbol, timeframe, 260)   App.tsx:541
       → getBarsInRange(...)                                       marketData.ts:213
       → fetch POST {type:'candleSnapshot'}                        marketData.ts:213+
    ↓ setBars(historicalBars)                             App.tsx:546
    on error: setBars([]) with "no synthetic fallback"     App.tsx:558
```

Effect #4 and effect #7 both write `App.bars`; they are keyed on `[symbol, timeframe]`
so the two are consistent per symbol/timeframe but the historical fetch can briefly
precede or follow the subscription.

## Async boundaries in this chain

| Step | Kind |
| --- | --- |
| `fetch` for the WebSocket subscription payload (`l2Book`, `candleSnapshot`) | `await` — `marketData.ts:195, 213` |
| `socket.onmessage` → `handleMessage` → `eventBus.emit` | synchronous |
| App's quote callback | synchronous — `App.tsx:611-643` |
| App's bar callback | synchronous — `App.tsx:724-749` |
| `TriggerEngine.process` → `delivery.wake` | `await` — `engine.ts:252` |
| `AgentRuntime.step` (the model call inside) | `await` — `runtime.ts:522` |

The tick path itself is **not** async: from the socket message to the React state write
there is no `await`. The only asynchrony is downstream of the trigger engine.

## State summary

| State | Writer | Cadence |
| --- | --- | --- |
| `App.quotes` | `App.tsx:614` (tick), `:680` (one-shot) | per tick |
| `App.bars` | `App.tsx:546` (fetch), `:724-749` (tick) | per tick |
| `MarketDataService` last prices | `services/marketData.ts:65` | per tick |
| adapter position `unrealizedPnL` | `demo.ts` `markToMarket` | per tick |
| `App.equity` (memo) | recomputed from `balance` + positions | per tick |

## Exit points

- Hyperliquid WebSocket (the sole inbound realtime source).
- No push leaves the browser; all consumers are in-process.
