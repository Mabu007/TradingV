# Authentication & Wallet

This document describes the identity architecture of **TradingGOATs**: the
Privy authentication foundation, the application-level wallet interface, and
the boundary that keeps wallet identity separate from trading permission.

---

## 1. Privy as the authentication foundation

TradingGOATs uses [Privy](https://www.privy.io) (`@privy-io/react-auth`) for
wallet and authentication infrastructure. Privy is initialized **once**, at
the application root:

```
src/main.tsx
  └── WalletProvider              # mounts <PrivyProvider> when configured
        └── ConnectedWalletBridge # maps Privy state to the app wallet state
              └── App
```

No component constructs a Privy client of its own. If `VITE_PRIVY_APP_ID` is
not set, the provider is not mounted at all and the application runs in a
permanently disconnected wallet state — wallet sign-in is never required to
use DEMO or BACKTEST.

Privy is used for **identity only** in this build. It is not connected to
order routing.

---

## 2. The application-level wallet interface

Everything outside `src/services/wallet/` depends on the `WalletService`
interface, not on raw Privy calls:

```ts
interface WalletState {
  configured: boolean;      // a Privy application id is present
  ready: boolean;           // the provider finished initialising
  authenticated: boolean;   // a Privy session exists
  status: WalletConnectionStatus;
  address?: string;
  shortAddress?: string;
  walletClientType?: string;
  signing: 'MESSAGE_SIGNING' | 'NONE';
  error?: string;
  liveExecutionEnabled: false;   // always false
}

interface WalletService {
  getState(): WalletState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signMessage?(message: string): Promise<string | undefined>;
}
```

| File | Responsibility |
| ---- | -------------- |
| `src/services/wallet/types.ts` | The application wallet interface and the pure state mapping |
| `src/services/wallet/privyConfig.ts` | Reads the public Privy config and builds the client config |
| `src/services/wallet/WalletProvider.tsx` | Root provider, the `useWallet()` hook, and the Privy binding |
| `src/services/wallet/index.ts` | The only module other code should import |
| `src/config/env.ts` | Every client-visible environment variable |

`useWallet()` returns the disconnected state when no provider is mounted, so
calling code never has to branch on whether Privy is configured.

---

## 3. Five distinct states

The application keeps these separate, and never collapses them:

| State | Meaning | Enables trading? |
| ----- | ------- | ----------------- |
| `UNCONFIGURED` | No Privy application id in the build | No |
| Authenticated | A Privy session exists, no wallet attached | No |
| `CONNECTED` | A wallet address is attached | No |
| `DEMO` / `BACKTEST` | An execution environment is selected | Simulated only |
| `LIVE` | **Not implemented** | Never |

**A connected wallet is an identity, not an execution permission.** It does not
change the execution mode, does not place orders, and does not sign them.

---

## 4. AI security boundary

The AI agent runtime cannot reach the wallet.

* No wallet capability is registered in `CapabilityRegistry`, so no agent
  skill can call one.
* `signMessage` is not a capability and is not in scope for any agent.
* The agent timeline records no key material.
* The agent can propose a trade intent; the deterministic policy and risk
  layers decide whether it is allowed. An agent can never approve, resize, or
  bypass a rejection, and it can never sign or transmit an order.
* No private key, seed phrase, or signing secret is ever placed in a `VITE_`
  variable, in source, or in the agent's observation.

`bun run test:wallet` asserts each of these.

---

## 5. Signing and the Hyperliquid boundary

### What exists

Privy exposes a user-approved **message** signature
(`BaseConnectedEthereumWallet.sign`). It is an identity gesture, and it is
intentionally **not** an order-signing path. There is no `signOrder` on
`WalletService`.

### What is deliberately deferred

Hyperliquid order signing for an agent requires a **server-side signer** that
holds an agent wallet. That infrastructure does not exist in this repository,
and the browser implementation is not presented as production-ready.

The intended boundary:

```
frontend intent
  → deterministic policy
  → deterministic risk
  → execution guard
  → SIGNING BOUNDARY (not implemented)
  → Hyperliquid
```

A future signing service must:

1. run server-side, holding the agent wallet and its encrypted secret;
2. accept only intents that already passed policy, risk, and the guard;
3. re-validate every limit server-side, because a client-side check is
   advisory;
4. never return the private key, seed phrase, or wallet secret to the client
   or to an agent;
5. be reachable only with a verified Privy access token.

The environment variables reserved for that service
(`HYPERLIQUID_API_WALLET`, `HYPERLIQUID_PRIVATE_KEY`,
`HYPERLIQUID_WALLET_SECRET`) are documented as **server-only** in
`.env.example` and are never prefixed with `VITE_`.

---

## 6. User profile service

The pre-existing local profile abstraction is unchanged:

* `src/services/userService.ts` — `UserService` interface and a
  localStorage-backed `MockUserService`.
* `src/components/views/ProfileView.tsx` — profile screen.

It remains separate from the wallet. The wallet address is the user's on-chain
identity; the profile is an in-browser display record. When a real backend
exists, it can validate a Privy access token and return the same `User`
shape, so components need no change.

---

## 7. Status table

| Subsystem | Status | File |
| --------- | ------ | ---- |
| Privy authentication provider | Implemented (root-mounted) | `src/services/wallet/WalletProvider.tsx` |
| Application wallet interface | Implemented | `src/services/wallet/types.ts` |
| Wallet connect / disconnect UI | Implemented | `src/components/views/WalletCard.tsx` |
| Message signing | Implemented, identity only | `src/services/wallet/WalletProvider.tsx` |
| Order signing | **Not implemented, by design** | — |
| Server-side agent signer | **Not implemented** | — |
| LIVE execution | **Not implemented** | — |
| Agent wallet access | **Blocked, and tested** | `src/services/wallet/tests.ts` |
| User profile service | Implemented (local) | `src/services/userService.ts` |
