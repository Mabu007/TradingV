/**
 * The backtest session.
 *
 * One object, and it is the whole of "put the GOAT into a historical world":
 *
 *     simulation clock  ->  simulated market  ->  the same GOAT runtime
 *                                              ->  the same tracker runtime
 *                                              ->  the same agent log
 *
 * Nothing in this file forks the agent. There is no `BacktestGoat` and no
 * second decision path. The GOAT orchestrator, the loop, the capabilities, the
 * risk layer and the tracker evaluator are the same objects the live product
 * runs; what differs is what they are handed:
 *
 *   - a clock that reads 15 Jan 2026 instead of now
 *   - a market that only reveals candles that have closed
 *   - a book that fills simulated orders
 *
 * The one genuinely separate object is the orchestrator *instance*, and that is
 * isolation rather than a fork: a simulation gets its own stores, its own agent
 * runtime and its own tracker runtime, so a replay cannot overwrite a live
 * deployment's thesis or leave a tracker armed against a market it is not
 * watching. Two instances of one class is not two trading engines.
 *
 * Replay shape
 * ------------
 *
 * The market advances far faster than the agent is asked to think, which is the
 * whole design. One simulated minute passes; every tracker is evaluated against
 * it; if something qualified, the GOAT wakes, re-reads the market, calls the
 * model and applies a plan — and the simulation waits for that to finish
 * before the next minute. If nothing qualified, the minute passes in silence
 * and no completion is spent. That is what makes watching a GOAT across a
 * historical day possible at all, and it is why a backtest here is not a
 * strategy replay with a candle chart bolted on.
 */

import { AgentRuntime } from '../../agents/runtime';
import { TrackerRegistry } from '../../agents/trackers/registry';
import { TrackerRuntime } from '../../agents/trackers/runtime';
import { InMemoryAgentTimelineStore } from '../../agents/timeline/store';
import type { AgentTimelineEvent, AgentTimelineEventType } from '../../agents/timeline/types';
import type { TrackerEvent, TrackerInput } from '../../agents/trackers/types';
import type { IAgentModel } from '../../agents/model/types';
import { capabilityRegistry } from '../../agents/capabilities';
import type { Bar, Trade } from '../../../types/trading';
import type { GoatMission } from '../mission';
import {
  TradeEngine,
  tradeStatistics,
  type TradeContext,
  type TradeRecord,
  type TradeStatistics,
  type TradeTransition,
} from '../tradeEngine';

import { GoatOrchestrator, createGoatStores, type GoatStores } from '../orchestrator';
import type { Goal } from '../types';
import {
  SimulationClock,
  DEFAULT_SIMULATION_SPEED,
  SIMULATION_STEP_MS,
  isSimulationSpeed,
  type SimulationSpeed,
} from './clock';
import {
  SimulationEnvironment,
  SIMULATION_BASE_TIMEFRAME,
  timeframeSeconds as baseSeconds,
} from './simulationEnvironment';
import {
  TIMEFRAME_ROLE_LABELS,
  resolveTimeframePlan,
  timeframesInStatement,
  type TimeframePlan,
} from '../timeframes';
import { summariseBehaviour, summarisePerformance, type BacktestReport } from './results';

/**
 * How much history the agent is given before the replay's own start.
 *
 * An indicator needs candles to exist before it can say anything, and a GOAT
 * that starts with two visible 15m candles is not being tested — it is being
 * handed an empty world. Four hours is enough for a 200-period average on 1m
 * data and for the higher-timeframe reads the GOAT chooses for itself.
 *
 * The warm-up is *before* `start`, so it is already in the past when the
 * simulation starts and never forms part of the replay window.
 */
export const DEFAULT_BACKTEST_WARMUP_MINUTES = 240;

/**
 * How long the replay waits for an in-flight wake before moving on.
 *
 * A bound, not a hope: a model that never answers must not freeze the
 * simulation forever, and a replay that stopped waiting early would let the
 * agent answer a question about a market it had already left behind.
 */
export const BACKTEST_WAKE_TIMEOUT_MS = 120_000;

export type BacktestState =
  | 'IDLE'
  | 'LOADING'
  | 'SETTING_UP'
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'STOPPED'
  | 'ERROR';

export interface BacktestCostModel {
  initialBalance?: number;
  spreadPrice?: number;
  slippagePrice?: number;
  commissionPerLot?: number;
  lotSize?: number;
  pricePrecision?: number;
  leverage?: number;
  pipSize?: number;
}

export interface BacktestRequest {
  /** The objective the GOAT pursues, in the user's words. */
  goal: string;
  name?: string;
  market: string;
  /**
   * The setup resolution.
   *
   * Optional, and not the same thing as the GOAT's working set: this is the one
   * resolution the replay acts on, and the set below is what it may read.
   */
  timeframe?: string;
  /**
   * Every resolution this GOAT may read.
   *
   * Inherited from the GOAT being replayed, so "scalp on 1m and 5m" is replayed
   * on 1m and 5m rather than quietly becoming a 15m backtest. Omitted, the
   * setup resolution plus its nearest neighbours is used — never a fixed
   * default the GOAT did not ask for.
   */
  timeframes?: string[];
  /**
   * The resolution the historical data is at, when it is known.
   *
   * Passed through rather than assumed, because it is the provider's answer and
   * not the product's: a venue that will not serve 1m candles for a year can
   * still serve 5m, and pretending otherwise would fail at load time.
   */
  baseTimeframe?: string;
  /** Historical instant the replay begins at, epoch ms. */
  start: number;
  /** Historical instant the replay ends at, epoch ms. */
  end: number;
  speed?: SimulationSpeed;
  skillIds?: string[];
  /**
   * A pre-loaded dataset.
   *
   * Supplied by a test, or by an application that already holds history. When
   * absent, `loadBars` is asked for it.
   */
  bars?: Bar[];
  /**
   * Where the history comes from.
   *
   * Injected rather than imported, because this file must be able to replay a
   * dataset with no network at all — a backtest whose correctness depends on a
   * venue being reachable cannot be used to prove anything about look-ahead.
   */
  loadBars?: (request: {
    market: string;
    start: number;
    end: number;
  }) => Promise<Bar[]>;
  /** The reasoning model. Defaults to the application's own. */
  model?: IAgentModel;
  warmupMinutes?: number;
  costModel?: BacktestCostModel;
  /**
   * Timers for the replay clock. Omitted, it uses the platform's.
   *
   * Forwarded from the request so a lifecycle test can drive the clock by hand
   * and observe whether a running replay is still reachable after the surface
   * that started it has gone. The clock already treats its scheduler as a
   * dependency; this only lets a caller reach it through the session.
   */
  scheduler?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

/**
 * What the data source could actually give.
 *
 * Reported rather than assumed, because the honest answer to "backtest three
 * years" is sometimes "the source has one year". A replay that silently used
 * the year it was given, without saying so, would be a result about a different
 * period than the one that was asked for.
 */
export interface BacktestHistory {
  /** The window the request asked for, epoch ms. */
  requestedStart: number;
  requestedEnd: number;
  /** The window the dataset actually covers. */
  availableStart?: number;
  availableEnd?: number;
  /** Bars the dataset holds, at the replay's resolution. */
  bars: number;
  /** The resolution the data is at. The finest thing the replay can read. */
  resolution: string;
  /** Resolutions this replay cannot serve, and why. */
  unsupported: string[];
  /** What was asked for that the source could not provide, in words. */
  note?: string;
}

/**
 * Where the replay is in the trade loop.
 *
 * Named for what the reader needs to know rather than for the component doing the
 * work, and deliberately distinct from `state`, which describes the clock rather
 * than the trading.
 */
export type BacktestTradePhase =
  | 'RESEARCHING'
  | 'FORMING PLAN'
  | 'ORDER PENDING'
  | 'POSITION OPEN'
  | 'MANAGING TRADE'
  | 'SEARCHING FOR NEXT TRADE'
  | 'BACKTEST COMPLETE';

export interface BacktestSnapshot {
  state: BacktestState;
  /** The simulated instant, epoch ms. */
  now: number;
  speed: SimulationSpeed;
  symbol: string;
  /** Latest simulated price, when a bar has closed. */
  price?: number;
  /** Simulated minutes since the replay started. */
  simulatedMinutes: number;
  /** Fraction of the dataset revealed, [0,1]. */
  progress: number;
  /**
   * True while the GOAT is mid-decision and the replay is holding for it.
   *
   * The replay's market does not advance while a request is outstanding. That
   * is the whole determinism story: an agent reasoning about 10:43 must not be
   * handed 10:44 by a fast clock, so the clock waits — and says that it is
   * waiting rather than looking stalled.
   */
  agentBusy: boolean;
  history?: BacktestHistory;
  goalId?: string;
  agentId?: string;
  mission?: GoatMission;
  report?: BacktestReport;
  message?: string;
  /**
   * Every trade this replay has taken, as trades.
   *
   * Carried on the snapshot rather than read on demand because the surface re-renders
   * from snapshots and a subscription that had to reach into the session for trades
   * would be a second source of truth about what happened.
   */
  trades?: TradeRecord[];
  tradeStats?: TradeStatistics;
  /** Where the replay is in the trade loop. See `tradePhase`. */
  tradePhase?: BacktestTradePhase;
}

export class BacktestSession {
  readonly market: string;
  /**
   * The resolution a replay acts on, once resolved.
   *
   * An alias of the plan's setup, kept as a field because the tracker
   * deliveries need it before they have anything else to go on.
   */
  readonly timeframe: string;
  /** Historical instant the replay begins at. The clock starts here. */
  readonly replayStart: number;
  readonly end: number;

  private readonly request: BacktestRequest;
  private readonly clock: SimulationClock;
  /**
   * Which resolutions this replay reads, and what each is for.
   *
   * Resolved once, at construction, from the GOAT being replayed. Everything
   * downstream — the deployment, the initial context, the tracker deliveries —
   * reads this rather than re-deciding, so the replay and the GOAT's own idea
   * of its working set cannot disagree.
   */
  private readonly plan: TimeframePlan;
  private readonly warmupMs: number;
  private readonly initialBalance: number;
  private readonly stores: GoatStores;
  private readonly agentRuntime: AgentRuntime;
  private readonly trackers: TrackerRuntime;
  private readonly listeners = new Set<(snapshot: BacktestSnapshot) => void>();

  private environment?: SimulationEnvironment;
  private orchestrator?: GoatOrchestrator;
  private goal?: Goal;
  private agentId?: string;
  private currentState: BacktestState = 'IDLE';
  private lastMessage?: string;
  private report?: BacktestReport;
  private readonly reportedTrades = new Set<string>();
  private readonly executedPlans = new Set<string>();
  /**
   * The trades this replay has taken.
   *
   * Created with the session and never persisted, which is what makes "a new
   * backtest has no trades from the last one" true by construction: there is no
   * path by which a previous replay's trades can appear in a new one, because
   * there is nothing to carry over.
   */
  private tradeEngine!: TradeEngine;
  private lastTickPrice?: number;
  private wakeInFlight = 0;
  private starting?: Promise<void>;

  constructor(request: BacktestRequest) {
    this.request = request;
    this.market = request.market;
    /*
     * Kept as the fallback for deliveries when the GOAT has armed nothing: it
     * is the plan's setup resolution once the plan is resolved below, and the
     * setup resolution is the right thing to watch in the absence of a
     * declared condition.
     */
    this.timeframe = request.timeframe ?? '15m';
    this.replayStart = request.start;
    this.end = request.end;
    this.warmupMs = (request.warmupMinutes ?? DEFAULT_BACKTEST_WARMUP_MINUTES) * 60_000;

    this.initialBalance = request.costModel?.initialBalance ?? 10_000;

    /*
     * The working set.
     *
     * The declared set wins, and the objective's own words are unioned into it:
     * a GOAT whose goal says "scalp on 1m and 5m" should be replayed on 1m and
     * 5m even if its stored set was written before the user said so. Neither
     * source can invent a resolution — both are limited to the supported set —
     * and with neither, the setup resolution and its neighbours are used, which
     * is a choice the GOAT can still widen at runtime.
     */
    const declared = [
      ...(request.timeframes ?? []),
      ...timeframesInStatement(request.goal),
    ];
    this.plan = resolveTimeframePlan({
      declared,
      setup: request.timeframe ?? declared[Math.floor(declared.length / 2)],
    });

    this.clock = new SimulationClock({
      start: request.start,
      speed: request.speed ?? DEFAULT_SIMULATION_SPEED,
      ...(request.scheduler ? { scheduler: request.scheduler } : {}),
    });

    /*
     * Its own stores, its own agent runtime, its own tracker runtime.
     *
     * Not a fork: the same classes the live application constructs at startup,
     * instantiated separately so that a replay's goals, theses, trackers and
     * activity feed are its own. Sharing them would mean a backtest could
     * overwrite a live GOAT's thesis, and would make "live mode is unchanged"
     * untestable.
     */
    this.stores = createGoatStores('MEMORY');
    this.agentRuntime = new AgentRuntime(
      capabilityRegistry,
      undefined,
      undefined,
      request.model,
      new InMemoryAgentTimelineStore(),
    );
    this.trackers = new TrackerRuntime({
      registry: new TrackerRegistry((agentId) => this.agentRuntime.getAgent(agentId)),
      agents: this.agentRuntime,
      timeline: this.agentRuntime.getTimelineStore(),
      // The tracker runtime's own clock is the simulation's, so a tracker's
      // cooldown, TTL and expiry are measured in historical time. A cooldown
      // evaluated against the wall clock would fire hundreds of times inside
      // one simulated minute.
      clock: () => this.clock.now(),
    });
    this.trackers.setEnvironment('BACKTEST');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load the history, deploy the GOAT, and let it think.
   *
   * Every stage reports itself, because a backtest that spends fifteen seconds
   * loading candles before saying anything looks identical to a hung one — the
   * exact failure this feature exists beside. A surface has real progress from
   * the first moment, and once the GOAT exists that progress is the agent log
   * itself rather than a separate spinner.
   */
  start(): Promise<void> {
    this.starting ??= this.run();
    return this.starting;
  }

  private async run(): Promise<void> {
    this.setState('LOADING', `Loading ${this.market} history`);
    this.emit();

    /*
     * The dataset's own start is not the replay's start.
     *
     * The clock was constructed at `replayStart`, and the bars before it are the
     * warm-up: history the agent may read, not time the simulation spends.
     * Getting this backwards would make the first tick of the replay something
     * the agent had already seen.
     */
    const loaded = this.request.bars ?? (await this.loadDataset());

    this.environment = new SimulationEnvironment(this.clock, {
      symbol: this.market,
      bars: loaded,
      initialBalance: this.initialBalance,
      ...(this.request.baseTimeframe ? { baseTimeframe: this.request.baseTimeframe } : {}),
      ...(this.request.costModel?.spreadPrice !== undefined
        ? { spreadPrice: this.request.costModel.spreadPrice }
        : {}),
      ...(this.request.costModel?.slippagePrice !== undefined
        ? { slippagePrice: this.request.costModel.slippagePrice }
        : {}),
      ...(this.request.costModel?.commissionPerLot !== undefined
        ? { commissionPerLot: this.request.costModel.commissionPerLot }
        : {}),
      ...(this.request.costModel?.lotSize !== undefined ? { lotSize: this.request.costModel.lotSize } : {}),
      ...(this.request.costModel?.pricePrecision !== undefined
        ? { pricePrecision: this.request.costModel.pricePrecision }
        : {}),
      ...(this.request.costModel?.leverage !== undefined ? { leverage: this.request.costModel.leverage } : {}),
      ...(this.request.costModel?.pipSize !== undefined ? { pipSize: this.request.costModel.pipSize } : {}),
    });

    /*
     * The trade engine, over the same simulated book the GOAT reads.
     *
     * Its context is read fresh on every decision rather than captured once,
     * because equity moves as trades close and a size computed against a stale
     * balance would quietly exceed the risk budget the strategy set.
     */
    this.tradeEngine = new TradeEngine({
      book: this.environment,
      now: () => this.clock.now(),
      context: () => this.tradeContext(),
      onTransition: (transition) => this.recordTradeTransition(transition),
    });

    this.orchestrator = new GoatOrchestrator({
      agentRuntime: this.agentRuntime,
      trackers: this.trackers,
      env: this.environment,
      stores: this.stores,
      model: this.request.model,
      // The simulation clock, everywhere the runtime would otherwise read the
      // wall clock. This one substitution is what "the GOAT reasons as if that
      // is now" actually means.
      clock: () => this.clock.now(),
      storeMode: 'MEMORY',
    });

    /*
     * Re-bind the wake hook so a replay can wait for it.
     *
     * The orchestrator binds an `onEvent` that fires and forgets, which is
     * right for a live product — a wake must never block a market-data delivery
     * — and wrong for a replay, where the next simulated minute must not begin
     * until the agent has finished reacting to the last one. The handler is the
     * same public `runWake` the live path takes; only the bookkeeping around it
     * differs, and the in-flight count it maintains is what `settle` waits on.
     */
    this.trackers.bindDomain({
      resolveThesis: (thesisId) => this.stores.theses.get(thesisId),
      resolveSkillIds: (agentId) => this.stores.goals.getForAgent(agentId)?.skillIds ?? [],
      onEvent: async (event: TrackerEvent) => {
        const wake = this.trackers.wakeRequestForEvent(event.id);
        if (!wake) return;
        this.wakeInFlight += 1;
        try {
          await this.orchestrator?.runWake(wake);
        } catch (error) {
          // The orchestrator's own binding records a refusal; this one records a
          // thrown error so a replay never fails silently.
          this.record('ERROR', {
            message: `A simulated wake could not be applied: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        } finally {
          this.wakeInFlight -= 1;
        }
      },
    });

    this.setState('SETTING_UP', 'Forming its first hypothesis');
    this.emit();

    const created = await this.orchestrator.createGoat({
      goal: this.request.goal.trim() || `Trade ${this.market}.`,
      ...(this.request.name?.trim() ? { name: this.request.name.trim() } : {}),
      /*
       * The GOAT's own skills, inherited.
       *
       * A skill is a capability grant: a GOAT replayed without its skills is a
       * different agent with the same objective, and a comparison between the
       * two would be meaningless. So the replay runs the GOAT the user is
       * actually looking at, not a bare agent in a costume.
       */
      ...(this.request.skillIds && this.request.skillIds.length > 0
        ? { skillIds: this.request.skillIds }
        : {}),
    });
    this.goal = created.goal;
    this.agentId = created.agentId;

    this.record('BACKTEST_STARTED', {
      symbol: this.market,
      timeframe: this.plan.setup,
      range: `${new Date(this.replayStart).toISOString()} → ${new Date(this.end).toISOString()}`,
      candles: loaded.length,
      speed: this.clock.speed,
      environment: 'BACKTEST',
      /*
       * The working set and its roles, on the first line of the run.
       *
       * A reader who wants to know what this replay can see should not have to
       * infer it from four market reads, and "1m entry timing, 5m setup" is a
       * different claim from "1m, 5m".
       */
      timeframes: this.plan.reads
        .map((read) => `${read.timeframe} ${TIMEFRAME_ROLE_LABELS[read.role]}`)
        .join(', '),
      chosenBy: this.plan.strategy === 'DECLARED' ? 'the GOAT' : 'the GOAT',
      ...(this.request.skillIds && this.request.skillIds.length > 0
        ? { skills: this.request.skillIds.length }
        : {}),
    });

    /*
     * What the data source could actually give.
     *
     * Recorded only when it differs from the request. A replay that silently
     * covered a different period than the one that was asked for would report
     * results about that period, and nothing in the log would say so.
     */
    const history = this.history();
    if (history.note) {
      this.record('BACKTEST_STARTED', {
        symbol: this.market,
        resolution: history.resolution,
        note: history.note,
        message: history.note,
      });
    }

    /*
     * DEMO rather than SHADOW.
     *
     * The deployment mode decides whether a plan may be acted on, and a
     * backtest exists to find out what the agent would have done. SHADOW would
     * guarantee the answer is "nothing", which is not a result.
     *
     * What that permission can reach is decided by the environment, and this
     * one has no route to a venue — see `SimulationEnvironment`.
     */
    this.orchestrator.deployGoat({
      goalId: created.goal.id,
      market: this.market,
      timeframe: this.plan.setup,
      timeframes: this.plan.reads.map((read) => read.timeframe),
      mode: 'DEMO',
      accountId: 'simulation',
    });

    await this.orchestrator.investigateGoal(created.goal.id);

    this.setState('READY', 'Ready. Start the simulation when you are.');
    this.emit();
  }

  /**
   * Fetch the dataset, warm-up included.
   *
   * The warm-up window is requested *before* the replay's start, and the two
   * are stitched here rather than asked for separately so that a loader cannot
   * hand back a dataset missing the history the agent needs to form a view in
   * the first place.
   */
  private async loadDataset(preloaded?: Bar[]): Promise<Bar[]> {
    if (preloaded) return preloaded;
    if (!this.request.loadBars) {
      throw new Error('A backtest needs either a dataset or a source to load one from.');
    }
    const bars = await this.request.loadBars({
      market: this.market,
      start: this.replayStart - this.warmupMs,
      end: this.end,
    });
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new Error('The historical dataset came back empty, so there is nothing to replay.');
    }
    return bars;
  }

  /**
   * Start (or resume) the clock.
   *
   * Separate from `start` so a surface can enter the workspace while the GOAT is
   * still thinking — the user watches the setup happen rather than staring at a
   * loading screen — and so START and RESUME are the same operation.
   */
  async play(): Promise<void> {
    await this.start();
    if (this.currentState === 'COMPLETED') return;
    if (this.environment?.exhausted) {
      await this.complete();
      return;
    }
    this.setState('RUNNING');
    this.clock.start(SIMULATION_STEP_MS, (now) => {
      void this.tick(now);
    });
    this.emit();
  }

  /** Hold the simulation where it is. The GOAT keeps whatever it believes. */
  pause(): void {
    if (this.currentState !== 'RUNNING') return;
    this.clock.stop();
    this.setState('PAUSED');
    this.emit();
  }

  /**
   * Stop the simulation.
   *
   * Not a pause: the replay's window is finite and the agent's work inside it
   * is over. Anything the GOAT was holding is stated as held, and the report is
   * final — because a "stopped" run whose numbers kept moving would be
   * unreadable.
   */
  async stop(reason = 'Stopped by the operator.'): Promise<BacktestReport> {
    this.clock.stop();
    this.record('BACKTEST_STOPPED', { reason, ...this.elapsedFields() });
    await this.environment?.finalize();
    this.reportClosedTrades();
    this.report = await this.buildReport('STOPPED', reason);
    this.setState('STOPPED', reason);
    this.emit();
    return this.report;
  }

  /**
   * Begin again from the same instant.
   *
   * A true restart rather than a rewind: the clock is rebuilt, the stores are
   * rebuilt, and the agent is redeployed with no memory of the previous run.
   * Resuming a finished GOAT with its old thesis would not be a replay of
   * anything — it would be the first run's conclusions, applied to the same
   * candles, which is the exact thing a replay must never do.
   */
  async restart(): Promise<void> {
    this.clock.stop();
    this.environment = undefined;
    this.orchestrator = undefined;
    this.goal = undefined;
    this.agentId = undefined;
    this.report = undefined;
    this.starting = undefined;
    this.currentState = 'IDLE';
    this.reportedTrades.clear();
    this.executedPlans.clear();
    this.lastTickPrice = undefined;
    this.trackers.dispose();
    await this.start();
  }

  setSpeed(speed: SimulationSpeed): void {
    if (!isSimulationSpeed(speed)) throw new Error(`${String(speed)}x is not a replay speed.`);
    this.clock.setSpeed(speed);
    this.emit();
  }

  // -------------------------------------------------------------------------
  // The replay
  // -------------------------------------------------------------------------

  /**
   * One simulated step.
   *
   * The order is the argument of the whole file:
   *
   *   1. open positions settle against the candle that just closed
   *   2. trackers evaluate against it
   *   3. whatever woke is allowed to finish, including its model call
   *   4. a risk-validated plan may be executed against the simulated book
   *
   * Step 3 before step 4 and before the next tick is the difference between a
   * replay and a race: an agent reasoning about 10:43 while the simulation is
   * already at 10:47 is reasoning about a market that no longer exists.
   */
  private async tick(now: number): Promise<void> {
    if (this.currentState !== 'RUNNING') return;
    void now;
    await this.step();
  }

  /**
   * One replay step: the whole pipeline, at the clock's current instant.
   *
   * Split out from the timer so that a caller can advance the simulation itself
   * and get exactly the same behaviour — one base bar at a time, with the agent
   * allowed to finish between them. The timer and a hand-driven replay share this
   * method, which is why a test can prove the ordering the browser will use.
   */
  private async step(): Promise<void> {
    const environment = this.environment;
    if (!environment) return;
    if (this.currentState === 'COMPLETED' || this.currentState === 'STOPPED' || this.currentState === 'ERROR') {
      return;
    }

    /*
     * Orders settle before positions, and both before the trackers hear about the
     * candle.
     *
     * The ordering is the whole honesty of a replay:
     *
     *   1. resting orders are tested against *this* candle's range, so a fill can
     *      only come from a price the GOAT was entitled to see;
     *   2. positions then settle against the same candle, which is what resolves a
     *      bar whose range spans both an entry and a stop — the stop is checked
     *      first, so the ambiguity resolves against the trade rather than for it;
     *   3. only then are trackers told about the candle, so any evidence they
     *      gather reflects a book that has already been marked to market.
     *
     * Settling positions first would have been the natural-looking order and would
     * have let a GOAT's own orders fill against a bar its risk layer had not yet
     * seen.
     */
    this.tradeEngine.settle();

    if (environment.exhausted) {
      this.clock.stop();
      await this.complete();
      return;
    }

    const bar = environment.currentBar();
    const now = this.clock.now();
    if (bar) this.recordTick(bar.close, now);

    await this.deliverToTrackers(now);
    await this.settle();
    await this.executeApprovedPlan();
    this.reportClosedTrades();
    this.emit();
  }

  /**
   * Move the simulation forward by a simulated duration, without a timer.
   *
   * The same mechanism the interval drives, one base bar at a time, so nothing
   * is skipped: a 30-minute advance settles positions and delivers thirty
   * candles' worth of tracker evaluations rather than jumping to the last one.
   * Used by the tests to replay a whole session in milliseconds, and available
   * to a surface that wants to move the market on demand.
   */
  async advance(simulatedMs: number): Promise<void> {
    await this.start();
    if (this.clock.running) {
      throw new Error('The simulation clock is already being driven by its timer; pause it first.');
    }
    if (this.currentState === 'COMPLETED' || this.currentState === 'STOPPED') return;

    const wasRunning = this.currentState === 'RUNNING';
    this.setState('RUNNING');
    let remaining = Math.max(0, simulatedMs);
    while (remaining > 0 && this.currentState === 'RUNNING') {
      const chunk = Math.min(60_000, remaining);
      this.clock.advanceBy(chunk);
      remaining -= chunk;
      await this.step();
    }
    if (this.currentState === 'RUNNING' && !wasRunning) this.setState('PAUSED');
  }

  /**
   * The market moved. Say so when it is worth saying.
   *
   * One line per price change, not one per simulated minute. At sixty simulated
   * minutes a minute, a log that printed every tick would bury the two lines
   * that mattered under eight hundred identical ones — the failure the whole
   * event-discipline argument is about. A tracker firing is never throttled; it
   * goes through the GOAT's own events.
   */
  private recordTick(price: number, now: number): void {
    const changed = this.lastTickPrice === undefined || Math.abs(price - this.lastTickPrice) > 1e-9;
    if (!changed) return;
    this.lastTickPrice = price;
    this.record('BACKTEST_TICK', {
      symbol: this.market,
      price,
      simulatedMinutes: Math.max(0, Math.round((now - this.replayStart) / 60_000)),
    });
  }

  /**
   * Hand the newest candle to every tracker that could observe it.
   *
   * One delivery per resolution the agent is actually watching, because the
   * tracker runtime scopes evaluation by timeframe: a single 15m delivery would
   * silently skip every 1h watch the GOAT armed, and the agent would appear to
   * ignore its own higher-timeframe hypothesis.
   *
   * The bars attached to the delivery come from the environment, so they are the
   * visible ones. A tracker therefore cannot be woken by a candle the agent
   * could not have seen either.
   */
  private async deliverToTrackers(now: number): Promise<void> {
    if (!this.agentId || !this.environment) return;

    const instance = this.agentRuntime.getAgent(this.agentId);
    if (!instance?.isRunning) return;

    const timeframes = new Set<string>();
    for (const tracker of this.trackers.listForAgent(this.agentId)) {
      if (tracker.lifecycle.status === 'ACTIVE' && tracker.timeframe) timeframes.add(tracker.timeframe);
    }
    if (timeframes.size === 0) timeframes.add(this.plan.setup);

    for (const timeframe of timeframes) {
      const bars = await this.environment.getMarketBars(this.market, timeframe, 200);
      const newest = bars[bars.length - 1];
      if (!newest) continue;
      /*
       * Stamped with the candle's own open time, which is the convention every
       * other producer of a `BAR_UPDATE` in this system follows.
       *
       * The evaluator confirms that the delivery's timestamp falls inside the
       * same timeframe bucket as the bar it carries, which is how it knows the
       * delivery is about *that* candle and not a stale one. A 15m watch handed a
       * delivery stamped at the candle's close instant lands in the next bucket,
       * concludes there is no new bar, and stays silent — a tracker that is
       * armed, correct, and never fires.
       */
      const closed = newest.time * 1000;
      const input: TrackerInput = {
        // The id names the delivery, so the same candle is never evaluated
        // twice for the same tracker however many times the clock ticks.
        id: `backtest:${this.market}:${timeframe}:${closed}`,
        agentId: this.agentId,
        type: 'BAR_UPDATE',
        timestamp: closed,
        environment: 'BACKTEST',
        symbol: this.market,
        timeframe,
        state: {
          timestamp: closed,
          environment: 'BACKTEST',
          symbol: this.market,
          timeframe,
          price: newest.close,
          bars: bars.map((item) => ({
            time: item.time,
            open: item.open,
            high: item.high,
            low: item.low,
            close: item.close,
          })),
          eventData: { isClosed: true },
        },
      };
      await this.trackers.process(input);
    }
  }

  /**
   * Wait for the agent to finish reacting.
   *
   * Bounded, and reported when the bound is hit. A replay that silently pushed
   * on would let the agent answer a question about a market it had already
   * left, which is the subtlest way a backtest can flatter a strategy.
   */
  private async settle(): Promise<void> {
    const deadline = Date.now() + BACKTEST_WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const waitingOnModel = this.agentId
        ? this.orchestrator?.pendingModelRequest(this.agentId) !== undefined
        : false;
      if (this.wakeInFlight === 0 && !waitingOnModel) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.record('ERROR', {
      message: 'The agent did not finish reacting to a simulated event within the replay budget.',
    });
  }

  /**
   * Act on a plan the risk layer approved.
   *
   * Only ever against the simulated book, and only at the size the risk layer
   * computed — the plan is the agent's, the sizing is the deterministic layer's,
   * and neither is recalculated here. The plan's own invalidation becomes the
   * stop, because that is what it is: the price at which the thesis is wrong.
   */
  private async executeApprovedPlan(): Promise<void> {
    if (!this.agentId || !this.goal || !this.environment || !this.orchestrator) return;
    const mission = this.orchestrator.mission(this.goal.id);
    const plan = mission?.tradePlan;
    if (!plan || plan.status !== 'READY') return;

    // The plan itself has already been through the orchestrator's risk layer; the
    // engine's job now is price coherence and placement. Both are needed: the
    // orchestrator sizes against the account, and the engine refuses a plan whose
    // stop is on the wrong side of its entry — a check no account reading can make.
    /*
     * The engine logs its own rejections.
     *
     * It has to: a plan can be refused by the price checks here or by the book
     * during placement, and both are the same fact about the same trade. Logging
     * again at the call site would print every rejection exactly twice, and a log
     * that says a thing happened two times is a log nobody trusts about the one
     * time it happened once.
     */
    await this.tradeEngine.submit(plan, this.goal.id);

    // Executing is only honest once the order is actually resting.
    const trade = this.tradeEngine.all().find((candidate) => candidate.planId === plan.id);
    if (!trade || trade.status !== 'PENDING') return;

    this.record('ORDER_PLACED', {
      tradeId: trade.id,
      planId: plan.id,
      symbol: trade.symbol,
      side: trade.side,
      orderType: trade.orderType,
      entry: trade.proposedEntry,
      stop: trade.stopLoss,
      ...(trade.takeProfit !== undefined ? { target: trade.takeProfit } : {}),
      riskReward: trade.riskReward,
      simulated: true,
    });
    this.orchestrator.applyExecution(plan.id, { status: 'EXECUTING', reason: 'A limit order is resting.' });
  }

  /**
   * The account and policy facts a trade decision is made against.
   *
   * Read fresh every time rather than captured once, because equity moves as
   * trades close: a size computed against the opening balance would silently
   * exceed the strategy's risk budget by the time the fourth trade was placed.
   *
   * `valuePerUnit` is 1 by default, which is right for instruments quoted in the
   * account's own currency and wrong for ones that are not. It is a known
   * approximation of the sizing layer rather than a claim of accuracy, and the
   * orchestrator's own `risk.calculatePositionSize` capability remains the
   * authority for anything that reaches a live venue.
   */
  private tradeContext(): TradeContext {
    const environment = this.environment;
    const bar = environment?.currentBar();
    const equity = this.initialBalance;
    /*
     * The deployment's own risk policy, read through the live agent rather than a
     * field on the session — the policy is the agent's, and duplicating it here
     * would be a second place to forget to update it.
     */
    const instance = this.agentId ? this.agentRuntime.getAgent(this.agentId) : undefined;
    const maxRiskPerTrade = instance?.agent.policy.maxRiskPerTrade ?? 0.01;
    return {
      symbol: this.market,
      currentPrice: bar?.close ?? 0,
      maxRiskFractionOfEquity: maxRiskPerTrade,
      equity,
      valuePerUnit: 1,
      mayExecute: this.orchestrator?.mission(this.goal?.id ?? '')?.mayExecute ?? false,
      // One position at a time.
      //
      // The conservative default for a strategy whose concurrency was never
      // stated: two overlapping positions from one thesis is not two trades, it is
      // one idea counted twice, and it would be reported as diversification.
      maxConcurrentPositions: 1,
    };
  }

  /**
   * Record one trade lifecycle transition.
   *
   * The event type is chosen from the transition rather than passed in, so every
   * path into a state logs the same kind of line — a fill logged as an order, or a
   * closure logged as an expiry, is the kind of mismatch that makes a timeline
   * unreadable exactly when somebody is trying to follow a trade.
   */
  private recordTradeTransition(transition: TradeTransition): void {
    const shared = {
      tradeId: transition.tradeId,
      planId: transition.planId,
      ...(transition.price !== undefined ? { price: transition.price } : {}),
      ...(transition.reason ? { detail: transition.reason } : {}),
      simulated: true,
    };

    switch (transition.to) {
      case 'PENDING':
        this.record('ORDER_PLACED', { ...shared, ...(transition.price !== undefined ? { entry: transition.price } : {}) });
        return;
      case 'FILLED':
        this.record('ORDER_FILLED', shared);
        return;
      case 'RUNNING':
        this.record('POSITION_OPENED', shared);
        return;
      case 'EXPIRED':
        this.record('ORDER_EXPIRED', shared);
        return;
      case 'CANCELLED':
        this.record('ORDER_CANCELLED', shared);
        return;
      case 'REJECTED':
        this.record('ORDER_REJECTED', shared);
        return;
      case 'TAKE_PROFIT':
      case 'STOPPED_OUT':
      case 'EXITED':
        this.record('TRADE_CLOSED', { ...shared, ...(transition.pnl !== undefined ? { pnl: transition.pnl } : {}) });
        return;
      default:
        return;
    }
  }

  /**
   * The GOAT's trades as *trades* — intention, order, fill, result.
   *
   * Distinct from `trades()`, which is the venue's own fill ledger. Both are
   * useful and they answer different questions: `trades()` says what executed,
   * this says what the GOAT was trying to do and what became of it, including the
   * orders that never filled at all.
   */
  tradeRecords(): TradeRecord[] {
    return this.tradeEngine.all();
  }

  /** Trade statistics, derived on demand from the trades above. */
  tradeStats(): TradeStatistics {
    return tradeStatistics(this.tradeEngine.all());
  }

  /**
   * Report a simulated exit once, with its outcome in plain numbers.
   *
   * The pips line is the one a person watching wants: whether the thesis was
   * right is a question about price, and it should be answerable without
   * arithmetic.
   */
  private reportClosedTrades(): void {
    for (const trade of this.environment?.simulatedTrades() ?? []) {
      if (this.reportedTrades.has(trade.id)) continue;
      this.reportedTrades.add(trade.id);
      const pips = this.environment?.pipsFor(trade);
      this.record('POSITION_CLOSED', {
        tradeId: trade.id,
        positionId: trade.positionId,
        symbol: trade.symbol,
        simulated: true,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        pnl: trade.pnl,
        ...(pips !== undefined ? { pips } : {}),
        outcome:
          trade.exitReason === 'STOP_LOSS'
            ? 'The thesis was wrong: its invalidation price was reached.'
            : trade.exitReason === 'TAKE_PROFIT'
              ? 'The thesis paid: its first target was reached.'
              : 'The simulation ended with the position still open.',
      });
    }
  }

  private async complete(): Promise<BacktestReport> {
    this.clock.stop();
    await this.environment?.finalize();
    this.reportClosedTrades();
    this.report = await this.buildReport('COMPLETED', 'The historical window has been replayed.');
    this.record('BACKTEST_COMPLETED', {
      ...this.elapsedFields(),
      trades: this.report.performance.trades,
      netPnl: this.report.performance.netPnl,
      modelCalls: this.report.behaviour.modelCalls,
    });
    this.setState('COMPLETED', this.report.message);
    this.emit();
    return this.report;
  }

  private async buildReport(
    outcome: BacktestReport['outcome'],
    message?: string,
  ): Promise<BacktestReport> {
    const account = (await this.environment?.getAccountState()) ?? {
      equity: this.initialBalance,
    };
    const trades = this.environment?.simulatedTrades() ?? [];
    const events = this.events();
    const bounds = { startAt: this.replayStart, endAt: Math.max(this.replayStart, this.clock.now()) };
    return {
      performance: summarisePerformance(trades, this.initialBalance, account.equity),
      behaviour: summariseBehaviour(events, bounds),
      trades,
      outcome,
      ...(message ? { message } : {}),
    };
  }

  private elapsedFields(): Record<string, number | string> {
    return {
      simulatedMinutes: Math.max(0, Math.round((this.clock.now() - this.replayStart) / 60_000)),
      bars: this.environment?.barsConsumed() ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  snapshot(): BacktestSnapshot {
    const bar = this.environment?.currentBar();
    const now = this.clock.now();
    return {
      state: this.currentState,
      now,
      speed: this.clock.speed,
      symbol: this.market,
      ...(bar ? { price: bar.close } : {}),
      simulatedMinutes: Math.max(0, Math.round((now - this.replayStart) / 60_000)),
      progress: this.environment?.progress ?? 0,
      agentBusy: this.isAgentBusy(),
      ...(this.goal ? { goalId: this.goal.id } : {}),
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...(this.goal && this.orchestrator ? { mission: this.orchestrator.mission(this.goal.id) ?? undefined } : {}),
      ...(this.report ? { report: this.report } : {}),
      ...(this.tradeEngine ? { tradePhase: this.tradePhase() } : {}),
      ...(this.lastMessage ? { message: this.lastMessage } : {}),
      ...(this.tradeEngine ? { trades: this.tradeEngine.all() } : {}),
      ...(this.tradeEngine ? { tradeStats: this.tradeStats() } : {}),
    };
  }

  /**
   * What the GOAT is doing, in trade terms.
   *
   * Derived from the live trades rather than tracked separately, because a status
   * kept alongside the trades is a status that can disagree with them — and the
   * whole complaint about the previous behaviour was a screen that said
   * "RESEARCHING" while a position was open.
   *
   * Order matters: the running position wins over the waiting order, because an
   * open position is what a reader most needs to know.
   */
  tradePhase(): BacktestTradePhase {
    const trades = this.tradeEngine?.all() ?? [];
    if (this.currentState === 'COMPLETED') return 'BACKTEST COMPLETE';
    if (trades.some((trade) => trade.status === 'RUNNING' || trade.status === 'FILLED')) return 'POSITION OPEN';
    if (trades.some((trade) => trade.status === 'PENDING')) return 'ORDER PENDING';
    if (trades.some((trade) => trade.status === 'TAKE_PROFIT' || trade.status === 'STOPPED_OUT' || trade.status === 'EXITED')) {
      return 'SEARCHING FOR NEXT TRADE';
    }
    if (this.orchestrator?.mission(this.goal?.id ?? '')?.tradePlan) return 'MANAGING TRADE';
    return 'RESEARCHING';
  }

  /** The agent log, from the same projection the live workspace renders. */
  agentLog(limit = 200) {
    return this.goal && this.orchestrator ? this.orchestrator.agentLog(this.goal.id, limit) : [];
  }

  /** Observe state changes. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: BacktestSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Trades as the simulated book holds them, for the results panel. */
  trades(): Trade[] {
    return this.environment?.simulatedTrades() ?? [];
  }

  /** Events the runtime wrote during this run, for behaviour analysis. */
  events(): AgentTimelineEvent[] {
    return this.agentRuntime.getTimelineStore().snapshotByGoat?.(this.agentId ?? '', 5000) ?? [];
  }

  /**
   * Whether the replay is holding for the GOAT.
   *
   * Either a wake is being applied or a model request is outstanding. Both mean
   * the market is deliberately not advancing, and both are worth saying: a clock
   * that stops without explanation looks like a bug, and this one is a promise
   * that the agent will not be shown a market it has already answered about.
   */
  private isAgentBusy(): boolean {
    if (this.wakeInFlight > 0) return true;
    // Any agent, not just the recorded one: during the first pass the goal is
    // still being interpreted, so there is an id to ask about yet — and that
    // window is exactly when the run is holding.
    return this.orchestrator?.hasPendingModelRequest() === true;
  }

  /**
   * What the data source could give, against what was asked for.
   *
   * The note is the important field. "You asked for three years and the source
   * has one" is a sentence this product must be able to say, because the
   * alternative — replaying a year and calling it three — is the failure mode
   * every historical claim is prone to.
   */
  history(): BacktestHistory {
    /*
     * Readable before the replay starts.
     *
     * The dataset arrives with the request in the common case, and a surface
     * wants to know what it got before it presses start — including whether the
     * window it asked for is one the source can serve. Waiting for `start` to
     * find that out would mean loading a year of candles to be told the source
     * has a month.
     */
    const dataset = this.environment?.dataset() ?? this.request.bars ?? [];
    const resolution = this.environment?.resolution ?? SIMULATION_BASE_TIMEFRAME;
    const unsupported = this.plan.reads
      .map((read) => read.timeframe)
      .filter((timeframe) => this.environment ? !this.environment.supports(timeframe) : false);

    const availableStart = dataset.length > 0 ? dataset[0].time * 1000 : undefined;
    const availableEnd = dataset.length > 0
      ? (dataset[dataset.length - 1].time + baseSeconds(this.environment?.resolution ?? resolution)) * 1000
      : undefined;

    const missingStart = availableStart !== undefined && availableStart > this.request.start + 60 * 60_000;
    const missingEnd = availableEnd !== undefined && availableEnd < this.request.end - 60 * 60_000;

    return {
      requestedStart: this.request.start,
      requestedEnd: this.request.end,
      ...(availableStart !== undefined ? { availableStart } : {}),
      ...(availableEnd !== undefined ? { availableEnd } : {}),
      bars: dataset.length,
      resolution,
      unsupported,
      ...(missingStart || missingEnd || unsupported.length > 0
        ? {
            note: [
              missingStart ? `The source has nothing before ${new Date(availableStart ?? 0).toISOString().slice(0, 10)}.` : '',
              missingEnd ? `The source has nothing after ${new Date(availableEnd ?? 0).toISOString().slice(0, 10)}.` : '',
              unsupported.length > 0
                ? `Unavailable at ${resolution}: ${unsupported.join(', ')}. Those resolutions are reported to the GOAT as missing rather than approximated.`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
    };
  }

  /** Which resolutions this replay reads, and what each one is for. */
  get timeframes(): TimeframePlan {
    return this.plan;
  }

  /** The simulated market, for a test that needs to inspect the boundary. */
  get simulation(): SimulationEnvironment {
    if (!this.environment) throw new Error('This backtest has not loaded its dataset yet.');
    return this.environment;
  }

  /** The historical clock. */
  get simulatedClock(): SimulationClock {
    return this.clock;
  }

  /** The GOAT runtime this simulation is running. */
  get goat(): GoatOrchestrator | undefined {
    return this.orchestrator;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private record(type: AgentTimelineEventType, data: unknown): void {
    if (!this.goal) return;
    this.orchestrator?.recordActivity({
      goatId: this.goal.agentId,
      agentId: this.goal.agentId,
      type,
      data,
    });
  }

  private setState(state: BacktestState, message?: string): void {
    this.currentState = state;
    if (message !== undefined) this.lastMessage = message;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A surface that throws must not stop the replay.
      }
    }
  }
}