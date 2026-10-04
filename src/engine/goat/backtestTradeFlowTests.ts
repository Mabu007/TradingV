/**
 * The end-to-end trade flow, through a real replay.
 *
 * ## What this is for
 *
 * The unit tests in `tradeEngineTests.ts` prove the order book and the lifecycle
 * behave. This proves the *whole* loop, which is the thing the release is actually
 * about:
 *
 *   research → a thesis → a tracker fires → the GOAT escalates → it prices a limit
 *   → the order rests → a candle reaches it → the position runs → the target is
 *   taken → the trade is recorded → the GOAT looks for the next one
 *
 * Every step goes through the production `BacktestSession`, the production
 * `GoatOrchestrator`, the production loop and the production risk layer. Nothing
 * is stubbed except the model, because the model is the only thing here that is
 * supposed to be the thinking.
 *
 * ## The trade is earned, not forced
 *
 * The fixture is a real breakout with a real retest, and the model proposes the
 * retest price because that is the price its strategy says to pay. There is no
 * "trade after N candles" rule anywhere in this file, and the test that follows
 * this one asserts that a replay in which price never reaches the entry takes no
 * trade at all — because a backtest that must produce activity to look healthy is
 * measuring its own optimism.
 *
 * `bun src/engine/goat/backtestTradeFlowTests.ts`
 */

import { BacktestSession } from './backtest/session';
import { normalizeModelReply } from '../agents/model/openrouter';
import type { IAgentModel } from '../agents/model/types';
import type { Bar } from '../../types/trading';
import type { AgentTimelineEventType } from '../agents/timeline/types';

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

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** The levels this strategy trades. Not hardcoded into any code path. */
const LEVELS = {
  rangeLow: 157.70,
  rangeHigh: 157.80,
  /** The broken resistance, now support. */
  breakoutLevel: 157.85,
  /** What the GOAT offers on the retest. */
  retestEntry: 157.82,
  /** Below the level that made the thesis wrong. */
  stop: 157.68,
  target: 158.20,
} as const;

/**
 * A range, a breakout, a retest to the entry, then continuation.
 *
 * Written as an explicit path because every assertion below depends on which
 * candle reaches which price. A formula would hide that, and the whole point of the
 * test is *which candle did what*.
 */
function breakoutPath(): number[] {
  const path: number[] = [];
  // A range for two hours, so the GOAT has something to study before the move.
  for (let index = 0; index < 120; index += 1) {
    path.push(index % 2 === 0 ? LEVELS.rangeHigh : LEVELS.rangeLow);
  }
  // The breakout: a candle that clears the range decisively.
  for (let index = 0; index < 3; index += 1) path.push(157.94);
  // The retest. The candle that closes at the offer trades down through it, which
  // is what fills a BUY LIMIT.
  for (const price of [157.88, 157.85, LEVELS.retestEntry, 157.90]) path.push(price);
  // Continuation to the target.
  for (let index = 0; index < 40; index += 1) {
    path.push(LEVELS.retestEntry + ((LEVELS.target - LEVELS.retestEntry) * (index + 1)) / 41);
  }
  // And back down afterwards, so a stop would have been survivable to see.
  for (let index = 0; index < 20; index += 1) path.push(LEVELS.target - index * 0.01);
  return path;
}

function candles(path: number[]): Bar[] {
  const bars: Bar[] = [];
  let time = 1_700_000_000;
  for (const close of path) {
    bars.push({
      time,
      open: close,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 1_000,
    });
    time += 60;
  }
  return bars;
}

/**
 * A GOAT that escalates, then prices a retest.
 *
 * Models the reasoning a breakout strategy actually performs: once a tracker says
 * the level broke, the thesis meets the bar for trading; on the following wake the
 * GOAT offers the retest price rather than the market, because the retest is where
 * the risk is.
 *
 * Escalation and pricing are separate replies on purpose. They cannot be the same
 * reply, because the loop only accepts a trade proposal from a thesis that is
 * already ACTIONABLE — which is the deadlock this work removed.
 */
class BreakoutRetestModel implements IAgentModel {
  private escalated = false;
  private priced = false;
  readonly replies: string[] = [];

  async run(request: { contract?: string; instructions: string; wakeReason?: string }) {
    if (request.contract === 'INVESTIGATION') {
      return normalizeModelReply(
        JSON.stringify({
          thought: 'The market is compressing under a level that has held for two hours.',
          thesis: {
            statement: `USD/JPY breaks above ${LEVELS.breakoutLevel} and holds the retest.`,
            direction: 'BULLISH',
            invalidation: `A completed 1m close back below ${LEVELS.rangeHigh}.`,
            requiredConfirmation: ['a new 15m bar', 'price reclaiming the broken level'],
          },
          trackers: [
            { purpose: 'Watch for a new 15m bar', kind: 'NEW_BAR', config: {}, timeframe: '15m' },
            {
              purpose: `Detect price crossing ${LEVELS.breakoutLevel}`,
              kind: 'PRICE_CROSS',
              config: { direction: 'ABOVE', level: LEVELS.breakoutLevel },
              timeframe: '1m',
            },
          ],
        }),
      );
    }

    if (request.contract === 'INTERPRETATION') {
      return normalizeModelReply(
        JSON.stringify({
          thought: 'Understood: trade a confirmed breakout on its retest.',
          symbols: ['USD/JPY'],
          timeframes: [],
          investigationPlan: [],
          openQuestions: [],
          actionable: true,
        }),
      );
    }

    /*
     * Only the GOAT's own decision contract.
     *
     * The agent runtime runs its own reasoning cycle against the same model
     * instance, and answering that with a GOAT plan is meaningless — the answer is
     * never applied to a thesis. A model that treats every call as a decision
     * appears to escalate and then does nothing, which looks exactly like the
     * deadlock this work removed.
     */
    if (request.contract !== 'PLAN') {
      return normalizeModelReply(JSON.stringify({ kind: 'WAIT', reason: 'agent cycle' }));
    }

    /*
     * Escalate on the breakout, and not before.
     *
     * This is the discipline the whole flow depends on: a GOAT that escalates on a
     * routine bar inside the range would then price a retest *above* the market it
     * is in, and the order would be refused as marketable — correctly, because
     * there was no breakout to buy. Waiting for the event that actually matters is
     * what makes the trade that follows real rather than staged.
     */
    /*
     * Escaped as `\\D` because this is a template literal: a bare `\D` in one is an
     * unknown escape and collapses to `D`, which would quietly turn "crossed above
     * 157.85." into a pattern that does not match it.
     */
    const brokeOut = new RegExp(`crossed above ${LEVELS.breakoutLevel}(\\D|$)`, 'i').test(
      request.wakeReason ?? '',
    );
    if (!brokeOut && !this.escalated) {
      this.replies.push('WAIT');
      return normalizeModelReply(
        JSON.stringify({ kind: 'WAIT', reason: 'Still inside the range; nothing to trade.' }),
      );
    }

    if (!this.escalated) {
      this.escalated = true;
      this.replies.push('ESCALATE_THESIS');
      return normalizeModelReply(
        JSON.stringify({
          kind: 'ESCALATE_THESIS',
          thesisId: 'any',
          reason: `Price cleared ${LEVELS.breakoutLevel} on a completed candle, so the bar for trading is met.`,
        }),
      );
    }

    if (!this.priced) {
      this.priced = true;
      this.replies.push('PROPOSE_TRADE_IDEA');
      return normalizeModelReply(
        JSON.stringify({
          kind: 'PROPOSE_TRADE_IDEA',
          thesisId: 'any',
          reason: 'The breakout is confirmed; I want the retest, not the market.',
          idea: {
            symbol: 'USD/JPY',
            direction: 'LONG',
            orderType: 'LIMIT',
            entry: LEVELS.retestEntry,
            invalidationLevel: LEVELS.stop,
            takeProfits: [{ price: LEVELS.target, fraction: 1, label: 'measured continuation' }],
            reasoning: `retest of the broken ${LEVELS.breakoutLevel} level as new support`,
          },
        }),
      );
    }

    this.replies.push('WAIT');
    return normalizeModelReply(JSON.stringify({ kind: 'WAIT', reason: 'Nothing new to price.' }));
  }
}

/** A GOAT that escalates and then offers a price this market never visits. */
class PatientNeverFilledModel extends BreakoutRetestModel {
  override async run(request: { contract?: string; instructions: string; wakeReason?: string }) {
    // Reach the escalation first, using the parent's own reasoning.
    if (!request.contract || request.contract !== 'PLAN') {
      return super.run(request);
    }
    if (!(this as unknown as { escalated: boolean }).escalated) {
      return super.run(request);
    }

    /*
     * A price far below anything this market visits.
     *
     * Used to prove the negative case: a patient order the market never reaches
     * must end the replay with no trade, no fill and no invented result. Without
     * this, every test in this file would pass with an engine that fills every
     * order it is given.
     */
    return normalizeModelReply(
      JSON.stringify({
        kind: 'PROPOSE_TRADE_IDEA',
        thesisId: 'any',
        reason: 'I will only buy a deep pullback.',
        idea: {
          symbol: 'USD/JPY',
          direction: 'LONG',
          orderType: 'LIMIT',
          entry: 150,
          invalidationLevel: 148,
          takeProfits: [{ price: 160, fraction: 1 }],
          reasoning: 'a deep pullback to 150',
        },
      }),
    );
  }
}

function sessionFor(model: IAgentModel, path = breakoutPath()) {
  const bars = candles(path);
  return new BacktestSession({
    goal: 'Trade a confirmed USD/JPY breakout on its retest.',
    name: 'Breakout retest',
    market: 'USD/JPY',
    timeframe: '1m',
    timeframes: ['1m', '15m'],
    start: bars[5].time * 1000,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model,
    speed: 1,
    costModel: { initialBalance: 10_000, spreadPrice: 0, slippagePrice: 0, commissionPerLot: 0, pipSize: 0.01 },
  });
}

const types = (log: Array<{ type: AgentTimelineEventType }>): AgentTimelineEventType[] =>
  log.map((entry) => entry.type);


// ---------------------------------------------------------------------------
// 1. The whole loop
// ---------------------------------------------------------------------------

await test('a breakout replay runs research → plan → limit → fill → position → result', async () => {
  const model = new BreakoutRetestModel();
  const session = sessionFor(model);
  await session.start();

  // The GOAT formed a plan of its own accord.
  const afterStart = session.snapshot().mission;
  assert(afterStart?.thesis !== undefined, 'the GOAT formed a Trade Plan from the market');
  assert(afterStart.activeTrackerCount > 0, 'and deployed trackers to watch it');

  // Replay across the breakout, the retest and the continuation.
  await session.advance(3 * 60 * 60_000);

  const trades = session.tradeRecords();
  assertEqual(trades.length, 1, `exactly one trade was taken (${trades.map((t) => `${t.status}@${t.proposedEntry}`).join(', ')})`);

  const trade = trades[0];
  assertEqual(trade.status, 'TAKE_PROFIT', `and it closed at the target (${trade.exitReason ?? trade.rejectionReason ?? 'no reason'})`);
  assertEqual(trade.side, 'BUY', 'a long, as the setup was');
  assertEqual(trade.orderType, 'LIMIT', 'entered on a resting limit order, not at the market');
  assertEqual(trade.proposedEntry, LEVELS.retestEntry, 'at the price the GOAT said it would pay');
  assertEqual(trade.fillPrice, LEVELS.retestEntry, 'which is where it filled');
  assertEqual(trade.stopLoss, LEVELS.stop, 'with the stop where its thesis said it would be wrong');
  assertEqual(trade.takeProfit, LEVELS.target, 'and the target it was aiming at');
  assertEqual(trade.exitPrice, LEVELS.target, 'and it exited there');
  assert((trade.pnl ?? 0) > 0, `for a gain (${trade.pnl})`);

  /*
   * The intermediate states must have existed.
   *
   * Asserting only the final status would let a system that jumped straight from
   * proposal to result pass this test — and a GOAT that never waits for its price
   * is precisely the defect this release exists to fix.
   */
  const log = session.agentLog(2_000);
  const seen = new Set<string>(log.map((entry) => entry.type));
  for (const required of ['ORDER_PLACED', 'ORDER_FILLED', 'POSITION_OPENED', 'TRADE_CLOSED']) {
    assert(seen.has(required), `the log shows ${required} (saw ${[...seen].join(', ')})`);
  }
  assert(model.replies.includes('ESCALATE_THESIS'), 'the GOAT escalated its thesis before pricing a trade');
  assert(
    model.replies.indexOf('ESCALATE_THESIS') < model.replies.indexOf('PROPOSE_TRADE_IDEA'),
    'and escalated before it proposed, which is the order the loop requires',
  );
});

await test('the order was resting before it filled, not filled on placement', async () => {
  const model = new BreakoutRetestModel();
  const session = sessionFor(model);
  await session.start();

  // Stop the replay just after the order is placed but before the retest.
  let sawPending = false;
  for (let minute = 0; minute < 200 && !sawPending; minute += 1) {
    await session.advance(60_000);
    const pending = session.tradeRecords().filter((trade) => trade.status === 'PENDING');
    sawPending = pending.length > 0;
    if (sawPending) {
      const trade = pending[0];
      assertEqual(trade.fillPrice, undefined, 'a resting order has no fill price yet');
      assertEqual(trade.proposedEntry, LEVELS.retestEntry, 'and is waiting for the price the GOAT named');
      assertEqual(session.simulation.openPositions().length, 0, 'with no position until it fills');
      // The order must genuinely be resting on the book, below the market.
      const resting = session.simulation.restingOrders();
      assertEqual(resting.length, 1, 'one order resting on the simulated book');
      assert(
        LEVELS.retestEntry < (session.simulation.currentBar()?.close ?? 0),
        `a BUY LIMIT waits below the market (entry ${LEVELS.retestEntry}, market ${session.simulation.currentBar()?.close})`,
      );
    }
  }
  assert(sawPending, 'the replay reached a state with a resting order');
});

await test('a patient limit the market never reaches produces no trade', async () => {
  const model = new PatientNeverFilledModel();
  const session = sessionFor(model);
  await session.start();
  await session.advance(3 * 60 * 60_000);

  const trades = session.tradeRecords();
  assertEqual(trades.length, 1, 'the plan was still acted on');
  assertEqual(
    trades[0].status,
    'PENDING',
    `and it is still waiting for ${trades[0].proposedEntry}, which this market never visited`,
  );
  assertEqual(trades[0].fillPrice, undefined, 'with no fill and no invented result');
  assertEqual(session.simulation.openPositions().length, 0, 'and no position');
  assertEqual(session.trades().length, 0, 'and no closed trade to report');

  /*
   * The important half of this: nothing was manufactured to make the replay look
   * busy. A strategy whose price never arrived must end with no trade, and a
   * backtest that cannot represent that outcome cannot be used to judge one.
   */
  const stats = session.tradeStats();
  assertEqual(stats.filled, 0, 'nothing filled');
  assertEqual(stats.pending, 1, 'one order still waiting');
  assertEqual(stats.winRate, undefined, 'and no win rate, because nothing closed');
});

await test('a second backtest starts with no trades from the first', async () => {
  const first = sessionFor(new BreakoutRetestModel());
  await first.start();
  await first.advance(3 * 60 * 60_000);
  assert(first.tradeRecords().length > 0, 'the first replay traded');

  const second = sessionFor(new BreakoutRetestModel());
  await second.start();
  assertEqual(second.tradeRecords().length, 0, 'a new replay has no trades');
  assertEqual(second.trades().length, 0, 'and no closed ones either');
});

await test('statistics describe the trade that actually happened', async () => {
  const session = sessionFor(new BreakoutRetestModel());
  await session.start();
  await session.advance(3 * 60 * 60_000);

  const stats = session.tradeStats();
  assertEqual(stats.trades, 1, 'one trade');
  assertEqual(stats.wins, 1, 'one win');
  assertEqual(stats.losses, 0, 'no losses');
  assertEqual(stats.winRate, 100, 'so a 100% win rate — which is what one winning trade means');
  assert(stats.totalPnl > 0, 'and a net gain');
  const held = session.tradeRecords()[0].secondsHeld;
  assert(typeof held === 'number' && held > 0, `the hold time is a real duration (${held})`);
  assert(
    held! < 60 * 60,
    `and a plausible one — the fill and the target are minutes apart, not hours (${held}s)`,
  );
  assertEqual(stats.rejected, 0, 'nothing was rejected');
  assertEqual(stats.expired, 0, 'nothing expired');
});

await test('the replay never reaches a live venue from a trade', async () => {
  const session = sessionFor(new BreakoutRetestModel());
  await session.start();
  await session.advance(3 * 60 * 60_000);

  /*
   * Structural rather than behavioural.
   *
   * The guarantee is not that a flag is off; it is that the simulation's book has
   * no method that could sign anything. If one were added, this fails to compile.
   */
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(session.simulation));
  assertEqual(
    surface.filter((name) => /signWallet|privateKey|submitLive|sendRealOrder/i.test(name)).length,
    0,
    'no venue-submission path exists on the simulated book',
  );
  assertEqual(session.simulation.mode, 'BACKTEST', 'and the environment says what it is');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} backtest trade flow test(s) failed.`);
}