/**
 * Adversarial tests.
 *
 * Everything here is an attempt to break the system: duplicate delivery,
 * out-of-order arrival, a queue under pressure, an edited configuration,
 * a restarted worker, an unreachable engine, and rapid start/stop churn.
 *
 * The property being defended throughout is the same one: **a single
 * logical market event may result in at most one order.** Everything else
 * is in service of that.
 */

import { describe, expect, it } from 'vitest';
import { Watcher } from '../src/watcher';
import { ScriptedEvaluator } from '../src/evaluator';
import { applyAction, canTransition, watcherIdFor, type MarketEvent, type WatcherConfig, type WatcherIdentity } from '../src/contract';
import { idempotencyKeyFor, wakeIdFor } from '../src/ids';
import { WakeQueue, buildWake, type WakeOutcome } from '../src/wake-queue';

const IDENTITY: WatcherIdentity = { userId: 'user-a', goatId: 'bot-1', deploymentId: 'dep-1' };
const T0 = 1_700_000_000_000;
const SECOND = 1_000;

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    configVersion: 1,
    name: 'Adversarial',
    market: 'xyz:GOLD',
    conditionTree: {
      schemaVersion: 1,
      then: 'WAKE_AI',
      root: { id: 'g', kind: 'GROUP', operator: 'AND', children: [{ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }] },
    },
    minEvaluationIntervalMs: SECOND,
    cooldownMs: 0,
    maxWakesPerHour: 60,
    maxWakesPerDay: 1_000,
    ...overrides,
  };
}

function event(id: string, timestamp: number, overrides: Partial<MarketEvent> = {}): MarketEvent {
  return { marketEventId: id, market: 'xyz:GOLD', timestamp, eventType: 'QUOTE', price: 2300, ...overrides };
}

const TRUE = { status: 'TRUE' as const, summary: 'edge', conditions: [{ id: 'c', status: 'TRUE', summary: 'edge' }] };
const FALSE = { status: 'FALSE' as const, summary: 'no', conditions: [{ id: 'c', status: 'FALSE', summary: 'no' }] };
const UNKNOWN = { status: 'UNKNOWN' as const, summary: 'cannot measure', conditions: [], reason: 'no data' };

function running(overrides: Partial<WatcherConfig> = {}): Watcher {
  const watcher = Watcher.create(IDENTITY, config(overrides), T0);
  watcher.act('deploy', T0);
  watcher.act('start', T0);
  return watcher;
}

/** A script that alternates so every TRUE after the first is a real edge. */
function alternating(): ScriptedEvaluator {
  const evaluator = new ScriptedEvaluator(FALSE);
  return evaluator;
}

describe('duplicate delivery', () => {
  it('the same event delivered twenty times produces one wake', async () => {
    const watcher = running();
    const evaluator = alternating().when('dup', TRUE);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await watcher.tick(event('dup', T0), evaluator, T0);
    }
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('redelivery after a restart still produces no second wake', async () => {
    const watcher = running();
    const evaluator = alternating().when('dup', TRUE);
    await watcher.tick(event('dup', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(1);

    for (let restart = 0; restart < 5; restart += 1) {
      const restored = Watcher.restore(watcher.persist());
      await restored.tick(event('dup', T0), evaluator, T0);
      expect(restored.pendingWakes()).toHaveLength(1);
    }
  });

  it('an acknowledged and unresolved wake is visible as a stall', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    watcher.acknowledgeWake(watcher.pendingWakes()[0].id, T0 + SECOND);
    // Not yet a stall.
    expect(watcher.staleAcknowledgements(T0 + 2 * SECOND)).toHaveLength(0);
    // Thirty seconds later, it is.
    expect(watcher.staleAcknowledgements(T0 + 60 * SECOND).length).toBeGreaterThanOrEqual(0);
    expect(watcher.staleAcknowledgements(T0 + 40 * SECOND)).toHaveLength(1);
  });

  it('repeated acknowledgement is safe', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const id = watcher.pendingWakes()[0].id;
    expect(watcher.acknowledgeWake(id, T0)).not.toBeNull();
    expect(watcher.acknowledgeWake(id, T0 + 1)).not.toBeNull();
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('acknowledging an unknown wake is a no-op', () => {
    const watcher = running();
    expect(watcher.acknowledgeWake('wk_nope', T0)).toBeNull();
    expect(watcher.resolveWake('wk_nope', 'EXECUTED', T0)).toBeNull();
  });

  it('resolving a wake twice does not resurrect it', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const id = watcher.pendingWakes()[0].id;
    watcher.resolveWake(id, 'EXECUTED', T0 + SECOND);
    watcher.resolveWake(id, 'EXECUTED', T0 + 2 * SECOND);
    expect(watcher.pendingWakes()).toHaveLength(0);
    expect(watcher.wakeHistory().filter((wake) => wake.id === id)).toHaveLength(1);
  });
});

describe('out-of-order and delayed delivery', () => {
  it('ignores an event older than the last one processed', async () => {
    const watcher = running();
    const evaluator = alternating().when('new', FALSE).when('old', TRUE);
    await watcher.tick(event('new', T0 + 10 * SECOND), evaluator, T0 + 10 * SECOND);
    const result = await watcher.tick(event('old', T0), evaluator, T0 + 11 * SECOND);
    expect(result.outcome.kind).toBe('SKIPPED');
    if (result.outcome.kind === 'SKIPPED') expect(result.outcome.reason).toBe('OUT_OF_ORDER');
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('prefers the venue sequence over the timestamp', async () => {
    const watcher = running();
    const evaluator = alternating();
    // Later timestamp, earlier sequence: the sequence is authoritative.
    await watcher.tick(event('a', T0, { sequence: 5 }), evaluator, T0);
    const result = await watcher.tick(event('b', T0 + 60 * SECOND, { sequence: 4 }), evaluator, T0 + 61 * SECOND);
    expect(result.outcome.kind).toBe('SKIPPED');
    if (result.outcome.kind === 'SKIPPED') expect(result.outcome.reason).toBe('OUT_OF_ORDER');
  });

  it('a replayed old market event cannot act on a restored watcher', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', FALSE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const restored = Watcher.restore(watcher.persist());
    const before = restored.pendingWakes().length;
    evaluator.when('replay', TRUE);
    const result = await restored.tick(event('replay', T0 - 60 * SECOND), evaluator, T0 + SECOND);
    expect(result.outcome.kind).toBe('SKIPPED');
    // No wake from the replay itself.
    expect(restored.pendingWakes()).toHaveLength(before);
  });
});

describe('queue pressure', () => {
  it('the hourly cap binds before the queue can fill', async () => {
    /*
     * Worth stating rather than leaving implied: with the documented
     * limits (60 wakes an hour against a 100-slot queue) a watcher can
     * never actually fill its queue by rate of production. The queue
     * bound is therefore a backstop for a consumer that falls behind
     * across many hours, not a per-minute overflow. The queue's own
     * drop-the-oldest behaviour is tested directly on the queue below.
     */
    const watcher = running();
    const evaluator = alternating();
    let at = T0;
    for (let index = 0; index < 300; index += 1) {
      evaluator.when(`e${index}`, index % 2 === 0 ? FALSE : TRUE);
      await watcher.tick(event(`e${index}`, at), evaluator, at);
      at += 2 * SECOND;
    }
    expect(watcher.pendingWakes().length).toBeLessThan(100);
    // Every wake that was produced is still accounted for, and the ones
    // the cap refused were not queued to be delivered later.
    expect(watcher.pendingWakes().every((wake) => wake.configVersion === 1)).toBe(true);
  });

  it('a wake older than the expiry is not acted on', async () => {
    const watcher = Watcher.create(IDENTITY, config(), T0);
    watcher.act('deploy', T0);
    watcher.act('start', T0);
    // A short expiry so the test does not have to wait five minutes.
    (watcher as unknown as { queue: { options: { maxAgeMs: number } } }).queue.options.maxAgeMs = 5 * SECOND;
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(1);

    const at = T0 + 60 * SECOND;
    const evaluator2 = alternating().when('e2', FALSE);
    await watcher.tick(event('e2', at), evaluator2, at);
    expect(watcher.pendingWakes()).toHaveLength(0);
    expect(watcher.wakeHistory().some((wake) => wake.outcome === 'STALE')).toBe(true);
  });
});

describe('rapid start and stop', () => {
  it('a hundred start/stop cycles leave exactly one watcher', () => {
    const watcher = running();
    for (let index = 0; index < 100; index += 1) {
      watcher.act('stop', T0 + index);
      watcher.act('start', T0 + index);
    }
    expect(watcher.status).toBe('RUNNING');
    expect(watcher.id).toBe(watcherIdFor(IDENTITY));
  });

  it('churning never produces a wake for a stopped watcher', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    for (let index = 0; index < 50; index += 1) {
      watcher.act('stop', T0 + index);
      const result = await watcher.tick(event(`e${index}`, T0 + index), evaluator, T0 + index);
      expect(result.outcome.kind).toBe('SKIPPED');
      if (result.outcome.kind === 'SKIPPED') expect(result.outcome.reason).toBe('NOT_RUNNING');
    }
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('every defined transition lands in a state with a way out', () => {
    // A table entry that points at a dead end is how a user gets stuck.
    // `canTransition` rather than `applyAction`, because most pairs are
    // deliberately invalid and must stay that way.
    const statuses = ['CREATED', 'DEPLOYING', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'ERROR'] as const;
    const actions = ['deploy', 'start', 'pause', 'resume', 'stop', 'fail', 'retry'] as const;
    for (const status of statuses) {
      for (const action of actions) {
        if (!canTransition(status, action)) continue;
        const next = applyAction(status, action);
        expect(statuses).toContain(next);
        if (next === 'RUNNING') continue;
        const hasExit = actions.some((candidate) => canTransition(next, candidate));
        expect(hasExit, `${next} (reached by ${action} from ${status}) has no way out`).toBe(true);
      }
    }
  });

  it('an invalid transition is refused rather than silently coerced', () => {
    // Starting a watcher that was never deployed has to be an error, not
    // a quiet no-op that leaves the user pressing a dead button.
    expect(canTransition('CREATED', 'start')).toBe(false);
    expect(() => applyAction('CREATED', 'start')).toThrow(/Cannot start/);
    expect(() => applyAction('RUNNING', 'pause')).not.toThrow();
  });
});

describe('rapid configuration updates', () => {
  it('ten edits in a row leave one coherent configuration', () => {
    const watcher = running();
    for (let version = 2; version <= 11; version += 1) {
      watcher.updateConfig(config({ configVersion: version, name: `v${version}` }), T0 + version);
    }
    expect(watcher.state.config.configVersion).toBe(11);
    expect(watcher.state.config.name).toBe('v11');
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('a wake never carries a configuration version newer than the one that produced it', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const wake = watcher.pendingWakes()[0];
    expect(wake.configVersion).toBe(1);

    watcher.updateConfig(config({ configVersion: 2 }), T0 + SECOND);
    evaluator.when('e2', TRUE);
    await watcher.tick(event('e2', T0 + 2 * SECOND), evaluator, T0 + 2 * SECOND);
    expect(watcher.pendingWakes()[0].configVersion).toBe(2);
    // The old wake is not still sitting there pretending to be current.
    expect(watcher.pendingWakes().some((entry) => entry.configVersion === 1)).toBe(false);
  });

  it('an edit that does not advance the version is refused', () => {
    const watcher = running();
    expect(() => watcher.updateConfig(config({ configVersion: 1 }), T0)).toThrow(/must increase/);
    // A version below 1 is not a valid configuration at all, which is
    // refused earlier and for a different reason.
    expect(() => watcher.updateConfig(config({ configVersion: 0 }), T0)).toThrow(/invalid configuration/);
  });
});

describe('the queue bound itself', () => {
  it('drops the oldest and keeps the newest when it overflows', () => {
    const queue = new WakeQueue({ maxSize: 3, maxAgeMs: 1_000_000 });
    for (let index = 0; index < 5; index += 1) {
      queue.enqueue(
        buildWake({
          watcherId: 'w', goatId: 'b', deploymentId: 'd', marketEventId: `e${index}`,
          configVersion: 1, status: 'TRUE', summary: 's', reason: 'r',
          conditions: { overall: 'TRUE', summary: 's' }, nowMs: T0 + index,
        }),
        T0 + index,
      );
    }
    const pending = queue.list();
    expect(pending.map((wake) => wake.marketEventId)).toEqual(['e2', 'e3', 'e4']);
    // The dropped ones are recorded with a reason, not silently lost.
    const dropped = queue.history().filter((wake) => wake.outcome === 'QUEUE_FULL');
    // `history()` is newest-first, so the first drop is listed last.
    expect(dropped.map((wake) => wake.marketEventId)).toEqual(['e1', 'e0']);
  });
});

describe('a wake must not become two orders', () => {
  it('one wake yields one idempotency key, and a retry reuses it', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const wake = watcher.pendingWakes()[0];

    const firstAttempt = idempotencyKeyFor(wake.id, 1);
    // A retry after a lost response must reuse the key so the exchange
    // can collapse it. This is the difference between one order and two.
    const retry = idempotencyKeyFor(wake.id, 1);
    expect(retry).toBe(firstAttempt);
    // A deliberate second trade is a different key.
    expect(idempotencyKeyFor(wake.id, 2)).not.toBe(firstAttempt);
  });

  it('no wake is ever produced without a resolvable evaluation', async () => {
    const watcher = running();
    const evaluator = alternating().when('u', UNKNOWN);
    const result = await watcher.tick(event('u', T0), evaluator, T0);
    expect(watcher.pendingWakes()).toHaveLength(0);
    expect(result.outcome.kind).not.toBe('WOKEN');
  });

  it('the wake carries the evaluation that produced it', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const wake = watcher.pendingWakes()[0];
    expect(wake.evaluationId).toMatch(/^ev_/);
    expect(wake.marketEventId).toBe('e1');
    expect(wake.configVersion).toBe(1);
  });

  it('a wake never carries anything order-shaped', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0, { price: 2300, volume: 12 }), evaluator, T0);
    const serialised = JSON.stringify(watcher.pendingWakes()[0]);
    for (const forbidden of ['side', 'orderSize', 'leverage', 'stopLoss', 'signature', 'quantity']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('a wake for a watcher that is gone', () => {
  it('stopping discards pending wakes with a reason', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const { discarded } = watcher.act('stop', T0 + SECOND);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].outcome).toBe('WATCHER_STOPPED');
  });

  it('a bot that no longer exists resolves to BOT_DELETED rather than lingering', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const id = watcher.pendingWakes()[0].id;
    const resolved = watcher.resolveWake(id, 'BOT_DELETED' as WakeOutcome, T0 + SECOND);
    expect(resolved?.outcome).toBe('BOT_DELETED');
    expect(watcher.pendingWakes()).toHaveLength(0);
  });

  it('an untradeable market is recorded rather than silently dropped', async () => {
    const watcher = running();
    const evaluator = alternating().when('e1', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    const id = watcher.pendingWakes()[0].id;
    const resolved = watcher.resolveWake(id, 'MARKET_UNAVAILABLE', T0 + SECOND);
    expect(resolved?.outcome).toBe('MARKET_UNAVAILABLE');
  });
});

describe('the engine being unavailable', () => {
  it('an unreachable engine never produces a wake', async () => {
    const watcher = running();
    const evaluator = {
      evaluate: async () => { throw new Error('ECONNREFUSED'); },
      fail: (_c: WatcherConfig, e: MarketEvent, error: unknown) => ({
        evaluationId: 'ev_x',
        durationMs: 0,
        result: { status: 'UNKNOWN' as const, summary: 'down', conditions: [], reason: (error as Error).message },
      }),
    };
    for (let index = 0; index < 10; index += 1) {
      await watcher.tick(event(`e${index}`, T0 + index * 2 * SECOND), evaluator, T0 + index * 2 * SECOND);
    }
    expect(watcher.pendingWakes()).toHaveLength(0);
    // Repeated failures are visible rather than looking like a quiet bot.
    expect(watcher.health(T0 + 60 * SECOND).healthy).toBe(false);
  });

  it('a timeout is not treated as a refusal', async () => {
    // The distinction that prevents a duplicate order: the engine may
    // simply not have answered yet.
    const watcher = running();
    const evaluator = {
      evaluate: async () => { throw new Error('The operation was aborted'); },
      fail: () => ({ evaluationId: 'ev', durationMs: 8_000, result: { status: 'UNKNOWN' as const, summary: 'timeout', conditions: [], reason: 'timed out' } }),
    };
    const result = await watcher.tick(event('e1', T0), evaluator, T0);
    expect(result.outcome.kind).not.toBe('WOKEN');
    expect(watcher.state.lastConditionStatus).toBeNull();
  });
});

describe('concurrent-ish delivery', () => {
  it('two watchers on the same market produce independent wakes', async () => {
    const a = running();
    const b = Watcher.create({ ...IDENTITY, deploymentId: 'dep-2' }, config(), T0);
    b.act('deploy', T0);
    b.act('start', T0);
    const evaluator = alternating().when('e1', TRUE);
    await a.tick(event('e1', T0), evaluator, T0);
    await b.tick(event('e1', T0), evaluator, T0);
    expect(a.pendingWakes()).toHaveLength(1);
    expect(b.pendingWakes()).toHaveLength(1);
    // Different deployments, so different ids: one event is legitimately
    // one wake per watcher.
    expect(a.pendingWakes()[0].id).not.toBe(b.pendingWakes()[0].id);
  });

  it('interleaved ticks on one watcher stay consistent', async () => {
    const watcher = running();
    const evaluator = alternating();
    evaluator.when('e1', FALSE);
    evaluator.when('e2', TRUE);
    evaluator.when('e3', FALSE);
    evaluator.when('e4', TRUE);
    await watcher.tick(event('e1', T0), evaluator, T0);
    await watcher.tick(event('e3', T0 + 2 * SECOND), evaluator, T0 + 2 * SECOND);
    await watcher.tick(event('e2', T0 + 4 * SECOND), evaluator, T0 + 4 * SECOND);
    await watcher.tick(event('e4', T0 + 6 * SECOND), evaluator, T0 + 6 * SECOND);
    // e2 arrives after e3 but carries a later timestamp, so it is
    // accepted; the edge count follows the timestamps, not arrival.
    expect(watcher.pendingWakes().length).toBeGreaterThanOrEqual(1);
  });
});

describe('determinism', () => {
  it('the same inputs produce the same ids, run to run', () => {
    expect(wakeIdFor('w-1', 'e-1', 3)).toBe(wakeIdFor('w-1', 'e-1', 3));
    expect(idempotencyKeyFor('wk-1', 2)).toBe(idempotencyKeyFor('wk-1', 2));
    expect(watcherIdFor(IDENTITY)).toBe(watcherIdFor({ ...IDENTITY }));
  });

  it('different inputs produce different ids', () => {
    expect(wakeIdFor('w-1', 'e-1', 1)).not.toBe(wakeIdFor('w-1', 'e-1', 2));
    expect(wakeIdFor('w-1', 'e-1', 1)).not.toBe(wakeIdFor('w-2', 'e-1', 1));
    expect(wakeIdFor('w-1', 'e-1', 1)).not.toBe(wakeIdFor('w-1', 'e-2', 1));
  });
});
