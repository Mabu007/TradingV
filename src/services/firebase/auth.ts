/**
 * Firebase Authentication: registration, sign-in, sign-out, session restoration.
 *
 * ## What "real authentication" means here
 *
 * Credentials belong to Firebase. This module never reads, hashes, stores or
 * compares a password — it hands the email and password to the SDK and takes
 * back a session, and everything it knows about identity comes from that
 * session. There is no local password table anywhere in this file, and there is
 * no "trusted local user" fallback that would let a browser invent an identity:
 * when Firebase is unavailable the application says so and keeps using the
 * device-local stores it already had.
 *
 * ## Why every method is on an injected backend
 *
 * Three things follow from that, all of which matter:
 *
 *   1. The *validation and error mapping* below is testable without a Firebase
 *      project. "A malformed email is rejected before a request is made" and
 *      "an existing account reports the account, not a generic failure" are
 *      properties of this code, and they are checked here rather than by a
 *      human clicking through a live project.
 *   2. The Firebase SDK can be initialised lazily and only when configured, so
 *      a build with no project never pays for the SDK and never throws on
 *      import.
 *   3. Signing out is a *local* act — clear the session, keep the deployments.
 *      That is the behaviour §"logout" has to have, and it is expressed as one
 *      method with one meaning rather than as a spread of `localStorage.clear()`.
 */

import type { AuthSession, FirebaseAuthBackend } from './contract';

export type { AuthSession };

/**
 * Why a sign-up or sign-in did not happen.
 *
 * A discriminated union rather than an `Error` string, because every caller
 * needs to render something different for "that email is already registered"
 * than for "the network is down", and a single error type with a message is how
 * those two end up sharing a generic message.
 */
export type AuthFailure =
  | { code: 'INVALID_EMAIL'; message: string }
  | { code: 'WEAK_PASSWORD'; message: string }
  | { code: 'MISMATCHED_CONFIRMATION'; message: string }
  | { code: 'EMAIL_ALREADY_IN_USE'; message: string }
  | { code: 'INVALID_CREDENTIALS'; message: string }
  | { code: 'EMAIL_NOT_VERIFIED'; message: string }
  | { code: 'TOO_MANY_ATTEMPTS'; message: string }
  | { code: 'NETWORK'; message: string }
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'UNKNOWN'; message: string };

export class AuthError extends Error {
  constructor(readonly failure: AuthFailure) {
    super(failure.message);
    this.name = 'AuthError';
  }
}

/**
 * The minimum a password must be.
 *
 * Firebase's own floor is six characters. This is that floor, stated here so the
 * rule can be tested and so the UI can say it *before* a request is made rather
 * than after it comes back rejected.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * What counts as a malformed email.
 *
 * Deliberately structural rather than a full RFC 5322 implementation: one `@`,
 * something either side of it, a dot in the domain, and no whitespace. A stricter
 * parser rejects addresses the provider accepts, and this application's job is
 * to catch typos, not to adjudicate the specification.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(email: string): AuthFailure | undefined {
  // Not a string at all is treated as empty. A form field that has not been
  // filled in yet is `''`, but a caller that lost the value entirely sends
  // `undefined` — and a sign-in form must not throw on that.
  const value = typeof email === 'string' ? email.trim() : '';
  if (value.length === 0) return { code: 'INVALID_EMAIL', message: 'Enter your email address.' };
  if (!EMAIL_PATTERN.test(value)) {
    return { code: 'INVALID_EMAIL', message: 'That does not look like an email address.' };
  }
  return undefined;
}

export function validatePassword(password: string): AuthFailure | undefined {
  const value = typeof password === 'string' ? password : '';
  if (value.length === 0) return { code: 'WEAK_PASSWORD', message: 'Choose a password.' };
  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      code: 'WEAK_PASSWORD',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters — this is the minimum Firebase accepts.`,
    };
  }
  return undefined;
}

export interface RegisterInput {
  email: string;
  password: string;
  passwordConfirmation: string;
}

/**
 * Everything wrong with a registration, in the order a user would fix it.
 *
 * Returned as a list rather than thrown one at a time, so the form can mark
 * every offending field at once instead of making someone submit three times.
 */
export function validateRegistration(input: RegisterInput): AuthFailure[] {
  const failures: AuthFailure[] = [];
  const email = validateEmail(input.email);
  if (email) failures.push(email);
  const password = validatePassword(input.password);
  if (password) failures.push(password);
  // A mismatched confirmation is checked only once both fields are plausible, so
  // an empty form reports "choose a password" rather than both complaints.
  if (!password && input.password !== input.passwordConfirmation) {
    failures.push({ code: 'MISMATCHED_CONFIRMATION', message: 'The two passwords do not match.' });
  }
  return failures;
}

export function validateSignIn(input: { email: string; password: string }): AuthFailure[] {
  const failures: AuthFailure[] = [];
  const email = validateEmail(input.email);
  if (email) failures.push(email);
  if (typeof input.password !== 'string' || input.password.length === 0) {
    failures.push({ code: 'INVALID_CREDENTIALS', message: 'Enter your password.' });
  }
  return failures;
}

/**
 * Translate a Firebase error code into this product's vocabulary.
 *
 * The mapping is total over the codes this application can cause, and falls
 * back to the provider's own message for anything else rather than swallowing
 * it — an unmapped code that shows nothing is worse than an unmapped code that
 * shows something unexpected.
 */
export function authFailureFromCode(code: string, message?: string): AuthFailure {
  switch (code) {
    case 'auth/invalid-email':
      return { code: 'INVALID_EMAIL', message: 'That does not look like an email address.' };
    case 'auth/missing-password':
    case 'auth/weak-password':
      return {
        code: 'WEAK_PASSWORD',
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters — this is the minimum Firebase accepts.`,
      };
    case 'auth/email-already-in-use':
      return {
        code: 'EMAIL_ALREADY_IN_USE',
        message: 'That email already has an account. Sign in instead.',
      };
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      // One message for all three, on purpose: distinguishing them would tell an
      // attacker which addresses have accounts.
      return { code: 'INVALID_CREDENTIALS', message: 'That email and password do not match an account.' };
    case 'auth/email-not-verified':
      return { code: 'EMAIL_NOT_VERIFIED', message: 'Verify that email address, then sign in.' };
    case 'auth/too-many-requests':
      return { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a moment and try again.' };
    case 'auth/network-request-failed':
      return { code: 'NETWORK', message: 'Could not reach the sign-in service. Check your connection.' };
    case 'auth/operation-not-allowed':
    case 'auth/configuration-not-found':
      return {
        code: 'UNAVAILABLE',
        message: 'Email and password sign-in is not enabled on this Firebase project yet.',
      };
    default:
      return { code: 'UNKNOWN', message: message ?? 'Sign-in failed. Try again.' };
  }
}

function toFailure(error: unknown): AuthFailure {
  if (error instanceof AuthError) return error.failure;
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const message =
    typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : undefined;
  return authFailureFromCode(code, message);
}

/**
 * The authentication surface the application uses.
 *
 * A class rather than a bag of functions so there is exactly one thing that can
 * change who is signed in, and therefore one place where "log out" has to be
 * correct.
 */
export class AuthService {
  private session: AuthSession | null = null;
  private readonly listeners = new Set<(session: AuthSession | null) => void>();

  constructor(
    private readonly backend: FirebaseAuthBackend | undefined,
    /** Why sign-in is unavailable, when it is. Null when it works. */
    readonly unavailableReason: string | null = null,
  ) {}

  /** The current session, or null. Restored once `start()` has been awaited. */
  get current(): AuthSession | null {
    return this.session;
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  /** Whether a request is in flight, so a form can disable itself while it waits. */
  get inFlight(): boolean {
    return this.inFlightCount > 0;
  }
  private inFlightCount = 0;

  /**
   * Restore whatever session the browser already holds.
   *
   * Called once at start-up. A refresh is the case that matters: the session
   * lives in Firebase's own persistence, so a reload comes back signed in
   * without another round trip through the user's password.
   */
  async start(): Promise<AuthSession | null> {
    if (!this.backend) return null;
    this.backend.onChange((session) => this.setSession(session));
    try {
      return this.setSession(await this.backend.restore());
    } catch {
      // A failed restore is not a signed-out state we should assert; it is an
      // unknown one, and the honest answer is "nobody is signed in yet".
      return this.setSession(null);
    }
  }

  async register(input: RegisterInput): Promise<AuthSession> {
    if (!this.backend) throw new AuthError({ code: 'UNAVAILABLE', message: this.unavailableReason ?? 'Sign-in is unavailable.' });

    const failures = validateRegistration(input);
    if (failures.length > 0) throw new AuthError(failures[0]);

    /*
     * The result is passed through `setSession` rather than returned as-is.
     *
     * A successful sign-in has to update this service's own state even when no
     * `start()` ever registered a listener — otherwise the session exists in the
     * backend and is invisible to the application, and every surface that asks
     * `signedIn` disagrees with the one that just signed in.
     */
    return this.track(async () =>
      this.setSession(
        await this.backend!.createAccount(input.email.trim(), input.password).catch((error: unknown) => {
          throw new AuthError(toFailure(error));
        }),
      ),
    );
  }

  async signIn(input: { email: string; password: string }): Promise<AuthSession> {
    if (!this.backend) throw new AuthError({ code: 'UNAVAILABLE', message: this.unavailableReason ?? 'Sign-in is unavailable.' });

    const failures = validateSignIn(input);
    if (failures.length > 0) throw new AuthError(failures[0]);

    // See `register`: the session is recorded here, not only published.
    return this.track(async () =>
      this.setSession(
        await this.backend!.signIn(input.email.trim(), input.password).catch((error: unknown) => {
          throw new AuthError(toFailure(error));
        }),
      ),
    );
  }

  /**
   * Sign out.
   *
   * Local act, and deliberately narrow: the session goes, and with it any
   * cached user-scoped state in this tab — but the deployments, GOATs and
   * history stay in the database under this account, and the runtime tier keeps
   * running. Logging out is not "shut down my GOATs", and a product that
   * conflated the two would stop trading the moment somebody closed a laptop.
   */
  async signOut(): Promise<void> {
    if (!this.backend) {
      this.setSession(null);
      return;
    }
    await this.track(async () => {
      await this.backend!.signOut();
      this.setSession(null);
    });
  }

  subscribe(listener: (session: AuthSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSession<T extends AuthSession | null>(session: T): T {
    this.session = session;
    for (const listener of this.listeners) {
      try {
        listener(session);
      } catch {
        // A surface that throws must not break the session for everyone else.
      }
    }
    // The generic is what lets `signIn` return a non-null session from a setter
    // that also has to handle null; without it the sign-in path would need a
    // non-null assertion, which is exactly the doubt this avoids.
    return session as T;
  }

  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.inFlightCount += 1;
    try {
      return await work();
    } finally {
      this.inFlightCount -= 1;
    }
  }
}