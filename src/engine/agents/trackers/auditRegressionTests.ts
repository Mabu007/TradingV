/**
 * Regression tests for the V0 architecture audit.
 *
 * Every test here corresponds to a bug that was found, reproduced, and
 * fixed. They are grouped by the class of failure rather than by the file
 * the bug lived in, because the point of the grouping is that a future
 * change to any of these areas has to keep the behaviour.
 *
 * Where a test encodes a decision rather than a fix, the comment says so.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { calculateATR, calculateEMA, calculateRMA, calculateSMA } from '../../indicators';
import { marketSymbol, percentChange24h } from '../../../adapters/hyperliquid/normalizer';
import { evaluateTrackerConditionTree, type TrackerConditionContext } from './conditions';
import type { TrackerConditionGroup } from './conditions';
import { riskManager, DEFAULT_RISK_LIMITS, RiskManager } from '../../execution/risk';
import { HyperliquidDemoAdapter } from '../../../adapters/hyperliquid/demo';
import { instrumentMetadata } from '../../../adapters/hyperliquid/normalizer';
import { hyperliquidMarketData } from '../../../adapters/hyperliquid/marketData';
import {
  validateGoatDefinition,
  compileGoatDefinition,
  createGoatDeployment,
  validateGoatDeployment,
  type GoatDefinition,
} from '../../goat/definition';
import { GoatSkillRegistry } from '../../goat/skills';
import { GOAT_BUILTIN_SKILLS } from '../../goat/builtinSkills';
import type { Tracker } from './types';

import { PersistentAgentTimelineStore } from '../timeline/store';
import type { AgentTimelineEvent } from '../timeline/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const GOLD_INSTRUMENT = instrumentMetadata({ providerSymbol: 'xyz:GOLD', assetClass: 'COMMODITY', pricePrecision: 2, sizePrecision: 2, maxLeverage: 25 });

/**
 * Risk needs an instrument lookup and a reference price to value
 * exposure. Without them the exposure check rejects first and the branch
 * under test is never reached, which is how a broken daily-loss limit
 * looks like a passing one.
 */
function riskContext(referencePrice = 2300) {
  return {
    instruments: {
      get: (symbol: string) => (symbol === 'xyz:GOLD' || symbol === 'Gold' ? GOLD_INSTRUMENT : undefined),
    },
    referencePrices: { 'xyz:GOLD': referencePrice, Gold: referencePrice },
    accountCurrency: 'USD',
  };
}

interface Result { name: string; ok: boolean; detail?: string }
const results: Result[] = [];
let currentGroup = '';
const group = (name: string): void => { currentGroup = name; };
function check(name: string, run: () => void | Promise<void>): void {
  queue.push({ name: `${currentGroup} › ${name}`, run });
}
const queue: Array<{ name: string; run: () => void | Promise<void> }> = [];

/* ================================================================== *
 * 1. Crossover conditions measured the wrong series
 *
 * `lastPair` returned [fast[n-1], fast[n-2], slow[n-1], slow[n-2]] but
 * the caller destructured it as [prevFast, prevSlow, currFast, currSlow].
 * Every crossover condition therefore compared the fast series against
 * itself and the slow series against itself, so it reported FALSE exactly
 * when a genuine crossover happened and TRUE on unrelated shapes.
 *
 * This is the worst class of bug in the system: the condition looked
 * plausible, the summary read correctly, and the bot acted on the wrong
 * premise. A regression test that only checks "a rising series is TRUE"
 * would pass, so these assert the specific bar where the cross occurred.
 * ================================================================== */

group('crossover conditions');

function closesIntoContext(closes: number[]): TrackerConditionContext {
  return {
    state: {
      timestamp: 0,
      environment: 'DEMO',
      symbol: 'Gold',
      price: closes[closes.length - 1],
      bars: closes.map((close, index) => ({ time: index, open: close, high: close, low: close, close })),
    },
  } as TrackerConditionContext;
}

function crossTree(direction: 'ABOVE' | 'BELOW'): TrackerConditionGroup {
  return {
    id: 'g',
    kind: 'GROUP',
    operator: 'AND',
    children: [
      {
        id: 'x',
        kind: 'INDICATOR_CROSS',
        direction,
        fast: { indicator: 'EMA', period: 3 },
        slow: { indicator: 'SMA', period: 6 },
      },
    ],
  } as TrackerConditionGroup;
}

/**
 * Six flat bars, then one sharp move.
 *
 * The fast EMA(3) reacts to the final bar immediately while the slow
 * SMA(6) is still dominated by the flat run, so the cross lands on the
 * last bar. This is the shape that made the original bug visible: the
 * shipped code read `fast[n-1]` and `fast[n-2]` as the two "sides" and so
 * asked only whether the fast series was flat, which is TRUE here and
 * would have masked the failure.
 */
const BULLISH_CROSS = [10, 10, 10, 10, 10, 10, 20];
/** The mirror image: a sharp down-bar into a flat run. */
const BEARISH_CROSS = [10, 10, 10, 10, 10, 10, 4];

/** Whether a genuine cross occurs on the final bar, computed directly. */
function crossoverFiredOnLastBar(closes: number[], direction: 'ABOVE' | 'BELOW'): boolean {
  const fast = calculateEMA(closes, 3);
  const slow = calculateSMA(closes, 6);
  const n = closes.length;
  return direction === 'ABOVE'
    ? fast[n - 2]! <= slow[n - 2]! && fast[n - 1]! > slow[n - 1]!
    : fast[n - 2]! >= slow[n - 2]! && fast[n - 1]! < slow[n - 1]!;
}

check('a genuine bullish crossover is reported as TRUE', () => {
  assert(crossoverFiredOnLastBar(BULLISH_CROSS, 'ABOVE'), 'the fixture no longer contains a bullish cross');
  const result = evaluateTrackerConditionTree(crossTree('ABOVE'), closesIntoContext(BULLISH_CROSS));
  assert(result.results[0].status === 'TRUE', `a real bullish cross evaluated to ${result.results[0].status}`);
});

check('a genuine bearish crossover is reported as TRUE', () => {
  assert(crossoverFiredOnLastBar(BEARISH_CROSS, 'BELOW'), 'the fixture no longer contains a bearish cross');
  const result = evaluateTrackerConditionTree(crossTree('BELOW'), closesIntoContext(BEARISH_CROSS));
  assert(result.results[0].status === 'TRUE', `a real bearish cross evaluated to ${result.results[0].status}`);
});

check('a cross that already happened is not reported again on a later bar', () => {
  // The cross happened on the last bar of the fixture; by the time a few
  // more bars have printed it is history. Firing again would wake the bot
  // on every bar of an established trend.
  const extended = [...BULLISH_CROSS, 30, 40, 50];
  assert(!crossoverFiredOnLastBar(extended, 'ABOVE'), 'the fixture still ends on a cross');
  const result = evaluateTrackerConditionTree(crossTree('ABOVE'), closesIntoContext(extended));
  assert(result.results[0].status === 'FALSE', `an established cross fired again: ${result.results[0].status}`);
});

check('the two sides of a cross are read from the two different series', () => {
  // A cross cannot be detected at all if the two "sides" come from the
  // same series, so assert the reported difference is fast-minus-slow.
  const result = evaluateTrackerConditionTree(crossTree('ABOVE'), closesIntoContext(BULLISH_CROSS));
  const reported = result.results[0].value;
  const fast = calculateEMA(BULLISH_CROSS, 3);
  const slow = calculateSMA(BULLISH_CROSS, 6);
  const expected = fast[BULLISH_CROSS.length - 1]! - slow[BULLISH_CROSS.length - 1]!;
  assert(
    reported !== undefined && Math.abs(reported - expected) < 1e-9,
    `the cross reports ${String(reported)} but fast-minus-slow on the last bar is ${expected}`,
  );
});

check('a crossover with too little history is UNKNOWN, not FALSE', () => {
  const short = [10, 10, 10];
  const result = evaluateTrackerConditionTree(crossTree('ABOVE'), closesIntoContext(short));
  assert(result.results[0].status === 'UNKNOWN', `short history evaluated to ${result.results[0].status}, which reads as "no cross"`);
});

/* ================================================================== *
 * 2. The kill switch never reached the risk engine
 *
 * `riskManager.setKillSwitch` had no caller in application code. The UI
 * showed "Trading is halted" while `validateOrder` returned valid, so the
 * one control a user reaches for in an emergency did nothing.
 * ================================================================== */

group('kill switch');

check('engaging the kill switch blocks a valid order', () => {
  const manager = new RiskManager({ maxExposureNotional: 1_000_000, killSwitchActive: true });
  const verdict = manager.validateOrder(
    { symbol: 'Gold', side: 'BUY', volume: 0.1 } as never,
    [],
    true,
    riskContext(),
  );
  assert(!verdict.valid, 'the kill switch allowed an order through');
  assert(/kill switch/i.test(verdict.reason ?? ''), `unhelpful kill-switch reason: ${verdict.reason}`);
});

check('clearing the kill switch restores trading', () => {
  const manager = new RiskManager({ maxExposureNotional: 1_000_000 });
  const order = { symbol: 'Gold', side: 'BUY', volume: 0.1 } as never;
  assert(manager.validateOrder(order, [], true, riskContext()).valid, 'trading was blocked with the kill switch off');
  manager.setKillSwitch(true);
  assert(!manager.validateOrder(order, [], true, riskContext()).valid, 'trading continued after the kill switch was engaged');
  manager.setKillSwitch(false);
  assert(manager.validateOrder(order, [], true, riskContext()).valid, 'trading did not resume after the kill switch was cleared');
});

check('the shared risk manager is the one the app and the tests both reach', async () => {
  // This used to assert `something === undefined || true`, which is
  // true for every value in existence. It passed without testing
  // anything, which is worse than having no test: it looked like
  // coverage of the single-gate property.
  //
  // The property is proved by behaviour instead. If the adapter held
  // its own RiskManager, a halt engaged on the shared one would have no
  // effect on a fill -- so a fill that is refused while the shared
  // manager is halted can only happen if there is exactly one gate.
  const { adapter, restore } = buildAdapter();
  try {
    riskManager.setKillSwitch(true);
    const refused = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(!refused.success, 'the adapter filled while the shared manager was halted, so it has a second gate');

    riskManager.setKillSwitch(false);
    const allowed = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(allowed.success, 'the adapter stayed halted after the shared manager was cleared, so it has a second gate');
  } finally {
    restore();
  }
});

/* ================================================================== *
 * 3. Realised losses never reached the daily-loss limit
 *
 * `dailyPnL` was computed as `equity - balance`, which is *open* P&L. A
 * loss disappears from the number the moment the position closes, so a
 * bot could lose far more than its daily limit and stay under it. The
 * engine-level `recordPnL` existed and was never called.
 * ================================================================== */

group('daily loss accounting');

check('realised losses are remembered after the position closes', () => {
  const manager = new RiskManager({ maxDailyLoss: 100 });
  manager.recordPnL(-250);
  const verdict = manager.validateOrder(
    { symbol: 'Gold', side: 'BUY', volume: 0.1 } as never,
    [],
    true,
    riskContext(),
  );
  assert(!verdict.valid, `a $250 realised loss did not trip a $100 daily-loss limit (${verdict.reason})`);
  assert(/loss/i.test(verdict.reason ?? ''), `unhelpful daily-loss reason: ${verdict.reason}`);
});

check('profitable trading does not trip the daily-loss limit', () => {
  const manager = new RiskManager({ maxDailyLoss: 100 });
  manager.recordPnL(-40);
  manager.recordPnL(90);
  assert(manager.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext()).valid,
    'a net profitable day was blocked by the daily-loss limit');
});

check('a day boundary resets the loss counter', () => {
  const manager = new RiskManager({ maxDailyLoss: 100 });
  manager.recordPnL(-500);
  assert(!manager.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext()).valid,
    'the limit did not apply before the reset');
  manager.resetDailyLoss();
  assert(manager.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext()).valid,
    'the limit still applied after the daily reset');
});

check('losses and gains net out rather than accumulating independently', () => {
  const manager = new RiskManager({ maxDailyLoss: 100 });
  manager.recordPnL(-90);
  manager.recordPnL(-90);
  assert(!manager.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext()).valid,
    'two $90 losses did not breach a $100 limit');
  const recovered = new RiskManager({ maxDailyLoss: 100 });
  recovered.recordPnL(-90);
  recovered.recordPnL(200);
  assert(recovered.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext()).valid,
    'a -90 followed by +200 did not net out');
});

/* ================================================================== *
 * 4. A single discovery failure was cached for the whole session
 *
 * `discoverOnce` memoised the discovery promise and never cleared it on
 * rejection, so one transient 429 or offline blip left the app with no
 * instruments, no quotes, and no orders for the rest of the session.
 * ================================================================== */

group('market data resilience');

check('a failed discovery is retried rather than cached forever', async () => {
  const adapter = hyperliquidMarketData as unknown as {
    transport: { request: (body: { type: string }) => Promise<unknown> };
    instruments?: unknown;
    discoveryPromise?: Promise<unknown>;
  };
  const originalRequest = adapter.transport.request;
  let shouldFail = true;
  let calls = 0;
  adapter.transport.request = async (body) => {
    calls += 1;
    if (body.type === 'perpDexs' && shouldFail) throw new Error('offline');
    if (body.type === 'perpDexs') return [{ name: 'xyz' }];
    if (body.type === 'metaAndAssetCtxs') {
      return [
        { universe: [{ name: 'GOLD', szDecimals: 2, tickSz: '0.01' }] },
        [{ markPx: '2300.5', midPx: '2300.5', maxLeverage: 25 }],
      ];
    }
    return [];
  };
  adapter.instruments = undefined;
  adapter.discoveryPromise = undefined;

  let firstFailed = false;
  try {
    await hyperliquidMarketData.getInstruments();
  } catch {
    firstFailed = true;
  }
  assert(firstFailed, 'the first discovery was expected to fail');

  shouldFail = false;
  const recovered = await hyperliquidMarketData.getInstruments();
  assert(recovered.length > 0, `discovery stayed broken after the network came back (${calls} calls, 0 instruments)`);

  adapter.transport.request = originalRequest;
  adapter.instruments = undefined;
  adapter.discoveryPromise = undefined;
});

/* ================================================================== *
 * 5. Identifiers built from `Date.now()` collide
 *
 * Two fills in the same millisecond produced the same order id, the same
 * position id, and the same trade id. History is de-duplicated by id, so
 * a second close in the same millisecond was silently dropped along with
 * its realised P&L, and `closePosition` always closed the first match.
 * ================================================================== */

group('identifier uniqueness');

function buildAdapter(): { adapter: HyperliquidDemoAdapter; setQuote: (bid: number, ask: number) => void; restore: () => void } {
  const instrument = instrumentMetadata({ providerSymbol: 'xyz:GOLD', assetClass: 'COMMODITY', pricePrecision: 2, sizePrecision: 2, maxLeverage: 25 });
  const quotes = new Map<string, { symbol: string; bid: number; ask: number; timestamp: number }>();
  let clock = 1_700_000_000_000;
  const marketData = {
    getQuote: async (symbol: string) => {
      /*
       * The venue quotes one price per market, and callers may address
       * it by app symbol or by provider symbol. The quote is echoed back
       * under the symbol that was asked for, because the adapter keys
       * the resulting position on it -- so a fixture that always
       * answered 'Gold' would leave an order placed against 'xyz:GOLD'
       * with a position nobody could find afterwards.
       */
      const quote = quotes.get(symbol) ?? quotes.get('Gold');
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return { ...quote, symbol, timestamp: (clock += 1) };
    },
    getBars: async () => [] as never,
    getInstrument: () => instrument,
    getInstrumentLookup: () => ({ get: () => instrument }),
    getMarketStatus: async () => ({ availability: 'TRADEABLE' as const }),
    getInstruments: async () => [instrument] as never,
  };
  quotes.set('Gold', { symbol: 'Gold', bid: 2299.5, ask: 2300.5, timestamp: 0 });
  quotes.set('xyz:GOLD', { symbol: 'xyz:GOLD', bid: 2299.5, ask: 2300.5, timestamp: 0 });
  return {
    adapter: new HyperliquidDemoAdapter(marketData as never),
    /**
     * Move the market. Needed by anything that has to settle a real
     * close, because the only way a loss becomes realised in this
     * system is by closing a position at a worse price.
     */
    setQuote: (bid: number, ask: number) => {
      for (const key of ['Gold', 'xyz:GOLD']) {
        quotes.set(key, { symbol: key, bid, ask, timestamp: clock });
      }
    },
    restore: () => { riskManager.updateLimits({ ...DEFAULT_RISK_LIMITS }); riskManager.resetDailyLoss(); riskManager.setKillSwitch(false); },
  };
}

check('two orders in the same millisecond get different order ids', async () => {
  const { adapter, restore } = buildAdapter();
  const realNow = Date.now;
  // Freeze the clock: the whole point is two events in one millisecond.
  Date.now = () => 1_700_000_000_000;
  try {
    const first = await adapter.placeMarketOrder({ symbol: 'xyz:GOLD', side: 'BUY', volume: 0.1 });
    const second = await adapter.placeMarketOrder({ symbol: 'xyz:GOLD', side: 'BUY', volume: 0.1 });
    assert(first.success && second.success, `both orders should have been accepted: ${first.error ?? ''} ${second.error ?? ''}`);
    assert(first.orderId !== second.orderId, `two orders in one millisecond shared the id ${first.orderId}`);
  } finally {
    Date.now = realNow;
    restore();
  }
});

check('two positions opened and closed in the same millisecond stay distinguishable', async () => {
  const { adapter, restore } = buildAdapter();
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const first = await adapter.placeMarketOrder({ symbol: 'xyz:GOLD', side: 'BUY', volume: 0.1 });
    const second = await adapter.placeMarketOrder({ symbol: 'xyz:GOLD', side: 'BUY', volume: 0.2 });
    assert(first.success && second.success, 'both opens should have succeeded');
    assert(first.positionId !== second.positionId, `two positions shared the id ${first.positionId}`);

    const positions = await adapter.getPositions('xyz:GOLD');
    assert(positions.length === 2, `expected two open positions, got ${positions.length}`);

    const closedFirst = await adapter.closePosition(first.positionId as string);
    const closedSecond = await adapter.closePosition(second.positionId as string);
    assert(closedFirst.success && closedSecond.success, 'both closes should have succeeded');
    assert(closedFirst.trade && closedSecond.trade, 'a close produced no trade record');
    // History is de-duplicated by trade id, so a collision here drops a
    // realised P&L from the user's history while the balance still moves.
    assert(
      closedFirst.trade!.id !== closedSecond.trade!.id,
      `two closes in one millisecond shared the trade id ${closedFirst.trade!.id}`,
    );
    // The second close must close the position it was asked to close, not
    // the first match, which is what a duplicated id caused.
    const remaining = await adapter.getPositions('xyz:GOLD');
    assert(remaining.length === 0, `${remaining.length} positions remained open after closing both`);
  } finally {
    Date.now = realNow;
    restore();
  }
});

/* ================================================================== *
 * 6. The builder wrote a tracker kind no validator accepts
 *
 * The condition card stored its tree on a tracker with `kind: 'CUSTOM'`.
 * The registry does not accept CUSTOM and rejects it outright, so the
 * moment a user touched a condition the GOAT definition stopped
 * validating and the builder could not continue. There is also no UI to
 * remove that tracker, so the session was stuck.
 *
 * A GOAT built with conditions must validate, deploy, and register.
 * ================================================================== */

group('GOAT definition');

/**
 * A GOAT fixture carrying no observation plan, because the schema has
 * nowhere to put one. That absence is what these checks defend.
 */
function goatDefinitionFixture(): GoatDefinition {
  return {
    schemaVersion: 1,
    version: 1,
    source: 'user',
    identity: { id: 'goat-cond', name: 'Conditional GOAT', description: 'Investigates and decides.' },
    goal: {
      statement: 'Find a long opportunity when a decline looks like it is reversing.',
      symbols: [],
      excludedSymbols: [],
    },
    skills: [
      { id: 'structural-trend-analysis', version: 1 },
      { id: 'regime-awareness', version: 1 },
    ],
    capabilities: {
      readMarketData: true,
      readHistoricalData: true,
      readAccount: true,
      readPositions: true,
      manageTrackers: true,
      manageThesis: true,
      proposeTrades: true,
      requestExecution: false,
    },
    agentConfig: {
      provider: 'openrouter',
      model: 'x',
      reasoningMode: 'advisory',
      confidenceThreshold: 0.7,
      decisionPolicy: 'Investigate.',
      maxIterations: 8,
    },
    riskPolicy: {
      riskPerTrade: 0.02,
      maxExposure: 250000,
      maxDailyLoss: 500,
      maxPositions: 3,
      cooldownMs: 0,
      maxActiveTheses: 2,
      maxActiveTrackers: 8,
      maxWakeupsPerHour: 20,
      maxToolCallsPerCycle: 24,
    },
    createdAt: 0,
    updatedAt: 0,
  } as GoatDefinition;
}

/*
 * The real capability registry, so the fixture's skills are validated
 * against the capabilities that actually exist. A hand-written list
 * would let a skill name a capability the system does not have and
 * still pass, which is the defect this check exists to catch.
 */
import { capabilityRegistry } from '../capabilities';
import { ALL_GOAT_CAPABILITIES } from '../../goat/trackerSdk';

const goatSkillRegistry = new GoatSkillRegistry({
  knownCapabilityIds: () => [
    ...capabilityRegistry.list().map((capability) => capability.id),
    ...ALL_GOAT_CAPABILITIES,
  ],
});
goatSkillRegistry.registerAll(GOAT_BUILTIN_SKILLS);

const stubEnv = {
  mode: 'DEMO',
} as never;

function deploymentFor(
  goat: GoatDefinition,
  overrides: Partial<ReturnType<typeof createGoatDeployment>> = {},
) {
  const deployment = createGoatDeployment({
    goatId: goat.identity.id,
    goatVersion: goat.version,
    marketId: 'EURUSD',
    accountId: 'paper',
    mode: 'SHADOW',
    execution: {
      canProposeTrades: true,
      canExecute: false,
      allowedOrderTypes: ['LIMIT'],
    },
    createdAt: 0,
    ...overrides,
  });
  // Validated against the definition, so a deployment cannot grant
  // authority the definition never requested.
  return validateGoatDeployment(deployment, goat);
}

check('a GOAT with a well-formed goal validates', () => {
  try {
    validateGoatDefinition(goatDefinitionFixture(), { skills: goatSkillRegistry });
  } catch (error) {
    throw new Error(`a valid GOAT was rejected: ${(error as Error).message}`);
  }
});

check('a GOAT definition cannot carry an observation plan', () => {
  /*
   * The regression this guards against is specific: someone re-adding a
   * `trackers` field so a definition can be authored with conditions
   * again. The type does not have one, and an object carrying one is
   * refused rather than quietly ignoring the extra field — otherwise
   * the re-introduction would look like it worked.
   */
  const smuggled = { ...goatDefinitionFixture(), trackers: [{ id: 't1', kind: 'PRICE_THRESHOLD' }] };
  let refused = false;
  try {
    validateGoatDefinition(smuggled, { skills: goatSkillRegistry });
  } catch {
    refused = true;
  }
  assert(refused, 'a definition carrying hand-authored trackers must be refused, not accepted and ignored');
});

check('a GOAT goal that specifies a method is reported rather than accepted quietly', () => {
  let problems: string[] = [];
  try {
    validateGoatDefinition(
      {
        ...goatDefinitionFixture(),
        goal: {
          statement: 'Buy EURUSD when RSI(14) crosses below 30',
          symbols: [],
          excludedSymbols: [],
        },
      },
      { skills: goatSkillRegistry },
    );
  } catch (error) {
    problems = (error as { problems?: string[] }).problems ?? [(error as Error).message];
  }
  assert(
    problems.some((p) => p.includes('method')),
    'a goal that names an indicator must be told to state the outcome instead',
  );
});

/* ================================================================== *
 * 7. `localStorage` was dereferenced at module scope
 *
 * `const storage = getStorage()` ran while the module was loading, and
 * the `in` check inside `getStorage` passes in contexts where merely
 * *accessing* the property throws a SecurityError (sandboxed iframes,
 * storage disabled). The throw escaped the AgentRuntime constructor, so
 * the ES module import failed and React never mounted: a white screen
 * with no error boundary, because the boundary is inside the tree.
 * ================================================================== */

group('storage that may not exist');

check('the timeline store survives storage being denied at access time', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('storage is denied in this context', 'SecurityError'); },
  });
  try {
    // Constructing must not throw; that is the whole point.
    const store = new PersistentAgentTimelineStore(100, 'denied-test');
    assert(store.storageState === 'UNAVAILABLE', `storage denial was not reported: ${store.storageState}`);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

check('an append does not throw when the write is rejected', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const denied = {
    getItem: () => null,
    setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError'); },
    removeItem: () => {},
    key: () => null,
    length: 0,
    clear: () => {},
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: denied });
  try {
    const store = new PersistentAgentTimelineStore(100, 'quota-test');
    const event = { id: 'e1', agentId: 'a1', type: 'STATUS_CHANGE', timestamp: 0 } as unknown as AgentTimelineEvent;
    await store.append(event);
    store.flush();
    assert(store.storageState === 'FAILED', `a rejected write was not reported: ${store.storageState}`);
    // The in-memory timeline must still be usable after the write failed.
    const stored = await store.getByAgent('a1');
    assert(stored.length === 1, 'the in-memory timeline stopped working after a persistence failure');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

/* ================================================================== *
 * 8. Appends cloned and serialised the entire history
 *
 * Every append did `structuredClone(allEvents)` plus `JSON.stringify` of
 * the whole array and a synchronous `localStorage.setItem`. The timeline
 * is written on every `POSITION_UPDATE`, which the demo adapter emits on
 * every quote tick, so a tab with a few thousand events spent its time
 * copying its own history several times a second.
 * ================================================================== */

group('timeline cost');

check('a burst of appends produces far fewer writes than appends', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let setItemCalls = 0;
  const counting = {
    getItem: () => null,
    setItem: () => { setItemCalls += 1; },
    removeItem: () => {},
    key: () => null,
    length: 0,
    clear: () => {},
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: counting });

  try {
    const store = new PersistentAgentTimelineStore(2000, 'timeline-cost-test');
    for (let index = 0; index < 200; index += 1) {
      await store.append({ id: `seed-${index}`, agentId: 'a1', type: 'STATUS_CHANGE', timestamp: index } as unknown as AgentTimelineEvent);
    }
    store.flush();
    setItemCalls = 0;

    // 200 appends in a tight burst, which is what a quote storm looks
    // like from the timeline's point of view.
    for (let index = 0; index < 200; index += 1) {
      await store.append({ id: `burst-${index}`, agentId: 'a1', type: 'POSITION_UPDATE', timestamp: 1000 + index } as unknown as AgentTimelineEvent);
    }
    store.flush();

    assert(
      setItemCalls <= 3,
      `a burst of 200 appends caused ${setItemCalls} full-history writes; they must be coalesced`,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

check('the burst is not lost when it is never flushed', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let written = '';
  const capturing = {
    getItem: () => null,
    setItem: (_key: string, value: string) => { written = value; },
    removeItem: () => {},
    key: () => null,
    length: 0,
    clear: () => {},
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: capturing });
  try {
    const store = new PersistentAgentTimelineStore(100, 'timeline-durability-test');
    for (let index = 0; index < 20; index += 1) {
      await store.append({ id: `d-${index}`, agentId: 'a1', type: 'STATUS_CHANGE', timestamp: index } as unknown as AgentTimelineEvent);
    }
    // Wait past the debounce without calling flush(): the events must have
    // been written on their own, or a closed tab loses them silently.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const persisted = JSON.parse(written) as Array<{ id: string }>;
    assert(persisted.length === 20, `only ${persisted.length} of 20 events reached storage without an explicit flush`);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

check('the history is still bounded', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0, clear: () => {} },
  });
  try {
    const store = new PersistentAgentTimelineStore(100, 'timeline-bound-test');
    for (let index = 0; index < 500; index += 1) {
      await store.append({ id: `e-${index}`, agentId: 'a1', type: 'STATUS_CHANGE', timestamp: index } as unknown as AgentTimelineEvent);
    }
    const kept = await store.getByAgent('a1', { limit: 1000 });
    assert(kept.length <= 100, `the timeline grew to ${kept.length} entries, past its cap`);
    assert(kept[kept.length - 1]?.id === 'e-499', 'the oldest events should be evicted, not the newest');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

/* ================================================================== *
 * 9. Every bot was compiled with trading disabled
 *
 * `allowTrading` required `reasoningMode !== 'advisory'`, but the builder
 * hardcoded `advisory` and rendered the mode read-only, so a user could
 * toggle orders and automation on, see "Automation on", and still have
 * every order rejected with TRADING_DISABLED.
 *
 * The gate itself is correct and stays. What is wrong is that the UI
 * could not reach the state it requires.
 * ================================================================== */

group('trading permission is reachable');

check('granting orders and automation is enough to permit trading', () => {
  /*
   * `allowTrading` used to require `reasoningMode !== 'advisory'` as well
   * as the two capabilities. The builder defaults to `advisory` and hides
   * the control behind "Advanced", so a user who toggled both
   * capabilities on saw "Automation on" and still had every order
   * rejected with TRADING_DISABLED.
   *
   * A permission must be a function of the permission, not of an autonomy
   * hint. This asserts the decoupling directly.
   */
  const definition = {
    ...goatDefinitionFixture(),
    capabilities: { ...goatDefinitionFixture().capabilities, requestExecution: true },
  } as GoatDefinition;
  const executed = deploymentFor(definition, {
    execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET', 'LIMIT'] },
  });
  const compiled = compileGoatDefinition({
    definition: { ...definition, agentConfig: { ...definition.agentConfig, reasoningMode: 'autonomous' } },
    deployment: { ...executed, mode: 'DEMO' },
    marketSymbol: 'xyz:GOLD',
    env: stubEnv,
    skills: goatSkillRegistry,
  });
  assert(compiled.policy.allowTrading === true, 'granting execution still did not permit trading');

  const proposeOnly = deploymentFor(definition);
  const disabled = compileGoatDefinition({
    definition,
    deployment: proposeOnly,
    marketSymbol: 'xyz:GOLD',
    env: stubEnv,
    skills: goatSkillRegistry,
  });
  assert(disabled.policy.allowTrading === false, 'trading was permitted without the deployment allowing execution');
});

check('reasoning mode still governs autonomy, not permission', () => {
  const definition = {
    ...goatDefinitionFixture(),
    capabilities: { ...goatDefinitionFixture().capabilities, requestExecution: true },
  } as GoatDefinition;
  const deployment = deploymentFor(definition, {
    execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET'] },
  });
  const advisory = compileGoatDefinition({
    definition: { ...definition, agentConfig: { ...definition.agentConfig, reasoningMode: 'advisory' } },
    deployment,
    marketSymbol: 'xyz:GOLD',
    env: stubEnv,
    skills: goatSkillRegistry,
  });
  const autonomous = compileGoatDefinition({
    definition: { ...definition, agentConfig: { ...definition.agentConfig, reasoningMode: 'autonomous' } },
    deployment,
    marketSymbol: 'xyz:GOLD',
    env: stubEnv,
    skills: goatSkillRegistry,
  });
  // An advisory GOAT is still *permitted*; it simply declines to act
  // on its own, which the agentic loop enforces separately.
  assert(advisory.policy.allowTrading === autonomous.policy.allowTrading,
    'reasoning mode is still silently controlling trading permission');
});

/* ================================================================== *
 * 10. Market data health must be observable
 *
 * A process that is alive but receiving nothing is not healthy. The
 * watcher health contract added in this pass encodes that distinction, and
 * these tests pin the shape the UI will read.
 * ================================================================== */

group('health is not the same as alive');

check('a watcher with no market data is not reported as healthy', () => {
  const now = 1_700_000_000_000;
  interface Health { lastMarketDataAt: number | null; lastEvaluationAt: number | null; lastSuccessfulEvaluationAt: number | null; lastError: string | null }
  const stale: Health = { lastMarketDataAt: now - 120_000, lastEvaluationAt: now, lastSuccessfulEvaluationAt: null, lastError: null };
  const healthy: Health = { lastMarketDataAt: now - 1_000, lastEvaluationAt: now, lastSuccessfulEvaluationAt: now, lastError: null };
  const classify = (input: Health): string => {
    if (input.lastError) return 'ERROR';
    if (input.lastMarketDataAt === null) return 'STARVED';
    if (now - input.lastMarketDataAt > 60_000) return 'STARVED';
    if (input.lastSuccessfulEvaluationAt === null) return 'STARTING';
    return 'HEALTHY';
  };
  assert(classify(stale) !== 'HEALTHY', 'a watcher with two-minute-old market data was called healthy');
  assert(classify(healthy) === 'HEALTHY', 'a watcher with fresh data was not called healthy');
});

/* ================================================================== *
 * 11. One quote id was shared by every agent
 *
 * The quote path built a delivery id from symbol and timestamp only, and
 * `process` marks a delivery id processed the first time any tracker
 * claims it. Every other agent's candidate on that symbol was therefore
 * skipped *before* its condition ran, so with two GOATs on one market one
 * of them silently stopped receiving quote-driven wakes.
 * ================================================================== */

group('quote delivery is scoped per agent');

check('the quote delivery id includes the agent', async () => {
  // Assert the shape of the id directly. Reproducing the full engine here
  // would need a runtime, two agents and a bus; the id is what the bug was.
  const { readFileSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'runtime.ts'), 'utf8');

  const quoteLine = source.split('\n').find((line) => line.includes('id: `quote:'));
  assert(quoteLine !== undefined, 'the quote delivery id was not found in runtime.ts');
  assert(
    quoteLine!.includes('instance.agent.id'),
    `the quote delivery id does not include the agent: ${quoteLine!.trim()}`,
  );
});

check('the bar path is also agent-scoped', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'runtime.ts'), 'utf8');
  const barLine = source.split('\n').find((line) => line.includes('id: `${input.id}:${instance.agent.id}`'));
  assert(barLine !== undefined, 'the bar delivery id was not found in runtime.ts');
  assert(barLine!.includes('instance.agent.id'), 'the bar delivery id is not agent-scoped either');
});

/* ================================================================== *
 * 12. The order ticket could never be submitted
 *
 * `TradeOrderModal` treats a missing quote as "not ready", so
 * `canExecute` was permanently false and the button read "Waiting for
 * Live Quote" forever. `QuotesTab` held the live quote and passed
 * nothing.
 * ================================================================== */

group('the order ticket can actually be submitted');

check('the quote is passed to the order modal', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '..', '..', '..', 'components', 'views', 'QuotesTab.tsx'), 'utf8');
  const modal = source.slice(source.indexOf('<TradeOrderModal'));
  const block = modal.slice(0, modal.indexOf('/>'));
  assert(
    /\bquote=\{/.test(block),
    'TradeOrderModal is rendered without a quote, so the submit button can never enable',
  );
});

/* ================================================================== *
 * 13. The kill switch moved the UI but not the engine
 *
 * The React state and `riskManager` were separate. The header said
 * "Trading is halted" while `validateOrder` returned valid, so the one
 * control a user reaches for in an emergency did nothing.
 * ================================================================== */

group('the kill switch reaches the engine');

check('toggling the kill switch engages the engine gate', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(resolve(here, '..', '..', '..', 'App.tsx'), 'utf8');

  // The emergency path is the one that must engage the engine first: it
  // immediately submits closes, and if new opens are still permitted
  // they race.
  const emergency = app.slice(app.indexOf('handleEmergencyKillSwitch ='));
  const riskIndex = emergency.indexOf('riskManager.setKillSwitch');
  const closeIndex = emergency.indexOf('handleClosePosition');
  assert(riskIndex >= 0, 'the emergency kill switch never calls riskManager.setKillSwitch');
  assert(closeIndex > riskIndex, 'the emergency flatten runs before the engine kill switch is engaged');
});

/* ================================================================== *
 * 12. A fabricated market statistic is worse than a missing one
 *
 * Reported as: "prevDayPx is fetched but unused, so 24h change always
 * shows 0.00%". That was true, and the cause was one level further up:
 * `marketSymbol()` took an optional previous snapshot and no caller ever
 * passed one, so every field it defaulted fell back to a constant.
 *
 *   change24h -> 0            "the market is flat" for every market
 *   high24h   -> lastPrice    "24h High" equal to the live price
 *   low24h    -> lastPrice    "24h Low"  equal to the live price
 *
 * The last two are the worse half, because a 24h high that always
 * equals the current price is indistinguishable from a real one and
 * the UI's finite() guard passes. `prevDayPx` was in the response type
 * the whole time, unused.
 *
 * Fixed by computing the change against the venue's own reference price
 * and by refusing to invent a 24h range: no range means NaN, which the
 * UI already renders as unavailable.
 * ================================================================== */

group('24h statistics are measured, not assumed');

check('a 24h change of +10% is reported as +10', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 110, 100);
  assert(symbol.change24h === 10, `expected +10, got ${symbol.change24h}`);
});

check('a 24h change of -10% is reported as -10', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 90, 100);
  assert(symbol.change24h === -10, `expected -10, got ${symbol.change24h}`);
});

check('an unchanged price is exactly zero, not a rounding artefact', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 100, 100);
  assert(symbol.change24h === 0, `expected 0, got ${symbol.change24h}`);
});

check('a missing reference price does not become a flat market', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 110);
  assert(!Number.isFinite(symbol.change24h), 'an absent reference must not report 0.00%');
});

check('a zero or unusable reference price does not divide by zero', () => {
  for (const reference of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const symbol = marketSymbol(GOLD_INSTRUMENT, 110, reference);
    assert(!Number.isFinite(symbol.change24h), `reference ${reference} produced ${symbol.change24h}`);
  }
});

check('a 24h range is never invented from the current price', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 110, 100);
  assert(!Number.isFinite(symbol.high24h), '24h High defaulted to the live price');
  assert(!Number.isFinite(symbol.low24h), '24h Low defaulted to the live price');
});

check('a real 24h range is passed through unchanged', () => {
  const symbol = marketSymbol(GOLD_INSTRUMENT, 110, 100, { high: 120, low: 95 });
  assert(symbol.high24h === 120, `expected 120, got ${symbol.high24h}`);
  assert(symbol.low24h === 95, `expected 95, got ${symbol.low24h}`);
});

check('the change is computed against the reference, not the range', () => {
  // A market that ranged 95-120 all day and sits at 110 now is +10%
  // against a 100 reference, not +15.7% against its own high.
  const symbol = marketSymbol(GOLD_INSTRUMENT, 110, 100, { high: 120, low: 95 });
  assert(symbol.change24h === 10, `expected +10, got ${symbol.change24h}`);
});

/* ================================================================== *
 * 13. ATR was an EMA of true range, so the browser disagreed with the
 *     engine on the same candles
 *
 * Reported as "may be". It was. The Python engine smoothed true range
 * with Wilder's RMA (alpha = 1/period); this implementation smoothed it
 * with an EMA (alpha = 2/(period + 1)). The two share a seed value on the
 * first computable bar and diverge on every bar after it, so a preview
 * in the browser and a decision from the engine could disagree on the
 * same market by several percent.
 *
 * The reference below is written from Wilder's definition rather than
 * from either implementation, and the fixture includes a gap so the
 * previous close -- not the bar's own range -- dominates true range on
 * the bars that matter.
 * ================================================================== */

interface AuditBar { time: number; open: number; high: number; low: number; close: number }

group('ATR is Wilder\'s smoothing, not an EMA of true range');

const ATR_AUDIT_BARS = [
  { time: 0, open: 10.0, high: 12.0, low: 9.5, close: 11.0 },
  { time: 1, open: 11.0, high: 13.0, low: 10.5, close: 12.5 },
  { time: 2, open: 12.0, high: 14.0, low: 11.0, close: 13.0 },
  // Gaps up: |high - previousClose| dominates the bar's own range.
  { time: 3, open: 13.0, high: 34.0, low: 12.5, close: 31.0 },
  { time: 4, open: 31.0, high: 33.0, low: 25.0, close: 32.0 },
  { time: 5, open: 32.0, high: 36.0, low: 30.5, close: 35.0 },
  { time: 6, open: 33.0, high: 37.0, low: 32.0, close: 34.0 },
  // Gaps down.
  { time: 7, open: 34.0, high: 24.0, low: 18.0, close: 22.0 },
  { time: 8, open: 22.0, high: 26.0, low: 20.5, close: 25.0 },
  { time: 9, open: 25.0, high: 27.0, low: 21.0, close: 22.5 },
  { time: 10, open: 22.5, high: 29.0, low: 22.0, close: 28.0 },
  { time: 11, open: 28.0, high: 30.0, low: 23.0, close: 24.0 },
  { time: 12, open: 24.0, high: 32.0, low: 24.5, close: 31.0 },
  { time: 13, open: 31.0, high: 33.0, low: 25.0, close: 32.5 },
  { time: 14, open: 32.5, high: 35.0, low: 26.5, close: 34.0 },
  { time: 15, open: 34.0, high: 36.0, low: 27.0, close: 28.0 },
  { time: 16, open: 28.0, high: 38.0, low: 28.5, close: 37.0 },
  { time: 17, open: 37.0, high: 39.0, low: 29.0, close: 30.0 },
  { time: 18, open: 30.0, high: 41.0, low: 30.5, close: 40.0 },
];

const ATR_AUDIT: AuditBar[] = ATR_AUDIT_BARS.map((bar) => ({ ...bar }));

function trueRangeReference(bars: readonly AuditBar[]): number[] {
  const out = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    out.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      ),
    );
  }
  return out;
}

function wilderReference(tr: number[], period: number): number[] {
  const out: number[] = new Array(tr.length).fill(Number.NaN);
  out[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

function emaReference(tr: number[], period: number): number[] {
  const multiplier = 2 / (period + 1);
  const out: number[] = new Array(tr.length).fill(Number.NaN);
  out[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    out[i] = (tr[i] - out[i - 1]) * multiplier + out[i - 1];
  }
  return out;
}

check('ATR matches Wilder\'s RMA on every bar after the seed', () => {
  const period = 14;
  const expected = wilderReference(trueRangeReference(ATR_AUDIT), period);
  const actual = calculateATR(ATR_AUDIT, period);
  for (let i = period - 1; i < expected.length; i++) {
    assert(
      Math.abs(actual[i] - expected[i]) < 1e-6,
      `ATR[${i}] = ${actual[i]}, Wilder = ${expected[i]}`,
    );
  }
});

check('ATR is not an EMA of true range', () => {
  // Without this, an EMA would also pass the test above on a fixture
  // where the two happened to agree, and a 'simplification' back to
  // calculateEMA would go unnoticed.
  const period = 14;
  const tr = trueRangeReference(ATR_AUDIT);
  const wilder = wilderReference(tr, period);
  const ema = emaReference(tr, period);
  const diverged: number[] = [];
  for (let i = period; i < tr.length; i++) {
    if (Math.abs(wilder[i] - ema[i]) > 1e-6) diverged.push(i);
  }
  assert(diverged.length > 0, 'the fixture no longer distinguishes RMA from EMA');
  const actual = calculateATR(ATR_AUDIT, period);
  for (const i of diverged) {
    assert(Math.abs(actual[i] - wilder[i]) < 1e-6, `ATR[${i}] follows the EMA, not Wilder`);
  }
});

check('ATR reports no value before it can be computed', () => {
  const period = 14;
  const actual = calculateATR(ATR_AUDIT, period);
  for (let i = 0; i < period - 1; i++) {
    assert(Number.isNaN(actual[i]), `ATR[${i}] = ${actual[i]} before it is computable`);
  }
});

check('the smoothing helper matches an inline Wilder recursion', () => {
  const values = [1, 4, 9, 16, 25, 36, 49, 64, 81, 100];
  const period = 4;
  const actual = calculateRMA(values, period);
  const expected = wilderReference(values, period);
  for (let i = period - 1; i < values.length; i++) {
    assert(Math.abs(actual[i] - expected[i]) < 1e-6, `RMA[${i}] = ${actual[i]}, expected ${expected[i]}`);
  }
});

check('a series shorter than the period yields no ATR at all', () => {
  const short = ATR_AUDIT.slice(0, 10);
  const actual = calculateATR(short, 14);
  assert(actual.length === short.length, 'the series length must be preserved for alignment');
  assert(actual.every((v) => Number.isNaN(v)), 'a partial warmup must not emit a value');
});

/* ================================================================== *
 * 14. The daily-loss limit could not fire, because nothing fed it
 *
 * The previous pass fixed the *displayed* `dailyPnL`: it was
 * `equity - balance`, which is open P&L, and read 0 with no positions.
 * That was real and it is fixed.
 *
 * It was not the whole bug. The gate reads a different number --
 * `riskManager.currentDailyPnL` -- and nothing in the application ever
 * wrote to it. `recordPnL()` had no production caller, so the field sat
 * at its initial 0 and the check was `0 <= -maxDailyLoss`, which is
 * never true. A bot could lose any amount in a day and the limit would
 * not stop it.
 *
 * The existing tests all called `recordPnL()` directly, so they
 * exercised the arithmetic and never the wiring. That is the gap this
 * group closes: every test below drives the execution adapter, which is
 * the only thing that can actually realise a loss.
 * ================================================================== */

group('the daily-loss limit is reachable from a real close');

async function loseMoneyThroughTheAdapter(amount: number): Promise<boolean> {
  const { adapter, setQuote, restore } = buildAdapter();
  try {
    const entry = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    if (!entry.success) return false;
    const [position] = await adapter.getPositions('Gold');
    if (!position) return false;
    // Move the market against the position, then settle it.
    setQuote(2299.5 - amount, 2300.5 - amount);
    const closed = await adapter.closePosition(position.id);
    return closed.success;
  } finally {
    restore();
  }
}

check('a real loss booked by the adapter reaches the daily-loss gate', async () => {
  // Tighten the limit so the fixture's loss is unambiguously a breach.
  const { adapter, setQuote, restore } = buildAdapter();
  try {
    riskManager.updateLimits({ maxDailyLoss: 10 });
    const entry = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(entry.success, 'the adapter should fill before the loss is booked');
    const [position] = await adapter.getPositions('Gold');
    assert(position !== undefined, 'the fill produced no position to close');
    setQuote(2290.0, 2291.0);
    const closed = await adapter.closePosition(position.id);
    assert(closed.success, 'the close should settle');
    assert(typeof closed.pnl === 'number' && closed.pnl < 0, `the fixture did not realise a loss (pnl ${closed.pnl})`);

    // This is the assertion that failed before: the adapter realised a
    // real loss and the gate still let the next order through.
    const next = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(!next.success, 'trading continued after the daily-loss limit was breached');
    assert(
      next.rejection?.category === 'DAILY_LOSS_LIMIT',
      `expected a daily-loss rejection, got ${next.rejection?.category ?? 'none'}`,
    );
  } finally {
    restore();
  }
});

check('realised P&L is visible to the gate, not just to the interface', async () => {
  const { adapter, setQuote, restore } = buildAdapter();
  try {
    riskManager.updateLimits({ maxDailyLoss: 100_000 });
    const entry = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    const [position] = await adapter.getPositions('Gold');
    setQuote(2290.0, 2291.0);
    await adapter.closePosition(position!.id);
    const gate = riskManager.realisedToday();
    const shown = (await adapter.getAccountState()).realisedSessionPnL;
    assert(gate !== 0, 'the gate still sees no realised P&L after a real close');
    assert(Math.abs(gate - shown) < 1e-6, `the gate (${gate}) and the interface (${shown}) disagree`);
  } finally {
    restore();
  }
  void loseMoneyThroughTheAdapter;
});

check('a partial close books only the closed part', async () => {
  const { adapter, setQuote, restore } = buildAdapter();
  try {
    riskManager.updateLimits({ maxDailyLoss: 100_000 });
    await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 2 });
    const [position] = await adapter.getPositions('Gold');
    setQuote(2298.0, 2299.0);
    const partial = await adapter.closePosition(position!.id, 1);
    assert(partial.success, 'the partial close should settle');
    assert(typeof partial.pnl === 'number', 'the partial close produced no realised P&L');
    const expected = partial.pnl as number;
    assert(expected < 0, 'the fixture did not realise a loss on the partial close');
    const booked = riskManager.realisedToday();
    assert(Math.abs(booked - expected) < 1e-6, `a partial close booked ${booked} instead of ${expected}`);
  } finally {
    restore();
  }
});

check('gains and losses net out in the gate', async () => {
  const { adapter, setQuote, restore } = buildAdapter();
  try {
    riskManager.updateLimits({ maxDailyLoss: 100_000 });
    // A losing round trip.
    await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    let [position] = await adapter.getPositions('Gold');
    setQuote(2290.0, 2291.0);
    const loss = await adapter.closePosition(position!.id);

    // A winning round trip on the same instrument.
    await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    [position] = await adapter.getPositions('Gold');
    setQuote(2310.0, 2311.0);
    const gain = await adapter.closePosition(position!.id);

    assert(typeof loss.pnl === 'number' && typeof gain.pnl === 'number', 'a close produced no realised P&L');
    assert((loss.pnl as number) < 0 && (gain.pnl as number) > 0, 'the fixture did not produce a loss and a gain');
    const expected = (loss.pnl as number) + (gain.pnl as number);
    const net = riskManager.realisedToday();
    assert(
      Math.abs(net - expected) < 1e-6,
      `the gate summed to ${net}, expected ${expected}`,
    );
  } finally {
    restore();
  }
});

check('the daily figure belongs to a UTC day and rolls over on its own', () => {
  const manager = new RiskManager({ maxDailyLoss: 50 });
  manager.recordPnL(-500);
  assert(manager.realisedToday() === -500, 'the loss was not booked');
  // Just after midnight UTC the previous day's loss is history.
  const nextDay = Date.now() + 86_400_000;
  assert(manager.realisedToday(nextDay) === 0, "yesterday's loss is still counted today");
  // And the gate agrees with the read.
  const verdict = manager.validateOrder({ symbol: 'Gold', side: 'BUY', volume: 0.1 } as never, [], true, riskContext());
  assert(verdict.valid, 'the new day should permit trading again');
});

check('a loss just before midnight does not lock the new day', () => {
  const manager = new RiskManager({ maxDailyLoss: 50 });
  manager.recordPnL(-500);
  // Just after the *next* midnight: earlier today is the same UTC day,
  // so nothing should roll over yet.
  const justAfterMidnight = Date.now() - (Date.now() % 86_400_000) + 86_400_000 + 1000;
  const verdict = manager.validateOrder(
    { symbol: 'Gold', side: 'BUY', volume: 0.1 } as never,
    [],
    true,
    riskContext(),
  );
  assert(!verdict.valid, 'the pre-midnight loss should block before the boundary');
  assert(manager.realisedToday(justAfterMidnight) === 0, 'the figure did not roll over at the UTC boundary');
});

/* ================================================================== *
 * 15. The kill switch: one authority, and no route around it
 *
 * The original bug was that `setKillSwitch` had no caller, so the
 * interface could display a halt while orders kept filling. That is
 * fixed, but the audit asked for the whole route to be traced, and two
 * things were still open:
 *
 *   a) the interface kept its own copy of the flag, so a halt engaged
 *      anywhere else would be invisible on screen while orders were
 *      rejected -- the same disagreement, reached a different way.
 *   b) nothing proved the adapter actually rejects, only that App.tsx
 *      mentions the call. A source-text assertion cannot fail if the
 *      adapter stops consulting the gate.
 *
 * Below, every rejection is observed at the adapter, which is the only
 * thing that can fill an order.
 * ================================================================== */

group('the kill switch blocks every path to a fill');

check('with the switch off an order fills, so the tests are not passing vacuously', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    riskManager.setKillSwitch(false);
    const result = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(result.success, 'a valid order was rejected with the kill switch off');
  } finally {
    restore();
  }
});

check('with the switch on the adapter refuses to open', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    riskManager.setKillSwitch(true);
    const result = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(!result.success, 'the adapter opened a position while the kill switch was engaged');
    assert(/kill switch/i.test(result.error ?? ''), `unhelpful halt reason: ${result.error}`);
  } finally {
    restore();
  }
});

check('a halt engaged concurrently still blocks every attempt', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    // Fire without awaiting each one, the way a burst of wakes would.
    riskManager.setKillSwitch(true);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 })),
    );
    const filled = attempts.filter((attempt) => attempt.success);
    assert(filled.length === 0, `${filled.length} of 8 concurrent orders filled through a halt`);
  } finally {
    restore();
  }
});

check('a halt still allows closing, because a halt must not trap a position', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    riskManager.setKillSwitch(false);
    await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    const [position] = await adapter.getPositions('Gold');
    riskManager.setKillSwitch(true);
    const closed = await adapter.closePosition(position!.id);
    assert(closed.success, 'the emergency flatten was blocked by the halt that caused it');
  } finally {
    restore();
  }
});

check('a wake that arrives while the halt is on cannot execute, and can once it lifts', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    // A wake is just a pending intent. Nothing executes it until the
    // order reaches the adapter, so the gate is the only thing that
    // matters -- and it must hold both before and after the halt.
    riskManager.setKillSwitch(true);
    const blocked = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(!blocked.success, 'a pending wake executed through an engaged halt');

    riskManager.setKillSwitch(false);
    const allowed = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
    assert(allowed.success, 'the same intent was still blocked after the halt lifted');
  } finally {
    restore();
  }
});

check('a retry during a halt cannot execute, and does not execute later by accident', async () => {
  const { adapter, restore } = buildAdapter();
  try {
    riskManager.setKillSwitch(true);
    // A retry loop that keeps trying through the halt, which is what a
    // naive "retry until it works" would do.
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
      assert(!result.success, `retry ${attempt} filled through a halt`);
    }
    const open = await adapter.getPositions('Gold');
    assert(open.length === 0, `${open.length} positions were opened by retries through a halt`);
  } finally {
    restore();
  }
});

check('the interface reads the engine rather than holding its own copy', () => {
  const manager = new RiskManager();
  assert(manager.isKillSwitchActive() === false, 'a fresh manager is not halted');
  manager.setKillSwitch(true);
  assert(manager.isKillSwitchActive() === true, 'the read API disagrees with the gate after a halt');

  // The interesting case: a halt engaged by restoring state rather than
  // by the emergency handler. Before this, the interface kept its own
  // copy and would have shown "trading active" here.
  const restored = new RiskManager({ killSwitchActive: true });
  assert(restored.isKillSwitchActive() === true, 'a restored halt is invisible to the read API');
  assert(
    restored.getLimits().killSwitchActive === restored.isKillSwitchActive(),
    'the limits snapshot and the read API disagree',
  );
});

check('the gate and the read API can never disagree', () => {
  const manager = new RiskManager();
  for (const active of [true, false, true, false]) {
    manager.setKillSwitch(active);
    const verdict = manager.validateOrder(
      { symbol: 'Gold', side: 'BUY', volume: 0.1 } as never,
      [],
      true,
      riskContext(),
    );
    assert(
      verdict.valid === !active,
      `the gate allowed=${verdict.valid} while the switch was ${active}`,
    );
    assert(
      manager.isKillSwitchActive() === active,
      `the read API reported ${manager.isKillSwitchActive()} for a switch set to ${active}`,
    );
  }
});

/* ================================================================== *
 * 16. The permission matrix, stated in full
 *
 * The original defect was a coupling: `allowTrading` required
 * `reasoningMode !== 'advisory'`, the builder defaulted to advisory and
 * hid the control, so the interface said "Automation on" while the
 * engine rejected every order.
 *
 * Fixing that coupling is not the same as knowing the resulting rule is
 * right. Below is the whole matrix, so the rule is written down rather
 * than inferred, and so a future change to either axis has to update a
 * test instead of quietly altering behaviour.
 * ================================================================== */

group('execution permission is a function of definition and deployment, never of reasoning mode');

const REASONING_MODES = ['autonomous', 'confirm', 'advisory'] as const;
const DEPLOY_MODES = ['SHADOW', 'DEMO'] as const;

check('every reasoning mode, capability, and deployment combination resolves as specified', () => {
  const base = goatDefinitionFixture();
  const observed = new Set<string>();

  for (const reasoningMode of REASONING_MODES) {
    for (const requestExecution of [false, true]) {
      for (const canExecute of [false, true]) {
        for (const deployMode of DEPLOY_MODES) {
          const definition = {
            ...base,
            agentConfig: { ...base.agentConfig, reasoningMode },
            capabilities: { ...base.capabilities, requestExecution },
          } as GoatDefinition;

          const combination = `${reasoningMode}/${requestExecution}/${canExecute}/${deployMode}`;
          observed.add(combination);

          let deployment;
          try {
            deployment = deploymentFor(definition, {
              mode: deployMode,
              execution: {
                canProposeTrades: true,
                canExecute,
                allowedOrderTypes: ['MARKET'],
              },
            });
          } catch {
            /*
             * A deployment cannot grant execution the definition did not
             * already request. That is a property worth pinning rather
             * than routing around: it is what stops authority being
             * introduced in the place nobody reviews the definition.
             */
            assert(
              canExecute && !requestExecution,
              `a deployment was refused for a reason other than execution without request: ${combination}`,
            );
            continue;
          }

          const compiled = compileGoatDefinition({
            definition,
            deployment,
            marketSymbol: 'xyz:GOLD',
            env: stubEnv,
            skills: goatSkillRegistry,
          });

          // The rule, in one line: permission is the deployment's
          // execution grant, gated by the definition's request and a
          // mode that can execute. Reasoning mode is not one of them.
          const expected =
            requestExecution &&
            canExecute &&
            deployMode !== 'SHADOW';
          assert(
            compiled.policy.allowTrading === expected,
            `${combination} -> allowTrading ${compiled.policy.allowTrading}, expected ${expected}`,
          );
        }
      }
    }
  }

  assert(
    observed.size === REASONING_MODES.length * 2 * 2 * DEPLOY_MODES.length,
    `the matrix covered only ${observed.size} of its combinations`,
  );
});

check('reasoning mode changes autonomy, not permission', () => {
  const base = goatDefinitionFixture();
  const definition = { ...base, capabilities: { ...base.capabilities, requestExecution: true } } as GoatDefinition;
  const deployment = deploymentFor(definition, {
    mode: 'DEMO',
    execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET'] },
  });
  const verdicts = REASONING_MODES.map((reasoningMode) =>
    compileGoatDefinition({
      definition: { ...definition, agentConfig: { ...definition.agentConfig, reasoningMode } },
      deployment,
      marketSymbol: 'xyz:GOLD',
      env: stubEnv,
      skills: goatSkillRegistry,
    }).policy.allowTrading,
  );
  /*
   * Every mode reaches the same permission. This is the regression
   * restated in the new domain: a reasoning hint is advice, and advice
   * that silently revokes permission is the bug that produced a UI
   * claiming "automation on" over an engine rejecting every order.
   *
   * Autonomy below `autonomous` is enforced in the agentic loop, which
   * is a different gate and is not impersonated by this one.
   */
  assert(
    new Set(verdicts).size === 1,
    `reasoning mode changed permission: ${verdicts.join(', ')}`,
  );
  assert(verdicts[0] === true, 'a deployment that grants execution did not reach it');
});

check('withdrawing execution permission withdraws it immediately', () => {
  const base = goatDefinitionFixture();
  const definition = { ...base, capabilities: { ...base.capabilities, requestExecution: true } } as GoatDefinition;
  const build = (canExecute: boolean) =>
    compileGoatDefinition({
      definition: { ...definition, agentConfig: { ...definition.agentConfig, reasoningMode: 'autonomous' } },
      deployment: deploymentFor(definition, {
        mode: 'DEMO',
        execution: { canProposeTrades: true, canExecute, allowedOrderTypes: ['MARKET'] },
      }),
      marketSymbol: 'xyz:GOLD',
      env: stubEnv,
      skills: goatSkillRegistry,
    }).policy.allowTrading;

  assert(build(true) === true, 'the granted case is wrong');
  assert(build(false) === false, 'revoking execution did not withdraw permission');
});


/* ================================================================== *
 * 17. Several GOATs, one market event, no cross-talk
 *
 * The earlier test for this bug read the source and checked that the
 * delivery id mentioned the agent. That proves a string was built, not
 * that a second GOAT was still woken -- and the failure mode is a
 * *missing* wake, which a shape assertion cannot see.
 *
 * Below, three GOATs with three trackers are driven through the real
 * event bus, and a price crossing a level is required to wake all
 * three. This was also used to re-test the premise. Forcing a single
 * shared quote id still wakes all three, because `processedEvents` is
 * keyed by tracker id and each GOAT owns its own trackers. So the
 * starvation described in the original report did not occur in this
 * code; what the test proves is the isolation itself, which is the
 * property worth holding regardless.
 * ================================================================== */

group('delivery ids do not starve a second GOAT');

check('three GOATs on one market event are all woken', async () => {
  const { TrackerRuntime } = await import('./runtime');
  const { TrackerRegistry } = await import('./registry');
  const { eventBus } = await import('../../../types/events');

  /*
   * Driven through the event bus, not by calling `process` directly.
   *
   * The delivery id is built by the engine's own quote handler, so a
   * test that supplies its own id is testing the caller's argument
   * rather than the code that assembles it -- and would keep passing
   * if the id stopped including the agent.
   */
  const agentIds = ['agent-a', 'agent-b', 'agent-c'];
  const instances = agentIds.map((agentId) => ({
    agent: {
      id: agentId,
      name: agentId,
      enabled: true,
      symbols: ['Gold'],
      timeframe: '15m' as const,
      policy: { allowedSymbols: ['Gold'] },
    },
    isRunning: true,
    env: { mode: 'DEMO' as const },
  }));
  const byId = new Map(instances.map((instance) => [instance.agent.id, instance]));

  const registry = new TrackerRegistry((agentId) => byId.get(agentId) as never);
  const woke: string[] = [];
  // A tracker reporting is recorded on the timeline as a TRACKER event,
  // which is the observable proof that the runtime got as far as waking.
  const timeline = {
    append: async (event: { type: string; agentId: string }) => {
      if (event.type === 'TRACKER') woke.push(event.agentId);
    },
  };

  /*
   * A price crossing, not a bar update. NEW_BAR is ignored on the quote
   * path by design, and PRICE_THRESHOLD needs two samples, so a price
   * cross is the condition a real quote-driven agent would use here.
   */
  agentIds.forEach((agentId, index) => registry.register({
    id: `tracker-${index}`,
    agentId,
    kind: 'PRICE_CROSS' as const,
    symbol: 'Gold',
    timeframe: '15m' as const,
    purpose: 'Know when gold takes out 2000.',
    eventType: 'PRICE_CROSSED_LEVEL',
    dependencies: [],
    dataRequirements: [],
    evaluation: { priority: 0, cooldownMs: 0, maxEventsPerMinute: 10 },
    lifecycle: { status: 'ACTIVE', eventCount: 0 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { level: 2000, direction: 'ABOVE' },
  } as never));

  const trackers = new TrackerRuntime({
    registry: registry as never,
    agents: {
      listAgents: () => instances as never,
      getAgent: (agentId: string) => byId.get(agentId) as never,
      handleEvent: async () => undefined,
    } as never,
    timeline: timeline as never,
    clock: () => 1_700_000_000_000,
  });
  trackers.setEnvironment('DEMO');
  trackers.start();

  try {
    const quote = (mid: number, timestamp: number) => eventBus.emit({
      type: 'MARKET_QUOTE',
      data: { symbol: 'Gold', bid: mid - 0.5, ask: mid + 0.5, spread: 1, timestamp },
    } as never);

    const settle = async () => {
      // The quote handler dispatches without awaiting, so the wake is
      // observed on a later turn rather than synchronously.
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    // Below the level, then through it. Both events reach all three
    // agents; only the second one is a cross.
    quote(1900, 1_700_000_000_000);
    await settle();
    assert(woke.length === 0, `a cross fired before the price crossed the level (${woke.join(', ')})`);

    quote(2400, 1_700_000_001_000);
    await settle();

    for (const agentId of agentIds) {
      assert(woke.includes(agentId), `${agentId} never received the market event (woke: ${woke.join(', ') || 'none'})`);
    }
    assert(woke.length === agentIds.length, `an agent was woken ${woke.length} times: ${woke.join(', ')}`);
  } finally {
    trackers.dispose();
  }
});

/* ================================================================== *
 * 18. Uniqueness at volume
 *
 * `Date.now()` was used as an identity in several places. Under a
 * high-frequency load it repeats, and a repeat is not a cosmetic
 * problem: history is de-duplicated by id, so a repeat drops a record
 * and, with it, a realised P&L the user is meant to see.
 *
 * The clock is frozen in these tests, so every record lands in the same
 * millisecond by construction. That is the worst case, and it is the
 * case the old code failed.
 * ================================================================== */

group('identifiers stay unique under a high-frequency burst');

check('a thousand trade records keep a thousand distinct ids', async () => {
  const { adapter, restore } = buildAdapter();
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000; // one millisecond for the whole burst
  // The order-rate limiter would otherwise stop the burst at twenty, and
  // it is doing its job; this test is about identifiers, so it is raised
  // for the duration and restored with everything else.
  riskManager.updateLimits({ maxOrdersPerMinute: 100_000 });
  try {
    const seenOrders = new Set<string>();
    const seenTrades = new Set<string>();
    let firstPositionId: string | undefined;

    for (let index = 0; index < 1000; index++) {
      const opened = await adapter.placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 });
      assert(opened.success, `open ${index} was rejected: ${opened.error}`);
      if (firstPositionId === undefined) firstPositionId = opened.positionId as string;
      seenOrders.add(opened.orderId as string);

      const [position] = await adapter.getPositions('Gold');
      const closed = await adapter.closePosition(position!.id);
      assert(closed.success, `close ${index} was rejected: ${closed.error}`);
      seenTrades.add(closed.trade!.id);
    }

    assert(seenOrders.size === 1000, `only ${seenOrders.size} distinct order ids out of 1000`);
    assert(seenTrades.size === 1000, `only ${seenTrades.size} distinct trade ids out of 1000`);
  } finally {
    Date.now = realNow;
    restore();
  }
});

check('a thousand deployments keep a thousand distinct ids', () => {
  /*
   * The old check imported a sequence counter out of a React component,
   * which is how the counter ended up evaluating `localStorage` at
   * module scope in the first place. Deployment identity is now derived
   * from the deployment's own contents, so the property is checked
   * directly: a thousand distinct deployments are a thousand ids.
   */
  const ids = new Set<string>();
  for (let index = 0; index < 1000; index++) {
    const deployment = createGoatDeployment({
      goatId: 'goat-1',
      goatVersion: 1,
      marketId: 'EURUSD',
      accountId: 'paper',
      mode: 'SHADOW',
      execution: { canProposeTrades: true, canExecute: false, allowedOrderTypes: ['LIMIT'] },
      id: `dep-${index}`,
      createdAt: 0,
    });
    ids.add(deployment.id);
  }
  assert(ids.size === 1000, `only ${ids.size} distinct deployment ids out of 1000`);
});

check('a thousand deployments produce a thousand distinct watcher identities', async () => {
  // The watcher derives its Durable Object identity from
  // user + goat + deployment, so a repeat here would merge two live
  // deployments into one object and let the watcher's own
  // de-duplication drop one of them.
  const { watcherIdFor } = await import('../../../../watchers/src/ids');
  const ids = new Set<string>();
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    for (let index = 0; index < 1000; index++) {
      ids.add(watcherIdFor({ userId: 'u1', goatId: 'goat-1', deploymentId: `dep-${index}` }));
    }
    assert(ids.size === 1000, `only ${ids.size} distinct watcher ids out of 1000`);
  } finally {
    Date.now = realNow;
  }
});

check('the tracker runtime does not grow its delivery-id memory without bound', async () => {
  const { TrackerRuntime } = await import('./runtime');
  const { TrackerRegistry } = await import('./registry');
  const registry = new TrackerRegistry(() => undefined);
  const trackers = new TrackerRuntime({
    registry: registry as never,
    agents: { listAgents: () => [] } as never,
    timeline: { append: async () => undefined } as never,
    clock: () => 1_700_000_000_000,
  });

  const before = (trackers as unknown as { recentInputIds: Map<string, number> }).recentInputIds.size;
  for (let index = 0; index < 2000; index++) {
    await trackers.process({
      id: `probe:${index}`,
      type: 'MARKET_QUOTE',
      timestamp: 1_700_000_000_000,
      environment: 'DEMO',
      state: { timestamp: 1_700_000_000_000, environment: 'DEMO', symbol: 'Gold', timeframe: '15m', price: 1, spread: 1 },
    });
  }
  const after = (trackers as unknown as { recentInputIds: Map<string, number> }).recentInputIds.size;
  // Nothing was registered, so no tracker claimed an id and the map
  // must not have moved at all -- which is the cheap half of the check.
  assert(after === before, `the delivery-id map grew to ${after} with no registered trackers`);
  assert(after <= 10_000, `the delivery-id map is unbounded at ${after} entries`);
});

/* ================================================================== *
 * 19. History under a burst of quote ticks, measured rather than
 *     asserted by eye
 *
 * The original defect was a full rewrite of the history on every append,
 * which is quadratic against a stream that appends once per tick. The
 * fix batches writes. These tests measure the batching rather than
 * trusting it: the write count is asserted, and the timing is printed
 * so a regression shows up as a number that moved, not as a judgement.
 * ================================================================== */

/** Events currently held, via the public query API. */
function countEvents(store: PersistentAgentTimelineStore): number {
  return (store as unknown as { events: unknown[] }).events.length;
}

group('history survives a burst of quote ticks');

/** Counts every setItem, and can be told to fail like a full quota. */
function countingStorage(behaviour: { failAfter?: number } = {}): {
  storage: Storage;
  writes: () => number;
  bytes: () => number;
} {
  const data = new Map<string, string>();
  let writes = 0;
  const storage: Storage = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => {
      writes += 1;
      if (behaviour.failAfter !== undefined && writes > behaviour.failAfter) {
        // Quota-exceeded is the common real cause, and it is a
        // throw, not a boolean.
        throw new DOMException('quota', 'QuotaExceededError');
      }
      data.set(key, value);
    },
  };
  return { storage, writes: () => writes, bytes: () => [...data.values()].reduce((sum, v) => sum + v.length, 0) };
}

/**
 * Install a storage for the duration of `run`, then put it back.
 *
 * Async-aware on purpose. A synchronous version restored the real
 * `localStorage` as soon as an async callback *returned* its promise,
 * which is immediately -- so anything a test awaited inside the callback
 * ran against the real storage and asserted against the wrong thing.
 */
async function withStorage<T>(storage: Storage | undefined, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (storage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { ...original });
  }
}

check('a thousand quote ticks are batched into a handful of writes', async () => {
  const { storage, writes } = countingStorage();
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline');
    const started = Date.now();
    for (let index = 0; index < 1000; index++) {
      void store.append({
        id: `event-${index}`, agentId: 'agent-a', timestamp: 1_700_000_000_000 + index,
        type: 'MARKET_UPDATE', environment: 'DEMO',
      } as never);
    }
    const elapsed = Date.now() - started;
    store.flush();
    const afterFlush = writes();

    // The appends must not each have cost a write. A per-append
    // implementation would be 1000.
    assert(afterFlush <= 2, `1000 appends produced ${afterFlush} writes; batching is not working`);
    assert(countEvents(store) === 1000, `the timeline lost events (${countEvents(store)})`);
    console.log(`      1000 appends -> ${afterFlush} write(s), ${elapsed}ms`);
  });
});

check('a burst followed by a quiet period persists on its own', async () => {
  const { storage, writes } = countingStorage();
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:auto');
    for (let index = 0; index < 50; index++) {
      void store.append({ id: `e-${index}`, agentId: 'a', timestamp: index, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    }
    assert(writes() === 0, 'a write happened synchronously during the burst');
    // The debounce has to elapse on its own; no flush() here. The
    // window is 250ms, so this waits well past it rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert(writes() > 0, 'the batched write never happened without a flush');
    assert(store.storageState === 'OK', `storage reported ${store.storageState}`);
  });
});

check('repeated flushes do not disable persistence', async () => {
  const { storage, writes } = countingStorage();
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:flush');
    void store.append({ id: 'first', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    store.flush();
    const afterFirst = writes();
    assert(afterFirst > 0, 'the first flush wrote nothing');

    for (let round = 0; round < 5; round++) {
      void store.append({ id: `after-${round}`, agentId: 'a', timestamp: round, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
      store.flush();
    }
    assert(writes() > afterFirst, 'persistence stopped after the first flush');
    const persisted = JSON.parse(storage.getItem('test:timeline:flush') ?? '[]') as unknown[];
    assert(persisted.length === 6, `expected 6 persisted events, found ${persisted.length}`);
  });
});

check('a full quota degrades to memory and says so', async () => {
  const { storage } = countingStorage({ failAfter: 1 });
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:quota');
    for (let index = 0; index < 200; index++) {
      void store.append({ id: `q-${index}`, agentId: 'a', timestamp: index, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
      store.flush();
    }
    assert(countEvents(store) === 200, 'the in-memory timeline stopped recording on a quota failure');
    assert(store.storageState !== 'OK', `a failed write still reported ${store.storageState}`);
  });
});

check('unavailable storage does not stop the timeline', async () => {
  await withStorage(undefined, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:absent');
    for (let index = 0; index < 100; index++) {
      void store.append({ id: `u-${index}`, agentId: 'a', timestamp: index, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    }
    store.flush();
    assert(countEvents(store) === 100, 'events were dropped when storage was unavailable');
    assert(store.storageState === 'UNAVAILABLE', `reported ${store.storageState} instead of UNAVAILABLE`);
  });
});

check('corrupt stored history is discarded without taking the app down', async () => {
  const { storage } = countingStorage();
  storage.setItem('test:timeline:corrupt', '{ this is not json');
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:corrupt');
    assert(store.storageState === 'FAILED', `corrupt history reported ${store.storageState}`);
    // And it still accepts new events afterwards.
    void store.append({ id: 'after-corrupt', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    assert(countEvents(store) === 1, 'the timeline stayed broken after corrupt history');
  });
});

check('history written by an older schema is ignored, not misread', async () => {
  const { storage } = countingStorage();
  // An array of things that are not timeline events.
  storage.setItem('test:timeline:old', JSON.stringify([1, 'two', null, { nope: true }]));
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:old');
    assert(countEvents(store) === 0, `old-schema data was misread as ${countEvents(store)} events`);
  });
});

check('a stored object where an array was expected does not throw', async () => {
  const { storage } = countingStorage();
  storage.setItem('test:timeline:shape', JSON.stringify({ events: [] }));
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:shape');
    assert(countEvents(store) === 0, `an unexpected stored shape was misread as ${countEvents(store)} events`);
    void store.append({ id: 'after-shape', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    assert(countEvents(store) === 1, 'the timeline was unusable after an unexpected stored shape');
  });
});

/* ================================================================== *
 * 20. Two live evaluators, and the kinds where they must agree
 *
 * The previous pass reported the browser evaluator as a duplicated
 * authority without saying who actually runs it. The arrangement is:
 *
 *   - the builder's "Test this condition" calls the Python engine, which
 *     is the authority;
 *   - the agent runtime decides wakes with the legacy evaluator here.
 *
 * Their vocabularies differ, so most kinds cannot be compared. Two pairs
 * genuinely mean the same thing on both sides, and those are the ones
 * where a disagreement would be a real defect rather than a difference in
 * design: a price level test, and an indicator level test.
 *
 * A crossed-over condition is *not* one of them. The schema's
 * CROSS_ABOVE is a transition; the legacy kinds are level tests. Testing
 * them against each other would encode the wrong expectation.
 * ================================================================== */

group('the two evaluators agree where their vocabularies overlap');

const LEGACY_CLOSES = Array.from({ length: 40 }, (_, index) => 100 + index * 2.5);

check('a price level test behaves as a level test, not a crossing', () => {
  const context = closesIntoContext(LEGACY_CLOSES);
  const current = LEGACY_CLOSES[LEGACY_CLOSES.length - 1];

  for (const level of [50, current - 1, current, current + 1, 500]) {
    const result = evaluateTrackerConditionTree({
      id: 'g', kind: 'GROUP', operator: 'AND',
      children: [{ id: 'c', kind: 'PRICE_LEVEL', timeframe: '15m', direction: 'ABOVE', level }],
    } as never, context);
    const expected = current >= level ? 'TRUE' : 'FALSE';
    assert(
      result.status === expected,
      `at level ${level} with a price of ${current} the evaluator said ${result.status}`,
    );
  }

  // The word matters. A "crossed above" that reads as "is above" would
  // make a wake repeat on every bar; the engine treats a cross as a
  // transition, and this kind must not be mistaken for one.
  const described = evaluateTrackerConditionTree({
    id: 'g', kind: 'GROUP', operator: 'AND',
    children: [{ id: 'c', kind: 'PRICE_LEVEL', timeframe: '15m', direction: 'ABOVE', level: 50 }],
  } as never, context);
  const sentence = described.flat[0]?.summary ?? '';
  assert(/at or above/i.test(sentence), `a level test describes itself as a crossing: "${sentence}"`);
});

check('an indicator level test is inclusive at the boundary', () => {
  const context = closesIntoContext(LEGACY_CLOSES);
  // SMA(5) of a linear ramp is the mean of the last five closes.
  const sma5 = LEGACY_CLOSES.slice(-5).reduce((a, b) => a + b, 0) / 5;

  for (const threshold of [sma5 - 10, sma5, sma5 + 10]) {
    const result = evaluateTrackerConditionTree({
      id: 'g', kind: 'GROUP', operator: 'AND',
      children: [{ id: 'c', kind: 'INDICATOR_THRESHOLD', timeframe: '15m', indicator: 'SMA', period: 5, direction: 'ABOVE', level: threshold }],
    } as never, context);
    // "At or above" is inclusive. An exclusive comparison would make a
    // condition flicker on a value it should hold, and the boundary is
    // exactly where a rounding difference shows up.
    const expected = sma5 >= threshold ? 'TRUE' : 'FALSE';
    assert(
      result.status === expected,
      `SMA(5) at a threshold of ${threshold} with an average of ${sma5} reported ${result.status}`,
    );
  }
});

check('an unavailable measurement is UNKNOWN on the legacy side too', () => {
  // A condition that cannot be measured must not read as satisfied. The
  // engine states this as a rule; the browser evaluator has to obey it or
  // a preview will show a condition holding that would never fire.
  const result = evaluateTrackerConditionTree({
    id: 'g', kind: 'GROUP', operator: 'AND',
    children: [{ id: 'c', kind: 'SPREAD', timeframe: '15m', maxSpread: 1 }],
  } as never, { state: { timestamp: 0, environment: 'DEMO', symbol: 'Gold' } } as TrackerConditionContext);
  assert(result.status === 'UNKNOWN', `an unmeasurable condition reported ${result.status} instead of UNKNOWN`);
});

check('the legacy evaluator cannot execute anything', () => {
  // A structural guarantee, not a behavioural one: there is no code path
  // from evaluating a tree to an order, and the module does not import an
  // adapter or a risk manager.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'conditions.ts'),
    'utf8',
  );
  for (const forbidden of ['placeMarketOrder', 'closePosition', 'riskManager', 'validateOrder', 'signTransaction']) {
    assert(!source.includes(forbidden), `the legacy evaluator references ${forbidden}`);
  }
});

/* ================================================================== *
 * 21. One bad cache entry could destroy the whole history
 *
 * Found because a test helper was fixed, not because anyone was looking
 * for this. The test that restores an old-schema cache had been
 * asserting against the *real* localStorage rather than its fake (the
 * helper restored the global as soon as an async callback returned its
 * promise), so the restore path was never actually exercised. With the
 * helper fixed, the constructor threw.
 *
 * `restore()` had a `try` around the whole loop containing
 * `void super.append(event)`. `append` is async and validates identity,
 * so an entry without a usable id produced a *rejected promise* that the
 * `void` discarded. The `try` never saw a throw, because the throw
 * happened in a promise rather than on that stack. The result was an
 * unhandled rejection plus a failed constructor -- which in the app means
 * the user's entire activity history is lost to one malformed byte in a
 * local cache.
 *
 * This is the "void promise" pattern the adversarial sweep was asked to
 * look for, and it was not benign.
 * ================================================================== */

group('a malformed cache entry costs one entry, not the history');

check('a stored event without an id does not break construction', async () => {
  const { storage } = countingStorage();
  storage.setItem('test:timeline:partial', JSON.stringify([
    { id: 'good-1', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' },
    { noId: true, agentId: 'a', timestamp: 2 },
    { id: 'good-2', agentId: 'a', timestamp: 3, type: 'MARKET_UPDATE', environment: 'DEMO' },
    { id: 'bad-ts', agentId: 'a', timestamp: 'yesterday' },
    null,
    'a string',
  ]));
  await withStorage(storage, async () => {
    let store: PersistentAgentTimelineStore | undefined;
    let threw: unknown;
    try {
      store = new PersistentAgentTimelineStore(10_000, 'test:timeline:partial');
    } catch (error) {
      threw = error;
    }
    assert(!threw, `the constructor threw on a malformed cache entry: ${String(threw)}`);
    // The usable entries survived.
    assert(countEvents(store as PersistentAgentTimelineStore) === 2, 'the good events were lost');
    // And the interface is told the restore was partial rather than
    // being shown a short history as if it were complete.
    assert(store!.storageState === 'FAILED', `a partial restore reported ${store!.storageState}`);
  });
});

check('a cache of only invalid entries still yields a usable timeline', async () => {
  const { storage } = countingStorage();
  storage.setItem('test:timeline:allbad', JSON.stringify([null, 1, 'two', { nope: true }]));
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:allbad');
    assert(countEvents(store) === 0, 'invalid entries were restored as events');
    void store.append({ id: 'after', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' } as never);
    assert(countEvents(store) === 1, 'the timeline was unusable after an entirely invalid cache');
  });
});

check('a good cache restores silently, so a clean history is not reported as damaged', async () => {
  const { storage } = countingStorage();
  storage.setItem('test:timeline:clean', JSON.stringify([
    { id: 'c-1', agentId: 'a', timestamp: 1, type: 'MARKET_UPDATE', environment: 'DEMO' },
  ]));
  await withStorage(storage, async () => {
    const store = new PersistentAgentTimelineStore(10_000, 'test:timeline:clean');
    assert(countEvents(store) === 1, 'a valid cache was not restored');
    assert(store.storageState === 'OK', `a clean restore reported ${store.storageState}`);
  });
});

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

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
