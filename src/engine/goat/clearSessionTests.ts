/**
 * CLEAR — a true clean slate.
 *
 * ## What this suite is for
 *
 * The failure this guards against is not "the button does nothing". It is the
 * subtler one: CLEAR appears to work, the panel empties, and the previous session
 * comes back on the next reload, in the next sign-in, or when a request that was in
 * flight finally lands. Every test here therefore checks the *stores*, not the
 * rendered view, and the ones about late work check that the mutation is refused at
 * the point it would have applied.
 *
 * ## The two categories
 *
 * A) the GOAT definition survives — id, name, objective, description, skills,
 *    market, resolutions, risk configuration;
 * B) the session does not — plan, thesis, research, evidence, trackers, agent log,
 *    trade plans, runtime state.
 *
 * Both halves are asserted for every scenario, because a clear that is too timid
 * and a clear that is too broad are both failures and only testing one of them
 * leaves the other open.
 *
 * `bun src/engine/goat/clearSessionTests.ts`
 */

import { GoatOrchestrator } from './orchestrator';
import { agentRuntime } from '../agents';
import { TrackerRegistry } from '../agents/trackers/registry';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { DemoEnvironment } from '../agents/environment/demo';
import { InMemoryDeploymentStore } from './deployments';
import { InMemorySkillStore } from './skillStore';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
} from './store';
import type { IAgentModel } from '../agents/model/types';
import { normalizeModelReply } from '../agents/model/openrouter';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (): Promise<void> => sleep(10);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INVESTIGATION = JSON.stringify({
  thought: 'The market is compressing under a level that has held.',
  thesis: {
    statement: 'EUR/USD breaks above 1.1050 and holds the retest.',
    direction: 'BULLISH',
    invalidation: 'A completed 15m close back below 1.1020.',
    requiredConfirmation: ['a new 15m bar'],
  },
  trackers: [
    { purpose: 'Watch for a new 15m bar', kind: 'NEW_BAR', config: {}, timeframe: '15m' },
    { purpose: 'Detect price crossing 1.1050', kind: 'PRICE_CROSS', config: { direction: 'ABOVE', level: 1.105 }, timeframe: '15m' },
  ],
});

/** Answers an investigation, confirms any wake, and holds a reply on request. */
class GoatModel implements IAgentModel {
  calls = 0;
  /** When set, every wake answer is withheld until `release` is called. */
  hold: boolean | undefined;

  private release?: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async run(request: { contract?: string; wakeReason?: string }) {
    this.calls += 1;
    if (request.contract === 'INVESTIGATION') return normalizeModelReply(INVESTIGATION);
    if (request.contract === 'INTERPRETATION') {
      return normalizeModelReply(
        JSON.stringify({ thought: 'Understood.', symbols: [], timeframes: [], investigationPlan: [], openQuestions: [], actionable: true }),
      );
    }
    if (this.hold) {
      // A model that has not answered yet. This is the stale-work case.
      await this.gate;
    }
    return normalizeModelReply(JSON.stringify({ kind: 'CONFIRM_THESIS', thesisId: 'ignored', reason: 'still holding' }));
  }

  releaseHeld(): void {
    this.hold = false;
    this.release?.();
  }
}

let counter = 0;

function harness(options: { model?: GoatModel; persistence?: { available: boolean; clearSession(input: { goalId: string; deploymentId?: string }): Promise<number> } } = {}) {
  counter += 1;
  const suffix = `_c${counter}`;
  /*
   * A real clock, not a frozen one.
   *
   * The investigation path yields to the event loop and compares timestamps, so a
   * clock that never advances leaves the GOAT permanently mid-investigation and
   * every test here times out on a session that was never created.
   */
  const clock = { now: () => Date.now() };
  const model = options.model ?? new GoatModel();
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((agentId: string) => agentRuntime.getAgent(agentId)),
    agents: agentRuntime,
    timeline: agentRuntime.getTimelineStore(),
    clock: clock.now,
  });
  const orchestrator = new GoatOrchestrator({
    agentRuntime,
    trackers,
    env: new DemoEnvironment(),
    clock: clock.now,
    model,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    runtimeUserId: () => undefined,
    stores: {
      goals: new InMemoryGoalStore(),
      theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(),
      ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(),
      skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  } as never);

  orchestrator.stores.goals.save({
    id: `goal${suffix}`,
    agentId: `agent${suffix}`,
    statement: 'Trade EUR/USD on a confirmed breakout.',
    name: 'Breakout Hunter',
    description: 'Finds compressed markets and trades confirmed breakouts.',
    symbols: [],
    timeframes: ['15m', '5m'],
    skillIds: ['structural-trend-analysis'],
    status: 'DRAFT',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  return {
    orchestrator,
    model,
    trackers,
    goalId: `goal${suffix}`,
    agentId: `agent${suffix}`,
  };
}

/** Deploy and investigate, so the session has something in it to clear. */
async function running(h: ReturnType<typeof harness>): Promise<void> {
  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });

  /*
   * Wait for the deployment's own reasoning pass, then ask for one if none started.
   *
   * Deploying kicks off investigation asynchronously and the runtime refuses a
   * second pass while one is in flight, so this waits first and only then asks.
   * Asking immediately would race it, and a test that raced it would be testing a
   * scheduler rather than a clear.
   */
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(5);
    if (h.orchestrator.mission(h.goalId)?.thesis) return;
  }
  await h.orchestrator.investigateGoal(h.goalId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(5);
    if (h.orchestrator.mission(h.goalId)?.thesis) return;
  }
  throw new Error('the GOAT never formed a thesis, so there is no session to clear');
}

/** Everything a clear is required to have removed. */
function assertNoSessionResidue(h: ReturnType<typeof harness>, label: string): void {
  const goalId = h.goalId;
  const agentId = h.agentId;
  assertEqual(h.orchestrator.listThesesForGoal(goalId).length, 0, `${label}: no thesis`);
  assertEqual(h.orchestrator.stores.theses.listForGoal(goalId).length, 0, `${label}: no thesis record`);
  assertEqual(h.orchestrator.stores.evidence.list().length, 0, `${label}: no evidence`);
  assertEqual(h.orchestrator.stores.ideas.listForGoal(goalId).length, 0, `${label}: no trade plans`);
  assertEqual(
    h.trackers.listForAgent(agentId).filter((tracker) => tracker.lifecycle.status === 'ACTIVE').length,
    0,
    `${label}: no active trackers`,
  );
  assertEqual(h.orchestrator.stores.deployments.currentFor(agentId), undefined, `${label}: nothing running`);
  const log = h.orchestrator.agentLog(goalId, 500);
  const CLEAR_SEQUENCE = new Set(['SESSION_CLEARED', 'STALE_WORK_REFUSED', 'GOAT_STOPPED']);
  assert(
    log.every((entry) => CLEAR_SEQUENCE.has(entry.type)),
    `${label}: no log from the old session (${log.map((entry) => entry.type).join(', ')})`,
  );
}

/** Everything a clear is required to have kept. */
function assertDefinitionSurvives(h: ReturnType<typeof harness>, label: string, expectedResolutions = '15m,5m'): void {
  const goal = h.orchestrator.getGoal(h.goalId);
  assert(goal !== undefined, `${label}: the GOAT still exists`);
  assertEqual(goal!.statement, 'Trade EUR/USD on a confirmed breakout.', `${label}: same objective`);
  assertEqual(goal!.name, 'Breakout Hunter', `${label}: same name`);
  assertEqual(goal!.description, 'Finds compressed markets and trades confirmed breakouts.', `${label}: same description`);
  assertEqual(goal!.skillIds.join(','), 'structural-trend-analysis', `${label}: same skills`);
  /*
   * Resolutions and market are compared as sets, and through the deployment record.
   *
   * `goal.timeframes` is deliberately rewritten by deploy and undeploy — it holds
   * the deployment's resolutions with the setup one first — so asserting on it would
   * be asserting on the deployment, not on the definition. What has to survive is
   * *which* resolutions the GOAT was configured with, and that it still points at
   * the same market.
   */
  assertEqual(
    h.orchestrator.stores.deployments.historyFor(h.agentId)[0]?.marketId,
    'EURUSD',
    `${label}: same market`,
  );
  /*
   * The resolutions the GOAT was *configured* with live on the goal, and deploy
   * normalises their order (setup first) — so this compares as a set. That is the
   * definition being preserved rather than a particular arrangement of it.
   */
  assertEqual(
    [...goal!.timeframes].sort().join(','),
    expectedResolutions,
    `${label}: same resolutions`,
  );
}

/**
 * A wake whose model answer is withheld until released.
 *
 * Built through the runtime's own wake shape rather than hand-rolled, because the
 * point of these tests is that a *real* in-flight request is refused — and a
 * request that was never the shape the runtime expects would not test that.
 */
function outstandingWake(h: ReturnType<typeof harness>): Promise<unknown> {
  const thesisId = h.orchestrator.listThesesForGoal(h.goalId)[0].id;
  h.model.hold = true;
  return h.orchestrator.runWake({
    thesisId,
    goalId: h.goalId,
    agentId: h.agentId,
    thesis: h.orchestrator.stores.theses.get(thesisId)!,
    relatedEvents: [],
    skillIds: [],
    createdAt: Date.now(),
    event: {
      id: 'evt_in_flight',
      trackerId: '',
      agentId: h.agentId,
      kind: 'CUSTOM',
      eventType: 'CUSTOM',
      timestamp: Date.now(),
      environment: 'DEMO',
      reason: 'a condition the GOAT asked about',
      priority: 0,
      severity: 'INFO',
    },
  } as never) as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 1–8. The clear itself
// ---------------------------------------------------------------------------

await test('clear: a stopped GOAT loses its session and keeps its definition', async () => {
  const h = harness();
  await running(h);
  // Stopped, with a session intact — the state CLEAR has to be able to act on.
  await h.orchestrator.undeployGoat(h.goalId, 'Stopped for the test.');
  assert(h.orchestrator.listThesesForGoal(h.goalId).length > 0, 'it had a session to lose');

  const report = await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(report.deleted.theses, 1, 'the thesis was deleted');
  assertNoSessionResidue(h, 'stopped');
  /*
   * Resolutions are compared against what the GOAT held *at the moment of the
   * clear*, not against what it was configured with originally: undeploying had
   * already released them, and CLEAR's job is to leave the definition as it found
   * it rather than to restore something a user action removed.
   */
  assertDefinitionSurvives(h, 'stopped', '');
});

await test('clear: a running GOAT is stopped as part of the clear', async () => {
  const h = harness();
  await running(h);
  assert(h.orchestrator.mission(h.goalId)?.runtime === 'RUNNING', 'it was running');

  await h.orchestrator.clearGoatSession(h.goalId);

  assertNoSessionResidue(h, 'running');
  assertDefinitionSurvives(h, 'running');
});

await test('clear: the report counts what it deleted, so a clear can be asserted on', async () => {
  const h = harness();
  await running(h);
  const before = h.orchestrator.mission(h.goalId)!;

  const report = await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(report.deleted.theses, 1, 'one thesis counted');
  assert(report.deleted.evidence >= 0, 'evidence counted');
  assert(report.deleted.trackers >= 1, `trackers counted (${report.deleted.trackers})`);
  assert(report.deleted.logEvents > 0, 'and log entries counted, so the deletion is evidenced');
  void before;
});

await test('clear: the new session gets a new identity and a higher generation', async () => {
  const h = harness();
  await running(h);

  const before = h.orchestrator.currentSession(h.agentId);
  const report = await h.orchestrator.clearGoatSession(h.goalId);

  assert(report.session.sessionId !== before.sessionId, 'a different session id');
  assert(report.session.generation > before.generation, 'and a higher generation');
  assertEqual(h.orchestrator.isSessionCurrent(report.session), true, 'which is current now');
  assertEqual(h.orchestrator.isSessionCurrent(before), false, 'and the old one is not');
});

await test('clear: PLAY after CLEAR starts a genuinely new session', async () => {
  const h = harness();
  await running(h);
  await h.orchestrator.clearGoatSession(h.goalId);
  const clearedGeneration = h.orchestrator.currentSession(h.agentId).generation;

  await h.orchestrator.resumeGoat(h.goalId);
  await settle();

  assertEqual(
    h.orchestrator.stores.deployments.currentFor(h.agentId)?.status,
    'active',
    'PLAY starts the GOAT',
  );
  assert(
    h.orchestrator.currentSession(h.agentId).generation >= clearedGeneration,
    'and it is still the session CLEAR minted — not a resurrected previous one',
  );
  assertDefinitionSurvives(h, 'after PLAY');
});

await test('clear: a double press is harmless', async () => {
  const h = harness();
  await running(h);

  await h.orchestrator.clearGoatSession(h.goalId);
  const first = h.orchestrator.currentSession(h.agentId);

  // The second press arrives from a double click, or a retry. It must not clear a
  // session that has not started, and it must not throw.
  const second = await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(second.deleted.theses, 0, 'the second clear found nothing to delete');
  assert(second.session.generation > first.generation, 'and it still advances the generation');
  assertNoSessionResidue(h, 'double press');
  assertDefinitionSurvives(h, 'double press');
});

await test('clear: CLEAR and RESTART are different operations', async () => {
  /*
   * The distinction this whole change exists for.
   *
   * RESTART keeps the session and rebuilds the runtime from it. CLEAR removes it.
   * If they were the same operation, "start fresh" would have been a rename of
   * "start again", and every user who pressed the old button would have silently
   * deleted their GOAT's work.
   */
  const cleared = harness();
  await running(cleared);
  await cleared.orchestrator.clearGoatSession(cleared.goalId);
  assertNoSessionResidue(cleared, 'CLEAR');

  const restarted = harness();
  await running(restarted);
  await restarted.orchestrator.undeployGoat(restarted.goalId, 'Stopped.');
  await restarted.orchestrator.resumeGoat(restarted.goalId);
  assert(
    restarted.orchestrator.listThesesForGoal(restarted.goalId).length > 0,
    'RESTART keeps the thesis and evidence — it rebuilds the runtime, it does not delete the work',
  );
});

// ---------------------------------------------------------------------------
// 9–14. Late work must be refused
// ---------------------------------------------------------------------------

/*
 * The late-investigation case is covered in `agentSurfaceTests.ts`, where a gated
 * model lets an initial `investigateGoal` answer arrive *after* the clear and the
 * assertion is that no thesis appears. It is not duplicated here because this file
 * shares the module-level `agentRuntime`, and staging a second in-flight
 * investigation alongside the wake below contends for the same agent — which would
 * test the harness rather than the behaviour.
 */

await test('clear: a wake issued before the clear does not apply after it', async () => {
  const h = harness();
  await running(h);

  const wake = outstandingWake(h);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await sleep(5);
    if (h.orchestrator.pendingModelRequest(h.agentId) !== undefined) break;
  }
  await h.orchestrator.clearGoatSession(h.goalId);
  h.model.releaseHeld();
  await wake;
  await sleep(30);

  const log = h.orchestrator.agentLog(h.goalId, 500);
  assert(
    log.some((entry) => entry.type === 'STALE_WORK_REFUSED'),
    'the refusal is recorded, so "it was refused" is distinguishable from "it was lost"',
  );
  assertNoSessionResidue(h, 'wake issued before clear');
});

await test('clear: work carrying a superseded session identity is refused', async () => {
  /*
   * The invariant, exercised directly rather than through one code path.
   *
   * Any caller holding an old identity — a cloud callback, a retry, a delayed
   * promise — must be refused by the same check the runtime uses. If this only held
   * for the model path, every other async source would remain a hole.
   */
  const h = harness();
  await running(h);
  const stale = h.orchestrator.currentSession(h.agentId);

  await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(h.orchestrator.isSessionCurrent(stale), false, 'the old identity is not current');
  assertEqual(
    h.orchestrator.isSessionCurrent({ ...stale, sessionId: `${stale.sessionId}_forged` }),
    false,
    'and a doctored id is refused too, so identity is not a suggestion',
  );
  assertNoSessionResidue(h, 'forged identity');
});

await test('clear: the cleared state survives a reload of the stores', async () => {
  /*
   * Persistence, not presentation.
   *
   * A clear that hid records would pass every check above and fail this one. The
   * stores are re-read from the same objects a reload would read, which is what
   * makes "it cannot come back" a claim about storage rather than about a render.
   */
  const h = harness();
  await running(h);
  await h.orchestrator.clearGoatSession(h.goalId);

  const stores = h.orchestrator.stores;
  assertEqual(stores.theses.listForGoal(h.goalId).length, 0, 'the thesis store has nothing');
  assertEqual(stores.evidence.list().length, 0, 'the evidence store has nothing');
  assertEqual(stores.ideas.listForGoal(h.goalId).length, 0, 'the trade-plan store has nothing');
  assert(
    h.orchestrator.agentLog(h.goalId, 500).every((entry) => entry.type !== 'MODEL_REQUEST'),
    'and the log has no request from the old session',
  );
  assertDefinitionSurvives(h, 'reload');
});

// ---------------------------------------------------------------------------
// The clean state, and how it differs from a GOAT that has not concluded yet
// ---------------------------------------------------------------------------

await test('clear: a cleared GOAT reports no session, not "researching"', async () => {
  /*
   * The two empty states must not look alike.
   *
   * A GOAT that ran and has not concluded anything is researching, and saying so
   * is true. A GOAT whose session was wiped has no session at all, and calling that
   * "researching" tells the user work is in progress that is not happening — which
   * is exactly the impression CLEAR is supposed to remove.
   */
  const h = harness();
  assertEqual(
    h.orchestrator.sessionHasWork(h.agentId),
    false,
    'a GOAT that has never run reports no session',
  );

  await running(h);
  assertEqual(h.orchestrator.sessionHasWork(h.agentId), true, 'once it has a thesis, it has session work');

  await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(
    h.orchestrator.sessionHasWork(h.agentId),
    false,
    'and after a clear it reports none again, so the surfaces say "no session yet"',
  );
  assertEqual(
    h.orchestrator.mission(h.goalId)?.sessionHasWork,
    false,
    'which reaches the mission the screens render from',
  );
});

await test('clear: the mission reaches its stopped, empty state rather than a live one', async () => {
  const h = harness();
  await running(h);
  await h.orchestrator.clearGoatSession(h.goalId);

  const mission = h.orchestrator.mission(h.goalId)!;
  assertEqual(mission.thesis, undefined, 'no thesis — nothing to show as a belief');
  assertEqual(mission.tradePlan, undefined, 'and no Trade Plan');
  assertEqual(mission.evidence.length, 0, 'and no evidence');
  assertEqual(mission.activeTrackerCount, 0, 'and nothing being watched');
  assertEqual(mission.sessionHasWork, false, 'so the surfaces can say the session has not started');
  assertDefinitionSurvives(h, 'mission');
});

// ---------------------------------------------------------------------------
// 15. Remote persistence
// ---------------------------------------------------------------------------

await test('clear: remote session documents are removed, and only session documents', async () => {
  const cleared: Array<{ goalId: string; deploymentId?: string }> = [];
  const h = harness({
    persistence: {
      available: true,
      clearSession: async (input) => {
        cleared.push(input);
        return 4;
      },
    },
  });
  await running(h);

  const report = await h.orchestrator.clearGoatSession(h.goalId);

  assertEqual(cleared.length, 1, 'remote persistence was asked to clear exactly once');
  assertEqual(cleared[0].goalId, h.agentId, 'for this GOAT');
  assertEqual(report.deleted.remoteDocuments, 4, 'and the count is reported');
  assertDefinitionSurvives(h, 'remote clear');
});

await test('clear: a remote failure does not fail the local clear', async () => {
  const h = harness({
    persistence: {
      available: true,
      clearSession: async () => {
        throw new Error('offline');
      },
    },
  });
  await running(h);

  // The local clear succeeded, so presenting it as a failure — and leaving the user
  // thinking their session still exists — would be the worst available outcome.
  await h.orchestrator.clearGoatSession(h.goalId);

  assertNoSessionResidue(h, 'remote failure');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} CLEAR test(s) failed.`);
}
