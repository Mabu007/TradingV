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

import { GoatOrchestrator, createGoatStores, type GoatStores } from '../orchestrator';
import type { Goal } from '../types';
import {
  SimulationClock,
  DEFAULT_SIMULATION_SPEED,
  SIMULATION_STEP_MS,
  isSimulationSpeed,
  type SimulationSpeed,
} from './clock';
import { SimulationEnvironment, timeframeSeconds } from './simulationEnvironment';
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
  /** The setup resolution. The agent chooses its own context resolutions. */
  timeframe?: string;
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
}

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
  goalId?: string;
  agentId?: string;
  mission?: GoatMission;
  report?: BacktestReport;
  message?: string;
}

export class BacktestSession {
  readonly market: string;
  readonly timeframe: string;
  /** Historical instant the replay begins at. The clock starts here. */
  readonly replayStart: number;
  readonly end: number;

  private readonly request: BacktestRequest;
  private readonly clock: SimulationClock;
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
  private lastTickPrice?: number;
  private wakeInFlight = 0;
  private starting?: Promise<void>;

  constructor(request: BacktestRequest) {
    this.request = request;
    this.market = request.market;
    this.timeframe = request.timeframe ?? '15m';
    this.replayStart = request.start;
    this.end = request.end;
    this.warmupMs = (request.warmupMinutes ?? DEFAULT_BACKTEST_WARMUP_MINUTES) * 60_000;

    this.initialBalance = request.costModel?.initialBalance ?? 10_000;

    this.clock = new SimulationClock({
      start: request.start,
      speed: request.speed ?? DEFAULT_SIMULATION_SPEED,
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
      ...(this.request.skillIds && this.request.skillIds.length > 0
        ? { skillIds: this.request.skillIds }
        : {}),
    });
    this.goal = created.goal;
    this.agentId = created.agentId;

    this.record('BACKTEST_STARTED', {
      symbol: this.market,
      timeframe: this.timeframe,
      range: `${new Date(this.replayStart).toISOString()} → ${new Date(this.end).toISOString()}`,
      candles: loaded.length,
      speed: this.clock.speed,
      environment: 'BACKTEST',
    });

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
      timeframe: this.timeframe,
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

    environment.settleOpenPositions();

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
    if (timeframes.size === 0) timeframes.add(this.timeframe);

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
    if (!mission?.mayExecute) return;
    if (this.executedPlans.has(plan.id)) return;
    if (this.environment.openPositions().length > 0) return;

    const size = plan.riskCheck?.metrics?.['volumeUnits'];
    if (typeof size !== 'number' || !(size > 0)) return;

    const side = plan.direction === 'LONG' ? 'BUY' : 'SELL';
    const target = plan.takeProfits[0]?.price;
    const fill = await this.environment.placeMarketOrder({
      symbol: plan.symbol,
      side,
      volume: size,
      stopLoss: plan.invalidationLevel,
      ...(typeof target === 'number' ? { takeProfit: target } : {}),
      comment: 'Simulated from a GOAT trade plan',
    });
    if (!fill.success || !fill.positionId) {
      this.record('ERROR', { message: `A simulated order was refused: ${fill.error ?? 'unknown reason'}` });
      return;
    }

    this.executedPlans.add(plan.id);
    this.record('ORDER', {
      symbol: plan.symbol,
      side,
      volume: size,
      entry: plan.entry,
      stop: plan.invalidationLevel,
      ...(typeof target === 'number' ? { target } : {}),
      simulated: true,
    });
    this.record('FILL', {
      symbol: plan.symbol,
      price: fill.fillPrice,
      volume: size,
      simulated: true,
    });
    this.record('POSITION_OPENED', {
      positionId: fill.positionId,
      symbol: plan.symbol,
      side,
      simulated: true,
    });
    this.orchestrator.applyExecution(plan.id, { status: 'MANAGING', reason: 'Simulated fill' });
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
      ...(this.goal ? { goalId: this.goal.id } : {}),
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...(this.goal && this.orchestrator ? { mission: this.orchestrator.mission(this.goal.id) ?? undefined } : {}),
      ...(this.report ? { report: this.report } : {}),
      ...(this.lastMessage ? { message: this.lastMessage } : {}),
    };
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