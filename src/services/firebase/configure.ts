/**
 * Where the Firebase pieces are put together.
 *
 * ## One seam, called once, with a fallback
 *
 * `configureFirebase` reads the environment, decides whether sign-in is possible,
 * and hands back the two services the application uses. It is the only place that
 * knows both exist.
 *
 * The important property is what happens when Firebase is *not* configured:
 *
 * ```
 *   configured    AuthService   PersistenceService   behaviour
 *   ────────────  ────────────  ────────────────────  ─────────────────────────
 *   yes           real          real                 signed in, data in Firestore
 *   no            inert         inert                exactly the product that
 *                                                     shipped before: no account,
 *                                                     data on this device, and a
 *                                                     stated reason why
 * ```
 *
 * The inert services are real objects that fail with a clear reason, not `null`s
 * scattered through the call sites and not a silently swapped local implementation.
 * "Unavailable" is a state this product can be in; it is not an error condition,
 * and it must never read as success.
 */

import {
  AuthService,
  type AuthFailure,
  type AuthSession,
} from './auth';
import { PersistenceService } from './persistence';
import {
  firebaseConfigFromEnv,
  type FirebaseBackend,
  type FirebaseStore,
} from './contract';
import { createFirebaseBackend } from './firebaseBackend';

export interface FirebaseServices {
  auth: AuthService;
  data: PersistenceService;
  /** Non-null when Firebase is not usable, and explains why in one sentence. */
  unavailableReason: string | null;
  /** True when a real backend exists behind these services. */
  configured: boolean;
  /**
   * The live SDK, when one exists. Exposed for the surfaces that need to talk to
   * something Firebase-specific — App Check, an emulator connection — and null
   * otherwise, so no caller has to import the SDK to ask.
   */
  backend: FirebaseBackend | null;
  /** Release the live SDK's tab-scoped instances. For tests and sign-out paths. */
  dispose(): void;
}

let services: FirebaseServices | null = null;

/**
 * Build the services from an environment.
 *
 * Defaults to the Vite environment, but takes one explicitly so the tests can
 * exercise both the configured and unconfigured paths without touching a real
 * `.env`.
 */
export function configureFirebase(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<string, string | undefined>,
): FirebaseServices {
  /*
   * One set of services per tab.
   *
   * Calling this twice used to build two independent stacks — two `AuthService`s,
   * two session subscriptions — while this module's own comment claimed there was
   * exactly one. The failure was invisible and severe: `main.tsx` passes a
   * configured instance to the auth gate, and because `import App` is hoisted
   * above that call, `App.tsx`'s module scope had already built a *different*
   * one. Sign-in worked on the gate's copy, so the application looked correctly
   * authenticated, while everything listening on the other copy — the Firestore
   * data path — never saw a session and quietly persisted nothing.
   *
   * An explicit environment still builds fresh services, which is what the tests
   * rely on to exercise both the configured and unconfigured paths.
   */
  const explicitEnv = arguments.length > 0;
  if (!explicitEnv && services !== null) return services;

  const resolved = firebaseConfigFromEnv(env);

  if ('unavailable' in resolved) {
    services = {
      auth: new AuthService(undefined, resolved.unavailable),
      data: new PersistenceService(undefined, () => Date.now(), resolved.unavailable),
      unavailableReason: resolved.unavailable,
      configured: false,
      backend: null,
      dispose: () => {
        services = null;
      },
    };
    return services;
  }

  let backend: FirebaseBackend;
  try {
    backend = createFirebaseBackend(resolved.config);
  } catch (error) {
    // A project that is configured but unreachable, or an app that another call
    // already initialised with a different project. Neither is fatal, and both
    // must be reported rather than swallowed.
    const reason = `Firebase could not be initialised: ${error instanceof Error ? error.message : String(error)}`;
    services = {
      auth: new AuthService(undefined, reason),
      data: new PersistenceService(undefined, () => Date.now(), reason),
      unavailableReason: reason,
      configured: false,
      backend: null,
      dispose: () => {
        services = null;
      },
    };
    return services;
  }

  const store = backend.store;

  /**
   * Keep the store's owner in step with the session.
   *
   * Both directions matter. Signing in scopes every subsequent read and write to
   * that account; signing out *unscopes* it, so a stale reference cannot keep
   * reading the last user's documents after the tab has moved on. That is the
   * difference between a session boundary and a login button.
   */
  const bindStoreToSession = (session: AuthSession | null): void => {
    (store as FirebaseStore).bindUser(session?.uid ?? null);
  };

  const auth = new AuthService(backend.auth);
  auth.subscribe(bindStoreToSession);

  services = {
    auth,
    data: new PersistenceService(store),
    unavailableReason: null,
    configured: true,
    backend,
    dispose: () => {
      bindStoreToSession(null);
      auth.subscribe(bindStoreToSession);
      services = null;
    },
  };
  return services;
}

/**
 * The services, building them on first use.
 *
 * Exists so a component deep in the tree can reach the services without every
 * ancestor threading them through props — and so there is exactly one set of
 * services per tab, which is what makes a session change observable in one place.
 */
export function firebaseServices(): FirebaseServices {
  return services ?? configureFirebase();
}

/**
 * Drop the tab's services so the next call builds them afresh.
 *
 * For tests, which need to exercise both the configured and unconfigured paths in
 * one process. Production has no reason to call it: the services are meant to
 * live for the tab.
 */
export function resetFirebaseServices(): void {
  if (services) services.dispose();
  services = null;
}

/** Whether the application can offer sign-in at all. */
export function signInAvailable(): boolean {
  return services === null ? false : services.configured;
}

/**
 * What the sign-in surface should show, ready to render.
 *
 * A small helper rather than each surface assembling its own copy, so "Firebase
 * is not configured" reads identically wherever somebody meets it.
 */
export function unavailableNotice(reason: string | null): string | null {
  if (reason === null) return null;
  return `${reason} Everything else on this device keeps working.`;
}

export type { AuthFailure };