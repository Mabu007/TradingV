import { BacktestSimulator } from './simulator';
import { Bar, BacktestConfig } from '../../types/trading';

/**
 * The interactive backtester, held to the guarantees it claims.
 *
 * This simulator had no test at all, which is why three defects lived in it
 * unnoticed: an unseeded random slippage that made every run irreproducible, an
 * ambiguous bar resolved in the flattering direction, and an end-of-run
 * liquidation that neither charged for the exit nor recomputed equity. None of
 * them are exotic — they are the three things a backtester is *for*.
 */
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function round2(value: number): number { return Math.round(value * 100) / 100; }

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'EURUSD',
    timeframe: '1m' as BacktestConfig['timeframe'],
    initialBalance: 10_000,
    spreadPips: 1,
    commissionPerLot: 0,
    slippagePips: 0,
    barCount: 60,
    ...overrides,
  };
}

/** `count` flat bars at `price`, then one that spans both levels. */
function bars(count: number, price: number, last?: Bar): Bar[] {
  const series: Bar[] = [];
  for (let index = 0; index < count; index += 1) {
    series.push({ time: 1_700_000_000 + index * 60, open: price, high: price, low: price, close: price });
  }
  if (last) series.push(last);
  return series;
}

/** Open one long on the first bar it is offered, then hold it. */
const enterLongOnce = `
  async function strategy(ctx) {
    if (ctx.state.get('entered')) return;
    const r = await ctx.orders.market({
      symbol: 'EURUSD', side: 'BUY', volume: 1, type: 'MARKET',
    });
    if (r.success) ctx.state.set('entered', true);
  }
`;

const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn]);
}

test('interactive backtest: the same run twice produces the same fills', async () => {
  const series = bars(40, 1.1);
  const simulator = new BacktestSimulator(config({ slippagePips: 5, spreadPips: 2 }));

  const first = await simulator.run(enterLongOnce, series);
  const second = await simulator.run(enterLongOnce, bars(40, 1.1));

  assertEqual(
    first.trades.map((trade) => `${trade.entryPrice}->${trade.exitPrice}`).join(','),
    second.trades.map((trade) => `${trade.entryPrice}->${trade.exitPrice}`).join(','),
    'two runs of one strategy over one dataset fill at the same prices',
  );
  assertEqual(
    first.finalEquity,
    second.finalEquity,
    'and therefore end at the same balance',
  );
  assertEqual(
    first.equityCurve.map((point) => point.equity).join(','),
    second.equityCurve.map((point) => point.equity).join(','),
    'with the same equity curve throughout',
  );
});

test('interactive backtest: an ambiguous bar resolves to the stop, not the target', async () => {
  /*
   * One bar that reaches both the stop and the target. OHLC records the range,
   * not the path, so the outcome is genuinely unknown — and every other
   * environment in this codebase resolves it to the worse case and says so.
   */
  const ambiguous: Bar = { time: 1_700_000_000 + 40 * 60, open: 1.1, high: 1.12, low: 1.09, close: 1.1 };
  const simulator = new BacktestSimulator(config({ slippagePips: 0, spreadPips: 0 }));

  const enter = `
    async function strategy(ctx) {
      if (ctx.state.get('opened')) return;
      const r = await ctx.orders.market({
        symbol: 'EURUSD', side: 'BUY', volume: 1, type: 'MARKET',
        stopLoss: 1.095, takeProfit: 1.115,
      });
      if (r.success) ctx.state.set('opened', true);
    }
  `;
  const result = await simulator.run(enter, bars(40, 1.1, ambiguous));

  const trade = result.trades[0];
  assert(trade !== undefined, 'the position was opened and closed');
  assertEqual(
    trade!.exitReason,
    'STOP_LOSS',
    'the stop is checked first, so the worse of the two outcomes is the one recorded',
  );
  assertEqual(trade!.exitPrice, 1.095, 'and the exit is priced at the stop, not the target');
});

test('interactive backtest: the closing liquidation is reflected in the reported account', async () => {
  /*
   * Positions still open when the dataset runs out. The run has to liquidate them,
   * charge for getting out, and then report the account as it actually stands —
   * the last figure used to be the equity measured *before* that happened.
   */
  const simulator = new BacktestSimulator(config({ slippagePips: 3, spreadPips: 2 }));
  const result = await simulator.run(enterLongOnce, bars(40, 1.1));

  assert(result.trades.length > 0, 'the open position was closed out at the end');
  assert(
    result.trades.some((trade) => trade.exitReason === 'MANUAL'),
    'by the end-of-run liquidation',
  );

  const realised = result.trades.reduce((sum, trade) => sum + trade.pnl - trade.commission, 0);
  assertEqual(
    round2(result.finalEquity),
    round2(config().initialBalance + realised),
    'the reported balance is the opening balance plus what every trade actually kept',
  );
  assertEqual(
    round2(result.netProfit),
    round2(realised),
    'and the headline profit is the same number, not a stale one',
  );

  const lastPoint = result.equityCurve[result.equityCurve.length - 1];
  assert(lastPoint !== undefined, 'the equity curve has a final point');
  assertEqual(
    round2(lastPoint!.equity),
    round2(result.finalEquity),
    'and that final point agrees with the balance rather than lagging a bar behind it',
  );
});

test('interactive backtest: reported profit cannot exceed the money in the account', async () => {
  const simulator = new BacktestSimulator(config({ slippagePips: 4, spreadPips: 3, commissionPerLot: 5 }));
  const rise = bars(39, 1.1);
  rise.push({ time: 1_700_000_000 + 39 * 60, open: 1.1, high: 1.15, low: 1.1, close: 1.15 });
  const result = await simulator.run(enterLongOnce, rise);

  const realised = result.trades.reduce((sum, trade) => sum + trade.pnl - trade.commission, 0);
  assertEqual(
    Math.round(result.finalEquity * 100) / 100,
    Math.round((config().initialBalance + realised) * 100) / 100,
    'balance is the opening balance plus what the trades actually kept',
  );
});

export async function runInteractiveBacktesterTests(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const [name, fn] of tests) {
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
  if (failures.length > 0) throw new Error(`${failures.length} interactive backtester test(s) failed.`);
}

if (import.meta.main) {
  await runInteractiveBacktesterTests();
}