/**
 * The living trade plan.
 *
 * A plan is the second thing a person looks at, and the first thing they ask
 * a question of: *what does it think, what is it waiting to prove, and what
 * would change its mind?* Until now those three answers lived in three
 * separate places — the thesis, the trackers, the risk check — and the only
 * unified artefact, the `TradeIdea`, does not exist until the thesis is
 * already ACTIONABLE and the model has committed to prices.
 *
 * So this is a **projection**, not a new artifact.
 *
 * It reads the records the runtime already wrote and presents them as one
 * plan. It creates nothing, persists nothing, and grants nothing. In
 * particular:
 *
 *   - It never produces a `TradeIdea`. A plan exists here from the moment
 *     there is a hypothesis, which is *earlier* than an executable plan and
 *     therefore strictly less powerful.
 *   - It never reports progress toward execution that the runtime has not
 *     made. Validation counts come from recorded evidence; the conditional
 *     execution block is labelled as intent, not as permission.
 *   - `mayExecute` is carried through from the deployment untouched, and the
 *     plan says "no order will be placed" when the deployment says so.
 *
 * The distinction the product needs — "what the GOAT is trying to prove"
 * versus "what it is doing right now" — is the distinction between this file
 * and the agent log. Neither duplicates the other.
 */

import type { Evidence, Thesis } from './types';
import type { GoatMission, TrackerSummary } from './mission';

/** One thing the thesis says it needs to see, and whether it has. */
export interface PlanCriterion {
  /** The requirement, in the thesis's own words. */
  label: string;
  state: 'confirmed' | 'contradicted' | 'pending';
  /** The evidence that settled it, when something did. */
  evidenceId?: string;
}

export type PlanStatus =
  | 'BUILDING'
  | 'RESEARCHING'
  | 'VALIDATING'
  | 'WAITING'
  | 'READY'
  | 'EXECUTED'
  | 'INVALIDATED'
  | 'REPLACED'
  | 'NONE';

export interface PlanView {
  /**
   * Whether there is a plan to read.
   *
   * True from the moment a hypothesis exists, which is deliberately earlier
   * than an executable plan: what the GOAT believes, what it needs and what it
   * would do are one object, and a panel that says "no plan yet" while the agent
   * is holding a view hides the only thing the user came to read.
   */
  exists: boolean;
  market?: string;
  /** The direction the plan leans, in one phrase. */
  direction?: string;
  /** What the GOAT believes could happen. */
  idea?: string;
  status: PlanStatus;
  statusLabel: string;
  /**
   * What the plan still needs before it can act, when there is a plan.
   *
   * A plan with no requirement met is not "nearly there" — it is waiting for
   * something specific, and naming it is what turns a status word into an
   * answer.
   */
  awaiting?: string[];

  /**
   * The plan in one sentence, written as a conditional objective.
   *
   * This is the sentence the whole panel explains, so it has to be readable
   * on its own: what the market may be doing, the conditions that would make
   * it worth acting on, and what it would do if they held. It is assembled
   * from the recorded thesis, requirements and invalidation — never from the
   * model's prose, because a wall of generated text is not a plan a person
   * can check.
   *
   * Deliberately not permission. "THEN BUY" states intent; whether the
   * deployment may act is a separate fact carried by `mayExecute`.
   */
  objective?: string;

  /** What it must be true for the thesis to hold. */
  research: PlanCriterion[];
  /** Confirmed criteria, and how many there are in total. */
  validation: { confirmed: number; total: number; contradicted: number };

  /** The condition under which the thesis is wrong. */
  invalidation?: string;

  /**
   * What it would do if confirmed.
   *
   * `intent` is deliberately not `instruction`: nothing here authorises
   * anything. Whether an order is ever placed is decided by the deployment
   * and the risk layer, and the view says so in as many words.
   */
  conditional?: {
    action: string;
    entry?: string;
    invalidation?: string;
    target?: string;
  };

  /** Whether this deployment could act on a plan at all. */
  mayExecute: boolean;
  /** Why it cannot, when it cannot. One line, from the deployment. */
  executionNote?: string;

  /** What it is watching to move forward. */
  watching: TrackerSummary[];
  /** How many pieces of evidence are recorded against the thesis. */
  evidenceCount: number;
  /** Skill requirements the goal has not met, stated rather than implied. */
  outstandingConstraints: string[];
}

/**
 * Match a thesis requirement to the evidence recorded against it.
 *
 * Word overlap, deliberately crude and deliberately conservative: a
 * requirement is only shown as confirmed when some recorded evidence shares
 * enough vocabulary with it to be plausibly about the same thing. Matching
 * too eagerly would render a checklist that ticks itself off, which is the
 * single most dishonest thing this panel could do — it would show the user
 * progress the agent never made.
 *
 * So: below the threshold, a requirement stays pending. Pending is always
 * safe; a false tick is not.
 */
const MATCH_THRESHOLD = 2;

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );
}

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'them',
  'then', 'than', 'when', 'what', 'which', 'while', 'will', 'would', 'could',
  'should', 'about', 'into', 'over', 'under', 'price', 'level', 'condition',
]);

function criteriaFor(thesis: Thesis | undefined, evidence: Evidence[]): PlanCriterion[] {
  const requirements = thesis?.requiredConfirmation ?? [];
  if (requirements.length === 0) return [];

  const evidenceTokens = evidence.map((item) => ({
    item,
    tokens: tokens(`${item.summary} ${Object.keys(item.observed ?? {}).join(' ')}`),
  }));

  return requirements.map((requirement) => {
    const wanted = tokens(requirement);
    let best: { item: Evidence; score: number } | undefined;

    for (const candidate of evidenceTokens) {
      let score = 0;
      for (const word of wanted) if (candidate.tokens.has(word)) score += 1;
      if (score > (best?.score ?? 0)) best = { item: candidate.item, score };
    }

    // No evidence shares enough vocabulary to be about this requirement.
    if (!best || wanted.size === 0 || best.score < Math.min(MATCH_THRESHOLD, wanted.size)) {
      return { label: requirement, state: 'pending' as const };
    }
    return {
      label: requirement,
      state: best.item.polarity === 'CONTRADICTS' ? ('contradicted' as const) : ('confirmed' as const),
      evidenceId: best.item.id,
    };
  });
}

function statusFor(mission: GoatMission): PlanStatus {
  const plan = mission.tradePlan;
  if (plan) {
    switch (plan.status) {
      case 'READY': return 'READY';
      case 'EXECUTING':
      case 'MANAGING': return 'EXECUTED';
      case 'INVALIDATED': return 'INVALIDATED';
      case 'CLOSED': return 'EXECUTED';
      case 'WAITING': return 'WAITING';
      default: break;
    }
  }
  /*
   * A dead thesis with no replacement yet is not "no plan" — the plan existed
   * and was disproven, which is a materially different thing for someone
   * reading this panel. The GOAT forming the next hypothesis moves it to
   * REPLACED, so the history stays visible without implying the old plan is
   * still live.
   */
  if (mission.thesis && isInvalidated(mission.thesis)) {
    return mission.thesisCount > 1 ? 'REPLACED' : 'INVALIDATED';
  }
  if (plan) return 'VALIDATING';
  if (mission.thesis) return 'RESEARCHING';
  return mission.deployment ? 'BUILDING' : 'NONE';
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  BUILDING: 'Forming',
  RESEARCHING: 'Researching',
  VALIDATING: 'Validating',
  WAITING: 'Waiting',
  READY: 'Ready',
  EXECUTED: 'Executed',
  INVALIDATED: 'Invalidated',
  REPLACED: 'Replaced',
  NONE: 'No plan yet',
};

/**
 * The plan as one sentence.
 *
 * Assembled from what the runtime recorded rather than generated, so it can
 * never say something the evidence does not support. The shape is
 * deliberately fixed — market, belief, conditions, consequence — because a
 * plan that reshapes itself every time it is rendered cannot be scanned.
 */
export function conditionalObjective(input: {
  market?: string;
  direction?: string;
  idea?: string;
  criteria: PlanCriterion[];
  /** What it would do if the conditions held, when that is defined yet. */
  action?: string;
}): string | undefined {
  const { market, direction, idea, criteria, action } = input;
  if (!idea) return undefined;

  const subject = market ? market : 'The market';
  const belief = idea.trim().replace(/\.$/, '');
  const conditions = criteria
    .map((criterion) => criterion.label.trim().replace(/\.$/, ''))
    .filter((label) => label.length > 0);
  const consequence = action ?? 'act on it';

  if (conditions.length === 0) {
    return `${subject} ${belief}. It is gathering evidence before it decides what to do.`;
  }

  /*
   * Long condition lists are read, not scanned, so the sentence is capped and
   * says plainly that there are more. A twelve-clause sentence is not a plan.
   */
  const shown = conditions.slice(0, 3);
  const remaining = conditions.length - shown.length;
  const conditionText = shown
    .map((label, index) => (index === 0 ? `if ${lower(label)}` : `${lower(label)}`))
    .join(remaining > 0 ? ', and ' : ', and ');

  return (
    `${subject} ${belief}. ` +
    `${conditionText}${remaining > 0 ? `, and ${remaining} further condition${remaining === 1 ? '' : 's'}` : ''}, ` +
    `then ${lower(consequence)}.`
  );
}

function lower(value: string): string {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}

/**
 * The consequence a direction implies, in the reader's own terms.
 *
 * "buy" and "sell" rather than "LONG"/"SHORT" because this sentence is prose,
 * and a NEUTRAL direction gets no verb at all — a GOAT that has not taken a side
 * has not promised anything, and a plan that implied otherwise would be
 * promising on its behalf.
 */
function directionAction(direction: Thesis['direction']): string | undefined {
  if (direction === 'BULLISH') return 'buy';
  if (direction === 'BEARISH') return 'sell';
  return undefined;
}

function isInvalidated(thesis: Thesis): boolean {
  return thesis.state === 'INVALIDATED' || thesis.state === 'ABANDONED' || thesis.state === 'COMPLETED';
}

/**
 * Build the plan view. Pure: same mission, same plan.
 *
 * Takes the whole mission rather than picking its own inputs so that
 * everything it shows is provably something the runtime already decided.
 */
export function buildPlanView(mission: GoatMission): PlanView {
  const thesis = mission.thesis;
  const evidence = mission.evidence;
  const research = criteriaFor(thesis, evidence);
  const confirmed = research.filter((item) => item.state === 'confirmed').length;
  const contradicted = research.filter((item) => item.state === 'contradicted').length;
  const status = statusFor(mission);

  const conditional = (() => {
    const plan = mission.tradePlan;
    if (!plan) return undefined;
    const target = plan.takeProfits[0];
    return {
      action: `${plan.direction} ${plan.orderType.toLowerCase()}`,
      ...(plan.entry !== undefined ? { entry: formatPrice(plan.entry) } : {}),
      ...(plan.invalidationLevel !== undefined
        ? { invalidation: formatPrice(plan.invalidationLevel) }
        : {}),
      ...(target ? { target: formatPrice(target.price) } : {}),
    };
  })();

  /*
   * What the plan says it will do, available before it is executable.
   *
   * The consequence is part of a plan from the moment the plan exists, and
   * leaving it out until the risk layer has approved something meant the
   * sentence ended in "then act on it" — which tells a reader nothing about the
   * one decision they came for. A recorded direction is enough to state the
   * consequence honestly, and NEUTRAL is stated as the absence of one rather
   * than dressed up as a side.
   */
  const action = mission.tradePlan
    ? `${mission.tradePlan.direction} ${mission.tradePlan.orderType.toLowerCase()}`
    : directionAction(thesis?.direction);
  const objective = conditionalObjective({
    market: mission.market,
    ...(thesis?.direction ? { direction: thesis.direction.toLowerCase() } : {}),
    ...(thesis ? { idea: thesis.statement } : {}),
    criteria: research,
    ...(action ? { action } : {}),
  });

  const awaiting = research.filter((item) => item.state === 'pending').map((item) => item.label);

  return {
    exists: thesis !== undefined || mission.tradePlan !== undefined,
    ...(objective ? { objective } : {}),
    ...(awaiting.length > 0 ? { awaiting: awaiting.slice(0, 3) } : {}),
    market: mission.market,
    ...(thesis?.direction ? { direction: thesis.direction.toLowerCase() } : {}),
    ...(thesis ? { idea: thesis.statement } : {}),
    status,
    statusLabel: STATUS_LABELS[status],
    research,
    validation: { confirmed, total: research.length, contradicted },
    ...(thesis?.invalidation ? { invalidation: thesis.invalidation } : {}),
    ...(conditional ? { conditional } : {}),
    mayExecute: mission.mayExecute,
    ...(mission.deployment && !mission.mayExecute
      ? { executionNote: `${mission.deployment.mode} mode — no order will be placed` }
      : {}),
    watching: mission.trackers.filter((tracker) => tracker.status === 'ACTIVE'),
    evidenceCount: evidence.length,
    outstandingConstraints: [...mission.outstandingConstraints],
  };
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) < 1 ? 5 : 2;
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}