import { Bar, OrderResult, Position } from '../../types/trading';
import { InstrumentMetadata } from '../../types/instruments';
import { ExecutionRejection } from '../execution/errors';
import { NormalizedQuote } from '../../types/quotes';

export type TradingEnvironmentMode = 'BACKTEST' | 'DEMO' | 'LIVE';

export interface AgentState {
  running: boolean;
  lastDecision?: AgentDecision;
  lastWakeEvent?: AgentWakeEvent;
  lastCycleAt?: number;
}

export interface AgentMemoryRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}


/**
 * Hard Agent Risk & Execution Policy
 * System-enforced: agent instructions can NEVER override these rules.
 */
export interface AgentPolicy {
  maxRiskPerTrade: number;       // e.g. 0.01 for 1% of equity
  maxDailyLoss?: number;         // e.g. 500 ($)
  maxDrawdown?: number;          // e.g. 0.05 for 5% max drawdown
  maxOpenPositions: number;      // e.g. 1
  /**
   * Maximum total exposure in the account currency.
   *
   * It is a monetary limit, not a quantity limit, so positions in
   * unrelated instruments are valued before they are compared.
   */
  maxExposure: number;           // e.g. 50,000 ($ notional)
  maxOrdersPerMinute: number;    // e.g. 10
  allowedSymbols: string[];      // e.g. ['EUR/USD']
  allowedSessions?: string[];    // e.g. ['LONDON', 'NEW_YORK', 'ASIAN', 'ALL']
  allowTrading: boolean;         // Master trading switch
}

/**
 * Composable Skill Definition
 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  requiredCapabilities: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled: boolean;
}

/**
 * Capability Execution Context
 */
export interface CapabilityContext {
  agentId: string;
  environment: TradingEnvironmentMode;
  env: ITradingEnvironment;
  symbol?: string;
  timeframe?: string;
  policy: AgentPolicy;
  symbols: string[];
}

/**
 * Strongly Typed Capability Interface
 */
export interface AgentCapability<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  category: 'market' | 'indicators' | 'structure' | 'account' | 'risk' | 'execution';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  execute(input: TInput, context: CapabilityContext): Promise<TOutput>;
}

/**
 * Environment Abstraction Contract
 *
 * The environment owns instrument metadata and execution economics.
 * The agent runtime reads them through this interface and never needs to
 * know which provider is behind it.
 */
export interface ITradingEnvironment {
  mode: TradingEnvironmentMode;
  getMarketQuote(symbol: string): Promise<NormalizedQuote>;
  getMarketBars(symbol: string, timeframe: string, count: number): Promise<Bar[]>;
  /** Canonical instrument metadata, when the environment can provide it. */
  getInstruments?(): Promise<InstrumentMetadata[]>;
  getAccountState(): Promise<{
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    dailyPnL: number | null;
    drawdownPercent: number | null;
  }>;
  getPositions(symbol?: string): Promise<Position[]>;
  getOrders(): Promise<OrderResult[]>;
  placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ success: boolean; positionId?: string; fillPrice?: number; error?: string; rejection?: ExecutionRejection }>;
  placeLimitOrder?(params: { symbol: string; side: 'BUY' | 'SELL'; volume: number; price: number; stopLoss?: number; takeProfit?: number }): Promise<{ success: boolean; orderId?: string; error?: string; rejection?: ExecutionRejection }>;
  cancelOrder?(orderId: string): Promise<{ success: boolean; error?: string }>;
  modifyPosition(positionId: string, changes: { stopLoss?: number; takeProfit?: number }): Promise<{ success: boolean; error?: string }>;
  closePosition(positionId: string, volume?: number): Promise<{ success: boolean; pnl?: number; error?: string; rejection?: ExecutionRejection }>;
}

/**
 * Normalized Observation fed into reasoning
 */
export interface AgentObservation {
  timestamp: number;
  environment: TradingEnvironmentMode;
  market: {
    quotes: NormalizedQuote[];
    quote?: NormalizedQuote;
    recentBars?: Bar[];
    spread?: number;
    session?: string;
  };
  account: {
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    dailyPnL: number | null;
    drawdownPercent: number | null;
  };
  positions: Position[];
  orders: OrderResult[];
  availableCapabilities: string[];
  availableSkills: string[];
  recentMemories?: Record<string, unknown>;
}

/**
 * Structured Agent Decisions
 */
export type AgentDecision =
  | {
      type: 'WAIT';
      reason: string;
    }
  | {
      type: 'ANALYZE';
      capability: string;
      input: Record<string, unknown>;
      reason?: string;
    }
  | {
      type: 'OPEN_POSITION';
      symbol: string;
      side: 'BUY' | 'SELL';
      volume: number;
      reason: string;
      stopLoss?: number;
      takeProfit?: number;
    }
  | {
      type: 'MODIFY_POSITION';
      positionId: string;
      changes: {
        stopLoss?: number;
        takeProfit?: number;
      };
      reason: string;
    }
  | {
      type: 'CLOSE_POSITION';
      positionId: string;
      reason: string;
    };

/**
 * Policy & Action Validation Result
 */
export interface AgentActionValidationResult {
  valid: boolean;
  reason?: string;
  code?:
    | 'APPROVED'
    | 'POLICY_VIOLATION'
    | 'RISK_REJECTED'
    | 'INVALID_PARAMS'
    | 'UNKNOWN_CAPABILITY'
    | 'DISALLOWED_SYMBOL'
    | 'DISALLOWED_SESSION'
    | 'TRADING_DISABLED'
    | 'RATE_LIMITED';
}

/**
 * Agent Wake Condition Events
 */
export type AgentWakeEventType =
  | 'NEW_BAR'
  | 'PRICE_THRESHOLD'
  | 'POSITION_OPENED'
  | 'POSITION_APPROACHING_STOP'
  | 'POSITION_REACHED_PROFIT_TARGET'
  | 'SPREAD_CHANGED'
  | 'SESSION_CHANGED'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'RISK_STATE_CHANGED'
  | 'TIMER_TICK'
  | 'MANUAL_TRIGGER'
  | 'TRIGGER_FIRED';

export interface AgentWakeEvent {
  type: AgentWakeEventType;
  symbol?: string;
  data?: unknown;
  timestamp: number;
  trigger?: unknown;
}

/**
 * Scoped Agent Memory Contract
 */
export type AgentAction = Extract<AgentDecision, { type: 'OPEN_POSITION' | 'MODIFY_POSITION' | 'CLOSE_POSITION' }>;

export interface AgentMemory {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  append(key: string, value: unknown): void;
  clear(): void;
  export(): Record<string, unknown>;
}

/**
 * Observable Audit Record
 */
export interface AgentAuditRecord {
  id: string;
  agentId: string;
  timestamp: number;
  event: AgentWakeEvent;
  observationSummary: string;
  skillsUsed: string[];
  toolCalls: Array<{
    capability: string;
    input: unknown;
    result: unknown;
    durationMs: number;
  }>;
  decision: AgentDecision;
  validation: AgentActionValidationResult;
  executionResult?: unknown;
  error?: string;
}

/**
 * Trading Agent Definition
 */
export interface TradingAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  skills: string[];
  capabilities: string[];
  policy: AgentPolicy;
  preferredEnvironment: TradingEnvironmentMode;
  symbols: string[];
  timeframe?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  ai?: { provider: 'openrouter'; model: string };
  botId?: string;
  deploymentId?: string;
}
