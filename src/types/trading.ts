/**
 * TradingGOATs Domain Models & Trading Context Types
 * Core abstractions shared across Backtest, Demo, and Live environments.
 */

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type AssetClass = 'FOREX' | 'COMMODITY' | 'INDEX';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';

export type OrderStatus = 'PENDING' | 'FILLED' | 'REJECTED' | 'CANCELLED';

export type ExecutionMode = 'BACKTEST' | 'DEMO' | 'LIVE';

export type GoatStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';

export interface Bar {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Quote {
  symbol: string;
  timestamp: number; // Unix timestamp in milliseconds
  bid: number;
  ask: number;
  spread: number;
}

/**
 * Live price snapshot. Instrument facts live in InstrumentMetadata so a
 * snapshot can never disagree with the instrument it describes.
 */
export interface MarketSnapshot {
  lastPrice: number;
  change24h: number;
  high24h: number;
  low24h: number;
}

export interface MarketOrderRequest {
  symbol: string;
  side: OrderSide;
  volume: number; // In units (e.g. 10,000 = 0.10 standard lots)
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /**
   * A stable identifier for *this decision to trade*, not for this attempt.
   *
   * Every retry of a submission — a user clicking again, a reconnecting
   * client re-sending, an agent waking twice on the same evidence — must
   * carry the same value. Without it, "did this already go through?" cannot
   * be answered, and the only safe-looking answer is to send it again.
   */
  idempotencyKey?: string;
}

export interface LimitOrderRequest extends MarketOrderRequest {
  price: number;
  expirationTime?: number;
}

export interface OrderResult {
  orderId: string;
  positionId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  volume: number;
  requestedPrice?: number;
  executionPrice?: number;
  status: OrderStatus;
  timestamp: number;
  errorMessage?: string;
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
  swap?: number;
  commission?: number;
  goatId?: string;
  goatName?: string;
}

export interface Trade {
  id: string;
  positionId?: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number; // Seconds
  exitTime: number;  // Seconds
  pnl: number;
  pnlPercent: number;
  returnPercent: number;
  commission: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL_CLOSE' | 'MANUAL';
  goatId?: string;
  goatName?: string;
}

export interface BarsRequest {
  symbol?: string;
  timeframe?: Timeframe;
  limit?: number;
  from?: number;
  to?: number;
}

export interface IndicatorOutputs {
  sma(values: number[], period: number): number[];
  ema(values: number[], period: number): number[];
  rsi(values: number[], period?: number): number[];
  macd(values: number[], fastPeriod?: number, slowPeriod?: number, signalPeriod?: number): {
    macd: number[];
    signal: number[];
    histogram: number[];
  };
  bollingerBands(values: number[], period?: number, stdDevMultiplier?: number): {
    upper: number[];
    middle: number[];
    lower: number[];
  };
  atr(bars: Bar[], period?: number): number[];
}

export interface SignalEvent {
  id: string;
  strategyId: string;
  symbol: string;
  side: OrderSide | 'INFO';
  timestamp: number;
  price: number;
  title: string;
  reason: string;
  confidence?: number;
}

/**
 * Controlled TradingContext interface presented to strategy.ts
 * Strictly isolated from window, document, network, and broker secrets.
 */
export interface TradingContext {
  market: {
    quote(symbol?: string): Promise<Quote>;
    bars(options?: BarsRequest): Promise<Bar[]>;
  };

  indicators: IndicatorOutputs;

  account: {
    balance(): number;
    equity(): number;
    margin(): number;
    freeMargin(): number;
    positions(symbol?: string): Position[];
  };

  orders: {
    market(request: MarketOrderRequest): Promise<OrderResult>;
    limit(request: LimitOrderRequest): Promise<OrderResult>;
    cancel(orderId: string): Promise<void>;
    closePosition(positionId: string): Promise<void>;
  };

  state: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
    clear(): void;
  };

  signal(event: Omit<SignalEvent, 'id' | 'strategyId'>): void;

  log(message: string, data?: unknown): void;
}

export interface RiskLimits {
  maxOrderSize: number;        // Max instrument units per single order
  maxOpenPositions: number;    // Max simultaneous open positions
  maxExposureNotional: number; // Max total exposure in the account currency
  maxOrdersPerMinute: number;  // Throttling safeguard
  maxDailyLoss: number;        // Absolute currency daily loss limit
  killSwitchActive: boolean;   // Immediate trading halt
}

/**
 * Interactive backtester configuration.
 *
 * Costs here are an explicit modelling choice for simulation only. They
 * are not venue fees and are never used by the Hyperliquid execution
 * path.
 */
export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  initialBalance: number;
  spreadPips: number;
  commissionPerLot: number;
  slippagePips: number;
  barCount: number;
  /** Spread as a raw price distance; used instead of spreadPips when set. */
  spreadPrice?: number;
  /** Slippage as a raw price distance; used instead of slippagePips when set. */
  slippagePrice?: number;
  /** Units in one standard lot for the cost model. */
  lotSize?: number;
  /** Price increment of one pip, when the instrument has one. */
  pipSize?: number;
  /** Decimal places used when rounding simulated quotes. */
  pricePrecision?: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  balance: number;
  drawdown: number;
  drawdownPercent: number;
}

export interface BacktestResult {
  id: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  initialBalance: number;
  finalEquity: number;
  netProfit: number;
  netProfitPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  averageTradeProfit: number;
  trades: Trade[];
  equityCurve: EquityPoint[];
  signals: SignalEvent[];
  logs: LogEntry[];
  startTime: number;
  endTime: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'trade' | 'risk';
  message: string;
  data?: unknown;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  symbol: string;
  timeframe: Timeframe;
  category: 'Trend' | 'Breakout' | 'Mean Reversion' | 'Momentum' | 'Scalping';
  code: string;
  createdAt: number;
  updatedAt: number;
}

export interface Goat {
  id: string;
  name: string;
  strategyId: string;
  agentId?: string;
  symbol: string;
  timeframe: Timeframe;
  mode: ExecutionMode;
  status: GoatStatus;
  lastSignal?: string;
  lastActivity: number;
  positionsCount: number;
  totalPnl: number;
  startedAt: number;
}

export interface Deployment {
  id: string;
  goatId: string;
  goatName: string;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  mode: ExecutionMode;
  status: GoatStatus;
  uptimeSeconds: number;
  lastTickTime: number;
  tradesCount: number;
  pnl: number;
}

export interface AISkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  category: 'Strategy' | 'Risk' | 'Indicator' | 'Session';
  enabled: boolean;
  examples?: string[];
}


export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  siteUrl: string;
  siteName: string;
}
