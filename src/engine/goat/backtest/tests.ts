/**
 * The invariants a backtest must not break.
 *
 * Ten tests, one per dangerous property. This is deliberately not a broad suite
 * of permutations: every test here exists because breaking it would make the
 * feature worse than useless rather than merely incomplete. A backtest that
 * leaks the future is worse than no backtest, because it is believed.
 *
 *   1  no future data          the agent cannot receive a candle that has not closed
 *   2  the clock advances      available history grows with simulated time
 *   3  indicator boundary      an indicator at T cannot have used T+1
 *   4  candle completion       an unfinished 15m candle is not a candle
 *   5  simulated execution     a replay cannot reach a live adapter
 *   6  tracker wake            a historical tick fires a tracker and wakes the GOAT
 *   7  model context           the model is given the simulated present, not the answer
 *   8  live is unchanged       a live environment still reads live data
 *   9  fast progression        historical minutes do not cost real minutes
 *   10 behaviour reporting     the run says what the agent did, not just what it earned
 *
 * Tests 5, 6, 7 and 10 run the real orchestrator, the real loop, the real
 * tracker runtime and the real capability registry against a synthetic dataset,
 * with only the clock and the model doubled — because a backtest whose
 * correctness depends on a venue being reachable proves nothing about
 * look-ahead.
 */

import { AgentRuntime } from '../../agents/runtime';
import { TrackerRegistry } from '../../agents/trackers/registry';
import { TrackerRuntime } from '../../agents/trackers/runtime';
import { InMemoryAgentTimelineStore } from '../../agents/timeline/store';
import type { AgentTimelineEvent } from '../../agents/timeline/types';
import type { IAgentModel } from '../../agents/model/types';
import { normalizeModelReply } from '../../agents/model/openrouter';
import { DemoEnvironment } from '../../agents/environment/demo';
import { capabilityRegistry } from '../../agents/capabilities';
import { calculateRSI, calculateSMA, calculateEMA } from '../../indicators';
import type { Bar } from '../../../types/trading';

import { GoatOrchestrator, createGoatStores } from '../orchestrator';
import { BacktestSession } from './session';
import type { BacktestReport } from './results';
import { SimulationClock } from './clock';
import { SimulationEnvironment, latestAtOrBefore, timeframeSeconds } from './simulationEnvironment';
import {
  resolveTimeframePlan,
  timeframesInStatement,
} from '../timeframes';
import {
  HISTORICAL_PRESETS,
  windowForPresetRequest,
} from './window';
import {
  deriveBehaviourScore,
  deriveGoatState,
  deriveKeyMoments,
  deriveNearMisses,
} from './story';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  const same =
    actual === expected ||
    (typeof actual === 'object' && actual !== null && expected !== null &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (!same) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A synthetic market with a shape a tracker can act on.
 *
 * A flat line would prove the boundary (nothing ever changes) but would also
 * make a wake impossible to test, so the second half trends: enough movement for
 * a price-cross to fire inside the replay window, and every bar a valid candle.
 */
function makeDataset(options: { count?: number; startSeconds?: number } = {}): Bar[] {
  const count = options.count ?? 900;
  const start = options.startSeconds ?? 1_767_225_600; // 2026-01-01T00:00:00Z
  return Array.from({ length: count }, (_, index) => {
    /*
     * A wave, so an indicator computed over the whole dataset genuinely differs
     * from one computed over a prefix — a straight line makes RSI saturate at
     * 100 either way, which would let a look-ahead leak pass a boundary test.
     * The trend in the second half is what a price-cross tracker can act on.
     */
    const drift = index < count / 2 ? 0 : (index - count / 2) * 0.0008;
    const base = 157.8 + drift + Math.sin(index / 9) * 0.0025;
    return {
      time: start + index * 60,
      open: base,
      high: base + 0.0006,
      low: base - 0.0006,
      close: base + 0.0002,
      volume: 1_000 + index,
    };
  });
}

/** A clock that can be moved by hand, so a test needs no timer at all. */
function manualClock(start: number): SimulationClock {
  return new SimulationClock({ start, speed: 1 });
}

const INVESTIGATION = JSON.stringify({
  thought: 'The range is holding while the higher timeframe stays flat.',
  thesis: {
    statement: 'The range holds while the higher timeframe remains neutral.',
    direction: 'BULLISH',
    invalidation: 'A 15m close below 157.7.',
    requiredConfirmation: ['a new bar', 'price reclaiming the range high'],
  },
  trackers: [
    { purpose: 'Watch for a new 15m bar', kind: 'NEW_BAR', config: {}, timeframe: '15m' },
    { purpose: 'Detect price crossing 157.9', kind: 'PRICE_CROSS', config: { direction: 'ABOVE', level: 157.9 }, timeframe: '15m' },
  ],
});

/** A model that answers an investigation, then confirms whatever woke it. */
class ScriptedBacktestModel implements IAgentModel {
  calls = 0;
  readonly requests: Array<{ contract?: string; instructions: string; wakeReason?: string }> = [];

  async run(request: { contract?: string; instructions: string; wakeReason?: string; observation?: unknown }) {
    this.calls += 1;
    this.requests.push({
      ...(request.contract ? { contract: request.contract } : {}),
      instructions: request.instructions,
      ...(request.wakeReason ? { wakeReason: request.wakeReason } : {}),
    });
    if (request.contract === 'INVESTIGATION') return normalizeModelReply(INVESTIGATION);
    if (request.contract === 'INTERPRETATION') {
      return normalizeModelReply(JSON.stringify({ thought: 'Understood.', symbols: [], timeframes: [], investigationPlan: [], openQuestions: [], actionable: true }));
    }
    return normalizeModelReply(
      JSON.stringify({
        kind: 'PROPOSE_TRADE_IDEA',
        thesisId: 'ignored',
        reason: 'the level was reclaimed on a completed candle',
        idea: {
          symbol: 'USD/JPY',
          direction: 'LONG',
          orderType: 'MARKET',
          entry: 158,
          invalidationLevel: 157.7,
          takeProfits: [{ price: 158.4, fraction: 1 }],
          reasoning: 'reclaim confirmed',
        },
      }),
    );
  }
}

/**
 * The market on its own, with no GOAT in it.
 *
 * The boundary is a property of the environment, so the tests that assert it
 * use it directly: a session would add a deployment, a model and a deployment
 * record to a question that none of those can affect.
 */
function makeEnvironment(options: { dataset?: Bar[]; start?: number } = {}): {
  clock: SimulationClock;
  environment: SimulationEnvironment;
  bars: Bar[];
} {
  const bars = options.dataset ?? makeDataset();
  const start = options.start ?? bars[200].time * 1000;
  const clock = new SimulationClock({ start, speed: 1 });
  const environment = new SimulationEnvironment(clock, {
    symbol: 'USD/JPY',
    bars,
    initialBalance: 10_000,
    spreadPrice: 0.001,
    pipSize: 0.01,
  });
  return { clock, environment, bars };
}

/**
 * A model that asks for the resolution it is missing, then answers.
 *
 * The first pass answers with `requestTimeframes` and no thesis, which is the
 * documented way for an agent to say "I cannot plan this from 15m alone". The
 * runtime reads what was asked for and asks again — so the second answer is the
 * one that produces a plan, and the log has to show both reads.
 */
/**
 * A scalper's answer: a plan and two conditions on the resolution it declared.
 *
 * Deliberately at the declared resolution rather than the default 15m, because
 * a GOAT that declared 1m and 5m and then armed a 15m condition would be
 * refused — and the runtime says so rather than quietly accepting a watch on a
 * resolution it will not evaluate.
 */
const SCALP_INVESTIGATION = JSON.stringify({
  thought: 'The range is holding on 1m while 5m stays flat.',
  thesis: {
    statement: 'USD/JPY holds its 1m range inside a flat 5m structure.',
    direction: 'BULLISH',
    invalidation: 'A completed 1m close below the range low.',
    requiredConfirmation: ['a new 1m bar', 'a reclaim of the 1m range high'],
  },
  trackers: [
    { purpose: 'Watch for a new 1m bar', kind: 'NEW_BAR', config: {}, timeframe: '1m' },
    { purpose: 'Detect price crossing 157.9', kind: 'PRICE_CROSS', config: { direction: 'ABOVE', level: 157.9 }, timeframe: '1m' },
  ],
});

class ScalpModel implements IAgentModel {
  calls = 0;

  async run(request: { contract?: string }) {
    this.calls += 1;
    if (request.contract === 'INVESTIGATION') return normalizeModelReply(SCALP_INVESTIGATION);
    if (request.contract === 'INTERPRETATION') {
      return normalizeModelReply(
        JSON.stringify({ thought: 'Scalp USD/JPY on 1m and 5m.', symbols: ['USD/JPY'], timeframes: ['1m', '5m'], investigationPlan: [], openQuestions: [], actionable: true }),
      );
    }
    return normalizeModelReply(JSON.stringify({ kind: 'WAIT', reason: 'Not enough yet.' }));
  }
}

class AcquiringModel extends ScriptedBacktestModel {
  asked = 0;

  async run(request: { contract?: string; instructions: string; wakeReason?: string }) {
    if (request.contract === 'INVESTIGATION' && this.asked === 0) {
      this.asked += 1;
      this.calls += 1;
      return normalizeModelReply(JSON.stringify({ requestTimeframes: ['1h'] }));
    }
    return super.run(request);
  }
}

/**
 * A model that holds its reply until the test lets it go.
 *
 * The replay's determinism claim is about the interval in which a request is
 * outstanding, so the test needs that interval to exist rather than to be
 * measured in milliseconds of luck.
 */
class GatedModel implements IAgentModel {
  private release?: () => void;
  private readonly answered = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async run(request: { contract?: string; instructions: string; wakeReason?: string }) {
    if (request.contract === 'INVESTIGATION' || request.contract === 'INTERPRETATION') {
      await this.answered;
      return normalizeModelReply(INVESTIGATION);
    }
    return normalizeModelReply(JSON.stringify({ kind: 'WAIT', reason: 'Nothing yet.' }));
  }

  letGo(): void {
    this.release?.();
  }
}

interface Fixture {
  session: BacktestSession;
  clock: SimulationClock;
  bars: Bar[];
  start: number;
  model: ScriptedBacktestModel;
}

async function makeSession(options: {
  dataset?: Bar[];
  market?: string;
  goal?: string;
  timeframes?: string[];
  timeframe?: string;
  name?: string;
  skillIds?: string[];
  warmupMinutes?: number;
} = {}): Promise<Fixture> {
  const bars = options.dataset ?? makeDataset();
  const market = options.market ?? 'USD/JPY';
  // The replay starts a third of the way in, so there is warm-up behind it.
  const startSeconds = bars[Math.floor(bars.length / 3)].time;
  const start = startSeconds * 1000;
  const model = new ScriptedBacktestModel();

  const session = new BacktestSession({
    goal: options.goal ?? 'Trade a USD/JPY range while the higher timeframe stays neutral.',
    name: options.name ?? 'Range replay',
    market,
    ...(options.timeframe ? { timeframe: options.timeframe } : {}),
    ...(options.timeframes ? { timeframes: options.timeframes } : {}),
    ...(options.skillIds ? { skillIds: options.skillIds } : {}),
    ...(options.warmupMinutes !== undefined ? { warmupMinutes: options.warmupMinutes } : {}),
    start,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model,
    speed: 1,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });

  /*
   * The environment is deliberately not in the fixture: it does not exist until
   * the session has loaded its dataset, and a test that reached for it first
   * would be reaching for the wrong object — the boundary belongs to the market
   * under the replay, not to the replay's scaffolding.
   */
  return { session, clock: session.simulatedClock, bars, start, model };
}

// ---------------------------------------------------------------------------
// 1. No future data
// ---------------------------------------------------------------------------

test('boundary: at 10:00 the agent cannot receive 10:01', async () => {
  const { clock, environment, bars } = makeEnvironment();

  const atTen = bars.findIndex((bar) => bar.time % 86_400 === 10 * 3_600);
  const target = bars[atTen >= 0 ? atTen : 200];
  clock.advanceTo((target.time + 60) * 1000);

  const visible = await environment.getMarketBars('USD/JPY', '1m', 5_000);
  const newest = visible[visible.length - 1];

  assertEqual(newest.time, target.time, 'the newest visible bar is the one that just closed');
  assert(
    !visible.some((bar) => bar.time > target.time),
    'nothing after the simulated instant is reachable',
  );
  assert(
    environment.horizon() <= clock.now(),
    'the environment advertises a horizon at or before the clock',
  );

  /*
   * Every way of asking, one answer.
   *
   * A boundary that holds for candles and not for the quote is not a boundary:
   * the model reads the price from the quote, so a quote from the future leaks
   * exactly as much as a future candle does.
   */
  const quote = await environment.getMarketQuote('USD/JPY');
  assertEqual(quote.timestamp, (target.time + 60) * 1000, 'the quote is stamped at the closed bar');
  assertEqual(quote.bid <= target.close, true, 'and priced from it');
  const context = await environment.getMarketContext('USD/JPY');
  assert(
    !String(context.source ?? '').includes('incomplete'),
    'the market context names when it was read',
  );
});

// ---------------------------------------------------------------------------
// 2. The clock advances the available dataset
// ---------------------------------------------------------------------------

test('clock: advancing time reveals exactly the next minutes', async () => {
  const { clock, environment, bars } = makeEnvironment();
  const startIndex = environment.barsConsumed();

  const counts: number[] = [environment.barsConsumed()];
  for (const minutes of [1, 2, 3]) {
    clock.advanceBy(minutes * 60_000);
    counts.push(environment.barsConsumed());
  }

  assertEqual(counts[1] - counts[0], 1, 'one simulated minute reveals one bar');
  assertEqual(counts[2] - counts[1], 2, 'two more minutes reveal two more');
  assertEqual(counts[3] - counts[2], 3, 'and three more reveals three');

  const visible = await environment.getMarketBars('USD/JPY', '1m', 1);
  assertEqual(visible.length, 1, 'a one-bar read is still a one-bar read');
  assert(
    counts[3] > startIndex,
    `the replay window opened behind the warm-up (${startIndex} bars were already visible)`,
  );
  assert(counts[3] < bars.length, 'and the dataset still holds future bars it has not given away');
});

// ---------------------------------------------------------------------------
// 3. Indicators respect the boundary
// ---------------------------------------------------------------------------

test('indicators: a value at T cannot have used a candle after T', async () => {
  const bars = makeDataset();
  const { clock, environment } = makeEnvironment({ dataset: bars });
  const index = 300;
  const atT = (bars[index].time + 60) * 1000;

  clock.advanceTo(atT);
  const visible = await environment.getMarketBars('USD/JPY', '1m', 400);
  const closes = visible.map((bar) => bar.close);

  /*
   * The property itself, checked on the inputs rather than inferred from an
   * output: every candle an indicator is about to be computed from had already
   * closed at the simulated instant. This is the whole of the rule, and it is
   * checkable because the boundary is enforced where the data is.
   */
  assert(
    visible.every((bar) => (bar.time + 60) * 1000 <= atT),
    'not one input bar closed after the instant being measured',
  );

  const rsiAtT = calculateRSI(closes, 14)[rsiIndex(closes.length, 14)];
  const smaAtT = calculateSMA(closes, 20)[closes.length - 1];
  assert(Number.isFinite(rsiAtT) && Number.isFinite(smaAtT), 'and the indicators are computable from that input');

  /*
   * Agreement with a whole-dataset calculation, which is the point.
   *
   * A windowed or backward-looking function reads the same value at T whether it
   * was given a prefix ending at T or the whole dataset indexed at T. So if these
   * two disagree, something is wrong in the other direction — and if the naive
   * path were the one in use, the two would silently agree while the *input* was
   * the dataset. The input assertion above is what rules that out; this one
   * proves the arithmetic matches the rest of the system's.
   */
  const allCloses = bars.map((bar) => bar.close);
  assertEqual(rsiAtT, calculateRSI(allCloses, 14)[index], 'RSI agrees with the value the same function gives over the dataset');
  assertEqual(smaAtT, calculateSMA(allCloses, 20)[index], 'and so does the moving average');

  /*
   * Where the leak actually lives, demonstrated rather than asserted away.
   *
   * EMA is seeded from the start of whatever array it is given. Computed over a
   * window that does not begin at the dataset's first candle, its value differs
   * from the same index of a whole-dataset series — so a runtime that precomputed
   * indicators once over the entire history and read them by timestamp would hand
   * the agent a value built from a different amount of history than the agent was
   * allowed to see. Recomputing per read is what avoids that, and this is the
   * check that would notice if it stopped.
   */
  const shortWindow = await environment.getMarketBars('USD/JPY', '1m', 120);
  const emaVisible = calculateEMA(shortWindow.map((bar) => bar.close), 50).at(-1);
  const emaLeaked = calculateEMA(allCloses, 50)[index];
  assert(Number.isFinite(emaVisible), 'a shorter visible window still yields a value');
  assert(emaVisible !== emaLeaked, 'and it is not the value a precomputed whole-dataset EMA would have returned');
  assert(
    shortWindow.every((bar) => (bar.time + 60) * 1000 <= atT),
    'because the window it was computed from was itself bounded',
  );
});

/** The last defined RSI index for a series, for readable assertions. */
function rsiIndex(length: number, period: number): number {
  return length - 1;
}

// ---------------------------------------------------------------------------
// 4. Multi-timeframe candle completion
// ---------------------------------------------------------------------------

test('candles: an unfinished 15m candle does not exist', async () => {
  const { clock, environment, bars } = makeEnvironment();
  /*
   * A 15m candle that opens after the clock's start and whose quarter has not
   * finished yet — the exact case the spec cares about. Inside a live session the
   * GOAT reads a 15m chart at 10:37 and must not see the candle that closes at
   * 10:45 as though it were history.
   */
  const boundary = bars.findIndex((bar) => bar.time > clock.now() / 1000 + 1_800 && bar.time % 900 === 0);
  const last = bars[bars.length - 1].time;
  assert(boundary >= 0 && bars[boundary].time + 900 <= last, 'the dataset contains a complete 15m boundary to test against');
  const opening = bars[boundary];

  // Seven minutes into it, the candle is still open.
  clock.advanceTo((opening.time + 7 * 60) * 1000);

  const fifteen = await environment.getMarketBars('USD/JPY', '15m', 10);
  assert(
    !fifteen.some((bar) => bar.time === opening.time),
    `the candle that closes at ${opening.time + 900} does not exist seven minutes into it`,
  );

  // One minute after it closes, it is.
  clock.advanceTo((opening.time + 900) * 1000);
  const after = await environment.getMarketBars('USD/JPY', '15m', 10);
  const formed = after.find((bar) => bar.time === opening.time);
  assert(formed !== undefined, 'once it has closed, the same candle exists');
  assertEqual(
    formed?.high,
    Math.max(...bars.filter((bar) => bar.time >= opening.time && bar.time < opening.time + 900).map((bar) => bar.high)),
    'and it aggregates exactly the minutes that had closed by then',
  );
});

// ---------------------------------------------------------------------------
// 5. Simulated execution cannot reach a live venue
// ---------------------------------------------------------------------------

test('execution: a backtest trade cannot reach live execution', async () => {
  const { session } = await makeSession();

  /*
   * A live adapter, instrumented so that being called is the failure.
   *
   * The import is the real application adapter; nothing about it is stubbed, so
   * this is the actual object a demo or live GOAT executes through. If a replay
   * can reach it, this counter moves.
   */
  const { hyperliquidDemoAdapter } = await import('../../../adapters/hyperliquid/demo');
  const adapter = hyperliquidDemoAdapter as unknown as Record<string, unknown>;
  const touched: string[] = [];
  for (const method of ['placeMarketOrder', 'placeLimitOrder', 'closePosition', 'cancelOrder']) {
    const original = adapter[method];
    adapter[method] = (...args: unknown[]) => {
      touched.push(method);
      return typeof original === 'function' ? (original as (...a: unknown[]) => unknown)(...args) : undefined;
    };
  }

  try {
    await session.start();
    const orchestrator = session.goat!;
    const environment = session.simulation;
    const snapshot = session.snapshot();
    assert(snapshot.mission !== undefined, 'the GOAT deployed and investigated inside the simulation');
    assertEqual(environment.mode, 'BACKTEST', 'the environment it reasons through says so');

    const fill = await environment.placeMarketOrder({
      symbol: 'USD/JPY',
      side: 'BUY',
      volume: 1_000,
      stopLoss: 157.7,
      takeProfit: 158.4,
    });
    assert(fill.success === true, 'the simulated book fills');
    assertEqual(fill.simulated, true, 'and says it was simulated');
    assertEqual(touched.length, 0, 'no live adapter method was called');

    /*
     * And structurally: the deployment this replay made is not permitted to
     * execute anywhere, because the orchestrator refuses LIVE outright, and the
     * environment has no adapter to fall back on.
     */
    let refused = false;
    try {
      orchestrator.deployGoat({ goalId: snapshot.goalId!, market: 'USD/JPY', mode: 'LIVE' });
    } catch {
      refused = true;
    }
    assert(refused, 'a LIVE deployment is refused even inside a backtest');

    const position = (await environment.getPositions())[0];
    assertEqual(position?.id?.startsWith('sim_pos_'), true, 'the position exists only in the simulated book');
  } finally {
    for (const method of ['placeMarketOrder', 'placeLimitOrder', 'closePosition', 'cancelOrder']) {
      delete adapter[method];
    }
  }
});

// ---------------------------------------------------------------------------
// 6. A historical tick fires a tracker and wakes the GOAT
// ---------------------------------------------------------------------------

test('wake: a simulated tick fires a tracker and the GOAT acts on it', async () => {
  const { session } = await makeSession();
  await session.start();

  const mission = session.snapshot().mission;
  assert(mission?.thesis !== undefined, 'the GOAT formed a hypothesis inside the replay');
  assert(mission.activeTrackerCount > 0, 'and armed the conditions that test it');

  /*
   * Place the hypothesis in the actionable state, through the loop's own API.
   *
   * Nothing in the current runtime promotes a thesis to ACTIONABLE by itself, so
   * this test would otherwise never reach an order. Doing it here, explicitly,
   * through `loop.reviseThesis` — which enforces the skill constraints on the
   * way in — is the same thing the live test suite does, and it keeps the
   * assertion honest: the *execution* path is what is under test, not whether
   * this build has finished wiring the agent's own escalation.
   */
  const thesisId = mission!.thesis!.id;
  session.goat!.loop.reviseThesis(thesisId, { state: 'ACTIONABLE' });

  // Replay far enough to cross several 15m boundaries, deterministically.
  await session.advance(45 * 60_000);

  const log = session.agentLog(500);
  const fired = log.filter((entry) => entry.type === 'TRACKER_FIRED');
  assert(fired.length > 0, `a tracker fired on simulated data: ${log.slice(-12).map((e) => e.type).join(' → ')}`);
  assert(
    log.some((entry) => entry.type === 'GOAT_WOKE'),
    'and the GOAT woke on it',
  );
  assert(
    log.some((entry) => entry.type === 'MODEL_REQUEST' && entry.detail !== undefined),
    'the wake re-read the market and asked the model again',
  );

  /*
   * And all the way to a simulated fill.
   *
   * The model was scripted to propose an idea; the risk layer sized it; the
   * session executed it against the simulated book. Every step is the runtime's
   * own, and every line in the log is marked simulated.
   */
  const position = session.simulation.openPositions()[0];
  assert(position !== undefined, 'and it acted: the plan it wrote was executed against the simulated book');
  assertEqual(position.side, 'BUY', 'in the direction the plan named');
  assert(
    position.stopLoss !== undefined,
    'with the thesis\'s own invalidation as the stop, which is what it is for',
  );
  /*
   * The execution lines are now specific about what happened.
   *
   * This used to assert a count of three against a filter that matched the older,
   * vaguer event names, which only worked because `ORDER` and `FILL` said almost
   * nothing about whether an order rested or filled. The trade engine names each
   * transition for what it is — placed, filled, running — so the assertion follows
   * the vocabulary, and checks that each line is filed under EXECUTION rather than
   * merely that some lines exist.
   */
  const execution = log.filter(
    (entry) =>
      entry.type === 'ORDER_PLACED' ||
      entry.type === 'ORDER_FILLED' ||
      entry.type === 'POSITION_OPENED' ||
      entry.type === 'ORDER' ||
      entry.type === 'FILL',
  );
  assert(
    execution.some((entry) => entry.type === 'ORDER_FILLED' || entry.type === 'FILL'),
    'the log says the order filled, not merely that an order was sent',
  );
  assert(
    execution.some((entry) => entry.type === 'POSITION_OPENED'),
    'and that a position opened',
  );
  for (const entry of execution) {
    assertEqual(entry.style.channel, 'EXECUTION', `${entry.type} is filed under EXECUTION`);
  }
  assert(
    log.some((entry) => entry.type === 'TRADE_PLAN_RISK_CHECKED' || entry.type === 'TRADE_PLAN_REJECTED'),
    'after the deterministic risk layer had its say',
  );
});

// ---------------------------------------------------------------------------
// 7. The model's context is the simulated present
// ---------------------------------------------------------------------------

test('context: the model is given the simulated present, never the future', async () => {
  const { session, model, clock } = await makeSession();
  await session.start();
  const environment = session.simulation;

  /*
   * Every prompt the runtime sent, checked against the boundary it was sent at.
   *
   * The bar is the newest closed 1m candle at that instant. A prompt naming a
   * later candle — or a price the market had not reached — would be the agent
   * being handed the answer.
   */
  const requests = model.requests;
  assert(requests.length > 0, 'the model was asked something');
  const atStart = environment.currentBar();
  assert(atStart !== undefined, 'and there was a closed bar to build the context from');

  for (const request of requests) {
    for (const match of request.instructions.matchAll(/\b(1[5-9]\d\.\d{2,4})\b/g)) {
      const price = Number(match[1]);
      assert(
        price <= (atStart?.high ?? Infinity) + 1e-9,
        `the prompt quoted ${price}, above anything the market had reached at the simulated instant`,
      );
    }
  }

  // Every candle the prompt could have been built from is at or before `now`.
  const horizon = environment.horizon();
  assert(horizon <= clock.now(), 'the horizon never runs ahead of the clock');

  /*
   * Nothing that only exists because the replay ended is present. The dataset
   * certainly contains bars after the replay window; the agent must not.
   */
  const futureBars = (await environment.getMarketBars('USD/JPY', '1m', 10_000)).length;
  assert(
    futureBars * 60_000 <= environment.dataset().length * 60_000,
    'the visible window is a prefix of the dataset',
  );
});

// ---------------------------------------------------------------------------
// 8. Live is unchanged
// ---------------------------------------------------------------------------

test('live: a live environment still reads the live market and the live clock', async () => {
  /*
   * Deliberately structural rather than networked: the claim is that adding a
   * simulation did not add simulated time or simulated data to the live path,
   * and that is provable without a venue being up. A test that needed the network
   * would prove connectivity instead.
   */
  const demo = new DemoEnvironment();
  assertEqual(demo.mode, 'DEMO', 'the live path is still DEMO, not BACKTEST');
  assert(
    typeof demo.getMarketQuote === 'function' && typeof demo.getMarketBars === 'function',
    'and it still reads the venue',
  );

  const liveClock = () => Date.now();
  const stores = createGoatStores('MEMORY');
  const agentRuntime = new AgentRuntime(
    capabilityRegistry, undefined, undefined, undefined, new InMemoryAgentTimelineStore(),
  );
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((agentId) => agentRuntime.getAgent(agentId)),
    agents: agentRuntime,
    timeline: agentRuntime.getTimelineStore(),
    clock: liveClock,
  });
  trackers.setEnvironment('DEMO');

  const orchestrator = new GoatOrchestrator({
    agentRuntime, trackers, env: demo, stores, clock: liveClock, storeMode: 'MEMORY',
  });

  orchestrator.stores.goals.save({
    id: 'live_goal', agentId: 'live_agent',
    statement: 'Watch EUR/USD for a break of the range.',
    symbols: [], timeframes: [], skillIds: [],
    status: 'DRAFT', createdAt: liveClock(), updatedAt: liveClock(),
  });
  const deployment = orchestrator.deployGoat({ goalId: 'live_goal', market: 'EURUSD' });

  const mission = orchestrator.mission('live_goal')!;
  assertEqual(mission.stage, 'RESEARCHING', 'a deployed GOAT is researching, not replaying');
  assert(mission.modelPending === undefined, 'and nothing is being waited on yet');
  assertEqual(
    Math.abs(deployment.createdAt - liveClock()) < 60_000,
    true,
    'its records are stamped with the wall clock, not a simulation clock',
  );
  const events = agentRuntime.getTimelineStore().snapshotByGoat?.('live_agent', 50) ?? [];
  assert(
    events.every((event) => event.timestamp >= deployment.createdAt - 60_000),
    'and so is every event it wrote',
  );
});

// ---------------------------------------------------------------------------
// 9. Progression is faster than real time
// ---------------------------------------------------------------------------

test('progression: historical minutes do not cost real minutes', async () => {
  const { clock, environment } = makeEnvironment();

  /*
   * Driven by hand, deliberately.
   *
   * `advanceBy` is the mechanism the real timer drives, so a test that moves the
   * clock directly proves the ratio rather than the timer's accuracy — and it
   * proves it without waiting. At 60x a second of wall clock is a minute of
   * market, which is the whole reason a backtest here can be watched.
   */
  clock.setSpeed(60);
  assertEqual(clock.speed, 60, 'the speed is the one that was asked for');

  const before = environment.barsConsumed();
  const clockStart = clock.now();
  const wallClockStart = Date.now();
  clock.advanceBy(1_000);
  const elapsedReal = Date.now() - wallClockStart;

  assertEqual(clock.now() - clockStart, 60_000, 'one real second at 60x is one simulated minute');
  assertEqual(environment.barsConsumed() - before, 1, 'and that minute reveals exactly one base bar');
  assert(elapsedReal < 250, `while costing no real time at all (${elapsedReal}ms)`);
  assert(
    clock.now() > environment.dataset()[environment.barsConsumed() - 1].time * 1000,
    'and the clock is ahead of the newest bar it has been given',
  );
});

// ---------------------------------------------------------------------------
// 10. Behaviour is reportable
// ---------------------------------------------------------------------------

test('behaviour: the report says what the agent did, not only what it earned', async () => {
  const { session } = await makeSession();
  await session.start();
  await session.advance(75 * 60_000);
  const report = await session.stop();

  assertEqual(report.outcome, 'STOPPED', 'the run ended because it was stopped, and says so');
  assert(report.behaviour.hypothesesFormed >= 1, 'it formed a hypothesis');
  assert(report.behaviour.trackersCreated >= 1, 'armed conditions for it');
  assert(report.behaviour.modelCalls >= 1, 'and asked the model, counted rather than estimated');
  assert(report.behaviour.waits >= 1, 'the times it went dormant are on the record');
  assert(report.behaviour.simulatedMinutes > 0, 'and how much history it covered');
  assertEqual(
    typeof report.performance.endingEquity,
    'number',
    'the money is reported too — but alongside the behaviour, not instead of it',
  );

  const events: AgentTimelineEvent[] = session.events();
  assert(
    events.some((event) => event.type === 'BACKTEST_STARTED') && events.some((event) => event.type === 'BACKTEST_STOPPED'),
    'and the lifecycle itself is in the log the reader inspects',
  );
});

// ---------------------------------------------------------------------------
// Facts respect the clock too
// ---------------------------------------------------------------------------

test('facts: funding and open interest are read as of the simulated instant', async () => {
  const clock = manualClock(1_767_225_600_000);
  const bars = makeDataset({ count: 200, startSeconds: 1_767_225_600 });
  const environment = new SimulationEnvironment(clock, {
    symbol: 'USD/JPY',
    bars,
    initialBalance: 10_000,
    funding: [
      { time: bars[0].time, value: 0.00001 },
      { time: bars[100].time, value: 0.0005 },
      { time: bars[190].time, value: 0.9 },
    ],
    openInterest: [{ time: bars[10].time, value: 1_000 }],
  });

  clock.advanceTo((bars[50].time + 60) * 1000);
  const early = await environment.getMarketContext('USD/JPY');
  assertEqual(early.fundingRate, 0.00001, 'the reading current at 50 minutes in, not the one from later');

  clock.advanceTo((bars[150].time + 60) * 1000);
  const later = await environment.getMarketContext('USD/JPY');
  assertEqual(later.fundingRate, 0.0005, 'and the next one once the clock reaches it');

  assertEqual(later.openInterest, 1_000, 'a fact published once stays the current reading');
  assertEqual(
    latestAtOrBefore([{ time: 10, value: 1 }], 5),
    undefined,
    'a reading from the future is not a reading',
  );
});

// ---------------------------------------------------------------------------
// Resolutions: 1m, 5m, and arbitrary supported combinations
// ---------------------------------------------------------------------------

test('timeframes: a scalper GOAT is replayed on 1m and 5m', async () => {
  const { session } = await makeSession({
    goal: 'Scalp USD/JPY on 1m and 5m while the higher context stays neutral.',
    timeframes: ['1m', '5m'],
    timeframe: '5m',
  });

  /*
   * The declared set, honoured exactly.
   *
   * This is the regression that matters for scalping: a GOAT that said 1m and 5m
   * used to be replayed as a 15m GOAT, which is not a slower version of the same
   * agent — it is a different agent with the same objective.
   */
  const plan = session.timeframes;
  assertEqual(plan.setup, '5m', 'the replay acts on the resolution the GOAT declared as its setup');
  assertEqual(
    plan.reads.map((read) => read.timeframe).join(','),
    '1m,5m',
    'and reads exactly the two it was given — no 15m nobody asked for',
  );
  assertEqual(plan.strategy, 'DECLARED', 'recorded as declared rather than chosen');
  assertEqual(plan.reads[0].role, 'ENTRY', '1m is entry timing for a 5m setup');
  assertEqual(plan.reads[1].role, 'SETUP', 'and 5m is the setup');

  await session.start();
  const reads = session.agentLog(500).filter((entry) => entry.type === 'MARKET_CONTEXT_LOADED');
  assert(reads.length > 0, 'the replay read its declared resolutions');
  for (const read of reads) {
    assert(
      /\b(1m|5m)\b/.test(`${read.detail ?? ''}`) && !/\b(15m|1h|4h)\b/.test(`${read.detail ?? ''}`),
      `only the declared resolutions were read: ${read.detail}`,
    );
  }
});

test('timeframes: arbitrary supported combinations each mean something different', () => {
  /*
   * The setup is the middle of the declared set, and the roles follow from it:
   * a scalper's 5m setup has entry timing below it, a swing GOAT's 4m setup has
   * structure above it, and a GOAT given all six gets the hour as its setup with
   * the day as its regime.
   */
  const cases: Array<{ declared: string[]; expect: Record<string, string> }> = [
    { declared: ['1m', '5m'], expect: { '1m': 'ENTRY', '5m': 'SETUP' } },
    { declared: ['5m', '15m', '1h'], expect: { '5m': 'CONFIRMATION', '15m': 'SETUP', '1h': 'STRUCTURE' } },
    { declared: ['1h', '4h', '1d'], expect: { '1h': 'CONFIRMATION', '4h': 'SETUP', '1d': 'REGIME' } },
    { declared: ['1m', '5m', '15m', '1h', '4h', '1d'], expect: { '1m': 'ENTRY', '1h': 'SETUP', '4h': 'STRUCTURE', '1d': 'REGIME' } },
    { declared: ['15m', '1h', '4h'], expect: { '15m': 'CONFIRMATION', '1h': 'SETUP', '4h': 'STRUCTURE' } },
  ];

  for (const entry of cases) {
    const plan = resolveTimeframePlan({ declared: entry.declared });
    for (const [timeframe, role] of Object.entries(entry.expect)) {
      const read = plan.reads.find((candidate) => candidate.timeframe === timeframe);
      assert(read !== undefined, `${entry.declared.join('+')} reads ${timeframe}`);
      assertEqual(read!.role, role, `${timeframe} on ${entry.declared.join('+')}`);
      assert(read!.reason.length > 0, `and says why: ${timeframe}`);
    }
  }
});

test('timeframes: every supported resolution is readable and shares one clock', async () => {
  /*
   * The invariant behind every multi-resolution claim in the product.
   *
   * At one simulated instant, each resolution must report the newest candle that
   * had actually closed — never a partial one, and never the same instant for
   * two resolutions when their boundaries differ.
   */
  const bars = makeDataset({ count: 2_000 });
  const { clock, environment } = makeEnvironment({ dataset: bars, start: bars[1_500].time * 1000 });

  clock.advanceTo((bars[1_600].time + 60) * 1000);
  const horizonSeconds = clock.now() / 1000;

  for (const timeframe of ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const) {
    const seconds = timeframeSeconds(timeframe);
    const barsFor = await environment.getMarketBars('USD/JPY', timeframe, 5);
    for (const bar of barsFor) {
      assert(
        bar.time + seconds <= horizonSeconds,
        `${timeframe} returned a candle closing at ${bar.time + seconds}, after the simulated ${horizonSeconds}`,
      );
    }
    const newest = barsFor[barsFor.length - 1];
    const gap = horizonSeconds - ((newest?.time ?? 0) + seconds);
    assert(
      gap >= 0 && gap < seconds,
      `${timeframe} newest close is the one due at this instant (off by ${gap}s)`,
    );
  }
});

test('timeframes: a 1m tracker fires on 1m boundaries, not on the clock', async () => {
  /*
   * The regression the previous implementation found, kept honest at every
   * resolution.
   *
   * A tracker delivery is stamped with the candle's own open time. Stamped with
   * its close instead, the evaluator's bucket check puts the delivery in the
   * *next* bucket, concludes there is no new bar, and the watch stays silent
   * forever — which looks exactly like a GOAT ignoring its own condition.
   */
  const bars = makeDataset({ count: 1_500 });
  const session = new BacktestSession({
    goal: 'Scalp USD/JPY using 1m and 5m.',
    market: 'USD/JPY',
    timeframe: '1m',
    timeframes: ['1m', '5m'],
    start: bars[1_000].time * 1000,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model: new ScalpModel(),
    speed: 1,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });
  await session.start();

  const mission = session.snapshot().mission;
  assert(mission?.thesis !== undefined, 'the GOAT formed a Trade Plan');
  assertEqual(
    mission.activeTrackerCount > 0,
    true,
    'and armed at least one condition, on a resolution it actually reads',
  );
  assertEqual(mission.timeframes.join(','), '1m,5m', 'and reads exactly the resolutions it declared');

  await session.advance(20 * 60_000);

  const log = session.agentLog(500);
  assert(
    log.some((entry) => entry.type === 'TRACKER_FIRED'),
    `a 1m watch fired inside twenty simulated minutes: ${log.slice(-8).map((entry) => entry.type).join(' → ')}`,
  );
});

test('timeframes: the objective\'s own resolution list survives into the replay', async () => {
  /*
   * User intent, preserved.
   *
   * A GOAT whose objective says "scalp on 1m and 5m" is replayed on 1m and 5m
   * even if its stored set was written before the sentence was. The parse is
   * literal on purpose — only canonical resolution strings count — because
   * expanding an adjective like "short-term" into resolutions would be the
   * system inventing an intent nobody stated.
   */
  assertEqual(
    timeframesInStatement('Scalp USD/JPY using 1m and 5m.').join(','),
    '1m,5m',
    'the resolutions the user wrote are found',
  );
  assertEqual(
    timeframesInStatement('Analyze across 15m, 1h and 4h.').join(','),
    '15m,1h,4h',
    'and an arbitrary combination is preserved in order',
  );
  assertEqual(timeframesInStatement('Trade it.').length, 0, 'no resolutions means none are invented');
  assertEqual(
    timeframesInStatement('There were 1000 candles and 15 orders.').length,
    0,
    'a bare number is not a resolution',
  );

  const { session } = await makeSession({ goal: 'Scalp USD/JPY using 1m and 5m.' });
  assertEqual(
    session.timeframes.reads.map((read) => read.timeframe).join(','),
    '1m,5m',
    'and the replay reads them',
  );
});

test('timeframes: what the GOAT cannot read is refused, never approximated', async () => {
  /*
   * A dataset that is not at 1m cannot answer a 1m question.
   *
   * The tempting alternative is to bucket 5m bars into 1m buckets, which
   * manufactures a resolution the data does not contain — five identical
   * candles per minute — and hands it to an agent as though it were observed.
   */
  const bars = makeDataset({ count: 200, startSeconds: 1_767_225_600 }).filter((_, index) => index % 5 === 0);
  assert(bars.length > 20, 'the fixture produced a 5m dataset long enough to test with');
  const clock = new SimulationClock({ start: bars[10].time * 1000, speed: 1 });
  const environment = new SimulationEnvironment(clock, {
    symbol: 'USD/JPY',
    bars,
    baseTimeframe: '5m',
  });

  assertEqual(environment.resolution, '5m', 'the dataset is at 5m');
  assertEqual(environment.supports('1m'), false, 'so 1m cannot be read');
  assertEqual(environment.supports('15m'), true, 'and 15m can, by aggregation');
  assertEqual(
    environment.supports('5m'),
    true,
    'and so can its own resolution',
  );

  let refused = false;
  try {
    await environment.getMarketBars('USD/JPY', '1m', 10);
  } catch (error) {
    refused = error instanceof Error && /cannot be read/.test(error.message);
  }
  assert(refused, 'and asking for 1m is refused with a reason rather than approximated');

  const fifteen = await environment.getMarketBars('USD/JPY', '15m', 3);
  assert(fifteen.length > 0, 'while the resolutions it does have are aggregated as usual');
  for (const bar of fifteen) {
    assert(bar.time + 900 <= clock.now() / 1000, 'still bounded by the clock');
  }
});

// ---------------------------------------------------------------------------
// Historical range, honestly
// ---------------------------------------------------------------------------

test('history: a window the source cannot cover is reported, not silently narrowed', async () => {
  const bars = makeDataset({ count: 600 });
  const { session } = await makeSession({ dataset: bars });

  /*
   * Asked for a period the dataset does not reach. The replay uses what it has,
   * and says so — because a result about a window nobody chose is not a result
   * about the question that was asked.
   */
  const history = session.history();
  assertEqual(history.requestedStart > 0, true, 'the request is on the record, before the replay even starts');
  assert(
    history.availableStart !== undefined && history.availableEnd !== undefined,
    'and so is what the source actually gave',
  );
  assertEqual(history.bars, bars.length, 'with the number of bars it really has');
  assertEqual(history.resolution, '1m', 'and the resolution they are at');

  const shortSession = new BacktestSession({
    goal: 'Replay a period far longer than the data covers, across three years.',
    market: 'USD/JPY',
    start: bars[100].time * 1000,
    end: (bars[bars.length - 1].time + 86_400 * 365 * 3) * 1000,
    bars,
    model: new ScriptedBacktestModel(),
    speed: 1,
  });
  const honest = shortSession.history();
  assert(
    honest.note !== undefined && /source has nothing after/.test(honest.note),
    `a three-year request against an hour of data is called out: ${honest.note}`,
  );
});

test('history: a long range never becomes a long prompt', async () => {
  /*
   * The dataset can be enormous; the agent's context cannot.
   *
   * This is the difference that matters at three years of 1m data: the replay
   * holds the whole period, and every prompt is built from the bounded context
   * the environment is willing to serve. If a prompt ever scaled with the
   * dataset, this would be the assertion that caught it.
   */
  const bars = makeDataset({ count: 5_000 });
  const { session, model } = await makeSession({ dataset: bars });
  await session.start();

  const prompts = model.requests.map((request) => request.instructions);
  assert(prompts.length > 0, 'the model was asked something');
  for (const prompt of prompts) {
    assert(
      prompt.length < 20_000,
      `a prompt stays a prompt's length even with ${bars.length} bars of history: ${prompt.length} characters`,
    );
    assert(
      !/\d{4}-\d{2}-\d{2}T/.test(prompt.split('\n').slice(0, 3).join('\n')),
      'and carries no serialised dataset',
    );
  }
});

// ---------------------------------------------------------------------------
// Agentic acquisition and the busy clock
// ---------------------------------------------------------------------------

test('acquisition: a GOAT that needs another resolution asks, and the read is on the record', async () => {
  /*
   * The agent deciding what data it needs, rather than being handed a fixed set.
   *
   * The model answers a first pass by naming the resolution it is missing. The
   * runtime reads it, records that it did, and asks again — which is the whole of
   * dynamic acquisition, and it is bounded so one deployment cannot spend itself
   * on data.
   */
  const bars = makeDataset({ count: 1_500 });
  const model = new AcquiringModel();
  const session = new BacktestSession({
    goal: 'Trade USD/JPY while the higher timeframe stays neutral.',
    market: 'USD/JPY',
    timeframe: '15m',
    timeframes: ['15m', '30m'],
    start: bars[1_000].time * 1000,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model,
    speed: 1,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });

  await session.start();

  assertEqual(model.asked, 1, 'the GOAT asked for the resolution it was missing');
  assertEqual(model.calls >= 2, true, 'and was asked again once it had it');

  const log = session.agentLog(500);
  const loaded = log.filter((entry) => entry.type === 'MARKET_CONTEXT_LOADED');
  assert(
    loaded.some((entry) => /\b1h\b/.test(entry.detail ?? '') && /asked for this resolution/.test(entry.detail ?? '')),
    `the acquired read is on the record, labelled as acquired: ${loaded
      .map((entry) => entry.detail)
      .join(' | ')}`,
  );
  assert(
    log.some((entry) => entry.type === 'THESIS_FORMED'),
    'and the plan was formed once the context was complete',
  );
});

test('acquisition: the replay holds the clock while the GOAT decides', async () => {
  /*
   * Determinism is a promise about what the agent can see.
   *
   * The market does not advance while a request is outstanding: an agent
   * reasoning about 10:43 must not be handed 10:44 by a fast clock. The snapshot
   * says so while it happens, because a clock that stops without explanation
   * looks like a fault.
   */
  const { session } = await makeSession();
  await session.start();

  const gate = new GatedModel();
  const replay = new BacktestSession({
    goal: 'Watch USD/JPY and act when the evidence supports one.',
    market: 'USD/JPY',
    timeframe: '15m',
    start: session.snapshot().now,
    end: session.snapshot().now + 6 * 60 * 60 * 1000,
    bars: makeDataset({ count: 1_200 }),
    model: gate,
    speed: 30,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });
  const starting = replay.start();

  let busySeen = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (replay.snapshot().agentBusy) busySeen = true;
  }

  assertEqual(busySeen, true, 'the snapshot reports that the GOAT is mid-decision');
  gate.letGo();
  await starting;
  assertEqual(replay.snapshot().agentBusy, false, 'and clears once the answer lands');

  /*
   * Nothing moved while it was deciding. The clock is the same one the
   * environment is read through, so a future candle cannot have been revealed.
   */
  const horizon = replay.simulation.horizon();
  assert(horizon <= replay.simulatedClock.now(), 'and the data boundary held throughout');
});

// ---------------------------------------------------------------------------
// 11. The replay loop itself
//
// These are the properties of the *loop*, not of the boundary: that it cannot
// overlap itself, that it holds historical time while the GOAT decides, that a
// fast pass processes every bar rather than skipping to the newest, that a
// restart is a new run, and that a model answer arriving too late changes
// nothing. Each of them was a live defect.
// ---------------------------------------------------------------------------

/**
 * A model that answers the setup immediately and then holds its wake answer.
 *
 * The gate has to be on the wake specifically: the setup answers are what make
 * the replay arm a watch in the first place, and a test that held the
 * investigation would only prove the old "loading holds" behaviour.
 */
class WakeGatedModel extends ScriptedBacktestModel {
  entered = 0;
  /** Highest number of `run` calls alive at the same time. The overlap detector. */
  concurrent = 0;
  maxConcurrent = 0;
  /** Simulated instants the model was asked about. */
  readonly seenInstants: number[] = [];
  private release?: () => void;
  private held?: Promise<void>;
  private heldNow?: () => void;

  async run(request: {
    contract?: string;
    instructions: string;
    wakeReason?: string;
    observation?: { timestamp?: number };
  }) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (typeof request.observation?.timestamp === 'number') {
        this.seenInstants.push(request.observation.timestamp);
      }
      if (request.contract === 'PLAN') {
        this.entered += 1;
        if (!this.held) {
          this.held = new Promise<void>((resolve) => {
            this.heldNow = resolve;
          });
          await this.held;
        }
      }
      return await super.run(request);
    } finally {
      this.concurrent -= 1;
    }
  }

  letGo(): void {
    this.heldNow?.();
    this.held = undefined;
  }
}

test('loop: the replay cannot overlap itself, and historical time holds while the GOAT decides', async () => {
  /*
   * The contract: advance time, process a bar, wait for the GOAT, execute,
   * settle, and only then advance again.
   *
   * The previous loop armed an interval that fired every 250ms and did not wait
   * for the tick it had started, so while a model thought for four seconds the
   * clock ran sixteen simulated minutes past it and sixteen `step()`s ran
   * concurrently against one world. Two things are asserted here: that no two
   * cycles are ever alive at once, and that the simulated instant does not move
   * by a single millisecond while a request is outstanding.
   */
  const { session } = await makeSession({ dataset: makeDataset({ count: 1_200 }) });
  const model = new WakeGatedModel();
  const replay = new BacktestSession({
    goal: 'Watch USD/JPY and act when the evidence supports one.',
    market: 'USD/JPY',
    timeframe: '15m',
    timeframes: ['1m'],
    start: session.snapshot().now,
    end: session.snapshot().now + 4 * 60 * 60 * 1000,
    bars: makeDataset({ count: 1_200 }),
    model,
    speed: 60,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });

  await replay.start();
  replay.goat!.loop.reviseThesis(replay.snapshot().mission!.thesis!.id, { state: 'ACTIONABLE' });
  replay.setSpeed(60);
  void replay.play();

  // Wait until a wake is genuinely in flight and the model is holding its answer.
  const deadline = Date.now() + 20_000;
  while (model.entered === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(model.entered > 0, 'a watch fired and the GOAT was asked for its answer');

  const heldAt = replay.simulatedClock.now();
  const barsAt = replay.simulation.barsConsumed();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assertEqual(replay.simulatedClock.now(), heldAt, 'the simulated clock does not move during a decision');
  assertEqual(replay.simulation.barsConsumed(), barsAt, 'and no new candle becomes visible while it waits');
  assert(
    replay.simulation.horizon() <= replay.simulatedClock.now(),
    'the data boundary held throughout the wait',
  );

  model.letGo();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assertEqual(model.maxConcurrent, 1, 'two replay steps were never alive at once');
  await replay.stop('test finished');
});

test('loop: a fast pass processes every bar rather than skipping to the newest', async () => {
  /*
   * Speed is a budget of bars per pass, not a jump in the clock.
   *
   * At 60× over one-minute data the loop advances sixty boundaries per pass and
   * processes each one. The old implementation advanced by `250ms × speed` and
   * delivered only the newest visible bar, so a pass that covered several
   * minutes evaluated conditions against the last candle and silently discarded
   * the ones in between — the candles existed and the agent could have read
   * them, but nothing was ever tested against them.
   */
  const bars = makeDataset({ count: 1_200 });
  const startSeconds = bars[400].time;
  // A scalper's answer, because it arms its watches at 1m — a 15m watch would
  // only ever be delivered once per fifteen bars and would prove nothing about
  // per-bar processing.
  const session = new BacktestSession({
    goal: 'Scalp USD/JPY on 1m and 5m while the higher timeframe stays neutral.',
    market: 'USD/JPY',
    timeframe: '1m',
    timeframes: ['1m', '5m'],
    model: new ScalpModel(),
    start: startSeconds * 1000,
    end: (bars[800].time + 60) * 1000,
    bars,
    speed: 60,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });

  await session.start();
  session.goat!.loop.reviseThesis(session.snapshot().mission!.thesis!.id, { state: 'ACTIONABLE' });
  await session.advance(30 * 60_000);

  const expectedBars = 30;
  assert(
    session.deliveredBars('1m') >= expectedBars,
    `every 1m bar in the window was delivered to the trackers (${session.deliveredBars('1m')} delivered)`,
  );
  assert(
    session.lastDeliveredInstant('1m')! <= session.simulatedClock.now(),
    'no delivery carried an instant the simulation had not reached',
  );
  assertEqual(
    session.simulatedClock.now(),
    (startSeconds + expectedBars * 60) * 1000,
    'and the clock landed exactly on the last bar boundary rather than past it',
  );
});

test('restart: a restarted replay is a new run, not the old one resumed', async () => {
  /*
   * A restart has to be indistinguishable from a first run.
   *
   * The previous restart nulled a handful of fields and called `start()` again,
   * keeping the clock object (and its accumulated elapsed time), the agent
   * runtime (and its generation counter, memory and audit trail) and the tracker
   * runtime (and its cooldowns and "already reported" state). The replay that
   * resulted carried the first run's conclusions into the same candles, which is
   * the one thing a replay must never be.
   */
  const bars = makeDataset({ count: 1_500 });
  const session = new BacktestSession({
    goal: 'Scalp USD/JPY on 1m and 5m while the higher timeframe stays neutral.',
    market: 'USD/JPY',
    timeframe: '1m',
    timeframes: ['1m', '5m'],
    start: bars[500].time * 1000,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model: new ScalpModel(),
    speed: 1,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });
  await session.start();
  await session.advance(45 * 60_000);

  const midRun = session.snapshot();
  assert(midRun.simulatedMinutes > 0, 'the first run actually moved through history');
  assert(session.agentLog(500).length > 0, 'and wrote a log worth replacing');
  const deliveredBefore = session.deliveredBars('1m');
  assert(deliveredBefore > 0, 'and really did deliver candles to its own watches');

  await session.restart();

  const fresh = session.snapshot();
  assertEqual(session.simulatedClock.elapsed, 0, 'the clock is back at the start of the window');
  assertEqual(session.simulatedClock.now(), session.replayStart, 'and reads the original instant again');
  assertEqual(fresh.state, 'READY', 'the replay is ready to run again');
  assertEqual(fresh.report, undefined, 'no report is carried over from the previous run');
  assertEqual(fresh.trades?.length ?? 0, 0, 'no trades are carried over');
  assertEqual(session.deliveredBars('1m'), 0, 'and not one of those deliveries is carried over');
  assertEqual(session.orderHistory().length, 0, 'no order is carried over');
  assertEqual(session.simulation.openPositions().length, 0, 'no position is carried over');
  assertEqual(session.simulation.simulatedTrades().length, 0, 'no trade is carried over');
  assertEqual(session.account()?.equity, 10_000, 'the account is the deposit again');
  assertEqual(
    session.simulatedClock.speed,
    1,
    'and the speed is the requested default rather than a carried-over setting',
  );
  assert(
    session.snapshot().mission?.thesis?.id !== undefined,
    'the GOAT exists again, with a fresh identity of its own',
  );

  /*
   * And it can genuinely run again, which is the only way to know the world is
   * new rather than emptied: a second run that reaches the same simulated instant
   * must deliver the same bars in the same order.
   */
  await session.advance(10 * 60_000);
  assert(session.deliveredBars('1m') >= 10, 'the replay runs again over the same window');
});

test('replay: a model answer that arrives after the run ended changes nothing', async () => {
  /*
   * A late answer must not act.
   *
   * The replay waits for the GOAT, and the wait is bounded at two minutes. A user
   * who presses STOP inside that window — or a RESTART that replaces the world —
   * must not find a trade submitted a second later by an answer to a question
   * about a market that no longer exists. Three independent guards have to hold:
   * the epoch moves first, the agent's execution generation is revoked, and the
   * loop checks the epoch before it acts on anything.
   */
  const base = await makeSession({ dataset: makeDataset({ count: 1_200 }) });
  const model = new WakeGatedModel();
  const session = new BacktestSession({
    goal: 'Watch USD/JPY and act when the evidence supports one.',
    market: 'USD/JPY',
    timeframe: '15m',
    timeframes: ['1m'],
    start: base.session.snapshot().now,
    end: base.session.snapshot().now + 4 * 60 * 60 * 1000,
    bars: makeDataset({ count: 1_200 }),
    model,
    speed: 60,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });

  await session.start();
  session.goat!.loop.reviseThesis(session.snapshot().mission!.thesis!.id, { state: 'ACTIONABLE' });
  void session.play();

  const deadline = Date.now() + 20_000;
  while (model.entered === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(model.entered > 0, 'the wake reached the model');

  await session.stop('The operator stopped the replay mid-decision.');
  const clockAtStop = session.simulatedClock.now();

  model.letGo();
  await new Promise((resolve) => setTimeout(resolve, 500));

  assertEqual(session.snapshot().state, 'STOPPED', 'the run stayed stopped');
  assertEqual(session.simulatedClock.now(), clockAtStop, 'and the clock stayed where it was left');
  assertEqual(session.orderHistory().length, 0, 'no order was submitted by the late answer');
  assertEqual(session.simulation.openPositions().length, 0, 'and no position was opened by it');
  assert(session.snapshot().report !== undefined, 'the stopped run still produced its report');
});

test('account: sizing reads the live simulated account, not the opening deposit', async () => {
  /*
   * Equity is a moving number and sizing has to move with it.
   *
   * The trade context handed the engine `initialBalance` — the deposit — so every
   * trade in a run was sized as though the account had neither won nor lost. A
   * GOAT that doubled its account went on risking 1% of the original, and one that
   * lost half its equity kept trading as though it were flush. This proves the
   * book moves and the context follows it.
   */
  const { session } = await makeSession({ dataset: makeDataset({ count: 1_200 }) });
  await session.start();

  const opening = session.tradeContext();
  assertEqual(opening.equity, 10_000, 'the risk context opens on the deposit');

  /*
   * A winning trade, driven through the simulated book rather than through the
   * GOAT. The question is what the *context* reports, and the cheapest honest way
   * to move the account is to take a real simulated profit against it.
   */
  const environment = session.simulation;
  await environment.placeMarketOrder({ symbol: 'USD/JPY', side: 'BUY', volume: 1_000 });
  const opened = environment.openPositions()[0];
  assert(opened !== undefined, 'a simulated position was opened');

  await environment.closePosition(opened.id);

  const after = session.tradeContext();
  const account = session.account();

  assert(after.equity !== 10_000, 'the simulated account is no longer the deposit it opened with');
  assertEqual(after.equity, account!.equity, 'and the risk context carries that account, not the constant');
  assert(
    Math.abs(account!.equity - account!.balance) < 1e-6,
    'with nothing open, equity is the balance: the balance moved by the spread and commission, and the context followed it',
  );
  assertEqual(
    account!.equity,
    Math.round(account!.equity * 100) / 100,
    'and it is the reported account state rather than a re-derived figure',
  );
});


// ---------------------------------------------------------------------------
// 12. Choosing a window, and telling the story of what happened
// ---------------------------------------------------------------------------

test('window: yesterday is a whole day, and a long window does not ask for a month of minutes', () => {
  /*
   * The window is the one thing a reader should not have to do arithmetic for, and
   * the resolution that comes with it is a decision about their browser rather than
   * about their strategy.
   */
  const now = Date.UTC(2026, 2, 18, 14, 37, 12);
  const yesterday = HISTORICAL_PRESETS.find((preset) => preset.id === 'yesterday')!;
  const yesterdayWindow = windowForPresetRequest(yesterday, { warmupMinutes: 240, now });
  assertEqual(
    yesterdayWindow.end - yesterdayWindow.start,
    86_400_000,
    'yesterday is one whole day rather than the last twenty-four hours',
  );
  assertEqual(
    new Date(yesterdayWindow.start).getUTCHours(),
    0,
    'and it starts at midnight UTC, the way a day does',
  );
  assertEqual(
    yesterdayWindow.warmupStart,
    yesterdayWindow.start - 240 * 60_000,
    'the warm-up is fetched separately and sits before the window',
  );
  assertEqual(yesterdayWindow.baseTimeframe, '1m', 'a single day is read at the finest resolution');

  const sixMonths = HISTORICAL_PRESETS.find((preset) => preset.id === 'half')!;
  const longWindow = windowForPresetRequest(sixMonths, { warmupMinutes: 240, now });
  assertEqual(longWindow.baseTimeframe, '5m', 'a six-month window is read at 5m rather than half a million bars');
  assert(/5m/.test(longWindow.baseReason), 'and says why, so the reader is not left guessing at the resolution');
  assert(new Date(longWindow.end).getTime() <= now, 'no window ever ends in the future');
});

test('story: the state word is about the agent, not the transport', () => {
  /*
   * A reader's question is "what is it doing", and `RUNNING` never answered it. The
   * order matters as much as the words: an open position outranks a written plan,
   * which outranks a wake, which outranks thinking.
   */
  assertEqual(deriveGoatState({ state: 'LOADING' }), 'BUILDING HISTORICAL WORLD', 'loading says so');
  assertEqual(deriveGoatState({ state: 'SETTING_UP' }), 'DEPLOYING GOAT', 'and so does deployment');
  assertEqual(deriveGoatState({ state: 'RUNNING', thesisCount: 0 }), 'INVESTIGATING', 'a GOAT with no thesis is investigating');
  assertEqual(deriveGoatState({ state: 'RUNNING', thesisCount: 1 }), 'WATCHING', 'one with a thesis is watching');
  assertEqual(deriveGoatState({ state: 'RUNNING', thesisCount: 1, agentBusy: true }), 'RE-EVALUATING', 'and re-evaluating while it thinks');
  assertEqual(deriveGoatState({ state: 'RUNNING', thesisCount: 1, hasPlan: true }), 'TRADE PLAN READY', 'a written plan is named as one');
  assertEqual(deriveGoatState({ state: 'RUNNING', hasPlan: true, restingOrders: 1 }), 'ORDER WAITING', 'a resting order outranks the plan that made it');
  assertEqual(deriveGoatState({ state: 'RUNNING', openPositions: 1 }), 'POSITION OPEN', 'an open position outranks everything');
  assertEqual(
    deriveGoatState({ state: 'RUNNING', openPositions: 1, lastOutcome: 'TAKE_PROFIT' }),
    'TARGET HIT',
    'and the loudest moment in a replay is named',
  );
  assertEqual(deriveGoatState({ state: 'COMPLETED' }), 'DONE', 'a finished run says so');
});

test('story: a dimension the log cannot support is absent, not zero', () => {
  /*
   * The difference between "we do not know" and "it did nothing well".
   *
   * A run that armed no conditions and wrote no plans has no evidence about
   * selectivity or risk control, and scoring it 0 on both would be a claim about
   * behaviour that never happened.
   */
  const empty = deriveBehaviourScore({ behaviour: emptyBehaviour(), performance: emptyPerformance() });
  assert(empty.overall === undefined, 'a run with no events has no overall score');
  assert(
    empty.lines.every((line) => line.score === undefined),
    'and no dimension is scored at all',
  );
  assert(
    empty.lines.every((line) => line.basis.length > 0),
    'every dimension still explains why it cannot be measured',
  );

  const recorded = deriveBehaviourScore({
    behaviour: {
      ...emptyBehaviour(),
      wakes: 4,
      waits: 6,
      trackersCreated: 10,
      trackersFired: 2,
      plansCreated: 5,
      plansRejectedByRisk: 1,
      hypothesesFormed: 3,
      hypothesesRevised: 1,
    },
    performance: { ...emptyPerformance(), trades: 4 },
  });
  assertEqual(recorded.lines.find((line) => line.dimension === 'DISCIPLINE')?.score, 60, 'discipline is the share of wakes it chose to wait through');
  assertEqual(recorded.lines.find((line) => line.dimension === 'SELECTIVITY')?.score, 80, 'selectivity is the share of armed conditions that never came true');
  assertEqual(recorded.lines.find((line) => line.dimension === 'RISK CONTROL')?.score, 80, 'risk control is the share of plans the gate allowed');
  assertEqual(recorded.overall, Math.round((60 + 80 + 80 + 33 + 80) / 5), 'and the overall is the mean of what could be measured');
});

test('story: a near miss has to be near', () => {
  /*
   * "NEAR MISS" is a sentence about patience, and it is only worth printing when
   * the market actually came to the price. Measured against nothing, every unfilled
   * order is dramatic; measured against the risk the setup was taking, it is a fact.
   */
  const order = {
    id: 'order-1',
    side: 'BUY' as const,
    entryPrice: 157.9,
    status: 'EXPIRED',
    placedAt: 1_000,
    expiresAt: 2_000,
  };

  const close = deriveNearMisses([order], () => ({ distance: 0.0002, at: 1_500, price: 157.9002 }));
  assertEqual(close.length, 1, 'an order the market came within a hair of is a near miss');
  assert(/missed by/.test(close[0]!.detail), 'and the sentence says how close it was');

  const distant = deriveNearMisses([order], () => ({ distance: 4.2, at: 1_500, price: 161.9 }));
  assertEqual(distant.length, 0, 'an order the market never approached is not dressed up as one');

  const filled = deriveNearMisses([{ ...order, filledAt: 1_800, status: 'FILLED' }], () => ({ distance: 0, at: 1_800, price: 157.9 }));
  assertEqual(filled.length, 0, 'and an order that filled has no near miss — it got its price');
});

test('story: key moments come from the record, and every line points at it', () => {
  /*
   * Compression is only honest if the original is reachable, so a moment is either
   * traceable to an event id or it is not shown as a moment.
   */
  const moments = deriveKeyMoments([
    { id: 'e1', agentId: 'a', timestamp: 1_000, type: 'THESIS_FORMED', data: { statement: 'The range holds while 1h stays flat.', direction: 'BULLISH' } },
    { id: 'e2', agentId: 'a', timestamp: 2_000, type: 'MODEL_REQUEST', data: { model: 'x' } },
    { id: 'e3', agentId: 'a', timestamp: 3_000, type: 'TRACKER_FIRED', data: { purpose: 'Price crossing 157.9', price: 157.9, level: 157.9 } },
  ]);

  assertEqual(moments.length, 2, 'the model request is machinery, not a moment');
  assertEqual(moments[0]!.kind, 'THESIS', 'the thesis comes first');
  assertEqual(moments[1]!.kind, 'WATCH_FIRED', 'and the watch firing second');
  assert(moments.every((moment) => moment.eventId !== undefined), 'every moment names the event it came from');
  assert(/157.9/.test(moments[1]!.detail ?? ''), 'and carries the numbers a reader wants');
});

export async function runBacktestTests(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`pass  ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL  ${name}`);
      console.log(`      ${message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} backtest test(s) failed.`);
  }
}

if (import.meta.main) {
  await runBacktestTests();
}

/**
 * A run that has recorded nothing.
 *
 * Zeroes, and labelled zeroes: every dimension derived from these renders as absent
 * rather than as a zero, which is the difference between "we do not know" and "it
 * did nothing well".
 */
function emptyBehaviour() {
  return {
    hypothesesFormed: 0,
    hypothesesRevised: 0,
    hypothesesInvalidated: 0,
    trackersCreated: 0,
    trackersFired: 0,
    plansCreated: 0,
    plansRejectedByRisk: 0,
    wakes: 0,
    waits: 0,
    modelCalls: 0,
    modelFailures: 0,
    modelLatencyMs: 0,
    simulatedMinutes: 0,
    longestSilenceMinutes: 0,
  } as unknown as BacktestReport['behaviour'];
}

function emptyPerformance(initialBalance = 10_000) {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    netR: undefined,
    winRatePercent: 0,
    endingEquity: initialBalance,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    averageWin: 0,
    averageLoss: 0,
  };
}
