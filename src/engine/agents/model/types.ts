import { AgentDecision, AgentObservation, TradingAgent } from '../types';

/**
 * Which JSON object the model is being asked for.
 *
 * This exists because of a failure that was invisible for a long time. The
 * agent system prompt told every model to answer with a *trading decision*
 * (`WAIT` / `OPEN_POSITION`), while the caller that deploys a GOAT needed a
 * *hypothesis and an observation plan*. A model that obeyed the system
 * prompt returned a perfectly valid decision, and the caller — which was
 * looking for `thesis` — reported that the model "did not return a
 * hypothesis". Two prompts, two schemas, and the disagreement was resolved
 * by blaming the model.
 *
 * So the phase declares the contract, and the prompt is built from it. One
 * schema is described at a time, and there is never a second "Output
 * Format" section contradicting it further down the same message.
 */
export type AgentResponseContract =
  /** A trading decision: WAIT / ANALYZE / OPEN_POSITION / … */
  | 'DECISION'
  /** A thesis plus the observation plan that would test it. */
  | 'INVESTIGATION'
  /** One decision about what to do with a thesis after a wake. */
  | 'PLAN'
  /** The agent's reading of the user's objective. */
  | 'INTERPRETATION';

export interface AgentModelRequest {
  agent: TradingAgent;
  observation: AgentObservation;
  /**
   * What the agent is actually trying to accomplish, in the user's words.
   *
   * It was missing, and it was the worst omission in this file. The GOAT
   * stores the objective on `agent.description`, which the prompt builder
   * never rendered — so the model was asked to investigate a market it had
   * no objective for, and answered accordingly: "the user has not yet
   * specified a concrete trading objective", followed by a guess at what
   * the objective might be. That guess was then stored as the GOAT's
   * understanding of what the user asked for.
   *
   * Explicit rather than parsed out of `description`, because a prompt
   * assembler should not be recovering an objective by string surgery.
   */
  objective?: string;
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
  /**
   * The response this call expects. Defaults to `DECISION`, which is what
   * the plain agent runtime has always asked for.
   */
  contract?: AgentResponseContract;
}

export interface AgentModelResponse {
  thought: string;
  /**
   * The whole JSON object the model returned, parsed once, here.
   *
   * This is the canonical internal representation. Downstream code reads
   * `payload` and never has to know that OpenRouter wraps JSON in prose,
   * that a model may answer a decision request when a thesis was asked
   * for, or that one field can arrive under two names. Normalising at this
   * boundary is the point: every provider-specific shape is absorbed in one
   * file instead of being re-implemented in each parser downstream.
   *
   * Absent when the model returned no JSON at all, which is a different
   * fact from "returned JSON I could not use" — see `malformed`.
   */
  payload?: Record<string, unknown>;
  /**
   * True when `content` held something JSON-shaped that would not parse,
   * or parsed to a non-object.
   *
   * Distinct from "no hypothesis" on purpose. A model that emitted broken
   * JSON is a transport problem and is retried; a model that answered
   * `WAIT` has answered.
   */
  malformed?: boolean;
  toolCall?: {
    capability: string;
    input: Record<string, unknown>;
  };
  decision?: AgentDecision;
  /**
   * Set when the model could not be consulted at all.
   *
   * The distinction that matters: a model that answered with WAIT has
   * answered, and an agent that could not be reached has not. Without
   * this, "you have not connected an API key" and "this market is not
   * interesting" are the same silence, and the person reading it is told
   * to write a better goal when the fix is a missing key.
   */
  unavailable?: {
    code: string;
    /** Written to be shown to a user. Carries no provider payload. */
    message: string;
  };
}

export interface IAgentModel {
  run(request: AgentModelRequest): Promise<AgentModelResponse>;
}
