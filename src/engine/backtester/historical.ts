import { Bar, Timeframe } from '../../types/trading';
import { HyperliquidMarketDataAdapter, hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { timeframeSeconds as canonicalTimeframeSeconds } from '../goat/timeframes';

export interface HistoricalBarsRequest {
  marketId: string;
  timeframe: Timeframe;
  /**
   * Start of the window, in **seconds**.
   *
   * Seconds, not milliseconds, because that is the unit every candle in this
   * system carries and the unit the Python condition engine uses. The venue's
   * millisecond requirement is a fact about `candleSnapshot`, and it is handled
   * once — here, at the boundary — rather than by every caller remembering it.
   *
   * Getting this wrong is silent and total: seconds reach the venue as 1970, the
   * venue returns an empty array, and the failure surfaces as "no candles for
   * <market>", which looks like the market has no history rather than like the
   * range being nonsense. See `historicalUnitTests.ts`.
   */
  start: number;
  /** End of the window, in **seconds**. See `start`. */
  end: number;
}

export interface HistoricalBarsResult {
  bars: Bar[];
  gaps: Array<{ from: number; to: number }>;
}

export interface HistoricalMarketDataProvider {
  getBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResult>;
}

export function validateHistoricalBars(bars: Bar[], timeframe: Timeframe): HistoricalBarsResult {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('Historical data returned no candles for this period.');
  const interval = timeframeSeconds(timeframe);
  const gaps: Array<{ from: number; to: number }> = [];
  let previous: Bar | undefined;
  for (const bar of bars) {
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) throw new Error('Historical data contains a non-finite candle.');
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) throw new Error(`Historical data contains an impossible OHLC candle at ${bar.time}.`);
    if (previous) {
      if (bar.time <= previous.time) throw new Error('Historical data must be strictly chronological without duplicate candles.');
      const distance = bar.time - previous.time;
      if (distance > interval) gaps.push({ from: previous.time, to: bar.time });
      if (distance < interval) throw new Error(`Historical data contains overlapping candles near ${bar.time}.`);
    }
    previous = bar;
  }
  return { bars: bars.map((bar) => ({ ...bar })), gaps };
}

/**
 * The most candles one `candleSnapshot` response will carry.
 *
 * The venue truncates a long request rather than refusing it, so a caller that
 * trusts one response gets a *shorter* history than it asked for and no error.
 * That is the worst possible failure for a backtest: the result looks like
 * data, it is contiguous, and it silently describes a different window than the
 * one the user chose.
 */
export const MAX_CANDLES_PER_VENUE_REQUEST = 5_000;

/**
 * Upper bound on paging, so a request for a decade cannot spin forever.
 *
 * 200 pages of 5 000 candles is far more history than this venue serves at any
 * interval, so reaching it means the source has run out — which the caller is
 * told rather than left waiting for.
 */
const MAX_HISTORICAL_PAGES = 200;

export class HyperliquidHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  constructor(private readonly adapter: Pick<HyperliquidMarketDataAdapter, 'getBarsInRange'> = hyperliquidMarketData) {}

  async getBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResult> {
    if (!request.marketId || !Number.isFinite(request.start) || !Number.isFinite(request.end) || request.end <= request.start) {
      throw new Error('Choose a valid historical start and end time.');
    }

    const secondsPerCandle = timeframeSeconds(request.timeframe);
    const requestedCandles = Math.ceil((request.end - request.start) / secondsPerCandle);
    /*
     * The one conversion between the application's seconds and the venue's
     * milliseconds.
     *
     * `getBarsInRange` is venue-native and speaks milliseconds — the live
     * `getBars` path already hands it `Date.now()`. Everything historical speaks
     * seconds, so the translation belongs here, where the historical contract is
     * owned, and nowhere else.
     */
    const startMs = request.start * 1_000;
    const endMs = request.end * 1_000;

    const singlePage = requestedCandles <= MAX_CANDLES_PER_VENUE_REQUEST;
    const pageSpanMs = MAX_CANDLES_PER_VENUE_REQUEST * secondsPerCandle * 1_000;
    const collected: Bar[] = [];
    let cursorMs = startMs;

    for (let page = 0; page < MAX_HISTORICAL_PAGES; page += 1) {
      const to = Math.min(endMs, cursorMs + pageSpanMs);
      const bars = await this.adapter.getBarsInRange(request.marketId, request.timeframe, cursorMs, to);
      collected.push(...bars);

      if (singlePage || to >= endMs) break;
      // Fewer candles than asked for means the venue had nothing more to give.
      if (bars.length < MAX_CANDLES_PER_VENUE_REQUEST) break;
      const nextMs = (bars[bars.length - 1].time + secondsPerCandle) * 1_000;
      // A page that did not move would loop forever.
      if (nextMs <= cursorMs) break;
      cursorMs = nextMs;
    }

    return validateHistoricalBars(collected, request.timeframe);
  }
}

/**
 * Seconds in one candle.
 *
 * Sourced from the canonical timeframe model rather than restated, so a
 * resolution cannot be readable here and not elsewhere.
 */
function timeframeSeconds(timeframe: Timeframe): number {
  return canonicalTimeframeSeconds(timeframe);
}

export const historicalMarketDataProvider = new HyperliquidHistoricalMarketDataProvider();
