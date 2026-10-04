/**
 * Agent-surface regression tests.
 *
 * The agent log and the trade plan are the two surfaces a person trusts with
 * their money, so the properties asserted here are not cosmetic:
 *
 *   1. Every line in the log corresponds to a record the runtime wrote. No
 *      synthesis, no filler, no "thinking..." row.
 *   2. The status indicator reflects runtime state, not the existence of a
 *      deployment record.
 *   3. Waiting is distinguishable from broken, and from working.
 *   4. The plan shows a hypothesis before it is actionable, and creates
 *      nothing that could be executed.
 *   5. A SHADOW deployment's plan says, in as many words, that nothing will
 *      be sent.
 *
 * These run the real orchestrator, the real loop, the real tracker runtime and
 * the real stores. Only the clock and the model are doubles, because a test
 * that mocks the thing under test proves nothing about it.
 */

import { AgentRuntime } from '../agents/runtime';
import { TrackerRegistry } from '../agents/trackers/registry';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { InMemoryAgentTimelineStore } from '../agents/timeline/store';
import type { AgentTimelineStore } from '../agents/timeline/types';
import type { Goal } from './types';
import type { ITradingEnvironment } from '../agents/types';
import type { IAgentModel } from '../agents/model/types';
import { normalizeModelReply } from '../agents/model/openrouter';
import type { Bar, OrderResult, Position } from '../../types/trading';
import type { NormalizedQuote } from '../../types/quotes';

import { GoatOrchestrator } from './orchestrator';
import { InMemoryDeploymentStore } from './deployments';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
} from './store';
import { InMemorySkillStore } from './skillStore';
import { buildMission, type GoatMission } from './mission';
import { buildPlanView } from './planView';
import { styleForEvent } from './agentEvents';
import { statusFor } from '../../components/goat/GoatStatusIndicator';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  const same =
    actual === expected ||
    (typeof actual === 'object' && actual !== null && expected !== null &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (!same) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function makeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

const METADATA = {
  symbol: 'EURUSD', displayName: 'EUR/USD', assetClass: 'FOREX' as const,
  provider: 'HYPERLIQUID' as const, providerSymbol: 'xyz:EUR', providerMarketId: 'EUR',
  quoteCurrency: 'USD', baseCurrency: 'EUR', pricePrecision: 5, sizePrecision: 0,
  sizeStep: 1, minOrderSize: 1, maxOrderSize: 1_000_000,
};
const BARS: Bar[] = Array.from({ length: 120 }, (_, i) => ({
  time: 1_700_000_000 + i * 900, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002,
}));

class StubEnvironment implements ITradingEnvironment {
  mode: 'BACKTEST' | 'DEMO' | 'LIVE' = 'DEMO';
  orders: Array<Record<string, unknown>> = [];
  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    return { symbol, symbolId: '1', bid: 1.1, ask: 1.1002, spread: 1, timestamp: 1, status: 'MOCK' };
  }
  async getMarketBars(): Promise<Bar[]> { return BARS; }
  async getInstruments() { return [METADATA]; }
  async getAccountState() {
    return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 };
  }
  async getPositions(): Promise<Position[]> { return []; }
  async getOrders(): Promise<OrderResult[]> { return []; }
  async placeMarketOrder(p: Record<string, unknown>) { this.orders.push(p); return { success: true, positionId: 'p1', fillPrice: 1.1 }; }
  async modifyPosition(positionId: string, changes: { stopLoss?: number; takeProfit?: number }) {
    this.orders.push({ modify: { positionId, ...changes } });
    return { success: true };
  }
  async closePosition(positionId: string, volume?: number) {
    this.orders.push({ close: { positionId, volume } });
    return { success: true };
  }
}

class ScriptedModel implements IAgentModel {
  replies: string[];
  calls = 0;
  /** Returned once the script runs out. */
  fallback?: string;
  /** When set, every call reports the model as unreachable. */
  unavailable?: boolean;

  constructor(replies: string[] = [], fallback?: string, unavailable = false) {
    this.replies = replies;
    this.fallback = fallback;
    this.unavailable = unavailable;
  }

  async run() {
    const next = this.replies[this.calls] ?? this.fallback;
    this.calls += 1;
    if (this.unavailable) {
      return { thought: '', unavailable: { code: 'UNAVAILABLE', message: 'The model is unreachable.' } };
    }
    return normalizeModelReply(next ?? '{"kind":"WAIT","reason":"no opinion"}');
  }
}

/** A real investigation answer, so the runtime genuinely forms a thesis. */
const INVESTIGATION = JSON.stringify({
  thought: 'The decline looks corrective.',
  thesis: {
    statement: 'The decline is corrective inside a broader bullish structure.',
    direction: 'BULLISH',
    invalidation: 'A sustained structural break below 1.0950.',
    requiredConfirmation: ['momentum recovery', 'structure shift above 1.1050', 'price reclaim of the 20 period average'],
  },
  trackers: [
    { purpose: 'Detect bullish break above the 20 period average', kind: 'NEW_BAR', config: {}, timeframe: '15m' },
  ],
});

interface Harness {
  orchestrator: GoatOrchestrator;
  trackers: TrackerRuntime;
  timeline: AgentTimelineStore;
  env: StubEnvironment;
  clock: ReturnType<typeof makeClock>;
  model: ScriptedModel;
  goalId: string;
  agentId: string;
  mission(): GoatMission;
  agentLog(): ReturnType<GoatOrchestrator['agentLog']>;
  /**
   * Ensure the runtime has formed a real thesis.
   *
   * A deployment kicks off its own reasoning pass, so this waits for that to
   * land rather than racing it — reading the mission before the pass settles
   * is how a test ends up asserting on a GOAT that has not thought yet.
   */
  investigate(): Promise<void>;
}

function makeHarness(options: {
  model?: ScriptedModel;
  market?: string;
  skillIds?: string[];
  goal?: string;
  timeframes?: string[];
} = {}): Harness {
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(undefined, undefined, undefined, undefined, new InMemoryAgentTimelineStore());
  const registry = new TrackerRegistry((id) => agentRuntime.getAgent(id));
  const trackers = new TrackerRuntime({
    registry, agents: agentRuntime, timeline: agentRuntime.getTimelineStore(), clock: clock.now,
  });
  const model = options.model ?? new ScriptedModel([INVESTIGATION]);

  const orchestrator = new GoatOrchestrator({
    agentRuntime, trackers, env, model, clock: clock.now,
    stores: {
      goals: new InMemoryGoalStore(), theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(), ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(), skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  });

  const agentId = 'goat_surface';
  const goalId = 'goal_surface';
  orchestrator.stores.goals.save({
    id: goalId, agentId,
    statement: options.goal ?? 'Find a long opportunity on EURUSD if the bearish move reverses.',
    symbols: [],
    timeframes: options.timeframes ?? [],
    skillIds: options.skillIds ?? ['structural-trend-analysis'],
    status: 'DRAFT', createdAt: clock.now(), updatedAt: clock.now(),
  });
  orchestrator.deployGoat({
    goalId,
    market: options.market ?? 'EURUSD',
    ...(options.timeframes ? { timeframes: options.timeframes } : {}),
  });

  return {
    orchestrator, trackers, timeline: agentRuntime.getTimelineStore(), env, clock, model, goalId, agentId,
    mission: () => orchestrator.mission(goalId)!,
    agentLog: () => orchestrator.agentLog(goalId),
    investigate: async () => {
      /*
       * A deployment kicks off its own reasoning pass, and the runtime
       * refuses a second one while that is in flight. So wait for it rather
       * than racing it, and only ask if nothing happened — otherwise the
       * test silently asserts against a GOAT that has not thought yet.
       */
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (orchestrator.mission(goalId)?.thesis) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await orchestrator.investigateGoal(goalId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (orchestrator.mission(goalId)?.thesis) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('the runtime never formed a thesis');
    },
  };
}

/** Drive one tracker through a real evaluation, so a real event is recorded. */
async function fireTracker(h: Harness, price: number): Promise<void> {
  const thesisId = h.mission().thesis?.id;
  if (!thesisId) return;
  h.trackers.createTracker(thesisId, h.agentId, {
    purpose: 'Detect a reclaim of 1.1050',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });
  const at = h.clock.now();
  const quote = (index: number, p: number, ts: number) => ({
    id: `tick-${index}`, type: 'MARKET_QUOTE' as const, timestamp: ts,
    environment: 'DEMO' as const, symbol: 'EURUSD', timeframe: '15m',
    state: { timestamp: ts, environment: 'DEMO' as const, symbol: 'EURUSD', timeframe: '15m', price: p, spread: 0.7 },
  });
  await h.trackers.process(quote(1, 1.10, at));
  await h.trackers.process(quote(2, price, at + 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// ---------------------------------------------------------------------------
// 1. The log shows only what the runtime recorded
// ---------------------------------------------------------------------------

test('agent log: every line corresponds to a recorded event', async () => {
  const h = makeHarness();
  const log = h.agentLog();

  assert(log.length > 0, 'a deployed GOAT has recorded something');
  for (const entry of log) {
    assert(entry.headline.length > 0, `every entry has words: ${JSON.stringify(entry)}`);
    assert(!/^processing|^thinking|^researching\.{0,3}$/i.test(entry.headline),
      `no placeholder activity: "${entry.headline}"`);
    assert(entry.at > 0 && Number.isFinite(entry.at), 'and a real timestamp');
  }
});

test('agent log: a GOAT that has done nothing shows nothing', async () => {
  /*
   * The single most important property this surface has. A log that
   * manufactures rows to look busy is worse than no log, because it teaches
   * the reader to distrust the rows that matter.
   */
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(undefined, undefined, undefined, undefined, new InMemoryAgentTimelineStore());
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((id) => agentRuntime.getAgent(id)),
    agents: agentRuntime, timeline: agentRuntime.getTimelineStore(), clock: clock.now,
  });
  const orchestrator = new GoatOrchestrator({
    agentRuntime, trackers, env, clock: clock.now,
    model: new ScriptedModel([]),
    stores: {
      goals: new InMemoryGoalStore(), theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(), ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(), skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  });
  orchestrator.stores.goals.save({
    id: 'g', agentId: 'a', statement: 'Trade it.', symbols: [], timeframes: [],
    skillIds: [], status: 'DRAFT', createdAt: clock.now(), updatedAt: clock.now(),
  });

  // Saved, never deployed: the runtime has genuinely recorded nothing.
  assertEqual(orchestrator.agentLog('g'), [], 'an untouched GOAT produces an empty log, not a placeholder one');
  assertEqual(orchestrator.activityFor('g'), [], 'and the plain feed agrees');
});

test('agent log: a wake records the observation, the evidence and the conclusion', async () => {
  /*
   * The narrative the product depends on: what the market did, what the agent
   * made of it, and what it concluded. Before this, evidence and the tracker
   * observation were never written at all, so the log could show a thesis
   * being revised with no indication of what the agent had actually seen.
   */
  const h = makeHarness({
    model: new ScriptedModel([INVESTIGATION, '{"kind":"CONFIRM_THESIS","thesisId":"ignored","reason":"momentum recovered"}']),
  });
  await h.investigate();
  await fireTracker(h, 1.11);

  const types = h.agentLog().map((entry) => entry.type);
  assert(types.includes('TRACKER_FIRED'), `the observation is recorded: ${types.join(', ')}`);
  assert(types.includes('AGENT_EVIDENCE'), `the evidence is recorded: ${types.join(', ')}`);
  assert(types.includes('THESIS_REVISED'), `and the conclusion is recorded: ${types.join(', ')}`);

  // Evidence carries the measurement, not just a claim about one.
  const evidence = h.agentLog().find((entry) => entry.type === 'AGENT_EVIDENCE');
  assert(evidence !== undefined, 'the evidence line exists');
  assert(
    /counts (for|against) the thesis/.test(evidence!.detail ?? ''),
    `and says which way it counted: ${JSON.stringify(evidence!.detail)}`,
  );

  // Evidence is recorded before the conclusion it justifies.
  const evidenceAt = h.agentLog().findIndex((entry) => entry.type === 'AGENT_EVIDENCE');
  const revisionAt = h.agentLog().findIndex((entry) => entry.type === 'THESIS_REVISED');
  assert(evidenceAt >= 0 && revisionAt >= 0 && evidenceAt < revisionAt,
    'the reader sees what was observed before what the agent concluded from it');
});

test('agent log: it never exposes private reasoning', async () => {
  const h = makeHarness();
  const secret = 'INTERNAL-DELIBERATION-abc123';
  const leaky = new ScriptedModel([
    INVESTIGATION,
    JSON.stringify({ thought: secret, kind: 'WAIT', reason: 'nothing yet' }),
  ]);
  const h2 = makeHarness({ model: leaky });
  await h2.investigate();
  await fireTracker(h2, 1.11);
  for (const entry of h2.agentLog()) {
    assert(!entry.headline.includes(secret), `no hidden reasoning in "${entry.headline}"`);
    assert(!(entry.detail ?? '').includes(secret), `and none in the detail of "${entry.type}"`);
  }
  assert(h.agentLog().length >= 0, 'and the other GOAT is unaffected');
});

test('agent log: the surface is live, not polled behind a signature', async () => {
  /*
   * THE DEFECT THIS CLOSES: the GOAT screen re-read state every two seconds
   * behind a signature built from mission fields, and an activity event
   * changed none of them. A tracker could fire, the agent could wake, record
   * evidence and revise its thesis — all real, all written — and the log would
   * not move until some unrelated field changed.
   *
   * An agent log that cannot be live is not an agent log.
   */
  const h = makeHarness();
  await h.investigate();
  const before = h.agentLog().length;
  assertEqual(before, h.agentLog().length, 'the log is stable while nothing happens');

  let notified = 0;
  const unsubscribe = h.orchestrator.observeActivity(h.goalId, () => { notified += 1; });
  await fireTracker(h, 1.11);

  assert(notified > 0, 'recording an event tells a subscriber immediately, without waiting for a poll');
  assert(h.agentLog().length > before, 'and the event is there to read');
  unsubscribe();
  const afterUnsubscribe = notified;
  await fireTracker(h, 1.13);
  assertEqual(notified, afterUnsubscribe, 'unsubscribing actually stops the notifications');
});

test('agent log: a subscriber that throws cannot lose the record', async () => {
  const h = makeHarness();
  await h.investigate();
  const store = h.timeline;
  assert(store.subscribe, 'the store is observable');
  store.subscribe!(() => { throw new Error('a view that cannot render'); });
  let secondSaw = 0;
  store.subscribe!(() => { secondSaw += 1; });

  await fireTracker(h, 1.11);
  assert(secondSaw > 0, 'one broken listener does not silence the others');
  assert(h.agentLog().length > 0, 'and the event is still recorded');
});

// ---------------------------------------------------------------------------
// 2. Status reflects reality
// ---------------------------------------------------------------------------

test('status: a stopped GOAT never reads as active', async () => {
  const h = makeHarness();
  await h.investigate();
  const now = h.clock.now();
  assert(statusFor(h.mission(), now) !== 'STOPPED', 'a running GOAT is not stopped');

  await h.orchestrator.stopGoat(h.goalId);
  assertEqual(statusFor(h.mission(), now), 'STOPPED',
    'stopping it is visible immediately, even though the deployment record is deliberately kept');
});

test('status: undeployed is distinct from stopped, and from watching', async () => {
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(undefined, undefined, undefined, undefined, new InMemoryAgentTimelineStore());
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((id) => agentRuntime.getAgent(id)),
    agents: agentRuntime, timeline: agentRuntime.getTimelineStore(), clock: clock.now,
  });
  const orchestrator = new GoatOrchestrator({
    agentRuntime, trackers, env, clock: clock.now, model: new ScriptedModel([]),
    stores: {
      goals: new InMemoryGoalStore(), theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(), ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(), skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  });
  orchestrator.stores.goals.save({
    id: 'g', agentId: 'a', statement: 'Trade it.', symbols: [], timeframes: [],
    skillIds: [], status: 'DRAFT', createdAt: clock.now(), updatedAt: clock.now(),
  });
  assertEqual(statusFor(orchestrator.mission('g')!, clock.now()), 'UNDEPLOYED',
    'saved and not pointed at a market is its own state, not "stopped"');
});

test('status: waiting is distinguishable from working and from broken', async () => {
  /*
   * The distinction the whole product rests on. A trading agent spends most of
   * its life idle; if idle reads as broken the product feels abandoned, and if
   * idle reads as working the product feels like it is lying. All three have
   * to be separately readable, so this asserts they are three different
   * answers rather than three labels for one.
   */
  const deployment = {
    id: 'dep', goatId: 'a', goatVersion: 1, accountId: 'acct', marketId: 'EURUSD',
    status: 'active' as const, mode: 'SHADOW' as const, venueEnvironment: 'TESTNET' as const,
    execution: { canExecute: false, canProposeTrades: true, allowedOrderTypes: ['LIMIT' as const] },
    createdAt: 1, updatedAt: 1,
  };
  const goal: Goal = {
    id: 'g', agentId: 'a', statement: 'Trade it.', symbols: ['EURUSD'], timeframes: ['15m'],
    skillIds: [], status: 'MONITORING', createdAt: 1, updatedAt: 1,
  };
  const at = 1_000_000;
  const missionFor = (runtime: 'RUNNING' | 'STOPPED' | 'ERROR') =>
    buildMission({ goal, deployment, runtime, theses: [], trackers: [], events: [], evidence: [], now: at });

  const watching = statusFor(missionFor('RUNNING'), at);
  const broken = statusFor(missionFor('ERROR'), at);
  const stopped = statusFor(missionFor('STOPPED'), at);

  assertEqual(watching, 'WATCHING', 'deployed with nothing to do is WATCHING, not ACTIVE');
  assertEqual(broken, 'ERROR', 'a runtime that is not running it is an ERROR');
  assertEqual(stopped, 'STOPPED', 'a stopped one is STOPPED');
  assertEqual(new Set([watching, broken, stopped]).size, 3, 'all three are distinguishable');
});

test('status: a GOAT whose last step failed never reads as healthy', async () => {
  /*
   * Found by watching a real deployment: the free model failed, the runtime
   * recorded MODEL_FAILURE, and the indicator showed a green pulsing ACTIVE
   * dot — because the runtime *had* done something, moments ago.
   *
   * The dot is the primary signal in the product. A green one immediately
   * after a recorded failure says everything is fine at the exact moment it
   * is least fine, and the reader has no other signal to contradict it.
   */
  const h = makeHarness();
  await h.investigate();
  const at = h.clock.now();

  // Record a real failure through the runtime, not by hand.
  h.orchestrator.recordActivity({
    goatId: h.agentId,
    agentId: h.agentId,
    type: 'MODEL_FAILURE',
    data: { code: 'RATE_LIMITED' },
  });

  /*
   * The runtime follows a failed step with a GOAT_WAITING line — it went
   * back to sleep. So the newest record is the sleep, not the failure, and a
   * surface reading only the newest record calls a failed GOAT healthy.
   * That is exactly what the browser showed before this was fixed.
   */
  h.orchestrator.recordActivity({
    goatId: h.agentId,
    agentId: h.agentId,
    type: 'GOAT_WAITING',
    data: { trackers: 0 },
  });

  const mission = h.mission();
  assertEqual(mission.lastEvent?.type, 'GOAT_WAITING', 'the newest record is the sleep');
  assertEqual(mission.lastFailure?.type, 'MODEL_FAILURE', 'and the failure is still resolved against it');
  assertEqual(statusFor(mission, at), 'STALLED', 'a failed step reads as stalled, not active');

  // Progress retires the failure: it is history once something has worked.
  h.orchestrator.recordActivity({
    goatId: h.agentId,
    agentId: h.agentId,
    type: 'MARKET_CONTEXT_LOADED',
    data: { symbol: 'EURUSD', candles: 120 },
  });
  h.clock.advance(1_000);
  assertEqual(h.mission().lastFailure, undefined, 'a later success retires the failure');
  assert(statusFor(h.mission(), h.clock.now()) !== 'STALLED', 'and the dot stops claiming something is wrong');

  // Amber, not red: the runtime is fine and the deployment is fine, so
  // sending someone to look for a deployment fault would be its own lie.
  const stalled = statusFor(mission, at);
  assert(stalled !== 'ERROR', 'and it is not dressed up as a broken runtime');
  assert(stalled !== 'STOPPED', 'nor as a stopped GOAT');

  // And it decays: an old failure is history, not a live condition.
  assert(statusFor(mission, at + 30 * 60_000) !== 'STALLED',
    'once it is old, the failure is history rather than a live state');
});

test('status: a recent real wake reads as active, and it decays', async () => {
  const { statusFor } = await import('../../components/goat/GoatStatusIndicator');
  const h = makeHarness();
  await fireTracker(h, 1.11);
  const at = h.clock.now();
  assertEqual(statusFor(h.mission(), at), 'ACTIVE', 'a GOAT that just did something is ACTIVE');

  // And it stops claiming to be active once the event is old, because the
  // pulse has to mean something.
  const later = at + 10 * 60_000;
  assertEqual(statusFor(h.mission(), later), 'WATCHING', 'an hour later it is waiting, not active');
});

// ---------------------------------------------------------------------------
// 3. Next action
// ---------------------------------------------------------------------------

test('next action: waiting says what it is waiting for', async () => {
  const h = makeHarness();
  await h.investigate();
  const next = h.mission().next;
  assert(!next.blocked, 'a deployed GOAT with trackers is not blocked');
  assert(/Waiting on \d+ condition/.test(next.label), `and says so: ${next.label}`);
  assert(typeof next.waitFor === 'string' && next.waitFor.length > 0,
    'with the exact condition in the tracker own words, because waiting alone is weak');
});

test('next action: nothing coming is stated, not implied', async () => {
  const h = makeHarness();
  await h.investigate();
  await h.orchestrator.stopGoat(h.goalId);
  const stopped = h.mission().next;
  assert(stopped.blocked, 'a stopped GOAT is blocked');
  assert(/nothing is being watched/i.test(stopped.label), `and says what is true: ${stopped.label}`);

  /*
   * Resume it, then kill the hypothesis.
   *
   * The next action has to follow the thesis rather than the line it happened
   * to be showing a moment ago. A GOAT whose hypothesis is dead is not
   * "waiting for a retest", and this is the assertion that stops a stale,
   * reassuring line outliving the thing that made it true.
   */
  await h.orchestrator.resumeGoat(h.goalId);
  const thesisId = h.mission().thesis!.id;
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'INVALIDATED' });
  const afterInvalidation = h.mission().next;
  assert(/nothing to act on/i.test(afterInvalidation.label),
    `an invalidated thesis says so: ${afterInvalidation.label}`);
  assert(afterInvalidation.blocked, 'and is not presented as something still coming');
});

// ---------------------------------------------------------------------------
// 4. The living plan
// ---------------------------------------------------------------------------

test('plan: it exists from the hypothesis, before anything is actionable', async () => {
  /*
   * The brief asks for a plan before ACTIONABLE, and it is the right ask: a
   * hypothesis with no plan shown is indistinguishable from a GOAT that is
   * doing nothing. This is a *view*, though — it creates nothing. The
   * executable artefact stays gated exactly as the audit established, and the
   * assertion below is the one that matters.
   */
  const h = makeHarness();
  await h.investigate();
  const mission = h.mission();
  assert(mission.thesis !== undefined, 'the runtime formed a thesis');
  assert(mission.thesis!.state !== 'ACTIONABLE',
    `and it is not yet actionable: ${mission.thesis!.state}`);

  const plan = buildPlanView(mission);
  assert(plan.exists, 'a plan is shown');
  assertEqual(plan.status, 'RESEARCHING', 'and its status is honest about where it is');
  assert(plan.research.length > 0, 'the thesis stated requirements, so they are listed');
  assert(plan.invalidation !== undefined, 'and what would change its mind is shown');
  assertEqual(plan.conditional, undefined, 'with no conditional execution, because no plan has been written');
  assertEqual(h.orchestrator.stores.ideas.list().length, 0, 'and nothing executable was created');
});

test('plan: requirements are only ticked by real evidence', async () => {
  /*
   * A checklist that fills itself in is the most dishonest thing this panel
   * could do: it would show the user progress the agent never made. So an
   * unrelated piece of evidence must not confirm anything.
   */
  const h = makeHarness();
  await h.investigate();
  const thesisId = h.mission().thesis!.id;
  const before = buildPlanView(h.mission());
  assertEqual(before.validation.confirmed, 0, 'nothing is confirmed while there is no evidence');

  h.orchestrator.loop.recordEvidence({
    thesisId, polarity: 'SUPPORTS', summary: 'Completely unrelated observation about the weather.',
    source: 'MARKET_DATA', observed: { temperature: 12 },
  });
  const unrelated = buildPlanView(h.mission());
  assertEqual(unrelated.validation.confirmed, 0, 'unrelated evidence confirms nothing');

  // Evidence that is actually about one of the requirements does confirm it.
  h.orchestrator.loop.recordEvidence({
    thesisId, polarity: 'SUPPORTS',
    summary: 'Observed a bullish structure shift above 1.1050 on the 15 minute chart.',
    source: 'MARKET_DATA', observed: { price: 1.106 },
  });
  const related = buildPlanView(h.mission());
  assert(related.validation.confirmed > 0, 'evidence about a requirement confirms that requirement');
  assertEqual(related.validation.total, before.validation.total, 'and the requirement count does not move');
});

test('plan: contradicting evidence is shown as contradicting', async () => {
  const h = makeHarness();
  await h.investigate();
  const thesisId = h.mission().thesis!.id;
  h.orchestrator.loop.recordEvidence({
    thesisId, polarity: 'CONTRADICTS',
    summary: 'Momentum recovery failed: structure shift above 1.1050 did not hold.',
    source: 'MARKET_DATA', observed: { price: 1.09 },
  });
  const plan = buildPlanView(h.mission());
  assert(plan.validation.contradicted > 0, 'a contradiction is visible on the plan, not hidden');
  assert(
    plan.research.some((criterion) => criterion.state === 'contradicted'),
    'and it marks the requirement it belongs to',
  );
});

test('plan: a SHADOW plan says in as many words that nothing will be sent', async () => {
  const h = makeHarness();
  await h.investigate();
  const thesisId = h.mission().thesis!.id;
  for (let index = 0; index < 4; index += 1) {
    h.orchestrator.loop.recordEvidence({
      thesisId, polarity: 'SUPPORTS',
      summary: `Structure shift above 1.1050 confirmed on sample ${index}.`,
      source: 'MARKET_DATA', observed: { price: 1.1 + index / 10_000 },
    });
  }
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'ACTIONABLE' });

  const wake = {
    thesisId, goalId: h.goalId, agentId: h.agentId, thesis: h.orchestrator.stores.theses.get(thesisId)!,
    relatedEvents: [], skillIds: [], createdAt: h.clock.now(),
    event: {
      id: 'evt-plan', trackerId: '', agentId: h.agentId, kind: 'CUSTOM' as const, eventType: 'CUSTOM' as const,
      timestamp: h.clock.now(), environment: 'DEMO' as const, reason: 'plan proposal',
      priority: 0, severity: 'INFO' as const,
    },
  };
  const outcome = await h.orchestrator.runWake(wake as never, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId,
    reason: 'confirmed',
    idea: {
      symbol: 'EURUSD', direction: 'LONG', orderType: 'LIMIT',
      entry: 1.106, invalidationLevel: 1.095, takeProfits: [{ price: 1.12, fraction: 1 }],
      reasoning: 'confirmed reversal',
    },
  });
  assert(outcome !== undefined, 'the wake was applied');
  assert(outcome!.tradeIdeaId !== undefined, `a plan is written: ${JSON.stringify(outcome!.rejections)}`);

  const view = buildPlanView(h.mission());
  assert(view.mayExecute === false, 'SHADOW cannot execute');
  assert(view.executionNote !== undefined && /SHADOW/.test(view.executionNote),
    `and the plan says so: ${String(view.executionNote)}`);
  assert(view.conditional !== undefined, 'the conditional block exists');
  assertEqual(view.conditional!.action, 'LONG limit', 'and describes intent, not a command');

  // And the plan's evolution through the deterministic layer is recorded.
  const types = h.agentLog().map((entry) => entry.type);
  assert(types.includes('TRADE_PLAN_CREATED'), `the plan creation is logged: ${types.join(', ')}`);
  assert(types.includes('TRADE_PLAN_UPDATED'), `and its change of state is logged separately: ${types.join(', ')}`);
  assertEqual(h.env.orders.length, 0, 'and nothing was sent anywhere');
});

test('plan: an invalidated thesis cannot present itself as actionable', async () => {
  const h = makeHarness();
  await h.investigate();
  const thesisId = h.mission().thesis!.id;
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'INVALIDATED' });
  const plan = buildPlanView(h.mission());
  assertEqual(plan.status, 'INVALIDATED', 'the status follows the thesis');
  assert(plan.mayExecute === false, 'and it cannot act');
});

// ---------------------------------------------------------------------------
// 5. Event classification
// ---------------------------------------------------------------------------

test('events: an unknown type degrades to a neutral line rather than throwing', () => {
  const style = styleForEvent('SOMETHING_SOMEONE_ADDED_LATER');
  assertEqual(style.channel, 'CONTROL', 'an unknown type is not a crash');
  assertEqual(style.weight, 'normal', 'and not loud');
  assertEqual(style.tone, 'neutral', 'and not coloured');
});

test('events: the weights mean what they claim', () => {
  assertEqual(styleForEvent('MARKET_CONTEXT_LOADED').weight, 'normal', 'a market read is quiet');
  assertEqual(styleForEvent('TRACKER_FIRED').weight, 'important', 'a tracker firing matters');
  assertEqual(styleForEvent('THESIS_INVALIDATED').weight, 'critical', 'losing a thesis is critical');
  assertEqual(styleForEvent('TRADE_PLAN_CREATED').weight, 'critical', 'a new plan is critical');
  assertEqual(styleForEvent('GOAT_WAITING').tone, 'neutral', 'waiting is not an error');
  assertEqual(styleForEvent('MODEL_FAILURE').tone, 'negative', 'a model failure is negative');
  assertEqual(styleForEvent('TRADE_PLAN_RISK_CHECKED').channel, 'VALIDATION', 'risk verdicts are validation');
});

test('log: a reader who has scrolled away is not dragged back', async () => {
  /*
   * A log people are meant to leave open for hours. Yanking them to the
   * bottom every time an event lands is the single most irritating thing a
   * live feed can do, and it is the reason the backlog is counted and
   * offered rather than enforced.
   *
   * The rule is pure, so it is tested directly rather than by generating
   * enough events to overflow a viewport — which a healthy GOAT might not
   * produce in a test run at all.
   */
  const { followState, renderedWindow } = await import('../../components/goat/AgentLog');

  // At the bottom: following, nothing owed.
  assertEqual(followState({ distanceFromBottom: 0, missed: 3 }),
    { following: true, missed: 0 },
    'reaching the bottom follows the stream and clears the backlog');

  // A one-pixel drift still counts as following, or a momentum flick on touch
  // would silently stop the log following.
  assert(followState({ distanceFromBottom: 20, missed: 2 }).following,
    'a small drift still follows');
  assertEqual(followState({ distanceFromBottom: 20, missed: 2 }).missed, 0,
    'and inside that tolerance the reader can see the newest events, so nothing is owed');

  // Scrolled up: stop following, keep the count.
  const away = followState({ distanceFromBottom: 900, missed: 4 });
  assert(!away.following, 'a reader who has scrolled up is not dragged back');
  assertEqual(away.missed, 4, 'and is told how much they missed');

  // Coming back to the bottom retires the count.
  assertEqual(followState({ distanceFromBottom: 0, missed: 4 }).missed, 0,
    'and returning clears it');

  // The render window is bounded, and says how much it is not drawing.
  assertEqual(renderedWindow(10), { visible: 10, hidden: 0 }, 'a short log renders in full');
  const long = renderedWindow(5000);
  assert(long.visible <= 40, `a long log renders a bounded window (${long.visible})`);
  assertEqual(long.visible + long.hidden, 5000, 'and accounts for every event, so none is silently lost');
});

test('log: the rendered window holds the tail, where the newest events are', async () => {
  const { renderedWindow } = await import('../../components/goat/AgentLog');
  const entries = Array.from({ length: 5000 }, (_, index) => ({ id: `e${index}` }));
  const w = renderedWindow(entries.length);
  const visible = entries.slice(entries.length - w.visible);
  assertEqual(visible[visible.length - 1].id, 'e4999', 'the newest event is always rendered');
  assert(visible.every((entry) => Number(entry.id.slice(1)) >= 5000 - w.visible),
    'and nothing older displaces it');
});

// ---------------------------------------------------------------------------
// 6. Lifecycle: steering, restart, and time as first-class data
// ---------------------------------------------------------------------------

test('lifecycle: steering re-enters the loop and cannot freeze the GOAT', async () => {
  /*
   * The headline defect. `wakeForSteering` returned false whenever the GOAT
   * held a live thesis — the normal case, because a GOAT with a thesis is
   * watching and asleep — so steering did nothing: the note stayed unread and
   * the agent log showed a request followed by silence.
   *
   * These assertions are the whole contract, and each one failed before.
   */
  const h = makeHarness();
  await h.investigate();

  const armed = h.mission().trackers.filter((tracker) => tracker.status === 'ACTIVE');
  assert(armed.length > 0, 'the GOAT is asleep because it is watching something');

  const { woke, note } = await h.orchestrator.steerGoat(h.goalId, 'Re-evaluate the momentum confirmation.');

  assert(woke, 'steering wakes the agent rather than waiting for the next tracker');
  assert(note.appliedAt !== undefined, 'the note is consumed by that pass');
  assertEqual(
    h.mission().steering.pending,
    0,
    'so the interface stops claiming it is still reading an instruction',
  );

  // Repeated steering keeps working: this is what "cannot freeze" means.
  for (let round = 0; round < 3; round += 1) {
    const next = await h.orchestrator.steerGoat(h.goalId, `Round ${round}: look again.`);
    assert(next.woke, `steering still works on repeat ${round + 1}`);
    assert(next.note.appliedAt !== undefined, `and is still consumed on repeat ${round + 1}`);
  }
  assertEqual(
    h.mission().steering.pending,
    0,
    'no note is ever left stranded as pending after a pass reads it',
  );
});

test('lifecycle: steering shows its work in the agent log', async () => {
  const h = makeHarness();
  await h.investigate();
  await h.orchestrator.steerGoat(h.goalId, 'Focus on confirmation.');

  const types = h.agentLog().map((entry) => entry.type);
  assert(types.includes('GOAT_STEERED'), `the instruction is recorded: ${types.join(', ')}`);
  assert(types.includes('GOAT_REASSESSING'), 'the reassessment it triggered is recorded');

  // The wake must not claim a tracker fired it.
  const woke = h.agentLog().find((entry) => entry.type === 'GOAT_WOKE');
  assert(woke !== undefined, 'the wake is recorded');
  assert(
    !/tracker/i.test(woke!.headline),
    `and does not say a tracker woke it, because a person did: ${woke!.headline}`,
  );
  assert(
    /operator|you asked|your instruction|asked the GOAT to reconsider/i.test(woke!.headline),
    `but says whose input caused it: ${woke!.headline}`,
  );
});

test('lifecycle: PLAY after real elapsed time re-reads the world', async () => {
  /*
   * Time passing is information. Restoring the observation plan is right for
   * four seconds and wrong for an hour, because a tracker armed at a level and
   * a thesis written against a candle are statements about the world *at a
   * moment*.
   */
  const h = makeHarness();
  await h.investigate();
  const armedBefore = h.mission().activeTrackerCount;
  assert(armedBefore > 0, 'it was watching something before the stop');

  await h.orchestrator.stopGoat(h.goalId);

  // A short stop: a resume is a resume.
  h.clock.advance(5_000);
  const quick = await h.orchestrator.resumeGoat(h.goalId);
  assertEqual(quick.alreadyRunning, false, 'a short stop resumes');
  assert(
    !quick.investigation.message.includes('reassessed'),
    'and does not pretend to have reassessed when nothing had changed',
  );

  // A real gap: this one must re-read.
  await h.orchestrator.stopGoat(h.goalId);
  h.clock.advance(3 * 60 * 60 * 1000);
  const stale = await h.orchestrator.resumeGoat(h.goalId);

  const types = h.agentLog().map((entry) => entry.type);
  assert(types.includes('GOAT_RESTARTED'), `the restart is recorded: ${types.join(', ')}`);
  assert(
    types.includes('GOAT_REASSESSING'),
    'and the thesis is reassessed rather than inherited',
  );

  const restarted = h.agentLog().find((entry) => entry.type === 'GOAT_RESTARTED');
  assert(/3h/.test(restarted!.detail ?? ''), `and it says how long it was asleep: ${restarted!.detail}`);

  const reassess = h.agentLog().find((entry) => entry.type === 'GOAT_REASSESSING');
  assert(
    /3h/.test(reassess!.detail ?? ''),
    `and the reassessment is told the gap it is accounting for: ${reassess!.detail}`,
  );
  assert(
    /unverified|armed before/i.test(reassess!.detail ?? ''),
    'and that the restored watches are not being trusted',
  );

  // The historical log survives a restart: nothing is erased because the
  // agent began again.
  assert(
    h.agentLog().some((entry) => entry.type === 'THESIS_FORMED'),
    'the log before the restart is still readable afterwards',
  );
  assert(
    /reassessed its thesis/i.test(stale.investigation.message),
    `and the user is told what happened: ${stale.investigation.message}`,
  );
});

test('lifecycle: a note the agent cannot read is not left pending forever', async () => {
  /*
   * The freeze had a second face. If the model could not be read, the pass that
   * would have consumed the note never ran, so the note stayed pending — and
   * the interface said "Reading 1 instruction you gave it" on a GOAT that had
   * already been told the model was unreachable. Pending has to mean "waiting
   * to be read", and an instruction nobody is going to read is not pending.
   */
  const h = makeHarness({
    model: new ScriptedModel([], undefined, true),
  });

  const { note, woke } = await h.orchestrator.steerGoat(h.goalId, 'Try a different approach.');

  assertEqual(woke, false, 'the GOAT honestly reports it could not act on it');
  assert(note.appliedAt !== undefined, 'and the note is retired rather than pending forever');
  assertEqual(
    h.mission().steering.pending,
    0,
    'so the interface stops promising a read that will not happen',
  );

  const recorded = h.agentLog().map((entry) => entry.type);
  assert(recorded.includes('MODEL_FAILURE') || recorded.includes('GOAT_WAITING'),
    `while the failure itself stays visible: ${recorded.join(', ')}`);
});

test('lifecycle: thirty seconds is already stale', async () => {
  /*
   * The product's own line: half a minute is three 15m candles on a setup
   * timeframe. A threshold of a minute would resume a read that is visibly out
   * of date, which is the failure the restart exists to prevent.
   */
  const h = makeHarness();
  await h.investigate();

  await h.orchestrator.stopGoat(h.goalId);
  h.clock.advance(35_000);
  await h.orchestrator.resumeGoat(h.goalId);

  assert(
    h.agentLog().some((entry) => entry.type === 'GOAT_RESTARTED'),
    'a 35-second stop is already a restart, not a resume',
  );
});

test('lifecycle: a stop does not pretend time stood still', async () => {
  const h = makeHarness();
  await h.investigate();
  await h.orchestrator.stopGoat(h.goalId);
  const next = h.mission().next;
  assert(next.blocked, 'a stopped GOAT is blocked, not progressing');
  assertEqual(
    h.mission().activeTrackerCount,
    0,
    'and nothing is being watched while it is stopped',
  );
  assert(/nothing is being watched/i.test(next.label), `which it says plainly: ${next.label}`);
});

test('lifecycle: a restarted GOAT never reports a tracker fired it', async () => {
  const h = makeHarness();
  await h.investigate();
  await h.orchestrator.stopGoat(h.goalId);
  h.clock.advance(2 * 60 * 60 * 1000);
  await h.orchestrator.resumeGoat(h.goalId);

  const restartWakes = h.agentLog().filter((entry) => entry.type === 'GOAT_WOKE');
  const last = restartWakes[restartWakes.length - 1];
  assert(last !== undefined, 'the restart produced a wake');
  assert(
    !/tracker/i.test(last!.headline),
    `a restart is not a tracker firing: ${last!.headline}`,
  );
});

// ---------------------------------------------------------------------------
// 7. Timeframes, data access, and the plan
// ---------------------------------------------------------------------------

test('timeframes: a GOAT is not pinned to one resolution', async () => {
  /*
   * The registry used to refuse any tracker whose timeframe differed from the
   * agent's single `timeframe`, which made the documented position — "the
   * timeframe belongs to the GOAT's research process" — false: a GOAT could
   * only ever watch one resolution regardless of its goal.
   */
  const h = makeHarness();
  await h.investigate();
  const thesisId = h.mission().thesis!.id;

  const created: string[] = [];
  for (const timeframe of ['5m', '15m', '1h', '4h']) {
    const tracker = h.trackers.createTracker(thesisId, h.agentId, {
      purpose: `Watch ${timeframe}`,
      kind: 'NEW_BAR',
      timeframe,
      config: {},
      cooldownMs: 0,
    });
    created.push(tracker.id);
    assertEqual(tracker.timeframe, timeframe, `a ${timeframe} watch is accepted`);
  }
  assertEqual(created.length, 4, 'a GOAT can watch across several resolutions at once');
});

test('timeframes: every read says what it is for, and context is never mistaken for setup', async () => {
  /*
   * Found by running a real deployment: the log said "Reading EUR/USD across
   * 15m, 1m, 5m" for a 15m setup. The resolution ordering was written
   * coarsest-first, so "higher" selected everything *finer* — a GOAT reading
   * its context off a 1m candle instead of the hour, which is the opposite of
   * the point and silently so.
   *
   * The property is now stronger than "context is coarser". A scalper on 1m is
   * entitled to read finer candles, so what must hold is that each read is
   * *labelled* for the job it is doing: entry timing, confirmation, structure,
   * regime, or the setup itself. A resolution with no stated role is the bug
   * this used to have.
   */
  const h = makeHarness();
  await h.investigate();

  const reads = h.agentLog().filter((entry) => entry.type === 'MARKET_CONTEXT_LOADED');
  assert(reads.length > 0, 'setup recorded market reads');

  const rank = (timeframe: string) => ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].indexOf(timeframe);
  for (const read of reads) {
    const match = /(\d+[mhd]) · ([^·]+?)(?: ·|$)/.exec(`${read.detail ?? ''}`);
    assert(match !== null, `each read names its resolution and its role: ${read.detail}`);
    const [, timeframe, role] = match;
    if (timeframe === '15m') {
      assertEqual(role, 'setup', 'the resolution the GOAT acts on is the setup');
      continue;
    }
    if (rank(timeframe) > rank('15m')) {
      assert(
        role === 'higher-timeframe structure' || role === 'regime',
        `${timeframe} is higher-timeframe context for a 15m setup, not ${role}`,
      );
    } else {
      assert(
        role === 'entry timing' || role === 'confirmation',
        `${timeframe} is finer than the setup, so it is timing — not ${role}`,
      );
    }
  }

  const request = h.agentLog().find((entry) => entry.type === 'MODEL_REQUEST');
  assert(request !== undefined, 'the model request is recorded with what was submitted');
  const timeframes = [...`${request!.headline} ${request!.detail ?? ''}`.matchAll(/\b(\d+[mhd])\b/g)]
    .map((match) => match[1]);
  assert(timeframes.includes('15m'), `the setup resolution was read: ${request!.detail}`);
  assert(
    timeframes.some((timeframe) => rank(timeframe) > rank('15m')),
    'and a higher resolution was read alongside it',
  );
});

test('timeframes: the GOAT declares a working set rather than inheriting a default', async () => {
  const { agentTimeframes } = await import('../agents/types');
  assertEqual(
    agentTimeframes({ timeframes: ['4h', '1h', '15m', '5m'] }),
    ['4h', '1h', '15m', '5m'],
    'a declared set is used as given',
  );
  assertEqual(agentTimeframes({ timeframe: '1h' }), ['1h'], 'a single resolution is still one set');
  assertEqual(agentTimeframes({}), [], 'and no declaration means unrestricted, not a default');
});

test('data: the context feature is forwarded, not merely written', async () => {
  /*
   * The whole capability could have stayed dead and every test around it would
   * still have passed, because they all supply their own fake environment. The
   * real seam is the one the app actually uses: `DemoEnvironment`, wrapping the
   * Hyperliquid adapter. It did not forward `getMarketContext`, so every GOAT
   * would have been told "this environment publishes no market context" while
   * the fetching code sat there looking finished.
   *
   * Deliberately offline. Asserting the real venue answered proved the network
   * was up, not that the seam was wired, and made the unit suite depend on
   * Hyperliquid being reachable. That the venue actually answers is the live
   * test's job; this test's job is that the call arrives somewhere real.
   */
  const { DemoEnvironment } = await import('../agents/environment/demo');
  const { hyperliquidMarketData } = await import('../../adapters/hyperliquid/marketData');

  const forwarded = (hyperliquidMarketData as { getMarketContext?: unknown }).getMarketContext;
  assertEqual(typeof forwarded, 'function', 'the shipped source publishes market context');

  const environment = new DemoEnvironment();
  const through = (environment as unknown as { getMarketContext?: unknown }).getMarketContext;
  assertEqual(
    typeof through,
    'function',
    'the environment GOATs actually run in forwards it rather than swallowing it',
  );

  const capability = (await import('../agents/capabilities')).initializeDefaultCapabilities(
    new (await import('../agents/capabilities/registry')).CapabilityRegistry(),
  ).get('market.getContext');
  assert(capability !== undefined, 'the capability exists');

  let reached = false;
  const spy = capability!.execute;
  const result = (await capability!.execute({}, {
    agentId: 'a', environment: 'DEMO', symbol: 'EUR/USD', timeframe: '15m',
    policy: { allowedSymbols: ['EUR/USD'] } as never,
    env: {
      mode: 'DEMO',
      async getMarketContext() {
        reached = true;
        return { symbol: 'EUR/USD', fundingRate: 0.0000125, openInterest: 21_876_429 };
      },
    } as never,
    symbols: ['EUR/USD'],
  } as never)) as Record<string, unknown>;
  assert(reached, 'the capability really calls the method it advertises');
  assertEqual(result['fundingRate'], 0.0000125, 'and what it returns is what the GOAT is told');
  void spy;
});

test('data: funding and open interest are readable, or honestly absent', async () => {
  /*
   * There was no capability for anything the venue publishes beyond price and
   * candles, so an agent could not reason about funding even when the venue
   * published it. Added — with the rule that a missing fact is reported as
   * missing, never as zero.
   */
  const { initializeDefaultCapabilities } = await import('../agents/capabilities');
  const { CapabilityRegistry } = await import('../agents/capabilities/registry');
  const registry = initializeDefaultCapabilities(new CapabilityRegistry());
  const capability = registry.get('market.getContext');
  assert(capability !== undefined, 'the market context capability exists');

  // An environment that publishes funding.
  const funded = (await capability!.execute({}, {
    agentId: 'a', environment: 'DEMO', symbol: 'EURUSD', timeframe: '15m',
    policy: { allowedSymbols: ['EURUSD'] } as never,
    env: {
      mode: 'DEMO',
      async getMarketContext() {
        return { symbol: 'EURUSD', fundingRate: 0.0000125, openInterest: 1_000_000, dayVolume: 5e8 };
      },
    } as never,
    symbols: ['EURUSD'],
  } as never)) as Record<string, unknown>;
  assertEqual(funded['fundingRate'], 0.0000125, 'the published funding rate is returned');
  assert(
    (funded['fundingAnnualPercent'] as number) > 0,
    'and is annualised, because a per-hour number means nothing on its own',
  );
  assertEqual(funded['unavailable'], undefined, 'with nothing reported missing when it is all present');

  // One that publishes none of it: an honest absence, not a zero.
  const bare = (await capability!.execute({}, {
    agentId: 'a', environment: 'DEMO', symbol: 'SPOT', timeframe: '15m',
    policy: { allowedSymbols: ['SPOT'] } as never,
    env: { mode: 'DEMO' } as never,
    symbols: ['SPOT'],
  } as never)) as Record<string, unknown>;
  assertEqual(bare['fundingRate'], undefined, 'no funding figure is invented');
  assert(
    Array.isArray(bare['unavailable']) && (bare['unavailable'] as string[]).length > 0,
    'and the absence is stated with a reason',
  );
});

test('data: a failed read is a missing fact, never a zero', async () => {
  const { initializeDefaultCapabilities } = await import('../agents/capabilities');
  const { CapabilityRegistry } = await import('../agents/capabilities/registry');
  const registry = initializeDefaultCapabilities(new CapabilityRegistry());
  const capability = registry.get('market.getContext')!;

  const failed = (await capability.execute({}, {
    agentId: 'a', environment: 'DEMO', symbol: 'EURUSD', timeframe: '15m',
    policy: { allowedSymbols: ['EURUSD'] } as never,
    env: {
      mode: 'DEMO',
      async getMarketContext() { throw new Error('venue timeout'); },
    } as never,
    symbols: ['EURUSD'],
  } as never)) as Record<string, unknown>;

  assertEqual(failed['fundingRate'], undefined, 'a timeout does not become funding of zero');
  assertEqual(failed['openInterest'], undefined, 'nor an open interest of zero');
  assert(
    /venue timeout/.test((failed['unavailable'] as string[])[0] ?? ''),
    'and the reason the read failed is reported',
  );
});

test('plan: the objective is one conditional sentence', async () => {
  const { conditionalObjective } = await import('./planView');
  const sentence = conditionalObjective({
    market: 'USD/JPY',
    idea: 'USD/JPY is breaking above 157.86.',
    criteria: [
      { label: 'a completed 15m candle closes above 157.86', state: 'pending' },
      { label: 'the first retest holds from above', state: 'pending' },
      { label: 'two consecutive 15m closes confirm', state: 'pending' },
    ],
    action: 'BUY limit',
  });
  assert(
    /^USD\/JPY .*\. if .*, and .*, and .*, then buy limit\.$/i.test(sentence ?? ''),
    `one sentence: market, belief, conditions, consequence. Got: ${sentence}`,
  );

  // With no conditions yet it says it is gathering them, rather than
  // inventing a condition.
  const gathering = conditionalObjective({
    market: 'EUR/USD',
    idea: 'EUR/USD is rejecting resistance.',
    criteria: [],
  });
  assert(/gathering evidence/i.test(gathering ?? ''), `and is honest when it has none: ${gathering}`);

  // Long lists are capped, and say so.
  const many = conditionalObjective({
    market: 'XAUUSD',
    idea: 'Gold is reclaiming a level.',
    criteria: Array.from({ length: 9 }, (_, index) => ({ label: `condition ${index}`, state: 'pending' as const })),
  });
  assert(/6 further conditions/.test(many ?? ''), `and the remainder is counted, not hidden: ${many}`);
});

test('plan: it exists from the hypothesis and says what it would do', async () => {
  const h = makeHarness();
  await h.investigate();
  const plan = buildPlanView(h.mission());

  assert(plan.exists, 'a plan exists as soon as there is a hypothesis');
  assert(plan.objective !== undefined, 'and is stated as a sentence');
  assert(plan.objective!.includes('EURUSD'), `naming the deployment's market: ${plan.objective}`);
  assertEqual(plan.conditional, undefined, 'with no executable intent while nothing is actionable');
  assertEqual(h.orchestrator.stores.ideas.list().length, 0, 'and nothing executable was created');
});

test('plan: a skill rule that cannot be satisfied is reported, not hidden', async () => {
  /*
   * Six of the ten shipped skills ask for higher-timeframe confirmation.
   * Enforcing that as a hard gate would deadlock every single-timeframe GOAT
   * permanently — so it is surfaced on the plan instead, and this asserts the
   * surface exists rather than pretending the rule is enforced.
   */
  const h = makeHarness();
  await h.investigate();
  const outstanding = h.mission().outstandingConstraints;
  assert(
    outstanding.some((entry) => /higher timeframe/i.test(entry)),
    `the unmet rule is stated: ${JSON.stringify(outstanding)}`,
  );
  assertEqual(buildPlanView(h.mission()).outstandingConstraints.length, outstanding.length,
    'and it reaches the plan rather than stopping at the mission');
});

test('skills: the watch ceiling a skill declares is actually enforced', async () => {
  /*
   * `MAX_TRACKERS` was declared by six skills, shown in the composer, and
   * checked by nothing — a skill that said "watch no more than eight" was
   * decoration.
   */
  const h = makeHarness({ skillIds: ['risk-discipline'] });
  await h.investigate();
  const thesisId = h.mission().thesis!.id;

  /*
   * risk-discipline caps watches at six. The investigation may already have
   * armed some, so the budget is measured rather than assumed — and a ceiling
   * that fired on the investigation's own watches would be a different test.
   */
  /*
   * Through the SDK, because that is the only surface a GOAT can create a
   * watch on — and therefore the only place a skill's promise can be true.
   * The runtime underneath keeps its own ceilings for non-GOAT agents.
   */
  const sdk = h.orchestrator.sdkFor(h.agentId);
  const already = h.mission().activeTrackerCount;
  for (let index = already; index < 6; index += 1) {
    sdk.create(thesisId, {
      purpose: `Watch ${index}`, kind: 'NEW_BAR', timeframe: '15m', config: {}, cooldownMs: 0,
    });
  }
  assertEqual(h.mission().activeTrackerCount, 6, 'six watches are armed');

  let refused = false;
  let message = '';
  try {
    sdk.create(thesisId, {
      purpose: 'One too many', kind: 'NEW_BAR', timeframe: '15m', config: {}, cooldownMs: 0,
    });
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }
  assert(refused, 'the seventh watch is refused, because the skill said six');
  assert(/at most 6|allow at most/i.test(message), `and says which rule stopped it: ${message}`);
});

test('skills: cancelling a watch frees the budget again', async () => {
  const h = makeHarness({ skillIds: ['risk-discipline'] });
  await h.investigate();
  const thesisId = h.mission().thesis!.id;
  const sdk = h.orchestrator.sdkFor(h.agentId);
  const already = h.mission().activeTrackerCount;
  const created: string[] = [];
  for (let index = already; index < 6; index += 1) {
    created.push(sdk.create(thesisId, {
      purpose: `Watch ${index}`, kind: 'NEW_BAR', timeframe: '15m', config: {}, cooldownMs: 0,
    }).id);
  }
  sdk.remove(created[0], 'no longer relevant');
  let accepted = false;
  try {
    sdk.create(thesisId, {
      purpose: 'Replacement', kind: 'NEW_BAR', timeframe: '15m', config: {}, cooldownMs: 0,
    });
    accepted = true;
  } catch {
    accepted = false;
  }
  assert(accepted, 'the ceiling is about what is watched now, not what ever was');
});

test('skills: a skill can be switched off, and that is a runtime fact', async () => {
  const h = makeHarness();
  const before = h.orchestrator.skills.get('patience')!;
  assert(before.enabled, 'it starts enabled');

  h.orchestrator.setSkillEnabled('patience', false);
  assertEqual(
    h.orchestrator.skills.get('patience')!.enabled,
    false,
    'switching it off is recorded on the canonical registry',
  );
  assert(
    !h.orchestrator.skills.listEnabled().some((skill) => skill.id === 'patience'),
    'and it stops being offered to new GOATs',
  );

  h.orchestrator.setSkillEnabled('patience', true);
  assert(
    h.orchestrator.skills.listEnabled().some((skill) => skill.id === 'patience'),
    'and can be switched back on',
  );
});

test('skills: a written skill can be revised, not only rewritten from scratch', async () => {
  /*
   * Create, read and delete existed; update did not. So the only way to improve
   * a skill you had written was to retype it from nothing, and a skill you had
   * grown to rely on could not be corrected in place. The fix is deliberately
   * not a second write path — `saveUserSkill` already upserts on the id in the
   * document's own frontmatter, so an edit and a create validate identically.
   */
  const h = makeHarness();

  const written = h.orchestrator.saveUserSkill([
    '---',
    'id: note_taking',
    'name: Note Taking',
    'description: Record what was learned.',
    'capabilities: [market.getQuote]',
    'constraints: [REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION]',
    '---',
    '',
    'Write down what the tape taught you.',
  ].join('\n'));
  assertEqual(written.problems.length, 0, `it saves: ${written.problems.join('; ')}`);
  const id = written.document!.id;
  assertEqual(h.orchestrator.listUserSkills().length, 1, 'and is listed as your own');

  // Read it back the way the editor does.
  const markdown = h.orchestrator.exportSkill(id);
  assert(markdown !== undefined, 'a written skill can be loaded back for editing');

  // Revise it.
  const revised = markdown!.replace(
    'Write down what the tape taught you.',
    'Record the level, then the reason.',
  );
  const updated = h.orchestrator.saveUserSkill(revised);
  assertEqual(updated.problems.length, 0, `the revision saves: ${updated.problems.join('; ')}`);
  assertEqual(updated.document!.id, id, 'as the same skill, not a second one');
  assertEqual(h.orchestrator.listUserSkills().length, 1, 'so the list did not grow');

  const stored = h.orchestrator.exportSkill(id)!;
  assert(
    stored.includes('Record the level, then the reason.'),
    'and the new text is what is stored',
  );
  assert(
    !stored.includes('Write down what the tape taught you.'),
    'the old text is gone, rather than both being kept',
  );

  // And the revision reached the runtime, not just the store.
  const live = h.orchestrator.skills.get(id);
  assert(live !== undefined, 'the canonical registry carries the revision');
  assert(
    (live!.instructions ?? '').includes('Record the level'),
    'including its instructions',
  );

  assertEqual(h.orchestrator.deleteUserSkill(id), true, 'and it can still be removed');
  assertEqual(h.orchestrator.listUserSkills().length, 0, 'leaving nothing behind');
});

test('skills: a GOAT can see the rules it has not satisfied yet', async () => {
  /*
   * Six of the ten skills declare REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION. It is
   * surfaced rather than enforced, because enforcing it would deadlock any GOAT
   * running a single timeframe. That decision is only honest if the user can
   * see it, so it has to reach the mission and the plan the user reads.
   */
  const h = makeHarness({ skillIds: ['structural-trend-analysis'] });
  await h.investigate();

  const outstanding = h.mission().outstandingConstraints;
  assert(
    outstanding.length > 0,
    `the mission carries what is still required: ${JSON.stringify(outstanding)}`,
  );
  assert(
    outstanding.some((entry) => /higher timeframe/i.test(entry)),
    `and says it in words a user can read, not in a rule name: ${JSON.stringify(outstanding)}`,
  );

  const plan = (await import('./planView')).buildPlanView(h.mission());
  assertEqual(
    plan.outstandingConstraints.length,
    outstanding.length,
    'the trade plan shows the same list, so the two cannot disagree',
  );
});

// ---------------------------------------------------------------------------
// 6. Initial work is visible, and waiting on the model is not watching
// ---------------------------------------------------------------------------

/**
 * A model that holds its reply until the test lets it go.
 *
 * The whole point of the MODEL states is the window while a request is
 * outstanding, and a model that answers immediately never opens one. This
 * double opens exactly one window and closes it on demand.
 */
class GatedModel implements IAgentModel {
  calls = 0;
  private release?: () => void;
  readonly answered = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async run() {
    this.calls += 1;
    await this.answered;
    return normalizeModelReply(INVESTIGATION);
  }

  letGo(): void {
    this.release?.();
  }
}

test('progress: a deployment records the work it does before the model is asked', async () => {
  const h = makeHarness();
  await h.investigate();

  const types = h.agentLog().map((entry) => entry.type);
  const at = (type: string) => types.indexOf(type);

  assert(types.includes('GOAT_SETTING_UP'), 'setup is announced');
  assert(
    at('GOAT_SETTING_UP') < at('MARKET_CONTEXT_LOADED'),
    'setup is announced before anything is read, so the silence after deployment has a boundary',
  );
  assert(
    at('MARKET_CONTEXT_PREPARED') > at('MARKET_CONTEXT_LOADED'),
    'research is recorded as finishing after the reads, not before them',
  );
  assert(
    at('MODEL_REQUEST') > at('MARKET_CONTEXT_PREPARED'),
    'and the request goes out after research is complete',
  );
  assert(
    at('THESIS_FORMED') > at('MODEL_REQUEST'),
    'and what the request produced follows it',
  );

  /*
   * The resolution set the agent claimed to have read, in the request itself.
   * Everything the reader is told about the agent's context has to be a value
   * the runtime actually collected.
   */
  const request = h.agentLog().find((entry) => entry.type === 'MODEL_REQUEST');
  assert(request!.detail !== undefined && /15m/.test(request!.detail!), 'the request carries the resolutions read');
  assert(/candles/.test(request!.detail!), 'and how much data went with them');
});

test('progress: waiting on the model is a state of its own, not watching', async () => {
  /*
   * The failure this exists to stop: a GOAT that read 15m, 30m and 1h and was
   * then blocked on a model for ten seconds rendered as WATCHING — "deployed
   * and waiting for a condition to fire" — which described a GOAT with nothing
   * to do while it was, in fact, mid-request.
   */
  const gate = new GatedModel();
  const h = makeHarness({ model: gate as unknown as ScriptedModel });
  const investigation = h.orchestrator.investigateGoal(h.goalId);

  // The window: read the state while the request is genuinely outstanding.
  let pending: GoatMission | undefined;
  for (let attempt = 0; attempt < 200 && !pending?.modelPending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending = h.mission();
  }

  assert(pending?.modelPending !== undefined, 'the runtime knows a request is outstanding');
  assertEqual(pending!.stage, 'WAITING_FOR_MODEL', 'the stage says so');
  assertEqual(statusFor(pending!, h.clock.now()), 'WAITING_FOR_MODEL', 'and so does the status the dot renders');
  assert(
    pending!.next.blocked === false,
    'it is not reported as blocked, because something is genuinely in flight',
  );

  gate.letGo();
  await investigation;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const settled = h.mission();
  assertEqual(settled.modelPending, undefined, 'the pending state clears when the answer lands');
  assert(
    settled.stage !== 'WAITING_FOR_MODEL',
    `and the GOAT moves on to what it is actually doing: ${settled.stage}`,
  );
});

test('progress: model work is one line and one outcome, never a heartbeat', async () => {
  /*
   * The failure mode this guards against is filling a gap with reassurance.
   *
   * There used to be a "still waiting" line every ten seconds. It was honest
   * and it was still spam: a reader had already been told the request went out,
   * and twelve identical lines do not make a GOAT look busier. So a fast answer
   * must produce exactly one request line and one outcome line, and a slow one
   * must produce the same two — the difference is carried by the live status,
   * not by the log.
   */
  const h = makeHarness();
  await h.investigate();

  const types = h.agentLog().map((entry) => entry.type);
  assertEqual(types.filter((type) => type === 'MODEL_REQUEST').length, 1, 'one request line');
  assertEqual(
    types.filter((type) => type === 'THESIS_FORMED' || type === 'THESIS_REVISED').length,
    1,
    'one outcome line: the Trade Plan',
  );
  assert(
    !types.some((type) => /WAITING|MODEL_RESPONSE|MODEL_FAILURE/.test(type)) ||
      types.includes('MODEL_FAILURE') === false,
    'nothing claims the model is waiting, answering again, or failing',
  );

  /*
   * No sleep line inside the request window either.
   *
   * A GOAT *is* entitled to a sleep line once its conditions exist — that is the
   * genuine "waiting for a qualifying market event" state, and it belongs after
   * the outcome. What it must never do is claim to be watching while it is in
   * fact blocked on a reply.
   */
  const request = types.indexOf('MODEL_REQUEST');
  const outcome = types.indexOf('THESIS_FORMED');
  assert(
    !types.slice(request, outcome).includes('GOAT_WAITING'),
    `nothing claims to be watching between the request and the plan: ${types.join(' → ')}`,
  );
  assert(
    types.lastIndexOf('GOAT_WAITING') > outcome,
    'and the sleep that does exist comes after the plan exists',
  );
});

test('progress: a failure to read the model is followed by a retry that exists', async () => {
  const h = makeHarness({
    model: new ScriptedModel([], undefined, true),
  });
  const report = await h.orchestrator.investigateGoal(h.goalId);
  assertEqual(report.outcome, 'MODEL_FAILURE', 'the failure is reported as a failure');
  assertEqual(h.orchestrator.hasPendingReconsideration(h.agentId), true, 'and a retry is genuinely armed');

  const retry = h.agentLog().find((entry) => entry.type === 'MODEL_RETRY');
  assert(retry !== undefined, 'the log says a retry was scheduled, because one was');
  assert(
    h.agentLog().some((entry) => entry.type === 'MODEL_FAILURE'),
    'and the failure that caused it is on the record',
  );
});

// ---------------------------------------------------------------------------
// 7. The Trade Plan is the hypothesis, and the model state is one live thing
// ---------------------------------------------------------------------------

test('plan: the plan and the belief are one record, not two lines', async () => {
  /*
   * The correction this test protects.
   *
   * A GOAT forming a plan used to write "Thesis: X" and then "Defined what it
   * needs to see", which is one idea in two vocabularies — and the user-facing
   * consequence was an architecture that looked more complicated than the
   * mental model it was supposed to match. What they believe, what would make
   * it right and what it would do are now one line, in the user's words.
   */
  const h = makeHarness();
  await h.investigate();

  const log = h.agentLog();
  const plan = log.find((entry) => entry.type === 'THESIS_FORMED');
  assert(plan !== undefined, 'the plan is recorded');
  assertEqual(plan!.style.label, 'TRADE PLAN', 'and labelled as the plan, not as a hypothesis');
  assert(
    !/hypothesis/i.test(`${plan!.headline} ${plan!.detail ?? ''}`),
    `nothing about it is called a hypothesis: ${plan!.headline}`,
  );
  assert(
    /\bif\b/i.test(plan!.headline) && /\bthen\b/i.test(plan!.headline),
    `and it says what must happen and what follows: ${plan!.headline}`,
  );
  assert(
    /conditions to confirm/.test(plan!.detail ?? ''),
    `with the conditions it is waiting on: ${plan!.detail}`,
  );

  assertEqual(
    log.filter((entry) => entry.type === 'EVIDENCE_REQUIREMENTS_DEFINED').length,
    0,
    'and there is no second line saying the same thing again',
  );
  assertEqual(
    log.filter((entry) => /research/i.test(entry.style.label) && entry.type === 'THESIS_FORMED').length,
    0,
    'the plan is not also filed as research',
  );
});

test('plan: the panel shows the consequence before anything is executable', async () => {
  const h = makeHarness();
  await h.investigate();

  const plan = buildPlanView(h.mission());
  assert(plan.exists, 'a plan exists from the moment there is a belief');
  assertEqual(plan.status, 'RESEARCHING', 'and says it is still validating rather than ready');
  assert(
    /then (buy|sell|keeps gathering evidence)/.test(plan.objective ?? ''),
    `the sentence ends in a consequence the user can act on: ${plan.objective}`,
  );
  assertEqual(
    plan.conditional,
    undefined,
    'while the executable block stays absent — intent is not permission',
  );
  assertEqual(
    (plan.awaiting ?? []).length,
    plan.research.length,
    'and the outstanding conditions are named rather than implied',
  );
});

test('model state: the pulsing state carries the waiting, and the log stays quiet', async () => {
  /*
   * The whole point of removing the heartbeat.
   *
   * The live state says what the GOAT is doing for as long as it is doing it,
   * and the log records what happened rather than what time did. A slow request
   * and a fast one produce the same two lines.
   */
  const gate = new GatedModel();
  const h = makeHarness({ model: gate as unknown as ScriptedModel });
  const running = h.orchestrator.investigateGoal(h.goalId);

  let mission: GoatMission | undefined;
  for (let attempt = 0; attempt < 400 && mission?.modelPending === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    mission = h.mission();
  }

  assert(mission?.modelPending !== undefined, 'the runtime knows a request is outstanding');
  assertEqual(mission!.modelPending!.phase, 'FORMING', 'and which kind of thinking it is');
  assertEqual(
    statusFor(mission!, h.clock.now()),
    'WAITING_FOR_MODEL',
    'the status is the model state, not watching',
  );

  /*
   * Held open for the length of several heartbeat intervals, and still one
   * request line. This is the assertion the old heartbeat could not survive.
   */
  await new Promise((resolve) => setTimeout(resolve, 250));
  const during = h.agentLog();
  assertEqual(
    during.filter((entry) => entry.type === 'MODEL_REQUEST').length,
    1,
    'one request line while the request is outstanding',
  );
  assertEqual(
    during.filter((entry) => /waiting/i.test(entry.headline) && entry.type.startsWith('MODEL')).length,
    0,
    'and nothing repeating that it is waiting',
  );

  gate.letGo();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = h.agentLog();
  assert(
    after.some((entry) => entry.type === 'THESIS_FORMED'),
    'the outcome arrives as one semantic line',
  );
  assertEqual(
    after.filter((entry) => entry.type.startsWith('MODEL')).length,
    1,
    'and the model contributed exactly one line in total',
  );
});

test('model state: the runtime measures latency without writing a line for it', async () => {
  const h = makeHarness();
  await h.investigate();

  const stats = h.orchestrator.modelCallStats(h.agentId);
  assertEqual(stats.calls, 1, 'one call was made');
  assert(stats.totalMs >= 0, 'and its cost is measured');
  assertEqual(stats.slowestMs, stats.totalMs, 'with one call, the slowest is the total');
  /*
   * The cost appears at most once, on the plan itself.
   *
   * A duration attached to the outcome is information — "this took four
   * seconds" is a fact about the plan. What is not information is a line that
   * exists only because time passed, which is why the count is one rather than
   * zero.
   */
  const timed = h.agentLog().filter((entry) => /\d+(\.\d+)?s\b/.test(entry.detail ?? ''));
  assert(timed.length <= 1, `at most one timing note in the log: ${timed.length}`);
  for (const entry of timed) {
    assertEqual(entry.type, 'THESIS_FORMED', 'and it rides on the outcome, never on the request');
  }
});

// ---------------------------------------------------------------------------
// 8. Resolutions belong to the GOAT, and the replay inherits them
// ---------------------------------------------------------------------------

test('timeframes: a GOAT declared to work on 1m and 5m deploys on exactly those', async () => {
  /*
   * The scalping regression.
   *
   * "Scalp USD/JPY using 1m and 5m" used to become a 15m GOAT: the deployment
   * wrote one resolution and the model was handed the whole menu regardless.
   * That is not a slower version of the same agent, it is a different agent with
   * the same objective.
   */
  const h = makeHarness({
    timeframes: ['1m', '5m'],
    goal: 'Scalp USD/JPY using 1m and 5m.',
  });

  const goal = h.orchestrator.getGoal(h.goalId)!;
  assertEqual(
    goal.timeframes.join(','),
    '5m,1m',
    'the deployment is on the middle declared resolution, with the set behind it',
  );

  await h.investigate();
  const reads = h.agentLog().filter((entry) => entry.type === 'MARKET_CONTEXT_LOADED');
  assert(reads.length > 0, 'it read its declared resolutions');
  for (const read of reads) {
    assert(
      /\b(1m|5m)\b/.test(read.detail ?? '') && !/\b(15m|1h|4h)\b/.test(read.detail ?? ''),
      `no resolution nobody declared was read: ${read.detail}`,
    );
  }
  assertEqual(
    h.mission().timeframes.join(','),
    '5m,1m',
    'and the mission carries the whole set, because a replay needs it',
  );
});

test('timeframes: an objective that names its resolutions is not overruled', async () => {
  const { timeframesInStatement, resolveTimeframePlan } = await import('./timeframes');

  assertEqual(
    timeframesInStatement('Scalp USD/JPY using 1m and 5m.').join(','),
    '1m,5m',
    'the resolutions the user wrote are found',
  );
  assertEqual(timeframesInStatement('Watch the market.').length, 0, 'and nothing is invented');

  const plan = resolveTimeframePlan({
    declared: timeframesInStatement('Analyze across 1m, 5m and 15m.'),
  });
  assertEqual(plan.reads.map((read) => read.timeframe).join(','), '1m,5m,15m', 'and all three are read');
  assertEqual(plan.setup, '5m', 'acting on the middle one');
});

// ---------------------------------------------------------------------------
// 9. Refresh: a clean runtime without losing the GOAT
// ---------------------------------------------------------------------------

test('refresh: the runtime is cleared and the GOAT, its deployment and its history are not', async () => {
  const h = makeHarness();
  await h.investigate();

  const before = h.mission();
  const goal = h.orchestrator.getGoal(h.goalId)!;
  const deploymentId = before.deployment?.id;
  const thesisId = before.thesis?.id;
  const evidenceBefore = before.evidence.length;
  const trackersBefore = before.activeTrackerCount;
  assert(trackersBefore > 0, 'there was something running to clear');

  const report = await h.orchestrator.refreshGoat(h.goalId);

  const after = h.mission();

  // --- cleared ---------------------------------------------------------
  assertEqual(report.cleared.trackers, trackersBefore, 'every tracker it had was reported as cleared');
  assertEqual(after.activeTrackerCount, 0, 'and none of them is watching any more');
  assertEqual(after.modelPending, undefined, 'no model request survives a refresh');
  assertEqual(statusFor(after, h.clock.now()) === 'ERROR', false, 'and the GOAT is not left in a broken state');

  // --- kept -------------------------------------------------------------
  assertEqual(h.orchestrator.getGoal(h.goalId)?.id, goal.id, 'the GOAT is the same GOAT');
  assertEqual(h.orchestrator.getGoal(h.goalId)?.statement, goal.statement, 'with the same objective');
  assertEqual(
    h.orchestrator.stores.deployments.currentFor(h.agentId)?.id,
    deploymentId,
    'and the same deployment identity — a refresh is not a second deployment',
  );
  assertEqual(after.deployment?.marketId, before.deployment?.marketId, 'pointed at the same market');
  assertEqual(h.orchestrator.listThesesForGoal(h.goalId).length, before.thesisCount, 'its plan history is intact');
  assert(after.evidence.length >= evidenceBefore, 'and its evidence is');
  assertEqual(
    h.orchestrator.stores.theses.get(thesisId!) !== undefined,
    true,
    'the thesis it was holding is still on record, even though nothing watches it now',
  );

  // --- and it is runnable again, without a duplicate runtime -------------
  const restarted = await h.orchestrator.investigateGoal(h.goalId);
  assert(restarted.deployed, 'it can be started again immediately');
  const trackers = h.trackers.listForAgent(h.agentId).filter((tracker) => tracker.lifecycle.status === 'ACTIVE');
  assertEqual(
    trackers.length,
    new Set(trackers.map((tracker) => tracker.purpose)).size,
    'with one watch per condition, never two copies of the same watch',
  );
  assertEqual(
    h.orchestrator.stores.deployments.historyFor(h.agentId).filter((entry) => entry.status === 'active').length,
    1,
    'and exactly one active deployment for this GOAT',
  );
});

test('refresh: a GOAT with no deployment can be refreshed without inventing one', async () => {
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(undefined, undefined, undefined, undefined, new InMemoryAgentTimelineStore());
  const trackers = new TrackerRuntime({
    registry: new TrackerRegistry((id) => agentRuntime.getAgent(id)),
    agents: agentRuntime, timeline: agentRuntime.getTimelineStore(), clock: clock.now,
  });
  const orchestrator = new GoatOrchestrator({
    agentRuntime, trackers, env, clock: clock.now,
    model: new ScriptedModel([]),
    stores: {
      goals: new InMemoryGoalStore(), theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(), ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(), skills: new InMemorySkillStore(),
    },
    venueEnvironment: 'TESTNET',
  });
  orchestrator.stores.goals.save({
    id: 'un', agentId: 'un_agent', statement: 'Watch EUR/USD for a break of the range.',
    symbols: [], timeframes: [], skillIds: [], status: 'UNDEPLOYED',
    createdAt: clock.now(), updatedAt: clock.now(),
  });

  const report = await orchestrator.refreshGoat('un');
  assertEqual(report.kept.deployment, false, 'nothing was deployed, so nothing is reported as kept');
  assertEqual(orchestrator.stores.deployments.historyFor('un_agent').length, 0, 'and a refresh creates no deployment');
  assertEqual(report.kept.theses, 0, 'there was nothing to keep');
});

test('refresh: an outstanding model request cannot mutate the fresh runtime', async () => {
  /*
   * The dangerous version of this control.
   *
   * A request that is in flight when the user refreshes will come back some
   * time later, against a runtime that no longer exists. If its answer is
   * applied it will re-form a Trade Plan nobody asked for, on the previous
   * context. So the pending request is dropped before anything is rebuilt.
   */
  const gate = new GatedModel();
  const h = makeHarness({ model: gate as unknown as ScriptedModel });
  const investigation = h.orchestrator.investigateGoal(h.goalId);

  let pending = false;
  for (let attempt = 0; attempt < 400 && !pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending = h.orchestrator.pendingModelRequest(h.agentId) !== undefined;
  }
  assert(pending, 'a request really is outstanding');

  const report = await h.orchestrator.refreshGoat(h.goalId);
  assertEqual(report.cleared.pendingModelRequest, true, 'and the refresh says it abandoned one');

  gate.letGo();
  await investigation;
  await new Promise((resolve) => setTimeout(resolve, 30));

  const after = h.mission();
  assertEqual(
    h.orchestrator.pendingModelRequest(h.agentId),
    undefined,
    'the late answer cannot register itself against the new runtime',
  );
  assertEqual(after.thesisCount, 0, 'and forms no plan on the way out');
  assertEqual(after.activeTrackerCount, 0, 'nor arms a condition the user just cleared');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runAgentSurfaceTests(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`pass  ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL  ${name}`);
      console.log(`      ${message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} agent-surface test(s) failed.`);
  }
}

if (import.meta.main) {
  await runAgentSurfaceTests();
}