/**
 * The durable runtime lifecycle.
 *
 * ## What is being claimed
 *
 * That `deployGoat` registers a runtime, `pauseGoat` suspends it, `resumeGoat`
 * reactivates the same one, `undeployGoat` retires it, and a refresh — which
 * discards a GOAT's *work* — does not leave a registered runtime behind pointing at
 * a session that no longer exists.
 *
 * The double records every call, so the assertions are about what the orchestrator
 * actually asked for rather than about a stored flag it might set. A lifecycle that
 * "works" because a boolean was flipped is not a lifecycle.
 *
 * ## Why the identity matters
 *
 * `(userId, goalId, deploymentId)` is the worker's identity, so these tests assert
 * the identity that goes out as well as the call. A runtime registered under the
 * wrong deployment is worse than no runtime: it keeps waking, for a market nobody
 * deployed.
 *
 * `bun src/engine/goat/durableRuntimeTests.ts`
 */

import { GoatOrchestrator } from './orchestrator';
import { agentRuntime, DemoEnvironment } from '../agents';
import { InMemoryAgentTimelineStore } from '../agents/timeline/store';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { TrackerRegistry } from '../agents/trackers/registry';
import { InMemoryDeploymentStore } from './deployments';
import { InMemorySkillStore } from './skillStore';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
} from './store';
import type { ActivateRequest, DurableRuntime, RuntimeIdentity, RuntimeReport } from './durableRuntime';

// ---------------------------------------------------------------------------

let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`pass  ${name}`);
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Records every call, so assertions are about behaviour and not about flags. */
class RecordingRuntime implements DurableRuntime {
  readonly available = true;
  readonly activated: ActivateRequest[] = [];
  readonly suspended: RuntimeIdentity[] = [];
  readonly retired: RuntimeIdentity[] = [];
  /** Set to make the next call fail, as a worker outage would. */
  failWith: string | undefined;

  async activate(request: ActivateRequest): Promise<RuntimeReport> {
    this.activated.push(request);
    if (this.failWith) return { ok: false, reason: this.failWith };
    return { ok: true, watcherId: `w_${this.activated.length}` };
  }
  async suspend(identity: RuntimeIdentity): Promise<RuntimeReport> {
    this.suspended.push(identity);
    return { ok: true, watcherId: 'w' };
  }
  async retire(identity: RuntimeIdentity): Promise<RuntimeReport> {
    this.retired.push(identity);
    return { ok: true, watcherId: 'w' };
  }
}

/**
 * A counter, so every test gets its own GOAT.
 *
 * `agentRuntime` is a module-level singleton, and the activity log is read from it,
 * so two tests sharing a goal id would share a log — and a suite about lifecycle
 * wiring that passes because of another test's activity is worse than no suite.
 */
let harnessCount = 0;

function harness(options: { runtime?: DurableRuntime; userId?: string | undefined } = {}) {
  const at = 1_700_000_000_000;
  harnessCount += 1;
  const suffix = `_${harnessCount}`;
  const clock = { now: () => at };
  const runtime = options.runtime ?? new RecordingRuntime();
  const env = new DemoEnvironment();
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((agentId: string) => agentRuntime.getAgent(agentId)),
    agents: agentRuntime,
    timeline: new InMemoryAgentTimelineStore(),
    clock: clock.now,
  });
  const orchestrator = new GoatOrchestrator({
    agentRuntime,
    trackers,
    env,
    clock: clock.now,
    runtime,
    // `userId: undefined` means "nobody signed in"; absent means "signed in as
    // Alice". Two different things, so presence is checked rather than value.
    runtimeUserId: () => ('userId' in options ? options.userId : 'user_alice'),
    stores: {
      goals: new InMemoryGoalStore(),
      theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(),
      ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(),
      skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  });

  orchestrator.stores.goals.save({
    id: `goal_dur${suffix}`,
    agentId: `goat_dur${suffix}`,
    statement: 'Trade EUR/USD when the structure gives a setup.',
    symbols: [],
    timeframes: ['15m'],
    skillIds: ['structural-trend-analysis'],
    status: 'DRAFT',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  /*
   * Activities collected locally rather than read back from the runtime.
   *
   * `agentRuntime` is a module-level singleton whose timeline is shared with every
   * other test in the file, and its writes are fire-and-forget. Reading it back
   * would make each assertion depend on which tests ran before it — so the
   * orchestrator's own `recordActivity` is wrapped and the events are collected
   * here. That is also a more direct assertion: it checks exactly what the
   * orchestrator wrote, not what a shared store happened to retain.
   */
  const recorded: Array<{ type: string; data: unknown }> = [];
  const original = orchestrator.recordActivity.bind(orchestrator);
  type ActivityEvent = Parameters<GoatOrchestrator['recordActivity']>[0];
  (orchestrator as unknown as { recordActivity: (event: ActivityEvent) => void }).recordActivity = (
    event: ActivityEvent,
  ) => {
    recorded.push({ type: event.type, data: event.data });
    original(event);
  };

  return {
    orchestrator,
    runtime: runtime as RecordingRuntime,
    env,
    recorded,
    goalId: `goal_dur${suffix}`,
    agentId: `goat_dur${suffix}`,
  };
}

/** Let a fire-and-forget runtime call land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------

await test('deploying a GOAT registers a durable runtime under the right identity', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness();
  const deployment = orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  assertEqual(runtime.activated.length, 1, 'exactly one runtime was registered');
  const request = runtime.activated[0];
  assertEqual(request.userId, 'user_alice', 'under the signed-in user');
  assertEqual(request.goalId, agentId, 'for this GOAT');
  assertEqual(request.deploymentId, deployment.id, 'and this deployment — the worker keys on all three');
  assertEqual(request.market, 'EUR/USD', 'pointed at the deployed market');
  assert(request.conditionTree !== undefined, 'with a condition tree, which the worker requires');
});

await test('deploying without a signed-in user registers nothing rather than a nameless runtime', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness({ userId: undefined });
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  assertEqual(runtime.activated.length, 0, 'nothing was registered');
  // And the deployment itself still happened: refusing to register a runtime is
  // not a reason to refuse to deploy.
  assert(orchestrator.stores.deployments.currentFor(agentId) !== undefined, 'the deployment stands');
});

await test('pausing suspends the runtime and keeps its state for a resume', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness();
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  orchestrator.pauseGoat(goalId);
  await settle();

  assertEqual(runtime.suspended.length, 1, 'the runtime was suspended');
  assertEqual(runtime.retired.length, 0, 'and not retired — a pause is not an undeploy');
});

await test('resuming reactivates the same runtime rather than making a second one', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness();
  const deployment = orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();
  orchestrator.pauseGoat(goalId);
  await settle();

  await orchestrator.resumeGoat(goalId);
  await settle();

  assertEqual(runtime.activated.length, 2, 'activation was requested again');
  assertEqual(
    runtime.activated[1].deploymentId,
    runtime.activated[0].deploymentId,
    'on the same deployment id, so the worker recognises it as the same runtime',
  );
  assertEqual(runtime.activated[1].deploymentId, deployment.id, 'and that is the deployment the GOAT still holds');
});

await test('undeploying retires the runtime, so nothing is left waking', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness();
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  await orchestrator.undeployGoat(goalId, 'Not needed.');

  assertEqual(runtime.retired.length, 1, 'the runtime was retired');
  assertEqual(runtime.retired[0].goalId, agentId, 'for this GOAT');
  assertEqual(runtime.suspended.length, 0, 'retired outright rather than merely suspended');
  assertEqual(orchestrator.stores.deployments.currentFor(agentId), undefined, 'and no deployment is current');
});

await test('undeploying awaits the retirement, so a deleted GOAT has no orphan', async () => {
  /*
   * Ordering, which is the whole point.
   *
   * `undeployGoat` is async and returns when it is done. If it retired the runtime
   * without awaiting, a caller that immediately deployed again would race: the new
   * deployment could register before the old runtime was retired, and the worker's
   * identity — keyed on the deployment — would end up with two objects where there
   * should be one retired and one live.
   */
  let settled = false;
  const slowRuntime: DurableRuntime = {
    available: true,
    async activate() {
      return { ok: true, watcherId: 'w' };
    },
    async suspend() {
      return { ok: true, watcherId: 'w' };
    },
    async retire() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = true;
      return { ok: true, watcherId: 'w' };
    },
  };
  const { orchestrator, goalId } = harness({ runtime: slowRuntime });
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  await orchestrator.undeployGoat(goalId);

  assert(settled, 'undeployGoat returned only after the runtime was retired');
});

await test('a runtime that fails to register leaves the deployment working and says so', async () => {
  const { orchestrator, runtime, recorded, goalId, agentId } = harness();
  runtime.failWith = 'The watcher service is unreachable.';
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  assert(
    orchestrator.stores.deployments.currentFor(agentId) !== undefined,
    'the deployment still exists — the in-tab runtime is running',
  );
  const reported = recorded.find((entry) => entry.type === 'RUNTIME_UNAVAILABLE');
  assert(reported !== undefined, 'and the failure is on the record rather than swallowed');
  const reason = String((reported!.data as { reason?: unknown }).reason ?? '');
  assert(
    reason.includes('unreachable'),
    `carrying the worker's own reason (${reason})`,
  );
});

await test('a refresh discards the session without leaving a runtime behind', async () => {
  const { orchestrator, runtime, goalId, agentId } = harness();
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  await orchestrator.clearGoatSession(goalId);
  await settle();

  /*
   * A refresh resets the GOAT's *work*, and the durable runtime's state is work:
   * the cooldowns and the last evaluation belong to the session that is being
   * cleared. Leaving it registered would carry a previous session's cooldowns into
   * a clean one, which is precisely what the user asked not to happen.
   */
  assert(
    runtime.suspended.length + runtime.retired.length > 0,
    'the runtime was suspended or retired rather than left as it was',
  );
});

await test('a build with no runtime configured deploys normally and logs nothing', async () => {
  const { InertRuntime } = await import('./durableRuntime');
  const { orchestrator, runtime, goalId, agentId } = harness({ runtime: new InertRuntime() });
  orchestrator.deployGoat({ goalId: goalId, market: 'EUR/USD' });
  await settle();

  assert(
    orchestrator.stores.deployments.currentFor(agentId) !== undefined,
    'the deployment is unaffected by having no durable runtime',
  );
  assert(
    !orchestrator.agentLog('goat_dur', 100).some((entry) => entry.type === 'RUNTIME_UNAVAILABLE'),
    'and no warning is logged, because "not configured" is a supported state rather than a failure',
  );
  void runtime;
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} durable runtime test(s) failed.`);
}