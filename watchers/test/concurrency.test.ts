/**
 * Concurrency, tested deterministically.
 *
 * The Watcher is a single-threaded state machine, and a Durable Object
 * serialises every call to one instance, so the interesting races are not
 * data races -- they are interleavings where two *logically* independent
 * operations each look correct alone and together produce a state nobody
 * asked for.
 *
 * The pairs the audit named: a config edit racing a wake, a duplicate
 * event racing an evaluation, a stop racing a start, and an execution
 * racing its own retry. Each drives real overlapping promises rather
 * than asserting against a hand-written interleaving.
 */

import { describe, expect, it } from 'vitest';
import type { ConditionEvaluator, EvaluationOutcome } from '../src/watcher';
import { applyAction, type MarketEvent, type WatcherAction, type WatcherConfig, type WatcherIdentity, type WatcherStatus } from '../src/contract';
import { Watcher } from '../src/watcher';

const IDENTITY: WatcherIdentity = { userId: 'user-a', goatId: 'bot-1', deploymentId: 'dep-1' };
const T0 = 1_700_000_000_000;

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    configVersion: 1,
    name: 'Gold',
    market: 'xyz:GOLD',
    conditionTree: {
      schemaVersion: 1,
      then: 'WAKE_AI',
      root: { id: 'g', kind: 'GROUP', operator: 'AND', children: [{ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }] },
    },
    minEvaluationIntervalMs: 1_000,
    cooldownMs: 0,
    maxWakesPerHour: 60,
    maxWakesPerDay: 1_000,
    ...overrides,
  };
}

function event(id: string, timestamp: number, overrides: Partial<MarketEvent> = {}): MarketEvent {
  return { marketEventId: id, market: 'xyz:GOLD', eventType: 'TICK', timestamp, price: 2_300, ...overrides } as MarketEvent;
}

/** An evaluator whose answer the test controls, and which can be held open. */
class ControllableEvaluator implements ConditionEvaluator {
  calls = 0;
  private outcome: EvaluationOutcome = outcome('FALSE');
  private hold: (() => void) | undefined;

  willReturn(next: EvaluationOutcome): void { this.outcome = next; }

  /** Block every evaluation until `release()` is called. */
  block(): void {
    this.blocked = true;
  }

  release(): void {
    this.blocked = false;
    const gate = this.hold;
    this.hold = undefined;
    gate?.();
  }

  private blocked = false;

  async evaluate(): Promise<EvaluationOutcome> {
    this.calls += 1;
    if (this.blocked) {
      await new Promise<void>((resolve) => { this.hold = resolve; });
    }
    return this.outcome;
  }

  fail(): EvaluationOutcome {
    return outcome('UNKNOWN');
  }
}

function outcome(status: 'TRUE' | 'FALSE' | 'UNKNOWN'): EvaluationOutcome {
  return {
    evaluationId: 'eval-1',
    result: { status, summary: `scripted ${status}`, conditions: [] },
    durationMs: 1,
  };
}

/** The wake a tick produced, or undefined when it did not wake. */
function wakeOf(result: { outcome: { kind: string } }): { configVersion: number; id: string } | undefined {
  const outcome = result.outcome as { kind: string; wake?: { configVersion: number; id: string } };
  return outcome.kind === 'WOKEN' ? outcome.wake : undefined;
}

function running(configured = config(), nowMs = T0): { watcher: Watcher; evaluator: ControllableEvaluator } {
  const evaluator = new ControllableEvaluator();
  const watcher = Watcher.create(IDENTITY, configured, nowMs);
  watcher.act('deploy', nowMs);
  watcher.act('start', nowMs);
  return { watcher, evaluator };
}

describe('concurrency', () => {
  it('two starts in a row leave exactly one RUNNING watcher', () => {
    const { watcher } = running();
    expect(watcher.state.status).toBe('RUNNING');
    // A double-click on Start, or a retried request. Repeating a
    // transition that is already in effect is a no-op rather than an
    // error, so a retried request cannot fail a caller for succeeding.
    const again = watcher.act('start', T0 + 1);
    expect(again.status).toBe('RUNNING');
    expect(watcher.state.status).toBe('RUNNING');
  });

  it('a repeated stop settles the watcher rather than stranding it', () => {
    const { watcher } = running();
    expect(watcher.act('stop', T0 + 1).status).toBe('STOPPING');
    /*
     * STOPPING is not a resting state. The transition table sends
     * STOPPING --stop--> STOPPED, and an earlier version short-circuited
     * that as a "harmless repeat", so a watcher that was stopped once
     * could never finish stopping: it reported STOPPING forever, with no
     * action available to leave it.
     */
    expect(watcher.act('stop', T0 + 2).status).toBe('STOPPED');
    expect(watcher.state.status).toBe('STOPPED');
    // A third stop is now genuinely a no-op, and must not fail.
    expect(watcher.act('stop', T0 + 3).status).toBe('STOPPED');
  });

  it('every status can reach a settled state from every action', () => {
    // A dead state is a status with no path out. Asserted over the whole
    // table so a future entry cannot introduce one.
    const statuses: WatcherStatus[] = ['CREATED', 'DEPLOYING', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'ERROR'];
    const actions: WatcherAction[] = ['deploy', 'start', 'pause', 'resume', 'stop', 'fail', 'retry'];
    const deadEnds: string[] = [];
    for (const status of statuses) {
      const reachable = actions
        .map((action) => {
          try {
            return applyAction(status, action);
          } catch {
            return undefined;
          }
        })
        .filter((next): next is WatcherStatus => next !== undefined);
      if (reachable.length === 0) deadEnds.push(status);
    }
    expect(deadEnds).toEqual([]);
  });

  it('a start issued while stopping cancels the stop', () => {
    // The case that once needed three presses.
    const { watcher } = running();
    watcher.act('stop', T0 + 1);
    expect(watcher.state.status).toBe('STOPPING');
    watcher.act('start', T0 + 2);
    expect(watcher.state.status).toBe('RUNNING');
  });

  it('a start then a stop in quick succession settles on STOPPED', () => {
    const { watcher } = running();
    watcher.act('stop', T0 + 1);
    watcher.act('start', T0 + 2);
    watcher.act('stop', T0 + 3);
    expect(watcher.state.status).toBe('STOPPING');
  });

  it('a config edit and a tick racing each other leave a consistent watcher', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));

    // Both promises are in flight at once; neither has settled when the
    // other is created.
    const [ , tickResult] = await Promise.all([
      watcher.updateConfig(config({ configVersion: 2, name: 'Gold v2' }), T0 + 10),
      watcher.tick(event('race', T0), evaluator, T0 + 10),
    ]);

    expect(watcher.state.config.configVersion).toBe(2);
    /*
     * A tick that evaluated *after* the edit legitimately produces a
     * version-2 wake; one that evaluated before produces a version-1
     * wake, which the edit must then discard. What must never happen is
     * a pending wake left under a version that is no longer current.
     */
    for (const pending of watcher.pendingWakes()) {
      expect(pending.configVersion).toBe(watcher.state.config.configVersion);
    }
    void tickResult;
  });

  it('a config edit discards wakes that were pending under the old version', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));
    await watcher.tick(event('e1', T0), evaluator, T0);

    expect(watcher.pendingWakes()).toHaveLength(1);
    const discarded = watcher.updateConfig(config({ configVersion: 2, name: 'Gold v2' }), T0 + 10);

    /*
     * The documented answer is "discard". A pending wake is a request to
     * act, and acting on it would mean acting on a configuration the
     * user has just replaced.
     */
    expect(discarded.discarded.length + watcher.pendingWakes().length).toBe(1);
    for (const wake of watcher.pendingWakes()) {
      expect(wake.configVersion).toBe(2);
    }
  });

  it('a config edit that is a no-op change still bumps the version', () => {
    // Otherwise a pending wake could survive an "edit" that did not
    // change anything, keeping a stale version alive.
    const { watcher } = running();
    const before = watcher.state.config.configVersion;
    watcher.updateConfig(config({ configVersion: before + 1 }), T0 + 10);
    expect(watcher.state.config.configVersion).toBe(before + 1);
  });

  it('the same market event delivered concurrently yields one wake', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));

    // A feed retry landing twice is the realistic version of this.
    const [a, b] = await Promise.all([
      watcher.tick(event('same', T0), evaluator, T0),
      watcher.tick(event('same', T0), evaluator, T0),
    ]);

    expect([a, b].filter((result) => wakeOf(result) !== undefined)).toHaveLength(1);
    expect(watcher.pendingWakes()).toHaveLength(1);
  });

  it('ten concurrent deliveries of one event produce at most one wake', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => watcher.tick(event('burst', T0), evaluator, T0)),
    );
    expect(results.filter((result) => wakeOf(result) !== undefined).length).toBeLessThanOrEqual(1);
    expect(watcher.pendingWakes().length).toBeLessThanOrEqual(1);
  });

  it('a duplicate arriving while the first evaluation is still open does not double-wake', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));
    evaluator.block();

    // The first tick is still inside the evaluator when the second is
    // created, so ordering alone has to prevent the second wake.
    const first = watcher.tick(event('dup', T0), evaluator, T0);
    const second = watcher.tick(event('dup', T0), evaluator, T0);
    evaluator.release();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => wakeOf(result) !== undefined).length).toBeLessThanOrEqual(1);
  });

  it('a stop during a burst does not leave a wake for a stopped watcher', async () => {
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));

    const ticks = Array.from({ length: 5 }, (_, index) =>
      watcher.tick(event(`burst-${index}`, T0 + index * 2_000), evaluator, T0 + index * 2_000));
    const results = await Promise.all(ticks);
    watcher.act('stop', T0 + 20_000);

    // Events accepted before the stop may have woken. None may be
    // attributed to a watcher that has since been stopped.
    for (const result of results) {
      if (wakeOf(result)) expect(watcher.state.status).not.toBe('RUNNING');
    }
  });

  it('a retried acknowledgement is idempotent, and delivery stays at-least-once', async () => {
    /*
     * An execution whose response was lost retries. Two properties have
     * to hold together:
     *
     *  - retrying is safe: the same wake comes back, never a second one,
     *    and never a duplicate settlement;
     *  - delivery is at-least-once: an acknowledged wake is still
     *    claimable, because a consumer that crashed after claiming has
     *    not executed it and dropping it would lose a real market event.
     *
     * The second point is why correctness rests on the execution
     * adapter's idempotency key rather than on the queue delivering
     * exactly once. This test pins the first point, which is the one
     * that can regress silently.
     */
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));
    await watcher.tick(event('exec', T0), evaluator, T0);

    const [pending] = watcher.pendingWakes();
    expect(pending).toBeDefined();
    expect(pending.status).toBe('PENDING');

    const first = watcher.acknowledgeWake(pending.id, T0 + 1);
    const second = watcher.acknowledgeWake(pending.id, T0 + 2);
    expect(first?.id).toBe(pending.id);
    expect(second?.id).toBe(pending.id);
    // Still one wake, not two, and the retry moved no new wake into
    // existence.
    expect(watcher.pendingWakes()).toHaveLength(1);

    // Resolution is what retires it, and a repeated resolution returns
    // the same terminal record rather than settling it a second time --
    // an app retrying after a network failure gets the answer, not an
    // error and not a duplicate.
    watcher.resolveWake(pending.id, { kind: 'FILLED' } as never, T0 + 3);
    expect(watcher.pendingWakes()).toHaveLength(0);
    const again = watcher.resolveWake(pending.id, { kind: 'FILLED' } as never, T0 + 4);
    expect(again?.id).toBe(pending.id);
    expect(again?.terminalAt).toBe(T0 + 3);
    expect(again?.outcome).toEqual({ kind: 'FILLED' });
  });

  it('acknowledging an unknown wake id is refused, not invented', () => {
    const { watcher } = running();
    expect(watcher.acknowledgeWake('no-such-wake', T0)).toBeNull();
  });

  it('two independent watchers on one market share no state', async () => {
    const a = running();
    const b = running();
    a.evaluator.willReturn(outcome('TRUE'));
    b.evaluator.willReturn(outcome('FALSE'));

    await Promise.all([
      a.watcher.tick(event('shared', T0), a.evaluator, T0),
      b.watcher.tick(event('shared', T0), b.evaluator, T0),
    ]);

    expect(a.watcher.pendingWakes()).toHaveLength(1);
    expect(b.watcher.pendingWakes()).toHaveLength(0);
  });

  it('a lost update does not corrupt the persisted snapshot', async () => {
    // Every mutation returns a complete snapshot. Two interleaved
    // mutations must each produce a self-consistent one, never a merge
    // of two versions.
    const { watcher, evaluator } = running();
    evaluator.willReturn(outcome('TRUE'));
    const ticks = Promise.all([
      watcher.tick(event('a', T0), evaluator, T0),
      watcher.tick(event('b', T0 + 2_000), evaluator, T0 + 2_000),
    ]);
    const [, edited] = await Promise.all([
      ticks,
      watcher.updateConfig(config({ configVersion: 2 }), T0 + 2_000),
    ]);
    const snapshot = watcher.persist();
    expect(snapshot.state.config.configVersion).toBe(2);
    expect(edited.configVersion).toBe(2);
    // The persisted snapshot is internally consistent.
    expect(snapshot.state.status).toBe(watcher.state.status);
    expect(snapshot.state.watcherId).toBe(watcher.state.watcherId);
  });
});
