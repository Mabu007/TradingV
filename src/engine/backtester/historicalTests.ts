import { Bar } from '../../types/trading';
import { validateHistoricalBars } from './historical';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function runHistoricalValidationTests(): void {
  const valid: Bar[] = [
    { time: 0, open: 1, high: 1.1, low: 0.9, close: 1 },
    { time: 60, open: 1, high: 1.2, low: 0.95, close: 1.1 },
    { time: 180, open: 1.1, high: 1.3, low: 1, close: 1.2 },
  ];
  const result = validateHistoricalBars(valid, '1m');
  assert(result.gaps.length === 1, 'legitimate historical gaps are reported');
  let rejected = false;
  try { validateHistoricalBars([valid[1], valid[0]], '1m'); } catch { rejected = true; }
  assert(rejected, 'historical candles must be chronological');
  rejected = false;
  try { validateHistoricalBars([{ ...valid[0], high: 0.8 }], '1m'); } catch { rejected = true; }
  assert(rejected, 'impossible OHLC candles are rejected');
}
