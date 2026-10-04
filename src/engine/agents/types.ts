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
  /**
   * Order types this deployment may ever submit, whatever `allowTrading`
   * currently says.
   *
   * Carried separately from `allowTrading` for the same reason
   * `allowTrading` is carried separately from the ability to research: a
   * SHADOW deployment has both of these populated and `allowTrading: false`,
   * and reporting "no order types" for it would misdescribe a deployment
   * that is fully capable of proposing a plan and simulating it.
   */
  allowedOrderTypes?: Array<'MARKET' | 'LIMIT' | 'STOP'>;
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
/**
 * The non-price facts about a market, when the venue publishes them.
 *
 * Every field is optional and every miss carries a reason. A GOAT told
 * "funding unavailable for this market" can plan around it; a GOAT told a
 * plausible-looking zero cannot, and will happily build a thesis on a
 * liquidity assumption that was never measured.
 */
export interface MarketFacts {
  symbol: string;
  /** Hourly funding rate as a fraction, e.g. 0.0000125 for 0.00125%/h. */
  fundingRate?: number;
  /** Annualised funding rate as a percentage, when derivable. */
  fundingAnnualPercent?: number;
  /** Venue-published funding interval in hours, usually 1. */
  fundingIntervalHours?: number;
  /** Open interest in the venue's own units. */
  openInterest?: number;
  /** 24h notional volume. */
  dayVolume?: number;
  /** Reference price used for funding and liquidation. */
  markPrice?: number;
  oraclePrice?: number;
  /** 24h change as a percentage. */
  change24hPercent?: number;
  /** Why a requested fact is absent. Shown to the user, never invented over. */
  unavailable?: string[];
  /** What the venue actually published, for a reader who wants to check. */
  source?: string;
}

export interface ITradingEnvironment {
  mode: TradingEnvironmentMode;
  getMarketQuote(symbol: string): Promise<NormalizedQuote>;
  getMarketBars(symbol: string, timeframe: string, count: number): Promise<Bar[]>;
  /** Canonical instrument metadata, when the environment can provide it. */
  getInstruments?(): Promise<InstrumentMetadata[]>;
  /**
   * What the venue publishes about a market beyond price and candles.
   *
   * Optional, and optional per field, on purpose. Funding, open interest and
   * volume are the difference between a research agent and a price reader,
   * and they are not available everywhere — a spot market has no funding, and
   * some venues publish none of it. So the shape is a bag of optional facts
   * and a reason when a fact is missing, rather than a fixed schema the agent
   * has to pretend it filled in.
   */
  getMarketContext?(symbol: string): Promise<MarketFacts>;
  /**
   * The account snapshot.
   *
   * `dailyPnL` is realised plus unrealised profit and loss for the current
   * trading day. It is not open P&L: a loss that has been closed must
   * still count, or a daily-loss limit can never fire.
   */
  getAccountState(): Promise<{
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    dailyPnL: number | null;
    /** Realised-only component of `dailyPnL`, kept for diagnosis. */
    realisedSessionPnL?: number;
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
  /**
   * Rest an order at a price and wait for the market to come to it.
   *
   * Optional because the live adapter may not implement every order type, and
   * because an environment that cannot express a resting order has to say so
   * rather than pretend. A caller that needs a limit must check for it rather than
   * fall back to a market order silently — that fallback is exactly the difference
   * between a GOAT that waits for its price and one that pays the spread to get in
   * now, and it must never happen unnoticed.
   */
  placeLimitOrder?(params: { symbol: string; side: 'BUY' | 'SELL'; volume: number; price: number; stopLoss?: number; takeProfit?: number; expiresAt?: number; idempotencyKey?: string; comment?: string }): Promise<{ success: boolean; orderId?: string; error?: string; rejection?: ExecutionRejection }>;
  /** Withdraw a resting order. */
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
    /**
     * The other resolutions this pass read.
     *
     * Context, setup and trigger are rarely the same resolution, and a GOAT
     * that can only see one cannot check a 15m setup against the 1h structure
     * it claims to agree with. Keyed by timeframe so the model can tell which
     * reading is which rather than receiving a merged number it has to guess
     * the resolution of.
     */
    timeframeReads?: Array<{
      timeframe: string;
      /** Context or setup: which job this reading was gathered for. */
      role?: string;
      candleCount?: number;
      firstTime?: number;
      lastTime?: number;
      indicators?: Record<string, unknown>;
      structure?: Record<string, unknown>;
      limitations?: string[];
    }>;
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
/**
 * Every timeframe an agent may read or watch.
 *
 * One place, because the answer was previously spelled three different ways —
 * the agent's single `timeframe`, its `timeframes`, and "any supported
 * timeframe" — and the disagreement between them was the hard-coded 15m
 * assumption. Prefer the declared set; fall back to the single resolution;
 * fall back again to nothing, which callers read as unrestricted.
 */
export function agentTimeframes(agent: {
  timeframes?: string[];
  timeframe?: string;
}): string[] {
  if (agent.timeframes && agent.timeframes.length > 0) return [...agent.timeframes];
  if (agent.timeframe) return [agent.timeframe];
  return [];
}

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
  | 'MANUAL_WAKE'
  | 'TRACKER_OBSERVED';

export interface AgentWakeEvent {
  type: AgentWakeEventType;
  symbol?: string;
  data?: unknown;
  timestamp: number;
  /** The tracker that woke the agent, when the wake came from one. */
  tracker?: unknown;
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
  /**
   * Every timeframe this agent may read and watch, when it works across more
   * than one.
   *
   * A single `timeframe` forced every analysis onto one resolution: a GOAT
   * asked for a breakout could not read the 1h structure the breakout would
   * have to agree with, and the registry rejected any tracker that named a
   * different one. Timeframe choice is a reasoning decision — context,
   * setup and trigger are usually not the same resolution — so it belongs to
   * the agent's reasoning, with this as the menu it may choose from.
   *
   * `timeframe` remains the primary resolution, for prompts and for callers
   * that want one.
   */
  timeframes?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  ai?: { provider: 'openrouter'; model: string };
  goatId?: string;
  deploymentId?: string;
}
