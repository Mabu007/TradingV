import { AgentCapability } from '../types';
import { pipSizeFor, resolveInstrument } from './instruments';

export const structureSwingHighsCapability: AgentCapability<
  { symbol?: string; timeframe?: string; lookbackBars?: number; pivotBars?: number },
  { highs: Array<{ index: number; price: number; time: number }> }
> = {
  id: 'structure.swingHighs',
  name: 'Swing Highs Detection',
  description: 'Identifies local peak price points (fractal/pivot swing highs) across historical candles.',
  category: 'structure',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    lookbackBars: { type: 'number', default: 60 },
    pivotBars: { type: 'number', default: 3 },
  },
  outputSchema: {
    highs: { type: 'array' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const tf = input.timeframe || context.timeframe || '5m';
    const lookback = input.lookbackBars || 60;
    const pivot = input.pivotBars || 3;

    const bars = await context.env.getMarketBars(symbol, tf, lookback);
    validateStructureBars(bars);
    const highs: Array<{ index: number; price: number; time: number }> = [];

    for (let i = pivot; i < bars.length - pivot; i++) {
      const currentHigh = bars[i].high;
      let isSwing = true;

      for (let j = 1; j <= pivot; j++) {
        if (bars[i - j].high >= currentHigh || bars[i + j].high > currentHigh) {
          isSwing = false;
          break;
        }
      }

      if (isSwing) {
        highs.push({
          index: i,
          price: currentHigh,
          time: bars[i].time,
        });
      }
    }

    return { highs };
  },
};

export const structureSwingLowsCapability: AgentCapability<
  { symbol?: string; timeframe?: string; lookbackBars?: number; pivotBars?: number },
  { lows: Array<{ index: number; price: number; time: number }> }
> = {
  id: 'structure.swingLows',
  name: 'Swing Lows Detection',
  description: 'Identifies local trough price points (fractal/pivot swing lows) across historical candles.',
  category: 'structure',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    lookbackBars: { type: 'number', default: 60 },
    pivotBars: { type: 'number', default: 3 },
  },
  outputSchema: {
    lows: { type: 'array' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const tf = input.timeframe || context.timeframe || '5m';
    const lookback = input.lookbackBars || 60;
    const pivot = input.pivotBars || 3;

    const bars = await context.env.getMarketBars(symbol, tf, lookback);
    validateStructureBars(bars);
    const lows: Array<{ index: number; price: number; time: number }> = [];

    for (let i = pivot; i < bars.length - pivot; i++) {
      const currentLow = bars[i].low;
      let isSwing = true;

      for (let j = 1; j <= pivot; j++) {
        if (bars[i - j].low <= currentLow || bars[i + j].low < currentLow) {
          isSwing = false;
          break;
        }
      }

      if (isSwing) {
        lows.push({
          index: i,
          price: currentLow,
          time: bars[i].time,
        });
      }
    }

    return { lows };
  },
};

export const structureSupportResistanceCapability: AgentCapability<
  { symbol?: string; timeframe?: string; lookbackBars?: number },
  { resistanceLevels: number[]; supportLevels: number[]; currentPrice: number }
> = {
  id: 'structure.supportResistance',
  name: 'Support & Resistance Zones',
  description: 'Extracts clustered key horizontal support and resistance price levels.',
  category: 'structure',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    lookbackBars: { type: 'number', default: 80 },
  },
  outputSchema: {
    resistanceLevels: { type: 'array', items: { type: 'number' } },
    supportLevels: { type: 'array', items: { type: 'number' } },
    currentPrice: { type: 'number' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const tf = input.timeframe || context.timeframe || '5m';
    const lookback = input.lookbackBars || 80;

    const bars = await context.env.getMarketBars(symbol, tf, lookback);
    validateStructureBars(bars);
    const quote = await context.env.getMarketQuote(symbol);
    const currentPrice = quote.bid;

    const highs: number[] = [];
    const lows: number[] = [];

    for (let i = 2; i < bars.length - 2; i++) {
      if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high &&
          bars[i].high > bars[i + 1].high && bars[i].high > bars[i + 2].high) {
        highs.push(bars[i].high);
      }
      if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
          bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
        lows.push(bars[i].low);
      }
    }

    // Resistance: levels strictly above current price
    const resistanceLevels = Array.from(new Set(highs.filter((p) => p > currentPrice)))
      .sort((a, b) => a - b)
      .slice(0, 3);

    // Support: levels strictly below current price
    const supportLevels = Array.from(new Set(lows.filter((p) => p < currentPrice)))
      .sort((a, b) => b - a)
      .slice(0, 3);

    return {
      resistanceLevels,
      supportLevels,
      currentPrice,
    };
  },
};

export const structureBreakoutCapability: AgentCapability<
  { symbol?: string; timeframe?: string; lookbackBars?: number; minPipsBuffer?: number; minPriceBuffer?: number },
  { breakout: 'BULLISH' | 'BEARISH' | 'NONE'; level: number; currentPrice: number; priceDistance: number; pipDistance: number | null }
> = {
  id: 'structure.breakout',
  name: 'Breakout Detection',
  description: 'Determines whether the market has broken out above previous swing highs or below swing lows.',
  category: 'structure',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    lookbackBars: { type: 'number', default: 50 },
    minPipsBuffer: {
      type: 'number',
      description: 'Forex only. Buffer in pips for pip-quoted instruments.',
    },
    minPriceBuffer: {
      type: 'number',
      description: 'Buffer as a raw price distance. Use for any asset class.',
    },
  },
  outputSchema: {
    breakout: { type: 'string' },
    level: { type: 'number' },
    currentPrice: { type: 'number' },
    priceDistance: { type: 'number' },
    pipDistance: {
      type: 'number',
      nullable: true,
      description: 'Only defined for pip-quoted Forex instruments.',
    },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const tf = input.timeframe || context.timeframe || '5m';
    const lookback = input.lookbackBars || 50;

    const bars = await context.env.getMarketBars(symbol, tf, lookback);
    validateStructureBars(bars);
    const quote = await context.env.getMarketQuote(symbol);
    const currentPrice = quote.bid;

    /*
     * Breakout buffers are distances. A pip buffer is only honoured for
     * instruments whose metadata declares a pip size, so Gold and index
     * breakouts are never measured in EUR/USD pips.
     */
    const pipSize = pipSizeFor(
      await resolveInstrument(context.env, symbol),
    );

    const minBuffer =
      input.minPriceBuffer ??
      (pipSize !== undefined ? (input.minPipsBuffer ?? 0) * pipSize : undefined) ??
      0;

    const asDistance = (distance: number) => ({
      priceDistance: distance,
      pipDistance:
        pipSize !== undefined
          ? Number((distance / pipSize).toFixed(1))
          : null,
    });

    if (bars.length < 15) {
      return {
        breakout: 'NONE',
        level: 0,
        currentPrice,
        ...asDistance(0),
      };
    }

    // Range high/low excluding the current in-progress bar
    const priorBars = bars.slice(0, -1);
    const rangeHigh = Math.max(...priorBars.map((b) => b.high));
    const rangeLow = Math.min(...priorBars.map((b) => b.low));

    const highDiff = currentPrice - rangeHigh;
    const lowDiff = rangeLow - currentPrice;

    if (highDiff >= minBuffer) {
      return {
        breakout: 'BULLISH',
        level: rangeHigh,
        currentPrice,
        ...asDistance(highDiff),
      };
    }

    if (lowDiff >= minBuffer) {
      return {
        breakout: 'BEARISH',
        level: rangeLow,
        currentPrice,
        ...asDistance(lowDiff),
      };
    }

    return {
      breakout: 'NONE',
      level: 0,
      currentPrice,
      ...asDistance(0),
    };
  },
};

export const STRUCTURE_CAPABILITIES = [
  structureSwingHighsCapability,
  structureSwingLowsCapability,
  structureSupportResistanceCapability,
  structureBreakoutCapability,
];

function validateStructureBars(bars: Array<{ high: number; low: number }>): void {
  if (!bars.every((bar) => Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high >= bar.low)) {
    throw new Error('Market bars must contain finite, correctly ordered high/low prices.');
  }
}
