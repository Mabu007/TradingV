import { TradingEnvironmentMode } from '../types';

export type TriggerType =
  | 'NEW_BAR' | 'PRICE_CROSS' | 'PRICE_THRESHOLD' | 'INDICATOR_CROSS' | 'BREAKOUT' | 'RISK_STATE_CHANGED'
  | 'POSITION_OPEN' | 'POSITION_CLOSE'
  | 'SPREAD_CHANGE' | 'VOLATILITY_CHANGE' | 'POSITION_UPDATE' | 'ORDER_FILLED'
  | 'STOP_APPROACHING' | 'TARGET_APPROACHING' | 'SESSION_START' | 'SESSION_END'
  | 'SCHEDULED' | 'CUSTOM';

export type PriceOperator = 'ABOVE' | 'BELOW';
export type CrossDirection = 'ABOVE' | 'BELOW';

export interface AgentTrigger {
  id: string;
  agentId: string;
  type: TriggerType;
  enabled: boolean;
  symbol?: string;
  timeframe?: string;
  config: unknown;
  priority?: number;
  cooldownMs?: number;
  maxFiringsPerMinute?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerMarketState {
  timestamp: number;
  environment: TradingEnvironmentMode;
  symbol: string;
  timeframe?: string;
  price?: number;
  spread?: number;
  bars?: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  indicators?: Record<string, number>;
  positions?: Array<{ id: string; symbol: string; side: 'BUY' | 'SELL'; currentPrice: number; volume?: number; unrealizedPnL?: number; stopLoss?: number; takeProfit?: number }>;
  order?: { status: string; orderId?: string; positionId?: string; symbol: string };
  session?: { id: string; startsAt: number; endsAt: number; timezone: string };
  eventData?: unknown;
}

export interface TriggerInput {
  id: string;
  agentId?: string;
  triggerId?: string;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
  type: string;
  timestamp: number;
  environment: TradingEnvironmentMode;
  symbol?: string;
  timeframe?: string;
  state: TriggerMarketState;
  sourceEventId?: string;
}

export interface AgentTriggerEvent {
  id: string;
  triggerId: string;
  agentId: string;
  type: TriggerType;
  timestamp: number;
  environment: TradingEnvironmentMode;
  symbol?: string;
  timeframe?: string;
  reason: string;
  marketSnapshot?: unknown;
  sourceEventId?: string;
  priority: number;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
}

export interface TriggerDelivery {
  wake(event: AgentTriggerEvent): Promise<void>;
}
