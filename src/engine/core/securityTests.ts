/**
 * Security boundary tests.
 *
 * These are the tests that have to exist before a real API key is
 * introduced, because they fail *quietly* otherwise. A secret that
 * reaches a log is not a visible failure; it is a compromise discovered
 * later, if at all.
 *
 * The claims under test:
 *
 *  1. A secret never appears in an error message, a log line, or anything
 *     the browser can read.
 *  2. A credential belongs to one user, and asking for someone else's
 *     gives exactly the same answer as asking for one that does not
 *     exist, so it is not an enumeration oracle.
 *  3. The browser learns a status, never a secret.
 *  4. LIVE cannot be reached by configuration alone.
 *
 * Most assertions are about *absence*, which is the hard kind: a test
 * that checks a positive path proves nothing about a leak.
 */

import { readFileSync } from 'node:fs';
import {
  REDACTED,
  TradingGOATsError,
  authError,
  authorizationError,
  classifyError,
  configError,
  executionError,
  internalError,
  marketDataError,
  networkError,
  policyRejection,
  rateLimitError,
  redact,
  redactValue,
  riskRejection,
  timeoutError,
  watcherError,
} from './errors';
import { InMemoryCredentialStore, assertNoSecrets, type CredentialStatusReport } from './credentials';
import { evaluationIdFor, idempotencyKeyFor, Logger, wakeIdFor } from './logger';
import { assertExecutable, type OrderRequest } from './execution';

/* ------------------------------------------------------------------ *
 * Harness. The root project runs on Bun with no test framework, so this
 * uses the same shape as the other suites.
 * ------------------------------------------------------------------ */

interface Result { name: string; ok: boolean; detail?: string }
const results: Result[] = [];
const queue: Array<{ name: string; run: () => void | Promise<void> }> = [];
let currentGroup = '';

function group(name: string): void { currentGroup = name; }
function check(name: string, run: () => void | Promise<void>): void {
  queue.push({ name: `${currentGroup} › ${name}`, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertNot(value: unknown, message: string): void {
  if (value) throw new Error(message);
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(`${message} (missing "${needle}")`);
}

function assertLacks(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) throw new Error(`${message} (found "${needle}")`);
}

async function assertRejects(run: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(pattern.test((error as Error).message), `${message} (got: ${(error as Error).message})`);
    return;
  }
  throw new Error(message);
}

function assertDoesNotThrow(run: () => void, message: string): void {
  try {
    run();
  } catch (error) {
    throw new Error(`${message} (threw: ${(error as Error).message})`);
  }
}

/* ================================================================== *
 * Redaction
 * ================================================================== */

group('redaction');

check('removes a private key block', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nk3DJvtH\n-----END PRIVATE KEY-----';
  assertLacks(redact(`failed with key ${pem} here`), 'MIIEvQIBADANBg', 'a PEM body survived redaction');
  assertContains(redact(pem), REDACTED, 'the PEM was not replaced');
});

check('removes a 0x-prefixed 32-byte key', () => {
  const key = '0x' + 'a'.repeat(64);
  assertLacks(redact(`key=${key}`), 'a'.repeat(64), 'a hex private key survived redaction');
});

check('removes labelled secrets however they are spelled', () => {
  for (const label of ['api_key', 'apiKey', 'API-KEY', 'secret', 'privateKey', 'passphrase', 'seed', 'mnemonic']) {
    assertLacks(redact(`${label}="supersecretvalue"`), 'supersecretvalue', `a ${label} survived redaction`);
  }
});

check('removes an authorization header', () => {
  assertLacks(redact('Authorization: Bearer abcdefghijklmnop'), 'abcdefghijklmnop', 'a bearer token survived');
});

check('removes a secret from a nested value while keeping the context', () => {
  const payload = {
    order: { symbol: 'Gold', apiKey: 'live_key_123456', nested: { privateKey: 'deadbeef' } },
    note: 'connect with api_key=abcdef123456',
  };
  const redacted = JSON.stringify(redactValue(payload));
  assertLacks(redacted, 'live_key_123456', 'a nested api key survived');
  assertLacks(redacted, 'deadbeef', 'a nested private key survived');
  // Non-secret context is preserved, or the log is useless.
  assertContains(redacted, 'Gold', 'useful context was destroyed by redaction');
});

check('refuses to serialise a secret-shaped payload at all', () => {
  const report = {
    provider: 'hyperliquid', label: 'Main', status: 'VERIFIED', lastVerifiedAt: 1, createdAt: 1,
    // A field a future edit might add, forced in to prove the guard works.
    ...({ apiKey: 'live_123' } as unknown as Record<string, never>),
  } as CredentialStatusReport;
  let threw = false;
  try {
    assertNoSecrets(report);
  } catch {
    threw = true;
  }
  assert(threw, 'assertNoSecrets let a payload containing apiKey through');
});

check('allows an ordinary status report through', () => {
  const report: CredentialStatusReport = {
    provider: 'hyperliquid', label: 'Main', status: 'VERIFIED', lastVerifiedAt: 1, createdAt: 1,
  };
  assertDoesNotThrow(() => assertNoSecrets(report), 'a legitimate status report was refused');
  assertDoesNotThrow(
    () => assertNoSecrets({ watchers: [{ id: 'w1', health: 'HEALTHY' }] }),
    'an ordinary API response shape was refused',
  );
});

/* ================================================================== *
 * Error taxonomy
 * ================================================================== */

group('error taxonomy');

check('requires a category at construction', () => {
  // Every constructor names one, so a throw site cannot forget.
  const categories = [
    configError('x').category, marketDataError('x').category, policyRejection('x').category,
    riskRejection('x').category, authError('x').category, executionError('x').category,
    rateLimitError('x').category, timeoutError('x').category, networkError('x').category,
    watcherError('x').category, authorizationError('x').category, internalError('x').category,
  ];
  assert(categories.every(Boolean), 'a constructor produced no category');
  assert(categories.includes('AUTHORIZATION_ERROR'), 'the authorisation category is missing');
  assert(categories.includes('TIMEOUT'), 'the timeout category is missing');
  assert(new Set(categories).size === categories.length, 'two constructors share a category');
});

check('marks refusals as terminal and transport failures as retryable', () => {
  // A retry of a refusal is refused again, and retrying looks like an
  // attempt to force something through.
  assert(policyRejection('x').terminal, 'a policy refusal is not terminal');
  assert(riskRejection('x').terminal, 'a risk refusal is not terminal');
  assert(authorizationError('x').terminal, 'an authorisation refusal is not terminal');
  assert(networkError('x').retryable, 'a network failure is not retryable');
  assert(timeoutError('x').retryable, 'a timeout is not retryable');
  // The two properties never overlap.
  assertNot(networkError('x').terminal, 'a network failure was marked terminal');
  assertNot(policyRejection('x').retryable, 'a refusal was marked retryable');
});

check('classifies an untyped error rather than assuming it is a rate limit', () => {
  const cases: Array<[Error, string]> = [
    [new Error('fetch failed'), 'NETWORK_ERROR'],
    [new Error('The operation was aborted'), 'TIMEOUT'],
    [new Error('HTTP 429 Too Many Requests'), 'RATE_LIMIT'],
    [new Error('401 unauthorized'), 'AUTH_ERROR'],
    // Unrecognised is INTERNAL_ERROR, which is deliberately the noisiest
    // category: an unclassified failure should be visible.
    [new Error('something odd'), 'INTERNAL_ERROR'],
  ];
  for (const [error, expected] of cases) {
    const actual = classifyError(error).category;
    assert(actual === expected, `"${error.message}" classified as ${actual}, expected ${expected}`);
  }
  assert(classifyError('a string').category === 'INTERNAL_ERROR', 'a non-Error was not classified');
});

check('preserves trace ids through serialisation', () => {
  const error = new TradingGOATsError({
    message: 'order rejected',
    category: 'RISK_REJECTION',
    requestId: 'req-1', goatId: 'bot-1', wakeId: 'wk-1', executionId: 'ex-1',
  });
  const logged = error.toLogObject();
  for (const key of ['requestId', 'goatId', 'wakeId', 'executionId']) {
    assert(logged[key] !== undefined, `${key} was lost in serialisation`);
  }
  assert(logged.category === 'RISK_REJECTION', 'the category was lost');
});

check('never serialises a cause message, only its category', () => {
  // A cause chain can carry a response body, and a response body can
  // carry a credential echo.
  const error = new TradingGOATsError({
    message: 'wrapped', category: 'INTERNAL_ERROR',
    cause: new Error('POST failed with key=0x' + 'b'.repeat(64)),
  });
  const serialised = JSON.stringify(error.toLogObject());
  assertLacks(serialised, 'b'.repeat(64), 'a cause message leaked a key');
  assertContains(serialised, 'cause', 'the cause is not represented at all');
});

check('redacts a secret that reached a message by accident', () => {
  const logged = JSON.stringify(configError('bad config: api_key=leakedvalue123').toLogObject());
  assertLacks(logged, 'leakedvalue123', 'a secret in an error message survived');
});

/* ================================================================== *
 * Credential boundary
 * ================================================================== */

group('credential store');

const SECRET = { apiKey: 'live_key_abcdef', apiSecret: 'secret_123456' };

check('stores a credential and reports only a status', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  const report = await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  assert(report.status === 'UNVERIFIED', 'a brand new credential should be UNVERIFIED');
  assert(report.provider === 'hyperliquid' && report.label === 'Main', 'the status lost its identity');
  assertDoesNotThrow(() => assertNoSecrets(report), 'the status report is not safe to serialise');
  assertLacks(JSON.stringify(report), 'live_key_abcdef', 'a secret reached the status report');
});

check('does not let a caller mutate the stored secret', async () => {
  // Otherwise a caller can rewrite what the adapter will later sign with
  // after the ownership check has already passed.
  const store = new InMemoryCredentialStore(() => 1000);
  const mutable = { ...SECRET };
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: mutable, userId: 'u1' });
  mutable.apiKey = 'attacker_rewrite';
  const used = await store.getCredentialForExecution('hyperliquid', 'u1', 'Main');
  assert(used.apiKey === 'live_key_abcdef', 'a caller mutated a stored credential after the fact');
});

check('never returns a secret through the status path', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  const report = await store.getStatus('hyperliquid', 'u1', 'Main');
  assertLacks(JSON.stringify(report), 'live_key_abcdef', 'a secret reached the status path');
});

check('refuses another user credential, indistinguishably from a missing one', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });

  let foreign = '';
  let missing = '';
  try {
    await store.getCredentialForExecution('hyperliquid', 'u2', 'Main');
  } catch (error) { foreign = (error as Error).message; }
  try {
    await store.getCredentialForExecution('hyperliquid', 'u2', 'Nope');
  } catch (error) { missing = (error as Error).message; }

  // The same answer either way, so this is not an enumeration oracle.
  assert(foreign === missing, `a different answer for "not yours" (${foreign}) vs "missing" (${missing})`);
  assertLacks(foreign, 'live_key_abcdef', 'the refusal message leaked the secret');
});

check('a new or replaced secret is never VERIFIED by inheritance', async () => {
  // Otherwise an unproven key trades on the strength of its predecessor.
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  await store.markVerified('hyperliquid', 'u1', 'Main', 2000);
  const verified = await store.getStatus('hyperliquid', 'u1', 'Main');
  assert(verified.status === 'VERIFIED', 'the credential was not marked verified');

  await store.rotateCredential('hyperliquid', 'u1', 'Main', { apiKey: 'new_key_xyz' });
  const after = await store.getStatus('hyperliquid', 'u1', 'Main');
  assert(after.status === 'UNVERIFIED', 'a rotated key inherited the old key verified status');
  assert(after.lastVerifiedAt === null, 'a rotated key inherited the old verification time');
});

check('refuses to execute with a credential the venue rejected', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  await store.markInvalid('hyperliquid', 'u1', 'Main', '401 unauthorized');
  await assertRejects(
    () => store.getCredentialForExecution('hyperliquid', 'u1', 'Main'),
    /replaced/,
    'an invalidated credential was still handed out for execution',
  );
});

check('deletes a credential and forgets it', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  assert((await store.deleteCredential('hyperliquid', 'u1', 'Main')) === true, 'the delete did not report success');
  assert((await store.deleteCredential('hyperliquid', 'u1', 'Main')) === false, 'delete is not idempotent');
  await assertRejects(() => store.getCredentialForExecution('hyperliquid', 'u1', 'Main'), /./, 'a deleted credential was still readable');
});

check('reports that it is not durable, so a LIVE deploy can refuse it', () => {
  // The V0 store loses secrets on restart. Saying so is what lets a
  // deployment check before deciding to trade real money.
  assert(new InMemoryCredentialStore().durable() === false, 'the in-memory store claimed to be durable');
});

check('refuses an empty secret rather than storing a blank one', async () => {
  const store = new InMemoryCredentialStore(() => 1000);
  await assertRejects(
    () => store.storeCredential({ provider: 'p', label: 'l', secret: {}, userId: 'u' }),
    /at least one secret/,
    'an empty secret was accepted',
  );
  await assertRejects(
    () => store.storeCredential({ provider: 'p', label: 'l', secret: { apiKey: '' }, userId: 'u' }),
    /empty/,
    'a blank secret field was accepted',
  );
});

check('records whether a credential was ever used', async () => {
  // "Was this key ever used?" is a question that has to be answerable
  // after the fact.
  const store = new InMemoryCredentialStore(() => 1000);
  await store.storeCredential({ provider: 'hyperliquid', label: 'Main', secret: SECRET, userId: 'u1' });
  assert(store.wasAccessed('hyperliquid', 'u1', 'Main') === false, 'an unused credential reported as used');
  await store.getCredentialForExecution('hyperliquid', 'u1', 'Main');
  assert(store.wasAccessed('hyperliquid', 'u1', 'Main') === true, 'a used credential reported as unused');
});

/* ================================================================== *
 * Execution idempotency
 * ================================================================== */

group('execution requests');

const baseOrder: OrderRequest = {
  symbol: 'xyz:GOLD', side: 'BUY', volume: 0.1, type: 'market',
  idempotencyKey: idempotencyKeyFor('wk-1', 1),
};

check('requires an idempotency key', () => {
  // The one mistake that cannot be made safe later, so it is refused at
  // the boundary rather than defaulted.
  assertThrowsMatching(() => assertExecutable({ ...baseOrder, idempotencyKey: '' }), /idempotencyKey/, 'a missing idempotency key was accepted');
  assertDoesNotThrow(() => assertExecutable(baseOrder), 'a valid order request was refused');
});

check('refuses a non-positive volume', () => {
  assertThrowsMatching(() => assertExecutable({ ...baseOrder, volume: 0 }), /positive/, 'a zero-volume order was accepted');
  assertThrowsMatching(() => assertExecutable({ ...baseOrder, volume: Number.NaN }), /positive/, 'a NaN-volume order was accepted');
});

check('requires a limit price for a limit order', () => {
  assertThrowsMatching(() => assertExecutable({ ...baseOrder, type: 'limit' }), /limitPrice/, 'a limit order with no price was accepted');
  assertDoesNotThrow(() => assertExecutable({ ...baseOrder, type: 'limit', limitPrice: 2300 }), 'a valid limit order was refused');
});

check('produces a stable key for the same intent and a different one for a new trade', () => {
  const first = idempotencyKeyFor('wk-abc', 1);
  assert(idempotencyKeyFor('wk-abc', 1) === first, 'a retry produced a different idempotency key');
  assert(idempotencyKeyFor('wk-abc', 2) !== first, 'a deliberate second trade reused the first key');
  assert(idempotencyKeyFor('wk-xyz', 1) !== first, 'two different wakes shared an idempotency key');
});

function assertThrowsMatching(run: () => void, pattern: RegExp, message: string): void {
  try {
    run();
  } catch (error) {
    assert(pattern.test((error as Error).message), `${message} (got: ${(error as Error).message})`);
    return;
  }
  throw new Error(message);
}

/* ================================================================== *
 * LIVE cannot be reached by configuration
 * ================================================================== */

group('LIVE is not reachable by configuration alone');

check('the pipeline refuses any environment but DEMO', () => {
  /*
   * `runPipeline` takes the environment as a parameter and refuses
   * anything but DEMO, so no environment variable, build flag, or
   * NODE_ENV can reach it. This asserts the refusal is in the source,
   * which is the property the behavioural tests rely on.
   */
  const source = readFileSync(new URL('../agents/pipelineAcceptance.ts', import.meta.url), 'utf8');
  assertContains(source, "environment !== 'DEMO'", 'the DEMO-only guard is missing from the pipeline');
  assertContains(source, 'LIVE trading is not available.', 'the LIVE refusal message is missing');
});

check('nothing in the pipeline reports itself as live-trading capable', () => {
  const source = readFileSync(new URL('../agents/pipelineAcceptance.ts', import.meta.url), 'utf8');
  assertContains(source, 'holdsCredentials: false', 'the capability list does not deny credentials');
  if (/holdsCredentials:\s*true/.test(source)) throw new Error('the pipeline claims to hold credentials');
  if (/liveTradingEnabled:\s*true/.test(source)) throw new Error('the pipeline claims live trading is enabled');
});

check('the execution interface has no mode setter', () => {
  // The adapter declares its mode. A `setMode` on this interface would be
  // a one-line way to reach LIVE from anywhere holding a reference.
  const source = readFileSync(new URL('./execution.ts', import.meta.url), 'utf8');
  assertContains(source, 'readonly mode: ExecutionMode', 'the adapter does not declare its mode');
  if (/setMode|enableLive|activateLive/.test(source)) throw new Error('the execution interface exposes a way to change modes');
});

check('the credential store cannot be reached from the watcher tier', () => {
  // The watcher tier must not be able to read a secret even by accident.
  const source = readFileSync(new URL('../../../watchers/src/watcher.ts', import.meta.url), 'utf8');
  if (/credential|secret|privateKey|apiKey/i.test(source)) {
    throw new Error('the watcher state machine references credential material');
  }
});

/* ================================================================== *
 * Observability
 * ================================================================== */

group('logging');

check('redacts data on the way out, not at the call site', () => {
  // Redaction at the call site means the first site that forgets is the
  // leak. Redaction at the sink cannot be forgotten.
  const lines: unknown[] = [];
  const logger = new Logger({ sink: { write: (record) => lines.push(record) }, context: { goatId: 'b1' } });
  logger.info('order failed', { apiKey: 'live_abcdef', symbol: 'Gold' });
  const serialised = JSON.stringify(lines[0]);
  assertLacks(serialised, 'live_abcdef', 'a secret in log data survived');
  assertContains(serialised, 'Gold', 'useful context was destroyed by redaction');
});

check('redacts an error message too', () => {
  const lines: unknown[] = [];
  const logger = new Logger({ sink: { write: (record) => lines.push(record) } });
  logger.error('failed', new Error('auth failed for api_key=leakedvalue'));
  assertLacks(JSON.stringify(lines[0]), 'leakedvalue', 'a secret in an error message survived');
});

check('carries the child context onto every line', () => {
  const lines: Array<Record<string, unknown>> = [];
  const parent = new Logger({ sink: { write: (record) => lines.push(record as never) } });
  parent.child({ watcherId: 'w-1' }).child({ wakeId: 'wk-1' }).info('evaluated');
  assert(lines[0].watcherId === 'w-1', 'the child watcher context was lost');
  assert(lines[0].wakeId === 'wk-1', 'the child wake context was lost');
});

check('bounds its own buffer', () => {
  // A long-lived logger that appends forever is a slow leak.
  const logger = new Logger({ sink: { write: () => undefined }, bufferLimit: 10 });
  for (let index = 0; index < 100; index += 1) logger.info(`line ${index}`);
  assert(logger.recent(1000).length === 10, `the log buffer grew to ${logger.recent(1000).length}`);
});

check('derives deterministic ids', () => {
  assert(wakeIdFor('w1', 'e1', 1) === wakeIdFor('w1', 'e1', 1), 'the wake id is not deterministic');
  assert(evaluationIdFor('w1', 'e1', 1) !== evaluationIdFor('w1', 'e1', 2), 'two config versions share an evaluation id');
});

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

for (const entry of queue) {
  try {
    await entry.run();
    results.push({ name: entry.name, ok: true });
  } catch (error) {
    results.push({ name: entry.name, ok: false, detail: (error as Error).message });
  }
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${result.name}`);
  if (!result.ok && result.detail) console.log(`      ${result.detail}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exit(1);
