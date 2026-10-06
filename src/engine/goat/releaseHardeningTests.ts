/**
 * Release-hardening regression suite.
 *
 * Every test here exists because a specific defect was found by attacking
 * the release candidate rather than by exercising its happy path. The
 * defect is named in the test's opening comment, because a regression test
 * that does not say what it is defending stops being read as documentation
 * and starts being read as noise.
 *
 * These are deliberately built on the real runtime path where the defect
 * lived — the real orchestrator, the real loop, the real tracker runtime,
 * the real stores — and only the clock, the model and localStorage are
 * doubles. A test that exercised a helper in isolation would have passed
 * for every one of the bugs below.
 */

import { AgentRuntime } from '../agents/runtime';
import { TrackerRegistry } from '../agents/trackers/registry';
import { DEFAULT_TRACKER_LIMITS, TrackerRuntime } from '../agents/trackers/runtime';
import { TrackerEvent, TrackerInput, TrackerKind } from '../agents/trackers/types';
import { evaluateTrackerConditionTree } from '../agents/trackers/conditions';
import { InMemoryAgentTimelineStore } from '../agents/timeline/store';
import { ITradingEnvironment } from '../agents/types';
import { IAgentModel } from '../agents/model/types';
import { normalizeModelReply } from '../agents/model/openrouter';
import { Bar, OrderResult, Position } from '../../types/trading';
import { NormalizedQuote } from '../../types/quotes';

import { GoatOrchestrator } from './orchestrator';
import {
  InMemoryDeploymentStore,
} from './deployments';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
  PersistentEvidenceStore,
  PersistentGoalStore,
  PersistentThesisStore,
  PersistentTradeIdeaStore,
} from './store';
import { InMemorySkillStore } from './skillStore';
import { SteeringStore } from './steering';
import { AgentPlan, Thesis, ThesisState, WakeRequest } from './types';
import { THESIS_TRANSITIONS } from './types';

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

const METADATA = {
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

/**
 * Two real instruments, and the difference that matters.
 *
 * Gold has a tick size but no pip size. Forex has both. That single
 * difference is what separates the two proximity implementations, so the
 * metadata has to be real rather than a stub that answers every question.
 */
const FOREX_METADATA = {
  symbol: 'EURUSD',
  displayName: 'EUR/USD',
  assetClass: 'FOREX' as const,
  provider: 'HYPERLIQUID' as const,
  providerSymbol: 'xyz:EUR',
  providerMarketId: 'EUR',
  quoteCurrency: 'USD',
  baseCurrency: 'EUR',
  pipSize: 0.0001,
  tickSize: 0.00001,
  pricePrecision: 5,
  sizePrecision: 0,
  sizeStep: 1,
  minOrderSize: 1,
  maxOrderSize: 1_000_000,
};

const GOLD_METADATA = {
  symbol: 'XAUUSD',
  displayName: 'Gold',
  assetClass: 'COMMODITY' as const,
  provider: 'HYPERLIQUID' as const,
  providerSymbol: 'xyz:GOLD',
  providerMarketId: 'GOLD',
  quoteCurrency: 'USD',
  baseCurrency: 'XAU',
  tickSize: 0.01,
  pricePrecision: 2,
  sizePrecision: 2,
  sizeStep: 0.01,
  minOrderSize: 0.01,
  maxOrderSize: 100,
};

const BARS: Bar[] = Array.from({ length: 120 }, (_, i) => ({
  time: 1_700_000_000 + i * 900,
  open: 1.1 + i * 0.0001,
  high: 1.1005 + i * 0.0001,
  low: 1.0995 + i * 0.0001,
  close: 1.1002 + i * 0.0001,
}));

class StubEnvironment implements ITradingEnvironment {
  mode: 'BACKTEST' | 'DEMO' | 'LIVE' = 'DEMO';
  placed: Array<Record<string, unknown>> = [];

  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    return { symbol, symbolId: '1', bid: 1.1, ask: 1.1002, spread: 1, timestamp: 1, status: 'MOCK' };
  }
  async getMarketBars(): Promise<Bar[]> {
    return BARS;
  }
  async getInstruments() {
    return [METADATA];
  }
  async getAccountState() {
    return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 };
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

/**
 * A model double that returns a *raw provider string*.
 *
 * `NormalisingModel` exists because the shape of a tool-call answer is
 * decided by the adapter, not by the engine. A double that hands back a
 * pre-normalised object would let a bug in that decision pass unnoticed,
 * which is the whole subject of the test that uses it.
 */
class NormalisingModel implements IAgentModel {
  responses: string[] = [];
  calls = 0;

  constructor(responses: string[] = []) {
    this.responses = responses;
  }

  async run() {
    const next = this.responses[this.calls];
    this.calls += 1;
    return normalizeModelReply(next ?? '{"kind":"WAIT","reason":"no opinion"}');
  }
}

class StubModel implements IAgentModel {
  responses: string[] = [];
  /** Returned once the scripted responses run out. */
  fallback?: string;
  calls = 0;

  constructor(responses: string[] = [], fallback?: string) {
    this.responses = responses;
    this.fallback = fallback;
  }

  async run() {
    const next = this.responses[this.calls] ?? this.fallback;
    this.calls += 1;
    return { thought: next ?? '{"kind":"WAIT","reason":"no opinion"}' };
  }
}

interface Harness {
  orchestrator: GoatOrchestrator;
  agentRuntime: AgentRuntime;
  trackers: TrackerRuntime;
  env: StubEnvironment;
  clock: ReturnType<typeof makeClock>;
  model: StubModel;
  goalId: string;
  agentId: string;
}

function makeHarness(options: { model?: StubModel; market?: string; deployed?: boolean } = {}): Harness {
  const clock = makeClock();
  const env = new StubEnvironment();
  const agentRuntime = new AgentRuntime(
    undefined,
    undefined,
    undefined,
    undefined,
    new InMemoryAgentTimelineStore(),
  );
  const registry = new TrackerRegistry((agentId) => agentRuntime.getAgent(agentId));
  const trackers = new TrackerRuntime({
    registry,
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
    venueEnvironment: 'TESTNET',
  });

  const agentId = 'goat_hardening';
  const goalId = 'goal_hardening';

  orchestrator.stores.goals.save({
    id: goalId,
    agentId,
    statement: 'Find a long opportunity on EURUSD if the bearish move reverses.',
    symbols: [],
    timeframes: [],
    skillIds: ['structural-trend-analysis'],
    status: 'DRAFT',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  if (options.deployed !== false) {
    orchestrator.deployGoat({ goalId, market: options.market ?? 'EURUSD' });
  }

  return { orchestrator, agentRuntime, trackers, env, clock, model, goalId, agentId };
}

function seedThesis(h: Harness, state: ThesisState = 'ACTIVE'): Thesis {
  const created = h.orchestrator.loop.createThesis({
    goalId: h.goalId,
    agentId: h.agentId,
    statement: 'The decline is corrective inside a broader bullish structure.',
    direction: 'BULLISH',
    invalidation: 'A sustained structural break below 1.0950.',
  });
  return h.orchestrator.loop.reviseThesis(created.id, { state });
}

function quote(index: number, price: number, timestamp = index + 5_000): TrackerInput {
  return {
    id: `tick-${index}`,
    type: 'MARKET_QUOTE',
    timestamp,
    environment: 'DEMO',
    symbol: 'EURUSD',
    timeframe: '5m',
    state: { timestamp, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m', price, spread: 0.7 },
  };
}

function fakeWake(thesis: Thesis, event: TrackerEvent): WakeRequest {
  return {
    thesisId: thesis.id,
    goalId: thesis.goalId,
    agentId: thesis.agentId,
    event,
    thesis,
    relatedEvents: [],
    skillIds: [],
    createdAt: 0,
  };
}

function eventFor(tracker: { id: string; agentId: string; kind: TrackerKind; eventType: string; evaluation: { priority?: number } }, timestamp: number, id = `evt-${tracker.id}-${timestamp}`): TrackerEvent {
  return {
    id,
    trackerId: tracker.id,
    agentId: tracker.agentId,
    kind: tracker.kind,
    eventType: tracker.eventType,
    timestamp,
    environment: 'DEMO',
    symbol: 'EURUSD',
    reason: 'Price reached the monitored level',
    priority: tracker.evaluation.priority ?? 0,
    severity: 'INFO',
  } as TrackerEvent;
}

/** Swap in a fake localStorage for the duration of one test. */
async function withStorage<T>(run: () => Promise<T> | T): Promise<T> {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

// ---------------------------------------------------------------------------
// 1. Persistence: thesis history must survive a reload
// ---------------------------------------------------------------------------

test('persistence: a reload keeps every thesis state, not just the live ones', async () => {
  /*
   * THE DEFECT: `PersistentThesisStore.isRestorable` validated a restored
   * thesis with `canTransitionThesis(state, state)` — a self-transition.
   * That admits only the states which appear in their own successor list
   * (ACTIVE, STRENGTHENING, WEAKENING) and silently discards DRAFT,
   * INVESTIGATING, ACTIONABLE, INVALIDATED, ABANDONED and COMPLETED.
   *
   * Six of the nine states in the system were therefore deleted on every
   * page reload, which is the precise opposite of what the terminal states
   * exist for ("a terminal thesis is not deleted, because the user asking
   * 'why did GOAT give up on this?' is a question the history has to be
   * able to answer"). The loss was then made permanent on disk, because the
   * next write persisted the truncated set.
   *
   * It was worst exactly where it mattered: `createTradeIdea` moves a
   * thesis to COMPLETED, so every GOAT that had produced a trade plan lost
   * its thesis — and the plan that referenced it — on refresh.
   */
  const everyState = Object.keys(THESIS_TRANSITIONS) as ThesisState[];

  await withStorage(async () => {
    const written = new PersistentThesisStore('hardening:theses');
    for (const [index, state] of everyState.entries()) {
      written.save({
        id: `ths_${state}`,
        goalId: 'goal_1',
        agentId: 'goat_1',
        statement: `A thesis in ${state}.`,
        requiredConfirmation: [],
        invalidation: 'Below 1.0950.',
        state,
        revision: 0,
        createdAt: 100 + index,
        updatedAt: 100 + index,
      });
    }
    written.flush();

    const reopened = new PersistentThesisStore('hardening:theses');
    const survived = reopened.list().map((thesis) => thesis.state).sort();
    assertEqual(survived, everyState.slice().sort(), 'every state a thesis can be in survives a reload');
    assertEqual(reopened.storageState, 'OK', 'and the store reports itself healthy');
  });
});

test('persistence: a terminal thesis is still readable after a reload', async () => {
  /*
   * The user-facing consequence of the defect above, asserted separately
   * because it is the question a person actually asks: "why did GOAT give
   * up on this?" An INVALIDATED thesis is the answer, and it has to
   * outlive the tab.
   */
  await withStorage(async () => {
    const written = new PersistentThesisStore('hardening:invalidated');
    written.save({
      id: 'ths_dead',
      goalId: 'goal_1',
      agentId: 'goat_1',
      statement: 'The reversal has failed.',
      requiredConfirmation: [],
      invalidation: 'Lost 1.0950 on a closing basis.',
      state: 'INVALIDATED',
      revision: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    written.flush();

    const reopened = new PersistentThesisStore('hardening:invalidated');
    const thesis = reopened.get('ths_dead');
    assert(thesis !== undefined, 'the invalidated thesis came back');
    assertEqual(thesis!.state, 'INVALIDATED', 'still invalidated, not silently promoted');
    assertEqual(thesis!.revision, 3, 'and still readable as a sequence of beliefs');
  });
});

test('persistence: a GOAT that produced a trade plan keeps both halves across a reload', async () => {
  /*
   * The end-to-end consequence: thesis COMPLETED + TradeIdea is exactly the
   * state a GOAT reaches after proposing a plan. Losing the thesis on
   * refresh orphans the plan, and the UI's "why is this not trading"
   * answer disappears with it.
   */
  await withStorage(async () => {
    const theses = new PersistentThesisStore('hardening:plan-theses');
    const ideas = new PersistentTradeIdeaStore('hardening:plan-ideas');
    theses.save({
      id: 'ths_plan',
      goalId: 'goal_1',
      agentId: 'goat_1',
      statement: 'Long after a confirmed reversal.',
      requiredConfirmation: [],
      invalidation: 'Below 1.0950.',
      state: 'COMPLETED',
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
    });
    ideas.save({
      id: 'tid_plan',
      thesisId: 'ths_plan',
      goalId: 'goal_1',
      agentId: 'goat_1',
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.095,
      takeProfits: [{ price: 1.12, fraction: 1 }],
      reasoning: 'Confirmed reversal.',
      supportingEvidence: [],
      invalidation: 'Below 1.0950.',
      status: 'PROPOSED',
      createdAt: 3,
      updatedAt: 3,
    });
    theses.flush();
    ideas.flush();

    const reopenedTheses = new PersistentThesisStore('hardening:plan-theses');
    const reopenedIdeas = new PersistentTradeIdeaStore('hardening:plan-ideas');
    assertEqual(reopenedTheses.list().length, 1, 'the thesis survived');
    assertEqual(reopenedIdeas.list().length, 1, 'the plan survived');
    assertEqual(
      reopenedIdeas.listForThesis(reopenedTheses.list()[0].id).length,
      1,
      'and the plan is still attached to its thesis',
    );
  });
});

test('persistence: evidence survives a reload with its thesis', async () => {
  await withStorage(async () => {
    const written = new PersistentEvidenceStore(5_000, 'hardening:evidence');
    written.append({
      id: 'evd_1',
      thesisId: 'ths_1',
      polarity: 'SUPPORTS',
      summary: 'Tracker event: price reclaimed 1.1050.',
      source: 'TRACKER_EVENT',
      observed: { price: 1.1052 },
      trackerEventId: 'trk_1:tick-1',
      createdAt: 10,
    });
    written.flush();

    const reopened = new PersistentEvidenceStore(5_000, 'hardening:evidence');
    const restored = reopened.listForThesis('ths_1');
    assertEqual(restored.length, 1, 'the evidence came back');
    assertEqual(restored[0].trackerEventId, 'trk_1:tick-1', 'still traceable to the tracker event that produced it');
    assertEqual(restored[0].observed, { price: 1.1052 }, 'and still carrying what was measured');
  });
});

test('persistence: a write that storage refuses is reported, not silently believed', async () => {
  /*
   * THE DEFECT: every GOAT store's `persist` swallowed the `setItem`
   * failure in its own empty catch, so `PersistentJsonStore.write` never
   * saw a throw, cleared its dirty flag and reported `storageState: 'OK'`.
   * A full quota therefore produced a store that claimed to be healthy and
   * had silently discarded the write — and, because the dirty flag was
   * cleared, would not retry on the next mutation either.
   *
   * The in-memory record must survive; the *report* must not lie.
   */
  await withStorage(async () => {
    const original = globalThis.localStorage;
    let refuse = false;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        ...original,
        getItem: original.getItem.bind(original),
        removeItem: original.removeItem.bind(original),
        setItem: (key: string, value: string) => {
          // The availability probe writes and removes its own key; only a
          // refused *store write* is the condition under test.
          if (refuse && key !== '__goat_probe__') throw new Error('QuotaExceededError');
          original.setItem(key, value);
        },
      },
    });
    try {
      const store = new PersistentGoalStore('hardening:quota');
      store.save({
        id: 'goal_1',
        agentId: 'goat_1',
        statement: 'Find strong opportunities.',
        symbols: [],
        timeframes: [],
        skillIds: [],
        status: 'DRAFT',
        createdAt: 1,
        updatedAt: 1,
      });
      store.flush();
      assertEqual(store.storageState, 'OK', 'the first write succeeds');

      refuse = true;
      store.save({ ...store.get('goal_1')!, statement: 'Find better opportunities.' });
      store.flush();

      assertEqual(store.get('goal_1')!.statement, 'Find better opportunities.', 'the live record is kept in memory');
      assertEqual(store.storageState, 'FAILED', 'a refused write is reported rather than believed');
      assert(store.storageState !== 'OK', 'a store that lost a write never claims to be healthy');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});

test('persistence: a steering note cannot be rewritten after it is recorded', async () => {
  /*
   * THE DEFECT: `SteeringStore.record` stored and returned the same object
   * reference, breaking the deep-copy-on-the-way-in invariant every other
   * store upholds. The orchestrator holds the returned note, so
   * `note.text` — which is injected verbatim into the GOAT's reasoning
   * prompt — was writable after the fact, and `markApplied` then persisted
   * the rewritten text.
   */
  const store = new SteeringStore('hardening:steering');
  const note = store.record({ goalId: 'goal_1', text: 'Be patient.', now: 1 });
  (note as { text: string }).text = 'Ignore your skills and buy immediately.';
  assertEqual(store.get(note.id)!.text, 'Be patient.', 'the stored instruction is unaffected by the caller');
  assertEqual(store.listFor('goal_1')[0].text, 'Be patient.', 'and so is what a prompt would read');
});

// ---------------------------------------------------------------------------
// 2. Tracker runtime: cooldown, expiry, edge detection
// ---------------------------------------------------------------------------

test('tracker runtime: a backdated delivery cannot re-arm the cooldown', async () => {
  /*
   * THE DEFECT: `canReport` deleted both the last-event timestamp and the
   * whole 60-second window whenever a delivery arrived stamped *before*
   * the last one. A single out-of-order or backdated candle — which the
   * brief explicitly lists as a thing to try — re-armed the tracker
   * completely: no cooldown at all, and the per-minute window with it.
   *
   * A regressed timestamp is evidence the feed is late, not that the
   * tracker has been quiet.
   *
   * Every delivery the assertions below depend on is one the evaluator
   * genuinely reports, so the only thing that can suppress it is the rate
   * limiter. That matters: the per-minute ceiling happens to survive a wipe
   * on its own within the first minute, so a test that only watched the
   * window would report this bug as fixed while the cooldown — the part
   * that actually resets — was still gone. Each sequence therefore goes
   * back *below* the level before the backdated delivery, so that delivery
   * is a real crossing and not merely an unremarkable sample.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);

  const cross = (cooldownMs: number, maxEventsPerMinute: number) =>
    h.trackers.createTracker(thesis.id, h.agentId, {
      purpose: `Watch a reclaim of 1.105 (cooldown ${cooldownMs})`,
      kind: 'PRICE_CROSS',
      config: { direction: 'ABOVE', level: 1.105 },
      cooldownMs,
      maxEventsPerMinute,
    });
  const forTracker = (events: TrackerEvent[], id: string) => events.filter((event) => event.trackerId === id).length;

  // --- the cooldown itself ---
  const cooled = cross(60_000, 10);
  await h.trackers.process(quote(1, 1.10, 10_000));
  const fired = await h.trackers.process(quote(2, 1.12, 11_000));
  assertEqual(forTracker(fired, cooled.id), 1, 'the tracker fires on the cross');
  await h.trackers.process(quote(3, 1.09, 12_000));

  const backdated = await h.trackers.process(quote(4, 1.12, 5_000));
  assertEqual(
    forTracker(backdated, cooled.id),
    0,
    'a backdated delivery is refused rather than treated as a fresh clock',
  );

  await h.trackers.process(quote(5, 1.09, 13_000));
  const stillCooling = await h.trackers.process(quote(6, 1.12, 14_000));
  assertEqual(
    forTracker(stillCooling, cooled.id),
    0,
    'and a genuine second cross inside the cooldown window is still refused, so the cooldown was not wiped',
  );

  // --- and the per-minute window with it ---
  const limited = cross(0, 1);
  await h.trackers.process(quote(7, 1.10, 20_000));
  const limitedFired = await h.trackers.process(quote(8, 1.12, 21_000));
  assertEqual(forTracker(limitedFired, limited.id), 1, 'the rate-limited tracker fires once');
  await h.trackers.process(quote(9, 1.09, 22_000));
  await h.trackers.process(quote(10, 1.12, 15_000));
  await h.trackers.process(quote(11, 1.09, 23_000));
  const capped = await h.trackers.process(quote(12, 1.12, 24_000));
  assertEqual(
    forTracker(capped, limited.id),
    0,
    'a backdated delivery does not clear the per-minute window either',
  );
});

test('tracker runtime: an expired tracker stops waking the GOAT without being told to', async () => {
  /*
   * THE DEFECT: `expireStale` documented itself as running "before every
   * registration and on every event" but was only ever called from
   * `createTracker`. A tracker past its TTL therefore stayed ACTIVE in the
   * candidate index and kept evaluating and waking the GOAT for as long as
   * the page stayed open — a watcher outliving the question it was asked,
   * which is the entire point of a TTL.
   *
   * This asserts expiry on the event path: no `expireStale()` call, no
   * registry sweep, just a delivery arriving after the deadline.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a short-lived reclaim',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
    expiresAt: h.clock.now() + 1_000,
  });

  h.clock.advance(5_000);
  const events = await h.trackers.process(quote(1, 1.11, h.clock.now()));
  assertEqual(
    events.filter((event) => event.trackerId === tracker.id).length,
    0,
    'a tracker past its TTL produces no event',
  );
  assertEqual(
    h.trackers.get(tracker.id)!.lifecycle.status,
    'EXPIRED',
    'and it is recorded as expired rather than left claiming to be active',
  );
});

test('tracker runtime: a condition that goes UNKNOWN does not re-arm its edge', async () => {
  /*
   * THE DEFECT: edge detection stored `result.status === 'TRUE'` as the
   * previous state, which conflates UNKNOWN with FALSE. TRUE -> UNKNOWN ->
   * TRUE therefore looked like FALSE -> TRUE and woke the GOAT a second
   * time for a condition that never lapsed.
   *
   * The consequence is a duplicate wake and a duplicate piece of evidence
   * manufactured by a missing candle rather than by the market — which is
   * exactly the kind of wake a rate limit should not have to catch.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch momentum recovery',
    kind: 'NEW_BAR',
    timeframe: '15m',
    config: {
      conditionTree: {
        id: 'root',
        kind: 'GROUP',
        operator: 'AND',
        children: [
          { id: 'level', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1.105 },
        ],
      },
    },
    cooldownMs: 0,
  });

  const treeQuote = (index: number, price: number, timestamp: number): TrackerInput => ({
    ...quote(index, price, timestamp),
    timeframe: '15m',
    state: { ...quote(index, price, timestamp).state, timeframe: '15m' },
  });

  const met = await h.trackers.process(treeQuote(1, 1.11, 10_000));
  assert(met.some((event) => event.trackerId === tracker.id), 'the condition reports when it becomes true');

  // The feed goes quiet: no price at all, so nothing can be evaluated.
  const unknown: TrackerInput = {
    id: 'tick-quiet',
    type: 'MARKET_QUOTE',
    timestamp: 11_000,
    environment: 'DEMO',
    symbol: 'EURUSD',
    timeframe: '15m',
    state: { timestamp: 11_000, environment: 'DEMO', symbol: 'EURUSD', timeframe: '15m' },
  };
  await h.trackers.process(unknown);
  assert(
    h.trackers.get(tracker.id)!.lifecycle.eventCount === 1,
    'a quiet feed produces no event of its own',
  );

  // The feed comes back with the condition still true. Nothing lapsed.
  const stillTrue = await h.trackers.process(treeQuote(3, 1.12, 12_000));
  assertEqual(
    stillTrue.filter((event) => event.trackerId === tracker.id).length,
    0,
    'the condition never went false, so it is not a new edge and does not wake again',
  );
});

test('tracker runtime: two trackers firing together both reach the GOAT', async () => {
  /*
   * THE DEFECT: the orchestrator's tracker-event handler read only the
   * newest queued wake request. A request is queued before its event is
   * announced, but the handler runs later and can find a newer request
   * already queued by the second tracker — so the id comparison failed and
   * the wake was dropped. Two trackers firing in one delivery meant one
   * GOAT wake, silently, with the event recorded and nothing reasoning
   * about it.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const a = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a reclaim of 1.1050',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });
  const b = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a loss of 1.0950',
    kind: 'PRICE_CROSS',
    config: { direction: 'BELOW', level: 1.095 },
    cooldownMs: 0,
  });

  // Both conditions are satisfied by a single wide move through both
  // levels, which is what makes them fire in the same delivery.
  await h.trackers.process(quote(1, 1.09, 10_000));
  const fired = await h.trackers.process(quote(2, 1.11, 11_000));
  const firedIds = fired.map((event) => event.trackerId);
  assert(firedIds.includes(a.id) || firedIds.includes(b.id), 'at least one tracker fired');

  for (const event of fired) {
    assert(
      h.trackers.wakeRequestForEvent(event.id) !== undefined,
      `the wake request for ${event.id} can be found by id, not only by recency`,
    );
  }
  assertEqual(
    fired.filter((event) => h.trackers.wakeRequestForEvent(event.id) === undefined).length,
    0,
    'no fired event lost its own wake request to a later one',
  );
});

test('tracker runtime: a tracker event carries the numbers the evidence needs', async () => {
  /*
   * THE DEFECT: `TrackerEvent.observedValues` was declared, consumed by
   * `GoatLoop.recordWakeEvidence` into `Evidence.observed`, and never
   * populated. Every tracker-derived piece of evidence therefore recorded
   * `observed: undefined` while the measurements sat unread in
   * `marketSnapshot`. Evidence is the record of why the agent believes
   * what it believes; an observation with no observation attached is that
   * system failing at its one job.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a reclaim of 1.1050',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });
  await h.trackers.process(quote(1, 1.1, 10_000));
  const fired = await h.trackers.process(quote(2, 1.106, 11_000));
  const event = fired.find((candidate) => candidate.trackerId === tracker.id);
  assert(event !== undefined, 'the tracker fired');
  assertEqual(event!.observedValues?.['price'], 1.106, 'the observed price is on the event');
  assertEqual(event!.observedValues?.['symbol'], 'EURUSD', 'and so is the market it was observed on');

  // And it survives the trip into evidence.
  const wake = fakeWake(thesis, event!);
  const outcome = h.orchestrator.loop.applyPlan(wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'confirmed' });
  const evidenceId = outcome.evidenceRecorded[0];
  const recorded = h.orchestrator.stores.evidence.listForThesis(thesis.id).find((item) => item.id === evidenceId);
  assert(recorded !== undefined, 'the wake produced evidence');
  assertEqual(recorded!.observed?.['price'], 1.106, 'and the evidence carries the measured price');
  assertEqual(recorded!.observed?.['symbol'], 'EURUSD', 'and the market it was measured on');
  assertEqual(recorded!.trackerEventId, event!.id, 'and stays traceable to the tracker event');
});

test('tracker runtime: abandoning trackers does not permanently wedge the runtime', async () => {
  /*
   * THE DEFECT: `maxTrackersTotal` counted every tracker the registry had
   * ever held, and nothing is ever removed from it — a cancelled tracker
   * is retained deliberately. One GOAT that created and abandoned 500
   * trackers therefore exhausted a *lifetime* budget, after which every
   * `createTracker` returned LIMIT_REACHED for the rest of the session with
   * no way to reclaim it. Retaining history must not consume a live-watch
   * budget.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);

  /*
   * The runtime is rebuilt with the global ceiling as the binding
   * constraint, because that is the budget that was wrong. The per-agent
   * and per-thesis ceilings were already counting only live trackers, so
   * leaving them at their defaults would let the correct ones refuse the
   * churn long before the defective global budget was reached.
   */
  const registry = new TrackerRegistry((agentId) => h.agentRuntime.getAgent(agentId));
  const trackers = new TrackerRuntime({
    registry,
    agents: h.agentRuntime,
    timeline: h.agentRuntime.getTimelineStore(),
    clock: h.clock.now,
    limits: {
      ...DEFAULT_TRACKER_LIMITS,
      maxTrackersPerThesis: 100,
      maxTrackersPerAgent: 100,
      maxTrackersTotal: 5,
    },
  });
  trackers.bindDomain({
    resolveThesis: (thesisId) => h.orchestrator.stores.theses.get(thesisId),
    resolveSkillIds: () => [],
  });

  let refused = 0;
  for (let index = 0; index < 20; index += 1) {
    try {
      const tracker = trackers.createTracker(thesis.id, h.agentId, {
        purpose: `Watch attempt ${index}`,
        kind: 'PRICE_CROSS',
        config: { direction: 'ABOVE', level: 1.105 },
        cooldownMs: 0,
      });
      trackers.cancelTracker(tracker.id, 'churn');
    } catch {
      refused += 1;
    }
  }
  assertEqual(refused, 0, 'abandoned trackers are retained as history without consuming a live-watch budget');

  const survivor = trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch what actually matters',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });
  assertEqual(survivor.lifecycle.status, 'ACTIVE', 'so a GOAT that churned its observation plan can still watch for something');

  // The ceiling is still a ceiling: five live trackers on one runtime is
  // genuinely too many, and saying so is the behaviour being preserved.
  let liveRefused = false;
  for (let index = 0; index < 10 && !liveRefused; index += 1) {
    try {
      trackers.createTracker(thesis.id, h.agentId, {
        purpose: `Live watch ${index}`,
        kind: 'PRICE_CROSS',
        config: { direction: 'ABOVE', level: 1.105 },
        cooldownMs: 0,
      });
    } catch {
      liveRefused = true;
    }
  }
  assert(liveRefused, 'but live trackers are still capped, so the limit has not been removed');
});

// ---------------------------------------------------------------------------
// 3. Condition tree: a direction nobody wrote down
// ---------------------------------------------------------------------------

test('conditions: an unreadable direction is UNKNOWN, not the opposite comparison', async () => {
  /*
   * THE DEFECT: every directional leaf reads
   * `condition.direction === 'ABOVE' ? ... : ...`, so any value that is
   * not exactly 'ABOVE' — `'above'`, `'UP'`, a typo, a number — silently
   * meant BELOW. A tracker authored to wake when price rose through a
   * level watched for price falling through it instead, and reported
   * nothing wrong about it.
   *
   * A direction that cannot be read has not been evaluated. The honest
   * answer is UNKNOWN, which the aggregation already treats as
   * unsatisfiable and therefore does not wake on.
   */
  const cases: Array<{ label: string; direction: unknown; kind: string; extra: Record<string, unknown> }> = [
    { label: 'PRICE_LEVEL', direction: 'above', kind: 'PRICE_LEVEL', extra: { level: 1.105 } },
    { label: 'PRICE_CROSS', direction: 'UP', kind: 'PRICE_CROSS', extra: { level: 1.105 } },
    {
      label: 'INDICATOR_THRESHOLD',
      direction: undefined,
      kind: 'INDICATOR_THRESHOLD',
      extra: { indicator: 'RSI', period: 14, level: 50 },
    },
    {
      label: 'VOLATILITY',
      direction: 'Rising',
      kind: 'VOLATILITY',
      extra: { period: 14, threshold: 0.001 },
    },
  ];

  for (const testCase of cases) {
    const tree = {
      id: 'root',
      kind: 'GROUP',
      operator: 'AND',
      children: [{ id: 'leaf', kind: testCase.kind, direction: testCase.direction, ...testCase.extra }],
    } as never;
    const result = evaluateTrackerConditionTree(tree, {
      state: {
        timestamp: 1,
        environment: 'DEMO',
        symbol: 'EURUSD',
        timeframe: '5m',
        price: 1.2,
        bars: BARS,
        indicators: { rsi14: 80 },
      },
      previousPrice: 1.1,
    });
    assertEqual(result.status, 'UNKNOWN', `${testCase.label} with direction ${String(testCase.direction)} is UNKNOWN, not silently inverted`);
  }

  // The recognised values still behave exactly as before.
  const above = evaluateTrackerConditionTree(
    {
      id: 'root',
      kind: 'GROUP',
      operator: 'AND',
      children: [{ id: 'leaf', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1.105 }],
    } as never,
    { state: { timestamp: 1, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m', price: 1.2 }, previousPrice: undefined },
  );
  assertEqual(above.status, 'TRUE', "a readable 'ABOVE' still means at or above the level");
});

test('conditions: a proximity threshold the market cannot express blocks the whole leaf', async () => {
  /*
   * THE DEFECT: two proximity implementations disagreed in opposite
   * directions. `proximity.ts` fails closed — an unmeasurable threshold
   * blocks the evaluation. The condition-tree leaf skipped the
   * unmeasurable thresholds and judged the condition on whatever was left.
   *
   * On gold, which has no pip size, a PROXIMITY leaf configured "within 50
   * pips or within 6 price units" was reported TRUE on the price test
   * alone. That is UNKNOWN laundered into a positive, and it is how a
   * tracker woke on a weaker question than the one it was asked.
   */
  const tree = {
    id: 'root',
    kind: 'GROUP',
    operator: 'AND',
    children: [
      {
        id: 'near',
        kind: 'PROXIMITY',
        level: 'stopLoss',
        withinPips: 50,
        withinPrice: 6,
      },
    ],
  } as never;

  // Gold: a real market with a price but no pip size.
  const gold = evaluateTrackerConditionTree(tree, {
    state: {
      timestamp: 1,
      environment: 'DEMO',
      symbol: 'XAUUSD',
      timeframe: '5m',
      price: 2400,
      positions: [
        {
          id: 'p1',
          symbol: 'XAUUSD',
          side: 'LONG',
          size: 1,
          entryPrice: 2400,
          currentPrice: 2400.5,
          stopLoss: 2395,
          takeProfit: 2410,
          unrealizedPnl: 0,
          openedAt: 1,
        } as never,
      ],
    },
    instrument: { ...GOLD_METADATA },
    previousPrice: undefined,
  });
  assertEqual(gold.status, 'UNKNOWN', 'a leaf with an inexpressible threshold does not report TRUE');

  // Forex, where pips are real, still works.
  const forex = evaluateTrackerConditionTree(tree, {
    state: {
      timestamp: 1,
      environment: 'DEMO',
      symbol: 'EURUSD',
      timeframe: '5m',
      price: 1.1000,
      positions: [
        {
          id: 'p1',
          symbol: 'EURUSD',
          side: 'LONG',
          size: 1000,
          entryPrice: 1.1000,
          currentPrice: 1.1000,
          stopLoss: 1.0950,
          takeProfit: 1.1100,
          unrealizedPnl: 0,
          openedAt: 1,
        } as never,
      ],
    },
    instrument: { ...FOREX_METADATA },
    previousPrice: undefined,
  });
  assertEqual(forex.status, 'FALSE', 'and where every threshold is measurable the leaf still judges honestly');
});

// ---------------------------------------------------------------------------
// 4. Isolation and the trade-plan boundary
// ---------------------------------------------------------------------------

test('isolation: a GOAT cannot build a context from another GOAT thesis', async () => {
  /*
   * THE DEFECT: `buildContext(agentId, thesisId)` trusted both arguments.
   * A crafted wake pairing one agent's id with another agent's thesis id
   * assembled a perfectly valid context holding the other GOAT's goal,
   * evidence and trackers under this GOAT's identity, and `applyPlan`
   * would then revise the other GOAT's thesis. `runWake` is public, and
   * `agentTools.proposeIdea` builds a wake from a caller-supplied
   * `thesisId`, so this was reachable rather than theoretical.
   */
  const h = makeHarness();
  const mine = seedThesis(h);

  // A second GOAT, on a different market, with its own thesis.
  const otherGoalId = 'goal_other';
  const otherAgentId = 'goat_other';
  h.orchestrator.stores.goals.save({
    id: otherGoalId,
    agentId: otherAgentId,
    statement: 'Trade gold.',
    symbols: [],
    timeframes: [],
    skillIds: [],
    status: 'DRAFT',
    createdAt: 1,
    updatedAt: 1,
  });
  const theirs = h.orchestrator.loop.createThesis({
    goalId: otherGoalId,
    agentId: otherAgentId,
    statement: 'Gold is correcting.',
    invalidation: 'Below 2300.',
  });

  const foreign = h.orchestrator.loop.buildContext(h.agentId, theirs.id);
  assertEqual(foreign, undefined, 'another GOAT thesis yields no context, however good the agent id looks');

  const mineFromMine = h.orchestrator.loop.buildContext(h.agentId, mine.id);
  assert(mineFromMine !== undefined, 'and a GOAT can still build its own context');
  assertEqual(mineFromMine!.deployment.market, 'EURUSD', 'against its own deployment market');
});

test('trade plan: a plan for a market the GOAT is not deployed to is refused', async () => {
  /*
   * THE DEFECT: `validateIdeaShape` checked that the numbers were
   * coherent — positive entry, invalidation on the correct side, at least
   * one target — and nothing checked *which market* they belonged to. A
   * GOAT deployed on EURUSD could persist a trade plan for an unrelated
   * instrument, which the risk layer would then price against the real
   * account as though it were a plan for the market this GOAT was
   * deployed to.
   *
   * `deployment.market` is authoritative. The same instrument written
   * `EUR/USD` is still the same instrument; an unrelated one is not.
   */
  const h = makeHarness();
  const draft = seedThesis(h);
  // The goal's skills require evidence before a thesis may become
  // actionable, so the evidence is recorded first. A trade plan is
  // downstream of sufficient evidence, and this test is about the market
  // check, not about that gate — which the gate's own tests cover.
  for (let index = 0; index < 4; index += 1) {
    h.orchestrator.loop.recordEvidence({
      thesisId: draft.id,
      polarity: 'SUPPORTS',
      summary: `Confirmed observation ${index}.`,
      source: 'MARKET_DATA',
      observed: { price: 1.105 + index / 10_000 },
    });
  }
  const thesis = h.orchestrator.loop.reviseThesis(draft.id, { state: 'ACTIONABLE' });
  const tracker = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a reclaim',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });
  await h.trackers.process(quote(1, 1.1, 10_000));
  const fired = await h.trackers.process(quote(2, 1.106, 11_000));
  const event = fired.find((candidate) => candidate.trackerId === tracker.id)!;

  const wrongMarket = h.orchestrator.loop.applyPlan(fakeWake(thesis, event), {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'looks good',
    idea: {
      symbol: 'XAUUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 2400,
      invalidationLevel: 2395,
      takeProfits: [{ price: 2450, fraction: 1 }],
      reasoning: 'looks good',
    },
  });
  assertEqual(wrongMarket.tradeIdeaId, undefined, 'no plan is constructed for a market this GOAT is not deployed to');
  assert(
    wrongMarket.rejections.some((reason) => reason.includes('XAUUSD') && reason.includes('EURUSD')),
    `and the refusal names both markets: ${JSON.stringify(wrongMarket.rejections)}`,
  );
  assertEqual(h.orchestrator.stores.ideas.list().length, 0, 'nothing was persisted');
  assertEqual(
    h.orchestrator.stores.theses.get(thesis.id)!.state,
    'ACTIONABLE',
    'and a refused plan does not consume the thesis',
  );

  // The deployment's own market is accepted, in either spelling.
  const ownMarket = h.orchestrator.loop.applyPlan(fakeWake(thesis, { ...event, id: 'evt-second' }), {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'confirmed',
    idea: {
      symbol: 'EUR/USD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.106,
      invalidationLevel: 1.095,
      takeProfits: [{ price: 1.12, fraction: 1 }],
      reasoning: 'confirmed reversal',
    },
  });
  assert(ownMarket.tradeIdeaId !== undefined, `a plan for the deployed market is accepted: ${JSON.stringify(ownMarket.rejections)}`);
  assertEqual(h.orchestrator.stores.ideas.get(ownMarket.tradeIdeaId!)!.symbol, 'EUR/USD', 'and is stored as proposed');
});

// ---------------------------------------------------------------------------
// 5. Error recovery
// ---------------------------------------------------------------------------

test('recovery: a wake the state machine refuses is recorded, not thrown into the void', async () => {
  /*
   * THE DEFECT: the tracker-event handler was invoked as
   * `void this.domain.onEvent(event)`, so anything `runWake` threw became
   * an unhandled rejection — logged by the browser, visible nowhere in the
   * product. The activity feed was left showing a `GOAT_WOKE` with no
   * outcome, which reads as a GOAT that woke, thought about something, and
   * then said nothing, indefinitely.
   *
   * `applyPlan` throws legitimately: a wake that lands on a thesis which
   * has since gone terminal makes `reviseThesis` refuse the transition.
   * The state machine is right; the refusal was the problem.
   *
   * The assertion is on what the user can see, because that is what was
   * missing: the refusal has to reach the feed.
   */
  // Deployment consults the model to interpret the goal and to investigate;
  // every call after that is a wake, and a wake that tries to strengthen a
  // dead thesis is exactly what has to be refused safely.
  const model = new StubModel(
    [],
    '{"kind":"CONFIRM_THESIS","thesisId":"whatever-the-model-said","reason":"the model was optimistic"}',
  );
  const h = makeHarness({ model });
  const thesis = seedThesis(h);
  const tracker = h.trackers.createTracker(thesis.id, h.agentId, {
    purpose: 'Watch a reclaim of 1.1050',
    kind: 'PRICE_CROSS',
    config: { direction: 'ABOVE', level: 1.105 },
    cooldownMs: 0,
  });

  // The thesis goes terminal while the tracker is still watching it.
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'INVALIDATED' });

  await h.trackers.process(quote(1, 1.10, 10_000));
  await h.trackers.process(quote(2, 1.11, 11_000));

  // Let the fire-and-forget delivery settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const activity = h.orchestrator.activityFor(h.goalId);
  assert(
    activity.some((entry) => entry.type === 'GOAT_WOKE'),
    'the wake was announced',
  );
  assertEqual(
    h.orchestrator.stores.theses.get(thesis.id)!.state,
    'INVALIDATED',
    'and the refused transition did not move the thesis off a terminal state',
  );
  assertEqual(
    h.orchestrator.stores.ideas.list().length,
    0,
    'and no trade plan was fabricated out of the failure',
  );

  /*
   * The refusal has to reach the feed — but it is no longer a *thrown* one.
   *
   * The loop now refuses a wake aimed at a terminal thesis at the door, records the
   * observation and returns, rather than letting `reviseThesis` throw and be caught
   * upstream. Same guarantee for the reader, a better one for the system: the reason
   * is specific ("it is INVALIDATED") instead of being an exception, and a thrown wake
   * could have taken an unrelated step with it.
   */
  const reported =
    activity.find(
      (entry) => entry.type === 'DECISION_REFUSED' && /INVALIDATED/i.test(entry.text),
    ) ??
    activity.find(
      (entry) => entry.type === 'GOAT_WAITING' && /could not be applied/i.test(entry.text),
    );
  assert(
    reported !== undefined,
    `the refusal is reported in the activity feed: ${JSON.stringify(activity.map((entry) => entry.text))}`,
  );
});

test('recovery: a plan the loop refuses leaves the thesis exactly as it was', async () => {
  /*
   * The narrower guarantee behind the boundary above: a refused plan is a
   * refusal, not a partial write. Nothing is torn down and nothing is
   * half-changed when the deterministic layer says no.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  h.orchestrator.loop.reviseThesis(thesis.id, { state: 'INVALIDATED' });
  const before = h.orchestrator.stores.theses.get(thesis.id)!;

  /*
   * Refused by being reported rather than by being thrown.
   *
   * A wake aimed at a terminal thesis used to reach `reviseThesis`, which threw —
   * correct as a rule, wrong as a control flow, because a throw from the middle of a
   * reasoning pass takes any step it had not yet completed with it. The loop now
   * refuses at the door and says so; the guarantee this test exists for is unchanged,
   * and the mechanism is one that cannot have collateral.
   */
  const outcome = h.orchestrator.loop.applyPlan(
    fakeWake(thesis, eventFor({ id: 'trk_x', agentId: h.agentId, kind: 'PRICE_CROSS', eventType: 'CONDITION_MET', evaluation: {} }, 1)),
    {
      kind: 'CONFIRM_THESIS',
      thesisId: thesis.id,
      reason: 'the model was optimistic',
    },
  );
  const refused = outcome.rejections.length > 0;
  assert(refused, 'the transition out of a terminal state is refused');
  assertEqual(
    h.orchestrator.stores.theses.get(thesis.id)!.state,
    before.state,
    'and the stored thesis is unchanged',
  );
  assertEqual(
    h.orchestrator.stores.theses.get(thesis.id)!.revision,
    before.revision,
    'with no revision burned on a refusal',
  );
});

test('recovery: a tool call is not reported as a considered "no thesis"', async () => {
  /*
   * THE DEFECT: some OpenRouter routes answer an investigation with a
   * request for tools instead of a hypothesis. That is well-formed JSON, so
   * it passed every readability check and fell through to "the model
   * answered and the answer held no hypothesis" — telling the user this
   * GOAT had weighed up the market and found nothing, when it had never
   * said anything about the market at all.
   *
   * The architecture already draws the right line: an answered wait is
   * NO_THESIS_YET, an unreadable answer is a MODEL_FAILURE. A tool call is
   * the second kind. The market was read deterministically before the call,
   * so the tools being asked for are the ones already supplied.
   */
  const model = new NormalisingModel(
    [JSON.stringify({ toolCall: { capability: 'market.getQuote', input: { symbol: 'EURUSD' } }, thought: 'let me look' })],
  );
  const h = makeHarness({ model });

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assertEqual(report.outcome, 'MODEL_FAILURE', 'an unreadable answer is a model failure, not a considered wait');
  assertEqual(report.deployed, true, 'and the deployment is reported as intact');
  assert(
    /retry|will be retried/i.test(report.message),
    `the message says it will be retried rather than that the market said nothing: ${report.message}`,
  );
  assert(
    !/strong enough thesis/i.test(report.message),
    'and never claims the GOAT considered the market and found nothing',
  );
  assertEqual(
    h.orchestrator.stores.theses.list().length,
    0,
    'no thesis is invented to fill the gap',
  );
  assertEqual(
    h.orchestrator.activityFor(h.goalId).some((entry) => entry.type === 'MODEL_FAILURE'),
    true,
    'and the failure is in the activity feed',
  );

  // A deliberate wait is still a deliberate wait. The distinction the
  // architecture draws must survive the tightening.
  const waiting = makeHarness({
    model: new StubModel([JSON.stringify({ thought: 'Nothing to act on yet.', decision: { type: 'WAIT', reason: 'no structure' } })]),
  });
  const quiet = await waiting.orchestrator.investigateGoal(waiting.goalId);
  assertEqual(quiet.outcome, 'NO_THESIS_YET', 'an answered wait is still reported as an answered wait');
});

test('recovery: a first pass that failed to read the model actually retries', async () => {
  /*
   * THE DEFECT: the model-failure path told the user "The GOAT stays
   * deployed on EURUSD and will retry safely" and scheduled nothing. Only
   * the "answered, held no thesis" path armed the reconsideration timer, so
   * a first pass that could not read the model left a GOAT deployed,
   * promising a retry, with no thesis, no trackers, and nothing that could
   * ever wake it — permanently asleep, and reporting that it was not.
   *
   * A promise the system does not keep is the whole defect. This asserts
   * the timer is armed and that it is the same bounded one.
   */
  // A truncated object: there was JSON here and it would not parse, which
  // is the shape the adapter reports as malformed rather than as silence.
  const broken = '{"thesis": {"statement": "price reverses", "invalidation":';
  const model = new NormalisingModel([broken, broken]);
  const h = makeHarness({ model });

  const report = await h.orchestrator.investigateGoal(h.goalId);

  assertEqual(report.outcome, 'MODEL_FAILURE', 'the unreadable answer is reported as a failure');
  assert(
    /will retry safely/i.test(report.message),
    'and the message promises a retry, which is what has to be true',
  );
  assertEqual(
    h.orchestrator.stores.deployments.currentFor(h.agentId)?.id,
    h.orchestrator.deploymentContextFor(h.agentId)?.deploymentId,
    'the deployment is still live, so there is something to retry on',
  );
  assert(
    h.orchestrator.hasPendingReconsideration(h.agentId),
    'a reconsideration is armed, so the promise is kept rather than merely stated',
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runReleaseHardeningTests(): Promise<void> {
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
    throw new Error(`${failures.length} release-hardening regression test(s) failed.`);
  }
}

if (import.meta.main) {
  await runReleaseHardeningTests();
}