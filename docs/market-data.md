# Market Data & Instruments

TradingVibe's only market-data provider is **Hyperliquid**, including its
**HIP-3** multi-namespace deployments.

## Supported asset groups

| Asset class | Example markets |
| ----------- | --------------- |
| Forex       | `xyz:EUR` (EUR/USD), `xyz:GBP` (GBP/USD), `xyz:JPY` (USD/JPY) |
| Commodities | `xyz:GOLD`, `xyz:SILVER`, `xyz:CL` (WTI), `xyz:BRENTOIL`, `xyz:COPPER`, `xyz:NATGAS`, `xyz:PLATINUM`, `xyz:PALLADIUM` |
| Indices     | `xyz:SP500`, `xyz:JP225`, `xyz:KR200`, `mkts:US500`, `mkts:USTECH`, `mkts:SMALL2000` |

## Discovery pipeline

```text
perpDexs + metaAndAssetCtxs (per HIP-3 namespace)
      |
      v
normalizeSymbol()            dex lowercased, asset uppercased
classifyAsset()              provider symbol -> FOREX | COMMODITY | INDEX
instrumentMetadata()         one canonical InstrumentMetadata per market
marketAvailability()         TRADEABLE | UNAVAILABLE
uniqueSymbolLabels()         disambiguates labels that collide across namespaces
      |
      v
TradingInstrument[]          active trading universe
```

Discovery is namespace aware: `xyz:GOLD` and `mkts:GOLD` are different
markets. When two namespaces publish the same asset, the app symbol is
suffixed with its namespace (`Gold (xyz)` / `Gold (mkts)`) so an order can
never be validated against a different market than the one it names.

## Discovered ≠ currently tradeable

A market can exist in provider metadata and still be untradeable right now.

* `midPx` / `markPx` present → `TRADEABLE`, included in the active universe.
* null `midPx` and `markPx` (for example a listed but unbooked or delisted
  namespace market) → `UNAVAILABLE`. Its metadata is kept and reported, it is
  **excluded from the active trading universe**, and it resolves to nothing
  for execution, risk, or sizing.

An oracle price is never promoted into an executable price, and no fallback or
synthetic quote is ever generated. `HyperliquidMarketDataAdapter.getMarketStatus()`
returns the current state with a user-safe explanation.

## The canonical instrument model

`InstrumentMetadata` (`src/types/instruments.ts`) is the single source of
instrument facts. `MarketSymbol` is that metadata plus a live price snapshot,
so a snapshot can never disagree with its instrument.

| Field | Source |
| ----- | ------ |
| `providerSymbol`, `providerMarketId` | provider name, namespace preserved verbatim |
| `providerDex` | HIP-3 namespace from `perpDexs` |
| `assetClass`, `symbol`, `displayName` | classification of the provider symbol |
| `pricePrecision` | decimals of the published price |
| `sizePrecision`, `sizeStep` | `szDecimals` |
| `tickSize` | derived from `pricePrecision` (formatting aid, not an exchange rule) |
| `pipSize` | **Forex pairs only**, from the pair's quote currency |
| `lotSize` | **Forex only**; lots are a UI representation of instrument units |
| `quoteCurrency`, `baseCurrency` | Forex pairs from the pair table; commodity/index markets are quoted in the platform account currency |
| `maxLeverage` | provider `maxLeverage`, used by the demo margin projection |
| `contractMultiplier`, `minOrderSize`, `maxOrderSize` | **undefined** — Hyperliquid does not publish them, and they are never invented |

## Instrument units are the execution contract

`volume` in orders, positions, exposure, and P&L is always provider
instrument units. Forex lots exist only in the order ticket, where they are
converted through `lotSize` and snapped onto the venue's size grid.
Commodities and indices are never divided by a lot size.

Order sizes are validated against `sizeStep` before execution: an off-grid
size is rejected, never silently corrected.

## Quotes and bars

* Quotes come from the `l2Book` subscription (real bid/ask). A BUY fills at
  the ask, a SELL at the bid; longs mark to the bid and shorts to the ask.
* Bars come from `candleSnapshot` / the `candle` stream (real OHLCV).
* Quote streams and bar streams are independent. Quote ticks never mutate
  the current candle.
* The instrument registry is refreshed in place on ticks so subscription
  setup does not restart on every price change.

## Connection status

`ConnectionStatus` reflects the websocket: `DISCONNECTED`, `CONNECTING`,
`CONNECTED`, `RECONNECTING`, `ERROR`. Status changes are emitted on the
event bus and surfaced in the UI.
