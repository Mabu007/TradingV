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
  | 'WAIT'
  | 'INVALIDATION'
  | 'ERROR'
  | 'CONTROL';

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

  // --- reading the world ------------------------------------------------
  MARKET_CONTEXT_LOADED: { channel: 'MARKET', tone: 'neutral', weight: 'normal', label: 'MARKET' },
  FILL: { channel: 'MARKET', tone: 'neutral', weight: 'normal', label: 'MARKET' },
  OBSERVATION: { channel: 'OBSERVATION', tone: 'neutral', weight: 'normal', label: 'OBSERVATION' },
  CAPABILITY_CALL: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  CAPABILITY_RESULT: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  MARKET_RESEARCH_COMPLETED: { channel: 'RESEARCH', tone: 'neutral', weight: 'normal', label: 'RESEARCH' },
  NO_THESIS_YET: { channel: 'RESEARCH', tone: 'warning', weight: 'normal', label: 'RESEARCH' },
  MODEL_FAILURE: { channel: 'ERROR', tone: 'negative', weight: 'critical', label: 'ERROR' },

  // --- believing something ---------------------------------------------
  THESIS_FORMED: { channel: 'ANALYSIS', tone: 'info', weight: 'important', label: 'THESIS' },
  THESIS_REVISED: { channel: 'ANALYSIS', tone: 'info', weight: 'important', label: 'THESIS' },
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