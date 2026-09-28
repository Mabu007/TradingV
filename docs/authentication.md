# Authentication & User Management

This document details the user identity architecture and the venue-credential boundary in **TradingVibe**.

---

## 1. User Management Abstraction (`src/services/userService.ts`)

TradingVibe decouples UI components from any specific authentication backend (such as Firebase Auth or custom JWT providers) by establishing a clean service interface:

```ts
export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  tier: "Free" | "Pro" | "VIP";
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
```

---

## 2. Current Implementation: `MockUserService`

In the current development phase, `MockUserService` provides persistent in-browser state:
* Stores user updates in `localStorage` under `tradingvibe_user_profile`.
* Pre-seeded with a default profile (`Gift`, `gtebogo75@gmail.com`, Pro tier).
* Supports immediate UI updates when the user saves edits on the **Profile Screen** (`ProfileView.tsx`).

### Firebase Auth Integration Roadmap
When Firebase Authentication is integrated:
```mermaid
graph LR
    UI[ProfileView / SettingsTab] --> Interface[UserService Interface]
    Interface -.-> Current[MockUserService (localStorage)]
    Interface --> Production[FirebaseUserService (Firebase Auth SDK)]
```
The React UI will interact solely with `UserService`, requiring zero component refactoring when switching from mock to Firebase.

---

## 3. Venue Authentication

**TradingVibe holds no venue credentials.**

Market data is read from Hyperliquid's public REST and WebSocket endpoints,
which require no credentials. There is no OAuth flow, no account token, and no
private key anywhere in this repository, and no code path accepts one.

If a future LIVE environment is implemented, authentication must happen in a
signing service outside the browser: the AI runtime and the client would never
receive, store, or forward signing material.

---

## 4. Status Table

| Subsystem | Status | Implementation File |
|---|---|---|
| User Service Contract | `Implemented` | `src/services/userService.ts` |
| Mock User Persistence | `Implemented` | `src/services/userService.ts` |
| User Profile UI | `Implemented` | `src/components/views/ProfileView.tsx` |
| Desktop Profile Widget | `Implemented` | `src/components/navigation/BottomNav.tsx` |
| Venue Credentials | `None` | not required for public market data; no live execution exists |
| Firebase Auth Provider | `Planned` | `src/services/firebaseUserService.ts` |
