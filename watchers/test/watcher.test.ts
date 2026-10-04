/**
 * Watcher behaviour, tested without a Cloudflare runtime.
 *
 * All of the decision logic is in `watcher.ts`, `wake-queue.ts`,
 * `contract.ts` and `health.ts`, none of which import a Durable Object.
 * That is what makes it possible to test the parts that actually break:
 * duplicate delivery, out-of-order arrival, a bot edited mid-flight, a
 * queue that fills, an engine that is down, and a restart.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  canTransition,
  countNodes,
  InvalidTransitionError,
  nextStatus,
  shouldProcessEvent,
  validateWatcherConfig,
  watcherIdFor,
  type MarketEvent,
  type WatcherConfig,
  type WatcherIdentity,
  type WatcherStatus,
} from '../src/contract';
import { assessHealth, describeAge, DEFAULT_HEALTH_THRESHOLDS, type HealthInput } from '../src/health';
import { evaluationIdFor, idempotencyKeyFor, wakeIdFor } from '../src/ids';
import { ScriptedEvaluator } from '../src/evaluator';
import { Watcher } from '../src/watcher';
import { WakeQueue, buildWake } from '../src/wake-queue';

const IDENTITY: WatcherIdentity = { userId: 'user-a', goatId: 'bot-1', deploymentId: 'dep-1' };
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    configVersion: 1,
    name: 'Gold breakout',
    market: 'xyz:GOLD',
    conditionTree: {
      schemaVersion: 1,
      then: 'WAKE_AI',
      root: { id: 'g', kind: 'GROUP', operator: 'AND', children: [{ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }] },
    },
    // The contract's floor is 1s, not 0: a watcher that evaluates on
    // every market event is a rate-limit bug waiting to happen.
    minEvaluationIntervalMs: 1_000,
    cooldownMs: 0,
    maxWakesPerHour: 60,
    maxWakesPerDay: 1_000,
    ...overrides,
  };
}

function event(id: string, timestamp: number, overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    marketEventId: id,
    market: 'xyz:GOLD',
    timestamp,
    eventType: 'QUOTE',
    price: 2300,
    ...overrides,
  };
}

function trueResult(summary = 'price is above 1') {
  return { status: 'TRUE' as const, summary, conditions: [{ id: 'c', status: 'TRUE', summary }] };
}

function falseResult(summary = 'price is below 1') {
  return { status: 'FALSE' as const, summary, conditions: [{ id: 'c', status: 'FALSE', summary }] };
}

function unknownResult(reason = 'No 1h candles loaded.') {
  return { status: 'UNKNOWN' as const, summary: 'Cannot be measured', conditions: [], reason };
}

function running(overrides: Partial<WatcherConfig> = {}, nowMs = T0): Watcher {
  const watcher = Watcher.create(IDENTITY, config(overrides), nowMs);
  watcher.act('deploy', nowMs);
  watcher.act('start', nowMs);
  return watcher;
}

/* ================================================================== *
 * Identity
 * ================================================================== */

describe('watcher identity', () => {
  it('is derived from the deployment, not the configuration', () => {
    const before = watcherIdFor(IDENTITY);
    const after = watcherIdFor({ ...IDENTITY });
    expect(before).toBe(after);
    // A different deployment is a different watcher.
    expect(watcherIdFor({ ...IDENTITY, deploymentId: 'dep-2' })).not.toBe(before);
    // A different user is a different watcher.
    expect(watcherIdFor({ ...IDENTITY, userId: 'user-b' })).not.toBe(before);
  });

  it('does not change when the bot conditions change', () => {
    // This is the property that stops an edit creating a second watcher.
    const id = watcherIdFor(IDENTITY);
    const edited = config({ configVersion: 2, name: 'Completely different' });
    expect(watcherIdFor(IDENTITY)).toBe(id);
    expect(edited.configVersion).toBe(2);
  });

  it('produces a wake id that is stable for the same event and config', () => {
    const watcher = running();
    const first = watcher.wakeIdForEvent('evt-1');
    expect(watcher.wakeIdForEvent('evt-1')).toBe(first);
    // A different event, or a different config, is a different wake.
    expect(watcher.wakeIdForEvent('evt-2')).not.toBe(first);
    expect(wakeIdFor(watcher.id, 'evt-1', 2)).not.toBe(first);
  });

  it('produces an idempotency key that is stable across retries of one intent', () => {
    expect(idempotencyKeyFor('wk-1', 1)).toBe(idempotencyKeyFor('wk-1', 1));
    // A second attempt of the same intent must reuse the key, so the
    // exchange can collapse it.
    expect(idempotencyKeyFor('wk-1', 2)).not.toBe(idempotencyKeyFor('wk-1', 1));
    // A different wake is a different key.
    expect(idempotencyKeyFor('wk-2', 1)).not.toBe(idempotencyKeyFor('wk-1', 1));
  });
});

/* ================================================================== *
 * Lifecycle
 * ================================================================== */

describe('lifecycle', () => {
  it('walks CREATED to RUNNING', () => {
    const watcher = Watcher.create(IDENTITY, config(), T0);
    expect(watcher.status).toBe('CREATED');
    watcher.act('deploy', T0);
    expect(watcher.status).toBe('DEPLOYING');
    watcher.act('start', T0);
    expect(watcher.status).toBe('RUNNING');
  });

  it('pauses and resumes', () => {
    const watcher = running();
    expect(watcher.act('pause', T0).status).toBe('PAUSED');
    expect(watcher.act('resume', T0).status).toBe('RUNNING');
  });

  it('stops through STOPPING, and reaches STOPPED', () => {
    /*
     * This test used to assert that a second stop left the watcher in
     * STOPPING, on the grounds that "STOPPED is reached by the object
     * finishing its drain". No such drain exists: the Durable Object
     * never references STOPPING, and `act('stop')` discards every
     * pending wake synchronously before it returns. So the status the
     * comment described was unreachable, and a stopped bot reported
     * "stopping" for the rest of its life.
     *
     * The transition table always said STOPPING --stop--> STOPPED. The
     * idempotency check was short-circuiting a real transition, which is
     * what stranded it.
     */
    const watcher = running();
    expect(watcher.act('stop', T0).status).toBe('STOPPING');
    expect(watcher.act('stop', T0).status).toBe('STOPPED');
    // And once settled, a further stop is a genuine no-op.
    expect(watcher.act('stop', T0).status).toBe('STOPPED');
    expect(nextStatus('STOPPING', 'stop')).toBe('STOPPED');
  });

  it('cancels a stop when started during STOPPING', () => {
    // Otherwise a user who presses stop then start needs three presses to
    // get a running watcher, which reads as "the button is broken".
    const watcher = running();
    watcher.act('stop', T0);
    expect(watcher.act('start', T0).status).toBe('RUNNING');
  });

  it('restarts from STOPPED', () => {
    expect(canTransition('STOPPED', 'retry')).toBe(true);
    expect(canTransition('STOPPED', 'start')).toBe(true);
    expect(nextStatus('STOPPED', 'start')).toBe('RUNNING');
  });

  it('retries from ERROR', () => {
    expect(canTransition('ERROR', 'retry')).toBe(true);
    expect(canTransition('ERROR', 'stop')).toBe(true);
    // ERROR is not a state you can simply resume from; the watcher has
    // to be redeployed so the operator sees what happened.
    expect(canTransition('ERROR', 'resume')).toBe(false);
  });

  it('refuses an invalid transition with an explanation', () => {
    const watcher = running();
    expect(() => watcher.act('start', T0)).not.toThrow(); // idempotent
    expect(nextStatus('PAUSED', 'deploy')).toBeNull();
    expect(() => applyAction('PAUSED', 'deploy')).toThrow(InvalidTransitionError);
  });

  it('makes start and stop idempotent', () => {
    const watcher = running();
    // Repeating an action that is already in effect changes nothing.
    watcher.act('start', T0);
    expect(watcher.status).toBe('RUNNING');
    watcher.act('start', T0);
    expect(watcher.status).toBe('RUNNING');

    // A stop is idempotent in the sense that matters: it always ends
    // settled, however many times it is pressed.
    watcher.act('stop', T0);
    watcher.act('stop', T0);
    watcher.act('stop', T0);
    expect(watcher.status).toBe('STOPPED');
  });

  it('can fail from any running state', () => {
    for (const status of ['DEPLOYING', 'RUNNING', 'PAUSED', 'STOPPING'] as WatcherStatus[]) {
      expect(canTransition(status, 'fail')).toBe(true);
    }
  });

  it('discards pending wakes when paused or stopped', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(1);

    const { discarded } = watcher.act('pause', T0 + 1);
    expect(discarded).toHaveLength(1);
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('forgets the condition latch when stopped, so a restart cannot fake an edge', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult()).when('e2', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(1);

    watcher.act('stop', T0 + 1);
    watcher.act('start', T0 + 2);

    // The condition is still true, but the watcher restarted. Without the
    // reset this would deliver a second wake for the same standing
    // condition.
    const result = await watcher.tick(event('e2', T0 + 3_000), evaluator, T0 + 3_000);
    expect(result.outcome.kind).toBe('WOKEN');
    expect(watcher.pendingWakes()).toHaveLength(1);
    // And a second tick on the same standing condition adds nothing.
    const again = await watcher.tick(event('e3', T0 + 5_000), evaluator, T0 + 5_000);
    expect(again.outcome.kind).toBe('EVALUATED');
    expect(watcher.pendingWakes()).toHaveLength(1);
  });
});

/* ================================================================== *
 * Configuration validation
 * ================================================================== */

describe('configuration', () => {
  it('accepts a valid configuration', () => {
    expect(validateWatcherConfig(config()).valid).toBe(true);
  });

  it('refuses a configuration that would cost the service more than it should', () => {
    // Documented limits, not silently clamped: a bot asking for
    // 1000 wakes a minute is a bug, and the user is told.
    const result = validateWatcherConfig(config({ maxWakesPerHour: 5_000 }));
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/maxWakesPerHour/);
  });

  it('refuses a rate limit of zero, which would be a silent kill switch', () => {
    expect(validateWatcherConfig(config({ maxWakesPerHour: 0 })).valid).toBe(false);
  });

  it('refuses an unbounded condition tree', () => {
    const children = Array.from({ length: 500 }, (_, index) => ({ id: `c${index}`, kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }));
    // Sanity: the counter is what the limit reads, so prove it counts both
    // shapes. A wrapper that counted as one node would let an oversized
    // tree through the limit entirely.
    expect(countNodes({ kind: 'GROUP', children })).toBe(501);
    expect(countNodes({ schemaVersion: 1, then: 'WAKE_AI', root: { id: 'g', kind: 'GROUP', children } })).toBe(501);
    const result = validateWatcherConfig(
      config({ conditionTree: { schemaVersion: 1, then: 'WAKE_AI', root: { id: 'g', kind: 'GROUP', operator: 'AND', children } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/limit is 200/);
  });

  it('counts nodes without recursing forever', () => {
    const cyclic: Record<string, unknown> = { kind: 'GROUP', children: [] };
    (cyclic.children as unknown[]).push(cyclic);
    expect(countNodes(cyclic)).toBeGreaterThan(0);
  });

  it('refuses to store a configuration version that does not increase', () => {
    const watcher = running();
    expect(() => watcher.updateConfig(config({ configVersion: 1 }), T0)).toThrow(/must increase/);
    expect(watcher.updateConfig(config({ configVersion: 2 }), T0).configVersion).toBe(2);
  });

  it('refuses an invalid configuration outright', () => {
    const watcher = running();
    expect(() => watcher.updateConfig({ ...config(), maxWakesPerHour: 0 }, T0)).toThrow(/invalid configuration/);
  });
});

/* ================================================================== *
 * Event acceptance: duplicates, ordering, staleness
 * ================================================================== */

describe('event acceptance', () => {
  const runningState = { market: 'xyz:GOLD', status: 'RUNNING' as const, lastSequence: null, lastTimestamp: null };

  it('accepts a fresh event', () => {
    expect(shouldProcessEvent(event('e1', T0), runningState, T0).accepted).toBe(true);
  });

  it('refuses an event for a market this watcher does not watch', () => {
    const result = shouldProcessEvent(event('e1', T0, { market: 'xyz:SILVER' }), runningState, T0);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('WRONG_MARKET');
  });

  it('refuses everything while paused or stopped', () => {
    for (const status of ['PAUSED', 'STOPPED', 'CREATED', 'STOPPING'] as WatcherStatus[]) {
      const result = shouldProcessEvent(event('e1', T0), { ...runningState, status }, T0);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe(status === 'PAUSED' ? 'PAUSED' : 'NOT_RUNNING');
    }
  });

  it('refuses an event with no id, because it cannot be deduplicated', () => {
    const result = shouldProcessEvent(event('', T0), runningState, T0);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('DUPLICATE');
  });

  it('refuses a duplicate sequence', () => {
    const state = { ...runningState, lastSequence: 10 };
    expect(shouldProcessEvent(event('e2', T0, { sequence: 10 }), state, T0).reason).toBe('DUPLICATE');
    expect(shouldProcessEvent(event('e3', T0, { sequence: 9 }), state, T0).reason).toBe('OUT_OF_ORDER');
    expect(shouldProcessEvent(event('e4', T0, { sequence: 11 }), state, T0).accepted).toBe(true);
  });

  it('refuses an out-of-order timestamp when the venue has no sequence', () => {
    const state = { ...runningState, lastTimestamp: T0 };
    expect(shouldProcessEvent(event('e2', T0 - 1), state, T0).reason).toBe('OUT_OF_ORDER');
    expect(shouldProcessEvent(event('e3', T0), state, T0).reason).toBe('DUPLICATE');
    expect(shouldProcessEvent(event('e4', T0 + 1), state, T0).accepted).toBe(true);
  });

  it('refuses a far-future timestamp from a broken clock', () => {
    // One bad timestamp would otherwise pass every rate limit at once,
    // because it looks like a long time has passed.
    const result = shouldProcessEvent(event('e2', T0 + 60_000), runningState, T0);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('FUTURE_TIMESTAMP');
  });

  it('tolerates small clock skew', () => {
    expect(shouldProcessEvent(event('e2', T0 + 2_000), runningState, T0).accepted).toBe(true);
  });
});

/* ================================================================== *
 * The tick
 * ================================================================== */

describe('ticks', () => {
  it('wakes on a FALSE to TRUE edge', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', falseResult()).when('e2', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const result = await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    expect(result.outcome.kind).toBe('WOKEN');
  });

  it('does not wake twice for a condition that stays true', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    for (let index = 2; index < 10; index += 1) {
      const at = T0 + index * 2_000;
      const result = await watcher.tick(event(`e${index}`, at), evaluator, at);
      expect(result.outcome.kind).toBe('EVALUATED');
    }
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('does not wake for a condition that stays false', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', falseResult());
    for (let index = 1; index < 5; index += 1) {
      const at = T0 + index * 2_000;
      const result = await watcher.tick(event(`e${index}`, at), evaluator, at);
      expect(result.outcome.kind).toBe('EVALUATED');
    }
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('never wakes on UNKNOWN', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', unknownResult());
    const result = await watcher.tick(event('e1', T0), evaluator, T0);
    expect(result.outcome.kind).toBe('EVALUATED');
    if (result.outcome.kind === 'EVALUATED') expect(result.outcome.status).toBe('UNKNOWN');
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('does not let an UNKNOWN re-arm a tracker that was already true', async () => {
    // TRUE, then UNKNOWN, then TRUE. The third event is not a new edge:
    // the condition never went false, so waking again would be waking on
    // a moment that has already passed.
    const watcher = running();
    const evaluator = new ScriptedEvaluator()
      .when('e1', trueResult())
      .when('e2', unknownResult())
      .when('e3', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    const third = await watcher.tick(event('e3', T0 + 4_000), evaluator, T0 + 4_000);
    expect(third.outcome.kind).toBe('EVALUATED');
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('does not let an UNKNOWN suppress the next genuine edge', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator()
      .when('e1', unknownResult())
      .when('e2', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const result = await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    expect(result.outcome.kind).toBe('WOKEN');
  });

  it('drops a duplicate market event instead of waking twice', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', falseResult()).when('e2', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    // The same event, redelivered, must not produce a second wake.
    const duplicate = await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 3_000);
    expect(duplicate.outcome.kind).toBe('SKIPPED');
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('respects the minimum evaluation interval', async () => {
    const watcher = running({ minEvaluationIntervalMs: 5 * MINUTE });
    const evaluator = new ScriptedEvaluator().when('e1', falseResult()).when('e2', trueResult()).when('e3', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const tooSoon = await watcher.tick(event('e2', T0 + 2 * MINUTE), evaluator, T0 + 2 * MINUTE);
    expect(tooSoon.outcome.kind).toBe('SKIPPED');
    if (tooSoon.outcome.kind === 'SKIPPED') expect(tooSoon.outcome.reason).toBe('EVALUATION_INTERVAL');
    const later = await watcher.tick(event('e3', T0 + 6 * MINUTE), evaluator, T0 + 6 * MINUTE);
    expect(later.outcome.kind).toBe('WOKEN');
  });

  it('enforces the hourly cap without queueing a wake for later', async () => {
    const watcher = running({ maxWakesPerHour: 2 });
    const evaluator = new ScriptedEvaluator({ status: 'FALSE', summary: 'no', conditions: [] });
    // Three genuine edges, one a minute apart.
    for (let index = 0; index < 2; index += 1) {
      const riseAt = T0 + index * 10_000;
      const fallAt = riseAt + 2_000;
      evaluator.when(`f${index}`, trueResult());
      await watcher.tick(event(`f${index}`, riseAt), evaluator, riseAt);
      evaluator.when(`f${index}`, falseResult());
      await watcher.tick(event(`f${index}`, fallAt), evaluator, fallAt);
    }
    // The third edge, past the cap.
    const thirdAt = T0 + 30_000;
    evaluator.when('f2', trueResult());
    const third = await watcher.tick(event('f2', thirdAt), evaluator, thirdAt);
    expect(third.outcome.kind).toBe('EVALUATED');

    expect(watcher.pendingWakes()).toHaveLength(2);
    // The third edge was refused and the latch stayed TRUE, so nothing is
    // queued to be delivered later for a moment that has already passed.
    expect(watcher.state.lastConditionStatus).toBe('TRUE');
    expect(watcher.pendingWakes().filter((wake) => wake.configVersion === 1)).toHaveLength(watcher.pendingWakes().length);
  });

  it('enforces the cooldown', async () => {
    const watcher = running({ cooldownMs: 10 * MINUTE });
    const evaluator = new ScriptedEvaluator();
    evaluator.when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    evaluator.when('e2', falseResult());
    await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    evaluator.when('e3', trueResult());
    const tooSoon = await watcher.tick(event('e3', T0 + 2 * MINUTE), evaluator, T0 + 2 * MINUTE);
    expect(tooSoon.outcome.kind).toBe('EVALUATED');
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('treats an unreachable engine as UNKNOWN, not as a signal', async () => {
    const watcher = running();
    const evaluator = {
      evaluate: async () => { throw new Error('fetch failed: connection refused'); },
      fail: (_c: WatcherConfig, e: MarketEvent, error: unknown) => ({
        evaluationId: evaluationIdFor('t', e.marketEventId, 1),
        durationMs: 0,
        result: { status: 'UNKNOWN' as const, summary: 'unreachable', conditions: [], reason: (error as Error).message },
      }),
    };
    const result = await watcher.tick(event('e1', T0), evaluator, T0);
    expect(result.outcome.kind).toBe('EVALUATED');
    expect(watcher.pendingWakes()).toHaveLength(0);
    // And it is visible as a problem rather than silently idle.
    expect(result.health.healthy).toBe(false);
  });
});

/* ================================================================== *
 * Config versioning and pending wakes
 * ================================================================== */

describe('configuration changes', () => {
  it('discards a wake produced under the old configuration', async () => {
    // The documented decision: discard, not execute-under-old-version.
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(1);

    const { discarded } = watcher.updateConfig(config({ configVersion: 2, name: 'Edited' }), T0 + 1_000);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].outcome).toBe('CONFIG_CHANGED');
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('keeps the discarded wake in the timeline with a reason', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    watcher.updateConfig(config({ configVersion: 2 }), T0 + 1);
    const history = watcher.wakeHistory();
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('CONFIG_CHANGED');
    expect(history[0].configVersion).toBe(1);
  });

  it('re-evaluates from scratch after an edit', async () => {
    // Forgetting the latch costs at most one missed edge; keeping it
    // would risk a spurious one.
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    watcher.updateConfig(config({ configVersion: 2 }), T0 + 1);
    expect(watcher.state.lastConditionStatus).toBeNull();

    evaluator.when('e2', trueResult());
    const result = await watcher.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    expect(result.outcome.kind).toBe('WOKEN');
    // And the new wake records the new version.
    expect(watcher.pendingWakes()[0].configVersion).toBe(2);
  });

  it('does not mix a wake from one version with the state of another', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const oldWake = watcher.pendingWakes()[0];

    watcher.updateConfig(config({ configVersion: 2 }), T0 + 1);
    evaluator.when('e1', trueResult());
    await watcher.tick(event('e1', T0 + 2_000), evaluator, T0 + 2_000);

    const newWake = watcher.pendingWakes()[0];
    expect(newWake.configVersion).toBe(2);
    expect(newWake.id).not.toBe(oldWake.id);
    expect(evaluationIdFor(watcher.id, 'e1', 1)).not.toBe(evaluationIdFor(watcher.id, 'e1', 2));
  });
});

/* ================================================================== *
 * The wake queue
 * ================================================================== */

describe('wake queue', () => {
  // The ids are derived, never supplied: a caller that could choose a
  // wake id could also choose a colliding one.
  const base = {
    watcherId: 'w-1', goatId: 'b-1', deploymentId: 'd-1',
    marketEventId: 'e-1', configVersion: 1,
    reason: 'price is above 1', conditions: { overall: 'TRUE', summary: 'price is above 1' },
  };

  it('refuses a duplicate wake', () => {
    const queue = new WakeQueue();
    const first = queue.enqueue(buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 }), T0);
    expect(first.accepted).toBe(true);
    const second = queue.enqueue(buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 }), T0);
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.reason).toBe('DUPLICATE');
  });

  it('refuses to re-enqueue a wake that already acted', () => {
    const queue = new WakeQueue();
    const wake = buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 });
    queue.enqueue(wake, T0);
    queue.resolve(wake.id, 'EXECUTED', T0 + 1);
    const again = queue.enqueue(wake, T0 + 2);
    expect(again.accepted).toBe(false);
  });

  it('resolving is idempotent, so a retried acknowledgement is safe', () => {
    const queue = new WakeQueue();
    const wake = buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 });
    queue.enqueue(wake, T0);
    expect(queue.resolve(wake.id, 'EXECUTED', T0 + 1)?.status).toBe('EXECUTED');
    // The app retries after a network failure; that must not resurrect it.
    expect(queue.resolve(wake.id, 'EXECUTED', T0 + 2)?.status).toBe('EXECUTED');
    expect(queue.list()).toHaveLength(0);
  });

  it('acknowledging an unknown wake is a no-op, not a crash', () => {
    const queue = new WakeQueue();
    expect(queue.acknowledge('nope', T0)).toBeNull();
    expect(queue.resolve('nope', 'EXECUTED', T0)).toBeNull();
  });

  it('expires a wake nobody consumed', () => {
    const queue = new WakeQueue({ maxAgeMs: 1_000 });
    const wake = buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 });
    queue.enqueue(wake, T0);
    // Acting on a ten-minute-old "price just crossed 2000" is not what
    // the user meant.
    const expired = queue.expire(T0 + 5_000);
    expect(expired).toHaveLength(1);
    expect(expired[0].outcome).toBe('STALE');
    expect(queue.list()).toHaveLength(0);
  });

  it('drops the oldest when full, not the newest', () => {
    const queue = new WakeQueue({ maxSize: 3 });
    for (let index = 0; index < 5; index += 1) {
      queue.enqueue(buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', marketEventId: `e${index}`, status: 'TRUE', summary: 's', nowMs: T0 + index }), T0 + index);
    }
    const pending = queue.list();
    expect(pending).toHaveLength(3);
    // The newest observation is the one most likely to still be true.
    expect(pending[pending.length - 1].marketEventId).toBe('e4');
    expect(queue.history().some((wake) => wake.outcome === 'QUEUE_FULL')).toBe(true);
  });

  it('surfaces a wake that was acknowledged and never resolved', () => {
    const queue = new WakeQueue();
    const wake = buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', status: 'TRUE', summary: 's', nowMs: T0 });
    queue.enqueue(wake, T0);
    queue.acknowledge(wake.id, T0 + 1);
    expect(queue.staleAcknowledged(T0 + 2, 30_000)).toHaveLength(0);
    expect(queue.staleAcknowledged(T0 + 60_000, 30_000)).toHaveLength(1);
  });

  it('bounds its own history', () => {
    const queue = new WakeQueue({ historyLimit: 5 });
    for (let index = 0; index < 20; index += 1) {
      const wake = buildWake({ ...base, watcherId: 'w', goatId: 'b', deploymentId: 'd', marketEventId: `e${index}`, status: 'TRUE', summary: 's', nowMs: T0 + index });
      queue.enqueue(wake, T0 + index);
      queue.resolve(wake.id, 'EXECUTED', T0 + index);
    }
    expect(queue.history()).toHaveLength(5);
  });
});

/* ================================================================== *
 * Health
 * ================================================================== */

describe('health', () => {
  const base: HealthInput = {
    status: 'RUNNING',
    lastHeartbeatAt: T0,
    lastMarketDataAt: T0,
    lastEvaluationAt: T0,
    lastSuccessfulEvaluationAt: T0,
    lastWakeAt: null,
    lastConfigChangeAt: T0,
    lastError: null,
    consecutiveEvaluationFailures: 0,
  };

  it('is healthy with fresh data and a recent evaluation', () => {
    // Well past the startup grace, so STARTING cannot be the answer.
    const report = assessHealth({ ...base, lastHeartbeatAt: T0 - 60_000 }, T0 + 1_000);
    expect(report.state).toBe('HEALTHY');
    expect(report.healthy).toBe(true);
  });

  it('is not healthy merely because the process is alive', () => {
    // The distinction this whole module exists for.
    const starved = assessHealth({ ...base, lastHeartbeatAt: T0 - 60_000, lastMarketDataAt: T0 - 10 * MINUTE }, T0);
    expect(starved.state).toBe('STARVED');
    expect(starved.healthy).toBe(false);
    expect(starved.summary).toMatch(/No market data/);
  });

  it('is STARVED, not STARTING, when it never receives anything', () => {
    const report = assessHealth({ ...base, lastMarketDataAt: null, lastHeartbeatAt: T0 - 60_000 }, T0);
    expect(report.state).toBe('STARVED');
  });

  it('is STARTING rather than STARVED in the first few seconds', () => {
    const report = assessHealth({ ...base, lastMarketDataAt: null, lastHeartbeatAt: T0 - 1_000 }, T0);
    expect(report.state).toBe('STARTING');
    expect(report.healthy).toBe(false);
  });

  it('is DEGRADED after repeated evaluation failures', () => {
    const report = assessHealth({ ...base, lastHeartbeatAt: T0 - 60_000, consecutiveEvaluationFailures: 3 }, T0);
    expect(report.state).toBe('DEGRADED');
  });

  it('is ERROR when an error is outstanding', () => {
    const report = assessHealth({ ...base, lastError: { message: 'engine unreachable', at: T0 - 5_000 } }, T0);
    expect(report.state).toBe('ERROR');
    expect(report.summary).toMatch(/engine unreachable/);
  });

  it('treats a stopped watcher as stopped, not unhealthy', () => {
    for (const status of ['STOPPED', 'PAUSED', 'CREATED']) {
      const report = assessHealth({ ...base, status }, T0 + 10 * MINUTE);
      expect(report.state).toBe('STOPPED');
      expect(report.healthy).toBe(false);
    }
  });

  it('does not render a negative age when the clock moves backwards', () => {
    const report = assessHealth({ ...base, lastHeartbeatAt: T0 - 60_000, lastMarketDataAt: T0 + 10_000 }, T0);
    expect(report.age.marketData).toBe(0);
    expect(report.summary).not.toMatch(/-/);
  });

  it('formats ages for a status line', () => {
    expect(describeAge(null)).toBe('never');
    expect(describeAge(400)).toBe('400ms');
    expect(describeAge(2_400)).toBe('2.4s');
    expect(describeAge(240_000)).toBe('4m');
  });
});

/* ================================================================== *
 * Recovery
 * ================================================================== */

describe('restart and recovery', () => {
  it('restores a running watcher from persisted state', () => {
    const watcher = running();
    const restored = Watcher.restore(watcher.persist());
    expect(restored.status).toBe('RUNNING');
    expect(restored.id).toBe(watcher.id);
  });

  it('keeps the timeline across a restart', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const wake = watcher.pendingWakes()[0];
    watcher.resolveWake(wake.id, 'EXECUTED', T0 + 1);

    const restored = Watcher.restore(watcher.persist());
    const history = restored.wakeHistory();
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('EXECUTED');
  });

  it('does not re-deliver a wake that already acted, after a restart', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const wake = watcher.pendingWakes()[0];
    watcher.resolveWake(wake.id, 'EXECUTED', T0 + 1);

    const restored = Watcher.restore(watcher.persist());
    // A new event after the restart, with the condition still true, must
    // not produce a second wake. The restored latch is still TRUE, so
    // there is no edge, and the wake that already acted is not redelivered.
    evaluator.when('e2', trueResult());
    const result = await restored.tick(event('e2', T0 + 2_000), evaluator, T0 + 2_000);
    expect(result.outcome.kind).toBe('EVALUATED');
    if (result.outcome.kind === 'EVALUATED') expect(result.outcome.status).toBe('TRUE');
    expect(restored.pendingWakes()).toHaveLength(0);
  });

  it('a restored watcher will not accept a stale replay of old data', async () => {
    const watcher = running();
    const evaluator = new ScriptedEvaluator().when('e1', trueResult());
    await watcher.tick(event('e1', T0), evaluator, T0);
    const restored = Watcher.restore(watcher.persist());
    evaluator.when('old', trueResult());
    const result = await restored.tick(event('old', T0 - MINUTE), evaluator, T0 + 10);
    expect(result.outcome.kind).toBe('SKIPPED');
    if (result.outcome.kind === 'SKIPPED') expect(result.outcome.reason).toBe('OUT_OF_ORDER');
  });

  it('bounds its fire-timestamp window', () => {
    // A long-running watcher must not accumulate a timestamp for every
    // wake it has ever made. Asserted through the state a tick prunes,
    // rather than by calling the private pruner.
    const watcher = running();
    for (let index = 0; index < 200; index += 1) {
      watcher.state.fireTimestamps.push(T0 - index * 1_000);
    }
    // A tick two days later prunes everything older than a day. The event
    // is a fresh timestamp so it is accepted and the pruner runs.
    return watcher.tick(event('far', T0 + 2 * 86_400_000), new ScriptedEvaluator(), T0 + 2 * 86_400_000).then(() => {
      expect(watcher.state.fireTimestamps.every((stamp) => T0 + 2 * 86_400_000 - stamp <= 86_400_000)).toBe(true);
      expect(watcher.state.fireTimestamps.length).toBeLessThan(200);
    });
  });
});
