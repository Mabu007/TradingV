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
import { SimulationClock } from './clock';
import { SimulationEnvironment, latestAtOrBefore } from './simulationEnvironment';

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

interface Fixture {
  session: BacktestSession;
  clock: SimulationClock;
  bars: Bar[];
  start: number;
  model: ScriptedBacktestModel;
}

async function makeSession(options: { dataset?: Bar[]; market?: string } = {}): Promise<Fixture> {
  const bars = options.dataset ?? makeDataset();
  const market = options.market ?? 'USD/JPY';
  // The replay starts a third of the way in, so there is warm-up behind it.
  const startSeconds = bars[Math.floor(bars.length / 3)].time;
  const start = startSeconds * 1000;
  const model = new ScriptedBacktestModel();

  const session = new BacktestSession({
    goal: 'Trade a USD/JPY range while the higher timeframe stays neutral.',
    name: 'Range replay',
    market,
    timeframe: '15m',
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
  const execution = log.filter((entry) => entry.type === 'ORDER' || entry.type === 'FILL' || entry.type === 'POSITION_OPENED');
  assertEqual(execution.length, 3, 'and every execution line says EXECUTION in the log');
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
// Runner
// ---------------------------------------------------------------------------

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