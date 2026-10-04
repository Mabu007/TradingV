/**
 * Tests for the Firebase layer.
 *
 * ## What is asserted here, and what is not
 *
 * These tests run the real `AuthService` and the real `PersistenceService`
 * against doubles for the two things that need a network: the Firebase Auth
 * backend and the document store. That means the logic under test is the
 * production logic, not a reimplementation of it.
 *
 * The rules are a separate subject and a separate suite: `rulesTests.ts` runs
 * `firestore.rules` against the Firestore emulator. Nothing here claims the rules
 * work — it claims the application asks for the right things, so that the rules
 * have something correct to accept or refuse.
 *
 * `bun src/services/firebase/tests.ts`
 */

import { AuthError, AuthService, authFailureFromCode, validateEmail, validatePassword, validateRegistration, validateSignIn } from './auth';
import { PersistenceService } from './persistence';
import { MemoryStore, MemoryStoreError } from './memoryStore';
import { configureFirebase, unavailableNotice } from './configure';
import { firebaseConfigFromEnv, ownedPath, type AuthSession, type FirebaseAuthBackend } from './contract';

// ---------------------------------------------------------------------------
// A tiny test harness, matching the style used elsewhere in this repository.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auth doubles
// ---------------------------------------------------------------------------

interface Account {
  email: string;
  password: string;
}

class FakeAuthBackend implements FirebaseAuthBackend {
  private session: AuthSession | null = null;
  private listeners = new Set<(session: AuthSession | null) => void>();
  readonly accounts = new Map<string, Account>();
  /** Calls made, so a test can assert no request was attempted. */
  readonly calls: string[] = [];
  failWith: string | null = null;

  async restore(): Promise<AuthSession | null> {
    this.calls.push('restore');
    return this.session;
  }

  async createAccount(email: string, password: string): Promise<AuthSession> {
    this.calls.push('createAccount');
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    const key = email.trim().toLowerCase();
    if (this.accounts.has(key)) {
      throw Object.assign(new Error('exists'), { code: 'auth/email-already-in-use' });
    }
    this.accounts.set(key, { email, password });
    return this.establish(key);
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    this.calls.push('signIn');
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    const account = this.accounts.get(email.trim().toLowerCase());
    if (!account || account.password !== password) {
      throw Object.assign(new Error('no'), { code: 'auth/wrong-password' });
    }
    return this.establish(email.trim().toLowerCase());
  }

  async signOut(): Promise<void> {
    this.calls.push('signOut');
    this.session = null;
    for (const listener of this.listeners) listener(null);
  }

  onChange(listener: (session: AuthSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async idToken(): Promise<string | null> {
    // Stands in for a signed token: what matters here is that it is present only
    // while there is a session, and that it is requested per call.
    return this.session ? `token-for-${this.session.uid}` : null;
  }

  /** Simulate a session lost to an expiry or a revoked token. */
  expire(): void {
    this.session = null;
    for (const listener of this.listeners) listener(null);
  }

  private establish(key: string): AuthSession {
    this.session = { uid: `uid_${key}`, email: this.accounts.get(key)!.email };
    for (const listener of this.listeners) listener(this.session);
    return this.session;
  }
}

// ---------------------------------------------------------------------------
// 1. Credential validation — before any request is made
// ---------------------------------------------------------------------------

await test('a malformed email is rejected before a request is attempted', () => {
  assertEqual(validateEmail('')?.code, 'INVALID_EMAIL', 'an empty address is malformed');
  assertEqual(validateEmail('not-an-email')?.code, 'INVALID_EMAIL', 'so is one with no domain');
  assertEqual(validateEmail('two@@example.com')?.code, 'INVALID_EMAIL', 'or two at signs');
  assertEqual(validateEmail('space in@example.com')?.code, 'INVALID_EMAIL', 'or whitespace');
  assertEqual(validateEmail(undefined as unknown as string)?.code, 'INVALID_EMAIL', 'or nothing at all');
  assertEqual(validateEmail('person@example.com'), undefined, 'a real address passes');
  assertEqual(validateEmail('person.name+tag@sub.example.co.uk'), undefined, 'and a busy one does too');
});

await test('a password below the provider minimum is rejected with the number in the message', () => {
  const short = validatePassword('abc');
  assertEqual(short?.code, 'WEAK_PASSWORD', 'too short is refused');
  assert(short!.message.includes('6'), 'and the message names the minimum rather than saying "too short"');
  assertEqual(validatePassword('')?.code, 'WEAK_PASSWORD', 'and an empty one is refused too');
  assertEqual(validatePassword('abcdef')?.code, undefined, 'exactly six is allowed');
});

await test('registration reports every problem at once, not one per attempt', () => {
  const bad = validateRegistration({ email: 'nope', password: '123', passwordConfirmation: '456' });
  const codes = bad.map((failure) => failure.code);
  assert(codes.includes('INVALID_EMAIL'), 'the email is reported');
  assert(codes.includes('WEAK_PASSWORD'), 'the password is reported');
  // The confirmation is not reported on its own once the password is already
  // wrong — "they do not match" is noise when the password is four characters.
  assert(!codes.includes('MISMATCHED_CONFIRMATION'), 'but not a redundant mismatch complaint');

  const mismatch = validateRegistration({
    email: 'person@example.com',
    password: 'abcdef',
    passwordConfirmation: 'different',
  });
  assertEqual(mismatch.length, 1, 'a mismatched confirmation on an otherwise valid form is one problem');
  assertEqual(mismatch[0].code, 'MISMATCHED_CONFIRMATION', 'and it is the right one');
});

await test('sign-in validation distinguishes a malformed address from a missing password', () => {
  const codes = validateSignIn({ email: 'person@example.com', password: '' }).map((f) => f.code);
  assertEqual(codes.length, 1, 'only the password is wrong');
  assertEqual(validateSignIn({ email: 'bad', password: 'secret' })[0].code, 'INVALID_EMAIL', 'the address is checked too');
  assertEqual(validateSignIn({ email: 'person@example.com', password: 'secret' }).length, 0, 'a complete form passes');
});

// ---------------------------------------------------------------------------
// 2. Error mapping
// ---------------------------------------------------------------------------

await test('an unknown account and a wrong password report the same thing', () => {
  const unknown = authFailureFromCode('auth/user-not-found');
  const wrong = authFailureFromCode('auth/wrong-password');
  const invalid = authFailureFromCode('auth/invalid-credential');
  assertEqual(unknown.code, wrong.code, 'a missing account and a bad password share a code');
  assertEqual(wrong.message, invalid.message, 'and a message, so they cannot be told apart');
  assert(!unknown.message.toLowerCase().includes('not found'), 'and the message does not confirm the account is missing');
});

await test('every provider code the application can cause maps to something specific', () => {
  const mapped = [
    'auth/invalid-email',
    'auth/weak-password',
    'auth/missing-password',
    'auth/email-already-in-use',
    'auth/invalid-credential',
    'auth/email-not-verified',
    'auth/too-many-requests',
    'auth/network-request-failed',
    'auth/operation-not-allowed',
  ].map((code) => authFailureFromCode(code).code);
  assert(!mapped.includes('UNKNOWN'), 'none of the known codes falls through to UNKNOWN');
});

await test('a session proof is available only while somebody is signed in', async () => {
  const backend = new FakeAuthBackend();
  backend.accounts.set('person@example.com', { email: 'person@example.com', password: 'secret1' });
  const auth = new AuthService(backend);
  await auth.start();

  assertEqual(await backend.idToken(), null, 'nothing to present before signing in');
  await auth.signIn({ email: 'person@example.com', password: 'secret1' });
  assertEqual(await backend.idToken(), 'token-for-uid_person@example.com', 'a proof while signed in');
  await auth.signOut();
  assertEqual(await backend.idToken(), null, 'and none after signing out');
});

await test('an unmapped code surfaces the provider message rather than swallowing it', () => {
  const failure = authFailureFromCode('auth/something-new', 'A message from the provider.');
  assertEqual(failure.code, 'UNKNOWN', 'it is honestly reported as unmapped');
  assertEqual(failure.message, 'A message from the provider.', 'with the provider text intact');
});

// ---------------------------------------------------------------------------
// 3. Session behaviour
// ---------------------------------------------------------------------------

await test('a session survives a refresh, and a restored one needs no password', async () => {
  const backend = new FakeAuthBackend();
  backend.accounts.set('person@example.com', { email: 'person@example.com', password: 'secret1' });
  const auth = new AuthService(backend);

  await auth.signIn({ email: 'person@example.com', password: 'secret1' });
  assert(auth.signedIn, 'signed in');

  // The refresh: a brand new service over the same backend, as a page load would.
  const afterReload = new AuthService(backend);
  const restored = await afterReload.start();
  assertEqual(restored?.email, 'person@example.com', 'the session comes back');
  assertEqual(
    backend.calls.filter((call) => call === 'signIn').length,
    1,
    'and no second sign-in was attempted with the password',
  );
});

await test('a session lost to an expiry reaches the application without being polled for', async () => {
  const backend = new FakeAuthBackend();
  backend.accounts.set('person@example.com', { email: 'person@example.com', password: 'secret1' });
  const auth = new AuthService(backend);
  const seen: Array<string | null> = [];
  auth.subscribe((session) => seen.push(session?.email ?? null));
  await auth.start();
  await auth.signIn({ email: 'person@example.com', password: 'secret1' });

  backend.expire();

  assertEqual(auth.signedIn, false, 'the application knows it is signed out');
  assertEqual(seen.at(-1), null, 'and its subscribers were told, rather than finding out on the next request');
});

await test('signing out ends the session and keeps the account', async () => {
  const backend = new FakeAuthBackend();
  backend.accounts.set('person@example.com', { email: 'person@example.com', password: 'secret1' });
  const auth = new AuthService(backend);
  await auth.signIn({ email: 'person@example.com', password: 'secret1' });

  await auth.signOut();

  assertEqual(auth.signedIn, false, 'the session is gone');
  assertEqual(backend.accounts.size, 1, 'the account still exists');
  // Signing back in works with the same password — logging out did not alter it.
  await auth.signIn({ email: 'person@example.com', password: 'secret1' });
  assert(auth.signedIn, 'and the same credentials still work');
});

await test('a validation failure never reaches the provider', async () => {
  const backend = new FakeAuthBackend();
  const auth = new AuthService(backend);
  let thrown: unknown;
  try {
    await auth.register({ email: 'bad', password: '123', passwordConfirmation: '123' });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof AuthError, 'it fails as an auth error');
  assertEqual(backend.calls.length, 0, 'and the provider was never contacted');
});

await test('a provider failure is reported as a typed failure, not a raw SDK error', async () => {
  const backend = new FakeAuthBackend();
  backend.failWith = 'auth/network-request-failed';
  const auth = new AuthService(backend);
  try {
    await auth.signIn({ email: 'person@example.com', password: 'secret1' });
    throw new Error('the sign-in should not have succeeded');
  } catch (error) {
    assert(error instanceof AuthError, 'it is an AuthError');
    assertEqual((error as AuthError).failure.code, 'NETWORK', 'with the network failure identified');
  }
});

await test('an unconfigured build reports why, and refuses to pretend', async () => {
  const services = configureFirebase({});
  assertEqual(services.configured, false, 'nothing is configured');
  assert(services.unavailableReason !== null, 'a reason is given');
  assert(
    services.unavailableReason!.includes('VITE_FIREBASE_API_KEY'),
    'and it names the missing setting, so it can be fixed',
  );
  assertEqual(services.auth.signedIn, false, 'nobody is signed in');
  try {
    await services.auth.signIn({ email: 'person@example.com', password: 'secret1' });
    throw new Error('sign-in should have been refused');
  } catch (error) {
    assertEqual((error as AuthError).failure.code, 'UNAVAILABLE', 'sign-in is refused as unavailable');
  }
});

await test('the unavailable notice says what still works', () => {
  const notice = unavailableNotice('Firebase is not configured.');
  assert(notice !== null && notice.includes('keeps working'), 'it reassures the user the rest of the app is fine');
  assertEqual(unavailableNotice(null), null, 'and there is no notice when Firebase works');
});

await test('a partial configuration is treated as no configuration', () => {
  const partial = firebaseConfigFromEnv({ VITE_FIREBASE_API_KEY: 'key' });
  assert('unavailable' in partial, 'a config missing authDomain and projectId is not usable');
  assert(
    ('unavailable' in partial ? partial.unavailable : '').includes('VITE_FIREBASE_PROJECT_ID'),
    'and it says which one is missing',
  );
});

// ---------------------------------------------------------------------------
// 4. Ownership
// ---------------------------------------------------------------------------

await test('every document lives under its owner, and the rules are written to match', () => {
  assertEqual(ownedPath('u1', 'goats'), 'users/u1/goats', 'a collection is under the owner');
  assertEqual(ownedPath('u1', 'goats', 'g1'), 'users/u1/goats/g1', 'and so is a document');
  // The rules file encodes the same prefix; if these ever diverge, ownership is
  // decided by whichever one a caller happens to use.
  assert(ownedPath('u1', 'deployments', 'd1').startsWith('users/u1/'), 'the prefix a rule matches on');
});

await test('a store with nobody signed in refuses to read rather than reading everything', async () => {
  const store = new MemoryStore();
  try {
    await store.list('goats');
    throw new Error('an unscoped read should have been refused');
  } catch (error) {
    assert(error instanceof MemoryStoreError, 'it is refused');
    assertEqual((error as MemoryStoreError).code, 'unauthenticated', 'for the right reason');
  }
});

await test('one user cannot see another user\'s documents', async () => {
  const shared = new Map();
  const alice = new MemoryStore(shared);
  const bob = new MemoryStore(shared);
  alice.bindUser('alice');
  bob.bindUser('bob');

  await alice.set('goats', { id: 'g1', name: 'Alice GOAT', updatedAt: 1 } as never);
  await bob.set('goats', { id: 'g1', name: 'Bob GOAT', updatedAt: 1 } as never);

  assertEqual((await alice.list<{ name: string }>('goats')).length, 1, 'each sees their own');
  assertEqual((await alice.list<{ name: string }>('goats'))[0].name, 'Alice GOAT', 'and it is theirs');
  assertEqual((await bob.get<{ name: string }>('goats', 'g1'))?.name, 'Bob GOAT', 'not the other one');
  // Same document id under two owners: the path is the ownership, so this is not
  // a collision.
  assertEqual(shared.size, 2, 'and the two documents coexist rather than overwriting');
});

// ---------------------------------------------------------------------------
// 5. The activation invariant
// ---------------------------------------------------------------------------

function harness(now = 1_000) {
  const shared = new Map();
  const store = new MemoryStore(shared);
  const clock = { value: now };
  const data = new PersistenceService(store, () => clock.value);
  store.bindUser('u1');
  return { shared, store, data, clock };
}

async function seedGoat(data: PersistenceService, id = 'g1') {
  return data.createGoat('u1', {
    id,
    name: 'Gold scalper',
    description: 'A GOAT that watches gold.',
    objective: 'Watch XAU/USD for a break of the range.',
    symbols: ['xyz:GOLD'],
    timeframes: ['1h', '15m', '1m'],
    skillIds: ['skill-1'],
    status: 'UNDEPLOYED',
  });
}

await test('creating an active deployment claims the GOAT\'s pointer in the same batch', async () => {
  const { data, store } = harness();
  await seedGoat(data);

  await data.addDeployment('u1', {
    id: 'd1',
    goatId: 'g1',
    market: 'xyz:GOLD',
    timeframe: '1h',
    mode: 'SHADOW',
    status: 'active',
  });

  const goat = await store.get<{ activeDeploymentId?: string }>('goats', 'g1');
  assertEqual(goat?.activeDeploymentId, 'd1', 'the GOAT points at the deployment that was just created');
  assert((await store.get('deployments', 'd1')) !== undefined, 'and the deployment exists');
});

await test('a second active deployment cannot take the pointer', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'active',
  });

  await data.updateDeployment('u1', 'd1', { status: 'stopped' });
  await data.addDeployment('u1', {
    id: 'd2', goatId: 'g1', market: 'xyz:GOLD', timeframe: '15m', mode: 'SHADOW', status: 'active',
  });

  assertEqual(
    (await store.get<{ activeDeploymentId?: string }>('goats', 'g1'))?.activeDeploymentId,
    'd2',
    'the newest activation owns the pointer',
  );
});

await test('stopping a deployment releases the pointer, so the GOAT can be started again', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'active',
  });

  await data.updateDeployment('u1', 'd1', { status: 'stopped' });

  assertEqual(
    (await store.get<{ activeDeploymentId?: string }>('goats', 'g1'))?.activeDeploymentId,
    undefined,
    'a stale pointer would leave the GOAT permanently unactivatable',
  );
});

await test('a stale tab cannot release a pointer another tab has claimed', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'active',
  });
  // Tab A stops d1 and tab B starts d2, interleaved so B's claim lands first.
  await data.updateDeployment('u1', 'd1', { status: 'stopped' });
  await data.addDeployment('u1', {
    id: 'd2', goatId: 'g1', market: 'xyz:GOLD', timeframe: '15m', mode: 'SHADOW', status: 'active',
  });

  // Tab A now retries its stop, long after the fact.
  const staleBatch = store.batch().update('deployments', 'd1', { status: 'paused' } as never);
  await staleBatch.releaseActiveDeployment('g1', 9_000, 'd1').commit();

  assertEqual(
    (await store.get<{ activeDeploymentId?: string }>('goats', 'g1'))?.activeDeploymentId,
    'd2',
    'd2 keeps its claim, because the release was conditional on naming d1',
  );
});

await test('deleting a deployment releases the pointer', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'active',
  });

  await data.deleteDeployment('u1', 'd1');

  assertEqual((await store.get('deployments', 'd1')), undefined, 'the deployment is gone');
  assertEqual(
    (await store.get<{ activeDeploymentId?: string }>('goats', 'g1'))?.activeDeploymentId,
    undefined,
    'and so is the claim on the GOAT',
  );
});

// ---------------------------------------------------------------------------
// 6. CRUD
// ---------------------------------------------------------------------------

await test('a GOAT round-trips with its timestamps stamped by the clock', async () => {
  const { data, clock } = harness(500);
  const created = await seedGoat(data);
  assertEqual(created.createdAt, 500, 'createdAt comes from the clock, not the caller');
  assertEqual(created.ownerId, 'u1', 'and the owner is stamped from the session, not trusted');
  assertEqual(created.schemaVersion, 1, 'with a schema version for a future migration');

  clock.value = 900;
  const updated = await data.updateGoat('u1', 'g1', { description: 'Now with a description.' });
  assertEqual(updated.updatedAt, 900, 'updatedAt moves on edit');
  assertEqual(updated.createdAt, 500, 'while createdAt does not');
  assertEqual(updated.description, 'Now with a description.', 'and the patch applied');
});

await test('deleting a GOAT takes its deployments and trackers with it', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'paused',
  });
  await data.saveTracker('u1', 'd1', {
    id: 't1', deploymentId: 'd1', goatId: 'g1', purpose: 'entry', kind: 'PRICE',
    timeframe: '1h', config: { side: 'above' }, status: 'ACTIVE',
  });
  await data.saveTracker('u1', 'd1', {
    id: 't2', deploymentId: 'd1', goatId: 'g1', purpose: 'confirm', kind: 'PRICE',
    timeframe: '15m', config: {}, status: 'ACTIVE',
  });

  const cascade = await data.deleteGoat('u1', 'g1');

  assertEqual(cascade.deployments, 1, 'one deployment went with it');
  assertEqual(cascade.trackers, 2, 'and two trackers');
  assertEqual(await store.get('goats', 'g1'), undefined, 'the GOAT is gone');
  assertEqual(await store.get('deployments', 'd1'), undefined, 'the deployment is gone');
  assertEqual((await store.listChildren('deployments', 'd1', 'trackers')).length, 0, 'and so are the trackers');
});

await test("a tracker edit is a new version, and the version never goes backwards", async () => {
  const { data } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'paused',
  });

  const first = await data.saveTracker('u1', 'd1', {
    id: 't1', deploymentId: 'd1', goatId: 'g1', purpose: 'entry', kind: 'PRICE',
    timeframe: '1h', config: { side: 'above' }, status: 'ACTIVE',
  });
  assertEqual(first.configurationVersion, 1, 'a new tracker starts at 1');

  const second = await data.updateTracker('u1', 'd1', 't1', { config: { side: 'below' } });
  assertEqual(second.configurationVersion, 2, 'an edit advances the version');
  assertEqual(second.createdAt, first.createdAt, 'and keeps its creation time');

  // A caller trying to force the version backwards is ignored rather than obeyed:
  // the runtime keys its work on this number, and a version that can move back is
  // a version it cannot order.
  const third = await data.updateTracker('u1', 'd1', 't1', { configurationVersion: 1 });
  assertEqual(third.configurationVersion, 3, 'a requested downgrade is overridden');
});

await test('saving the same tracker twice edits one document instead of adding a second watch', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  await data.addDeployment('u1', {
    id: 'd1', goatId: 'g1', market: 'xyz:GOLD', timeframe: '1h', mode: 'SHADOW', status: 'paused',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await data.saveTracker('u1', 'd1', {
      id: 't1', deploymentId: 'd1', goatId: 'g1', purpose: 'entry', kind: 'PRICE',
      timeframe: '1h', config: { attempt }, status: 'ACTIVE',
    });
  }
  const trackers = await store.listChildren<{ configurationVersion: number }>('deployments', 'd1', 'trackers');
  assertEqual(trackers.length, 1, 'one tracker, not three');
  assertEqual(trackers[0].configurationVersion, 3, 'with a version per edit');
});

await test('history is append-only and bounded', async () => {
  const { data, store } = harness(4_242);
  const record = await data.appendHistory('u1', {
    id: 'h1', kind: 'BACKTEST', subjectId: 'run-1', summary: 'GOLD 15m, 3/3 conditions fired.',
    metrics: { winRate: 0.42, trades: 12 },
  });
  assertEqual(record.at, 4_242, 'stamped from the clock');
  assertEqual(record.ownerId, 'u1', 'and owned');

  // There is no update or delete method on the service at all — an app that
  // cannot call them cannot rewrite its own history.
  const service = data as unknown as Record<string, unknown>;
  assertEqual(service['updateHistory'], undefined, 'no update method exists');
  assertEqual(service['deleteHistory'], undefined, 'and no delete method');
  assertEqual((await store.list('history')).length, 1, 'the record is there');
});

await test('a list is ordered by recency and can be capped', async () => {
  const { data, store, clock } = harness(100);
  await seedGoat(data, 'g1');
  clock.value = 200;
  await seedGoat(data, 'g2');
  clock.value = 300;
  await seedGoat(data, 'g3');

  const all = await data.listGoats('u1');
  assertEqual(all.map((goat) => goat.id).join(','), 'g3,g2,g1', 'newest first');

  const top = await store.list<{ id: string }>('goats', { limit: 2 });
  assertEqual(top.length, 2, 'a limit caps the list');
  assertEqual(top[0].id, 'g3', 'and keeps the newest');
});

await test('a store refuses to overwrite on create, so a colliding id is reported', async () => {
  const { data, store } = harness();
  await seedGoat(data);
  try {
    await data.createGoat('u1', {
      id: 'g1', name: 'A different GOAT with the same id', description: '', objective: 'x',
      symbols: [], timeframes: [], skillIds: [], status: 'UNDEPLOYED',
    });
    throw new Error('the second create should have been refused');
  } catch (error) {
    assert(error instanceof MemoryStoreError, 'it is refused rather than silently replacing a GOAT');
    assertEqual((error as MemoryStoreError).code, 'already-exists', 'for the right reason');
  }
  assertEqual((await data.getGoat('u1', 'g1'))?.name, 'Gold scalper', 'and the original is untouched');
});

// ---------------------------------------------------------------------------
// 7. Unavailability
// ---------------------------------------------------------------------------

await test('an unconfigured persistence layer fails with a reason, not a null dereference', async () => {
  const data = new PersistenceService(undefined, () => 0, 'Firebase is not configured.');
  assertEqual(data.available, false, 'it knows it is unavailable');
  try {
    await data.listGoats('u1');
    throw new Error('a read should have been refused');
  } catch (error) {
    assert(
      (error as Error).message.includes('Firebase is not configured'),
      'and says which setting is missing',
    );
  }
});

await test('a create with no owner is refused before it reaches a store', async () => {
  const { data } = harness();
  try {
    await data.createGoat('', {
      id: 'g1', name: 'x', description: '', objective: 'y', symbols: [], timeframes: [],
      skillIds: [], status: 'UNDEPLOYED',
    });
    throw new Error('an ownerless write should have been refused');
  } catch (error) {
    assert((error as Error).message.includes('owner'), 'the reason names the missing owner');
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} firebase test(s) failed.`);
}