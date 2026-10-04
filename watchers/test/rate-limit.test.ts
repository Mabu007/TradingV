/**
 * Regression tests for the application-layer rate limit.
 *
 * The Watcher limits how often a *bot* may fire: a cooldown, an hourly
 * cap, a daily cap. Those do nothing until a bot exists, and a client
 * that only ever deploys, starts, stops, lists and evaluates never
 * reaches them. These tests cover the request budget that does apply.
 *
 * The decision function is Cloudflare-free, so this runs in the default
 * suite with no runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  consume,
  emptyRateLimitState,
  isPreflight,
  RATE_LIMITS,
  RATE_WINDOW_MS,
  type RateLimitState,
} from '../src/rate-limit';

const T0 = 1_700_000_000_000;

/** Run `count` requests through the limiter and report the verdicts. */
function hammer(
  bucket: keyof typeof RATE_LIMITS,
  count: number,
  options: { start?: RateLimitState; now?: number; limits?: typeof RATE_LIMITS } = {},
): { allowed: number; refused: number; last?: ReturnType<typeof consume>; state: RateLimitState } {
  const now = options.now ?? T0;
  let state = options.start;
  let allowed = 0;
  let refused = 0;
  let last: ReturnType<typeof consume> | undefined;
  for (let index = 0; index < count; index++) {
    last = consume(state, bucket, now, options.limits);
    state = last.state;
    if (last.decision.allowed) allowed += 1;
    else refused += 1;
  }
  return { allowed, refused, last, state: state as RateLimitState };
}

describe('application-layer rate limits', () => {
  it('allows a request inside the budget', () => {
    const { decision } = consume(emptyRateLimitState(T0), 'lifecycle', T0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(RATE_LIMITS.lifecycle - 1);
  });

  it('refuses a caller that exhausts its budget', () => {
    const result = hammer('lifecycle', RATE_LIMITS.lifecycle + 20);
    expect(result.allowed).toBe(RATE_LIMITS.lifecycle);
    expect(result.refused).toBe(20);
    expect(result.last?.decision.allowed).toBe(false);
  });

  it('does not let a caller exceed the limit by overshooting', () => {
    // The counter is clamped at the limit. A loop that keeps sending
    // must not keep increasing a number that will be read later.
    const result = hammer('lifecycle', RATE_LIMITS.lifecycle * 4);
    expect(result.state.counts.lifecycle).toBeLessThanOrEqual(RATE_LIMITS.lifecycle + 1);
  });

  it('reports how long to wait, and never zero', () => {
    const { decision } = consume(
      { windowStart: T0, counts: { lifecycle: RATE_LIMITS.lifecycle } },
      'lifecycle',
      T0 + 1_000,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(RATE_WINDOW_MS / 1000));
  });

  it('starts a fresh window once the old one has elapsed', () => {
    const first = hammer('lifecycle', RATE_LIMITS.lifecycle + 5, { now: T0 });
    expect(first.last?.decision.allowed).toBe(false);

    const later = consume(first.state, 'lifecycle', T0 + RATE_WINDOW_MS);
    expect(later.decision.allowed).toBe(true);
  });

  it('does not reset one millisecond early', () => {
    const first = hammer('lifecycle', RATE_LIMITS.lifecycle, { now: T0 });
    const early = consume(first.state, 'lifecycle', T0 + RATE_WINDOW_MS - 1);
    expect(early.decision.allowed).toBe(false);
  });

  it('treats a window from the future as expired rather than trusting it', () => {
    // A clock that jumps backwards -- or a state written by a host with
    // a different clock -- must not hand out free budget, and must not
    // lock the caller out until the clock catches up either.
    const future: RateLimitState = { windowStart: T0 + 10 * RATE_WINDOW_MS, counts: { lifecycle: RATE_LIMITS.lifecycle } };
    const result = consume(future, 'lifecycle', T0);
    expect(result.decision.allowed).toBe(true);
  });

  it('keeps budgets separate per route class', () => {
    let state = emptyRateLimitState(T0);
    // Exhaust the cheapest-to-abuse class.
    for (let index = 0; index <= RATE_LIMITS.lifecycle; index++) {
      state = consume(state, 'lifecycle', T0).state;
    }
    expect(consume(state, 'lifecycle', T0).decision.allowed).toBe(false);
    // A caller stuck in a start/stop loop still gets to read and to ask
    // the engine for an evaluation.
    expect(consume(state, 'read', T0).decision.allowed).toBe(true);
    expect(consume(state, 'evaluate', T0).decision.allowed).toBe(true);
  });

  it('keeps budgets separate per caller', () => {
    // The state is the caller's; the limiter never mixes two of them.
    const exhausted = hammer('lifecycle', RATE_LIMITS.lifecycle + 1, { now: T0 }).state;
    const other: RateLimitState = emptyRateLimitState(T0);
    expect(consume(other, 'lifecycle', T0).decision.allowed).toBe(true);
    expect(consume(exhausted, 'lifecycle', T0).decision.allowed).toBe(false);
  });

  it('counts a refused request, so retrying does not buy more time', () => {
    const result = hammer('evaluate', RATE_LIMITS.evaluate + 50);
    // A stuck retry loop is the case this exists for: it must stay
    // refused for the rest of the window, not slip through at the edge.
    expect(result.refused).toBe(50);
  });

  it('does not mutate the state it is given', () => {
    const original: RateLimitState = { windowStart: T0, counts: { read: 3 } };
    const snapshot = JSON.stringify(original);
    consume(original, 'read', T0);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('returns a usable state when given none', () => {
    const { state, decision } = consume(undefined, 'feed', T0);
    expect(decision.allowed).toBe(true);
    expect(state.windowStart).toBe(T0);
    expect(state.counts.feed).toBe(1);
  });

  it('is deterministic', () => {
    const first = hammer('evaluate', 200);
    const second = hammer('evaluate', 200);
    expect(first.allowed).toBe(second.allowed);
    expect(first.refused).toBe(second.refused);
    expect(first.state).toEqual(second.state);
  });

  it('survives a hostile limits table', () => {
    // A limit of zero means "none permitted" rather than "unlimited" or
    // a division by zero.
    const result = consume(undefined, 'feed', T0, { ...RATE_LIMITS, feed: 0 });
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.remaining).toBe(0);
  });

  it('does not spend budget on a CORS preflight', () => {
    // Preflights do not reach an object, so charging them would tax
    // every cross-origin call twice.
    expect(isPreflight('OPTIONS')).toBe(true);
    expect(isPreflight('options')).toBe(true);
    expect(isPreflight('GET')).toBe(false);
    expect(isPreflight('POST')).toBe(false);
  });

  it('keeps a polling UI inside the read budget', () => {
    // The interface polls; a limit low enough to trip during normal use
    // would present as an outage, so this pins the headroom.
    const perMinute = RATE_LIMITS.read;
    expect(perMinute).toBeGreaterThanOrEqual(120);
    const result = hammer('read', perMinute);
    expect(result.refused).toBe(0);
  });
});
