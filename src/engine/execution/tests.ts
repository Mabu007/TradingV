import {
  ACCOUNT_CURRENCY,
  aggregateExposure,
  DEMO_FALLBACK_LEVERAGE,
  leverageRequirement,
  marginForPosition,
  quoteToAccountFactor,
  riskToStop,
  valuePriceDistance,
} from './valuation';
import { RiskManager } from './risk';
import { instrumentMetadata } from '../../adapters/hyperliquid/normalizer';
import { InstrumentMetadata } from '../../types/instruments';
import { Position } from '../../types/trading';
import {
  instrumentUnitsToLots,
  lotsToInstrumentUnits,
  snapOrderSize,
  validateOrderSize,
} from '../../utils/orderSize';

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function meta(
  providerSymbol: string,
  assetClass: 'FOREX' | 'COMMODITY' | 'INDEX',
  pricePrecision: number,
  sizePrecision: number,
  maxLeverage: number,
): InstrumentMetadata {
  return instrumentMetadata({
    providerSymbol,
    assetClass,
    pricePrecision,
    sizePrecision,
    maxLeverage,
  });
}

const EUR_USD = meta('xyz:EUR', 'FOREX', 5, 1, 50);
const USD_JPY = meta('xyz:JPY', 'FOREX', 2, 2, 50);
const GOLD = meta('xyz:GOLD', 'COMMODITY', 1, 4, 25);
const WTI = meta('xyz:CL', 'COMMODITY', 2, 3, 20);
const SP500 = meta('xyz:SP500', 'INDEX', 2, 3, 50);

/** No Forex constant may appear in a generic risk or P&L path. */
export function testValuationPerAssetClass(): void {
  const cases: Array<{
    label: string;
    metadata: InstrumentMetadata;
    entry: number;
    stop: number;
    quantity: number;
    expected: number;
  }> = [
    {
      label: 'EUR/USD',
      metadata: EUR_USD,
      entry: 1.1001,
      stop: 1.09,
      quantity: 1000,
      expected: 10.1,
    },
    {
      label: 'USD/JPY (quoted in JPY)',
      metadata: USD_JPY,
      entry: 157.33,
      stop: 156.33,
      quantity: 10_000,
      expected: Number((10_000 / 157.33).toFixed(2)),
    },
    {
      label: 'Gold',
      metadata: GOLD,
      entry: 4141,
      stop: 4131,
      quantity: 2,
      expected: 20,
    },
    {
      label: 'WTI',
      metadata: WTI,
      entry: 92.53,
      stop: 91.53,
      quantity: 10,
      expected: 10,
    },
    {
      label: 'S&P 500',
      metadata: SP500,
      entry: 7700.8,
      stop: 7690.8,
      quantity: 3,
      expected: 30,
    },
  ];

  for (const testCase of cases) {
    const risk = riskToStop({
      symbol: testCase.metadata.symbol,
      metadata: testCase.metadata,
      entryPrice: testCase.entry,
      stopLoss: testCase.stop,
      quantity: testCase.quantity,
    });

    assert(
      risk.available,
      `${testCase.label} risk is available`,
    );

    assert(
      Math.abs((risk.value ?? 0) - testCase.expected) < 0.05,
      `${testCase.label} stop risk is price distance x size (expected ${testCase.expected}, got ${risk.value})`,
    );
  }

  const forexPnl = valuePriceDistance({
    symbol: 'EUR/USD',
    metadata: EUR_USD,
    priceDistance: 0.001,
    quantity: 1000,
    referencePrice: 1.1001,
  });
  assert(forexPnl.value === 1, 'EUR/USD P&L is linear in price x size');

  const goldPnl = valuePriceDistance({
    symbol: 'Gold',
    metadata: GOLD,
    priceDistance: 0.001,
    quantity: 1000,
    referencePrice: 4141,
  });
  assert(
    goldPnl.value === 1,
    'Gold P&L is linear in price x size with no lot divisor',
  );

  const indexPnl = valuePriceDistance({
    symbol: 'S&P 500',
    metadata: SP500,
    priceDistance: 0.001,
    quantity: 1000,
    referencePrice: 7700,
  });
  assert(
    indexPnl.value === 1,
    'index P&L is linear in price x size',
  );

  const jpyPnl = valuePriceDistance({
    symbol: 'USD/JPY',
    metadata: USD_JPY,
    priceDistance: 1,
    quantity: 10_000,
    referencePrice: 157.33,
  });
  assert(
    Math.abs((jpyPnl.value ?? 0) - 10_000 / 157.33) < 0.01,
    'a JPY-quoted amount is converted with the live price, not a constant',
  );
}

/** Quote-currency conversion is exact or explicitly unavailable. */
export function testQuoteCurrencyConversion(): void {
  assert(
    quoteToAccountFactor(GOLD, 4141) === 1,
    'a commodity quoted in the account currency has a factor of 1',
  );

  assert(
    quoteToAccountFactor(USD_JPY, 157.33) === 1 / 157.33,
    'a pair quoted in JPY converts through the live price',
  );

  assert(
    quoteToAccountFactor({ ...GOLD, quoteCurrency: undefined }, 4141) === undefined,
    'an unknown quote currency has no conversion',
  );

  assert(
    quoteToAccountFactor(
      { ...GOLD, quoteCurrency: 'CHF', baseCurrency: 'XXX' },
      4141,
    ) === undefined,
    'an unrelated quote currency has no conversion',
  );

  const unavailable = valuePriceDistance({
    symbol: 'Mystery',
    metadata: { ...GOLD, quoteCurrency: 'CHF', baseCurrency: 'XXX' },
    priceDistance: 1,
    quantity: 10,
    referencePrice: 4141,
  });

  assert(
    !unavailable.available,
    'an unconvertible instrument reports an unavailable value',
  );
  assert(
    Boolean(unavailable.reason),
    'an unavailable value explains itself',
  );
}

/**
 * Mixed-asset exposure is a monetary aggregate. Quantities of unrelated
 * instruments are never summed.
 */
export function testMixedAssetExposureAggregation(): void {
  const summary = aggregateExposure([
    {
      symbol: 'Gold',
      quantity: 10,
      metadata: GOLD,
      referencePrice: 4000,
    },
    {
      symbol: 'EUR/USD',
      quantity: 90_000,
      metadata: EUR_USD,
      referencePrice: 1.1,
    },
  ]);

  assert(
    summary.complete,
    'a fully priced book aggregates completely',
  );

  assert(
    Math.abs(summary.total - (40_000 + 99_000)) < 0.01,
    `exposure is the sum of notionals (expected 139,000, got ${summary.total})`,
  );

  const withJpy = aggregateExposure([
    {
      symbol: 'USD/JPY',
      quantity: 10_000,
      metadata: USD_JPY,
      referencePrice: 157.33,
    },
  ]);

  assert(
    Math.abs((withJpy.total ?? 0) - 10_000) < 1,
    `a JPY-quoted position is valued as its USD notional (got ${withJpy.total})`,
  );

  const unpriced = aggregateExposure([
    {
      symbol: 'Gold',
      quantity: 10,
      metadata: GOLD,
    },
  ]);

  assert(
    !unpriced.complete && unpriced.unresolved.includes('Gold'),
    'a leg without a usable price is reported as unresolved',
  );

  const unconvertible = aggregateExposure([
    {
      symbol: 'Mystery',
      quantity: 10,
      metadata: {
        ...GOLD,
        quoteCurrency: 'CHF',
        baseCurrency: 'XXX',
      },
      referencePrice: 4000,
    },
  ]);

  assert(
    !unconvertible.complete,
    'a leg that cannot be converted is reported as unresolved',
  );
}

/** Leverage comes from the provider, with a named demo fallback. */
export function testLeverageAndMargin(): void {
  assert(
    leverageRequirement(GOLD).leverage === 25 &&
      leverageRequirement(GOLD).source === 'PROVIDER',
    'margin uses the leverage the venue publishes',
  );

  const fallback = leverageRequirement(undefined);
  assert(
    fallback.leverage === DEMO_FALLBACK_LEVERAGE &&
      fallback.source === 'DEMO_FALLBACK',
    'a market without published leverage falls back to the documented demo value',
  );

  const goldMargin = marginForPosition({
    symbol: 'Gold',
    metadata: GOLD,
    quantity: 10,
    referencePrice: 4000,
  });

  assert(
    goldMargin.margin === 1600,
    `margin is notional divided by published leverage (got ${goldMargin.margin})`,
  );

  const unconvertible = marginForPosition({
    symbol: 'Mystery',
    metadata: {
      ...GOLD,
      quoteCurrency: 'CHF',
      baseCurrency: 'XXX',
    },
    quantity: 10,
    referencePrice: 4000,
  });

  assert(
    unconvertible.margin === undefined,
    'margin is not invented for an unconvertible instrument',
  );
}

/** The risk manager gates on notional exposure, never raw unit sums. */
export function testRiskManagerExposure(): void {
  const manager = new RiskManager({
    maxExposureNotional: 100_000,
    maxOrderSize: 100_000,
  });

  const goldPosition: Position = {
    id: 'gold-1',
    symbol: 'Gold',
    side: 'BUY',
    volume: 10,
    entryPrice: 4000,
    currentPrice: 4000,
    unrealizedPnL: 0,
    unrealizedPnlPercent: 0,
    timestamp: 1,
  };

  const instruments = [GOLD, EUR_USD, WTI, SP500];
  const referencePrices = {
    Gold: 4000,
    'EUR/USD': 1.1,
    'S&P 500': 7700,
  };

  const lookup = {
    get: (symbol: string) =>
      instruments.find((candidate) => candidate.symbol === symbol),
  };

  const small = manager.validateOrder(
    { symbol: 'EUR/USD', side: 'BUY', volume: 1_000 },
    [goldPosition],
    false,
    { instruments: lookup, referencePrices },
  );

  assert(
    small.valid,
    'a small order alongside a commodity position is allowed',
  );

  /*
   * 90,000 EUR units is ~$99,000. With $40,000 of Gold already open,
   * the raw unit sum would still be 90,010 while the notional total
   * breaches the limit.
   */
  const overNotional = manager.validateOrder(
    { symbol: 'EUR/USD', side: 'BUY', volume: 90_000 },
    [goldPosition],
    false,
    { instruments: lookup, referencePrices },
  );

  assert(
    !overNotional.valid,
    'exposure is measured in the account currency, not in units',
  );
  assert(
    String(overNotional.reason).includes('notional'),
    'the exposure rejection names the notional limit',
  );

  const unpriced = manager.validateOrder(
    { symbol: 'EUR/USD', side: 'BUY', volume: 1_000 },
    [
      {
        ...goldPosition,
        id: 'oil-1',
        symbol: 'WTI Crude Oil',
        currentPrice: Number.NaN,
        entryPrice: Number.NaN,
      },
    ],
    false,
    { instruments: lookup, referencePrices },
  );

  assert(
    !unpriced.valid,
    'a position that cannot be valued blocks new orders instead of being ignored',
  );
}

/** Order sizing: lots only where the instrument declares them. */
export function testOrderSizing(): void {
  const lots = lotsToInstrumentUnits(0.1, EUR_USD);
  assert(
    lots.valid && lots.units === 10_000,
    'a 0.1 lot Forex position is 10,000 instrument units',
  );

  assert(
    instrumentUnitsToLots(10_000, EUR_USD) === 0.1,
    'instrument units convert back to lots for Forex',
  );

  const goldLots = lotsToInstrumentUnits(0.1, GOLD);
  assert(
    !goldLots.valid,
    'Gold has no lot concept, so lots are refused',
  );

  assert(
    instrumentUnitsToLots(10, GOLD) === undefined,
    'Gold units are never converted to lots',
  );

  assert(
    instrumentUnitsToLots(3, SP500) === undefined,
    'index units are never converted to lots',
  );

  assert(
    snapOrderSize(1.23456, EUR_USD).value === 1.2,
    'a size is snapped onto the venue grid (szDecimals 1)',
  );

  assert(
    snapOrderSize(1.23456, WTI).value === 1.235,
    'oil snaps to three decimals, matching the venue',
  );

  assert(
    validateOrderSize(1.2, EUR_USD).valid,
    'an on-grid size passes validation',
  );

  assert(
    !validateOrderSize(1.23, EUR_USD).valid,
    'an off-grid size fails validation',
  );

  assert(
    !validateOrderSize(0.05, EUR_USD).valid,
    'a size below one step fails validation',
  );

  assert(
    validateOrderSize(1, GOLD).valid,
    'commodity sizes validate against their own precision',
  );

  assert(
    !validateOrderSize(1, undefined).valid,
    'an unknown instrument cannot be sized',
  );

  const jpyLots = lotsToInstrumentUnits(0.01, USD_JPY);
  assert(
    jpyLots.valid && jpyLots.units === 1_000,
    'USD/JPY lots convert to instrument units',
  );
}

export async function runExecutionRiskTests(): Promise<void> {
  testValuationPerAssetClass();
  testQuoteCurrencyConversion();
  testMixedAssetExposureAggregation();
  testLeverageAndMargin();
  testRiskManagerExposure();
  testOrderSizing();

  console.log(
    'Valuation, exposure, leverage and order-sizing tests passed.',
  );
}

if (import.meta.main) {
  await runExecutionRiskTests();
}
