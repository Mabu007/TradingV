# Chain: Bot Backtest

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the user taps "Run backtest" in the `BotBuilderModal` test stage.

**Confidence:** CONFIRMED.

---

```
[1] "Run backtest" button                              BotBuilderModal.tsx:227
    └─ runTest()                                        BotBuilderModal.tsx:190
       └─ onBacktest(definition, testMarket, testTimeframe, testBalance,
                     start, end, setTestProgress)        BotBuilderModal.tsx:196
          ↓
[2] App.handleRunBotBacktest(...)                       App.tsx:1555-1712
```

## Stage 1 — App handler preconditions

| Step | Line | Action |
| --- | --- | --- |
| key gate | `:1570-1574` | `requireOpenRouterKey()`; **throws** if absent |
| fetch bars | `:1585` | `await historicalMarketDataProvider.getBars({ marketId, timeframe, start, end })` |
| empty guard | `:1594-1601` | throws when the range returns no bars |
| deployment | `:1609` | `createDeployment({ mode: 'paper', … })` |
| symbol metadata | `:1636-1644` | `marketDataService.getSymbol(marketId)`; throws when unknown |
| run | `:1651-1711` | `await runBotDefinitionBacktest({ …, onProgress })` |

## Stage 2 — historical data fetch

```
historicalMarketDataProvider.getBars({marketId, timeframe, start, end})   App.tsx:1585
   → engine/backtester/historical.ts:40-42
   → hyperliquidMarketData.getBarsInRange(symbol, timeframe, startTime, endTime)
                                                        marketData.ts:213
   → await fetch POST {REST}/info
        { type: 'candleSnapshot',
          req: { coin, interval, startTime, endTime } }   marketData.ts:213+
   → normalizer.fromHyperliquidCandle → Bar[]
```

Provider singleton: `historicalMarketDataProvider` — `engine/backtester/historical.ts:53`.
`HyperliquidHistoricalMarketDataProvider` implements the `MarketDataProvider` interface
from `src/adapters/marketData.ts`.

## Stage 3 — the backtest engine

```
runBotDefinitionBacktest({ definition, deployment, runtimeSymbol, timeframe,
                           bars, initialBalance, pipSize, spreadPips, slippagePips,
                           spreadPrice, commissionPerLot: 3.5, lotSize,
                           pricePrecision, gaps, onProgress })     App.tsx:1651-1711
   ↓ engine/agents/backtest.ts:139
```

### `BacktestEnvironment` construction — `environment/backtest.ts:50-375`

| Field | Line | Initial value |
| --- | --- | --- |
| `mode` | `:51` | `'BACKTEST'` |
| `balance` / `equity` / `maxEquitySeen` | `:52-54` | `initialBalance` |
| `currentBarIndex` | `:55` | 0 |
| `bars` | `:56` | the fetched array (empty rejected at `:96`) |
| `positions` | `:57` | `new Map()` |
| `closedTrades` | `:58` | `[]` |
| `spreadPrice` / `slippagePrice` | `:59-60` | converted from pips in the constructor `:83-95` |
| `commissionPerLot` | `:61` | 3.5 (from `App.tsx:1663`) |
| `lotSize` | `:62` | `DEFAULT_BACKTEST_LOT_SIZE = 100_000` `:45` |
| `leverage` | `:63` | `DEFAULT_BACKTEST_LEVERAGE = 100` `:48` |
| `pricePrecision` | `:64` | from the instrument |
| `initialBalance` | `:65` | |
| `symbol` | `:66` | `runtimeSymbol` |
| `nextPositionId` | `:67` | 0 |
| `pendingOrders` | `:68` | `[]` |
| `equityCurve` | `:69` | `[]` |
| `nextTradeId` | `:70` | 0 |

### The per-bar loop

```
for each bar:
   BacktestEnvironment.setBarIndex(i) / advanceBar()        backtest.ts:111, :117
      └─ evaluateOpenPositions(bar)                          backtest.ts:126-188
           ├─ SL / TP checks per side                       backtest.ts:131-147
           ├─ P&L = priceDiff * volume                      backtest.ts:150-151
           ├─ closedTrades.push(new Trade)                  backtest.ts:154-169
           ├─ unrealised mark for open positions             backtest.ts:173-178
           └─ equity update + drawdown                      backtest.ts:182-187
      recordEquity(...)                                      backtest.ts:190-199
   replayAgentBacktest(runtime, agentId, environment)        backtest.ts:377-395
      └─ runtime.step(agentId, { type: 'NEW_BAR', … }) per bar
   onProgress(...)
finalize()                                                  backtest.ts:275-280
   ├─ close all remaining positions                          backtest.ts:276
   └─ record the final equity point                          backtest.ts:277-279
```

### Backtest-specific behaviour of the shared agent code

| Concern | Difference | Evidence |
| --- | --- | --- |
| **Clock** | `nowFor(instance)` returns the current bar's timestamp instead of `Date.now()` | `runtime.ts:1371-1382` |
| **Duration measurement** | uses the env clock for `BACKTEST` | `runtime.ts:727-734` |
| **Quote** | `getMarketQuote` synthesises bid = the bar's close, ask = bid + spread, `status: 'MOCK'` | `backtest.ts:201-216` |
| **Bars visibility** | `getMarketBars` returns the **prefix only**: `slice(start, currentBarIndex+1)` | `backtest.ts:218-224` — no look-ahead |
| **Order fill** | `placeMarketOrder` fills at ask + slippage (BUY) / bid − slippage (SELL) and deducts commission | `backtest.ts:282-321` |
| **Position id** | `sim_pos_<barIndex>_<n>` | `backtest.ts:294` |
| **Account** | margin = notional / leverage; `dailyPnL = equity - initialBalance` | `backtest.ts:226-251` |
| **Triggers** | `TriggerEngine` filters agents by `env.mode === sourceEnvironment`; a backtest agent only sees `BACKTEST` inputs | `engine.ts:82, 121, 203, 285` |

## Stage 4 — where the result goes

```
BotBacktestResult returned to BotBuilderModal.runTest        BotBuilderModal.tsx:196
   └─ setTestResult(result)                                   BotBuilderModal.tsx:126
   └─ setTestProgress(pct)                                    BotBuilderModal.tsx:128
```

**CONFIRMED** — the result is held in `BotBuilderModal` local state. `App.backtestResult`
(`App.tsx:259-260`) has no writer, so `BotsTab.backtestResult` (`App.tsx:2527`) is
always `null` and the "Backtest Results" panel in `BotsTab` never renders.

`BotsTab.handleExecuteBacktest` (`BotsTab.tsx:146-151`) calls the **stub** passed at
`App.tsx:2467` — `async () => null` — not `handleRunBotBacktest`.

## State summary

| State | Owner | Reset |
| --- | --- | --- |
| `BacktestEnvironment` (18 fields) | `environment/backtest.ts:52-70` | per run — a new instance |
| `equityCurve` | `backtest.ts:69`, `:271-273` | per run |
| `closedTrades` | `backtest.ts:58`, `:154-169` | per run |
| `instances[*].memory` | `ScopedAgentMemory` | **not** reset between runs — the same `agentRuntime` singleton is used, so `decisionHistory` accumulates across backtests |
| `agentRuntime.auditLog` | `runtime.ts:1289` | `clearAuditTrail()` `runtime.ts:1776` — not called by the backtest path |
| `BotBuilderModal` local `testResult` / `testProgress` | `BotBuilderModal.tsx:126, 128` | modal close |

## Exit points

- Hyperliquid `candleSnapshot` REST call (`marketData.ts:213`).
- One OpenRouter call per agent wake inside the loop, if a key is configured
  (`runtime.ts:522` → `provider.ts:194`).
- No order reaches any external endpoint — `BacktestEnvironment` fills locally.
