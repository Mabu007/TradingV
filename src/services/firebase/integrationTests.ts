/**
 * Tests for the account data path.
 *
 * Two things are being defended here, and they are the two that a user notices:
 *
 *   1. **Ownership.** Every read and write is scoped by the Firebase uid. User A
 *      must not be able to reach user B's GOATs through this abstraction, and no
 *      cached id, remembered GOAT id or device id may stand in for the session.
 *
 *   2. **Ordering.** A refresh must not turn the account's data into an empty
 *      state. A local store rehydrates before the network read returns, and a
 *      naive write-through would push that local copy over whatever the account
 *      actually had. The account is authoritative, so the read has to win.
 *
 * Uses the same fakes as the rest of the Firebase suite — no emulator, no
 * network — so these stay fast and deterministic.
 */

import { AuthService } from './auth';
import { PersistenceService } from './persistence';
import { MemoryStore } from './memoryStore';
import { startUserDataSync, goalFromRecord, recordFromGoal } from './userDataSync';
import { firebaseConfigFromEnv } from './contract';
import type { AuthSession, FirebaseAuthBackend, GoatRecord } from './contract';
import type { Goal } from '../../engine/goat/types';
import type { GoalStore } from '../../engine/goat/store';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

/** An auth backend with accounts this test owns, so no test shares an identity. */
class TestAuthBackend implements FirebaseAuthBackend {
  private session: AuthSession | null = null;
  private listeners = new Set<(session: AuthSession | null) => void>();
  readonly accounts = new Map<string, { uid: string; password: string }>();
  /** Gate the restore call, so a test can observe the loading window. */
  releaseRestore: (() => void) | null = null;

  async restore(): Promise<AuthSession | null> {
    if (this.releaseRestore) {
      await new Promise<void>((resolve) => {
        this.releaseRestore = resolve;
      });
    }
    return this.session;
  }

  async createAccount(email: string, password: string): Promise<AuthSession> {
    const key = email.trim().toLowerCase();
    if (this.accounts.has(key)) {
      throw Object.assign(new Error('exists'), { code: 'auth/email-already-in-use' });
    }
    const uid = `uid-${key.replace(/[^a-z0-9]/g, '-')}`;
    this.accounts.set(key, { uid, password });
    return this.establish(uid, email);
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const account = this.accounts.get(email.trim().toLowerCase());
    if (!account || account.password !== password) {
      throw Object.assign(new Error('no'), { code: 'auth/wrong-password' });
    }
    return this.establish(account.uid, email);
  }

  async signOut(): Promise<void> {
    this.session = null;
    for (const listener of this.listeners) listener(null);
  }

  onChange(listener: (session: AuthSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async idToken(): Promise<string | null> {
    return this.session ? `token-${this.session.uid}` : null;
  }

  private establish(uid: string, email: string): AuthSession {
    this.session = { uid, email, createdAt: 1_700_000_000 };
    for (const listener of this.listeners) listener(this.session);
    return this.session;
  }
}

/** A goal store with no storage behind it, counting what was written. */
class CountingGoalStore implements GoalStore {
  private readonly goals = new Map<string, Goal>();
  saves = 0;

  save(goal: Goal): void {
    this.saves += 1;
    this.goals.set(goal.id, goal);
  }
  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }
  list(): Goal[] {
    return [...this.goals.values()];
  }
  listForAgent(agentId: string): Goal[] {
    return this.list().filter((goal) => goal.agentId === agentId);
  }
  getForAgent(agentId: string): Goal | undefined {
    return this.goals.get(agentId);
  }
  remove(id: string): boolean {
    return this.goals.delete(id);
  }
}

function goal(id: string, statement = 'Trade EUR/USD scalps.'): Goal {
  return {
    id,
    agentId: 'agent-1',
    name: `GOAT ${id}`,
    description: 'A test GOAT.',
    statement,
    symbols: ['EUR/USD'],
    timeframes: ['1m', '5m'],
    skillIds: [],
    status: 'UNDEPLOYED',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_001,
  };
}

/** Persistence wired to a store, with the owner bound the way auth binds it. */
function makeData(): { store: MemoryStore; data: PersistenceService } {
  const store = new MemoryStore();
  store.bindUser('unused-until-bound');
  return { store, data: new PersistenceService(store) };
}

/**
 * A persistence service whose read can be held open.
 *
 * The in-memory store answers in the same tick, which leaves no window in which
 * to observe what happens to a write made *during* hydration — which is the
 * entire behaviour under test. Holding `listGoats` open creates that window
 * deliberately rather than hoping a real network would produce one.
 */
function gatedData(data: PersistenceService): { data: PersistenceService; release: () => void } {
  let open = true;
  let unlock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const proxy = {
    available: data.available,
    unavailableReason: data.unavailableReason,
    listGoats: async (ownerId: string) => {
      if (open) await gate;
      return data.listGoats(ownerId);
    },
    getGoat: (ownerId: string, goatId: string) => data.getGoat(ownerId, goatId),
    createGoat: (ownerId: string, input: never) => data.createGoat(ownerId, input),
    updateGoat: (ownerId: string, goatId: string, patch: never) => data.updateGoat(ownerId, goatId, patch),
    deleteGoat: (ownerId: string, goatId: string) => data.deleteGoat(ownerId, goatId),
  };
  return {
    data: proxy as unknown as PersistenceService,
    release: () => {
      open = false;
      unlock();
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. Configuration: the naming mismatch that made production inert
// ---------------------------------------------------------------------------

function testConfigFromEitherNaming(): void {
  const firebaseNames = firebaseConfigFromEnv({
    FIREBASE_apiKey: 'k',
    FIREBASE_authDomain: 'a.firebaseapp.com',
    FIREBASE_projectId: 'p',
    FIREBASE_storageBucket: 'b',
  });
  assert('config' in firebaseNames, 'the FIREBASE_* names configure the app');
  assertEqual(firebaseNames.config.projectId, 'p', 'the project comes from the environment');

  const viteNames = firebaseConfigFromEnv({
    VITE_FIREBASE_API_KEY: 'k',
    VITE_FIREBASE_AUTH_DOMAIN: 'a.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'p',
  });
  assert('config' in viteNames, 'the VITE_FIREBASE_* names configure the app too');

  const none = firebaseConfigFromEnv({});
  assert('unavailable' in none, 'neither naming means an explicit unavailable, not a false success');
  assert(
    none.unavailable.includes('FIREBASE_apiKey'),
    `and the reason names the variables it looked for: ${none.unavailable}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Auth states
// ---------------------------------------------------------------------------

async function testAuthStates(): Promise<void> {
  const backend = new TestAuthBackend();
  const auth = new AuthService(backend);

  assertEqual(auth.current, null, 'unauthenticated before anything happens');
  assertEqual(auth.signedIn, false, 'and not signed in');

  const seen: Array<AuthSession | null> = [];
  auth.subscribe((session) => seen.push(session));

  const restored = await auth.start();
  assertEqual(restored, null, 'restoring with no stored session yields no session');

  const session = await auth.register({ email: 'owner@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  assert(session.uid.length > 0, 'registering yields a uid');
  assertEqual(auth.signedIn, true, 'and the service is signed in');
  assertEqual(auth.current?.uid, session.uid, 'the current session is that account');
  assert(seen[0] === null, 'a subscriber is told the state it starts in');
  assertEqual(seen[seen.length - 1]?.uid, session.uid, 'and then the session it became');

  // A reload is a new service over the same backend: what makes refresh work.
  const afterReload = new AuthService(backend);
  const back = await afterReload.start();
  assertEqual(back?.uid, session.uid, 'a refresh restores the same uid from Firebase persistence');
  assertEqual(back?.email, session.email, 'and the same account');

  await afterReload.signOut();
  assertEqual(afterReload.current, null, 'signing out clears the session');
  assertEqual(afterReload.signedIn, false, 'and the service reports signed out');
}

async function testSignOutIsNotFaked(): Promise<void> {
  const backend = new TestAuthBackend();
  const auth = new AuthService(backend);
  await auth.register({ email: 'out@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  await auth.signOut();
  assertEqual(auth.current, null, 'the session is gone');
  // A fresh service must not resurrect it.
  const fresh = new AuthService(backend);
  assertEqual(await fresh.start(), null, 'and it does not come back after signing out');
}

// ---------------------------------------------------------------------------
// 3. Ownership: data is scoped to the uid
// ---------------------------------------------------------------------------

async function testUidScoping(): Promise<void> {
  const { store, data } = makeData();
  const alice = 'uid-alice';
  const bob = 'uid-bob';

  store.bindUser(alice);
  await data.createGoat(alice, recordFromGoal(goal('goat-a')));

  // Bob signs in: the same store, a different owner.
  store.bindUser(bob);
  assertEqual((await data.listGoats(bob)).length, 0, 'a second account sees none of the first account data');
  assertEqual(await data.getGoat(bob, 'goat-a'), undefined, 'and cannot fetch it by a known id');

  store.bindUser(alice);
  assertEqual((await data.listGoats(alice)).length, 1, 'the owner still sees their own GOAT');

  // Unbound is not "everyone": it is nobody.
  store.bindUser(null);
  let refused = false;
  try {
    await data.listGoats(alice);
  } catch {
    refused = true;
  }
  assert(refused, 'an unbound store refuses to read rather than reading unscoped');
}

async function testWriteGoesToTheSessionUid(): Promise<void> {
  const { store, data } = makeData();
  const auth = new AuthService(new TestAuthBackend());
  const goals = new CountingGoalStore();
  const sync = startUserDataSync({ auth, data, goals });

  await auth.register({ email: 'writer@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  await sync.ready();

  const uid = auth.current!.uid;
  store.bindUser(uid);
  sync.goalStore(goals).save(goal('goat-new'));
  await settle();

  const stored = await data.listGoats(uid);
  assertEqual(stored.length, 1, 'a GOAT saved in the app reaches the account');
  assertEqual(stored[0].id, 'goat-new', 'under the session uid, with the id the runtime uses');
  assertEqual(stored[0].objective, 'Trade EUR/USD scalps.', 'and the user objective is preserved');

  sync.dispose();
}

// ---------------------------------------------------------------------------
// 4. Refresh must not overwrite the account with local state
// ---------------------------------------------------------------------------

async function testRefreshRestoresRatherThanOverwrites(): Promise<void> {
  const { store, data } = makeData();
  const backend = new TestAuthBackend();
  const auth = new AuthService(backend);

  // First device: the account accumulates two GOATs.
  const firstSession = await auth.register({ email: 'restore@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  store.bindUser(firstSession.uid);
  await data.createGoat(firstSession.uid, recordFromGoal(goal('goat-1')));
  await data.createGoat(firstSession.uid, recordFromGoal(goal('goat-2')));

  // Second device: a different browser, so a local store with nothing in it.
  const secondAuth = new AuthService(backend);
  const goals = new CountingGoalStore();
  const gated = gatedData(data);
  const sync = startUserDataSync({ auth: secondAuth, data: gated.data, goals });

  // A local GOAT appears while the read is still in flight — the race. Signing in
  // puts the sync into HYDRATING, so this write must be queued, not pushed.
  const store2 = sync.goalStore(goals);
  const restoring = secondAuth.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(sync.state, 'HYDRATING', 'the sync is reading before it will write');
  store2.save(goal('local-only'));
  assertEqual(goals.saves, 1, 'the local store took it immediately');

  gated.release();
  await restoring;
  await sync.ready();
  assertEqual(sync.state, 'READY', 'and the queued write was released after the read');

  assert(
    goals.get('goat-1') !== undefined && goals.get('goat-2') !== undefined,
    'the account GOATs are restored onto this device',
  );
  assertEqual(goals.list().length, 3, 'and the device ends up with the account plus its own');

  const stored = await data.listGoats(firstSession.uid);
  assertEqual(stored.length, 3, 'the account has all three: nothing was lost, nothing duplicated');
  assertEqual(
    stored.filter((record: GoatRecord) => record.id === 'goat-1').length,
    1,
    'and a GOAT written during hydration did not create a second copy',
  );

  sync.dispose();
}

async function testStaleLocalDoesNotOverwriteNewerAccountCopy(): Promise<void> {
  const { store, data } = makeData();
  const backend = new TestAuthBackend();
  const auth = new AuthService(backend);
  const session = await auth.register({ email: 'stale@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  store.bindUser(session.uid);

  // The account has a newer edit of this GOAT than the device holds.
  await data.createGoat(session.uid, recordFromGoal(goal('shared', 'Edited on another device.')));

  const goals = new CountingGoalStore();
  goals.save({ ...goal('shared', 'Stale local copy.'), updatedAt: 1_700_000_001 });

  const sync = startUserDataSync({ auth, data, goals });
  await sync.ready();

  const restored = goals.get('shared');
  assert(restored !== undefined, 'the GOAT is present after hydration');
  assertEqual(
    restored.statement,
    'Edited on another device.',
    'the account copy won, because it is newer',
  );

  const stored = await data.listGoats(session.uid);
  assertEqual(stored[0].objective, 'Edited on another device.', 'and the account was not pushed back over');

  sync.dispose();
}

// ---------------------------------------------------------------------------
// 5. Failure handling
// ---------------------------------------------------------------------------

async function testFailedReadKeepsLocalState(): Promise<void> {
  const { data } = makeData();
  // Unavailable persistence is the worst realistic case: no store at all.
  const auth = new AuthService(new TestAuthBackend());
  const goals = new CountingGoalStore();
  goals.save(goal('local'));

  const states: string[] = [];
  const sync = startUserDataSync({
    auth,
    data: new PersistenceService(undefined, () => 0, 'Firestore is unavailable.'),
    goals,
    onState: (state) => states.push(state),
  });

  await auth.register({ email: 'degraded@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  await sync.ready();

  assert(goals.get('local') !== undefined, 'a failed load does not destroy what the device had');
  assert(states.includes('READY'), 'and the app reaches a usable state rather than hanging on loading');
  void data;
}

async function testSignOutStopsWriting(): Promise<void> {
  const { store, data } = makeData();
  const auth = new AuthService(new TestAuthBackend());
  const goals = new CountingGoalStore();
  const sync = startUserDataSync({ auth, data, goals });

  await auth.register({ email: 'bye@example.com', password: 'correct-horse-battery', passwordConfirmation: 'correct-horse-battery' });
  await sync.ready();
  const uid = auth.current!.uid;
  store.bindUser(uid);

  const writes = sync.goalStore(goals);
  writes.save(goal('before-signout'));
  await settle();
  assertEqual((await data.listGoats(uid)).length, 1, 'written while signed in');

  await auth.signOut();
  await settle();

  writes.save(goal('after-signout'));
  await settle();
  assertEqual((await data.listGoats(uid)).length, 1, 'a write after sign-out does not reach the account');
  assertEqual(sync.uid, null, 'and the sync is unbound');

  sync.dispose();
}

// ---------------------------------------------------------------------------
// 6. Record <-> goal mapping
// ---------------------------------------------------------------------------

function testMapping(): void {
  const original = goal('map-me');
  const record = recordFromGoal(original);
  assertEqual(record.id, original.id, 'the id survives, so nothing is orphaned');
  assertEqual(record.objective, original.statement, 'the objective is stored');

  const back = goalFromRecord({ ...record, ownerId: 'u', schemaVersion: 1, createdAt: 1, updatedAt: 1 } as GoatRecord, 'agent-1');
  assert(back !== undefined, 'a stored GOAT rebuilds');
  assertEqual(back.statement, original.statement, 'with its objective intact');
  assertEqual(back.timeframes.join(','), '1m,5m', 'and the resolutions it declared');
  assertEqual(goalFromRecord({ id: '' } as unknown as GoatRecord, 'a'), undefined, 'an unreadable record is refused rather than half-restored');

  const finished = recordFromGoal({ ...original, status: 'ACHIEVED' });
  assertEqual(finished.status, 'ARCHIVED', 'a finished GOAT is archived in storage');
}

if (import.meta.main) {
  const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
    { name: 'config: either naming convention configures Firebase', fn: testConfigFromEitherNaming },
    { name: 'auth: unauthenticated, signed in, restored, signed out', fn: testAuthStates },
    { name: 'auth: a sign-out is not undone by a reload', fn: testSignOutIsNotFaked },
    { name: 'scoping: a second account cannot read the first', fn: testUidScoping },
    { name: 'scoping: a saved GOAT is written under the session uid', fn: testWriteGoesToTheSessionUid },
    { name: 'refresh: the account is restored, not overwritten', fn: testRefreshRestoresRatherThanOverwrites },
    { name: 'refresh: a stale local copy does not win', fn: testStaleLocalDoesNotOverwriteNewerAccountCopy },
    { name: 'failure: a failed load keeps local state', fn: testFailedReadKeepsLocalState },
    { name: 'failure: sign-out stops writes reaching the account', fn: testSignOutStopsWriting },
    { name: 'mapping: a stored GOAT round-trips', fn: testMapping },
  ];
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
  if (failures.length > 0) throw new Error(`${failures.length} Firebase integration test(s) failed.`);
}

export {};