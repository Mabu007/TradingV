/**
 * The OpenRouter agent-model boundary.
 *
 * This file exists because it had no tests at all, and because the defect
 * it caused lived entirely inside it.
 *
 * The bug, precisely: `OpenRouterAgentModel` built one system prompt for
 * every phase. That prompt declared a *trading-decision* response format —
 * `WAIT` / `OPEN_POSITION` — while the caller that deploys a GOAT needed a
 * *hypothesis and an observation plan*. Every GOAT test passed, because
 * every GOAT test used a stub model that returned exactly the shape the
 * parser wanted. The first real deployment returned a valid `WAIT`
 * decision, and the product told the user "the reasoning model did not
 * return a hypothesis for this goal, so nothing was deployed".
 *
 * So these tests stub `fetch`, not the model: the real adapter builds the
 * real prompt and normalises the real reply.
 */

import { OpenRouterAgentModel, normalizeModelReply } from './openrouter';
import type { AgentModelRequest } from './types';
import type { AgentObservation, TradingAgent } from '../types';
import { installFetchStub, restoreFetch, lastCall } from './testFetch';
import { openRouterProvider } from '../../../adapters/openrouter/provider';

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function agent(overrides: Partial<TradingAgent> = {}): TradingAgent {
  return {
    id: 'goat_1',
    name: 'GOAT',
    description: 'test',
    instructions: 'test',
    skills: ['goat-core'],
    capabilities: ['market.getQuote'],
    policy: {
      maxRiskPerTrade: 0.01,
      maxOpenPositions: 1,
      maxExposure: 50_000,
      maxOrdersPerMinute: 10,
      allowedSymbols: ['EUR/USD'],
      allowedOrderTypes: ['LIMIT'],
      // The SHADOW case: research yes, order submission no.
      allowTrading: false,
    },
    preferredEnvironment: 'DEMO',
    symbols: ['EUR/USD'],
    timeframe: '15m',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function observation(): AgentObservation {
  return {
    timestamp: 1_700_000_000,
    environment: 'DEMO',
    market: {
      quotes: [],
      quote: {
        symbol: 'EUR/USD',
        symbolId: '1',
        bid: 1.1285,
        ask: 1.1286,
        spread: 0.0001,
        timestamp: 1_700_000_000,
        status: 'LIVE',
      },
    },
    account: {
      balance: 10_000,
      equity: 10_000,
      margin: 0,
      freeMargin: 10_000,
      dailyPnL: 0,
      drawdownPercent: 0,
    },
    positions: [],
    orders: [],
    availableCapabilities: ['market.getQuote'],
    availableSkills: ['goat-core'],
  };
}

const OBJECTIVE =
  'Find a high-quality EUR/USD trading opportunity. Wait for clear evidence before producing a trade plan.';

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    agent: agent(),
    objective: OBJECTIVE,
    observation: observation(),
    instructions: 'You are deployed on EUR/USD at 15m.',
    skillsInstructions: '',
    toolHistory: [],
    iteration: 0,
    wakeReason: 'DEPLOYED',
    ...overrides,
  };
}

/** What the provider actually received. */
function outbound(): { model: string; messages: Array<{ role: string; content: string }> } {
  const call = lastCall();
  assert(call, 'a request was made');
  return JSON.parse(call.body) as { model: string; messages: Array<{ role: string; content: string }> };
}

function systemPrompt(): string {
  const sent = outbound();
  return sent.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

function allText(): string {
  return outbound()
    .messages.map((message) => message.content)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The regression: one contract per phase, and no second one anywhere
// ---------------------------------------------------------------------------

test('investigation: the request describes a thesis, and no trading decision', async () => {
  installFetchStub(`{"thought":"ok","thesis":{"statement":"s","invalidation":"i"},"trackers":[]}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const prompt = systemPrompt();
  assert(prompt.includes('"thesis"'), 'the thesis schema is described');
  assert(prompt.includes('"invalidation"'), 'and the invalidation it requires');
  assert(
    !prompt.includes('"decision":'),
    'a GOAT investigating must not also be told to return a trading decision',
  );
  assert(
    !prompt.includes('OPEN_POSITION'),
    'and no order type is offered as an answer to an investigation',
  );
});

test('investigation: the request contains exactly one system message', async () => {
  installFetchStub(`{"thought":"ok","thesis":{"statement":"s","invalidation":"i"},"trackers":[]}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const systems = outbound().messages.filter((message) => message.role === 'system');
  assertEqual(systems.length, 1, 'one system message, not the prompt twice');
});

test('the provider decision prompt never leaks into a GOAT request', async () => {
  installFetchStub(`{"thought":"ok"}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const text = allText();
  assert(
    !text.includes('AVAILABLE DECISIONS'),
    "the provider's own decision catalogue must not be sent alongside a thesis request",
  );
  assert(
    !text.includes('Return a single valid JSON object matching the requested decision schema'),
    'nor its closing instruction',
  );
});

test('plan: a wake asks for a kind, not a decision', async () => {
  installFetchStub(`{"kind":"WAIT","reason":"not enough"}`);
  await new OpenRouterAgentModel().run(request({ contract: 'PLAN' }));

  const prompt = systemPrompt();
  assert(prompt.includes('CONFIRM_THESIS'), 'the wake vocabulary is present');
  assert(!prompt.includes('"decision":'), 'and no trading decision schema is');
  assert(!prompt.includes('OPEN_POSITION'), 'nor an order is offered as an answer');
});

test('interpretation: the goal reader asks for the shape its parser reads', async () => {
  installFetchStub(`{"understood":"a goal","actionable":true}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INTERPRETATION' }));

  const prompt = systemPrompt();
  assert(prompt.includes('"understood"'), 'the interpretation schema is described');
  assert(prompt.includes('"actionable"'), 'including the boolean the parser requires');
});

// ---------------------------------------------------------------------------
// Research permission versus execution permission
// ---------------------------------------------------------------------------

test('a SHADOW deployment is told it may read the market and may not submit orders', async () => {
  installFetchStub(`{"thought":"ok","thesis":{"statement":"s","invalidation":"i"},"trackers":[]}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const prompt = systemPrompt();
  assert(
    prompt.includes('Research permission — granted'),
    'research is stated as granted, not left to be inferred',
  );
  assert(
    prompt.includes('Market you are deployed on: EUR/USD'),
    'the deployed market is named',
  );
  assert(
    prompt.includes('Trading allowed (order submission): false'),
    'order submission is reported as off',
  );
  assert(
    prompt.includes('Allowed order types: [LIMIT]'),
    'a SHADOW deployment still knows which order types its deployment permits',
  );
  assert(
    !/Trading Allowed:\s*false/.test(prompt),
    'the old single "Trading Allowed" line, which read as "you may not investigate", is gone',
  );
  assert(
    prompt.includes('never a reason to decline to investigate'),
    'and the prompt says so in words',
  );
});

test("the user's objective reaches the model, in their own words", async () => {
  installFetchStub(`{"thought":"ok"}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const prompt = systemPrompt();
  assert(
    prompt.includes(OBJECTIVE),
    'the objective is in the prompt. It used to be dropped, so the model was asked to investigate a market it had no objective for and answered that no objective had been given — which was then stored as the GOAT\'s understanding of the user.',
  );
  assert(
    prompt.includes('deliberately broad'),
    'and the prompt says the objective is not expected to be a strategy',
  );
});

test('an objective is never answered with "the user has not specified one"', async () => {
  installFetchStub(`{"thought":"ok","thesis":{"statement":"s","invalidation":"i"},"trackers":[]}`);
  await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  const prompt = systemPrompt();
  assert(
    /do not answer that the objective is unspecified/i.test(prompt),
    'the instruction against inventing an objective is explicit',
  );
});

test('the deployed symbol reaches the request even when the goal has none', async () => {
  installFetchStub(`{"thought":"ok","thesis":{"statement":"s","invalidation":"i"},"trackers":[]}`);
  await new OpenRouterAgentModel().run(
    request({
      contract: 'INVESTIGATION',
      agent: agent({ symbols: [], policy: { ...agent().policy, allowedSymbols: [] } }),
    }),
  );

  const prompt = systemPrompt();
  assert(
    prompt.includes('Market you are deployed on: EUR/USD'),
    'the quote in the observation is the fallback, and it is a real quote',
  );
});

// ---------------------------------------------------------------------------
// Normalisation: the canonical representation
// ---------------------------------------------------------------------------

test('a thesis response keeps its whole payload, not just its prose', async () => {
  installFetchStub(
    JSON.stringify({
      thought: 'RSI is high but structure holds.',
      thesis: { statement: 'Continuation.', direction: 'BULLISH', invalidation: 'A close below 1.1230.' },
      trackers: [{ purpose: 'a new bar', kind: 'NEW_BAR', config: {} }],
    }),
  );

  const response = await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  assert(response.payload !== undefined, 'the payload survives the boundary');
  assertEqual(
    (response.payload as Record<string, unknown>)['thesis'] !== undefined,
    true,
    'and it still contains the thesis',
  );
  assertEqual(response.thought, 'RSI is high but structure holds.', 'thought is the prose alone');
});

test('a decision response is not reduced to its thought', async () => {
  installFetchStub(
    JSON.stringify({ thought: 'Nothing confirmed.', decision: { type: 'WAIT', reason: 'no structure' } }),
  );

  const response = await new OpenRouterAgentModel().run(request({ contract: 'DECISION' }));

  assert(response.decision?.type === 'WAIT', 'the decision is read');
  assert(response.payload !== undefined, 'and the payload is still whole');
});

test('markdown-fenced JSON is read', () => {
  const response = normalizeModelReply(
    'Here you go:\n\n```json\n{"thought":"t","kind":"WAIT"}\n```\n\nHope that helps.',
  );
  assert(response.payload !== undefined, 'a fence does not hide the answer');
  assertEqual(response.payload!['kind'], 'WAIT', 'and the value survives');
});

test('an example printed after the answer does not destroy it', () => {
  /*
   * The greedy `\{[\s\S]*\}` this replaced matched from the first brace to
   * the last, so `{answer}{your own example}` was one unparseable string
   * and a perfectly good answer was reported as absent.
   */
  const response = normalizeModelReply(
    '{"thought":"t","kind":"WAIT"}\n\nFor reference, the format is:\n{"thought":"...","decision":{"type":"WAIT"}}',
  );
  assert(response.payload !== undefined, 'the first object is taken');
  assertEqual(response.payload!['kind'], 'WAIT', 'not the concatenation of both');
});

test('braces inside string values do not unbalance the extraction', () => {
  const response = normalizeModelReply(
    '{"thought":"a level {1.1250} matters","kind":"WAIT"}',
  );
  assert(response.payload !== undefined, 'a brace in prose is not a delimiter');
  assert(
    String(response.payload!['thought']).includes('{1.1250}'),
    'and the value is intact',
  );
});

test('broken JSON is reported as malformed, not as silence', () => {
  const response = normalizeModelReply('{"thought":"t", "kind": }');
  assert(response.malformed === true, 'malformed JSON is its own outcome');
  assert(response.payload === undefined, 'and no payload is invented');
});

test('prose with no JSON is reported as prose, not as malformed', () => {
  const response = normalizeModelReply('I think EUR/USD looks interesting but I am not sure.');
  assert(response.malformed !== true, 'prose is not a transport failure');
  assert(response.payload === undefined, 'and there is nothing to parse');
});

test('a JSON array is not accepted as an object', () => {
  const response = normalizeModelReply('[{"thought":"t"}]');
  assert(response.payload === undefined, 'an array is not the requested shape');
  assert(response.malformed === true, 'and it is not silently ignored');
});

test('a provider failure is surfaced as unavailable, not as an empty answer', async () => {
  installFetchStub('', { status: 401 });
  const response = await new OpenRouterAgentModel().run(request({ contract: 'INVESTIGATION' }));

  assert(response.unavailable !== undefined, 'the model was not consulted');
  assertEqual(response.unavailable?.code, 'INVALID_KEY', 'and the cause is named');
  assert(
    !JSON.stringify(response).includes('sk-or-v1'),
    'no credential material appears in the response the runtime records',
  );
});

test('the API key travels in the Authorization header and nowhere else', async () => {
  installFetchStub(`{"thought":"ok"}`);
  await new OpenRouterAgentModel().run(request());

  const call = lastCall();
  assert(call, 'a request was captured');
  const key = call.headers.Authorization?.replace('Bearer ', '') ?? '';
  assert(key.startsWith('sk-or-v1-'), 'the key is in the Authorization header');
  assert(
    !call.body.includes(key),
    'and the raw key appears nowhere in the request body',
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runAgentModelTests(): Promise<void> {
  const { installLocalStorage } = await import('./testStorage');
  const uninstall = installLocalStorage();
  restoreFetch();

  /*
   * The provider reads its configuration when it is constructed, which
   * happens at module import — before this function runs. So the key is
   * written through the provider's own API rather than into storage and
   * hoped for. A shape, not a credential: `fetch` is stubbed throughout, so
   * nothing is sent anywhere.
   */
  const before = openRouterProvider.getConfig();
  openRouterProvider.saveConfig({ apiKey: 'sk-or-v1-testkeytestkeytestkey', model: 'openrouter/free' });

  let passed = 0;
  const failures: Array<{ name: string; detail: string }> = [];

  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`pass  ${name}`);
        passed += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`FAIL  ${name}\n      ${detail}`);
        failures.push({ name, detail });
      }
    }
  } finally {
    openRouterProvider.saveConfig({
      apiKey: before.apiKey,
      model: before.model,
    });
    restoreFetch();
    uninstall();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} agent model test(s) failed.`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
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
