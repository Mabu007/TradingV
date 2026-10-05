/**
 * The GOAT orchestrator.
 *
 * This is the object an application talks to instead of hand-authoring a
 * strategy. It owns the wiring between the reasoning layer (goal,
 * thesis, evidence, plan) and the infrastructure it reasons through (the
 * agent runtime, the tracker runtime, capabilities, policy, risk).
 *
 * The design rule throughout: GOAT adds reasoning, and reuses execution.
 * Every place where a safety property is enforced — capability
 * allowlists, symbol scope, input validation, policy, risk, the LIVE
 * refusal — that enforcement is still the one that runs.
 *
 * Note what this file does *not* own: the trackers. It binds the
 * reasoning layer to a `TrackerRuntime` that the application created, and
 * that runtime is the same object the market-data path evaluates
 * through. There is no second tracker implementation to keep in step.
 */

import { AgentRuntime } from '../agents/runtime';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { AgentWakeEvent } from '../agents/types';
import { capabilityRegistry, CapabilityRegistry } from '../agents/capabilities';
import { agentModel } from '../agents/model/openrouter';
import { skillRegistry, SkillRegistry } from '../agents/skills';
import { IAgentModel, AgentModelRequest, AgentModelResponse } from '../agents/model/types';
import { AgentObservation, AgentPolicy, ITradingEnvironment, TradingAgent } from '../agents/types';
import type { AgentInstance } from '../agents/runtime';
import type { AgentTimelineEventType } from '../agents/timeline/types';
import { styleForEvent, type AgentEventView } from './agentEvents';
import { agentTimeframes } from '../agents/types';

import { GoatLoop, InvestigationRequest, DeploymentContext } from './loop';
import { GOAT_CORE_SKILL, GOAT_CORE_SKILL_ID } from './coreSkill';
import {
  GoatMission,
  RuntimeStatus,
  buildMission,
} from './mission';
import { SteeringStore, SteeringNote } from './steering';
import {
  MarketContext,
  collectMarketContext,
  marketContextEvidence,
  renderMarketContext,
  BAR_COUNT,
} from './marketContext';
import {
  EvidenceStore,
  GoalStore,
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
  PersistentEvidenceStore,
  PersistentGoalStore,
  PersistentThesisStore,
  PersistentTradeIdeaStore,
  ThesisStore,
  TradeIdeaStore,
} from './store';
import { TrackerRuntimeError } from '../agents/trackers/runtime';
import { buildTrackerCapabilities, TrackerSdk, ALL_GOAT_CAPABILITIES } from './trackerSdk';
import { registerAgentTools, AGENT_TOOL_IDS, AGENT_TOOL_GUIDE } from './agentTools';
import { isDataRequirement } from '../agents/trackers/registry';
import {
  InertRuntime,
  type DurableRuntime,
  type RuntimeIdentity,
  type RuntimeReport,
} from './durableRuntime';
import {
  createSessionRegistry,
  staleWorkMessage,
  type GoatSessionIdentity,
  type SessionRegistry,
} from './session';
import { TRACKER_KINDS } from '../agents/trackers/runtime';
import { defaultObservationPlan } from '../agents/trackers/contracts';
import { GoatSkillRegistry, SkillPackage } from './skills';
import {
  DEFAULT_GOAT_TIMEFRAME as CANONICAL_DEFAULT_TIMEFRAME,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_ROLE_LABELS,
  isSupportedTimeframe,
  parseTimeframes,
  resolveTimeframePlan,
  timeframesInStatement,
  type TimeframeRole,
  type TimeframeStrategy,
} from './timeframes';
import { GOAT_BUILTIN_SKILLS } from './builtinSkills';
import { STARTER_GOATS } from './starterGoats';
import { InMemoryDeploymentStore, DeploymentStore, PersistentDeploymentStore } from './deployments';
import { InMemorySkillStore, PersistentSkillStore, SkillDocument, SkillStore, prepareSkillDocument } from './skillStore';
import { configuredVenue, type VenueEnvironment } from '../../config/venue';
import { parseSkillMarkdown, toSkillMarkdown } from './skillMarkdown';
import {
  createGoatDeployment,
  GoatDeployment,
  GoatDeploymentMode,
  ExecutionPermissions,
} from './definition';
import {
  AgentPlan,
  Evidence,
  Goal,
  Thesis,
  TrackerEvent,
  TrackerKind,
  TrackerRequest,
  TradeIdea,
  WakeRequest,
} from './types';

/** The timeframe a GOAT runs on when deployment does not name one. */
export const DEFAULT_GOAT_TIMEFRAME = '15m';

/**
 * How long a GOAT may be stopped before PLAY is a restart rather than a
 * resume.
 *
 * Time passing is information. A tracker armed at a level, a thesis written
 * against a candle, a plan built on momentum — none of that is still true an
 * hour later, so a GOAT that was asleep long enough must re-read the world
 * before it reasons about it again rather than inheriting its own last
 * conclusion as current.
 *
 * Thirty seconds, because that is the shortest gap the product treats as
 * meaningful: half a minute is three 15m candles on a setup timeframe and a
 * moved price, and a level a tracker was armed at is a statement about the
 * world at a moment. A shorter threshold would make an accidental Stop/Play
 * double-tap cost a model call; a longer one would resume a three-hour-old
 * read as though it were current, which is the failure this exists to stop.
 */
export const GOAT_RESTART_REANALYZE_AFTER_MS = 30_000;

/**
 * The timeframes a deployed GOAT may read through its market tools.
 *
 * The timeframe belongs to the GOAT's research process, not to the
 * deployment's identity: a deployment names a market and nothing else, and
 * the agent decides whether to look at 5m, 15m or 4h while working out what
 * it believes. So this is a menu, not a filter.
 */
export const TIMEFRAMES_A_GOAT_MAY_RESEARCH = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const;

/**
 * How long a first investigation's observation plan stays worth budget.
 *
 * Long enough to gather real evidence across a few sessions, short enough
 * that a GOAT which never gets confirmation stops rather than watching
 * forever. The per-goal tracker ceiling is the tighter limit in practice.
 */
export const DEFAULT_INVESTIGATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a GOAT waits before it looks again on its own initiative.
 *
 * Only used when a first pass produced no hypothesis: there is no tracker
 * to wake it, because a tracker has to belong to a thesis and there is no
 * thesis, and inventing one in order to have something to watch would be
 * fabricating the agent's belief. So the GOAT is dormant and comes back
 * once, after a fixed interval — not on a loop.
 *
 * Four bars is long enough that the market has had time to be different and
 * short enough that a user who deployed a GOAT is not left waiting a day.
 */
export const GOAT_RECONSIDER_AFTER_MS = 60 * 60 * 1000;

/**
 * The shortest a reading of someone's objective may be.
 *
 * Long enough to rule out a stray token, short enough that a terse but
 * genuine reading is still accepted.
 */
const MIN_INTERPRETATION_LENGTH = 24;

/**
 * How many times a GOAT may look again on its own before it stops.
 *
 * A bound, not a heuristic. A GOAT that cannot find a hypothesis in a market
 * that is not moving should say so and go quiet, not spend a completion
 * every hour indefinitely. Three looks is enough for a market to change
 * shape; past that the honest answer is that there is nothing to act on.
 */
export const MAX_UNPROMPTED_RECONSIDERATIONS = 3;

/**
 * How many extra rounds of context a first pass may buy.
 *
 * Two, because the useful case is "I need the hour" and "I need 1m as well",
 * and the useless case is a model that keeps asking. The bound is what makes
 * dynamic acquisition safe to offer at all: an unbounded version is a way for
 * one deployment to spend its budget on data acquisition.
 */
export const MAX_CONTEXT_ROUNDS = 2;

/**
 * A model request that is outstanding right now.
 *
 * Real-time, deliberately, even in a simulation whose clock is historical:
 * latency is a property of the call, not of the market being replayed, and a
 * backtest that reported a simulated 4ms model wait would be measuring
 * nothing.
 */
export interface PendingModelRequest {
  /** Real time the request went out. */
  startedAt: number;
  /** What the request is for, in the reader's words. */
  intent: string;
  /** The contract asked for: INVESTIGATION, PLAN, … */
  contract: string;
  /**
   * Which kind of thinking this is.
   *
   * The live state needs to say "BUILDING TRADE PLAN" or "UPDATING TRADE PLAN"
   * rather than one vague word, and parsing that back out of a sentence is how a
   * status indicator starts lying.
   */
  phase: 'FORMING' | 'UPDATING';
}

/**
 * One resolution read for a pass, with the job it is doing.
 *
 * The role and reason travel with the context all the way into the prompt and
 * the log, because "read 1h" and "read 1h for regime" are different claims and
 * only one of them is checkable by a reader.
 */
export interface TimeframeContext {
  context: MarketContext;
  role: TimeframeRole;
  reason: string;
  /** Whether the resolutions were the user's or the agent's choice. */
  strategy: TimeframeStrategy;
}

/**
 * What one model request produced, for the log.
 *
 * Written after the fact from the response itself, so the line cannot claim a
 * hypothesis that was not parsed or a failure that did not happen.
 */
export interface ModelCallReport {
  /** True when the model could not be read at all. */
  failed: boolean;
  /** Machine-readable failure cause, when there was one. */
  code?: string;
  /** Real milliseconds the request took. */
  elapsedMs: number;
  /** What came back, in the log's vocabulary. */
  outcome: string;
}

/**
 * What an investigation did, in words the UI can show verbatim.
 *
 * Every outcome is reported, including the ones that changed nothing. A
 * GOAT that failed to start and a GOAT that started are very different
 * states, and pretending otherwise is how a product ends up showing
 * RUNNING over an agent that is not running.
 */
export interface InvestigationReport {
  /**
   * Whether the GOAT is now running with a thesis behind it.
   *
   * True both when this call did the work and when the GOAT was already
   * investigating, which is why `investigated` exists: "running" and
   * "just started" are different things to tell a user.
   */
  ok: boolean;
  /** True only when this call was the one that formed the thesis. */
  investigated: boolean;
  message: string;
  thesisId?: string;
  trackerIds: string[];
  rejections: string[];
  /**
   * What actually happened, so the UI can say it rather than infer it.
   *
   * The distinction the old boolean could not carry is the whole point:
   * a GOAT that deployed cleanly and formed no thesis is not a deployment
   * failure, and telling someone to redeploy it would be wrong. This was
   * reported as "nothing was deployed" while the deployment was sitting
   * there, running, bound to EUR/USD.
   */
  outcome:
    | 'THESIS_FORMED'
    | 'WAITING'
    | 'NO_THESIS_YET'
    | 'ALREADY_INVESTIGATING'
    | 'MODEL_FAILURE'
    | 'NOT_DEPLOYED';
  /** True once the deployment exists, whatever the model did. */
  deployed: boolean;
}

/** A report for a start that did not happen. Never a partial success. */
function failed(
  message: string,
  outcome: InvestigationReport['outcome'] = 'NOT_DEPLOYED',
  deployed = false,
): InvestigationReport {
  return {
    ok: false,
    investigated: false,
    message,
    trackerIds: [],
    rejections: [],
    outcome,
    deployed,
  };
}

export interface GoatStores {
  goals: GoalStore;
  theses: ThesisStore;
  evidence: EvidenceStore;
  ideas: TradeIdeaStore;
  /** Which market each GOAT is currently pointed at. */
  deployments: DeploymentStore;
  /** Skills the user wrote, as markdown. */
  skills: SkillStore;
  /**
   * Runtime guidance the user has typed into a running GOAT.
   *
   * Optional so a caller can hand the orchestrator nothing but goals; the
   * orchestrator then keeps steering in memory for the session, which is
   * right for a test or a backtest and wrong for an app, so
   * `createGoatStores` always supplies it.
   */
  steering?: SteeringStore;
}

/**
 * Store selection.
 *
 * Persistent by default because "why did GOAT change its mind?" is
 * unanswerable without history, and history that vanishes on reload is
 * not history. In-memory is available for backtests and tests, where
 * writing to the user's browser storage would be actively wrong.
 */
export function createGoatStores(mode: 'PERSISTENT' | 'MEMORY' = 'PERSISTENT'): GoatStores {
  if (mode === 'MEMORY') {
    return {
      goals: new InMemoryGoalStore(),
      theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(),
      ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(),
      skills: new InMemorySkillStore(),
      steering: new SteeringStore('tradinggoats.steering.memory'),
    };
  }
  return {
    goals: new PersistentGoalStore(),
    theses: new PersistentThesisStore(),
    evidence: new PersistentEvidenceStore(),
    ideas: new PersistentTradeIdeaStore(),
    deployments: new PersistentDeploymentStore(),
    skills: new PersistentSkillStore(),
    steering: new SteeringStore(),
  };
}

export interface GoatDeps {
  agentRuntime: AgentRuntime;
  /** The tracker runtime the application already created. */
  trackers: TrackerRuntime;
  env: ITradingEnvironment;
  stores: GoatStores;
  model?: IAgentModel;
  capabilities?: CapabilityRegistry;
  /** The runtime's skill registry, so GOAT skills can be registered into it. */
  skillRegistry?: SkillRegistry;
  clock?: () => number;
  storeMode?: 'PERSISTENT' | 'MEMORY';
  /**
   * The venue environment new deployments are bound to.
   *
   * Supplied by the application rather than read from a module global, so
   * a test or a second window can deploy against Testnet while the rest of
   * the process is configured for Mainnet. When absent, the canonical
   * configured venue is used.
   */
  venueEnvironment?: VenueEnvironment;
  /**
   * The durable runtime that survives the tab being closed.
   *
   * Optional, and absent means "this deployment lives only in this tab". That is a
   * supported configuration rather than a degraded one — a replay never has one —
   * and it is why every call site goes through a report instead of assuming a
   * runtime exists.
   */
  runtime?: DurableRuntime;
  /**
   * The signed-in user's id, for the durable runtime's identity.
   *
   * A function rather than a value so it is read at the moment a deployment
   * happens: a user can sign in between two deployments, and a value captured at
   * construction time would register the second one against the first user's
   * account. Returns undefined when nobody is signed in, which simply means no
   * durable runtime is registered — see `runtimeIdentity`.
   */
  runtimeUserId?: () => string | undefined;
  /**
   * Remote persistence, so a clear is durable.
   *
   * Optional: a replay and most tests have none, and a device-local clear is still
   * a real clear. When present, `clearGoatSession` removes the session's documents
   * as well, so a cleared session does not come back on the next sign-in.
   */
  persistence?: {
    readonly available: boolean;
    clearSession(input: { goalId: string; deploymentId?: string }): Promise<number>;
  };
}

/**
 * What CLEAR removed, and what it kept.
 *
 * Returned rather than logged alone because "cleared" and "appears cleared" are
 * different claims. Every count here is something a caller can assert on, and
 * `kept` is stated positively so the two categories cannot be confused: what is
 * kept is the GOAT, and nothing else.
 */
/**
 * The events a CLEAR leaves behind.
 *
 * All of them describe the clear itself — the runtime stopping, the session being
 * destroyed, a late request being refused — and none describes anything the
 * destroyed session found. They are what makes a cleared GOAT distinguishable from
 * a GOAT that crashed, so they are kept rather than removed; and they are excluded
 * from "does this session have work", because a record of clearing is not work.
 */
const CLEAR_SEQUENCE_EVENTS: ReadonlySet<AgentTimelineEventType> = new Set([
  'SESSION_CLEARED',
  'STALE_WORK_REFUSED',
  'GOAT_STOPPED',
]);

export interface ClearSessionReport {
  /** What the session wrote and no longer exists. */
  deleted: {
    /** Theses — the working thesis and the Trade Plans built from it. */
    theses: number;
    /** Evidence records attached to those theses. */
    evidence: number;
    /** Trade plans, including ones that were never executed. */
    tradePlans: number;
    /** Trackers that existed when the clear began. */
    trackers: number;
    /** Of those, the ones cancelled outright rather than disposed. */
    cancelledTrackers: number;
    /** Agent-log events removed from the timeline store. */
    logEvents: number;
    /** True when a model request was outstanding and has been abandoned. */
    pendingModelRequest: boolean;
    /** Unprompted "look again" attempts discarded. */
    reconsiderations: number;
    /** Recorded model timings discarded. */
    modelTimings: boolean;
    /** Session documents removed from remote persistence, when there is one. */
    remoteDocuments: number;
  };
  /** What CLEAR deliberately left alone. This is the GOAT, and nothing else. */
  kept: {
    goal: boolean;
    market: boolean;
    timeframes: boolean;
    skills: boolean;
    riskConfiguration: boolean;
  };
  /** The session that replaced the one just cleared. */
  session: GoatSessionIdentity;
}

export interface CreateGoatResult {
  agentId: string;
  goal: Goal;
  /**
   * The agent's reading of the goal, before any thesis exists.
   *
   * Returned even when the model is unavailable, because a user who
   * asked for something deserves to be told what is being done with it.
   */
  interpretation: GoalInterpretation;
  /** Trackers the agent deployed while investigating, if any. */
  thesisIds: string[];
  trackerIds: string[];
  /**
   * Set only when creation could not happen at all.
   *
   * Never set for a goal being vague. That concept is gone: see
   * `createGoat`.
   */
  blocked?: string;
}

/**
 * What the agent understood the user to be asking for.
 *
 * Deliberately narrow. The agent may report what it thinks the goal is
 * and what it intends to investigate, but it does not get to restate
 * the user's objective as something narrower without saying so.
 */
export interface GoalInterpretation {
  /** The agent's reading, in its own words. */
  understood: string;
  /** Markets it will investigate. */
  symbols: string[];
  /** Timeframes it judged relevant. */
  timeframes: string[];
  /** What it plans to examine first. */
  investigationPlan: string[];
  /** Anything about the goal it could not resolve. */
  openQuestions: string[];
  /** Whether the goal was specific enough to act on. */
  actionable: boolean;
}

/**
 * The system GOAT applications instantiate.
 */
export class GoatOrchestrator {
  readonly skills: GoatSkillRegistry;
  readonly loop: GoatLoop;
  readonly trackers: TrackerRuntime;
  readonly stores: GoatStores;
  private readonly sdkByAgent = new Map<string, TrackerSdk>();
  private readonly steeringStore: SteeringStore;
  private readonly model: IAgentModel;
  private readonly capabilities: CapabilityRegistry;
  private readonly clock?: () => number;
  private sequence = 0;
  /** Agents with an investigation in flight, so a start cannot double up. */
  private readonly investigating = new Set<string>();
  /**
   * Trackers each agent's last stop cancelled.
   *
   * The resume path restores exactly these. Without the record, a resume
   * cannot tell an interrupted watch from one cancelled two pauses ago,
   * and restores both.
   */
  private readonly stoppedTrackers = new Map<string, string[]>();
  /**
   * Pending "look again" timers, one per agent.
   *
   * A GOAT whose first pass produced no thesis has no tracker to wake it, so
   * it would otherwise be dormant forever — deployed, running, holding no
   * view and never looking again. One timer per agent, cleared on stop and
   * on archive, so it can neither double up nor outlive its deployment.
   */
  private readonly reconsiderTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Whether a GOAT has promised to look again and still means to.
   *
   * Exposed because "this will be retried" is a claim the product makes to
   * a user, and a claim like that has to be checkable rather than asserted.
   */
  hasPendingReconsideration(agentId: string): boolean {
    return this.reconsiderTimers.has(agentId);
  }
  /** Consecutive unprompted looks that produced no hypothesis. */
  private readonly noThesisLooks = new Map<string, number>();
  /**
   * Resolutions this agent's market could not supply, learned once and kept.
   *
   * Keyed `agentId → symbol:timeframe`. Whether a resolution exists is a
   * property of the market for this deployment, so re-deciding it on every wake
   * was answering a question whose answer does not change — each wake paying
   * for a read that was already known to fail, and then asking a model to
   * request it again.
   *
   * Scoped to the agent rather than the process: a new deployment, and a CLEAR,
   * both produce a new agent id and therefore re-probe, which is correct
   * because the market behind the agent may have changed. Nothing here is
   * persisted, so there is no cache to invalidate and no global state to leak
   * between users.
   */
  private readonly unavailableResolutions = new Map<string, Set<string>>();
  /**
   * Record that a resolution cannot be read, or return the ones already known.
   *
   * A `getMarketBars` failure is recorded; a context that came back with
   * limitations is recorded too, since a resolution with no candles behind it is
   * the same dead end reached by a different route.
   */
  private noteUnavailableResolution(agentId: string, symbol: string, timeframe: string): void {
    const key = `${symbol}:${timeframe}`;
    const known = this.unavailableResolutions.get(agentId);
    if (known) {
      known.add(key);
      return;
    }
    this.unavailableResolutions.set(agentId, new Set([key]));
  }

  private knownUnavailableResolutions(agentId: string): ReadonlySet<string> {
    return this.unavailableResolutions.get(agentId) ?? new Set<string>();
  }

  /**
   * State the runtime already knows, so the model is not asked to find it.
   *
   * These constraints are computed from skills and recorded evidence before
   * any call is made, and they were previously only ever rendered for the
   * person watching. A GOAT told only what its tools returned would read an
   * absent coarser resolution as something to go and request — which is how a
   * known-unavailable timeframe got asked for on every wake. Told up front, it
   * can plan within what the market actually offers.
   *
   * Wording is deliberately informational: these are unmet conditions, not a
   * prohibition. The runtime reports them rather than enforcing them, and a
   * prompt that implied otherwise would turn a reported condition into an
   * invented one.
   */
  private renderKnownConstraints(goalId: string): string {
    const constraints = this.loop.outstandingConstraints(goalId);
    if (constraints.length === 0) return '';
    return [
      'KNOWN CONDITIONS — already determined for this market, not something you need to discover:',
      ...constraints.map((constraint) => `- ${constraint}`),
      'Plan within these. Do not request a resolution already reported as unavailable, and do not ask for the confirmation above — it is recorded as outstanding and surfaced to the person who wrote your goal.',
    ].join('\n');
  }
  /**
   * Model requests that are outstanding right now, one per agent.
   *
   * This is what lets a surface answer "is it working or is it stuck?" without
   * guessing from timestamps. While an entry exists the GOAT is not watching
   * the market and not idle: it is blocked on an external dependency, which is
   * a state the product previously reported as WATCHING — the single most
   * misleading thing the agent log said.
   *
   * Keyed by agent so two GOATs cannot mask each other, and always cleared in
   * a `finally`, so a model that throws cannot leave a GOAT permanently
   * "waiting for the model".
   */
  private readonly pendingModels = new Map<string, PendingModelRequest>();
  /**
   * How long each model call actually took, per agent.
   *
   * Kept out of the log on purpose. Latency is real and worth knowing, but a
   * line per call to report a number nobody asked for is the same noise problem
   * as the heartbeat, and the number is only interesting in aggregate — "this
   * replay spent nine seconds waiting on the model across thirty calls" — which
   * is a report question, not a log question.
   *
   * Bounded, and it is the runtime's own measurement rather than something a
   * surface infers from timestamps.
   */
  private readonly modelCalls = new Map<string, Array<{ at: number; elapsedMs: number; phase: 'FORMING' | 'UPDATING' }>>();

  /**
   * Bumped whenever a GOAT's runtime is rebuilt under an in-flight request.
   *
   * The stale-reply hazard, closed. Clearing `pendingModels` on a refresh stops
   * the *indicator* from lying, but the call that was already awaiting the model
   * is still holding a promise: when it comes back it will parse the answer and
   * apply it — forming a Trade Plan and arming conditions on a runtime the user
   * has just deliberately emptied.
   *
   * A generation counter is the smallest thing that distinguishes "this answer
   * belongs to the runtime that asked" from "this answer belongs to the one
   * before the refresh", without threading a cancellation signal through every
   * reasoning path.
   */
  private readonly runtimeGeneration = new Map<string, number>();

  /** The generation an agent's runtime is currently at. */
  runtimeGenerationFor(agentId: string): number {
    return this.runtimeGeneration.get(agentId) ?? 0;
  }

  private bumpRuntimeGeneration(agentId: string): number {
    const next = this.runtimeGenerationFor(agentId) + 1;
    this.runtimeGeneration.set(agentId, next);
    return next;
  }

  /**
   * The durable runtime, never null.
   *
   * Held as a field rather than read from `deps` at each call site, so there is
   * exactly one place that answers "is there a durable runtime here" and no call
   * site that can forget to ask.
   */
  private readonly runtime: DurableRuntime;

  /**
   * Session identities, and the one place stale work is refused.
   *
   * Held on the orchestrator rather than in a module global so that a second
   * instance — a test, a second window — has its own view of which session is
   * current, and a callback cannot be validated against another instance's state.
   */
  private readonly sessions: SessionRegistry;

  /**
   * The session each in-flight operation belongs to, while it is running.
   *
   * This is what stops a stale operation from writing to the activity log. The
   * generation check elsewhere refuses the *mutation* — the plan, the evidence, the
   * trackers — but a wake that was already inside `reason()` would still have
   * recorded "reading the market" and "asked the model" after the clear, leaving
   * exactly the kind of residue CLEAR promises is gone.
   *
   * Keyed by agent, set for the duration of a wake, and consulted by
   * `recordActivity`. An operation that has already finished has removed itself, so
   * nothing else is affected.
   */
  private readonly inFlightSessions = new Map<string, GoatSessionIdentity>();

  constructor(private readonly deps: GoatDeps) {
    this.runtime = deps.runtime ?? new InertRuntime();
    this.sessions = createSessionRegistry(() => this.now());
    this.stores = deps.stores;
    this.steeringStore = deps.stores.steering ?? new SteeringStore('tradinggoats.steering.memory');
    this.capabilities = deps.capabilities ?? capabilityRegistry;
    this.model = deps.model ?? agentModel;
    this.clock = deps.clock;

    this.skills = new GoatSkillRegistry({
      knownCapabilityIds: () => this.capabilityIds(),
    });
    this.skills.registerAll(GOAT_BUILTIN_SKILLS);
    this.loadUserSkills();

    /*
     * Bind, do not wrap.
     *
     * The runtime is the real one: the same object the market-data path
     * evaluates through, holding the same registry. The only thing added
     * here is the three-function binding the runtime needs in order to
     * know who a tracker belongs to, so an observation can be woken
     * against a thesis.
     */
    this.trackers = deps.trackers;
    this.trackers.bindDomain({
      resolveThesis: (thesisId) => this.stores.theses.get(thesisId),
      resolveSkillIds: (agentId) => {
        const goal = this.stores.goals.getForAgent(agentId);
        return goal?.skillIds ?? [];
      },
      onEvent: (event) => this.handleTrackerEvent(event),
    });

    this.registerTrackerCapabilities();
    this.registerCoreSkill();
    this.mirrorSkillsIntoRuntimeRegistry();

    this.loop = new GoatLoop({
      goals: this.stores.goals,
      theses: this.stores.theses,
      evidence: this.stores.evidence,
      ideas: this.stores.ideas,
      trackers: this.trackers,
      skills: this.skills,
      sdkFor: (agentId) => this.sdkFor(agentId),
      clock: deps.clock,
      env: this.deps.env,
      currentDeployment: (agentId) => this.deploymentContextFor(agentId),
    });

    /*
     * Registered after the loop exists, because the thesis and decision
     * tools call back into it. A definition may therefore name
     * `thesis.update` and `trades.proposeIdea`; before this ran they
     * were silently filtered out as unregistered, and a GOAT would have
     * been built that could read the market and never its own mind.
     */
    registerAgentTools(this.loop, this.capabilities);
  }

  /**
   * Turn a skill on or off.
   *
   * Not decoration: the runtime resolves a skill's capabilities from the
   * enabled set, and `AgentRuntime` refuses to start an agent referencing a
   * disabled skill — so switching one off really does take the capability
   * away from GOATs built on it. Built-in skills can be disabled because
   * they are preferences rather than safety properties; the rules a disabled
   * skill was enforcing stop with it, which is the honest consequence and is
   * why the surface says so.
   */
  setSkillEnabled(skillId: string, enabled: boolean): SkillPackage {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Unknown skill ${skillId}.`);
    return this.skills.update({ ...skill, enabled });
  }

  /** The tool guidance injected wherever the agent reasons. */
  get toolGuide(): string {
    return AGENT_TOOL_GUIDE;
  }

  private now(): number {
    return this.clock ? this.clock() : Date.now();
  }

  /**
   * The model request a GOAT is blocked on, when it has one.
   *
   * Exposed for the read model rather than for the surface: a status dot that
   * asks the orchestrator what phase its GOAT is in cannot disagree with the
   * events the orchestrator wrote, because they are the same fact.
   */
  pendingModelRequest(agentId: string): PendingModelRequest | undefined {
    return this.pendingModels.get(agentId);
  }

  /**
   * Whether *any* GOAT is waiting on a model right now.
   *
   * The per-agent question is the one a surface normally asks, because a screen
   * is about one GOAT. This exists for the window before an agent exists — a
   * first pass whose goal is still being interpreted — and for a replay, where
   * "is the run holding for its agent" is a fact about the run rather than about
   * an id the run has not been given yet.
   */
  hasPendingModelRequest(): boolean {
    return this.pendingModels.size > 0;
  }

  /**
   * What this GOAT's model calls cost, in real time.
   *
   * Exposed for the report a replay produces. Empty rather than zero-filled for
   * an agent that has never been asked anything, so "no model calls" cannot be
   * mistaken for "the model was instantaneous".
   */
  modelCallStats(agentId: string): { calls: number; totalMs: number; slowestMs: number } {
    const calls = this.modelCalls.get(agentId) ?? [];
    return {
      calls: calls.length,
      totalMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0),
      slowestMs: calls.reduce((slowest, call) => Math.max(slowest, call.elapsedMs), 0),
    };
  }

  /**
   * Ask the model, and make the waiting visible while it happens.
   *
   * Every reasoning step in this system goes through here, which is the only
   * reason the log can be honest about model latency. Three things are written
   * around the call, and each corresponds to a real transition:
   *
   *   MODEL_REQUEST   the request went out, with what was in it
   *   MODEL_FAILURE   it came back unreadable, with the cause
   *
   * The pending entry is registered before the call and cleared in a `finally`,
   * so a surface can render "waiting for the model" for exactly as long as
   * that is true. Nothing here is generated for display: no request means no
   * line, a fast answer means one line, and a slow one says how slow it
   * actually was rather than performing thought.
   */
  private async callModel(options: {
    agentId: string;
    deploymentId?: string;
    /** Forming a plan for the first time, or updating one after evidence. */
    phase: 'FORMING' | 'UPDATING';
    /** What this request is for, in words a reader would use. */
    intent: string;
    /** What was submitted, for the log's detail line. */
    submitted: Record<string, number | string>;
    request: AgentModelRequest;
  }): Promise<{ response: AgentModelResponse; report: ModelCallReport }> {
    const { agentId, deploymentId, phase, intent, submitted, request } = options;

    const startedAt = Date.now();
    this.pendingModels.set(agentId, {
      startedAt,
      intent,
      phase,
      contract: request.contract ?? 'DECISION',
    });

    /*
     * One line, on the way out. Nothing on the way back unless it failed.
     *
     * There used to be a heartbeat here, one line every ten seconds for as long
     * as the call took. It was honest — a real elapsed time against a real
     * pending request — and it was still noise: the reader had already been told
     * the request went out, and a dozen identical lines do not make a GOAT look
     * busier, they make the log unreadable. So the waiting is carried by the
     * live state instead, which pulses for exactly as long as this promise is
     * outstanding, and the log is left with the events that changed something.
     *
     * The outcome line is the caller's to write, because only the caller knows
     * what the answer meant: a plan, a revision, a refusal. A generic "answered"
     * line beside it would be the second description of one event.
     */
    this.recordActivity({
      goatId: agentId,
      deploymentId,
      agentId,
      type: 'MODEL_REQUEST',
      data: { intent, phase, contract: request.contract ?? 'DECISION', ...submitted },
    });

    try {
      const response = await this.model.run(request);
      const report = this.reportModelOutcome(
        response,
        Date.now() - startedAt,
        request.contract ?? 'DECISION',
      );
      this.recordModelCall(agentId, report.elapsedMs, phase);
      if (report.failed) {
        this.recordActivity({
          goatId: agentId,
          deploymentId,
          agentId,
          type: 'MODEL_FAILURE',
          data: {
            intent,
            phase,
            outcome: report.outcome,
            elapsedMs: report.elapsedMs,
            ...(report.code ? { code: report.code } : {}),
          },
        });
      }
      return { response, report };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      this.recordModelCall(agentId, elapsedMs, phase);
      this.recordActivity({
        goatId: agentId,
        deploymentId,
        agentId,
        type: 'MODEL_FAILURE',
        data: {
          intent,
          phase,
          outcome: 'The request threw before it could be read.',
          code: 'REQUEST_THREW',
          elapsedMs,
        },
      });
      // Re-thrown, so the caller's own failure handling stays in charge.
      throw error;
    } finally {
      this.pendingModels.delete(agentId);
    }
  }

  /** One measured call, kept so a report can talk about time honestly. */
  private recordModelCall(
    agentId: string,
    elapsedMs: number,
    phase: 'FORMING' | 'UPDATING',
  ): void {
    const calls = this.modelCalls.get(agentId) ?? [];
    calls.push({ at: Date.now(), elapsedMs, phase });
    if (calls.length > 500) calls.splice(0, calls.length - 500);
    this.modelCalls.set(agentId, calls);
  }

  /**
   * What a model response turned out to be.
   *
   * Pure, and derived from the response rather than from the caller's
   * interpretation of it, so two reasoning paths cannot describe the same
   * answer differently.
   */
  private reportModelOutcome(
    response: AgentModelResponse,
    elapsedMs: number,
    contract: string,
  ): ModelCallReport {
    if (response.unavailable) {
      return { failed: true, code: response.unavailable.code, elapsedMs, outcome: 'The model could not be reached.' };
    }
    if (response.malformed) {
      return { failed: true, code: 'MALFORMED_RESPONSE', elapsedMs, outcome: 'The response could not be read.' };
    }
    if (response.toolCall) {
      return { failed: true, code: 'TOOL_CALL_RESPONSE', elapsedMs, outcome: 'The model asked for tools instead of answering.' };
    }
    if (contract === 'INVESTIGATION') {
      const thesis = isRecord(response.payload?.['thesis']) ? 'a hypothesis' : 'no hypothesis';
      const trackers = Array.isArray(response.payload?.['trackers'])
        ? (response.payload?.['trackers'] as unknown[]).length
        : 0;
      return {
        failed: false,
        elapsedMs,
        outcome: `Answered with ${thesis} and ${trackers} proposed ${trackers === 1 ? 'condition' : 'conditions'}.`,
      };
    }
    const kind = typeof response.payload?.['kind'] === 'string' ? response.payload['kind'] : 'nothing recognisable';
    return { failed: false, elapsedMs, outcome: `Answered: ${kind}.` };
  }

  /**
   * Write one durable record of something the runtime actually did.
   *
   * Best-effort by design, and never awaited by the caller: an activity
   * feed that can fail a deployment is worse than no activity feed, and a
   * browser that refuses storage must still let a GOAT reason. Nothing
   * here is ever generated for display — if no transition happened, no
   * record is written.
   */
  recordActivity(event: {
    goatId: string;
    deploymentId?: string;
    agentId: string;
    type: AgentTimelineEventType;
    data: unknown;
  }): void {
    /*
     * Refuse activity from a superseded session.
     *
     * The check is by agent, because that is what an activity event carries, and
     * it is deliberately conservative: while an operation is in flight for an
     * agent, anything recorded against that agent must belong to that operation's
     * session or it is residue from a session the user has already cleared.
     */
    const inflight = this.inFlightSessions.get(event.goatId);
    if (inflight !== undefined && !this.sessions.isCurrent(inflight)) return;

    const timestamp = this.now();
    const id = `act_${timestamp.toString(36)}_${(this.sequence = this.sequence + 1).toString(36)}`;

    try {
      void this.deps.agentRuntime
        .getTimelineStore()
        .append({
          id,
          agentId: event.agentId,
          goatId: event.goatId,
          deploymentId: event.deploymentId,
          timestamp,
          type: event.type,
          environment: this.deps.env.mode,
          data: event.data,
        })
        .catch(() => undefined);
    } catch {
      // A store that cannot accept an event must not stop the runtime.
    }
  }

  /**
   * The activity feed for one GOAT, oldest first.
   *
   * Read straight from the durable timeline, so it survives a reload and
   * is the same sequence the runtime wrote rather than a reconstruction.
   * Every entry is a record that something happened: nothing is synthesised
   * for display, which is why a GOAT that has done nothing returns nothing.
   */
  activityFor(goalId: string, limit = 40): GoatActivityEntry[] {
    return this.agentLog(goalId, limit).map((entry) => ({
      id: entry.id,
      at: entry.at,
      type: entry.type as AgentTimelineEventType,
      text: entry.headline,
    }));
  }

  /**
   * The agent log: one resolved view per recorded event.
   *
   * `activityFor` flattens each event to a single sentence, which is all a
   * list needs. A log needs the event's *kind* and *weight* as well, and it
   * needs them decided by the same code that produced the event rather than
   * guessed by each surface — two views of one feed that disagree about
   * whether something was critical is worse than one view.
   *
   * So the classification happens here, on the way out of the runtime, and
   * the UI renders what it is given. Still no synthesis: a GOAT that has done
   * nothing returns nothing, and every line here corresponds to a record.
   */
  agentLog(goalId: string, limit = 200): AgentEventView[] {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return [];
    try {
      const store = this.deps.agentRuntime.getTimelineStore();
      if (!store.snapshotByGoat) return [];
      return store.snapshotByGoat(goal.agentId, limit).map((event) => {
        const record = isRecord(event.data) ? event.data : {};
        const style = styleForEvent(event.type);
        const headline = describeActivity(event.type, event.data).replace(/\.$/, '');
        return {
          id: event.id,
          at: event.timestamp,
          type: event.type,
          headline,
          ...(detailForActivity(event.type, record) ? { detail: detailForActivity(event.type, record) } : {}),
          ...(artifactForActivity(event.type, record) ? { artifact: artifactForActivity(event.type, record) } : {}),
          style,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * The number of events recorded for this GOAT since a point in time.
   *
   * Used to decide whether a surface has anything new to show without
   * re-rendering the whole feed. Counting is cheaper than projecting, and a
   * log that is watched for hours is mostly not changing.
   */
  activityCountSince(goalId: string, since: number): number {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return 0;
    try {
      const store = this.deps.agentRuntime.getTimelineStore();
      if (!store.snapshotByGoat) return 0;
      let count = 0;
      for (const event of store.snapshotByGoat(goal.agentId)) {
        if (event.timestamp > since) count += 1;
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Observe recorded events for one GOAT.
   *
   * The push path a live log needs. `subscribe` is optional on the store, so
   * this returns no subscription when the store cannot provide one and the
   * caller keeps polling — degradation, never a blank screen.
   */
  observeActivity(goalId: string, listener: () => void): () => void {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return () => undefined;
    const store = this.deps.agentRuntime.getTimelineStore();
    if (!store.subscribe) return () => undefined;
    // Filtered here rather than in the store: the store knows about events,
    // and only this layer knows which GOAT an event belongs to.
    return store.subscribe((event) => {
      if (event.goatId === goal.agentId || event.agentId === goal.agentId) listener();
    });
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.now().toString(36)}_${this.sequence.toString(36)}`;
  }

  /** Every capability id the registry knows, for skill validation. */
  private capabilityIds(): string[] {
    return [
      ...this.capabilities.list().map((c) => c.id),
      ...ALL_GOAT_CAPABILITIES,
      ...Object.values(AGENT_TOOL_IDS),
    ];
  }

  /**
   * Register the tracker capabilities.
   *
   * Bound to this orchestrator's runtime rather than registered as
   * unbound stubs, so a capability call reaches the runtime that
   * actually owns the trackers.
   */
  private registerTrackerCapabilities(): void {
    const bound = buildTrackerCapabilities({
      runtime: this.trackers,
      getSdk: (agentId) => this.sdkFor(agentId),
    });
    for (const capability of bound) {
      if (!this.capabilities.has(capability.id)) {
        this.capabilities.register(capability);
      }
    }
  }

  /**
   * Register the internal baseline skill.
   *
   * Done before the GOAT skills are mirrored, and idempotent, so a second
   * orchestrator in the same process does not fail on a duplicate id.
   */
  private registerCoreSkill(): void {
    const runtimeSkills = this.deps.skillRegistry ?? skillRegistry;
    if (runtimeSkills.has(GOAT_CORE_SKILL_ID)) return;
    runtimeSkills.register(GOAT_CORE_SKILL);
  }

  /**
   * Make GOAT skills visible to the existing agent runtime.
   *
   * `AgentRuntime.registerAgent` refuses an agent whose skills are not
   * in the runtime's own `SkillRegistry`. That check is load-bearing and
   * is kept: a GOAT skill still has to be a real, enabled skill before
   * an agent may reference it.
   *
   * So GOAT skills are projected into that registry rather than
   * bypassing it. The projection is a one-way, narrowing translation:
   * it carries the instruction text and the required capabilities, and
   * adds no authority the GOAT skill did not already have. The richer
   * per-phase guidance, constraints and evaluators stay in the GOAT
   * registry, which is the one the loop reads.
   */
  private mirrorSkillsIntoRuntimeRegistry(): void {
    for (const skill of this.skills.list()) this.mirrorSkillIntoRuntimeRegistry(skill);
  }

  /**
   * Project one GOAT skill into the agent runtime's own registry.
   *
   * A skill written after start-up has to be projected too, or a GOAT
   * created a moment later would reference a skill the runtime refuses
   * to accept. Same one-way, narrowing translation either way.
   */
  private mirrorSkillIntoRuntimeRegistry(skill: SkillPackage): void {
    const runtimeSkills = this.deps.skillRegistry ?? skillRegistry;
    if (runtimeSkills.has(skill.id)) return;
    runtimeSkills.register({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      requiredCapabilities: [
        ...(skill.requiredCapabilities ?? []),
        ...(skill.grants ?? []),
      ],
      enabled: skill.enabled,
    });
  }

  // ---------------------------------------------------------------------
  // User-authored skills
  // ---------------------------------------------------------------------

  /**
   * Load every stored skill document into the registry.
   *
   * A document that no longer parses is skipped and reported rather than
   * allowed to throw, so one bad file cannot make every GOAT unusable.
   */
  loadUserSkills(): { loaded: string[]; problems: string[] } {
    const loaded: string[] = [];
    const problems: string[] = [];
    for (const document of this.stores.skills.list()) {
      const parsed = parseSkillMarkdown(document.markdown);
      if (!parsed.ok || !parsed.skill) {
        problems.push(`Skill "${document.id}" was not loaded: ${parsed.problems.join(' ')}`);
        continue;
      }
      if (this.skills.has(parsed.skill.id)) continue;
      try {
        this.skills.register(parsed.skill);
        this.mirrorSkillIntoRuntimeRegistry(parsed.skill);
        loaded.push(parsed.skill.id);
      } catch (error) {
        problems.push(
          `Skill "${document.id}" was not loaded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { loaded, problems };
  }

  /** Every skill the user has written, newest last. */
  listUserSkills(): SkillDocument[] {
    return this.stores.skills.list();
  }

  /** The markdown of a stored skill, for editing or export. */
  getUserSkill(id: string): SkillDocument | undefined {
    return this.stores.skills.get(id);
  }

  /**
   * Validate, store and register a skill the user wrote.
   *
   * Refused rather than partially accepted: a skill with a broken
   * constraint is a rule the user believes is in force, and a skill the
   * GOAT silently ignores is worse than one that was never saved.
   */
  saveUserSkill(markdown: string): { skill?: SkillPackage; document?: SkillDocument; problems: string[] } {
    const prepared = prepareSkillDocument({
      markdown,
      now: this.now(),
      previous: undefined,
    });
    if (!prepared.skill || !prepared.document) {
      return { problems: prepared.problems };
    }
    try {
      this.skills.upsert(prepared.skill);
    } catch (error) {
      return { problems: [error instanceof Error ? error.message : String(error)] };
    }
    this.mirrorSkillIntoRuntimeRegistry(prepared.skill);
    this.stores.skills.save(prepared.document);
    return { skill: prepared.skill, document: prepared.document, problems: [] };
  }

  /** Remove a user-authored skill. Built-in skills are not stored here. */
  deleteUserSkill(id: string): boolean {
    if (!this.stores.skills.remove(id)) return false;
    this.skills.remove(id);
    for (const goal of this.stores.goals.list()) {
      if (!goal.skillIds.includes(id)) continue;
      const remaining = goal.skillIds.filter((skillId) => skillId !== id);
      this.stores.goals.save({ ...goal, skillIds: remaining, updatedAt: this.now() });
    }
    return true;
  }

  /** Markdown for any skill, stored or built-in, for export. */
  exportSkill(id: string): string | undefined {
    const stored = this.stores.skills.get(id);
    if (stored) return stored.markdown;
    const skill = this.skills.get(id);
    return skill ? toSkillMarkdown(skill) : undefined;
  }

  /** The operator guidance a GOAT has been given, oldest first. */
  steeringFor(goalId: string | undefined): SteeringNote[] {
    if (!goalId) return [];
    return this.steeringStore.listFor(goalId);
  }

  /**
   * Tell a running GOAT something.
   *
   * The instruction is recorded, then the GOAT is woken, so it is applied
   * by a reasoning step rather than applied to the GOAT. Nothing about the
   * goal, the thesis or the observation plan is rewritten here: what
   * changes is what the agent decides the next time it wakes.
   */
  async steerGoat(goalId: string, text: string): Promise<{ note: SteeringNote; woke: boolean }> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);

    const note = this.steeringStore.record({
      goalId,
      text,
      now: this.now(),
      stageAtSend: this.deps.agentRuntime.getAgent(goal.agentId)?.isRunning ? 'RUNNING' : 'UNDEPLOYED',
    });

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: this.stores.deployments.currentFor(goal.agentId)?.id,
      agentId: goal.agentId,
      type: 'GOAT_STEERED',
      data: { instruction: text, stageAtSend: note.stageAtSend },
    });

    const woke = await this.wakeForSteering(goal);
    /*
     * Re-read rather than return the snapshot.
     *
     * The note is very often consumed by that same call — a GOAT with a live
     * thesis is woken by the note and reads it during that pass — so
     * returning the pre-wake copy handed the caller a note claiming to be
     * unread at the moment it had been read. A caller checking
     * `appliedAt` to decide what to show would show the wrong thing.
     */
    return { note: this.steeringStore.get(note.id) ?? note, woke };
  }

  /**
   * Wake a GOAT so a steering note is actually read.
   *
   * A note nobody has woken up for changes nothing, and silence reads to
   * the user as the app ignoring them.
   *
   * A note is marked read only once a reasoning pass has really consumed
   * it. It used to be marked applied the moment it arrived, which cleared
   * the "reading your instruction" indicator and told the user their
   * guidance had been taken while the GOAT was asleep and had seen nothing.
   * A GOAT with a live thesis has no cheap way to be woken — it wakes on
   * evidence, which is the whole point of it — so the note simply waits,
   * visibly, for the next tracker event.
   */
  /**
   * Steering is an input into the loop, not a note beside it.
   *
   * This used to return `false` whenever the GOAT already held a live thesis
   * — which is the normal case, because a GOAT with a thesis is watching and
   * asleep. So the commonest possible steering did nothing at all: the note
   * sat in the store unread, the interface said "reading 1 instruction you
   * gave it" forever, and the agent log showed the user's request followed by
   * silence. From the user's side that is a frozen agent, and it was the
   * single most damaging behaviour in the product.
   *
   * So a note now re-enters the loop exactly the way a tracker firing does:
   * the model is asked what the instruction means for the *current* thesis,
   * against *current* market context, and the plan it returns is applied by
   * the same code path that applies every other plan — including the skill
   * constraints, the invalidation rule and the trade-plan gate. Steering gets
   * no privilege and no shortcut; it only gets to go first.
   *
   * What it still must not do is rewrite the user's goal. The instruction is
   * guidance for the next reasoning step, and `buildContext` is given the same
   * unchanged goal, so "reconsider the breakout" informs the next plan
   * without silently becoming a new objective.
   */
  private async wakeForSteering(goal: Goal): Promise<boolean> {
    const instance = this.deps.agentRuntime.getAgent(goal.agentId);
    if (!instance || !instance.isRunning) return false;

    const live = this.stores.theses.listLiveForGoal(goal.id);

    // Nothing to reassess yet: the instruction shapes the first pass instead.
    if (live.length === 0) {
      const report = await this.investigateGoal(goal.id, { redeploy: true });
      if (report.investigated) this.markLatestSteeringApplied(goal);
      /*
       * A note the agent could not read is not a note still waiting to be
       * read. Leaving it pending produced the exact symptom this whole path
       * exists to remove — "Reading 1 instruction you gave it", permanently,
       * on a GOAT that had already been told the model was unreachable. It is
       * retired either way, and the failure is recorded where the user can see
       * it, so nothing is silently swallowed.
       */
      if (!report.investigated) this.markLatestSteeringApplied(goal);
      return report.investigated;
    }

    const thesis = live[0];
    const deployment = this.stores.deployments.currentFor(goal.agentId);
    if (!deployment) return false;

    const note = this.steeringStore.recentFor(goal.id, 1)[0];
    const instruction = note?.text ?? 'reconsider the current plan';

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_REASSESSING',
      data: { reason: 'Operator instruction', thesisId: thesis.id, market: deployment.marketId },
    });

    const wake: WakeRequest = {
      thesisId: thesis.id,
      goalId: goal.id,
      agentId: goal.agentId,
      /*
       * A real event id, derived from the note, so two pieces of guidance in
       * a row are two passes rather than one deduplicated delivery, and so
       * a replayed request cannot re-consume a note already read.
       */
      event: {
        id: `steer_${note?.id ?? thesis.id}`,
        trackerId: '',
        agentId: goal.agentId,
        kind: 'CUSTOM',
        eventType: 'CUSTOM',
        timestamp: this.now(),
        environment: this.deps.env.mode === 'LIVE' ? 'DEMO' : this.deps.env.mode,
        symbol: deployment.marketId,
        reason: `Operator asked the GOAT to reconsider: ${instruction}`,
        priority: 0,
        severity: 'INFO',
        source: 'STEERING',
      },
      thesis,
      relatedEvents: [],
      skillIds: goal.skillIds,
      createdAt: this.now(),
    };

    try {
      const outcome = await this.runWake(wake);
      /*
       * The note is consumed by the pass, whatever that pass concluded.
       *
       * A `WAIT` is a real answer to "reconsider this" — the agent read the
       * instruction, weighed it against the market, and concluded the current
       * reading still stands. Leaving the note pending in that case is what
       * produced the permanent "reading 1 instruction you gave it" state, so
       * the note is retired once a reasoning step has actually seen it.
       */
      this.markLatestSteeringApplied(goal);
      return outcome !== undefined;
    } catch (error) {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'GOAT_WAITING',
        data: {
          message: `The GOAT could not act on that instruction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      return false;
    }
  }

  /** Called by the reasoning paths that actually injected the note. */
  private markLatestSteeringApplied(goal: Goal): void {
    const latest = this.steeringStore.recentFor(goal.id, 1)[0];
    if (latest && latest.appliedAt === undefined) {
      this.steeringStore.markApplied(latest.id, this.now());
    }
  }

  /**
   * The wake a restart uses.
   *
   * A real event with a real cause, so it enters the loop through exactly the
   * path a tracker firing uses — fresh market read, the same prompt, the same
   * skill constraints, the same plan gate. Restarting gets no special route
   * into the engine, which is the point: a restart that re-derived its own
   * logic would be a second state machine.
   *
   * The restored watchers are named in the reason so the pass can judge them
   * rather than inherit them. It is told they are unverified, because they
   * were armed before the gap and the world has moved since.
   */
  private restartWake(
    goal: Goal,
    deployment: GoatDeployment,
    thesis: Thesis,
    restoredTrackers: string[],
  ): WakeRequest {
    const restored = restoredTrackers
      .map((id) => this.trackers.get(id)?.purpose)
      .filter((purpose): purpose is string => typeof purpose === 'string' && purpose.length > 0);

    return {
      thesisId: thesis.id,
      goalId: goal.id,
      agentId: goal.agentId,
      event: {
        id: `restart_${deployment.id}_${deployment.updatedAt.toString(36)}`,
        trackerId: '',
        agentId: goal.agentId,
        kind: 'CUSTOM',
        eventType: 'CUSTOM',
        timestamp: this.now(),
        environment: this.deps.env.mode === 'LIVE' ? 'DEMO' : this.deps.env.mode,
        symbol: deployment.marketId,
        reason:
          'The GOAT was stopped and has restarted. Reassess the thesis against the current market ' +
          'before continuing, and restate what is worth watching.' +
          (restored.length > 0
            ? ` These watches were armed before the gap and are unverified: ${restored.join('; ')}.`
            : ' There is nothing currently being watched.'),
        priority: 0,
        severity: 'INFO',
        source: 'RESTART',
      },
      thesis,
      relatedEvents: [],
      skillIds: goal.skillIds,
      createdAt: this.now(),
    };
  }

  /**
   * The tracker SDK for an agent.
   *
   * A live handle on the grant set rather than a snapshot, so revoking
   * `trackers.create` takes effect immediately instead of at the next
   * registration.
   */
  /**
   * The watch ceiling this agent's goal's skills impose.
   *
   * Undefined when no active skill states one, which means "no ceiling from
   * skills" rather than "no ceiling at all" — the runtime's own per-thesis,
   * per-agent and global limits still apply underneath.
   */
  private maxTrackersForGoal(agentId: string): number | undefined {
    const goal = this.stores.goals.getForAgent(agentId);
    if (!goal) return undefined;

    let ceiling: number | undefined;
    for (const constraint of this.skills.resolveConstraints(goal.skillIds)) {
      if (constraint.kind !== 'MAX_TRACKERS') continue;
      ceiling = ceiling === undefined ? constraint.maximum : Math.min(ceiling, constraint.maximum);
    }
    return ceiling;
  }

  sdkFor(agentId: string): TrackerSdk {
    const existing = this.sdkByAgent.get(agentId);
    if (existing) return existing;

    const sdk = new TrackerSdk(agentId, {
      runtime: this.trackers,
      resolveOwnedThesisIds: (id) =>
        this.stores.theses
          .list()
          .filter((thesis) => thesis.agentId === id)
          .map((thesis) => thesis.id),
      resolveGrantedCapabilities: (id) => {
        const instance = this.deps.agentRuntime.getAgent(id);
        if (!instance) return [];
        return instance.allowedCapabilities;
      },
      /*
       * The tightest watch ceiling among the goal's active skills, so a
       * skill that promises restraint actually restrains. Tightest rather
       * than first: with two skills attached, the more cautious claim is the
       * one that should hold, and a skill cannot be loosened by attaching a
       * second one.
       */
      maxTrackersForGoal: (id) => this.maxTrackersForGoal(id),
      clock: this.clock,
    });
    this.sdkByAgent.set(agentId, sdk);
    return sdk;
  }

  /**
   * Create a GOAT.
   *
   * A GOAT is a goal plus skills. That is the whole of it, and it is
   * deliberately all the user has to supply: no market, no timeframe, no
   * thresholds. A GOAT is worth having whatever market it is pointed at,
   * so binding it to one at creation would make it single-use, and
   * making the user choose before they have seen the agent's reading of
   * their own goal would be asking for a decision they are not ready to
   * make.
   *
   * What happens here: the goal is recorded, the skills are resolved, and
   * the agent is asked what it thinks the goal means — so the user sees
   * its reading before deciding where it runs. No runtime agent is
   * registered and nothing is watched until `deployGoat`.
   */
  async createGoat(input: {
    agentId?: string;
    /** Optional display name. See `Goal.name`. */
    name?: string;
    /** Optional user description. See `Goal.description`. */
    description?: string;
    goal: string;
    skillIds?: string[];
    policy?: Partial<AgentPolicy>;
    instructions?: string;
  }): Promise<CreateGoatResult> {
    const now = this.now();
    const agentId = input.agentId ?? this.nextId('goat');

    const statement = input.goal.trim();
    assertUsableGoal(statement);

    // Validate skills before anything is written, so a bad skill id
    // cannot leave a half-created goal behind.
    const skillIds = input.skillIds ?? [];
    this.skills.resolveActive(skillIds);

    const goal: Goal = {
      id: this.nextId('goal'),
      agentId,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      statement,
      // Market and timeframe are deployment's business, not the goal's.
      symbols: [],
      timeframes: [],
      skillIds,
      status: 'UNDEPLOYED',
      createdAt: now,
      updatedAt: now,
    };

    const agent = this.buildAgent({
      id: agentId,
      goal: statement,
      skillIds,
      policy: input.policy,
      instructions: input.instructions,
    });

    this.stores.goals.save(goal);

    const interpretation = await this.interpretGoal(goal, agent);

    goal.interpretation = interpretation.understood;
    /*
     * The resolutions this GOAT works across, kept.
     *
     * The model was asked which timeframes the objective implies and answered,
     * and the answer used to be thrown away — which is how "scalp using 1m and
     * 5m" became a 15m GOAT. Two sources are unioned rather than one chosen:
     * the resolutions the objective literally names, and the ones the model's
     * reading proposed. The literal parse runs first because a model is a
     * reader, not a guarantee: if the user wrote "1m and 5m", that is the
     * request, and it should survive whatever the interpretation said.
     *
     * Nothing is invented here — only canonical resolutions that were either
     * written by the user or proposed by the agent for this goal.
     */
    const declared = [
      ...timeframesInStatement(statement),
      ...parseTimeframes(interpretation.timeframes).accepted,
    ];
    goal.timeframes = SUPPORTED_TIMEFRAMES.filter((timeframe) => declared.includes(timeframe));
    /*
     * What the agent could not resolve is kept, but it no longer decides
     * anything.
     *
     * It used to: a goal the agent called "not actionable" was refused
     * deployment and the user was told to write a better one. That is the
     * opposite of the product — the agent exists to work out how to pursue
     * an objective, and refusing to start is how you get a system that
     * never learns anything about the market its user trades. The open
     * questions now travel to the review card, where a person can answer
     * them if they want to.
     */
    goal.status = 'UNDEPLOYED';
    goal.updatedAt = this.now();
    this.stores.goals.save(goal);

    return {
      agentId,
      goal,
      interpretation,
      thesisIds: [],
      trackerIds: [],
    };
  }

  /**
   * Read a goal again, for a GOAT that already exists.
   *
   * The case this exists for: a GOAT created before an API key was
   * connected is recorded with the reason it could not be read, and its
   * status stays DRAFT. Once the key exists, the honest way to fix that is
   * to ask the agent again — not to create a second GOAT with the same
   * words and leave the first one behind as debris. Creating a duplicate
   * is what a user does when a product gives them no other button.
   */
  async refreshInterpretation(goalId: string): Promise<CreateGoatResult> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) {
      throw new Error(`Unknown goal ${goalId}.`);
    }

    const agent = this.buildAgent({
      id: goal.agentId,
      goal: goal.statement,
      skillIds: goal.skillIds,
    });

    const interpretation = await this.interpretGoal(goal, agent);
    goal.interpretation = interpretation.understood;
    goal.status = interpretation.actionable ? 'UNDEPLOYED' : 'DRAFT';
    goal.updatedAt = this.now();
    this.stores.goals.save(goal);

    return {
      agentId: goal.agentId,
      goal,
      interpretation,
      thesisIds: this.stores.theses.listForGoal(goal.id).map((thesis) => thesis.id),
      trackerIds: this.trackers.listForGoal(goal.id).map((tracker) => tracker.id),
    };
  }

  /**
   * Rename a GOAT, or change its description.
   *
   * Writes two fields and nothing else. The id, goal, skills, theses,
   * evidence, deployments and history are untouched, which is the only
   * honest way to let someone relabel an agent: a rename that rebuilt the
   * GOAT would silently discard everything it had learned.
   */
  updateGoatProfile(
    goalId: string,
    change: { name?: string; description?: string },
  ): Goal {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);

    const name = change.name?.trim();
    const description = change.description?.trim();
    const updated: Goal = {
      ...goal,
      // An empty field means "clear it", not "keep the old value": a user
      // who deletes a name does not want it back on the next render.
      ...(change.name !== undefined ? { name: name || undefined } : {}),
      ...(change.description !== undefined ? { description: description || undefined } : {}),
      updatedAt: this.now(),
    };
    this.stores.goals.save(updated);
    return updated;
  }

  /**
   * Attach or detach one skill on an existing GOAT.
   *
   * The same resolution the creation path uses, so a typo in a skill id is
   * refused here too rather than being stored on a GOAT that would then
   * fail to build.
   */
  attachSkill(goalId: string, skillId: string, attach: boolean): Goal {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);
    if (!skillId) throw new Error('A skill id is required.');

    const attached = goal.skillIds.includes(skillId);
    if (attached === attach) return goal;

    // Validate before writing, for the same reason creation does: a bad id
    // must not leave a half-edited GOAT behind.
    this.skills.resolveActive(attach ? [...goal.skillIds, skillId] : goal.skillIds.filter((id) => id !== skillId));

    const skillIds = attach
      ? [...goal.skillIds, skillId]
      : goal.skillIds.filter((id) => id !== skillId);

    const updated: Goal = { ...goal, skillIds, updatedAt: this.now() };
    this.stores.goals.save(updated);
    return updated;
  }

  /** Edit the goal itself, keeping the GOAT, its history and its identity. */
  updateGoalStatement(goalId: string, statement: string): Goal {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);
    assertUsableGoal(statement.trim());

    const updated: Goal = {
      ...goal,
      statement: statement.trim(),
      // The agent's old reading is no longer a reading of this goal, so it
      // is dropped rather than left contradicting the new words.
      interpretation: undefined,
      updatedAt: this.now(),
    };
    this.stores.goals.save(updated);
    return updated;
  }

  /**
   * Create a GOAT from one of the shipped starters.
   *
   * Delegated to `createGoat` on purpose, and it is the whole point: a
   * starter is a pre-authored goal plus a pre-authored skill list, and
   * creating one takes exactly the path a typed goal takes. There is no
   * privileged route, no pre-attached thesis, no observation plan, and
   * nothing the resulting GOAT can do that a GOAT the user wrote cannot.
   * If that ever stops being true, the Explorer is showing a different
   * product from the one underneath it.
   */
  async createGoatFromStarter(starterId: string): Promise<CreateGoatResult> {
    const starter = STARTER_GOATS.find((candidate) => candidate.identity.id === starterId);
    if (!starter) {
      throw new Error(`Unknown starter GOAT ${starterId}.`);
    }
    return this.createGoat({
      name: starter.identity.name,
      description: starter.identity.description,
      goal: starter.goal.statement,
      skillIds: starter.skills.map((reference) => reference.id),
    });
  }

  /**
   * Point a GOAT at a market and start it running.
   *
   * This is the moment the user chooses where the GOAT works, and it is
   * also the moment they are told what it is allowed to do. The default
   * is SHADOW: real market data, real decisions, no orders. A GOAT that
   * could place a trade on its first deployment would be a GOAT nobody
   * would trust on its first deployment.
   *
   * Redeploying to another market is supported and is not a special
   * case: the previous executor is retired, the trackers that were
   * watching the old market are cancelled with a reason, and the
   * deployment history keeps both records. A tracker's identity is its
   * history, so moving a GOAT must not leave a tracker quietly watching
   * a market its GOAT no longer trades.
   */
  deployGoat(input: {
    goalId: string;
    market: string;
    timeframe?: string;
    /**
     * The resolutions this deployment may read.
     *
     * Optional, and the goal's own set is the default. A GOAT whose objective
     * said "1m and 5m" arrives with those already recorded, so this exists for
     * the case where a deployment genuinely differs from the goal — a replay
     * that must use 1m because that is what the data can serve, say.
     */
    timeframes?: string[];
    mode?: GoatDeploymentMode;
    accountId?: string;
    execution?: Partial<ExecutionPermissions>;
  }): GoatDeployment {
    const goal = this.stores.goals.get(input.goalId);
    if (!goal) {
      throw new Error(`Unknown goal ${input.goalId}.`);
    }
    const market = input.market.trim();
    if (!market) {
      throw new Error('A deployment needs a market.');
    }

    /*
     * The setup resolution, and the set it belongs to.
     *
     * The set comes from the goal unless the deployment overrides it, and the
     * setup is the deployment's explicit choice when there is one — otherwise
     * the middle of the declared set, which for {1m, 5m} is 5m and for
     * {15m, 1h} is 1h. Picking the finest would force every GOAT into
     * microstructure; picking the coarsest would make a scalper wait a day.
     */
    const declared = [...new Set(
      [...goal.timeframes, ...(input.timeframes ?? [])].filter(isSupportedTimeframe),
    )];
    const timeframe = isSupportedTimeframe(input.timeframe?.trim())
      ? (input.timeframe?.trim() as string)
      : declared.length > 0
        ? declared[Math.floor(declared.length / 2)]
        : DEFAULT_GOAT_TIMEFRAME;
    const mode: GoatDeploymentMode = input.mode ?? 'SHADOW';
    const accountId = input.accountId?.trim() || 'paper';

    /*
     * A deployment is bound to one venue, and it says which one.
     *
     * The refusal is the point, not the recording. `LIVE` is a mode this
     * product cannot honour — there is no signing service — so accepting it
     * would create a deployment holding `canExecute: true` with nothing
     * behind it, which is the most misleading state in the system. The
     * error names what to do instead rather than just what is not allowed.
     */
    if (mode === 'LIVE') {
      throw new Error(
        'A GOAT cannot be deployed LIVE: this build has no order-signing service, so a LIVE deployment would claim authority it does not have. Deploy as SHADOW to reason on real Hyperliquid data and execute nothing, or as DEMO to trade simulated fills.',
      );
    }

    /*
     * No specificity gate. Every goal this system has ever refused to
     * deploy was refused for being a goal rather than a strategy — and
     * working out the strategy is the agent's job. The only things that
     * can stop a deployment are things that are genuinely wrong: an
     * unknown goal, no market, and a request for live authority this build
     * cannot honour.
     */

    const previous = this.stores.deployments.currentFor(goal.agentId);
    if (previous) this.retireDeployment(previous, 'Redeployed to another market.');

    /*
     * An executor may already exist for this GOAT: one restored from a
     * previous session, or one left behind by an earlier build of the
     * same goal. Binding is "make the executor match the deployment", so
     * an existing instance is retired rather than treated as a
     * duplicate. Its trackers go with it — they were watching a market
     * the new deployment did not choose.
     */
    if (this.deps.agentRuntime.getAgent(goal.agentId)) {
      this.trackers.cancelTrackersForAgent(goal.agentId, 'Rebound to a new deployment.');
      this.deps.agentRuntime.unregisterAgent(goal.agentId);
    }

    const deployment = createGoatDeployment({
      goatId: goal.agentId,
      goatVersion: 1,
      marketId: market,
      accountId,
      mode,
      venueEnvironment: this.deps.venueEnvironment ?? configuredVenue().environment,
      execution: {
        canProposeTrades: true,
        canExecute: mode !== 'SHADOW',
        allowedOrderTypes: mode === 'SHADOW' ? ['LIMIT'] : ['MARKET', 'LIMIT', 'STOP'],
        ...input.execution,
      },
      id: this.nextId('dep'),
      createdAt: this.now(),
    });

    const agent = this.buildAgent({
      id: goal.agentId,
      goal: goal.statement,
      market,
      timeframe,
      ...(declared.length > 0 ? { timeframes: declared } : {}),
      skillIds: goal.skillIds,
      policy: {
        allowTrading: mode !== 'SHADOW',
        allowedOrderTypes: deployment.execution.allowedOrderTypes,
      },
    });

    this.deps.agentRuntime.registerAgent(agent, this.deps.env);
    this.trackers.setEnvironment(this.deps.env.mode === 'BACKTEST' ? 'BACKTEST' : 'DEMO');
    this.deps.agentRuntime.start(goal.agentId);

    this.stores.deployments.save(deployment);
    this.stores.goals.save({
      ...goal,
      symbols: [market],
      // The whole set, with the setup resolution first so `timeframes[0]` still
      // means "the one this deployment acts on".
      timeframes: [timeframe, ...declared.filter((option) => option !== timeframe)],
      status: 'MONITORING',
      updatedAt: this.now(),
    });

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_DEPLOYED',
      data: {
        market,
        mode,
        venueEnvironment: deployment.venueEnvironment,
        mayExecute: deployment.execution.canExecute,
      },
    });

    /*
     * Register the durable runtime.
     *
     * After the deployment record, not before: the worker's identity includes the
     * deployment id, so there is nothing to register until the deployment exists.
     * And after the activity line, because "deployed" is true either way — the
     * in-tab runtime is already running and the GOAT is already working, so this
     * extends the deployment's life beyond this tab rather than starting it.
     *
     * Not awaited, because `deployGoat` is synchronous and is called from a click
     * handler. The report is recorded when it lands, so a runtime that could not
     * be registered is visible rather than merely absent.
     */
    void this.activateRuntime(goal.agentId, deployment.id, market, declared.length > 0 ? declared : [timeframe]);

    return deployment;
  }

  /**
   * The first investigation, run once a GOAT has a market.
   *
   * `deployGoat` registers the executor and records the deployment; that
   * is configuration, not work. Without this pass a freshly deployed GOAT
   * had no thesis and no trackers, so nothing could ever wake it and the
   * product showed a running GOAT that was, in the only sense that matters
   * here, asleep — with nothing written down about what it believed.
   *
   * So deploying is followed by the loop's real first step: read the goal,
   * form a hypothesis with a stated invalidation, and deploy the trackers
   * that would confirm or refute it. It goes through the same
   * `GoatLoop.investigate` the tests drive, through the same Tracker SDK,
   * and through the same ceilings and permission checks.
   *
   * Single-flight per agent, so a double-click or a reload cannot start two
   * investigations of one goal.
   */
  async investigateGoal(
    goalId: string,
    options: { redeploy?: boolean } = {},
  ): Promise<InvestigationReport> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) {
      return failed('That GOAT no longer exists.');
    }
    if (this.investigating.has(goal.agentId)) {
      return failed('This GOAT is already starting up.');
    }

    const deployment = this.stores.deployments.currentFor(goal.agentId);
    if (!deployment) {
      return failed('Deploy the GOAT to a market before it can investigate one.');
    }

    /*
     * From here on a failure is a failure of reasoning, not of deployment.
     * The deployment is already recorded and the runtime is already running,
     * and every message below has to say so: the previous wording told the
     * user that "nothing was deployed" while their GOAT was deployed,
     * RUNNING, and bound to a market.
     */
    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_STARTED',
      data: {
        market: deployment.marketId,
        mode: deployment.mode,
        venueEnvironment: deployment.venueEnvironment,
        environment: this.deps.env.mode,
        researchAllowed: true,
        mayExecute: deployment.execution.canExecute,
      },
    });

    /*
     * A live thesis means the loop is already running, so this is checked
     * before the model is asked rather than after: there is nothing to
     * investigate, and asking anyway would spend a completion to be told
     * the answer the stores already hold.
     */
    const live = this.stores.theses.listLiveForGoal(goal.id);
    if (live.length > 0) {
      const watching = this.trackers
        .listForThesis(live[0].id)
        .filter((tracker) => tracker.lifecycle.status === 'ACTIVE');

      /*
       * A live thesis with nothing watching it is a GOAT that has gone
       * quiet: the hypothesis survived a page reload and its observation
       * plan did not. Rebuilding the plan is the fix, and it is a different
       * act from forming a second thesis — the claim is unchanged, only
       * what it is waiting for.
       */
      if (!options.redeploy || watching.length > 0) {
        return {
          ok: true,
          investigated: false,
          thesisId: live[0].id,
          trackerIds: watching.map((tracker) => tracker.id),
          rejections: [],
          outcome: 'ALREADY_INVESTIGATING',
          deployed: true,
          message:
            live[0].state === 'INVESTIGATING'
              ? 'This GOAT is investigating and waiting on its trackers.'
              : `This GOAT already has a Trade Plan that is ${live[0].state.toLowerCase()}, and it wakes on its own conditions.`,
        };
      }
    }

    /*
     * The executor is derived from the deployment, so it is rebuilt here
     * whenever it is missing. Without this a GOAT that was running before
     * a reload has a thesis, a deployment and no agent: it looks alive and
     * cannot reason at all.
     */
    this.ensureExecutor(goal, deployment);

    const generation = this.runtimeGenerationFor(goal.agentId);
    const session = this.sessions.current(goal.agentId);
    this.investigating.add(goal.agentId);
    try {
      const investigation = await this.proposeInvestigation(goal, deployment);
      const proposal = investigation;

      /*
       * The runtime was rebuilt while this pass was talking to the model.
       *
       * The answer is still good — it is the market's answer, not the runtime's
       * — but it was formed against a runtime that no longer exists, and
       * applying it would form a Trade Plan and arm conditions on a GOAT the user
       * has just emptied. Dropping it is the honest outcome, and it says so.
       */
      /*
       * Both checks are made, and they are not redundant.
       *
       * The generation catches a superseded runtime generation; the session
       * identity catches the same thing more precisely, and is what the rest of the
       * system stamps work with. Keeping the generation check means the behaviour
       * does not depend on either mechanism alone.
       */
      if (this.runtimeGenerationFor(goal.agentId) !== generation || !this.sessions.isCurrent(session)) {
        return failed(
          'The GOAT was refreshed while this pass was in flight, so its answer was discarded rather than applied.',
          'NOT_DEPLOYED',
          true,
        );
      }

      if (proposal.unavailable) {
        /*
         * The model call records its own failure, with the intent and the
         * elapsed time, so this line is only for the failures that happened
         * before a request could be made at all — a GOAT with no runtime
         * registered has not called anything, and reporting it as a model
         * failure would send someone looking at the wrong thing.
         */
        if (!proposal.modelFailed) {
          this.recordActivity({
            goatId: goal.agentId,
            deploymentId: deployment.id,
            agentId: goal.agentId,
            type: 'MODEL_FAILURE',
            data: { code: proposal.unavailableCode ?? 'UNKNOWN', phase: 'PRE_REQUEST' },
          });
        }
        /*
         * The message below promises a retry, so one has to happen.
         *
         * Only the "answered, held no thesis" path used to schedule a
         * reconsideration, so a first pass that failed to read the model
         * left the GOAT deployed, reporting that it would try again, and
         * never looking again — no thesis, no trackers, and nothing that
         * could ever wake it. The timer is the same bounded one, and it
         * re-checks that the deployment is still live before acting, so a
         * GOAT stopped in the meantime is not resurrected by it.
         *
         * A provider that answered unusably is exempt. The request reached
         * OpenRouter and came back in a shape that would not read again, so
         * the retry would spend a model call to arrive at the same answer —
         * which is how one unreadable response used to become three. The
         * failure is still reported, still leaves the GOAT deployed, and is
         * still stated in plain terms; only the promise of a retry is
         * withdrawn, because it is not one this runtime can keep.
         */
        const retryable = !proposal.responseReached;
        if (retryable) this.scheduleReconsideration(goal, deployment, 'MODEL_UNAVAILABLE');
        return failed(
          retryable
            ? `${proposal.unavailable} The GOAT stays deployed on ${deployment.marketId} and will retry safely.`
            : `${proposal.unavailable} The GOAT stays deployed on ${deployment.marketId}. Retrying would return the same unreadable answer, so no retry was scheduled.`,
          'MODEL_FAILURE',
          true,
        );
      }

      if (!proposal.proposed) {
        /*
         * The model answered and the answer held no hypothesis. That is a
         * legitimate state for a first pass over a market that says nothing
         * yet — the GOAT reviewed it and formed no view — so it is reported
         * as what it is rather than as a failure of the deployment.
         */
        this.recordActivity({
          goatId: goal.agentId,
          deploymentId: deployment.id,
          agentId: goal.agentId,
          type: 'NO_THESIS_YET',
          data: { market: deployment.marketId },
        });
        this.scheduleReconsideration(goal, deployment);

        return {
          ok: false,
          investigated: false,
          trackerIds: [],
          rejections: [],
          outcome: 'NO_THESIS_YET',
          deployed: true,
          message: this.stores.deployments.currentFor(goal.agentId)
            ? `This GOAT is deployed on ${deployment.marketId} and reviewed the market, but it does not yet have a Trade Plan it can act on. It will look again on its own in about an hour, up to a few times, and it will wake you here the moment it has one.`
            : `This GOAT is deployed on ${deployment.marketId} and reviewed the market, but it does not yet have a Trade Plan it can act on.`,
        };
      }

      /*
       * A thesis with no tracker is a GOAT holding a view and no way to
       * re-read it — asleep indefinitely, showing a belief it can never
       * check. A model that reasons well but writes one config this runtime
       * cannot accept produced exactly that state in a live run: three
       * trackers proposed, three refused, and a GOAT that looked alive and
       * was not.
       *
       * So if nothing survived, the runtime instruments the observation
       * plan itself, from the thesis's own timeframe. It is the smallest
       * honest version of "watch this again": a new bar, and nothing that
       * requires a number the model may have invented. It is recorded as
       * defaulted so the feed never claims it was the model's idea.
       */
      /*
       * The runtime's own watcher, whenever the model armed nothing usable.
       *
       * This used to trigger only when the model proposed nothing at all. When
       * it proposed conditions and every one was refused, the GOAT was left with
       * a belief and no way to re-read it — alive, holding a view, and unable to
       * wake. That is worse than the proposal being refused silently, and it
       * becomes likelier rather than rarer now that a GOAT can declare its own
       * resolutions: a model that answers with a 15m condition for a 1m scalper
       * has proposed nothing the runtime can actually watch.
       */
      const proposedTrackers = proposal.proposed.trackers;
      const defaulted =
        proposedTrackers.length === 0 || proposal.proposed.dropped === proposedTrackers.length
          ? defaultObservationPlan(timeframeFor(goal))
          : [];
      const plan = proposedTrackers.length > 0 ? proposedTrackers : defaulted;

      const outcome = this.loop.investigate({
        agentId: goal.agentId,
        goalId: goal.id,
        thesis: proposal.proposed.thesis,
        trackers: plan,
        validUntil: this.now() + DEFAULT_INVESTIGATION_WINDOW_MS,
        attachToLive: options.redeploy === true && live.length > 0,
      });

      const rejections = [...outcome.rejections];
      if (defaulted.length > 0) {
        rejections.push(
          proposedTrackers.length > 0
            ? `None of the ${proposedTrackers.length} proposed conditions could be watched by this runtime, so its own bar watcher was deployed instead.`
            : 'No observation plan could be read from the response, so this GOAT deployed its own bar watcher.',
        );
      }
      if (proposal.proposed.dropped > 0) {
        rejections.push(
          `${proposal.proposed.dropped} proposed tracker${
            proposal.proposed.dropped === 1 ? ' was' : 's were'
          } not something this runtime can watch, and ${proposal.proposed.dropped === 1 ? 'was' : 'were'} discarded.`,
        );
      }

      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'THESIS_FORMED',
        data: {
          thesisId: outcome.thesisId,
          statement: proposal.proposed.thesis.statement,
          direction: proposal.proposed.thesis.direction,
          market: deployment.marketId,
          /*
           * The conditions, on the plan's own record.
           *
           * They used to be a second line — "Thesis: X" followed by "Defined
           * what it needs to see" — which is one idea split across two
           * vocabularies. A Trade Plan is the belief *and* the conditions *and*
           * the consequence, so it is one line that says all three.
           */
          requirements: proposal.proposed.thesis.requiredConfirmation ?? [],
          watches: outcome.trackerIds.length,
          ...(proposal.elapsedMs !== undefined ? { modelMs: proposal.elapsedMs } : {}),
          ...(proposal.acquiredTimeframes && proposal.acquiredTimeframes.length > 0
            ? { acquired: proposal.acquiredTimeframes.join(', ') }
            : {}),
        },
      });
      for (const trackerId of outcome.trackerIds) {
        this.recordActivity({
          goatId: goal.agentId,
          deploymentId: deployment.id,
          agentId: goal.agentId,
          type: 'TRACKER_CREATED',
          data: {
            thesisId: outcome.thesisId,
            trackerId,
            // The tracker's own words, so the feed says what it is
            // waiting for rather than printing an identifier.
            purpose: this.trackers.get(trackerId)?.purpose,
          },
        });
      }
      /*
       * What it decided it needs to see is no longer a second record.
       *
       * It used to be one, and the log showed a Trade Plan and then a separate
       * line about the conditions, which is the same fact twice. The conditions
       * now ride on the plan's own record, where they belong — a reader sees
       * what the agent thinks and what would make it right on one line.
       */
      if (outcome.trackerIds.length > 0) {
        this.recordActivity({
          goatId: goal.agentId,
          deploymentId: deployment.id,
          agentId: goal.agentId,
          type: 'GOAT_WAITING',
          data: { trackers: outcome.trackerIds.length },
        });
      }

      return {
        ok: outcome.created || outcome.trackerIds.length > 0,
        investigated: outcome.created,
        thesisId: outcome.thesisId,
        trackerIds: outcome.trackerIds,
        rejections,
        outcome: outcome.trackerIds.length > 0 ? 'WAITING' : 'NO_THESIS_YET',
        deployed: true,
        message: outcome.created
          ? outcome.trackerIds.length > 0
            ? `Thesis formed. ${outcome.trackerIds.length} tracker${
                outcome.trackerIds.length === 1 ? '' : 's'
              } deployed, so this GOAT now wakes on evidence rather than polling.` +
              (defaulted.length > 0 ? ' Its own bar watcher was used, because none of the conditions it proposed could be watched here.' : '')
            : 'Thesis formed, but no tracker was accepted, so this GOAT has nothing to wake it.'
          : rejections[0] ?? 'This GOAT already has a thesis and is waiting on its trackers.',
      };
    } catch (error) {
      /*
       * A thrown failure is reported as a failure of reasoning, with the
       * deployment explicitly still intact. It used to be caught as `{}`
       * one layer down and surface as "the model did not return a
       * hypothesis", which is a different claim and an untrue one.
       */
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'MODEL_FAILURE',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      return failed(
        `The reasoning step failed on this GOAT (${error instanceof Error ? error.message : String(error)}). The deployment on ${deployment.marketId} is healthy and nothing has been torn down.`,
        'MODEL_FAILURE',
        true,
      );
    } finally {
      this.investigating.delete(goal.agentId);
    }
  }

  /**
   * Stop a GOAT without forgetting it.
   *
   * The deployment record is kept as `stopped` rather than deleted, and so
   * are the thesis, the evidence and any trade plan. A person who stops an
   * agent has not decided its history never happened, and a history that
   * vanishes on a pause is a history that cannot be read back.
   */
  /**
   * Start this GOAT again from a clean runtime state.
   *
   * "Refresh" is not "delete" and not "deploy again". The user is saying: this
   * agent's *thinking* has drifted — it is holding a stale belief, reacting to
   * conditions that no longer describe the market, or carrying an error it has
   * not recovered from — and they want it to reason again from what is true now.
   * The GOAT itself, its market, its skills, its risk configuration, its history
   * and its ownership are not in question.
   *
   * So this clears exactly the transient layer:
   *
   *   kept    the goal, its skills, the deployment record and its identity
   *           (one deployment, never a second), the theses and evidence already
   *           recorded, the trade plans, the activity feed, the user
   *   cleared  the executor, the trackers and their cooldowns and TTLs, the
   *           pending "look again" timer, the unprompted-look counter, the
   *           recorded model timings, and the agent's in-memory instance
   *
   * The deployment record is reactivated *in place*, so a refresh cannot leave
   * two deployments for one GOAT, and the tracker runtime is rebuilt empty
   * rather than re-seeded — the GOAT re-arms its own conditions from the market
   * it can actually see, which is the whole point of asking for a second pass.
   *
   * Returns what was cleared, because a control that resets something has to be
   * able to say what it reset.
   */
  /**
   * CLEAR — destroy this GOAT's session and leave nothing of it behind.
   *
   * This is not a refresh, a reload, or a restart, and the difference is the whole
   * point of the operation:
   *
   *   REFRESH / RESTART   keep the session and rebuild the runtime from it. The
   *                        thesis, the evidence, the trackers and the log all
   *                        survive; the GOAT carries on from where it was.
   *
   *   CLEAR                destroy the session. Nothing the session wrote
   *                        survives — not the thesis, not the evidence, not the
   *                        trackers, not the log, not the trades, not the runtime's
   *                        state — and the GOAT is left as though it had never run,
   *                        stopped, waiting for somebody to press PLAY.
   *
   * The order below is load-bearing and is the reason this is one method rather than
   * a flag the UI sets:
   *
   *   1. invalidate the session, so nothing in flight can write afterwards
   *   2. stop the in-tab runtime, so it stops producing work
   *   3. retire the durable runtime, so the cloud runtime stops waking
   *   4. delete the session's records, in dependency order
   *   5. leave the deployment *stopped* rather than reactivating it
   *
   * Step 1 before everything else because a model request that resolves
   * mid-teardown must be refused, and it can only be refused if the session is
   * already superseded when it comes back. And the last step emphatically: the
   * previous version of this operation reactivated the deployment, which meant
   * CLEAR silently started the GOAT again — the exact opposite of what the button
   * says.
   *
   * PLAY and RESTART remain separate operations. This one starts nothing.
   */
  async clearGoatSession(
    goalId: string,
    reason = 'Session cleared by the operator.',
  ): Promise<ClearSessionReport> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);

    const at = this.now();
    const deployment =
      this.stores.deployments.currentFor(goal.agentId) ??
      this.stores.deployments.historyFor(goal.agentId)[0];

    // 1. Invalidate first, before anything is torn down.
    //
    // `supersede` both bumps the generation — so the in-flight model request's
    // answer is refused when it returns — and mints the identity the next session
    // will run under. Holding it now means step 5 has nothing left to decide.
    const session = this.sessions.supersede(goal.agentId, at);
    this.bumpRuntimeGeneration(goal.agentId);

    const inFlightModel = this.pendingModels.has(goal.agentId);
    this.pendingModels.delete(goal.agentId);
    const reconsiderations = this.clearReconsideration(goal.agentId) ?? 0;

    // 2. Cancel the trackers, *before* the agent is unregistered.
    //
    // Cancelling a tracker is an update to it, and the tracker registry refuses an
    // update whose owner is not a registered agent. Doing this after
    // `unregisterAgent` therefore throws — which would abandon the clear half-way,
    // with the session invalidated and the records still on disk. The order is not
    // cosmetic and it is the kind that only shows up when a GOAT actually has
    // trackers, which is why it is asserted rather than assumed.
    const trackersBefore = this.trackers.listForGoal(goalId).length;
    const cancelled = this.trackers.cancelTrackersForAgent(goal.agentId, reason);

    // 3. Stop the in-tab runtime.
    if (this.deps.agentRuntime.getAgent(goal.agentId)) {
      await this.deps.agentRuntime.stop(goal.agentId);
      this.deps.agentRuntime.unregisterAgent(goal.agentId);
    }

    // 4. Retire the durable runtime, so the cloud side stops waking.
    //
    // Awaited: a cleared GOAT whose Durable Object is still registered keeps waking
    // against a session that no longer exists, and no amount of local tidiness
    // changes that. Retire rather than suspend — the session is gone, and keeping
    // its cooldowns would carry the previous session's decisions into the next one.
    if (deployment) await this.retireRuntime(deployment, reason);

    // 5. Delete what the session wrote.
    this.trackers.disposeAgent(goal.agentId);
    this.modelCalls.delete(goal.agentId);
    this.noThesisLooks.delete(goal.agentId);

    const theses = this.stores.theses.listForGoal(goalId);
    const ideas = this.stores.ideas.listForGoal(goalId);
    let evidence = 0;
    // Children before parents: an evidence row whose thesis no longer exists is an
    // orphan nothing would ever clean up, and a plan whose thesis is gone cannot be
    // reasoned about.
    for (const thesis of theses) evidence += this.stores.evidence.listForThesis(thesis.id).length;
    for (const thesis of theses) {
      // `removeForThesis` rather than removing rows one at a time: a session's
      // evidence is exactly "everything attached to its theses", and deleting by
      // thesis cannot leave a row behind by missing an id.
      this.stores.evidence.removeForThesis(thesis.id);
      this.stores.theses.remove(thesis.id);
    }
    for (const idea of ideas) this.stores.ideas.remove(idea.id);

    // 6. The agent log. Deleted, not hidden.
    const logEvents = (await this.deps.agentRuntime.getTimelineStore().removeForGoat?.(goal.agentId)) ?? 0;

    // 7. Remote session documents, when there is remote persistence.
    const remoteDocuments = await this.clearRemoteSession(goal, deployment);

    /*
     * The deployment is left *stopped*.
     *
     * This is the line between CLEAR and RESTART. A stopped deployment keeps the
     * GOAT's identity — its id, market, mode and skills — so the definition survives
     * and PLAY can resume the same GOAT. But nothing is running, no executor is
     * registered, and no tracker is watching, which is what "as though it had never
     * run" has to mean for the runtime as well as the records.
     */
    if (deployment) {
      this.retireDeployment(deployment, reason);
      this.stores.goals.save({
        ...goal,
        status: 'DRAFT',
        updatedAt: at,
      });
    }

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment?.id,
      agentId: goal.agentId,
      type: 'SESSION_CLEARED',
      data: {
        sessionId: session.sessionId,
        generation: session.generation,
        theses: theses.length,
        evidence,
        trackers: trackersBefore,
        logEvents,
        reason,
      },
    });

    return {
      deleted: {
        theses: theses.length,
        evidence,
        tradePlans: ideas.length,
        trackers: trackersBefore,
        cancelledTrackers: cancelled.length,
        logEvents,
        pendingModelRequest: inFlightModel,
        reconsiderations,
        modelTimings: this.modelCalls.size === 0,
        remoteDocuments,
      },
      kept: {
        goal: true,
        market: true,
        timeframes: true,
        skills: true,
        riskConfiguration: true,
      },
      session,
    };
  }

  /**
   * Delete a GOAT's session documents from remote persistence.
   *
   * Only ever session-scoped data. The GOAT's own record, its deployments and any
   * financial history are not touched — which is why this exists as its own method
   * rather than as a flag on the persistence service: the blast radius is the whole
   * reason the operation is safe.
   */
  private async clearRemoteSession(goal: Goal, deployment: GoatDeployment | undefined): Promise<number> {
    const persistence = this.deps.persistence;
    if (!persistence?.available) return 0;
    try {
      return await persistence.clearSession({
        goalId: goal.agentId,
        ...(deployment ? { deploymentId: deployment.id } : {}),
      });
    } catch {
      // Reported through the durable runtime's own failure channel rather than
      // thrown: a local clear that succeeded must not be presented as a failure
      // because a network write did.
      return 0;
    }
  }

  async stopGoat(goalId: string, reason = 'Stopped by the operator.'): Promise<GoatDeployment | undefined> {
    await this.undeployGoat(goalId, reason);
    const goal = this.stores.goals.get(goalId);
    if (!goal) return undefined;
    return this.stores.deployments.historyFor(goal.agentId)[0];
  }

  /**
   * Start a stopped GOAT again, on the same deployment.
   *
   * "Play" is not "deploy again". The deployment record is reactivated in
   * place, so the GOAT keeps one deployment identity and one history
   * rather than accumulating a new deployment every time somebody pauses
   * it; the executor is rebuilt from the deployment; and the observation
   * plan is restored only if it is actually missing, so pressing play
   * cannot leave two copies of every tracker watching one market.
   */
  async resumeGoat(goalId: string): Promise<{
    deployment: GoatDeployment;
    investigation: InvestigationReport;
    alreadyRunning: boolean;
  }> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}.`);

    const current = this.stores.deployments.currentFor(goal.agentId);
    if (current) {
      return {
        deployment: current,
        investigation: {
          ok: true,
          investigated: false,
          message: 'This GOAT is already running.',
          trackerIds: [],
          rejections: [],
          outcome: 'ALREADY_INVESTIGATING',
          deployed: true,
        },
        alreadyRunning: true,
      };
    }

    const previous = this.stores.deployments.historyFor(goal.agentId)[0];
    if (!previous) {
      throw new Error('This GOAT has no deployment to resume. Deploy it to a market first.');
    }

    const deployment: GoatDeployment = {
      ...previous,
      status: 'active',
      updatedAt: this.now(),
    };
    this.stores.deployments.save(deployment);

    /*
     * Register the durable runtime again, on the same identity.
     *
     * Idempotent on `(userId, goalId, deploymentId)` — which is the worker's own
     * identity — so a resume continues the existing runtime with its cooldowns
     * intact rather than starting a second one. That is the whole reason resume
     * keeps the deployment record instead of deploying afresh.
     */
    void this.activateRuntime(
      goal.agentId,
      deployment.id,
      deployment.marketId,
      goal.timeframes.length > 0 ? goal.timeframes : ['15m'],
    );

    // The market it was pointed at is part of the deployment, so resuming
    // restores it rather than asking again.
    this.stores.goals.save({
      ...goal,
      symbols: [deployment.marketId],
      timeframes: goal.timeframes.length > 0 ? goal.timeframes : ['15m'],
      status: 'MONITORING',
      updatedAt: this.now(),
    });

    this.ensureExecutor(goal, deployment);

    /*
     * Restore the observation plan from the record before asking the model
     * anything. Resuming should not require the agent's permission to
     * remember what it was already watching, and a resumed GOAT that
     * re-invented its plan would be a GOAT watching something it had never
     * decided to watch.
     */
    const interrupted = this.stoppedTrackers.get(goal.agentId);
    this.stoppedTrackers.delete(goal.agentId);
    const restored = this.loop.restoreObservationPlan(goal.agentId, goalId, interrupted);

    /*
     * Time passing is information.
     *
     * Restoring the observation plan is right for a moment — a GOAT that was
     * asleep for four seconds should not forget what it was watching — and
     * wrong for an hour. A tracker armed at a level, a thesis written against
     * a candle and a plan built on momentum are all statements about the
     * world *at a moment*, and after a real gap none of them is current.
     *
     * So a long enough stop triggers a restart pass: the runtime re-reads the
     * market through the normal wake path and the model is asked what it
     * thinks now, with the restored watches explicitly flagged as
     * unverified. Trackers are put back first so the GOAT is not blind
     * during the call, and then reconciled by that pass — added, removed or
     * restated by the same code that maintains them normally, so the skill
     * limits and the plan gate still apply.
     */
    const stoppedAt = previous.updatedAt;
    const downtime = Math.max(0, this.now() - stoppedAt);
    const stale = downtime >= GOAT_RESTART_REANALYZE_AFTER_MS;
    let reassessed = false;

    if (stale) {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'GOAT_RESTARTED',
        data: { downtime: describeDuration(downtime), downtimeMs: downtime, market: deployment.marketId },
      });

      const live = this.stores.theses.listLiveForGoal(goalId);
      if (live.length > 0) {
        this.recordActivity({
          goatId: goal.agentId,
          deploymentId: deployment.id,
          agentId: goal.agentId,
          type: 'GOAT_REASSESSING',
          data: {
            reason: `Time passed while stopped (${describeDuration(downtime)})`,
            thesisId: live[0].id,
            market: deployment.marketId,
            restoredTrackers: restored.length,
          },
        });
        const wake = this.restartWake(goal, deployment, live[0], restored);
        try {
          const outcome = await this.runWake(wake);
          reassessed = outcome !== undefined;
        } catch {
          // A restart that could not reason is reported and left recoverable:
          // the GOAT is deployed and watching, which is strictly better than
          // not having started, and the failure is in the feed.
          this.recordActivity({
            goatId: goal.agentId,
            deploymentId: deployment.id,
            agentId: goal.agentId,
            type: 'GOAT_WAITING',
            data: {
              message:
                'Restarted, but the reassessment could not complete. It is deployed and watching; the previous plan has not been revalidated.',
            },
          });
        }
      } else {
        // No hypothesis to revalidate, so the first pass is the restart pass.
        await this.investigateGoal(goalId, { redeploy: true });
        reassessed = true;
      }
    }

    /*
     * Recorded, because a feed that shows three stops and no resumes tells
     * a user their GOAT is not running when it is. Each restored tracker is
     * its own line too, so the observation plan coming back is explained
     * rather than appearing from nowhere.
     */
    for (const trackerId of restored) {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'TRACKER_CREATED',
        data: { trackerId, purpose: this.trackers.get(trackerId)?.purpose, restored: true },
      });
    }
    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_RESUMED',
      data: { market: deployment.marketId, mode: deployment.mode, restored: restored.length },
    });

    if (restored.length > 0) {
      return {
        deployment,
        alreadyRunning: false,
        investigation: {
          ok: true,
          investigated: false,
          thesisId: this.stores.theses.listLiveForGoal(goalId)[0]?.id,
          trackerIds: restored,
          rejections: this.loop.restoreRefusals(),
          outcome: 'ALREADY_INVESTIGATING' as const,
          deployed: true,
          message: reassessed
            ? `Resumed after ${describeDuration(downtime)}. It re-read ${deployment.marketId} and reassessed its thesis before continuing, so the ${
                restored.length === 1 ? 'watch' : 'watches'
              } it resumed are revalidated rather than assumed.`
            : `Resumed. ${restored.length} condition${
                restored.length === 1 ? '' : 's'
              } restored from what it was watching.`,
        },
      };
    }

    // Nothing to restore — a GOAT stopped before it ever deployed one.
    const investigation = await this.investigateGoal(goalId, { redeploy: true });

    return { deployment, investigation, alreadyRunning: false };
  }

  /**
   * Archive a GOAT the user deleted.
   *
   * Deletion here means "stop taking it off my list", and the honest
   * implementation of that is a state rather than a `remove`: the goal is
   * stopped, marked `ABANDONED`, and hidden from the active lists. Its
   * theses, evidence, trackers and trade plans stay on disk, because they
   * are the record of what the agent did, and an agent that can be made to
   * have never existed is an agent whose conclusions cannot be trusted.
   *
   * Returns what was kept, so the UI can say so rather than implying the
   * history was destroyed.
   */
  async archiveGoat(goalId: string): Promise<{ archived: boolean; kept: { theses: number; evidence: number; plans: number } }> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return { archived: false, kept: { theses: 0, evidence: 0, plans: 0 } };

    const deployment = this.stores.deployments.currentFor(goal.agentId);
    if (deployment) await this.stopGoat(goalId, 'Archived by the operator.');

    const theses = this.stores.theses.listForGoal(goalId);
    for (const thesis of theses) {
      if (thesis.state === 'INVALIDATED' || thesis.state === 'ABANDONED' || thesis.state === 'COMPLETED') continue;
      try {
        this.loop.reviseThesis(thesis.id, { state: 'ABANDONED' });
      } catch {
        // Already terminal; the archive still stands.
      }
    }

    this.stores.goals.save({
      ...goal,
      symbols: [],
      timeframes: [],
      status: 'ABANDONED',
      updatedAt: this.now(),
    });
    this.steeringStore.removeFor(goalId);

    return {
      archived: true,
      kept: {
        theses: theses.length,
        evidence: theses.reduce(
          (total, thesis) => total + this.stores.evidence.listForThesis(thesis.id).length,
          0,
        ),
        plans: this.stores.ideas.listForGoal(goalId).length,
      },
    };
  }

  /**
   * Deploy, then investigate. The sequence a user means by "run this".
   *
   * Reported separately from the deployment because they can fail
   * separately: a deployment that recorded but did not reason is a
   * different thing from one that never started, and the UI says which.
   */
  async startGoat(input: {
    goalId: string;
    market: string;
    timeframe?: string;
    mode?: GoatDeploymentMode;
  }): Promise<{ deployment: GoatDeployment; investigation: InvestigationReport }> {
    const deployment = this.deployGoat(input);
    const investigation = await this.investigateGoal(input.goalId);
    return { deployment, investigation };
  }

  /**
   * Bring deployed GOATs back to a state where something can wake them.
   *
   * Two cases, both of which a page reload creates:
   *
   *   deployed, never investigated    nothing to wake it
   *   live thesis, no observation plan  trackers are not persisted, so a
   *                                   reload leaves the claim with nothing
   *                                   waiting on it
   *
   * A GOAT that is already watching something is left strictly alone: it is
   * thinking, and asking it to think again would be a second agent
   * reasoning about one market.
   */
  async resumeUnstartedGoats(): Promise<InvestigationReport[]> {
    const reports: InvestigationReport[] = [];

    for (const goal of this.stores.goals.list()) {
      if (goal.status !== 'MONITORING') continue;
      if (!this.stores.deployments.currentFor(goal.agentId)) continue;

      const live = this.stores.theses.listLiveForGoal(goal.id);
      const watching = live.flatMap((thesis) =>
        this.trackers.listForThesis(thesis.id),
      ).filter((tracker) => tracker.lifecycle.status === 'ACTIVE');

      if (live.length > 0 && watching.length > 0) continue;

      try {
        const report = await this.investigateGoal(goal.id, {
          redeploy: live.length > 0,
        });
        if (report.ok) reports.push(report);
      } catch {
        // A GOAT that cannot be resumed stays as it is; it is reported as
        // a goal with no thesis rather than as a broken product.
      }
    }

    return reports;
  }

  /**
   * Read the market the GOAT is pointed at, through deterministic tools.
   *
   * Returns an empty-but-shaped context when the feed cannot be read. The
   * agent is told what it could not see, which is a very different thing
   * from being handed nothing and left to guess.
   */
  /**
   * Read one resolution.
   *
   * Thin on purpose: every caller that needs more than one asks for each one
   * separately, so which resolutions were actually read is visible rather
   * than buried in a merged summary.
   */
  private async readMarket(
    symbol: string | undefined,
    instance: AgentInstance,
    timeframe: string,
  ): Promise<MarketContext> {
    if (!symbol) {
      return {
        symbol: 'none',
        timeframe,
        bars: { requested: 0, received: 0 },
        structure: {},
        indicators: {},
        limitations: ['No market has been chosen yet.'],
      };
    }

    /*
     * Already known to be dead for this agent, so the read is not attempted
     * again. The answer is returned directly and says why it is empty, so the
     * model is told the resolution is unavailable for the same reason it was
     * the first time — the loop stops repeating a doomed read, and stops
     * asking the model to request what is already known not to exist.
     */
    if (this.knownUnavailableResolutions(instance.agent.id).has(`${symbol}:${timeframe}`)) {
      return {
        symbol,
        timeframe,
        bars: { requested: BAR_COUNT, received: 0 },
        structure: {},
        indicators: {},
        limitations: [
          `${timeframe} is not available for ${symbol} on this market and was already found to be unavailable for this GOAT. It has not been requested again.`,
        ],
      };
    }

    const context = await collectMarketContext(this.deps.env, this.capabilities, {
      agentId: instance.agent.id,
      symbol,
      timeframe,
      policy: instance.agent.policy,
      mode: this.deps.env.mode,
    });

    /*
     * Learned here so the next wake starts from it. Both routes to a dead end
     * count: a thrown read and a context that came back with no candles behind
     * it.
     */
    if (context.limitations.length > 0 || context.bars.received === 0) {
      this.noteUnavailableResolution(instance.agent.id, symbol, timeframe);
    }

    return context;
  }

  /**
   * Read the resolutions worth reading for this pass, and say which.
   *
   * Context, setup and trigger are usually not the same resolution, and a GOAT
   * reasoning about a breakout needs the higher one to agree with. What that
   * means changed once: the set is no longer "the setup plus whatever is
   * coarser".
   *
   * It is now the agent's own declared menu, resolved through the canonical
   * timeframe model, and every resolution comes back with the job it is doing —
   * regime, structure, setup, confirmation, entry. So a scalper that declared
   * 1m and 5m reads exactly those two and calls 1m entry timing, while a
   * swing GOAT on 15m reads the hour as structure and the 5m as confirmation.
   * Neither is given a resolution it did not ask for, and the reason each one
   * was read is in the prompt and the log rather than implied by its size.
   *
   * The menu is the agent's, not a constant, so narrowing it for a goal narrows
   * what gets read, and an empty menu means "choose", which resolves to the
   * setup resolution and its nearest neighbours.
   */
  private async readMarketAcrossTimeframes(
    symbol: string,
    instance: AgentInstance,
    setupTimeframe: string,
    options: { extra?: string[] } = {},
  ): Promise<TimeframeContext[]> {
    const plan = resolveTimeframePlan({
      declared: [...agentTimeframes(instance.agent), ...(options.extra ?? [])],
      setup: setupTimeframe,
    });

    const contexts: TimeframeContext[] = [];
    for (const read of plan.reads) {
      contexts.push({
        context: await this.readMarket(symbol, instance, read.timeframe),
        role: read.role,
        reason: read.reason,
        strategy: plan.strategy,
      });
    }
    return contexts;
  }

  /**
   * Render several resolutions of one market into the prompt.
   *
   * One block per timeframe with its candle range and the role it is playing,
   * so the model can tell "no structure on 1h" from "structure on 15m" instead
   * of reading a single merged number and assuming it applies everywhere — and
   * so it knows that a 1m read is entry timing while a 5m read is confirmation.
   * The role is stated rather than implied, because the same candles support
   * different conclusions depending on what the agent is trying to learn from
   * them.
   */
  private renderTimeframeContexts(contexts: TimeframeContext[]): string {
    return contexts
      .map(({ context, role, reason }) => {
        const lines = renderMarketContext(context)
          .split('\n')
          .filter((line) => !/^(Symbol|Timeframe):/.test(line));
        return [
          `${context.symbol} · ${context.timeframe} — ${TIMEFRAME_ROLE_LABELS[role]} (${reason})`,
          ...lines.map((line) => `  ${line}`),
        ].join('\n');
      })
      .join('\n\n');
  }

  /**
   * The observation the GOAT reasons against.
   *
   * Built from the same environment the runtime observes through, so a
   * GOAT and a plain agent see the same market. A failure to read it is
   * reported as an empty observation rather than as zeros: a GOAT told
   * "equity is 0" reasons about an account it does not have.
   */
  private async buildObservation(
    instance: AgentInstance,
    input: {
      symbol?: string;
      timeframe: string;
      skillIds: string[];
      market: MarketContext;
      /** The other resolutions gathered for this pass, if any. */
      extraTimeframes?: MarketContext[];
    },
  ): Promise<AgentObservation> {
    const observation: AgentObservation = {
      timestamp: this.now(),
      environment: this.deps.env.mode,
      market: { quotes: [] },
      account: {
        balance: 0,
        equity: 0,
        margin: 0,
        freeMargin: 0,
        dailyPnL: null,
        drawdownPercent: null,
      },
      positions: [],
      orders: [],
      ...(input.extraTimeframes && input.extraTimeframes.length > 0
        ? {
            market: {
              // Filled in below, once the base market has been populated.
              quotes: [],
              timeframeReads: [
                {
                  timeframe: input.market.timeframe,
                  role: 'setup',
                  candleCount: input.market.bars.received,
                  ...(input.market.bars.firstTime !== undefined ? { firstTime: input.market.bars.firstTime } : {}),
                  ...(input.market.bars.lastTime !== undefined ? { lastTime: input.market.bars.lastTime } : {}),
                  indicators: input.market.indicators as Record<string, unknown>,
                  structure: input.market.structure as Record<string, unknown>,
                  ...(input.market.limitations.length > 0 ? { limitations: input.market.limitations } : {}),
                },
                ...input.extraTimeframes.map((context) => ({
                  timeframe: context.timeframe,
                  role: 'context',
                  candleCount: context.bars.received,
                  ...(context.bars.firstTime !== undefined ? { firstTime: context.bars.firstTime } : {}),
                  ...(context.bars.lastTime !== undefined ? { lastTime: context.bars.lastTime } : {}),
                  indicators: context.indicators as Record<string, unknown>,
                  structure: context.structure as Record<string, unknown>,
                  ...(context.limitations.length > 0 ? { limitations: context.limitations } : {}),
                })),
              ],
            },
          }
        : {}),
      availableCapabilities: instance.allowedCapabilities,
      availableSkills: input.skillIds,
    };

    if (input.market.quote) {
      observation.market.quote = input.market.quote;
      observation.market.quotes = [input.market.quote];
      observation.timestamp = input.market.quote.timestamp;
    }

    // Spread and session come from the same deterministic read as the quote.
    const spread = input.market.spread as { spreadBps?: number } | undefined;
    if (typeof spread?.spreadBps === 'number') observation.market.spread = spread.spreadBps;
    const session = input.market.session as { activeSession?: string } | undefined;
    if (typeof session?.activeSession === 'string') observation.market.session = session.activeSession;

    try {
      const account = await this.deps.env.getAccountState();
      observation.account = {
        balance: account.balance,
        equity: account.equity,
        margin: account.margin,
        freeMargin: account.freeMargin,
        dailyPnL: account.dailyPnL,
        drawdownPercent: account.drawdownPercent,
      };
    } catch {
      // Left at zero, and the GOAT is told in its limitations.
    }

    try {
      observation.positions = await this.deps.env.getPositions(input.symbol);
    } catch {
      // No positions is the normal state, not an error worth failing on.
    }

    try {
      observation.orders = await this.deps.env.getOrders();
    } catch {
      // Likewise.
    }

    return observation;
  }

  /**
   * The deployment, expressed the way a wake needs it.
   *
   * This is the single place the two permissions are separated. Research is
   * granted by being deployed at all; execution is whatever the deployment's
   * mode allows. A SHADOW deployment returns `research.allowed: true` and
   * `execution.canExecute: false`, and there is no reading of that object
   * in which the market is missing.
   */
  deploymentContextFor(agentId: string): DeploymentContext | undefined {
    const deployment = this.stores.deployments.currentFor(agentId);
    if (!deployment) return undefined;

    return {
      deploymentId: deployment.id,
      goatId: deployment.goatId,
      market: deployment.marketId,
      mode: deployment.mode,
      venueEnvironment: deployment.venueEnvironment,
      research: {
        allowed: true,
        market: deployment.marketId,
        /*
         * The GOAT chooses its own timeframes through the deterministic
         * market tools; the deployment's own timeframe is only a starting
         * point, and it is deliberately not a restriction.
         */
        timeframes: [...TIMEFRAMES_A_GOAT_MAY_RESEARCH],
      },
      execution: {
        canProposeTrades: deployment.execution.canProposeTrades,
        canExecute: deployment.execution.canExecute,
        allowedOrderTypes: [...deployment.execution.allowedOrderTypes],
      },
      clock: this.now(),
    };
  }

  /**
   * Make the runtime's executor match the deployment.
   *
   * Idempotent: an agent that is already registered is left alone, so
   * resuming a session does not restart a GOAT that is mid-thought. The
   * agent is built from the goal and the deployment, exactly as
   * `deployGoat` builds it, so there is one description of what a running
   * GOAT is rather than two that can drift.
   */
  private ensureExecutor(goal: Goal, deployment: GoatDeployment): void {
    if (this.deps.agentRuntime.getAgent(goal.agentId)) return;

    this.deps.agentRuntime.registerAgent(
      this.buildAgent({
        id: goal.agentId,
        goal: goal.statement,
        market: deployment.marketId,
        timeframe: goal.timeframes[0] ?? DEFAULT_GOAT_TIMEFRAME,
        // The goal's whole set, not just its first resolution: a resumed GOAT
        // that lost its 1m context would be a different agent from the one the
        // user deployed.
        ...(goal.timeframes.length > 0 ? { timeframes: goal.timeframes } : {}),
        skillIds: goal.skillIds,
        policy: {
          allowTrading: deployment.mode !== 'SHADOW',
          allowedOrderTypes: deployment.execution.allowedOrderTypes,
        },
      }),
      this.deps.env,
    );
    this.deps.agentRuntime.start(goal.agentId);
  }

  /**
   * Ask the model for a hypothesis and an observation plan.
   *
   * The third and last place GOAT reasons on its own initiative — after
   * goal interpretation and after a wake. It is told what it may not do:
   * no prices, no candles, no invented levels, and a price level it does
   * not have must be left out of the plan rather than guessed at.
   *
   * The `INVESTIGATION` contract matters more than it looks. The prompt
   * this sends used to be accompanied by a system prompt that demanded a
   * trading decision instead, so a model that obeyed the stronger of the
   * two returned `{"thought": "...", "decision": {"type": "WAIT"}}` and the
   * parser looking for `thesis` reported that the model had no hypothesis.
   */
  private async proposeInvestigation(
    goal: Goal,
    deployment: GoatDeployment,
  ): Promise<{
    proposed?: InvestigationProposal;
    /** Why there is nothing to apply, when there was nothing to apply. */
    unavailable?: string;
    /** Machine-readable form of the same cause. */
    unavailableCode?: string;
    /**
     * True when a model request went out and could not be read.
     *
     * Distinct from "unavailable" on purpose: that also covers a GOAT with no
     * runtime registered, which is not a model failure and must not be
     * recorded as one.
     */
    modelFailed?: boolean;
    /**
     * True when the provider answered and the answer was unusable.
     *
     * Suppresses the outage retry: the request reached OpenRouter, so waiting
     * cannot change the outcome and re-issuing it spends a model call to
     * arrive at the same unusable answer. The GOAT stays deployed and no
     * thesis is invented — the difference is the retry, not the outcome.
     */
    responseReached?: boolean;
    /** Real milliseconds the deciding call took, when one was made. */
    elapsedMs?: number;
    /** Resolutions the GOAT asked for and had to wait for before it could plan. */
    acquiredTimeframes?: string[];
  }> {
    const instance = this.deps.agentRuntime.getAgent(goal.agentId);
    if (!instance) {
      return { unavailable: 'This GOAT has no runtime registered, so it cannot reason right now.' };
    }

    const instructions = [
      this.skills.compilePhase(goal.skillIds, 'INVESTIGATION'),
      this.skills.compilePhase(goal.skillIds, 'THESIS_FORMATION'),
      this.skills.compilePhase(goal.skillIds, 'TRACKER_PLANNING'),
      this.toolGuide,
    ]
      .filter(Boolean)
      .join('\n\n');

    const timeframe = goal.timeframes[0] ?? DEFAULT_GOAT_TIMEFRAME;

    /*
     * Setup begins, recorded before anything is read rather than after.
     *
     * The order of this line matters more than its content. A deployment used
     * to show one "deployed" record and then nothing until the model replied,
     * so the entire setup — resolutions chosen, candles pulled, tools run —
     * happened inside a silence that looked exactly like a stuck agent. Now
     * the reader is told work has started, sees each read below it, and can
     * tell an agent that is reading from an agent that is blocked.
     */
    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_SETTING_UP',
      data: { market: deployment.marketId, timeframe, environment: this.deps.env.mode },
    });

    /*
     * Initialisation, recorded as the work it is.
     *
     * The first pass used to read one timeframe and record one line, so the
     * whole of a deployment looked like a pause followed by a thesis. Setup is
     * agent work — choosing resolutions, pulling candles, deciding what it
     * needs — and showing each read is what makes a GOAT look like it started
     * rather than like the app was waiting for the AI.
     *
     * Read once, here, and reused: the setup resolution feeds the observation
     * below rather than being fetched a second time.
     */
    const reads = await this.readMarketAcrossTimeframes(
      deployment.marketId,
      instance,
      timeframe,
    );
    const steering = this.steeringFor(goal.id);

    this.recordReads(goal, deployment, reads, timeframe);

    /*
     * Ask, read more if the answer says it needs more, then ask again.
     *
     * This is the difference between an agent given a fixed blob and an agent
     * that works out what it needs. A GOAT that cannot tell a 5m setup from a
     * 15m one asks for the resolution it is missing; the runtime reads it,
     * records that it did, and asks again with the wider context. Bounded, so a
     * model that keeps asking cannot spend a deployment on data acquisition.
     */
    const requested: string[] = [];
    const first = await this.askForTradePlan({
      goal,
      deployment,
      instance,
      timeframe,
      reads,
      steering,
      instructions,
      round: 0,
    });
    let response = first.response;
    // The deciding call is the last one, so its elapsed time is the one that
    // describes how long forming this plan actually took.
    let elapsedMs = first.elapsedMs;

    for (let round = 0; round < MAX_CONTEXT_ROUNDS; round += 1) {
      if (response.unavailable || response.malformed || response.toolCall) break;

      const { accepted, rejected } = parseTimeframes(response.payload?.['requestTimeframes']);
      const missing = accepted.filter((timeframe) => !reads.some((read) => read.context.timeframe === timeframe));
      if (missing.length === 0) {
        /*
         * Nothing new was asked for. Two reasons are possible and they deserve
         * different treatment: the model asked for resolutions it already has,
         * or it asked for something this product cannot read. The second is
         * said out loud, because a silent refusal looks like the agent decided
         * it did not need it.
         */
        if (rejected.length > 0) {
          this.recordActivity({
            goatId: goal.agentId,
            deploymentId: deployment.id,
            agentId: goal.agentId,
            type: 'MARKET_CONTEXT_PREPARED',
            data: {
              market: deployment.marketId,
              timeframes: reads.map((read) => read.context.timeframe),
              resolutions: reads.length,
              unsupported: rejected.join(', '),
              limitations: 0,
            },
          });
        }
        break;
      }

      for (const timeframe of missing) {
        this.recordActivity({
          goatId: goal.agentId,
          deploymentId: deployment.id,
          agentId: goal.agentId,
          type: 'MARKET_CONTEXT_PREPARED',
          data: {
            market: deployment.marketId,
            reason: `The GOAT asked for ${timeframe} before it could form a Trade Plan`,
            requested: timeframe,
          },
        });
      }

      const extra = await this.readMarketAcrossTimeframes(deployment.marketId, instance, timeframe, {
        extra: [...requested, ...missing],
      });
      for (const read of extra.filter((candidate) => missing.includes(candidate.context.timeframe as never))) {
        reads.push(read);
      }
      requested.push(...missing);
      this.recordReads(goal, deployment, reads, timeframe, { acquired: missing });

      const next = await this.askForTradePlan({
        goal,
        deployment,
        instance,
        timeframe,
        reads,
        steering,
        instructions,
        round: round + 1,
      });
      response = next.response;
      elapsedMs = elapsedMs + next.elapsedMs;
    }

    if (response.unavailable) {
      return {
        unavailable: response.unavailable.message,
        unavailableCode: response.unavailable.code,
        modelFailed: true,
        ...(response.unavailable.responseReached ? { responseReached: true } : {}),
      };
    }

    if (response.malformed) {
      return {
        unavailable:
          'The reasoning model returned a response TradingGOATs could not read. The GOAT is still deployed and this will be retried.',
        unavailableCode: 'MALFORMED_RESPONSE',
        modelFailed: true,
      };
    }

    /*
     * A tool call is not an answer.
     *
     * Some routes answer an investigation with a request for tools instead
     * of a hypothesis. That is well-formed JSON, so it used to pass every
     * readability check and fall through to "the model answered and the
     * answer held no hypothesis" — telling the user this GOAT had
     * considered the market and found nothing, when in fact it had never
     * said anything about the market at all.
     *
     * The market was already read, deterministically, before this call: the
     * tools the model is asking for are the ones it was already given. So
     * this is an unreadable answer, and it belongs in the same category as
     * a malformed one — reported, retried, deployment untouched.
     */
    if (response.toolCall) {
      return {
        unavailable:
          'The reasoning model asked for tools instead of answering. The GOAT is still deployed and this will be retried.',
        unavailableCode: 'TOOL_CALL_RESPONSE',
        modelFailed: true,
      };
    }

    const proposed = parseInvestigation(response);

    /*
     * A research line only when research produced nothing.
     *
     * When the answer holds a hypothesis, the Trade Plan record that follows is
     * the record of it — and two lines saying the same thing in two vocabularies
     * is the duplication this product is trying not to have. The research line
     * earns its place in the other case: the market was read, and the reading
     * did not yet support a plan.
     */
    if (!proposed) {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'MARKET_RESEARCH_COMPLETED',
        data: { formedThesis: false, rounds: requested.length + 1 },
      });
    }

    return {
      proposed,
      elapsedMs,
      ...(requested.length > 0 ? { acquiredTimeframes: requested } : {}),
    };
  }

  /**
   * One pass at the Trade Plan, with the context this GOAT has so far.
   *
   * Split out of the investigation so that dynamic acquisition can call it again
   * with a wider context: the prompt is assembled from the reads it is given, so
   * asking twice is asking with more evidence rather than re-asking the same
   * question a different way.
   */
  private async askForTradePlan(input: {
    goal: Goal;
    deployment: GoatDeployment;
    instance: AgentInstance;
    timeframe: string;
    reads: TimeframeContext[];
    steering: SteeringNote[];
    instructions: string;
    round: number;
  }): Promise<{ response: AgentModelResponse; elapsedMs: number }> {
    const { goal, deployment, instance, timeframe, reads, steering, instructions, round } = input;
    const market = reads[0].context;
    const observation = await this.buildObservation(instance, {
      symbol: deployment.marketId,
      skillIds: goal.skillIds,
      timeframe,
      market,
      ...(reads.length > 1
        ? { extraTimeframes: reads.slice(1).map((read) => read.context) }
        : {}),
    });

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'MARKET_CONTEXT_PREPARED',
      data: {
        market: deployment.marketId,
        timeframes: reads.map((read) => read.context.timeframe).join(', '),
        resolutions: reads.length,
        roles: reads.map((read) => `${read.context.timeframe} ${TIMEFRAME_ROLE_LABELS[read.role]}`).join(', '),
        chosenBy: reads[0].strategy === 'DECLARED' ? 'the goal' : 'the GOAT',
        candles: market.bars.received,
        indicators: Object.keys(market.indicators).length,
        limitations: market.limitations.length,
        ...(round > 0 ? { round } : {}),
      },
    });

    const { response, report } = await this.callModel({
      agentId: goal.agentId,
      deploymentId: deployment.id,
      phase: 'FORMING',
      intent: `Building the Trade Plan for ${deployment.marketId}`,
      submitted: {
        symbol: deployment.marketId,
        setupTimeframe: timeframe,
        timeframes: reads.map((read) => read.context.timeframe).join(', '),
        candles: market.bars.received,
        indicators: Object.keys(market.indicators).length,
        objective: goal.statement,
      },
      request: {
        agent: instance.agent,
        observation,
        contract: 'INVESTIGATION',
        instructions: [
          `You are deployed on ${deployment.marketId}.`,
          '',
          'MARKET CONTEXT — measured by deterministic tools, not estimated.',
          'Each resolution is labelled with the job it is doing for you:',
          this.renderTimeframeContexts(reads),
          '',
          this.renderKnownConstraints(goal.id),
          steering.length > 0
            ? `OPERATOR STEERING (runtime guidance, applies to this and later wakeups):\n${steering
                .slice(-3)
                .map((note) => `- ${note.text}`)
                .join('\n')}`
            : '',
          'This is your first pass on this market. Investigate and decide what to believe.',
          '',
          'What you produce is ONE Trade Plan. In this product the plan and the',
          'hypothesis are the same object: what you believe could happen, what',
          'must happen for you to be right, and what you will do if it is.',
          '',
          'Rules for this answer:',
          '- `invalidation` is required. Without it you do not have a plan.',
          '- Deploy two to four conditions to watch. Fewer is not thorough; more is not persistence.',
          '- Each condition\'s config must match its published contract exactly. One wrong',
          '  field and it is refused.',
          '- NEW_BAR needs no number and is never refused. Reach for it first, and add a',
          '  level-based condition only when the runtime has actually given you a level.',
          '- SESSION_START, SESSION_END, position and order kinds are not available to you.',
          '  Their config can only be written once the venue or the account supplies it.',
          '- Never state a price, candle, indicator value or volume that was not provided.',
          `- You may read any of these resolutions: ${SUPPORTED_TIMEFRAMES.join(', ')}.`,
          '- If the context you were given cannot support a plan — because a resolution you need',
          '  is missing — return {"requestTimeframes": ["1h"]} and nothing else. The runtime will',
          '  read it and ask you again. Do that instead of guessing.',
          '- If you genuinely cannot form a plan from what you have, say so in "thought" and',
          '  return no "thesis" key. That is an acceptable answer and is not a failure.',
        ].join('\n'),
        skillsInstructions: instructions,
        toolHistory: [],
        iteration: round,
        wakeReason: 'DEPLOYED',
      },
    });

    return { response, elapsedMs: report.elapsedMs };
  }

  /**
   * One line per resolution read, with the job it was doing.
   *
   * The role is on the line rather than left to be inferred from the size,
   * because "read 1h" and "read 1h for regime" are different claims, and only
   * one of them can be checked against what the agent then did.
   */
  private recordReads(
    goal: Goal,
    deployment: GoatDeployment,
    reads: TimeframeContext[],
    setupTimeframe: string,
    options: { acquired?: string[] } = {},
  ): void {
    for (const read of reads) {
      if (options.acquired && !options.acquired.includes(read.context.timeframe as never)) continue;
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'MARKET_CONTEXT_LOADED',
        data: {
          ...marketContextEvidence(read.context),
          timeframe: read.context.timeframe,
          role: TIMEFRAME_ROLE_LABELS[read.role],
          reason: read.reason,
          chosenBy: read.strategy === 'DECLARED' ? 'the goal' : 'the GOAT',
          setup: read.context.timeframe === setupTimeframe,
          ...(options.acquired ? { acquired: true } : {}),
        },
      });
    }
  }

  /**
   * Come back and look again, once, if the GOAT is still deployed.
   *
   * The alternative was a GOAT that is permanently asleep: a first pass over
   * a market that said nothing leaves it with no thesis, and a tracker can
   * only belong to a thesis. Fabricating one so that something would wake
   * it would be inventing the agent's belief, which is the one thing this
   * system must never do. So the GOAT returns on a timer instead, a bounded
   * number of times, and every one of those looks is written to the feed.
   */
  private scheduleReconsideration(
    goal: Goal,
    deployment: GoatDeployment,
    cause: 'MODEL_UNAVAILABLE' | 'NO_THESIS' = 'NO_THESIS',
  ): void {
    this.clearReconsideration(goal.agentId);

    const looks = (this.noThesisLooks.get(goal.agentId) ?? 0) + 1;
    this.noThesisLooks.set(goal.agentId, looks);

    if (looks > MAX_UNPROMPTED_RECONSIDERATIONS) {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'GOAT_WAITING',
        data: {
          trackers: 0,
          exhausted: true,
          looks,
          message:
            'This GOAT looked several times and found nothing it could act on. It is deployed and will wake you if a condition it set fires.',
        },
      });
      return;
    }

    const timer = setTimeout(() => {
      this.reconsiderTimers.delete(goal.agentId);
      const current = this.stores.deployments.currentFor(goal.agentId);
      if (!current) return;
      if (this.stores.theses.listLiveForGoal(goal.id).length > 0) return;
      void this.investigateGoal(goal.id).catch(() => undefined);
    }, GOAT_RECONSIDER_AFTER_MS);

    // A pending look must never hold the process open on its own.
    timer.unref?.();
    this.reconsiderTimers.set(goal.agentId, timer);

    this.recordActivity({
      goatId: goal.agentId,
      deploymentId: deployment.id,
      agentId: goal.agentId,
      type: 'GOAT_WAITING',
      data: {
        trackers: 0,
        looks,
        reconsiderInMs: GOAT_RECONSIDER_AFTER_MS,
        message: `No Trade Plan on look ${looks} of ${MAX_UNPROMPTED_RECONSIDERATIONS}; it will look again on its own shortly.`,
      },
    });

    /*
     * A retry that was actually armed, announced as one.
     *
     * The failure line above says the model could not be read and the wait
     * line says the GOAT will look again; nothing joined them, so the log read
     * as a failure followed by an unrelated sleep. Emitted only once the timer
     * exists, and only for the failure case — a GOAT that answered and found
     * no hypothesis has not been retried, it has thought.
     */
    if (cause === 'MODEL_UNAVAILABLE') {
      this.recordActivity({
        goatId: goal.agentId,
        deploymentId: deployment.id,
        agentId: goal.agentId,
        type: 'MODEL_RETRY',
        data: {
          looks,
          retryInMs: GOAT_RECONSIDER_AFTER_MS,
          message: `Bounded retry ${looks} of ${MAX_UNPROMPTED_RECONSIDERATIONS} scheduled.`,
        },
      });
    }
  }

  /** Cancel a pending look. Called whenever the deployment stops. */
  private clearReconsideration(agentId: string): void {
    const timer = this.reconsiderTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.reconsiderTimers.delete(agentId);
  }

  /**
   * Stop a GOAT and release its executor.
   *
   * The goal and everything it learned are kept: a GOAT that was pointed
   * at the wrong market is a user mistake, not a reason to make them
   * write the goal again.
   */
  async undeployGoat(goalId: string, reason = 'Undeployed.'): Promise<void> {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return;
    const deployment = this.stores.deployments.currentFor(goal.agentId);
    if (deployment) {
      this.retireDeployment(deployment, reason);
      /*
       * Retire the durable runtime, and await it.
       *
       * Awaited here, unlike the activation on deploy, because undeploying is
       * already async and already a deliberate act: returning while a retired
       * deployment's watcher is still registered is exactly the orphan this method
       * exists to prevent — a runtime that keeps waking for a deployment the user
       * has just deleted.
       */
      await this.retireRuntime(deployment, reason);
    }
    if (this.deps.agentRuntime.getAgent(goal.agentId)) {
      await this.deps.agentRuntime.stop(goal.agentId);
      this.deps.agentRuntime.unregisterAgent(goal.agentId);
    }

    this.trackers.disposeAgent(goal.agentId);
    this.stores.goals.save({
      ...goal,
      symbols: [],
      timeframes: [],
      status: 'UNDEPLOYED',
      updatedAt: this.now(),
    });
  }

  /**
   * Register the durable runtime for a deployment.
   *
   * Best effort by construction: the report is recorded and the deployment stands.
   * A deployment whose runtime could not be registered is still running in this
   * tab, and telling the user it failed would be wrong — what is true is that it
   * will not survive this tab, which is a different and much smaller claim.
   */
  private async activateRuntime(
    agentId: string,
    deploymentId: string,
    market: string,
    timeframes: string[],
  ): Promise<void> {
    // Goals are keyed by goal id and reached by agent id, so the lookup is by
    // agent — `getForAgent` exists for exactly this and `get` would silently
    // return nothing, which is how a runtime ends up unregistered with no error.
    const goal = this.stores.goals.getForAgent(agentId);
    const identity: RuntimeIdentity | undefined = this.runtimeIdentity(agentId, deploymentId);
    if (!goal || !identity) return;

    let report: RuntimeReport;
    try {
      report = await this.runtime.activate({
        ...identity,
        market,
        name: goal.name?.trim() || goal.statement.slice(0, 60),
        configurationVersion: 1,
        conditionTree: this.runtimeConditionTree(agentId, market, timeframes),
        timeframes,
      });
    } catch (error) {
      report = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (report.ok) {
      this.recordActivity({
        goatId: agentId,
        deploymentId,
        agentId,
        type: 'RUNTIME_REGISTERED',
        data: { watcherId: report.watcherId, market },
      });
      return;
    }
    // A skipped runtime is not news — no worker configured is the normal case for
    // a replay and for a build without one — so it is not logged. A *failed* one
    // is, because somebody asked for durability and did not get it.
    if (report.skipped !== true) {
      this.recordActivity({
        goatId: agentId,
        deploymentId,
        agentId,
        type: 'RUNTIME_UNAVAILABLE',
        data: { reason: report.reason, phase: 'activate' },
      });
    }
  }

  /** Stop the durable runtime waking, keeping its state for a resume. */
  private async suspendRuntime(deployment: GoatDeployment, reason: string): Promise<void> {
    const identity = this.runtimeIdentity(deployment.goatId, deployment.id);
    if (!identity) return;
    try {
      const report = await this.runtime.suspend(identity);
      if (!report.ok && report.skipped !== true) {
        this.recordActivity({
          goatId: deployment.goatId,
          deploymentId: deployment.id,
          agentId: deployment.goatId,
          type: 'RUNTIME_UNAVAILABLE',
          data: { reason: report.reason, phase: 'suspend' },
        });
      }
    } catch (error) {
      this.recordActivity({
        goatId: deployment.goatId,
        deploymentId: deployment.id,
        agentId: deployment.goatId,
        type: 'RUNTIME_UNAVAILABLE',
        data: { reason: error instanceof Error ? error.message : String(error), phase: 'suspend' },
      });
    }
    void reason;
  }

  /** Discard the durable runtime's state entirely. */
  private async retireRuntime(deployment: GoatDeployment, reason: string): Promise<void> {
    const identity = this.runtimeIdentity(deployment.goatId, deployment.id);
    if (!identity) return;
    try {
      const report = await this.runtime.retire(identity);
      if (!report.ok && report.skipped !== true) {
        this.recordActivity({
          goatId: deployment.goatId,
          deploymentId: deployment.id,
          agentId: deployment.goatId,
          type: 'RUNTIME_UNAVAILABLE',
          data: { reason: report.reason, phase: 'retire' },
        });
      }
    } catch {
      // Deliberately swallowed. The deployment is already retired locally, and a
      // runtime that outlives it is cleaned up by the worker's own reconciliation;
      // failing the undeploy instead would leave the user with a half-removed GOAT.
    }
    void reason;
  }

  /**
   * The worker's identity for a deployment, when there is one to be had.
   *
   * Absent without a signed-in user, because the user id is the worker's only
   * notion of who is asking and it must come from a verified session — never from
   * a GOAT, a goal record, or anything the caller could supply.
   */
  private runtimeIdentity(goalId: string, deploymentId: string): RuntimeIdentity | undefined {
    const userId = this.deps.runtimeUserId?.();
    if (!userId) return undefined;
    return { userId, goalId, deploymentId };
  }

  /**
   * The conditions the durable runtime should watch.
   *
   * The GOAT's live trackers when it has any, because those are the conditions it
   * has actually armed — handing the worker a different set would mean it woke for
   * something this GOAT is not watching. Before the first thesis exists there are
   * none, so the tree records the market and the resolutions it works across, which
   * is the honest answer: "watch this market, at these resolutions".
   */
  private runtimeConditionTree(agentId: string, market: string, timeframes: string[]): unknown {
    const trackers = this.trackers
      .listForAgent(agentId)
      .filter((tracker) => tracker.lifecycle.status === 'ACTIVE');

    if (trackers.length === 0) {
      return {
        schemaVersion: 1,
        then: 'all',
        root: {
          kind: 'GROUP',
          description: `${market} at ${timeframes.join(', ') || 'the deployment resolution'}`,
          children: timeframes.map((timeframe) => ({
            kind: 'NEW_BAR',
            timeframe,
            config: {},
          })),
        },
      };
    }

    return {
      schemaVersion: 1,
      then: 'all',
      root: {
        kind: 'GROUP',
        children: trackers.map((tracker) => ({
          kind: tracker.kind,
          timeframe: tracker.timeframe,
          config: tracker.config,
        })),
      },
    };
  }

  /**
   * The session a GOAT is currently in.
   *
   * Public because the surfaces that render a session — the detail page, the
   * backtest runner — have to be able to stamp their work with it, and because a
   * caller deciding whether to start work needs to compare against the same value
   * the guard compares against.
   */
  currentSession(agentId: string): GoatSessionIdentity {
    return this.sessions.current(agentId);
  }

  /**
   * Whether work carrying this session may still mutate the GOAT.
   *
   * The single choke point for stale work. Every asynchronous path calls this
   * immediately before it writes, so a response, a wake, a retry or a cloud callback
   * from a cleared session is refused at the moment it would have applied rather
   * than being noticed afterwards by a UI that no longer shows it.
   */
  isSessionCurrent(identity: GoatSessionIdentity): boolean {
    return this.sessions.isCurrent(identity);
  }

  /**
   * Whether the current session has produced anything at all.
   *
   * This is what separates two states a GOAT is otherwise indistinguishable in:
   * one that is *running and has not concluded anything yet*, and one whose
   * session was *cleared and has never started*. The first should say it is still
   * gathering evidence; the second must say it has no session, because telling
   * someone who just wiped a session that it is "researching" implies work is in
   * progress that does not exist.
   *
   * Derived from the records rather than tracked as a flag: a flag can disagree
   * with the state it describes, and a reload would preserve the disagreement.
   */
  sessionHasWork(agentId: string): boolean {
    const goal = this.stores.goals.getForAgent(agentId);
    if (!goal) return false;
    if (this.stores.theses.listForGoal(goal.id).length > 0) return true;
    if (this.stores.ideas.listForGoal(goal.id).length > 0) return true;
    if (this.trackers.listForAgent(agentId).some((tracker) => tracker.lifecycle.status === 'ACTIVE')) return true;
    /*
     * The log decides it too, excluding the clear's own sequence.
     *
     * A log whose only records are "stopped", "session cleared" and "refused
     * stale work" is the definition of a session with nothing in it. Counting the
     * stop as work would report a cleared GOAT as though it were mid-session, which
     * is the confusion this method exists to prevent.
     */
    const log = this.agentLog(goal.id, 200);
    return log.some((entry) => !CLEAR_SEQUENCE_EVENTS.has(entry.type as AgentTimelineEventType));
  }

  /** The message recorded when work from a cleared session is refused. */
  private staleWork(what: string, identity: GoatSessionIdentity): ReturnType<typeof staleWorkMessage> {
    const report = staleWorkMessage(what, identity);
    const current = this.sessions.peek(identity.goatId);
    this.recordActivity({
      goatId: identity.goatId,
      agentId: identity.goatId,
      type: 'STALE_WORK_REFUSED',
      data: { what, reason: report.reason, sessionId: identity.sessionId, generation: identity.generation },
    });
    return { ...report, ...(current ? { currentGeneration: current.generation } : {}) };
  }

  /** Move an existing deployment to paused, without losing the record. */
  pauseGoat(goalId: string): GoatDeployment | undefined {
    const deployment = this.currentDeployment(goalId);
    if (!deployment) return undefined;
    const paused = { ...deployment, status: 'paused' as const, updatedAt: this.now() };
    this.stores.deployments.save(paused);
    /*
     * Suspend, do not retire.
     *
     * A paused GOAT keeps its durable state — its cooldowns and its last
     * evaluation are the record of what it was doing — and a resume continues from
     * there. Retiring here would throw that away on every pause, which is what
     * makes a pause indistinguishable from an undeploy.
     */
    void this.suspendRuntime(deployment, 'Paused by the operator.');
    return paused;
  }

  private retireDeployment(deployment: GoatDeployment, reason: string): void {
    this.clearReconsideration(deployment.goatId);
    this.noThesisLooks.delete(deployment.goatId);
    this.stores.deployments.save({
      ...deployment,
      status: 'stopped',
      updatedAt: this.now(),
    });
    const goal = this.stores.goals.list().find((item) => item.agentId === deployment.goatId);
    if (!goal) return;

    /*
     * Remember exactly what this stop took down.
     *
     * `restoreObservationPlan` can otherwise only see that a tracker is
     * cancelled, not which stop cancelled it, so every resume restored
     * every cancelled tracker the thesis had ever had — and the observation
     * plan grew by a full set on the second pause. This is the answer to
     * "restore what was interrupted", and it is cleared when used.
     */
    const cancelled = this.trackers.cancelTrackersForAgent(deployment.goatId, reason);
    const previous = this.stoppedTrackers.get(deployment.goatId) ?? [];
    this.stoppedTrackers.set(deployment.goatId, [
      ...previous,
      ...cancelled.map((tracker) => tracker.id),
    ]);

    this.recordActivity({
      goatId: deployment.goatId,
      deploymentId: deployment.id,
      agentId: deployment.goatId,
      type: 'GOAT_STOPPED',
      data: { reason, trackers: cancelled.length },
    });
  }

  /** The deployment a GOAT is currently running, if any. */
  currentDeployment(goalId: string): GoatDeployment | undefined {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return undefined;
    return this.stores.deployments.currentFor(goal.agentId);
  }

  /**
   * Everything known about one GOAT, derived.
   *
   * The single answer to "what is this doing". Read by the GOAT screens and
   * by the assistant's tools, so the two cannot disagree.
   */
  mission(goalId: string): GoatMission | undefined {
    const goal = this.stores.goals.get(goalId);
    if (!goal) return undefined;
    return this.buildMissionFor(goal, this.now());
  }

  /** The mission for every GOAT that is still in play, newest first. */
  missions(): GoatMission[] {
    return this.stores.goals
      .list()
      .filter((goal) => goal.status !== 'ABANDONED')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((goal) => this.buildMissionFor(goal, this.now()));
  }

  /**
   * The missions of GOATs that are running right now: the operational
   * view. A stopped GOAT keeps its deployment record but is not live, and
   * listing it here would put a GOAT that cannot act at the top of a page
   * titled "Live".
   */
  liveMissions(): GoatMission[] {
    return this.missions().filter((mission) => mission.runtime === 'RUNNING');
  }

  private buildMissionFor(goal: Goal, now: number): GoatMission {
    const deployment = this.stores.deployments.currentFor(goal.agentId);
    const lastDeployment = this.stores.deployments.historyFor(goal.agentId)[0];
    const instance = this.deps.agentRuntime.getAgent(goal.agentId);

    /*
     * `ERROR` is a real state and not an edge case. A GOAT with an active
     * deployment and no executor is a GOAT that looks deployed and cannot
     * do anything, and the one thing worse than showing that is hiding it.
     */
    /*
     * "Never deployed" and "deployed and then stopped" are different
     * states with different next actions, and collapsing them would make a
     * paused GOAT look like one that was never started.
     */
    const runtime: RuntimeStatus = !deployment
      ? lastDeployment
        ? 'STOPPED'
        : 'UNDEPLOYED'
      : !instance
        ? 'ERROR'
        : instance.isRunning
          ? 'RUNNING'
          : 'STOPPED';

    const theses = this.stores.theses.listForGoal(goal.id);
    const ideas = this.stores.ideas.listForGoal(goal.id);
    const events = this.trackers
      .listEvents()
      .filter(
        (event) =>
          event.goalId === goal.id ||
          theses.some((thesis) => thesis.id === event.thesisId),
      );

    const evidence = theses.flatMap((thesis) => this.stores.evidence.listForThesis(thesis.id));
    const latestWake = events.length > 0 ? Math.max(...events.map((event) => event.timestamp)) : 0;

    return buildMission({
      goal,
      /*
       * Derived from the records, so a reload cannot disagree with it: a GOAT whose
       * session was cleared has no thesis, no plan, no trackers and a log containing
       * only the clear, and that combination is what "no session yet" means.
       */
      sessionHasWork: this.sessionHasWork(goal.agentId),
      /*
       * The last deployment, not just the active one. A stopped GOAT still
       * knows its market, its mode and whether it may execute, and without
       * those facts the command centre can only offer "Deploy" — which
       * reads as "this was never set up" and invites a second deployment
       * record for a GOAT that already has one.
       */
      deployment: deployment ?? lastDeployment,
      runtime,
      theses,
      trackers: this.trackers.listForGoal(goal.id),
      events,
      evidence,
      tradePlan: ideas.sort((a, b) => b.createdAt - a.createdAt)[0],
      steering: this.steeringStore.listFor(goal.id),
      /*
       * The GOAT's own recorded history, so the surface can tell "working"
       * from "its last step failed" without a second read. Read newest
       * first, and the window is deliberately wider than it looks: the
       * surface also has to resolve whether a recorded failure has been
       * superseded by anything that worked since, and a GOAT that records a
       * model failure followed by five sleep lines has already pushed it
       * past a short window. Anything older than this has had more than
       * twenty-five things happen after it, so it is history either way.
       */
      activity: this.recentActivityFor(goal.agentId, 25),
      outstandingConstraints: this.loop.outstandingConstraints(goal.id),
      reEvaluating: runtime === 'RUNNING' && now - latestWake < 8_000,
      /*
       * The live model request, when there is one. Passed in rather than
       * derived from timestamps, because the read model must never guess what
       * the runtime is doing: the orchestrator knows whether a request is
       * outstanding, and that is the whole fact.
       */
      modelPending: this.pendingModels.has(goal.agentId)
        ? this.pendingModels.get(goal.agentId)
        : undefined,
      now,
    });
  }

  /**
   * The most recent records for one GOAT, newest first.
   *
   * Reads through the synchronous snapshot, so this is a projection and not
   * a workflow step. Bounded, because the question it answers — "what did it
   * last manage to do?" — never needs more than a handful of records.
   */
  private recentActivityFor(agentId: string, limit: number): Array<{ at: number; type: string }> {
    try {
      const store = this.deps.agentRuntime.getTimelineStore();
      if (!store.snapshotByGoat) return [];
      return store
        .snapshotByGoat(agentId, limit)
        .slice()
        .reverse()
        .map((event) => ({ at: event.timestamp, type: event.type }));
    } catch {
      return [];
    }
  }

  /** Every deployment a GOAT has had, newest first. */
  deploymentHistory(goalId: string): GoatDeployment[] {
    const goal = this.stores.goals.get(goalId);
    return goal ? this.stores.deployments.historyFor(goal.agentId) : [];
  }

  listDeployments(): GoatDeployment[] {
    return this.stores.deployments.list();
  }

  /**
   * Build the runtime agent that backs a GOAT.
   *
   * The agent is the *executor* for a GOAT, not the GOAT itself. It is
   * given the tracker capabilities the goal's skills grant, and it is
   * given no observation plan at all: the plan is the agent's own
   * output, not the user's input.
   *
   * `market` is absent until deployment, which is why the symbols are
   * empty rather than defaulted: a GOAT that has not been pointed
   * anywhere has no market, and inventing one would be a decision made
   * on the user's behalf.
   */
  private buildAgent(input: {
    id: string;
    goal: string;
    market?: string;
    timeframe?: string;
    /**
     * Every resolution this GOAT may work across.
     *
     * Left unset, the GOAT gets the whole menu. That is the honest default:
     * a goal like "find a short-term breakout" needs 1h context, a 15m setup
     * and a 5m trigger, and a single resolution cannot express that. The
     * agent picks from this set per pass and is expected to say which it
     * used, so the choice is visible rather than assumed.
     */
    timeframes?: string[];
    skillIds: string[];
    policy?: Partial<AgentPolicy>;
    instructions?: string;
  }): TradingAgent {
    const now = this.now();
    const skillCapabilities = this.skills.resolveCapabilities(input.skillIds);
    const symbols = input.market ? [input.market] : [];
    const timeframes =
      input.timeframes && input.timeframes.length > 0
        ? [...input.timeframes]
        : [...TIMEFRAMES_A_GOAT_MAY_RESEARCH];

    return {
      id: input.id,
      name: 'GOAT',
      description: `Goal-Oriented Agentic Trader pursuing: ${input.goal}`,
      instructions:
        input.instructions ??
        [
          'You are a Goal-Oriented Agentic Trader.',
          '',
          'The user gave you a goal. You decide what to investigate, what to',
          'hypothesise, what evidence would confirm or refute it, and what to',
          'watch for while you wait.',
          '',
          'You do not poll the market. You deploy trackers and go dormant. A',
          'tracker waking you is a fact, not a signal: decide for yourself what',
          'it means for the thesis.',
          '',
          'Before proposing any trade, state the condition under which your',
          'hypothesis is wrong. If you cannot, you do not have a hypothesis yet.',
        ].join('\n'),
      /*
       * The internal baseline skill is part of every GOAT's skill list, so
       * reading the market is a property of being a GOAT rather than
       * something the user has to know to switch on.
       */
      skills: [GOAT_CORE_SKILL_ID, ...input.skillIds.filter((id) => id !== GOAT_CORE_SKILL_ID)],
      capabilities: [
        ...new Set([...skillCapabilities, ...GOAT_CORE_SKILL.requiredCapabilities]),
      ],

      policy: {
        maxRiskPerTrade: input.policy?.maxRiskPerTrade ?? 0.01,
        maxDailyLoss: input.policy?.maxDailyLoss,
        maxDrawdown: input.policy?.maxDrawdown,
        maxOpenPositions: input.policy?.maxOpenPositions ?? 1,
        maxExposure: input.policy?.maxExposure ?? 50_000,
        maxOrdersPerMinute: input.policy?.maxOrdersPerMinute ?? 10,
        /*
         * An undeployed GOAT has no allowed symbols, and a deployment
         * narrows this to exactly the market it was pointed at.
         */
        allowedSymbols: input.policy?.allowedSymbols ?? symbols,
        allowedSessions: input.policy?.allowedSessions,
        allowedOrderTypes: input.policy?.allowedOrderTypes,
        /*
         * Order submission, and only order submission.
         *
         * This switch is false for every SHADOW deployment and it does not
         * touch research: reading the market, forming a thesis, deploying
         * trackers and writing a trade plan are all permitted, and the
         * agent prompt now says so in those words. A GOAT told "trading is
         * disabled" next to its own deployed symbol would answer that it
         * could not investigate — which is what it used to do.
         */
        allowTrading: input.market ? (input.policy?.allowTrading ?? false) : false,
      },
      preferredEnvironment: this.deps.env.mode,
      symbols,
      timeframe: input.timeframe ?? DEFAULT_GOAT_TIMEFRAME,
      timeframes,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Ask the agent what the goal means and what it would investigate.
   *
   * Runs once, at goal creation. If the model is unavailable the goal
   * is still recorded and reported as not yet actionable, rather than
   * being quietly reduced to whatever a default template said.
   */
  private async interpretGoal(goal: Goal, agent: ReturnType<GoatOrchestrator['buildAgent']>): Promise<GoalInterpretation> {
    const observation: AgentObservation = {
      timestamp: this.now(),
      environment: this.deps.env.mode,
      market: { quotes: [] },
      account: {
        balance: 0,
        equity: 0,
        margin: 0,
        freeMargin: 0,
        dailyPnL: null,
        drawdownPercent: null,
      },
      positions: [],
      orders: [],
      availableCapabilities: this.capabilities.list().map((c) => c.id),
      availableSkills: goal.skillIds,
    };

    const phaseInstructions = this.skills.compilePhase(goal.skillIds, 'GOAL_INTERPRETATION');

    try {
      /*
       * Instrumented like every other reasoning step, because it is one.
       *
       * It used to be the only model call that went around the front door, so
       * the composer could sit silent for seconds with nothing in the log and no
       * pulsing state to say why. It is now a MODEL line, a pending state while
       * it is outstanding, and a recorded measurement — and the run genuinely
       * does stop while it is in flight, so a replay holding for its agent
       * includes this window.
       */
      const { response } = await this.callModel({
        agentId: goal.agentId,
        phase: 'FORMING',
        intent: 'Reading the objective you gave this GOAT',
        submitted: { objective: goal.statement.slice(0, 120) },
        request: {
        agent,
        // A GOAT that has not been deployed has no market, but it always has
        // an objective — and that is the only thing this call is reading.
        objective: goal.statement,
        observation,
        instructions: [
          'Interpret the user\'s objective. Do not trade. Do not deploy trackers yet.',
          '',
          'The user has not chosen a market yet — that happens at deployment, and',
          'you are not being asked to choose one. Say what the objective is asking',
          'for and what you will look at once you are pointed somewhere.',
          '',
          'An objective does not have to be a strategy. "Find a high-quality',
          'EUR/USD opportunity, and wait for clear evidence before producing a plan"',
          'is a complete objective. Working out the entry, the stop, the target and',
          'the timeframe is your job, not the user\'s.',
        ].join('\n'),
        skillsInstructions: phaseInstructions,
        toolHistory: [],
        iteration: 0,
        wakeReason: 'GOAL_CREATED',
        contract: 'INTERPRETATION',
        },
      });

      /*
       * The model may have answered with something unusable, or may never
       * have been reached at all. The second case has a cause worth
       * naming — a missing key is fixed by one button, and telling
       * someone to rewrite their goal when the real problem is a
       * credential sends them off to fix the wrong thing.
       */
      if (response.unavailable) {
        return {
          understood: '',
          symbols: goal.symbols,
          timeframes: goal.timeframes,
          investigationPlan: [],
          openQuestions: [response.unavailable.message],
          actionable: false,
        };
      }

      const parsed = parseInterpretation(response);
      /*
       * A reading has to be a reading.
       *
       * A small free model will occasionally answer the interpretation
       * contract with two words that have nothing to do with the objective
       * — "User Safety: safe" was the real answer from a live deployment.
       * Storing that would put it under "Understand your objective" in the
       * work plan, presented as the GOAT's understanding of what the user
       * asked for, which is worse than showing nothing.
       *
       * So a reading that is too short to be a reading is refused, and the
       * existing "unreadable" path says so instead of pretending.
       */
      const readable =
        parsed !== undefined && parsed.understood.trim().length >= MIN_INTERPRETATION_LENGTH
          ? parsed
          : undefined;

      if (!readable) {
        /*
         * The model's own words, kept — but only as the model's words. This
         * used to be stored as the goal's `interpretation` and then
         * rendered forever under "Understand your objective", which is how
         * a GOAT deployed on EUR/USD ended up displaying "no deployed
         * symbol or quote is provided, so no market can be investigated"
         * as its understanding of its own objective. It was the model's
         * prose about an empty observation, not a fact about the GOAT.
         */
        return {
          understood: response.thought.slice(0, 500),
          symbols: goal.symbols,
          timeframes: goal.timeframes,
          investigationPlan: [],
          openQuestions: [
            'This reading of your objective came back unreadable, so it will be re-read once the GOAT is deployed.',
          ],
          actionable: false,
        };
      }
      return readable;
    } catch {
      return {
        understood: '',
        symbols: goal.symbols,
        timeframes: goal.timeframes,
        investigationPlan: [],
        openQuestions: ['The reasoning model is unavailable, so the goal has not been interpreted yet.'],
        actionable: false,
      };
    }
  }

  /**
   * A tracker fired. Wake the agent.
   *
   * The wake is delivered through the existing `handleEvent` path, so
   * it inherits the single-flight guard, the relevance filter and the
   * timeline record that every other wake already gets.
   */
  private async handleTrackerEvent(event: TrackerEvent): Promise<void> {
    const wake = this.trackers.wakeRequestForEvent(event.id);
    if (!wake) return;
    /*
     * An error boundary, not a swallow.
     *
     * This handler is invoked as `void this.domain.onEvent(event)`, so
     * anything it throws becomes an unhandled rejection: the browser logs
     * it, nothing else does, and the activity feed is left showing a
     * `GOAT_WOKE` with no outcome — a GOAT that appears to have thought
     * about something and then said nothing, forever.
     *
     * `applyPlan` can genuinely throw. A wake that lands on a thesis which
     * has since gone terminal makes `reviseThesis` refuse the transition,
     * which is the state machine working correctly; the bug was never
     * reaching the user. Recording the refusal keeps the feed honest and
     * leaves the runtime exactly as it was: nothing torn down, no thesis
     * half-written, no plan fabricated.
     */
    try {
      await this.runWake(wake);
    } catch (error) {
      this.recordActivity({
        goatId: wake.agentId,
        deploymentId: this.stores.deployments.currentFor(wake.agentId)?.id,
        agentId: wake.agentId,
        type: 'GOAT_WAITING',
        data: {
          // `message` is what a GOAT_WAITING line renders; a `reason` here
          // would be discarded and the feed would show "Waiting on
          // 0 trackers" in place of the refusal.
          message: `The wake could not be applied, so nothing was changed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          thesisId: wake.thesisId,
        },
      });
    }
  }

  /**
   * Re-evaluate a thesis against a tracker event.
   *
   * Exposed so a backtest, a test, or a manual "look again" can drive
   * exactly the same path a live wake takes.
   */
  async runWake(wake: WakeRequest, plan?: AgentPlan): Promise<ReturnType<GoatLoop['applyPlan']> | undefined> {
    const thesis = this.stores.theses.get(wake.thesisId);
    if (!thesis) return undefined;

    /*
     * The session this wake belongs to, captured before anything is awaited.
     *
     * Checked twice: once here, so a wake that is already stale never reaches the
     * model, and once after the model answers, because that is where a CLEAR
     * pressed during the request would show up. The second check is the one that
     * matters — it is the only thing standing between a cleared session and an
     * answer that was computed against it.
     */
    const session = this.sessions.current(wake.agentId);
    if (!this.sessions.isCurrent(session)) return undefined;
    this.inFlightSessions.set(wake.agentId, session);

    const context = this.loop.buildContext(wake.agentId, wake.thesisId, wake.event);
    if (!context) return undefined;

    const deployment = this.stores.deployments.currentFor(wake.agentId);

    /*
     * The observation, in its own right.
     *
     * `GOAT_WOKE` says the agent woke; it does not say what it saw. The
     * tracker runtime also writes a `TRACKER` row for every observation, but
     * that row carries no `goatId`, so `snapshotByGoat` filtered it out and
     * the GOAT's own log never showed a tracker firing — only the fact that
     * the agent woke. The observation and the wake are two different facts
     * and a reader needs both.
     *
     * Written from the tracker record, so the reason is the tracker's own.
     */
    this.recordActivity({
      goatId: context.agentId,
      deploymentId: context.deployment.deploymentId,
      agentId: wake.agentId,
      type: 'TRACKER_FIRED',
      data: {
        trackerId: wake.event.trackerId,
        thesisId: wake.thesisId,
        symbol: wake.event.symbol,
        kind: wake.event.kind,
        reason: wake.event.reason,
        severity: wake.event.severity,
        observed: wake.event.observedValues,
      },
    });

    this.recordActivity({
      goatId: context.agentId,
      deploymentId: context.deployment.deploymentId,
      agentId: wake.agentId,
      type: 'GOAT_WOKE',
      data: {
        symbol: wake.event.symbol,
        reason: wake.event.reason,
        thesisId: wake.thesisId,
        ...(wake.event.source ? { source: wake.event.source } : {}),
      },
    });

    const decided = plan ?? (await this.reason(context, wake));

    /*
     * Re-check after the model has been consulted.
     *
     * A plan is only applied to the session that asked for it. Without this, a GOAT
     * that is cleared while a request is outstanding would apply that request's
     * answer on arrival — recreating the thesis, the evidence and the trackers the
     * user had just deleted, and logging them into a session that no longer exists.
     */
    if (!this.sessions.isCurrent(session)) {
      this.inFlightSessions.delete(wake.agentId);
      this.staleWork('A wake decision', session);
      return undefined;
    }

    const outcome = this.loop.applyPlan(wake, decided);
    this.inFlightSessions.delete(wake.agentId);

    /*
     * Evidence, before the conclusion it produced.
     *
     * `applyPlan` records evidence and then revises the thesis, but only the
     * revision was ever written to the timeline. An agent log could therefore
     * show "Thesis revised to STRENGTHENING" with no indication of what the
     * agent saw, which is the one thing that makes a revision interpretable —
     * and it is recorded here, from the ids the loop actually stored, so it
     * cannot describe evidence that was not written.
     *
     * Order matters for the narrative: the reader sees what was observed, and
     * then what the agent concluded from it.
     */
    for (const evidenceId of outcome.evidenceRecorded) {
      const evidence = this.stores.evidence.listForThesis(wake.thesisId)
        .find((item) => item.id === evidenceId);
      if (!evidence) continue;
      this.recordActivity({
        goatId: context.agentId,
        deploymentId: context.deployment.deploymentId,
        agentId: wake.agentId,
        type: 'AGENT_EVIDENCE',
        data: {
          thesisId: evidence.thesisId,
          polarity: evidence.polarity,
          summary: evidence.summary,
          trackerEventId: evidence.trackerEventId,
          observed: evidence.observed,
        },
      });
    }

    this.recordActivity({
      goatId: context.agentId,
      deploymentId: context.deployment.deploymentId,
      agentId: wake.agentId,
      type: activityForPlan(decided),
      data: {
        kind: decided.kind,
        reason: decided.reason,
        thesisId: decided.kind === 'CREATE_TRACKER' ? decided.thesisId : wake.thesisId,
      },
    });

    /*
     * What the loop refused, on the record.
     *
     * A wake can decide something the loop will not do — an escalation that does not
     * meet its skills, a trade proposal for a thesis that is not actionable, a
     * tracker spec this runtime cannot watch. Every one of those refusals used to be
     * collected into `outcome.rejections` and then dropped on the floor, which is
     * precisely why the missing escalation went unnoticed: the GOAT looked like it
     * was thinking and quietly going nowhere, with nothing in the log to say why.
     *
     * Recorded as its own line rather than folded into the decision's reason,
     * because the decision was accepted — it is what the GOAT wanted — and the
     * refusal is a different fact about a different subject.
     */
    for (const rejection of outcome.rejections) {
      this.recordActivity({
        goatId: context.agentId,
        deploymentId: context.deployment.deploymentId,
        agentId: wake.agentId,
        type: 'DECISION_REFUSED',
        data: { kind: decided.kind, reason: rejection, thesisId: wake.thesisId },
      });
    }

    if (outcome.trackerChanges.length > 0) {
      for (const change of outcome.trackerChanges) {
        this.recordActivity({
          goatId: context.agentId,
          deploymentId: context.deployment.deploymentId,
          agentId: wake.agentId,
          type: change.action === 'created' ? 'TRACKER_CREATED' : 'TRACKER_REMOVED',
          data: { trackerId: change.trackerId, purpose: context.watching.find((w) => w.id === change.trackerId)?.purpose },
        });
      }
    }

    if (outcome.tradeIdeaId) {
      this.recordActivity({
        goatId: context.agentId,
        deploymentId: context.deployment.deploymentId,
        agentId: wake.agentId,
        type: 'TRADE_PLAN_CREATED',
        data: {
          ideaId: outcome.tradeIdeaId,
          symbol: outcome.plan.kind === 'PROPOSE_TRADE_IDEA' ? outcome.plan.idea.symbol : undefined,
          direction: outcome.plan.kind === 'PROPOSE_TRADE_IDEA' ? outcome.plan.idea.direction : undefined,
          entry: outcome.plan.kind === 'PROPOSE_TRADE_IDEA' ? outcome.plan.idea.entry : undefined,
        },
      });
      await this.riskCheckTradePlan(outcome.tradeIdeaId);
    }

    /*
     * A wake that changed nothing observable leaves the GOAT dormant again.
     * Recorded so the feed says it went back to sleep rather than implying
     * it is still thinking, and so a GOAT that is genuinely stuck is
     * visible as having woken and done nothing.
     */
    const active = this.trackers
      .listForThesis(wake.thesisId)
      .filter((tracker) => tracker.lifecycle.status === 'ACTIVE').length;

    this.recordActivity({
      goatId: context.agentId,
      deploymentId: context.deployment.deploymentId,
      agentId: wake.agentId,
      type: 'GOAT_WAITING',
      data: { trackers: active, thesisState: outcome.thesis?.state },
    });

    return outcome;
  }

  /**
   * Run a proposed plan past the deterministic risk layer.
   *
   * This is the boundary the agent never crosses: it proposes, code
   * decides. A SHADOW deployment stays `READY` and stops there, because
   * `READY` means "risk-validated and permitted" and SHADOW is not
   * permitted — which is exactly what a user needs to be able to read off
   * the screen.
   */
  async riskCheckTradePlan(ideaId: string): Promise<TradeIdea | undefined> {
    const idea = this.stores.ideas.get(ideaId);
    if (!idea) return undefined;

    const instance = this.deps.agentRuntime.getAgent(idea.agentId);
    const deployment = this.stores.deployments.currentFor(idea.agentId);

    const approve = (reason: string, metrics?: Record<string, number | string>) =>
      this.updateTradePlan(ideaId, { status: 'READY', riskCheck: { approved: true, reason, checkedAt: this.now(), ...(metrics ? { metrics } : {}) } });

    const wait = (reason: string, metrics?: Record<string, number | string>) =>
      this.updateTradePlan(ideaId, { status: 'WAITING', riskCheck: { approved: false, reason, checkedAt: this.now(), ...(metrics ? { metrics } : {}) } });

    if (!instance || !deployment) {
      return wait('This plan is not attached to a live deployment, so it cannot be checked.');
    }

    /*
     * Positioning first, because it is the number the plan has to justify:
     * how much is at stake between entry and the thesis's invalidation.
     *
     * Two capability contracts, in order, and the order matters. Sizing
     * turns the deployment's risk policy and the live equity into a volume
     * using the plan's stop distance; only then is there a volume to price.
     *
     * This previously asked `risk.calculateRisk` for a stop in one call,
     * with no volume at all and the field named `stopPrice` — which is
     * `risk.calculatePositionSize`'s name for it. The registry refused the
     * unsupported field, the capability could not be evaluated, and every
     * single trade plan came back WAITING with a capability error as its
     * stated reason. A risk gate that has never once run is not a gate.
     */
    try {
      const capabilityContext = {
        agentId: idea.agentId,
        environment: this.deps.env.mode,
        env: this.deps.env,
        symbol: idea.symbol,
        timeframe: this.stores.goals.get(idea.goalId)?.timeframes[0],
        policy: instance.agent.policy,
        symbols: instance.agent.policy.allowedSymbols,
      };

      const sizing = (await this.capabilities.execute(
        'risk.calculatePositionSize',
        { symbol: idea.symbol, stopPrice: idea.invalidationLevel },
        capabilityContext,
      )) as Record<string, unknown>;

      const volumeUnits = sizing['volumeUnits'];
      if (typeof volumeUnits !== 'number' || !(volumeUnits > 0)) {
        return wait(
          typeof sizing['reason'] === 'string'
            ? `The risk layer could not size this plan: ${sizing['reason']}`
            : 'The risk layer could not size this plan from the account and the proposed stop.',
        );
      }

      const result = (await this.capabilities.execute(
        'risk.calculateRisk',
        {
          symbol: idea.symbol,
          volume: volumeUnits,
          entryPrice: idea.entry,
          stopLossPrice: idea.invalidationLevel,
        },
        capabilityContext,
      )) as Record<string, unknown>;

      const dollarRisk = typeof result['dollarRisk'] === 'number' ? result['dollarRisk'] : null;
      const available = typeof result['available'] === 'boolean' ? result['available'] : null;
      const reason = typeof result['reason'] === 'string' ? result['reason'] : undefined;
      const metrics = {
        volumeUnits,
        ...(dollarRisk !== null ? { dollarRisk } : {}),
        /*
         * Recorded as 1/0 because the risk check's metrics are numbers and
         * strings. The capability returns a boolean; a plan's audit trail
         * should not have to widen its own type to carry one.
         */
        ...(available !== null ? { available: available ? 1 : 0 } : {}),
        ...(typeof result['percentOfEquity'] === 'number'
          ? { percentOfEquity: result['percentOfEquity'] }
          : {}),
        ...(typeof result['priceDistance'] === 'number'
          ? { priceDistance: result['priceDistance'] }
          : {}),
      };

      if (reason || available === false) {
        const declined = wait(
          `The risk layer declined this plan: ${reason ?? 'the loss at the proposed stop could not be valued.'}`,
          metrics,
        );
        this.recordRiskCheck(idea, declined, false);
        return declined;
      }

      const updated = approve(
        deployment.execution.canExecute
          ? 'Risk-validated. This deployment is permitted to act on it.'
          : `Risk-validated. Running in ${deployment.mode}, so no order will be placed.`,
        metrics,
      );
      this.recordRiskCheck(idea, updated, true);
      return updated;
    } catch (error) {
      const blocked = wait(
        `The risk layer could not evaluate this plan: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.recordRiskCheck(idea, blocked, false);
      return blocked;
    }
  }

  /**
   * The risk verdict belongs in the activity feed.
   *
   * A plan whose risk check failed is the single most useful thing a user
   * can be told about a GOAT, and until this existed the only place it
   * appeared was the trade plan's own row.
   */
  private recordRiskCheck(idea: TradeIdea, result: TradeIdea | undefined, approved: boolean): void {
    const deployment = this.stores.deployments.currentFor(idea.agentId);
    this.recordActivity({
      goatId: idea.agentId,
      deploymentId: deployment?.id,
      agentId: idea.agentId,
      type: approved ? 'TRADE_PLAN_RISK_CHECKED' : 'TRADE_PLAN_REJECTED',
      data: {
        ideaId: idea.id,
        approved,
        reason: result?.riskCheck?.reason,
        ...(result?.riskCheck?.metrics ?? {}),
      },
    });
  }

/**
   * Move a plan on because something happened to it outside the agent's own
   * decision.
   *
   * A plan goes `PROPOSED → RISK_CHECK → READY` entirely inside the runtime, and
   * stops there: nothing in the GOAT layer submits an order, because nothing
   * in the GOAT layer may. Execution belongs to the deployment and to whatever
   * is acting on it — a venue adapter in live, and the simulated book in a
   * backtest.
   *
   * So the two states a plan is in once it has actually been acted on,
   * `EXECUTING` and `CLOSED`, had no way to be reached, and a plan that had
   * been filled would sit at READY for the rest of the run claiming it was
   * waiting to be acted on. This is the seam: the caller that executed it says
   * so, and the same bookkeeping records the transition, so the plan surface
   * and the log cannot disagree about whether it filled.
   */
  applyExecution(
    ideaId: string,
    change: { status: TradeIdea['status']; reason: string },
  ): TradeIdea | undefined {
    if (change.status !== 'EXECUTING' && change.status !== 'MANAGING' && change.status !== 'CLOSED') {
      throw new Error(`An execution may only move a plan to EXECUTING, MANAGING or CLOSED, not ${change.status}.`);
    }
    return this.updateTradePlan(ideaId, { status: change.status });
  }

  private updateTradePlan(
    ideaId: string,
    change: { status: TradeIdea['status']; riskCheck?: TradeIdea['riskCheck'] },
  ): TradeIdea | undefined {
    const idea = this.stores.ideas.get(ideaId);
    if (!idea) return undefined;
    const updated: TradeIdea = {
      ...idea,
      status: change.status,
      ...(change.riskCheck ? { riskCheck: change.riskCheck } : undefined),
      updatedAt: this.now(),
    };
    this.stores.ideas.save(updated);

    /*
     * The plan moved.
     *
     * Every status change a plan goes through is a change of intent, and a log
     * that only records the creation and the risk verdict cannot show a plan
     * evolving — which is the single most reassuring thing to watch, because
     * it is how a person sees the deterministic layer narrowing the agent's
     * options without the agent's involvement.
     *
     * Recorded from the stored plan's own before/after, never from the
     * argument, so what the log says is what was persisted.
     */
    const deployment = this.stores.deployments.currentFor(updated.agentId);
    this.recordActivity({
      goatId: updated.agentId,
      deploymentId: deployment?.id,
      agentId: updated.agentId,
      type: 'TRADE_PLAN_UPDATED',
      data: {
        ideaId: updated.id,
        thesisId: updated.thesisId,
        symbol: updated.symbol,
        direction: updated.direction,
        from: idea.status,
        to: updated.status,
        reason: change.riskCheck?.reason,
      },
    });

    return updated;
  }

  /**
   * Ask the model what the event means.
   *
   * This is the second of only two places GOAT reasons. The first is
   * goal interpretation. Everything after this is a reaction to a
   * specific piece of evidence, which is what keeps the agent dormant
   * between events.
   */
  private async reason(
    context: ReturnType<GoatLoop['buildContext']> & object,
    wake: WakeRequest,
  ): Promise<AgentPlan> {
    const instance = this.deps.agentRuntime.getAgent(context.agentId);
    if (!instance) {
      return { kind: 'WAIT', reason: `Agent ${context.agentId} is not registered.` };
    }

    const phaseInstructions = this.skills.compilePhase(
      context.skillIds,
      'EVENT_INTERPRETATION',
    );

    const goal = this.stores.goals.getForAgent(context.agentId);
    /*
     * The deployment's market, first.
     *
     * It used to come from `goal.symbols[0]`, which is written at deploy
     * time and cleared at undeploy — so a resumed or redeployed GOAT could
     * wake against whatever the goal record happened to say, including
     * nothing at all, while the deployment it actually belongs to named a
     * market. The deployment is the authority on which market this GOAT
     * runs; the tracker that woke it is the next best thing.
     */
    const symbol =
      context.deployment.market ||
      goal?.symbols[0] ||
      context.wakeEvent?.symbol ||
      wake.event.symbol ||
      instance.agent.symbols[0];
    const timeframe = goal?.timeframes[0] ?? context.wakeEvent?.timeframe ?? DEFAULT_GOAT_TIMEFRAME;

    /*
     * The market is re-read on every wake. A tracker fired because
     * something changed, and reasoning about the state that produced the
     * event is how a GOAT convinces itself the market already knew what it
     * is about to be told.
     */
    /*
     * Several resolutions, read one at a time and recorded one at a time.
     *
     * The wake used to read exactly one timeframe and reason as though the
     * market only had that shape. Reading the higher context alongside the
     * setup is what lets a 15m breakout be checked against the 1h structure
     * it claims to be breaking, and recording each read is what makes "which
     * timeframes is this using" answerable from the log instead of guessed.
     */
    const reads = await this.readMarketAcrossTimeframes(symbol, instance, timeframe);
    const market = reads[0].context;

    if (goal) {
      this.recordReads(goal, context.deployment as unknown as GoatDeployment, reads, timeframe);
    } else {
      for (const read of reads) {
        this.recordActivity({
          goatId: context.agentId,
          deploymentId: context.deployment.deploymentId,
          agentId: instance.agent.id,
          type: 'MARKET_CONTEXT_LOADED',
          data: {
            ...marketContextEvidence(read.context),
            timeframe: read.context.timeframe,
            role: TIMEFRAME_ROLE_LABELS[read.role],
            reason: read.reason,
          },
        });
      }
    }

    const observation = await this.buildObservation(instance, {
      symbol,
      skillIds: context.skillIds,
      timeframe,
      market,
    });
    const steering = this.steeringFor(goal?.id);
    if (goal && steering.length > 0) this.markLatestSteeringApplied(goal);

    /*
     * The same boundary as a first pass: research is over, and the GOAT is
     * now blocked on the model. Without this line a wake rendered as one
     * quiet gap between "a tracker fired" and "the plan was updated", which
     * is exactly the gap during which the agent appears frozen.
     */
    this.recordActivity({
      goatId: context.agentId,
      deploymentId: context.deployment.deploymentId,
      agentId: instance.agent.id,
      type: 'MARKET_CONTEXT_PREPARED',
      data: {
        market: symbol,
        timeframes: reads.map((read) => read.context.timeframe).join(', '),
        resolutions: reads.length,
        roles: reads.map((read) => `${read.context.timeframe} ${TIMEFRAME_ROLE_LABELS[read.role]}`).join(', '),
        candles: market.bars.received,
        indicators: Object.keys(market.indicators).length,
        limitations: market.limitations.length,
      },
    });

    try {
      const { response } = await this.callModel({
        agentId: context.agentId,
        deploymentId: context.deployment.deploymentId,
        phase: 'UPDATING',
        intent: `Updating the Trade Plan for ${symbol}`,
        submitted: {
          symbol,
          setupTimeframe: timeframe,
          timeframes: reads.map((read) => read.context.timeframe).join(', '),
          candles: market.bars.received,
          objective: goal?.statement ?? context.goal,
        },
        request: {
        agent: instance.agent,
        objective: goal?.statement ?? context.goal,
        observation,
        contract: 'PLAN',
        instructions: [
          'A tracker you deployed has fired. Interpret it for the thesis.',
          '',
          `THESIS UNDER TEST: ${context.thesis.statement}`,
          `It is wrong if: ${context.thesis.invalidation}`,
          `Current state: ${context.thesis.state}${
            context.thesis.confidence !== undefined
              ? `, confidence ${Math.round(context.thesis.confidence * 100)}%`
              : ''
          }`,
          `Evidence recorded: ${context.evidence.filter((item) => item.polarity === 'SUPPORTS').length} supporting, ${
            context.evidence.filter((item) => item.polarity === 'CONTRADICTS').length
          } contradicting`,
          `Already watching: ${
            context.watching.length > 0
              ? context.watching.map((tracker) => tracker.purpose).join('; ')
              : 'nothing'
          }`,
          '',
          'MARKET CONTEXT — measured now, by deterministic tools.',
          'Each resolution is labelled with the job it is doing for you:',
          this.renderTimeframeContexts(reads),
          '',
          steering.length > 0
            ? `OPERATOR STEERING (runtime guidance):\n${steering
                .slice(-3)
                .map((note) => `- ${note.text}`)
                .join('\n')}`
            : '',
          '',
          'Choose exactly one of:',
          '- CONFIRM_THESIS  the event supports the hypothesis',
          '- WEAKEN_THESIS   the event counts against it',
          '- INVALIDATE_THESIS the thesis is disproven',
          '- REVISE_THESIS   the hypothesis needs restating',
          '- CREATE_TRACKER  you now need to watch for something else',
          '- REMOVE_TRACKER  you no longer need to watch something',
          '- ESCALATE_THESIS the evidence now meets your skills\' bar for trading',
          '- PROPOSE_TRADE_IDEA the thesis is already ACTIONABLE and you can price it',
          '- WAIT            not enough to act on',
          '',
          'ESCALATE_THESIS and PROPOSE_TRADE_IDEA are two different steps, not two ways',
          'of saying the same thing. A thesis is only ACTIONABLE after an escalation,',
          'so proposing a trade on an investigating thesis will be refused. Escalate',
          'first; price the trade on a later wake.',
          '',
          'Pricing a trade means answering one question: at what price would this',
          'become attractive? Prefer orderType LIMIT with an entry you would wait',
          'for — a retest, a level, a pullback — over MARKET, which pays the spread',
          'to get in now. `invalidationLevel` is the stop: the price at which the',
          'thesis is wrong, so it must sit beyond the structure you are trading.',
          '',
          'A tracker event is a fact. It is never a buy or a sell.',
          'One decision per wake. If the decision depends on a resolution you were not',
          `given, return {"requestTimeframes": ["1h"]} instead of a decision (${SUPPORTED_TIMEFRAMES.join(', ')}).`,
        ].join('\n'),
        skillsInstructions: phaseInstructions,
        toolHistory: [],
        iteration: 0,
        wakeReason: wake.event.reason,
        },
      });

      if (response.unavailable || response.malformed) {
        return {
          kind: 'WAIT',
          reason: 'The reasoning model could not be read for this wake, so nothing was changed.',
        };
      }

      return parsePlan(response) ?? {
        kind: 'WAIT',
        reason: 'The model response did not contain a recognisable plan.',
      };
    } catch {
      return { kind: 'WAIT', reason: 'The reasoning model failed, so no plan was applied.' };
    }
  }

  // ---------------------------------------------------------------------
  // Reads for the UI
  // ---------------------------------------------------------------------

  getGoal(goalId: string): Goal | undefined {
    return this.stores.goals.get(goalId);
  }

  getGoalForAgent(agentId: string): Goal | undefined {
    return this.stores.goals.getForAgent(agentId);
  }

  getThesis(thesisId: string): Thesis | undefined {
    return this.stores.theses.get(thesisId);
  }

  listThesesForGoal(goalId: string): Thesis[] {
    return this.stores.theses.listForGoal(goalId);
  }

  listLiveTheses(goalId: string): Thesis[] {
    return this.stores.theses.listLiveForGoal(goalId);
  }

  listEvidence(thesisId: string): Evidence[] {
    return this.stores.evidence.listForThesis(thesisId);
  }

  listContradictingEvidence(thesisId: string): Evidence[] {
    return this.stores.evidence.listContradicting(thesisId);
  }

  /** "GOAT is watching" — active trackers with their purposes. */
  listWatching(goalId: string) {
    return this.trackers.listWatching(goalId);
  }

  listTradeIdeas(goalId: string) {
    return this.stores.ideas.listForGoal(goalId);
  }

  /**
   * Create a thesis and its observation plan directly.
   *
   * Used by tests and by the backtest path, where the hypothesis is
   * known up front and the point is to exercise the runtime rather than
   * the model.
   */
  seedThesis(input: {
    goalId: string;
    agentId: string;
    statement: string;
    direction?: Thesis['direction'];
    invalidation: string;
    requiredConfirmation?: string[];
    state?: Thesis['state'];
  }): Thesis {
    const thesis = this.loop.createThesis(input);
    if (input.state && input.state !== 'DRAFT') {
      return this.loop.reviseThesis(thesis.id, { state: input.state });
    }
    return thesis;
  }
}

/**
 * Which activity a plan's decision is recorded as.
 *
 * `WAIT` is deliberately *not* mapped to a failure. A wake that concludes
 * "not enough to act on" is the loop working.
 */
function activityForPlan(plan: AgentPlan): AgentTimelineEventType {
  switch (plan.kind) {
    case 'WAIT':
      return 'GOAT_WAITING';
    case 'CONFIRM_THESIS':
    case 'WEAKEN_THESIS':
    case 'REVISE_THESIS':
      return 'THESIS_REVISED';
    case 'INVALIDATE_THESIS':
      return 'THESIS_INVALIDATED';
    case 'CREATE_TRACKER':
    case 'REMOVE_TRACKER':
      return 'DECISION';
    case 'PROPOSE_TRADE_IDEA':
      return 'DECISION';
    default:
      return 'DECISION';
  }
}

/**
 * The timeframe a GOAT's own fallback watcher uses.
 *
 * The deployment's timeframe when there is one, because that is the
 * resolution the GOAT was pointed at, and the default otherwise.
 */
function timeframeFor(goal: Goal): string {
  return goal.timeframes[0] ?? DEFAULT_GOAT_TIMEFRAME;
}

/** One line of a GOAT's durable activity feed. */
export interface GoatActivityEntry {
  id: string;
  at: number;
  type: AgentTimelineEventType;
  /** The event in words, derived from the record the runtime wrote. */
  text: string;
}

/**
 * One word per transition, from the record rather than from the model's
 * prose. A feed made of model sentences is a feed that can flatter the
 * model; this one says what the runtime did.
 */
/**
 * The supporting line under a log entry, where there is something to add.
 *
 * The headline says what happened; this says the numbers. A log entry that
 * reads "Read EUR/USD" is an event; one that reads "Read EUR/USD · 120
 * candles · RSI 43.7" is evidence a person can check the agent's claim
 * against. Only real recorded values appear — every one of these is read out
 * of `data`, never computed and never inferred.
 */
function detailForActivity(type: AgentTimelineEventType, record: Record<string, unknown>): string | undefined {
  const parts: string[] = [];

  switch (type) {
    /*
     * Resolution and role first, numbers after.
     *
     * The pair is the claim — "5m, entry timing" — and it leads so a reader
     * scanning the log can see what the agent was looking at without reading
     * every line. The numbers follow as the evidence for it.
     */
    case 'MARKET_CONTEXT_LOADED':
      if (typeof record.timeframe === 'string' && record.timeframe) {
        parts.push(
          typeof record.role === 'string' && record.role ? `${record.timeframe} · ${record.role}` : record.timeframe,
        );
      }
      if (isFiniteNumber(record.candles)) parts.push(`${record.candles} candles`);
      if (isFiniteNumber(record.rsi)) parts.push(`RSI ${round(record.rsi)}`);
      if (isFiniteNumber(record.atr)) parts.push(`ATR ${round(record.atr)}`);
      if (record.acquired === true) parts.push('the GOAT asked for this resolution');
      break;

    /*
     * The numbers, not the sentence.
     *
     * The headline is the conditional sentence and repeating it here would make
     * every plan line a paragraph. What belongs under it is what the plan needs
     * and how far through it is.
     */
    case 'THESIS_FORMED':
    case 'THESIS_REVISED': {
      if (typeof record.state === 'string' && record.state) parts.push(record.state.toLowerCase());
      const requirements = Array.isArray(record.requirements)
        ? record.requirements.filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (requirements.length > 0) parts.push(`${requirements.length} conditions to confirm`);
      if (isFiniteNumber(record.modelMs)) parts.push(`${(record.modelMs / 1000).toFixed(1)}s to form`);
      if (typeof record.watches !== 'number') {
        // Intentionally empty: nothing measured to report yet.
      }
      break;
    }

    case 'EVIDENCE_REQUIREMENTS_DEFINED': {
      const requirements = Array.isArray(record.requirements) ? record.requirements.filter((r): r is string => typeof r === 'string') : [];
      if (requirements.length > 0) parts.push(requirements.join(' · '));
      break;
    }

    case 'DECISION_REFUSED': {
      if (typeof record.kind === 'string' && record.kind) parts.push(record.kind);
      break;
    }

    case 'RUNTIME_REGISTERED': {
      if (isFiniteNumber(record.watcherId)) parts.push(String(record.watcherId));
      break;
    }

    case 'AGENT_EVIDENCE': {
      if (typeof record.polarity === 'string') {
        parts.push(record.polarity === 'CONTRADICTS' ? 'counts against the thesis' : 'counts for the thesis');
      }
      const observed = record.observed;
      if (isRecord(observed)) {
        // Numbers only: the evidence log's structured numbers are what a
        // person can actually verify, and a prose summary is already the
        // headline's job.
        for (const [key, value] of Object.entries(observed)) {
          if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key} ${round(value)}`);
        }
      }
      break;
    }

    case 'TRACKER_FIRED':
    case 'TRACKER_CREATED':
      if (typeof record.symbol === 'string' && record.symbol) parts.push(record.symbol);
      if (typeof record.kind === 'string' && record.kind) parts.push(record.kind.toLowerCase());
      break;

    case 'TRADE_PLAN_CREATED':
      if (typeof record.symbol === 'string' && record.symbol) parts.push(record.symbol);
      if (typeof record.direction === 'string' && record.direction) parts.push(record.direction);
      if (isFiniteNumber(record.entry)) parts.push(`entry ${record.entry}`);
      break;

    case 'TRADE_PLAN_UPDATED':
      if (typeof record.from === 'string' && typeof record.to === 'string') {
        parts.push(`${record.from.toLowerCase()} → ${record.to.toLowerCase()}`);
      }
      if (typeof record.reason === 'string' && record.reason) parts.push(record.reason);
      break;

    case 'GOAT_RESTARTED':
      if (text(record.downtime)) parts.push(`asleep for ${text(record.downtime)}`);
      if (text(record.market)) parts.push(text(record.market));
      break;

    case 'GOAT_REASSESSING':
      if (text(record.reason)) parts.push(text(record.reason));
      if (isFiniteNumber(record.restoredTrackers)) {
        parts.push(
          record.restoredTrackers === 0
            ? 'nothing was being watched'
            : `${record.restoredTrackers} restored watch${
                record.restoredTrackers === 1 ? '' : 'es'
              }, unverified`,
        );
      }
      break;

    case 'GOAT_WAITING':
      if (isFiniteNumber(record.trackers)) parts.push(`${record.trackers} active`);
      if (typeof record.thesisState === 'string' && record.thesisState) parts.push(record.thesisState.toLowerCase());
      break;

    case 'GOAT_SETTING_UP':
      if (text(record.timeframe)) parts.push(`${text(record.timeframe)} setup`);
      if (text(record.environment)) parts.push(text(record.environment));
      break;

    case 'MARKET_CONTEXT_PREPARED':
      if (text(record.timeframes)) parts.push(text(record.timeframes));
      if (isFiniteNumber(record.candles)) parts.push(`${record.candles} candles`);
      if (isFiniteNumber(record.indicators)) parts.push(`${record.indicators} indicator sets`);
      if (isFiniteNumber(record.limitations) && record.limitations > 0) {
        parts.push(`${record.limitations} could not be read`);
      }
      break;

    /*
     * What was actually submitted.
     *
     * This is the line a reader uses to check the agent's claim about its own
     * context, so it carries the real values rather than a reassurance: the
     * resolutions, how many candles, how many indicator sets, and the
     * objective in the user's own words.
     */
    case 'MODEL_REQUEST':
      if (text(record.symbol)) parts.push(text(record.symbol));
      if (text(record.timeframes)) parts.push(text(record.timeframes));
      if (isFiniteNumber(record.candles)) parts.push(`${record.candles} candles`);
      if (isFiniteNumber(record.indicators)) parts.push(`${record.indicators} indicator sets`);
      if (text(record.objective)) parts.push(text(record.objective));
      break;

    case 'MODEL_RETRY':
      if (isFiniteNumber(record.retryInMs)) parts.push(`in ${describeDuration(record.retryInMs)}`);
      if (isFiniteNumber(record.looks)) parts.push(`look ${record.looks}`);
      break;

    case 'BACKTEST_STARTED':
      if (text(record.symbol)) parts.push(text(record.symbol));
      if (text(record.range)) parts.push(text(record.range));
      if (isFiniteNumber(record.speed)) parts.push(`${record.speed}x`);
      break;

    case 'BACKTEST_TICK':
      // The price is the headline's job; repeating it here made every tick a
      // line and a half long.
      if (isFiniteNumber(record.simulatedMinutes)) {
        parts.push(`${record.simulatedMinutes} simulated minutes`);
      }
      break;

    case 'BACKTEST_STOPPED':
    case 'BACKTEST_COMPLETED':
      if (isFiniteNumber(record.simulatedMinutes)) {
        parts.push(`${record.simulatedMinutes} simulated minutes`);
      }
      if (isFiniteNumber(record.trades)) parts.push(count(record.trades, 'trade'));
      if (isFiniteNumber(record.modelCalls)) parts.push(count(record.modelCalls, 'model call'));
      break;

    default:
      break;
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The thing a log entry points at, when it points at one.
 *
 * Only three artefacts exist — a thesis, a plan, a tracker — and a link is
 * only offered when the record actually carries the id. A link to nothing is
 * worse than no link.
 */
function artifactForActivity(
  type: AgentTimelineEventType,
  record: Record<string, unknown>,
): AgentEventView['artifact'] | undefined {
  const id = (key: 'thesisId' | 'ideaId' | 'trackerId'): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  if (type === 'TRADE_PLAN_CREATED' || type === 'TRADE_PLAN_UPDATED') {
    const planId = id('ideaId');
    return planId ? { kind: 'plan', id: planId, label: 'trade plan' } : undefined;
  }
  if (type === 'TRACKER_CREATED' || type === 'TRACKER_FIRED' || type === 'TRACKER_REMOVED') {
    const trackerId = id('trackerId');
    return trackerId ? { kind: 'tracker', id: trackerId, label: 'tracker' } : undefined;
  }
  if (type === 'THESIS_FORMED' || type === 'THESIS_REVISED' || type === 'THESIS_INVALIDATED') {
    const thesisId = id('thesisId');
    return thesisId ? { kind: 'thesis', id: thesisId, label: 'thesis' } : undefined;
  }
  return undefined;
}

/**
 * An elapsed time in words.
 *
 * Shown to a person deciding whether a restart did the right thing, so the
 * precision that matters is coarse and the unit is unambiguous. Never "0s":
 * that would claim nothing had passed when something had.
 */
export function describeDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const seconds = Math.round(safe / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * One Trade Plan as one sentence.
 *
 * `X may be doing Y. If A, and B, then C.` — assembled from the recorded
 * statement, the recorded requirements and the recorded direction. It never
 * paraphrases the model and never adds a number nobody supplied: everything in
 * it came from the records this line is reporting, so a reader can check it
 * against the plan panel beside it.
 *
 * When there are no requirements yet, the sentence says so rather than
 * pretending the plan is conditional when it is not.
 */
function conditionalSentence(record: Record<string, unknown>): string {
  const market = text(record.market);
  const statement = text(record.statement);
  if (!statement) return 'Trade Plan formed';

  const belief = statement.trim().replace(/\.$/, '');
  /*
   * The subject, unless the statement already opens with it.
   *
   * Models write "USD/JPY holds its range" as often as they write "the range
   * holds", and prefixing unconditionally produced "USD/JPY USD/JPY holds its
   * range" on the log's most important line.
   */
  const opens = market !== '' && belief.toUpperCase().startsWith(market.toUpperCase());
  const subject = opens ? '' : market || 'The market';
  const requirements = Array.isArray(record.requirements)
    ? record.requirements.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const action = directionAction(text(record.direction));

  if (requirements.length === 0) return `${subject ? `${subject} ` : ''}${belief}.`;

  const shown = requirements.slice(0, 3).map((entry) => lower(entry.trim().replace(/\.$/, '')));
  const remaining = requirements.length - shown.length;
  const conditions = `${lower(shown[0])}${shown
    .slice(1)
    .map((entry) => `, and ${lower(entry)}`)
    .join('')}${remaining > 0 ? `, and ${remaining} more condition${remaining === 1 ? '' : 's'}` : ''}`;

  return `${subject ? `${subject} ` : ''}${belief}. If ${conditions}, then ${action}.`;
}

/**
 * What the plan says it will do, from the direction it recorded.
 *
 * NEUTRAL gets no verb, because a GOAT that has not taken a side has not said
 * it will buy or sell, and a plan that implies otherwise is the plan lying on
 * the user's behalf.
 */
function directionAction(direction: string): string {
  const value = direction.toUpperCase();
  if (value === 'BULLISH') return 'it buys';
  if (value === 'BEARISH') return 'it sells';
  return 'it keeps gathering evidence';
}

function lower(value: string): string {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A number, trimmed to the precision a reader can use. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function describeActivity(type: AgentTimelineEventType, data: unknown): string {
  const record = isRecord(data) ? data : {};

  switch (type) {
    case 'GOAT_DEPLOYED':
      return `Deployed on ${text(record.market)} in ${text(record.mode)}`;
    case 'GOAT_STARTED':
      return `Started investigating ${text(record.market)}`;
    case 'GOAT_RESUMED':
      return record.restored !== undefined
        ? `Resumed on ${text(record.market)} with ${count(record.restored, 'condition')} restored`
        : `Resumed on ${text(record.market)}`;
    case 'GOAT_STOPPED':
      return text(record.reason) ? `Stopped: ${text(record.reason)}` : 'Stopped';
    /*
     * The loop's refusal, in the reader's terms.
     *
     * "Refused" is the wrong word on its own — it reads as an error, when the
     * refusal is the runtime declining to do something the GOAT asked for and
     * saying why. Naming the gate it stopped at is what makes the line useful.
     */
    case 'DECISION_REFUSED':
      return text(record.reason) || 'The runtime declined this decision.';
    case 'STALE_WORK_REFUSED':
      return text(record.reason) || 'Work from a cleared session was refused.';

    case 'SESSION_CLEARED': {
      /*
       * What was removed, counted.
       *
       * A clear that reports only "cleared" is indistinguishable from a reload that
       * happened to look clean, and the reader's question after pressing CLEAR is
       * exactly "what went". The counts are the answer.
       */
      const parts = [
        isFiniteNumber(record.theses) ? count(record.theses, 'thesis') : undefined,
        isFiniteNumber(record.evidence) ? count(record.evidence, 'evidence record') : undefined,
        isFiniteNumber(record.trackers) ? count(record.trackers, 'tracker') : undefined,
        isFiniteNumber(record.logEvents) ? count(record.logEvents, 'log entry') : undefined,
      ].filter((part): part is string => part !== undefined);
      return `Session cleared — ${parts.join(', ') || 'nothing to remove'}. The GOAT itself is unchanged, and nothing is running until you press PLAY.`;
    }

    case 'RUNTIME_REGISTERED':
      return 'Registered with the durable runtime, so it keeps working when this tab closes';
    case 'RUNTIME_UNAVAILABLE': {
      const phase = text(record.phase);
      return `The durable runtime is unavailable${
        phase ? ` while trying to ${phase}` : ''
      }. This GOAT keeps working in this tab, but it will stop when the tab closes.`;
    }
    case 'GOAT_STEERED':
      return text(record.instruction)
        ? `You asked it to reconsider: ${text(record.instruction)}`
        : 'You sent an instruction';
    case 'GOAT_REASSESSING':
      return `Reassessing ${text(record.market) || 'the current thesis'} against your instruction`;
    case 'GOAT_RESTARTED':
      return text(record.downtime)
        ? `Restarted after ${text(record.downtime)} — rebuilding from current market state`
        : 'Restarted — rebuilding from current market state';
    case 'GOAT_REASSESSING':
      if (typeof record.reason === 'string' && record.reason) {
        return text(record.restoredTrackers) !== undefined
          ? `Reassessing ${text(record.market) || 'the current thesis'} — ${record.reason}. ${
              text(record.restoredTrackers) === '0'
                ? 'Nothing was being watched.'
                : `${record.restoredTrackers} restored watch${
                    text(record.restoredTrackers) === '1' ? '' : 'es'
                  } are unverified.`
            }`
          : `Reassessing ${text(record.market) || 'the current thesis'} — ${record.reason}`;
      }
      return `Reassessing ${text(record.market) || 'the current thesis'} against your instruction`;
    case 'GOAT_WOKE':
      /*
       * A wake is not always a tracker. Saying "woken by a tracker" for a
       * steering request or a restart is not a wording problem: it tells the
       * reader the agent reacted to the market when it actually reacted to
       * them, which is exactly backwards.
       */
      if (record.source === 'STEERING') {
        return text(record.reason)
          ? text(record.reason)
          : 'Woken by your instruction';
      }
      if (record.source === 'RESTART') return 'Restarted and re-reading the thesis';
      return `Woken by a tracker on ${text(record.symbol)}`;
    case 'GOAT_WAITING': {
      if (typeof record.message === 'string' && record.message) return record.message;
      return `Waiting on ${count(record.trackers, 'tracker')}`;
    }
    case 'GOAT_SETTING_UP':
      return text(record.market)
        ? `Building the initial market context on ${text(record.market)}`
        : 'Building the initial market context';

    case 'MARKET_CONTEXT_LOADED':
      return `Read ${text(record.symbol)}: ${text(record.candles)} candles, RSI ${text(record.rsi)}, ATR ${text(record.atr)}`;

    case 'MARKET_CONTEXT_PREPARED':
      return text(record.timeframes)
        ? `Research complete across ${text(record.timeframes)} — the request is ready`
        : 'Research complete — the request is ready';

    /*
     * The one line that says the GOAT is thinking.
     *
     * Phrased as the work rather than as the call, because "forming a
     * hypothesis" and "converting it into a plan" are one activity to a user
     * and two only to the architecture. What the agent is doing while this is
     * outstanding is carried by the live status above the log, which pulses for
     * exactly as long as the request is in flight.
     */
    case 'MODEL_REQUEST':
      return text(record.intent) || 'Building the Trade Plan';

    case 'MODEL_RETRY':
      return text(record.message) || 'Bounded retry scheduled';

    case 'BACKTEST_STARTED':
      return `Backtest started on ${text(record.symbol) || 'this market'}`;

    case 'BACKTEST_TICK':
      return `${text(record.symbol)} ${text(record.price)}`;

    case 'BACKTEST_STOPPED':
      return 'Backtest stopped';

    case 'BACKTEST_COMPLETED':
      return 'Backtest complete';
    case 'MARKET_RESEARCH_COMPLETED':
      return `Read ${text(record.market) || 'the market'} and could not form a Trade Plan yet`;

    /*
     * The Trade Plan, in one sentence.
     *
     * What the agent believes could happen, what would make it right, and what
     * it will do. Not a label followed by the belief, and not "hypothesis" —
     * a user reads this line and should not need to know that the architecture
     * has a separate word for the same thing.
     */
    case 'THESIS_FORMED':
      return conditionalSentence(record);
    case 'THESIS_REVISED':
      return text(record.statement)
        ? `Trade Plan updated — ${conditionalSentence(record)}`
        : `Trade Plan updated — ${text(record.state).toLowerCase() || 'the belief changed'}`;
    case 'THESIS_INVALIDATED':
      return `Trade Plan abandoned — ${text(record.reason) || 'the conditions it required did not hold'}`;
    case 'NO_THESIS_YET':
      return `Read ${text(record.market)} and could not form a Trade Plan yet`;
    case 'EVIDENCE_REQUIREMENTS_DEFINED':
      return `What the Trade Plan needs to see`;
    case 'TRACKER_CREATED':
      return `Watching: ${text(record.purpose) || text(record.trackerId)}${
        record.defaulted === true ? ' (the runtime\'s own watcher)' : ''
      }`;
    case 'TRACKER_FIRED':
      return text(record.reason) || 'A tracker fired';
    case 'TRACKER_REMOVED':
      return `Stopped watching ${text(record.trackerId)}`;
    case 'TRADE_PLAN_CREATED':
      return `Wrote a trade plan: ${text(record.direction)} ${text(record.symbol)} @ ${text(record.entry)}`;
    case 'TRADE_PLAN_RISK_CHECKED':
      return record.approved === true
        ? 'Plan passed risk validation'
        : `Plan failed risk validation: ${text(record.reason)}`;
    case 'TRADE_PLAN_REJECTED':
      return `Plan rejected: ${text(record.reason)}`;
    case 'SHADOW_EXECUTION':
      return `Simulated ${text(record.side)} ${text(record.volume)} ${text(record.symbol)}`;
    case 'MODEL_FAILURE':
      /*
       * The intent keeps its own capitalisation: lower-casing it mid-sentence
       * produced "failed while form a hypothesis on eur/usd", which reads like a
       * truncated thought rather than a request that went out.
       */
      return text(record.intent)
        ? `The reasoning model failed — ${text(record.intent)}: ${
            text(record.code) || text(record.message) || 'unreadable'
          }`
        : `The reasoning model failed: ${text(record.code) || text(record.message)}`;
    case 'ERROR':
      return text(record.message) || 'The runtime recorded an error';
    default:
      return type.replace(/_/g, ' ').toLowerCase();
  }
}

/**
 * A record's field, as a word.
 *
 * Numbers are included because most of what is worth reporting about a
 * market read is numeric, and an activity line reading "Read EUR/USD:
 * candles, RSI , ATR" — which is what a string-only version produced — is
 * worse than no line at all.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return '';
}

function count(value: unknown, noun: string): string {
  return typeof value === 'number' ? `${value} ${noun}${value === 1 ? '' : 's'}` : noun;
}

/**
 * What an investigation proposal consists of, once parsed.
 */
export interface InvestigationProposal {
  thesis: InvestigationRequest['thesis'];
  trackers: TrackerRequest[];
  /** Proposals the runtime cannot watch, and therefore discarded. */
  dropped: number;
}

/**
 * Parse an investigation out of a model response.
 *
 * Reads the canonical `payload` the AI boundary produced, falling back to
 * the raw text for a model double that returns prose directly. The
 * provider-specific work — fences, brace matching, deciding whether the
 * content was JSON at all — already happened at the boundary, so this does
 * not repeat any of it.
 *
 * A hypothesis without an invalidation is not a hypothesis, so it is
 * refused here rather than stored as a thesis that can never be acted on.
 * Trackers are filtered the same way plans are: an unrecognised kind or a
 * malformed config is dropped with the rest refused by the registry, and
 * never half-registered.
 */
export function parseInvestigation(
  response: AgentModelResponse,
): InvestigationProposal | undefined {
  const json = response.payload ?? extractJson(response.thought);
  if (!json) return undefined;

  const thesis = json['thesis'];
  if (!isRecord(thesis)) return undefined;
  if (typeof thesis.statement !== 'string' || !thesis.statement.trim()) return undefined;
  if (typeof thesis.invalidation !== 'string' || !thesis.invalidation.trim()) return undefined;

  const direction =
    thesis.direction === 'BULLISH' || thesis.direction === 'BEARISH' || thesis.direction === 'NEUTRAL'
      ? thesis.direction
      : undefined;

  const trackers: TrackerRequest[] = [];
  let dropped = 0;
  if (Array.isArray(json['trackers'])) {
    for (const spec of json['trackers']) {
      if (!isRecord(spec)) {
        dropped += 1;
        continue;
      }
      if (typeof spec.kind !== 'string' || !isTrackerKind(spec.kind)) {
        dropped += 1;
        continue;
      }
      if (!isRecord(spec.config)) {
        dropped += 1;
        continue;
      }
      if (typeof spec.purpose !== 'string' || !spec.purpose.trim()) {
        dropped += 1;
        continue;
      }

      trackers.push({
        purpose: spec.purpose.trim(),
        kind: spec.kind,
        config: spec.config,
        ...(typeof spec.symbol === 'string' ? { symbol: spec.symbol } : {}),
        ...(typeof spec.timeframe === 'string' ? { timeframe: spec.timeframe } : {}),
        ...(typeof spec.priority === 'number' ? { priority: spec.priority } : {}),
        ...(typeof spec.cooldownMs === 'number' ? { cooldownMs: spec.cooldownMs } : {}),
        ...(typeof spec.maxEventsPerMinute === 'number'
          ? { maxEventsPerMinute: spec.maxEventsPerMinute }
          : {}),
        ...(typeof spec.expiresAt === 'number' ? { expiresAt: spec.expiresAt } : {}),
      });
    }
  }

  return {
    dropped,
    thesis: {
      statement: thesis.statement.trim(),
      ...(direction ? { direction } : {}),
      invalidation: thesis.invalidation.trim(),
      ...(Array.isArray(thesis.requiredConfirmation)
        ? {
            requiredConfirmation: thesis.requiredConfirmation.filter(
              (item): item is string => typeof item === 'string',
            ),
          }
        : {}),
    },
    trackers,
  };
}

/**
 * Whether a model answered, and answered in a way this engine understands.
 *
 * `WAIT` is an answer. A model told to investigate, told it may read the
 * market, and told that a plan it cannot execute will simply be simulated,
 * will sometimes conclude that the market says nothing yet — and that is
 * the single most common correct first answer. Treating it as a failure is
 * what produced the message this file exists to correct.
 */
export function isDeliberateWait(response: AgentModelResponse): boolean {
  if (response.toolCall) return false;
  if (response.payload && !response.payload['thesis']) return true;
  return response.decision?.type === 'WAIT';
}

/** Parse a goal interpretation out of a model response. */
function parseInterpretation(response: AgentModelResponse): GoalInterpretation | undefined {
  const json = response.payload ?? extractJson(response.thought);
  if (!json) return undefined;
  const record = json as Record<string, unknown>;
  if (typeof record.actionable !== 'boolean') return undefined;
  return {
    understood: typeof record.understood === 'string' ? record.understood : '',
    symbols: Array.isArray(record.symbols) ? record.symbols.filter((s): s is string => typeof s === 'string') : [],
    timeframes: Array.isArray(record.timeframes)
      ? record.timeframes.filter((s): s is string => typeof s === 'string')
      : [],
    investigationPlan: Array.isArray(record.investigationPlan)
      ? record.investigationPlan.filter((s): s is string => typeof s === 'string')
      : [],
    openQuestions: Array.isArray(record.openQuestions)
      ? record.openQuestions.filter((s): s is string => typeof s === 'string')
      : [],
    actionable: record.actionable,
  };
}

/** Parse an agent plan out of a model response. */
function parsePlan(response: AgentModelResponse): AgentPlan | undefined {
  const json = response.payload ?? extractJson(response.thought);
  if (!json) return undefined;
  const record = json as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string') return undefined;
  const reason = typeof record.reason === 'string' ? record.reason : '';

  switch (kind) {
    case 'WAIT':
      return { kind: 'WAIT', reason };
    case 'CONFIRM_THESIS':
    case 'WEAKEN_THESIS':
    case 'INVALIDATE_THESIS':
    case 'ESCALATE_THESIS':
    case 'REVISE_THESIS':
      if (typeof record.thesisId !== 'string') return undefined;
      return {
        kind,
        thesisId: record.thesisId,
        reason,
        ...(typeof record.nextCheck === 'string' ? { nextCheck: record.nextCheck } : {}),
        ...(typeof record.statement === 'string' ? { statement: record.statement } : {}),
        ...(typeof record.invalidation === 'string' ? { invalidation: record.invalidation } : {}),
        ...(typeof record.confidence === 'number' ? { confidence: record.confidence } : {}),
      } as AgentPlan;

    case 'CREATE_TRACKER': {
      const spec = record.spec;
      if (!isRecord(spec)) return undefined;
      if (typeof record.thesisId !== 'string' || typeof spec.purpose !== 'string') return undefined;
      if (typeof spec.kind !== 'string' || !isTrackerKind(spec.kind) || !isRecord(spec.config)) return undefined;
      return {
        kind: 'CREATE_TRACKER',
        thesisId: record.thesisId,
        reason,
        spec: {
          purpose: spec.purpose,
          kind: spec.kind,
          config: spec.config,
          ...(typeof spec.symbol === 'string' ? { symbol: spec.symbol } : {}),
          ...(typeof spec.timeframe === 'string' ? { timeframe: spec.timeframe } : {}),
          ...(typeof spec.priority === 'number' ? { priority: spec.priority } : {}),
          ...(typeof spec.cooldownMs === 'number' ? { cooldownMs: spec.cooldownMs } : {}),
          ...(typeof spec.maxEventsPerMinute === 'number' ? { maxEventsPerMinute: spec.maxEventsPerMinute } : {}),
          ...(typeof spec.expiresAt === 'number' ? { expiresAt: spec.expiresAt } : {}),
          ...(Array.isArray(spec.dependencies)
            ? { dependencies: spec.dependencies.filter((d): d is string => typeof d === 'string') }
            : {}),
          ...(Array.isArray(spec.dataRequirements)
            ? { dataRequirements: spec.dataRequirements.filter(isDataRequirement) }
            : {}),
        },
      };
    }

    case 'REMOVE_TRACKER':
      if (typeof record.trackerId !== 'string') return undefined;
      return { kind: 'REMOVE_TRACKER', trackerId: record.trackerId, reason };

    case 'PROPOSE_TRADE_IDEA': {
      const idea = record.idea;
      if (typeof record.thesisId !== 'string' || !isRecord(idea)) return undefined;
      if (idea.direction !== 'LONG' && idea.direction !== 'SHORT') return undefined;
      if (!['MARKET', 'LIMIT', 'STOP'].includes(String(idea.orderType))) return undefined;
      if (typeof idea.symbol !== 'string') return undefined;
      if (typeof idea.entry !== 'number' || !Number.isFinite(idea.entry)) return undefined;
      if (typeof idea.invalidationLevel !== 'number' || !Number.isFinite(idea.invalidationLevel)) {
        return undefined;
      }
      const targets = Array.isArray(idea.takeProfits)
        ? idea.takeProfits
            .filter(isRecord)
            .filter((t) => typeof t.price === 'number' && Number.isFinite(t.price))
            .map((t) => ({
              price: t.price as number,
              fraction: typeof t.fraction === 'number' ? t.fraction : 1,
              ...(typeof t.label === 'string' ? { label: t.label } : {}),
            }))
        : [];
      if (targets.length === 0) return undefined;

      return {
        kind: 'PROPOSE_TRADE_IDEA',
        thesisId: record.thesisId,
        reason,
        idea: {
          symbol: idea.symbol,
          direction: idea.direction,
          orderType: idea.orderType as 'MARKET' | 'LIMIT' | 'STOP',
          entry: idea.entry,
          invalidationLevel: idea.invalidationLevel,
          takeProfits: targets,
          reasoning: typeof idea.reasoning === 'string' ? idea.reasoning : reason,
          ...(Array.isArray(idea.supportingEvidence)
            ? {
                supportingEvidence: idea.supportingEvidence.filter(
                  (e): e is string => typeof e === 'string',
                ),
              }
            : {}),
        },
      };
    }

    default:
      return undefined;
  }
}

/**
 * Is this a goal a GOAT could be pointed at?
 *
 * Only genuinely unusable input is refused. The test used to be "can the
 * agent act on this", which quietly required the user to write a strategy
 * — entry, stop, target, timeframe — and told a person asking for help that
 * their question was wrong. "Find strong opportunities and wait for
 * confirmation" is a perfectly good objective: working out what to watch is
 * the agent's job, and refusing to start is how a system never learns
 * anything.
 *
 * What is refused is input that carries no objective at all: empty, or a
 * placeholder nobody finished typing.
 */
function assertUsableGoal(statement: string): void {
  if (!statement) {
    throw new Error('A GOAT needs a goal. One sentence about what you want is enough.');
  }

  const words = statement.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));
  if (words.length === 0) {
    throw new Error('A GOAT needs a goal. One sentence about what you want is enough.');
  }
  if (words.length <= 2 && /^(go|trade|do it|buy|sell|make money)$/i.test(words[0] ?? '')) {
    throw new Error(
      'That is too short to be a goal. Say what you want this GOAT to look for, even roughly.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A model-authored tracker kind, or nothing.
 *
 * The parser refuses an unrecognised kind rather than passing it on for
 * the runtime to reject, so a hallucinated program is reported as a
 * malformed plan instead of appearing as a rejected registration.
 */
function isTrackerKind(value: string): value is TrackerKind {
  return TRACKER_KINDS.has(value as TrackerKind);
}

/**
 * Pull one JSON object out of a model response.
 *
 * Brace-balanced rather than greedy. `\{[\s\S]*\}` matches from the first
 * brace to the *last* one in the response, so a model that printed its own
 * example after its answer produced `{answer}{example}`, which is not JSON
 * and was silently discarded — reported as "the model returned nothing".
 *
 * This is a fallback for model doubles that hand back text directly. The
 * real path normalises once, at the AI boundary.
 */
function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    if (end < 0) continue;

    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Look at the next candidate rather than giving up.
    }
  }

  return undefined;
}
