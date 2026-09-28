import { Bar, IndicatorOutputs } from '../../types/trading';

/**
 * Technical Indicator Suite
 * Pure calculation functions optimized for backtesting and live strategy iteration.
 */

export function calculateSMA(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const result: number[] = new Array(values.length);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      result[i] = Number((sum / period).toFixed(6));
    } else {
      result[i] = NaN;
    }
  }
  return result;
}

export function calculateEMA(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const result: number[] = new Array(values.length);
  const multiplier = 2 / (period + 1);

  // Initial SMA for first period
  let initialSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      initialSum += values[i];
      result[i] = NaN;
    } else if (i === period - 1) {
      initialSum += values[i];
      result[i] = initialSum / period;
    } else {
      result[i] = Number(((values[i] - result[i - 1]) * multiplier + result[i - 1]).toFixed(6));
    }
  }
  return result;
}

export function calculateRSI(values: number[], period: number = 14): number[] {
  if (period <= 0 || values.length < period + 1) {
    return new Array(values.length).fill(NaN);
  }

  const result: number[] = new Array(values.length).fill(NaN);
  let gains = 0;
  let losses = 0;

  // First period change calculation
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses += -diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = Number((100 - 100 / (1 + rs)).toFixed(2));
  }

  // Wilder's smoothing
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = Number((100 - 100 / (1 + rs)).toFixed(2));
    }
  }

  return result;
}

export function calculateMACD(
  values: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEMA = calculateEMA(values, fastPeriod);
  const slowEMA = calculateEMA(values, slowPeriod);

  const macdLine: number[] = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(fastEMA[i]) && !isNaN(slowEMA[i])) {
      macdLine[i] = Number((fastEMA[i] - slowEMA[i]).toFixed(6));
    }
  }

  // Filter out NaNs for signal calculation, but keep indexing
  const validMacdStarts = macdLine.findIndex((v) => !isNaN(v));
  const signalLine: number[] = new Array(values.length).fill(NaN);
  const histogram: number[] = new Array(values.length).fill(NaN);

  if (validMacdStarts !== -1 && values.length - validMacdStarts >= signalPeriod) {
    const validValues = macdLine.slice(validMacdStarts);
    const validSignal = calculateEMA(validValues, signalPeriod);

    for (let i = 0; i < validSignal.length; i++) {
      const fullIndex = validMacdStarts + i;
      signalLine[fullIndex] = validSignal[i];
      if (!isNaN(macdLine[fullIndex]) && !isNaN(signalLine[fullIndex])) {
        histogram[fullIndex] = Number((macdLine[fullIndex] - signalLine[fullIndex]).toFixed(6));
      }
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

export function calculateBollingerBands(
  values: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calculateSMA(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    let sumSquares = 0;
    const mean = middle[i];
    for (let j = 0; j < period; j++) {
      sumSquares += Math.pow(values[i - j] - mean, 2);
    }
    const stdDev = Math.sqrt(sumSquares / period);
    upper[i] = Number((mean + stdDevMultiplier * stdDev).toFixed(6));
    lower[i] = Number((mean - stdDevMultiplier * stdDev).toFixed(6));
  }

  return { upper, middle, lower };
}

export function calculateATR(bars: Bar[], period: number = 14): number[] {
  if (bars.length === 0 || period <= 0) return [];
  const tr: number[] = new Array(bars.length);
  tr[0] = bars[0].high - bars[0].low;

  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  return calculateEMA(tr, period);
}

export const indicators: IndicatorOutputs = {
  sma: calculateSMA,
  ema: calculateEMA,
  rsi: calculateRSI,
  macd: calculateMACD,
  bollingerBands: calculateBollingerBands,
  atr: calculateATR,
};
