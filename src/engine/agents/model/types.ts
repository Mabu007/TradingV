import { AgentDecision, AgentObservation, TradingAgent } from '../types';

export interface AgentModelRequest {
  agent: TradingAgent;
  observation: AgentObservation;
  instructions: string;
  skillsInstructions: string;
  toolHistory: Array<{
    capability: string;
    input: unknown;
    result: unknown;
  }>;
  capabilitySchemas?: Array<{ id: string; description: string; inputSchema: Record<string, unknown> }>;
  iteration: number;
  wakeReason?: string;
}

export interface AgentModelResponse {
  thought: string;
  toolCall?: {
    capability: string;
    input: Record<string, unknown>;
  };
  decision?: AgentDecision;
}

export interface IAgentModel {
  run(request: AgentModelRequest): Promise<AgentModelResponse>;
}
