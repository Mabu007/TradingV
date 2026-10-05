import type { AuthSession } from './firebase/auth';
import { firebaseServices, type FirebaseServices } from './firebase/configure';

export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  tier: 'Free' | 'Pro' | 'VIP';
  tradingAccountsCount: number;
  goatsCount: number;
  tradesCount: number;
  createdAt: number;
}

export interface UpdateProfileInput {
  username?: string;
  email?: string;
  avatarUrl?: string;
}

export interface UserService {
  getCurrentUser(): Promise<User>;
  updateProfile(input: UpdateProfileInput): Promise<User>;
  signOut(): Promise<void>;
}

/**
 * Only display fields the signed-in account decides for itself are cached here.
 *
 * `id` is never cached: it is the Firebase `uid`, and a stale copy of an
 * identity in `localStorage` is exactly the kind of thing that outlives a sign-out
 * and then reads the previous account's data. The id is read from the live
 * session every time.
 */
const STORAGE_KEY = 'tradingvibe_user_profile';

interface CachedProfile {
  username?: string;
  avatarUrl?: string;
}

function readCachedProfile(): CachedProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CachedProfile) : {};
  } catch {
    return {};
  }
}

function writeCachedProfile(profile: CachedProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // A profile that cannot be cached is a cosmetic problem, not a failure.
  }
}

/**
 * The signed-out shape.
 *
 * Every field is empty and the id is empty. This used to be a specific person —
 * a name, an email address and a set of counts — which the product displayed as
 * though it were the account using it. A signed-out visitor is nobody, and saying
 * so is the honest answer.
 */
function signedOutUser(): User {
  return {
    id: '',
    username: '',
    email: '',
    avatarUrl: '',
    tier: 'Free',
    tradingAccountsCount: 0,
    goatsCount: 0,
    tradesCount: 0,
    createdAt: 0,
  };
}

/**
 * The signed-in shape, built from the Firebase session.
 *
 * The Firebase `uid` is the id, and the account's own email is the email. The
 * counts are left at zero rather than invented: they are derived from data this
 * layer does not have, and a made-up "127 trades" on a real account is a lie
 * displayed in a product that trades.
 */
function userFromSession(session: AuthSession, cached: CachedProfile): User {
  const handle = session.email.split('@')[0] ?? '';
  return {
    id: session.uid,
    username: cached.username?.trim() || session.displayName?.trim() || handle,
    email: session.email,
    avatarUrl: cached.avatarUrl ?? '',
    tier: 'Free',
    tradingAccountsCount: 0,
    goatsCount: 0,
    tradesCount: 0,
    createdAt: session.createdAt ?? 0,
  };
}

/**
 * The account surface, backed by Firebase Auth.
 *
 * Privy still owns the wallet; this owns *who the person is* for the purposes of
 * data. Reading it from the session rather than from storage is what keeps the
 * two from disagreeing after a sign-out.
 */
class FirebaseUserService implements UserService {
  private services: FirebaseServices;

  constructor(services: FirebaseServices) {
    this.services = services;
  }

  private current(): User {
    const session = this.services.auth.current;
    return session ? userFromSession(session, readCachedProfile()) : signedOutUser();
  }

  async getCurrentUser(): Promise<User> {
    // Restoring the session is idempotent and is what makes a refresh show the
    // signed-in account rather than the signed-out one.
    if (!this.services.auth.current) await this.services.auth.start();
    return this.current();
  }

  async updateProfile(input: UpdateProfileInput): Promise<User> {
    const user = this.current();
    if (!user.id) {
      throw new Error('Sign in before changing your profile.');
    }
    // The email belongs to the auth provider, not to this profile.
    const next: CachedProfile = {
      username: input.username ?? user.username,
      avatarUrl: input.avatarUrl ?? user.avatarUrl,
    };
    writeCachedProfile(next);
    return { ...user, ...next };
  }

  /**
   * Clears the provider's session, not a local flag.
   *
   * The previous mock threw here, because there was no session to clear. Now
   * there is: the sign-out goes through Firebase, and `AuthGate` releases the
   * Firestore binding from the same subscription, so signed-out data is not
   * reachable when this resolves.
   */
  async signOut(): Promise<void> {
    await this.services.auth.signOut();
  }
}

let service: UserService | null = null;

/**
 * The account surface, built once per tab from the same Firebase services the
 * rest of the application uses, so the identity on screen and the uid the data
 * layer is scoped by cannot come from two different sources.
 */
export function userService(): UserService {
  service ??= new FirebaseUserService(firebaseServices());
  return service;
}

/** Test seam: drop the cached service so a new Firebase environment is picked up. */
export function resetUserService(): void {
  service = null;
}
