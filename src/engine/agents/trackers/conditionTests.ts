import {
  TrackerCondition,
  TrackerConditionContext,
  TrackerConditionGroup,
  makeGroup,
  makeCondition,
  summariseTrackerTree,
  validateTrackerConditionTree,
  countConditions,
  evaluateTrackerConditionTree,
  describeTrackerCondition,
  TRACKER_CONDITION_CATALOGUE,
} from './conditions';
import { evaluateTracker, newEvaluationState, conditionTreeOf } from './evaluator';
import type { Tracker, TrackerInput } from './types';
import type { InstrumentMetadata } from '../../../types/instruments';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const gold: InstrumentMetadata = {
  symbol: 'Gold', displayName: 'Gold Perpetual', assetClass: 'COMMODITY',
  provider: 'HYPERLIQUID', providerSymbol: 'xyz:GOLD', providerMarketId: 'xyz:GOLD',
  providerDex: 'xyz', quoteCurrency: 'USD', pricePrecision: 2, sizePrecision: 2, tickSize: 0.01,
};

const eurusd: InstrumentMetadata = {
  symbol: 'EUR/USD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX',
  provider: 'HYPERLIQUID', providerSymbol: 'xyz:EUR', providerMarketId: 'xyz:EUR',
  providerDex: 'xyz', baseCurrency: 'EUR', quoteCurrency: 'USD',
  pricePrecision: 5, sizePrecision: 1, tickSize: 0.00001, pipSize: 0.0001,
};

function bars(count: number, start: number, step: number, noise: (index: number) => number) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + step * index + noise(index);
    return {
      time: 1_700_000_000 + index * 300,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
    };
  });
}

function context(overrides: Partial<TrackerConditionContext['state']> = {}, extra: Partial<TrackerConditionContext> = {}): TrackerConditionContext {
  return {
    state: {
      timestamp: 1_700_000_000_000,
      environment: 'DEMO',
      symbol: 'Gold',
      timeframe: '15m',
      price: 2350.4,
      spread: 0.2,
      ...overrides,
    },
    ...extra,
  };
}

function condition(overrides: Partial<TrackerCondition> & { kind: TrackerCondition['kind'] }): TrackerCondition {
  return { id: 'c', ...overrides } as TrackerCondition;
}

function tree(...children: TrackerCondition[] | TrackerConditionGroup[]): TrackerConditionGroup {
  return makeGroup('AND', children as never);
}

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

export function runConditionTreeTests(): void {
  testSingleConditions();
  testLogicalGroups();
  testUnknownPropagation();
  testNoFabricatedPrices();
  testAssetAgnosticProximity();
  testDebounce();
  testSummaryAndValidation();
  testCatalogueIntegrity();
}

function testSingleConditions(): void {
  const ctx = context({ price: 2501, bars: bars(30, 2400, 1, () => 0) });

  // price above
  const above = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2500 })),
    ctx,
  );
  assert(above.status === 'TRUE', 'price at or above a level is satisfied');

  const below = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_LEVEL', direction: 'BELOW', level: 2500 })),
    ctx,
  );
  assert(below.status === 'FALSE', 'price at or below a level fails when the price is above it');

  // price cross needs two samples
  const crossNoHistory = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_CROSS', direction: 'ABOVE', level: 2500 })),
    ctx,
  );
  assert(crossNoHistory.status === 'UNKNOWN', 'a cross without a previous price is UNKNOWN, not false');

  const crossed = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_CROSS', direction: 'ABOVE', level: 2500 })),
    { ...ctx, previousPrice: 2499 },
  );
  assert(crossed.status === 'TRUE', 'a cross is satisfied on the sample that crosses');

  // indicator threshold
  const falling = bars(40, 2600, -8, (index) => Math.sin(index / 3) * 3);
  const rsi = evaluateTrackerConditionTree(
    tree(condition({ kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 })),
    context({ bars: falling, price: undefined }),
  );
  assert(rsi.status === 'TRUE', 'RSI below a level is measured from real bars');

  const atr = evaluateTrackerConditionTree(
    tree(condition({ kind: 'VOLATILITY', direction: 'ABOVE', period: 14, threshold: 0.5 })),
    context({ bars: falling, price: undefined }),
  );
  assert(atr.status === 'TRUE', 'ATR volatility threshold is measured from real bars');

  // breakout
  const range = bars(30, 2000, 1, () => 0);
  const breakout = evaluateTrackerConditionTree(
    tree(condition({ kind: 'BREAKOUT', direction: 'ABOVE', lookbackBars: 20 })),
    context({ bars: range, price: 2100 }),
  );
  assert(breakout.status === 'TRUE', 'a breakout above the prior range is satisfied');

  // spread
  const tight = evaluateTrackerConditionTree(
    tree(condition({ kind: 'SPREAD', direction: 'BELOW', maxSpread: 1 })),
    context({ spread: 0.2 }),
  );
  assert(tight.status === 'TRUE', 'a spread below its maximum is satisfied');

  // event
  const eventCtx = context({ eventData: { type: 'POSITION_OPENED' } });
  const opened = evaluateTrackerConditionTree(
    tree(condition({ kind: 'EVENT', event: 'POSITION_OPENED' })),
    eventCtx,
  );
  assert(opened.status === 'TRUE', 'a matching event satisfies an event condition');
  const notOpened = evaluateTrackerConditionTree(
    tree(condition({ kind: 'EVENT', event: 'ORDER_FILLED' })),
    eventCtx,
  );
  assert(notOpened.status === 'FALSE', 'a non-matching event does not satisfy an event condition');
}

function testLogicalGroups(): void {
  const price = 2350.4;
  const ctx = context({ price });

  // AND requires every child
  const andTrue = evaluateTrackerConditionTree(
    makeGroup('AND', [
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
      condition({ kind: 'PRICE_LEVEL', direction: 'BELOW', level: 3000 }),
    ]),
    ctx,
  );
  assert(andTrue.status === 'TRUE', 'AND is satisfied when every child holds');

  const andFalse = evaluateTrackerConditionTree(
    makeGroup('AND', [
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 3000 }),
    ]),
    ctx,
  );
  assert(andFalse.status === 'FALSE', 'AND fails when one child fails');

  // OR needs only one
  const orTrue = evaluateTrackerConditionTree(
    makeGroup('OR', [
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9000 }),
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
    ]),
    ctx,
  );
  assert(orTrue.status === 'TRUE', 'OR is satisfied when one child holds');

  const orFalse = evaluateTrackerConditionTree(
    makeGroup('OR', [
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9000 }),
      condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9500 }),
    ]),
    ctx,
  );
  assert(orFalse.status === 'FALSE', 'OR fails when no child holds');

  // NOT inverts
  const notTrue = evaluateTrackerConditionTree(
    makeGroup('NOT', [condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9000 })]),
    ctx,
  );
  assert(notTrue.status === 'TRUE', 'NOT inverts a false child');
  const notFalse = evaluateTrackerConditionTree(
    makeGroup('NOT', [condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 })]),
    ctx,
  );
  assert(notFalse.status === 'FALSE', 'NOT inverts a true child');

  // nested groups
  const nested = makeGroup('OR', [
    makeGroup('AND', [
      condition({ id: 'a1', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
      condition({ id: 'a2', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 3000 }),
    ]),
    makeGroup('AND', [
      condition({ id: 'b1', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
      condition({ id: 'b2', kind: 'PRICE_LEVEL', direction: 'BELOW', level: 2500 }),
    ]),
  ]);
  const nestedResult = evaluateTrackerConditionTree(nested, ctx);
  assert(nestedResult.status === 'TRUE', 'a nested tree resolves through both branches');
  assert(countConditions(nested) === 4, 'a nested tree counts every leaf');

  // depth 3
  const deep = makeGroup('AND', [
    condition({ id: 'd1', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
    makeGroup('OR', [
      condition({ id: 'd2', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9000 }),
      makeGroup('AND', [
        condition({ id: 'd3', kind: 'PRICE_LEVEL', direction: 'BELOW', level: 2400 }),
        condition({ id: 'd4', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2300 }),
      ]),
    ]),
  ]);
  assert(evaluateTrackerConditionTree(deep, ctx).status === 'TRUE', 'a depth-3 tree evaluates correctly');

  // a disabled condition never contributes
  const withDisabled = makeGroup('AND', [
    condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
    condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 9000, enabled: false }),
  ]);
  assert(evaluateTrackerConditionTree(withDisabled, ctx).status === 'TRUE', 'a disabled condition is ignored');
}

function testUnknownPropagation(): void {
  const ctx = context({ price: undefined, bars: undefined });

  const unknownLeaf = evaluateTrackerConditionTree(
    tree(condition({ kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 })),
    ctx,
  );
  assert(unknownLeaf.status === 'UNKNOWN', 'an unmeasurable indicator is UNKNOWN');

  const unknownAnd = evaluateTrackerConditionTree(
    makeGroup('AND', [
      condition({ id: 'x', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }),
      condition({ id: 'y', kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 }),
    ]),
    ctx,
  );
  assert(unknownAnd.status === 'UNKNOWN', 'AND with an unknown child is UNKNOWN, never TRUE');

  const unknownOrWithTrueSibling = evaluateTrackerConditionTree(
    makeGroup('OR', [
      condition({ id: 'x', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }),
      condition({ id: 'y', kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 }),
    ]),
    context({ price: 10, bars: undefined }),
  );
  assert(unknownOrWithTrueSibling.status === 'TRUE', 'OR with a TRUE sibling is TRUE even with an unknown child');

  const notUnknown = evaluateTrackerConditionTree(
    makeGroup('NOT', [condition({ kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 })]),
    ctx,
  );
  assert(notUnknown.status === 'UNKNOWN', 'NOT of an unknown child stays UNKNOWN');
}

function testNoFabricatedPrices(): void {
  const noPrice = context({ price: undefined, bars: undefined, spread: undefined });

  const level = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 })),
    noPrice,
  );
  assert(level.status === 'UNKNOWN', 'a level condition with no price is UNKNOWN, not TRUE');
  assert(
    level.flat[0].reason?.toLowerCase().includes('no live price'),
    'the reason explains that no price exists',
  );

  const zeroPrice = context({ price: 0, bars: undefined });
  const zeroResult = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 })),
    zeroPrice,
  );
  assert(zeroResult.status === 'UNKNOWN', 'a null venue price never becomes an executable price');

  const spread = evaluateTrackerConditionTree(
    tree(condition({ kind: 'SPREAD', direction: 'BELOW', maxSpread: 100 })),
    context({ spread: undefined }),
  );
  assert(spread.status === 'UNKNOWN', 'a missing spread is UNKNOWN');
}

function testAssetAgnosticProximity(): void {
  const longGold = {
    id: 'p1', symbol: 'Gold', side: 'BUY' as const,
    currentPrice: 2350.4, volume: 2, stopLoss: 2347,
  };

  const goldWithin = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'stopLoss', withinPrice: 4 })),
    context({ positions: [longGold] }),
  );
  assert(goldWithin.status === 'TRUE', 'gold stop within an absolute price distance is satisfied');

  const goldOutside = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'stopLoss', withinPrice: 1 })),
    context({ positions: [longGold] }),
  );
  assert(goldOutside.status === 'FALSE', 'gold stop outside the distance is not satisfied');

  // A pip threshold on an instrument with no pip size cannot be measured.
  const goldPips = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'stopLoss', withinPips: 50 })),
    context({ positions: [longGold] }),
  );
  assert(goldPips.status === 'UNKNOWN', 'a pip threshold on a commodity is UNKNOWN, not approximated');

  // A short position behaves identically.
  const shortEur = {
    id: 'p2', symbol: 'EUR/USD', side: 'SELL' as const,
    currentPrice: 1.1, volume: 1000, takeProfit: 1.1004,
  };
  const shortResult = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'takeProfit', withinPips: 5 })),
    context({ symbol: 'EUR/USD', positions: [shortEur] }, { instrument: eurusd }),
  );
  assert(shortResult.status === 'TRUE', 'a short position target proximity is measured from the pip size');

  // No position means the condition cannot be measured.
  const noPosition = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'stopLoss', withinPrice: 10 })),
    context({ positions: [] }),
  );
  assert(noPosition.status === 'UNKNOWN', 'a position condition with no position is UNKNOWN');

  // Monetary distance uses quantity and metadata.
  const valueResult = evaluateTrackerConditionTree(
    tree(condition({ kind: 'PROXIMITY', level: 'stopLoss', withinValue: 20 })),
    context({ positions: [longGold] }, { instrument: gold }),
  );
  assert(valueResult.status === 'TRUE', 'a monetary proximity threshold is derived from quantity and metadata');
}

function testDebounce(): void {
  const state = newEvaluationState();

  const tracker: Tracker = {
    id: 'tree-tracker',
    agentId: 'agent',
    kind: 'NEW_BAR',
    timeframe: '15m',
    config: {
      conditionTree: makeGroup('AND', [
        condition({ id: 'a', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2000 }),
        condition({ id: 'b', kind: 'PRICE_LEVEL', direction: 'BELOW', level: 3000 }),
      ]),
    },
    purpose: 'Know when price is back inside the band.',
    eventType: 'CONDITION_MET',
    dependencies: [],
    dataRequirements: [],
    evaluation: { priority: 0, cooldownMs: 1_000, maxEventsPerMinute: 10 },
    lifecycle: { status: 'ACTIVE', eventCount: 0 },
    createdAt: 1,
    updatedAt: 1,
  };

  assert(conditionTreeOf(tracker) !== undefined, 'a tracker with a condition tree is detected');

  const makeInput = (price: number, timestamp: number): TrackerInput => ({
    id: `tick-${timestamp}`,
    type: 'MARKET_QUOTE',
    timestamp,
    environment: 'DEMO',
    symbol: 'Gold',
    timeframe: '15m',
    state: { timestamp, environment: 'DEMO', symbol: 'Gold', timeframe: '15m', price, spread: 0.2 },
  });

  const first = evaluateTracker(tracker, makeInput(2350, 1), state);
  assert(Boolean(first), 'the tree reports on the first sample that satisfies it');
  assert(first?.includes('wake the GOAT'), 'the wake reason says wake the GOAT, not place a trade');
  assert(!/place|order|execute/i.test(first ?? ''), 'the wake reason never claims to place an order');

  for (let index = 2; index <= 30; index += 1) {
    const repeat = evaluateTracker(tracker, makeInput(2350 + index * 0.1, index * 1000), state);
    assert(!repeat, 'the tree does not report again while the condition stays true');
  }

  // Leaving and re-entering the band re-arms.
  evaluateTracker(tracker, makeInput(1000, 40_000), state);
  const rearmed = evaluateTracker(tracker, makeInput(2350, 50_000), state);
  assert(Boolean(rearmed), 'the tree reports again after leaving and re-entering the band');
}

function testSummaryAndValidation(): void {
  const root = makeGroup('AND', [
    condition({ kind: 'PRICE_CROSS', direction: 'ABOVE', level: 2500 }),
    condition({ kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 35 }),
  ]);

  const summary = summariseTrackerTree(root, { symbol: 'Gold', timeframe: '15m' });
  assert(summary.startsWith('IF Gold'), 'the summary reads as a sentence');
  assert(summary.includes('THEN wake the GOAT'), 'the summary ends by waking the GOAT');
  assert(summary.includes('AND'), 'the summary shows the AND between conditions');
  assert(!/place|execute/i.test(summary), 'the summary never implies an order');

  const nested = makeGroup('OR', [
    makeGroup('AND', [
      condition({ id: 'n1', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2500 }),
      condition({ id: 'n2', kind: 'PRICE_LEVEL', direction: 'BELOW', level: 2600 }),
    ]),
    condition({ id: 'n3', kind: 'BREAKOUT', direction: 'ABOVE', lookbackBars: 20 }),
  ]);
  const nestedSummary = summariseTrackerTree(nested);
  assert(nestedSummary.includes('OR'), 'nested groups show their operator');
  assert(nestedSummary.includes('('), 'nested groups are parenthesised');

  // Validation surfaces real problems.
  const empty = makeGroup('AND', []);
  assert(validateTrackerConditionTree(empty).length > 0, 'an empty group is rejected');

  const badPrice = makeGroup('AND', [condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 0 })]);
  assert(validateTrackerConditionTree(badPrice).some((problem) => problem.includes('greater than zero')), 'a zero price level is rejected');

  const badNot = makeGroup('NOT', [
    condition({ id: 'x', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }),
    condition({ id: 'y', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2 }),
  ]);
  assert(validateTrackerConditionTree(badNot).some((problem) => problem.includes('NOT')), 'a multi-child NOT is rejected');

  const good = makeGroup('AND', [
    condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }),
    condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2 }),
  ]);
  assert(validateTrackerConditionTree(good).length === 0, 'a well-formed tree has no problems');

  assert(describeTrackerCondition(condition({ kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 2500 })).includes('2500'),
    'descriptions include the numeric level');
  assert(
    describeTrackerCondition(condition({ kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 35 })).includes('RSI(14)'),
    'descriptions name the indicator and its period',
  );
}

function testCatalogueIntegrity(): void {
  assert(TRACKER_CONDITION_CATALOGUE.length > 0, 'the catalogue is not empty');

  const kinds = new Set<string>(TRACKER_CONDITION_CATALOGUE.map((spec) => spec.kind));
  assert(kinds.size === TRACKER_CONDITION_CATALOGUE.length, 'the catalogue has no duplicate kinds');

  for (const spec of TRACKER_CONDITION_CATALOGUE) {
    assert(typeof spec.label === 'string' && spec.label.length > 0, `catalogue entry ${spec.kind} has a label`);
    assert(typeof spec.category === 'string' && spec.category.length > 0, `catalogue entry ${spec.kind} has a category`);

    const created = spec.create();
    assert(created.kind === spec.kind, `catalogue entry ${spec.kind} creates its own kind`);
    assert(typeof spec.create === 'function', `catalogue entry ${spec.kind} is constructible`);
    // Every catalogue entry must produce a tree that validates once
    // minimally filled in, so the builder can never offer a condition
    // the engine cannot evaluate.
    const candidate = makeGroup('AND', [created]);
    assert(validateTrackerConditionTree(candidate).length > 0, `catalogue entry ${spec.kind} needs user input before it is valid`);
  }
}
