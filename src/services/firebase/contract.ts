/**
 * Firebase configuration and the seam everything else goes through.
 *
 * ## What this repository already had
 *
 * Nothing. There was no Firebase dependency, no Firebase config and no auth
 * code; the only identity integration was Privy, which is a wallet login rather
 * than an account, and the only persistence was `localStorage` through
 * `PersistentJsonStore`. So this is a new seam, not a completed one — and it is
 * built as one deliberately:
 *
 *   - **Configuration is optional and checked, not assumed.** A build with no
 *     Firebase environment is a working build. It runs exactly as it did before,
 *     because "Firebase is not configured" is a state the application handles
 *     rather than a crash it throws.
 *   - **No module-level singleton that cannot be replaced.** Every consumer
 *     takes its backend from `configureFirebase`, which means a test can run the
 *     real auth and persistence logic against a double, and a browser can run it
 *     against the real SDK, with no branch in between.
 *
 * ## Why Firestore
 *
 * The alternative in the SDK is Realtime Database. This product's data is
 * documents with identity and history — a GOAT definition, a deployment, a
 * tracker configuration, a backtest record — read as whole documents, written as
 * whole documents, and authorised per user. That is what Firestore is for.
 * Realtime Database would be a better fit for a high-frequency counter or a
 * deeply nested live feed, and this repository has neither: the high-frequency
 * state belongs in the Durable Object tier, not in the database.
 */

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

/**
 * The backend contract the application actually depends on.
 *
 * Small on purpose. It is the smallest surface that supports the product's real
 * requirements — email/password credentials held by Firebase, a session that
 * survives a refresh, and document CRUD scoped to the signed-in user — and
 * nothing in it is achievable by reimplementing it locally. Passwords are never
 * written to the database, and no method here accepts one.
 */
export interface FirebaseBackend {
  readonly kind: 'FIREBASE';
  auth: FirebaseAuthBackend;
  readonly store: FirebaseStore;
}

export interface FirebaseAuthBackend {
  /** Resolves the session a browser already holds, if there is one. */
  restore(): Promise<AuthSession | null>;
  createAccount(email: string, password: string): Promise<AuthSession>;
  signIn(email: string, password: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  /** Fires whenever the session is established or lost, including on expiry. */
  onChange(listener: (session: AuthSession | null) => void): () => void;
  /**
   * A signed proof of the current session, for another service to verify.
   *
   * This is the only thing a browser may present to a service that needs to know
   * who it is talking to. It exists because the alternative — a shared secret in
   * the bundle — is a secret everybody has: every deployed copy of the
   * application would carry it.
   *
   * Null when nobody is signed in.
   */
  idToken(): Promise<string | null>;
}

/**
 * A batch of writes committed atomically.
 *
 * It exists for one reason, and it is a rules requirement rather than a
 * convenience. Activating a deployment has to write two documents in one
 * atomic step — the deployment's status and the GOAT's `activeDeploymentId` —
 * because that pairing is how "one active deployment per GOAT" is enforced in the
 * database instead of merely requested by the client. Two separate writes would
 * leave a window in which either could succeed alone.
 */
export interface StoreBatch {
  /**
   * A create, not a merge.
   *
   * Named `create` rather than `set` because that is what it means: within a
   * batch, overwriting a colliding id would hide a caller bug rather than report
   * it.
   */
  create<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch;
  /**
   * Write a complete document, creating or replacing it.
   *
   * Distinct from `create` because the activation path needs both: creating a
   * deployment writes a document that does not exist yet, while moving an existing
   * one to active writes the same document again as part of a two-document batch.
   * Using `create` for the second case would refuse a document it is meant to
   * update; using `create` semantics for the first case would hide an id collision.
   */
  put<T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch;
  update<T extends { id: string }>(collection: OwnedCollection, id: string, patch: Partial<T>): StoreBatch;
  remove(collection: OwnedCollection, id: string): StoreBatch;
  setChild<T extends { id: string }>(
    collection: OwnedCollection,
    parentId: string,
    child: string,
    document: T,
  ): StoreBatch;
  removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): StoreBatch;

  /**
   * Point a GOAT at the deployment that is becoming active.
   *
   * A named operation rather than a raw update so that the pairing with the
   * deployment write cannot be forgotten: there is no way to activate a
   * deployment without it, and the rules reject the attempt otherwise.
   */
  claimActiveDeployment(goatId: string, deploymentId: string, at: number): StoreBatch;

  /**
   * Clear the pointer, but only if it still names a specific deployment.
   *
   * `expectedDeploymentId` is checked by the store where it can be, so a stale
   * tab stopping an old deployment cannot release a pointer that has since been
   * claimed by a new one. A store with no read capability clears unconditionally
   * and says so.
   */
  releaseActiveDeployment(goatId: string, at: number, expectedDeploymentId?: string): StoreBatch;

  /** Applies every staged write, or none of them. */
  commit(): Promise<void>;
}

export interface FirebaseStore {
  /** Opens a batch scoped to the same user as this store. */
  batch(): StoreBatch;
  /**
   * Scope this store to a signed-in user, or unscope it on sign-out.
   *
   * The store lives for the tab, the path prefix depends on who is signed in, so
   * the owner is bound once. Every method that touches data refuses to run while
   * it is unbound, which is what makes an unscoped read impossible rather than
   * merely discouraged.
   */
  bindUser(uid: string | null): void;
  /** Reads a collection, ordered by `updatedAt` descending. */
  list<T>(collection: OwnedCollection, options?: { limit?: number }): Promise<T[]>;
  get<T>(collection: OwnedCollection, id: string): Promise<T | undefined>;
  create<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T>;
  set<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T>;
  update<T extends { id: string }>(collection: OwnedCollection, id: string, patch: Partial<T>): Promise<T>;
  remove(collection: OwnedCollection, id: string): Promise<void>;
  /**
   * Reads every child collection of a document.
   *
   * Used for the one hierarchy this product has — a deployment's trackers — so a
   * deployment can be read as one unit rather than by fanning out N queries.
   */
  listChildren<T>(collection: OwnedCollection, parentId: string, child: string): Promise<T[]>;
  removeChildren(collection: OwnedCollection, parentId: string, child: string): Promise<void>;

  /**
   * The one hierarchy this product has: a deployment's trackers.
   *
   * Sub-collection methods rather than a path string on the general methods,
   * so a caller cannot invent a hierarchy this application does not have — the
   * shape of the data is decided in one place.
   */
  getChild<T>(collection: OwnedCollection, parentId: string, child: string, id: string): Promise<T | undefined>;
  setChild<T extends { id: string }>(
    collection: OwnedCollection,
    parentId: string,
    child: string,
    document: T,
  ): Promise<T>;
  removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): Promise<void>;
}

/** The signed-in user, and nothing about them that Firebase does not own. */
export interface AuthSession {
  uid: string;
  email: string;
  displayName?: string;
  /** Real time, for a surface that shows "signed in 3 days ago". */
  createdAt?: number;
}

/**
 * The product data this application persists, and the shape of each record.
 *
 * Every collection is *owned*: the path is `users/{uid}/…`, so a Firestore rule
 * can deny cross-user reads without the application having to remember to
 * check. That is the difference between authorisation and the appearance of it.
 */
export const OWNED_COLLECTIONS = [
  'goats',
  'deployments',
  'trackers',
  'history',
  'preferences',
] as const;

export type OwnedCollection = (typeof OWNED_COLLECTIONS)[number];

/** Schema version, so a future migration knows what it is looking at. */
export const SCHEMA_VERSION = 1;

/**
 * A GOAT definition, as durable product data.
 *
 * Deliberately a *definition*: what the agent is for and how it is configured.
 * Its runtime — trackers armed, cooldowns, pending wakes — is not here. See the
 * state-boundary note in `persistence.ts`.
 */
export interface GoatRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  /** The user's objective, in their own words. */
  objective: string;
  /** The agent's reading of it, when it has made one. */
  interpretation?: string;
  symbols: string[];
  /** Every resolution this GOAT may read, setup first. */
  timeframes: string[];
  skillIds: string[];
  /** Capability ids resolved from the skills above, kept so a replay can rebuild. */
  capabilityIds?: string[];
  /** Risk configuration, as the deployment policy that enforced it. */
  risk?: {
    maxRiskPerTrade: number;
    maxDailyLoss?: number;
    maxDrawdown?: number;
    maxOpenPositions: number;
    maxExposure: number;
  };
  /** Model preference for this GOAT, when it differs from the account default. */
  ai?: { provider?: string; model?: string };
  schemaVersion: number;
  status: 'UNDEPLOYED' | 'MONITORING' | 'PAUSED' | 'ARCHIVED';
  /**
   * The one deployment allowed to be active for this GOAT.
   *
   * This pointer is the whole single-active guarantee, and it lives on the GOAT
   * because that is the only place the database can express it: Firestore rules
   * cannot query a collection, so "no other deployment is active" is not
   * checkable, while "this pointer names this deployment" is. See `firestore.rules`.
   */
  activeDeploymentId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A deployment: one GOAT pointed at one market under one mode. */
export interface DeploymentRecord {
  id: string;
  ownerId: string;
  goatId: string;
  market: string;
  timeframe: string;
  /** SHADOW or DEMO. LIVE is refused by the runtime, so it is not a value here. */
  mode: 'SHADOW' | 'DEMO';
  status: 'active' | 'paused' | 'stopped';
  /** The wallet/account this deployment trades against, when it has one. */
  accountId?: string;
  venueEnvironment?: string;
  /** Tracker ids, so a deployment can be read as one unit. */
  trackerIds?: string[];
  configuration?: Record<string, number | string | boolean>;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** A tracker's configuration — durable, and independent of its runtime state. */
export interface TrackerRecord {
  id: string;
  ownerId: string;
  deploymentId: string;
  goatId: string;
  thesisId?: string;
  purpose: string;
  kind: string;
  /** The resolution it watches. */
  timeframe: string;
  config: Record<string, unknown>;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';
  /** Bumped on every edit; the runtime tier keys its work on it. */
  configurationVersion: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Durable user-facing history.
 *
 * Backtest runs, deployment transitions and Trade Plan history belong here
 * because a user expects them to still exist next week. Market ticks and agent
 * log lines do not, and writing them here would turn the database into a
 * firehose that costs money and answers nothing.
 */
export interface HistoryRecord {
  id: string;
  ownerId: string;
  kind: 'BACKTEST' | 'DEPLOYMENT' | 'TRADE_PLAN' | 'WALLET';
  /** The thing this record is about. */
  subjectId: string;
  /** A short summary for a list, never the whole run. */
  summary: string;
  /** A small, bounded metric set — the headline numbers a list would show. */
  metrics?: Record<string, number | string>;
  at: number;
  schemaVersion: number;
}

/** Account-level preferences that belong to the user rather than a GOAT. */
export interface PreferenceRecord {
  id: string;
  ownerId: string;
  /** Which model the account uses when a GOAT has no preference of its own. */
  defaultModel?: string;
  /** Reduced motion, dense log, and so on. Presentation, not trading. */
  preferences?: Record<string, boolean | string | number>;
  schemaVersion: number;
  updatedAt: number;
}

/**
 * Read the configuration from the environment, or explain why there is none.
 *
 * Returning `null` rather than throwing is deliberate: a developer running this
 * with no Firebase project should get the application it always had, not an
 * error page. What they must not get is a *false* success — so the reason is
 * kept and rendered by the surfaces that need to say "sign-in is unavailable".
 */
export function firebaseConfigFromEnv(
  env: Record<string, string | undefined>,
): { config: FirebaseConfig } | { unavailable: string } {
  const apiKey = env['VITE_FIREBASE_API_KEY'];
  const authDomain = env['VITE_FIREBASE_AUTH_DOMAIN'];
  const projectId = env['VITE_FIREBASE_PROJECT_ID'];

  const missing: string[] = [];
  if (!apiKey) missing.push('VITE_FIREBASE_API_KEY');
  if (!authDomain) missing.push('VITE_FIREBASE_AUTH_DOMAIN');
  if (!projectId) missing.push('VITE_FIREBASE_PROJECT_ID');
  if (missing.length > 0) {
    return {
      unavailable: `Firebase is not configured (${missing.join(', ')}). Sign-in is unavailable and data stays on this device.`,
    };
  }

  return {
    config: {
      apiKey: apiKey as string,
      authDomain: authDomain as string,
      projectId: projectId as string,
      ...(env['VITE_FIREBASE_STORAGE_BUCKET'] ? { storageBucket: env['VITE_FIREBASE_STORAGE_BUCKET'] } : {}),
      ...(env['VITE_FIREBASE_MESSAGING_SENDER_ID']
        ? { messagingSenderId: env['VITE_FIREBASE_MESSAGING_SENDER_ID'] }
        : {}),
      ...(env['VITE_FIREBASE_APP_ID'] ? { appId: env['VITE_FIREBASE_APP_ID'] } : {}),
    },
  };
}

/**
 * The path prefix every owned document lives under.
 *
 * Exported because the security rules encode the same shape, and a test asserts
 * that this function and the rules agree. Two implementations of "where a user's
 * data lives" is how a permission bug starts.
 */
export function ownedPath(ownerId: string, collection: OwnedCollection, id?: string): string {
  return id === undefined
    ? `users/${ownerId}/${collection}`
    : `users/${ownerId}/${collection}/${id}`;
}