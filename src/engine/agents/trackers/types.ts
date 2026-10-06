/**
 * The Tracker domain.
 *
 * A Tracker is something a GOAT creates in order to *observe* the
 * market. It is not a signal, it is not a strategy, and it is not a
 * trade: it is a statement of the form "if this becomes true, I want to
 * be woken", plus the deterministic machinery that watches for it while
 * the GOAT is dormant.
 *
 * That is the whole of the object. It deliberately carries no
 * interpretation. There is no `side`, no `action`, and no `confidence`
 * in what a tracker decides, because deciding what an observation means
 * is the GOAT's job and doing it here is exactly the mistake this
 * architecture exists to prevent.
 *
 * The pieces:
 *
 *   Tracker          the domain object: who owns it, what it observes,
 *                    why it exists, and where it is in its lifecycle.
 *   TrackerCondition what it observes, as either a kind + config or a
 *                    condition tree (see `conditions.ts`).
 *   TrackerEvent     the fact that it observed something.
 *   WakeRequest      the envelope handed to the GOAT when it does.
 *
 * Ownership notes: this module is the canonical home. The GOAT layer
 * imports these types rather than redefining them, so a Tracker is one
 * object with one shape from the evaluator all the way to the UI.
 */

import { TradingEnvironmentMode } from '../types';
import { InstrumentMetadata } from '../../../types/instruments';

/**
 * The vocabulary of things a tracker can observe.
 *
 * This is the tracker's program: which measurement, of what, decides
 * whether it has something to report. The event type (`TrackerEventType`)
 * is a separate, deliberately lossier vocabulary — it says what the
 * agent should read, not what was measured.
 */
export type TrackerKind =
  | 'NEW_BAR' | 'PRICE_CROSS' | 'PRICE_THRESHOLD' | 'INDICATOR_CROSS' | 'BREAKOUT' | 'RISK_STATE_CHANGED'
  | 'POSITION_OPEN' | 'POSITION_CLOSE'
  | 'SPREAD_CHANGE' | 'VOLATILITY_CHANGE' | 'POSITION_UPDATE' | 'ORDER_FILLED'
  | 'STOP_APPROACHING' | 'TARGET_APPROACHING' | 'SESSION_START' | 'SESSION_END'
  | 'SCHEDULED' | 'CUSTOM';

export type PriceOperator = 'ABOVE' | 'BELOW';
export type CrossDirection = 'ABOVE' | 'BELOW';

/**
 * The machine-checkable part of a tracker's observation.
 *
 * Plain data, validated by the registry. A tracker may not carry
 * credentials here, and the check for that is part of registration
 * rather than a convention, because a tracker is authored by a model.
 */
export type TrackerConfig = Record<string, unknown>;

/**
 * The canonical Tracker.
 *
 * `purpose` is the human half and `config` is the machine half. Both are
 * required: a tracker that cannot say what it is waiting for is not
 * something a GOAT should be able to deploy, and a tracker whose
 * parameters cannot be checked is not something a runtime should
 * execute.
 */
export interface Tracker {
  id: string;
  /** The GOAT that owns it. A tracker is always someone's. */
  agentId: string;
  /** The thesis that asked for it. Trackers are thesis children. */
  thesisId?: string;
  goalId?: string;
  /** What this tracker observes. */
  kind: TrackerKind;
  symbol?: string;
  timeframe?: string;
  config: TrackerConfig;
  /**
   * What this tracker is waiting for, in the GOAT's own words.
   *
   * Distinct from `config` on purpose: the config is machine-checkable,
   * the purpose is for a person to read. "Wait for gold to reclaim 2000"
   * is both, and only one of the two is verifiable.
   */
  purpose: string;
  /**
   * The kind of event this tracker reports.
   *
   * Not a direction. A tracker reporting means "something relevant
   * happened", and interpreting it is a separate, explicit act.
   */
  eventType: TrackerEventType;
  /** Other trackers that must be satisfied for this one to matter. */
  dependencies: string[];
  /** What the tracker needs from the market in order to run. */
  dataRequirements: TrackerDataRequirement[];
  /** How it is evaluated, and how often it may report. */
  evaluation: TrackerEvaluationConfig;
  /** Where it is in its life, and what it has seen so far. */
  lifecycle: TrackerLifecycle;
  createdAt: number;
  updatedAt: number;
}

export interface TrackerEvaluationConfig {
  /** Higher is reported first when several trackers observe at once. */
  priority: number;
  /** Minimum gap between events, in milliseconds. */
  cooldownMs: number;
  /** Hard ceiling on events per minute, whatever the cooldown says. */
  maxEventsPerMinute: number;
}

export type TrackerStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

export interface TrackerLifecycle {
  status: TrackerStatus;
  /** Absolute expiry, or undefined for "as long as the thesis lives". */
  expiresAt?: number;
  lastEvaluatedAt?: number;
  lastEventAt?: number;
  /** How many events this tracker has produced since creation. */
  eventCount: number;
  /**
   * Why the tracker failed, when it did.
   *
   * A tracker that cannot be evaluated is worse than no tracker: it
   * looks like coverage and provides none, so the failure is retained
   * rather than swallowed.
   */
  failureReason?: string;
}

/**
 * Market inputs a tracker needs.
 *
 * Declared up front so the runtime can share work and report honestly
 * about what a tracker will and will not be able to see.
 */
export interface TrackerDataRequirement {
  kind: 'QUOTE' | 'BARS' | 'INDICATOR' | 'STRUCTURE' | 'ACCOUNT';
  timeframe?: string;
  /** Indicator or structure capability the evaluation depends on. */
  detail?: string;
  barCount?: number;
}

/** The market, as a tracker evaluation sees it. */
export interface TrackerObservation {
  timestamp: number;
  environment: TradingEnvironmentMode;
  symbol: string;
  timeframe?: string;
  price?: number;
  spread?: number;
  bars?: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  indicators?: Record<string, number>;
  positions?: Array<{ id: string; symbol: string; side: 'BUY' | 'SELL'; entryPrice?: number; currentPrice: number; volume?: number; unrealizedPnL?: number; stopLoss?: number; takeProfit?: number }>;
  order?: { status: string; orderId?: string; positionId?: string; symbol: string };
  /**
   * Canonical instrument metadata for `symbol`, when the environment can
   * supply it. Proximity and threshold maths reads pip/tick size, price
   * precision, and contract multiplier from here, so a tracker never has
   * to guess an instrument's unit from its name.
   */
  instrument?: InstrumentMetadata;
  session?: { id: string; startsAt: number; endsAt: number; timezone: string };
  eventData?: unknown;
}

/** One delivery of market state into the tracker runtime. */
export interface TrackerInput {
  id: string;
  agentId?: string;
  /** Restrict evaluation to one tracker, when the caller knows. */
  trackerId?: string;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
  type: string;
  timestamp: number;
  environment: TradingEnvironmentMode;
  symbol?: string;
  timeframe?: string;
  state: TrackerObservation;
  sourceEventId?: string;
}

/**
 * A tracker observed something.
 *
 * This is a fact about the market, not a signal about a trade. There is
 * deliberately no `side` and no `action` field: the GOAT interprets the
 * event, and interpreting it is a separate, explicit act.
 */
export interface TrackerEvent {
  id: string;
  trackerId: string;
  agentId: string;
  /** The program that produced this event. */
  kind: TrackerKind;
  /** How the agent should read it. */
  eventType: TrackerEventType;
  timestamp: number;
  environment: TradingEnvironmentMode;
  thesisId?: string;
  goalId?: string;
  symbol?: string;
  timeframe?: string;
  /** Human-readable description of what was observed. */
  reason: string;
  /** Values the evaluation actually compared. */
  observedValues?: Record<string, number | string>;
  /** Market context the agent needs to interpret without re-fetching. */
  marketContext?: TrackerEventMarketContext;
  /** Raw market snapshot, retained for the audit trail. */
  marketSnapshot?: unknown;
  /** The delivery that produced it, for deduplication. */
  sourceEventId?: string;
  priority: number;
  severity: TrackerEventSeverity;
  /**
   * What caused this event, when it did not come from a tracker evaluating
   * the market.
   *
   * A wake can also be a person asking the agent to reconsider, or an
   * operator restarting it. Without this the log had one shape for every
   * wake — "woken by a tracker" — which is not merely wrong for those, it is
   * how a steering request came to look like a dead end.
   */
  source?: 'TRACKER' | 'STEERING' | 'RESTART';
  /** Agent's confidence in its own reading, [0,1]. Never set by the runtime. */
  confidence?: number;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
}

export type TrackerEventType =
  | 'PRICE_REACHED_LEVEL'
  | 'PRICE_CROSSED_LEVEL'
  | 'INDICATOR_CROSSED'
  | 'VOLATILITY_CHANGED'
  | 'STRUCTURE_CHANGED'
  | 'SPREAD_CHANGED'
  | 'BAR_CLOSED'
  | 'TIME_WINDOW_STARTED'
  | 'SESSION_CHANGED'
  | 'CONDITION_MET'
  | 'CUSTOM';

export type TrackerEventSeverity = 'INFO' | 'NOTABLE' | 'SIGNIFICANT' | 'DECISIVE';

export interface TrackerEventMarketContext {
  price?: number;
  spread?: number;
  session?: string;
  /** Last few closed bars, enough to interpret structure without refetching. */
  recentBars?: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  indicators?: Record<string, number>;
}

/**
 * A tracker a GOAT wants to exist.
 *
 * The GOAT supplies intent; the SDK supplies the id, the validation, the
 * permission check, and the registration. `kind` is the only field the
 * GOAT must get right for the request to be accepted.
 */
export interface TrackerRequest {
  name?: string;
  purpose: string;
  kind: TrackerKind;
  symbol?: string;
  timeframe?: string;
  config: TrackerConfig;
  eventType?: TrackerEventType;
  priority?: number;
  cooldownMs?: number;
  maxEventsPerMinute?: number;
  expiresAt?: number;
  dependencies?: string[];
  dataRequirements?: TrackerDataRequirement[];
}

/**
 * What the runtime hands a GOAT when a tracker reports.
 *
 * Assembled from the event so the GOAT can re-evaluate with the context
 * it would otherwise have to go and rebuild. `thesis` is a structural
 * view rather than the GOAT's own record, because the runtime must not
 * depend on the reasoning layer to know what it is waking.
 */
export interface TrackerWakeRequest {
  thesisId: string;
  goalId: string;
  agentId: string;
  /** The event that caused the wake. */
  event: TrackerEvent;
  /** The thesis at wake time, not a later revision of it. */
  thesis: TrackerThesisView;
  /** Other recent events for the same tracker, newest last. */
  relatedEvents: TrackerEvent[];
  /**
   * Every observation from one logical frame, when this wake belongs to one.
   *
   * Absent for an observation delivered on its own, which is the common case for a
   * position, order or risk event. When it is present, `event` is
   * `batch.primaryEventId` and the batch is the full delivery — so a reasoning
   * layer that only reads `event` behaves exactly as before, and one that reads
   * the batch sees the whole observation.
   */
  batch?: TrackerObservationBatch;
  /** Skills active at wake time. */
  skillIds: string[];
  createdAt: number;
}

/**
 * Several observations that belong to one logical reasoning opportunity.
 *
 * ## What this is, and what it is not
 *
 * It is a *delivery container*. One market observation — one bar closing, one
 * quote arriving, one position update — very often satisfies several trackers at
 * once, and waking the reasoning layer once per tracker means paying for three
 * model calls to be told the same thing three times. The batch says "these
 * observations came from one observation of the market" and nothing more.
 *
 * It is emphatically not a merged observation. There is no combined event, no
 * `COMBINED_CONFIRMATION`, no synthetic event type: every `TrackerEvent` in
 * `events` remains individually addressable, individually queryable and
 * individually attributable to the tracker that produced it, and
 * `listEventsForTracker` still answers for each of them.
 *
 * ## Why there is no "independent" flag
 *
 * Two trackers firing on the same price movement are two facts about one fact.
 * Whether they are *independent evidence* is a question about the thesis they bear
 * on, and only the reasoning layer can answer it — it knows what it already holds
 * and what it has already counted. So the batch preserves each event's
 * `sourceEventId`, which is the delivery that produced it, and lets the reasoning
 * layer compare that against what it has recorded. Nothing here decides anything.
 *
 * ## Identity is logical, never temporal
 *
 * `frameId` is derived from the source delivery and the environment, so the same
 * historical input produces the same batch at 1× and at 60×. There is no timer and
 * no wall-clock window anywhere in its construction: a batch is formed while the
 * delivery that produced it is being processed, and never later.
 */
export interface TrackerObservationBatch {
  /**
   * Identity of this batch.
   *
   * Deterministic from the environment, the GOAT, the thesis, the market and the
   * source delivery — so the same replay produces the same ids in the same order.
   */
  batchId: string;
  agentId: string;
  thesisId: string;
  environment: TradingEnvironmentMode;
  symbol: string;
  /**
   * When the market was observed, epoch ms.
   *
   * The *market's* time, taken from the events themselves, so a batch is stamped
   * by the history it describes rather than by when the runtime happened to notice.
   */
  observationTimestamp: number;
  /**
   * The delivery that produced every event in the batch.
   *
   * Shared by all of them, and the reason the runtime does not claim they are
   * independent: this string is what the reasoning layer compares against the
   * provenance of evidence it has already recorded.
   */
  sourceEventId: string;
  /** Every observation, in the deterministic order the runtime committed to. */
  events: TrackerEvent[];
  /**
   * The event the wake is addressed to.
   *
   * One observation has to lead, because a wake names one — but it leads by a rule
   * (timestamp, then priority, then id) and not by whichever evaluation finished
   * first. It is a representative, not a summary, and the other events are not
   * subordinate to it.
   */
  primaryEventId: string;
}

/** The minimum a wake needs to know about the thesis it is waking for. */
export interface TrackerThesisView {
  id: string;
  goalId: string;
  agentId: string;
  statement: string;
  state: string;
  confidence?: number;
  revision: number;
}

/** How a wake is delivered. */
export interface TrackerDelivery {
  wake(event: TrackerEvent): Promise<void>;
}
