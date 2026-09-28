export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  tier: 'Free' | 'Pro' | 'VIP';
  tradingAccountsCount: number;
  botsCount: number;
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
  botsCount: 4,
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

  async signOut(): Promise<void> {
    // Clear session or token
    console.log('[UserService] User signed out');
  }
}

export const userService = new MockUserService();
