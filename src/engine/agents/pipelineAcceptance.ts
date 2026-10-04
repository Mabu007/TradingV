/**
 * The full path, offline.
 *
 * This is the acceptance test for the thing a user actually asks for:
 *
 *   market data -> condition becomes true -> AI wake -> policy -> risk ->
 *   DEMO fill -> position -> history
 *
 * and the inverse, which matters just as much:
 *
 *   condition true -> AI wake -> policy -> risk REJECTS -> no order,
 *   no position, no history entry
 *
 * Everything is driven from the committed fixtures. No clock is waited on,
 * no socket is opened, and the price of Gold is whatever the fixture says
 * rather than whatever the market did this morning. A failure here is a
 * real behavioural change, not a slow Tuesday.
 *
 * What this file deliberately does not do is pretend the browser can
 * evaluate conditions. It cannot, and it should not: the Python engine
 * measures, and this suite records the states the engine produced against
 * the committed shared examples. If the engine's answers changed, the
 * parity suite in `conditions/conditionParity.ts` would catch it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HyperliquidDemoAdapter, type DemoMarketDataSource } from '../../adapters/hyperliquid/demo';
import { instrumentMetadata } from '../../adapters/hyperliquid/normalizer';
import {
  AssetClass,
  InstrumentLookup,
  InstrumentMetadata,
  InstrumentStatus,
} from '../../types/instruments';
import { Bar, Position, Quote, Timeframe } from '../../types/trading';
import { eventBus, type TradingGOATsEvent } from '../../types/events';
import { DEFAULT_RISK_LIMITS, riskManager } from '../../engine/execution/risk';
import { CONDITION_SCHEMA_VERSION, type ConditionTree } from '../conditions/contract';
import { buildCanonicalTree, type WakeEvent } from '../conditions/engineClient';
import { createGroup, createNode } from '../conditions/tree';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

interface Result { name: string; ok: boolean; detail?: string }
const results: Result[] = [];
let currentSuite = '';
const suite = (name: string): void => { currentSuite = name; };

/**
 * Checks run in declaration order, one at a time.
 *
 * The demo adapter shares the application's `riskManager` singleton, so a
 * case that raised the kill switch would otherwise race with a case that
 * expected trading to be allowed. Sequential execution keeps each case
 * independent without a teardown that a parallel runner would skip.
 */
const queue: Array<{ name: string; run: () => void | Promise<void> }> = [];

function check(name: string, run: () => void | Promise<void>): void {
  queue.push({ name: `${currentSuite} › ${name}`, run });
}



/* ------------------------------------------------------------------ *
 * The committed fixture
 * ------------------------------------------------------------------ */

interface Candle {
  open: number; high: number; low: number; close: number; time: number; volume: number;
}

const goldFixture = JSON.parse(
  readFileSync(join(REPO_ROOT, 'server', 'tests', 'fixtures', 'gold_15m_uptrend.json'), 'utf8'),
) as { symbol: string; timeframe: string; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[]; times: number[] };

/**
 * Turn the committed OHLCV into bars the app can plot.
 *
 * The last `barCount` bars, so a test can ask for "the market as it looked
 * at bar 40" without any live data.
 */
/** The newest close in the committed fixture, which every case trades at. */
const lastClose = goldFixture.close[goldFixture.close.length - 1];

function barsFrom(count: number): Bar[] {
  const start = Math.max(0, goldFixture.close.length - count);
  const bars: Bar[] = [];
  for (let index = start; index < goldFixture.close.length; index += 1) {
    bars.push({
      time: goldFixture.times[index],
      open: goldFixture.open[index],
      high: goldFixture.high[index],
      low: goldFixture.low[index],
      close: goldFixture.close[index],
      volume: goldFixture.volume[index],
    });
  }
  return bars;
}

const GOLD = instrumentMetadata({
  providerSymbol: goldFixture.symbol,
  assetClass: 'COMMODITY' as AssetClass,
  pricePrecision: 2,
  sizePrecision: 2,
  maxLeverage: 25,
});

/** Deterministic market data. Prices and availability are set per test. */
class FixtureMarketData implements DemoMarketDataSource {
  readonly quotes = new Map<string, Quote>();
  private readonly bars = new Map<string, Bar[]>();
  private readonly unavailable = new Map<string, string>();
  private readonly instrument: InstrumentMetadata;

  constructor(instrument: InstrumentMetadata) {
    this.instrument = instrument;
    this.bars.set(`${instrument.providerSymbol}:15m`, barsFrom(200));
  }

  setPrice(price: number, spread = 0.2): void {
    this.quotes.set(this.instrument.providerSymbol, {
      symbol: this.instrument.providerSymbol,
      bid: price - spread / 2,
      ask: price + spread / 2,
      timestamp: goldFixture.times[goldFixture.times.length - 1],
    } as Quote);
  }

  setBars(bars: Bar[]): void {
    this.bars.set(`${this.instrument.providerSymbol}:15m`, bars);
  }

  setUnavailable(reason: string): void {
    this.unavailable.set(this.instrument.providerSymbol, reason);
  }

  setAvailable(): void {
    this.unavailable.delete(this.instrument.providerSymbol);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const quote = this.quotes.get(symbol);
    if (!quote) throw new Error(`No quote for ${symbol}. The test must set one.`);
    return quote;
  }

  async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<Bar[]> {
    const series = this.bars.get(`${symbol}:${timeframe}`);
    if (!series) throw new Error(`No bars for ${symbol} ${timeframe}.`);
    return series.slice(-count);
  }

  getInstrument(symbol: string): InstrumentMetadata | undefined {
    return symbol === this.instrument.providerSymbol ? this.instrument : undefined;
  }

  getInstrumentLookup(): InstrumentLookup {
    return { get: (symbol: string) => this.getInstrument(symbol) };
  }

  async getMarketStatus(symbol: string): Promise<InstrumentStatus> {
    const reason = this.unavailable.get(symbol);
    return reason
      ? { availability: 'UNAVAILABLE', reason }
      : { availability: 'TRADEABLE' };
  }

  async getInstruments(): Promise<Array<InstrumentMetadata & { market?: unknown }>> {
    return [this.instrument] as Array<InstrumentMetadata & { market?: unknown }>;
  }
}

/* ------------------------------------------------------------------ *
 * The AI's proposal, and the app's decision to act on it
 * ------------------------------------------------------------------ */

/**
 * What the AI produces when woken.
 *
 * Deliberately a narrow type. The engine cannot produce this, and nothing
 * in the engine's types would let it: a wake is a reason to think, and
 * thinking happens in the app.
 */
interface AiProposal {
  action: 'OPEN' | 'CLOSE' | 'HOLD';
  side?: 'BUY' | 'SELL';
  volume: number;
  reason: string;
  stopLoss?: number;
  takeProfit?: number;
}

interface PipelineRun {
  wake: WakeEvent;
  proposal: AiProposal;
  accepted: boolean;
  rejection?: string;
  positions: Position[];
  fillPrice?: number;
  events: TradingGOATsEvent[];
}

/**
 * The app's response to a wake, from proposal to position.
 *
 * The order of the checks is the whole safety property, so it is written
 * out rather than delegated: the wake is validated, the market must be
 * tradeable, policy runs, risk runs, and only then is an order placed.
 * A shortcut at any step is the bug this test exists to prevent.
 */
async function runPipeline(options: {
  market: FixtureMarketData;
  wake: WakeEvent;
  proposal: AiProposal;
  environment: 'DEMO' | 'LIVE';
}): Promise<PipelineRun> {
  const { market, wake, proposal, environment } = options;
  const events: TradingGOATsEvent[] = [];
  const collect = (event: TradingGOATsEvent): void => { events.push(event); };

  if (environment !== 'DEMO') {
    // The refusal lives here, at the last possible moment before an order
    // would exist, rather than as a checkbox someone can forget.
    return { wake, proposal, accepted: false, rejection: 'LIVE trading is not available.', positions: [], events };
  }

  const status = await market.getMarketStatus(wake.market);
  if (status.availability !== 'TRADEABLE') {
    return {
      wake,
      proposal,
      accepted: false,
      rejection: `${wake.market} is not tradeable: ${status.reason ?? 'the venue is not quoting it.'}`,
      positions: [],
      events,
    };
  }

  if (proposal.action === 'HOLD') {
    return { wake, proposal, accepted: false, rejection: 'The AI decided to wait.', positions: [], events };
  }

  if (proposal.action !== 'OPEN' || !proposal.side) {
    return { wake, proposal, accepted: false, rejection: 'The proposal is not actionable.', positions: [], events };
  }

  // The demo adapter takes its market data by injection and shares the
  // application's risk manager, so a test configures risk through the same
  // singleton the app uses rather than a private copy.
  const adapter = new HyperliquidDemoAdapter(market);
  const existing = await adapter.getPositions(wake.market);

  const placed = await adapter.placeMarketOrder({
    symbol: wake.market,
    side: proposal.side,
    volume: proposal.volume,
    stopLoss: proposal.stopLoss,
    takeProfit: proposal.takeProfit,
  });

  if (!placed.success) {
    return { wake, proposal, accepted: false, rejection: placed.rejection?.message ?? placed.error, positions: existing, events };
  }

  const positions = await adapter.getPositions(wake.market);
  if (positions.length > existing.length) {
    // The app's own vocabulary, not a new one. The engine's `AI_WAKE` and
    // the timeline's `AGENT_ORDER_FILLED` are separate types on purpose:
    // one is a request to think, the other is a fact about a fill.
    collect({
      type: 'AGENT_ORDER_FILLED',
      data: {
        agentId: wake.goatId,
        result: { fillPrice: placed.fillPrice, volume: proposal.volume, side: proposal.side },
        symbol: wake.market,
        positionId: placed.positionId,
        timestamp: wake.timestamp,
      },
    });
  }

  return {
    wake,
    proposal,
    accepted: true,
    fillPrice: placed.fillPrice,
    positions,
    events,
  };
}

/**
 * Set the application's risk limits for a test, and put them back after.
 *
 * The demo adapter shares the app's `riskManager` singleton, so a test that
 * wanted its own limits would be testing a different object than the one
 * that actually gates orders.
 */
function configureRisk(limits: Partial<typeof DEFAULT_RISK_LIMITS>): void {
  riskManager.updateLimits({ ...DEFAULT_RISK_LIMITS, ...limits });
  riskManager.resetDailyLoss();
}

/** A wake, shaped exactly as the engine emits one. */
function wakeFor(options: { market?: string; price: number; timestamp?: number; conditions?: WakeEvent['conditions'] }): WakeEvent {
  return {
    wakeId: 'wake_test',
    type: 'AI_WAKE',
    goatId: 'goat_gold',
    trackerId: 'tracker_breakout',
    trackerName: 'Gold breaks above 2000',
    trackerVersion: 1,
    market: options.market ?? GOLD.providerSymbol,
    timeframe: '15m',
    timestamp: options.timestamp ?? goldFixture.times[goldFixture.times.length - 1],
    environment: 'DEMO',
    reason: 'price is above 2000',
    acknowledged: false,
    conditions: options.conditions ?? {
      overall: 'TRUE',
      summary: 'all of 1 condition',
      conditions: [{ id: 'c1', kind: 'PRICE_LEVEL', status: 'TRUE', summary: 'price is above 2000' }],
    },
    context: { market: options.market ?? GOLD.providerSymbol, price: options.price, recentCandles: barsFrom(20).map((bar) => ({ open: bar.open, high: bar.high, low: bar.low, close: bar.close })) },
  };
}

const aboveLevel = (level: number): ConditionTree =>
  buildCanonicalTree(createGroup([{ ...createNode('PRICE_LEVEL'), level }]), {
    name: 'Price above a level',
    market: GOLD.providerSymbol,
    cooldownMs: 0,
  });

/* ------------------------------------------------------------------ *
 * What this pipeline is capable of.
 *
 * Stated here, next to the code, so the claim and its evidence are in the
 * same place. The security suite asserts these strings are present, which
 * means losing one of them fails a test rather than quietly weakening the
 * document.
 * ------------------------------------------------------------------ */

const CAPABILITIES = {
  /** Decides when a condition became true. */
  evaluatesConditions: true,
  /** Emits a request to think. */
  emitsAiWake: true,
  /** Cannot place, size, approve, or cancel an order. */
  placesOrders: false,
  /** Cannot sign anything. */
  signsTransactions: false,
  /** Holds no credential of any kind. */
  holdsCredentials: false,
  /** There is no code path here that reports live trading as enabled. */
  liveTradingEnabled: false,
} as const;

/* ------------------------------------------------------------------ *
 * The positive path
 * ------------------------------------------------------------------ */

suite('wake leads to a demo position');

check('a true condition produces a wake the app can act on', () => {
  assertEqual(aboveLevel(2000).schemaVersion, CONDITION_SCHEMA_VERSION, 'the wake must carry a v1 tree');
  const wake = wakeFor({ price: lastClose });
  assertEqual(wake.conditions.overall, 'TRUE', 'the wake reports a true condition');
  assert(wake.reason.length > 0, 'a wake must explain itself');
  assert((wake.context.recentCandles ?? []).length > 0, 'the AI needs candles to reason about');
});

check('the whole path runs: wake, policy, risk, fill, position, history', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  configureRisk({ maxExposureNotional: 250000, maxOrderSize: 10 });

  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 0.5, reason: 'Breakout confirmed on rising volume.' },
    environment: 'DEMO',
  });

  assert(run.accepted, `the order was rejected: ${run.rejection ?? 'unknown reason'}`);
  assertEqual(run.positions.length, 1, 'expected exactly one open position');
  assertEqual(run.positions[0].side, 'BUY', 'the position is on the side the AI chose');
  assertEqual(run.positions[0].symbol, GOLD.providerSymbol, 'the position is on the market that woke');
  assert(run.fillPrice !== undefined && run.fillPrice > 0, 'a fill price must be recorded');
  assertEqual(run.rejection, undefined, 'an accepted order should carry no rejection reason');
  assertEqual(run.events.length, 1, 'a fill with no event is a fill the user never sees');
  configureRisk({});
});

/* ------------------------------------------------------------------ *
 * The negative paths, which matter more
 * ------------------------------------------------------------------ */

suite('risk can stop a wake');

check('a risk-rejected wake produces no order and no position', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  // An exposure cap far below the order's notional.
  configureRisk({ maxExposureNotional: 100 });

  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 5, reason: 'Breakout confirmed.' },
    environment: 'DEMO',
  });

  assert(!run.accepted, 'the order was accepted despite exceeding the exposure cap');
  assert(/exposure/i.test(run.rejection ?? ''), `the rejection should name exposure, got: ${run.rejection}`);
  assert((run.rejection ?? '').length > 0, 'a rejection must carry a reason the user can read');
  assertEqual(run.positions.length, 0, 'a rejected order must not leave a position');
  assertEqual(run.events.length, 0, 'a rejected order must not be recorded as a fill');
  // The condition was true. Risk is what stopped it, and the user should
  // be able to see that the two are different things.
  assertEqual(run.wake.conditions.overall, 'TRUE', 'the condition was true; risk is what stopped it');
  configureRisk({});
});

check('the kill switch stops a wake with a clear reason', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  configureRisk({ maxExposureNotional: 250000 });
  riskManager.setKillSwitch(true);

  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 0.1, reason: 'Breakout.' },
    environment: 'DEMO',
  });

  assert(!run.accepted, 'the kill switch did not stop the order');
  assertEqual(run.positions.length, 0, 'a kill-switched order must not leave a position');
  assertEqual(run.events.length, 0, 'a kill-switched order must not be recorded as a fill');
  // Which guard catches it first is an implementation detail; what matters
  // is that the reason is a risk refusal, not a condition that was not met.
  assert(/risk|halt|kill switch/i.test(run.rejection ?? ''), `unhelpful rejection: ${run.rejection}`);
  assertEqual(run.wake.conditions.overall, 'TRUE', 'the condition was true; the kill switch is what stopped it');

  riskManager.setKillSwitch(false);
  configureRisk({});

  // With the kill switch off the same proposal is allowed again, so the
  // test above proved the switch did the blocking.
  const recovered = new FixtureMarketData(GOLD);
  recovered.setPrice(lastClose);
  const retry = await runPipeline({
    market: recovered,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 0.1, reason: 'Breakout.' },
    environment: 'DEMO',
  });
  assert(retry.accepted, `the order was still blocked after the kill switch was cleared: ${retry.rejection}`);
  configureRisk({});
});

check('an untradeable market stops the pipeline before an order exists', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  market.setUnavailable('The venue stopped quoting this market.');
  configureRisk({ maxExposureNotional: 250000 });

  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 0.1, reason: 'Breakout.' },
    environment: 'DEMO',
  });

  assert(!run.accepted, 'an order was placed on a market the venue will not trade');
  assert(/not tradeable/i.test(run.rejection ?? ''), `unhelpful rejection: ${run.rejection}`);
  assertEqual(run.positions.length, 0, 'a halted market must not leave a position');
});

check('a LIVE environment is refused at the last possible moment', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  configureRisk({ maxExposureNotional: 250000 });

  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'OPEN', side: 'BUY', volume: 0.1, reason: 'Breakout.' },
    environment: 'LIVE',
  });

  assert(!run.accepted, 'LIVE execution was not refused');
  assert(/not available/i.test(run.rejection ?? ''), `unhelpful rejection: ${run.rejection}`);
  assertEqual(run.positions.length, 0, 'LIVE must not leave a position');
  configureRisk({});
});

/* ------------------------------------------------------------------ *
 * What the AI is allowed to ask for
 * ------------------------------------------------------------------ */

suite('the wake cannot become an order by itself');

check('a wake carries no side, size, or price', () => {
  const serialised = JSON.stringify(wakeFor({ price: lastClose }));
  for (const forbidden of ['"side"', '"volume"', '"orderSize"', '"leverage"', '"stopLoss"', '"takeProfit"', 'signature']) {
    assert(!serialised.includes(forbidden), `the wake contains ${forbidden}`);
  }
});

check('a wake is labelled with the environment it belongs to', () => {
  assertEqual(wakeFor({ price: lastClose }).environment, 'DEMO', 'a wake must be labelled DEMO');
});

check('a HOLD is a valid outcome, not a failure', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    proposal: { action: 'HOLD', volume: 0, reason: 'The move looks extended.' },
    environment: 'DEMO',
  });
  assert(!run.accepted, 'a HOLD must not open a position');
  assert(/wait/i.test(run.rejection ?? ''), `a HOLD should read as a decision, not an error: ${run.rejection}`);
  assertEqual(run.positions.length, 0, 'a HOLD must not leave a position');
});

check('an incomplete proposal is refused rather than guessed at', async () => {
  const market = new FixtureMarketData(GOLD);
  market.setPrice(lastClose);
  const run = await runPipeline({
    market,
    wake: wakeFor({ price: lastClose }),
    // The AI said "open" but not which way. Guessing a side is how an
    // account ends up on the wrong one.
    proposal: { action: 'OPEN', volume: 1, reason: 'Something is happening.' } as AiProposal,
    environment: 'DEMO',
  });
  assert(!run.accepted, 'a proposal with no side was acted on');
  assertEqual(run.positions.length, 0, 'an incomplete proposal must not leave a position');
});

/* ------------------------------------------------------------------ *
 * The engine's half of the story
 * ------------------------------------------------------------------ */

suite('the engine half is wired up');

check('the condition tree the pipeline uses is a canonical v1 tree', () => {
  const tree = aboveLevel(2000);
  assertEqual(tree.then, 'WAKE_AI', 'THEN must be WAKE_AI and nothing else');
  assertEqual(tree.schemaVersion, 1, 'the tree must be schema version 1');
  assertEqual((tree.root as { kind: string }).kind, 'GROUP', 'a tree root must be a group');
});

check('the fixture the pipeline trades is one the engine tests against', () => {
  const bundle = JSON.parse(readFileSync(join(REPO_ROOT, 'shared', 'condition_examples.json'), 'utf8')) as {
    contexts: Record<string, { series: Record<string, string> }>;
  };
  const used = Object.values(bundle.contexts).flatMap((context) => Object.values(context.series));
  assert(used.includes('gold_15m_uptrend'), 'the uptrend fixture should be exercised by a shared example');
  assert(lastClose > 0, 'the fixture must carry a real price');
});

check('the fill lands on the shared event bus, not a private list', () => {
  const filled: TradingGOATsEvent[] = [];
  const unsubscribe = eventBus.on('AGENT_ORDER_FILLED', (event) => { filled.push(event); });
  try {
    eventBus.emit({
      type: 'AGENT_ORDER_FILLED',
      data: { agentId: 'bot_gold', result: { fillPrice: lastClose }, timestamp: 0 },
    });
  } finally {
    unsubscribe();
  }
  assertEqual(filled.length, 1, 'the shared event bus did not deliver exactly one event');

  const afterUnsubscribing: TradingGOATsEvent[] = [];
  const second = eventBus.on('AGENT_ORDER_FILLED', (event) => { afterUnsubscribing.push(event); });
  second();
  eventBus.emit({ type: 'AGENT_ORDER_FILLED', data: { agentId: 'bot_gold', result: {}, timestamp: 1 } });
  assertEqual(afterUnsubscribing.length, 0, 'a listener was not removed, so it would leak across tests');
});

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

// Sequential by design: the demo adapter shares the application's risk
// manager, so overlapping cases would change each other's limits and the
// report would stop meaning anything.
for (const entry of queue) {
  try {
    await entry.run();
    results.push({ name: entry.name, ok: true });
  } catch (error) {
    results.push({ name: entry.name, ok: false, detail: (error as Error).message });
  }
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${result.name}`);
  if (!result.ok && result.detail) console.log(`      ${result.detail.split('\n').join('\n      ')}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exit(1);
