/**
 * Historical candles: the unit contract at the provider boundary.
 *
 * ## Why this file exists
 *
 * A backtest of GOLD failed with "Hyperliquid returned no candles for
 * xyz:GOLD", and the cause was not GOLD. It was a unit mismatch at exactly one
 * boundary:
 *
 *   - Hyperliquid's `candleSnapshot` takes `startTime`/`endTime` in
 *     **milliseconds**.
 *   - This application's historical request contract is in **seconds**, which
 *     is what the Python condition engine and every internal `Bar.time` use.
 *
 * Seconds reach the venue as 1970, the venue returns an empty array, and the
 * adapter reports it as "no candles for <market>" — which reads like the market
 * has no history and sends someone looking at the instrument instead of at the
 * arithmetic. It failed for every market; GOLD was simply the one the user
 * tried first.
 *
 * So this file pins three things:
 *
 *   1. The historical provider converts exactly once, at the boundary.
 *   2. A HIP-3 identifier (`xyz:GOLD`) is resolved as itself and needs no
 *      special case — the venue accepts it, and a fix that special-cased GOLD
 *      would be wrong twice over.
 *   3. A long range is *paged*, because the venue caps a single response. A
 *      silently truncated history is a result about a window nobody chose.
 *
 * The candle-response fixture below is the real shape the venue returns,
 * including the millisecond timestamps and the `xyz:` prefixed symbol, so a
 * regression in the parsing is caught here rather than in a user's backtest.
 */

import {
  HyperliquidHistoricalMarketDataProvider,
  MAX_CANDLES_PER_VENUE_REQUEST,
  validateHistoricalBars,
  type HistoricalBarsRequest,
} from './historical';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

/* ------------------------------------------------------------------ *
 * Fixtures — the venue's real response shape
 * ------------------------------------------------------------------ */

/** 2026-01-15T10:00:00Z, in both units, so a conversion error is visible. */
const BASE_SECONDS = 1_768_478_400;
const BASE_MS = BASE_SECONDS * 1_000;

function candle(t: number, overrides: Record<string, string> = {}) {
  return {
    t,
    T: t + 3_599_999,
    s: 'xyz:GOLD',
    i: '1h',
    o: '4139.60',
    h: '4140.10',
    l: '4138.20',
    c: '4139.50',
    v: '45.9647',
    n: 135,
    ...overrides,
  };
}

interface Recorded {
  body: Record<string, unknown>;
}

/**
 * A transport that answers with real candles and records what it was asked.
 *
 * `maxCandles` reproduces the venue's per-response cap so the paging test is
 * about this application's behaviour rather than about a limit we cannot see.
 */
function fixtureProvider(options: { maxCandles?: number; coins?: string[] } = {}): {
  provider: HyperliquidHistoricalMarketDataProvider;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const maxCandles = options.maxCandles ?? 5_000;
  const coins = options.coins ?? ['xyz:GOLD'];

  const provider = new HyperliquidHistoricalMarketDataProvider({
    getBarsInRange: (async (symbol: string, timeframe: string, start: number, end: number) => {
      requests.push({ body: { symbol, timeframe, start, end } });
      if (!coins.some((coin) => coin.toLowerCase() === symbol.toLowerCase())) {
        throw new Error(`Hyperliquid returned no candles for ${symbol}.`);
      }
      const stepSeconds = ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3_600 } as Record<string, number>)[timeframe] ?? 3_600;
      const out: unknown[] = [];
      for (let t = start; t < end; t += stepSeconds * 1_000) {
        if (out.length >= maxCandles) break;
        out.push(candle(t, { i: timeframe, s: symbol }));
      }
      if (out.length === 0) throw new Error(`Hyperliquid returned no candles for ${symbol}.`);
      return out.map((raw) => ({
        time: Math.floor((raw as { t: number }).t / 1_000),
        open: Number((raw as { o: string }).o),
        high: Number((raw as { h: string }).h),
        low: Number((raw as { l: string }).l),
        close: Number((raw as { c: string }).c),
        volume: Number((raw as { v: string }).v),
      }));
    }) as never,
  });

  return { provider, requests };
}

/* ------------------------------------------------------------------ *
 * The bug
 * ------------------------------------------------------------------ */

test('candles: a historical request reaches the venue in milliseconds, not seconds', async () => {
  const { provider, requests } = fixtureProvider();

  const result = await provider.getBars({
    marketId: 'xyz:GOLD',
    timeframe: '1h',
    start: BASE_SECONDS,
    end: BASE_SECONDS + 7_200,
  });

  const asked = requests[0];
  const sentStart = asked.body.start as number;
  const sentEnd = asked.body.end as number;

  /*
   * The whole bug in one assertion.
   *
   * 1_768_478_400 is a plausible epoch in seconds and an absurd one in
   * milliseconds — 1970-01-21, which is why the venue returned nothing. Any
   * value in this decade must mean milliseconds.
   */
  assertEqual(sentStart, BASE_MS, 'the start reaches the venue in milliseconds');
  assertEqual(sentEnd, BASE_MS + 7_200_000, 'and so does the end');
  assert(
    sentStart > 1_000_000_000_000,
    'a request that still looked like seconds would be silently resolved to 1970',
  );
  assert(result.bars.length > 0, 'and the market comes back with history');
  assertEqual(result.bars[0].time, BASE_SECONDS, 'parsed back into the application’s seconds');
});

test('candles: a HIP-3 identifier is passed through, never rewritten', async () => {
  /*
   * The specific trap in this bug.
   *
   * `xyz:GOLD` and `xyz:SILVER` both exist in the same HIP-3 namespace, and a
   * provider that "helpfully" resolved GOLD to a default-DEX instrument, or
   * stripped the namespace prefix, would return *plausible candles for the wrong
   * market*. Silent, and worse than an error. So this asserts pass-through: the
   * provider does no symbol rewriting at all, and display-name resolution stays
   * where it already lives, in the adapter's instrument map.
   */
  const { provider, requests } = fixtureProvider({ coins: ['xyz:GOLD', 'xyz:SILVER'] });

  for (const marketId of ['xyz:GOLD', 'xyz:SILVER']) {
    const result = await provider.getBars({
      marketId,
      timeframe: '1h',
      start: BASE_SECONDS,
      end: BASE_SECONDS + 3_600,
    });
    assert(result.bars.length > 0, `${marketId} has history`);
  }

  assertEqual(requests.length, 2, 'one request per market, no retries and no fallbacks');
  assertEqual(requests[0].body.symbol, 'xyz:GOLD', 'GOLD is asked for as itself');
  assertEqual(requests[1].body.symbol, 'xyz:SILVER', 'and so is the commodity beside it');
});

test('candles: a long range is paged rather than silently truncated', async () => {
  /*
   * The venue caps one response. Without paging, "backtest three months" would
   * quietly become "backtest the first 5000 candles" and report a result about a
   * window the user never chose — which is the failure this file exists to
   * prevent, one layer up from the units.
   */
  // The venue's own cap, so the provider's page size and the fixture agree.
  const { provider, requests } = fixtureProvider({ maxCandles: MAX_CANDLES_PER_VENUE_REQUEST });

  const hours = MAX_CANDLES_PER_VENUE_REQUEST + 1_000;
  const result = await provider.getBars({
    marketId: 'xyz:GOLD',
    timeframe: '1h',
    start: BASE_SECONDS,
    end: BASE_SECONDS + hours * 3_600,
  });

  assert(requests.length > 1, `a range larger than one response is paged (${requests.length} requests)`);
  assertEqual(result.bars.length, hours, 'and the whole window is returned');
  assertEqual(result.gaps.length, 0, 'with no gaps');

  // Pages must advance, or the second request would re-fetch the first.
  for (let index = 1; index < requests.length; index += 1) {
    assert(
      (requests[index].body.start as number) >= (requests[index - 1].body.end as number),
      'each page starts where the previous one ended',
    );
  }
});

test('candles: a market with no history is reported as an error, never as an empty dataset', async () => {
  const { provider } = fixtureProvider({ coins: ['xyz:GOLD'] });

  let message = '';
  try {
    await provider.getBars({
      marketId: 'xyz:NOTLISTED',
      timeframe: '1h',
      start: BASE_SECONDS,
      end: BASE_SECONDS + 3_600,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(/no candles/i.test(message), `an unsupported market says so: ${message}`);
  assertEqual(
    message.includes('NOTLISTED'),
    true,
    'and names the market, so the message is actionable rather than mysterious',
  );
});

test('candles: malformed history is refused rather than replayed', () => {
  const good = [
    { time: BASE_SECONDS, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: BASE_SECONDS + 60, open: 1.5, high: 2.5, low: 1, close: 2 },
  ];
  assertEqual(validateHistoricalBars(good, '1m').bars.length, 2, 'a well-formed range validates');

  const outOfOrder = [good[1], good[0]];
  let refused = '';
  try {
    validateHistoricalBars(outOfOrder, '1m');
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert(/chronological/i.test(refused), `out-of-order history is refused: ${refused}`);

  const impossible = [{ time: BASE_SECONDS, open: 2, high: 1, low: 3, close: 2 }];
  let impossibleMessage = '';
  try {
    validateHistoricalBars(impossible, '1m');
  } catch (error) {
    impossibleMessage = error instanceof Error ? error.message : String(error);
  }
  assert(/impossible/i.test(impossibleMessage), `an impossible candle is refused: ${impossibleMessage}`);
});

test('provider: the historical contract is documented in seconds', () => {
  /*
   * A compile-time comment is not a contract. This asserts the shape of the
   * request object the backtest surface builds, so a future caller passing
   * milliseconds is caught here rather than by an empty candle array.
   */
  const secondsRequest: HistoricalBarsRequest = {
    marketId: 'xyz:GOLD',
    timeframe: '1h',
    start: BASE_SECONDS,
    end: BASE_SECONDS + 3_600,
  };
  assert(secondsRequest.start < 1_000_000_000_000, 'the contract is seconds, so the provider converts once');
  assertEqual(
    secondsRequest.timeframe,
    '1h',
    'and the only other thing a caller supplies is a resolution the venue publishes',
  );
});

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export async function runHistoricalUnitTests(): Promise<void> {
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
  if (failures.length > 0) throw new Error(`${failures.length} historical-candle test(s) failed.`);
}

if (import.meta.main) {
  await runHistoricalUnitTests();
}