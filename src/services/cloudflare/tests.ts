/**
 * Tests for the browser's watcher client.
 *
 * The point of these tests is the *reporting*. Everything about the durable
 * runtime tier is worthless if a browser cannot tell the difference between
 * "registered and running" and "I asked and it failed", so most of what follows
 * is about failures — how they surface, and what they are not allowed to become.
 *
 * `bun src/services/cloudflare/tests.ts`
 */

import {
  WatchersClient,
  WatcherClientError,
  buildWatcherConfig,
  createWatchersClient,
  watchersEndpointFromEnv,
} from './watchersClient';
import type { WatcherConfig } from '../../../watchers/src/contract';

let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

/**
 * Declared as an assertion function so `assert('config' in built, …)` narrows the
 * union below it — without that, every check of a tagged result has to be
 * followed by a cast or a cast-free non-null assertion, which is exactly the doubt
 * the assertion is there to remove.
 */
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

/** A fetch that records what it was asked for and answers with a script. */
function scriptedFetch(
  responder: (url: string, init: RequestInit | undefined) => { status?: number; body?: unknown; text?: string } | Promise<{ status?: number; body?: unknown; text?: string }>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = await responder(url, init);
    if (answer.text !== undefined) {
      return new Response(answer.text, { status: answer.status ?? 200 });
    }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function validConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    configVersion: 1,
    name: 'GOLD entry',
    market: 'xyz:GOLD',
    conditionTree: { kind: 'leaf', metric: 'price', op: '>' },
    minEvaluationIntervalMs: 3_600_000,
    cooldownMs: 900_000,
    maxWakesPerHour: 6,
    maxWakesPerDay: 48,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Configuration is the worker's contract, not a local invention
// ---------------------------------------------------------------------------

await test('a configuration the worker accepts is one this client accepts', () => {
  const built = buildWatcherConfig({
    name: 'GOLD entry',
    market: 'xyz:GOLD',
    conditionTree: { kind: 'leaf', metric: 'price', op: '>' },
    configVersion: 1,
  });
  assert('config' in built, 'it builds');
  // The shared validator is what makes this claim meaningful: if it were a copy,
  // this test would still pass while the worker refused the same configuration.
  assertEqual(built.config.market, 'xyz:GOLD', 'and it keeps the market');
  assert(built.config.minEvaluationIntervalMs >= 1_000, 'within the contract\'s floor');
});

await test('an impossible request is clamped to the contract, and the clamp is reported', () => {
  const built = buildWatcherConfig({
    name: 'GOLD entry',
    market: 'xyz:GOLD',
    conditionTree: { kind: 'leaf', metric: 'price', op: '>' },
    configVersion: 1,
    // A request for a 10ms evaluation loop and 1000 wakes an hour.
    desired: { minEvaluationIntervalMs: 10, maxWakesPerHour: 1_000 },
  });
  assert('config' in built, 'it still builds rather than failing');
  assertEqual(built.config.minEvaluationIntervalMs, 1_000, 'the interval is raised to the floor');
  assertEqual(built.config.maxWakesPerHour, 60, 'and the hourly wakes to the ceiling');

  assert(
    built.clamped.length === 2,
    `both adjustments are reported rather than applied silently (got ${built.clamped.length})`,
  );
  assert(
    built.clamped.some((note) => note.includes('10') && note.includes('1000')),
    'and the report names the number asked for and the number used',
  );
});

await test('a configuration with no name or no market is refused before any request', () => {
  const nameless = buildWatcherConfig({
    name: '  ',
    market: 'xyz:GOLD',
    conditionTree: {},
    configVersion: 1,
  });
  assert('problems' in nameless, 'a blank name is refused');
  assert(nameless.problems.length > 0, 'with something to say about it');
});

// ---------------------------------------------------------------------------
// 2. Identity
// ---------------------------------------------------------------------------

await test('requests carry a Firebase ID token, never a chosen user id', async () => {
  const { fetch: impl, calls } = scriptedFetch(() => ({ body: { watcherId: 'w_1' } }));
  const client = new WatchersClient({
    baseUrl: 'https://watchers.test',
    token: async () => 'a-real-firebase-token',
    fetch: impl,
  });

  await client.deploy({ goatId: 'g1', deploymentId: 'd1', config: validConfig() });

  const header = (calls[0].init?.headers ?? {}) as Record<string, string>;
  assertEqual(header['Authorization'], 'Bearer a-real-firebase-token', 'the token is presented');
  assert(
    !('X-User-Id' in header),
    'and no user id is asserted separately, because a caller must not be able to choose one',
  );
});

await test('with nobody signed in, nothing is sent at all', async () => {
  const { fetch: impl, calls } = scriptedFetch(() => ({ body: {} }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => null, fetch: impl });

  let thrown: unknown;
  try {
    await client.deploy({ goatId: 'g1', deploymentId: 'd1', config: validConfig() });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof WatcherClientError, 'it fails');
  assertEqual((thrown as WatcherClientError).code, 'NOT_SIGNED_IN', 'as an authentication problem');
  assertEqual(calls.length, 0, 'and no request is made — nothing to leak');
});

// ---------------------------------------------------------------------------
// 3. Failures are failures
// ---------------------------------------------------------------------------

await test('an expired session is reported as such, not as a server error', async () => {
  const { fetch: impl } = scriptedFetch(() => ({ status: 401, body: { error: 'UNAUTHENTICATED' } }));
  const client = new WatchersClient({
    baseUrl: 'https://watchers.test',
    token: async () => 'stale-token',
    fetch: impl,
  });
  let thrown: WatcherClientError | undefined;
  try {
    await client.list();
  } catch (error) {
    thrown = error as WatcherClientError;
  }
  assertEqual(thrown?.code, 'UNAUTHENTICATED', 'the caller can tell to re-authenticate');
});

await test('a rate limit is reported as a rate limit, with the status', async () => {
  const { fetch: impl } = scriptedFetch(() => ({ status: 429, body: { message: 'Too many requests.' } }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });
  let thrown: WatcherClientError | undefined;
  try {
    await client.list();
  } catch (error) {
    thrown = error as WatcherClientError;
  }
  assertEqual(thrown?.code, 'RATE_LIMITED', 'the code is specific');
  assertEqual(thrown?.status, 429, 'the status is kept');
  assertEqual(thrown?.message, 'Too many requests.', "and the worker's own wording is passed through");
});

await test('an unreachable service is a network failure, not a silent success', async () => {
  const impl = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });
  let thrown: WatcherClientError | undefined;
  try {
    await client.list();
  } catch (error) {
    thrown = error as WatcherClientError;
  }
  assertEqual(thrown?.code, 'NETWORK', 'reported as unreachable');
});

await test('a non-JSON body from the service is a server problem, not an empty success', async () => {
  // A captive portal or a proxy returning HTML is the realistic case. Treating it
  // as `{}` would report a watcher as deployed when nothing was deployed.
  const { fetch: impl } = scriptedFetch(() => ({ text: '<html>proxy error</html>', status: 200 }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });
  let thrown: WatcherClientError | undefined;
  try {
    await client.list();
  } catch (error) {
    thrown = error as WatcherClientError;
  }
  assertEqual(thrown?.code, 'BAD_RESPONSE', 'reported as a bad response');
});

await test('a refused configuration never costs a round trip or a rate-limit token', async () => {
  const { fetch: impl, calls } = scriptedFetch(() => ({ body: {} }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });

  let thrown: WatcherClientError | undefined;
  try {
    // A version of zero, which the contract requires to be a positive integer.
    await client.deploy({
      goatId: 'g1',
      deploymentId: 'd1',
      config: validConfig({ configVersion: 0 }),
    });
  } catch (error) {
    thrown = error as WatcherClientError;
  }
  assertEqual(thrown?.code, 'INVALID_CONFIG', 'refused locally');
  assertEqual(calls.length, 0, 'and nothing was sent');
});

// ---------------------------------------------------------------------------
// 4. The happy path, and what it returns
// ---------------------------------------------------------------------------

await test('deploying posts the worker\'s own deploy shape', async () => {
  const { fetch: impl, calls } = scriptedFetch(() => ({
    body: { watcherId: 'w_abc', status: 'RUNNING', configVersion: 1, pendingWakes: 0 },
  }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });

  const summary = await client.deploy({ goatId: 'g1', deploymentId: 'd1', config: validConfig() });

  assertEqual(calls[0].url, 'https://watchers.test/watchers', 'posted to the collection');
  assertEqual(calls[0].init?.method, 'POST', 'as a POST');
  const body = JSON.parse(String(calls[0].init?.body));
  assertEqual(body.goatId, 'g1', 'with the GOAT');
  assertEqual(body.deploymentId, 'd1', 'the deployment');
  assertEqual(body.config.configVersion, 1, 'and the configuration');
  assertEqual(summary.watcherId, 'w_abc', 'and the worker\'s watcher id is returned');
});

await test('a watcher id is URL-encoded, so an odd id cannot become a different route', async () => {
  const { fetch: impl, calls } = scriptedFetch(() => ({ body: {} }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });
  await client.status('w_../../admin');
  assert(!calls[0].url.includes('/../'), 'no path traversal survives into the URL');
});

await test('an empty watcher list is an empty list, not a failure', async () => {
  const { fetch: impl } = scriptedFetch(() => ({ body: { watchers: [] } }));
  const client = new WatchersClient({ baseUrl: 'https://watchers.test', token: async () => 't', fetch: impl });
  assertEqual((await client.list()).length, 0, 'a user with no watchers has zero');
});

// ---------------------------------------------------------------------------
// 5. Configuration
// ---------------------------------------------------------------------------

await test('with no endpoint configured, there is no client and a stated reason', () => {
  const missing = watchersEndpointFromEnv({});
  assert('unavailable' in missing, 'no client is built');
  assert(missing.unavailable.includes('VITE_WATCHERS_URL'), 'the reason names the setting');
  assert(
    missing.unavailable.includes('survives'),
    'and says what is lost, rather than only what is missing',
  );

  const built = createWatchersClient({}, async () => null);
  assert('unavailable' in built, 'the factory refuses the same way');
});

await test('a trailing slash in the endpoint does not double up in a URL', async () => {
  // Constructed directly rather than through the factory, because the fix belongs
  // to the client: any caller passing a configured environment value would hit it.
  const { fetch: impl, calls } = scriptedFetch(() => ({ body: { watchers: [] } }));
  const client = new WatchersClient({
    baseUrl: 'https://watchers.test/',
    token: async () => 't',
    fetch: impl,
  });
  await client.list();
  assertEqual(calls[0].url, 'https://watchers.test/watchers', 'the path is clean');

  const built = createWatchersClient({ VITE_WATCHERS_URL: 'https://watchers.test//' }, async () => 't');
  assert('client' in built, 'and the factory accepts one');
});

await test('health is a yes or no, never an exception', async () => {
  const down = new WatchersClient({
    baseUrl: 'https://watchers.test',
    token: async () => 't',
    fetch: (async () => {
      throw new Error('unreachable');
    }) as typeof fetch,
  });
  assertEqual(await down.healthy(), false, 'an unreachable service is reported as unhealthy');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} watcher client test(s) failed.`);
}