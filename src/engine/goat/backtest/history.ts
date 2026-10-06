/**
 * What a replay left behind.
 *
 * A backtest is only half a product if its answer disappears when the tab does.
 * This is the smallest thing that makes backtesting a laboratory rather than a
 * one-shot: after a run, the summary stays readable, and the next one is one
 * button away rather than one form away.
 *
 * ## What is deliberately not here
 *
 * No persistence. Sessions themselves are in-memory and a refresh destroys this
 * registry along with the JavaScript context that holds it, so writing a summary
 * that outlived the session would be a claim this module cannot keep — and the
 * more damaging kind of claim, because a replay summary is a statement about
 * money. The trade-off is stated in `BacktestManager`'s own header and repeated
 * here rather than papered over with a localStorage key that quietly rots.
 *
 * ## Deduplication, not accumulation
 *
 * Re-running the same GOAT over the same window replaces its summary rather than
 * adding a second one. A history that grew a line per press would become a
 * request log dressed as a results list, and the number a reader compares against
 * — the last run of this setup over this period — would be the hardest to find.
 */

import type { BacktestBehaviour, BacktestPerformance, BacktestReport } from './results';

export interface ReplaySummary {
  /** Market replayed. */
  market: string;
  /** Which GOAT, by objective, so two replays of one idea are recognisable. */
  goal: string;
  name?: string;
  /** The historical window, epoch ms. */
  start: number;
  end: number;
  /** Simulated time actually consumed, epoch ms. */
  simulatedMs: number;
  outcome: BacktestReport['outcome'];
  performance: BacktestPerformance;
  behaviour: BacktestBehaviour;
  /** When the run finished, wall clock. Only ever used for ordering the list. */
  recordedAt: number;
}

/** How many summaries are kept. Enough to compare against; few enough to read. */
const MAX_REPLAY_HISTORY = 12;

const summaries: ReplaySummary[] = [];

export type ReplaySummaryInput = Omit<ReplaySummary, 'recordedAt'>;

/**
 * File a finished run, newest first.
 *
 * Returns the stored summary so a caller can render it without reading the list
 * back — the surface that just produced it should not have to ask again.
 */
export function recordReplaySummary(input: ReplaySummaryInput): ReplaySummary {
  const summary: ReplaySummary = { ...input, recordedAt: Date.now() };
  const existing = summaries.findIndex(
    (candidate) =>
      candidate.market === summary.market &&
      candidate.start === summary.start &&
      candidate.end === summary.end &&
      candidate.goal === summary.goal,
  );

  if (existing >= 0) summaries.splice(existing, 1);
  summaries.unshift(summary);
  if (summaries.length > MAX_REPLAY_HISTORY) summaries.length = MAX_REPLAY_HISTORY;
  return summary;
}

/** Every recorded run, newest first. */
export function replayHistory(): ReplaySummary[] {
  return [...summaries];
}

/** The last run of this market, if there is one. What "TRY LAST MONTH" builds on. */
export function lastReplayFor(market: string): ReplaySummary | undefined {
  return summaries.find((candidate) => candidate.market === market);
}

export function clearReplayHistory(): void {
  summaries.length = 0;
}
