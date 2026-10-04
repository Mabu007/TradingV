/**
 * Application-level wallet interface.
 *
 * TradingGOATs uses Privy for wallet and authentication infrastructure.
 * The rest of the application depends on this interface, not on raw
 * Privy calls, so the provider can be changed without touching the UI or
 * the execution engine.
 *
 * Security boundary:
 *
 *  - A connected wallet is an *identity*, not an execution permission.
 *    It never enables LIVE trading, never bypasses the deterministic
 *    policy/risk layer, and never reaches an agent.
 *  - Nothing in this interface can read a private key, a seed phrase, or
 *    any other signing secret. `signMessage` is a user-facing
 *    authorization gesture through the wallet provider; it is not an
 *    order-signing path and it is not reachable from the agent runtime.
 *  - LIVE execution requires a server-side Hyperliquid signing service
 *    that does not exist yet. The interface therefore has no
 *    `signOrder`, and adding one is deliberately out of scope here.
 */

export type WalletConnectionStatus =
  | 'UNCONFIGURED'
  | 'INITIALISING'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR';

export type SigningCapability =
  /** The provider can request a user-approved message signature. */
  | 'MESSAGE_SIGNING'
  | 'NONE';

export interface WalletState {
  /** Privy is configured with an application id. */
  configured: boolean;
  /** The Privy client has finished initialising. */
  ready: boolean;
  /** The user has an authenticated Privy session. */
  authenticated: boolean;
  status: WalletConnectionStatus;
  /** Primary connected wallet address, or undefined. */
  address?: string;
  /** Shortened form for display, e.g. "0x1234…abcd". */
  shortAddress?: string;
  /** How the wallet is managed, e.g. "privy", "metamask", "wallet_connect". */
  walletClientType?: string;
  signing: SigningCapability;
  /** User-safe message when the provider failed to initialise. */
  error?: string;
  /**
   * Always false. LIVE execution is not implemented, and connecting a
   * wallet does not and cannot change that.
   */
  liveExecutionEnabled: false;
}

export interface WalletService {
  getState(): WalletState;
  /** Opens the provider's connect flow. */
  connect(): Promise<void>;
  /** Disconnects the wallet and clears the session. */
  disconnect(): Promise<void>;
  /**
   * Requests a user-approved message signature.
   *
   * Intentionally absent from the agent capability registry, and not an
   * order-signing path. It exists so the wallet can be proven to sign
   * before any live boundary is built.
   */
  signMessage?(message: string): Promise<string | undefined>;
}

export const DISCONNECTED_WALLET_STATE: WalletState = {
  configured: false,
  ready: false,
  authenticated: false,
  status: 'UNCONFIGURED',
  signing: 'NONE',
  liveExecutionEnabled: false,
};

/** 0x1234…abcd */
export function shortenAddress(address: string | undefined): string | undefined {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Map raw provider state onto the application wallet state.
 *
 * Kept as a pure function so the mapping is testable without a browser
 * wallet session.
 */
export function mapWalletState(input: {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  connecting: boolean;
  address?: string;
  walletClientType?: string;
  error?: string;
}): WalletState {
  const status: WalletConnectionStatus = !input.configured
    ? 'UNCONFIGURED'
    : input.error
      ? 'ERROR'
      : input.connecting
        ? 'CONNECTING'
        : input.address
          ? 'CONNECTED'
          : input.ready
            ? 'DISCONNECTED'
            : 'INITIALISING';

  return {
    configured: input.configured,
    ready: input.ready,
    authenticated: input.authenticated,
    status,
    address: input.address,
    shortAddress: shortenAddress(input.address),
    walletClientType: input.walletClientType,
    signing: input.address ? 'MESSAGE_SIGNING' : 'NONE',
    error: input.error,
    liveExecutionEnabled: false,
  };
}
