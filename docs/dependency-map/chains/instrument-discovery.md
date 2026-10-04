# Chain: Instrument Discovery

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** `App` mount effect #2.

**Confidence:** CONFIRMED for the code path. The set of returned instruments depends on
what the venue lists and is therefore DYNAMIC.

---

```
[1] src/App.tsx:416   useEffect([], "Hyperliquid instrument discovery")
    ↓
[2] hyperliquidMarketData.getInstruments(['FOREX','COMMODITY','INDEX'])   marketData.ts:94
    ↓ await fetch(POST https://api.hyperliquid.xyz/info)                 marketData.ts:54
```

## Stage 1 — REST call

| | |
| --- | --- |
| **Input** | `assetClasses: AssetClass[] = ['FOREX','COMMODITY','INDEX']` — `marketData.ts:94` |
| **URL** | `https://${network === 'mainnet' ? 'api.hyperliquid.xyz' : 'api.hyperliquid-testnet.xyz'}/info` — `marketData.ts:55`; stored as `this.restUrl` `:75` |
| **Network** | from `hyperliquidNetwork()` — `config/env.ts:43-47` reading `VITE_HYPERLIQUID_NETWORK` |
| **Body** | Hyperliquid public `/info` RPC shapes |
| **Output** | raw JSON |

## Stage 2 — normalisation

`src/adapters/hyperliquid/normalizer.ts` supplies the four transformations
(imported at `marketData.ts:5`):

| Function | Role |
| --- | --- |
| `classifyAsset(providerSymbol)` | provider prefix → `AssetClass` |
| `instrumentMetadata(...)` | canonical `InstrumentMetadata` (decimals, size decimals, pip size, lot size) |
| `marketAvailability(...)` | `TRADEABLE` vs `UNAVAILABLE` + a reason |
| `tradingInstrument(...)` | the `TradingInstrument` UI record |
| `normalizeSymbol` | provider symbol ↔ display symbol |
| `uniqueSymbolLabels` | de-duplicated display labels |
| `toHyperliquidInterval` | `Timeframe` → provider interval |
| `fromHyperliquidCandle`, `quoteFromBook` | candle and book shapes → `Bar` / `Quote` |

**The same set of functions also normalizes candles and quotes**, so discovery,
`getBars`, and `getQuote` share one venue-shape translation layer.

## Stage 3 — state writes

```
[3] setInstruments(discovered)                              App.tsx:426
[4] marketDataService.setSymbols(markets)                    App.tsx:436
       → MarketDataService internal symbol list              services/marketData.ts:35
[5] setSymbol(kept if still available, else the first)      App.tsx:443-452
```

| | |
| --- | --- |
| **Mutation** | `App.instruments` `App.tsx:174-175`; `MarketDataService` symbol list; `App.symbol` `:171-172` |
| **On failure** | `eventBus.emit({type:'LOG', id:'market-discovery-error', …})` — `App.tsx:460-471`; `instruments` stays `[]` |
| **Cleanup** | `cancelled = true` — `App.tsx:475` |

## Stage 4 — the four downstream effects of `instruments` changing

### 4a. `subscribedInstrumentIds` → quote subscriptions

```
subscribedInstrumentIds = useMemo(
  () => instruments.map(i => i.id).join('|'), [instruments])   App.tsx:596-602
   ↓ used only as an effect dependency
useEffect([subscribedInstrumentIds], …) → for each instrument:
    hyperliquidMarketData.subscribeQuote(symbol, callback)       App.tsx:611
      ├ setQuotes(prev => ({...prev, [quote.symbol]: quote}))   App.tsx:614
      ├ marketDataService.updateLastPrice(sym, (bid+ask)/2)      App.tsx:624
      └ hyperliquidDemoAdapter.markToMarket(quote)               App.tsx:637
```

The string-keyed memo exists so that a price tick (which replaces a `Quote` object but
does not change the instrument id set) does not tear down and re-create N WebSocket
subscriptions.

**Cleanup** — `unsubscribers.forEach(u => u())` at `App.tsx:645-648`. There is an early
return at `App.tsx:605` when `instruments.length === 0`, and that early return path
registers **no** cleanup.

### 4b. `discoveredSymbols` → `QuotesTab`

```
discoveredSymbols = useMemo(() => instruments.map(i => i.market),
                            [instruments])                       App.tsx:2063-2077
   ↓ <QuotesTab symbols={discoveredSymbols} />                 App.tsx:2366
```

### 4c. `marketsFromDiscovery(instruments)` → `BotsTab`

`App.tsx:2437` — the bot list and builder get their market list from the same
instrument set.

### 4d. AI context

`App.tsx:1916` — the `markets[]` slice of the published snapshot, which is what
`getAvailableMarkets()` (`services/aiContext/tools.ts:76`) and `getMarketQuote()`
(`tools.ts:101`) read.

## Where the instrument metadata then flows

| Consumer | Path |
| --- | --- |
| `DemoEnvironment.getInstruments()` | `environment/demo.ts:26-28` |
| `AgentRuntime.resolveInstruments(instance)` | `runtime.ts:886` → `:1352-1369` |
| `ActionValidator` context | `policy/validator.ts:29-35`, used at `:154-186`, `:220-244` |
| `RiskManager` valuation context | `execution/risk.ts:27-32`; `valuation.lookupFrom` `:459-474` |
| `market.getSpread` (pip-size branch) | `capabilities/market.ts:129-131` |
| `indicators.atr` (`latestPips`) | `capabilities/indicators.ts:185-187` |
| `structure.breakout` (pip buffer) | `capabilities/structure.ts:217-224` |
| `HyperliquidDemoAdapter` order guard | `demo.ts:457` |
| `BacktestEnvironment` lot/pip size | `App.tsx:1636-1644` reads `marketDataService.getSymbol` |

## The Python-side parallel

The engine performs its own discovery with a separate implementation:

```
Hyperliquid /info {type:'perpDexs'}                    marketdata.py:155
   ↓ per-dex {type:'metaAndAssetCtxs', dex}            marketdata.py:175
   ↓ a per-dex MarketDataError is skipped (continue)   marketdata.py:176-177
   ↓ availability from midPx, falling back to markPx   marketdata.py:204-206
   ↓ > 0 → TRADEABLE, else UNAVAILABLE + a reason      marketdata.py:208-212
   ↓ Instrument objects                                  marketdata.py:75
   ↓
   ├─ API GET /instruments                              api.py:253-267
   └─ MonitorContextBuilder.for_symbol (tradeable gate) store.py:194-195
```

**CONFIRMED** — `oraclePx` is never read; the code only consults `midPx` then
`markPx` (`marketdata.py:204-206`).

**Two independent implementations** of the same availability rule exist — one in
`src/adapters/hyperliquid/normalizer.ts` (TypeScript) and one in
`server/tradingv_engine/marketdata.py` (Python). They are not shared code.

## Effect on `subscribedInstrumentIds` when the network changes

`App.tsx:2802-2811` — `HyperliquidSettingsModal.onSave` sets `hyperliquidNetwork` and
calls `hyperliquidMarketData.setNetwork(network)` (`marketData.ts:82`). Because
`instruments` is not re-fetched by that handler, the discovery effect (which has `[]`
deps) does not re-run. **INFERRED** — the subscription teardown/setup in effect #5 is
keyed on instrument ids rather than network, so a network switch does not by itself
restart discovery.
