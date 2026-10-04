/**
 * Wallet service boundary.
 *
 * `WalletProvider` and `useWallet` are the only wallet entry points the
 * application should use. Everything else depends on the `WalletService`
 * interface, not on Privy.
 *
 * Signing and live execution
 * --------------------------
 *
 * Browser message signing exists through the wallet provider, but it is
 * an identity gesture only. It is deliberately not an order-signing path:
 *
 *  - There is no `signOrder` on `WalletService`.
 *  - The method is not registered as an agent capability, so the AI
 *    runtime cannot call it.
 *  - LIVE execution stays disabled. A connected wallet does not enable
 *    it, and no code path turns `liveExecutionEnabled` on.
 *
 * Real Hyperliquid order signing for an agent needs a server-side
 * signer that holds the agent wallet. That infrastructure does not exist
 * in this repository, and this interface does not pretend otherwise. See
 * `docs/authentication.md` for the boundary.
 */

export {
  WalletProvider,
  useWallet,
} from './WalletProvider';

export {
  DISCONNECTED_WALLET_STATE,
  mapWalletState,
  shortenAddress,
  type SigningCapability,
  type WalletConnectionStatus,
  type WalletService,
  type WalletState,
} from './types';

export { privySetup, type PrivySetup } from './privyConfig';
