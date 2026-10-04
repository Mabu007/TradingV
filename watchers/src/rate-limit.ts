/**
 * Application-layer rate limits.
 *
 * The Watcher already limits how fast *one bot* may fire -- a cooldown,
 * an hourly cap, a daily cap. Those are product rules, not abuse
 * controls: they do nothing until a watcher exists, and a client that
 * keeps deploying, starting, stopping and deleting never touches them.
 *
 * What this limits is the number of *requests* one caller may make per
 * route class, so a single client cannot spin Durable Objects or
 * saturate the edge by looping over its own routes. It is deliberately
 * small and local: a fixed window per user, held in one Durable Object.
 * That is enough to stop trivial abuse and resource exhaustion without
 * pretending to be a distributed limiter.
 *
 * The decision logic here is Cloudflare-free so it can be tested with no
 * runtime, exactly like the watcher itself.
 */

/** Route classes, so the limit follows the cost rather than the path. */
export type RateBucket = 'read' | 'lifecycle' | 'evaluate' | 'feed';

export const RATE_LIMITS: Readonly<Record<RateBucket, number>> = Object.freeze({
  /*
   * Reads are the cheapest and the most common: the UI polls. A limit
   * low enough to trip during normal use would look like an outage, so
   * this is generous.
   */
  read: 300,
  /*
   * Lifecycle calls each touch object storage and change durable state.
   * No honest client needs more than a handful a minute; a loop of a
   * few hundred is a client that is not a client.
   */
  lifecycle: 30,
  /*
   * Evaluation is one wake request. A burst above this is a stuck
   * retry loop, which is exactly the case that turns one bad condition
   * into a self-inflicted denial of service.
   */
  evaluate: 120,
  feed: 240,
});

/** The window a count applies to. */
export const RATE_WINDOW_MS = 60_000;

/** The part of the state this module owns. */
export interface RateLimitState {
  /** Start of the current fixed window, epoch ms. */
  windowStart: number;
  /** Requests per bucket in the current window. */
  counts: Record<string, number>;
}

export interface RateDecision {
  allowed: boolean;
  /** The bucket's limit, for the response headers. */
  limit: number;
  /** Requests left in this window after this one. */
  remaining: number;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
}

/** An empty state, for a caller seen for the first time. */
export function emptyRateLimitState(now: number): RateLimitState {
  return { windowStart: now, counts: {} };
}

/**
 * Decide whether one request may proceed, and roll the window if needed.
 *
 * Pure, so the same inputs always give the same answer. The caller
 * persists the returned state.
 */
export function consume(
  state: RateLimitState | undefined,
  bucket: RateBucket,
  now: number,
  limits: Readonly<Record<RateBucket, number>> = RATE_LIMITS,
): { state: RateLimitState; decision: RateDecision } {
  const limit = limits[bucket];

  // A missing state, a window from the future (a clock change), or an
  // elapsed window all start a fresh one. Keeping the stale counts would
  // let a client time its way past a limit.
  const expired = !state || now < state.windowStart || now - state.windowStart >= RATE_WINDOW_MS;
  const current: RateLimitState = expired
    ? emptyRateLimitState(now)
    : { windowStart: state.windowStart, counts: { ...state.counts } };

  const used = current.counts[bucket] ?? 0;
  const allowed = used < limit;

  // A rejected request is still counted. Otherwise a client that keeps
  // retrying past the limit is doing unlimited work at our expense,
  // which is the thing the limit is meant to prevent.
  if (allowed || used <= limit) {
    current.counts[bucket] = used + 1;
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((current.windowStart + RATE_WINDOW_MS - now) / 1000),
  );

  return {
    state: current,
    decision: {
      allowed,
      limit,
      remaining: Math.max(0, limit - current.counts[bucket]),
      retryAfterSeconds,
    },
  };
}

/**
 * Fold a request into an existing decision without spending budget.
 *
 * Preflight requests do not reach a Durable Object, so they are not
 * limited, and they must not consume a caller's budget either.
 */
export function isPreflight(method: string): boolean {
  return method.toUpperCase() === 'OPTIONS';
}
