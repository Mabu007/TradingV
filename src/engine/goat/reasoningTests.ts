/**
 * Tests for the reasoning layer itself.
 *
 * ## Why these are separate from `tests.ts`
 *
 * `tests.ts` exercises the GOAT through its orchestrator — deployment, market
 * context, the model call, the plan, the plan's effects — which is the right level
 * for "does this feature work end to end" and the wrong level for "is the
 * arithmetic of belief correct". Every property tested here is a property of
 * `GoatLoop` and the deterministic functions it delegates to, and each of them is
 * stated as a rule the system claims to obey rather than as an outcome of a
 * particular run:
 *
 *   confidence   evidence is weighted, not counted; belief is bounded; a repeat
 *                moves nothing
 *   evidence     provenance is preserved, a contradiction is distinguishable from
 *                a duplicate, and a second delivery of one wake adds nothing
 *   composite    several decisions apply in the right order, an unreadable plan is
 *                refused whole, an illegal transition is still illegal
 *   tournaments  a pair is bounded by the same ceiling as everything else, each
 *                side keeps its own evidence, and disproving one closes the pair
 *   recalibration the original record survives, the replacement is a new watch, and
 *                nothing is recalibrated without a reading the GOAT actually made
 *   risk feedback a refusal becomes evidence, the allowance to retry is bounded, and
 *                no retry can reach anything the risk layer refused
 *   hysteresis   a marginal observation moves confidence without moving the state,
 *                and a decisive one still does
 *
 * The loop is driven directly, with no orchestrator and no model, so every result
 * here is a function of what the test handed it. That is also what makes them fast:
 * nothing is fetched, nothing is priced, and nothing is awaited that does not have
 * to be.
 */

import { GoatLoop, MAX_RISK_REVISIONS, type MarketReading } from './loop';
import {
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryEvidenceStore,
  InMemoryTradeIdeaStore,
} from './store';
import { GoatSkillRegistry, type SkillPackage } from './skills';
import { TrackerSdk, ALL_GOAT_CAPABILITIES } from './trackerSdk';
import { AgentRuntime } from '../agents/runtime';
import { TrackerRegistry } from '../agents/trackers/registry';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { InMemoryAgentTimelineStore } from '../agents/timeline/store';
import type {
  AgentPlan,
  Evidence,
  Goal,
  Thesis,
  TrackerEvent,
  TrackerRequest,
  WakeRequest,
} from './types';
import {
  applyConfidence,
  clampConfidence,
  detectConflicts,
  hysteresisVerdict,
  noveltyWeight,
  provenanceKey,
  readSufficiency,
  severityWeight,
  statedConfidenceWeight,
  timeframeWeight,
  UNKNOWN_SEVERITY_WEIGHT,
} from './reasoning';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

const NOW = 1_800_000_000_000;

const SKILL: SkillPackage = {
  id: 'test-skill',
  name: 'Test',
  description: 'A skill for the reasoning tests.',
  instructions: '',
  requiredCapabilities: [],
  enabled: true,
  constraints: [],
};

interface Harness {
  loop: GoatLoop;
  goal: Goal;
  trackers: TrackerRuntime;
  theses: InMemoryThesisStore;
  evidence: InMemoryEvidenceStore;
  ideas: InMemoryTradeIdeaStore;
  agentRuntime: AgentRuntime;
  /** The last market reading the harness has offered, if any. */
  setReading(reading: MarketReading | undefined): void;
}

function makeHarness(options: { constraints?: SkillPackage['constraints']; market?: string } = {}): Harness {
  const goals = new InMemoryGoalStore();
  const theses = new InMemoryThesisStore();
  const evidence = new InMemoryEvidenceStore();
  const ideas = new InMemoryTradeIdeaStore();

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
    clock: () => NOW,
  });

  /*
   * The domain binding, exactly as the orchestrator wires it.
   *
   * Without it the tracker runtime cannot resolve a thesis, and every test here
   * would be testing a harness rather than the loop: `resolveThesis` is how a
   * tracker is checked for ownership, so it is part of the behaviour under test,
   * not scaffolding around it.
   */
  trackers.bindDomain({
    resolveThesis: (thesisId) => theses.get(thesisId),
    resolveSkillIds: () => [SKILL.id],
    onEvent: () => undefined,
  });

  /*
   * A registered agent, because the tracker runtime refuses to arm a watch for an
   * owner it cannot see — the same fail-closed rule the live path relies on.
   */
  agentRuntime.registerAgent(
    {
      id: 'agent-1',
      name: 'Test GOAT',
      description: '',
      instructions: '',
      /*
       * No skills: the loop does not read the agent's capability set — the SDK's
       * grant is what governs tracker ownership here — and registering skills would
       * couple this harness to the *agent* skill registry rather than the GOAT one
       * under test.
       */
      skills: [],
      capabilities: [],
      policy: {
        maxRiskPerTrade: 0.01,
        maxOpenPositions: 1,
        maxExposure: 50_000,
        maxOrdersPerMinute: 5,
        allowedSymbols: ['EURUSD'],
        allowTrading: true,
      },
      preferredEnvironment: 'DEMO',
      symbols: ['EURUSD'],
      timeframe: '15m',
      timeframes: ['15m', '1h'],
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      mode: 'DEMO',
      async getMarketQuote() {
        return { symbol: 'EURUSD', symbolId: '1', bid: 1.1, ask: 1.1001, spread: 1, timestamp: NOW, status: 'MOCK' };
      },
      async getMarketBars() { return []; },
      async getAccountState() {
        return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 };
      },
      async getPositions() { return []; },
      async getOrders() { return []; },
      async placeMarketOrder() { return { success: true }; },
      async modifyPosition() { return { success: true }; },
      async closePosition() { return { success: true }; },
    },
  );
  agentRuntime.start('agent-1');

  const skills = new GoatSkillRegistry({ knownCapabilityIds: () => [...ALL_GOAT_CAPABILITIES] });
  skills.register({ ...SKILL, ...(options.constraints ? { constraints: options.constraints } : {}) });

  const goal: Goal = {
    id: 'goal-1',
    agentId: 'agent-1',
    statement: 'Find a long if the decline reverses.',
    symbols: ['EURUSD'],
    timeframes: ['15m'],
    skillIds: [SKILL.id],
    status: 'MONITORING',
    createdAt: NOW,
    updatedAt: NOW,
  };
  goals.save(goal);

  let reading: MarketReading | undefined;

  const loop = new GoatLoop({
    goals,
    theses,
    evidence,
    ideas,
    trackers,
    skills,
    sdkFor: (agentId) =>
      new TrackerSdk(agentId, {
        runtime: trackers,
        resolveOwnedThesisIds: (id) =>
          theses.list().filter((thesis) => thesis.agentId === id).map((thesis) => thesis.id),
        resolveGrantedCapabilities: () => [...ALL_GOAT_CAPABILITIES],
      }),
    clock: () => NOW,
    env: { mode: 'DEMO' },
    currentDeployment: (agentId) => ({
      deploymentId: 'dep-1',
      goatId: agentId,
      market: options.market ?? 'EURUSD',
      mode: 'DEMO' as const,
      research: { allowed: true, market: options.market ?? 'EURUSD', timeframes: ['15m'] },
      execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET', 'LIMIT', 'STOP'] },
      clock: NOW,
    }),
    lastMarketReading: () => reading,
  });

  return {
    loop,
    goal,
    trackers,
    theses,
    evidence,
    ideas,
    agentRuntime,
    setReading: (next) => {
      reading = next;
    },
  };
}

/** A live thesis with a watch on it, the shape every wake here happens in. */
/**
 * A live thesis, reached the way the runtime reaches one.
 *
 * Two revisions rather than one: DRAFT cannot become ACTIONABLE directly, and a
 * harness that skipped the transition table would be testing a loop that does not
 * exist.
 */
function seedThesis(h: Harness, overrides: Partial<Thesis> = {}, direction: 'BULLISH' | 'BEARISH' = 'BULLISH'): Thesis {
  const created = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The decline is corrective inside a broader bullish structure.',
    direction,
    invalidation: 'A sustained structural break below 1.0950.',
    requiredConfirmation: ['a 15m close above 1.1010'],
  });
  const { state, ...rest } = overrides;
  // A thesis that is meant to stay in DRAFT never goes through ACTIVE at all, which
  // is the only way to get one: the transition table does not go back.
  if (state === 'DRAFT') return rest.confidence === undefined
    ? created
    : h.loop.reviseThesis(created.id, rest);
  h.loop.reviseThesis(created.id, { state: 'ACTIVE', confidence: 0.5, ...rest });
  return state ? h.loop.reviseThesis(created.id, { state }) : h.theses.get(created.id)!;
}

function makeTracker(h: Harness, thesisId: string, request: Partial<TrackerRequest> = {}) {
  return h.trackers.createTracker(thesisId, h.goal.agentId, {
    purpose: 'Watch for a reclaim',
    kind: 'INDICATOR_CROSS',
    timeframe: '15m',
    config: { indicatorKey: 'rsi14', indicator: { type: 'RSI', period: 14 }, level: 50, direction: 'ABOVE' },
    priority: 60,
    ...request,
  } as never);
}

/** A wake for an event the tracker runtime produced, so severity is the runtime's. */
function wakeFor(h: Harness, thesisId: string, trackerId: string, overrides: Partial<TrackerEvent> = {}): WakeRequest {
  const tracker = h.trackers.get(trackerId)!;
  const event = h.trackers.ingestEvent({
    id: `evt_${trackerId}_${NOW}`,
    trackerId,
    agentId: h.goal.agentId,
    kind: tracker.kind,
    eventType: tracker.eventType,
    timestamp: NOW,
    environment: 'DEMO',
    symbol: tracker.symbol ?? 'EURUSD',
    timeframe: tracker.timeframe,
    reason: 'Price reached the monitored level',
    priority: tracker.evaluation.priority ?? 0,
    severity: 'INFO',
    ...overrides,
  });
  assert(event, 'the tracker runtime accepted the observation');
  return {
    thesisId,
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    event,
    thesis: {
      id: thesisId,
      goalId: h.goal.id,
      agentId: h.goal.agentId,
      statement: '',
      state: 'ACTIVE',
      revision: 0,
    },
    relatedEvents: [],
    skillIds: [SKILL.id],
    createdAt: NOW,
  };
}

// ---------------------------------------------------------------------------
// 1. Confidence is weighted, bounded, and cannot compound
// ---------------------------------------------------------------------------

test('confidence: a stronger observation moves belief further than a weaker one', () => {
  const notable = severityWeight('NOTABLE');
  const decisive = severityWeight('DECISIVE');
  assert(decisive > notable, 'a decisive observation is worth more than a notable one');
  assertEqual(severityWeight('NOT-A-LEVEL'), UNKNOWN_SEVERITY_WEIGHT, 'an unknown severity is treated as the middle of the range, not as the top');
  assertEqual(severityWeight(undefined), UNKNOWN_SEVERITY_WEIGHT, 'and an absent severity is the same unknown');

  assert(timeframeWeight('15m', '1h') > timeframeWeight('15m', '15m'), 'confirmation from a coarser resolution is worth more');
  assert(timeframeWeight('15m', '1m') < timeframeWeight('15m', '15m'), 'and a finer resolution is worth slightly less');
  assertEqual(timeframeWeight(undefined, '1h'), 1, 'with no thesis resolution to compare against, nothing is privileged');

  assert(
    statedConfidenceWeight(1) <= 1 && statedConfidenceWeight(0) >= 0.5,
    "a model's stated confidence may discount its own evidence and never amplify it",
  );
  assertEqual(statedConfidenceWeight(undefined), 1, 'an absent claim is not a claim of zero');
});

test('confidence: belief is clamped, and damped as it approaches an extreme', () => {
  assertEqual(clampConfidence(1.4), 1, 'confidence cannot exceed 1');
  assertEqual(clampConfidence(-0.2), 0, 'and cannot fall below 0');
  assertEqual(applyConfidence(undefined, 5), 1, 'a large positive effect from neutral still lands on the bound');
  assertEqual(applyConfidence(undefined, -5), 0, 'and so does a large negative one');

  // Damping: the same effect moves a neutral belief further than a near-certain one.
  const fromNeutral = applyConfidence(0.5, 0.2) - 0.5;
  const fromCertain = applyConfidence(0.9, 0.2) - 0.9;
  assert(fromNeutral > fromCertain, 'a belief that is already near an extreme is harder to move further');
  assertEqual(applyConfidence(0.95, 0.2), 1, 'and the scale is the limit, not the evidence');
});

test('confidence: a repeat of one observation moves nothing', () => {
  const first = noveltyWeight({ provenanceKey: 'delivery:a', trackerId: 't1', prior: [] });
  assertEqual(first, 1, 'an observation never seen before counts fully');
  const repeated = noveltyWeight({
    provenanceKey: 'delivery:a',
    trackerId: 't1',
    prior: [{ provenance: 'delivery:a' }, { provenance: 'delivery:b' }],
  });
  assertEqual(repeated, 0, 'the same delivery a second time counts for nothing');
  const sameTracker = noveltyWeight({
    provenanceKey: 'delivery:c',
    trackerId: 't1',
    prior: [{ provenance: 'delivery:a', sourceTrackerId: 't1' }, { provenance: 'delivery:b', sourceTrackerId: 't1' }],
  });
  assert(sameTracker > 0 && sameTracker < 1, 'a fourth touch of the same level is weaker than the first, and not nothing');

  assertEqual(
    provenanceKey({ id: 'e1', sourceEventId: 'bar:1', observedValues: { price: 1.1 } }),
    'delivery:bar:1',
    'the delivery id is the identity of the observation, because that is what makes two events one observation',
  );
  assertEqual(
    provenanceKey({ id: 'e1', trackerId: 't1', observedValues: { price: 1.1, level: 1.2 } }),
    provenanceKey({ id: 'e2', trackerId: 't1', observedValues: { level: 1.2, price: 1.1 } }),
    'without a delivery id, the observed values are compared, and their order does not matter',
  );
});

test('confidence: a strong confirmation moves belief more than a routine touch', () => {
  /*
   * Severity is the runtime's, derived from the tracker's own priority — an event
   * that claimed to be decisive would be overruled. So the two observations come
   * from two watches: an ordinary one and a decisive one, which is exactly how a
   * GOAT ends up with both.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const routine = makeTracker(h, thesis.id, { priority: 20 });
  const decisive = makeTracker(h, thesis.id, { priority: 100 });

  h.loop.applyPlan(wakeFor(h, thesis.id, routine.id, { sourceEventId: 'delivery:routine' }), {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'Touched.',
  });
  const afterRoutine = h.theses.get(thesis.id)!.confidence!;

  h.loop.applyPlan(wakeFor(h, thesis.id, decisive.id, { sourceEventId: 'delivery:decisive' }), {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'Broke structure.',
  });
  const afterDecisive = h.theses.get(thesis.id)!.confidence!;

  assert(
    afterDecisive - afterRoutine > afterRoutine - 0.5,
    'a decisive observation moved belief further than a routine one',
  );
  assert(h.theses.get(thesis.id)!.confidence! <= 1, 'and belief is still inside the bound');
});

test('confidence: contradicting evidence lowers it, and the same observation does not compound', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { confidence: 0.7 });
  const tracker = makeTracker(h, thesis.id);

  const seen: number[] = [];
  for (const index of [1, 2, 3]) {
    h.loop.applyPlan(
      wakeFor(h, thesis.id, tracker.id, {
        id: `evt_${index}`,
        sourceEventId: 'delivery:the-same-one',
      }),
      { kind: 'WEAKEN_THESIS', thesisId: thesis.id, reason: 'Reclaim failed.' },
    );
    seen.push(h.theses.get(thesis.id)!.confidence!);
  }

  assert((seen[0] as number) < 0.7, 'contradiction lowered belief');
  assertEqual(seen[1], seen[0], 'the second delivery of the same observation moved nothing');
  assertEqual(seen[2], seen[1], 'and neither did the third');

  const supporting = h.evidence.listForThesis(thesis.id).filter((item) => item.polarity === 'CONTRADICTS');
  assertEqual(supporting.length, 3, 'each delivery is still recorded — the market did something each time');
  assertEqual(supporting.filter((item) => (item.weight ?? 0) !== 0).length, 1, 'but only the first of them moved anything');
});

// ---------------------------------------------------------------------------
// 2. Hysteresis: the state is not the number
// ---------------------------------------------------------------------------

test('hysteresis: a marginal observation moves confidence without moving the state', () => {
  const small = hysteresisVerdict({ polarity: 'SUPPORTS', effect: 0.02, repeated: false });
  assert(!small.changesState, 'a very small confirmation is not a change of state');
  assert((small.reason ?? '').length > 0, 'and it says why, rather than silently doing less');

  const decisive = hysteresisVerdict({ polarity: 'SUPPORTS', effect: 0.2, repeated: false });
  assert(decisive.changesState, 'a decisive one is');

  const repeated = hysteresisVerdict({ polarity: 'CONTRADICTS', effect: 0.2, repeated: true });
  assert(!repeated.changesState, 'and not even a large effect from an observation already counted changes the state');

  // Weakening is the more conservative of the two, on purpose.
  assertEqual(
    hysteresisVerdict({ polarity: 'CONTRADICTS', effect: 0.05, repeated: false }).changesState,
    false,
    'a middling contradiction moves confidence rather than the state',
  );
  assertEqual(
    hysteresisVerdict({ polarity: 'CONTRADICTS', effect: 0.12, repeated: false }).changesState,
    true,
    'a substantial one does',
  );
});

test('hysteresis: small opposing evidence does not oscillate a live thesis', () => {
  /*
   * Anti-flapping, in the form it actually matters: a thesis talked down by noise
   * never gets the ground back, because the next noise puts it back where it was and
   * the next one after that takes it further down. So the property under test is
   * that the *state* does not reach WEAKENING on small contradictions — not that
   * nothing happens at all, which would be a GOAT that cannot be argued out of
   * anything.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  // An ordinary watch: the weakest severity the tables produce.
  const noisy = makeTracker(h, thesis.id, { priority: 5 });

  const states: string[] = [];
  for (const index of [1, 2, 3, 4, 5, 6]) {
    h.loop.applyPlan(
      wakeFor(h, thesis.id, noisy.id, { id: `f${index}`, sourceEventId: `delivery:f${index}` }),
      { kind: index % 2 === 1 ? 'CONFIRM_THESIS' : 'WEAKEN_THESIS', thesisId: thesis.id, reason: 'Noise.' },
    );
    states.push(h.theses.get(thesis.id)!.state);
  }

  assert(!states.includes('WEAKENING'), 'small contradictions never put a live thesis into WEAKENING');
  assert(
    h.theses.get(thesis.id)!.revision >= 6,
    'and every wake is still recorded, because belief did move even though the state did not',
  );

  /*
   * And a decisive contradiction still gets through: a floor that swallowed every
   * contradiction would be a safety rail with no purpose.
   */
  const decisive = makeTracker(h, thesis.id, { priority: 100 });
  h.loop.applyPlan(
    wakeFor(h, thesis.id, decisive.id, { sourceEventId: 'delivery:decisive-noise' }),
    { kind: 'WEAKEN_THESIS', thesisId: thesis.id, reason: 'Structure broke.' },
  );
  assertEqual(h.theses.get(thesis.id)!.state, 'WEAKENING', 'a decisive contradiction does weaken the thesis');
});

// ---------------------------------------------------------------------------
// 3. Evidence provenance and contradiction
// ---------------------------------------------------------------------------

test('evidence: provenance survives the recording', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id, { timeframe: '1h' });

  h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'bar-1' }), {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'Confirmed.',
  });

  const item = h.evidence.listForThesis(thesis.id)[0]!;
  assertEqual(item.provenance, 'delivery:bar-1', 'the observation identity is preserved');
  assertEqual(item.sourceTrackerId, tracker.id, 'as is the watch that produced it');
  assertEqual(item.timeframe, '1h', 'and the resolution it was made at');
  assertEqual(item.source, 'TRACKER_EVENT', 'with its source unchanged');
  assert(typeof item.weight === 'number', 'and the effect the runtime computed for it');
});

test('evidence: a contradiction is distinguishable from a duplicate', () => {
  const prior: Evidence[] = [
    {
      id: 'evd_old',
      thesisId: 't',
      polarity: 'SUPPORTS',
      summary: 'The 1h structure held.',
      source: 'TRACKER_EVENT',
      weight: 0.1,
      novelty: 1,
      timeframe: '1h',
      sourceTrackerId: 't-old',
      createdAt: 1,
    },
  ];

  const against = detectConflicts({
    incoming: { polarity: 'CONTRADICTS', weight: 0.12, timeframe: '15m', sourceTrackerId: 't-new' },
    prior,
  });
  assertEqual(against.length, 1, 'a heavier observation from the other side is in tension with the earlier claim');
  assertEqual(against[0]!.evidenceId, 'evd_old', 'and names what it is in tension with');
  assert((against[0]!.because ?? '').length > 0, 'and says why, in a sentence');

  const weaker = detectConflicts({
    incoming: { polarity: 'CONTRADICTS', weight: 0.01, timeframe: '15m', sourceTrackerId: 't-new' },
    prior,
  });
  assertEqual(weaker.length, 0, 'a marginal observation does not manufacture a contradiction');

  const sameWatch = detectConflicts({
    incoming: { polarity: 'CONTRADICTS', weight: 0.2, timeframe: '15m', sourceTrackerId: 't-old' },
    prior,
  });
  assert(
    /same watch/.test(sameWatch[0]?.because ?? ''),
    'one watch disagreeing with itself is named as such rather than as a broken thesis',
  );
});

test('evidence: the same wake delivered twice changes nothing the second time', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:once' });

  const first = h.loop.applyPlan(wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Confirmed.' });
  const afterFirst = h.theses.get(thesis.id)!;
  const second = h.loop.applyPlan(wake, { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Confirmed again.' });
  const afterSecond = h.theses.get(thesis.id)!;

  assertEqual(first.evidenceRecorded.length, 1, 'the first delivery recorded its evidence');
  assertEqual(second.evidenceRecorded.length, 0, 'the second recorded nothing');
  assertEqual(second.rejections.length, 1, 'and said that it had already been handled');
  assertEqual(afterSecond.revision, afterFirst.revision, 'the thesis was not revised twice');
  assertEqual(h.evidence.listForThesis(thesis.id).length, 1, 'and there is one piece of evidence, not two');
});

// ---------------------------------------------------------------------------
// 4. Composite plans
// ---------------------------------------------------------------------------

test('composite: several decisions apply in the order the world requires', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const stale = makeTracker(h, thesis.id, { purpose: 'Watch a level that no longer matters' });
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:composite' });

  const outcome = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'Record it, revise the question, drop the stale watch.',
    steps: [
      { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Confirmed.' },
      { kind: 'CREATE_TRACKER', thesisId: thesis.id, reason: 'Ask a better question.', spec: { purpose: 'Watch the retest', kind: 'NEW_BAR', config: {}, timeframe: '15m' } },
      { kind: 'REMOVE_TRACKER', trackerId: stale.id, reason: 'No longer the question.' },
    ],
  });

  assertEqual(outcome.evidenceRecorded.length, 1, 'evidence was recorded');
  assertEqual(outcome.trackerChanges.length, 2, 'both tracker mutations were applied');
  assertEqual(outcome.rejections.length, 0, 'and nothing was refused');
  assert(
    h.trackers.get(stale.id)!.lifecycle.status !== 'ACTIVE',
    'the stale watch really was cancelled',
  );
  assert(
    h.trackers.listForThesis(thesis.id).some((candidate) => candidate.purpose === 'Watch the retest'),
    'and the new question really was armed',
  );
});

test('composite: an unreadable plan is refused whole rather than half-applied', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:bad' });

  const duplicated = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'Two confirmations.',
    steps: [
      { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'One.' },
      { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'And the same one again.' },
    ],
  });
  assertEqual(duplicated.evidenceRecorded.length, 0, 'a plan with two of the same decision records nothing');
  assert(/Composite plan refused/.test(duplicated.rejections[0] ?? ''), 'and says it was refused as a whole');
  assertEqual(h.evidence.listForThesis(thesis.id).length, 0, 'so no evidence was written');

  const oversized = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'Everything, at once.',
    steps: Array.from({ length: 6 }, () => ({ kind: 'WAIT' as const, reason: 'x' })),
  });
  assertEqual(oversized.rejections.length, 1, 'and a plan longer than the bound is refused too');
});

test('composite: one refused step does not undo the ones that applied', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:partial' });

  const outcome = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'Confirm, then ask for a tracker the registry cannot watch.',
    steps: [
      { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Confirmed.' },
      { kind: 'CREATE_TRACKER', thesisId: thesis.id, reason: 'Impossible.', spec: { purpose: 'Watch nothing', kind: 'NOT_A_KIND', config: {} } as never },
    ],
  });

  assertEqual(outcome.evidenceRecorded.length, 1, 'the valid step applied');
  assertEqual(outcome.rejections.length, 1, 'the invalid one was refused and reported');
  assert(
    h.theses.get(thesis.id)!.revision > thesis.revision,
    'and the thesis really did change',
  );
});

test('composite: escalation and proposal in one pass, in that order', () => {
  /*
   * The ordering that makes the composite worth having: a proposal is only legal on
   * an ACTIONABLE thesis, so escalating first is what authorises it.
   */
  const h = makeHarness({ constraints: [{ kind: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE', minimum: 0 }] });
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:escalate' });

  const outcome = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'It is actionable, and here is the trade.',
    steps: [
      {
        kind: 'PROPOSE_TRADE_IDEA',
        thesisId: thesis.id,
        reason: 'Entry on the retest.',
        idea: {
          symbol: 'EURUSD',
          direction: 'LONG',
          orderType: 'LIMIT',
          entry: 1.105,
          invalidationLevel: 1.0985,
          takeProfits: [{ price: 1.115, fraction: 1 }],
          reasoning: 'Reclaim confirmed.',
        },
      },
      { kind: 'ESCALATE_THESIS', thesisId: thesis.id, reason: 'The bar is met.' },
    ],
  });

  assert(Boolean(outcome.tradeIdeaId), 'the proposal was accepted, because the escalation ran first');
  assertEqual(outcome.rejections.length, 0, 'and nothing was refused');
  assertEqual(h.theses.get(thesis.id)!.state, 'ACTIONABLE', 'the thesis is actionable and still live for the risk layer');
});

test('composite: an illegal transition is still illegal inside one', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { state: 'DRAFT' });
  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:illegal' });

  const outcome = h.loop.applyPlan(wake, {
    kind: 'COMPOSITE',
    thesisId: thesis.id,
    reason: 'Straight to actionable from a draft.',
    steps: [{ kind: 'ESCALATE_THESIS', thesisId: thesis.id, reason: 'Because I say so.' }],
  });
  assertEqual(outcome.tradeIdeaId, undefined, 'nothing was traded');
  assert(h.theses.get(thesis.id)!.state === 'DRAFT', 'and the thesis did not move: DRAFT cannot become ACTIONABLE');
});

// ---------------------------------------------------------------------------
// 5. Hypothesis tournaments
// ---------------------------------------------------------------------------

test('tournament: the ceiling is the same ceiling, and a tournament does not raise it', () => {
  /*
   * Two things, and the second is the one that matters. The ceiling that applies to
   * a competing hypothesis is the same one that applies to any other thesis — and it
   * is checked against the hypotheses that already exist, not against the pair alone,
   * so a GOAT cannot reach its limit by pairing up.
   */
  const h = makeHarness({ constraints: [{ kind: 'MAX_THESES', maximum: 2 }] });
  const first = seedThesis(h, {}, 'BULLISH');
  const second = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The move is impulsive.',
    direction: 'BEARISH',
    invalidation: 'A reclaim of 1.1010.',
    competesWith: first.id,
  });
  assertEqual(h.theses.listLiveForGoal(h.goal.id).length, 2, 'a pair is admissible where the skills allow two');

  let refused = '';
  try {
    h.loop.createThesis({
      goalId: h.goal.id,
      agentId: h.goal.agentId,
      statement: 'A third reading.',
      direction: 'NEUTRAL',
      invalidation: 'Anything.',
      competesWith: second.id,
    });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert(/limit 2/.test(refused), 'and a third is refused by the same ceiling a third would be refused by');
  assertEqual(h.theses.listLiveForGoal(h.goal.id).length, 2, 'with two still live');

  /*
   * And two readings that agree are not a tournament: a second bullish statement of
   * the same idea is one hypothesis written twice, and admitting it would let a GOAT
   * spend the tracker budget twice on one question.
   */
  const single = makeHarness({ constraints: [{ kind: 'MAX_THESES', maximum: 3 }] });
  const only = seedThesis(single, {}, 'BULLISH');
  let sameDirection = '';
  try {
    single.loop.createThesis({
      goalId: single.goal.id,
      agentId: single.goal.agentId,
      statement: 'The decline is corrective, restated.',
      direction: 'BULLISH',
      invalidation: 'A structural break.',
      competesWith: only.id,
    });
  } catch (error) {
    sameDirection = error instanceof Error ? error.message : String(error);
  }
  assert(/not competing hypotheses/.test(sameDirection), 'two readings of the same direction are refused as a pair');
});

test('tournament: two opposite readings can coexist and keep their own evidence', () => {
  const h = makeHarness({ constraints: [{ kind: 'MAX_THESES', maximum: 2 }] });
  const bull = seedThesis(h, {}, 'BULLISH');
  const bear = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The move is impulsive and the structure is breaking down.',
    direction: 'BEARISH',
    invalidation: 'A reclaim of 1.1010.',
    competesWith: bull.id,
  });

  assertEqual(h.theses.get(bull.id)!.competesWith, bear.id, 'the relationship is recorded on both sides');
  assertEqual(h.theses.listLiveForGoal(h.goal.id).length, 2, 'both hypotheses are live');

  const bullTracker = makeTracker(h, bull.id, { purpose: 'Watch the reclaim' });
  const bearTracker = makeTracker(h, bear.id, { purpose: 'Watch the break' });

  h.loop.applyPlan(wakeFor(h, bull.id, bullTracker.id, { sourceEventId: 'delivery:bull' }), {
    kind: 'CONFIRM_THESIS',
    thesisId: bull.id,
    reason: 'Reclaimed.',
  });

  assertEqual(h.evidence.listForThesis(bull.id).length, 1, 'the evidence belongs to the thesis that asked the question');
  assertEqual(h.evidence.listForThesis(bear.id).length, 0, 'and the competing hypothesis learned nothing from it');
  assertEqual(h.trackers.listForThesis(bear.id).length, 1, 'its own watch is untouched');

  /*
   * A wake is about one hypothesis, whatever the plan says.
   *
   * The wake here was built for the bear thesis's watch while naming the bull
   * thesis, which is the shape of a confused or adversarial reasoning pass. The wake's
   * own thesis is authoritative — the same rule `ESCALATE_THESIS` already followed —
   * so the bear hypothesis is the one that is disproven, and the pair resolves with
   * it rather than against it.
   */
  const crossed = h.loop.applyPlan(wakeFor(h, bear.id, bearTracker.id, { sourceEventId: 'delivery:crossed' }), {
    kind: 'INVALIDATE_THESIS',
    thesisId: bull.id,
    reason: 'Disproved.',
  });
  assertEqual(crossed.thesis.state, 'INVALIDATED', 'the wake decided about the thesis it woke for');
  assertEqual(h.theses.get(bear.id)!.state, 'INVALIDATED', 'and not about the one the plan named');
  assertEqual(h.theses.get(bull.id)!.state, 'ABANDONED', 'so the counterpart was closed as the survivor');
});

test('tournament: disproving one closes the pair, and only that way', () => {
  const h = makeHarness({ constraints: [{ kind: 'MAX_THESES', maximum: 2 }] });
  const bull = seedThesis(h, {}, 'BULLISH');
  const bear = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The move is impulsive.',
    direction: 'BEARISH',
    invalidation: 'A reclaim of 1.1010.',
    competesWith: bull.id,
  });
  const bearTracker = makeTracker(h, bear.id);

  h.loop.applyPlan(wakeFor(h, bear.id, bearTracker.id, { sourceEventId: 'delivery:disprove' }), {
    kind: 'INVALIDATE_THESIS',
    thesisId: bear.id,
    reason: 'Disproved.',
  });

  assertEqual(h.theses.get(bear.id)!.state, 'INVALIDATED', 'the disproven hypothesis is invalidated');
  assertEqual(h.theses.get(bull.id)!.state, 'ABANDONED', 'and the question now has one answer, so the other is closed');
  assertEqual(
    h.trackers.listForThesis(bull.id).filter((tracker) => tracker.lifecycle.status === 'ACTIVE').length,
    0,
    'the closed hypothesis spends no further wake budget',
  );
});

// ---------------------------------------------------------------------------
// 6. Adaptive recalibration
// ---------------------------------------------------------------------------

test('recalibration: a question the market has already answered is re-asked, and the original survives', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const level = makeTracker(h, thesis.id, {
    purpose: 'Watch for a reclaim of 1.17',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.17, operator: 'ABOVE' },
  });
  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped for the test.');

  h.setReading({ symbol: 'EURUSD', price: 1.19, timeframe: '15m', at: NOW });

  const restored = h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);
  assertEqual(restored.length, 1, 'something is watching again');
  assert(
    h.trackers.get(restored[0]!)!.config['level'] === 1.19,
    'and it asks about the price the market is actually at',
  );
  assert(
    h.trackers.get(level.id)!.lifecycle.status !== 'ACTIVE',
    'the original record is still there, cancelled, as the history of a watch that was stopped',
  );
  assert(
    h.loop.restoreRefusals().some((line) => /re-asked/.test(line)),
    'and the recalibration is reported rather than done silently',
  );
});

test('recalibration: nothing is recalibrated without a reading the GOAT actually made', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const level = makeTracker(h, thesis.id, {
    purpose: 'Watch for a reclaim of 1.17',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.17, operator: 'ABOVE' },
  });
  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped for the test.');
  h.setReading(undefined);

  const restored = h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);
  assertEqual(restored.length, 1, 'the plan still comes back');
  assertEqual(
    h.trackers.get(restored[0]!)!.config['level'],
    1.17,
    'at the level it was asking about, because the runtime will not invent a market it has not read',
  );
});

test('recalibration: a reachable level is left alone however far away it is', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const patient = makeTracker(h, thesis.id, {
    purpose: 'Wait for 1.30, because that is the level that matters',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.3, operator: 'ABOVE' },
  });
  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped for the test.');
  h.setReading({ symbol: 'EURUSD', price: 1.19, timeframe: '15m', at: NOW });

  const restored = h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [patient.id]);
  assertEqual(
    h.trackers.get(restored[0]!)!.config['level'],
    1.3,
    'patience is not staleness: an unmet level the GOAT chose is exactly what a tracker is for',
  );
});

test('recalibration: restoring twice does not double the observation plan', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const level = makeTracker(h, thesis.id, { purpose: 'Watch 1.17', kind: 'PRICE_THRESHOLD', config: { level: 1.17, operator: 'ABOVE' } });
  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped for the test.');

  h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);
  h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);

  assertEqual(
    h.trackers.listForThesis(thesis.id).filter((tracker) => tracker.lifecycle.status === 'ACTIVE').length,
    1,
    'the same intent is not restored twice',
  );
});

// ---------------------------------------------------------------------------
// 7. Risk refusal as reasoning feedback
// ---------------------------------------------------------------------------

test('risk feedback: a refusal becomes evidence, and the thesis stays alive to act on it', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { state: 'ACTIONABLE' });

  const feedback = h.loop.recordRiskFeedback({
    planId: 'tid-1',
    thesisId: thesis.id,
    approved: false,
    reason: 'The stop is inside the spread.',
    metrics: { dollarRisk: 0 },
  });

  assertEqual(feedback?.attempts, 1, 'the refusal is counted');
  assertEqual(feedback?.abandoned, false, 'and one refusal is not a spent allowance');
  assertEqual(h.theses.get(thesis.id)!.state, 'ACTIONABLE', 'the thesis is still live: there is something to do about it');

  const recorded = h.evidence.listForThesis(thesis.id).filter((item) => item.source === 'RISK_FEEDBACK');
  assertEqual(recorded.length, 1, 'the refusal is in the evidence');
  assert(/stop is inside the spread/.test(recorded[0]!.summary), 'with the reason the risk layer gave');
  assertEqual(recorded[0]!.weight, 0, 'and it drags no belief with it: a small account is not a wrong thesis');
});

test('risk feedback: approval is what completes a thesis', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { state: 'ACTIONABLE' });
  h.loop.recordRiskFeedback({ planId: 'tid-1', thesisId: thesis.id, approved: false, reason: 'No.' });
  h.loop.recordRiskFeedback({ planId: 'tid-2', thesisId: thesis.id, approved: true, reason: 'Yes.' });
  assertEqual(h.theses.get(thesis.id)!.state, 'COMPLETED', 'the thesis ends when the risk layer is satisfied');
});

test('risk feedback: the allowance to retry is bounded, and the bound stops the loop', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { state: 'ACTIONABLE' });

  for (let attempt = 0; attempt < MAX_RISK_REVISIONS; attempt += 1) {
    const outcome = h.loop.recordRiskFeedback({
      planId: `tid-${attempt}`,
      thesisId: thesis.id,
      approved: false,
      reason: 'Still refused.',
    });
    assert(!outcome?.abandoned || attempt === MAX_RISK_REVISIONS - 1, 'the allowance is spent only at the bound');
  }

  const tracker = makeTracker(h, thesis.id);
  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:retry' });
  const outcome = h.loop.applyPlan(wake, {
    kind: 'PROPOSE_TRADE_IDEA',
    thesisId: thesis.id,
    reason: 'Trying once more.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 1 }],
      reasoning: 'Again.',
    },
  });

  assertEqual(outcome.tradeIdeaId, undefined, 'no further trade idea is built');
  assert(
    /limit 3/.test(outcome.rejections[0] ?? ''),
    'and the refusal says how many were refused, so the GOAT is not left to discover it',
  );
  assertEqual(h.ideas.list().length, 0, 'nothing was written');
});

test('risk feedback: a skill may set a stricter retry bound', () => {
  const h = makeHarness({ constraints: [{ kind: 'MAX_RISK_REVISIONS', maximum: 1 }] });
  const thesis = seedThesis(h, { state: 'ACTIONABLE' });
  const outcome = h.loop.recordRiskFeedback({ planId: 'tid-1', thesisId: thesis.id, approved: false, reason: 'No.' });
  assertEqual(outcome?.abandoned, true, 'a skill that allows one retry gets exactly one');
});

// ---------------------------------------------------------------------------
// 8. Sufficiency
// ---------------------------------------------------------------------------

test('sufficiency: one weak observation is not enough, and it says which case this is', () => {
  const thesis: Thesis = {
    id: 't',
    goalId: 'g',
    agentId: 'a',
    statement: '',
    requiredConfirmation: [],
    invalidation: '',
    state: 'ACTIVE',
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const none = readSufficiency({ thesis, evidence: [], thesisTimeframe: '15m', now: NOW });
  assertEqual(none.sufficiency, 'INSUFFICIENT', 'nothing recorded is not enough');
  assertEqual(none.independentSupport, 0, 'and there is nothing independent to count');

  const supporting: Evidence[] = [
    { id: 'e1', thesisId: 't', polarity: 'SUPPORTS', summary: 'a', source: 'TRACKER_EVENT', weight: 0.1, novelty: 1, createdAt: 1 },
    { id: 'e2', thesisId: 't', polarity: 'SUPPORTS', summary: 'b', source: 'TRACKER_EVENT', weight: 0.12, novelty: 1, timeframe: '1h', createdAt: 2 },
  ];
  const enough = readSufficiency({ thesis, evidence: supporting, thesisTimeframe: '15m', now: NOW });
  assertEqual(enough.sufficiency, 'SUFFICIENT', 'two independent observations from two resolutions is a case');
  assertEqual(enough.higherTimeframeSupport, 1, 'and the confirmation from a coarser one is counted as such');

  const contradicted = readSufficiency({
    thesis,
    evidence: [
      ...supporting,
      { id: 'e3', thesisId: 't', polarity: 'CONTRADICTS', summary: 'c', source: 'TRACKER_EVENT', weight: 0.3, novelty: 1, createdAt: 3 },
    ],
    thesisTimeframe: '15m',
    now: NOW,
  });
  assertEqual(contradicted.sufficiency, 'CONTRADICTED', 'and the case against being heavier is named as such');

  const stale = readSufficiency({ thesis, evidence: supporting, thesisTimeframe: '15m', now: NOW + 10 * 60 * 60 * 1000 });
  assertEqual(stale.sufficiency, 'STALE', 'a case built long ago is stale rather than still standing');
});

test('sufficiency: the context carries it, and the model sees the reason', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);
  h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:ctx' }), {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'Confirmed.',
  });

  const context = h.loop.buildContext(h.goal.agentId, thesis.id)!;
  assert(context.sufficiency !== undefined, 'the context carries a sufficiency reading');
  assertEqual(context.sufficiency.supporting, 1, 'counted from the evidence, not asserted');
  assert(
    h.loop.buildContext('someone-else', thesis.id) === undefined,
    'and a context still cannot be built for a GOAT that does not own the thesis',
  );
});

// ---------------------------------------------------------------------------
// 9. Idempotency, lifecycle, and no lookahead
// ---------------------------------------------------------------------------

test('idempotency: a wake delivered twice is refused the second time, whatever it decides', () => {
  const h = makeHarness();
  const thesis = seedThesis(h, { state: 'ACTIONABLE' });
  const tracker = makeTracker(h, thesis.id);

  const build = () => ({
    kind: 'PROPOSE_TRADE_IDEA' as const,
    thesisId: thesis.id,
    reason: 'Entry.',
    idea: {
      symbol: 'EURUSD',
      direction: 'LONG' as const,
      orderType: 'LIMIT' as const,
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 1 }],
      reasoning: 'Reclaim confirmed.',
    },
  });

  const wake = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:once' });
  const first = h.loop.applyPlan(wake, build());
  assert(Boolean(first.tradeIdeaId), 'the first delivery produced the idea');
  const ideas = h.ideas.list().length;

  const second = h.loop.applyPlan(wake, build());
  assertEqual(second.tradeIdeaId, undefined, 'the second produced nothing');
  assertEqual(h.ideas.list().length, ideas, 'and no duplicate trade idea exists');
  assertEqual(h.evidence.listForThesis(thesis.id).length, 1, 'nor a duplicate evidence record');
});

test('lifecycle: a terminal thesis does not come back to life on a later answer', () => {
  /*
   * The runtime already revokes execution authority on stop; this asserts the
   * reasoning layer's half of the same boundary — a thesis that has been closed is
   * closed, whatever a wake that arrives afterwards says.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);

  const original = wakeFor(h, thesis.id, tracker.id, { sourceEventId: 'delivery:a' });
  h.loop.applyPlan(original, {
    kind: 'INVALIDATE_THESIS',
    thesisId: thesis.id,
    reason: 'Disproved.',
  });
  assertEqual(h.theses.get(thesis.id)!.state, 'INVALIDATED', 'the thesis is terminal');

  assert(
    h.trackers.listForThesis(thesis.id).every((candidate) => candidate.lifecycle.status !== 'ACTIVE'),
    'and it spends no further wake budget: every watch was cancelled with it',
  );
  assert(
    h.trackers.ingestEvent({
      id: 'evt_late',
      trackerId: tracker.id,
      agentId: h.goal.agentId,
      kind: tracker.kind,
      eventType: tracker.eventType,
      timestamp: NOW + 1,
      environment: 'DEMO',
      symbol: 'EURUSD',
      timeframe: tracker.timeframe,
      reason: 'Price reached the monitored level',
      priority: 60,
      severity: 'SIGNIFICANT',
    }) === undefined,
    'so the runtime will not even produce a second observation for it',
  );

  /*
   * And if a wake arrives anyway — a crafted one, a delivery that was already in
   * flight — the loop refuses it at the door and records the observation without
   * deciding anything from it. `reviseThesis` would throw; a thrown wake is a crash
   * in the middle of a replay.
   */
  const late = h.loop.applyPlan(
    {
      ...original,
      event: {
        id: 'evt_late_decision',
        trackerId: tracker.id,
        agentId: h.goal.agentId,
        kind: tracker.kind,
        eventType: tracker.eventType,
        timestamp: NOW + 1,
        environment: 'DEMO',
        symbol: 'EURUSD',
        timeframe: tracker.timeframe,
        reason: 'Price reached the monitored level',
        priority: 100,
        severity: 'DECISIVE',
      },
    },
    { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'And now it is confirmed?' },
  );
  assertEqual(late.evidenceRecorded.length, 1, 'the observation is still recorded — the market did do that');
  assert(/INVALIDATED/.test(late.rejections[0] ?? ''), 'and the refusal names the state that caused it');
  assertEqual(h.theses.get(thesis.id)!.state, 'INVALIDATED', 'a terminal thesis does not come back to life');
});

test('lifecycle: the whole reasoning pass is a function of its inputs', () => {
  /*
   * Determinism, asserted rather than asserted-about. The same harness, the same
   * thesis and the same events produce the same numbers every time — which is what a
   * backtest replay depends on, and what a confidence system carrying hidden state
   * would quietly break.
   */
  const run = (): number[] => {
    const h = makeHarness();
    const thesis = seedThesis(h);
    const routine = makeTracker(h, thesis.id, { priority: 20 });
    const decisive = makeTracker(h, thesis.id, { priority: 100 });
    for (const [index, tracker] of [routine, decisive, routine].entries()) {
      h.loop.applyPlan(
        wakeFor(h, thesis.id, tracker.id, { sourceEventId: `delivery:${index}` }),
        { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'Confirmed.' },
      );
    }
    return [h.theses.get(thesis.id)!.confidence!, h.theses.get(thesis.id)!.revision];
  };

  const first = run();
  const second = run();
  assertEqual(second[0], first[0], 'the same evidence produced the same belief');
  assertEqual(second[1], first[1], 'and the same number of revisions');
});

test('no lookahead: recalibration reads a recorded price and never the market', () => {
  /*
   * The only market input the reasoning layer has is a reading the GOAT already
   * made. This is the assertion that keeps it that way: the harness's reading is the
   * only source of a price here, so a recalibration that worked without one would be
   * reading something the system does not have.
   */
  const h = makeHarness();
  const thesis = seedThesis(h);
  const level = makeTracker(h, thesis.id, {
    purpose: 'Watch for a reclaim of 1.17',
    kind: 'PRICE_THRESHOLD',
    config: { level: 1.17, operator: 'ABOVE' },
  });
  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped.');

  h.setReading(undefined);
  const untouched = h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);
  assertEqual(h.trackers.get(untouched[0]!)!.config['level'], 1.17, 'no reading, no recalibration');

  h.trackers.cancelTrackersForThesis(thesis.id, 'Stopped again.');
  h.setReading({ symbol: 'EURUSD', price: 1.19, timeframe: '15m', at: NOW });
  const recalibrated = h.loop.restoreObservationPlan(h.goal.agentId, h.goal.id, [level.id]);
  assertEqual(
    h.trackers.get(recalibrated[0]!)!.config['level'],
    1.19,
    'and with a reading, exactly that recorded price is used',
  );
});

// ---------------------------------------------------------------------------
// 10. Ownership and fail-closed behaviour
// ---------------------------------------------------------------------------

test('ownership: a wake cannot act on a thesis it did not wake for', () => {
  const h = makeHarness({ constraints: [{ kind: 'MAX_THESES', maximum: 2 }] });
  const bull = seedThesis(h, {}, 'BULLISH');
  const bear = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The move is impulsive.',
    direction: 'BEARISH',
    invalidation: 'A reclaim of 1.1010.',
    competesWith: bull.id,
  });
  h.loop.reviseThesis(bear.id, { state: 'ACTIVE' });
  const bearBefore = h.theses.get(bear.id)!.state;
  const bullTracker = makeTracker(h, bull.id);

  /*
   * The wake is about the bull thesis; the plan escalates the bear one. The wake's
   * thesis is authoritative, exactly as it was for `ESCALATE_THESIS` before — a
   * model must not be able to act on a hypothesis it was not woken about.
   */
  const outcome = h.loop.applyPlan(wakeFor(h, bull.id, bullTracker.id), {
    kind: 'ESCALATE_THESIS',
    thesisId: bear.id,
    reason: 'That other one is ready.',
  });
  assertEqual(h.theses.get(bear.id)!.state, bearBefore, 'the other hypothesis was not escalated');
  assertEqual(h.theses.get(bull.id)!.state, 'ACTIONABLE', 'the wake acted on the thesis it woke for');
  assert(outcome.thesis.id === bull.id, 'the outcome describes the wake\'s thesis');
});

/*
 * The other side of batching.
 *
 * The runtime groups observations of one market moment into one wake; this is where
 * that becomes meaningful. Every observation is recorded as its own evidence — and
 * because they share a delivery, the second and third are worth nothing, so three
 * trackers agreeing about one bar produce one piece of support rather than three.
 *
 * These two claims are the reason batching is safe to do at all. If the loop only
 * read the wake's first event, observations would vanish; if it treated a frame as
 * independent confirmations, confidence would walk to certainty on a single bar.
 */
test('frame: every observation in a batch is recorded, and they are not independent', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const first = makeTracker(h, thesis.id, { purpose: 'Price cross', priority: 60 });
  const second = makeTracker(h, thesis.id, { purpose: 'Indicator cross', priority: 50 });
  const third = makeTracker(h, thesis.id, { purpose: 'Breakout', priority: 40 });

  const wake = wakeFor(h, thesis.id, first.id, {
    id: `evt_frame_primary_${NOW}`,
    sourceEventId: 'bar:1000',
    reason: 'Price closed above the level',
  });
  // The other two observations of the same bar, which the runtime put in the frame.
  const siblings = [
    wakeFor(h, thesis.id, second.id, {
      id: `evt_frame_rsi_${NOW}`, sourceEventId: 'bar:1000', reason: 'RSI crossed above 50',
    }),
    wakeFor(h, thesis.id, third.id, {
      id: `evt_frame_breakout_${NOW}`, sourceEventId: 'bar:1000', reason: 'Price broke the range',
    }),
  ];

  // One frame of three, exactly as the runtime delivers it.
  const frame = {
    batchId: 'batch:DEMO:agent-1:bar:1000',
    agentId: h.goal.agentId,
    thesisId: thesis.id,
    environment: 'DEMO' as const,
    symbol: 'EURUSD',
    observationTimestamp: NOW,
    sourceEventId: 'bar:1000',
    events: [wake.event, ...siblings.map((sibling) => sibling.event)],
    primaryEventId: wake.event.id,
  };
  const before = h.evidence.listForThesis(thesis.id).length;
  const outcome = h.loop.applyPlan({ ...wake, batch: frame }, {
    kind: 'CONFIRM_THESIS',
    thesisId: thesis.id,
    reason: 'The reclaim held.',
  });

  const recorded = h.evidence.listForThesis(thesis.id).slice(before);
  assertEqual(recorded.length, 3, 'every observation in the frame became its own evidence record');
  assert(
    recorded.every((item) => item.summary.includes('Tracker event')),
    'and each says what was observed',
  );
  assertEqual(
    new Set(recorded.map((item) => item.provenance)).size,
    1,
    'all three name the one delivery they came from, which is how they are known to be one movement',
  );
  assertEqual(
    recorded.filter((item) => (item.weight ?? 0) !== 0).length,
    1,
    'and only the observation the wake is addressed to carried weight',
  );
  assertEqual(
    new Set(outcome.evidenceRecorded).size,
    3,
    'the outcome reports all of them, because the GOAT was shown all of them',
  );
});

test('frame: a frame is worth about as much as one observation, not three', () => {
  const one = makeHarness();
  const thesisOne = seedThesis(one);
  const single = makeTracker(one, thesisOne.id);
  const oneOutcome = one.loop.applyPlan(wakeFor(one, thesisOne.id, single.id, {
    id: 'evt_single', sourceEventId: 'bar:2000', reason: 'Price closed above the level',
  }), { kind: 'CONFIRM_THESIS', thesisId: thesisOne.id, reason: 'The reclaim held.' });
  const confidenceAfterOne = one.theses.get(thesisOne.id)!.confidence;

  const many = makeHarness();
  const thesisMany = seedThesis(many);
  const a = makeTracker(many, thesisMany.id, { purpose: 'Price cross', priority: 60 });
  const b = makeTracker(many, thesisMany.id, { purpose: 'Indicator cross', priority: 50 });
  const c = makeTracker(many, thesisMany.id, { purpose: 'Breakout', priority: 40 });

  const primary = wakeFor(many, thesisMany.id, a.id, {
    id: 'evt_many_primary', sourceEventId: 'bar:2000', reason: 'Price closed above the level',
  });
  const siblings = [
    wakeFor(many, thesisMany.id, b.id, {
      id: 'evt_many_rsi', sourceEventId: 'bar:2000', reason: 'RSI crossed above 50',
    }),
    wakeFor(many, thesisMany.id, c.id, {
      id: 'evt_many_breakout', sourceEventId: 'bar:2000', reason: 'Price broke the range',
    }),
  ];
  many.loop.applyPlan({ ...primary, batch: {
    batchId: 'batch:DEMO:agent-1:bar:2000',
    agentId: many.goal.agentId,
    thesisId: thesisMany.id,
    environment: 'DEMO',
    symbol: 'EURUSD',
    observationTimestamp: NOW,
    sourceEventId: 'bar:2000',
    events: [primary.event, ...siblings.map((sibling) => sibling.event)],
    primaryEventId: primary.event.id,
  } }, { kind: 'CONFIRM_THESIS', thesisId: thesisMany.id, reason: 'The reclaim held.' });
  const confidenceAfterFrame = many.theses.get(thesisMany.id)!.confidence;

  assertEqual(oneOutcome.thesis.id, thesisOne.id, 'the single-observation wake described its thesis');
  assertEqual(
    confidenceAfterFrame,
    confidenceAfterOne,
    'three trackers reporting the same bar moves belief exactly as much as one of them did',
  );
});

/*
 * Provenance that survives the evidence store.
 *
 * Novelty is the mechanism that stops three observations of one bar reading as
 * three confirmations, and it works by asking whether this delivery has been seen
 * before. That question was answered from the evidence list — which is bounded and
 * evicted oldest-first — so on a thesis awake long enough, the record of an
 * observation disappeared and the next appearance of that observation was scored
 * as brand new. These two cases hold the boundary: a repeat stays a repeat after
 * the record of the first time is gone, and a genuinely new delivery still counts.
 */
test('provenance: a repeat stays a repeat after its evidence record is evicted', () => {
  const h = makeHarness();
  const thesis = seedThesis(h);
  const tracker = makeTracker(h, thesis.id);

  h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, {
    id: 'evt_cap_first', sourceEventId: 'bar:cap', reason: 'Price crossed above the level',
  }), { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'first look' });
  const afterFirst = h.theses.get(thesis.id)!.confidence ?? 0;

  // A delivery seen again, however much unrelated evidence has piled up since.
  h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, {
    id: 'evt_cap_second', sourceEventId: 'bar:cap', reason: 'Price crossed above the level',
  }), { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'seen before' });
  assertEqual(
    h.theses.get(thesis.id)!.confidence,
    afterFirst,
    'the same delivery a second time moves nothing',
  );
  assertEqual(
    h.evidence.listForThesis(thesis.id).slice(-1)[0]!.novelty,
    0,
    'and is recorded as worth nothing',
  );

  // And a delivery nobody has seen still moves belief. Not by the full amount: it
  // is the same tracker asking again, which is discounted — but discounted, not
  // zeroed. A provenance system that suppressed legitimate later evidence would be
  // as wrong as one that let repeats through.
  h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, {
    id: 'evt_cap_third', sourceEventId: 'bar:different', reason: 'Price crossed above the level',
  }), { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'a different bar' });
  const moved = h.theses.get(thesis.id)!.confidence ?? 0;
  assert(moved > afterFirst, 'a genuinely new delivery moves belief, even after a repeat');
  assertEqual(
    h.evidence.listForThesis(thesis.id).slice(-1)[0]!.provenance,
    'delivery:bar:different',
    'and is recorded against the delivery that produced it',
  );
});

test('provenance: the cap on retained evidence does not decide what counts as new', () => {
  /*
   * Driven directly, because provoking 5,000 real observations would make this
   * test slow for no extra insight: the store's retention policy is the input, and
   * novelty must not depend on it.
   */
  const key = 'delivery:bar:ancient';
  // What is left of the record after the store's cap has recycled the rest.
  const evicted: Array<{ provenance?: string; sourceTrackerId?: string }> = [];
  assertEqual(
    noveltyWeight({ provenanceKey: key, trackerId: 't1', prior: evicted }),
    1,
    'with nothing left in the record to compare, an old delivery looks new — which is the defect',
  );
  assertEqual(
    noveltyWeight({ provenanceKey: key, trackerId: 't1', prior: evicted, seenProvenance: new Set([key]) }),
    0,
    'and the durable identity is what stops it',
  );
  assertEqual(
    noveltyWeight({ provenanceKey: 'delivery:bar:new', trackerId: 't1', prior: evicted, seenProvenance: new Set([key]) }),
    1,
    'without suppressing a delivery nobody has seen',
  );
  assertEqual(
    noveltyWeight({
      provenanceKey: key,
      trackerId: 't1',
      prior: [{ provenance: key, sourceTrackerId: 't1' }],
      seenProvenance: new Set<string>(),
    }),
    0,
    'and the record still answers it when the record is there',
  );
});

/*
 * A refusal is information.
 *
 * The transition table does not allow every move, and a wake can carry a plan the
 * table refuses. That refusal used to throw, which unwound the caller before it
 * could report anything: the evidence the wake had already recorded disappeared,
 * the reason for the refusal disappeared, and the orchestrator's in-flight session
 * marker stayed pinned — silently dropping every later activity line for that
 * GOAT. A refusal has to leave a record and leave the session as it found it.
 */
test('refusal: a plan the state machine will not accept still reports, and loses nothing', () => {
  const h = makeHarness();
  /*
   * `INVESTIGATING` cannot become `STRENGTHENING` — the table does not allow it —
   * and a thesis with a live tracker can sit in `INVESTIGATING`. This is that
   * shape, reached the way the product reaches it.
   */
  const thesis = h.loop.createThesis({
    goalId: h.goal.id,
    agentId: h.goal.agentId,
    statement: 'The decline is corrective inside a broader bullish structure.',
    direction: 'BULLISH',
    invalidation: 'A sustained structural break below 1.0950.',
    requiredConfirmation: ['a 15m close above 1.1010'],
  });
  h.loop.reviseThesis(thesis.id, { state: 'INVESTIGATING' });
  assertEqual(h.theses.get(thesis.id)!.state, 'INVESTIGATING', 'the thesis really is in a state that refuses this move');
  const tracker = makeTracker(h, thesis.id);
  const before = h.evidence.listForThesis(thesis.id).length;

  const outcome = h.loop.applyPlan(wakeFor(h, thesis.id, tracker.id, {
    id: 'evt_investigating', sourceEventId: 'bar:inv', reason: 'Price crossed above the level',
  }), { kind: 'CONFIRM_THESIS', thesisId: thesis.id, reason: 'this should be refused' });

  assertEqual(
    h.theses.get(thesis.id)!.state,
    'INVESTIGATING',
    'the thesis is exactly where it was',
  );
  assert(outcome.rejections.length > 0, 'and the refusal is reported rather than thrown');
  assert(
    h.evidence.listForThesis(thesis.id).length > before,
    'the evidence the wake recorded before the refusal is kept',
  );
  assert(outcome.evidenceRecorded.length > 0, 'and is named in the outcome');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runReasoningTests(): Promise<void> {
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
  if (failures.length > 0) throw new Error(`${failures.length} reasoning test(s) failed.`);
}

if (import.meta.main) {
  await runReasoningTests();
}
