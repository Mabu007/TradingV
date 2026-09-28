# TradingVibe Strategy SDK Reference

Strategies are implemented in TypeScript as default exported asynchronous functions:

```ts
export default async function strategy(ctx: TradingContext): Promise<void>
```

## `ctx.market`

- `quote(symbol?: string): Promise<Quote>`
  Returns the current real-time bid, ask, and spread for the requested symbol.
- `bars(options?: { symbol?: string; timeframe?: Timeframe; limit?: number }): Promise<Bar[]>`
  Fetches chronological candlestick bars (`open`, `high`, `low`, `close`, `volume`, `time`).

## `ctx.indicators`

- `sma(values: number[], period: number): number[]`
  Computes Simple Moving Average.
- `ema(values: number[], period: number): number[]`
  Computes Exponential Moving Average with smoothing.
- `rsi(values: number[], period?: number): number[]`
  Computes Wilder's Relative Strength Index (0–100).
- `macd(values: number[], fast?, slow?, signal?): { macd, signal, histogram }`
  Computes Moving Average Convergence Divergence.
- `bollingerBands(values: number[], period?, stdDev?): { upper, middle, lower }`
  Computes Bollinger Band envelopes.
- `atr(bars: Bar[], period?): number[]`
  Computes Average True Range for dynamic volatility stop placement.

## `ctx.account`

- `balance(): number` — Returns available cash balance.
- `equity(): number` — Returns real-time equity (balance + unrealized P&L).
- `margin(): number` — Returns margin consumed by open positions.
- `freeMargin(): number` — Returns equity minus used margin.
- `positions(symbol?: string): Position[]` — Returns currently open positions.

## `ctx.orders`

- `market(request: MarketOrderRequest): Promise<OrderResult>`
  Submits a market order. Supports `symbol`, `side: 'BUY' | 'SELL'`, `volume`, `stopLoss`, and `takeProfit`.
- `limit(request: LimitOrderRequest): Promise<OrderResult>`
  Submits a limit order at specified entry price.
- `cancel(orderId: string): Promise<void>`
  Cancels a pending order.
- `closePosition(positionId: string): Promise<void>`
  Closes an active position at current market price.

## `ctx.state`

- `get<T>(key: string): T | undefined`
- `set<T>(key: string, value: T): void`
- `clear(): void`
  Stores custom strategy state variables across successive bar evaluations.

## `ctx.signal` & `ctx.log`

- `signal(event: SignalEvent): void`
  Creates a visual entry marker on the TradingView chart (e.g. `▲ AI BUY`).
- `log(message: string, data?: unknown): void`
  Appends timestamped event logs to the in-app terminal panel.
