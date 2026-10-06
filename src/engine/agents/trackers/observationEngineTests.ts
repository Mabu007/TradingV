import { AgentRuntime } from '../runtime';
import { AgentPolicy, ITradingEnvironment, TradingAgent } from '../types';
import { AgentModelRequest, IAgentModel } from '../model/types';
import { SkillRegistry } from '../skills/registry';
import { CapabilityRegistry } from '../capabilities/registry';
import { ActionValidator } from '../policy/validator';
import { InMemoryAgentTimelineStore } from '../timeline';
import { TrackerRuntime } from './runtime';
import { TrackerEvaluator } from './evaluator';
import { TrackerRegistry } from './registry';
import {
  Tracker,
  TrackerConfig,
  TrackerEvent,
  TrackerInput,
  TrackerKind,
  TrackerObservationBatch,
  TrackerThesisView,
} from './types';
import { Bar, Position } from '../../../types/trading';
import { InstrumentMetadata } from '../../../types/instruments';
import { NormalizedQuote } from '../../../types/quotes';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

const policy: AgentPolicy = {
  maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 10_000, maxOrdersPerMinute: 2,
  allowedSymbols: ['EURUSD'], allowTrading: false,
};
const quote: NormalizedQuote = { symbol: 'EURUSD', symbolId: '1', bid: 1.1, ask: 1.1001, spread: 0.7, timestamp: 1000, status: 'MOCK' };
const bar: Bar = { time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 };

/*
 * Published under the symbol the runtime looks it up by, because a metadata entry
 * the runtime cannot find is indistinguishable from metadata that does not exist —
 * and these two tests are about what happens when it exists.
 */
const instrument: InstrumentMetadata = {
  symbol: 'EURUSD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX', provider: 'HYPERLIQUID',
  providerSymbol: 'EURUSD', providerMarketId: 'xyz:EUR', providerDex: 'xyz',
  baseCurrency: 'EUR', quoteCurrency: 'USD', pricePrecision: 5, sizePrecision: 1,
  tickSize: 0.00001, pipSize: 0.0001, lotSize: 100_000,
};

function makeAgent(id: string, symbols: string[]): TradingAgent {
  return {
    id, name: id, description: 'test agent', instructions: '', skills: ['observation'], capabilities: [],
    policy: { ...policy, allowedSymbols: symbols }, preferredEnvironment: 'DEMO', symbols, enabled: true,
    createdAt: 1, updatedAt: 1,
  };
}

function makeTracker(
  id: string,
  agentId: string,
  kind: TrackerKind,
  config: TrackerConfig,
  extra: { cooldownMs?: number; priority?: number; thesisId?: string; symbol?: string } = {},
): Tracker {
  const { cooldownMs, priority, thesisId, symbol } = extra;
  return {
    id,
    agentId,
    kind,
    config,
    purpose: `Observe ${kind} on the agent's market.`,
    eventType: 'CONDITION_MET',
    dependencies: [],
    dataRequirements: [],
    evaluation: { priority: priority ?? 0, cooldownMs: cooldownMs ?? 0, maxEventsPerMinute: 10 },
    lifecycle: { status: 'ACTIVE', eventCount: 0 },
    ...(thesisId ? { thesisId } : {}),
    ...(symbol ? { symbol } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * An evaluator that throws, standing in for a tracker whose inputs it cannot
 * measure. The evaluator is written to survive ordinary input, so this is the only
 * honest way to reach the failure policy — and reaching it is the point.
 */
function failingEvaluator(shouldFail: boolean, context = 'evaluator'): TrackerEvaluator {
  const evaluator = new TrackerEvaluator();
  if (!shouldFail) return evaluator;
  return new Proxy(evaluator, {
    get(target, property, receiver) {
      if (property === 'evaluate') return () => { throw new Error(`instrument metadata is missing a tick size (${context})`); };
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as TrackerEvaluator;
}

function environment(overrides: Partial<ITradingEnvironment> = {}): ITradingEnvironment {
  return {
    mode: 'DEMO',
    async getMarketQuote(symbol) { return { ...quote, symbol }; },
    async getMarketBars() { return [bar]; },
    async getAccountState() { return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 }; },
    async getPositions(): Promise<Position[]> { return []; },
    async getOrders() { return []; },
    async placeMarketOrder() { return { success: false, error: 'unused' }; },
    async modifyPosition() { return { success: false, error: 'unused' }; },
    async closePosition() { return { success: false, error: 'unused' }; },
    async getInstruments() { return [instrument]; },
    ...overrides,
  } as ITradingEnvironment;
}

/** A thesis view good enough for a wake to be built. */
const thesis = (id: string, agentId: string): TrackerThesisView => ({
  id,
  goalId: 'goal-1',
  agentId,
  statement: `A thesis owned by ${agentId}.`,
  state: 'ACTIVE',
  confidence: 0.5,
  revision: 1,
});

/**
 * A runtime wired the way the GOAT wires it: one agent, one registry, a timeline,
 * and a domain binding that records what it was woken with.
 */
async function harness(options: {
  trackers: Tracker[];
  agentIds?: string[];
  bind?: boolean;
  evaluatorFactory?: (evaluationKey: string, tracker: Tracker) => TrackerEvaluator;
  env?: ITradingEnvironment;
  now?: () => number;
} = {
  trackers: [],
}): Promise<{
  trackers: TrackerRuntime;
  registry: TrackerRegistry;
  timeline: InMemoryAgentTimelineStore;
  env: ITradingEnvironment;
  wakes: Array<{ event: TrackerEvent; batch?: TrackerObservationBatch }>;
}> {
  const timeline = new InMemoryAgentTimelineStore();
  const model: IAgentModel = { async run(_request: AgentModelRequest) { return { thought: 'observed', decision: { type: 'WAIT', reason: 'not acting' } }; } };
  const skills = new SkillRegistry();
  skills.register({ id: 'observation', name: 'Observation', description: 'Read market', instructions: '', requiredCapabilities: [], enabled: true });
  const agents = new AgentRuntime(new CapabilityRegistry(), skills, new ActionValidator(), model, timeline);
  const env = options.env ?? environment();
  for (const agentId of options.agentIds ?? [...new Set(options.trackers.map((tracker) => tracker.agentId))]) {
    const agent = makeAgent(agentId, ['EURUSD']);
    agents.registerAgent(agent, env);
    await agents.start(agentId);
  }

  const registry = new TrackerRegistry((id) => agents.getAgent(id));
  for (const tracker of options.trackers) registry.register(tracker);

  const wakes: Array<{ event: TrackerEvent; batch?: TrackerObservationBatch }> = [];
  const runtime = new TrackerRuntime({
    registry,
    agents,
    timeline,
    clock: options.now ?? (() => 0),
    ...(options.evaluatorFactory ? { evaluatorFactory: options.evaluatorFactory } : {}),
  });
  if (options.bind !== false) {
    runtime.bindDomain({
      /*
       * Every thesis in these tests belongs to the agent that armed the tracker,
       * and the runtime only asks which thesis owns a tracker — it never reasons
       * about the thesis here. One honest answer for all of them is enough.
       */
      resolveThesis: (thesisId) => {
        const owner = registry.list().find((tracker) => tracker.thesisId === thesisId);
        return thesis(thesisId, owner?.agentId ?? 'agent');
      },
      resolveSkillIds: () => [],
      onEvent: (event, batch) => { wakes.push({ event, batch }); },
    });
  }
  return { trackers: runtime, registry, timeline, env, wakes };
}

/**
 * One delivery.
 *
 * Note that a tracker measures a *crossing*, not a level: the evaluator needs a
 * previous sample to have seen the other side of the line. So every scenario here
 * primes the runtime below the level and then crosses it, which is what a live
 * session does for free and what a test has to say out loud.
 */
const tick = (id: string, price: number, timestamp: number): TrackerInput => ({
  id,
  type: 'TICK',
  timestamp,
  environment: 'DEMO',
  symbol: 'EURUSD',
  sourceEventId: `src:${id}`,
  state: { timestamp, symbol: 'EURUSD', price, spread: 0.7, environment: 'DEMO', bars: [bar] },
});

/**
 * The observation engine.
 *
 * Two claims are tested here, and they are the ones the architecture rests on:
 *
 *  1. One market movement wakes the GOAT once. Several trackers satisfied by one
 *     delivery are one observation of one thing, and the runtime delivers them as
 *     one frame — without merging them, losing them, or inventing a market event
 *     to stand for them.
 *
 *  2. A tracker that cannot evaluate what it is given is isolated, quietly, and
 *     only after saying so three times. Everything else keeps running.
 */
export async function runTrackerObservationEngineTests(): Promise<void> {
  await batchingCoalescesOneDeliveryIntoOneWake();
  await batchingNeverMergesSeparateIdentities();
  await batchingKeepsEveryObservationIndividuallyAddressable();
  await batchingIsDeterministicRegardlessOfRegistrationOrder();
  await batchingSupersedesPerEventDelivery();
  await duplicateDeliveriesProduceOneWake();
  await circuitBreakerIsolatesOneTrackerAfterThreeFailures();
  await circuitBreakerResetsOnSuccessAndOnRecovery();
  await quarantinedTrackerDoesNotStopTheOthers();
  await lifecycleRefusalProducesNoObservationAndNoWake();
  await disposalStopsAnInFlightEvaluation();
  await instrumentLookupFailureIsNotRememberedForever();
  await positionEventsAreNotDuplicatedByTheFrame();
}

/**
 * Three trackers on one market, all satisfied by one delivery, are one wake.
 *
 * And the frame is not a summary: it carries all three observations, each with its
 * own id, its own tracker, and the same source event — which is the fact the
 * reasoning layer needs to decide for itself that they are not three independent
 * confirmations.
 */
async function batchingCoalescesOneDeliveryIntoOneWake(): Promise<void> {
  const trackers = [
    makeTracker('threshold', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 2 }),
    makeTracker('cross', 'agent-a', 'PRICE_CROSS', { direction: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
    makeTracker('breakout', 'agent-a', 'BREAKOUT', { direction: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 3 }),
  ];
  const { trackers: runtime, wakes } = await harness({ trackers });

  await runtime.process(tick('p0', 9, 900));
  await runtime.process(tick('d1', 11, 1_000));

  assertEqual(wakes.length, 1, 'three observations of one delivery wake the GOAT once');
  const batch = wakes[0]!.batch;
  assert(batch !== undefined, 'the wake carries the frame it came from');
  assertEqual(batch.events.length, 3, 'the frame holds every observation the delivery produced');
  assert(
    new Set(batch.events.map((event) => event.id)).size === 3,
    'no observation is collapsed into another',
  );
  assert(
    batch.events.every((event) => event.sourceEventId === 'src:d1'),
    'every observation names the delivery that produced it',
  );
  assert(
    batch.events.some((event) => event.id === batch.primaryEventId),
    'the frame names the observation it is addressed to',
  );
  /*
   * The strongest observation leads, because it is the one that matters most and
   * the one a reader looks for first. Order is a promise, not an accident of
   * registration.
   */
  assertEqual(batch.events[0]!.trackerId, 'breakout', 'the highest-priority observation leads the frame');
  assertEqual(batch.primaryEventId, batch.events[0]!.id, 'and it is the one the wake is addressed to');
  assertEqual(batch.batchId, `batch:DEMO:agent-a:thesis:agent-a:EURUSD:src:d1`, 'a frame identifies itself by what produced it');
  assertEqual(batch.environment, 'DEMO', 'the frame knows which environment it came from');
  assertEqual(batch.observationTimestamp, 1_000, 'and when it was observed');
}

/**
 * The frame is only as wide as the observation.
 *
 * Two GOATs, two theses, two markets or two deliveries are four different things
 * and must never be gathered into one wake, however close together they arrive.
 * Nothing here reads a clock, so "close together" is not even a question.
 */
async function batchingNeverMergesSeparateIdentities(): Promise<void> {
  const trackers = [
    makeTracker('a-thesis', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:one', priority: 5 }),
    makeTracker('a-other', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:two', priority: 4 }),
    makeTracker('b-thesis', 'agent-b', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:one', priority: 3 }),
  ];
  const { trackers: runtime, wakes } = await harness({ trackers });

  // Two crossings, so each delivery genuinely produces observations.
  await runtime.process(tick('p0', 9, 900));
  await runtime.process(tick('d1', 11, 1_000));
  await runtime.process(tick('d2', 9, 2_000));
  await runtime.process(tick('d3', 11, 3_000));

  assertEqual(wakes.length, 6, 'two crossings across two theses and two GOATs are six frames');
  assert(
    wakes.every((wake) => wake.batch?.events.length === 1),
    'no frame ever borrowed another\'s observation',
  );
  const thesisOne = wakes.filter((wake) => wake.event.thesisId === 'thesis:one');
  assertEqual(thesisOne.length, 4, 'one thesis per GOAT per crossing is four separate observations');
  assert(
    new Set(thesisOne.map((wake) => wake.event.agentId)).size === 2,
    'the same thesis id under two GOATs stays two frames',
  );
  assertEqual(
    new Set(thesisOne.map((wake) => wake.batch!.sourceEventId)).size,
    2,
    'and two separate deliveries stay two frames, however alike the moment',
  );
}

/**
 * Batching changes delivery, not the record.
 *
 * Everything the runtime knew before batching must still be knowable after it: each
 * observation by id, by tracker, each with its own wake request. A caller that
 * wants one specific observation gets exactly that one, and can see the frame it
 * belonged to.
 */
async function batchingKeepsEveryObservationIndividuallyAddressable(): Promise<void> {
  const trackers = [
    makeTracker('first', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
    makeTracker('second', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 2 }),
  ];
  const { trackers: runtime } = await harness({ trackers });

  await runtime.process(tick('p0', 9, 900));
  await runtime.process(tick('d1', 11, 1_000));

  const events = runtime.listEvents();
  assertEqual(events.length, 2, 'both observations are recorded');
  assertEqual(runtime.listEventsForTracker('first').length, 1, 'and each is retrievable by its own tracker');
  assertEqual(runtime.listEventsForTracker('second').length, 1, 'including the one that was not the wake\'s primary');

  for (const event of events) {
    const request = runtime.wakeRequestForEvent(event.id);
    assert(request !== undefined, `a wake request exists for ${event.id}`);
    assertEqual(request!.event.id, event.id, 'the request is addressed to its own observation');
    assertEqual(request!.batch?.batchId, 'batch:DEMO:agent-a:thesis:agent-a:EURUSD:src:d1', 'and carries the frame it arrived in');
    assertEqual(request!.batch?.events.length, 2, 'the frame is whole from every one of its members');
  }
}

/**
 * The same market, the same trackers, the same answer — in any order.
 *
 * Registration order is an accident of how the file was written. Two replays of
 * one session that registered the same trackers in a different order must produce
 * the same frames with the same leaders, or a backtest is not reproducible.
 */
async function batchingIsDeterministicRegardlessOfRegistrationOrder(): Promise<void> {
  const definitions = [
    makeTracker('zebra', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
    makeTracker('alpha', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
    makeTracker('middle', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
  ];

  const forwards = await harness({ trackers: definitions });
  await forwards.trackers.process(tick('p0', 9, 900));
  await forwards.trackers.process(tick('d1', 11, 1_000));
  const backwards = await harness({ trackers: [...definitions].reverse() });
  await backwards.trackers.process(tick('p0', 9, 900));
  await backwards.trackers.process(tick('d1', 11, 1_000));

  assertEqual(
    forwards.wakes[0]!.batch!.batchId,
    backwards.wakes[0]!.batch!.batchId,
    'the frame identifies itself identically in both runs',
  );
  assertEqual(
    forwards.wakes[0]!.batch!.events.map((event) => event.trackerId).join(','),
    backwards.wakes[0]!.batch!.events.map((event) => event.trackerId).join(','),
    'and orders identically',
  );
  /*
   * Equal priority means the id decides, ascending — so the same observation leads
   * every time, and it is never whichever tracker happened to be registered first.
   */
  assertEqual(forwards.wakes[0]!.batch!.primaryEventId, `${'alpha'}:d1`, 'ties are broken by id, ascending');
  assertEqual(backwards.wakes[0]!.batch!.primaryEventId, `${'alpha'}:d1`, 'and not by registration order');
}

/**
 * The frame replaces the per-observation wake; it does not add to it.
 *
 * A single observation is the degenerate frame, and it is delivered exactly once.
 * If both paths ran, every wake would be doubled — which is not slow, it is wrong:
 * the GOAT would reason about the same movement twice and could read the second
 * pass as new information.
 */
async function batchingSupersedesPerEventDelivery(): Promise<void> {
  const { trackers: runtime, wakes } = await harness({
    trackers: [makeTracker('only', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' })],
  });

  await runtime.process(tick('p0', 9, 900));
  await runtime.process(tick('d1', 11, 1_000));
  assertEqual(wakes.length, 1, 'one observation is delivered once');

  // A standalone ingest is a frame of one, and is delivered exactly once too.
  const standalone = runtime.listEvents()[0]!;
  runtime.ingestEvent({ ...standalone, id: `${standalone.id}:manual` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(wakes.length, 2, 'an observation ingested on its own is still delivered exactly once');
}

/**
 * The same delivery twice is one observation.
 *
 * A replay, a re-poll and a duplicated bus message are the same market moment
 * arriving more than once, and a GOAT woken three times for one tick would read it
 * as three.
 */
async function duplicateDeliveriesProduceOneWake(): Promise<void> {
  const trackers = [
    makeTracker('first', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', cooldownMs: 0 }),
    makeTracker('second', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', cooldownMs: 0 }),
  ];
  const { trackers: runtime, wakes } = await harness({ trackers });

  await runtime.process(tick('p0', 9, 900));
  const delivery = tick('d1', 11, 1_000);
  await runtime.process(delivery);
  await runtime.process(delivery);
  await runtime.process(delivery);

  assertEqual(wakes.length, 1, 'a repeated delivery wakes the GOAT once');
  assertEqual(runtime.listEvents().length, 2, 'and produces no second set of observations');
  assertEqual(wakes[0]!.batch!.events.length, 2, 'the frame is the one that was delivered');
}

/**
 * Three failures in a row, and only then.
 *
 * One failure is a fact about a delivery; three is a fact about a tracker. The
 * tracker is isolated, the failure is written down once, and the other trackers on
 * the same market keep working — because a broken watch must not be able to take
 * the market down with it.
 *
 * The prices alternate because a tracker measures a crossing: the healthy tracker
 * has to be able to keep reporting for "it kept working" to mean anything.
 */
async function circuitBreakerIsolatesOneTrackerAfterThreeFailures(): Promise<void> {
  const trackers = [
    makeTracker('broken', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 9 }),
    makeTracker('healthy', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a', priority: 1 }),
  ];
  const { trackers: runtime, registry, timeline, wakes } = await harness({
    trackers,
    evaluatorFactory: (_key, tracker) => failingEvaluator(tracker.id === 'broken'),
  });

  const cross = async (id: string, price: number, timestamp: number): Promise<void> => {
    await runtime.process(tick(id, price, timestamp));
  };

  // Deliveries p0, d1, p1 are three consecutive failures; the crossings are what
  // give the healthy tracker something to report.
  await cross('p0', 9, 900);
  assertEqual(registry.get('broken')?.lifecycle.status, 'ACTIVE', 'one failure does not isolate a tracker');

  await cross('d1', 11, 1_000);
  assertEqual(registry.get('broken')?.lifecycle.status, 'ACTIVE', 'nor does two');
  assertEqual(wakes.length, 1, 'and the healthy tracker reported through both');

  await cross('p1', 9, 1_900);
  assertEqual(registry.get('broken')?.lifecycle.status, 'FAILED', 'the third failure in a row isolates the tracker');
  assert(
    registry.get('broken')?.lifecycle.failureReason?.includes('3 times in a row'),
    'and says how many failures it took',
  );
  assertEqual(registry.get('healthy')?.lifecycle.status, 'ACTIVE', 'the other tracker is untouched');

  const rows = (await timeline.getByAgent('agent-a')).filter((row) => row.type === 'ERROR');
  const quarantines = rows.filter((row) => (row.data as { code?: string }).code === 'TRACKER_QUARANTINED');
  assertEqual(quarantines.length, 1, 'the isolation is written down exactly once');
  assert(
    (quarantines[0]!.data as { message: string }).message.includes('instrument metadata is missing a tick size'),
    'and says what went wrong',
  );
  assertEqual(
    rows.filter((row) => (row.data as { code?: string }).code !== 'TRACKER_QUARANTINED').length,
    2,
    'the two failures that were tolerated were recorded as failures, not ignored',
  );

  // And it stays quiet: an isolated tracker stops evaluating rather than failing on
  // every tick for the rest of the session.
  await cross('d2', 11, 3_000);
  await cross('p2', 9, 3_900);
  await cross('d3', 11, 4_000);
  assertEqual(wakes.length, 3, 'an isolated tracker produces no further observations');
  assert(
    !runtime.listEvents().some((event) => event.trackerId === 'broken'),
    'and none at all',
  );
}

/**
 * Recovery is real recovery, not a pause.
 *
 * A success in between makes the next failure the first one again, and reactivating
 * an isolated tracker gives it back a clean slate — a repaired watcher that still
 * remembers three failures is one bad delivery away from being isolated again.
 */
async function circuitBreakerResetsOnSuccessAndOnRecovery(): Promise<void> {
  let fail = true;
  const { trackers: runtime, registry } = await harness({
    trackers: [makeTracker('flaky', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' })],
    evaluatorFactory: () => ({
      evaluate: () => { if (fail) throw new Error('cannot evaluate'); return 'Price crossed above 10.'; },
      reset: () => {},
    }) as unknown as TrackerEvaluator,
  });

  const deliver = async (id: string, timestamp: number): Promise<void> => {
    await runtime.process(tick(id, 11, timestamp));
  };

  await deliver('d1', 1_000);
  await deliver('d2', 2_000);
  fail = false;
  await deliver('d3', 3_000);
  fail = true;
  await deliver('d4', 4_000);
  await deliver('d5', 5_000);
  assertEqual(registry.get('flaky')?.lifecycle.status, 'ACTIVE', 'a success between failures resets the count');

  await deliver('d6', 6_000);
  assertEqual(registry.get('flaky')?.lifecycle.status, 'FAILED', 'so it takes three again, not two');

  fail = false;
  runtime.updateTracker('flaky', { purpose: 'metadata repaired' });
  assertEqual(registry.get('flaky')?.lifecycle.status, 'ACTIVE', 'reactivating brings the tracker back');

  fail = true;
  await deliver('d7', 7_000);
  await deliver('d8', 8_000);
  assertEqual(registry.get('flaky')?.lifecycle.status, 'ACTIVE', 'a recovered tracker starts its count from nothing');
  await deliver('d9', 9_000);
  assertEqual(registry.get('flaky')?.lifecycle.status, 'FAILED', 'and is only isolated after three fresh failures');
}

/**
 * Isolation is containment, not shutdown.
 *
 * The failure is scoped to one tracker in one environment. Everything watching the
 * same market — including a second GOAT's tracker — keeps reporting, because the
 * alternative is one bad evaluator silencing a whole portfolio.
 */
async function quarantinedTrackerDoesNotStopTheOthers(): Promise<void> {
  const trackers = [
    makeTracker('demo-broken', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' }),
    makeTracker('demo-fine', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' }),
    makeTracker('other-agent', 'agent-b', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' }),
  ];
  const { trackers: runtime, registry } = await harness({
    trackers,
    evaluatorFactory: (key, tracker) => failingEvaluator(tracker.id === 'demo-broken', key),
  });

  for (const [index, price] of [9, 11, 9, 11, 9, 11].entries()) {
    await runtime.process(tick(`d${index}`, price, 1_000 + index * 1_000));
  }

  assertEqual(registry.get('demo-broken')?.lifecycle.status, 'FAILED', 'the failing tracker is isolated');
  assertEqual(registry.get('demo-fine')?.lifecycle.status, 'ACTIVE', 'its neighbour is fine');
  assertEqual(registry.get('other-agent')?.lifecycle.status, 'ACTIVE', 'and so is the other GOAT\'s tracker');
  assertEqual(runtime.listEvents().length, 6, 'both healthy trackers reported on every crossing');
  assert(
    runtime.listEvents().every((event) => event.trackerId !== 'demo-broken'),
    'and the isolated one produced nothing',
  );
}

/**
 * An observation the runtime refuses to record is never delivered.
 *
 * A tracker that was paused between being selected and being reported must produce
 * no event, no row and no wake. The frame cannot resurrect what was rejected, which
 * is the whole reason the frame is assembled from accepted observations only.
 */
async function lifecycleRefusalProducesNoObservationAndNoWake(): Promise<void> {
  const trackers = [
    makeTracker('active-one', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' }),
    makeTracker('paused-one', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' }),
  ];
  const { trackers: runtime, registry, wakes } = await harness({ trackers });
  runtime.pauseTracker('paused-one');

  await runtime.process(tick('p0', 9, 900));
  await runtime.process(tick('d1', 11, 1_000));

  assertEqual(registry.get('paused-one')?.lifecycle.status, 'PAUSED', 'the paused tracker is paused');
  assert(
    runtime.listEvents().every((event) => event.trackerId === 'active-one'),
    'a paused tracker produces no observation',
  );
  assertEqual(wakes.length, 1, 'and no wake');
  assertEqual(wakes[0]!.batch!.events.length, 1, 'the frame holds only what the runtime accepted');
}

/**
 * A disposed runtime is inert immediately.
 *
 * Disposal can land while a delivery is being evaluated — here it lands *inside* the
 * evaluation, the tightest race available. Anything in flight must stop at the next
 * boundary rather than carry on writing into stores that were just emptied, or wake
 * an agent that was just stopped.
 */
async function disposalStopsAnInFlightEvaluation(): Promise<void> {
  const trackers = [makeTracker('only', 'agent-a', 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { thesisId: 'thesis:agent-a' })];
  let disposeMe: TrackerRuntime | undefined;
  const { trackers: runtime, timeline, wakes } = await harness({
    trackers,
    evaluatorFactory: () => ({
      evaluate: () => {
        disposeMe?.dispose();
        return 'Price crossed above 10.';
      },
      reset: () => {},
    }) as unknown as TrackerEvaluator,
  });
  disposeMe = runtime;

  const fired = await runtime.process(tick('p0', 9, 900));
  assertEqual(fired.length, 0, 'an evaluation interrupted by disposal reports nothing');
  assertEqual(wakes.length, 0, 'and wakes nobody');
  assertEqual((await timeline.getByAgent('agent-a')).length, 0, 'and writes nothing to a store it no longer owns');

  // And it stays inert: a disposed runtime does not resume on the next delivery.
  const after = await runtime.process(tick('d1', 11, 1_000));
  assertEqual(after.length, 0, 'a disposed runtime stays inert for later deliveries');
  assertEqual(wakes.length, 0, 'still waking nobody');
}

/**
 * A failed lookup is not a permanent answer.
 *
 * Instrument metadata that could not be fetched is unknown, not absent. Caching the
 * failure would leave every tracker on that market unmeasurable for the life of the
 * runtime, with nothing in the product that could retry.
 */
async function instrumentLookupFailureIsNotRememberedForever(): Promise<void> {
  /*
   * Counted only from the first delivery, because starting an agent asks the
   * environment for its own view of the instruments and that lookup is not the one
   * under test.
   */
  let counting = false;
  let attempts = 0;
  const env = environment({
    async getInstruments() {
      if (!counting) return [instrument];
      attempts += 1;
      if (attempts === 1) throw new Error('provider unavailable');
      return [instrument];
    },
  });
  const { trackers: runtime } = await harness({
    trackers: [makeTracker('proximity', 'agent-a', 'STOP_APPROACHING', { withinPips: 5 }, { thesisId: 'thesis:agent-a', cooldownMs: 0 })],
    env,
  });

  const position = (currentPrice: number): NonNullable<TrackerInput['state']['positions']>[number] => ({
    id: 'p1', symbol: 'EURUSD', side: 'BUY', entryPrice: 1.1, currentPrice,
    volume: 1, stopLoss: 1.105, takeProfit: 1.11, unrealizedPnL: 0,
  });

  counting = true;
  // Sequential on purpose: a concurrent pair would legitimately share one lookup,
  // and the claim under test is about what is remembered afterwards, not about how
  // two simultaneous callers share a promise.
  await runtime.processPositionEvent('agent-a', 'POSITION_OPEN', position(1.1), 1_000, 'DEMO');
  const firstObserved = runtime.listEvents().length;
  await runtime.processPositionEvent('agent-a', 'POSITION_UPDATE', position(1.1049), 2_000, 'DEMO');

  /*
   * The behavioural claim is the one that matters: had the miss been cached, the
   * second delivery would have been blind too. It measured, so the failure was
   * forgotten. The count only says the lookup happened again.
   */
  assert(attempts >= 2, 'a failed metadata lookup is retried rather than remembered');
  assertEqual(firstObserved, 0, 'the delivery that could not read metadata reported nothing');
  assertEqual(runtime.listEvents().length, 1, 'and the next delivery measured normally');
}

/**
 * Position observations take the frame path too, once.
 *
 * A position update can satisfy several trackers at once, and it can also be
 * replayed by a session that reconnects. It is delivered like anything else the
 * runtime observes: as one frame per market moment, with no duplicates.
 */
async function positionEventsAreNotDuplicatedByTheFrame(): Promise<void> {
  const trackers = [
    makeTracker('stop', 'agent-a', 'STOP_APPROACHING', { withinPips: 5 }, { thesisId: 'thesis:agent-a', priority: 2 }),
    makeTracker('target', 'agent-a', 'TARGET_APPROACHING', { withinPips: 5 }, { thesisId: 'thesis:agent-a', priority: 1 }),
  ];
  const { trackers: runtime, wakes } = await harness({ trackers });

  const position: NonNullable<TrackerInput['state']['positions']>[number] = ({
    id: 'p1', symbol: 'EURUSD', side: 'BUY', entryPrice: 1.1, currentPrice: 1.1049,
    volume: 1, stopLoss: 1.105, takeProfit: 1.11, unrealizedPnL: 0,
  });
  runtime.processPositionEvent('agent-a', 'POSITION_OPEN', position, 1_000, 'DEMO');
  runtime.processPositionEvent('agent-a', 'POSITION_OPEN', position, 1_000, 'DEMO');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const observed = wakes.flatMap((wake) => wake.batch?.events ?? [wake.event]);
  assert(observed.length > 0, 'a position event is still observed');
  assertEqual(
    new Set(observed.map((event) => event.id)).size,
    observed.length,
    'and the same one delivered twice is observed once',
  );
}
/**
 * Named, so a failure says which claim broke rather than which line.
 *
 * Every case is asserted by its own message and every message states the behaviour
 * in words, so a report reads as a list of claims the engine is making — not as a
 * stack trace in a file whose name nobody remembers.
 */
const CASES: Array<[string, () => Promise<void>]> = [
  ['batching: one delivery wakes the GOAT once', batchingCoalescesOneDeliveryIntoOneWake],
  ['batching: separate GOATs, theses, markets and deliveries stay separate frames', batchingNeverMergesSeparateIdentities],
  ['batching: every observation stays individually addressable', batchingKeepsEveryObservationIndividuallyAddressable],
  ['batching: the frame is identical whatever order the trackers were registered in', batchingIsDeterministicRegardlessOfRegistrationOrder],
  ['batching: a frame replaces the per-observation wake rather than adding to it', batchingSupersedesPerEventDelivery],
  ['batching: a repeated delivery is one observation', duplicateDeliveriesProduceOneWake],
  ['circuit breaker: three failures in a row isolate one tracker', circuitBreakerIsolatesOneTrackerAfterThreeFailures],
  ['circuit breaker: a success, and then a recovery, both reset the count', circuitBreakerResetsOnSuccessAndOnRecovery],
  ['circuit breaker: isolation is scoped to one tracker', quarantinedTrackerDoesNotStopTheOthers],
  ['lifecycle: a refused observation is never delivered', lifecycleRefusalProducesNoObservationAndNoWake],
  ['lifecycle: a disposed runtime is inert immediately', disposalStopsAnInFlightEvaluation],
  ['cache: a failed metadata lookup is not remembered', instrumentLookupFailureIsNotRememberedForever],
  ['positions: an observation delivered twice is observed once', positionEventsAreNotDuplicatedByTheFrame],
];

if (import.meta.main) {
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  for (const [name, run] of CASES) {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, detail: (error as Error).message });
    }
  }
  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? 'pass' : 'FAIL'}  ${result.name}`);
    if (!result.ok && result.detail) console.log(`      ${result.detail.split('\n').join('\n      ')}`);
  }
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}
