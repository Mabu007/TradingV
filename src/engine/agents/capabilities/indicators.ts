import { AgentCapability } from '../types';
import { pipSizeFor, resolveInstrument } from './instruments';
import { calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../../indicators';

export const indicatorSmaCapability: AgentCapability<
  { symbol?: string; timeframe?: string; period: number; values?: number[] },
  { period: number; latest: number; values: number[] }
> = {
  id: 'indicators.sma',
  name: 'Simple Moving Average (SMA)',
  description: 'Calculates the deterministic Simple Moving Average for a symbol or price array.',
  category: 'indicators',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    period: { type: 'number', required: true, minimum: 1, default: 20 },
    values: { type: 'array', items: { type: 'number' } },
  },
  outputSchema: {
    period: { type: 'number' },
    latest: { type: 'number' },
    values: { type: 'array' },
  },
  async execute(input, context) {
    const period = input.period || 20;
    if (!Number.isInteger(period) || period <= 0) throw new Error('period must be a positive integer.');
    let prices = input.values;

    if (!prices || prices.length === 0) {
      const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
      const tf = input.timeframe || context.timeframe || '5m';
      const bars = await context.env.getMarketBars(symbol, tf, period + 30);
      prices = bars.map((b) => b.close);
    }

    validatePrices(prices);
    const calculated = calculateSMA(prices, period);
    const validValues = calculated.filter((v) => !isNaN(v));
    const latest = validValues.length > 0 ? validValues[validValues.length - 1] : 0;

    return {
      period,
      latest,
      values: calculated,
    };
  },
};

export const indicatorEmaCapability: AgentCapability<
  { symbol?: string; timeframe?: string; period: number; values?: number[] },
  { period: number; latest: number; values: number[] }
> = {
  id: 'indicators.ema',
  name: 'Exponential Moving Average (EMA)',
  description: 'Calculates the deterministic Exponential Moving Average with recency weighting.',
  category: 'indicators',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    period: { type: 'number', required: true, minimum: 1, default: 20 },
    values: { type: 'array', items: { type: 'number' } },
  },
  outputSchema: {
    period: { type: 'number' },
    latest: { type: 'number' },
    values: { type: 'array' },
  },
  async execute(input, context) {
    const period = input.period || 20;
    if (!Number.isInteger(period) || period <= 0) throw new Error('period must be a positive integer.');
    let prices = input.values;

    if (!prices || prices.length === 0) {
      const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
      const tf = input.timeframe || context.timeframe || '5m';
      const bars = await context.env.getMarketBars(symbol, tf, period + 30);
      prices = bars.map((b) => b.close);
    }

    validatePrices(prices);
    const calculated = calculateEMA(prices, period);
    const validValues = calculated.filter((v) => !isNaN(v));
    const latest = validValues.length > 0 ? validValues[validValues.length - 1] : 0;

    return {
      period,
      latest,
      values: calculated,
    };
  },
};

export const indicatorRsiCapability: AgentCapability<
  { symbol?: string; timeframe?: string; period?: number; values?: number[] },
  { period: number; latest: number; condition: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL'; values: number[] }
> = {
  id: 'indicators.rsi',
  name: 'Relative Strength Index (RSI)',
  description: 'Calculates momentum oscillation from 0 to 100 with overbought/oversold boundaries.',
  category: 'indicators',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    period: { type: 'number', minimum: 1, default: 14 },
    values: { type: 'array', items: { type: 'number' } },
  },
  outputSchema: {
    period: { type: 'number' },
    latest: { type: 'number' },
    condition: { type: 'string' },
    values: { type: 'array' },
  },
  async execute(input, context) {
    const period = input.period || 14;
    if (!Number.isInteger(period) || period <= 0) throw new Error('period must be a positive integer.');
    let prices = input.values;

    if (!prices || prices.length === 0) {
      const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
      const tf = input.timeframe || context.timeframe || '5m';
      const bars = await context.env.getMarketBars(symbol, tf, period + 35);
      prices = bars.map((b) => b.close);
    }

    validatePrices(prices);
    const calculated = calculateRSI(prices, period);
    const validValues = calculated.filter((v) => !isNaN(v));
    const latest = validValues.length > 0 ? validValues[validValues.length - 1] : 50;

    let condition: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = 'NEUTRAL';
    if (latest >= 70) condition = 'OVERBOUGHT';
    else if (latest <= 30) condition = 'OVERSOLD';

    return {
      period,
      latest: Number(latest.toFixed(2)),
      condition,
      values: calculated,
    };
  },
};

export const indicatorAtrCapability: AgentCapability<
  { symbol?: string; timeframe?: string; period?: number },
  { period: number; latestPips: number | null; latestValue: number }
> = {
  id: 'indicators.atr',
  name: 'Average True Range (ATR)',
  description: 'Measures market volatility based on true range over a given window.',
  category: 'indicators',
  inputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string', default: '5m' },
    period: { type: 'number', minimum: 1, default: 14 },
  },
  outputSchema: {
    period: { type: 'number' },
    latestPips: {
      type: 'number',
      nullable: true,
      description: 'Only defined for pip-quoted Forex instruments.',
    },
    latestValue: { type: 'number' },
  },
  async execute(input, context) {
    const period = input.period || 14;
    if (!Number.isInteger(period) || period <= 0) throw new Error('period must be a positive integer.');
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const tf = input.timeframe || context.timeframe || '5m';

    const bars = await context.env.getMarketBars(symbol, tf, period + 25);
    if (!bars.every((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))) throw new Error('ATR bars must contain finite prices.');
    const calculated = calculateATR(bars, period);
    const validValues = calculated.filter((v) => !isNaN(v));
    const latest = validValues.length > 0 ? validValues[validValues.length - 1] : 0.001;

    /*
     * ATR is a price distance. It is reported in pips only when the
     * instrument's own metadata declares a pip size.
     */
    const pipSize = pipSizeFor(
      await resolveInstrument(context.env, symbol),
    );

    return {
      period,
      latestPips:
        pipSize !== undefined
          ? Number((latest / pipSize).toFixed(1))
          : null,
      latestValue: Number(latest.toFixed(5)),
    };
  },
};

export const INDICATOR_CAPABILITIES = [
  indicatorSmaCapability,
  indicatorEmaCapability,
  indicatorRsiCapability,
  indicatorAtrCapability,
];

function validatePrices(values: number[]): void {
  if (!values.every((value) => Number.isFinite(value))) throw new Error('Indicator values must all be finite numbers.');
}
