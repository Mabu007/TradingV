/**
 * The real Firebase implementation of the contract.
 *
 * ## Lazy, and only when configured
 *
 * The SDK is initialised on first use, not at import. Two reasons, both
 * practical: a build with no Firebase project must not throw while a test is
 * merely loading a module, and a user who never signs in should not pay for a
 * network client they never used. Everything here is created inside `live()`,
 * which is only reached once `configureFirebase` has found a configuration.
 *
 * ## Firestore error handling
 *
 * Firestore reports a permission denial the same way it reports a missing
 * document: `permission-denied` or `not-found`. That is a deliberate part of its
 * security model — a reader must not be able to distinguish "no such document"
 * from "not yours" — so the store does not try to. It surfaces the code, and the
 * rules rather than the client decide what a cross-user read can return.
 *
 * `initializeFirestore` with `persistentLocalCache` is used when available:
 * an offline edit is queued and sent when the connection returns, which is what
 * makes a refresh on a bad connection a queue rather than a lost edit. If the
 * browser has already initialised Firestore — which a hot reload or a second
 * `configureFirebase` call can do — the existing instance is reused rather than
 * thrown over.
 */

import type { FirebaseApp } from 'firebase/app';
import type {
  Auth,
  User,
} from 'firebase/auth';
import type { Firestore, CollectionReference } from 'firebase/firestore';

/*
 * The SDK, loaded on demand.
 *
 * This file used to import `firebase/app`, `firebase/auth` and `firebase/firestore`
 * statically, which put roughly half a megabyte of SDK into the critical bundle of
 * every build — including the ones with no Firebase project at all, which is most
 * developer machines and every test run.
 *
 * These are now type-only imports plus a dynamic `loadSdk()`, so the SDK lands in
 * its own chunk and is fetched only when a configured build first touches auth or
 * the database. The types are still the real ones, so nothing here is typed against
 * a hand-written approximation of the SDK.
 */
interface FirebaseSdk {
  app: typeof import('firebase/app');
  auth: typeof import('firebase/auth');
  firestore: typeof import('firebase/firestore');
}

let sdkPromise: Promise<FirebaseSdk> | undefined;

/** Load the SDK once per tab. */
async function loadSdk(): Promise<FirebaseSdk> {
  sdkPromise ??= Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]).then(([app, auth, firestore]) => ({ app, auth, firestore }));
  return sdkPromise;
}

type Placeholder = never; // removed below


import type {
  AuthSession,
  FirebaseAuthBackend,
  FirebaseBackend,
  FirebaseConfig,
  FirebaseStore,
  OwnedCollection,
  StoreBatch,
} from './contract';
import { ownedPath } from './contract';

/** A Firestore failure, reported with its code rather than swallowed. */
export class FirestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FirestoreError';
  }
}

function firestoreError(error: unknown, what: string): FirestoreError {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'unknown';
  const detail =
    typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error);
  return new FirestoreError(code, `Could not ${what}: ${detail}`, error);
}

function toSession(user: User): AuthSession {
  const createdAt = (user.metadata as { creationTime?: string } | undefined)?.creationTime;
  return {
    uid: user.uid,
    email: user.email ?? '',
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(createdAt ? { createdAt: Date.parse(createdAt) || undefined } : {}),
  };
}

/**
 * Holds the app, auth and Firestore instances for one browser tab.
 *
 * A module-level cache is correct here and not in most places: the Firebase SDK
 * requires a single app per project per tab, and re-initialising it throws. The
 * promise is cached rather than the instances so that two callers racing on the
 * first call share one initialisation instead of one winning and one throwing.
 */
let live: Promise<{ app: FirebaseApp; auth: Auth; store: Firestore }> | null = null;

export function resetFirebaseBackend(): void {
  live = null;
}

/**
 * Initialise — or reuse — the Firebase instances for a configuration.
 *
 * Idempotent by configuration: a second call with the same project returns the same
 * instances rather than attempting a second `initializeApp`, which the SDK rejects.
 * A second call with a *different* project is also refused here rather than
 * silently returning the first project's app, because every document written
 * afterwards would land in the wrong account.
 */
async function instances(config: FirebaseConfig): Promise<{ app: FirebaseApp; auth: Auth; store: Firestore }> {
  const sdk = await loadSdk();

  if (live !== null) {
    const existing = await live;
    const current = (existing.app.options as { projectId?: string }).projectId;
    if (current !== undefined && current !== config.projectId) {
      throw new Error(
        `Firebase is already initialised for project ${current}; it cannot also serve ${config.projectId} in the same tab.`,
      );
    }
    return existing;
  }

  const pending = (async () => {
    const app = sdk.app.getApps().length > 0 ? sdk.app.getApp() : sdk.app.initializeApp(config);
    const auth = sdk.auth.getAuth(app);

    let store: Firestore;
    try {
      // Local persistence, so an edit made offline is queued rather than lost.
      store = sdk.firestore.initializeFirestore(app, { localCache: sdk.firestore.persistentLocalCache() });
    } catch {
      // Already initialised — a hot reload, or a second configureFirebase call.
      store = sdk.firestore.getFirestore(app);
    }
    return { app, auth, store };
  })();

  live = pending;
  return pending;
}

/**
 * Build a backend for a configuration.
 *
 * Returns synchronously, as the contract requires, while the SDK loads behind it.
 * Every method that touches Firebase awaits the load first, so a caller sees a
 * promise that resolves when the work is genuinely done rather than a rejection
 * from an unloaded chunk — which is the failure mode that makes lazy loading look
 * like a bug rather than an optimisation.
 */
export function createFirebaseBackend(config: FirebaseConfig): FirebaseBackend {
  if (!config.apiKey || !config.authDomain || !config.projectId) {
    throw new Error('createFirebaseBackend was called with an incomplete configuration.');
  }

  const ready = (): ReturnType<typeof instances> => instances(config);

  const authBackend: FirebaseAuthBackend = {
    async restore(): Promise<AuthSession | null> {
      const { auth } = await ready();
      const sdk = await loadSdk();
      await sdk.auth.setPersistence(auth, sdk.auth.browserLocalPersistence).catch(() => {
        // A blocked storage quota must not prevent signing in; the session is then
        // kept in memory for this tab, which is worse but still working.
      });
      return auth.currentUser ? toSession(auth.currentUser) : null;
    },

    async createAccount(email: string, password: string): Promise<AuthSession> {
      const { auth } = await ready();
      const sdk = await loadSdk();
      const credential = await sdk.auth.createUserWithEmailAndPassword(auth, email, password);
      return toSession(credential.user);
    },

    async signIn(email: string, password: string): Promise<AuthSession> {
      const { auth } = await ready();
      const sdk = await loadSdk();
      const credential = await sdk.auth.signInWithEmailAndPassword(auth, email, password);
      return toSession(credential.user);
    },

    async signOut(): Promise<void> {
      const { auth } = await ready();
      const sdk = await loadSdk();
      await sdk.auth.signOut(auth);
    },

    async idToken(): Promise<string | null> {
      const { auth } = await ready();
      const user = auth.currentUser;
      if (!user) return null;
      // A fresh token per call rather than a cached one: a token is good for about
      // an hour, and a service that receives an expired one refuses the request.
      return user.getIdToken();
    },

    onChange(listener: (session: AuthSession | null) => void): () => void {
      /*
       * Synchronous unsubscribe over an asynchronous subscription.
       *
       * The contract asks for a function back immediately, and it must genuinely
       * unsubscribe — so the listener is only attached once the SDK has loaded, and
       * a cancellation that arrives first prevents it from ever being attached.
       * The alternative, an async unsubscribe, would mean a caller that no longer
       * exists could still be called.
       */
      let cancelled = false;
      let detach: (() => void) | undefined;
      void (async () => {
        const [{ auth }, sdk] = await Promise.all([ready(), loadSdk()]);
        if (cancelled) return;
        detach = sdk.auth.onAuthStateChanged(auth, (user) => listener(user ? toSession(user) : null));
        if (cancelled) detach();
      })();
      return () => {
        cancelled = true;
        detach?.();
      };
    },
  };

  return {
    kind: 'FIREBASE',
    auth: authBackend,
    store: createFirestoreStore(ready),
  };
}

/** Firestore implementing the store contract, scoped to one user's documents. */
function createFirestoreStore(
  ready: () => ReturnType<typeof instances>,
): FirebaseStore {
  let ownerId: string | null = null;

  /**
   * Bind the store to a user.
   *
   * The store lives for the tab and its path prefix depends on who is signed in, so
   * the owner is bound here rather than passed on every call. A call made while
   * nobody is signed in throws rather than defaulting to an empty path — an
   * unscoped read is exactly the bug this design exists to prevent.
   */
  const bound = (): string => {
    if (ownerId === null) throw new FirestoreError('unauthenticated', 'No user is signed in.');
    return ownerId;
  };

  const store: FirebaseStore = {
    bindUser(uid: string | null): void {
      ownerId = uid;
    },

    /*
     * Staged locally, applied at commit.
     *
     * The contract makes `batch()` synchronous while the SDK is loaded on demand,
     * so the batch cannot reach Firestore until `commit()` — which is also how the
     * SDK itself behaves, so nothing is lost. Staging as plain operations rather
     * than as closures over a `writeBatch` means the batch can be assembled before
     * the SDK exists, and the writes are applied to the real batch in one go.
     */
    batch(): StoreBatch {
      const operations: Array<(batch: ReturnType<FirebaseSdk['firestore']['writeBatch']>, sdk: FirebaseSdk, db: Firestore) => void> = [];
      const pendingReleases: Array<{ goatId: string; at: number; expectedDeploymentId?: string }> = [];

      const batch: StoreBatch = {
        create<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch {
          // merge: false — a batch create must not quietly overwrite.
          operations.push((b, sdk, db) =>
            b.set(sdk.firestore.doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
              merge: false,
            }),
          );
          return batch;
        },
        put<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch {
          operations.push((b, sdk, db) =>
            b.set(sdk.firestore.doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
              merge: false,
            }),
          );
          return batch;
        },
        update<T extends { id: string }>(collection: OwnedCollection, id: string, patch: Partial<T>): StoreBatch {
          operations.push((b, sdk, db) =>
            b.update(sdk.firestore.doc(db, ownedPath(bound(), collection, id)), patch as Record<string, unknown>),
          );
          return batch;
        },
        remove(collection: OwnedCollection, id: string): StoreBatch {
          operations.push((b, sdk, db) => b.delete(sdk.firestore.doc(db, ownedPath(bound(), collection, id))));
          return batch;
        },
        setChild<T extends { id: string }>(
          collection: OwnedCollection,
          parentId: string,
          child: string,
          document: T,
        ): StoreBatch {
          operations.push((b, sdk, db) =>
            b.set(
              sdk.firestore.doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${document.id}`),
              stripId(document),
              { merge: true },
            ),
          );
          return batch;
        },
        removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): StoreBatch {
          operations.push((b, sdk, db) =>
            b.delete(sdk.firestore.doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${id}`)),
          );
          return batch;
        },
        claimActiveDeployment(goatId: string, deploymentId: string, at: number): StoreBatch {
          operations.push((b, sdk, db) =>
            b.update(sdk.firestore.doc(db, ownedPath(bound(), 'goats', goatId)), {
              activeDeploymentId: deploymentId,
              updatedAt: at,
            }),
          );
          return batch;
        },
        releaseActiveDeployment(goatId: string, at: number, expectedDeploymentId?: string): StoreBatch {
          // A release needs a read before it can decide, so it cannot be a plain
          // staged write; it is applied at commit with the other writes, still
          // inside the same atomic batch.
          pendingReleases.push({ goatId, at, expectedDeploymentId });
          return batch;
        },
        async commit(): Promise<void> {
          const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
          const firestoreBatch = sdk.firestore.writeBatch(db);

          /*
           * Releases are resolved here, immediately before the commit, so each
           * decision is made against the state this commit is about to apply to.
           */
          for (const release of pendingReleases) {
            const current = await sdk.firestore.getDoc(
              sdk.firestore.doc(db, ownedPath(bound(), 'goats', release.goatId)),
            );
            const pointer = current.data()?.['activeDeploymentId'];
            if (
              current.exists() &&
              pointer !== undefined &&
              (release.expectedDeploymentId === undefined || pointer === release.expectedDeploymentId)
            ) {
              firestoreBatch.update(sdk.firestore.doc(db, ownedPath(bound(), 'goats', release.goatId)), {
                activeDeploymentId: sdk.firestore.deleteField(),
                updatedAt: release.at,
              });
            }
          }
          pendingReleases.length = 0;

          for (const operation of operations) operation(firestoreBatch, sdk, db);

          // An empty batch is legal and commits as a no-op.
          await firestoreBatch.commit().catch((error: unknown) => {
            throw firestoreError(error, 'commit batch');
          });
        },
      };

      return batch;
    },

    async list<T>(collection: OwnedCollection, options: { limit?: number } = {}): Promise<T[]> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      const base = ownedCollectionRef(sdk, db, collection, bound());
      /*
       * The limit is applied to the ordered query rather than mixed into one
       * constraint list: a limit on an unordered collection is an arbitrary subset,
       * not "the most recent N".
       */
      const ordered = sdk.firestore.query(base, sdk.firestore.orderBy('updatedAt', 'desc'));
      const snapshot = await sdk.firestore
        .getDocs(
          options.limit === undefined
            ? ordered
            : sdk.firestore.query(ordered, sdk.firestore.limit(options.limit)),
        )
        .catch((error: unknown) => {
          throw firestoreError(error, `list ${collection}`);
        });
      return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
    },

    async get<T>(collection: OwnedCollection, id: string): Promise<T | undefined> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      const snapshot = await sdk.firestore
        .getDoc(sdk.firestore.doc(db, ownedPath(bound(), collection, id)))
        .catch((error: unknown) => {
          throw firestoreError(error, `read ${collection}/${id}`);
        });
      return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : undefined;
    },

    async create<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      // create → not createOrMerge: a colliding id is a bug in the caller and
      // silently overwriting a user's GOAT would hide it.
      await sdk.firestore
        .setDoc(sdk.firestore.doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
          merge: false,
        })
        .catch((error: unknown) => {
          throw firestoreError(error, `create ${collection}/${document.id}`);
        });
      return document;
    },

    async set<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      await sdk.firestore
        .setDoc(sdk.firestore.doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
          merge: true,
        })
        .catch((error: unknown) => {
          throw firestoreError(error, `save ${collection}/${document.id}`);
        });
      return document;
    },

    async update<T extends { id: string }>(collection: OwnedCollection, id: string, patch: Partial<T>): Promise<T> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      await sdk.firestore
        .updateDoc(sdk.firestore.doc(db, ownedPath(bound(), collection, id)), patch as Record<string, unknown>)
        .catch((error: unknown) => {
          throw firestoreError(error, `update ${collection}/${id}`);
        });
      const updated = await store.get<T>(collection, id);
      if (!updated) throw new FirestoreError('not-found', `${collection}/${id} disappeared during the update.`);
      return updated;
    },

    async remove(collection: OwnedCollection, id: string): Promise<void> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      await sdk.firestore
        .deleteDoc(sdk.firestore.doc(db, ownedPath(bound(), collection, id)))
        .catch((error: unknown) => {
          throw firestoreError(error, `delete ${collection}/${id}`);
        });
    },

    async listChildren<T>(collection: OwnedCollection, parentId: string, child: string): Promise<T[]> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      const base = ownedCollectionRef(sdk, db, child, bound(), parentId);
      const snapshot = await sdk.firestore
        .getDocs(sdk.firestore.query(base, sdk.firestore.orderBy('createdAt', 'asc')))
        .catch((error: unknown) => {
          throw firestoreError(error, `list ${child}`);
        });
      return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
    },

    async removeChildren(collection: OwnedCollection, parentId: string, child: string): Promise<void> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      const base = ownedCollectionRef(sdk, db, child, bound(), parentId);
      const snapshot = await sdk.firestore.getDocs(base).catch((error: unknown) => {
        throw firestoreError(error, `list ${child}`);
      });
      if (snapshot.empty) return;
      // Batched, in chunks of 500 — Firestore's write limit. A deployment with
      // hundreds of trackers must not fail halfway and leave the rest behind.
      for (let start = 0; start < snapshot.docs.length; start += 500) {
        const batch = sdk.firestore.writeBatch(db);
        for (const document of snapshot.docs.slice(start, start + 500)) batch.delete(document.ref);
        await batch.commit().catch((error: unknown) => {
          throw firestoreError(error, `delete ${child}`);
        });
      }
    },

    async getChild<T>(
      collection: OwnedCollection,
      parentId: string,
      child: string,
      id: string,
    ): Promise<T | undefined> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      const snapshot = await sdk.firestore
        .getDoc(sdk.firestore.doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${id}`))
        .catch((error: unknown) => {
          throw firestoreError(error, `read ${child}/${id}`);
        });
      return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : undefined;
    },

    async setChild<T extends { id: string }>(
      collection: OwnedCollection,
      parentId: string,
      child: string,
      document: T,
    ): Promise<T> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      await sdk.firestore
        .setDoc(
          sdk.firestore.doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${document.id}`),
          stripId(document),
          { merge: true },
        )
        .catch((error: unknown) => {
          throw firestoreError(error, `save ${child}/${document.id}`);
        });
      return document;
    },

    async removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): Promise<void> {
      const [{ store: db }, sdk] = await Promise.all([ready(), loadSdk()]);
      await sdk.firestore
        .deleteDoc(sdk.firestore.doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${id}`))
        .catch((error: unknown) => {
          throw firestoreError(error, `delete ${child}/${id}`);
        });
    },
  };

  return store;
}

/**
 * The collection reference for an owned path, optionally under a parent document.
 *
 * One function builds every path this application reads or writes, so the
 * `users/{uid}/…` shape has exactly one implementation to disagree with the
 * security rules.
 */
function ownedCollectionRef(
  sdk: FirebaseSdk,
  db: Firestore,
  name: string,
  ownerId: string,
  parentId?: string,
): CollectionReference {
  const path =
    parentId === undefined
      ? ownedPath(ownerId, name as OwnedCollection)
      : `${ownedPath(ownerId, name as OwnedCollection, parentId)}/${name}`;
  return sdk.firestore.collection(db, path);
}

/**
 * Drop the document id from the stored fields.
 *
 * In Firestore the id is the document's name, so a copy of it inside the body is a
 * second source of truth that can disagree with the path — the failure this avoids
 * is a read that returns one id and an update that writes to another.
 */
function stripId<T extends { id: string }>(document: T): Omit<T, 'id'> {
  const { id: _ignored, ...fields } = document;
  return fields;
}
