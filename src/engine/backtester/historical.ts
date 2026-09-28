import { Bar, Timeframe } from '../../types/trading';
import { HyperliquidMarketDataAdapter, hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';

export interface HistoricalBarsRequest {
  marketId: string;
  timeframe: Timeframe;
  start: number;
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

export class HyperliquidHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  constructor(private readonly adapter: Pick<HyperliquidMarketDataAdapter, 'getBarsInRange'> = hyperliquidMarketData) {}

  async getBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResult> {
    if (!request.marketId || !Number.isFinite(request.start) || !Number.isFinite(request.end) || request.end <= request.start) throw new Error('Choose a valid historical start and end time.');
    const bars = await this.adapter.getBarsInRange(request.marketId, request.timeframe, request.start, request.end);
    return validateHistoricalBars(bars, request.timeframe);
  }
}

function timeframeSeconds(timeframe: Timeframe): number {
  return ({ '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 })[timeframe];
}

export const historicalMarketDataProvider = new HyperliquidHistoricalMarketDataProvider();
