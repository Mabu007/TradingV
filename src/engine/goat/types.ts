/**
 * GOAT — Goal-Oriented Agentic Trader.
 *
 * Core domain model.
 *
 * The five objects a GOAT deployment is made of:
 *
 *   Goal      what the user wants
 *   Thesis    what GOAT currently believes about the market
 *   Tracker   what GOAT is watching for
 *   Evidence  what it has seen that bears on the thesis
 *   TradeIdea what GOAT proposes once a thesis becomes actionable
 *
 * Everything here is plain data. No behaviour, no I/O, no framework
 * types. That keeps the model testable in isolation and keeps the
 * persistence layer free to choose its own storage.
 *
 * Where each object lives:
 *
 *   Goal          here. Nothing in the architecture before GOAT recorded
 *                 what the user was actually trying to achieve.
 *   Thesis        here. Replaces the implicit "a config is a belief"
 *                 model with an explicit, revisable hypothesis.
 *   Tracker       `agents/trackers`. The canonical domain object, with
 *                 its own registry, evaluator and runtime. It is
 *                 re-exported below rather than redefined, so the GOAT
 *                 layer and the runtime cannot drift apart.
 *   TrackerEvent  `agents/trackers`. The observation, plus the thesis it
 *                 belongs to.
 *   Evidence      here. It is a claim about a thesis, and a thesis is
 *                 the GOAT layer's own concept.
 *   TradeIdea     here. Deliberately separate from AgentDecision, because
 *                 constructing an idea is not authorising execution.
 */

import type {
  Tracker,
  TrackerDataRequirement,
  TrackerEvent,
  TrackerEventSeverity,
  TrackerEventType,
  TrackerKind,
  TrackerRequest,
  TrackerStatus,
  TrackerWakeRequest as WakeRequest,
} from '../agents/trackers/types';

export type {
  Tracker,
  TrackerDataRequirement,
  TrackerEvent,
  TrackerEventSeverity,
  TrackerEventType,
  TrackerKind,
  TrackerRequest,
  TrackerStatus,
  WakeRequest,
};

/**
 * The user's objective.
 *
 * A Goal states WHAT is wanted. It must not encode HOW to pursue it:
 * no indicators, no thresholds, no tracker configuration. If a goal
 * carries an implementation, the user has written the agent's
 * observation plan for it, and there is nothing left for the GOAT to
 * work out.
 */
export interface Goal {
  id: string;
  /** Owning agent. One agent pursues exactly one goal at a time. */
  agentId: string;
  /**
   * What the user calls this GOAT.
   *
   * A label, not an identity. Renaming writes this field and nothing else:
   * the id, the goal, the skills, the theses, the evidence and the
   * deployments are untouched, because a GOAT that changed when it was
   * renamed would lose the history that makes it worth keeping.
   */
  name?: string;
  /**
   * The user's own description of this GOAT.
   *
   * Metadata about the agent, kept separate from `statement`: one is "what
   * this GOAT is for", the other is "what this GOAT is". Conflating them
   * is how a rename silently rewrites an objective.
   */
  description?: string;
  /** The user's own words. Never rewritten by the agent. */
  statement: string;
  /**
   * The agent's reading of the statement, in its own words.
   *
   * Kept separate from `statement` so the user can always see what they
   * asked for next to what the agent thought they asked for. When these
   * two disagree, the disagreement is the bug.
   */
  interpretation?: string;
  /**
   * Symbols the goal is about, when the agent could determine them.
   *
   * Empty means "not yet determined" rather than "any symbol". A goal
   * the agent could not scope is not a reason to go looking everywhere.
   */
  symbols: string[];
  /** Timeframes the agent judged relevant to the goal. */
  timeframes: string[];
  /** Skills the user attached, or that the agent proposed and was given. */
  skillIds: string[];
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Where a GOAT is in its life.
 *
 * There is no "not specific enough" state, and that is deliberate. A GOAT
 * used to be refused deployment until its author had written a strategy
 * rather than an objective — entry, stop, target, timeframe — which is the
 * one thing the agent exists to work out. The only states now are where the
 * GOAT actually is: saved, working out its thesis, or watching.
 */
export type GoalStatus =
  /**
   * Created and pointed at a market, working out what it believes.
   *
   * Also the state a GOAT is in between being saved and being deployed.
   */
  | 'DRAFT'
  /** Deployed and working out what it believes. */
  | 'INVESTIGATING'
  /** Deployed and watching. */
  | 'MONITORING'
  /**
   * Created, but not pointed at a market.
   *
   * A real state with its own next action: a GOAT is never bound to a
   * market at creation, so "I have not chosen where it runs yet" is
   * something the user does, not something the agent refuses.
   */
  | 'UNDEPLOYED'
  | 'ACHIEVED'
  | 'ABANDONED';

/**
 * A hypothesis about the market.
 *
 * A Thesis is the unit of reasoning. It owns its Trackers, its Evidence
 * and its revision history, and it can be true, false, or simply not yet
 * decided. It is never the same thing as a position.
 */
export interface Thesis {
  id: string;
  goalId: string;
  agentId: string;
  /** Free-text hypothesis, e.g. "the decline is corrective, not impulsive". */
  statement: string;
  /** Direction the hypothesis implies, when it implies one. */
  direction?: ThesisDirection;
  /**
   * What must be true for this thesis to hold.
   *
   * This is the observation plan before it becomes Trackers: the
   * evidence GOAT believes it needs. Trackers are how those
   * requirements get instrumented.
   */
  requiredConfirmation: string[];
  /**
   * The condition under which the thesis is wrong.
   *
   * Invalidation is a first-class field, not a comment on the stop
   * loss. "What must happen for me to be wrong" is asked before any
   * price is chosen, because it decides where the stop belongs.
   */
  invalidation: string;
  state: ThesisState;
  /**
   * Confidence in [0,1].
   *
   * Advisory only. Nothing in the runtime treats it as a probability to
   * be traded on; it exists so the user can see how settled the agent's
   * belief is, and so a revision that lowers it is visible.
   */
  confidence?: number;
  /**
   * Monotonic revision counter. Every accepted revision increments it,
   * which is what makes a thesis history readable as a sequence.
   */
  revision: number;
  /**
   * The thesis this one is a competing reading of, if any.
   *
   * A pair of opposing hypotheses about one question, not two agents. Both belong
   * to the same goal, each keeps its own evidence and its own trackers, and the
   * ceiling above still bounds how many may exist. Set only where a goal's skills
   * allow more than one live thesis; the runtime refuses the link otherwise, which
   * is the difference between a hypothesis tournament and an unbounded branching
   * agent.
   *
   * There is no automatic winner. Evidence that invalidates one ends the pair by
   * abandoning the other, because that is the only moment the record actually
   * supports a conclusion.
   */
  competesWith?: string;
  /**
   * How many trade constructions the risk layer has refused for this thesis.
   *
   * Bounded, and read by the loop before it will accept another proposal. It
   * exists because the alternative is a loop the GOAT cannot leave: propose,
   * be refused, propose the same thing again, be refused, until something else
   * happens to interrupt it. See `MAX_RISK_REVISIONS` in `loop.ts`.
   */
  riskAttempts?: number;
  createdAt: number;
  updatedAt: number;
}

export type ThesisDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type ThesisState =
  | 'DRAFT'
  | 'INVESTIGATING'
  | 'ACTIVE'
  | 'STRENGTHENING'
  | 'WEAKENING'
  | 'ACTIONABLE'
  | 'INVALIDATED'
  | 'ABANDONED'
  | 'COMPLETED';

/**
 * States from which a thesis may still change its mind.
 *
 * INVALIDATED, ABANDONED and COMPLETED are terminal. A terminal thesis
 * is not deleted, because the user asking "why did GOAT give up on
 * this?" is a question the history has to be able to answer.
 */
export const TERMINAL_THESIS_STATES: ReadonlySet<ThesisState> = new Set<ThesisState>([
  'INVALIDATED',
  'ABANDONED',
  'COMPLETED',
]);

/**
 * Legal thesis transitions.
 *
 * Enforced by the store rather than by convention, because an
 * agent-driven state machine that nothing checks is not a state machine.
 */
export const THESIS_TRANSITIONS: Readonly<Record<ThesisState, readonly ThesisState[]>> = {
  DRAFT: ['INVESTIGATING', 'ACTIVE', 'ABANDONED', 'INVALIDATED'],
  INVESTIGATING: ['ACTIVE', 'ABANDONED', 'INVALIDATED'],
  ACTIVE: ['STRENGTHENING', 'WEAKENING', 'ACTIONABLE', 'ABANDONED', 'INVALIDATED', 'COMPLETED', 'ACTIVE'],
  STRENGTHENING: ['STRENGTHENING', 'WEAKENING', 'ACTIONABLE', 'ACTIVE', 'ABANDONED', 'INVALIDATED', 'COMPLETED'],
  WEAKENING: ['WEAKENING', 'STRENGTHENING', 'ACTIONABLE', 'ACTIVE', 'ABANDONED', 'INVALIDATED', 'COMPLETED'],
  ACTIONABLE: ['ACTIVE', 'WEAKENING', 'STRENGTHENING', 'COMPLETED', 'ABANDONED', 'INVALIDATED'],
  INVALIDATED: [],
  ABANDONED: [],
  COMPLETED: [],
};

export function canTransitionThesis(from: ThesisState, to: ThesisState): boolean {
  return THESIS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Whether a value is one of the thesis states at all.
 *
 * This is an admission test, not a transition test, and the distinction is
 * load-bearing. Validating a restored thesis with
 * `canTransitionThesis(state, state)` admits only the states that happen
 * to list themselves as a successor — ACTIVE, STRENGTHENING, WEAKENING —
 * and silently discards DRAFT, INVESTIGATING, ACTIONABLE and every
 * terminal state. That deleted a GOAT's entire thesis history on each
 * reload, which is exactly what the terminal states exist to prevent.
 */
export function isThesisState(value: unknown): value is ThesisState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THESIS_TRANSITIONS, value);
}

/**
 * A piece of evidence bearing on a thesis.
 *
 * Evidence is the record of why the agent believes what it believes. It
 * is signed by polarity rather than by truth: `SUPPORTS` means this
 * argues for the thesis, and says nothing about whether it is correct.
 */
export interface Evidence {
  id: string;
  thesisId: string;
  /** Whether this argues for or against the thesis. */
  polarity: 'SUPPORTS' | 'CONTRADICTS';
  /** The observation, in plain language. */
  summary: string;
  /** Where it came from. Never fabricated: an untraced claim is a bug. */
  source: EvidenceSource;
  /**
   * The concrete numbers behind the summary, when there are any.
   *
   * Kept structured so the UI can show what was actually measured
   * instead of only the agent's prose about it.
   */
  observed?: Record<string, number | string>;
  /** Agent's confidence in this specific piece of evidence, [0,1]. */
  confidence?: number;
  /** Identifier of the tracker event that produced it, when applicable. */
  trackerEventId?: string;
  /**
   * Identity of the *observation*, as distinct from the event that reported it.
   *
   * Two wakes can report one market observation; without this, belief is moved
   * twice for one thing that happened. See `provenanceKey`.
   */
  provenance?: string;
  /** The tracker that produced it, when a tracker did. */
  sourceTrackerId?: string;
  /** The resolution the observation was made at. */
  timeframe?: string;
  /** The market the observation was made on. */
  symbol?: string;
  /**
   * How much of an effect this evidence was worth, and what remains of it.
   *
   * `weight` is the signed effect the runtime computed; `novelty` is the fraction
   * that survived repetition. Both are recorded because a reader looking at why a
   * thesis reached a confidence needs the arithmetic, not just the number it
   * produced.
   */
  weight?: number;
  novelty?: number;
  /**
   * What this evidence is in tension with, when it is.
   *
   * Contradiction is not the same as disagreement with the thesis: evidence can
   * support the thesis and still conflict with an earlier supporting claim. The
   * model is shown both facts separately for that reason.
   */
  conflictsWith?: Array<{ evidenceId: string; because: string }>;
  createdAt: number;
}

export type EvidenceSource =
  | 'TRACKER_EVENT'
  | 'SKILL'
  | 'AGENT_INVESTIGATION'
  | 'MARKET_DATA'
  /**
   * The deterministic risk layer's verdict on a trade construction.
   *
   * Not evidence about the market — the market was never consulted — and recorded
   * as such, because a GOAT that has been refused twice for the same reason and
   * proposes it a third time is not reasoning badly, it is reasoning without
   * having been told.
   */
  | 'RISK_FEEDBACK';

/**
 * A structured trade proposal.
 *
 * A TradeIdea is what GOAT produces when a thesis becomes actionable.
 * It is deliberately not an order and not an `AgentDecision`: producing
 * one requires no execution permission, and converting one into an
 * order is a separate step that passes through the existing policy and
 * risk gates.
 */
export interface TradeIdea {
  id: string;
  thesisId: string;
  goalId: string;
  agentId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  /** Primary entry. Meaning depends on `orderType`. */
  entry: number;
  /**
   * The price at which the thesis is wrong.
   *
   * Not a risk parameter dressed up as one. It is the thesis
   * invalidation turned into a price, which is why it is derived from
   * the thesis rather than from a position-sizing rule.
   */
  invalidationLevel: number;
  takeProfits: TradeIdeaTarget[];
  /** Why this, why now, in the agent's words. */
  reasoning: string;
  /** Evidence ids that support the idea. */
  supportingEvidence: string[];
  /** The thesis's invalidation, restated at the price level. */
  invalidation: string;
  /** Account context that shaped sizing, when it was available. */
  riskContext?: TradeIdeaRiskContext;
  /**
   * Where this plan is in its life.
   *
   * A trade plan is the GOAT's output, so it has to be able to say "not
   * yet" — that is the whole difference between an agent and a signal
   * generator. `PROPOSED` is what the agent produces; `RISK_CHECK`,
   * `READY`, `EXECUTING`, `MANAGING` and `CLOSED` are what the
   * deterministic side decides; `WAITING` is what happens when a plan
   * cannot be advanced yet, which is a successful outcome, not a failure.
   */
  status: TradeIdeaStatus;
  /**
   * The deterministic verdict, when one has been run.
   *
   * Kept on the record so the UI never has to re-derive a risk number, and
   * so "why is this not trading" has an answer that is not a guess.
   */
  riskCheck?: TradeIdeaRiskCheck;
  createdAt: number;
  updatedAt: number;
}

export type TradeIdeaStatus =
  /** The agent has written it. Nothing has checked it yet. */
  | 'PROPOSED'
  /** Checked by the deterministic risk layer. */
  | 'RISK_CHECK'
  /** Risk-validated. Would execute if the deployment permitted it. */
  | 'READY'
  /** An order for this plan is live. */
  | 'EXECUTING'
  /** A position from this plan is open. */
  | 'MANAGING'
  /** The plan is done. */
  | 'CLOSED'
  /** The thesis behind it was disproven. */
  | 'INVALIDATED'
  /** Cannot be advanced yet. Evidence, permission or risk. */
  | 'WAITING';

export interface TradeIdeaRiskCheck {
  approved: boolean;
  /** Plain words, safe to show a user. Never a provider payload. */
  reason: string;
  checkedAt: number;
  /** Dollar risk, equity, percentage — whatever the check produced. */
  metrics?: Record<string, number | string>;
}

export interface TradeIdeaTarget {
  price: number;
  /** Fraction of the idea's size intended to close here, [0,1]. */
  fraction: number;
  label?: string;
}

export interface TradeIdeaRiskContext {
  equity?: number;
  /** Distance from entry to invalidation, in account currency per unit. */
  riskPerUnit?: number;
  riskCurrency?: number;
  riskFractionOfEquity?: number;
}

/**
 * What the agent decided to do with a wake.
 *
 * The output space is intentionally small and closed. Every member is a
 * reasoning outcome; none of them executes anything.
 */
export type AgentPlan =
  | { kind: 'CONFIRM_THESIS'; thesisId: string; reason: string; nextCheck?: string }
  | { kind: 'WEAKEN_THESIS'; thesisId: string; reason: string; nextCheck?: string }
  | { kind: 'INVALIDATE_THESIS'; thesisId: string; reason: string }
  | { kind: 'REVISE_THESIS'; thesisId: string; reason: string; statement?: string; invalidation?: string; confidence?: number }
  | { kind: 'CREATE_TRACKER'; thesisId: string; spec: TrackerRequest; reason: string }
  | { kind: 'REMOVE_TRACKER'; trackerId: string; reason: string }
  /**
   * The hypothesis now meets the bar for trading.
   *
   * This is the escalation, and until it existed the GOAT could not trade at
   * all — not "rarely", never. `PROPOSE_TRADE_IDEA` is only accepted on an
   * ACTIONABLE thesis, and the only way to reach that state was
   * `loop.reviseThesis`, which no wake path ever called. So a model that did
   * everything right on every wake was refused at the last step, every time.
   *
   * One decision per wake is still the rule, so escalating and proposing are two
   * wakes: this one says the thesis is ready, and the next one prices it. The
   * alternative — letting one wake do both — would mean constructing a trade
   * idea from evidence the model had not yet been shown.
   */
  | { kind: 'ESCALATE_THESIS'; thesisId: string; reason: string }
  | { kind: 'PROPOSE_TRADE_IDEA'; thesisId: string; idea: TradeIdeaRequest; reason: string }
  | { kind: 'WAIT'; reason: string }
  /*
   * Several decisions, taken together, from one wake.
   *
   * A wake that means "record this, weaken that, and stop watching the stale
   * condition" previously cost three wakes, and two of them were wakes the GOAT
   * could not ask for — it had to wait for the market to oblige. That is not
   * precision, it is latency charged against the GOAT's own reasoning.
   *
   * What this is *not*: a program. The steps are drawn from the same finite
   * vocabulary as a single decision, they may not nest, at most one step of each
   * kind may appear, and the length is capped by the loop before anything is
   * applied. Every step still passes through the same validation it would have
   * passed on its own — the composite changes the transaction, never the
   * authority.
   */
  | {
      kind: 'COMPOSITE';
      thesisId: string;
      reason: string;
      /** Ordered, non-nested, and deduplicated by kind by the loop. */
      steps: AgentPlanStep[];
    };

/**
 * One step of a composite plan.
 *
 * The same vocabulary as a single decision, minus the composite itself, so a
 * composite cannot contain a composite and cannot grow a new vocabulary by
 * accident.
 */
export type AgentPlanStep = Exclude<AgentPlan, { kind: 'COMPOSITE' }>;

export interface TradeIdeaRequest {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  entry: number;
  invalidationLevel: number;
  takeProfits: Array<{ price: number; fraction: number; label?: string }>;
  reasoning: string;
  supportingEvidence?: string[];
  riskContext?: TradeIdeaRiskContext;
}
