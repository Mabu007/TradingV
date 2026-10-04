/**
 * What a GOAT is doing right now.
 *
 * One read model, derived from records the runtime actually wrote, and read
 * by everything that has to answer that question: the GOAT screens, the
 * live cards, the chatbot's tools, and the tests. A second implementation
 * in the frontend would drift within one release, and then the assistant
 * and the screen would disagree about the same GOAT — which is worse than
 * either being wrong alone.
 *
 * Two rules govern everything below.
 *
 *   Nothing is invented. A stage is chosen because a record says so: a
 *   thesis exists, trackers are active, a plan was written, a wake
 *   happened. A GOAT that has done nothing is `RESEARCHING` with an empty
 *   activity list, which is an honest and useful thing to show.
 *
 *   Nothing is decorative. There is no timer, no animated progress and no
 *   stage that exists to make the interface feel busy. The work plan is a
 *   projection of state, so it can be trusted, and an empty step is a
 *   statement about the GOAT rather than about the design.
 */

import type { GoatDeployment } from './definition';
import type {
  Evidence,
  Goal,
  Thesis,
  Tracker,
  TrackerEvent,
  TradeIdea,
} from './types';
import type { SteeringNote } from './steering';

/**
 * The stages a GOAT moves through.
 *
 * Roughly the arc of the product: understand the objective, read the
 * market, form a hypothesis, watch for the evidence, build a plan, risk
 * check it, act if permitted. Not every GOAT uses every stage, and a GOAT
 * can sit in one for a long time; sitting still is a stage too.
 */
export type MissionStage =
  | 'UNDEPLOYED'
  | 'UNDERSTANDING'
  | 'RESEARCHING'
  /*
   * Blocked on the model.
   *
   * A stage rather than a decoration, because it is the answer to the question
   * this read model exists for: the GOAT is not watching the market, and it is
   * not stuck either — it has done everything it can and is waiting on an
   * external dependency. Rendering this as RESEARCHING or WAITING made a
   * healthy deployment look like it had nothing to do.
   */
  | 'WAITING_FOR_MODEL'
  | 'ANALYZING'
  | 'FORMING_THESIS'
  | 'COLLECTING_EVIDENCE'
  | 'MONITORING'
  | 'RE_EVALUATING'
  | 'BUILDING_TRADE_PLAN'
  | 'RISK_CHECK'
  | 'READY'
  | 'EXECUTING'
  | 'MANAGING'
  | 'WAITING'
  | 'STOPPED'
  | 'ERROR';

/** Short, human wording for a stage. One place, so it is always consistent. */
export const MISSION_STAGE_LABELS: Record<MissionStage, string> = {
  UNDEPLOYED: 'Not deployed',
  UNDERSTANDING: 'Understanding your objective',
  RESEARCHING: 'Researching the market',
  WAITING_FOR_MODEL: 'Working on its Trade Plan',
  ANALYZING: 'Analyzing what it found',
  FORMING_THESIS: 'Forming a thesis',
  COLLECTING_EVIDENCE: 'Collecting evidence',
  MONITORING: 'Monitoring',
  RE_EVALUATING: 'Re-evaluating',
  BUILDING_TRADE_PLAN: 'Building trade plan',
  RISK_CHECK: 'Risk-checking the plan',
  READY: 'Plan ready',
  EXECUTING: 'Executing',
  MANAGING: 'Managing an open position',
  WAITING: 'Waiting',
  STOPPED: 'Stopped',
  ERROR: 'Needs attention',
};

export type WorkStepStatus = 'done' | 'active' | 'pending';

export interface WorkStep {
  id: string;
  label: string;
  /** What actually happened, where there is something to say. */
  detail?: string;
  status: WorkStepStatus;
}

export type RuntimeStatus = 'RUNNING' | 'STOPPED' | 'UNDEPLOYED' | 'PAUSED' | 'ERROR';

/**
 * The next thing this GOAT is waiting for.
 *
 * `label` is always populated so a surface has something to render, and
 * `blocked` is what tells it that nothing is coming. `waitFor` is the
 * concrete condition when one exists, because "waiting" is a far weaker
 * thing to read than "waiting for price to retest 1.1710".
 */
export interface MissionNext {
  label: string;
  detail?: string;
  /** The specific condition being waited for, in the tracker's own words. */
  waitFor?: string;
  /** True when nothing is coming, and `label` says why. */
  blocked: boolean;
}

export interface TrackerSummary {
  id: string;
  purpose: string;
  kind: string;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | string;
  eventCount: number;
  lastEvaluatedAt?: number;
  expiresAt?: number;
}

export interface MissionActivity {
  /** One line: what this GOAT is doing right now. */
  headline: string;
  /** Why, in one more line. Empty when there is nothing to add. */
  detail: string;
  /** The tracker's own words: what it is waiting for. */
  watching: string[];
}

export interface GoatMission {
  goalId: string;
  agentId: string;
  name: string;
  description: string;
  goal: string;
  /** The agent's reading of the goal, when it has made one. */
  interpretation?: string;
  skillIds: string[];

  stage: MissionStage;
  stageLabel: string;
  runtime: RuntimeStatus;

  deployment?: GoatDeployment;
  market?: string;
  /** The resolution this GOAT acts on. */
  timeframe?: string;
  /**
   * Every resolution this GOAT may read, setup first.
   *
   * Carried whole rather than as a single resolution because that is what a
   * GOAT is: a scalper works on 1m and 5m, a swing GOAT on 15m and 1h, and
   * anything that needs to replay or explain the GOAT has to know the difference.
   */
  timeframes: string[];
  mode?: GoatDeployment['mode'];
  environment?: GoatDeployment['venueEnvironment'];
  /** False when the deployment cannot act on a plan. */
  mayExecute: boolean;

  thesis?: Thesis;
  thesisCount: number;
  evidence: Evidence[];
  supportingEvidenceCount: number;
  contradictingEvidenceCount: number;
  trackers: TrackerSummary[];
  activeTrackerCount: number;

  tradePlan?: TradeIdea;
  tradePlanStatus?: TradeIdea['status'];

  activity: MissionActivity;
  /**
   * What the GOAT is waiting for, in one line.
   *
   * The question a person actually has — "what is it doing right now?" —
   * had no first-class answer, so every surface improvised one and they did
   * not agree. Derived from real state only; `blocked` is what stops a
   * waiting state from reading as progress.
   */
  next: MissionNext;
  /**
   * Skill requirements the GOAT has not met yet.
   *
   * Reported rather than silently unenforced: a user whose skills ask for
   * higher-timeframe confirmation should be able to see that it has not
   * happened, instead of wondering why the plan sits in RESEARCHING.
   */
  outstandingConstraints: string[];
  workPlan: WorkStep[];
  /** When this GOAT last woke on a tracker, when it ever has. */
  lastWakeAt?: number;
  /**
   * The most recent thing the runtime recorded for this GOAT.
   *
   * Present because "is it working?" cannot be answered from mission fields
   * alone: a GOAT whose last recorded step was a model failure looks
   * identical to one that has been quietly watching all morning, unless you
   * know what it last managed to do.
   */
  lastEvent?: { at: number; type: string };
  /**
   * The most recent recorded failure, when nothing has succeeded since.
   *
   * Not the same as `lastEvent`. A failed reasoning step is usually followed
   * by a `GOAT_WAITING` line — the runtime recording that it went back to
   * sleep — so "the newest record" is the sleep, and a surface that only
   * looked at that would report a failed GOAT as healthy. This is the
   * failure, resolved against anything that has happened since.
   */
  lastFailure?: { at: number; type: string };
  lastActivity?: { at: number; text: string };
  /**
   * The model request this GOAT is blocked on, when it has one.
   *
   * Exposed so a surface can say what it is waiting for instead of rendering
   * an idle agent and an empty log as the same thing.
   */
  modelPending?: { at: number; intent: string; contract?: string; phase?: 'FORMING' | 'UPDATING' };

  steering: { total: number; pending: number; notes: SteeringNote[] };
  updatedAt: number;
}

export interface MissionInput {
  goal: Goal;
  deployment?: GoatDeployment;
  runtime: RuntimeStatus;
  theses: Thesis[];
  trackers: Tracker[];
  events: TrackerEvent[];
  evidence: Evidence[];
  tradePlan?: TradeIdea;
  steering?: SteeringNote[];
  /** The GOAT's recorded history, newest first, when the caller has it. */
  activity?: Array<{ at: number; type: string }>;
  /** Skill requirements this goal has not met, resolved by the caller. */
  outstandingConstraints?: string[];
  /** The most recent wake, when one is being processed right now. */
  reEvaluating?: boolean;
  /**
   * The outstanding model request, when the runtime has one.
   *
   * Supplied by the orchestrator rather than reconstructed from timestamps.
   * A read model that inferred "waiting for the model" from the age of the
   * last event would eventually be wrong in the direction that matters most:
   * reporting a stuck agent as busy.
   */
  modelPending?: { intent: string; contract?: string; phase?: 'FORMING' | 'UPDATING' };
  now: number;
}

/**
 * Records that mean a step did not work.
 *
 * Shared with the status indicator so the two cannot disagree about which
 * records are failures.
 */
export const FAILURE_EVENTS: ReadonlySet<string> = new Set(['MODEL_FAILURE', 'ERROR']);

/**
 * Records that mean nothing was actually attempted.
 *
 * A GOAT that fails to read the model records the failure and then records
 * that it went back to sleep. Those two lines are a sequence, and reading
 * only the newest one reports a failed GOAT as healthy — which is what the
 * indicator did before this set existed, found by deploying a real GOAT and
 * watching a green pulsing dot appear immediately after a recorded failure.
 *
 * So these are explicitly *not* progress, and do not retire a failure. Every
 * other record either is a failure or is something the runtime actually did.
 */
export const BOOKKEEPING_EVENTS: ReadonlySet<string> = new Set([
  'GOAT_WAITING',
  'TRACKER_EVALUATED',
]);

/** A tracker fires at most this often, so "just woke" means just. */
const JUST_WOKE_MS = 12_000;

/**
 * What this GOAT is waiting for next.
 *
 * Ordered by how much can actually happen, which is not the same as the order
 * the work plan reads in. A GOAT that is stopped is not "waiting to gather
 * evidence"; a GOAT whose thesis is invalidated is not "waiting for a
 * retest". Both of those were answerable from the work plan alone, and both
 * answers would have been reassuring and wrong.
 */
function deriveNext(input: {
  input: MissionInput;
  liveThesis?: Thesis;
  activeTrackers: TrackerSummary[];
  stage: MissionStage;
  tradePlan?: TradeIdea;
}): MissionNext {
  const { input: source, liveThesis, activeTrackers, stage } = input;
  const market = source.deployment?.marketId;

  if (!source.deployment) {
    return { label: 'Not deployed \u2014 choose a market', blocked: true };
  }
  if (source.runtime === 'STOPPED' || source.runtime === 'PAUSED') {
    return { label: 'Stopped \u2014 nothing is being watched', blocked: true };
  }
  if (source.runtime === 'ERROR') {
    return { label: 'Runtime is not running this GOAT', blocked: true };
  }
  if (liveThesis && isTerminal(liveThesis)) {
    return {
      label: `Trade Plan ${liveThesis.state.toLowerCase()} \u2014 nothing to act on from it`,
      detail: liveThesis.invalidation,
      blocked: true,
    };
  }
  if (stage === 'WAITING_FOR_MODEL') {
    /*
     * Not blocked. Something is genuinely in flight — a request that has been
     * submitted and not yet answered — and a reader told "nothing is coming"
     * during that window would be told the one thing that is untrue.
     */
    return {
      label:
        source.modelPending?.phase === 'UPDATING'
          ? 'Updating its Trade Plan'
          : 'Building its Trade Plan',
      detail: source.modelPending?.intent,
      blocked: false,
    };
  }
  if (stage === 'RISK_CHECK' || stage === 'READY') {
    return { label: 'Risk check', detail: source.tradePlan?.riskCheck?.reason, blocked: false };
  }
  if (stage === 'EXECUTING' || stage === 'MANAGING') {
    return { label: stage === 'EXECUTING' ? 'Working an order' : 'Managing an open position', blocked: false };
  }
  /*
   * No plan yet. Not "blocked", because something is in flight — a deployment is
   * reading the market or waiting on the model — and telling a reader that
   * nothing is coming is the one thing that would be untrue here.
   */
  if (!liveThesis) {
    return {
      label: `Reading ${market ?? 'the market'} to form a Trade Plan`,
      detail: activeTrackers.length === 0 ? 'No Trade Plan yet.' : undefined,
      blocked: false,
    };
  }
  if (activeTrackers.length > 0) {
    return {
      label: `Waiting on ${activeTrackers.length} condition${activeTrackers.length === 1 ? '' : 's'}`,
      waitFor: activeTrackers[0].purpose,
      detail: liveThesis.invalidation ? `Wrong if: ${liveThesis.invalidation}` : undefined,
      blocked: false,
    };
  }

  return {
    label: `Deciding what to watch for on ${market ?? 'this market'}`,
    detail: liveThesis.invalidation ? `Wrong if: ${liveThesis.invalidation}` : undefined,
    blocked: true,
  };
}

/**
 * Derive the mission. Pure: same input, same answer, no I/O.
 */
export function buildMission(input: MissionInput): GoatMission {
  const { goal, deployment, runtime, now } = input;

  // Sorted on a copy. `buildMission` is documented as pure, and this used to
  // reorder the caller's array in place — so the same input could answer
  // differently depending on who had read it first.
  const theses = [...input.theses];
  const liveThesis =
    theses.find((thesis) => !isTerminal(thesis)) ??
    theses.sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const trackers = input.trackers.map(toTrackerSummary);
  const activeTrackers = trackers.filter((tracker) => tracker.status === 'ACTIVE');

  const market = deployment?.marketId;
  const timeframe = goal.timeframes[0];
  const supporting = input.evidence.filter((item) => item.polarity === 'SUPPORTS');
  const contradicting = input.evidence.filter((item) => item.polarity === 'CONTRADICTS');

  const latestEvent = [...input.events].sort((a, b) => b.timestamp - a.timestamp)[0];
  const recorded = input.activity ?? [];
  const lastRecorded = recorded[0];
  /*
   * Walk newest-first until something decides the question.
   *
   * A failure is unresolved only if nothing real has happened since it, and
   * "something real" is defined above rather than guessed: bookkeeping lines
   * do not count, so a failure followed by a sleep line stays a failure.
   */
  const lastFailure = (() => {
    for (const entry of recorded) {
      if (FAILURE_EVENTS.has(entry.type)) return entry;
      if (!BOOKKEEPING_EVENTS.has(entry.type)) return undefined;
    }
    return undefined;
  })();
  const lastActivity = input.tradePlan
    ? { at: input.tradePlan.updatedAt, text: `Trade plan ${label(input.tradePlan.status).toLowerCase()}` }
    : latestEvent
      ? { at: latestEvent.timestamp, text: latestEvent.reason }
      : liveThesis
        ? { at: liveThesis.updatedAt, text: `Thesis ${liveThesis.state.toLowerCase()}` }
        : { at: goal.updatedAt, text: goal.interpretation ? 'Goal read' : 'Created' };

  const stage = deriveStage({ input, liveThesis, activeTrackerCount: activeTrackers.length });
  const activity = deriveActivity({ input, liveThesis, activeTrackers, stage });
  const next = deriveNext({ input, liveThesis, activeTrackers, stage, tradePlan: input.tradePlan });

  return {
    goalId: goal.id,
    agentId: goal.agentId,
    name: goal.name?.trim() || defaultName(goal),
    description: goal.description?.trim() ?? '',
    goal: goal.statement,
    interpretation: goal.interpretation,
    skillIds: [...goal.skillIds],

    stage,
    stageLabel: MISSION_STAGE_LABELS[stage],
    runtime,

    deployment,
    market,
    timeframe,
    timeframes: [...(goal.timeframes ?? [])],
    mode: deployment?.mode,
    environment: deployment?.venueEnvironment,
    mayExecute: deployment?.execution.canExecute === true,

    thesis: liveThesis,
    thesisCount: input.theses.length,
    evidence: [...input.evidence].sort((a, b) => b.createdAt - a.createdAt),
    supportingEvidenceCount: supporting.length,
    contradictingEvidenceCount: contradicting.length,
    trackers,
    activeTrackerCount: activeTrackers.length,

    tradePlan: input.tradePlan,
    tradePlanStatus: input.tradePlan?.status,

    activity,
    next,
    outstandingConstraints: input.outstandingConstraints ?? [],
    workPlan: buildWorkPlan({
      goal,
      stage,
      thesis: liveThesis,
      activeTrackerCount: activeTrackers.length,
      evidence: input.evidence,
      tradePlan: input.tradePlan,
      runtime,
      inspected: hasInspectedMarket(input),
    }),
    ...(latestEvent ? { lastWakeAt: latestEvent.timestamp } : {}),
    ...(lastRecorded
      ? { lastEvent: { at: lastRecorded.at, type: lastRecorded.type } }
      : {}),
    ...(lastFailure ? { lastFailure: { at: lastFailure.at, type: lastFailure.type } } : {}),
    ...(input.modelPending
      ? {
          modelPending: {
            at: now,
            intent: input.modelPending.intent,
            ...(input.modelPending.contract ? { contract: input.modelPending.contract } : {}),
            ...(input.modelPending.phase ? { phase: input.modelPending.phase } : {}),
          },
        }
      : {}),
    lastActivity,

    steering: {
      total: input.steering?.length ?? 0,
      pending: (input.steering ?? []).filter((note) => note.appliedAt === undefined).length,
      notes: input.steering ?? [],
    },
    updatedAt: Math.max(
      goal.updatedAt,
      liveThesis?.updatedAt ?? 0,
      input.tradePlan?.updatedAt ?? 0,
      latestEvent?.timestamp ?? 0,
    ),
  };
}

function deriveStage(input: {
  input: MissionInput;
  liveThesis?: Thesis;
  activeTrackerCount: number;
}): MissionStage {
  const { input: source, liveThesis, activeTrackerCount } = input;

  if (!source.deployment) return 'UNDEPLOYED';
  if (source.runtime === 'STOPPED' || source.runtime === 'PAUSED') return 'STOPPED';
  if (source.runtime === 'ERROR') return 'ERROR';

  if (source.reEvaluating) return 'RE_EVALUATING';

  /*
   * Checked after the lifecycle states and before anything derived from the
   * thesis or the plan, because a pending request outranks all of them: a GOAT
   * holding a valid thesis that is mid-request is waiting on the model, not
   * monitoring, researching or building anything.
   */
  if (source.modelPending) return 'WAITING_FOR_MODEL';

  const plan = source.tradePlan;
  if (plan) {
    switch (plan.status) {
      case 'READY':
        return 'READY';
      case 'EXECUTING':
        return 'EXECUTING';
      case 'MANAGING':
        return 'MANAGING';
      case 'RISK_CHECK':
        return 'RISK_CHECK';
      case 'BUILDING' as TradeIdea['status']:
        return 'BUILDING_TRADE_PLAN';
      case 'CLOSED':
        return 'WAITING';
      case 'INVALIDATED':
        return liveThesis ? 'COLLECTING_EVIDENCE' : 'RESEARCHING';
      default:
        break;
    }
  }

  if (!liveThesis) {
    // Deployed, no hypothesis yet: either it has not started, or the model
    // has not produced one.
    return source.now - source.goal.updatedAt > 0 && activeTrackerCount === 0
      ? 'RESEARCHING'
      : 'RESEARCHING';
  }

  if (liveThesis.state === 'DRAFT') return 'FORMING_THESIS';
  if (activeTrackerCount === 0) {
    return liveThesis.state === 'INVESTIGATING' ? 'FORMING_THESIS' : 'COLLECTING_EVIDENCE';
  }
  if (liveThesis.state === 'WEAKENING' || liveThesis.state === 'INVALIDATED') {
    return 'COLLECTING_EVIDENCE';
  }
  if (
    source.now - liveThesis.updatedAt < JUST_WOKE_MS &&
    source.events.some((event) => source.now - event.timestamp < JUST_WOKE_MS)
  ) {
    return 'RE_EVALUATING';
  }

  return 'MONITORING';
}

function deriveActivity(input: {
  input: MissionInput;
  liveThesis?: Thesis;
  activeTrackers: TrackerSummary[];
  stage: MissionStage;
}): MissionActivity {
  const { input: source, liveThesis, activeTrackers, stage } = input;
  const market = source.deployment?.marketId ?? 'this market';
  const watching = activeTrackers.map((tracker) => tracker.purpose);

  const headline = (() => {
    switch (stage) {
      case 'UNDEPLOYED':
        return 'Saved, not deployed. Choose a market when you are ready.';
      case 'STOPPED':
        return 'Stopped. Nothing is being watched.';
      case 'ERROR':
        return 'The runtime is not running this GOAT. Check the deployment.';
      case 'RESEARCHING':
        return `Reading ${market} before forming a view.`;
      case 'WAITING_FOR_MODEL':
        /*
         * The blocked-on-external-dependency state, named as what it is doing.
         * "Reading the market" while a request is outstanding would be false —
         * the reads are finished — and "thinking" would be a claim about a
         * private process nobody can verify.
         */
        return source.modelPending?.intent ?? 'Working on its Trade Plan';
      case 'FORMING_THESIS':
        return liveThesis
          ? `Building its Trade Plan on ${market}.`
          : `Working out what it believes about ${market}.`;
      case 'COLLECTING_EVIDENCE':
        return liveThesis
          ? `Waiting for its Trade Plan to be confirmed: ${liveThesis.statement}`
          : `Gathering evidence on ${market}.`;
      case 'MONITORING':
        return liveThesis
          ? `Monitoring ${market} against its Trade Plan: ${liveThesis.statement}`
          : `Monitoring ${market}.`;
      case 'RE_EVALUATING':
        return 'A tracker fired. Re-reading the thesis against it.';
      case 'BUILDING_TRADE_PLAN':
        return 'Building a trade plan.';
      case 'RISK_CHECK':
        return 'Risk-checking a proposed plan.';
      case 'READY':
        return source.deployment?.execution.canExecute
          ? 'A plan passed risk validation.'
          : 'A plan passed risk validation. SHADOW means nothing is sent.';
      case 'EXECUTING':
        return 'Working an order.';
      case 'MANAGING':
        return 'Managing an open position from this plan.';
      case 'WAITING':
        return 'Waiting. Nothing has changed enough to act on.';
      default:
        return 'Working.';
    }
  })();

  const detail = (() => {
    if (stage === 'MONITORING' && liveThesis?.invalidation) {
      return `Wrong if: ${liveThesis.invalidation}`;
    }
    if (stage === 'WAITING') {
      const rejections = (source.tradePlan?.riskCheck?.reason ?? '').trim();
      return rejections;
    }
    if (stage === 'RESEARCHING' && activeTrackers.length === 0) {
      return 'No Trade Plan yet.';
    }
    if (stage === 'WAITING_FOR_MODEL') {
      return 'Market context prepared and submitted. Waiting on the answer, not on the market.';
    }
    return '';
  })();

  return { headline, detail, watching };
}

/**
 * The work plan, projected from state.
 *
 * Order matters and is fixed: it is the order the product takes, so a user
 * reading it learns how a GOAT works. A step is `done` only when a record
 * proves it, `active` only when it is the stage the GOAT is in now.
 */
function buildWorkPlan(input: {
  goal: Goal;
  stage: MissionStage;
  thesis?: Thesis;
  activeTrackerCount: number;
  evidence: Evidence[];
  tradePlan?: TradeIdea;
  runtime: RuntimeStatus;
  /** True once the GOAT has read the market on its own market. */
  inspected: boolean;
}): WorkStep[] {
  const { goal, stage, thesis, activeTrackerCount, evidence, tradePlan, inspected } = input;
  /*
   * "Inspected the market" is done when the GOAT holds a hypothesis, which
   * it can only hold after reading the market — or when it has acted since.
   *
   * Deliberately *not* keyed off MARKET_DATA evidence: evidence with that
   * source is not written, because a market snapshot is context rather than
   * support, and recording it as SUPPORTS would satisfy the
   * REQUIRE_EVIDENCE_BEFORE_ACTIONABLE gate that keeps a GOAT from becoming
   * tradable off its own reading of the price.
   */
  const hasMarketEvidence = inspected || thesis !== undefined || evidence.length > 0;

  const steps: Array<WorkStep & { order: MissionStage[] }> = [
    {
      id: 'understand',
      label: 'Understand your objective',
      detail: goal.interpretation,
      status: goal.interpretation ? 'done' : 'pending',
      order: ['UNDERSTANDING'],
    },
    {
      id: 'inspect',
      label: 'Inspect the current market',
      detail: hasMarketEvidence ? 'Market read on this market.' : undefined,
      status: hasMarketEvidence ? 'done' : 'pending',
      order: ['RESEARCHING', 'ANALYZING'],
    },
    {
      id: 'thesis',
      label: 'Form a thesis',
      detail: thesis?.statement,
      status: thesis ? 'done' : 'pending',
      order: ['FORMING_THESIS'],
    },
    {
      id: 'evidence',
      label: 'Define what evidence it needs',
      detail: activeTrackerCount > 0 ? `${activeTrackerCount} condition${activeTrackerCount === 1 ? '' : 's'} being watched` : undefined,
      status: activeTrackerCount > 0 ? 'done' : 'pending',
      order: ['COLLECTING_EVIDENCE'],
    },
    {
      id: 'monitor',
      label: 'Monitor for confirmation',
      status: 'pending',
      order: ['MONITORING', 'RE_EVALUATING'],
    },
    {
      id: 'plan',
      label: 'Build trade plan',
      detail: tradePlan ? `${tradePlan.direction} ${tradePlan.symbol} @ ${tradePlan.entry}` : undefined,
      status: tradePlan ? 'done' : 'pending',
      order: ['BUILDING_TRADE_PLAN'],
    },
    {
      id: 'risk',
      label: 'Risk-check trade plan',
      detail: tradePlan?.riskCheck?.reason,
      status:
        tradePlan?.riskCheck === undefined
          ? 'pending'
          : tradePlan.riskCheck.approved
            ? 'done'
            : 'pending',
      order: ['RISK_CHECK', 'READY'],
    },
    {
      id: 'execute',
      label: 'Execute when permitted',
      detail: stage === 'READY' ? 'The deployment decides whether this is acted on.' : undefined,
      status: stage === 'EXECUTING' || stage === 'MANAGING' ? 'done' : 'pending',
      order: ['EXECUTING', 'MANAGING'],
    },
  ];

  /*
   * A GOAT that is not running has no step in progress. That is the honest
   * reading, and it is also the useful one: showing "inspect the market" as
   * active on a GOAT that has never been pointed at a market would be an
   * animation pretending to be progress.
   */
  if (stage === 'UNDEPLOYED' || stage === 'STOPPED' || stage === 'ERROR') {
    return steps.map(({ order: _order, ...step }) => step);
  }

  /*
   * Otherwise exactly one step is active, and it is the one the stage
   * names. If the stage is in no step's order list the GOAT is in a state
   * the plan does not describe, and the most useful thing to show is the
   * step after the last completed one rather than an arbitrary one.
   */
  const activeIndex = steps.findIndex((step) => step.order.includes(stage));
  if (activeIndex >= 0) {
    steps[activeIndex] = { ...steps[activeIndex], status: 'active' };
  } else {
    const lastDone = steps.reduce((index, step, current) => (step.status === 'done' ? current : index), -1);
    if (lastDone >= 0 && lastDone < steps.length - 1) {
      steps[lastDone + 1] = { ...steps[lastDone + 1], status: 'active' };
    }
  }

  return steps.map(({ order: _order, ...step }) => step);
}

/**
 * Has this GOAT looked at its market?
 *
 * A thesis can only exist because an investigation read the market first,
 * and a tracker can only be deployed as part of one, so either is proof.
 * A market snapshot is not stored as evidence, because evidence is what
 * makes a thesis actionable and a price is not that.
 */
function hasInspectedMarket(input: MissionInput): boolean {
  return (
    input.theses.length > 0 ||
    input.trackers.length > 0 ||
    input.tradePlan !== undefined
  );
}

function toTrackerSummary(tracker: Tracker): TrackerSummary {
  return {
    id: tracker.id,
    purpose: tracker.purpose,
    kind: tracker.kind,
    status: tracker.lifecycle.status,
    eventCount: tracker.lifecycle.eventCount,
    lastEvaluatedAt: tracker.lifecycle.lastEvaluatedAt,
    expiresAt: tracker.lifecycle.expiresAt,
  };
}

function isTerminal(thesis: Thesis): boolean {
  return thesis.state === 'INVALIDATED' || thesis.state === 'ABANDONED' || thesis.state === 'COMPLETED';
}

/** A name a user did not give, derived from their own words. */
function defaultName(goal: Goal): string {
  const words = goal.statement
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  if (words.length === 0) return 'GOAT';
  return `${words.join(' ')} GOAT`;
}

function label(status: TradeIdea['status']): string {
  return status.replace(/_/g, ' ');
}
