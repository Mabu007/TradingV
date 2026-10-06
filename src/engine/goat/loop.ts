/**
 * The GOAT loop.
 *
 *   Goal
 *     -> Investigation
 *     -> Thesis
 *     -> Observation plan (trackers)
 *     -> Dormancy
 *     -> Tracker event
 *     -> Wake
 *     -> Re-evaluation
 *     -> Thesis update + tracker update
 *     -> Dormancy
 *
 * The single most important property here is the dormancy. The agent
 * does not poll. It reasons once, deploys trackers, and stops. The
 * runtime holds it dormant until a tracker fires, and the only thing
 * that wakes it is evidence it asked for.
 *
 * That is enforced structurally, not by convention: `investigate()` is
 * the only entry point that does unbounded work, it is called once per
 * goal, and everything after it is a reaction to a wake request. There
 * is no loop anywhere in this file.
 */

import {
  AgentPlan,
  AgentPlanStep,
  Evidence,
  Thesis,
  ThesisState,
  TrackerEvent,
  TrackerKind,
  TrackerRequest,
  TradeIdeaRequest,
  WakeRequest,
} from './types';
import { canTransitionThesis } from './types';
import {
  applyConfidence,
  clampConfidence,
  detectConflicts,
  hysteresisVerdict,
  provenanceKey,
  readSufficiency,
  weighEvidence,
  type EvidenceWeight,
  type SufficiencyReadout,
} from './reasoning';
import {
  EvidenceStore,
  GoalStore,
  ThesisStore,
  TradeIdeaStore,
} from './store';
import { TrackerRuntime, TrackerRuntimeError } from '../agents/trackers/runtime';
import { TrackerSdk } from './trackerSdk';
import { GoatSkillRegistry, SkillConstraint, SkillPhase } from './skills';

export interface GoatLoopDeps {
  goals: GoalStore;
  theses: ThesisStore;
  evidence: EvidenceStore;
  ideas: TradeIdeaStore;
  trackers: TrackerRuntime;
  skills: GoatSkillRegistry;
  sdkFor(agentId: string): TrackerSdk;
  clock?: () => number;
  /** The mode the environment runs in, for the context's own record. */
  env?: { mode?: string };
  /**
   * The deployment a GOAT is currently running, if any.
   *
   * The loop does not own deployments — the orchestrator does — but it
   * builds the context a wake reasons against, and a context without the
   * deployed market is the defect this dependency exists to close. Absent
   * only in a harness that has not deployed anything.
   */
  currentDeployment?(agentId: string): DeploymentContext | undefined;
  /**
   * The last market reading this GOAT made, if there is one.
   *
   * Present only as a *record of something already read*. It exists so a resumed
   * observation plan can ask whether the questions it was asking are still the
   * right ones, and it is deliberately the last reading rather than a fresh one:
   * recalibration that triggered a market fetch would be an unscheduled market read
   * in a system whose whole premise is that a GOAT reads when it is woken, and in a
   * backtest it would be a read of a moment the simulation had not reached.
   *
   * Absent means the GOAT has not read anything this session, and the answer is
   * then "leave the plan alone" rather than a guess.
   */
  lastMarketReading?(agentId: string): MarketReading | undefined;
}

/**
 * A market reading a GOAT already made, kept for the question "is this plan stale".
 */
export interface MarketReading {
  symbol: string;
  price: number;
  timeframe?: string;
  at: number;
}

export interface AgentContext {
  agentId: string;
  goalId: string;
  skillIds: string[];
  /**
   * The deployment this wake belongs to.
   *
   * Present on every wake of a deployed GOAT, and the reason is a bug this
   * file used to have: the context carried a thesis, evidence and trackers
   * but not the market, the venue, or the deployment's own id, so a wake
   * could reason — and refuse to reason — as though nothing had been
   * deployed. `market` is the deployment's market verbatim; there is no
   * path by which a running deployment yields an empty one.
   */
  deployment: DeploymentContext;
  /** The user's objective, in their own words. */
  goal: string;
  /** Live thesis the agent is currently working. */
  thesis: Thesis;
  /** What is being watched for this thesis. */
  watching: Array<{
    id: string;
    purpose: string;
    status: string;
    eventCount: number;
    expiresAt?: number;
    lastEvaluatedAt?: number;
  }>;
  /** Everything gathered for or against the thesis. */
  evidence: Evidence[];
  /** Recent events for this thesis. */
  recentEvents: TrackerEvent[];
  /** The event that caused this wake, when there was one. */
  wakeEvent?: TrackerEvent;
  constraints: string[];
  /** The environment this is running in. Identical in backtest and live. */
  environment: string;
  /**
   * Whether there is enough here to decide anything, in the runtime's own terms.
   *
   * Computed from counts and weights, never from elapsed time: a GOAT that is still
   * waiting is doing exactly the right thing, and a budget that punished waiting
   * would turn patience into a failure. The model may disagree with the word, but
   * the gates that act on it are not the model's to overrule.
   */
  sufficiency: SufficiencyReadout;
}

/**
 * What a deployment is: the identity and the two permissions.
 *
 * Research and execution are separate fields on purpose, and always were
 * in intent — `canExecute` only ever gated order submission. Naming them
 * separately here is what stops "trading is disabled" being read as "you
 * may not look at this market".
 */
export interface DeploymentContext {
  deploymentId: string;
  goatId: string;
  /** The market this GOAT was pointed at. Never empty while deployed. */
  market: string;
  mode: 'SHADOW' | 'DEMO' | 'LIVE' | 'PAPER';
  /** Venue environment: MAINNET or TESTNET. */
  venueEnvironment?: string;
  /** May the GOAT read the market, reason, track, and write a plan? */
  research: {
    allowed: boolean;
    market: string;
    timeframes: string[];
  };
  /** May the GOAT submit an order? */
  execution: {
    canProposeTrades: boolean;
    canExecute: boolean;
    allowedOrderTypes: string[];
  };
  /** Wall clock at the moment the context was built. */
  clock: number;
}

export interface WakeOutcome {
  thesisId: string;
  /** The plan the agent settled on. */
  plan: AgentPlan;
  /** The thesis after the wake was applied. */
  thesis: Thesis;
  /** Trackers created, modified or cancelled as a result. */
  trackerChanges: Array<{ action: 'created' | 'updated' | 'cancelled'; trackerId: string }>;
  /** Evidence recorded during this wake. */
  evidenceRecorded: string[];
  /** The trade idea produced, when one was. */
  tradeIdeaId?: string;
  /** Rejections, so a refused action is visible rather than silent. */
  rejections: string[];
}

/** What the agent decided while investigating, before any tracker exists. */
export interface InvestigationRequest {
  agentId: string;
  goalId: string;
  thesis: {
    statement: string;
    direction?: Thesis['direction'];
    /** What would prove the hypothesis wrong. Required, not optional. */
    invalidation: string;
    requiredConfirmation?: string[];
  };
  /** The observation plan: what the agent needs to see, and why. */
  trackers: TrackerRequest[];
  /** Absolute time at which this line of enquiry stops being worth budget. */
  validUntil?: number;
  /**
   * The thesis this investigation is the opposing reading of.
   *
   * Present only where the goal's skills allow a second live hypothesis, and
   * refused by `createThesis` otherwise — the ceiling is not relaxed for this, it
   * is the same ceiling.
   */
  competesWith?: string;
  /**
   * Attach to the live thesis instead of refusing.
   *
   * For the case where the hypothesis survived and its observation plan
   * did not — a page closed mid-deploy, or trackers are not persisted. A
   * second thesis would be wrong, because there is only one claim being
   * made; what is missing is what to watch.
   */
  attachToLive?: boolean;
}

export interface InvestigationOutcome {
  /** Set when a thesis was created by this pass. */
  thesisId?: string;
  thesis?: Thesis;
  trackerIds: string[];
  /** Refusals, so a rejected tracker is visible rather than silent. */
  rejections: string[];
  /**
   * False when the GOAT already had a live thesis.
   *
   * A second concurrent thesis is not a richer picture of the same goal; it
   * is two agents reasoning about one market with half the tracker budget
   * each, and the ceiling exists for that reason.
   */
  created: boolean;
}

/**
 * How many times a thesis may be re-proposed after the risk layer refused it.
 *
 * Three, and the number is the point rather than the value. One refusal means the
 * construction was wrong. Two means the GOAT is learning. Three means it is not
 * going to solve this by trying again, and continuing would be a loop the GOAT
 * cannot leave: propose, be refused, propose the same thing, be refused. After the
 * bound the loop refuses another proposal and says so, which is the only honest
 * outcome available to a reasoning system that cannot move the gate it is being
 * held at.
 *
 * Overridable per goal by a skill constraint, because a strategy that expects to
 * be re-priced around a moving account is a real thing.
 */
export const MAX_RISK_REVISIONS = 3;

/**
 * The most steps one composite plan may contain.
 *
 * A bound on transaction size, not a budget for ambition. Four is enough for
 * "record this, weaken that, drop that watch, ask a better question", which is the
 * shape of a real wake; anything longer is a model trying to do a morning's work in
 * one turn, and a pass that fails half way through it is worse than a pass that did
 * one thing.
 */
export const MAX_COMPOSITE_STEPS = 4;

/**
 * Runs the loop for one agent at a time.
 *
 * Multi-thesis is a property of the store, not of this class: an agent
 * owns a goal, the goal owns theses, and each thesis owns its trackers.
 * Nothing here assumes one thesis per agent, and the wake handler
 * resolves the thesis from the event rather than from a single field.
 */
export class GoatLoop {
  private readonly inflight = new Set<string>();
  /** Refusals from the most recent plan restore, for the caller to report. */
  private readonly lastRestoreRefusals: string[] = [];

  constructor(private readonly deps: GoatLoopDeps) {}

  private now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  /**
   * Assemble everything the agent needs to reason about a thesis.
   *
   * This is the "GOAT Agent" box from the architecture: goal, skills,
   * tools, current thesis, evidence, trackers, history. Assembled in
   * one place so a wake cannot accidentally reason against a partial
   * picture — and the deployment is part of that picture, because a GOAT
   * that knows its thesis but not its market is reasoning about nothing.
   */
  buildContext(agentId: string, thesisId: string, wakeEvent?: TrackerEvent): AgentContext | undefined {
    const thesis = this.deps.theses.get(thesisId);
    if (!thesis) return undefined;
    /*
     * Ownership, asserted rather than assumed.
     *
     * Both arguments are supplied by the caller — `runWake` is public, and
     * a crafted wake pairing one agent's id with another agent's thesis id
     * would otherwise assemble a perfectly valid context holding GOAT B's
     * goal, evidence and trackers under GOAT A's identity, and then apply
     * a plan to GOAT B's thesis. Refusing here is cheaper than discovering
     * it later.
     */
    if (thesis.agentId !== agentId) return undefined;
    const goal = this.deps.goals.get(thesis.goalId);
    if (!goal) return undefined;
    if (goal.agentId !== agentId) return undefined;

    const deployment = this.deps.currentDeployment?.(agentId);
    if (!deployment) {
      /*
       * Refused rather than defaulted. Returning a context with an empty
       * market here is exactly what produced "no deployed symbol, so no
       * market can be investigated" on a GOAT that was demonstrably
       * deployed and reading EUR/USD. A caller that has no deployment has
       * no business waking this loop.
       */
      return undefined;
    }

    const watching = this.deps.trackers.listForThesis(thesisId).map((tracker) => ({
      id: tracker.id,
      purpose: tracker.purpose,
      status: tracker.lifecycle.status,
      eventCount: tracker.lifecycle.eventCount,
      expiresAt: tracker.lifecycle.expiresAt,
      lastEvaluatedAt: tracker.lifecycle.lastEvaluatedAt,
    }));

    const recentEvents = this.deps.trackers
      .listEventsForThesis(thesisId)
      .slice(-10);

    /*
     * Evidence, bounded and ordered by what it does to belief.
     *
     * A thesis that has been awake for a week can hold hundreds of items, and
     * sending all of them would crowd out the market context — which is the part
     * that decides anything. The strongest opposing evidence comes first even
     * though it is oldest, because the case against is what a GOAT is most likely
     * to have stopped looking at.
     */
    const evidence = this.boundedEvidence(thesisId);

    return {
      agentId,
      goalId: goal.id,
      skillIds: goal.skillIds,
      deployment,
      goal: goal.statement,
      thesis,
      watching,
      evidence,
      recentEvents,
      wakeEvent,
      constraints: this.deps.skills.describeConstraints(goal.skillIds),
      environment: this.deps.env?.mode ?? 'AGENTIC',
      sufficiency: readSufficiency({
        thesis,
        evidence: this.deps.evidence.listForThesis(thesisId),
        ...(this.thesisTimeframe(thesis) ? { thesisTimeframe: this.thesisTimeframe(thesis) } : {}),
        now: this.now(),
      }),
    };
  }

  /**
   * The evidence worth showing a model, and nothing else.
   *
   * A count, not a trim: the newest items, the heaviest on each side, and the
   * strongest contradiction always survive, because those are the three ways a
   * piece of evidence changes what someone should do next. Everything in between is
   * still on the timeline and in the store.
   */
  private boundedEvidence(thesisId: string, limit = 16): Evidence[] {
    const all = this.deps.evidence.listForThesis(thesisId);
    if (all.length <= limit) return all;

    const chosen = new Map<string, Evidence>();
    const take = (items: Evidence[]): void => {
      for (const item of items.slice(-limit)) chosen.set(item.id, item);
    };
    take(all);
    for (const side of ['SUPPORTS', 'CONTRADICTS'] as const) {
      take(
        all
          .filter((item) => item.polarity === side)
          .sort((left, right) => Math.abs(right.weight ?? 0) - Math.abs(left.weight ?? 0))
          .slice(0, 4),
      );
    }
    // Newest last, so the sequence a reader follows is still chronological.
    return [...chosen.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * Register a new thesis for a goal.
   *
   * The agent is expected to call this from its own reasoning, after
   * investigation. The loop's job is to make the write safe and the
   * history complete, not to decide the hypothesis.
   */
  createThesis(input: {
    goalId: string;
    agentId: string;
    statement: string;
    direction?: Thesis['direction'];
    requiredConfirmation?: string[];
    invalidation: string;
    confidence?: number;
    /**
     * The thesis this one is the opposing reading of.
     *
     * A tournament, not a second agent: both sides belong to the same goal, each
     * keeps its own evidence and its own trackers, and the ceiling above still
     * bounds how many can exist. Refused unless the goal's skills permit more than
     * one live thesis, because the whole difference between a tournament and an
     * unbounded branching agent is that the ceiling applies to it too.
     */
    competesWith?: string;
  }): Thesis {
    const now = this.now();
    const maxTheses = this.thesisCeiling(input.goalId);
    const live = this.deps.theses.listLiveForGoal(input.goalId).length;
    if (live >= maxTheses) {
      throw new Error(
        `Goal ${input.goalId} already has ${live} live theses (limit ${maxTheses}). Abandon or complete one first.`,
      );
    }

    const competesWith = this.validCompetingThesis(input, maxTheses);

    const thesis: Thesis = {
      id: `ths_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      goalId: input.goalId,
      agentId: input.agentId,
      statement: input.statement,
      direction: input.direction,
      requiredConfirmation: input.requiredConfirmation ?? [],
      invalidation: input.invalidation,
      state: 'DRAFT',
      confidence: input.confidence,
      revision: 0,
      ...(competesWith ? { competesWith } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.deps.theses.save(thesis);

    /*
     * The relationship is stored on both sides.
     *
     * One-directional would leave the surviving half unable to find the hypothesis
     * it was competing with, so invalidating it could not close the pair — and the
     * loser would keep its trackers armed against a question that now has one
     * answer.
     */
    if (competesWith) {
      const counterpart = this.deps.theses.get(competesWith);
      if (counterpart && counterpart.agentId === input.agentId && !counterpart.competesWith) {
        this.deps.theses.save({ ...counterpart, competesWith: thesis.id });
      }
    }

    return thesis;
  }

  /**
   * Whether a proposed competing hypothesis is admissible.
   *
   * Four conditions, all of them about integrity rather than taste: the counterpart
   * exists and belongs to this goal, the ceiling permits two live theses, the two
   * disagree about direction (a tournament between two bullish readings is one
   * thesis written twice), and the counterpart is not already in a tournament with
   * somebody else. Anything else is refused with the reason, and a refusal simply
   * means the GOAT has one hypothesis rather than two.
   */
  private validCompetingThesis(
    input: { goalId: string; agentId: string; direction?: Thesis['direction']; competesWith?: string },
    maxTheses: number,
  ): string | undefined {
    const counterpartId = input.competesWith;
    if (!counterpartId) return undefined;

    if (maxTheses < 2) {
      throw new Error(
        'This goal may hold one live hypothesis at a time, so a competing hypothesis cannot be opened.',
      );
    }
    const counterpart = this.deps.theses.get(counterpartId);
    if (!counterpart || counterpart.goalId !== input.goalId || counterpart.agentId !== input.agentId) {
      throw new Error(
        `Thesis ${counterpartId} is not a hypothesis of goal ${input.goalId} owned by agent ${input.agentId}.`,
      );
    }
    if (isTerminalThesisState(counterpart.state)) {
      throw new Error(
        `Thesis ${counterpartId} is ${counterpart.state}, so it is not competing with anything.`,
      );
    }
    if (counterpart.competesWith && counterpart.competesWith !== counterpartId) {
      throw new Error(
        `Thesis ${counterpartId} is already in a tournament with ${counterpart.competesWith}.`,
      );
    }
    if (
      input.direction !== undefined &&
      counterpart.direction !== undefined &&
      input.direction === counterpart.direction
    ) {
      throw new Error(
        `Thesis ${counterpartId} already reads ${input.direction}; two ${input.direction} readings of one question are not competing hypotheses.`,
      );
    }
    return counterpartId;
  }

  /**
   * The first half of the loop: goal -> thesis -> observation plan.
   *
   * This is the pass that `applyPlan` cannot do, because a plan is applied
   * *to* a thesis and an investigation is what produces the first one. It
   * is deliberately the only unbounded-work entry point in this file: it
   * runs once per goal, it is refused while a live thesis already exists,
   * and everything after it is a reaction to a wake.
   *
   * The thesis and the trackers are written even when the market has said
   * nothing yet. A hypothesis formed from structure is a hypothesis; what
   * is missing is confirmation, and that is what the trackers are for.
   */
  investigate(request: InvestigationRequest): InvestigationOutcome {
    const outcome: InvestigationOutcome = { trackerIds: [], rejections: [], created: false };

    if (this.deps.goals.get(request.goalId)?.agentId !== request.agentId) {
      outcome.rejections.push(`Goal ${request.goalId} is not owned by agent ${request.agentId}.`);
      return outcome;
    }

    const live = this.deps.theses.listLiveForGoal(request.goalId);
    if (live.length > 0 && !request.attachToLive && !request.competesWith) {
      outcome.thesisId = live[0].id;
      outcome.thesis = live[0];
      outcome.rejections.push(
        `Goal ${request.goalId} already has a live thesis (${live[0].state}). It wakes on its own trackers.`,
      );
      return outcome;
    }

    // Rebuilding the observation plan for a thesis that already exists.
    if (live.length > 0 && request.attachToLive) {
      return this.deployObservationPlan(request.agentId, live[0], request, outcome);
    }

    let thesis: Thesis;
    try {
      thesis = this.createThesis({
        goalId: request.goalId,
        agentId: request.agentId,
        statement: request.thesis.statement,
        direction: request.thesis.direction,
        invalidation: request.thesis.invalidation,
        requiredConfirmation: request.thesis.requiredConfirmation,
        ...(request.competesWith ? { competesWith: request.competesWith } : {}),
      });
    } catch (error) {
      outcome.rejections.push(this.describeRejection(error));
      return outcome;
    }

    // A thesis with an observation plan is investigating, not merely drafted.
    outcome.thesis = this.reviseThesis(thesis.id, { state: 'INVESTIGATING' });
    outcome.thesisId = thesis.id;
    outcome.created = true;

    this.deployObservationPlan(request.agentId, thesis, request, outcome);

    /*
     * A hypothesis with an observation plan is live.
     *
     * `INVESTIGATING` is the state in which a thesis exists and nothing is
     * watching it yet — which is exactly the state a thesis with no
     * accepted tracker is left in below. A thesis that something will wake
     * it about has to be `ACTIVE`, because that is the state every wake
     * acts on, and a wake cannot strengthen a thesis that is still
     * investigating: the transition table does not allow it.
     */
    if (outcome.trackerIds.length > 0) {
      outcome.thesis = this.reviseThesis(thesis.id, { state: 'ACTIVE' });
    }

    return outcome;
  }

  /**
   * Deploy an observation plan against a thesis.
   *
   * Shared by the first investigation and by rebuilding a plan that was
   * lost, because "what should this agent watch" must not depend on
   * whether the hypothesis is new or old.
   */
  private deployObservationPlan(
    agentId: string,
    thesis: Thesis,
    request: InvestigationRequest,
    outcome: InvestigationOutcome,
  ): InvestigationOutcome {
    const sdk = this.deps.sdkFor(agentId);
    for (const spec of request.trackers) {
      try {
        const tracker = sdk.create(thesis.id, {
          ...spec,
          ...(request.validUntil !== undefined && spec.expiresAt === undefined
            ? { expiresAt: request.validUntil }
            : {}),
        });
        outcome.trackerIds.push(tracker.id);
      } catch (error) {
        // One bad tracker must not cost the good ones, and the reason is
        // kept so the UI can show what the runtime refused and why.
        outcome.rejections.push(`${spec.purpose || spec.kind}: ${this.describeRejection(error)}`);
      }
    }

    outcome.thesisId = thesis.id;
    outcome.thesis = this.deps.theses.get(thesis.id) ?? thesis;

    if (outcome.trackerIds.length === 0 && request.trackers.length > 0) {
      outcome.rejections.push(
        'No tracker was accepted, so this GOAT has nothing to wake it. It stays dormant until you add one.',
      );
    }

    return outcome;
  }

  /** Why the most recent restore refused a tracker, if it did. */
  restoreRefusals(): string[] {
    return [...this.lastRestoreRefusals];
  }

  /**
   * Put back an observation plan that was cancelled when a GOAT stopped.
   *
   * Resuming should not need the model's permission to remember what it was
   * already watching. Each tracker is recreated from the record — same
   * purpose, kind, config, timeframe and priority — with a new identity,
   * because a new watch is a new watch: the old record stays as the
   * history of a tracker that was stopped, and the new one starts empty
   * rather than inheriting an event count it did not earn.
   *
   * Returns the ids of what is now watching. An empty result means there
   * was nothing to restore, which is the caller's cue to ask the model.
   *
   * `only` is the set of trackers the last stop actually cancelled. It
   * matters more than it looks: without it, every resume restores every
   * cancelled tracker in the thesis's history, so the second stop/play
   * cycle restores the first cycle's cancelled copies as well and the
   * observation plan grows by a full set each time. A GOAT that had been
   * paused twice was watching twice as much as it had decided to watch.
   */
  restoreObservationPlan(agentId: string, goalId: string, only?: Iterable<string>): string[] {
    const thesis = this.deps.theses.listLiveForGoal(goalId)[0];
    if (!thesis) return [];
    this.lastRestoreRefusals.length = 0;

    const sdk = this.deps.sdkFor(agentId);
    const restored: string[] = [];

    /*
     * Guards against restoring the same intent twice, whatever the caller
     * passed. A tracker whose purpose, kind and timeframe already exist
     * more recently than this cancelled record has been restored already.
     */
    const alreadyRestored = new Set<string>();
    for (const existing of this.deps.trackers.listForThesis(thesis.id)) {
      if (existing.lifecycle.status === 'ACTIVE') alreadyRestored.add(intentKey(existing));
    }

    const permitted = only ? new Set(only) : undefined;

    /*
     * The market as this GOAT last read it.
     *
     * Read once, from a record — never fetched. A restore that fetched the market
     * would be an unscheduled read in a system that reads when it is woken, and in
     * a backtest it would be a read of an instant the simulation had not reached.
     * With nothing on the record the answer is "the plan is not known to be stale",
     * which is the safe direction: leaving a stale question in place costs one wake
     * on a condition that may never fire, and recalibrating a plan on invented
     * context would cost the question itself.
     */
    const reading = this.deps.lastMarketReading?.(agentId);

    for (const previous of this.deps.trackers.listForThesis(thesis.id)) {
      if (previous.lifecycle.status === 'ACTIVE') continue;
      if (permitted && !permitted.has(previous.id)) continue;
      if (alreadyRestored.has(intentKey(previous))) continue;
      try {
        const intent = this.recalibrate(previous, reading);
        const tracker = sdk.create(thesis.id, {
          purpose: intent.purpose,
          kind: intent.kind,
          config: { ...intent.config },
          ...(intent.symbol ? { symbol: intent.symbol } : {}),
          ...(intent.timeframe ? { timeframe: intent.timeframe } : {}),
          ...(intent.priority !== undefined ? { priority: intent.priority } : {}),
          ...(intent.cooldownMs !== undefined ? { cooldownMs: intent.cooldownMs } : {}),
        });
        restored.push(tracker.id);
        alreadyRestored.add(intentKey(tracker));
        if (intent.recalibrated) {
          this.lastRestoreRefusals.push(
            `${previous.purpose || previous.kind}: re-asked as "${intent.purpose}" because the original level is behind the market as this GOAT last read it.`,
          );
        }
      } catch (error) {
        // One unrestorable tracker is reported rather than allowed to stop
        // the rest of the plan coming back.
        this.lastRestoreRefusals.push(
          `${previous.purpose || previous.kind}: ${this.describeRejection(error)}`,
        );
      }
    }

    return restored;
  }

  /**
   * Whether a restored tracker is still asking a meaningful question.
   *
   * A tracker that watched "price above 1.1700" is stale the moment the market is at
   * 1.1900: it can never fire, and worse, it looks armed. Recalibration here is the
   * narrowest possible version of the idea — it re-asks the *same* question at the
   * price the market is actually at, and it changes nothing else.
   *
   * The limits are deliberate, and each one exists because the alternative is worse
   * than not recalibrating:
   *
   *   * only for a level-carrying tracker, because a question without a level has
   *     no price in it that could have gone stale
   *   * only from a reading this GOAT made, never a fresh one
   *   * only in the direction that restores the question's intent — a "reached"
   *     threshold above the market is still reachable, and re-asking it below would
   *     be answering a different question
   *   * never invented: if the level cannot be derived from the recorded price, the
   *     original tracker is restored untouched
   *
   * No volatility estimate, no ATR, no ratio: the recalibrated level is the recorded
   * price, because that is a number the system actually has rather than one it would
   * have to assume.
   */
  private recalibrate(
    previous: {
      purpose: string;
      kind: TrackerKind;
      config: unknown;
      symbol?: string;
      timeframe?: string;
      evaluation: { priority?: number; cooldownMs?: number };
    },
    reading: MarketReading | undefined,
  ): {
    purpose: string;
    kind: TrackerKind;
    config: Record<string, unknown>;
    symbol?: string;
    timeframe?: string;
    priority?: number;
    cooldownMs?: number;
    recalibrated: boolean;
  } {
    const original = {
      purpose: previous.purpose,
      kind: previous.kind,
      config: { ...(previous.config as Record<string, unknown>) },
      ...(previous.symbol ? { symbol: previous.symbol } : {}),
      ...(previous.timeframe ? { timeframe: previous.timeframe } : {}),
      ...(previous.evaluation.priority !== undefined ? { priority: previous.evaluation.priority } : {}),
      ...(previous.evaluation.cooldownMs !== undefined ? { cooldownMs: previous.evaluation.cooldownMs } : {}),
      recalibrated: false,
    };

    if (!reading || !Number.isFinite(reading.price) || reading.price <= 0) return original;
    const level = original.config['level'];
    if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) return original;

    const above = original.config['operator'] === 'ABOVE' || original.config['direction'] === 'ABOVE';
    const below = original.config['operator'] === 'BELOW' || original.config['direction'] === 'BELOW';
    if (!above && !below) return original;

    /*
     * Stale means unreachable, not merely distant: a "reached 1.1700 from below"
     * condition that the market is already far above has been answered, and asking
     * it again would be re-asking a settled question. A threshold the market has not
     * reached is untouched however far away it is, because the GOAT may have wanted
     * exactly that patience.
     */
    const stale = above ? reading.price >= level : reading.price <= level;
    if (!stale) return original;

    return {
      ...original,
      config: { ...original.config, level: reading.price },
      purpose: `${original.purpose} (re-asked at the last price this GOAT read)`,
      recalibrated: true,
    };
  }

  /**
   * Move a thesis to a new state, enforcing the transition table.
   *
   * The revision counter increments on every accepted change, which is
   * what makes a thesis readable as a sequence of beliefs rather than
   * a mutable row.
   */
  reviseThesis(
    thesisId: string,
    next: Partial<Pick<Thesis, 'state' | 'statement' | 'invalidation' | 'confidence' | 'direction'>>,
  ): Thesis {
    const thesis = this.deps.theses.get(thesisId);
    if (!thesis) throw new Error(`Unknown thesis ${thesisId}.`);

    if (next.state && next.state !== thesis.state) {
      if (!canTransitionThesis(thesis.state, next.state)) {
        throw new Error(
          `Thesis ${thesisId} cannot move from ${thesis.state} to ${next.state}.`,
        );
      }
    }

    if (
      next.state === 'ACTIONABLE' &&
      !this.mayBecomeActionable(thesis)
    ) {
      throw new Error(
        `Thesis ${thesisId} does not meet the active skill constraints for becoming actionable.`,
      );
    }

    const updated: Thesis = {
      ...thesis,
      ...(next.state ? { state: next.state as ThesisState } : {}),
      ...(next.statement !== undefined ? { statement: next.statement } : {}),
      ...(next.invalidation !== undefined ? { invalidation: next.invalidation } : {}),
      ...(next.confidence !== undefined ? { confidence: next.confidence } : {}),
      ...(next.direction !== undefined ? { direction: next.direction } : {}),
      revision: thesis.revision + 1,
      updatedAt: this.now(),
    };

    this.deps.theses.save(updated);
    return updated;
  }

  /** Record evidence for or against a thesis. */
  recordEvidence(input: Omit<Evidence, 'id' | 'createdAt'>): Evidence {
    const now = this.now();
    const evidence: Evidence = {
      ...input,
      id: `evd_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
    };
    this.deps.evidence.append(evidence);
    return evidence;
  }

  /**
   * Re-evaluate a thesis after a wake, and apply the agent's plan.
   *
   * The whole of the agent's response to a tracker event happens here:
   * interpret the event, record evidence with its provenance and weight, revise
   * the thesis, and adjust what is being watched. The agent gets one pass, and the
   * outcome is recorded whether or not it changed anything.
   *
   * A composite plan is the same pass, expressed as several decisions. It is
   * applied in a defined order — evidence, then thesis, then trackers, then a trade
   * idea — because the order is not cosmetic: a thesis revision that escalated the
   * thesis to ACTIONABLE is what makes a proposal in the same plan legal, and a
   * tracker created before a thesis was revised could arm itself against a thesis
   * that does not exist yet.
   *
   * Each step is validated on its own and refused on its own. There is no rollback,
   * and pretending otherwise would be worse than the partial application it would
   * replace: `WakeOutcome.rejections` records exactly which steps were refused, and
   * every step that did apply is independently safe on its own terms.
   */
  applyPlan(wake: WakeRequest, plan: AgentPlan): WakeOutcome {
    const outcome: WakeOutcome = {
      thesisId: wake.thesisId,
      plan,
      thesis: this.deps.theses.get(wake.thesisId) as Thesis,
      trackerChanges: [],
      evidenceRecorded: [],
      rejections: [],
    };

    if (this.inflight.has(wake.event.id)) {
      outcome.rejections.push(`Event ${wake.event.id} was already handled.`);
      return outcome;
    }
    this.inflight.add(wake.event.id);

    try {
      if (plan.kind === 'COMPOSITE') {
        this.applyComposite(wake, plan, outcome);
      } else {
        this.applyStep(wake, plan, outcome);
      }
    } finally {
      // Bounded: an id is only remembered long enough to catch a
      // genuine double delivery.
      if (this.inflight.size > 1_000) this.inflight.clear();
    }

    return outcome;
  }

  /**
   * Validate a composite plan before any of it is applied.
   *
   * The whole plan is refused on a structural problem — nesting, a duplicated
   * step, or too many steps — because a malformed composite is a malformed
   * *transaction*, and applying half of one the runtime does not understand is how
   * a system ends up with a thesis that was strengthened and evidence that was
   * never recorded. A step that is individually invalid is a different case: that
   * one is refused in place, by `applyStep`, and the rest of the plan proceeds.
   */
  private validateComposite(plan: Extract<AgentPlan, { kind: 'COMPOSITE' }>): string | undefined {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      return 'A composite plan needs at least one step.';
    }
    if (plan.steps.length > MAX_COMPOSITE_STEPS) {
      return `A composite plan may contain at most ${MAX_COMPOSITE_STEPS} steps; this one had ${plan.steps.length}.`;
    }
    const kinds = new Set<string>();
    for (const step of plan.steps) {
      if (!isRecord(step) || typeof step.kind !== 'string') {
        return 'A composite step was not a recognisable decision.';
      }
      // Narrowed away by the type; checked anyway, because this is untrusted input.
      if ((step as { kind: string }).kind === 'COMPOSITE') {
        return 'A composite plan cannot contain another composite plan.';
      }
      if (kinds.has(step.kind)) {
        return `A composite plan cannot contain two ${step.kind} steps; the second would silently undo the first.`;
      }
      kinds.add(step.kind);
    }
    return undefined;
  }

  /**
   * Apply a composite plan, in the one order that is coherent.
   *
   * Evidence first, because everything after it is a conclusion drawn from that
   * evidence. Thesis decisions next, because an escalation is what authorises a
   * proposal in the same pass. Trackers after the thesis, so a watch is armed
   * against the belief it exists to test. The trade idea last, because it is the
   * only step that needs every preceding one to have landed.
   */
  private applyComposite(
    wake: WakeRequest,
    plan: Extract<AgentPlan, { kind: 'COMPOSITE' }>,
    outcome: WakeOutcome,
  ): void {
    const problem = this.validateComposite(plan);
    if (problem) {
      outcome.rejections.push(`Composite plan refused: ${problem} Nothing in it was applied.`);
      return;
    }

    const order: Record<AgentPlanStep['kind'], number> = {
      CONFIRM_THESIS: 0,
      WEAKEN_THESIS: 0,
      INVALIDATE_THESIS: 0,
      REVISE_THESIS: 1,
      ESCALATE_THESIS: 1,
      CREATE_TRACKER: 2,
      REMOVE_TRACKER: 2,
      PROPOSE_TRADE_IDEA: 3,
      WAIT: 4,
    };

    const steps = [...plan.steps].sort(
      (left, right) => (order[left.kind] ?? 9) - (order[right.kind] ?? 9),
    );

    for (const step of steps) {
      /*
       * A thesis that is no longer live stops the rest of the plan. Not a
       * refusal — an observation that the plan's later steps were written against a
       * thesis that no longer exists.
       */
      const current = this.deps.theses.get(wake.thesisId);
      if (!current || isTerminalThesisState(current.state)) {
        outcome.rejections.push(
          `The remaining steps were not applied: thesis ${wake.thesisId} is no longer live.`,
        );
        return;
      }
      this.applyStep(wake, step, outcome);
    }
  }

  /**
   * Apply one decision.
   *
   * Everything the composite path needs is here, and everything here is
   * individually safe: an invalid action is refused and recorded, and no refusal
   * leaves the thesis, the evidence or the trackers in a state that a later step
   * would read as permission it was not given.
   */
  private applyStep(wake: WakeRequest, plan: AgentPlanStep, outcome: WakeOutcome): void {
    /*
     * A terminal thesis refuses everything, at the door.
     *
     * Not a nicety: `reviseThesis` throws on an illegal transition, and a wake that
     * reached it with a closed thesis would take the whole pass with it. In practice
     * the tracker runtime never delivers such a wake — invalidating a thesis cancels
     * its watches, and a cancelled watch cannot produce an observation — so this is
     * the second of two fail-closed checks rather than the first. Both are wanted:
     * the first is what stops it happening, the second is what stops it mattering if
     * something upstream changes.
     */
    const current = this.deps.theses.get(wake.thesisId);
    if (!current) {
      outcome.rejections.push(`Thesis ${wake.thesisId} no longer exists.`);
      return;
    }
    if (isTerminalThesisState(current.state)) {
      outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS', 0).id);
      outcome.rejections.push(
        `Thesis ${wake.thesisId} is ${current.state}, so this wake was recorded but nothing was decided.`,
      );
      return;
    }

    switch (plan.kind) {
      case 'WAIT':
        return;

      case 'CONFIRM_THESIS': {
        this.applyConfidenceWake(wake, 'SUPPORTS', 'STRENGTHENING', outcome);
        return;
      }

      case 'WEAKEN_THESIS': {
        this.applyConfidenceWake(wake, 'CONTRADICTS', 'WEAKENING', outcome);
        return;
      }

      case 'INVALIDATE_THESIS': {
        outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'CONTRADICTS', 0).id);
        outcome.thesis = this.reviseThesis(wake.thesisId, { state: 'INVALIDATED' });
        // A rejected thesis must stop costing wake budget.
        for (const tracker of this.deps.trackers.cancelTrackersForThesis(
          wake.thesisId,
          'Thesis invalidated.',
        )) {
          outcome.trackerChanges.push({ action: 'cancelled', trackerId: tracker.id });
        }
        /*
         * A hypothesis tournament has exactly one survivor, and "this one was
         * disproven" is the only moment the record supports saying so about the
         * other. Never the other way round, and never silently: the counterpart is
         * closed with a reason rather than left running against a question that no
         * longer has two answers.
         */
        this.resolveCompetingThesis(wake.thesisId, outcome);
        return;
      }

      case 'REVISE_THESIS': {
        outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS', 0).id);
        outcome.thesis = this.reviseThesis(wake.thesisId, {
          statement: plan.statement,
          invalidation: plan.invalidation,
          /*
           * The model's stated confidence is an *input* to belief, never the
           * output. It is recorded, clamped, and bounded by how much it is allowed
           * to move the number the runtime computed: a model that restates its
           * thesis and declares 99% certainty cannot rewrite four minutes of
           * evidence into certainty.
           */
          confidence: this.boundedStatedConfidence(
            plan.confidence,
            this.deps.theses.get(wake.thesisId) as Thesis,
          ),
          state: 'ACTIVE',
        });
        return;
      }

      case 'ESCALATE_THESIS': {
        /*
         * Promotion, through the gate that already exists.
         *
         * `reviseThesis` refuses a thesis that does not meet its skills' bar, so
         * escalation cannot be used to bypass evidence requirements — it can
         * only express that the model believes the bar is met. A refusal is
         * reported rather than thrown, because "your skills are not satisfied
         * yet" is a legitimate answer to a wake, not a crash.
         *
         * The wake's own `thesisId` is authoritative and the plan's is ignored.
         * The wake already says which thesis this reasoning is about; a model that
         * named a different one would otherwise be able to escalate somebody
         * else's thesis, which is the same ownership hazard `buildContext` refuses
         * to even reach.
         */
        const thesis = this.deps.theses.get(wake.thesisId);
        if (!thesis) {
          outcome.rejections.push(`Thesis ${wake.thesisId} no longer exists.`);
          return;
        }
        if (thesis.state === 'ACTIONABLE') {
          // Already there. Saying so is better than a redundant write, and the
          // next wake can price the trade.
          outcome.thesis = thesis;
          outcome.rejections.push('This thesis is already actionable.');
          return;
        }
        outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS', 0).id);
        try {
          outcome.thesis = this.reviseThesis(wake.thesisId, { state: 'ACTIONABLE' });
        } catch (error) {
          outcome.rejections.push(this.describeRejection(error));
        }
        return;
      }

      case 'CREATE_TRACKER': {
        try {
          const tracker = this.deps
            .sdkFor(wake.agentId)
            .create(plan.thesisId, plan.spec);
          outcome.trackerChanges.push({ action: 'created', trackerId: tracker.id });
          // A new tracker means a new question, so the thesis is
          // investigating again.
          if (this.deps.theses.get(plan.thesisId)?.state === 'ACTIONABLE') {
            outcome.thesis = this.reviseThesis(plan.thesisId, { state: 'ACTIVE' });
          }
        } catch (error) {
          outcome.rejections.push(this.describeRejection(error));
        }
        return;
      }

      case 'REMOVE_TRACKER': {
        try {
          const tracker = this.deps
            .sdkFor(wake.agentId)
            .remove(plan.trackerId, plan.reason);
          outcome.trackerChanges.push({ action: 'cancelled', trackerId: tracker.id });
        } catch (error) {
          outcome.rejections.push(this.describeRejection(error));
        }
        return;
      }

      case 'PROPOSE_TRADE_IDEA': {
        const ideaId = this.createTradeIdea(wake, plan, outcome);
        if (ideaId) outcome.tradeIdeaId = ideaId;
        return;
      }

      default:
        outcome.rejections.push('Unrecognised plan.');
    }
  }

  /**
   * The confidence half of a wake: record the evidence, then move belief by an
   * amount the runtime computed.
   *
   * Two decisions are taken here and neither is the model's to make:
   *
   *   *how far* belief moves — from severity, resolution, novelty, independence
   *   and the model's own (discount-only) stated confidence
   *   *whether the state* moves at all — from the hysteresis floor, so a marginal
   *   observation moves the number and leaves the state alone
   *
   * A repeated observation is still recorded — the market did something, and the
   * record of it is the point of evidence — but it moves nothing, because a
   * condition being true for the fourth time is not four confirmations.
   */
  private applyConfidenceWake(
    wake: WakeRequest,
    polarity: 'SUPPORTS' | 'CONTRADICTS',
    target: 'STRENGTHENING' | 'WEAKENING',
    outcome: WakeOutcome,
  ): void {
    const thesis = this.deps.theses.get(wake.thesisId);
    if (!thesis) {
      outcome.rejections.push(`Thesis ${wake.thesisId} no longer exists.`);
      return;
    }

    const thesisTimeframe = this.thesisTimeframe(thesis);
    const frame = this.weighFrame(wake, polarity, thesisTimeframe);
    outcome.evidenceRecorded.push(...frame.evidence.map((item) => item.id));

    const confidence = applyConfidence(thesis.confidence, frame.totalEffect);
    const verdict = hysteresisVerdict({
      polarity,
      effect: frame.strongest.effect,
      repeated: frame.strongest.repeated,
    });

    if (!verdict.changesState) {
      /*
       * Belief moved, state did not. Written as a revision anyway, because a
       * confidence that changed is a change to the thesis and hiding it would make
       * the number drift without a visible history.
       */
      outcome.thesis = this.reviseThesis(wake.thesisId, { confidence });
      if (verdict.reason) outcome.rejections.push(verdict.reason);
      return;
    }

    outcome.thesis = this.reviseThesis(wake.thesisId, {
      state: target,
      confidence,
    });
  }

  /**
   * The deterministic risk layer's verdict, as something the GOAT can reason about.
   *
   * This is the seam between the two halves of the system. The risk engine decides;
   * the loop cannot see an account, cannot re-price anything, and has no way to
   * make a refusal disappear. What it does is turn the refusal into evidence and a
   * bounded allowance to try again — so a GOAT that was refused for placing its
   * stop inside the noise can re-propose with a wider one, and a GOAT that is being
   * refused for the same reason three times is told its allowance is spent rather
   * than being left to discover it.
   *
   * Idempotent by plan id: the same refusal delivered twice is one refusal.
   */
  recordRiskFeedback(input: {
    planId: string;
    thesisId: string;
    approved: boolean;
    reason: string;
    metrics?: Record<string, number | string>;
  }): { attempts: number; remaining: number; abandoned: boolean } | undefined {
    const thesis = this.deps.theses.get(input.thesisId);
    if (!thesis) return undefined;

    if (input.approved) {
      /*
       * Approval ends the construction, and only now.
       *
       * The thesis used to be completed the moment an idea was written, which put
       * the risk check after the end of the line: a refused plan left a thesis in a
       * terminal state with no way to re-evaluate, so the GOAT's only remaining
       * option was to form a brand-new hypothesis over the same market and try
       * again. Completing on approval instead means the thesis stays live exactly
       * as long as there is something left to do about the refusal.
       */
      if (thesis.state !== 'COMPLETED') {
        this.reviseThesis(input.thesisId, { state: 'COMPLETED' });
      }
      return { attempts: thesis.riskAttempts ?? 0, remaining: 0, abandoned: false };
    }

    const attempts = (thesis.riskAttempts ?? 0) + 1;
    const limit = this.riskRevisionCeiling(thesis.goalId);
    const remaining = Math.max(0, limit - attempts);
    const abandoned = attempts >= limit;

    this.recordEvidence({
      thesisId: input.thesisId,
      polarity: 'CONTRADICTS',
      summary: `The risk layer refused this trade construction: ${input.reason}`,
      source: 'RISK_FEEDBACK',
      confidence: undefined,
      observed: {
        planId: input.planId,
        attempt: attempts,
        limit,
        ...(input.metrics ?? {}),
      },
      provenance: `risk:${input.planId}:${attempts}`,
      /*
       * A refusal is not evidence about the market, so it is weighted as nothing
       * in particular: it must not drag a thesis's confidence toward zero just
       * because the account was small. It belongs in the record and in the
       * reasoning context, and it moves no number.
       */
      weight: 0,
      novelty: 1,
    });

    /*
     * Belief in the *thesis* is untouched; what is exhausted is the allowance to
     * re-propose. Separating the two is what stops a sizing problem from being
     * mistaken for a thesis being wrong — and it is why this is written straight to
     * the record rather than through `reviseThesis`, whose fields are about belief.
     */
    const updated: Thesis = {
      ...thesis,
      riskAttempts: attempts,
      revision: thesis.revision + 1,
      updatedAt: this.now(),
    };
    this.deps.theses.save(updated);

    return { attempts, remaining, abandoned };
  }

  /**
   * Close the other half of a hypothesis tournament.
   *
   * Only ever called when one side is disproven, and only for the thesis it names
   * as its counterpart — so a thesis cannot be closed by a decision about a
   * question it is not part of.
   */
  private resolveCompetingThesis(thesisId: string, outcome: WakeOutcome): void {
    const winner = this.deps.theses.get(thesisId);
    const counterpartId = winner?.competesWith;
    if (!counterpartId) return;

    const counterpart = this.deps.theses.get(counterpartId);
    if (!counterpart || counterpart.agentId !== winner?.agentId) return;
    if (isTerminalThesisState(counterpart.state)) return;

    try {
      this.reviseThesis(counterpartId, { state: 'ABANDONED' });
      for (const tracker of this.deps.trackers.cancelTrackersForThesis(
        counterpartId,
        'The competing hypothesis was disproven.',
      )) {
        outcome.trackerChanges.push({ action: 'cancelled', trackerId: tracker.id });
      }
      outcome.rejections.push(
        `Its competing hypothesis (${counterpartId}) was closed: the question this goal asked now has one answer, not two.`,
      );
    } catch (error) {
      outcome.rejections.push(this.describeRejection(error));
    }
  }

  /**
   * How much belief a stated confidence is allowed to add.
   *
   * Bounded by a fraction of the runtime's own number, so restating a thesis cannot
   * rewrite its history. Absent means "the model did not say", which is not a claim
   * of certainty and leaves the computed number alone.
   */
  private boundedStatedConfidence(stated: number | undefined, thesis: Thesis): number | undefined {
    if (typeof stated !== 'number' || !Number.isFinite(stated)) return undefined;
    const computed = clampConfidence(thesis.confidence ?? 0.5);
    const requested = clampConfidence(stated);
    const maxMove = 0.15;
    const bounded = Math.max(
      computed - maxMove,
      Math.min(computed + maxMove, requested),
    );
    return clampConfidence(bounded);
  }

  /** How many re-proposals this goal is allowed after a risk refusal. */
  private riskRevisionCeiling(goalId: string): number {
    const goal = this.deps.goals.get(goalId);
    if (!goal) return MAX_RISK_REVISIONS;
    for (const constraint of this.deps.skills.resolveConstraints(goal.skillIds)) {
      if (constraint.kind === 'MAX_RISK_REVISIONS') return constraint.maximum;
    }
    return MAX_RISK_REVISIONS;
  }

  /**
   * Turn a wake into evidence.
   *
   * The event itself is recorded verbatim. What the event means for
   * the thesis is the agent's judgement, and that judgement is the
   * `summary`, not the `reason` the runtime produced.
   */
  /**
   * Record the observations this wake delivered, as evidence.
   *
   * One record per observation, not one per wake — and that is the whole of what
   * batching changes here. The tracker runtime groups several observations of one
   * market moment into a single wake so the GOAT is woken once; it does not merge
   * them, and the reasoning layer still has to see each of them separately,
   * because whether three observations of one bar are one piece of evidence or
   * three is a question about this thesis and these records, and only this layer
   * can answer it.
   *
   * They arrive here sharing a provenance key, so `noveltyWeight` gives the second
   * and third nothing and the model is told plainly that it is not looking at
   * three independent confirmations. The independence is *decided* here and
   * asserted nowhere upstream.
   */
  private recordWakeEvidence(
    wake: WakeRequest,
    polarity: 'SUPPORTS' | 'CONTRADICTS',
    effect = 0,
    detail?: {
      novelty?: number;
      conflicting?: boolean;
      conflictingWith?: Array<{ evidenceId: string; because: string }>;
    },
  ): Evidence {
    return this.recordObservationEvidence(wake, wake.event, polarity, effect, detail);
  }

  /**
   * Every observation in the wake's frame, in the runtime's deterministic order,
   * primary first.
   *
   * The primary leads because the wake is addressed to it and the reason the wake
   * happened is its own; the rest follow in the order the runtime committed to, so
   * the record reads the same way twice.
   */
  private observationsOf(wake: WakeRequest): TrackerEvent[] {
    const batch = wake.batch?.events;
    if (!batch || batch.length === 0) return [wake.event];
    const ordered = [wake.event, ...batch.filter((event) => event.id !== wake.event.id)];
    return ordered;
  }

  /**
   * Weigh and record every observation in one frame, in the runtime's order.
   *
   * Each observation is weighed *separately*, against the evidence as it stood when
   * it was weighed. That ordering is what makes a batch mean something rather than
   * merely arrive together: the first observation of a market movement is novel and
   * the second and third, sharing its provenance, are not — so three trackers firing
   * on one bar produce one piece of support and two records that say so, rather than
   * three pieces of support and a confidence that walked to certainty on one bar.
   *
   * The effect applied to belief is the sum of what each observation was worth, and
   * the strongest single observation decides whether the state moves at all. A
   * batch of two marginal observations does not aggregate its way past the
   * hysteresis floor.
   */
  private weighFrame(
    wake: WakeRequest,
    polarity: 'SUPPORTS' | 'CONTRADICTS',
    thesisTimeframe: string | undefined,
  ): { evidence: Evidence[]; totalEffect: number; strongest: EvidenceWeight } {
    const recorded: Evidence[] = [];
    let totalEffect = 0;
    let strongest: EvidenceWeight | undefined;

    for (const event of this.observationsOf(wake)) {
      const prior = this.deps.evidence.listForThesis(wake.thesisId);
      const weight = weighEvidence({
        event,
        polarity,
        ...(thesisTimeframe ? { thesisTimeframe } : {}),
        priorEvidence: prior,
        strongestCounterWeight: strongestWeight(prior, polarity === 'SUPPORTS' ? 'CONTRADICTS' : 'SUPPORTS'),
      });
      recorded.push(
        this.recordObservationEvidence(wake, event, polarity, weight.effect, {
          novelty: weight.novelty,
        }),
      );
      totalEffect += weight.effect;
      if (!strongest || Math.abs(weight.effect) > Math.abs(strongest.effect)) strongest = weight;
    }

    return {
      evidence: recorded,
      totalEffect,
      strongest: strongest ?? {
        effect: 0,
        severity: 0,
        timeframe: 0,
        novelty: 0,
        stated: 0,
        repeated: true,
        conflicting: false,
      },
    };
  }

  private recordObservationEvidence(
    wake: WakeRequest,
    event: TrackerEvent,
    polarity: 'SUPPORTS' | 'CONTRADICTS',
    effect = 0,
    detail?: {
      novelty?: number;
      conflicting?: boolean;
      conflictingWith?: Array<{ evidenceId: string; because: string }>;
    },
  ): Evidence {
    const key = provenanceKey(event);
    const prior = this.deps.evidence.listForThesis(wake.thesisId);
    const conflicts = detectConflicts({
      incoming: {
        polarity,
        weight: Math.abs(effect),
        ...(event.trackerId ? { sourceTrackerId: event.trackerId } : {}),
        ...(event.timeframe ? { timeframe: event.timeframe } : {}),
      },
      prior,
    });

    return this.recordEvidence({
      thesisId: wake.thesisId,
      polarity,
      summary: `Tracker event: ${event.reason}`,
      source: 'TRACKER_EVENT',
      ...(event.observedValues ? { observed: event.observedValues } : {}),
      ...(typeof event.confidence === 'number'
        ? { confidence: event.confidence }
        : {}),
      trackerEventId: event.id,
      provenance: key,
      ...(event.trackerId ? { sourceTrackerId: event.trackerId } : {}),
      ...(event.timeframe ? { timeframe: event.timeframe } : {}),
      ...(event.symbol ? { symbol: event.symbol } : {}),
      weight: effect,
      novelty: detail?.novelty ?? 1,
      ...(conflicts.length > 0
        ? {
            conflictsWith: conflicts.map((conflict) => ({
              evidenceId: conflict.evidenceId,
              because: conflict.because,
            })),
          }
        : {}),
    });
  }

  /**
   * Construct a trade idea from an actionable thesis.
   *
   * Note what this does not do: it does not place an order. An idea is
   * a proposal with a stated invalidation, and converting it into an
   * order is a separate decision that passes through the policy and
   * risk gates that already exist.
   */
  private createTradeIdea(
    wake: WakeRequest,
    plan: Extract<AgentPlan, { kind: 'PROPOSE_TRADE_IDEA' }>,
    outcome: WakeOutcome,
  ): string | undefined {
    const thesis = this.deps.theses.get(wake.thesisId);
    if (!thesis) {
      outcome.rejections.push(`Thesis ${wake.thesisId} no longer exists.`);
      return undefined;
    }

    if (thesis.state !== 'ACTIONABLE') {
      outcome.rejections.push(
        `Thesis ${wake.thesisId} is ${thesis.state}, not ACTIONABLE, so no trade idea was constructed.`,
      );
      return undefined;
    }

    const goal = this.deps.goals.get(thesis.goalId);
    const constraints = goal ? this.deps.skills.resolveConstraints(goal.skillIds) : [];
    const forbidden = forbiddenOrderTypes(constraints);
    if (forbidden.includes(plan.idea.orderType)) {
      outcome.rejections.push(
        `Active skills forbid ${plan.idea.orderType} orders for this goal.`,
      );
      return undefined;
    }

    const invalidationRequired = constraints.some(
      (c) => c.kind === 'REQUIRE_INVALIDATION_BEFORE_TRADE',
    );
    if (invalidationRequired && !Number.isFinite(plan.idea.invalidationLevel)) {
      outcome.rejections.push(
        'Active skills require an explicit invalidation level before a trade idea.',
      );
      return undefined;
    }

    /*
     * Shape checks that do not depend on any skill.
     *
     * These are not preferences. A long with no target is not a trade
     * idea, and storing it as one would put an unsound proposal in
     * front of the user with a thesis id attached, which is worse than
     * refusing it.
     */
    const shapeProblem = validateIdeaShape(plan.idea);
    if (shapeProblem) {
      outcome.rejections.push(shapeProblem);
      return undefined;
    }

    /*
     * One construction in flight per thesis.
     *
     * A thesis used to complete the moment an idea was written, which incidentally
     * prevented a second idea from the same hypothesis — by making the hypothesis
     * unusable rather than by refusing the proposal. Now that the thesis stays live
     * until the risk layer approves, the refusal has to be explicit: while a plan is
     * still waiting to be checked, another one from the same thesis would be a
     * second answer to a question that has not been asked yet.
     *
     * A plan that has already been checked — approved or refused — does not block
     * another, because that is the retry this whole path exists to allow, and it is
     * bounded above.
     */
    const inFlight = this.deps.ideas
      .listForThesis(thesis.id)
      .find((idea) => idea.status === 'PROPOSED' || idea.status === 'RISK_CHECK');
    if (inFlight) {
      outcome.rejections.push(
        `Trade plan ${inFlight.id} from this thesis is still waiting to be risk-checked, so no second construction was built.`,
      );
      return undefined;
    }

    /*
     * The retry bound, checked before anything is written.
     *
     * A GOAT that has been refused by the risk layer N times has learned everything
     * it is going to learn from being refused N times. Refusing here — with the
     * count and the reason in the message — is what stops the alternative, which is
     * a loop with no exit: propose, be refused, propose the same construction, be
     * refused. The thesis stays live; what is exhausted is this route to a trade.
     */
    const attempts = thesis.riskAttempts ?? 0;
    const limit = this.riskRevisionCeiling(thesis.goalId);
    if (attempts >= limit) {
      outcome.rejections.push(
        `The risk layer has refused ${attempts} constructions from this thesis (limit ${limit}). No further trade idea will be built from it until new evidence changes the thesis itself.`,
      );
      return undefined;
    }

    /*
     * The market, checked against the deployment rather than trusted.
     *
     * Shape validation says the numbers are coherent; it says nothing about
     * which market they belong to. A GOAT deployed on EUR/USD could
     * therefore persist a trade plan for an unrelated instrument, and the
     * plan would then be priced against the real account by the risk layer
     * as though it were a plan for the market this GOAT was deployed to.
     * `deployment.marketId` is authoritative; symbols are compared in the
     * form the deployment recorded them.
     */
    const deployment = this.deps.currentDeployment?.(thesis.agentId);
    if (!deployment) {
      outcome.rejections.push(
        `Thesis ${wake.thesisId} has no live deployment, so no trade idea was constructed.`,
      );
      return undefined;
    }
    if (!sameMarket(plan.idea.symbol, deployment.market)) {
      outcome.rejections.push(
        `A ${plan.idea.symbol} idea cannot be constructed by a GOAT deployed to ${deployment.market}.`,
      );
      return undefined;
    }

    const now = this.now();
    const id = `tid_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.deps.ideas.save({
      id,
      thesisId: thesis.id,
      goalId: thesis.goalId,
      agentId: thesis.agentId,
      symbol: plan.idea.symbol,
      direction: plan.idea.direction,
      orderType: plan.idea.orderType,
      entry: plan.idea.entry,
      invalidationLevel: plan.idea.invalidationLevel,
      takeProfits: plan.idea.takeProfits,
      reasoning: plan.idea.reasoning,
      supportingEvidence: plan.idea.supportingEvidence ?? this.deps.evidence
        .listForThesis(thesis.id)
        .filter((item) => item.polarity === 'SUPPORTS')
        .map((item) => item.id),
      invalidation: thesis.invalidation,
      riskContext: plan.idea.riskContext,
      /*
       * `PROPOSED`, not `READY`. The agent proposing a plan and a plan
       * being acceptable to the risk layer are different events, and the
       * second one is decided by code that has read the account rather
       * than by the agent that wrote the plan.
       */
      status: 'PROPOSED',
      createdAt: now,
      updatedAt: now,
    });

    /*
     * The thesis is *not* completed here.
     *
     * It used to be, one line before this evidence was recorded, and that single
     * line put the end of the chain in front of the risk layer: `COMPLETED` is a
     * terminal state, so a refused plan left a thesis that could not be revised,
     * re-priced or re-evaluated, with no way to respond to the refusal except to
     * invent a brand-new hypothesis over the same market. The thesis now completes
     * when the risk layer approves the construction — `recordRiskFeedback` — so it
     * stays live for exactly as long as there is something left to do.
     */
    outcome.evidenceRecorded.push(
      this.recordEvidence({
        thesisId: thesis.id,
        polarity: 'SUPPORTS',
        summary: `Trade idea constructed: ${plan.idea.direction} ${plan.idea.symbol} ${plan.idea.orderType} @ ${plan.idea.entry}.`,
        source: 'AGENT_INVESTIGATION',
        observed: {
          entry: plan.idea.entry,
          invalidationLevel: plan.idea.invalidationLevel,
        },
        provenance: `plan:${id}`,
        weight: 0,
        novelty: 1,
      }).id,
    );
    outcome.thesis = this.deps.theses.get(thesis.id) as Thesis;
    return id;
  }

  /**
   * Whether a thesis has earned the right to be actionable.
   *
   * Enforced, not suggested. A skill that requires evidence before
   * action is a claim about the system, and a claim the runtime does
   * not check is not a constraint.
   */
  private mayBecomeActionable(thesis: Thesis): boolean {
    const goal = this.deps.goals.get(thesis.goalId);
    if (!goal) return false;

    const supporting = this.deps.evidence
      .listForThesis(thesis.id)
      .filter((item) => item.polarity === 'SUPPORTS');

    for (const constraint of this.deps.skills.resolveConstraints(goal.skillIds)) {
      if (
        constraint.kind === 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE' &&
        supporting.length < constraint.minimum
      ) {
        return false;
      }

    }
    return true;
  }

  /**
   * Which of the goal's skill constraints are not yet met.
   *
   * Reported rather than enforced, and that is a deliberate decision worth
   * stating plainly.
   *
   * `REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION` is declared by six of the ten
   * shipped skills. Enforcing it as a hard gate on ACTIONABLE would mean a
   * GOAT watching a single resolution could *never* become actionable — not
   * "would rarely", never — because there is no coarser observation for it to
   * be confirmed by. Six of every ten goals would stall in RESEARCHING for
   * good, and the fix would look like a working safety rule while being a
   * deadlock.
   *
   * So it is surfaced instead: the plan shows it as an outstanding
   * requirement, so the user can see the GOAT is waiting on corroboration it
   * has not got, and can attach a multi-timeframe skill or read the 1h
   * themselves. A rule that is visible and unmet is honest; a rule that is
   * enforced and unreachable is neither.
   *
   * Everything else this gate checks *is* enforced, because those constraints
   * have an escape: evidence accumulates, order types are chosen, and an
   * invalidation is written.
   */
  outstandingConstraints(goalId: string): string[] {
    const goal = this.deps.goals.get(goalId);
    if (!goal) return [];

    const outstanding: string[] = [];
    for (const constraint of this.deps.skills.resolveConstraints(goal.skillIds)) {
      if (constraint.kind === 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION') {
        const thesis = this.deps.theses.listLiveForGoal(goalId)[0];
        const confirmed = thesis ? this.hasHigherTimeframeConfirmation(thesis) : false;
        if (!confirmed) {
          outstanding.push(
            'Your skills ask for confirmation on a higher timeframe than the setup. No coarser observation has been recorded yet.',
          );
        }
      }
    }
    return outstanding;
  }

  /**
   * Whether any supporting evidence came from a higher resolution than the
   * thesis's own.
   *
   * Read from the evidence record rather than the prose: `observed` carries
   * the resolution an observation was made at, so this asks a question about
   * a measurement rather than about what a summary says. Evidence with no
   * recorded resolution cannot satisfy the check, because assuming it was
   * higher would make the rule decorative in exactly the case it exists for.
   */
  private hasHigherTimeframeConfirmation(thesis: Thesis): boolean {
    const supporting = this.deps.evidence
      .listForThesis(thesis.id)
      .filter((item) => item.polarity === 'SUPPORTS');
    const thesisTimeframe = this.thesisTimeframe(thesis);
    if (!thesisTimeframe) return false;

    const rank = (timeframe: string): number =>
      TIMEFRAME_ORDER.indexOf(timeframe);
    const thesisRank = rank(thesisTimeframe);
    if (thesisRank < 0) return false;

    return supporting.some((item) => {
      const observed = item.observed as { timeframe?: unknown } | undefined;
      const observedTimeframe = typeof observed?.timeframe === 'string' ? observed.timeframe : undefined;
      if (!observedTimeframe) return false;
      const observedRank = rank(observedTimeframe);
      // A lower resolution is not confirmation, and neither is the same one.
      return observedRank > thesisRank;
    });
  }

  /**
   * The resolution a thesis is being worked on.
   *
   * Carried in the thesis's own requirements as the first resolution it
   * names, and otherwise the goal's setup resolution. Derived rather than
   * stored, because a stored default is exactly the hard-coded assumption this
   * replaces.
   */
  private thesisTimeframe(thesis: Thesis): string | undefined {
    for (const requirement of thesis.requiredConfirmation) {
      const match = /\b(\d+[mhd])\b/.exec(requirement);
      if (match) return match[1];
    }
    const goal = this.deps.goals.get(thesis.goalId);
    return goal?.timeframes[0];
  }

  private thesisCeiling(goalId: string): number {
    const goal = this.deps.goals.get(goalId);
    if (!goal) return 5;
    for (const constraint of this.deps.skills.resolveConstraints(goal.skillIds)) {
      if (constraint.kind === 'MAX_THESES') return constraint.maximum;
    }
    return 5;
  }

  /** Confidence is advisory, so it is clamped rather than trusted. */
  private adjustedConfidence(thesis: { confidence?: number }, delta: number): number {
    const current = thesis.confidence ?? 0.5;
    return Math.max(0, Math.min(1, current + delta));
  }

  private describeRejection(error: unknown): string {
    if (error instanceof TrackerRuntimeError) {
      return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Instructions for one phase, from the goal's active skills.
   *
   * Called at the point the phase happens, not once at start-up. This
   * is the difference between a skill that shapes GOAT and a skill that
   * decorates a system prompt.
   */
  instructionsFor(goalId: string, phase: SkillPhase): string {
    const goal = this.deps.goals.get(goalId);
    if (!goal) return '';
    return this.deps.skills.compilePhase(goal.skillIds, phase);
  }
}

/**
 * Whether two symbol labels name the same market.
 *
 * The same instrument is written several ways across the system —
 * `EURUSD` in a deployment, `EUR/USD` in a plan, `EUR-USD` in prose — so
 * the comparison is on alphanumerics only. Anything that is not a
 * recognisable pair is *not* the same market: an unrecognisable symbol is
 * refused rather than allowed through on the assumption that it probably
 * meant the right one.
 */
function sameMarket(left: string, right: string): boolean {
  const normalise = (value: string) => value.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const a = normalise(left ?? '');
  const b = normalise(right ?? '');
  return a.length > 0 && a === b;
}

/**
 * Resolutions from finest to coarsest.
 *
 * A total order is what makes "higher timeframe" checkable at all: the
 * constraint asks whether confirmation came from a coarser resolution than the
 * setup, and that comparison has to mean something.
 */
const TIMEFRAME_ORDER: readonly string[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

function forbiddenOrderTypes(constraints: SkillConstraint[]): Array<'MARKET' | 'LIMIT' | 'STOP'> {
  return constraints
    .filter((c): c is Extract<SkillConstraint, { kind: 'FORBID_ORDER_TYPE' }> => c.kind === 'FORBID_ORDER_TYPE')
    .map((c) => c.orderType);
}

/**
 * What makes two trackers the same watch.
 *
 * Purpose, kind and timeframe. The config is deliberately excluded: two
 * PRICE_THRESHOLD trackers on the same market and timeframe watching the
 * same thing are one watch, however the levels were written down.
 */
function intentKey(tracker: {
  purpose: string;
  kind: string;
  timeframe?: string;
  symbol?: string;
}): string {
  return `${tracker.kind}|${tracker.timeframe ?? ''}|${tracker.symbol ?? ''}|${tracker.purpose.trim()}`;
}

/**
 * Whether a proposed idea is structurally usable, and if not, why.
 *
 * The directional checks matter most: an invalidation on the wrong side
 * of the entry is the exact mistake that turns a thesis into a loss,
 * and it is worth catching before the idea is ever shown to a user.
 */
function validateIdeaShape(idea: TradeIdeaRequest): string | undefined {
  if (!Number.isFinite(idea.entry) || idea.entry <= 0) {
    return 'A trade idea needs a positive entry price.';
  }
  if (!Number.isFinite(idea.invalidationLevel) || idea.invalidationLevel <= 0) {
    return 'A trade idea needs a positive invalidation level.';
  }
  if (idea.direction === 'LONG' && idea.invalidationLevel >= idea.entry) {
    return 'A long idea cannot have its invalidation at or above its entry.';
  }
  if (idea.direction === 'SHORT' && idea.invalidationLevel <= idea.entry) {
    return 'A short idea cannot have its invalidation at or below its entry.';
  }
  if (idea.takeProfits.length === 0) {
    return 'A trade idea needs at least one target.';
  }
  for (const target of idea.takeProfits) {
    if (!Number.isFinite(target.price) || target.price <= 0) {
      return 'A trade idea target needs a positive price.';
    }
    if (target.fraction <= 0 || target.fraction > 1) {
      return 'A trade idea target fraction must be within (0, 1].';
    }
    if (idea.direction === 'LONG' && target.price <= idea.entry) {
      return 'A long idea cannot have a target at or below its entry.';
    }
    if (idea.direction === 'SHORT' && target.price >= idea.entry) {
      return 'A short idea cannot have a target at or above its entry.';
    }
  }
  return undefined;
}

/** The largest single effect any recorded evidence carries. */
function strongestWeight(
  evidence: readonly Evidence[],
  polarity: Evidence['polarity'],
): number {
  return evidence
    .filter((item) => item.polarity === polarity)
    .reduce((max, item) => Math.max(max, Math.abs(item.weight ?? 0)), 0);
}

function isTerminalThesisState(state: ThesisState): boolean {
  return state === 'INVALIDATED' || state === 'ABANDONED' || state === 'COMPLETED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
