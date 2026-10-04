/**
 * GOAT definition and agent-tool tests.
 *
 * Two things are being defended here.
 *
 * The first is the schema itself: a GOAT states a goal and is given no
 * observation plan, and it should be difficult to reintroduce one by
 * accident. The second is the tool boundary: a tool is a *request*,
 * and the runtime decides whether the request is allowed.
 */

import { GoatSkillRegistry } from './skills';
import { GOAT_BUILTIN_SKILLS } from './builtinSkills';
import {
  CURRENT_GOAT_SCHEMA_VERSION,
  GoatValidationError,
  compileGoatDefinition,
  createGoatDeployment,
  migrateGoatDefinition,
  validateGoatDefinition,
  validateGoatDeployment,
  type GoatDefinition,
} from './definition';
import { AGENT_TOOL_IDS, buildAgentTools } from './agentTools';
import { AGENT_TOOL_GUIDE } from './agentTools';
import { GOAT_CAPABILITIES } from './trackerSdk';
import { GoatLoop } from './loop';
import {
  InMemoryEvidenceStore,
  InMemoryGoalStore,
  InMemoryThesisStore,
  InMemoryTradeIdeaStore,
} from './store';
import { TrackerRegistry } from '../agents/trackers/registry';
import { TrackerRuntime } from '../agents/trackers/runtime';
import { CapabilityRegistry } from '../agents/capabilities/registry';
import { ITradingEnvironment } from '../agents/types';
import { Bar } from '../../types/trading';
import { AgentCapability, CapabilityContext } from '../agents/types';

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

const stubEnv = { mode: 'DEMO' } as ITradingEnvironment;

/*
 * The real capability registry, so a skill naming a capability the
 * system does not have fails here rather than passing against a
 * hand-written list. A narrow list would make this whole suite
 * validate against capabilities that do not exist.
 */
import { capabilityRegistry } from '../agents/capabilities';
import { ALL_GOAT_CAPABILITIES } from './trackerSdk';

function skills(): GoatSkillRegistry {
  const registry = new GoatSkillRegistry({
    knownCapabilityIds: () => [
      ...capabilityRegistry.list().map((capability) => capability.id),
      ...ALL_GOAT_CAPABILITIES,
      ...Object.values(AGENT_TOOL_IDS),
    ],
  });
  registry.registerAll(GOAT_BUILTIN_SKILLS);
  return registry;
}

function definition(overrides: Partial<GoatDefinition> = {}): GoatDefinition {
  return {
    schemaVersion: CURRENT_GOAT_SCHEMA_VERSION,
    version: 1,
    source: 'user',
    identity: { id: 'goat-1', name: 'Momentum Hunter', description: 'Looks for continuation.' },
    goal: {
      statement: 'Find markets where momentum is expanding and price is following.',
      symbols: [],
      excludedSymbols: [],
    },
    skills: [
      { id: 'structural-trend-analysis', version: 1 },
      { id: 'regime-awareness', version: 1 },
    ],
    capabilities: {
      readMarketData: true,
      readHistoricalData: true,
      readAccount: true,
      readPositions: true,
      manageTrackers: true,
      manageThesis: true,
      proposeTrades: true,
      requestExecution: false,
    },
    agentConfig: {
      provider: 'openrouter',
      model: 'test-model',
      reasoningMode: 'advisory',
      confidenceThreshold: 0.7,
      decisionPolicy: 'Report before acting.',
      maxIterations: 8,
    },
    riskPolicy: {
      riskPerTrade: 0.005,
      maxPositions: 1,
      maxExposure: 50_000,
      cooldownMs: 60_000,
      maxActiveTheses: 2,
      maxActiveTrackers: 8,
      maxWakeupsPerHour: 20,
      maxToolCallsPerCycle: 24,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as GoatDefinition;
}

function deployment(overrides: Record<string, unknown> = {}) {
  return createGoatDeployment({
    goatId: 'goat-1',
    goatVersion: 1,
    marketId: 'EURUSD',
    accountId: 'paper',
    mode: 'SHADOW',
    execution: { canProposeTrades: true, canExecute: false, allowedOrderTypes: ['LIMIT'] },
    createdAt: 0,
    ...overrides,
  } as never);
}

// ---------------------------------------------------------------------------
// GOAT creation: Goal -> GOAT
// ---------------------------------------------------------------------------

test('creation: a goal plus skills produces a valid GOAT', () => {
  const created = validateGoatDefinition(definition(), { skills: skills() });
  assertEqual(created.identity.name, 'Momentum Hunter', 'the GOAT is named');
  assert(created.goal.statement.length > 0, 'the goal states the outcome');
  assertEqual(created.skills.length, 2, 'the skills are carried');
});

test('creation: a GOAT with no skills is refused', () => {
  assertThrows(
    () => validateGoatDefinition(definition({ skills: [] }), { skills: skills() }),
    'a GOAT must have at least one skill',
  );
});

test('creation: a GOAT referencing an unregistered skill is refused', () => {
  assertThrows(
    () =>
      validateGoatDefinition(
        definition({ skills: [{ id: 'does-not-exist', version: 1 }] }),
        { skills: skills() },
      ),
    'a GOAT cannot claim a skill that does not exist',
  );
});

test('creation: a GOAT without a goal is refused', () => {
  assertThrows(
    () => validateGoatDefinition(definition({ goal: { statement: '  ', symbols: [], excludedSymbols: [] } })),
    'a GOAT must have a goal',
  );
});

test('creation: a goal that specifies a method is reported', () => {
  let problems: string[] = [];
  try {
    validateGoatDefinition(
      definition({ goal: { statement: 'Buy EURUSD when RSI crosses below 30', symbols: [], excludedSymbols: [] } }),
      { skills: skills() },
    );
  } catch (error) {
    problems = (error as GoatValidationError).problems ?? [];
  }
  assert(problems.some((p) => p.includes('method')), 'a goal naming a method is told to state the outcome');
});

test('creation: a goal stated as an outcome is accepted without complaint', () => {
  const created = validateGoatDefinition(
    definition({ goal: { statement: 'Find a long opportunity when a decline looks like it is reversing.', symbols: [], excludedSymbols: [] } }),
    { skills: skills() },
  );
  assert(created.goal.statement.includes('reversing'), 'an outcome-shaped goal is fine');
});

test('creation: unknown fields are refused rather than ignored', () => {
  assertThrows(
    () => validateGoatDefinition({ ...definition(), entryRule: 'buy at X' }, { skills: skills() }),
    'a definition carrying a field the schema does not have must be refused, not ignored',
  );
});

test('creation: risk policy ceilings are all required', () => {
  const incomplete = { ...definition().riskPolicy } as Record<string, unknown>;
  delete incomplete.maxWakeupsPerHour;
  assertThrows(
    () => validateGoatDefinition(definition({ riskPolicy: incomplete as never }), { skills: skills() }),
    'a GOAT without an agentic-explosion ceiling is refused',
  );
});

test('creation: a starter GOAT is a real GOAT, not a disguised something else', () => {
  // Every starter must survive the same validation a user-authored
  // definition does, or the two are not the same kind of thing.
  let { STARTER_GOATS } = require('./starterGoats') as typeof import('./starterGoats');
  assertEqual(STARTER_GOATS.length, 4, 'the product ships exactly four starter GOATs');
  for (const starter of STARTER_GOATS) {
    validateGoatDefinition(starter, { skills: skills() });
    /*
     * The field name is spelled the old way on purpose. This asserts the
     * absence of a retired shape, and a renamed assertion would stop
     * testing the thing that actually happened.
     */
    assert(
      !('triggers' in (starter as unknown as Record<string, unknown>)),
      `starter "${starter.identity.id}" carries an observation plan`,
    );
    assertEqual(starter.capabilities.requestExecution, false, `starter "${starter.identity.id}" ships with execution authority`);
  }
});

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

test('deployment: a GOAT is not bound to a market until deployed', () => {
  const created = validateGoatDefinition(definition(), { skills: skills() });
  assertEqual(created.goal.symbols.length, 0, 'a created GOAT has no market');
  const deployed = deployment();
  assertEqual(deployed.marketId, 'EURUSD', 'a deployment is where the market comes from');
});

test('deployment: a deployment cannot execute what the definition never requested', () => {
  const goat = definition();
  assertThrows(
    () =>
      validateGoatDeployment(
        deployment({ execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET'] } }),
        goat,
      ),
    'a deployment cannot grant execution a definition did not request',
  );
});

test('deployment: a deployment cannot execute without being able to propose', () => {
  assertThrows(
    () =>
      validateGoatDeployment(
        deployment({ execution: { canProposeTrades: false, canExecute: true, allowedOrderTypes: ['MARKET'] } }),
      ),
    'an account with a reason to trade but no way to reach the decision is not a thing a deployment can express',
  );
});

test('deployment: SHADOW mode can never permit trading', () => {
  const goat = definition({ capabilities: { ...definition().capabilities, requestExecution: true } });
  const compiled = compileGoatDefinition({
    definition: goat,
    deployment: validateGoatDeployment(
      deployment({
        mode: 'SHADOW',
        execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET'] },
      }),
      goat,
    ),
    marketSymbol: 'EURUSD',
    env: stubEnv,
    skills: skills(),
  });
  assertEqual(compiled.policy.allowTrading, false, 'a shadow deployment must never reach the order path');
});

test('deployment: reasoning mode does not change permission', () => {
  const goat = definition({ capabilities: { ...definition().capabilities, requestExecution: true } });
  const dep = validateGoatDeployment(
    deployment({ mode: 'DEMO', execution: { canProposeTrades: true, canExecute: true, allowedOrderTypes: ['MARKET'] } }),
    goat,
  );
  const verdicts = (['advisory', 'confirm', 'autonomous'] as const).map(
    (mode) =>
      compileGoatDefinition({
        definition: { ...goat, agentConfig: { ...goat.agentConfig, reasoningMode: mode } },
        deployment: dep,
        marketSymbol: 'EURUSD',
        env: stubEnv,
        skills: skills(),
      }).policy.allowTrading,
  );
  assertEqual(new Set(verdicts).size, 1, `reasoning mode changed permission: ${verdicts.join(', ')}`);
  assertEqual(verdicts[0], true, 'a deployment that grants execution should reach it');
});

test('deployment: a GOAT has no fixed timeframe', () => {
  const compiled = compileGoatDefinition({
    definition: definition(),
    deployment: deployment(),
    marketSymbol: 'EURUSD',
    env: stubEnv,
    skills: skills(),
  });
  assertEqual(compiled.timeframe, undefined, 'timeframe selection is an agent decision, per tracker');
});

test('deployment: a GOAT cannot propose trades when its definition forbids it', () => {
  const goat = definition({ capabilities: { ...definition().capabilities, proposeTrades: false } });
  assertThrows(
    () =>
      validateGoatDeployment(
        deployment({ execution: { canProposeTrades: true, canExecute: false, allowedOrderTypes: ['LIMIT'] } }),
        goat,
      ),
    'a deployment cannot propose on behalf of a GOAT that may not propose',
  );
});

test('migration: a definition without a schemaVersion is refused', () => {
  assertThrows(
    () => migrateGoatDefinition({ identity: { id: 'x' } }),
    'an unmigratable definition is refused rather than coerced',
  );
});

test('migration: a newer schemaVersion is refused', () => {
  assertThrows(
    () => migrateGoatDefinition({ ...definition(), schemaVersion: CURRENT_GOAT_SCHEMA_VERSION + 1 }),
    'a definition from the future is not silently reinterpreted',
  );
});

// ---------------------------------------------------------------------------
// Compiled agent
// ---------------------------------------------------------------------------

test('compile: capabilities are the intersection and can only narrow', () => {
  const registry = new CapabilityRegistry();
  for (const id of ['market.getQuote', 'market.getBars']) {
    registry.register({
      id,
      name: id,
      description: id,
      category: 'market',
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({}),
    } as AgentCapability);
  }
  const compiled = compileGoatDefinition({
    definition: definition(),
    deployment: deployment(),
    marketSymbol: 'EURUSD',
    env: stubEnv,
    skills: skills(),
    capabilities: registry,
  });
  assert(
    compiled.capabilities.every((id) =>
      registry.has(id) || Object.values(AGENT_TOOL_IDS).includes(id as never) || id.startsWith('trackers.'),
    ),
    'a compiled agent is never handed a capability that is not registered',
  );
});

test('compile: a GOAT with no execution permission cannot trade', () => {
  const compiled = compileGoatDefinition({
    definition: definition(),
    deployment: deployment(),
    marketSymbol: 'EURUSD',
    env: stubEnv,
    skills: skills(),
  });
  assertEqual(compiled.policy.allowTrading, false, 'a starter-shaped GOAT does not ship with trading authority');
  assertEqual(compiled.policy.allowedSymbols[0], 'EURUSD', 'and is scoped to its deployment market');
});

// ---------------------------------------------------------------------------
// Agent tool layer
// ---------------------------------------------------------------------------

function toolHarness() {
  const goals = new InMemoryGoalStore();
  const theses = new InMemoryThesisStore();
  const evidence = new InMemoryEvidenceStore();
  const ideas = new InMemoryTradeIdeaStore();

  goals.save({
    id: 'goal-1',
    agentId: 'goat-1',
    statement: 'Find a reversal on EURUSD.',
    symbols: ['EURUSD'],
    timeframes: [],
    skillIds: [],
    status: 'MONITORING',
    createdAt: 0,
    updatedAt: 0,
  });

  const thesis = theses.listForGoal('goal-1')[0] ?? undefined;
  const created =
    thesis ??
    (() => {
      const t: import('./types').Thesis = {
        id: 'ths-1',
        goalId: 'goal-1',
        agentId: 'goat-1',
        statement: 'The decline is corrective.',
        direction: 'BULLISH',
        requiredConfirmation: ['momentum recovery'],
        invalidation: 'A sustained break below 1.0950.',
        state: 'ACTIVE',
        confidence: 0.6,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      };
      theses.save(t);
      return t;
    })();

  const trackerRuntime = new TrackerRuntime({
    registry: new TrackerRegistry(() => undefined),
    agents: { getAgent: () => undefined, listAgents: () => [] } as never,
    timeline: { append: async () => undefined } as never,
  });
  trackerRuntime.bindDomain({
    resolveThesis: (id: string) => theses.get(id),
    resolveSkillIds: () => [],
  });

  const loop = new GoatLoop({
    goals,
    theses,
    evidence,
    ideas,
    trackers: trackerRuntime,
    skills: skills(),
    sdkFor: () => ({}) as never,
    clock: () => 0,
  });

  const tools = buildAgentTools({ loop });
  const context = {
    agentId: 'goat-1',
    environment: 'DEMO',
    env: stubEnv,
    policy: {} as never,
    symbols: ['EURUSD'],
    thesisStore: theses,
    evidenceStore: evidence,
    goalStore: goals,
    trackerStore: {
      listForThesis: (id: string) => trackerRuntime.listForThesis(id).map((t) => ({
        id: t.id,
        purpose: t.purpose,
        status: t.lifecycle.status,
        eventCount: t.lifecycle.eventCount,
      })),
    },
    loop,
  } as unknown as CapabilityContext & { thesisStore: typeof theses };

  return { tools, context, theses, evidence, ideas, thesisId: created.id, loop };
}

test('tools: the tool set exposes the agent mind', () => {
  const { tools } = toolHarness();
  const ids = tools.map((tool) => tool.id);
  for (const id of Object.values(AGENT_TOOL_IDS)) {
    assert(ids.includes(id), `the tool set is missing ${id}`);
  }
  /*
   * Tracker authority is deliberately not here. It is reachable through
   * the Tracker SDK capabilities, so putting it in this set as well
   * would create a second route to the same authority with its own
   * permission check — and two checks is one more than there should be.
   */
  assert(
    !ids.some((id) => id.startsWith('trackers.')),
    'tracker authority must come from the Tracker SDK, not the tool set',
  );
});

test('tools: reading a thesis returns the hypothesis and its invalidation', async () => {
  const { tools, context, thesisId } = toolHarness();
  const read = tools.find((tool) => tool.id === AGENT_TOOL_IDS.readThesis)!;
  const result = (await read.execute({ thesisId }, context)) as {
    thesis: { statement: string; invalidation: string };
  };
  assert(result.thesis.statement.includes('corrective'), 'the hypothesis is returned');
  assert(result.thesis.invalidation.length > 0, 'the invalidation is returned with it');
});

test('tools: updating a thesis goes through the state machine', async () => {
  const { tools, context, thesisId } = toolHarness();
  const update = tools.find((tool) => tool.id === AGENT_TOOL_IDS.updateThesis)!;
  const bad = (await update.execute(
    { thesisId, state: 'DRAFT', reason: 'rewinding' },
    context,
  )) as { error?: string };
  assert(bad.error, 'an illegal transition is refused with a reason, not applied');
});

test('tools: evidence reads both directions', async () => {
  const { tools, context, thesisId, evidence } = toolHarness();
  evidence.append({
    id: 'e1',
    thesisId,
    polarity: 'SUPPORTS',
    summary: 'Momentum recovered.',
    source: 'TRACKER_EVENT',
    createdAt: 0,
  });
  evidence.append({
    id: 'e2',
    thesisId,
    polarity: 'CONTRADICTS',
    summary: 'Volume confirmation is weak.',
    source: 'AGENT_INVESTIGATION',
    createdAt: 0,
  });

  const read = tools.find((tool) => tool.id === AGENT_TOOL_IDS.readEvidence)!;
  const result = (await read.execute({ thesisId }, context)) as {
    supporting: unknown[];
    contradicting: unknown[];
  };
  assertEqual(result.supporting.length, 1, 'supporting evidence is returned');
  assertEqual(result.contradicting.length, 1, 'contradicting evidence is returned too');
});

test('tools: a non-actionable thesis cannot produce a trade idea', async () => {
  const { tools, context, thesisId, ideas } = toolHarness();
  const propose = tools.find((tool) => tool.id === AGENT_TOOL_IDS.proposeIdea)!;
  const result = (await propose.execute(
    {
      thesisId,
      symbol: 'EURUSD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 1.105,
      invalidationLevel: 1.0985,
      takeProfits: [{ price: 1.115, fraction: 1 }],
      reasoning: 'Looks good.',
    },
    context,
  )) as { tradeIdeaId?: string; status: string };

  assertEqual(result.status, 'REJECTED', 'an idea from a non-actionable thesis is rejected');
  assertEqual(ideas.list().length, 0, 'and nothing is stored');
});

test('tools: a tool with no resolvable thesis says so instead of guessing', async () => {
  const { tools, context } = toolHarness();
  const read = tools.find((tool) => tool.id === AGENT_TOOL_IDS.readThesis)!;
  const result = (await read.execute({ thesisId: 'does-not-exist' }, context)) as { error?: string };
  assert(result.error, 'an unknown thesis is reported, not silently resolved to another one');
});

test('tools: the tool guide names the tools the agent can call', () => {
  for (const id of Object.values(AGENT_TOOL_IDS)) {
    assert(AGENT_TOOL_GUIDE.includes(id), `the guide does not mention ${id}`);
  }
  assert(
    AGENT_TOOL_GUIDE.includes(GOAT_CAPABILITIES.createTracker),
    'the guide should also point at the Tracker SDK, which is where watching comes from',
  );
  assert(
    AGENT_TOOL_GUIDE.includes('contradicting'),
    'the guide should push the agent toward reading against itself',
  );
});

export async function runDefinitionTests(): Promise<void> {
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
  if (failures.length > 0) throw new Error(`${failures.length} GOAT definition test(s) failed.`);
}
