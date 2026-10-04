import { TradingEnvironmentMode } from '../types';

export type AgentTimelineEventType =
  | 'TRACKER'
  | 'TRACKER_EVALUATED'
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
  /*
   * The order lifecycle.
   *
   * `ORDER` is the instruction leaving; these three are what became of it. They
   * are separate events rather than fields on one because a resting order that
   * expires and a resting order that is withdrawn are different facts about the
   * market and about the GOAT, and a log that merged them would make patience
   * indistinguishable from indecision.
   */
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_EXPIRED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'TRADE_CLOSED'
  | 'DECISION_REFUSED'
  /** The durable runtime behind this deployment, registered or not. */
  | 'RUNTIME_REGISTERED'
  | 'RUNTIME_UNAVAILABLE'
  | 'ERROR'
  /*
   * The GOAT lifecycle.
   *
   * These are the transitions a person watching a GOAT actually wants to
   * see — deployed, read the market, formed a thesis, deployed trackers,
   * went dormant, woke, revised, wrote a plan, risk-checked it — and until
   * they were recorded the activity feed could only show the last thing
   * that happened. Every one of them is written by the runtime at the
   * moment it happens; none is generated for display.
   */
  | 'GOAT_DEPLOYED'
  | 'GOAT_STARTED'
  | 'GOAT_RESUMED'
  | 'GOAT_STOPPED'
  | 'GOAT_STEERED'
  /*
   * A GOAT began building its initial market context.
   *
   * Deployment used to end with a single "deployed" line and then a silence
   * that lasted as long as the model took: reads, research and the request
   * itself were all real work and none of them were recorded. This is the
   * line that says setup has begun, so the silence after it is a read rather
   * than a mystery. Written by the runtime immediately before the first
   * market read of a pass.
   */
  | 'GOAT_SETTING_UP'
  /*
   * The context a model request is being built from is finished.
   *
   * Distinct from `MARKET_CONTEXT_LOADED`, which is one resolution read. This
   * is the end of the deterministic research pass: every tool has run, the
   * observation exists, and the request is about to be submitted. It is the
   * boundary between "the GOAT is reading the market" and "the GOAT is
   * blocked on an external dependency", which is the distinction a reader
   * cannot make when both states render as WATCHING.
   */
  | 'MARKET_CONTEXT_PREPARED'
  /*
   * The agent was told to reconsider, and is doing it.
   *
   * Separate from the steering that caused it on purpose. "User asked the GOAT
   * to reconsider the breakout" and "the GOAT is reconsidering the breakout"
   * are two different events, and collapsing them is how a steering note
   * became a dead end in the log: the first line appeared and then nothing
   * ever did, which reads exactly like a frozen agent.
   */
  | 'GOAT_REASSESSING'
  | 'GOAT_RESTARTED'
  | 'GOAT_WOKE'
  | 'GOAT_WAITING'
  | 'MARKET_CONTEXT_LOADED'
  | 'MARKET_RESEARCH_COMPLETED'
  | 'THESIS_FORMED'
  | 'THESIS_REVISED'
  | 'THESIS_INVALIDATED'
  | 'NO_THESIS_YET'
  | 'EVIDENCE_REQUIREMENTS_DEFINED'
  /*
   * A piece of evidence the agent recorded.
   *
   * It was missing, and its absence is the reason an agent log could show
   * that a thesis was revised without ever showing *why*: evidence is the
   * only record of what the agent actually saw, and the thesis revision is
   * only interpretable next to it. Written by the runtime at the moment
   * `recordEvidence` succeeds, never by a view.
   */
  | 'AGENT_EVIDENCE'
  | 'TRACKER_CREATED'
  | 'TRACKER_FIRED'
  | 'TRACKER_REMOVED'
  | 'TRADE_PLAN_CREATED'
  /*
   * A trade plan changed state.
   *
   * Distinct from the risk verdict on purpose. "The plan moved to WAITING"
   * and "the risk layer declined it" are different facts, and collapsing
   * them means the log cannot show the plan evolving as its own artefact.
   */
  | 'TRADE_PLAN_UPDATED'
  | 'TRADE_PLAN_RISK_CHECKED'
  | 'TRADE_PLAN_REJECTED'
  | 'SHADOW_EXECUTION'
  | 'MODEL_FAILURE'
  /*
   * The model request has been submitted.
   *
   * The whole point of the MODEL channel. A GOAT that reads three timeframes
   * and then goes quiet for ten seconds is not watching the market, and a log
   * that says WATCHING during that window is lying about the agent's state.
   * This line is written with what was actually submitted — symbol,
   * resolutions, the indicator values the context carried — so the reader can
   * see what the model was given and when the waiting started.
   */
  | 'MODEL_REQUEST'
  /*
   * A bounded retry was scheduled after a failure.
   *
   * Pairs with the failure it follows. Emitted only when a retry timer was
   * actually armed, so the line is a claim the runtime keeps.
   */
  | 'MODEL_RETRY'
  /*
   * The agentic backtest lifecycle.
   *
   * Four types, no more: a simulation has a start, a clock, a stop and an
   * end, and every internal step of a replay reuses the GOAT log's own event
   * projection rather than inventing a second vocabulary for itself.
   */
  | 'BACKTEST_STARTED'
  | 'BACKTEST_TICK'
  | 'BACKTEST_STOPPED'
  | 'BACKTEST_COMPLETED';

export interface AgentTimelineEvent {
  id: string;
  agentId: string;
  goatId?: string;
  deploymentId?: string;
  timestamp: number;
  type: AgentTimelineEventType;
  environment?: TradingEnvironmentMode;
  trackerId?: string;
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
  goatId?: string;
  deploymentId?: string;
  limit?: number;
}

/** Told when an event is recorded. Optional: a store need not be observable. */
export type TimelineListener = (event: AgentTimelineEvent) => void;

export interface AgentTimelineStore {
  append(event: AgentTimelineEvent): Promise<void>;
  /**
   * Watch for events as they are recorded.
   *
   * Optional and additive. A surface that polls can keep polling; a surface
   * that must be live needs this, because polling cannot distinguish "nothing
   * happened" from "nothing changed the fields I was watching".
   *
   * Returns an unsubscribe function. Notifies synchronously, after the event
   * is stored, and must isolate listener failures from the write.
   */
  subscribe?(listener: TimelineListener): () => void;
  getByAgent(agentId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
  getByTrade(tradeId: string): Promise<AgentTimelineEvent[]>;
  getByPosition(positionId: string): Promise<AgentTimelineEvent[]>;
  getByGoat?(goatId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
  getByDeployment?(deploymentId: string, options?: TimelineQuery): Promise<AgentTimelineEvent[]>;
  /**
   * The same history, synchronously.
   *
   * The read model the GOAT screens and the assistant are built on is
   * synchronous — it is a projection, not a workflow step — and the activity
   * feed is part of that projection. Awaiting a store inside a render path
   * would either mean a loading state on every poll or a second cached copy
   * that could disagree with the records it claims to show. The records are
   * already in memory; this only exposes them.
   */
  snapshotByGoat?(goatId: string, limit?: number): AgentTimelineEvent[];
}
