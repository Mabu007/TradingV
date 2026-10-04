/**
 * Tests for `firestore.rules`, run against the Firestore emulator.
 *
 * ## Why the rules get their own suite
 *
 * Everything else in this feature can be tested against a double. The rules
 * cannot: their entire job is to decide what a *client that is not trusted* is
 * allowed to do, so a test that reads and writes through the same trusted
 * application code would be testing the code, not the rules.
 *
 * So these tests do what an attacker would do. They use the Firestore SDK
 * directly, with a signed-in user's auth context, and attempt exactly the writes
 * that must be refused. A rule that is wrong in the permissive direction fails
 * here.
 *
 * ## Running them
 *
 * ```
 *   firebase emulators:exec --only firestore "bun run test:rules"
 * ```
 *
 * The emulator is required — `firestore.rules` is not something this repository
 * can interpret. That is deliberate friction: a security rule that is only ever
 * checked by reading it is a rule nobody has checked.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

const OWNER = 'user_alice';
const OTHER = 'user_bob';

let environment: RulesTestEnvironment;
const now = 1_700_000_000_000;

/** A document with everything the rules require, so a test can vary one field. */
function goat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g1',
    ownerId: OWNER,
    name: 'Gold scalper',
    description: 'Watches gold.',
    objective: 'Watch XAU/USD for a break of the range.',
    interpretation: 'Break of the 1h range.',
    symbols: ['xyz:GOLD'],
    timeframes: ['1h', '15m'],
    skillIds: ['s1'],
    risk: { maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 0.02 },
    status: 'MONITORING',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function deployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1',
    ownerId: OWNER,
    goatId: 'g1',
    market: 'xyz:GOLD',
    timeframe: '1h',
    mode: 'SHADOW',
    status: 'active',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tracker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    ownerId: OWNER,
    deploymentId: 'd1',
    goatId: 'g1',
    purpose: 'Entry confirmation',
    kind: 'PRICE',
    timeframe: '15m',
    config: { side: 'above', price: 2000 },
    status: 'ACTIVE',
    configurationVersion: 1,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * A client as `uid` sees the database.
 *
 * Returned as the rules-testing library's own Firestore type: it is a different
 * declaration from the SDK's, and these tests only need something the SDK
 * document functions accept.
 */
async function asUser(uid: string): Promise<ReturnType<ReturnType<typeof environment.authenticatedContext>['firestore']>> {
  return environment.authenticatedContext(uid).firestore();
}

/**
 * Put a document in place with the rules switched off.
 *
 * These rules deny everything to an anonymous caller — which is correct, and is
 * asserted in its own right — so a fixture cannot be prepared through a client at
 * all. Setup is trusted; every assertion goes through a real signed-in context
 * with the rules on. The helper is the async form, which is the only one this
 * version of the testing library exposes.
 */
async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), data, { merge: true });
  });
}

// ---------------------------------------------------------------------------

let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

async function test(name: string, body: () => Promise<void>): Promise<void> {
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

async function expectDenied(work: Promise<unknown>, message: string): Promise<void> {
  try {
    await work;
  } catch {
    return; // Denied, which is what we needed.
  }
  throw new Error(`${message} (it was allowed)`);
}

// ---------------------------------------------------------------------------

/*
 * The rules are read here rather than named by path.
 *
 * Two reasons, and the second is the one that matters: the emulator must
 * compile the file this test was written against — a path is resolved against
 * whatever directory the runner happened to start in, so a path can silently
 * become a *different or empty* set of rules and the suite still reports on it.
 * Reading the file makes "which rules did this test check" a question with one
 * answer.
 */
// Resolved from this file rather than the working directory, so the suite checks
// the rules in this repository no matter where the runner was started.
const RULES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'firestore.rules');
const RULES_SOURCE = readFileSync(RULES_PATH, 'utf8');

environment = await initializeTestEnvironment({
  projectId: `tradecode-rules-${process.pid}`,
  firestore: { rules: RULES_SOURCE, host: '127.0.0.1', port: 8080 },
});

// ---------------------------------------------------------------------------
// 1. Ownership
// ---------------------------------------------------------------------------

await test('a user can read their own GOAT', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const db = await asUser(OWNER);
  await assertSucceeds(getDoc(doc(db, `users/${OWNER}/goats/g1`)));
});

await test("a user cannot read another user's GOAT", async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const bob = await asUser(OTHER);
  await expectDenied(
    getDoc(doc(bob, `users/${OWNER}/goats/g1`)),
    "another user's document must not be readable",
  );
});

await test("a user cannot list another user's GOATs", async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const bob = await asUser(OTHER);
  await expectDenied(
    getDocs(collection(bob, `users/${OWNER}/goats`)),
    "another user's collection must not be listable",
  );
});

await test('nobody signed in gets nothing', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const anonymous = environment.unauthenticatedContext().firestore();
  await expectDenied(
    getDoc(doc(anonymous, `users/${OWNER}/goats/g1`)),
    'an unauthenticated read must be refused',
  );
});

await test("a document cannot be written into another user's path", async () => {
  const bob = await asUser(OTHER);
  await expectDenied(
    setDoc(doc(bob, `users/${OWNER}/goats/g_stolen`), goat({ ownerId: OTHER })),
    'writing into another user subtree must be refused',
  );
  // And the two halves of the check are independent: a matching ownerId does not
  // buy access to somebody else's path.
  await expectDenied(
    setDoc(doc(bob, `users/${OWNER}/goats/g_stolen`), goat({ ownerId: OWNER })),
    'a correct ownerId in a foreign path must still be refused',
  );
});

// ---------------------------------------------------------------------------
// 2. Required fields and identity
// ---------------------------------------------------------------------------

await test('a GOAT missing a required field is refused', async () => {
  const alice = await asUser(OWNER);
  const { objective, ...withoutObjective } = goat();
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/goats/g_bad`), withoutObjective),
    'a GOAT with no objective must be refused',
  );
});

await test("a GOAT's id, owner and creation time are immutable", async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const alice = await asUser(OWNER);

  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/goats/g1`), { id: 'g_renamed' }),
    'the id must not change',
  );
  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/goats/g1`), { ownerId: OTHER }),
    'the owner must not change',
  );
  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/goats/g1`), { createdAt: now + 1_000 }),
    'the creation time must not change',
  );
  // And a normal edit by its owner must still succeed.
  await assertSucceeds(updateDoc(doc(alice, `users/${OWNER}/goats/g1`), { name: 'Renamed by its owner' }));
});

await test('an unknown status is refused, so a list cannot render an impossible value', async () => {
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/goats/g_bad`), goat({ status: 'VERY_HAPPY' })),
    'an unknown status must be refused',
  );
});

// ---------------------------------------------------------------------------
// 3. The activation invariant
// ---------------------------------------------------------------------------

await test('a deployment cannot become active without claiming the GOAT pointer', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const alice = await asUser(OWNER);

  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d1`), deployment()),
    'an active deployment with no pointer claim must be refused',
  );

  // The GOAT may point at it.
  await assertSucceeds(updateDoc(doc(alice, `users/${OWNER}/goats/g1`), { activeDeploymentId: 'd1' }));
  // And then the deployment may claim the slot.
  await assertSucceeds(setDoc(doc(alice, `users/${OWNER}/deployments/d1`), deployment()));
});

await test('two deployments cannot both be active for one GOAT', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat({ activeDeploymentId: 'd1' }));
  await seed(`users/${OWNER}/deployments/d1`, deployment({ id: 'd1' }));
  const alice = await asUser(OWNER);

  // A second deployment claiming active while the pointer names the first one.
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d2`), deployment({ id: 'd2' })),
    'a second active deployment must be refused',
  );

  // And it is refused even when the caller tries to write the pointer at the same
  // time — no, that one is allowed, because moving the pointer is how you stop
  // d1 and start d2. What must be impossible is claiming d2 without the pointer.
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d3`), deployment({ id: 'd3' })),
    'a third active deployment must also be refused',
  );
});

await test('a paused deployment needs no pointer, so a GOAT can be configured before it runs', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const alice = await asUser(OWNER);
  await assertSucceeds(setDoc(doc(alice, `users/${OWNER}/deployments/d0`), deployment({ id: 'd0', status: 'paused' })));
});

await test('a deployment for a GOAT that does not exist is refused', async () => {
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d9`), deployment({ id: 'd9', goatId: 'ghost', status: 'paused' })),
    'a deployment with no GOAT must be refused',
  );
});

await test('LIVE is not a mode the database will store', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat());
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d_live`), deployment({ id: 'd_live', mode: 'LIVE', status: 'paused' })),
    'LIVE trading must not be storable, because the runtime refuses it',
  );
});

// ---------------------------------------------------------------------------
// 4. Trackers
// ---------------------------------------------------------------------------

await test('a tracker cannot exist without its deployment', async () => {
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d_missing/trackers/t1`), tracker()),
    'a tracker under a deployment that is not there must be refused',
  );
});

await test('a tracker cannot claim a different deployment than the one it is written under', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat({ activeDeploymentId: 'd1' }));
  await seed(`users/${OWNER}/deployments/d1`, deployment());
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/deployments/d1/trackers/t_lie`), tracker({ id: 't_lie', deploymentId: 'd_other' })),
    'the path and the field must agree',
  );
});

await test("a tracker's configuration version cannot go backwards', and identity is fixed", async () => {
  await seed(`users/${OWNER}/goats/g1`, goat({ activeDeploymentId: 'd1' }));
  await seed(`users/${OWNER}/deployments/d1`, deployment());
  await seed(`users/${OWNER}/deployments/d1/trackers/t1`, tracker({ configurationVersion: 3 }));
  const alice = await asUser(OWNER);

  // A forward version must succeed.
  await assertSucceeds(updateDoc(doc(alice, `users/${OWNER}/deployments/d1/trackers/t1`), { configurationVersion: 4 }));
  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/deployments/d1/trackers/t1`), { configurationVersion: 2 }),
    'a backward version must be refused',
  );
  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/deployments/d1/trackers/t1`), { goatId: 'g_other' }),
    'the GOAT must not change',
  );
});

// ---------------------------------------------------------------------------
// 5. History
// ---------------------------------------------------------------------------

await test('history can be appended and read by its owner', async () => {
  const alice = await asUser(OWNER);
  const record = {
    id: 'h1', ownerId: OWNER, kind: 'BACKTEST', subjectId: 'run-1',
    summary: 'GOLD 15m, 3/3 conditions fired.', metrics: { winRate: 0.42 },
    at: now, schemaVersion: 1, createdAt: now, updatedAt: now,
  };
  await assertSucceeds(setDoc(doc(alice, `users/${OWNER}/history/h1`), record));
  await assertSucceeds(getDoc(doc(alice, `users/${OWNER}/history/h1`)));
});

await test('history cannot be rewritten or deleted', async () => {
  const alice = await asUser(OWNER);
  await seed(`users/${OWNER}/history/h1`, {
    id: 'h1', ownerId: OWNER, kind: 'BACKTEST', subjectId: 'run-1',
    summary: 'As it happened.', at: now, schemaVersion: 1, createdAt: now, updatedAt: now,
  });
  await expectDenied(
    updateDoc(doc(alice, `users/${OWNER}/history/h1`), { summary: 'Something better happened.' }),
    'history must not be rewritable',
  );
  await expectDenied(
    deleteDoc(doc(alice, `users/${OWNER}/history/h1`)),
    'history must not be deletable',
  );
});

await test('history with an unknown kind or a huge metric map is refused', async () => {
  const alice = await asUser(OWNER);
  const base = {
    ownerId: OWNER, subjectId: 'run-1', summary: 'x', at: now,
    schemaVersion: 1, createdAt: now, updatedAt: now,
  };
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/history/h_kind`), { ...base, id: 'h_kind', kind: 'GUESS' }),
    'an unknown kind must be refused',
  );
  const huge: Record<string, number> = {};
  for (let index = 0; index < 40; index += 1) huge[`metric_${index}`] = index;
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/history/h_big`), {
      ...base, id: 'h_big', kind: 'BACKTEST', summary: 'x', metrics: huge,
    }),
    'a metric map that is not small must be refused',
  );
});

// ---------------------------------------------------------------------------
// 6. Preferences
// ---------------------------------------------------------------------------

await test('preferences are readable and writable by their owner only', async () => {
  const alice = await asUser(OWNER);
  const bob = await asUser(OTHER);
  const preferences = {
    id: 'current', ownerId: OWNER, defaultModel: 'gemini-2.5-flash',
    schemaVersion: 1, updatedAt: now,
  };
  await assertSucceeds(setDoc(doc(alice, `users/${OWNER}/preferences/current`), preferences));
  await expectDenied(
    getDoc(doc(bob, `users/${OWNER}/preferences/current`)),
    "another user's preferences must not be readable",
  );
});

// ---------------------------------------------------------------------------
// 7. No catch-all
// ---------------------------------------------------------------------------

await test('an unknown collection is denied rather than inherited from a permissive parent', async () => {
  const alice = await asUser(OWNER);
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/secrets/s1`), { id: 's1', ownerId: OWNER }),
    'an unlisted collection must be denied',
  );
  await expectDenied(
    getDocs(collection(alice, `users/${OWNER}/secrets`)),
    'and not listable',
  );
});

await test("a GOAT's own subcollection is denied, so no shape is added by accident", async () => {
  const alice = await asUser(OWNER);
  await seed(`users/${OWNER}/goats/g1`, goat());
  await expectDenied(
    setDoc(doc(alice, `users/${OWNER}/goats/g1/private/p1`), { id: 'p1', ownerId: OWNER }),
    'an unlisted subcollection must be denied',
  );
});

// ---------------------------------------------------------------------------
// 8. The queries the application actually issues
// ---------------------------------------------------------------------------

await test('the GOAT list query the UI runs is allowed, ordered and capped', async () => {
  await seed(`users/${OWNER}/goats/g1`, goat({ id: 'g1', name: 'One' }));
  await seed(`users/${OWNER}/goats/g2`, goat({ id: 'g2', name: 'Two' }));
  const alice = await asUser(OWNER);
  const result = await assertSucceeds(
    getDocs(query(collection(alice, `users/${OWNER}/goats`), orderBy('updatedAt', 'desc'), limit(2))),
  );
  // Both documents share a timestamp in this fixture, so the assertion is about
  // permission and ordering being accepted at all — a query the rules reject is a
  // feature the UI cannot use, whatever it would have returned.
  if (result.size !== 2) throw new Error(`expected 2 GOATs, got ${result.size}`);
});

await test("another user's query is refused even when the shape is identical", async () => {
  const bob = await asUser(OTHER);
  await expectDenied(
    getDocs(query(collection(bob, `users/${OWNER}/goats`), orderBy('updatedAt', 'desc'))),
    'a foreign collection query must be refused',
  );
});

// ---------------------------------------------------------------------------

await environment.cleanup();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error}`);
  throw new Error(`${failures.length} rules test(s) failed.`);
}