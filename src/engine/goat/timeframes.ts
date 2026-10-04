/**
 * Timeframes: the canonical model.
 *
 * There used to be one timeframe per GOAT and an implicit hierarchy above it,
 * which quietly meant every GOAT was a 15m GOAT. A scalper asking for 1m and
 * 5m could not be one, and a GOAT whose objective needed 1h and 4h had no way to
 * say so.
 *
 * So this file holds the one model everything else reads:
 *
 *   1. which resolutions exist (from the data abstraction, never invented)
 *   2. what role a resolution is playing for a given setup resolution
 *   3. what the user explicitly asked for, read from their own words
 *   4. which resolutions a pass should actually read
 *
 * Two rules make it trustworthy rather than convenient:
 *
 *   **Nothing unsupported is ever offered.** The supported set is the
 *   provider's, and a request for a resolution outside it is refused with a
 *   reason rather than quietly approximated. A "5m" that is really 15m is worse
 *   than a refusal.
 *
 *   **A role is relative, not absolute.** 5m is entry timing for a 15m setup
 *   and higher-timeframe context for a 1m scalper. Nothing here decides which
 *   resolutions matter; it only describes the relationship between the ones
 *   that do.
 */

import type { Timeframe } from '../../types/trading';

export type { Timeframe };

/**
 * The resolutions this product can read.
 *
 * Taken from the canonical `Timeframe` type rather than re-declared, so a
 * resolution cannot exist in a prompt and not in the data layer. A venue that
 * cannot serve one of these at a historical range reports that fact at load
 * time (see `SimulationEnvironment` and the session's history report) instead
 * of the product pretending otherwise.
 */
export const SUPPORTED_TIMEFRAMES: readonly Timeframe[] = [
  '1m', '5m', '15m', '30m', '1h', '4h', '1d',
] as const;

/** Finest to coarsest. A larger rank is a longer candle. */
const ORDER: readonly Timeframe[] = SUPPORTED_TIMEFRAMES;

/** The resolution a GOAT runs on when neither the user nor the goal named one. */
export const DEFAULT_GOAT_TIMEFRAME: Timeframe = '15m';

/**
 * Upper bound on the resolutions one pass reads.
 *
 * Four is not arbitrary: it is enough to express regime → structure → setup →
 * trigger, and it is the point past which more candles stop informing a decision
 * and start costing latency and prompt size. A GOAT that genuinely needs a
 * fifth asks for it explicitly through dynamic acquisition, which is a decision
 * on the record rather than a default.
 */
export const MAX_TIMEFRAMES_PER_PASS = 4;

export function isSupportedTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

export function rankOf(timeframe: string): number {
  return ORDER.indexOf(timeframe as Timeframe);
}

/** Negative when `a` is the finer resolution. */
export function compareTimeframes(a: string, b: string): number {
  return rankOf(a) - rankOf(b);
}

/**
 * What a resolution is *for* in a given pass.
 *
 * Named for the job rather than the size, because the same size does different
 * work depending on the objective: 1h is "regime" to a day trader and
 * "structure" to someone scalping 1m.
 */
export type TimeframeRole = 'REGIME' | 'STRUCTURE' | 'SETUP' | 'CONFIRMATION' | 'ENTRY';

export const TIMEFRAME_ROLE_LABELS: Readonly<Record<TimeframeRole, string>> = {
  REGIME: 'regime',
  STRUCTURE: 'higher-timeframe structure',
  SETUP: 'setup',
  CONFIRMATION: 'confirmation',
  ENTRY: 'entry timing',
};

/**
 * The role a resolution plays, given the setup resolution.
 *
 * Purely positional, and deliberately explainable: the coarsest read is the
 * regime, everything coarser than the setup is structure, the setup is the
 * setup, and the finest read is entry timing with anything between it as
 * confirmation. There is no judgement here — deciding *which* resolutions to
 * read is the agent's and the user's job, and that decision is recorded when it
 * is made.
 */
export function roleFor(setup: string, timeframe: string): TimeframeRole {
  const setupRank = rankOf(setup);
  const rank = rankOf(timeframe);
  if (rank === setupRank) return 'SETUP';
  if (rank > setupRank) return rank === ORDER.length - 1 ? 'REGIME' : 'STRUCTURE';
  // Finer than the setup: the finest read is entry timing.
  return rank === 0 ? 'ENTRY' : 'CONFIRMATION';
}

/** One resolution, and the job it is doing. */
export interface TimeframeRead {
  timeframe: Timeframe;
  role: TimeframeRole;
  /** Why it was read, in words a reader can check. */
  reason: string;
}

/**
 * Why a resolution is in this pass, as a sentence fragment.
 *
 * Carried into the prompt and into the agent log, because "read 1h" does not
 * tell a reader whether the agent was checking a regime or looking for an
 * entry, and the two lead to different conclusions from the same candles.
 */
export function reasonFor(setup: string, timeframe: string): string {
  const role = roleFor(setup, timeframe);
  if (role === 'SETUP') return 'the resolution this GOAT acts on';
  if (role === 'REGIME') return 'the broad regime the setup sits inside';
  if (role === 'STRUCTURE') return `structure the ${setup} setup must agree with`;
  if (role === 'ENTRY') return `entry timing finer than the ${setup} setup`;
  return `confirmation between ${setup} and the higher context`;
}

/**
 * The timeframes the user named in their own words.
 *
 * Deliberately literal: it looks for the resolution strings themselves
 * ("1m", "5m", "15m", "1h", "4h", "1d") and never guesses from adjectives like
 * "short-term" or "scalp". Two reasons. A word like "short-term" means
 * something different to every trader, and silently expanding it into 1m and
 * 5m would be the system inventing an intent. And the model's own reading of
 * the objective is available alongside this, so the union of the two is
 * available without the deterministic side pretending to understand prose.
 *
 * The bound on what it finds matters too: "15" on its own is not a timeframe,
 * and "1000" is not either. Only the canonical forms count, which is what makes
 * this safe to run over any user text.
 */
export function timeframesInStatement(statement: string): Timeframe[] {
  if (!statement) return [];
  // A canonical resolution is a digit group followed by a single unit letter.
  const found = new Set<Timeframe>();
  for (const match of statement.matchAll(/(?:^|[^0-9a-z])(\d{1,2})\s*(m|h|d)(?![a-z0-9])/gi)) {
    const value = `${Number(match[1])}${match[2].toLowerCase()}`;
    if (isSupportedTimeframe(value)) found.add(value);
  }
  return ORDER.filter((timeframe) => found.has(timeframe));
}

/**
 * How a GOAT's timeframes are decided.
 *
 * Three cases, and the third is the important one:
 *
 *   - the user or the goal named resolutions → those, honoured exactly
 *   - a single resolution is named → it, plus nothing invented
 *   - nothing is named → the GOAT chooses from the whole menu, and whatever it
 *     picks is recorded
 *
 * The default is deliberately "let the agent decide" rather than "15m". A
 * 15m default is a decision made on the user's behalf, and it is the reason a
 * scalper used to be forced into a medium-term architecture.
 */
export type TimeframeStrategy = 'DECLARED' | 'CHOOSE';

export interface TimeframePlanInput {
  /** Resolutions the goal or the user named. */
  declared?: string[];
  /** The resolution the deployment runs on, when one was chosen explicitly. */
  setup?: string;
}

export interface TimeframePlan {
  strategy: TimeframeStrategy;
  /** Finest to coarsest, deduplicated, at most `MAX_TIMEFRAMES_PER_PASS`. */
  reads: TimeframeRead[];
  /** The resolution this GOAT acts on. */
  setup: Timeframe;
  /** What the resolutions are for, in one sentence, for the prompt and the log. */
  summary: string;
}

/**
 * Which resolutions one pass reads, and why.
 *
 * With a declared set, the plan is the user's list truncated to the bound — a
 * GOAT that was told "1m and 5m" gets exactly those two, and never a 15m
 * nobody asked for. Without one, the plan is the setup resolution plus the
 * nearest coarser and finer neighbours, which is the minimum a multi-resolution
 * read needs to be a multi-resolution read.
 */
export function resolveTimeframePlan(input: TimeframePlanInput): TimeframePlan {
  const declared = (input.declared ?? []).filter(isSupportedTimeframe);
  const setup = isSupportedTimeframe(input.setup)
    ? input.setup
    : declared.length > 0
      ? declared[Math.floor(declared.length / 2)]
      : DEFAULT_GOAT_TIMEFRAME;

  const chosen = declared.length > 0 ? [...declared] : defaultNeighbourhood(setup);
  const withSetup = truncateAround(
    ORDER.filter((timeframe) => chosen.includes(timeframe)),
    setup,
  );

  const reads = withSetup
    .slice()
    .sort(compareTimeframes)
    .map((timeframe) => ({ timeframe, role: roleFor(setup, timeframe), reason: reasonFor(setup, timeframe) }));

  return {
    strategy: declared.length > 0 ? 'DECLARED' : 'CHOOSE',
    reads,
    setup,
    summary: reads
      .map((read) => `${read.timeframe} ${TIMEFRAME_ROLE_LABELS[read.role]}`)
      .join(', '),
  };
}

/**
 * Fit a declared set inside the per-pass bound without losing its shape.
 *
 * Truncating from one end is the wrong cut. A GOAT that named all six
 * resolutions would lose the daily — the regime its intraday work sits inside —
 * to keep three minutes it never asked about. So the ends are kept, the setup is
 * kept, and the remaining slots go to whatever is nearest the setup: the
 * resolutions that actually inform the decision it is about to make.
 */
function truncateAround(ordered: Timeframe[], setup: Timeframe): Timeframe[] {
  if (ordered.length <= MAX_TIMEFRAMES_PER_PASS) {
    return ordered.includes(setup) ? ordered : [setup, ...ordered].slice(0, MAX_TIMEFRAMES_PER_PASS);
  }
  const kept = new Set<Timeframe>([
    setup,
    ordered[0],
    ordered[ordered.length - 1],
  ]);
  const byDistance = ordered
    .filter((timeframe) => !kept.has(timeframe))
    .sort(
      (left, right) =>
        Math.abs(rankOf(left) - rankOf(setup)) - Math.abs(rankOf(right) - rankOf(setup)) ||
        compareTimeframes(left, right),
    );
  for (const timeframe of byDistance) {
    if (kept.size >= MAX_TIMEFRAMES_PER_PASS) break;
    kept.add(timeframe);
  }
  return ORDER.filter((timeframe) => kept.has(timeframe));
}

/**
 * The setup resolution and its two nearest neighbours.
 *
 * Nearest rather than "everything coarser", because the point of a context
 * read is adjacency: the hour above a 15m setup changes the reading of it, and
 * the month does not.
 */
function defaultNeighbourhood(setup: Timeframe): Timeframe[] {
  const rank = Math.max(0, rankOf(setup));
  const chosen = new Set<Timeframe>([setup as Timeframe]);
  if (rank > 0) chosen.add(ORDER[rank - 1]);
  if (rank < ORDER.length - 1) chosen.add(ORDER[rank + 1]);
  return [...chosen];
}

/**
 * Parse a model-proposed list of resolutions.
 *
 * Used on `requestTimeframes` and on the interpretation's own answer. Anything
 * unsupported is dropped rather than approximated, and the refusal is available
 * to the caller so it can say what it ignored instead of quietly narrowing the
 * agent's request.
 */
export function parseTimeframes(value: unknown): { accepted: Timeframe[]; rejected: string[] } {
  if (!Array.isArray(value)) return { accepted: [], rejected: [] };
  const accepted: Timeframe[] = [];
  const rejected: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalised = entry.trim().toLowerCase();
    if (isSupportedTimeframe(normalised)) {
      if (!accepted.includes(normalised)) accepted.push(normalised);
    } else {
      rejected.push(entry.trim());
    }
  }
  return { accepted: ORDER.filter((timeframe) => accepted.includes(timeframe)), rejected };
}

/** Seconds in one candle, from the canonical set. Throws on anything else. */
export function timeframeSeconds(timeframe: string): number {
  if (!isSupportedTimeframe(timeframe)) {
    throw new Error(`${timeframe} is not a resolution this product reads. Supported: ${SUPPORTED_TIMEFRAMES.join(', ')}.`);
  }
  return ({ '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 })[timeframe];
}