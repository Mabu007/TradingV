/**
 * The canonical agent event vocabulary.
 *
 * The runtime already records a rich, honest set of timeline events — a wake,
 * a market read, a thesis, an evidence requirement, a tracker, a plan, a
 * risk verdict, a failure. What it lacked was a single agreed way to say what
 * *kind* of thing each one is, so every consumer had to re-guess it. The UI
 * guessing is how an agent log ends up looking like an undifferentiated
 * list of sentences.
 *
 * So this file is a pure projection, not a new source of truth:
 *
 *     AgentTimelineEvent  ->  channel + tone + weight + label
 *
 * Nothing here reads a clock, writes state, or invents an event. Every value
 * is a function of the record the runtime wrote, which means a log entry can
 * only ever say what actually happened.
 *
 * Three deliberate constraints, all of them load-bearing:
 *
 *   1. **No chain of thought.** The projection describes what the system did
 *      and what it concluded, never the model's private deliberation. A
 *      `thought` field in an event payload is deliberately not surfaced.
 *   2. **Weight is derived, never authored.** An event does not get to decide
 *      it is critical; the *type* does, because the type is written by the
 *      runtime at the moment the thing happened.
 *   3. **Unknown types degrade to neutral.** A new event type added by
 *      someone else shows up as a normal neutral line rather than vanishing
 *      or throwing.
 */

import type { AgentTimelineEventType } from '../agents/timeline/types';

/**
 * The fourteen things a person watching an agent actually cares about.
 *
 * Deliberately small. A vocabulary is only useful if it is short enough to
 * learn by sight, which is the whole reason this is not one label per
 * timeline type.
 */
export type AgentEventChannel =
  | 'WAKE'
  | 'MARKET'
  | 'OBSERVATION'
  | 'ANALYSIS'
  | 'EVIDENCE'
  | 'RESEARCH'
  | 'PLAN'
  | 'VALIDATION'
  | 'TRACKER'
  | 'DECISION'
  | 'RISK'
  | 'EXECUTION'
  /** The durable runtime that survives the tab closing. */
  | 'RUNTIME'
  | 'WAIT'
  | 'INVALIDATION'
  | 'ERROR'
  | 'CONTROL'
  /*
   * Waiting on the model, and only on the model.
   *
   * Its own channel because the distinction is the whole argument of this
   * file's larger sibling: "waiting for a qualifying market event" and
   * "waiting for an external dependency to answer" are different states with
   * different meanings, and both used to render as WATCHING. A reader cannot
   * act on one of them and can do something about the other.
   */
  | 'MODEL'
  /*
   * The historical simulation.
   *
   * A clock and a dataset, not an agent phase, so it never competes with the
   * GOAT's own narrative — it says where "now" is, and the GOAT's log says
   * what the agent did with it.
   */
  | 'BACKTEST';

/**
 * Semantic colour. Only the signal is coloured; most of a log is neutral,
 * which is what makes the coloured lines worth looking at.
 */
export type AgentEventTone = 'neutral' | 'positive' | 'negative' | 'warning' | 'info';

/**
 * How much of the reader's attention a line is asking for.
 *
 * Three levels, because a log with one weight is a wall. This is what lets
 * someone scan a whole day and stop at the two lines that mattered.
 */
export type AgentEventWeight = 'normal' | 'important' | 'critical';

export interface AgentEventStyle {
  channel: AgentEventChannel;
  tone: AgentEventTone;
  weight: AgentEventWeight;
  /** The short word shown as the line's label. */
  label: string;
}

/**
 * Every recorded event type, mapped once.
 *
 * This table is the contract. Adding a timeline type without adding it here
 * is not an error — it renders as a neutral `CONTROL` line — but it does mean
 * nobody chose its channel, so it will read as undifferentiated.
 */
const STYLE: Record<AgentTimelineEventType, AgentEventStyle> = {
  // --- the agent coming to life ---------------------------------------
  GOAT_WOKE: { channel: 'WAKE', tone: 'info', weight: 'important', label: 'WAKE' },
  AGENT_WAKE: { channel: 'WAKE', tone: 'info', weight: 'important', label: 'WAKE' },
  GOAT_SETTING_UP: { channel: 'CONTROL', tone: 'info', weight: 'important', label: 'SETUP' },

  // --- reading the world ------------------------------------------------
  MARKET_CONTEXT_LOADED: { channel: 'MARKET', tone: 'neutral', weight: 'normal', label: 'MARKET' },
  MARKET_CONTEXT_PREPARED: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  FILL: { channel: 'MARKET', tone: 'neutral', weight: 'normal', label: 'MARKET' },
  OBSERVATION: { channel: 'OBSERVATION', tone: 'neutral', weight: 'normal', label: 'OBSERVATION' },
  CAPABILITY_CALL: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  CAPABILITY_RESULT: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  MARKET_RESEARCH_COMPLETED: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  NO_THESIS_YET: { channel: 'RESEARCH', tone: 'warning', weight: 'normal', label: 'RESEARCH' },
  MODEL_FAILURE: { channel: 'ERROR', tone: 'negative', weight: 'critical', label: 'ERROR' },

  // --- waiting on the model, which is not waiting on the market ---------
  /*
   * One line, on the way out.
   *
   * There was a heartbeat here, one line every ten seconds for as long as the
   * call took, and it was the wrong instinct. It was honest — a real elapsed
   * time against a real pending request — and it still buried the events that
   * changed something under a dozen identical ones. The waiting is now carried
   * by the live status, which pulses for exactly as long as the request is
   * outstanding; the log keeps the request and whatever it produced.
   *
   * `important` rather than `critical`: the reader must see where the agent
   * stopped doing anything of its own, but the outcome line that follows is the
   * one that decides what happened.
   */
  MODEL_REQUEST: { channel: 'MODEL', tone: 'info', weight: 'important', label: 'MODEL' },
  MODEL_RETRY: { channel: 'MODEL', tone: 'warning', weight: 'important', label: 'RETRY' },

  // --- the historical simulation ----------------------------------------
  /*
   * `BACKTEST_TICK` is `normal` for the same reason a heartbeat is: at sixty
   * simulated minutes a minute it would otherwise dominate every screen.
   */
  BACKTEST_STARTED: { channel: 'BACKTEST', tone: 'info', weight: 'important', label: 'BACKTEST' },
  BACKTEST_TICK: { channel: 'BACKTEST', tone: 'neutral', weight: 'normal', label: 'BACKTEST' },
  BACKTEST_STOPPED: { channel: 'BACKTEST', tone: 'neutral', weight: 'important', label: 'BACKTEST' },
  BACKTEST_COMPLETED: { channel: 'BACKTEST', tone: 'positive', weight: 'important', label: 'BACKTEST' },

  // --- believing something ---------------------------------------------
  /*
   * The plan, not the belief behind it.
   *
   * This product has one user-facing concept for what a GOAT thinks might
   * happen: the Trade Plan. What it believes, what must happen for it to be
   * right and what it will do are one thing, said three ways. So the record
   * that carries the plan is labelled and weighted as the plan — it is the
   * centre of the product — and there is no separate "hypothesis" line beside
   * it saying the same thing in another vocabulary.
   */
  THESIS_FORMED: { channel: 'PLAN', tone: 'info', weight: 'critical', label: 'TRADE PLAN' },
  THESIS_REVISED: { channel: 'PLAN', tone: 'info', weight: 'important', label: 'TRADE PLAN UPDATED' },
  EVIDENCE_REQUIREMENTS_DEFINED: { channel: 'EVIDENCE', tone: 'neutral', weight: 'normal', label: 'EVIDENCE' },
  AGENT_EVIDENCE: { channel: 'EVIDENCE', tone: 'neutral', weight: 'normal', label: 'EVIDENCE' },

  // --- finding out ------------------------------------------------------
  TRACKER: { channel: 'TRACKER', tone: 'neutral', weight: 'normal', label: 'TRACKER' },
  TRACKER_EVALUATED: { channel: 'TRACKER', tone: 'neutral', weight: 'normal', label: 'TRACKER' },
  TRACKER_CREATED: { channel: 'TRACKER', tone: 'info', weight: 'normal', label: 'TRACKER' },
  TRACKER_FIRED: { channel: 'TRACKER', tone: 'info', weight: 'important', label: 'TRACKER' },
  TRACKER_REMOVED: { channel: 'TRACKER', tone: 'neutral', weight: 'normal', label: 'TRACKER' },

  // --- deciding ---------------------------------------------------------
  DECISION: { channel: 'DECISION', tone: 'neutral', weight: 'normal', label: 'DECISION' },
  TRADE_PLAN_CREATED: { channel: 'PLAN', tone: 'info', weight: 'critical', label: 'PLAN' },
  TRADE_PLAN_UPDATED: { channel: 'PLAN', tone: 'info', weight: 'important', label: 'PLAN' },
  TRADE_PLAN_RISK_CHECKED: { channel: 'VALIDATION', tone: 'positive', weight: 'important', label: 'VALIDATION' },
  TRADE_PLAN_REJECTED: { channel: 'VALIDATION', tone: 'negative', weight: 'important', label: 'VALIDATION' },
  RISK_CHECK: { channel: 'RISK', tone: 'neutral', weight: 'important', label: 'RISK' },

  // --- acting -----------------------------------------------------------
  ORDER: { channel: 'EXECUTION', tone: 'warning', weight: 'critical', label: 'EXECUTION' },
  SHADOW_EXECUTION: { channel: 'EXECUTION', tone: 'warning', weight: 'critical', label: 'EXECUTION' },
  POSITION_OPENED: { channel: 'EXECUTION', tone: 'positive', weight: 'important', label: 'EXECUTION' },
  POSITION_UPDATE: { channel: 'EXECUTION', tone: 'neutral', weight: 'normal', label: 'EXECUTION' },
  POSITION_CLOSED: { channel: 'EXECUTION', tone: 'neutral', weight: 'normal', label: 'EXECUTION' },
  /*
   * The order lifecycle.
   *
   * Same channel as execution, because an order is execution that has not
   * happened yet — a resting limit order is the GOAT having acted, which is the
   * thing a person watching wants to see. The tones carry the difference: a
   * rejection is negative and an expiry is neutral, so an expiry never looks like
   * a failure even though it usually is one from the strategy's point of view.
   */
  ORDER_PLACED: { channel: 'EXECUTION', tone: 'info', weight: 'important', label: 'EXECUTION' },
  ORDER_FILLED: { channel: 'EXECUTION', tone: 'positive', weight: 'important', label: 'EXECUTION' },
  ORDER_EXPIRED: { channel: 'EXECUTION', tone: 'neutral', weight: 'normal', label: 'EXECUTION' },
  ORDER_CANCELLED: { channel: 'EXECUTION', tone: 'neutral', weight: 'normal', label: 'EXECUTION' },
  ORDER_REJECTED: { channel: 'RISK', tone: 'negative', weight: 'important', label: 'RISK' },
  /*
   * The loop declined to do what the GOAT asked.
   *
   * Neutral rather than negative: the refusal is the system working. A GOAT that
   * proposes something its skills forbid and is stopped is behaving correctly, and
   * styling that as a failure would train a reader to ignore the one line that
   * explains a stalled GOAT.
   */
  DECISION_REFUSED: { channel: 'VALIDATION', tone: 'neutral', weight: 'normal', label: 'VALIDATION' },
  /*
   * The durable runtime.
   *
   * `RUNTIME` rather than `EXECUTION`, because nothing is being traded here: this
   * is the thing that survives the tab closing, and putting it in the execution
   * channel would imply an order was placed.
   */
  /*
   * The session ended.
   *
   * Its own event rather than a rephrasing of a stop, because the two are not the
   * same: a stop leaves the session and its records, and a clear removes them. A log
   * that recorded both as "stopped" would make the destructive one look routine.
   */
  SESSION_CLEARED: { channel: 'CONTROL', tone: 'warning', weight: 'important', label: 'CLEARED' },
  /*
   * Refused stale work.
   *
   * Neutral, and deliberately not styled as an error: refusing a late answer is the
   * system working correctly, and a session is not permanently in trouble because one
   * request was in flight when it was cleared. Logged at all because "it was
   * refused" and "it was lost" are different claims and only one of them is safe.
   */
  STALE_WORK_REFUSED: { channel: 'CONTROL', tone: 'neutral', weight: 'normal', label: 'STALE' },
  RUNTIME_REGISTERED: { channel: 'RUNTIME', tone: 'positive', weight: 'normal', label: 'RUNTIME' },
  RUNTIME_UNAVAILABLE: { channel: 'RUNTIME', tone: 'warning', weight: 'normal', label: 'RUNTIME' },
  TRADE_CLOSED: { channel: 'EXECUTION', tone: 'positive', weight: 'important', label: 'EXECUTION' },

  // --- losing the hypothesis -------------------------------------------
  THESIS_INVALIDATED: { channel: 'INVALIDATION', tone: 'negative', weight: 'critical', label: 'INVALIDATION' },

  // --- waiting, which is not failing ------------------------------------
  GOAT_WAITING: { channel: 'WAIT', tone: 'neutral', weight: 'normal', label: 'WATCHING' },

  // --- the person, and the lifecycle ------------------------------------
  GOAT_STEERED: { channel: 'CONTROL', tone: 'info', weight: 'important', label: 'STEER' },
  GOAT_REASSESSING: { channel: 'ANALYSIS', tone: 'info', weight: 'important', label: 'REASSESS' },
  GOAT_RESTARTED: { channel: 'CONTROL', tone: 'info', weight: 'important', label: 'RESTART' },
  GOAT_DEPLOYED: { channel: 'CONTROL', tone: 'positive', weight: 'important', label: 'DEPLOYED' },
  GOAT_STARTED: { channel: 'CONTROL', tone: 'positive', weight: 'important', label: 'DEPLOYED' },
  GOAT_RESUMED: { channel: 'CONTROL', tone: 'positive', weight: 'important', label: 'RESUMED' },
  GOAT_STOPPED: { channel: 'CONTROL', tone: 'neutral', weight: 'important', label: 'STOPPED' },

  ERROR: { channel: 'ERROR', tone: 'negative', weight: 'critical', label: 'ERROR' },
};

const FALLBACK: AgentEventStyle = {
  channel: 'CONTROL',
  tone: 'neutral',
  weight: 'normal',
  label: 'EVENT',
};

/**
 * Classify one recorded event.
 *
 * Total by construction: an unrecognised type is a neutral line, never an
 * exception. A log that throws on an unknown event is a log that loses the
 * one line the user most needed.
 */
export function styleForEvent(type: AgentTimelineEventType | string): AgentEventStyle {
  return STYLE[type as AgentTimelineEventType] ?? FALLBACK;
}

/**
 * Whether an event should briefly announce itself.
 *
 * Only the ones that change what the reader believes. A `WAKE` that arrives
 * while the reader is already looking at a `WAKE` is not news, and animating
 * it is how a log starts to feel like it is performing.
 */
export function announcesItself(weight: AgentEventWeight): boolean {
  return weight !== 'normal';
}

/**
 * One line of the agent log, resolved for display.
 *
 * Everything the UI needs, decided in one place, so two surfaces showing the
 * same event cannot disagree about what kind of event it was.
 */
export interface AgentEventView {
  id: string;
  at: number;
  /** The recorded type, kept for keys and for the detail line. */
  type: string;
  /** Headline: one short phrase, no trailing full stop. */
  headline: string;
  /** Optional supporting line: the numbers, the reason, the counts. */
  detail?: string;
  /** Optional artefact the reader can act on or inspect. */
  artifact?: { kind: 'thesis' | 'plan' | 'tracker'; id: string; label: string };
  style: AgentEventStyle;
}