/**
 * Tests for the OpenRouter boundary.
 *
 * The credential here is the user's own, pasted into their own browser,
 * and it is sent from their own browser. That design is deliberate — the
 * alternative is a server that holds other people's keys — and it means
 * the app's job is narrow but non-negotiable: the key goes to OpenRouter
 * and nowhere else, and no provider payload comes back into a channel that
 * treats text as the model's own words.
 *
 * These tests defend the failure modes, not the happy path.
 */

import {
  KEY_REQUIRED,
  OpenRouterProvider,
  REQUEST_FAILED,
  looksLikeApiKey,
  redactSecrets,
} from './provider';
import { chatCompletionsUrl, modelsUrl, openRouterUrl, OPENROUTER_BASE_URL } from './endpoints';
import {
  classifyProviderFailure,
  isCredentialFailure,
  isModelFailure,
  isProviderOutageCode,
} from './errors';
import {
  DEFAULT_MODEL_ID,
  FALLBACK_MODELS,
  RECOMMENDED_MODEL_IDS,
  clearModelCatalogueCache,
  filterModels,
  isModelAvailable,
  normaliseCatalogue,
  normaliseModel,
  pickDefaultModel,
  recommendedModels,
  supportsAgentReasoning,
} from './catalogue';
import type { AIProviderErrorCode, OpenRouterModel } from './types';

/** The exact URL a request must resolve to. */
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

/** A key-shaped string that is not a real credential. */
const FAKE_KEY = 'sk-or-v1-test0000000000000000notreal';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A 200 carrying JSON, the shape every happy-path response arrives in. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

/**
 * Runs one chat call against a fake fetch and returns both what the caller
 * was told and what actually went out.
 *
 * Both halves matter. Asserting only on the provider's response would let a
 * test pass while the credential quietly moved from the header into the
 * body; asserting only on the request would not notice that a provider
 * error page was handed back as the model's words.
 */
async function callWithFetch(
  provider: OpenRouterProvider,
  responder: Responder,
): Promise<{
  response: Awaited<ReturnType<OpenRouterProvider['chat']>>;
  calls: CapturedRequest[];
}> {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];

  globalThis.fetch = (async (input: unknown, init: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: new Headers((init?.headers ?? {}) as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return responder(url, init ?? {});
  }) as typeof fetch;

  try {
    const response = await provider.chat([{ role: 'user', content: 'hello' }]);
    return { response, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** A localStorage stand-in, so the tests do not touch the real one. */
function withStorage(body: () => void | Promise<void>): Promise<void> {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });

  /*
   * Awaited before the stand-in is removed. A synchronous restore would
   * swap the real localStorage back in underneath an async test body,
   * which is how a test ends up asserting against storage it set up.
   */
  return Promise.resolve()
    .then(body)
    .finally(() => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    });
}

const okResponse = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/** --- The credential is sent to OpenRouter and nowhere else ---------------------- */

async function runRequestShapeTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY, model: 'openai/gpt-4o' });

    const { response, calls } = await callWithFetch(provider, () => okResponse('WAIT'));

    assert(response.content === 'WAIT', 'a successful call returns the model content');
    assert(calls.length === 1, 'exactly one request is made');
    /*
     * Exactly, not "starts with". The 404 this build shipped with was a
     * duplicated path, and a prefix assertion is precisely what let it
     * through: `.../chat/completions/chat/completions` starts with the
     * right string.
     */
    assert(calls[0].url === CHAT_URL, `the request goes to exactly ${CHAT_URL}`);
    assert(
      calls[0].headers.get('Authorization') === `Bearer ${FAKE_KEY}`,
      'the credential travels in the Authorization header, where OpenRouter expects it',
    );
    assert(
      calls[0].headers.get('Content-Type') === 'application/json',
      'the request declares JSON, as the endpoint requires',
    );
    assert(
      !calls[0].body.includes(FAKE_KEY),
      'the credential is never placed in the request body, where it could be logged',
    );
    assert(
      JSON.parse(calls[0].body).model === 'openai/gpt-4o',
      'the selected model is what is requested',
    );
  });
}

/** --- The URL is built in one place and cannot double up -------------------------- */

function runEndpointTest(): void {
  assert(OPENROUTER_BASE_URL === 'https://openrouter.ai/api/v1', 'the base is the documented one');
  assert(chatCompletionsUrl() === CHAT_URL, 'the chat URL is exactly the documented endpoint');
  assert(modelsUrl() === CATALOGUE_URL, 'the catalogue URL is exactly the documented endpoint');

  /*
   * The failure mode this exists to make impossible: a base that already
   * carries the path, with the path appended again.
   */
  assert(
    openRouterUrl('/chat/completions', 'https://openrouter.ai/api/v1/chat/completions') === CHAT_URL,
    'a base that already ends in the full path does not produce a doubled path',
  );
  assert(
    openRouterUrl('chat/completions', 'https://openrouter.ai/api/v1/') === CHAT_URL,
    'a trailing slash does not produce a doubled slash',
  );
  assert(
    openRouterUrl('/api/v1/chat/completions', OPENROUTER_BASE_URL) === CHAT_URL,
    'a path that already carries the version does not produce /api/v1/api/v1',
  );
  assert(
    chatCompletionsUrl().startsWith('https://'),
    'the URL is absolute: a relative one would be resolved against the dev server',
  );
}

/** --- A missing key is reported without a request -------------------------------- */

async function runMissingKeyTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();

    const { response, calls } = await callWithFetch(provider, () =>
      okResponse('should not happen'),
    );

    assert(calls.length === 0, 'no request is made without a key');
    assert(
      response.content === KEY_REQUIRED,
      'a missing key is reported through the sentinel the UI branches on',
    );
    assert(
      response.error?.code === 'KEY_REQUIRED',
      'a missing key is reported as a structured error',
    );
    assert(
      typeof response.error?.message === 'string' &&
        response.error.message.length > 0,
      'a missing key carries a message written for a person',
    );
  });
}

/**
 * Provider failure text does not travel as model output.
 *
 * This is the test that matters most. `content` is what the agent runtime
 * treats as the model's words: it is reasoned over and written to the
 * timeline. A provider error page echoed into `content` is indistinguishable
 * there from the model having said it.
 */
async function runNoProviderLeakageTest(): Promise<void> {
  const provider = new OpenRouterProvider();

  await withStorage(async () => {
    provider.saveConfig({ apiKey: FAKE_KEY });

    /*
     * A provider that reflects the credential back, which is the worst case
     * and entirely within a provider's rights to do.
     */
    const leakyBody = JSON.stringify({
      error: {
        message: `Invalid key: ${FAKE_KEY}. Check your credentials at https://x`,
        code: 401,
      },
    });

    const cases: Array<[number, string]> = [
      [401, leakyBody],
      [402, leakyBody],
      [429, leakyBody],
      [500, leakyBody],
      [400, leakyBody],
    ];

    for (const [status, body] of cases) {
      const { response } = await callWithFetch(provider, () => new Response(body, { status }));

      assert(
        !response.content.includes(FAKE_KEY),
        `status ${status}: the credential never appears in model content`,
      );
      assert(
        !response.content.includes('Invalid key'),
        `status ${status}: provider error text never appears in model content`,
      );
      assert(
        response.content === REQUEST_FAILED,
        `status ${status}: the failure is the bare sentinel`,
      );
      assert(
        typeof response.error?.code === 'string',
        `status ${status}: the failure is structured`,
      );
      assert(
        !JSON.stringify(response.error).includes(FAKE_KEY),
        `status ${status}: the structured error carries no credential`,
      );
      assert(
        typeof response.error?.status === 'number' && response.error.status === status,
        `status ${status}: the status is reported`,
      );
    }
  });
}

/** --- A network failure is a network failure ------------------------------------- */

async function runNetworkFailureTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    let response;
    try {
      response = await provider.chat([{ role: 'user', content: 'hello' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert(
      response.error?.code === 'NETWORK_ERROR',
      'a transport failure is reported as a network failure, not a provider rejection',
    );
    assert(
      !response.content.includes('Failed to fetch'),
      'a transport error message does not travel as model content',
    );
  });
}

/** --- A failure is described as the failure it is --------------------------------- */

/**
 * The mislabelling this replaces.
 *
 * Every 400, 404 and 422 became "the selected model may be unavailable for
 * this key", which sent users to change a key that was fine and left a
 * genuinely wrong endpoint looking like a model problem.
 */
async function runErrorClassificationTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY, model: 'openai/gpt-4o' });

    const cases: Array<[number, string | undefined, string]> = [
      [401, JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }), 'INVALID_KEY'],
      [402, JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }), 'OUT_OF_CREDITS'],
      [403, JSON.stringify({ error: { message: 'Forbidden', code: 403 } }), 'UNAUTHORIZED'],
      [404, JSON.stringify({ error: { message: 'Model "x/y" not found', code: 404 } }), 'MODEL_NOT_FOUND'],
      [404, JSON.stringify({ error: { message: 'No endpoints found for x/y', code: 404 } }), 'MODEL_UNAVAILABLE'],
      [429, JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }), 'RATE_LIMITED'],
      [400, JSON.stringify({ error: { message: 'Bad request', code: 400 } }), 'BAD_REQUEST'],
      [422, JSON.stringify({ error: { message: 'Unprocessable', code: 422 } }), 'BAD_REQUEST'],
      [500, 'upstream exploded', 'PROVIDER_ERROR'],
      [503, 'no providers configured', 'MODEL_UNAVAILABLE'],
      [418, '', 'UNKNOWN'],
    ];

    for (const [status, body, code] of cases) {
      const { response } = await callWithFetch(provider, () => new Response(body, { status }));

      assert(response.error?.code === code, `status ${status} is classified as ${code}`);
      assert(
        typeof response.error?.message === 'string' && response.error.message.length > 10,
        `status ${status} carries a message written for a person`,
      );
      assert(response.error?.status === status, `status ${status} is reported`);
    }

    /*
     * The specific mislabelling: a rejected key must never be described as
     * a model problem, and a wrong endpoint must never be described as
     * either.
     */
    const { response: unauthorised } = await callWithFetch(provider, () => new Response('', { status: 401 }));
    assert(
      !/model/i.test(unauthorised.error?.message ?? ''),
      'a rejected key is not described as a model problem',
    );
    assert(
      /API key/i.test(unauthorised.error?.message ?? ''),
      'a rejected key says so',
    );

    const { response: emptyBody } = await callWithFetch(provider, () => new Response('', { status: 404 }));
    assert(
      emptyBody.error?.code === 'ENDPOINT_NOT_FOUND',
      'a 404 with nothing model-shaped in it is an endpoint problem, not a model problem',
    );
    assert(
      !/unavailable for this key/i.test(emptyBody.error?.message ?? ''),
      'the old blanket message is gone',
    );

    assert(
      isCredentialFailure(unauthorised.error!),
      'a key failure is recognised as something settings fixes',
    );
    assert(
      !isModelFailure(emptyBody.error!) && !isCredentialFailure(emptyBody.error!),
      'a wrong endpoint is neither a key problem nor a model problem',
    );
    assert(
      isModelFailure(classifyProviderFailure(404, JSON.stringify({ error: { message: 'Model "x/y" not found' } }))),
      'a model failure is recognised as something the picker fixes',
    );
  });

  /*
   * The body is a signal, never text. A provider that reflects the
   * credential back must not be able to put it in front of a user.
   */
  const leaked = classifyProviderFailure(
    401,
    JSON.stringify({ error: { message: `key ${FAKE_KEY} is invalid` } }),
    'openai/gpt-4o',
  );
  assert(
    !JSON.stringify(leaked).includes(FAKE_KEY),
    'classification never carries provider payload, so it cannot leak the credential',
  );
}

/** --- An empty response is its own case ------------------------------------------ */

async function runEmptyResponseTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY });

    const { response } = await callWithFetch(provider, () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), {
        status: 200,
      }),
    );

    assert(
      response.error?.code === 'EMPTY_RESPONSE',
      'an empty completion is reported as an empty response',
    );

    // A body that is not the shape expected must not be read as content.
    const { response: malformed } = await callWithFetch(provider, () =>
      new Response('<html>gateway</html>', { status: 200 }),
    );

    /*
     * Unreadable rather than empty, and deliberately so: the provider answered
     * and this adapter could not parse the answer, which is a different event
     * from a model that returned nothing — and it is not an outage. The
     * property this test has always protected is the one that still matters
     * below it: the body never becomes model content.
     */
    assert(
      malformed.error?.code === 'UNREADABLE_RESPONSE',
      'a non-JSON body is reported as unreadable, not as an empty answer',
    );
    assert(
      !malformed.content.includes('gateway'),
      'a non-JSON body does not travel as model content',
    );
  });
}

/** --- Response shapes a provider can legitimately return ----------------------- */

/**
 * A 200 that arrives in a shape this adapter did not expect used to be
 * classified as an empty response, which is an availability code — so a
 * perfectly good answer, sent as parts rather than a string, was treated as an
 * outage and spent retries. Each case below is pinned to the specific code it
 * now produces, because the specific code is what keeps it off the outage path.
 */
async function runResponseShapeTests(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY });

    // A: the ordinary string answer is unaffected.
    const string = await callWithFetch(provider, () =>
      jsonResponse({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }),
    );
    assert(string.response.error === undefined, 'a string answer is not a failure');
    assertEqual(string.response.content, 'hello', 'and the text is passed through');

    // B: the same answer as parts, which is what was being thrown away.
    const parts = await callWithFetch(provider, () =>
      jsonResponse({
        choices: [{ message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] } }],
      }),
    );
    assert(parts.response.error === undefined, 'array-of-parts content is an answer, not a failure');
    assertEqual(parts.response.content, 'hello world', 'text parts are joined in order');

    // C: null content is the provider declining to answer, not empty text.
    const nullContent = await callWithFetch(provider, () =>
      jsonResponse({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }),
    );
    assertEqual(nullContent.response.error?.code, 'EMPTY_RESPONSE', 'null content is reported as no text');
    assert(
      nullContent.response.content !== 'null' && nullContent.response.content !== '',
      'null never becomes model content',
    );

    // D: an empty choices array means no answer was offered, which is specific.
    const noChoices = await callWithFetch(provider, () => jsonResponse({ choices: [] }));
    assertEqual(noChoices.response.error?.code, 'NO_CHOICES', 'an empty choices array is named for what it is');
    assertEqual(noChoices.response.error?.status, 200, 'and it is still a 200, not an HTTP failure');

    // E: a filter is the provider declining on purpose, which is not emptiness.
    const filtered = await callWithFetch(provider, () =>
      jsonResponse({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }),
    );
    assertEqual(filtered.response.error?.code, 'CONTENT_FILTERED', 'a content-filtered answer is named as filtered');

    // F: a 200 the adapter cannot read at all.
    const unreadable = await callWithFetch(provider, () => jsonResponse({ result: 'surprise' }));
    assertEqual(unreadable.response.error?.code, 'UNREADABLE_RESPONSE', 'an unknown envelope is unreadable');
    const notJson = await callWithFetch(provider, () => new Response('<html>ok</html>', { status: 200 }));
    assertEqual(notJson.response.error?.code, 'UNREADABLE_RESPONSE', 'a non-JSON 200 is unreadable');

    /*
     * G: none of the above is an outage, which is the whole behavioural point.
     * These are the codes the availability and retry paths key on, so a
     * response that arrived and could not be read must not carry one.
     */
    const shapeCodes: AIProviderErrorCode[] = [
      'EMPTY_RESPONSE',
      'NO_CHOICES',
      'CONTENT_FILTERED',
      'UNREADABLE_RESPONSE',
    ];
    for (const code of shapeCodes) {
      assert(
        !isProviderOutageCode(code),
        `${code} is a received-but-unusable response, not an outage`,
      );
    }

    // H: a genuine outage still is one. Nothing about this narrows availability.
    assert(isProviderOutageCode('NETWORK_ERROR'), 'a network failure is still an outage');
    assert(isProviderOutageCode('PROVIDER_ERROR'), 'a 5xx is still an outage');
    assert(isProviderOutageCode('MODEL_UNAVAILABLE'), 'no available provider is still an outage');
    assert(isProviderOutageCode('RATE_LIMITED'), 'rate limiting is still an outage');
  });
}

/** --- Persisted configuration is validated --------------------------------------- */

async function runConfigValidationTest(): Promise<void> {
  await withStorage(() => {
    /*
     * A stale or hand-edited record. A blind spread would put an object
     * where a string belongs, and `hasApiKey` would read that object as a
     * perfectly good key.
     */
    localStorage.setItem(
      'tradingvibe_openrouter_config',
      JSON.stringify({
        apiKey: { leaked: true },
        model: 42,
        siteUrl: ['not', 'a', 'url'],
      }),
    );

    const provider = new OpenRouterProvider();
    const config = provider.getConfig();

    assert(
      config.apiKey === '',
      'a non-string key is discarded rather than adopted',
    );
    assert(
      typeof config.model === 'string' && config.model.length > 0,
      'a non-string model falls back to the default',
    );
    assert(
      typeof config.siteUrl === 'string',
      'a non-string site url is discarded',
    );
    assert(
      provider.hasApiKey() === false,
      'an object-valued key does not count as a key',
    );
  });

  await withStorage(() => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY, model: '  openai/gpt-4o  ' });

    const config = provider.getConfig();
    assert(config.model === 'openai/gpt-4o', 'a model is trimmed on save');
    assert(provider.hasApiKey(), 'a real-looking key is accepted');

    provider.clearApiKey();
    assert(
      provider.hasApiKey() === false,
      'clearing the key removes it from the running configuration',
    );
    assert(
      localStorage.getItem('tradingvibe_openrouter_config') === null,
      'clearing the key removes it from disk',
    );
  });

  // Shape, not length.
  assert(looksLikeApiKey(FAKE_KEY), 'a key-shaped value is accepted');
  assert(!looksLikeApiKey('short'), 'a short value is rejected');
  assert(!looksLikeApiKey('this is my openrouter key pasted here'), 'a sentence is rejected');
  assert(!looksLikeApiKey('sk-or-v1-has spaces in it'), 'a value with whitespace is rejected');
  assert(!looksLikeApiKey(undefined), 'undefined is not a key');
  assert(!looksLikeApiKey(12345), 'a number is not a key');
  assert(!looksLikeApiKey({}), 'an object is not a key');
}

/** --- Redaction ------------------------------------------------------------------- */

function runRedactionTest(): void {
  assert(
    redactSecrets(`key ${FAKE_KEY} failed`).includes('[redacted]'),
    'an OpenRouter key is redacted',
  );
  assert(
    redactSecrets('Authorization: Bearer abcdefghijklmnopqrst').includes('[redacted]'),
    'a bearer token is redacted',
  );
  assert(
    redactSecrets('sk-abcdefghijklmnopqrstuvwxyz').includes('[redacted]'),
    'a legacy-format key is redacted',
  );
  assert(
    redactSecrets(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    ).includes('[redacted]'),
    'a JWT is redacted',
  );
  assert(
    redactSecrets('rate limited, try again in 30 seconds') ===
      'rate limited, try again in 30 seconds',
    'ordinary text is left alone',
  );
}

/** --- The catalogue is discovered, filtered and cached --------------------------- */

const providerPayload = {
  data: [
    {
      id: 'nvidia/nemotron-3.5-lightning:free',
      name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
      description: 'A fast reasoning model.   With a doubled space.',
      context_length: 1_000_000,
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'structured_outputs', 'reasoning'],
    },
    {
      id: 'openai/gpt-4.1-mini',
      name: 'OpenAI: GPT-4.1 Mini',
      context_length: 1_047_576,
      architecture: { modality: 'text->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000004', completion: '0.0000016' },
      supported_parameters: ['tools', 'response_format'],
    },
    {
      // Not a chat model: reads text, writes embeddings.
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI: Text Embedding 3 Small',
      context_length: 8_191,
      architecture: { modality: 'text->embedding', input_modalities: ['text'], output_modalities: ['embedding'] },
      pricing: { prompt: '0.00000002', completion: '0' },
      supported_parameters: [],
    },
    {
      // Image generation: no text output at all.
      id: 'stability/sdxl',
      name: 'Stable Diffusion XL',
      context_length: 77,
      architecture: { modality: 'text->image', input_modalities: ['text'], output_modalities: ['image'] },
      pricing: { prompt: '0.000003', completion: '0' },
      supported_parameters: [],
    },
    {
      // No context length: nothing honest can be displayed about it.
      id: 'ghost/model-without-context',
      name: 'Ghost',
      context_length: 0,
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000001', completion: '0.000002' },
      supported_parameters: ['tools'],
    },
  ],
};

function runCatalogueTest(): void {
  const models = normaliseCatalogue(providerPayload);

  assert(models.length === 2, 'only text-in/text-out models with a context length survive');
  assert(
    !models.some((model) => model.id.includes('embedding')),
    'an embedding model is not offered as a model to talk to',
  );
  assert(
    !models.some((model) => model.id.includes('sdxl')),
    'an image model is not offered as a model to talk to',
  );

  const free = models.find((model) => model.id === 'nvidia/nemotron-3.5-lightning:free');
  assert(free !== undefined, 'a free model is kept');
  assert(free!.isFree, 'a zero-priced model is marked free');
  assert(free!.name === 'NVIDIA: Nemotron 3.5 Lightning', 'the "(free)" suffix is not part of the name');
  assert(free!.provider === 'NVIDIA', 'the provider is readable, not a routing slug');
  assert(free!.supportsTools && free!.supportsStructuredOutputs, 'capabilities come from the metadata');
  assert(free!.supportsReasoning, 'reasoning support is read from the metadata');
  assert(!free!.supportsVision, 'a text-only model is not advertised as seeing images');
  assert(
    free!.description === 'A fast reasoning model. With a doubled space.',
    'a description is collapsed to one line',
  );
  assert(supportsAgentReasoning(free!), 'a free tool-using model is usable for GOAT reasoning');

  const paid = models.find((model) => model.id === 'openai/gpt-4.1-mini');
  assert(paid !== undefined && !paid!.isFree, 'a priced model is not marked free');
  assert(paid!.supportsVision, 'image input is read from the input modalities');

  // Junk in, nothing out. Never a thrown parse of someone else's payload.
  assert(normaliseCatalogue(null).length === 0, 'a non-object payload yields no models');
  assert(normaliseCatalogue({ data: 'nope' }).length === 0, 'a non-array data field yields no models');
  assert(normaliseModel(undefined) === undefined, 'a non-model entry is skipped');
}

/** --- Selecting a model from what is actually on offer --------------------------- */

function runSelectionTest(): void {
  const models = normaliseCatalogue(providerPayload);

  const recommended = recommendedModels(models);
  assert(
    recommended.every((model) => isModelAvailable(models, model.id)),
    'a recommended model is only offered when it is in the catalogue',
  );

  const defaultModel = pickDefaultModel(models);
  assert(isModelAvailable(models, defaultModel), 'the default is always a model that exists');

  const freeOnly = filterModels(models, { freeOnly: true });
  assert(freeOnly.every((model) => model.isFree), 'the free filter returns only free models');

  const toolsOnly = filterModels(models, { toolsOnly: true });
  assert(toolsOnly.length === 2, 'the tool filter returns only models that can call tools');

  const longContext = filterModels(models, { longContextOnly: true });
  assert(longContext.length === 2, 'the long-context filter uses a real threshold');

  const searched = filterModels(models, { query: 'nemotron' });
  assert(searched.length === 1, 'search matches on the human name');
  assert(filterModels(models, { query: 'nvidia' }).length === 1, 'search matches on the provider');
  assert(filterModels(models, { query: 'gpt-4.1' }).length === 1, 'search matches on the id');
  assert(filterModels(models, { query: 'nothing at all' }).length === 0, 'a search with no hits is empty');

  assert(
    pickDefaultModel([]) === DEFAULT_MODEL_ID,
    'with nothing discovered, the shipped default is the answer',
  );
  assert(
    FALLBACK_MODELS.length <= 12,
    'the offline fallback stays small; it is not a second model picker',
  );
  assert(
    FALLBACK_MODELS.every((model) => supportsAgentReasoning(model)),
    'every fallback model can carry the request format the runtime sends',
  );
  assert(
    RECOMMENDED_MODEL_IDS.includes(DEFAULT_MODEL_ID),
    'the shipped default is one of the recommended models',
  );
}

/** --- The provider recovers a persisted model that no longer exists --------------- */

async function runModelRecoveryTest(): Promise<void> {
  await withStorage(async () => {
    clearModelCatalogueCache();
    const provider = new OpenRouterProvider();

    // What this build shipped with, and what OpenRouter no longer lists.
    provider.saveConfig({ apiKey: FAKE_KEY, model: 'inclusionai/ling-3.0-flash-fin:free' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input) === CATALOGUE_URL) {
        return new Response(JSON.stringify(providerPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return okResponse('ready');
    }) as typeof fetch;

    try {
      assert(
        (await provider.isSelectedModelAvailable()) === false,
        'a retired model is reported as unavailable rather than quietly accepted',
      );

      const reconciled = await provider.reconcileModel();
      assert(
        isModelAvailable(normaliseCatalogue(providerPayload), reconciled),
        'reconciling moves a retired selection onto a model that exists',
      );
      assert(
        provider.getConfig().model === reconciled,
        'the replacement is persisted, so the next request does not 404 again',
      );

      const catalogue = await provider.listModels();
      assert(catalogue.models.length === 2, 'the catalogue is normalised from the API payload');
      assert(catalogue.source === 'api', 'the catalogue reports that it came from the API');
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCatalogueCache();
    }
  });
}

/** --- A catalogue failure does not make the app unusable ------------------------- */

async function runCatalogueFallbackTest(): Promise<void> {
  await withStorage(async () => {
    clearModelCatalogueCache();
    const provider = new OpenRouterProvider();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    try {
      const catalogue = await provider.listModels();
      assert(catalogue.source === 'fallback', 'an unreachable catalogue falls back');
      assert(catalogue.models.length > 0, 'the fallback still offers models to choose from');
      assert(
        catalogue.error !== undefined,
        'the fallback is reported, so the UI can say the list is not live',
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCatalogueCache();
    }
  });
}

/** --- One request, however many components ask for the catalogue ------------------ */

async function runCatalogueDedupeTest(): Promise<void> {
  await withStorage(async () => {
    clearModelCatalogueCache();
    const provider = new OpenRouterProvider();

    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input) !== CATALOGUE_URL) throw new Error('unexpected request');
      calls += 1;
      return new Response(JSON.stringify(providerPayload), { status: 200 });
    }) as typeof fetch;

    try {
      await Promise.all([provider.listModels(), provider.listModels(), provider.listModels()]);
      assert(calls === 1, 'three callers make one catalogue request');
      await provider.listModels();
      assert(calls === 1, 'a second read is served from the cache');
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCatalogueCache();
    }
  });
}

/** --- A model that answered is remembered ----------------------------------------- */

async function runLastWorkingModelTest(): Promise<void> {
  await withStorage(async () => {
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: FAKE_KEY, model: 'openai/gpt-4o' });

    const { response } = await callWithFetch(provider, () => okResponse('ready'));
    assert(response.content === 'ready', 'the test request answered');
    assert(
      provider.getConfig().lastWorkingModel === 'openai/gpt-4o',
      'a model that answered is remembered as working for this key',
    );
  });
}

if (import.meta.main) {
  await runRequestShapeTest();
  runEndpointTest();
  await runMissingKeyTest();
  await runNoProviderLeakageTest();
  await runNetworkFailureTest();
  await runErrorClassificationTest();
  await runEmptyResponseTest();
  await runResponseShapeTests();
  await runConfigValidationTest();
  runRedactionTest();
  runCatalogueTest();
  runSelectionTest();
  await runModelRecoveryTest();
  await runCatalogueFallbackTest();
  await runCatalogueDedupeTest();
  await runLastWorkingModelTest();
  console.log('OpenRouter endpoint, credential, catalogue and error tests passed.');
}