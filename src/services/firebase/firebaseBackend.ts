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

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  collection as firestoreCollection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  initializeFirestore,
  limit as firestoreLimit,
  orderBy,
  persistentLocalCache,
  query,
  setDoc,
  updateDoc,
  writeBatch,
  type CollectionReference,
  type Firestore,
} from 'firebase/firestore';

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
 * requires a single app per project per tab, and re-initialising it throws.
 */
let live: {
  app: FirebaseApp;
  auth: Auth;
  store: Firestore;
} | null = null;

export function resetFirebaseBackend(): void {
  live = null;
}

/** Whether a live Firebase backend has been initialised in this tab. */
export function firebaseBackendIsLive(): boolean {
  return live !== null;
}

function ensureFirestore(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache() });
  } catch {
    // Already initialised — a reload, or a second configureFirebase call.
    return getFirestore(app);
  }
}


/**
 * Initialise (or reuse) the Firebase backend for a configuration.
 *
 * Throws when called with a configuration that is incomplete, because this is
 * only reached after `configureFirebase` has validated the same values; if the
 * two ever disagree, the error belongs here.
 */
export function createFirebaseBackend(config: FirebaseConfig): FirebaseBackend {
  if (!config.apiKey || !config.authDomain || !config.projectId) {
    throw new Error('createFirebaseBackend was called with an incomplete configuration.');
  }

  if (live === null) {
    const app = getApps().length > 0 ? getApp() : initializeApp(config);
    const auth = getAuth(app);
    const store = ensureFirestore(app);
    live = { app, auth, store };
  }
  const { auth, store } = live;

  const authBackend: FirebaseAuthBackend = {
    async restore(): Promise<AuthSession | null> {
      await setPersistence(auth, browserLocalPersistence).catch(() => {
        // A blocked storage quota must not prevent signing in; the session is
        // then kept in memory for this tab, which is worse but still working.
      });
      return auth.currentUser ? toSession(auth.currentUser) : null;
    },

    async createAccount(email: string, password: string): Promise<AuthSession> {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      return toSession(credential.user);
    },

    async signIn(email: string, password: string): Promise<AuthSession> {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return toSession(credential.user);
    },

    async signOut(): Promise<void> {
      await firebaseSignOut(auth);
    },

    async idToken(): Promise<string | null> {
      // A fresh token per call rather than a cached one: a token is good for about
      // an hour, and a service that receives an expired one refuses the request.
      // Firebase refreshes it for free when it is close to expiry.
      const user = auth.currentUser;
      return user ? user.getIdToken() : null;
    },

    onChange(listener: (session: AuthSession | null) => void): () => void {
      // Firebase's own listener, so a session lost to an expiry or a revoked
      // token reaches the application without anybody polling for it.
      return onAuthStateChanged(auth, (user) => listener(user ? toSession(user) : null));
    },
  };

  return {
    kind: 'FIREBASE',
    auth: authBackend,
    store: createFirestoreStore(store),
  };
}

/** Firestore implementing the store contract, scoped to one user's documents. */
function createFirestoreStore(db: Firestore): FirebaseStore {
  let ownerId: string | null = null;

  /**
   * Bind the store to a user.
   *
   * The store is created once per tab, and its path prefix depends on who is
   * signed in, so the owner is set here rather than passed on every call. A call
   * made while nobody is signed in throws rather than defaulting to an empty
   * path — an unscoped read is exactly the bug this design exists to prevent.
   */
  const bound = (): string => {
    if (ownerId === null) throw new FirestoreError('unauthenticated', 'No user is signed in.');
    return ownerId;
  };

  const store: FirebaseStore = {
    bindUser(uid: string | null): void {
      ownerId = uid;
    },

    batch(): StoreBatch {
      /*
       * A real `writeBatch`, staged as calls are made.
       *
       * Staging into the batch object — rather than collecting closures and
       * applying them one by one on commit — is what makes this atomic. A
       * closure list would apply each write separately, which is exactly the
       * window the rules cannot tolerate: the deployment's status and the GOAT's
       * activation pointer are only meaningful if they land together.
       *
       * Firestore caps a batch at 500 writes. Nothing in this application
       * approaches that — an activation is two documents — but a cascade delete
       * uses `removeChildren`, which chunks deliberately.
       */
      const firestoreBatch = writeBatch(db);
      const pendingReleases: Array<{ goatId: string; at: number; expectedDeploymentId?: string }> = [];

      const batch: StoreBatch = {
        create<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch {
          // merge: false — a batch create must not quietly overwrite.
          firestoreBatch.set(doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
            merge: false,
          });
          return batch;
        },
        put<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch {
          firestoreBatch.set(doc(db, ownedPath(bound(), collection, document.id)), stripId(document), {
            merge: false,
          });
          return batch;
        },
        update<T extends { id: string }>(collection: OwnedCollection, id: string, patch: Partial<T>): StoreBatch {
          firestoreBatch.update(doc(db, ownedPath(bound(), collection, id)), patch as Record<string, unknown>);
          return batch;
        },
        remove(collection: OwnedCollection, id: string): StoreBatch {
          firestoreBatch.delete(doc(db, ownedPath(bound(), collection, id)));
          return batch;
        },
        setChild<T extends { id: string }>(
          collection: OwnedCollection,
          parentId: string,
          child: string,
          document: T,
        ): StoreBatch {
          const path = `${ownedPath(bound(), collection, parentId)}/${child}/${document.id}`;
          firestoreBatch.set(doc(db, path), stripId(document), { merge: true });
          return batch;
        },
        removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): StoreBatch {
          firestoreBatch.delete(doc(db, `${ownedPath(bound(), collection, parentId)}/${child}/${id}`));
          return batch;
        },
        /**
         * Release the pointer, only when it still names what the caller expects.
         *
         * The read happens inside `commit`, after the batch has been assembled,
         * so a stale tab that is stopping an old deployment cannot release a
         * pointer a newer tab has since claimed. Firestore has no conditional
         * update, so this is a read-then-write: there is still a theoretical
         * interleaving, and it is accepted deliberately — the alternative is a
         * transaction, which would make every stop a serialisable write against
         * the GOAT document.
         */
        releaseActiveDeployment(goatId: string, at: number, expectedDeploymentId?: string): StoreBatch {
          pendingReleases.push({ goatId, at, expectedDeploymentId });
          return batch;
        },

        claimActiveDeployment(goatId: string, deploymentId: string, at: number): StoreBatch {
          firestoreBatch.update(doc(db, ownedPath(bound(), 'goats', goatId)), {
            activeDeploymentId: deploymentId,
            updatedAt: at,
          });
          return batch;
        },

        async commit(): Promise<void> {
          /*
           * Releases are staged rather than written, because each one needs a
           * read first. Each read happens here, immediately before the commit,
           * so the decision is made against the state this commit will apply to.
           */
          for (const release of pendingReleases) {
            const current = await getDoc(doc(db, ownedPath(bound(), 'goats', release.goatId)));
            const pointer = current.data()?.['activeDeploymentId'];
            if (
              current.exists() &&
              pointer !== undefined &&
              (release.expectedDeploymentId === undefined || pointer === release.expectedDeploymentId)
            ) {
              firestoreBatch.update(doc(db, ownedPath(bound(), 'goats', release.goatId)), {
                activeDeploymentId: deleteField(),
                updatedAt: release.at,
              });
            }
          }
          pendingReleases.length = 0;

          // An empty batch is legal and commits as a no-op.
          await firestoreBatch.commit().catch((error: unknown) => {
            throw firestoreError(error, 'commit batch');
          });
        },
      };

      return batch;
    },

    async list<T>(collection: OwnedCollection, options: { limit?: number } = {}): Promise<T[]> {
      const base = ownedCollectionRef(db, collection, bound());
      // A CollectionReference *is* a Query in the SDK, so ordering comes first
      // and the limit is applied to the ordered query. A limit on an unordered
      // collection is an arbitrary subset, not "the most recent N".
      const ordered = query(base, orderBy('updatedAt', 'desc'));
      const snapshot = await getDocs(
        options.limit === undefined ? ordered : query(ordered, firestoreLimit(options.limit)),
      ).catch((error: unknown) => {
        throw firestoreError(error, `list ${collection}`);
      });
      return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
    },

    async get<T>(collection: OwnedCollection, id: string): Promise<T | undefined> {
      const snapshot = await getDoc(doc(db, ownedPath(bound(), collection, id))).catch((error: unknown) => {
        throw firestoreError(error, `read ${collection}/${id}`);
      });
      return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : undefined;
    },

    async create<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
      // create → not createOrMerge: a colliding id is a bug in the caller and
      // silently overwriting a user's GOAT would hide it.
      await setDoc(doc(db, ownedPath(bound(), collection, document.id)), stripId(document), { merge: false }).catch(
        (error: unknown) => {
          throw firestoreError(error, `create ${collection}/${document.id}`);
        },
      );
      return document;
    },

    async set<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
      await setDoc(doc(db, ownedPath(bound(), collection, document.id)), stripId(document), { merge: true }).catch(
        (error: unknown) => {
          throw firestoreError(error, `save ${collection}/${document.id}`);
        },
      );
      return document;
    },

    async update<T extends { id: string }>(
      collection: OwnedCollection,
      id: string,
      patch: Partial<T>,
    ): Promise<T> {
      await updateDoc(doc(db, ownedPath(bound(), collection, id)), patch as Record<string, unknown>).catch(
        (error: unknown) => {
          throw firestoreError(error, `update ${collection}/${id}`);
        },
      );
      const updated = await store.get<T>(collection, id);
      if (!updated) throw new FirestoreError('not-found', `${collection}/${id} disappeared during the update.`);
      return updated;
    },

    async remove(collection: OwnedCollection, id: string): Promise<void> {
      await deleteDoc(doc(db, ownedPath(bound(), collection, id))).catch((error: unknown) => {
        throw firestoreError(error, `delete ${collection}/${id}`);
      });
    },

    async listChildren<T>(
      collection: OwnedCollection,
      parentId: string,
      child: string,
    ): Promise<T[]> {
      const base = ownedCollectionRef(db, child, bound(), parentId);
      const snapshot = await getDocs(query(base, orderBy('createdAt', 'asc'))).catch((error: unknown) => {
        throw firestoreError(error, `list ${child}`);
      });
      return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
    },

    async removeChildren(collection: OwnedCollection, parentId: string, child: string): Promise<void> {
      const base = ownedCollectionRef(db, child, bound(), parentId);
      const snapshot = await getDocs(base).catch((error: unknown) => {
        throw firestoreError(error, `list ${child}`);
      });
      if (snapshot.empty) return;
      // Batched, in chunks of 500 — Firestore's write limit. A deployment with
      // hundreds of trackers must not fail halfway and leave the rest behind.
      for (let start = 0; start < snapshot.docs.length; start += 500) {
        const batch = writeBatch(db);
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
      const snapshot = await getDoc(doc(db, ownedPath(bound(), collection, parentId) + `/${child}/${id}`)).catch(
        (error: unknown) => {
          throw firestoreError(error, `read ${child}/${id}`);
        },
      );
      return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : undefined;
    },

    async setChild<T extends { id: string }>(
      collection: OwnedCollection,
      parentId: string,
      child: string,
      document: T,
    ): Promise<T> {
      await setDoc(
        doc(db, ownedPath(bound(), collection, parentId) + `/${child}/${document.id}`),
        stripId(document),
        { merge: true },
      ).catch((error: unknown) => {
        throw firestoreError(error, `save ${child}/${document.id}`);
      });
      return document;
    },

    async removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): Promise<void> {
      await deleteDoc(doc(db, ownedPath(bound(), collection, parentId) + `/${child}/${id}`)).catch(
        (error: unknown) => {
          throw firestoreError(error, `delete ${child}/${id}`);
        },
      );
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
  db: Firestore,
  name: string,
  ownerId: string,
  parentId?: string,
): CollectionReference {
  const path =
    parentId === undefined
      ? ownedPath(ownerId, name as OwnedCollection)
      : `${ownedPath(ownerId, name as OwnedCollection, parentId)}/${name}`;
  return firestoreCollection(db, path);
}

/**
 * Drop the document id from the stored fields.
 *
 * In Firestore the id is the document's name, so a copy of it inside the body is
 * a second source of truth that can disagree with the path — the failure this
 * avoids is a read that returns one id and an update that writes to another.
 */
function stripId<T extends { id: string }>(document: T): Omit<T, 'id'> {
  const { id: _ignored, ...fields } = document;
  return fields;
}
