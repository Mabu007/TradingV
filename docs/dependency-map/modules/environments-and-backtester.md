# Module 10 — Environments & Backtester

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/environment/{index,demo,backtest,live}.ts`,
`src/engine/backtester/{simulator,historical,historicalTests}.ts`,
`src/engine/agents/backtest.ts`, `src/engine/sandbox/sandboxEnv.ts`

**Purpose:** the execution-environment abstraction that separates "what an agent may
do" from "where the fills happen", plus the bar-replay machinery that makes a
deterministic backtest possible.

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `agents/types.ts` | 295 | `ITradingEnvironment` `:91-128` (the interface) |
| `environment/index.ts` | 3 | the barrel |
| `environment/demo.ts` | 72 | `DemoEnvironment` `:8-68` |
| `environment/backtest.ts` | 395 | `BacktestEnvironmentConfig` `:16-42`, `DEFAULT_BACKTEST_LOT_SIZE = 100_000` `:45`, `DEFAULT_BACKTEST_LEVERAGE = 100` `:48`, `BacktestEnvironment` `:50-375`, `replayAgentBacktest` `:377-395` |
| `environment/live.ts` | 5 | `createLiveEnvironment()` `:3-5` — **throws** |
| `agents/backtest.ts` | 824 | `runBotDefinitionBacktest` `:139` |
| `backtester/simulator.ts` | 477 | `BACKTEST_LOT_SIZE = 100_000` `:21`, `BACKTEST_MARGIN_LEVERAGE = 100` `:27`, `BacktestSimulator` `:29` |
| `backtester/historical.ts` | — | `HyperliquidHistoricalMarketDataProvider`; singleton `historicalMarketDataProvider` `:53` |
| `sandbox/sandboxEnv.ts` | — | `prepareStrategyFunction(code)` `:31`, `createWorkerBlobScript()` `:81` |

---

## The interface

`ITradingEnvironment` — `src/engine/agents/types.ts:91-128`

| Member | Required | Notes |
| --- | --- | --- |
| `mode` | yes | `'BACKTEST' \| 'DEMO' \| 'LIVE'` |
| `getMarketQuote(symbol)` | yes | |
| `getMarketBars(symbol, timeframe, count)` | yes | |
| `getInstruments()` | optional | read by `resolveInstruments` `runtime.ts:1352-1369` |
| `getAccountState()` | yes | with `dailyPnL`, optional `realisedSessionPnL`, `drawdownPercent` |
| `getPositions()` | yes | |
| `getOrders()` | yes | |
| `placeMarketOrder(request)` | yes | |
| `placeLimitOrder(request)` | optional | |
| `cancelOrder(id)` | optional | |
| `modifyPosition(id, changes)` | yes | |
| `closePosition(id, volume?)` | yes | |

**Selection is not a runtime branch** — the instance is a constructor argument to
`registerAgent(agent, env)` (`runtime.ts:84-87`) and is stored on `AgentInstance.env`
(`runtime.ts:31`). Everything downstream reads `instance.env.mode`:
`runtime.ts:112` (reject LIVE), `:728` (duration clock), `:1374-1381` (clock),
`engine.ts:82, 121, 203, 285` (agent filter), `registry.ts:26, 96` (refuse LIVE triggers).

**App wiring** — `new DemoEnvironment()` at `App.tsx:1182`, passed to `registerBot`
`App.tsx:1185`. `App.executionMode` (`App.tsx:180`) is a **UI label** and is not what
selects the environment.

---

## `DemoEnvironment` — `environment/demo.ts:8-68`

`mode = 'DEMO'` `:9`; `adapter = hyperliquidDemoAdapter` `:10`. Pure delegation:

| Method | Line | Delegates to |
| --- | --- | --- |
| `getMarketQuote` | `:12-14` | `demo.ts:12` → `marketData.ts:192` |
| `getMarketBars` | `:16-19` | `demo.ts:16` (timeframe guard `:17`; `isTimeframe` `:70-72`) |
| `getInstruments` | `:26-28` | `demo.ts:26` → `marketData.ts:398` |
| `getAccountState` | `:30-32` | `demo.ts:30` |
| `getPositions` | `:34-36` | `demo.ts:34` |
| `getOrders` | `:38-40` | `demo.ts:38` |
| `placeMarketOrder` | `:42-51` | `demo.ts:442` |
| `placeLimitOrder` | `:53-55` | `demo.ts` |
| `cancelOrder` | `:57-59` | `demo.ts` |
| `modifyPosition` | `:61-63` | `demo.ts` |
| `closePosition` | `:65-67` | `demo.ts` |

---

## `BacktestEnvironment` — `environment/backtest.ts:50-375`

**Mutable state — 18 fields, `:52-70`**

| Field | Line | Purpose |
| --- | --- | --- |
| `balance` / `equity` / `maxEquitySeen` | `:52-54` | |
| `currentBarIndex` | `:55` | |
| `bars` | `:56` | empty rejected `:96` |
| `positions` | `:57` | `Map<string, Position>` |
| `closedTrades` | `:58` | |
| `spreadPrice` / `slippagePrice` | `:59-60` | converted from pips in the constructor `:83-95` |
| `commissionPerLot` | `:61` | 3.5 (from `App.tsx:1663`) |
| `lotSize` | `:62` | `DEFAULT_BACKTEST_LOT_SIZE` `:45` |
| `leverage` | `:63` | `DEFAULT_BACKTEST_LEVERAGE` `:48` |
| `pricePrecision` | `:64` | |
| `initialBalance` | `:65` | |
| `symbol` | `:66` | |
| `nextPositionId` | `:67` | |
| `pendingOrders` | `:68` | |
| `equityCurve` | `:69` | |
| `nextTradeId` | `:70` | |

**Methods**

| Method | Line |
| --- | --- |
| `getCurrentBar` / `getBarIndex` / `getBarCount` | `:99` / `:103` / `:107` |
| `setBarIndex` (calls `evaluateOpenPositions`) | `:111-115` |
| `advanceBar` | `:117-124` |
| `evaluateOpenPositions(bar)` | `:126-188` |
| `recordEquity` | `:190-199` |
| `getMarketQuote` (bid = bar close, ask = bid + spread, `status: 'MOCK'`) | `:201-216` |
| `getMarketBars` — **prefix only** `slice(start, currentBarIndex+1)` | `:218-224` |
| `getAccountState` (margin = notional / leverage; `dailyPnL = equity - initialBalance`) | `:226-251` |
| `getOrders` / `getPositions` | `:253-255` / `:257-260` |
| `costForVolume` | `:263-265` |
| `getClosedTrades` / `getEquityCurve` | `:267-269` / `:271-273` |
| `finalize` (closes all, records equity) | `:275-280` |
| `placeMarketOrder` (fills at ask + slippage / bid − slippage; id `sim_pos_<barIndex>_<n>`; commission `:314`) | `:282-321` |
| `modifyPosition` | `:323-330` |
| `closePosition` | `:332-374` |
| `replayAgentBacktest(runtime, agentId, environment)` | `:377-395` |

`evaluateOpenPositions(bar)` `:126-188`: SL/TP checks per side `:131-147`;
P&L = `priceDiff * volume` `:150-151`; `closedTrades.push` `:154-169`;
unrealised mark `:173-178`; equity + drawdown `:182-187`.

**The no-look-ahead property (CONFIRMED)** — `getMarketBars` returns
`slice(start, currentBarIndex + 1)` (`:218-224`), so an agent can only see bars up to
and including the current one.

---

## `createLiveEnvironment()` — `environment/live.ts:3-5`

```python
raise RuntimeError(
  'LIVE agent execution is not available until an explicitly confirmed '
  'production environment adapter is implemented.'
)
```

Reinforced at registration: `registerAgent` throws for `env.mode === 'LIVE'`
(`runtime.ts:112-116`), and `TriggerRegistry` refuses LIVE triggers
(`registry.ts:26, 96`).

---

## `runBotDefinitionBacktest` — `agents/backtest.ts:139`

Called from `App.handleRunBotBacktest` — `App.tsx:1651-1711`.
Constructs a `BacktestEnvironment` (`environment/backtest.ts:50`) and drives
`replayAgentBacktest` per bar.

**Backtest-specific behaviour of the shared agent code**

| Concern | Difference | Evidence |
| --- | --- | --- |
| Clock | the backtest bar's timestamp, not `Date.now()` | `runtime.ts:1371-1382` |
| Duration measurement | uses the env clock when `mode === 'BACKTEST'` | `runtime.ts:727-734` |
| Session | `market.getSession` reads the current bar time | `capabilities/market.ts:177-180` |
| Trigger routing | the engine filters agents by `env.mode` | `engine.ts:82, 121, 203, 285` |

Full flow in [chains/bot-backtest.md](../chains/bot-backtest.md).

---

## `backtester/simulator.ts`

`BacktestSimulator` `:29`, `constructor(config: BacktestConfig)` `:45`.
`BACKTEST_LOT_SIZE = 100_000` `:21`; `BACKTEST_MARGIN_LEVERAGE = 100` `:27` —
the same constants as `environment/backtest.ts:45, 48`.

**Two independent backtest engines exist** — `BacktestSimulator`
(`backtester/simulator.ts`) and `BacktestEnvironment`
(`environment/backtest.ts`). `runBotDefinitionBacktest` (`agents/backtest.ts:139`)
uses `BacktestEnvironment`. No `src/` file imports `BacktestSimulator`
outside `backtester/`.

---

## `backtester/historical.ts`

`HyperliquidHistoricalMarketDataProvider` implements the `MarketDataProvider`
interface from `src/adapters/marketData.ts` by delegating to
`hyperliquidMarketData.getBarsInRange(...)` — `historical.ts:40-42`.
Singleton `historicalMarketDataProvider` `:53`, consumed at `App.tsx:1585`.

---

## `sandbox/sandboxEnv.ts`

| Symbol | Line | Notes |
| --- | --- | --- |
| `prepareStrategyFunction(code)` | `:31` | strips import/export statements `:32`; `new Function(wrapperCode)` `:71` |
| `createWorkerBlobScript()` | `:81` | |

**No production consumer (CONFIRMED)** — no `src/` file imports this module; only
`src/engine/core/securityTests.ts` exercises it.

---

## Depends on

| Module | How |
| --- | --- |
| Hyperliquid Adapters | `demo.ts:10`, `historical.ts:40-42` |
| Policy & Risk | indirectly, through the adapter's gates |
| Bot Definitions | `runBotDefinitionBacktest` takes a `BotDefinition` (`backtest.ts:139`) |
| Agent Runtime | `replayAgentBacktest` calls `runtime.step` per bar (`backtest.ts:377-395`) |
| Capabilities | `env` is the `CapabilityContext.env` field |

## Used by

| Consumer | Line |
| --- | --- |
| `App` | `new DemoEnvironment()` `:1182`; `historicalMarketDataProvider` `:1585` |
| `AgentRuntime` | `instance.env` throughout |
| `capabilities/*` | `context.env.*` |
| `runBotDefinitionBacktest` | `agents/backtest.ts:139` |
| `builtins/register.ts` | `new DemoEnvironment()` default `:5-10` |
| Test runners (test-only) | `agents/backtestTests.ts`, `backtester/historicalTests.ts`, `core/securityTests.ts` |

## Reads

`env.mode` · `bars` · `positions` · `account` (all environment-local) ·
`historical.ts` reads the Hyperliquid candle endpoint ·
`replayAgentBacktest` reads `runtime.getAgent(agentId)`.

## Writes

| Target | Line |
| --- | --- |
| `BacktestEnvironment` 18 fields | `backtest.ts:111-374` |
| `BacktestEnvironment.positions` | `placeMarketOrder` `:282-321`, `closePosition` `:332-374` |
| `BacktestEnvironment.closedTrades` | `evaluateOpenPositions` `:154-169` |
| `BacktestEnvironment.equityCurve` | `recordEquity` `:190-199` |
| adapter state (via `DemoEnvironment`) | `demo.ts` |

## Mutates

- `setBarIndex` / `advanceBar` mutate `currentBarIndex` and then run
  `evaluateOpenPositions` (`backtest.ts:111-124`).
- `finalize` closes every remaining position (`:275-280`).
- **`agentRuntime` memory and `auditLog` are not reset between backtest runs** — the
  same singleton is used, so `decisionHistory` accumulates.

## Emits

None from the environments themselves. The `DEMO` environment's mutations cause
`eventBus` `POSITION_*` emissions inside the adapter.

## Subscribes to

Nothing.

## External dependencies

- Hyperliquid `candleSnapshot` REST — `marketData.ts:213` (via `historical.ts`).
- Hyperliquid `l2Book` REST — `marketData.ts:195` (via `demo.ts` order pricing).
- `new Function` — `sandbox/sandboxEnv.ts:71` (test-only consumer).
- Browser `URL` / `Worker` blob — `sandbox/sandboxEnv.ts:81` (test-only consumer).

## Entry points

`DemoEnvironment` constructor `environment/demo.ts:8` ·
`BacktestEnvironment` constructor `:50` · `replayAgentBacktest` `:377` ·
`runBotDefinitionBacktest` `agents/backtest.ts:139` ·
`historicalMarketDataProvider` `backtester/historical.ts:53` ·
`prepareStrategyFunction` `sandbox/sandboxEnv.ts:31`.

## Exit points

`env.placeMarketOrder` / `modifyPosition` / `closePosition` — the only route from an
agent to a fill. For `DEMO` that is the Hyperliquid adapter; for `BACKTEST` it is
in-process arithmetic. `createLiveEnvironment` throws, so there is no third route.
