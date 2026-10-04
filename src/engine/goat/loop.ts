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
  Evidence,
  Thesis,
  ThesisState,
  TrackerEvent,
  TrackerRequest,
  TradeIdeaRequest,
  WakeRequest,
} from './types';
import { canTransitionThesis } from './types';
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

    return {
      agentId,
      goalId: goal.id,
      skillIds: goal.skillIds,
      deployment,
      goal: goal.statement,
      thesis,
      watching,
      evidence: this.deps.evidence.listForThesis(thesisId),
      recentEvents,
      wakeEvent,
      constraints: this.deps.skills.describeConstraints(goal.skillIds),
      environment: this.deps.env?.mode ?? 'AGENTIC',
    };
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
  }): Thesis {
    const now = this.now();
    const maxTheses = this.thesisCeiling(input.goalId);
    const live = this.deps.theses.listLiveForGoal(input.goalId).length;
    if (live >= maxTheses) {
      throw new Error(
        `Goal ${input.goalId} already has ${live} live theses (limit ${maxTheses}). Abandon or complete one first.`,
      );
    }

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
      createdAt: now,
      updatedAt: now,
    };

    this.deps.theses.save(thesis);
    return thesis;
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
    if (live.length > 0 && !request.attachToLive) {
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

    for (const previous of this.deps.trackers.listForThesis(thesis.id)) {
      if (previous.lifecycle.status === 'ACTIVE') continue;
      if (permitted && !permitted.has(previous.id)) continue;
      if (alreadyRestored.has(intentKey(previous))) continue;
      try {
        const tracker = sdk.create(thesis.id, {
          purpose: previous.purpose,
          kind: previous.kind,
          config: { ...previous.config },
          ...(previous.symbol ? { symbol: previous.symbol } : {}),
          ...(previous.timeframe ? { timeframe: previous.timeframe } : {}),
          ...(previous.evaluation.priority !== undefined
            ? { priority: previous.evaluation.priority }
            : {}),
          ...(previous.evaluation.cooldownMs !== undefined
            ? { cooldownMs: previous.evaluation.cooldownMs }
            : {}),
        });
        restored.push(tracker.id);
        alreadyRestored.add(intentKey(tracker));
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
   * interpret the event, record evidence, revise the thesis, and adjust
   * what is being watched. The agent gets one pass, and the outcome is
   * recorded whether or not it changed anything.
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
      switch (plan.kind) {
        case 'WAIT':
          break;

        case 'CONFIRM_THESIS': {
          outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS').id);
          outcome.thesis = this.reviseThesis(wake.thesisId, {
            state: 'STRENGTHENING',
            confidence: this.adjustedConfidence(wake.thesis, 0.1),
          });
          break;
        }

        case 'WEAKEN_THESIS': {
          outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'CONTRADICTS').id);
          outcome.thesis = this.reviseThesis(wake.thesisId, {
            state: 'WEAKENING',
            confidence: this.adjustedConfidence(wake.thesis, -0.15),
          });
          break;
        }

        case 'INVALIDATE_THESIS': {
          outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'CONTRADICTS').id);
          outcome.thesis = this.reviseThesis(wake.thesisId, { state: 'INVALIDATED' });
          // A rejected thesis must stop costing wake budget.
          for (const tracker of this.deps.trackers.cancelTrackersForThesis(
            wake.thesisId,
            'Thesis invalidated.',
          )) {
            outcome.trackerChanges.push({ action: 'cancelled', trackerId: tracker.id });
          }
          break;
        }

        case 'REVISE_THESIS': {
          outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS').id);
          outcome.thesis = this.reviseThesis(wake.thesisId, {
            statement: plan.statement,
            invalidation: plan.invalidation,
            confidence: plan.confidence,
            state: 'ACTIVE',
          });
          break;
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
            break;
          }
          if (thesis.state === 'ACTIONABLE') {
            // Already there. Saying so is better than a redundant write, and the
            // next wake can price the trade.
            outcome.thesis = thesis;
            outcome.rejections.push('This thesis is already actionable.');
            break;
          }
          outcome.evidenceRecorded.push(this.recordWakeEvidence(wake, 'SUPPORTS').id);
          try {
            outcome.thesis = this.reviseThesis(wake.thesisId, { state: 'ACTIONABLE' });
          } catch (error) {
            outcome.rejections.push(this.describeRejection(error));
          }
          break;
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
          break;
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
          break;
        }

        case 'PROPOSE_TRADE_IDEA': {
          const ideaId = this.createTradeIdea(wake, plan, outcome);
          if (ideaId) outcome.tradeIdeaId = ideaId;
          break;
        }

        default:
          outcome.rejections.push('Unrecognised plan.');
      }
    } finally {
      // Bounded: an id is only remembered long enough to catch a
      // genuine double delivery.
      if (this.inflight.size > 1_000) this.inflight.clear();
    }

    return outcome;
  }

  /**
   * Turn a wake into evidence.
   *
   * The event itself is recorded verbatim. What the event means for
   * the thesis is the agent's judgement, and that judgement is the
   * `summary`, not the `reason` the runtime produced.
   */
  private recordWakeEvidence(wake: WakeRequest, polarity: 'SUPPORTS' | 'CONTRADICTS'): Evidence {
    return this.recordEvidence({
      thesisId: wake.thesisId,
      polarity,
      summary: `Tracker event: ${wake.event.reason}`,
      source: 'TRACKER_EVENT',
      observed: wake.event.observedValues,
      confidence: wake.event.confidence,
      trackerEventId: wake.event.id,
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

    this.reviseThesis(thesis.id, { state: 'COMPLETED' });
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
