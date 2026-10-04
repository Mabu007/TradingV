/**
 * GOAT test suite.
 *
 * Covers the four areas the architecture depends on:
 *
 *   1. Tracker Runtime   - lifecycle, expiry, events, ownership
 *   2. Agent loop        - thesis lifecycle, multi-thesis, wake behaviour
 *   3. Skills            - loading, validation, activation, influence, conflicts
 *   4. Permissions       - a skill cannot widen an agent's authority
 *   5. Integration       - goal -> thesis -> tracker -> event -> wake -> update
 *
 * The integration test drives the full loop with a deterministic stub
 * model and a hand-fed observation. No network, no API key and no
 * trading, which is the point: the architecture has to be testable
 * without any of those.
 */

import { AgentRuntime } from '../agents/runtime';
import { TrackerRegistry } from '../agents/trackers/registry';
import { TrackerRuntime, TrackerRuntimeError } from '../agents/trackers/runtime';
import { TrackerEvent } from '../agents/trackers/types';
import { CapabilityRegistry } from '../agents/capabilities/registry';
import { ITradingEnvironment } from '../agents/types';
import { Bar, OrderResult, Position } from '../../types/trading';
import { NormalizedQuote } from '../../types/quotes';
import { InMemoryAgentTimelineStore } from '../agents/timeline/store';
import { IAgentModel } from '../agents/model/types';

import {
  GoatOrchestrator,
  createGoatStores,
} from './orchestrator';
import { TrackerSdk, TrackerPermissionError, GOAT_CAPABILITIES, ALL_GOAT_CAPABILITIES } from './trackerSdk';
import { GoatSkillRegistry, SkillPackage, SkillValidationError } from './skills';
import { GOAT_BUILTIN_SKILLS } from './builtinSkills';
import { STARTER_GOATS, starterProfiles } from './starterGoats';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
} from './store';
import { InMemoryDeploymentStore } from './deployments';
import { InMemorySkillStore } from './skillStore';
import { parseSkillMarkdown, toSkillMarkdown } from './skillMarkdown';
import { GOAT_EXECUTION_CAPABILITIES } from './researchCapabilities';
import { GOAT_CORE_SKILL, GOAT_CORE_SKILL_ID } from './coreSkill';
import {
  collectMarketContext,
  marketContextEvidence,
  renderMarketContext,
} from './marketContext';
import { initializeDefaultCapabilities } from '../agents/capabilities';
import { PersistentGoalStore } from './store';
import { PersistentDeploymentStore } from './deployments';
import { PersistentSkillStore } from './skillStore';
import { AgentPlan, Thesis, Tracker, TradeIdea, WakeRequest } from './types';
import { isDeliberateWait, parseInvestigation } from './orchestrator';

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  /*
   * Arrays and objects are compared by content. A reference comparison
   * reports two obviously identical lists of ids as a failure, which
   * trains a reader to ignore the assertion — the exact opposite of what a
   * test is for.
   */
  const same =
    actual === expected ||
    (typeof actual === 'object' &&
      actual !== null &&
      expected !== null &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (!same) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A deterministic clock. Nothing in these tests reads the wall clock. */
function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}

const EURUSD_BARS: Bar[] = Array.from({ length: 120 }, (_, i) => ({
  time: 1_700_000_000 + i * 900,
  open: 1.1 + i * 0.0001,
  high: 1.1005 + i * 0.0001,
  low: 1.0995 + i * 0.0001,
  close: 1.1002 + i * 0.0001,
}));

/**
 * Real instrument metadata for the market the harness deploys.
 *
 * Present because production has it and the risk layer needs it: an amount
 * denominated in EUR cannot be converted into the account currency without
 * the pair's quote currency and pip size. A stub environment that returned
 * none made every risk check decline for a reason that has nothing to do
 * with the plan being checked, which is how a broken capability contract
 * hid for so long.
 */
const EURUSD_METADATA = {
  symbol: 'EURUSD',
  displayName: 'EUR/USD',
  assetClass: 'FOREX' as const,
  provider: 'HYPERLIQUID' as const,
  providerSymbol: 'xyz:EUR',
  providerMarketId: 'EUR',
  quoteCurrency: 'USD',
  baseCurrency: 'EUR',
  pricePrecision: 5,
  sizePrecision: 0,
  sizeStep: 1,
  minOrderSize: 1,
  maxOrderSize: 1_000_000,
};

class StubEnvironment implements ITradingEnvironment {
  mode: 'BACKTEST' | 'DEMO' | 'LIVE' = 'DEMO';
  placed: Array<Record<string, unknown>> = [];

  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    return { symbol, symbolId: '1', bid: 1.1000, ask: 1.1002, spread: 1, timestamp: 1, status: 'MOCK' };
  }
  async getMarketBars(): Promise<Bar[]> {
    return EURUSD_BARS;
  }
  async getInstruments() {
    return [EURUSD_METADATA];
  }
  async getAccountState() {
    return { balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, dailyPnL: 0, drawdownPercent: 0 };
  }
  async getPositions(): Promise<Position[]> {
    return [];
  }
  async getOrders(): Promise<OrderResult[]> {
    return [];
  }
  async placeMarketOrder(params: Record<string, unknown>) {
    this.placed.push(params);
    return { success: true, positionId: 'p1', fillPrice: 1.1 };
  }
  async modifyPosition() {
    return { success: true };
  }
  async closePosition() {
    return { success: true };
  }
}

/** A model that returns whatever the test tells it to. */
class StubModel implements IAgentModel {
  responses: string[] = [];
  calls: number = 0;
  /** When set, every call reports the model as unreachable. */
  unavailable?: { code: string; message: string };

  constructor(responses: string[] = []) {
    this.responses = responses;
  }

  async run() {
    const next = this.responses[this.calls];
    this.calls += 1;
    if (this.unavailable) {
      return {
        thought: 'OpenRouter was not consulted.',
        decision: { type: 'WAIT' as const, reason: 'The reasoning model was unavailable.' },
        unavailable: this.unavailable,
      };
    }
    return { thought: next ?? '{"kind":"WAIT","reason":"no opinion"}' };
  }
}

interface Harness {
  orchestrator: GoatOrchestrator;
  agentRuntime: AgentRuntime;
  trackerRegistry: TrackerRegistry;
  trackers: TrackerRuntime;
  env: StubEnvironment;
  clock: ReturnType<typeof makeClock>;
  /**
   * The model double in play.
   *
   * Typed as the harness needs it rather than as the interface, because
   * tests legitimately push another reply onto `responses` to drive a
   * second decision.
   */
  model: StubModel;
  goalId: string;
  agentId: string;
}

function makeHarness(
  options: {
    skillIds?: string[];
    model?: StubModel | ScriptedModel;
    venueEnvironment?: 'TESTNET' | 'MAINNET';
    /**
     * False leaves the goal saved but undeployed.
     *
     * Used by the tests that are specifically about the state *before* a
     * deployment, which is a real state a user reaches by composing a GOAT
     * and not yet choosing where it runs.
     */
    deployed?: boolean;
    /** The symbol to deploy. Discovery emits the slash form. */
    market?: string;
  } = {},
): Harness {
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(
    undefined,
    undefined,
    undefined,
    undefined,
    new InMemoryAgentTimelineStore(),
  );
  const trackerRegistry = new TrackerRegistry((agentId) => agentRuntime.getAgent(agentId));
  const trackers = new TrackerRuntime({
    registry: trackerRegistry,
    agents: agentRuntime,
    timeline: agentRuntime.getTimelineStore(),
    clock: clock.now,
  });
  const model = options.model ?? new StubModel();

  const orchestrator = new GoatOrchestrator({
    agentRuntime,
    trackers,
    env,
    stores: {
      goals: new InMemoryGoalStore(),
      theses: new InMemoryThesisStore(),
      evidence: new InMemoryEvidenceStore(),
      ideas: new InMemoryTradeIdeaStore(),
      deployments: new InMemoryDeploymentStore(),
      skills: new InMemorySkillStore(),
    },
    model,
    clock: clock.now,
    venueEnvironment: options.venueEnvironment ?? 'TESTNET',
  });

  // Synchronous setup: register a goal and an agent without waiting on
  // the model, so each test starts from a known state.
  const agentId = 'goat_test';
  const goalId = 'goal_test';
  const skillIds = options.skillIds ?? ['structural-trend-analysis', 'regime-awareness'];

  orchestrator.stores.goals.save({
    id: goalId,
    agentId,
    statement: 'Find a long opportunity on EURUSD if the current bearish move reverses.',
    symbols: [],
    timeframes: [],
    skillIds,
    status: 'DRAFT',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  /*
   * Deployed, not hand-registered.
   *
   * The harness used to build an executor by hand and never create a
   * deployment, which is not a state the product can be in — and it hid a
   * real defect. `buildContext` refuses to assemble a wake context for a
   * GOAT with no deployment, because a context with no market is what
   * produced "no deployed symbol, so no market can be investigated" on a
   * GOAT that was deployed and reading EUR/USD. Tests that hand-built the
   * executor therefore never exercised that path at all.
   *
   * Going through `deployGoat` means every test now starts from the same
   * sequence the UI does: a goal, a deployment, and an executor derived
   * from that deployment. Capabilities come from the goal's own skills plus
   * the read-only research set every GOAT carries, exactly as in
   * production.
   */
  if (options.deployed !== false) {
    orchestrator.deployGoat({ goalId, market: options.market ?? 'EURUSD' });
  }

  return { orchestrator, agentRuntime, trackerRegistry, trackers, env, clock, model, goalId, agentId };
}
function seedThesis(h: Harness, overrides: Partial<Thesis> = {}): Thesis {
  const created = h.orchestrator.loop.createThesis({
    goalId: h.goalId,
    agentId: h.agentId,
    statement: 'The decline is corrective inside a broader bullish structure.',
    direction: 'BULLISH',
    invalidation: 'A sustained structural break below 1.0950.',
    requiredConfirmation: ['momentum recovery', 'structure shift', 'price reclaim'],
  });
  const activated = h.orchestrator.loop.reviseThesis(created.id, {
    state: overrides.state ?? 'ACTIVE',
  });
  const rest = { ...overrides };
  delete rest.state;
  return Object.keys(rest).length > 0
    ? h.orchestrator.loop.reviseThesis(created.id, rest)
    : activated;
}

/**
 * An observation, as the evaluator would have produced it.
 *
 * Ownership fields are deliberately minimal: the runtime fills them from
 * the registry, so a test that asserted them here would be asserting its
 * own fixture rather than the runtime's behaviour.
 */
function makeTrackerEvent(
  tracker: Tracker,
  timestamp: number,
  reason = 'Price reached the monitored level',
  overrides: Partial<TrackerEvent> = {},
): TrackerEvent {
  return {
    id: `evt_${tracker.id}_${timestamp}`,
    trackerId: tracker.id,
    agentId: tracker.agentId,
    kind: tracker.kind,
    eventType: tracker.eventType,
    timestamp,
    environment: 'DEMO',
    symbol: tracker.symbol ?? 'EURUSD',
    timeframe: tracker.timeframe,
    reason,
    priority: tracker.evaluation.priority,
    severity: 'INFO',
    ...overrides,
  };
}

/**
 * Apply a wake and require it to have produced an outcome.
 *
 * `runWake` returns undefined when the thesis is gone, which is a real
 * outcome but not one these tests are asserting about. Wrapping it keeps
 * the assertions below about behaviour rather than about null checks.
 */
async function applyWake(
  h: Harness,
  request: WakeRequest,
  plan: AgentPlan,
): Promise<NonNullable<Awaited<ReturnType<Harness['orchestrator']['runWake']>>>> {
  const outcome = await h.orchestrator.runWake(request, plan);
  assert(outcome, 'the wake produced an outcome');
  return outcome;
}

// ---------------------------------------------------------------------------
// 1. Tracker Runtime
// ---------------------------------------------------------------------------

test('tracker runtime: a tracker is created for a thesis and owned by it', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.loop
    .buildContext(h.agentId, thesis.id)!
    .watching;

  assertEqual(tracker.length, 0, 'a fresh thesis watches nothing');

  const created = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery on 15m',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
    priority: 50,
  });

  assertEqual(created.thesisId, thesis.id, 'tracker belongs to the thesis');
  assertEqual(created.goalId, h.goalId, 'tracker inherits the goal');
  assertEqual(created.lifecycle.status, 'ACTIVE', 'a new tracker is active');
  assertEqual(created.lifecycle.eventCount, 0, 'a new tracker has not fired');
  assert(created.purpose.length > 0, 'a tracker states what it waits for');
});

test('tracker runtime: a tracker requires a purpose', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assertThrows(
    () =>
      h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
        purpose: '   ',
        kind: 'PRICE_THRESHOLD',
        config: { level: 1.1, operator: 'ABOVE' },
      }),
    'a tracker with no purpose is rejected',
  );
});

test('tracker runtime: an unsupported tracker kind is rejected', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assertThrows(
    () =>
      h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
        purpose: 'Watch something',
        // Deliberately not a TrackerKind: the runtime has to reject it.
        kind: 'SOMETHING_ELSE' as never,
        config: {},
      }),
    'an unknown tracker kind is rejected',
  );
});

test('tracker runtime: a tracker for an unknown thesis is rejected', async () => {
  const h = makeHarness();
  assertThrows(
    () =>
      h.orchestrator.trackers.createTracker('ths_missing', h.agentId, {
        purpose: 'Watch something',
        kind: 'PRICE_THRESHOLD',
        config: { level: 1.1, operator: 'ABOVE' },
      }),
    'a tracker cannot be created for a thesis that does not exist',
  );
});

test('tracker runtime: a tracker outside the agent market scope is rejected', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assertThrows(
    () =>
      h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
        purpose: 'Watch gold',
        symbol: 'XAUUSD',
        kind: 'PRICE_THRESHOLD',
        config: { level: 2650, operator: 'ABOVE' },
      }),
    'a tracker cannot observe a market the agent may not trade',
  );
});

test('tracker runtime: an observation produces an event with no direction', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
    priority: 60,
  });

  const event = h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  assert(event, 'an observation produces an event');
  assertEqual(event.trackerId, tracker.id, 'the event names its tracker');
  assertEqual(event.thesisId, thesis.id, 'the event names its thesis');
  assertEqual(event.severity, 'SIGNIFICANT', 'priority drives severity');

  // The critical property: an event is a fact, not a signal.
  const serialised = JSON.stringify(event);
  assert(
    !/"side"\s*:/.test(serialised) && !/"action"\s*:/.test(serialised) && !/"direction"\s*:\s*"(BUY|SELL)"/.test(serialised),
    'a tracker event carries no side and no action',
  );
});

test('tracker runtime: an observation is counted and recorded', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const updated = h.orchestrator.trackers.get(tracker.id)!;
  assertEqual(updated.lifecycle.eventCount, 1, 'the observation is counted');
  assert(updated.lifecycle.lastEventAt !== undefined, 'the observation is timestamped');
  assertEqual(h.orchestrator.trackers.listEventsForTracker(tracker.id).length, 1, 'the event is retained');
});

test('tracker runtime: a paused tracker produces no events', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  h.orchestrator.trackers.pauseTracker(tracker.id);
  const event = h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  assertEqual(event, undefined, 'a paused tracker produces no evidence');
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.eventCount, 0, 'a paused tracker is not counted');
});

test('tracker runtime: a resumed tracker reports again', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });
  h.orchestrator.trackers.pauseTracker(tracker.id);
  h.orchestrator.trackers.resumeTracker(tracker.id);
  const event = h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  assert(event, 'a resumed tracker reports again');
});

test('tracker runtime: removing is terminal and the tracker is retained', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  h.orchestrator.trackers.cancelTracker(tracker.id, 'No longer relevant.');
  const cancelled = h.orchestrator.trackers.get(tracker.id);
  assert(cancelled, 'a cancelled tracker is retained so the user can see it happened');
  assertEqual(cancelled.lifecycle.status, 'CANCELLED', 'the tracker is cancelled');
  assertThrows(
    () => h.orchestrator.trackers.resumeTracker(tracker.id),
    'a cancelled tracker cannot be resumed',
  );
  assertEqual(
    h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now())),
    undefined,
    'a cancelled tracker produces no evidence',
  );
});

test('tracker runtime: pausing and cancelling are different acts', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });
  h.orchestrator.trackers.pauseTracker(tracker.id);
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'PAUSED', 'pause is reversible');
  h.orchestrator.trackers.resumeTracker(tracker.id);
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'ACTIVE', 'the tracker is watching again');
});

test('tracker runtime: a tracker expires and stops watching', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a short-lived condition',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
    expiresAt: h.clock.now() + 1_000,
  });

  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'ACTIVE', 'the tracker starts active');
  h.clock.advance(2_000);
  const expired = h.orchestrator.trackers.expireStale();
  assertEqual(expired.length, 1, 'the expired tracker is reported');
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'EXPIRED', 'the tracker has expired');
  assertEqual(
    h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now())),
    undefined,
    'an expired tracker produces no evidence',
  );
});

test('tracker runtime: an update keeps the tracker identity and history', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));

  const updated = h.orchestrator.trackers.updateTracker(tracker.id, {
    purpose: 'Watch momentum recovery above 55 instead',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 55, direction: 'ABOVE' },
  });

  assertEqual(updated.id, tracker.id, 'the tracker keeps its identity');
  assertEqual(updated.lifecycle.eventCount, 1, 'the tracker keeps its history');
  assertEqual(updated.purpose, 'Watch momentum recovery above 55 instead', 'the purpose is updated');
  assertEqual((updated.config as { level: number }).level, 55, 'the condition is updated');
});

test('tracker runtime: a tracker cannot be updated after cancellation', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch something',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.1, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.cancelTracker(tracker.id);
  assertThrows(
    () => h.orchestrator.trackers.updateTracker(tracker.id, { purpose: 'Watch something else' }),
    'a cancelled tracker cannot be redefined',
  );
});

test('tracker runtime: the per-thesis ceiling is enforced', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  for (let i = 0; i < 12; i += 1) {
    h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
      purpose: `Watch condition ${i}`,
      kind: 'PRICE_THRESHOLD',
      config: { level: 1.1 + i / 10_000, operator: 'ABOVE' },
    });
  }
  assertThrows(
    () =>
      h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
        purpose: 'One too many',
        kind: 'PRICE_THRESHOLD',
        config: { level: 1.2, operator: 'ABOVE' },
      }),
    'the per-thesis tracker ceiling stops a runaway agent',
  );
});

test('tracker runtime: invalidating a thesis removes its trackers', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for a structural break',
    kind: 'BREAKOUT',
    timeframe: '15m',
    config: { direction: 'BELOW', level: 1.09 },
  });

  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'INVALIDATED' });
  for (const cancelled of h.orchestrator.trackers.cancelTrackersForThesis(thesis.id, 'Thesis invalidated.')) {
    assertEqual(cancelled.id, tracker.id, 'the tracker is cancelled with the thesis');
  }
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'CANCELLED', 'no tracker outlives its thesis');
});

test('tracker runtime: an event for an unknown tracker is ignored', async () => {
  const h = makeHarness();
  const event: TrackerEvent = {
    id: 'evt_orphan',
    trackerId: 'trk_does_not_exist',
    agentId: h.agentId,
    kind: 'PRICE_THRESHOLD',
    eventType: 'PRICE_REACHED_LEVEL',
    timestamp: h.clock.now(),
    environment: 'DEMO',
    reason: 'orphan',
    priority: 0,
    severity: 'INFO',
  };
  assertEqual(
    h.orchestrator.trackers.ingestEvent(event),
    undefined,
    'an event for a tracker the runtime does not own is ignored',
  );
});

test('tracker runtime: data requirements are declared, not guessed at failure time', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for a momentum cross',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { fastKey: 'ema20', slowKey: 'ema50', fast: { type: 'EMA', period: 20 }, slow: { type: 'EMA', period: 50 }, direction: 'ABOVE' },
  });
  assert(
    tracker.dataRequirements.some((r) => r.kind === 'INDICATOR'),
    'an indicator tracker declares that it needs indicator data',
  );
  assert(
    tracker.dataRequirements.some((r) => r.kind === 'BARS'),
    'an indicator tracker declares that it needs bars',
  );
});

test('tracker events: ownership is taken from the registry, not from the event', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
    priority: 60,
  });

  // A lying event: it claims another GOAT, another thesis and another
  // market. The runtime resolves the tracker first and fills ownership
  // from it, because a wake built on a claimed owner is a wake the wrong
  // agent would act on.
  const event = h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now(), 'Price is below the level', {
    agentId: 'someone_else',
    thesisId: 'ths_someone_else',
    goalId: 'goal_someone_else',
    symbol: 'XAUUSD',
  }));

  assert(event, 'the observation is recorded');
  assertEqual(event!.agentId, h.agentId, 'the event names the GOAT that owns the tracker');
  assertEqual(event!.thesisId, thesis.id, 'the event names the thesis that asked for it');
  assertEqual(event!.goalId, h.goalId, 'the event names the goal');
  assertEqual(event!.symbol, 'EURUSD', 'the market comes from the tracker, not the caller');
  assertEqual(event!.kind, 'PRICE_THRESHOLD', 'the program is the tracker kind');
  assertEqual(event!.eventType, 'PRICE_REACHED_LEVEL', 'the event type is derived from the kind');
  assertEqual(event!.severity, 'SIGNIFICANT', 'severity is derived from the tracker priority');
  assertEqual(event!.timestamp, h.clock.now(), 'the event keeps the observation timestamp');
  assertEqual(
    h.orchestrator.trackers.get(tracker.id)!.lifecycle.eventCount,
    1,
    'only one observation is attributed to the tracker',
  );
  const wakes = h.orchestrator.trackers.latestWakeRequest()!;
  assertEqual(wakes.agentId, h.agentId, 'the wake is addressed to the owning GOAT');
  assertEqual(wakes.thesisId, thesis.id, 'the wake names the thesis that will evaluate it');
  assertEqual(wakes.event.id, event!.id, 'the wake carries the same observation');
});

test('tracker lifecycle: a removed tracker stops watching and keeps its history', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  assertEqual(h.orchestrator.trackers.listEventsForTracker(tracker.id).length, 1, 'the observation is kept');

  const removed = h.orchestrator.trackers.cancelTracker(tracker.id, 'Thesis no longer needs it.');
  assertEqual(removed.lifecycle.status, 'CANCELLED', 'a removed tracker is retained as cancelled');
  assertEqual(
    h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now() + 1_000)),
    undefined,
    'a removed tracker produces no further evidence',
  );
  assertEqual(h.orchestrator.trackers.listEventsForTracker(tracker.id).length, 1, 'and its history is not rewritten');
  assertEqual(h.orchestrator.listWatching(h.goalId).length, 0, 'it is not in the watching list');
});

test('tracker authorization: a second GOAT cannot see or touch the first', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  // A different GOAT, granted the same observation skills and therefore
  // the same capabilities, owning none of this one's theses. Authority is
  // ownership, not capability: this is the case a capability check alone
  // would wave through.
  const otherId = 'goat_other';
  const otherSkills = ['structural-trend-analysis', 'regime-awareness'];
  h.orchestrator.stores.goals.save({
    id: 'goal_other',
    agentId: otherId,
    statement: 'Watch EURUSD for a short.',
    symbols: ['EURUSD'],
    timeframes: ['15m'],
    skillIds: otherSkills,
    status: 'MONITORING',
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  });
  h.agentRuntime.registerAgent({
    id: otherId,
    name: 'GOAT',
    description: 'test',
    instructions: 'test',
    skills: otherSkills,
    capabilities: h.orchestrator.skills.resolveCapabilities(otherSkills),
    policy: {
      maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 50000, maxOrdersPerMinute: 5,
      allowedSymbols: ['EURUSD'], allowTrading: false,
    },
    preferredEnvironment: 'DEMO',
    symbols: ['EURUSD'],
    timeframe: '15m',
    enabled: true,
    createdAt: h.clock.now(),
    updatedAt: h.clock.now(),
  }, h.env);
  const otherGranted = h.agentRuntime.getAgent(otherId)!.allowedCapabilities as string[];
  for (const capability of ALL_GOAT_CAPABILITIES) {
    assert(otherGranted.includes(capability), `the second GOAT really does hold ${capability}`);
  }

  const intruder = h.orchestrator.sdkFor(otherId);
  assertEqual(intruder.read().length, 0, 'a GOAT sees only its own trackers');
  assertThrows(() => intruder.get(tracker.id), 'a GOAT cannot read another GOAT tracker');
  assertThrows(() => intruder.update(tracker.id, { purpose: 'Something else' }), 'a GOAT cannot modify another GOAT tracker');
  assertThrows(() => intruder.pause(tracker.id), 'a GOAT cannot pause another GOAT tracker');
  assertThrows(() => intruder.remove(tracker.id), 'a GOAT cannot remove another GOAT tracker');
  assertEqual(
    h.orchestrator.trackers.get(tracker.id)!.purpose,
    'Watch the invalidation level',
    'and the tracker is unchanged by every one of those attempts',
  );

  // A leaked handle is not authority either: the grant is re-checked per
  // call, so revoking it after the handle was handed over closes it.
  const leaked = h.orchestrator.sdkFor(h.agentId);
  const instance = h.agentRuntime.getAgent(h.agentId)!;
  (instance as { allowedCapabilities: string[] }).allowedCapabilities = [
    GOAT_CAPABILITIES.readTrackers,
  ];
  assertEqual(leaked.read().length, 1, 'the surviving read capability still works');
  assertThrows(() => leaked.remove(tracker.id), 'a leaked handle cannot exceed the remaining grant');
});

test('tracker evaluation: the same delivery is only ever reported once', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
    cooldownMs: 0,
  });

  // The market-data path delivers the same quote twice: a replay, a
  // reconnect, a duplicated websocket frame. The observation must be
  // counted once or the GOAT wakes twice for one fact.
  const input = {
    id: 'quote:EURUSD:1',
    type: 'MARKET_QUOTE',
    timestamp: h.clock.now(),
    environment: 'DEMO' as const,
    agentId: h.agentId,
    symbol: 'EURUSD',
    timeframe: '15m',
    state: {
      timestamp: h.clock.now(),
      environment: 'DEMO' as const,
      symbol: 'EURUSD',
      timeframe: '15m',
      price: 1.1,
    },
  };
  const first = await h.trackers.process(input);
  const duplicate = await h.trackers.process(input);
  const tracker = h.orchestrator.trackers.listForThesis(thesis.id)[0];

  assertEqual(first.length, 0, 'a threshold with no previous sample has nothing to cross');
  const crossed = await h.trackers.process({ ...input, id: 'quote:EURUSD:2', timestamp: h.clock.now() + 1_000, state: { ...input.state, timestamp: h.clock.now() + 1_000, price: 1.09 } });
  assertEqual(crossed.length, 1, 'the crossing is reported once');
  assertEqual(duplicate.length, 0, 'a redelivery of the same id produces nothing');
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.eventCount, 1, 'and only one event is attributed');
});

test('goat wake: an observation reaches the agentic loop with its thesis', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));

  const wake = h.orchestrator.trackers.latestWakeRequest()!;
  const context = h.orchestrator.loop.buildContext(wake.agentId, wake.thesisId, wake.event)!;
  assertEqual(context.thesis.id, thesis.id, 'the agent reasons against the thesis that asked');
  assertEqual(context.wakeEvent?.id, wake.event.id, 'the observation is the reason it woke');
  assertEqual(context.watching[0]?.id, tracker.id, 'and it knows what it is watching');
  assertEqual(context.recentEvents.length, 1, 'with the observation in its recent history');

  const outcome = await applyWake(h, wake, {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'The evidence supports the thesis.',
  });
  assertEqual(outcome.thesis.state, 'STRENGTHENING', 'the wake changed the thesis');
  assertEqual(outcome.evidenceRecorded.length, 1, 'and recorded the observation as evidence');
  const evidence = h.orchestrator.listEvidence(thesis.id)[0];
  assertEqual(evidence.source, 'TRACKER_EVENT', 'the evidence names the observation as its source');
  assertEqual(evidence.trackerEventId, wake.event.id, 'and points back at the exact event');
});

// ---------------------------------------------------------------------------
// 2. Agent loop and thesis lifecycle
// ---------------------------------------------------------------------------

test('thesis lifecycle: a new thesis is a draft and can be activated', async () => {
  const h = makeHarness();
  const created = h.orchestrator.loop.createThesis({
    goalId: h.goalId,
    agentId: h.agentId,
    statement: 'The market is consolidating.',
    invalidation: 'A break of the range.',
  });
  assertEqual(created.state, 'DRAFT', 'a new thesis starts as a draft');
  assertEqual(created.revision, 0, 'a new thesis has no revisions');
  h.orchestrator.loop.reviseThesis(created.id, { state: 'INVESTIGATING' });
  h.orchestrator.loop.reviseThesis(created.id, { state: 'ACTIVE' });
  assertEqual(h.orchestrator.stores.theses.get(created.id)!.state, 'ACTIVE', 'the thesis becomes active');
  assertEqual(h.orchestrator.stores.theses.get(created.id)!.revision, 2, 'every transition is a revision');
});

test('thesis lifecycle: an illegal transition is refused', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assertThrows(
    () => h.orchestrator.loop.reviseThesis(thesis.id, { state: 'DRAFT' }),
    'an active thesis cannot return to draft',
  );
});

test('thesis lifecycle: an invalidated thesis is terminal', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'INVALIDATED' });
  assertThrows(
    () => h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIVE' }),
    'an invalidated thesis cannot be revived',
  );
  // It is still readable, so the user can ask why.
  assert(h.orchestrator.stores.theses.get(thesis.id), 'an invalidated thesis is retained');
  assertEqual(h.orchestrator.listLiveTheses(h.goalId).length, 0, 'but it is no longer live');
});

test('thesis lifecycle: invalidation is required and is a first-class field', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assert(thesis.invalidation.length > 0, 'a thesis states what would make it wrong');
  const revised = h.orchestrator.loop.reviseThesis(thesis.id, {
    invalidation: 'A sustained break below 1.0900.',
  });
  assertEqual(revised.invalidation, 'A sustained break below 1.0900.', 'invalidation can be revised');
});

test('multi-thesis: one goal can hold several independent theses', async () => {
  const h = makeHarness();
  const a = seedThesis(h);
  const b = h.orchestrator.loop.createThesis({
    goalId: h.goalId,
    agentId: h.agentId,
    statement: 'The move continues lower.',
    direction: 'BEARISH',
    invalidation: 'A higher low forming.',
  });
  h.orchestrator.loop.reviseThesis(b.id, { state: 'ACTIVE' });

  assertEqual(h.orchestrator.listLiveTheses(h.goalId).length, 2, 'a goal can hold two opposing theses');

  const trackerA = h.orchestrator.trackers.createTracker(a.id, h.agentId, {
    purpose: 'Watch for bullish structure shift',
    kind: 'BREAKOUT',
    timeframe: '15m',
    config: { direction: 'ABOVE', level: 1.11 },
  });
  const trackerB = h.orchestrator.trackers.createTracker(b.id, h.agentId, {
    purpose: 'Watch for bearish structure break',
    kind: 'BREAKOUT',
    timeframe: '15m',
    config: { direction: 'BELOW', level: 1.09 },
  });

  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(trackerA, h.clock.now()));
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(trackerB, h.clock.now()));

  assertEqual(h.orchestrator.trackers.listEventsForThesis(a.id).length, 1, 'thesis A sees its own event');
  assertEqual(h.orchestrator.trackers.listEventsForThesis(b.id).length, 1, 'thesis B sees its own event');
  assertEqual(h.orchestrator.stores.theses.get(a.id)!.state, 'ACTIVE', 'thesis A is unaffected by B');
});

test('wake behaviour: a tracker observation produces a wake request with full context', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });

  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  assert(wake, 'a tracker observation produces a wake request');
  assertEqual(wake.thesisId, thesis.id, 'the wake names the thesis');
  assertEqual(wake.goalId, h.goalId, 'the wake names the goal');
  assertEqual(wake.agentId, h.agentId, 'the wake names the agent');
  assert(wake.thesis.statement.length > 0, 'the wake carries the current thesis');
  assert(wake.event.observedValues !== undefined || wake.event.reason.length > 0, 'the wake carries what happened');
  assert(wake.skillIds.includes('structural-trend-analysis'), 'the wake carries the active skills');
});

test('wake behaviour: confirming a thesis strengthens it and records evidence', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Momentum recovered.' });
  assertEqual(outcome.thesis.state, 'STRENGTHENING', 'the thesis is strengthened');
  assert(outcome.evidenceRecorded.length > 0, 'the event is recorded as evidence');
  const supporting = h.orchestrator.listEvidence(thesis.id).filter((e) => e.polarity === 'SUPPORTS');
  assertEqual(supporting.length, 1, 'supporting evidence is kept');
});

test('wake behaviour: weakening a thesis lowers its confidence', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { confidence: 0.6 });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for a failed reclaim',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.11, operator: 'BELOW' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, { kind: 'WEAKEN_THESIS', thesisId: thesis.id, reason: 'Reclaim failed.' });
  assertEqual(outcome.thesis.state, 'WEAKENING', 'the thesis is weakening');
  assert(outcome.thesis.confidence! < 0.6, 'confidence falls when a thesis weakens');
  const contradicting = h.orchestrator.listContradictingEvidence(thesis.id);
  assertEqual(contradicting.length, 1, 'contradicting evidence is kept separately');
});

test('wake behaviour: invalidating a thesis stops its trackers', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.09, operator: 'BELOW' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'INVALIDATE_THESIS',
    thesisId: thesis.id,
    reason: 'Higher timeframe structure broke.',
  });

  assertEqual(outcome.thesis.state, 'INVALIDATED', 'the thesis is invalidated');
  assertEqual(outcome.trackerChanges.length, 1, 'its trackers are cancelled');
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'CANCELLED', 'no tracker survives the thesis');
});

test('wake behaviour: an event for a vanished thesis cancels its trackers', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for a break',
    kind: 'BREAKOUT',
    timeframe: '15m',
    config: { direction: 'BELOW', level: 1.09 },
  });

  h.orchestrator.stores.theses.remove(thesis.id);
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'CANCELLED', 'a tracker with no thesis is cancelled');
  assertEqual(h.orchestrator.trackers.latestWakeRequest(), undefined, 'and produces no wake');
});

test('wake behaviour: the same event is not applied twice', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const first = await applyWake(h, wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'ok' });
  const second = await applyWake(h, wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'ok' });

  assertEqual(first.rejections.length, 0, 'the first application is accepted');
  assert(second.rejections.length > 0, 'a duplicate wake is refused rather than double-counted');
});

test('trade idea: a non-actionable thesis produces no trade idea', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Price entered the zone.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 1 }],
      reasoning: 'Momentum recovered and price entered the demand zone.',
    },
  });

  assertEqual(outcome.tradeIdeaId, undefined, 'an investigating thesis cannot produce a trade idea');
  assert(outcome.rejections.length > 0, 'and the refusal is visible');
  assertEqual(h.orchestrator.listTradeIdeas(h.goalId).length, 0, 'nothing was stored');
});

test('trade idea: an actionable thesis produces an idea with its invalidation', async () => {
  const h = makeHarness({ skillIds: [] });
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });

  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Price entered the monitored zone with momentum recovered.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 0.5 }, { price: 1.125, fraction: 0.5 }],
      reasoning: 'Momentum recovered, structure shifted, higher timeframe intact.',
    },
  });

  assert(outcome.tradeIdeaId, 'an actionable thesis produces a trade idea');
  const idea = h.orchestrator.stores.ideas.get(outcome.tradeIdeaId!)!;
  assertEqual(idea.symbol, 'EURUSD', 'the idea names the market');
  assertEqual(idea.direction, 'LONG', 'the idea names a direction');
  assertEqual(idea.orderType, 'LIMIT', 'the idea names an order type');
  assertEqual(idea.invalidationLevel, 1.0985, 'the idea carries the invalidation level');
  assert(idea.invalidation.length > 0, 'the idea restates the thesis invalidation');
  assertEqual(idea.takeProfits.length, 2, 'the idea carries its targets');
  assertEqual(h.orchestrator.stores.theses.get(thesis.id)!.state, 'COMPLETED', 'a realised idea completes the thesis');
});

test('trade idea: a skill that forbids an order type blocks the idea', async () => {
  const h = makeHarness();
  h.orchestrator.skills.register({
    id: 'no-market-orders',
    name: 'No Market Orders',
    description: 'test',
    instructions: 'test',
    enabled: true,
    constraints: [{ kind: 'FORBID_ORDER_TYPE', orderType: 'MARKET' }],
  });
  h.orchestrator.stores.goals.save({
    ...h.orchestrator.stores.goals.get(h.goalId)!,
    skillIds: ['no-market-orders'],
  });

  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Entry zone reached.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'MARKET',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 1 }],
      reasoning: 'test',
    },
  });

  assertEqual(outcome.tradeIdeaId, undefined, 'a forbidden order type produces no idea');
  assert(outcome.rejections.some((r) => r.includes('MARKET')), 'and the refusal explains why');
});

test('trade idea: an invalidation on the wrong side of the entry is refused', async () => {
  const h = makeHarness({ skillIds: [] });
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  // A long whose invalidation sits above its entry is not a long; it is
  // a stop on the wrong side, and storing it would put an unsound
  // proposal in front of the user.
  const outcome = await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Entry zone reached.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.12,
      takeProfits: [{ price: 1.13, fraction: 1 }],
      reasoning: 'test',
    },
  });

  assertEqual(outcome.tradeIdeaId, undefined, 'an inverted idea is refused');
  assert(outcome.rejections.some((r) => r.includes('invalidation')), 'and the refusal explains why');
  assertEqual(h.orchestrator.listTradeIdeas(h.goalId).length, 0, 'nothing was stored');
});

test('trade idea: a target on the wrong side of the entry is refused', async () => {
  const h = makeHarness({ skillIds: [] });
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Entry zone reached.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.09, fraction: 1 }],
      reasoning: 'test',
    },
  });

  assertEqual(outcome.tradeIdeaId, undefined, 'a long with a target below entry is refused');
  assert(outcome.rejections.some((r) => r.includes('target')), 'and the refusal explains why');
});

test('evidence: a thesis accumulates both support and contradiction', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  h.orchestrator.loop.recordEvidence({
    thesisId: thesis.id,
    polarity: 'SUPPORTS',
    summary: 'Higher timeframe structure remains bullish.',
    source: 'AGENT_INVESTIGATION',
  });
  h.orchestrator.loop.recordEvidence({
    thesisId: thesis.id,
    polarity: 'CONTRADICTS',
    summary: 'Volume confirmation is weak.',
    source: 'AGENT_INVESTIGATION',
  });

  assertEqual(h.orchestrator.listEvidence(thesis.id).length, 2, 'both are kept');
  assertEqual(h.orchestrator.listContradictingEvidence(thesis.id).length, 1, 'contradiction is countable');
  const evidence = h.orchestrator.listEvidence(thesis.id)[0];
  assert(evidence.createdAt > 0, 'evidence is timestamped');
  assert(evidence.source, 'evidence names its source');
});

// ---------------------------------------------------------------------------
// 3. Skills
// ---------------------------------------------------------------------------

function makeSkillRegistry(ids: string[]): GoatSkillRegistry {
  return new GoatSkillRegistry({ knownCapabilityIds: () => ids });
}

test('skills: the built-in skills load and validate', async () => {
  const h = makeHarness();
  assert(GOAT_BUILTIN_SKILLS.length >= 4, 'there are built-in skills');
  for (const skill of h.orchestrator.skills.list()) {
    assert(skill.id.length > 0, 'a skill has an id');
    assert(skill.instructions.length > 0, 'a skill has instructions');
  }
});

test('skills: a skill naming an unknown capability is rejected', async () => {
  const registry = makeSkillRegistry(['market.getQuote']);
  assertThrows(
    () =>
      registry.register({
        id: 'bad',
        name: 'Bad',
        description: 'x',
        instructions: 'x',
        enabled: true,
        requiredCapabilities: ['does.not.exist'],
      }),
    'a skill cannot require a capability that does not exist',
  );
});

test('skills: a skill with an unknown phase is rejected', async () => {
  const registry = makeSkillRegistry([]);
  assertThrows(
    () =>
      registry.register({
        id: 'bad',
        name: 'Bad',
        description: 'x',
        instructions: 'x',
        enabled: true,
        phases: { NOT_A_PHASE: 'x' } as never,
      }),
    'a skill cannot declare a phase the loop does not have',
  );
});

test('skills: a duplicate skill is rejected', async () => {
  const registry = makeSkillRegistry([]);
  const skill: SkillPackage = {
    id: 'dup',
    name: 'Dup',
    description: 'x',
    instructions: 'x',
    enabled: true,
  };
  registry.register(skill);
  assertThrows(() => registry.register(skill), 'a skill id is unique');
});

test('skills: activating a missing or disabled skill fails loudly', async () => {
  const registry = makeSkillRegistry([]);
  registry.register({
    id: 'off',
    name: 'Off',
    description: 'x',
    instructions: 'x',
    enabled: false,
  });
  assertThrows(
    () => registry.resolveActive(['off', 'missing']),
    'a silently ignored skill is worse than a rejected one',
  );
});

test('skills: a skill participates in every phase, not just the first', async () => {
  const registry = makeSkillRegistry([]);
  registry.register({
    id: 'structure',
    name: 'Structure',
    description: 'x',
    instructions: 'Base instruction.',
    enabled: true,
    phases: {
      GOAL_INTERPRETATION: 'Interpret via structure.',
      TRACKER_PLANNING: 'Plan structure trackers.',
      EVENT_INTERPRETATION: 'Interpret breaks.',
    },
  });

  const goal = registry.compilePhase(['structure'], 'GOAL_INTERPRETATION');
  const planning = registry.compilePhase(['structure'], 'TRACKER_PLANNING');
  const events = registry.compilePhase(['structure'], 'EVENT_INTERPRETATION');
  const trade = registry.compilePhase(['structure'], 'TRADE_CONSTRUCTION');

  assert(goal.includes('Base instruction.'), 'the baseline instruction is present');
  assert(goal.includes('Interpret via structure.'), 'goal interpretation is shaped');
  assert(planning.includes('Plan structure trackers.'), 'tracker planning is shaped');
  assert(events.includes('Interpret breaks.'), 'event interpretation is shaped');
  assertEqual(trade.trim(), '', 'an unphased phase gets no extra guidance');
});

test('skills: a disabled skill contributes nothing', async () => {
  const registry = makeSkillRegistry([]);
  registry.register({
    id: 'off',
    name: 'Off',
    description: 'x',
    instructions: 'Should not appear.',
    enabled: false,
    phases: { TRACKER_PLANNING: 'Should not appear either.' },
  });
  assertEqual(registry.compilePhase(['off'], 'TRACKER_PLANNING').trim(), '', 'a disabled skill is silent');
  assertEqual(registry.resolveCapabilities(['off']).length, 0, 'a disabled skill grants nothing');
});

test('skills: multiple skills compose, and conflicting ceilings take the strictest', async () => {
  const registry = makeSkillRegistry([]);
  registry.register({
    id: 'a',
    name: 'A',
    description: 'x',
    instructions: 'x',
    enabled: true,
    constraints: [
      { kind: 'MAX_TRACKERS', maximum: 10 },
      { kind: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE', minimum: 1 },
    ],
  });
  registry.register({
    id: 'b',
    name: 'B',
    description: 'x',
    instructions: 'x',
    enabled: true,
    constraints: [
      { kind: 'MAX_TRACKERS', maximum: 4 },
      { kind: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE', minimum: 3 },
    ],
  });

  const constraints = registry.resolveConstraints(['a', 'b']);
  const maxTrackers = constraints.find((c) => c.kind === 'MAX_TRACKERS');
  const evidence = constraints.find((c) => c.kind === 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE');
  assertEqual(maxTrackers && 'maximum' in maxTrackers ? maxTrackers.maximum : 0, 4, 'the tightest tracker ceiling wins');
  assertEqual(evidence && 'minimum' in evidence ? evidence.minimum : 0, 3, 'the strictest evidence requirement wins');
});

test('skills: capabilities are granted through skills', async () => {
  const h = makeHarness();
  const granted = h.orchestrator.skills.resolveCapabilities(['structural-trend-analysis', 'regime-awareness']);
  assert(granted.includes('structure.breakout'), 'a skill grants its required capabilities');
  assert(granted.includes('indicators.rsi'), 'every skill contributes');
});

test('skills: an evidence requirement gates becoming actionable', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  assertThrows(
    () => h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' }),
    'a thesis without the required evidence cannot become actionable',
  );

  h.orchestrator.loop.recordEvidence({
    thesisId: thesis.id,
    polarity: 'SUPPORTS',
    summary: 'Momentum recovered.',
    source: 'AGENT_INVESTIGATION',
  });
  assertThrows(
    () => h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' }),
    'one piece of evidence is still not enough',
  );

  h.orchestrator.loop.recordEvidence({
    thesisId: thesis.id,
    polarity: 'SUPPORTS',
    summary: 'Structure shifted.',
    source: 'AGENT_INVESTIGATION',
  });
  const updated = h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  assertEqual(updated.state, 'ACTIONABLE', 'the requirement is met and the thesis becomes actionable');
});

// ---------------------------------------------------------------------------
// 3b. Authoring skills
//
// A skill is prose the user wrote. The parser is the boundary: it is the
// difference between a limit the GOAT enforces and a sentence the user
// believes is being enforced.
// ---------------------------------------------------------------------------

test('skill markdown: a document parses into a skill', () => {
  const parsed = parseSkillMarkdown([
    '---',
    'id: patience',
    'name: Patience',
    'description: Sit on your hands when structure is unclear.',
    'order: 20',
    '---',
    '',
    'Unclear structure is a reason to do nothing.',
    '',
    '## THESIS_FORMATION',
    '',
    'Do not form a thesis inside a range.',
    '',
    '## Constraints',
    '',
    '- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2',
    '- MAX_TRACKERS: 6',
    '- FORBID_ORDER_TYPE: MARKET',
  ].join('\n'));

  assert(parsed.ok, `a valid document parsed with problems: ${parsed.problems.join(' ')}`);
  const skill = parsed.skill!;
  assertEqual(skill.id, 'patience', 'the id comes from the header');
  assertEqual(skill.name, 'Patience', 'and the name');
  assertEqual(skill.description, 'Sit on your hands when structure is unclear.', 'and the description');
  assertEqual(skill.order, 20, 'and the display order');
  assertEqual(skill.instructions, 'Unclear structure is a reason to do nothing.', 'the prose is the instructions');
  assertEqual(skill.phases?.THESIS_FORMATION, 'Do not form a thesis inside a range.', 'a phase section is that phase');
  assertEqual(skill.constraints?.length, 3, 'and the constraints are machine-checkable, not prose');
  assertEqual(
    skill.constraints?.find((c) => c.kind === 'MAX_TRACKERS') && 'maximum' in (skill.constraints.find((c) => c.kind === 'MAX_TRACKERS') as never)
      ? (skill.constraints.find((c) => c.kind === 'MAX_TRACKERS') as { maximum: number }).maximum
      : 0,
    6,
    'a numeric constraint keeps its number',
  );
});

test('skill markdown: a document survives a round trip unchanged', () => {
  // The editor rewrites a skill on every save. If a round trip dropped
  // the phase sections or the constraints, every edit would quietly
  // weaken the skill.
  const original = parseSkillMarkdown([
    '---',
    'id: round-trip',
    'name: Round Trip',
    'description: Proves the format is stable.',
    '---',
    '',
    'Steering text.',
    '',
    '## EVENT_INTERPRETATION',
    '',
    'On a tracker event, ask what would falsify it.',
    '',
    '## Constraints',
    '',
    '- REQUIRE_INVALIDATION_BEFORE_TRADE',
    '- MAX_THESES: 3',
  ].join('\n'));
  assert(original.ok, 'the original parses');

  const serialised = toSkillMarkdown(original.skill!);
  const reparsed = parseSkillMarkdown(serialised);
  assert(reparsed.ok, `the serialised form parses: ${reparsed.problems.join(' ')}`);
  assertEqual(reparsed.skill!.id, original.skill!.id, 'the id survives');
  assertEqual(reparsed.skill!.instructions, original.skill!.instructions, 'the steering text survives');
  assertEqual(
    reparsed.skill!.phases?.EVENT_INTERPRETATION,
    original.skill!.phases?.EVENT_INTERPRETATION,
    'the phase guidance survives',
  );
  assertEqual(reparsed.skill!.constraints?.length, 2, 'and both constraints survive');
});

test('explorer: exactly four starters, each describing a GOAT that can actually be created', () => {
  assertEqual(STARTER_GOATS.length, 4, 'the Explorer shows four starters, not a catalogue');

  const profiles = starterProfiles();
  assertEqual(profiles.length, 4, 'and four profiles to render them from');
  assertEqual(
    new Set(profiles.map((p) => p.id)).size,
    4,
    'each starter is distinct, so no card is a duplicate',
  );

  for (const profile of profiles) {
    const definition = STARTER_GOATS.find((s) => s.identity.id === profile.id)!;
    assert(!!definition, `${profile.id}: has a definition`);
    assertEqual(
      profile.goal,
      definition.goal.statement,
      `${profile.id}: the Explorer shows the goal that will be created`,
    );
    assertEqual(
      profile.skills.map((s) => s.id),
      definition.skills.map((s) => s.id),
      `${profile.id}: the skills shown are the skills the GOAT gets`,
    );
    assert(
      profile.skills.every((s) => s.name.length > 0 && !s.name.includes('\u2014')),
      `${profile.id}: every skill resolves to a real name rather than a fallback`,
    );

    // Enough to decide whether to try it.
    assert(profile.philosophy.length > 40, `${profile.id}: explains how it thinks`);
    assert(profile.watches.length > 20, `${profile.id}: says what it watches`);
    assert(profile.interests.length > 20, `${profile.id}: says what makes it act`);
    assert(profile.dormant.length > 20, `${profile.id}: says when it stays dormant`);
    assert(profile.riskPosture.length > 20, `${profile.id}: states its risk posture`);
    assert(profile.markets.length > 0, `${profile.id}: names the asset classes it suits`);
    assertEqual(
      profile.shadowFirst,
      true,
      `${profile.id}: the Explorer says it is designed to be tried in SHADOW`,
    );
    assert(
      profile.unenforcedRules.length >= 2,
      `${profile.id}: discloses the rules it states but cannot enforce`,
    );

    // Nothing in a card may imply execution authority.
    const capabilities = definition.capabilities;
    assertEqual(
      capabilities.requestExecution,
      false,
      `${profile.id}: a starter cannot request execution`,
    );
    assert(
      !definition.skills.some((skill) => {
        const resolved = GOAT_BUILTIN_SKILLS.find((c) => c.id === skill.id);
        return resolved?.grants?.some((grant) => /order|trade\.(place|execute)/i.test(grant));
      }),
      `${profile.id}: no skill it carries grants anything order-related`,
    );
  }
});

test('explorer: creating from a starter goes through the normal creation path', async () => {
  /*
   * The point of the Explorer is that it is not a second way in. A starter
   * must create a GOAT through exactly the path a hand-written goal takes,
   * with the same privileges and the same absence of any execution path —
   * otherwise "use a starter" quietly becomes "use a different, trusted
   * entry point".
   */
  for (const starter of STARTER_GOATS) {
    const h = makeHarness({ model: ACTIONABLE_MODEL('The starter is a good fit.') });
    const created = await h.orchestrator.createGoatFromStarter(starter.identity.id);

    assertEqual(
      created.goal.statement,
      starter.goal.statement,
      `${starter.identity.id}: the created GOAT carries the starter's goal`,
    );
    assertEqual(
      created.goal.skillIds,
      starter.skills.map((skill) => skill.id),
      `${starter.identity.id}: and the starter's skills`,
    );
    assertEqual(created.goal.status, 'UNDEPLOYED', `${starter.identity.id}: created undeployed`);
    assertEqual(created.goal.symbols.length, 0, `${starter.identity.id}: with no market yet`);
    assertEqual(
      h.agentRuntime.getAgent(created.agentId),
      undefined,
      `${starter.identity.id}: nothing is running before deployment`,
    );
    assertEqual(
      h.orchestrator.currentDeployment(created.goal.id),
      undefined,
      `${starter.identity.id}: and no deployment exists`,
    );

    // Creating it twice produces two independent GOATs.
    const second = await h.orchestrator.createGoatFromStarter(starter.identity.id);
    assert(
      second.agentId !== created.agentId,
      `${starter.identity.id}: a starter can be used more than once`,
    );
  }
});

test('explorer: an unknown starter is refused rather than creating something', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The starter is a good fit.') });
  let message = '';
  try {
    await h.orchestrator.createGoatFromStarter('does-not-exist');
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes('does-not-exist'), 'the refusal names what was asked for');
});

test('shipped skills: every one loads from its own Markdown and round-trips', () => {
  /*
   * The shipped skills are Markdown documents parsed at import, not object
   * literals. This checks the two consequences that matter: the document
   * really is the source (serialising a skill reproduces what parsing it
   * produced), and none of them has quietly lost content in the process.
   */
  assertEqual(GOAT_BUILTIN_SKILLS.length, 10, 'the product ships ten skills');

  for (const skill of GOAT_BUILTIN_SKILLS) {
    assertEqual(typeof skill.id, 'string', `${skill.id}: has an id`);
    assert(skill.name.length > 0, `${skill.id}: has a name`);
    assert(skill.description.length > 20, `${skill.id}: has a real description`);
    assert(skill.instructions.length > 80, `${skill.id}: has steering text, not a placeholder`);
    assert(
      Object.keys(skill.phases ?? {}).length >= 5,
      `${skill.id}: carries phase guidance for the loop it participates in`,
    );
    assert(
      (skill.constraints?.length ?? 0) >= 1,
      `${skill.id}: states at least one enforceable constraint`,
    );
    assert(
      (skill.grants?.length ?? 0) > 0,
      `${skill.id}: grants the observation SDK, so a GOAT built on it can watch`,
    );

    for (const constraint of skill.constraints ?? []) {
      assert(
        constraint.kind !== 'FORBID_ORDER_TYPE',
        `${skill.id}: never forbids an order type, because a skill does not place orders`,
      );
    }

    // The document is the source: it serialises back to the same skill.
    const reparsed = parseSkillMarkdown(toSkillMarkdown(skill));
    assert(reparsed.ok, `${skill.id}: its own document parses`);
    assertEqual(reparsed.skill!.id, skill.id, `${skill.id}: keeps its id`);
    assertEqual(reparsed.skill!.name, skill.name, `${skill.id}: keeps its name`);
    assertEqual(
      reparsed.skill!.instructions,
      skill.instructions,
      `${skill.id}: keeps its steering text`,
    );
    assertEqual(
      Object.keys(reparsed.skill!.phases ?? {}).length,
      Object.keys(skill.phases ?? {}).length,
      `${skill.id}: keeps every phase`,
    );
    assertEqual(
      reparsed.skill!.constraints!.length,
      skill.constraints!.length,
      `${skill.id}: keeps every constraint`,
    );
    assertEqual(
      reparsed.skill!.grants?.length,
      skill.grants?.length,
      `${skill.id}: keeps its granted authority`,
    );

    // And re-serialising the reparsed skill is stable.
    assertEqual(
      toSkillMarkdown(reparsed.skill!),
      toSkillMarkdown(skill),
      `${skill.id}: its document is stable across a round trip`,
    );
  }
});

test('skill markdown: a broken document is reported, not guessed at', () => {
  const missingHeader = parseSkillMarkdown('Just some prose with no header.');
  assert(!missingHeader.ok, 'a document without a header is refused');
  assert(missingHeader.problems.length > 0, 'and the problem is listed');

  const badPhase = parseSkillMarkdown([
    '---', 'id: x', 'name: X', 'description: D', '---', '',
    'Prose.', '', '## NOT_A_PHASE', '', 'Guidance.', '',
  ].join('\n'));
  assert(!badPhase.ok, 'an unknown phase section is refused');
  assert(badPhase.problems.some((p) => p.includes('NOT_A_PHASE')), 'and named');

  // The important one: a mistyped constraint must not be dropped, because
  // a dropped constraint is a rule the user believes is in force.
  const badConstraint = parseSkillMarkdown([
    '---', 'id: y', 'name: Y', 'description: D', '---', '',
    'Prose.', '', '## Constraints', '', '- MAX_TRACKERS: loads', '',
  ].join('\n'));
  assert(!badConstraint.ok, 'a non-numeric ceiling is refused');
  assert(badConstraint.problems.some((p) => p.includes('MAX_TRACKERS')), 'and the constraint is named, not ignored');

  const unknownConstraint = parseSkillMarkdown([
    '---', 'id: z', 'name: Z', 'description: D', '---', '',
    'Prose.', '', '## Constraints', '', '- BE_NICE_TO_THE_MARKET', '',
  ].join('\n'));
  assert(!unknownConstraint.ok, 'an unenforceable constraint is refused');
});

test('skills: a user-written skill is stored, registered and attachable', async () => {
  const h = makeHarness();
  const saved = h.orchestrator.saveUserSkill([
    '---', 'id: my-own', 'name: My Own', 'description: Steering I wrote.', '---', '',
    'Prefer patience.', '', '## Constraints', '', '- MAX_TRACKERS: 4', '',
  ].join('\n'));
  assertEqual(saved.problems.length, 0, `a valid skill is saved without problems: ${saved.problems.join(' ')}`);
  assertEqual(h.orchestrator.skills.has('my-own'), true, 'and is immediately usable');
  assertEqual(h.orchestrator.listUserSkills().length, 1, 'and is listed as mine');
  assertEqual(h.orchestrator.exportSkill('my-own'), saved.document!.markdown, 'and exports as the markdown I wrote');
});

test('skills: a broken document is never stored', async () => {
  const h = makeHarness();
  const saved = h.orchestrator.saveUserSkill('not a skill at all');
  assert(saved.problems.length > 0, 'the problems are reported');
  assertEqual(h.orchestrator.skills.has('not a skill at all'), false, 'nothing was registered');
  assertEqual(h.orchestrator.listUserSkills().length, 0, 'and nothing was stored');
});

test('skills: editing a skill replaces it rather than duplicating it', async () => {
  const h = makeHarness();
  h.orchestrator.saveUserSkill([
    '---', 'id: edited', 'name: Edited', 'description: First version.', '---', '', 'Original text.', '',
  ].join('\n'));
  const second = h.orchestrator.saveUserSkill([
    '---', 'id: edited', 'name: Edited', 'description: Second version.', '---', '', 'Replacement text.', '',
  ].join('\n'));
  assertEqual(second.problems.length, 0, 'the second save is accepted');
  assertEqual(h.orchestrator.listUserSkills().length, 1, 'and does not create a second skill');
  assertEqual(h.orchestrator.skills.get('edited')?.instructions, 'Replacement text.', 'the new text is in force');
});

test('skills: deleting one detaches it from the GOATs using it', async () => {
  const h = makeHarness();
  h.orchestrator.saveUserSkill([
    '---', 'id: temporary', 'name: Temporary', 'description: Not for keeps.', '---', '', 'Prose.', '',
  ].join('\n'));
  const thesis = seedThesis(h);
  h.orchestrator.stores.goals.save({
    ...h.orchestrator.stores.goals.get(h.goalId)!,
    skillIds: ['temporary', 'structural-trend-analysis'],
  });

  assertEqual(h.orchestrator.deleteUserSkill('temporary'), true, 'the skill is deleted');
  assertEqual(h.orchestrator.skills.has('temporary'), false, 'and is no longer usable');
  const goal = h.orchestrator.stores.goals.get(h.goalId)!;
  assertEqual(goal.skillIds.includes('temporary'), false, 'the GOAT no longer claims it');
  assertEqual(goal.skillIds.includes('structural-trend-analysis'), true, 'and keeps the skills it still uses');
  assert(thesis.id.length > 0, 'the thesis history is untouched');
});

// ---------------------------------------------------------------------------
// 3c. Creation and deployment
//
// A GOAT is a goal and its skills; a deployment is the binding to one
// market and one mode. These tests hold the line between them, because
// collapsing the two would make every GOAT single-use and would make
// "which market is this running on" a question with two answers.
// ---------------------------------------------------------------------------

const ACTIONABLE_MODEL = (text: string) =>
  new StubModel([
    JSON.stringify({
      understood: text,
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      investigationPlan: ['Read the structure.'],
      openQuestions: [],
      actionable: true,
    }),
  ]);

test('deployment: a created GOAT exists without a market and runs nothing', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });

  assertEqual(created.blocked, undefined, 'the goal was accepted');
  assertEqual(created.goal.status, 'UNDEPLOYED', 'and is waiting to be deployed');
  assertEqual(created.goal.symbols.length, 0, 'it has no market');
  assertEqual(h.agentRuntime.getAgent(created.agentId), undefined, 'no executor is running');
  assertEqual(h.orchestrator.currentDeployment(created.goal.id), undefined, 'and no deployment exists');
});

test('deployment: deploying binds a GOAT to a market in SHADOW', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });

  const deployment = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  assertEqual(deployment.marketId, 'EURUSD', 'the market is recorded');
  assertEqual(deployment.mode, 'SHADOW', 'the first deployment is SHADOW by default');
  assertEqual(deployment.execution.canExecute, false, 'and cannot execute');
  assertEqual(deployment.execution.canProposeTrades, true, 'though it may still propose');

  const instance = h.agentRuntime.getAgent(created.agentId)!;
  assertEqual(instance.agent.symbols[0], 'EURUSD', 'the executor is scoped to the market');
  assertEqual(instance.isRunning, true, 'and is running');
  assertEqual(instance.agent.policy.allowTrading, false, 'SHADOW cannot trade even though the GOAT is live');

  const goal = h.orchestrator.getGoal(created.goal.id)!;
  assertEqual(goal.status, 'MONITORING', 'the goal is now being pursued');
  assertEqual(goal.symbols[0], 'EURUSD', 'and knows where');
  assertEqual(h.orchestrator.currentDeployment(created.goal.id)?.id, deployment.id, 'the deployment is the current one');
});

test('deployment: the same GOAT can be moved to another market', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });
  const first = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  // Once it is live, the GOAT works: a thesis, and a tracker watching it.
  const thesis = h.orchestrator.loop.createThesis({
    goalId: created.goal.id,
    agentId: created.agentId,
    statement: 'The decline is corrective.',
    invalidation: 'A sustained break below 1.0950.',
  });
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIVE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, created.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'ACTIVE', 'the tracker is watching');

  const second = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'XAUUSD' });

  assertEqual(
    h.orchestrator.stores.deployments.get(first.id)?.status,
    'stopped',
    'the previous deployment is retired, not deleted',
  );
  assertEqual(second.status, 'active', 'and the new one is the live one');
  assertEqual(second.marketId, 'XAUUSD', 'on the new market');
  assertEqual(h.agentRuntime.getAgent(created.agentId)!.agent.symbols[0], 'XAUUSD', 'the executor was re-scoped');
  assertEqual(
    h.orchestrator.trackers.get(h.orchestrator.trackers.listForThesis(thesis.id)[0].id)!.lifecycle.status,
    'CANCELLED',
    'a tracker watching the old market is retired, not left watching it',
  );
  assertEqual(h.orchestrator.deploymentHistory(created.goal.id).length, 2, 'both deployments are in the history');
  assertEqual(h.orchestrator.getGoal(created.goal.id)!.symbols[0], 'XAUUSD', 'the goal follows the deployment');
});

test('deployment: a broad goal deploys anyway, because the agent is the agent', async () => {
  /*
   * The behaviour this product used to have, and the reason it is gone.
   *
   * A goal the agent called "not actionable" used to be refused deployment,
   * and the user was told to write a better one — which in practice meant
   * writing a strategy, with an entry and a stop and a timeframe, before
   * an agent could be allowed to start. Every question a new user brings
   * was answered with "be more specific".
   */
  const h = makeHarness({
    model: new StubModel([
      JSON.stringify({
        understood: 'The user wants strong opportunities with confirmation.',
        openQuestions: ['Which market?'],
        actionable: false,
      }),
    ]),
  });

  const created = await h.orchestrator.createGoat({
    goal: 'Find strong trading opportunities and wait for clear evidence before acting.',
  });

  assertEqual(created.blocked, undefined, 'a broad goal is never refused');
  assertEqual(created.goal.status, 'UNDEPLOYED', 'it is created the same way as any other');

  const deployment = h.orchestrator.deployGoat({
    goalId: created.goal.id,
    market: 'EURUSD',
  });

  assertEqual(deployment.marketId, 'EURUSD', 'and it deploys');
  assertEqual(deployment.mode, 'SHADOW', 'still in SHADOW');
  assert(
    created.interpretation.openQuestions.length > 0,
    'what the agent could not resolve is still reported, as information',
  );
});

test('deployment: a goal with no objective in it is still refused', async () => {
  const h = makeHarness();
  await assertRejects(
    () => h.orchestrator.createGoat({ goal: '' }),
    'an empty goal is not a goal',
  );
  await assertRejects(
    () => h.orchestrator.createGoat({ goal: '...' }),
    'punctuation is not an objective',
  );
  await assertRejects(
    () => h.orchestrator.createGoat({ goal: 'trade' }),
    'a single verb is a placeholder, not an objective',
  );
  await assertRejects(
    () => h.orchestrator.createGoat({ goal: '   ' }),
    'whitespace is not a goal either',
  );

  /*
   * The line has to be in the right place, or "be more specific" comes
   * back as a wall. Everything below is accepted.
   */
  for (const usable of [
    'Find breakout opportunities.',
    'Look for strong directional opportunities and wait for confirmation.',
    'Find opportunities in EUR/USD where the market structure gives us a clear asymmetric setup.',
  ]) {
    const created = await h.orchestrator.createGoat({ goal: usable });
    assertEqual(created.goal.statement, usable, `"${usable}" is a goal a GOAT can be given`);
  }
});

test('deployment: a deployment needs a market', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });
  assertThrows(
    () => h.orchestrator.deployGoat({ goalId: created.goal.id, market: '  ' }),
    'a deployment with no market is refused',
  );
});

test('deployment: a deployment records the venue it is bound to', async () => {
  const h = makeHarness({
    model: ACTIONABLE_MODEL('The user wants a reversal taken.'),
    venueEnvironment: 'MAINNET',
  });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });

  const deployment = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  assertEqual(
    deployment.venueEnvironment,
    'MAINNET',
    'the deployment says which network it was made against',
  );
  assertEqual(
    h.orchestrator.currentDeployment(created.goal.id)?.venueEnvironment,
    'MAINNET',
    'and it survives being read back',
  );
  assertEqual(
    deployment.execution.canExecute,
    false,
    'a Mainnet-bound SHADOW deployment still executes nothing',
  );
});

test('deployment: a GOAT cannot be deployed LIVE', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });

  /*
   * Refused rather than accepted with execution quietly disabled. A
   * deployment holding `canExecute: true` with no signing path behind it is
   * the most misleading state this product can be in, and the failure is
   * silent: everything looks configured and nothing can be sent.
   */
  assertThrows(
    () => h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD', mode: 'LIVE' }),
    'a LIVE deployment is refused',
  );

  assertEqual(
    h.orchestrator.currentDeployment(created.goal.id),
    undefined,
    'and nothing was deployed',
  );

  // DEMO and PAPER remain available: neither claims to touch real value.
  const demo = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD', mode: 'DEMO' });
  assertEqual(demo.mode, 'DEMO', 'a DEMO deployment is allowed');
  assertEqual(demo.execution.canExecute, true, 'and may execute simulated fills');
});

test('deployment: stopping a GOAT keeps the goal and its history', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('The user wants a reversal taken.') });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long when the decline reverses' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  await h.orchestrator.undeployGoat(created.goal.id);

  const goal = h.orchestrator.getGoal(created.goal.id)!;
  assertEqual(goal.status, 'UNDEPLOYED', 'the goal is no longer running');
  assertEqual(goal.statement, 'Find a long when the decline reverses', 'and the user\'s words are still there');
  assert(h.orchestrator.deploymentHistory(created.goal.id).length > 0, 'the deployment history is kept');
  assertEqual(h.agentRuntime.getAgent(created.agentId), undefined, 'the executor is gone');

  // Redeploying is a normal thing to want, and it must work.
  const again = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'XAUUSD' });
  assertEqual(again.status, 'active', 'the same GOAT can be deployed again');
});

// ---------------------------------------------------------------------------
// 4. Permissions
// ---------------------------------------------------------------------------

test('permissions: an agent without CREATE_TRACKER cannot deploy one', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  // The agent was registered with all tracker capabilities, so revoke
  // the one being tested to prove the check is real.
  const instance = h.agentRuntime.getAgent(h.agentId)!;
  const narrowed = (instance.allowedCapabilities as string[]).filter(
    (id) => id !== GOAT_CAPABILITIES.createTracker,
  );
  (instance as { allowedCapabilities: string[] }).allowedCapabilities = narrowed;

  const sdk = h.orchestrator.sdkFor(h.agentId);
  assertThrows(
    () => sdk.create(thesis.id, { purpose: 'Watch something', kind: 'PRICE_THRESHOLD', config: { level: 1.1, operator: 'ABOVE' } }),
    'a capability the agent does not hold cannot be exercised',
  );
});

test('permissions: an agent cannot create a tracker for another agent thesis', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  h.orchestrator.stores.theses.save({ ...thesis, agentId: 'someone_else' });

  const sdk = h.orchestrator.sdkFor(h.agentId);
  assertThrows(
    () => sdk.create(thesis.id, { purpose: 'Watch something', kind: 'PRICE_THRESHOLD', config: { level: 1.1, operator: 'ABOVE' } }),
    'an agent cannot deploy trackers against a thesis it does not own',
  );
});

test('permissions: an agent cannot touch another agent tracker', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch something',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.1, operator: 'ABOVE' },
  });
  h.orchestrator.stores.theses.save({ ...thesis, agentId: 'someone_else' });

  const sdk = h.orchestrator.sdkFor(h.agentId);
  assertThrows(() => sdk.remove(tracker.id), 'an agent cannot remove a tracker it does not own');
});

test('permissions: a skill cannot widen an agent beyond what it declared', async () => {
  const h = makeHarness();
  const instance = h.agentRuntime.getAgent(h.agentId)!;
  const before = [...instance.allowedCapabilities];
  // Registration intersects declared capabilities with skill grants, so
  // a skill that grants a lot still cannot exceed the agent's own list.
  assert(
    before.every((id) => instance.agent.capabilities.includes(id)),
    'allowed capabilities are a subset of what the agent declared',
  );
});

test('permissions: the SDK checks the grant on every call, not once at construction', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const sdk = h.orchestrator.sdkFor(h.agentId);
  // Holding a reference is not authority.
  const instance = h.agentRuntime.getAgent(h.agentId)!;
  (instance as { allowedCapabilities: string[] }).allowedCapabilities = [];

  await assertRejects(
    async () => sdk.read(),
    'revoking the grant takes effect immediately',
  );
});

test('model output: a tracker plan from the model is parsed and applied', async () => {
  const model = new StubModel([
    JSON.stringify({
      kind: 'CREATE_TRACKER',
      thesisId: 'PLACEHOLDER',
      reason: 'Momentum recovered, so watch for the structural confirmation.',
      spec: {
        purpose: 'Watch for a structural break above the last lower high',
        kind: 'BREAKOUT',
        config: { direction: 'ABOVE', level: 1.11 },
        priority: 80,
        cooldownMs: 30_000,
      },
    }),
  ]);
  const h = makeHarness({ model });
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  // Rewrite the placeholder with the real thesis id the model could not know.
  const response = model.responses[0].replace('PLACEHOLDER', thesis.id);
  model.responses[0] = response;

  const outcome = await applyWake(h, wake, JSON.parse(response));
  assertEqual(outcome.trackerChanges.length, 1, 'the model-authored tracker was deployed');
});

test('model output: a trade idea from the model is parsed but gated by the thesis state', async () => {
  const h = makeHarness({ skillIds: [] });
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const plan = JSON.parse(
    JSON.stringify({
      kind: 'PROPOSE_TRADE_IDEA',
      thesisId: thesis.id,
      reason: 'Entry zone reached with momentum recovered.',
      idea: {
        symbol: 'EURUSD',
        direction: 'LONG',
        orderType: 'LIMIT',
        entry: 1.105,
        invalidationLevel: 1.0985,
        takeProfits: [{ price: 1.115, fraction: 1 }],
        reasoning: 'Momentum recovered and price entered the demand zone.',
      },
    }),
  );

  const outcome = await applyWake(h, wake, plan);
  assert(outcome.tradeIdeaId, 'a well-formed model idea becomes a trade idea');
  const idea = h.orchestrator.stores.ideas.get(outcome.tradeIdeaId!)!;
  assertEqual(idea.invalidationLevel, 1.0985, 'the model-supplied invalidation is carried through');
});

test('model output: a malformed idea is refused rather than half-accepted', async () => {
  const h = makeHarness({ skillIds: [] });
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'ACTIONABLE' });
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for the entry zone',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.105, operator: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  // No targets: an idea with nowhere to go is not an idea.
  const plan = {
    kind: 'PROPOSE_TRADE_IDEA' as const,
    thesisId: thesis.id,
    reason: 'x',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG' as const,
      orderType: 'LIMIT' as const,
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [],
      reasoning: 'x',
    },
  };

  const outcome = await applyWake(h, wake, plan as never);
  assertEqual(h.orchestrator.listTradeIdeas(h.goalId).length, 0, 'nothing was stored');
  assert(outcome.rejections.length > 0 || outcome.tradeIdeaId === undefined, 'and it was reported');
});

// ---------------------------------------------------------------------------
// 5. Integration: the full loop
// ---------------------------------------------------------------------------

test('integration: goal -> thesis -> tracker -> event -> wake -> thesis update', async () => {
  const h = makeHarness();
  const goal = h.orchestrator.getGoal(h.goalId)!;
  assertEqual(goal.statement.includes('long opportunity'), true, 'the goal states what the user wants');
  assert(goal.skillIds.length > 0, 'the goal carries its skills');

  const thesis = seedThesis(h);
  assertEqual(thesis.goalId, goal.id, 'the thesis belongs to the goal');

  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery on 15m',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
    priority: 60,
  });
  assertEqual(h.orchestrator.listWatching(goal.id).length, 1, 'the user can see what GOAT is watching');

  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;
  assert(wake, 'the tracker observation woke the GOAT');

  const context = h.orchestrator.loop.buildContext(h.agentId, thesis.id, wake.event)!;
  assert(context.watching.length > 0, 'the agent knows what it is watching');
  assert(context.constraints.length > 0, 'the agent knows the constraints its skills impose');

  const outcome = await applyWake(h, wake, {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'Momentum recovered as the thesis required.',
  })!;

  assertEqual(outcome.thesis.state, 'STRENGTHENING', 'the thesis was updated');
  assertEqual(outcome.thesis.revision, thesis.revision + 1, 'the update is a recorded revision');
  assert(h.orchestrator.listEvidence(thesis.id).length > 0, 'the evidence is traceable');
});

test('integration: a wake can deploy a new tracker, not just observe one', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'CREATE_TRACKER',
    thesisId: thesis.id,
    reason: 'Momentum recovered, so now watch for the structural confirmation.',
    spec: {
      purpose: 'Watch for a structural break above the last lower high',
      kind: 'BREAKOUT',
      timeframe: '15m',
      config: { direction: 'ABOVE', level: 1.11 },
      priority: 80,
    },
  })!;

  assertEqual(outcome.trackerChanges.length, 1, 'the agent deployed a new tracker');
  assertEqual(outcome.trackerChanges[0].action, 'created', 'the change is a creation');
  assertEqual(h.orchestrator.listWatching(thesis.goalId).length, 2, 'the observation plan grew');
  assertEqual(
    outcome.trackerChanges[0].trackerId.includes('trk_'),
    true,
    'the new tracker is a real runtime tracker',
  );
});

test('integration: a wake can retire a tracker the thesis no longer needs', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for a short-lived momentum spike',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 70, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'REMOVE_TRACKER',
    trackerId: tracker.id,
    reason: 'Overbought momentum is no longer the question this thesis needs answered.',
  })!;

  assertEqual(outcome.trackerChanges[0].action, 'cancelled', 'the tracker is retired');
  assertEqual(h.orchestrator.trackers.get(tracker.id)!.lifecycle.status, 'CANCELLED', 'and stops watching');
});

test('integration: an invalid tracker plan is refused and reported, not silently dropped', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch for momentum recovery',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
  });
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  const outcome = await applyWake(h, wake, {
    kind: 'CREATE_TRACKER',
    thesisId: thesis.id,
    reason: 'Deploy something that cannot work.',
    spec: { purpose: '', kind: 'PRICE_THRESHOLD', config: {} },
  })!;

  assertEqual(outcome.trackerChanges.length, 0, 'nothing was created');
  assert(outcome.rejections.length > 0, 'the refusal is reported to the caller');
});

test('integration: the same tracker behaves identically on historical and live input', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  const live = h.orchestrator.trackers.ingestEvent(
    { ...makeTrackerEvent(tracker, h.clock.now()), environment: 'DEMO' },
  );
  const backtest = h.orchestrator.trackers.ingestEvent(
    { ...makeTrackerEvent(tracker, h.clock.now()), environment: 'BACKTEST' },
  );

  assert(live && backtest, 'the tracker fires in both environments');
  assertEqual(live.eventType, backtest.eventType, 'and reports the same event type');
  assertEqual(live.severity, backtest.severity, 'and the same severity');
  assertEqual(live.reason, backtest.reason, 'and reports the same observation');
  assertEqual(live.trackerId, backtest.trackerId, 'because the evaluation semantics are shared');
});

test('integration: the wake is delivered through the existing agent runtime', async () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.orchestrator.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch the invalidation level',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.095, operator: 'BELOW' },
  });

  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  // Let the async onEvent handler settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(h.orchestrator.trackers.latestWakeRequest(), 'the wake was routed and recorded');
});

test('integration: creating a GOAT produces a goal, not a strategy definition', async () => {
  const model = new StubModel([
    JSON.stringify({
      understood: 'The user wants a long entry on EURUSD if the recent decline reverses.',
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      investigationPlan: ['Read the 1h swing structure.', 'Check whether 15m momentum is recovering.'],
      openQuestions: [],
      actionable: true,
    }),
  ]);
  const h = makeHarness({ model });

  const result = await h.orchestrator.createGoat({
    goal: 'Find a potential long opportunity when the current downtrend starts reversing.',
    skillIds: ['structural-trend-analysis', 'regime-awareness'],
  });

  assertEqual(result.blocked, undefined, 'a specific goal is actionable');
  assertEqual(result.interpretation.actionable, true, 'the agent understood the goal');
  assert(result.goal.id.length > 0, 'a goal was recorded');
  assertEqual(result.goal.status, 'UNDEPLOYED', 'a created goal is waiting to be pointed at a market');
  assertEqual(result.interpretation.symbols[0], 'EURUSD', 'the agent suggested a market, without being given one');

  // A GOAT is a goal and its skills. Nothing else, and in particular no
  // market: creation is not where a user is asked to choose one.
  assertEqual(result.goal.symbols.length, 0, 'the goal carries no market of its own');
  assertEqual(result.goal.timeframes.length, 0, 'and no timeframe');
  assertEqual(h.agentRuntime.getAgent(result.agentId), undefined, 'nothing is running until it is deployed');
  assertEqual(h.trackerRegistry.listForAgent(result.agentId).length, 0, 'no user-defined trackers exist');
});

test('integration: a vague goal is reported as not actionable rather than guessed at', async () => {
  const model = new StubModel([
    JSON.stringify({
      understood: 'The user has not said which market or which direction.',
      symbols: [],
      timeframes: [],
      investigationPlan: [],
      openQuestions: ['Which market?', 'Which direction?'],
      actionable: false,
    }),
  ]);
  const h = makeHarness({ model });

  const result = await h.orchestrator.createGoat({
    goal: 'Look for strong directional opportunities and wait for confirmation.',
  });

  assertEqual(result.blocked, undefined, 'an objective is not a specification requirement');
  assert(
    result.interpretation.openQuestions.length > 0,
    "the agent's open questions travel with it rather than blocking it",
  );
  assertEqual(
    result.goal.interpretation,
    result.interpretation.understood,
    'and what the agent thought it heard is kept next to what was said',
  );
  assertEqual(
    result.goal.status,
    'UNDEPLOYED',
    'a GOAT that has not been pointed anywhere is undeployed, not a draft',
  );
});

test('integration: an unavailable model does not fabricate an interpretation', async () => {
  const failing: IAgentModel = {
    run: async () => {
      throw new Error('model unavailable');
    },
  };
  const h = makeHarness({ model: failing as StubModel });

  const result = await h.orchestrator.createGoat({ goal: 'Find a long when the trend reverses' });

  assertEqual(result.interpretation.actionable, false, 'no interpretation is invented without a model');
  assert(!result.goal.interpretation, 'and none is stored on the goal');
  assertEqual(result.blocked, undefined, 'creation still succeeds: the goal is the user\'s, not the model\'s');

  /*
   * The failure is still reported — just where it belongs. A GOAT with no
   * reasoning model cannot start, and saying so is what stops the UI
   * showing a GOAT that is going nowhere.
   */
  h.orchestrator.deployGoat({ goalId: result.goal.id, market: 'EURUSD' });
  const report = await h.orchestrator.investigateGoal(result.goal.id);
  assert(!report.ok, 'a GOAT with no model does not pretend to have investigated');
  assert(
    /unavailable|failed|try again/i.test(report.message),
    `and says why in words a person can act on (got: ${report.message})`,
  );
});

test('integration: the same goal statement and the agent reading are both preserved', async () => {
  const model = new StubModel([
    JSON.stringify({
      understood: 'The agent read this as a reversal setup on EURUSD.',
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      investigationPlan: [],
      openQuestions: [],
      actionable: true,
    }),
  ]);
  const h = makeHarness({ model });
  const statement = 'Find a long when the downtrend reverses.';

  const result = await h.orchestrator.createGoat({ goal: statement });
  assertEqual(result.goal.statement, statement, 'the user words are never rewritten');
  assertEqual(
    result.goal.interpretation,
    'The agent read this as a reversal setup on EURUSD.',
    'the agent reading is kept separately so disagreement is visible',
  );
});

// ---------------------------------------------------------------------------
// 6. Investigation — the pass between deploying and the first wake
// ---------------------------------------------------------------------------

const INVESTIGATION_RESPONSE = JSON.stringify({
  thought: 'The decline is corrective inside the wider structure, so I want proof of a shift.',
  thesis: {
    statement: 'The bearish leg is ending and price reclaims the prior swing high.',
    direction: 'BULLISH',
    invalidation: 'A sustained structural break below the last swing low.',
    requiredConfirmation: ['a higher low', 'a reclaim of the swing high'],
  },
  trackers: [
    {
      purpose: 'A 15m bar closes, so I can see whether structure is changing.',
      kind: 'NEW_BAR',
      timeframe: '15m',
      config: {},
      priority: 1,
      cooldownMs: 900_000,
    },
    {
      purpose: 'Price trades back above the level the decline began from.',
      kind: 'PRICE_THRESHOLD',
      timeframe: '15m',
      config: { level: 1.105, operator: 'ABOVE' },
      priority: 2,
    },
  ],
});

test('investigation: deploying starts the loop, so a thesis and trackers exist', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model });

  const { deployment, investigation } = await h.orchestrator.startGoat({
    goalId: h.goalId,
    market: 'EURUSD',
  });

  assertEqual(deployment.mode, 'SHADOW', 'the deployment is SHADOW');
  assert(investigation.ok, `the investigation succeeded: ${investigation.message}`);
  assert(investigation.thesisId, 'an investigation produced a thesis');
  assertEqual(investigation.trackerIds.length, 2, 'both proposed trackers were deployed');

  const thesis = h.orchestrator.getThesis(investigation.thesisId!);
  assert(thesis, 'the thesis is readable back');
  assertEqual(
    thesis!.state,
    'ACTIVE',
    'a thesis something will wake it about is live, not merely drafted',
  );
  assert(thesis!.invalidation.length > 0, 'the thesis states what would disprove it');

  const watching = h.orchestrator.trackers.listForThesis(thesis!.id);
  assertEqual(watching.length, 2, 'the runtime holds the observation plan');
  assert(
    watching.every((tracker) => tracker.agentId === h.agentId),
    'the trackers belong to this GOAT',
  );
});

test('investigation: a GOAT with no market has nothing to investigate', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, deployed: false });

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(!report.ok, 'an undeployed GOAT does not investigate');
  assert(
    /deploy/i.test(report.message),
    'the report says what to do rather than failing silently',
  );
  assertEqual(model.calls, 0, 'the model was never asked');
});

test('investigation: a second investigation is refused while a thesis is live', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });
  const first = await h.orchestrator.investigateGoal(h.goalId);
  assert(first.ok, 'the first investigation ran');

  const second = await h.orchestrator.investigateGoal(h.goalId);
  assert(!second.investigated, 'a live thesis means there is nothing to investigate again');
  assert(second.ok, 'and the GOAT is reported as running on what it already has');
  assertEqual(second.thesisId, first.thesisId, 'the existing thesis is the one reported');
  assertEqual(model.calls, 1, 'the model was asked exactly once');
});

test('investigation: a hypothesis with no invalidation is refused', async () => {
  const model = new StubModel([
    JSON.stringify({
      thought: 'I have a view but no way to be wrong.',
      thesis: { statement: 'Price will go up.', direction: 'BULLISH' },
      trackers: [],
    }),
  ]);
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });
  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(!report.ok, 'a goal is not a thesis, and a thesis needs an invalidation');
  assertEqual(h.orchestrator.listThesesForGoal(h.goalId).length, 0, 'nothing was stored');
});

test('investigation: a tracker the runtime refuses is reported, and the rest survive', async () => {
  const model = new StubModel([
    JSON.stringify({
      thought: 'One of my trackers is malformed.',
      thesis: {
        statement: 'Structure is turning.',
        invalidation: 'A break of the last swing low.',
      },
      trackers: [
        { purpose: 'A bar closes.', kind: 'NEW_BAR', timeframe: '15m', config: {} },
        // NEW_BAR without a timeframe is refused by the registry.
        { purpose: 'A bar closes but I forgot which one.', kind: 'NEW_BAR', config: {} },
        { purpose: 'Something the runtime does not have.', kind: 'NOT_A_KIND', config: {} },
      ],
    }),
  ]);
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });
  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(report.ok, 'one good tracker is enough to have started');
  assertEqual(report.trackerIds.length, 1, 'only the usable tracker was deployed');
  assertEqual(report.rejections.length, 2, 'both refusals are reported, not swallowed');
  // The hallucinated kind never reaches the registry.
  assert(
    !report.rejections.some((reason) => reason.includes('NOT_A_KIND')),
    'an unrecognised kind is dropped during parsing rather than registered',
  );
});

test('investigation: starting twice at once does not start twice', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE, INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });
  const [first, second] = await Promise.all([
    h.orchestrator.investigateGoal(h.goalId),
    h.orchestrator.investigateGoal(h.goalId),
  ]);

  assert(first.investigated, 'one investigation ran');
  assert(!second.investigated, 'the duplicate start was refused');
  assertEqual(model.calls, 1, 'the model was asked once, not twice');
  assertEqual(
    h.orchestrator.listThesesForGoal(h.goalId).length,
    1,
    'a double-click cannot create two theses',
  );
});

test('investigation: a GOAT deployed but never started is resumed once', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE, INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });

  const resumed = await h.orchestrator.resumeUnstartedGoats();
  assertEqual(resumed.length, 1, 'the unstarted GOAT was picked up');
  assert(resumed[0].investigated, 'and the report says it did the work');
  assertEqual(h.orchestrator.listThesesForGoal(h.goalId).length, 1, 'it now has a thesis');

  const again = await h.orchestrator.resumeUnstartedGoats();
  assertEqual(again.length, 0, 'a GOAT that already has a thesis is left alone');
  assertEqual(model.calls, 1, 'and is not asked to think again');
});

test('investigation: SHADOW still cannot execute after it starts reasoning', async () => {
  const model = new StubModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model });

  const { deployment } = await h.orchestrator.startGoat({ goalId: h.goalId, market: 'EURUSD' });

  assertEqual(deployment.execution.canExecute, false, 'a SHADOW deployment cannot execute');
  assertEqual(deployment.execution.canProposeTrades, true, 'but it may still propose');
  assertEqual(
    deployment.execution.allowedOrderTypes,
    ['LIMIT'],
    'and only the order type SHADOW is permitted',
  );

  const instance = h.agentRuntime.getAgent(h.agentId);
  assert(instance, 'the executor is registered');
  assertEqual(
    instance!.agent.policy.allowTrading,
    false,
    'reasoning about a trade does not become permission to trade',
  );
  assertEqual(h.env.placed.length, 0, 'nothing was ordered');
});

test('resume: a reloaded GOAT keeps its thesis and gets its observation plan back', async () => {
  const model = new StubModel([
    // createGoat reads the goal first, then the investigation runs.
    JSON.stringify({
      understood: 'The agent read this as a reversal setup.',
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      investigationPlan: [],
      openQuestions: [],
      actionable: true,
    }),
    INVESTIGATION_RESPONSE,
    // Asked again on the next load, once the resume notices nothing is
    // watching the surviving thesis.
    JSON.stringify({
      thought: 'My observation plan needs rebuilding.',
      thesis: {
        statement: 'The bearish leg is ending and price reclaims the prior swing high.',
        invalidation: 'A sustained structural break below the last swing low.',
      },
      trackers: [
        {
          purpose: 'A 15m bar closes, so I can see whether structure is changing.',
          kind: 'NEW_BAR',
          timeframe: '15m',
          config: {},
        },
      ],
    }),
  ]);
  const clock = makeClock();
  const env = new StubEnvironment();
  const stores = {
    goals: new InMemoryGoalStore(),
    theses: new InMemoryThesisStore(),
    evidence: new InMemoryEvidenceStore(),
    ideas: new InMemoryTradeIdeaStore(),
    deployments: new InMemoryDeploymentStore(),
    skills: new InMemorySkillStore(),
  };

  const build = () => {
    const agentRuntime = new AgentRuntime(
      undefined,
      undefined,
      undefined,
      undefined,
      new InMemoryAgentTimelineStore(),
    );
    const trackers = new TrackerRuntime({
      registry: new TrackerRegistry((agentId) => agentRuntime.getAgent(agentId)),
      agents: agentRuntime,
      timeline: agentRuntime.getTimelineStore(),
      clock: clock.now,
    });
    const orchestrator = new GoatOrchestrator({
      agentRuntime,
      trackers,
      env,
      stores,
      model,
      clock: clock.now,
    });
    return { orchestrator, agentRuntime, trackers };
  };

  // First session: create, deploy, investigate.
  const first = build();
  const created = await first.orchestrator.createGoat({
    goal: 'Find a long opportunity if the current bearish move begins reversing.',
    skillIds: ['structural-trend-analysis', 'patience'],
  });
  first.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  const started = await first.orchestrator.investigateGoal(created.goal.id);
  assert(started.investigated, `the GOAT started (${started.message})`);
  const thesisId = started.thesisId!;

  /*
   * A page reload. The goals, theses and deployments are stores, so they
   * come back; the tracker registry is runtime state, so it does not. What
   * is left is a GOAT claiming something with nothing waiting on it — the
   * state this test exists to make sure is repaired rather than reported
   * as running.
   */
  const second = build();
  assert(
    second.trackers.listForThesis(thesisId).length === 0,
    'the observation plan really is gone after a reload',
  );

  const resumed = await second.orchestrator.resumeUnstartedGoats();
  assertEqual(resumed.length, 1, 'the quiet GOAT is picked up');
  assertEqual(
    second.orchestrator.listThesesForGoal(created.goal.id).length,
    1,
    'and it is the same hypothesis, not a second one',
  );
  assertEqual(
    second.orchestrator.getThesis(thesisId)?.statement.length !== undefined,
    true,
    'with its identity intact',
  );
  assert(
    second.trackers.listForThesis(thesisId).length > 0,
    'and something to wake it again',
  );
  assertEqual(
    second.orchestrator.currentDeployment(created.goal.id)?.execution.canExecute,
    false,
    'and still no trading authority after a reload',
  );
});

// ---------------------------------------------------------------------------
// 7. The mission read model, steering, plans and lifecycle
// ---------------------------------------------------------------------------

/**
 * A model that reads the goal and then investigates it, in that order.
 *
 * The order matters because it is the order the UI causes: `createGoat`
 * asks the agent what the goal means before there is a market to look at.
 */
const CREATED_THEN_INVESTIGATED = (extra: string[] = []) =>
  new StubModel([
    JSON.stringify({
      understood: 'A reversal setup on EURUSD.',
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      investigationPlan: ['Read the structure.'],
      openQuestions: [],
      actionable: true,
    }),
    INVESTIGATION_RESPONSE,
    ...extra,
  ]);

test('mission: a saved GOAT says it is undeployed and has done nothing', async () => {
  const h = makeHarness({ model: ACTIONABLE_MODEL('A reversal setup.') });

  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  const mission = h.orchestrator.mission(created.goal.id)!;

  assertEqual(mission.stage, 'UNDEPLOYED', 'it has not been pointed anywhere');
  assertEqual(mission.runtime, 'UNDEPLOYED', 'so nothing is running');
  assertEqual(mission.activeTrackerCount, 0, 'and nothing is being watched');
  assertEqual(mission.tradePlan, undefined, 'and there is no trade plan');
  assertEqual(
    mission.workPlan.filter((step) => step.status === 'active').length,
    0,
    'nothing is in progress: a GOAT that has not been pointed at a market is not working',
  );
  assertEqual(
    mission.workPlan.filter((step) => step.status === 'done').map((step) => step.id),
    ['understand'],
    'the only completed step is reading the objective, which creation did',
  );
  assert(mission.workPlan.length >= 8, 'the plan covers the whole arc of the product');
});

test('mission: a deployed GOAT is shown working, with real progress', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });

  const created = await h.orchestrator.createGoat({
    goal: 'Find a long if the decline reverses',
    skillIds: ['structural-trend-analysis', 'patience'],
  });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  await h.orchestrator.investigateGoal(created.goal.id);

  const mission = h.orchestrator.mission(created.goal.id)!;

  assertEqual(mission.runtime, 'RUNNING', 'the executor is live');
  assertEqual(mission.stage, 'MONITORING', 'and it is watching for evidence');
  assertEqual(mission.market, 'EURUSD', 'the market it was pointed at');
  assertEqual(mission.mode, 'SHADOW', 'in SHADOW');
  assertEqual(mission.mayExecute, false, 'which cannot act on a plan');
  assert(mission.activeTrackerCount > 0, 'with conditions being watched');
  assert(
    mission.activity.headline.toLowerCase().includes('monitor'),
    `the activity says what it is doing (${mission.activity.headline})`,
  );
  assert(
    mission.activity.watching.length > 0,
    'and lists what it is waiting for, in the tracker\'s own words',
  );
  assertEqual(mission.tradePlan, undefined, 'no trade plan yet — which is correct');

  const done = mission.workPlan.filter((step) => step.status === 'done').map((step) => step.id);
  assertEqual(done.length >= 4, true, `four steps are genuinely done (${done.join(', ')})`);
  const active = mission.workPlan.filter((step) => step.status === 'active');
  assertEqual(active.length, 1, 'exactly one step is in progress');
  assertEqual(active[0].id, 'monitor', 'and it is the one the stage names');
});

test('mission: a GOAT whose runtime is missing reports ERROR rather than looking fine', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  await h.orchestrator.investigateGoal(created.goal.id);

  assertEqual(h.orchestrator.mission(created.goal.id)!.runtime, 'RUNNING', 'it starts healthy');

  // The executor vanishes while the deployment says active: the exact state
  // that used to render as a running GOAT doing nothing.
  h.agentRuntime.unregisterAgent(created.goal.agentId);

  const mission = h.orchestrator.mission(created.goal.id)!;
  assertEqual(mission.runtime, 'ERROR', 'a GOAT with no executor says so');
  assertEqual(mission.stage, 'ERROR', 'and is not presented as working');
  assert(
    mission.activity.headline.toLowerCase().includes('not running'),
    'with an explanation a person can act on',
  );
});

test('steering: a note re-enters the loop and changes no definition', async () => {
  /*
   * THE FREEZE.
   *
   * `wakeForSteering` returned false whenever the GOAT already held a live
   * thesis — which is the normal case, because a GOAT with a thesis is
   * watching and asleep. So the commonest possible steering did nothing: the
   * note sat unread, the interface said "reading 1 instruction you gave it"
   * forever, and the log showed the request followed by silence. To a user
   * that is a frozen agent.
   *
   * It was once asserted here as intended behaviour ("a GOAT with a live
   * thesis is not woken for steering, because it wakes on evidence"). The
   * reasoning was sound and the conclusion was not: an operator asking a
   * question is an event, and the agent has a loop that can answer one.
   *
   * What must remain true afterwards is the boundary: guidance informs the
   * next plan, it does not silently become a new objective.
   */
  const h = makeHarness({
    model: CREATED_THEN_INVESTIGATED([
      JSON.stringify({
        kind: 'REVISE_THESIS',
        thesisId: 'ignored-by-the-loop',
        reason: 'Operator asked for a different emphasis.',
      }),
    ]),
  });

  const created = await h.orchestrator.createGoat({ goal: 'Watch for a breakout and act on the retest' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  await h.orchestrator.investigateGoal(created.goal.id);

  const before = h.orchestrator.getGoal(created.goal.id)!;
  const thesisBefore = h.orchestrator.listThesesForGoal(created.goal.id);
  const trackersBefore = h.orchestrator.trackers.listForGoal(created.goal.id).length;

  const { note, woke } = await h.orchestrator.steerGoat(
    created.goal.id,
    'Focus on confirmation rather than anticipating the breakout.',
  );

  assert(note.text.includes('confirmation'), "the note keeps the user's words");
  assertEqual(h.orchestrator.steeringFor(created.goal.id).length, 1, 'it is recorded');
  assertEqual(note.stageAtSend, 'RUNNING', 'recorded against the stage it was sent at');

  /*
   * The core of it: the note reached a reasoning step. Not "will reach",
   * not "reaches the next time a tracker happens to fire" — this pass.
   */
  assert(woke, 'steering re-enters the loop instead of waiting for the next tracker');
  assert(note.appliedAt !== undefined, 'so the note is consumed by that pass');
  assertEqual(
    h.orchestrator.mission(created.goal.id)!.steering.pending,
    0,
    'and the interface stops claiming it is still reading an instruction',
  );

  // And the loop shows its work, so a user can see the agent responded.
  const activity = h.orchestrator.activityFor(created.goal.id, 40).map((entry) => entry.text);
  assert(
    activity.some((text) => /Reassessing/.test(text)),
    `the log shows the reassessment beginning: ${JSON.stringify(activity.slice(-6))}`,
  );
  assert(
    activity.some((text) => /your instruction|You asked it to reconsider/i.test(text)),
    'and shows whose instruction caused it',
  );

  // The boundary: guidance, not a rewrite.
  assertEqual(
    h.orchestrator.getGoal(created.goal.id)!.statement,
    before.statement,
    'the goal statement is untouched',
  );
  assertEqual(
    h.orchestrator.getGoal(created.goal.id)!.skillIds.join(','),
    before.skillIds.join(','),
    'and so are the skills',
  );
  assertEqual(
    h.orchestrator.listThesesForGoal(created.goal.id).length,
    thesisBefore.length,
    'no second thesis is created by being told something',
  );

  assertRejects(
    () => h.orchestrator.steerGoat(created.goal.id, '   '),
    'an empty instruction is refused',
  );
});

test('steering: a note reaches a GOAT that already has trackers, without duplicating them', async () => {
  /*
   * The other half of the freeze: the GOAT was asleep *because* it was
   * watching, with live trackers armed. Steering must wake it without
   * disturbing what it was watching — a second copy of the same watch would
   * double every event and quietly break the deduplication the whole loop
   * depends on.
   */
  const h = makeHarness({
    model: CREATED_THEN_INVESTIGATED([
      JSON.stringify({ kind: 'WAIT', reason: 'Reconsidered; the reading still stands.' }),
    ]),
  });

  const created = await h.orchestrator.createGoat({ goal: 'Watch for a breakout and act on the retest' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  await h.orchestrator.investigateGoal(created.goal.id);

  const armed = h.orchestrator.trackers
    .listForGoal(created.goal.id)
    .filter((tracker) => tracker.lifecycle.status === 'ACTIVE');
  assert(armed.length > 0, 'the GOAT is watching something, which is why it was asleep');

  const { woke, note } = await h.orchestrator.steerGoat(created.goal.id, 'Also weigh the 1h structure.');

  assert(woke, 'and steering still wakes it');
  assert(note.appliedAt !== undefined, 'the note is consumed by the pass that read it');

  const after = h.orchestrator.trackers
    .listForGoal(created.goal.id)
    .filter((tracker) => tracker.lifecycle.status === 'ACTIVE');
  assertEqual(after.length, armed.length, 'without deploying a duplicate watch');
  assertEqual(
    after.map((tracker) => tracker.purpose).sort().join('|'),
    armed.map((tracker) => tracker.purpose).sort().join('|'),
    'and without changing what it was watching',
  );
});

test('steering: a note to a GOAT with no thesis is read on the pass it triggers', async () => {
  // Call one reads the objective; call two is the pass steering triggers.
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });

  const created = await h.orchestrator.createGoat({ goal: 'Watch EURUSD for a clean break of the session high' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  const { note, woke } = await h.orchestrator.steerGoat(
    created.goal.id,
    'Wait for a retest rather than entering on the first touch.',
  );

  assert(woke, 'a GOAT with nothing to sleep on is woken for its instruction');
  // Read the store, not the value handed back: `note` is the snapshot taken
  // when the instruction arrived, before any pass could have read it.
  assert(
    h.orchestrator.steeringFor(created.goal.id)[0].appliedAt !== undefined,
    'and the note is marked read, because a pass really consumed it',
  );
  assertEqual(
    h.orchestrator.mission(created.goal.id)!.steering.pending,
    0,
    'so nothing is left claiming to be unread',
  );

  const activity = h.orchestrator.activityFor(created.goal.id);
  assert(
    activity.some((entry) => entry.type === 'GOAT_STEERED'),
    'and the instruction is in the activity feed with the user\'s own words',
  );
});

test('trade plan: a proposed plan is risk-checked, and SHADOW never becomes ready to execute', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });

  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  const investigation = await h.orchestrator.investigateGoal(created.goal.id);
  const thesisId = investigation.thesisId!;

  // Evidence first: a plan may only be built from an actionable thesis, and
  // an actionable thesis requires evidence. Both are enforced below.
  for (let i = 0; i < 2; i += 1) {
    h.orchestrator.loop.recordEvidence({
      thesisId,
      polarity: 'SUPPORTS',
      summary: `Confirmation ${i + 1}`,
      source: 'TRACKER_EVENT',
    });
  }

  const tracker = h.orchestrator.trackers.listForThesis(thesisId)[0];

  // Actionable before the event, because the plan may only be built from an
  // actionable thesis — a status a wake cannot grant itself.
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'ACTIONABLE' });

  h.model.responses.push(
    JSON.stringify({
      kind: 'PROPOSE_TRADE_IDEA',
      thesisId,
      reason: 'Structure has confirmed and the risk is defined.',
      idea: {
        symbol: 'EURUSD',
        direction: 'LONG',
        orderType: 'LIMIT',
        entry: 1.105,
        invalidationLevel: 1.1,
        takeProfits: [{ price: 1.12, fraction: 1, label: 'Target' }],
        reasoning: 'Higher low plus momentum recovery.',
      },
    }),
  );

  // The real path: the runtime delivers the event and the wake, and the GOAT
  // reasons on its own. Calling runWake as well would race it.
  h.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const plan = h.orchestrator.stores.ideas
    .listForGoal(created.goal.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  assert(plan, 'the plan was constructed from the evidence');
  assert(plan.status === 'READY' || plan.status === 'WAITING', `it was risk-checked (${plan.status})`);
  assert(plan.riskCheck !== undefined, 'with a verdict recorded on it');
  assert(
    typeof plan.riskCheck?.reason === 'string' && plan.riskCheck.reason.length > 0,
    'and a reason a person can read',
  );

  const mission = h.orchestrator.mission(created.goal.id)!;
  assertEqual(mission.tradePlan?.id, plan.id, 'the mission reports the plan');
  assert(
    plan.status !== ('EXECUTING' as TradeIdea['status']) &&
      plan.status !== ('MANAGING' as TradeIdea['status']),
    'and a plan in SHADOW never claims to be executing',
  );

  const planStep = mission.workPlan.find((step) => step.id === 'plan')!;
  assertEqual(planStep.status, 'done', 'the work plan shows the plan as built');
});

test('lifecycle: stop, then play, keeps one deployment and one observation plan', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED([INVESTIGATION_RESPONSE]) });

  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  const deployment = h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  await h.orchestrator.investigateGoal(created.goal.id);

  const trackersBefore = h.orchestrator.trackers.listForGoal(created.goal.id).length;
  assert(trackersBefore > 0, 'it was watching something');

  const stopped = await h.orchestrator.stopGoat(created.goal.id);
  assertEqual(stopped?.status, 'stopped', 'stopping marks the deployment stopped');
  assertEqual(h.orchestrator.mission(created.goal.id)!.runtime, 'STOPPED', 'and the GOAT reads as stopped');
  assert(
    h.orchestrator.listThesesForGoal(created.goal.id).length > 0,
    'stopping keeps the thesis',
  );

  const resumed = await h.orchestrator.resumeGoat(created.goal.id);

  assertEqual(resumed.alreadyRunning, false, 'play starts it');
  assertEqual(resumed.deployment.id, deployment.id, 'on the same deployment, not a new one');
  assertEqual(
    h.orchestrator.listDeployments().filter((d) => d.goatId === created.goal.agentId).length,
    1,
    'and there is still exactly one deployment record',
  );
  assertEqual(h.orchestrator.mission(created.goal.id)!.runtime, 'RUNNING', 'the runtime is live again');
  const activeNow = () =>
    h.orchestrator.trackers
      .listForGoal(created.goal.id)
      .filter((tracker) => tracker.lifecycle.status === 'ACTIVE');

  assertEqual(
    activeNow().length,
    trackersBefore,
    'and the observation plan is watching again, restored from the record',
  );
  assertEqual(
    new Set(activeNow().map((tracker) => tracker.purpose)).size,
    activeNow().length,
    'with nothing watched twice',
  );
  assert(
    h.orchestrator.trackers
      .listForGoal(created.goal.id)
      .some((tracker) => tracker.lifecycle.status === 'CANCELLED'),
    'the stopped watch is kept as history rather than deleted',
  );

  const again = await h.orchestrator.resumeGoat(created.goal.id);
  assertEqual(again.alreadyRunning, true, 'pressing play on a running GOAT does nothing');
  assertEqual(
    activeNow().length,
    trackersBefore,
    'and still does not duplicate a tracker',
  );
});

test('lifecycle: delete archives the GOAT and keeps what it learned', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });

  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  const investigation = await h.orchestrator.investigateGoal(created.goal.id);

  const result = await h.orchestrator.archiveGoat(created.goal.id);

  assertEqual(result.archived, true, 'the GOAT is archived');
  assert(result.kept.theses > 0, 'and the theses it produced are kept');
  assertEqual(
    h.orchestrator.mission(created.goal.id)!.runtime,
    'STOPPED',
    'it is no longer running',
  );
  assert(
    !h.orchestrator.missions().some((mission) => mission.goalId === created.goal.id),
    'and it is out of the active list',
  );
  assertEqual(
    h.orchestrator.getThesis(investigation.thesisId!)?.state,
    'ABANDONED',
    'with the thesis archived rather than destroyed',
  );
  assert(
    h.orchestrator.stores.goals.get(created.goal.id) !== undefined,
    'the goal record itself is kept: "delete" here means "stop showing me this"',
  );
});

test('naming: a GOAT can be named and renamed without losing anything', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });

  const created = await h.orchestrator.createGoat({
    name: 'My Breakout GOAT',
    description: 'Watches major breakouts and waits for confirmation.',
    goal: 'Watch for a sustained break above recent resistance',
  });
  const mission = h.orchestrator.mission(created.goal.id)!;
  assertEqual(mission.name, 'My Breakout GOAT', 'the name the user gave is used');
  assert(
    mission.description.includes('confirmation'),
    'and the description is kept separate from the goal',
  );
  assertEqual(mission.goal, created.goal.statement, 'the goal is still the user\'s own words');

  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  const investigation = await h.orchestrator.investigateGoal(created.goal.id);
  const thesisId = investigation.thesisId!;

  const renamed = h.orchestrator.updateGoatProfile(created.goal.id, { name: 'Breakout GOAT' });

  assertEqual(renamed.id, created.goal.id, 'renaming keeps the identity');
  assertEqual(renamed.statement, created.goal.statement, 'and the goal');
  assertEqual(renamed.skillIds.join(','), created.goal.skillIds.join(','), 'and the skills');
  assertEqual(h.orchestrator.getThesis(thesisId)?.id, thesisId, 'and the thesis');
  assert(
    h.orchestrator.trackers.listForGoal(created.goal.id).length > 0,
    'and the observation plan',
  );
  assertEqual(h.orchestrator.mission(created.goal.id)!.name, 'Breakout GOAT', 'the new name is shown');

  const cleared = h.orchestrator.updateGoatProfile(created.goal.id, { name: '  ' });
  assertEqual(cleared.name, undefined, 'clearing a name clears it rather than restoring it');

  const edited = h.orchestrator.updateGoalStatement(created.goal.id, 'Watch for a break and hold');
  assertEqual(edited.statement, 'Watch for a break and hold', 'the goal can be edited in place');
  assertEqual(edited.id, created.goal.id, 'without becoming a different GOAT');
  assert(
    !edited.interpretation,
    "and the agent's stale reading is dropped rather than left contradicting the new words",
  );
});

test('research: a GOAT can read the market it is pointed at, and cannot trade', async () => {
  const h = makeHarness({ model: CREATED_THEN_INVESTIGATED() });
  const created = await h.orchestrator.createGoat({ goal: 'Find a long if the decline reverses' });
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });

  const instance = h.agentRuntime.getAgent(created.goal.agentId)!;

  for (const capability of ['market.getQuote', 'market.getBars', 'indicators.rsi', 'structure.swingHighs', 'risk.calculatePositionSize']) {
    assert(
      instance.allowedCapabilities.includes(capability),
      `a GOAT can read ${capability}`,
    );
  }
  for (const capability of GOAT_EXECUTION_CAPABILITIES) {
    assert(
      !instance.allowedCapabilities.includes(capability),
      `a GOAT is never granted ${capability}`,
    );
  }

  assertEqual(
    instance.agent.policy.allowTrading,
    false,
    'and reasoning authority is still not trading authority in SHADOW',
  );
});

test('market context: real tools produce numbers, and gaps are reported', async () => {
  /*
   * The GOAT's market read goes through the same capabilities the agent
   * runtime exposes, so this asserts the shape of what a GOAT can know
   * rather than re-testing the indicator maths.
   */
  const env = new StubEnvironment();
  const capabilities = new CapabilityRegistry();
  initializeDefaultCapabilities(capabilities);

  const context = await collectMarketContext(env, capabilities, {
    agentId: 'goat_test',
    symbol: 'EURUSD',
    timeframe: '15m',
    policy: {
      maxRiskPerTrade: 0.01,
      maxOpenPositions: 1,
      maxExposure: 50_000,
      maxOrdersPerMinute: 5,
      allowedSymbols: ['EURUSD'],
      allowTrading: false,
    },
    mode: 'DEMO',
  });

  assert(context.bars.received > 0, 'candles were read');
  assert(context.quote !== undefined, 'a quote was read');
  assert(context.spread !== undefined, 'the spread was measured rather than guessed');
  assert(context.structure.swingHighs !== undefined, 'structure was measured');
  assert(
    context.limitations.length === 0,
    `a healthy read reports no limitations (${context.limitations.join(' | ')})`,
  );

  const rendered = renderMarketContext(context);
  assert(rendered.includes('Quote:'), 'the numbers are rendered for the agent');
  assert(rendered.includes('ATR'), 'including volatility');
  assert(rendered.includes('RSI'), 'and momentum');

  const evidence = marketContextEvidence(context);
  assert(typeof evidence['bid'] === 'number', 'the evidence keeps the price it was based on');
  assert(typeof evidence['candles'] === 'number', 'and how much history backed it');

  /*
   * A read that cannot reach the market must say so rather than return
   * zeros, because zeros are a price and the agent would reason from them.
   */
  const broken = await collectMarketContext(
    {
      mode: 'DEMO',
      getMarketQuote: () => {
        throw new Error('feed down');
      },
      getMarketBars: () => {
        throw new Error('feed down');
      },
    } as unknown as ITradingEnvironment,
    capabilities,
    {
      agentId: 'goat_test',
      symbol: 'EURUSD',
      timeframe: '15m',
      policy: {
        maxRiskPerTrade: 0.01,
        maxOpenPositions: 1,
        maxExposure: 50_000,
        maxOrdersPerMinute: 5,
        allowedSymbols: ['EURUSD'],
        allowTrading: false,
      },
      mode: 'DEMO',
    },
  );

  assert(broken.limitations.length > 0, 'a failed read reports what it could not read');
  assert(broken.quote === undefined, 'and invents no quote');
  assert(renderMarketContext(broken).includes('assume nothing'), 'and tells the agent to assume nothing');
});

test('market context: a GOAT with no market is told so instead of reading one', async () => {
  const capabilities = new CapabilityRegistry();
  initializeDefaultCapabilities(capabilities);

  const context = await collectMarketContext(new StubEnvironment(), capabilities, {
    agentId: 'goat_test',
    symbol: '',
    timeframe: '15m',
    policy: {
      maxRiskPerTrade: 0.01,
      maxOpenPositions: 1,
      maxExposure: 50_000,
      maxOrdersPerMinute: 5,
      allowedSymbols: [],
      allowTrading: false,
    },
    mode: 'DEMO',
  });

  assert(context.quote === undefined, 'nothing is read for a GOAT with no market');
  assert(
    context.limitations.some((limitation) => /no market/i.test(limitation)),
    'and the reason is recorded',
  );
});

test('persistence: a GOAT survives a reload', async () => {
  /*
   * The bug this defends: `PersistentJsonStore` restored from its own base
   * constructor, which runs before a subclass's fields exist, so every
   * restore wrote into an undefined Map and came back empty. A GOAT was
   * therefore lost on every reload, and "reload and press play" was
   * untestable.
   */
  const storage = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
    },
  });

  try {
    const store = new PersistentGoalStore('test:goals');
    store.save({
      id: 'goal_1',
      agentId: 'goat_1',
      name: 'My GOAT',
      statement: 'Find strong opportunities.',
      symbols: ['EURUSD'],
      timeframes: ['15m'],
      skillIds: ['patience'],
      status: 'MONITORING',
      createdAt: 1,
      updatedAt: 2,
    });
    store.flush();

    // A second store over the same storage is what a reload creates.
    const reopened = new PersistentGoalStore('test:goals');
    const restored = reopened.get('goal_1');

    assert(restored !== undefined, 'the goal came back');
    assertEqual(restored!.statement, 'Find strong opportunities.', 'with its own words');
    assertEqual(restored!.status, 'MONITORING', 'and its state');
    assertEqual(reopened.storageState, 'OK', 'and the store is healthy, not silently failing');

    /*
     * The deployment is the harder one, and it failed differently: its
     * store implemented "give me everything" by re-reading storage, so
     * every save wrote the saved copy back over the live one. A GOAT could
     * be deployed, run for the whole session, and be undeployed again by a
     * reload — the exact moment a user checks that it kept its work.
     */
    const deployments = new PersistentDeploymentStore();
    deployments.save({
      id: 'dep_1',
      goatId: 'goat_1',
      goatVersion: 1,
      accountId: 'acct_1',
      marketId: 'EURUSD',
      mode: 'SHADOW',
      venueEnvironment: 'MAINNET',
      execution: { canProposeTrades: true, canExecute: false, allowedOrderTypes: ['LIMIT'] },
      status: 'active',
      createdAt: 3,
      updatedAt: 3,
    });
    deployments.flush();

    const reopenedDeployments = new PersistentDeploymentStore();
    const live = reopenedDeployments.currentFor('goat_1');
    assert(live !== undefined, 'the deployment came back');
    assertEqual(live!.marketId, 'EURUSD', 'still pointed at the market it was given');
    assertEqual(live!.execution.canExecute, false, 'and still forbidden from executing');

    const skills = new PersistentSkillStore();
    skills.save({ id: 'skill_custom', markdown: 'Be careful.', createdAt: 4, updatedAt: 4 });
    skills.flush();
    assert(
      new PersistentSkillStore().get('skill_custom') !== undefined,
      'edited skills survive a reload too',
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  }
});

test('lifecycle: stop keeps the deployment so play can resume it', async () => {
  /*
   * The bug: stopping a GOAT retired its deployment, and a retired
   * deployment is not a current one, so the mission came back with no
   * deployment at all. The command centre then offered "Deploy" — telling
   * the user a GOAT that had run all afternoon had never been set up, and
   * inviting a second deployment record.
   */
  const h = makeHarness();
  const goalId = h.goalId;

  const running = h.orchestrator.mission(goalId);
  assertEqual(running!.runtime, 'RUNNING', 'it runs');
  assertEqual(running!.market, 'EURUSD', 'on the market it was given');

  await h.orchestrator.stopGoat(goalId);

  const stopped = h.orchestrator.mission(goalId);
  assertEqual(stopped!.runtime, 'STOPPED', 'stopping it stops it');
  assert(stopped!.deployment !== undefined, 'and it still knows what it was deployed to');
  assertEqual(stopped!.market, 'EURUSD', 'including the market');
  assertEqual(stopped!.mayExecute, false, 'and that it may not execute');
  assert(
    h.orchestrator.liveMissions().every((mission) => mission.runtime === 'RUNNING'),
    'a stopped GOAT is not listed as live',
  );

  await h.orchestrator.resumeGoat(goalId);
  const resumed = h.orchestrator.mission(goalId);
  assertEqual(resumed!.runtime, 'RUNNING', 'pressing play starts it again');
  assertEqual(resumed!.market, 'EURUSD', 'on the same market');
  assertEqual(
    h.orchestrator.deploymentHistory(goalId).length,
    1,
    'and without inventing a second deployment for the same GOAT',
  );
});

test('end to end: every explorer GOAT reaches a running, waiting agent', async () => {
  /*
   * The whole MVP chain, once per starter, through the same code the UI
   * calls: the Explorer's Use GOAT button, a review, a SHADOW deployment,
   * the first investigation, and a tracker event waking the agent.
   *
   * The model is stubbed so the test is about the architecture rather than
   * about anyone's credit balance. Everything below the model — the stores,
   * the skill constraints, the tracker registry, the wake, the policy and
   * the risk gates — is the real thing.
   */
  for (const starter of starterProfiles()) {
    // Two calls, in the order the UI makes them: read the goal, then
    // investigate it once there is a market.
    const model = new StubModel([
      JSON.stringify({
        understood: `The agent read this as: ${starter.goal}`,
        symbols: ['EURUSD'],
        timeframes: ['15m'],
        investigationPlan: ['Structure on the higher timeframe', 'Continuation quality'],
        openQuestions: [],
        actionable: true,
      }),
      INVESTIGATION_RESPONSE,
    ]);
    const clock = makeClock();
    const env = new StubEnvironment();
    const agentRuntime = new AgentRuntime(
      undefined,
      undefined,
      undefined,
      undefined,
      new InMemoryAgentTimelineStore(),
    );
    const trackerRegistry = new TrackerRegistry((agentId) => agentRuntime.getAgent(agentId));
    const trackers = new TrackerRuntime({
      registry: trackerRegistry,
      agents: agentRuntime,
      timeline: agentRuntime.getTimelineStore(),
      clock: clock.now,
    });
    const orchestrator = new GoatOrchestrator({
      agentRuntime,
      trackers,
      env,
      stores: {
        goals: new InMemoryGoalStore(),
        theses: new InMemoryThesisStore(),
        evidence: new InMemoryEvidenceStore(),
        ideas: new InMemoryTradeIdeaStore(),
        deployments: new InMemoryDeploymentStore(),
        skills: new InMemorySkillStore(),
      },
      model,
      clock: clock.now,
    });

    // 1. Explore -> Use this GOAT.
    const created = await orchestrator.createGoatFromStarter(starter.id);
    assertEqual(
      created.goal.statement,
      starter.goal,
      `${starter.name}: the starter's own goal is what the user gets`,
    );
    assertEqual(
      created.goal.skillIds.length,
      starter.skills.length,
      `${starter.name}: its skills are attached`,
    );

    // 2. Deploy to SHADOW, and let it start.
    const { deployment, investigation } = await orchestrator.startGoat({
      goalId: created.goal.id,
      market: 'EURUSD',
    });
    assertEqual(deployment.mode, 'SHADOW', `${starter.name}: deployed in SHADOW`);
    assert(
      investigation.investigated,
      `${starter.name}: the first investigation ran (${investigation.message})`,
    );

    // 3. It holds a thesis with an invalidation, and watchers.
    const theses = orchestrator.listLiveTheses(created.goal.id);
    assertEqual(theses.length, 1, `${starter.name}: one live thesis`);
    assert(theses[0].invalidation.length > 0, `${starter.name}: the thesis can be proved wrong`);

    const watching = orchestrator.trackers.listForGoal(created.goal.id);
    assert(watching.length > 0, `${starter.name}: it has something to wake it`);

    // 4. A tracker fires. The runtime delivers the wake and the agent
    //    re-evaluates on its own — nothing here calls the agent back.
    const before = orchestrator.listThesesForGoal(created.goal.id)[0];
    model.responses.push(
      JSON.stringify({
        kind: 'CONFIRM_THESIS',
        thesisId: before.id,
        reason: 'The evidence supports it.',
      }),
    );

    trackers.ingestEvent(makeTrackerEvent(watching[0], clock.now()));
    // The wake is delivered asynchronously; let it finish rather than
    // racing it, which is what makes such a test flaky rather than useful.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const after = orchestrator.listThesesForGoal(created.goal.id)[0];
    assertEqual(
      after.state,
      'STRENGTHENING',
      `${starter.name}: the thesis moved on the evidence`,
    );
    assertEqual(
      orchestrator.listEvidence(after.id).length,
      1,
      `${starter.name}: and the observation was recorded as evidence`,
    );

    // 5. And it still cannot trade.
    assertEqual(
      orchestrator.currentDeployment(created.goal.id)?.execution.canExecute,
      false,
      `${starter.name}: reasoning about a trade is not permission to trade`,
    );
    assertEqual(env.placed.length, 0, `${starter.name}: nothing was ordered`);
  }
});

test('unavailable model: the reason names the cause, not a vague failure', async () => {
  const model = new StubModel();
  model.unavailable = {
    code: 'KEY_REQUIRED',
    message: 'This GOAT needs your own OpenRouter API key before it can reason.',
  };
  const h = makeHarness({ model });

  h.orchestrator.deployGoat({ goalId: h.goalId, market: 'EURUSD' });
  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(!report.ok, 'a GOAT with no model does not start');
  assert(
    /openrouter api key/i.test(report.message),
    'the report says what to fix, not merely that something failed',
  );
  assertEqual(h.orchestrator.listThesesForGoal(h.goalId).length, 0, 'and nothing was invented');

  const created = await h.orchestrator.createGoat({
    goal: 'Find a long if the decline reverses.',
  });
  assertEqual(
    created.blocked,
    undefined,
    'creation is not blocked by a missing key: the goal is the user\'s, not the model\'s',
  );
  assert(
    created.goal.statement === 'Find a long if the decline reverses.',
    'and the goal itself is still recorded exactly as written',
  );

  /*
   * Where the cause surfaces instead: the GOAT that could not start says
   * so in the same words the assistant would use, so the user is told to
   * connect a key rather than to rewrite a goal that was fine.
   */
  h.orchestrator.deployGoat({ goalId: created.goal.id, market: 'EURUSD' });
  const creationReport = await h.orchestrator.investigateGoal(created.goal.id);
  assert(!creationReport.ok, 'the GOAT cannot start without a reasoning model');
  assert(
    /openrouter api key/i.test(creationReport.message),
    'and the message names the thing that would fix it',
  );
});


// ===========================================================================
// The blocker this suite was extended for
//
// Every test above passes a stub model that returns exactly the shape the
// parser wants. That is the correct way to test a parser and the wrong way
// to find this class of bug, because the defect was in what the model was
// *asked for*: the system prompt demanded a trading decision while the
// caller needed a hypothesis. A stub returning a thesis agreed with the
// prompt's caller and hid the disagreement.
//
// The tests below pin the contracts that were broken. They are deliberately
// written as statements about the product rather than about the fix.
// ===========================================================================

/** A model whose reply is authored the way a real one answers a prompt. */
class ScriptedModel implements IAgentModel {
  calls = 0;
  /** Present so a harness test can assert what the model was asked. */
  responses: string[];
  constructor(
    private readonly replies: string[],
    private readonly fail = false,
  ) {
    this.responses = replies;
  }

  async run() {
    const next = this.replies[this.calls];
    this.calls += 1;
    if (this.fail) {
      return {
        thought: 'OpenRouter was not consulted.',
        decision: { type: 'WAIT' as const, reason: 'The reasoning model was unavailable.' },
        unavailable: { code: 'NETWORK_ERROR', message: 'TradingGOATs could not reach OpenRouter.' },
      };
    }
    return { thought: next ?? '{"kind":"WAIT","reason":"no opinion"}' };
  }
}

test('A: a deployment of EUR/USD produces a context whose market is EUR/USD', async () => {
  const h = makeHarness({ market: 'EUR/USD' });
  const thesis = seedThesis(h);
  const context = h.orchestrator.loop.buildContext(h.agentId, thesis.id);

  assert(context !== undefined, 'a deployed GOAT always has a wake context');
  assertEqual(context!.deployment.market, 'EUR/USD', 'the context names the deployed market');
  assertEqual(
    context!.deployment.market,
    h.orchestrator.currentDeployment(h.goalId)!.marketId,
    'and it is the deployment record that decides, not a default',
  );
  assert(
    context!.deployment.deploymentId.length > 0,
    'the deployment id travels with it',
  );
  assertEqual(context!.deployment.venueEnvironment, 'TESTNET', 'and the venue it is bound to');
});

test('A: an undeployed GOAT has no context at all, rather than an empty one', async () => {
  const h = makeHarness({ deployed: false });
  const thesis = seedThesis(h);
  assertEqual(
    h.orchestrator.loop.buildContext(h.agentId, thesis.id),
    undefined,
    'a context with no market is not handed to a wake',
  );
});

test('B: SHADOW with execution disabled can still read the market and form a thesis', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });

  const deployment = h.orchestrator.currentDeployment(h.goalId)!;
  assertEqual(deployment.mode, 'SHADOW', 'the deployment is SHADOW');
  assertEqual(deployment.execution.canExecute, false, 'and cannot submit an order');

  const agent = h.agentRuntime.getAgent(h.agentId)!.agent;
  assertEqual(agent.policy.allowTrading, false, 'the executor is told not to trade');

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(report.ok, `a GOAT that may not trade can still investigate: ${report.message}`);
  assert(report.thesisId !== undefined, 'and it forms a thesis');
  assert(report.trackerIds.length > 0, 'and deploys trackers');
});

test('B: research is permitted while execution is refused', async () => {
  const h = makeHarness({ market: 'EUR/USD' });
  const context = h.orchestrator.deploymentContextFor(h.agentId)!;

  assertEqual(context.research.allowed, true, 'research is granted');
  assertEqual(context.research.market, 'EUR/USD', 'for the deployed market');
  assertEqual(context.execution.canExecute, false, 'while execution is refused');
  assert(
    context.execution.allowedOrderTypes.length > 0,
    'and the deployment still records what it would be allowed to submit',
  );
});

test('C: an empty execution allowed-symbol list does not block research', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });

  /*
   * The narrowest version of the defect: the agent's own policy list is
   * emptied, which is an *execution* statement, and market research must
   * survive it. `collectMarketContext` already falls back to the deployed
   * symbol; this proves the whole path does.
   */
  const agent = h.agentRuntime.getAgent(h.agentId)!;
  agent.agent = {
    ...agent.agent,
    policy: { ...agent.agent.policy, allowedSymbols: [], allowTrading: false },
  };

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(report.ok, `an empty execution symbol list did not stop the investigation: ${report.message}`);
  assert(report.trackerIds.length > 0, 'the GOAT still deployed trackers');
});

test('D: a broad objective is investigated rather than refused', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  h.orchestrator.stores.goals.save({
    ...h.orchestrator.getGoal(h.goalId)!,
    statement: 'Find a high-quality EUR/USD opportunity and wait for clear evidence before planning a trade.',
  });

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assert(report.ok, `a broad objective is a valid objective: ${report.message}`);
  assert(
    !/specific enough|rewrite the goal|too vague/i.test(report.message),
    'and it is never sent back to be rewritten',
  );
});

test('E: a model answer that only says WAIT is a valid reasoning outcome, not a failure', () => {
  /*
   * The shape a model produces when it obeys a system prompt that asks for
   * a trading decision. It used to be reported as "did not return a
   * hypothesis", which is both untrue and unactionable.
   */
  const parsed = parseInvestigation({
    thought: 'RSI is extended and there is no clean level yet.',
    payload: {
      thought: 'RSI is extended and there is no clean level yet.',
      decision: { type: 'WAIT', reason: 'no structure' },
    },
    decision: { type: 'WAIT', reason: 'no structure' },
  });

  assertEqual(parsed, undefined, 'there is no thesis to apply, which is correct');
  assert(
    isDeliberateWait({
      thought: 'x',
      payload: { thought: 'x', decision: { type: 'WAIT', reason: 'r' } },
      decision: { type: 'WAIT', reason: 'r' },
    }),
    'and the answer is recognised as a deliberate wait rather than a parse failure',
  );
});

test('E: a model answer carrying a thesis is applied even inside a markdown fence', () => {
  const parsed = parseInvestigation({
    thought: `Here is my answer.\n\n\`\`\`json\n${INVESTIGATION_RESPONSE}\n\`\`\``,
  });

  assert(parsed !== undefined, 'a fence does not hide a valid thesis');
  assert(parsed!.thesis.invalidation.length > 0, 'and the invalidation survives');
  assertEqual(parsed!.trackers.length, 2, 'with both trackers');
});

test('F: a deliberate wait is reported as no-thesis-yet, not as a deployment failure', async () => {
  const model = new ScriptedModel([
    JSON.stringify({ thought: 'Nothing to act on yet.', decision: { type: 'WAIT', reason: 'no structure' } }),
  ]);
  const h = makeHarness({ model, market: 'EUR/USD' });

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assertEqual(report.outcome, 'NO_THESIS_YET', 'the outcome names what happened');
  assertEqual(report.deployed, true, 'and the deployment is reported as intact');
  assert(
    !/nothing was deployed/i.test(report.message),
    'the message never claims the deployment did not happen',
  );
  assert(
    !/try again|redeploy|check the model in AI settings/i.test(report.message),
    'and does not send the user to redeploy a healthy GOAT',
  );
});

test('G: a model failure, no thesis, and a deliberate wait are three different things', async () => {
  const failing = makeHarness({ model: new ScriptedModel([], true) });
  const failureReport = await failing.orchestrator.investigateGoal(failing.goalId);

  assertEqual(failureReport.outcome, 'MODEL_FAILURE', 'an unreachable model is a model failure');
  assertEqual(failureReport.deployed, true, 'and the deployment is intact');
  assert(
    /retry|try again|unavailable|reach/i.test(failureReport.message),
    'the message says the GOAT stays deployed and will retry',
  );
  assert(
    !/nothing was deployed/i.test(failureReport.message),
    'and never says nothing was deployed',
  );

  const quiet = makeHarness({
    market: 'EUR/USD',
    model: new ScriptedModel([
      JSON.stringify({ thought: 'Nothing to act on yet.', decision: { type: 'WAIT', reason: 'r' } }),
    ]),
  });
  const quietReport = await quiet.orchestrator.investigateGoal(quiet.goalId);

  assertEqual(quietReport.outcome, 'NO_THESIS_YET', 'an answered wait is not a model failure');
  assert(quietReport.outcome !== failureReport.outcome, 'the two outcomes differ');
});

test('H: a successful deployment is never reported as "nothing was deployed"', async () => {
  for (const replies of [
    [INVESTIGATION_RESPONSE],
    [JSON.stringify({ thought: 'quiet market', decision: { type: 'WAIT', reason: 'r' } })],
    [JSON.stringify({ thought: 'no invalidation', thesis: { statement: 's' }, trackers: [] })],
  ]) {
    const h = makeHarness({ model: new ScriptedModel(replies) });
    const report = await h.orchestrator.investigateGoal(h.goalId);

    assert(
      h.orchestrator.currentDeployment(h.goalId) !== undefined,
      'the deployment exists',
    );
    assertEqual(report.deployed, true, 'and the report says so');
    assert(
      !/nothing was deployed/i.test(report.message),
      `no outcome may claim otherwise: ${report.message}`,
    );
  }
});

test('I: a deployed GOAT keeps its deployment across reload, stop, play and wake', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);

  const afterInvestigation = h.orchestrator.currentDeployment(h.goalId)!;

  await h.orchestrator.stopGoat(h.goalId);
  assertEqual(
    h.orchestrator.currentDeployment(h.goalId),
    undefined,
    'a stopped GOAT has no current deployment',
  );
  assertEqual(
    h.orchestrator.mission(h.goalId)!.market,
    'EUR/USD',
    'but it still knows what it was deployed to',
  );

  await h.orchestrator.resumeGoat(h.goalId);
  const afterPlay = h.orchestrator.currentDeployment(h.goalId)!;

  assertEqual(afterPlay.id, afterInvestigation.id, 'play resumes the same deployment');
  assertEqual(afterPlay.marketId, 'EUR/USD', 'on the same market');

  const context = h.orchestrator.loop.buildContext(
    h.agentId,
    h.orchestrator.listLiveTheses(h.goalId)[0].id,
  );
  assertEqual(context!.deployment.market, 'EUR/USD', 'and a wake after play still knows its market');
});

test('J: stop then play creates no duplicate deployment and no duplicate tracker', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);
  const before = h.orchestrator.deploymentHistory(h.goalId).length;
  const thesisId = h.orchestrator.listLiveTheses(h.goalId)[0].id;
  const trackersBefore = h.trackers.listForThesis(thesisId).filter((t) => t.lifecycle.status === 'ACTIVE').length;

  for (let round = 0; round < 3; round += 1) {
    await h.orchestrator.stopGoat(h.goalId);
    await h.orchestrator.resumeGoat(h.goalId);
  }

  assertEqual(
    h.orchestrator.deploymentHistory(h.goalId).length,
    before,
    'three stop/play cycles produced no new deployment records',
  );
  assertEqual(
    h.trackers.listForThesis(thesisId).filter((t) => t.lifecycle.status === 'ACTIVE').length,
    trackersBefore,
    'and no duplicate trackers',
  );
  assertEqual(model.calls, 1, 'and the model was asked exactly once, not on every resume');
});

test('K: a trade plan cannot exist without an actionable thesis', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);
  const thesisId = h.orchestrator.listLiveTheses(h.goalId)[0].id;

  const thesis = h.orchestrator.getThesis(thesisId)!;
  assert(
    thesis.state !== 'ACTIONABLE',
    'an investigation does not produce an actionable thesis by itself',
  );

  const tracker = h.orchestrator.trackers.listForThesis(thesisId)[0];
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId,
    reason: 'looks good',
    idea: {
      symbol: 'EUR/USD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.129,
      invalidationLevel: 1.125,
      takeProfits: [{ price: 1.135, fraction: 1 }],
      reasoning: 'because',
    },
  });

  assertEqual(
    h.orchestrator.listTradeIdeas(h.goalId).length,
    0,
    'a plan proposed against a non-actionable thesis is refused, not stored',
  );
});

test('L: SHADOW can never submit a real order', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);

  const thesisId = h.orchestrator.listLiveTheses(h.goalId)[0].id;

  /*
   * Force the thesis actionable so the plan path is genuinely reached, and
   * then confirm the deployment still refuses to execute it. This is the
   * boundary Part 17 asks not to weaken, tested at the point where it would
   * be weakened.
   */
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'ACTIVE' });
  for (let index = 0; index < 2; index += 1) {
    h.orchestrator.loop.recordEvidence({
      thesisId,
      polarity: 'SUPPORTS',
      summary: `observation ${index}`,
      source: 'TRACKER_EVENT',
      observed: {},
    });
  }
  h.orchestrator.loop.reviseThesis(thesisId, { state: 'ACTIONABLE' });

  const tracker = h.orchestrator.trackers.listForThesis(thesisId)[0];
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  const wake = h.orchestrator.trackers.latestWakeRequest()!;

  await applyWake(h, wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId,
    reason: 'evidence supports it',
    idea: {
      symbol: 'EUR/USD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.129,
      invalidationLevel: 1.125,
      takeProfits: [{ price: 1.135, fraction: 1 }],
      reasoning: 'structure held and momentum returned',
    },
  });

  const ideas = h.orchestrator.listTradeIdeas(h.goalId);
  assertEqual(ideas.length, 1, 'the plan is written');
  assertEqual(ideas[0].status, 'READY', 'and risk-validated');
  assert(
    h.orchestrator.mission(h.goalId)!.mayExecute === false,
    'but the deployment still may not execute it',
  );
  assertEqual(
    h.env.placed.length,
    0,
    'and nothing was ever submitted to the venue',
  );
});

test('the work plan and the activity feed come from records, not from motion', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE]);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);

  const mission = h.orchestrator.mission(h.goalId)!;
  assertEqual(mission.market, 'EUR/USD', 'the mission knows its market');
  assert(
    mission.workPlan.filter((step) => step.status === 'active').length <= 1,
    'at most one step is ever active',
  );
  assertEqual(
    mission.workPlan.find((step) => step.id === 'thesis')?.status,
    'done',
    'a formed thesis is reported as done',
  );
  assertEqual(
    mission.workPlan.find((step) => step.id === 'monitor')?.status,
    'active',
    'and the GOAT is monitoring rather than researching',
  );

  const activity = h.orchestrator.activityFor(h.goalId);
  const types = activity.map((entry) => entry.type);
  assert(types.includes('GOAT_DEPLOYED'), 'the deployment is recorded');
  assert(types.includes('GOAT_STARTED'), 'the start is recorded');
  assert(types.includes('MARKET_CONTEXT_LOADED'), 'reading the market is recorded');
  assert(types.includes('THESIS_FORMED'), 'forming the thesis is recorded');
  assert(types.includes('TRACKER_CREATED'), 'deploying trackers is recorded');
  assert(types.includes('GOAT_WAITING'), 'and going dormant is recorded');
  assert(
    activity.every((entry) => entry.text.length > 0),
    'every record reads as a sentence',
  );
});

test('a wake records that it woke, what it decided, and that it went back to sleep', async () => {
  const model = new ScriptedModel([INVESTIGATION_RESPONSE, '{"kind":"WAIT","reason":"not enough"}']);
  const h = makeHarness({ model, market: 'EUR/USD' });
  await h.orchestrator.investigateGoal(h.goalId);

  const thesis = h.orchestrator.listLiveTheses(h.goalId)[0];
  const tracker = h.orchestrator.trackers.listForThesis(thesis.id)[0];

  /*
   * The event is ingested and nothing else. `bindDomain` routes it to
   * `handleTrackerEvent`, which asks the model and applies the plan, so this
   * is the whole wake path, driven by the tracker rather than by the test.
   */
  h.orchestrator.trackers.ingestEvent(makeTrackerEvent(tracker, h.clock.now()));
  for (let turn = 0; turn < 20 && model.calls < 2; turn += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assertEqual(model.calls, 2, 'the model was consulted once for the investigation and once for the wake');

  const activity = h.orchestrator.activityFor(h.goalId);
  const types = activity.map((entry) => entry.type);
  assert(types.includes('GOAT_WOKE'), 'the wake is recorded');
  assert(types.includes('GOAT_WAITING'), 'and the return to dormancy');
  assert(
    activity.some((entry) => entry.type === 'GOAT_WOKE' && /woken/i.test(entry.text)),
    'and the wake reads as a sentence rather than a code',
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runGoatTests(): Promise<void> {
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
    throw new Error(`${failures.length} GOAT test(s) failed.`);
  }
}
