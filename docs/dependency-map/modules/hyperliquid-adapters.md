# Module 11 — Hyperliquid Adapters

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/adapters/hyperliquid/{marketData,normalizer,demo}.ts`,
`src/adapters/marketData.ts`

**Purpose:** the only code that talks to the Hyperliquid venue. `marketData.ts`
performs live discovery, quote, and candle I/O over REST + WebSocket.
`normalizer.ts` translates venue shapes into the application's canonical models.
`demo.ts` is the execution adapter: it holds positions, orders, and the account, and
it simulates fills. There is no signing path and no order-write network call.

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `marketData.ts` | 481 | `HyperliquidTransport` `:25`, `HyperliquidCandle` `:29`, `HyperliquidMarketDataAdapter` `:34`, `hyperliquidMarketData` `:481` |
| `normalizer.ts` | 275 | `fromHyperliquidCandle` `:31`, `normalizeSymbol`, `quoteFromBook`, `toHyperliquidInterval`, `classifyAsset`, `instrumentMetadata`, `marketAvailability`, `marketSymbol`, `tradingInstrument`, `uniqueSymbolLabels` |
| `demo.ts` | 1034 | `HyperliquidDemoAdapter`, `hyperliquidDemoAdapter` |
| `marketData.ts` (parent) | — | the `MarketDataProvider` interface |

---

## `HyperliquidMarketDataAdapter` — `marketData.ts:34`

**Endpoints**

| Purpose | Line | Detail |
| --- | --- | --- |
| REST base | `:55`, `:75`, `:82` | `https://${host}/info` where host is `api.hyperliquid.xyz` or `api.hyperliquid-testnet.xyz` |
| WS base | `:75`, `:82` | `wss://${host}/ws` |
| fetch calls | `:54` (discovery), `:195` (l2Book), `:213` (candleSnapshot) | |

**Network selection** — `hyperliquidNetwork()` from `config/env.ts:43-47`
(`VITE_HYPERLIQUID_NETWORK`). `setNetwork(network)` recomputes both bases at
`marketData.ts:82`; called from `App.tsx:2808`.

**Methods**

| Method | Line | Notes |
| --- | --- | --- |
| `getInstruments(assetClasses = ['FOREX','COMMODITY','INDEX'])` | `:94` | `{type:'perpDexs'}` then `{type:'metaAndAssetCtxs', dex}` per dex |
| `getQuote(symbol)` | `:192` | `await fetch` `{type:'l2Book'}` `:195`; lazily discovers if the symbol has no `:` `:193` |
| `getBars(symbol, timeframe, count)` | `:205` | delegates to `getBarsInRange` `:209` |
| `getBarsInRange(symbol, timeframe, startTime, endTime)` | `:213` | `candleSnapshot`; lazy discovery `:215` |
| `subscribeQuote(symbol, callback)` | `:223` | returns an unsubscribe closure |
| `subscribeBars(symbol, timeframe, callback)` | `:229` | |
| `connect()` | ~`:178` | opens the socket `:180` |
| `onStatusChange(listener)` | `:168` | adds to `statusListeners`; returns a delete closure |
| `setNetwork(network)` | `:82` | |

**WebSocket**

```
new WebSocket(this.wsUrl)                                 marketData.ts:180
socket.onmessage = (message) => this.handleMessage(message.data)   marketData.ts:184
   ↓ normalizer.quoteFromBook / fromHyperliquidCandle
   ↓ eventBus.emit({ type: 'MARKET_QUOTE', data: quote })
   ↓ eventBus.emit({ type: 'BAR_UPDATE', symbol, timeframe, bar, isClosed })
```

**Test seam** — `HyperliquidTransport` `:25`; the class accepts an injected
`transport` so discovery/quotes/candles can be stubbed.

---

## `normalizer.ts` — one translation layer

Every venue shape crosses this file. `marketData.ts:5` imports ten functions from it.

| Function | Role |
| --- | --- |
| `fromHyperliquidCandle(raw): Bar` `:31` | `{t,T,s,i,o,c,h,l,v,n}` → `Bar` |
| `quoteFromBook` | l2Book levels → `Quote` (bid/ask/spread) |
| `normalizeSymbol` | provider symbol ↔ display symbol |
| `toHyperliquidInterval` | `Timeframe` → provider interval string |
| `classifyAsset` | provider prefix → `AssetClass` |
| `instrumentMetadata` | canonical `InstrumentMetadata` (decimals, size decimals, pip size, lot size) |
| `marketAvailability` | `TRADEABLE` vs `UNAVAILABLE` + a reason |
| `marketSymbol` | → `MarketSymbol` |
| `tradingInstrument` | → `TradingInstrument` (the UI record) |
| `uniqueSymbolLabels` | de-duplicated display labels |

**A parallel Python implementation exists** —
`server/tradingv_engine/marketdata.py:64-72` (`classify`), `:75-110` (`Instrument`),
`:327-346` (decimals, pip size, label). The two are separate code with the same
availability rule (`midPx` then `markPx`, `> 0` ⇒ tradeable) — `marketdata.py:204-212`.
Neither imports the other.

---

## `HyperliquidDemoAdapter` — the execution adapter

**Holds** — positions, orders, closed trades, and the account (balance / margin /
free margin). It is the single source of truth for execution state in the browser app
(`App` mirrors it through effect #8, `App.tsx:793-842`).

**Place an order** — `placeMarketOrder(params)` `demo.ts:442`

| Step | Line | Detail |
| --- | --- | --- |
| instrument resolution | `:457` | → `marketData.ts:398` |
| size validation | `:22` import | `validateOrderSize` `utils/orderSize.ts:92` |
| live quote | `:442` | → `marketData.ts:192` → `await fetch` `:195` |
| kill-switch gate | — | `riskManager.isKillSwitchActive()` |
| risk validation | `:515` | `riskManager.validateOrder` |
| pricing | — | BUY fills at `quote.ask`, SELL at `quote.bid` |
| commission | — | deducted from the account |
| position creation | — | `positions.push(...)` |
| emissions | — | `eventBus.emit({type:'ORDER'})`, `eventBus.emit({type:'POSITION_OPEN', data})` |

**Other methods**

| Method | Call site | Notes |
| --- | --- | --- |
| `closePosition(positionId)` | `App.tsx:926`; `environment/demo.ts:65` | realised P&L, `trades.unshift`, `positions.remove`, emits `POSITION_CLOSE` |
| `markToMarket(quote)` | `App.tsx:637` | updates open positions' `unrealizedPnL` |
| `getPositions()` | `App.tsx:796`; `environment/demo.ts:34` | |
| `getAccountState()` | `App.tsx:802`; `environment/demo.ts:30` | |
| `getOrders()` | `environment/demo.ts:38` | |
| `modifyPosition(id, changes)` | `environment/demo.ts:61` | |

**Imported dependencies** — `demo.ts:1-24`
`eventBus` · `types/trading` · `types/instruments` · `types/quotes` ·
`riskManager` (`engine/execution/risk`) · `execution/errors` ·
`ACCOUNT_CURRENCY`, `marginForPosition`, `valuePriceDistance` (`engine/execution/valuation`) ·
`validateOrderSize` (`utils/orderSize`) · `ITradingEnvironment` (`engine/agents/types`) ·
`hyperliquidMarketData` (`./marketData`).

**No signing, no credentials, no order-write endpoint (CONFIRMED)** — the file
contains no request to any private or exchange route; the only network call it makes
is the public `l2Book` fetch, and that is delegated to `marketData.ts`.

---

## Depends on

| Module | How |
| --- | --- |
| Services & State | `config/env.ts` `hyperliquidNetwork()`; `eventBus`; `types/instruments`, `types/trading`, `types/quotes` |
| Policy & Risk | `riskManager` (`demo.ts:16`), `valuation` (`:21`), `errors` (`:17-20`), `utils/orderSize` (`:22`) |
| Environments | the reverse — `environment/demo.ts:10` holds the adapter |

## Used by

| Consumer | Line |
| --- | --- |
| `App` | `:76` (`hyperliquidMarketData`), discovery `:419`, quotes `:611/:673`, bars `:541/:720`, status `:514`, `connect` `:520`, `setNetwork` `:2808`; adapter `placeMarketOrder` `:871`, `closePosition` `:926`, `getPositions` `:796`, `getAccountState` `:802`, `markToMarket` `:637` |
| `DemoEnvironment` | `environment/demo.ts:10` |
| `HistoricalMarketDataProvider` | `engine/backtester/historical.ts:40-42` |
| `AgentRuntime` (indirect) | through `ITradingEnvironment` |
| Test runners (test-only) | `adapters/hyperliquid/tests.ts`, `executionTests.ts`, `discoveryTests.ts`, `discoverySmoke.ts` |

## Reads

| Source | Line |
| --- | --- |
| `VITE_HYPERLIQUID_NETWORK` | `config/env.ts:44` |
| `this.instruments` (cached) | `marketData.ts:193, 206, 215` |
| `eventBus` (subscribed by others) | `marketData.ts:184` |
| `riskManager` | `demo.ts:515` |
| Hyperliquid `/info` | `marketData.ts:54, 195, 213` |
| Hyperliquid `/ws` | `marketData.ts:180` |

## Writes

| Target | Line |
| --- | --- |
| `this.instruments` (cache) | `marketData.ts:94+` |
| `this.restUrl` / `this.wsUrl` / `this.statusListeners` | `marketData.ts:75, 82, 168` |
| adapter positions / orders / trades / account | `demo.ts:442+` |
| `eventBus.emit` `MARKET_QUOTE`, `BAR_UPDATE`, `ORDER`, `POSITION_OPEN`, `POSITION_UPDATE`, `POSITION_CLOSE` | `marketData.ts:184`, `demo.ts` |

## Mutates

| State | Writer | Reset |
| --- | --- | --- |
| adapter `positions` | `placeMarketOrder` `demo.ts:442`, `closePosition` | `positions.push` / `remove` |
| adapter `orders` | `placeMarketOrder` | appended only |
| adapter `trades` | `closePosition` | appended only |
| adapter account balance / margin / free margin | `placeMarketOrder`, `closePosition` | overwritten |
| `this.instruments` | `getInstruments` `marketData.ts:94` | re-fetched on demand |
| `riskManager` (via the gate) | `risk.ts:202` | 60 s prune |

## Emits

`MARKET_QUOTE` `types/events.ts:16` · `BAR_UPDATE` `:17` · `ORDER` `:19` ·
`POSITION_OPEN` `:20` · `POSITION_UPDATE` `:21` · `POSITION_CLOSE` `:22`.

## Subscribes to

Nothing. This adapter is a producer only.

## External dependencies

| Boundary | Line | Kind |
| --- | --- | --- |
| `https://api.hyperliquid.xyz/info` | `marketData.ts:55` | `await fetch` POST |
| `https://api.hyperliquid-testnet.xyz/info` | `marketData.ts:55` | `await fetch` POST |
| `wss://api.hyperliquid.xyz/ws` | `marketData.ts:75` | WebSocket |
| `wss://api.hyperliquid-testnet.xyz/ws` | `marketData.ts:75` | WebSocket |
| `VITE_HYPERLIQUID_NETWORK` | `config/env.ts:44` | env var (name only) |
| browser `WebSocket`, `fetch` | `marketData.ts:180, 54` | platform APIs |

## Entry points

`hyperliquidMarketData` `marketData.ts:481` — `getInstruments` `:94`, `getQuote` `:192`,
`getBars` `:205`, `getBarsInRange` `:213`, `subscribeQuote` `:223`, `subscribeBars`
`:229`, `onStatusChange` `:168`, `setNetwork` `:82`, `connect`.
`hyperliquidDemoAdapter` `demo.ts` — `placeMarketOrder` `:442`, `closePosition`,
`markToMarket`, `getPositions`, `getAccountState`, `getOrders`.

## Exit points

- `eventBus` emissions (the only in-process output).
- The application's execution state, mirrored into React by `App` effect #8.
- **No external write.** The DEMO adapter is the terminal execution boundary; it
  never contacts a signing or order-submission endpoint.
