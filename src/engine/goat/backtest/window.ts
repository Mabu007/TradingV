/**
 * Choosing a window in history.
 *
 * The question a user actually has is "when should I send this GOAT back?", and
 * answering it with two `datetime-local` inputs makes them do arithmetic the
 * product already knows how to do. Yesterday, last week, last month: three taps.
 * Everything else stays available, because sometimes the interesting period is
 * a specific Tuesday.
 *
 * ## The base resolution is part of the request
 *
 * Hyperliquid serves one-minute candles for a long history, and a user who picks
 * six months of them would be handed roughly 260,000 bars — tens of megabytes of
 * objects in a browser tab, on a phone, next to a replay that is trying to stay
 * responsive. So the window chooses its own resolution:
 *
 *   short window   -> 1m, because that is the resolution a scalper needs
 *   long window    -> 5m, honestly declared rather than synthesised
 *
 * The replay aggregates upwards from whatever it is given and refuses anything
 * finer, and it *says so* — a GOAT that wanted 1m in a six-month window is told
 * the data is at 5m and can ask again, which is a better answer than being handed
 * 260,000 bars or a silently fabricated 1m series. Nothing finer is ever
 * manufactured from something coarser: that is the one transformation that would
 * make a backtest lie about its own resolution.
 *
 * ## Warm-up is fetched separately, and is not part of the window
 *
 * An indicator needs candles to exist before it can say anything. Those candles
 * come from before `from`, and the moment the user picked is the moment the replay
 * begins. Keeping the two apart here rather than inside the loader is what stops a
 * replay's first tick from being something the agent had already seen.
 */

import type { Timeframe } from '../../../types/trading';

export interface HistoricalWindow {
  /** Historical instant the replay begins at, epoch ms. */
  start: number;
  /** Historical instant the replay ends at, epoch ms. */
  end: number;
  /**
   * The resolution the candles are fetched at.
   *
   * A property of the request rather than an assumption about the user: the
   * loader uses it, the environment declares it, and `history()` reports it when
   * it differs from 1m.
   */
  baseTimeframe: Timeframe;
  /** Why that resolution, in one sentence a reader can check. */
  baseReason: string;
}

/**
 * Fast presets.
 *
 * `span` is a duration and `until` decides which side of it to measure from, so
 * "yesterday" is a whole UTC day rather than "the last twenty-four hours",
 * which is what a person means by it.
 */
export interface HistoricalPreset {
  id: string;
  label: string;
  /** The sentence under the buttons. */
  hint: string;
  days: number;
  /**
   * For `YESTERDAY`: the window is the previous UTC day, boundaries included.
   * Everything else is "the last N days, ending at the most recent closed minute".
   */
  previousUtcDay?: boolean;
}

export const HISTORICAL_PRESETS: readonly HistoricalPreset[] = [
  { id: 'yesterday', label: 'YESTERDAY', hint: 'One whole UTC trading day.', days: 1, previousUtcDay: true },
  { id: 'week', label: 'LAST 7 DAYS', hint: 'The last seven days of one-minute candles.', days: 7 },
  { id: 'month', label: 'LAST 30 DAYS', hint: 'The last month, at one-minute resolution.', days: 30 },
  { id: 'quarter', label: 'LAST 3 MONTHS', hint: 'Three months, at five-minute resolution.', days: 91 },
  { id: 'half', label: 'LAST 6 MONTHS', hint: 'Six months, at five-minute resolution.', days: 182 },
];

/**
 * Above this many days, one-minute candles stop being a reasonable thing to hand
 * a browser.
 *
 * Thirty days is 43,200 bars — already a lot of objects to hold while a replay
 * walks them — and it is where the cost of resolution stops being worth it for
 * the kind of setup a month-long window invites.
 */
const MAX_DAYS_AT_ONE_MINUTE = 30;

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * The newest instant a replay may end at.
 *
 * The most recent minute is still forming. A replay whose window included it would
 * be replaying an unfinished candle, which the environment would refuse to reveal
 * anyway — leaving the clock claiming a time the data has not reached.
 */
export function latestClosedMinute(now: number = Date.now()): number {
  return Math.floor(now / MINUTE) * MINUTE - MINUTE;
}

/** The window a preset describes. */
export function windowForPreset(
  preset: HistoricalPreset,
  now: number = Date.now(),
): { start: number; end: number } {
  if (preset.previousUtcDay) {
    const today = Math.floor(now / DAY) * DAY;
    return { start: today - DAY, end: today };
  }
  const end = latestClosedMinute(now);
  return { start: end - preset.days * DAY, end };
}

/**
 * The resolution a window should be fetched at.
 *
 * Returned with its reason because it is a decision the user is entitled to see
 * rather than a default that happened: "this replay reads 5m candles" is a claim
 * about what the GOAT is working with, and it belongs next to the price.
 */
export function baseResolutionFor(days: number): {
  baseTimeframe: Timeframe;
  reason: string;
} {
  if (days <= MAX_DAYS_AT_ONE_MINUTE) {
    return {
      baseTimeframe: '1m',
      reason: `Read at 1m — the finest resolution this venue serves, and what ${days <= 1 ? 'a single day' : 'a short window'} is for.`,
    };
  }
  return {
    baseTimeframe: '5m',
    reason: `Read at 5m: ${days} days of one-minute candles is ${Math.round(days * 1_440).toLocaleString()} bars for a browser to hold. Higher resolutions are aggregated from it; a finer one is refused rather than invented.`,
  };
}

/**
 * The full request for a preset: the window, its resolution, and the warm-up.
 *
 * The warm-up is returned separately and added by the caller, so nothing that
 * plays the role of "the window" can quietly include history the replay was not
 * supposed to have.
 */
export function windowForPresetRequest(
  preset: HistoricalPreset,
  options: { warmupMinutes: number; now?: number },
): HistoricalWindow & { warmupStart: number } {
  const { start, end } = windowForPreset(preset, options.now);
  const spanDays = Math.max(1, (end - start) / DAY);
  const { baseTimeframe, reason } = baseResolutionFor(spanDays);
  return {
    start,
    end,
    baseTimeframe,
    baseReason: reason,
    warmupStart: start - Math.max(0, options.warmupMinutes) * MINUTE,
  };
}

/** How a window is described in one line, for the surface and for replay history. */
export function describeWindow(start: number, end: number): string {
  const days = (end - start) / DAY;
  if (days < 1.5) {
    const hours = Math.max(1, Math.round(days * 24));
    return hours === 1 ? 'THE LAST HOUR' : `THE LAST ${hours} HOURS`;
  }
  const rounded = Math.round(days);
  return rounded === 1 ? 'YESTERDAY' : `LAST ${rounded} DAYS`;
}
