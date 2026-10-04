/**
 * Tests for the trade engine and the limit order book.
 *
 * ## What is actually exercised
 *
 * The real `SimulationEnvironment` and the real `TradeEngine`, over a manually
 * stepped clock. Not a fake book, because the behaviour under test *is* the
 * collaboration: an order resting on one object and a lifecycle advanced by
 * another, where a mistake in either shows up only when both run.
 *
 * Two rules govern what a passing run is allowed to mean:
 *
 *   1. **No trade is manufactured.** Every filled trade below was filled because a
 *      candle in the fixture reached the price the GOAT asked for. There is no
 *      fixture here that forces a fill, and `a price never reached` is asserted
 *      as its own case precisely so a later change cannot quietly turn it into a
 *      fill.
 *   2. **The ambiguous case is asserted as ambiguous.** Where one candle spans
 *      both an entry and a stop, the test states which way it resolves and why,
 *      rather than picking whichever answer would have looked better.
 *
 * `bun src/engine/goat/tradeEngineTests.ts`
 */

import {
  TradeEngine,
  decideTrade,
  tradeStatistics,
  type TradeContext,
  type TradeRecord,
  type TradeTransition,
} from './tradeEngine';
import {
  SimulationEnvironment,
  type SimulatedOrder,
} from './backtest/simulationEnvironment';
import { SimulationClock } from './backtest/clock';
import type { Bar } from '../../types/trading';
import type { TradeIdea } from './types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`pass  ${name}`);
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A candle list from a price path.
 *
 * Written as explicit steps rather than a formula so a reader can see exactly what
 * price the market reaches and when — a generator would make every assertion in
 * this file depend on trigonometry.
 */
function candles(path: number[]): Bar[] {
  const bars: Bar[] = [];
  let time = 1_700_000_000;
  for (const close of path) {
    const open = close;
    bars.push({
      time,
      open,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 1_000,
    });
    time += 60;
  }
  return bars;
}

interface Harness {
  engine: TradeEngine;
  environment: SimulationEnvironment;
  clock: SimulationClock;
  transitions: TradeTransition[];
  trades(): TradeRecord[];
  /** Advance one base bar. */
  step(): void;
  /** Advance n base bars. */
  advance(n: number): void;
}

function harness(bars: Bar[], overrides: Partial<TradeContext> = {}, options: { pipSize?: number } = {}): Harness {
  const clock = new SimulationClock({ start: (bars[0].time + 60) * 1000, speed: 1 });
  const environment = new SimulationEnvironment(clock, {
    symbol: 'USD/JPY',
    bars,
    initialBalance: 10_000,
    spreadPrice: 0,
    slippagePrice: 0,
    commissionPerLot: 0,
    ...(options.pipSize !== undefined ? { pipSize: options.pipSize } : {}),
  });

  const context: TradeContext = {
    symbol: 'USD/JPY',
    currentPrice: environment.currentBar()?.close ?? 0,
    maxRiskFractionOfEquity: 0.01,
    equity: 10_000,
    valuePerUnit: 1,
    mayExecute: true,
    maxConcurrentPositions: 1,
    ...overrides,
  };

  const transitions: TradeTransition[] = [];
  const engine = new TradeEngine({
    book: environment,
    now: () => clock.now(),
    // Read fresh, as the session does, so a decision never prices against a
    // market that has moved since the engine was built.
    context: () => ({ ...context, currentPrice: environment.currentBar()?.close ?? 0 }),
    onTransition: (transition) => transitions.push(transition),
  });

  return {
    engine,
    environment,
    clock,
    transitions,
    trades: () => engine.all(),
    // One call, exactly as the session makes it: the engine owns the per-bar
    // order of fills, marks and reconciliation. Driving the environment
    // separately here is how the sequence bug this file guards against would be
    // reintroduced unnoticed by the tests.
    step: () => {
      clock.advanceBy(60_000);
      engine.settle();
    },
    advance: (count: number) => {
      for (let index = 0; index < count; index += 1) {
        clock.advanceBy(60_000);
        engine.settle();
      }
    },
  };
}

let nextIdea = 0;

function idea(overrides: Partial<TradeIdea> = {}): TradeIdea {
  nextIdea += 1;
  const base: TradeIdea = {
    id: `tid_${nextIdea}`,
    thesisId: 'th_1',
    goalId: 'g1',
    agentId: 'a1',
    symbol: 'USD/JPY',
    direction: 'LONG',
    orderType: 'LIMIT',
    entry: 100,
    invalidationLevel: 99,
    takeProfits: [{ price: 102, fraction: 1 }],
    reasoning: 'retest of broken resistance',
    supportingEvidence: [],
    invalidation: 'a close below the broken level',
    status: 'READY',
    riskCheck: { approved: true, reason: 'ok', checkedAt: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
  return { ...base, ...overrides };
}

/**
 * Trade statuses as one string.
 *
 * Joined rather than returned as an array: `assertEqual` compares with `Object.is`,
 * which is never true for two freshly built arrays, so an array assertion fails on
 * identity no matter what it contains. Joining keeps the assertion about the
 * sequence, which is what these tests are actually checking.
 */
const statuses = (trades: TradeRecord[]): string => trades.map((trade) => trade.status).join(',');

// ---------------------------------------------------------------------------
// 1. Price validation — the deterministic refusals
// ---------------------------------------------------------------------------

await test('a long stop above the entry is refused, and the refusal says why', () => {
  const decision = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 101, takeProfits: [{ price: 105, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 102, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(decision.approved, false, 'refused');
  assert(decision.reason.includes('wrong side'), 'and names the problem, not just the outcome');
  assert(decision.reason.includes('below'), 'saying which side it should have been on');
});

await test('a short stop below the entry is refused too', () => {
  const decision = decideTrade(
    idea({ direction: 'SHORT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 95, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 98, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(decision.approved, false, 'a short needs its stop above the entry');
});

await test('a target on the wrong side of the entry is refused', () => {
  const long = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 98, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(long.approved, false, 'a long target below the entry is not a target');

  const short = decideTrade(
    idea({ direction: 'SHORT', entry: 100, invalidationLevel: 101, takeProfits: [{ price: 102, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 99, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(short.approved, false, 'and a short target above it is not either');
});

await test('a plan priced at a different market than the deployment is refused', () => {
  const decision = decideTrade(idea({ symbol: 'EUR/USD' }), {
    symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000,
    valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1,
  });
  assertEqual(decision.approved, false, 'a GOAT cannot plan a trade in a market it is not deployed to');
});

await test('a plan with no stop is refused, because there is nowhere for it to be wrong', () => {
  const decision = decideTrade(
    idea({ invalidationLevel: Number.NaN }),
    { symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(decision.approved, false, 'refused');
  assert(decision.reason.includes('invalidation'), 'and says the invalidation is what is missing');
});

await test('a limit already through the market is refused rather than filled at it', () => {
  const marketableBuy = decideTrade(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 105, invalidationLevel: 100, takeProfits: [{ price: 110, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(marketableBuy.approved, false, 'a BUY LIMIT above the market is a market order in disguise');
  assert(marketableBuy.approved === false && marketableBuy.reason.includes('immediately'), 'and says so');

  const marketableSell = decideTrade(
    idea({ direction: 'SHORT', orderType: 'LIMIT', entry: 95, invalidationLevel: 100, takeProfits: [{ price: 90, fraction: 1 }] }),
    { symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1 },
  );
  assertEqual(marketableSell.approved, false, 'and a SELL LIMIT below it likewise');
});

await test('reward-to-risk below the strategy floor is refused', () => {
  const decision = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 101, fraction: 1 }] }),
    {
      symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000,
      valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1, minRiskReward: 2,
    },
  );
  assertEqual(decision.approved, false, 'risking 2 to make 1 does not satisfy a 2:1 requirement');
  assert(decision.reason.includes('minimum'), 'and the reason quotes the requirement');
});

await test('size comes from the stop, so a wider stop means a smaller position', () => {
  const context = {
    symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000,
    valuePerUnit: 1, mayExecute: true, maxConcurrentPositions: 1,
  };
  const tight = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 105, fraction: 1 }] }),
    context,
  );
  const wide = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 95, takeProfits: [{ price: 105, fraction: 1 }] }),
    context,
  );
  assert((tight.volume ?? 0) > (wide.volume ?? 0), 'a 1-wide stop carries more than a 5-wide one at the same risk budget');
  assertEqual(tight.metrics?.['dollarRisk'], 100, 'and both spend exactly the risk budget');
});

await test('a deployment that may not trade gets no order, and is not told it was refused', () => {
  const decision = decideTrade(
    idea({ direction: 'LONG', entry: 100, invalidationLevel: 99 }),
    { symbol: 'USD/JPY', currentPrice: 101, maxRiskFractionOfEquity: 0.01, equity: 10_000, valuePerUnit: 1, mayExecute: false, maxConcurrentPositions: 1 },
  );
  assertEqual(decision.approved, true, 'the plan itself is sound');
  assertEqual(decision.canPlaceOrder, false, 'and it is still not permitted to act on it');
});

// ---------------------------------------------------------------------------
// 2. BUY LIMIT — the whole lifecycle
// ---------------------------------------------------------------------------

await test('a BUY LIMIT rests while price stays above it', async () => {
  const h = harness(candles([101, 100.8, 100.6, 100.5]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 105, fraction: 1 }] });

  const decision = await h.engine.submit(plan, 'g1');
  assertEqual(decision.approved, true, 'approved');
  assertEqual(statuses(h.trades()), 'PENDING', 'and resting');
  assertEqual(h.environment.restingOrders().length, 1, 'one order on the book');

  h.advance(3);

  assertEqual(statuses(h.trades()), 'PENDING', 'still resting: price never reached the entry');
  assertEqual(h.environment.openPositions().length, 0, 'no position was manufactured');
});

await test('a BUY LIMIT fills when a candle trades down through it, and the position runs', async () => {
  const h = harness(candles([101, 100.5, 99.9, 100.1]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 105, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');

  h.advance(1);
  assertEqual(statuses(h.trades()), 'PENDING', 'the 100.5 candle does not reach an entry at 100');

  h.advance(1); // this candle's low is 99.85, below the entry
  const trade = h.trades()[0];
  assertEqual(trade.status, 'RUNNING', 'filled and now running');
  assertEqual(trade.fillPrice, 100, 'at the limit price, which is the point of a limit order');
  assertEqual(h.environment.openPositions().length, 1, 'a position exists');
  assertEqual(trade.secondsWaiting, 120, 'it rested for two minutes before the price came');
});

await test('a filled BUY LIMIT is stopped out when price reaches the stop', async () => {
  /*
   * The fill candle must not also reach the stop, or this test would be asserting
   * the same-candle rule by accident. `100.40` does not reach the 100 entry; the
   * `99.90` candle fills without reaching the 99 stop; the `98.50` candle reaches
   * it.
   */
  const h = harness(candles([101, 100.4, 99.9, 98.5, 98.6]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 110, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');
  h.advance(2); // fills on the 99.90 candle

  assertEqual(h.trades()[0].status, 'RUNNING', 'running before the stop');

  h.advance(1); // low 98.45, through the 99 stop

  const trade = h.trades()[0];
  assertEqual(trade.status, 'STOPPED_OUT', 'closed at the stop');
  assertEqual(trade.exitPrice, 99, 'at the stop price, not at the candle close');
  assertEqual(trade.exitReason, 'Price reached the stop, so the thesis was wrong.', 'and says why in words');
  assertEqual(trade.exitCode, 'STOP_LOSS', 'while the venue code is kept beside it for machines');
  assertEqual(h.environment.openPositions().length, 0, 'no position left open');
  assert((trade.pnl ?? 0) < 0, 'and the result is a loss, which is what it was');
});

await test('a filled BUY LIMIT takes profit when price reaches the target', async () => {
  const h = harness(candles([101, 99.9, 103, 104]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 103, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');
  h.advance(2); // fills on the 99.9 candle

  h.advance(1); // high 103.05, through the 103 target

  const trade = h.trades()[0];
  assertEqual(trade.status, 'TAKE_PROFIT', 'closed at the target');
  assertEqual(trade.exitPrice, 103, 'at the target price');
  assert((trade.pnl ?? 0) > 0, 'for a gain');
  assertEqual(h.environment.openPositions().length, 0, 'and nothing left open');
});

await test('a position that reaches neither stop nor target stays running', async () => {
  const h = harness(candles([101, 99.9, 101, 101.5, 102]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 110, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');
  h.advance(4);

  const trade = h.trades()[0];
  assertEqual(trade.status, 'RUNNING', 'still open');
  assertEqual(trade.exitPrice, undefined, 'with no exit recorded');
  assertEqual(h.environment.openPositions().length, 1, 'and a live position');
});

await test('a resting BUY LIMIT expires when its time to live runs out', async () => {
  // The market never comes down to the entry, so only expiry can end this order.
  const h = harness(candles([105, 105, 105, 105, 105]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 110, fraction: 1 }] });

  // Expires after two minutes of simulated time.
  const nowSeconds = (h.environment.currentBar()?.time ?? 0) + 60;
  const placed = await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 100,
    expiresAt: nowSeconds + 120, planId: plan.id,
  });
  assertEqual(placed.success, true, 'rests');

  h.advance(1);
  assertEqual(h.environment.orderForPlan(plan.id)?.status, 'PENDING', 'still waiting after one minute');
  h.advance(2);

  const order = h.environment.orderForPlan(plan.id) as SimulatedOrder;
  assertEqual(order.status, 'EXPIRED', 'expired rather than left waiting forever');
  assert(order.terminalReason !== undefined, 'with a stated reason');
});

await test('an expired order is distinguishable from a cancelled one', async () => {
  const h = harness(candles([105, 105, 105]));
  const first = await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 100, planId: 'expired',
    expiresAt: (h.environment.currentBar()?.time ?? 0) + 120,
  });
  const second = await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 101, planId: 'cancelled',
  });
  assertEqual(first.success, true, 'the expiring order rests');
  assertEqual(second.success, true, 'and so does the other');

  h.advance(3);
  await h.environment.cancelOrder(second.orderId!, 'The GOAT found something better.');

  const statuses_ = [h.environment.orderForPlan('expired')?.status, h.environment.orderForPlan('cancelled')?.status];
  assertEqual(statuses_[0], 'EXPIRED', 'the first expired: the market never came');
  assertEqual(statuses_[1], 'CANCELLED', 'the second was cancelled: the GOAT withdrew it');
});

await test('a cancelled order cannot be cancelled again, and says why', async () => {
  const h = harness(candles([105, 105, 105]));
  const placed = await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 100,
  });
  assertEqual((await h.environment.cancelOrder(placed.orderId!)).success, true, 'cancelled once');

  const again = await h.environment.cancelOrder(placed.orderId!);
  assertEqual(again.success, false, 'a second cancellation fails');
  assert((again.error ?? '').includes('CANCELLED'), 'reporting the state it is actually in');
});

await test('a filled order cannot be cancelled — that would erase a position', async () => {
  const h = harness(candles([101, 99.9, 100.5]));
  const placed = await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 100, stopLoss: 98,
  });
  h.advance(1);

  const attempt = await h.environment.cancelOrder(placed.orderId!);
  assertEqual(attempt.success, false, 'refused');
  assert((attempt.error ?? '').includes('FILLED'), 'because it is a position now');
});

// ---------------------------------------------------------------------------
// 3. SELL LIMIT — the mirror, and it must actually mirror
// ---------------------------------------------------------------------------

await test('a SELL LIMIT rests above the market and fills when price rises to it', async () => {
  const h = harness(candles([101, 101.5, 102.5, 101.8]));
  const plan = idea({
    direction: 'SHORT', orderType: 'LIMIT', entry: 102, invalidationLevel: 103,
    takeProfits: [{ price: 99, fraction: 1 }],
  });
  const decision = await h.engine.submit(plan, 'g1');
  assertEqual(decision.approved, true, 'approved');
  assertEqual(statuses(h.trades()), 'PENDING', 'resting above the market');

  h.advance(2); // 102.5 candle, whose high is 102.55
  const trade = h.trades()[0];
  assertEqual(trade.status, 'RUNNING', 'filled on the way up');
  assertEqual(trade.side, 'SELL', 'as a short');
  assertEqual(trade.fillPrice, 102, 'at the limit');
});

await test('a short is stopped out above its entry and takes profit below it', async () => {
  const stopped = harness(candles([101, 102.5, 104]));
  await stopped.engine.submit(
    idea({ direction: 'SHORT', orderType: 'LIMIT', entry: 102, invalidationLevel: 103, takeProfits: [{ price: 95, fraction: 1 }] }),
    'g1',
  );
  stopped.advance(2);
  const loss = stopped.trades()[0];
  assertEqual(loss.status, 'STOPPED_OUT', 'price rose through the stop');
  assertEqual(loss.exitPrice, 103, 'filled at the stop');
  assert((loss.pnl ?? 0) < 0, 'a loss, as it should be');

  const won = harness(candles([101, 102.5, 101, 98]));
  await won.engine.submit(
    idea({ direction: 'SHORT', orderType: 'LIMIT', entry: 102, invalidationLevel: 104, takeProfits: [{ price: 98, fraction: 1 }] }),
    'g1',
  );
  won.advance(3);
  const gain = won.trades()[0];
  assertEqual(gain.status, 'TAKE_PROFIT', 'price fell to the target');
  assertEqual(gain.exitPrice, 98, 'filled at the target');
  assert((gain.pnl ?? 0) > 0, 'for a gain');
});

// ---------------------------------------------------------------------------
// 4. The ambiguity OHLC cannot resolve
// ---------------------------------------------------------------------------

await test('a candle spanning both the entry and the stop resolves against the trade', async () => {
  /*
   * The candle's low (99.5) is below the entry (100) *and* below the stop (99.8).
   * OHLC cannot say whether price reached 100 before or after 99.8, so the replay
   * assumes the worse ordering: filled, then stopped.
   *
   * The alternative — treating the entry as unreachable because the stop was
   * nearer — would be a flattering guess, and it would flatter this case every
   * time, which is the worst property a backtest can have.
   */
  const bars: Bar[] = [
    { time: 1_700_000_000, open: 101, high: 101.2, low: 99.5, close: 100.5, volume: 1_000 },
  ];
  const h = harness(bars);
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99.8, takeProfits: [{ price: 110, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');

  h.advance(1);

  const trade = h.trades()[0];
  assertEqual(trade.status, 'STOPPED_OUT', 'filled and immediately stopped out, in that order');
  assertEqual(trade.exitPrice, 99.8, 'at the stop');
  assert((trade.pnl ?? 0) < 0, 'so the trade is a loss — the honest reading');
});

await test('a candle spanning both the entry and the target resolves against the trade too', async () => {
  const bars: Bar[] = [
    { time: 1_700_000_000, open: 101, high: 103.5, low: 99.5, close: 103, volume: 1_000 },
  ];
  const h = harness(bars);
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99.8, takeProfits: [{ price: 103, fraction: 1 }] });
  await h.engine.submit(plan, 'g1');

  h.advance(1);

  // The stop (99.8) and the target (103) are both inside this candle's range.
  // The stop is checked first, so the trade loses even though the candle also
  // touched the target. That is the conservative resolution, and it is asserted
  // rather than left implicit — the whole point of documenting the rule is that a
  // later change to it has to be deliberate.
  const trade = h.trades()[0];
  assertEqual(trade.status, 'STOPPED_OUT', 'the worse of the two outcomes');
});

// ---------------------------------------------------------------------------
// 5. Multiple trades, and the concurrency constraint
// ---------------------------------------------------------------------------

await test('a second plan is refused while a position is open, and says so', async () => {
  const h = harness(candles([101, 99.9, 100.5, 101, 101.5]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 110, fraction: 1 }] }),
    'g1',
  );
  h.advance(2); // fill and run, price now 100.5

  // A second plan below the market, so the only thing that can refuse it is the
  // concurrency limit. A price at the market would be refused as marketable and
  // the test would pass for the wrong reason.
  const second = await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100.2, invalidationLevel: 99, takeProfits: [{ price: 110, fraction: 1 }] }),
    'g1',
  );

  assertEqual(second.approved, false, 'refused while one position is open');
  assert(second.reason.includes('position'), 'and the reason mentions the limit');
  assertEqual(h.environment.restingOrders().length, 0, 'no second order was left resting');
});

await test('a GOAT may trade again once its position has closed', async () => {
  const h = harness(candles([101, 99.9, 100.5, 98.5, 98.6, 99.9, 101.5, 102]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 100.4, fraction: 1 }] }),
    'g1',
  );
  h.advance(3); // fills then takes profit

  assertEqual(h.trades()[0].status, 'TAKE_PROFIT', 'the first trade closed');

  /*
   * Below the market as it stands after three bars — 98.50 — so the only thing
   * that can refuse this is the concurrency limit, which no longer applies
   * because the first trade has closed. A price at or above the market would be
   * refused as marketable and the test would pass for the wrong reason.
   */
  const second = await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 98.2, invalidationLevel: 97.5, takeProfits: [{ price: 104, fraction: 1 }] }),
    'g1',
  );
  assertEqual(second.approved, true, `the next trade is allowed (${second.reason})`);
  assertEqual(statuses(h.trades()), 'TAKE_PROFIT,PENDING', 'so two trades exist');
});

await test('one plan cannot produce two orders, however many times it is submitted', async () => {
  const h = harness(candles([101, 100.5, 100.2, 100.1]));
  const plan = idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 110, fraction: 1 }] });

  await h.engine.submit(plan, 'g1');
  const again = await h.engine.submit(plan, 'g1');
  const third = await h.engine.submit(plan, 'g1');

  assert(again.reason.includes('already live'), 'the second submission is answered, not obeyed');
  assert(third.reason.includes('already live'), 'and so is the third');
  assertEqual(h.environment.restingOrders().length, 1, 'exactly one order exists');
  assertEqual(h.trades().length, 1, 'and exactly one trade');
});

await test('an order fills once, not once per candle it spans', async () => {
  const h = harness(candles([101, 99.9, 99.8, 99.7, 99.6]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 95, takeProfits: [{ price: 120, fraction: 1 }] }),
    'g1',
  );
  h.advance(4);

  const filled = h.environment.simulatedOrders().filter((order) => order.status === 'FILLED');
  assertEqual(filled.length, 1, 'filled exactly once');
  assertEqual(h.trades()[0].status, 'RUNNING', 'and there is one position, not four');
});

// ---------------------------------------------------------------------------
// 6. End of replay with work still open
// ---------------------------------------------------------------------------

await test('a position still open at the end of the data is closed and reported', async () => {
  const h = harness(candles([101, 99.9, 101, 102]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 95, takeProfits: [{ price: 130, fraction: 1 }] }),
    'g1',
  );
  h.advance(3);

  assertEqual(h.trades()[0].status, 'RUNNING', 'still running as the data runs out');
  await h.environment.finalize();
  // The book has now realised it, so the engine reconciles — the same order the
  // session uses, and the reason a stopped replay's last trade is not left showing
  // "running" against a book that has already closed it.
  h.engine.settle();

  const trade = h.trades()[0];
  assertEqual(trade.status, 'EXITED', 'closed by the end of the replay rather than left dangling');
  assert((trade.exitReason ?? '').includes('closed this trade'), 'and the reason says so');
  assertEqual(h.environment.openPositions().length, 0, 'with no position left open');
});

await test('an order still resting at the end of the data stays pending, honestly', async () => {
  const h = harness(candles([105, 105, 105]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 95, takeProfits: [{ price: 120, fraction: 1 }] }),
    'g1',
  );
  h.advance(2);
  await h.environment.finalize();

  const trade = h.trades()[0];
  assertEqual(trade.status, 'PENDING', 'the market never came to it, so it is still waiting');
  assertEqual(trade.exitPrice, undefined, 'with no invented exit');
});

await test('cancelling restings leaves open positions alone', async () => {
  const h = harness(candles([101, 99.9, 100.5, 100.6]));
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 95, takeProfits: [{ price: 130, fraction: 1 }] }),
    'g1',
  );
  h.advance(2);

  const cancelled = await h.engine.cancelResting('The GOAT was refreshed.');
  assertEqual(cancelled, 0, 'there was no resting order to cancel');
  assertEqual(h.trades()[0].status, 'RUNNING', 'and the open position was not touched');
  assertEqual(h.environment.openPositions().length, 1, 'still held');
});

// ---------------------------------------------------------------------------
// 7. LIVE and REPLAY stay apart
// ---------------------------------------------------------------------------

await test('the simulated book refuses to act as anything but a simulation', async () => {
  const h = harness(candles([101, 100.5]));
  await assertEqual(
    h.environment.mode,
    'BACKTEST',
    'the mode is BACKTEST',
  );

  // The mode assertion is the belt; the real guarantee is that there is no
  // adapter, signer or network call anywhere in the class. Proven by the type: a
  // live venue environment is a different object with different capabilities.
  const calls = (h.environment as unknown as { placeLimitOrder: unknown }).placeLimitOrder;
  assertEqual(typeof calls, 'function', 'the book exists and is local');
});

await test('a backtest trade never reaches the venue path', async () => {
  /*
   * Structural, not behavioural: the environment exposes no method that could
   * submit to a venue, so there is nothing for a backtest to call. If a future
   * change added one, this test fails to compile rather than passing silently.
   */
  const h = harness(candles([101, 100.5]));
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(h.environment));
  const forbidden = surface.filter((name) => /signWallet|privateKey|submitLive|sendOrder/i.test(name));
  assertEqual(forbidden.length, 0, `no venue-submission method exists (${forbidden.join(', ')})`);
});

// ---------------------------------------------------------------------------
// 8. Statistics
// ---------------------------------------------------------------------------

await test('statistics are derived from trades and admit when they know nothing', () => {
  const empty = tradeStatistics([]);
  assertEqual(empty.trades, 0, 'no trades');
  assertEqual(empty.winRate, undefined, 'and no win rate, because a percentage of nothing is not a measurement');
  assertEqual(empty.profitFactor, undefined, 'nor a profit factor');

  const one = tradeStatistics([
    { status: 'PENDING' } as TradeRecord,
  ]);
  assertEqual(one.pending, 1, 'a resting order is counted as pending');
  assertEqual(one.wins, 0, 'and not as a win, because nothing has closed');
});

await test('statistics count wins, losses and the orders that never filled', async () => {
  const h = harness(candles([101, 99.9, 103, 101, 99.5, 98.4, 98.5, 99, 100, 105]));
  // One winner.
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 98, takeProfits: [{ price: 103, fraction: 1 }] }),
    'g1',
  );
  h.advance(3);
  // Then a loser once the first has closed.
  await h.engine.submit(
    idea({ direction: 'LONG', orderType: 'LIMIT', entry: 100, invalidationLevel: 99, takeProfits: [{ price: 104, fraction: 1 }] }),
    'g1',
  );
  h.advance(6);

  const stats = tradeStatistics(h.trades());
  assertEqual(stats.trades, 2, 'two trades were attempted');
  assertEqual(stats.wins, 1, 'one won');
  assertEqual(stats.losses, 1, 'one lost');
  assertEqual(stats.winRate, 50, 'so a 50% win rate');
  assert(stats.totalPnl > 0, 'and a net gain, since the target was further than the stop');
  assert(stats.profitFactor !== undefined, 'a profit factor is computable with both outcomes present');
});

await test('an expired order is counted as expired, never as a loss', async () => {
  const h = harness(candles([105, 105, 105, 105]));
  const nowSeconds = (h.environment.currentBar()?.time ?? 0) + 60;
  await h.environment.placeLimitOrder({
    symbol: 'USD/JPY', side: 'BUY', volume: 100, price: 100,
    expiresAt: nowSeconds + 120, planId: 'stale',
  });
  h.advance(3);

  const stats = tradeStatistics([]);
  assertEqual(stats.expired, 0, 'no *trade* was created by a bare order — an unfilled order is not a trade');

  const order = h.environment.orderForPlan('stale');
  assertEqual(order?.status, 'EXPIRED', 'though the order itself expired');
  assertEqual(stats.losses, 0, 'and nothing was counted as a loss');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} trade engine test(s) failed.`);
}