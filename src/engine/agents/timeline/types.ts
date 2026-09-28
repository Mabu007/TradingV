import { TradingEnvironmentMode } from '../types';

export type AgentTimelineEventType =
  | 'TRIGGER'
  | 'TRIGGER_EVALUATED'
  | 'AGENT_WAKE'
  | 'OBSERVATION'
  | 'CAPABILITY_CALL'
  | 'CAPABILITY_RESULT'
  | 'DECISION'
  | 'RISK_CHECK'
  | 'ORDER'
  | 'FILL'
  | 'POSITION_OPENED'
  | 'POSITION_UPDATE'
  | 'POSITION_CLOSED'
  | 'ERROR';

export interface AgentTimelineEvent {
  id: string;
  agentId: string;
  botId?: string;
  deploymentId?: string;
  timestamp: number;
  type: AgentTimelineEventType;
  environment?: TradingEnvironmentMode;
  triggerId?: string;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
  correlationId?: string;
  data: unknown;
}

export interface TimelineQuery {
  from?: number;
  to?: number;
  type?: AgentTimelineEventType;
  botId?: string;
  deploymentId?: string;
  limit?: number;
}

export interface AgentTimelineStore {
  append(event: AgentTimelineEvent): Promise<void>;
  getByAgent(agentId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
  getByTrade(tradeId: string): Promise<AgentTimelineEvent[]>;
  getByPosition(positionId: string): Promise<AgentTimelineEvent[]>;
  getByBot?(botId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
  getByDeployment?(deploymentId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
}
