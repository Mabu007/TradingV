export const TRADING_CONTEXT_DTS = `
export type OrderSide = 'BUY' | 'SELL';
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Quote {
  symbol: string;
  timestamp: number;
  bid: number;
  ask: number;
  spread: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnL: number;
  unrealizedPnlPercent: number;
  timestamp: number;
}

export interface MarketOrderRequest {
  symbol: string;
  side: OrderSide;
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
}

export interface LimitOrderRequest extends MarketOrderRequest {
  price: number;
  expirationTime?: number;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  executionPrice?: number;
  status: 'FILLED' | 'REJECTED' | 'CANCELLED';
  timestamp: number;
  errorMessage?: string;
}

export interface SignalEvent {
  symbol: string;
  side: OrderSide | 'INFO';
  timestamp: number;
  price: number;
  title: string;
  reason: string;
  confidence?: number;
}

export interface TradingContext {
  market: {
    /** Get real-time bid, ask and spread for a symbol */
    quote(symbol?: string): Promise<Quote>;
    /** Fetch historical candlestick bars */
    bars(options?: { symbol?: string; timeframe?: Timeframe; limit?: number }): Promise<Bar[]>;
  };

  indicators: {
    /** Simple Moving Average */
    sma(values: number[], period: number): number[];
    /** Exponential Moving Average */
    ema(values: number[], period: number): number[];
    /** Relative Strength Index (0-100) */
    rsi(values: number[], period?: number): number[];
    /** Moving Average Convergence Divergence */
    macd(values: number[], fast?: number, slow?: number, signal?: number): {
      macd: number[];
      signal: number[];
      histogram: number[];
    };
    /** Bollinger Bands (upper, middle, lower) */
    bollingerBands(values: number[], period?: number, stdDev?: number): {
      upper: number[];
      middle: number[];
      lower: number[];
    };
    /** Average True Range */
    atr(bars: Bar[], period?: number): number[];
  };

  account: {
    /** Available account cash balance */
    balance(): number;
    /** Current real-time equity (balance + unrealized P&L) */
    equity(): number;
    /** Margin used by open positions */
    margin(): number;
    /** Available free margin */
    freeMargin(): number;
    /** Retrieve list of currently open positions */
    positions(symbol?: string): Position[];
  };

  orders: {
    /** Submit a market order with optional stopLoss and takeProfit */
    market(request: MarketOrderRequest): Promise<OrderResult>;
    /** Submit a limit order */
    limit(request: LimitOrderRequest): Promise<OrderResult>;
    /** Cancel a pending order */
    cancel(orderId: string): Promise<void>;
    /** Close an open position by its ID */
    closePosition(positionId: string): Promise<void>;
  };

  state: {
    /** Retrieve persisted custom strategy variable across bars */
    get<T>(key: string): T | undefined;
    /** Store custom strategy variable across bars */
    set<T>(key: string, value: T): void;
    /** Clear custom strategy state */
    clear(): void;
  };

  /** Record a strategy signal overlay on the trading chart */
  signal(event: SignalEvent): void;

  /** Log message with timestamp to IDE terminal */
  log(message: string, data?: unknown): void;
}

declare const ctx: TradingContext;
`;
