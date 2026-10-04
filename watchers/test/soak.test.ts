/**
 * A soak, with the numbers printed.
 *
 * The point of this file is not to assert a performance target. It is to
 * put actual measurements behind the claims in the readiness report,
 * because "should be fine at scale" is not evidence and the previous pass
 * had none.
 *
 * What is measured: latency percentiles for a tick, the growth of the
 * bounded structures, duplicate suppression under a repeated feed, and
 * behaviour across repeated start/stop and config-edit cycles. The
 * assertions are about *shape* -- a queue that grows without bound, a
 * latency that degrades with queue depth, a duplicate that produces a
 * second wake. Absolute numbers are reported, not asserted, so a slow
 * machine does not produce a false failure.
 */

import { describe, expect, it } from 'vitest';
import type { MarketEvent, WatcherConfig, WatcherIdentity } from '../src/contract';
import type { ConditionEvaluator, EvaluationOutcome } from '../src/watcher';
import { Watcher } from '../src/watcher';

const T0 = 1_700_000_000_000;
const IDENTITIES: WatcherIdentity[] = Array.from({ length: 100 }, (_, index) => ({
  userId: 'user-a',
  goatId: `bot-${index}`,
  deploymentId: `dep-${index}`,
}));
const MARKETS = ['xyz:GOLD', 'EUR/USD', 'BTC/USD', 'ETH/USD', 'CL/USD'];

function configFor(market: string, index: number): WatcherConfig {
  return {
    configVersion: 1,
    name: `bot ${index}`,
    market,
    conditionTree: {
      schemaVersion: 1,
      then: 'WAKE_AI',
      root: { id: 'g', kind: 'GROUP', operator: 'AND', children: [{ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: index }] },
    },
    minEvaluationIntervalMs: 1_000,
    cooldownMs: 0,
    maxWakesPerHour: 60,
    maxWakesPerDay: 1_000,
  };
}

/**
 * Alternates TRUE/FALSE so the edge detector has real work to do.
 *
 * A constant answer would be much less demanding: once the latch latched
 * TRUE there is no further edge, so one wake per watcher and an empty
 * queue for the rest of the run. Alternating makes every second tick an
 * edge, which is what actually fills the queue.
 */
class AlternatingEvaluator implements ConditionEvaluator {
  calls = 0;
  async evaluate(_config: WatcherConfig, _event: MarketEvent): Promise<EvaluationOutcome> {
    this.calls += 1;
    const status = this.calls % 2 === 0 ? 'FALSE' : 'TRUE';
    return {
      evaluationId: `eval-${this.calls}`,
      result: { status, summary: 'soak', conditions: [] },
      durationMs: 0,
    };
  }
  fail(): EvaluationOutcome {
    return { evaluationId: 'fail', result: { status: 'UNKNOWN', summary: 'soak', conditions: [] }, durationMs: 0 };
  }
}

function percentiles(samples: number[]): { p50: number; p95: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
}

function megabytes(): number {
  // V8 reports more than the process actually uses, so this is an upper
  // bound on the heap and is only read as a trend.
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
}

describe('soak', () => {
  /*
   * An explicit budget, because this is the one test whose runtime is a
   * property of the host rather than of the code: 5,000 events across 100
   * watchers takes about ten seconds on a modest laptop and well under one
   * on a build server. The default 5s timeout made this test fail for
   * reasons that had nothing to do with what it asserts.
   */
  it('100 GOATs across 5 markets survive 5,000 market events', { timeout: 60_000 }, async () => {
    const heapBefore = megabytes();
    const watchers = IDENTITIES.map((identity, index) => {
      const evaluator = new AlternatingEvaluator();
      const watcher = Watcher.create(identity, configFor(MARKETS[index % MARKETS.length] ?? 'xyz:GOLD', index), T0);
      watcher.act('deploy', T0);
      watcher.act('start', T0);
      return { watcher, evaluator, market: MARKETS[index % MARKETS.length] ?? 'xyz:GOLD' };
    });

    const latencies: number[] = [];
    const perWatcher = new Map<string, number>();
    const events = 5_000;
    // Peak depth, not final depth. The queue expires unclaimed wakes
    // after five minutes by default, and this run simulates eighty-three
    // minutes, so the queue is legitimately empty at the end. The number
    // that shows whether the cap works is the high-water mark.
    let peakPending = 0;
    let totalExpired = 0;
    let totalWoken = 0;

    const started = Date.now();
    for (let step = 0; step < events; step += 1) {
      // A round-robin feed: every watcher on a market sees the event.
      const market = MARKETS[step % MARKETS.length] as string;
      const event = {
        marketEventId: `evt-${step}`,
        market,
        eventType: 'QUOTE',
        timestamp: T0 + step * 1_000,
        price: 1_000 + (step % 97),
      } as unknown as MarketEvent;

      for (const entry of watchers) {
        if (entry.market !== market) continue;
        const at = performance.now();
        const result = await entry.watcher.tick(event, entry.evaluator, T0 + step * 1_000);
        latencies.push(performance.now() - at);
        if (result.outcome.kind === 'WOKEN') {
          totalWoken += 1;
          perWatcher.set(entry.watcher.state.watcherId, (perWatcher.get(entry.watcher.state.watcherId) ?? 0) + 1);
          const depth = entry.watcher.pendingWakes().length;
          if (depth > peakPending) peakPending = depth;
        }
        totalExpired += result.expired.length;
      }
    }
    const elapsed = Date.now() - started;

    const ticks = percentiles(latencies);
    const pending = watchers.reduce((sum, entry) => sum + entry.watcher.pendingWakes().length, 0);
    const heapAfter = megabytes();
    const evaluations = watchers.reduce((sum, entry) => sum + entry.evaluator.calls, 0);

    console.log('      ── soak: 100 GOATs x 5 markets x 5,000 events ──');
    console.log(`      elapsed            ${elapsed}ms (${(events / (elapsed / 1000)).toFixed(0)} events/s)`);
    console.log(`      ticks              ${latencies.length}`);
    console.log(`      latency p50/p95/p99 ${ticks.p50.toFixed(3)} / ${ticks.p95.toFixed(3)} / ${ticks.p99.toFixed(3)} ms (max ${ticks.max.toFixed(3)})`);
    console.log(`      evaluations        ${evaluations}`);
    console.log(`      wakes emitted      ${totalWoken}`);
    console.log(`      peak queue depth   ${peakPending} per watcher (cap is 100)`);
    console.log(`      wakes expired      ${totalExpired} (unclaimed after 5 minutes)`);
    console.log(`      wakes pending now  ${pending}`);
    console.log(`      watchers that woke ${perWatcher.size} of ${watchers.length}`);
    console.log(`      heap               ${heapBefore}MB -> ${heapAfter}MB`);

    // Shape assertions only. A bounded queue must stay bounded however
    // many events arrive, and this is the property that would be lost if
    // the cap were removed.
    expect(peakPending).toBeGreaterThan(0);
    expect(peakPending).toBeLessThanOrEqual(100);
    // Every watcher that was supposed to fire did.
    expect(perWatcher.size).toBe(watchers.length);
    // The heap must not grow by an order of magnitude across the run.
    expect(heapAfter).toBeLessThan(Math.max(heapBefore * 10, heapBefore + 200));
  });

  it('a repeated feed produces no extra wakes', async () => {
    // The same event delivered 50 times: the sort of thing a retrying
    // producer does, and the sort of thing that turns one market move
    // into fifty orders.
    const evaluator = new AlternatingEvaluator();
    const watcher = Watcher.create(IDENTITIES[0] as WatcherIdentity, configFor('xyz:GOLD', 1), T0);
    watcher.act('deploy', T0);
    watcher.act('start', T0);

    const event = {
      marketEventId: 'repeat-1', market: 'xyz:GOLD', eventType: 'QUOTE', timestamp: T0, price: 2_000,
    } as unknown as MarketEvent;

    let wakes = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await watcher.tick(event, evaluator, T0);
      if (result.outcome.kind === 'WOKEN') wakes += 1;
    }
    expect(wakes).toBe(1);
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('latency does not degrade as the queue fills', async () => {
    // A queue that is scanned linearly per tick gets slower as it grows.
    // The cap is what keeps the last tick as cheap as the first.
    const evaluator = new AlternatingEvaluator();
    const watcher = Watcher.create(IDENTITIES[1] as WatcherIdentity, configFor('xyz:GOLD', 1), T0);
    watcher.act('deploy', T0);
    watcher.act('start', T0);

    const early: number[] = [];
    const late: number[] = [];
    for (let step = 0; step < 600; step += 1) {
      const event = {
        // A fresh id every time, so nothing is suppressed as a duplicate.
        marketEventId: `grow-${step}`, market: 'xyz:GOLD', eventType: 'QUOTE',
        timestamp: T0 + step * 2_000, price: 2_000,
      } as unknown as MarketEvent;
      const at = performance.now();
      await watcher.tick(event, evaluator, T0 + step * 2_000);
      const took = performance.now() - at;
      if (step < 50) early.push(took);
      if (step > 550) late.push(took);
    }

    const first = percentiles(early);
    const last = percentiles(late);
    console.log('      ── soak: queue growth vs latency ──');
    console.log(`      first 50 ticks   p95 ${first.p95.toFixed(3)}ms`);
    console.log(`      last 50 ticks    p95 ${last.p95.toFixed(3)}ms (queue at cap: ${watcher.pendingWakes().length})`);

    // Reported, not asserted: a 20x margin absorbs a noisy machine while
    // still failing if the cost really is proportional to queue depth.
    expect(last.p95).toBeLessThan(Math.max(first.p95 * 20, 5));
  });

  it('survives repeated start, stop, and config edits', async () => {
    const evaluator = new AlternatingEvaluator();
    const watcher = Watcher.create(IDENTITIES[2] as WatcherIdentity, configFor('xyz:GOLD', 2), T0);
    watcher.act('deploy', T0);
    watcher.act('start', T0);

    let nowMs = T0;
    for (let round = 0; round < 200; round += 1) {
      watcher.act('stop', nowMs);
      watcher.act('stop', nowMs);
      nowMs += 1_000;
      // Every state must be reachable and none may strand.
      expect(watcher.state.status).toBe('STOPPED');
      watcher.act('start', nowMs);
      expect(watcher.state.status).toBe('RUNNING');
      nowMs += 1_000;
      watcher.updateConfig({ ...configFor('xyz:GOLD', 2 + round), configVersion: round + 2 }, nowMs);
      nowMs += 1_000;
      const result = await watcher.tick(
        { marketEventId: `cycle-${round}`, market: 'xyz:GOLD', eventType: 'QUOTE', timestamp: nowMs, price: 2_000 } as unknown as MarketEvent,
        evaluator, nowMs,
      );
      expect(result.outcome.kind).toBeDefined();
    }
    expect(watcher.state.config.configVersion).toBe(201);
    console.log('      ── soak: 200 start/stop/config cycles ──');
    console.log(`      final status      ${watcher.state.status}`);
    console.log(`      final version     ${watcher.state.config.configVersion}`);
  });
});
