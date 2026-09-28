import {
  HyperliquidDemoAdapter,
  DemoMarketDataSource,
  markPositionToMarket,
} from './demo';
import { instrumentMetadata } from './normalizer';
import {
  AssetClass,
  InstrumentLookup,
  InstrumentMetadata,
  InstrumentStatus,
} from '../../types/instruments';
import { Bar, Quote, Timeframe } from '../../types/trading';
import { eventBus } from '../../types/events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Instrument metadata exactly as Hyperliquid discovery builds it, with
 * the size precision and leverage the venue publishes.
 */
function metadata(
  providerSymbol: string,
  assetClass: AssetClass,
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

const EUR_USD = metadata('xyz:EUR', 'FOREX', 5, 1, 50);
const USD_JPY = metadata('xyz:JPY', 'FOREX', 2, 2, 50);
const GOLD = metadata('xyz:GOLD', 'COMMODITY', 1, 4, 25);
const WTI = metadata('xyz:CL', 'COMMODITY', 2, 3, 20);
const SP500 = metadata('xyz:SP500', 'INDEX', 2, 3, 50);
const ALL_INSTRUMENTS = [
  EUR_USD,
  USD_JPY,
  GOLD,
  WTI,
  SP500,
];

/** Deterministic, offline market data with explicit quotes per symbol. */
class FixtureMarketData implements DemoMarketDataSource {
  readonly quotes = new Map<string, Quote>();

  private readonly unavailable = new Map<string, string>();

  constructor(private readonly instruments: InstrumentMetadata[]) {}

  /** Register a market the provider lists but publishes no price for. */
  setUnavailable(symbol: string, reason: string): void {
    this.unavailable.set(symbol, reason);
  }

  async getMarketStatus(symbol: string): Promise<InstrumentStatus> {
    const reason = this.unavailable.get(symbol);

    return reason
      ? { availability: 'UNAVAILABLE', reason }
      : { availability: 'TRADEABLE' };
  }

  setQuote(symbol: string, bid: number, ask: number): void {
    this.quotes.set(symbol, {
      symbol,
      bid,
      ask,
      spread: ask - bid,
      timestamp: Date.now(),
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const quote = this.quotes.get(symbol);

    if (!quote) {
      throw new Error(`No fixture quote for ${symbol}.`);
    }

    return quote;
  }

  async getBars(
    _symbol: string,
    _timeframe: Timeframe,
    count: number,
  ): Promise<Bar[]> {
    return Array.from({ length: count }, (_, index) => ({
      time: index + 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    }));
  }

  getInstrument(symbol: string): InstrumentMetadata | undefined {
    if (this.unavailable.has(symbol)) return undefined;

    return (
      this.instruments.find(
        (candidate) =>
          candidate.symbol === symbol ||
          candidate.providerSymbol === symbol,
      ) ?? undefined
    );
  }

  getInstrumentLookup(): InstrumentLookup {
    return { get: (symbol: string) => this.getInstrument(symbol) };
  }
}

function buildAdapter(
  quotes: Array<[string, number, number]>,
): { adapter: HyperliquidDemoAdapter; marketData: FixtureMarketData } {
  const marketData = new FixtureMarketData(ALL_INSTRUMENTS);

  quotes.forEach(([symbol, bid, ask]) =>
    marketData.setQuote(symbol, bid, ask),
  );

  return {
    adapter: new HyperliquidDemoAdapter(marketData),
    marketData,
  };
}

/**
 * Entry and exit prices come from the live book: a BUY fills at the ask,
 * a SELL fills at the bid, longs are marked to the bid and shorts to
 * the ask.
 */
export async function testEntryAndExitSides(): Promise<void> {
  assert(
    markPositionToMarket(
      { side: 'BUY', entryPrice: 100, volume: 2, symbol: 'Gold' },
      104,
      105,
      GOLD,
    ).markPrice === 104,
    'long positions mark to the bid',
  );

  assert(
    markPositionToMarket(
      { side: 'SELL', entryPrice: 100, volume: 2, symbol: 'Gold' },
      104,
      105,
      GOLD,
    ).markPrice === 105,
    'short positions mark to the ask',
  );

  const { adapter } = buildAdapter([['Gold', 4140, 4141]]);

  await adapter
    .placeMarketOrder({ symbol: 'Gold', side: 'BUY', volume: 1 })
    .then((buy) => {
      assert(
        buy.fillPrice === 4141,
        'a BUY market order fills at the ask',
      );

      return adapter.placeMarketOrder({
        symbol: 'Gold',
        side: 'SELL',
        volume: 1,
      });
    })
    .then((sell) => {
      assert(
        sell.fillPrice === 4140,
        'a SELL market order fills at the bid',
      );
    });
}

/**
 * Linear P&L for every asset class, with no pip multiplier and no lot
 * conversion applied to commodities or indices.
 */
export function testLinearValuationPerAssetClass(): void {
  const goldLong = markPositionToMarket(
    { side: 'BUY', entryPrice: 4000, volume: 2, symbol: 'Gold' },
    4010,
    4010.5,
    GOLD,
  );
  assert(
    goldLong.unrealizedPnL === 20,
    'Gold P&L is price distance x units (10 x 2)',
  );

  const goldShort = markPositionToMarket(
    { side: 'SELL', entryPrice: 4000, volume: 2, symbol: 'Gold' },
    4010,
    4010.5,
    GOLD,
  );
  assert(
    goldShort.unrealizedPnL === -21,
    'Gold short P&L uses the ask-side distance x units',
  );

  const indexMark = markPositionToMarket(
    { side: 'BUY', entryPrice: 7700, volume: 3, symbol: 'S&P 500' },
    7702,
    7702.5,
    SP500,
  );
  assert(
    indexMark.unrealizedPnL === 6,
    'index P&L is price distance x units, never converted to lots',
  );

  const oilMark = markPositionToMarket(
    { side: 'BUY', entryPrice: 92.5, volume: 100, symbol: 'WTI Crude Oil' },
    92.52,
    92.53,
    WTI,
  );
  assert(
    oilMark.unrealizedPnL === 2,
    'oil P&L is price distance x units',
  );

  const forexMark = markPositionToMarket(
    { side: 'BUY', entryPrice: 1.1, volume: 1000, symbol: 'EUR/USD' },
    1.101,
    1.1011,
    EUR_USD,
  );
  assert(
    forexMark.unrealizedPnL === 1,
    'EUR/USD P&L remains price distance x units',
  );

  assert(
    markPositionToMarket(
      { side: 'BUY', entryPrice: 100, volume: 3, symbol: 'Gold' },
      101,
      101.5,
      GOLD,
    ).unrealizedPnL === 3,
    'a commodity position is never re-priced with a 100,000-unit lot formula',
  );

  assert(
    GOLD.pipSize === undefined && GOLD.lotSize === undefined,
    'commodity metadata carries no pip size and no lot size',
  );
}

/**
 * USD/JPY is quoted in JPY. The account-currency value is derived from
 * the live price, never from a hardcoded conversion rate.
 */
export function testQuoteCurrencyConversion(): void {
  const entry = 157.33;
  const mark = entry + 1;

  const jpyMark = markPositionToMarket(
    {
      side: 'BUY',
      entryPrice: entry,
      volume: 10_000,
      symbol: 'USD/JPY',
    },
    mark,
    mark + 0.01,
    USD_JPY,
    'USD',
  );

  // 1 JPY move on 10,000 units = 10,000 JPY, converted at the live rate.
  const expected = Number((10_000 / mark).toFixed(2));

  assert(
    jpyMark.unrealizedPnL === expected,
    `USD/JPY P&L converts with the live price (expected ${expected})`,
  );

  assert(
    Math.abs(jpyMark.unrealizedPnL - 63.16) < 0.01,
    'USD/JPY P&L equals the exact reciprocal-price conversion',
  );

  assert(
    markPositionToMarket(
      { side: 'BUY', entryPrice: entry, volume: 10_000, symbol: 'USD/JPY' },
      mark,
      mark + 0.01,
      { ...USD_JPY, quoteCurrency: undefined },
      'USD',
    ).available === false,
    'an unknown quote currency is never silently treated as USD',
  );

  assert(
    markPositionToMarket(
      { side: 'BUY', entryPrice: entry, volume: 10_000, symbol: 'USD/JPY' },
      mark,
      mark + 0.01,
      {
        ...USD_JPY,
        baseCurrency: 'JPY',
        quoteCurrency: 'XXX',
      },
      'USD',
    ).available === false,
    'an unconvertible quote currency is reported, not approximated',
  );

  const convertible = markPositionToMarket(
    { side: 'BUY', entryPrice: entry, volume: 10_000, symbol: 'USD/JPY' },
    mark,
    mark + 0.01,
    { ...USD_JPY, baseCurrency: 'USD', quoteCurrency: 'JPY' },
    'USD',
  );
  assert(
    convertible.available,
    'a pair quoted in a foreign currency converts through its live price',
  );
}

/**
 * Full position lifecycle against one authoritative execution state:
 * open, mark, partial close, full close, trade history, balance.
 */
export async function testPositionLifecycle(): Promise<void> {
  const { adapter, marketData } = buildAdapter([
    ['Gold', 4000, 4001],
  ]);

  const opened: string[] = [];
  const closed: string[] = [];
  const unsubscribeOpen = eventBus.on('POSITION_OPEN', (event) =>
    opened.push(event.data.id),
  );
  const unsubscribeClose = eventBus.on('POSITION_CLOSE', (event) =>
    closed.push(event.data.trade.id),
  );

  const before = await adapter.getAccountState();

  const entry = await adapter.placeMarketOrder({
    symbol: 'Gold',
    side: 'BUY',
    volume: 4,
  });

  assert(entry.success, 'the demo adapter fills a valid Gold order');
  assert(opened.length === 1, 'opening a position emits one POSITION_OPEN');

  const [openedPosition] = await adapter.getPositions('Gold');
  assert(
    openedPosition.entryPrice === 4001,
    'the position opens at the executed fill price',
  );
  assert(
    openedPosition.unrealizedPnL === 0,
    'a freshly filled position starts flat',
  );

  // Mark the position higher using a real quote.
  marketData.setQuote('Gold', 4010, 4011);
  adapter.markToMarket(await marketData.getQuote('Gold'));

  const [marked] = await adapter.getPositions('Gold');
  assert(
    marked.unrealizedPnL === 36,
    'marking to market updates P&L from the live bid (9 x 4)',
  );
  assert(
    marked.currentPrice === 4010,
    'the marked position carries the bid as its current price',
  );

  const markedState = await adapter.getAccountState();
  assert(
    markedState.equity === markedState.balance + 36,
    'equity includes open P&L from the adapter',
  );

  const partial = await adapter.closePosition(
    openedPosition.id,
    1,
  );

  assert(
    partial.success && partial.pnl === 9,
    'a partial close realizes P&L on the closed part only',
  );

  const [reduced] = await adapter.getPositions('Gold');
  assert(
    reduced.volume === 3,
    'a partial close leaves the remaining volume open',
  );

  // Full close of the remainder.
  marketData.setQuote('Gold', 4020, 4021);
  const finalClose = await adapter.closePosition(reduced.id);

  assert(
    finalClose.success && finalClose.pnl === 57,
    'the final close realizes the remaining P&L (19 x 3)',
  );

  assert(
    (await adapter.getPositions('Gold')).length === 0,
    'a full close removes the position',
  );

  assert(
    closed.length === 2,
    'each close emits a POSITION_CLOSE with an adapter trade',
  );

  const after = await adapter.getAccountState();
  assert(
    after.balance === Number((before.balance + 9 + 57).toFixed(2)),
    'realized P&L is credited to the account balance exactly once',
  );
  assert(
    after.equity === after.balance,
    'with no open positions, equity equals balance',
  );

  unsubscribeOpen();
  unsubscribeClose();
}

/** The execution guard enforces the venue's size precision. */
export async function testOrderSizeGuard(): Promise<void> {
  const { adapter } = buildAdapter([
    ['EUR/USD', 1.14, 1.141],
    ['Gold', 4000, 4001],
    ['Gold ×', 4000, 4001],
  ]);

  const offGrid = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 1.234,
  });

  assert(
    !offGrid.success,
    'a size off the venue grid is rejected instead of being sent',
  );
  assert(
    String(offGrid.error).includes('multiple of 0.1'),
    'the rejection explains the required size step',
  );

  const tooSmall = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 0.05,
  });
  assert(!tooSmall.success, 'a size below the smallest tradeable unit is rejected');

  const valid = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 1000,
  });
  assert(valid.success, 'a size on the venue grid is accepted');

  const unknownInstrument = await adapter.placeMarketOrder({
    symbol: 'Gold ×',
    side: 'BUY',
    volume: 1,
  });
  assert(
    !unknownInstrument.success,
    'an instrument with no metadata cannot be executed',
  );
}

/**
 * Mixed-asset exposure is compared in the account currency, never as a
 * sum of raw quantities.
 */
export async function testMixedAssetExposure(): Promise<void> {
  const { adapter } = buildAdapter([
    ['EUR/USD', 1.1, 1.101],
    ['Gold', 4000, 4001],
  ]);

  /*
   * 10 Gold units is 10 units but roughly $40,000 of exposure.
   * 90,000 EUR units is 90,000 units and roughly $99,000 of exposure.
   *
   * Adding raw quantities would keep every book in this test under the
   * old unit cap; the notional model refuses the last order.
   */
  const firstEur = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 90_000,
  });
  assert(firstEur.success, 'a 90,000 unit EUR position can be opened');

  const gold = await adapter.placeMarketOrder({
    symbol: 'Gold',
    side: 'BUY',
    volume: 10,
  });
  assert(gold.success, 'a 10 unit Gold position can be opened');

  const secondEur = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 100_000,
  });
  assert(
    secondEur.success,
    'the second EUR order still fits inside the notional budget',
  );

  const oversizeGold = await adapter.placeMarketOrder({
    symbol: 'Gold',
    side: 'BUY',
    volume: 5,
  });

  assert(
    !oversizeGold.success,
    'the next order is gated by notional exposure, not by summed units',
  );
  assert(
    String(oversizeGold.error).includes('notional'),
    'the rejection explains that the notional limit was breached',
  );

  assert(
    (await adapter.getPositions()).length === 3,
    'the rejected order left no position behind',
  );

  const units = (await adapter.getPositions()).reduce(
    (sum, position) => sum + position.volume,
    0,
  );

  assert(
    units === 190_010,
    'the raw unit total of the open book is still under the legacy unit cap',
  );
}

/** Margin uses the leverage Hyperliquid publishes for the market. */
export async function testMarginUsesPublishedLeverage(): Promise<void> {
  const { adapter } = buildAdapter([['Gold', 4000, 4001]]);

  await adapter.placeMarketOrder({
    symbol: 'Gold',
    side: 'BUY',
    volume: 10,
  });

  const state = await adapter.getAccountState();

  // 10 units x 4001 notional / 25x published leverage
  assert(
    state.margin === Number((10 * 4001 / 25).toFixed(2)),
    'margin uses the leverage published by the venue',
  );
}

/**
 * A market the provider lists without a current price must never be
 * executable, must never get an invented price, and must be reported as
 * unavailable rather than silently mapped onto another market.
 */
export async function testUnavailableMarketPolicy(): Promise<void> {
  const marketData = new FixtureMarketData(ALL_INSTRUMENTS);

  // The venue lists it, but there is no book for it.
  marketData.setUnavailable('Silent Market', 'Nothing to trade');

  const adapter = new HyperliquidDemoAdapter(marketData);

  const order = await adapter.placeMarketOrder({
    symbol: 'Silent Market',
    side: 'BUY',
    volume: 1,
  });

  assert(
    !order.success,
    'a market without a live price cannot be executed',
  );

  assert(
    order.rejection?.category === 'MARKET_DATA_UNAVAILABLE' ||
      order.rejection?.category === 'UNKNOWN_INSTRUMENT',
    `the rejection is categorised (got ${order.rejection?.category})`,
  );

  assert(
    Boolean(order.rejection?.message) &&
      !/Error|at .*\.ts/.test(order.rejection?.message ?? ''),
    'the rejection carries a user-safe message, not internals',
  );

  let threw = false;

  try {
    await marketData.getQuote('Silent Market');
  } catch {
    threw = true;
  }

  assert(
    threw,
    'no quote is fabricated for a market with no provider price',
  );
}

/** Deterministic gates return a category plus a user-safe message. */
export async function testStructuredRejections(): Promise<void> {
  const { adapter } = buildAdapter([
    ['EUR/USD', 1.14, 1.141],
  ]);

  const offGrid = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 1.234,
  });

  assert(
    offGrid.rejection?.category === 'ORDER_SIZE_INVALID',
    'an invalid size is categorised as ORDER_SIZE_INVALID',
  );
  assert(
    offGrid.rejection?.message ===
      'That order size is not valid for this market. Check the allowed size and precision.',
    'the size rejection uses the user-safe message',
  );

  const oversize = await adapter.placeMarketOrder({
    symbol: 'EUR/USD',
    side: 'BUY',
    volume: 500_000,
  });

  assert(
    oversize.rejection?.category === 'ORDER_SIZE_INVALID',
    'an oversized order is categorised as ORDER_SIZE_INVALID',
  );

  const unknown = await adapter.placeMarketOrder({
    symbol: 'Nope',
    side: 'BUY',
    volume: 1,
  });

  assert(
    unknown.rejection?.category === 'UNKNOWN_INSTRUMENT',
    'an unlisted market is categorised as UNKNOWN_INSTRUMENT',
  );
}

/**
 * Demo execution charges no fees, and nothing in the repository claims a
 * Hyperliquid fee of any fixed amount.
 */
export async function testDemoFeeSemantics(): Promise<void> {
  const { adapter } = buildAdapter([['Gold', 4000, 4001]]);

  const opened = await adapter.placeMarketOrder({
    symbol: 'Gold',
    side: 'BUY',
    volume: 1,
  });

  assert(opened.success, 'the demo position opens');

  const [position] = await adapter.getPositions('Gold');

  assert(
    position.commission === 0,
    'demo execution records zero commission because no fee model exists',
  );

  const closed = await adapter.closePosition(position.id);

  assert(
    closed.success && closed.trade?.commission === 0,
    'a closed demo trade also records zero commission',
  );

  const sources = collectSourceFiles(
    REPOSITORY_ROOT,
  );

  const hyperliquidFiles = sources.filter(
    (file) =>
      file.startsWith(join(SOURCE_ROOT, 'adapters/hyperliquid')) ||
      file.startsWith(join(SOURCE_ROOT, 'engine/execution')),
  );

  // This guard names the pattern it forbids, so it skips itself.
  const self = fileURLToPath(import.meta.url);

  for (const file of hyperliquidFiles) {
    if (file === self) continue;

    const contents = readFileSync(file, 'utf8');

    /*
     * A fee model that does not exist must not be faked: the only
     * commission value allowed on the execution path is a literal zero.
     */
    for (const match of contents.matchAll(/commission:\s*([0-9][0-9_.]*)/gi)) {
      assert(
        Number(match[1]) === 0,
        `${file} only ever records a zero commission (found ${match[1]})`,
      );
    }

    assert(
      !/commissionPerLot/.test(contents),
      `${file} does not apply a per-lot fee model to Hyperliquid execution`,
    );
  }
}

/** No production market-data path may fabricate an executable price. */
export function testNoSyntheticPriceFallbacks(): void {
  const self = fileURLToPath(import.meta.url);

  for (const file of collectSourceFiles(SOURCE_ROOT)) {
    // This guard names the patterns it forbids, so it skips itself.
    if (file === self) continue;

    const contents = readFileSync(file, 'utf8');

    assert(
      !/simulateTick|getCurrentQuote|syntheticQuote|fakeQuote/.test(contents),
      `${file} contains no synthetic quote generator`,
    );

    assert(
      !/\b(ask|bid)\b[^\n]{0,40}\|\|\s*1(\.0)?\b/.test(contents),
      `${file} contains no bid/ask fallback price`,
    );
  }
}

/**
 * cTrader is no longer part of the product: no application module,
 * import, or configuration reference may remain.
 */
export function testNoCTraderRemains(): void {
  const self = fileURLToPath(import.meta.url);

  for (const file of collectSourceFiles(SOURCE_ROOT)) {
    // This guard names the provider it checks for, so it skips itself.
    if (file === self) continue;

    assert(
      !/ctrader/i.test(readFileSync(file, 'utf8')),
      `${file} contains no legacy broker reference`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  );

  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };

  for (const name of Object.keys(dependencies)) {
    assert(
      !/ctrader|spotware/i.test(name),
      `package.json has no cTrader dependency (${name})`,
    );
  }
}

/** src/ directory of the repository under test. */
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Repository root (parent of src/). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);

      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }

      if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
        files.push(path);
      }
    }
  };

  walk(root);

  return files;
}

export async function runHyperliquidExecutionTests(): Promise<void> {
  testNoCTraderRemains();
  testNoSyntheticPriceFallbacks();
  await testStructuredRejections();
  await testUnavailableMarketPolicy();
  await testDemoFeeSemantics();
  await testEntryAndExitSides();
  testLinearValuationPerAssetClass();
  testQuoteCurrencyConversion();
  await testPositionLifecycle();
  await testOrderSizeGuard();
  await testMixedAssetExposure();
  await testMarginUsesPublishedLeverage();

  console.log(
    'Hyperliquid execution lifecycle, sizing and exposure tests passed.',
  );
}

if (import.meta.main) {
  await runHyperliquidExecutionTests();
}
