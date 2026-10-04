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

const STORAGE_KEY = 'tradingvibe_user_profile';

const DEFAULT_USER: User = {
  id: 'usr_tv_01',
  username: 'Gift',
  email: 'gtebogo75@gmail.com',
  avatarUrl: '',
  tier: 'Pro',
  tradingAccountsCount: 2,
  goatsCount: 4,
  tradesCount: 127,
  createdAt: Date.now() - 30 * 86400 * 1000,
};

/**
 * MockUserService provides local persistence and clean async interfaces.
 * When Firebase Auth is added, FirebaseUserService can implement UserService directly.
 */
class MockUserService implements UserService {
  private user: User;

  constructor() {
    this.user = this.loadUser();
  }

  private loadUser(): User {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_USER, ...JSON.parse(stored) };
      }
    } catch (e) {
      // Fallback to default
    }
    return DEFAULT_USER;
  }

  async getCurrentUser(): Promise<User> {
    return { ...this.user };
  }

  async updateProfile(input: UpdateProfileInput): Promise<User> {
    this.user = {
      ...this.user,
      ...input,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user));
    } catch (e) {
      console.warn('Failed to save user profile to localStorage', e);
    }
    return { ...this.user };
  }

  /**
   * Not implemented, and deliberately loud about it.
   *
   * This service is a mock: there is no session, no token, and no caller
   * anywhere in the interface. The previous body was a `console.log`
   * announcing that the user had signed out, which reads in a log as a
   * completed sign-out and would be actively misleading the moment this
   * is pointed at a real provider -- a caller would believe the session
   * was cleared when nothing had happened.
   *
   * When a real identity provider replaces this mock, this must clear the
   * provider's session before resolving.
   */
  async signOut(): Promise<void> {
    throw new Error(
      'signOut is not implemented: this user service is a mock with no session to clear. ' +
      'Wire the real identity provider before calling it.',
    );
  }
}

export const userService = new MockUserService();
