# Backtesting Engine

This document details the historical backtesting simulator, financial simulation metrics, and CSV reporting engine in **TradingVibe**.

---

## 1. Simulation Architecture (`src/engine/backtester/simulator.ts`)

The **BacktestSimulator** replays historical price bars tick-by-tick or bar-by-bar, evaluating the identical TypeScript strategy code used in live/demo environments.

```mermaid
graph TD
    History[Historical Bar Feed (300+ bars)] --> Step[Bar Replay Engine]
    Step --> Context[Mock TradingContext]
    Context --> Strategy[strategy.ts Function]
    Strategy --> Signals[Orders / Signals]
    Signals --> SimBroker[Simulated Broker]
    SimBroker --> Math[Spread, Commission & Slippage Math]
    Math --> Book[Position & Trade Ledger]
    Book --> Curves[Equity Curve & Drawdown Calculator]
    Curves --> Output[BacktestResult & CSV Export]
```

---

## 2. Realistic Market Simulation

Unlike naive backtesters that assume fills occur exactly at bar close prices with zero transaction costs, TradingVibe incorporates realistic institutional friction:

1. **Spread Simulation**: Orders pay a configurable spread, expressed as a raw price distance or, for pip-quoted Forex instruments, in pips. Buy orders enter at Ask, Sell orders at Bid.
2. **Commission Simulation**: Standard institutional commission of **$3.50 per lot** ($7.00 round turn).
3. **Slippage Modeling**: Configurable micro-slippage (raw price distance or pips) accounts for execution delay and depth. Spread, slippage, and commission are simulation parameters, not venue fees.
4. **Intra-Bar High/Low Stop Loss Triggering**: Stop Loss and Take Profit levels are evaluated against each bar's `high` and `low`, not just the closing price.

---

## 3. Backtest Metrics & Result Output

Every backtest generates a comprehensive `BacktestResult` object:

* **Net Profit ($ and %)**: Total realized earnings after all commissions and spreads.
* **Win Rate (%)**: Percentage of profitable closed trades.
* **Profit Factor**: Gross profits divided by gross losses.
* **Max Drawdown ($ and %)**: Maximum peak-to-trough decline in net equity.
* **Sharpe Ratio**: Annualized risk-adjusted return ratio.
* **Equity Curve**: Array of timestamped points tracking balance and equity over time.
* **Signals**: Buy and sell event markers plotted on the chart.

---

## 4. RFC 4180 CSV Export (`src/utils/csvExport.ts`)

Traders can download complete transaction logs with one click for external quantitative analysis in **Microsoft Excel**, **Python (pandas)**, or **R**.

### Exported Columns:
1. `Trade ID`
2. `Strategy`
3. `Symbol`
4. `Side` (BUY / SELL)
5. `Volume (Lots)`
6. `Entry Time (UTC)`
7. `Exit Time (UTC)`
8. `Entry Timestamp` (Unix epoch)
9. `Exit Timestamp` (Unix epoch)
10. `Duration (Seconds)`
11. `Entry Price`
12. `Exit Price`
13. `PnL ($)`
14. `PnL (%)`
15. `Return (%)`
16. `Commission ($)`
17. `Exit Reason` (`TAKE_PROFIT`, `STOP_LOSS`, `SIGNAL_CLOSE`, `MANUAL`)
