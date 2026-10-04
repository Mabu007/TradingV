import React, { createContext, useContext, useMemo, useState } from 'react';
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  type BaseConnectedEthereumWallet,
  type BaseConnectedWallet,
  type PrivyClientConfig,
} from '@privy-io/react-auth';

import { privySetup } from './privyConfig';
import {
  DISCONNECTED_WALLET_STATE,
  mapWalletState,
  type WalletService,
  type WalletState,
} from './types';

/**
 * Root-level wallet wiring.
 *
 * Privy is mounted exactly once, here, so no component initializes it
 * itself. The rest of the application reads wallet state from
 * `useWallet()`, which is backed by the `WalletService` interface rather
 * than by raw Privy calls.
 *
 * When no Privy application id is configured the provider is not mounted
 * at all and the application runs in a fully functional, permanently
 * disconnected wallet state. Wallet connection is never required to use
 * the demo or backtest environments.
 */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const setup = useMemo(() => privySetup(), []);

  if (!setup.configured) {
    return <DisconnectedWalletRoot>{children}</DisconnectedWalletRoot>;
  }

  return (
    <PrivyProvider
      appId={setup.appId as string}
      clientId={setup.clientId}
      apiUrl={setup.apiUrl}
      config={setup.config as PrivyClientConfig}
    >
      <ConnectedWalletBridge>{children}</ConnectedWalletBridge>
    </PrivyProvider>
  );
}

const WalletContext = createContext<WalletService | undefined>(undefined);

/**
 * Stable no-wallet service used when Privy is not configured, and as the
 * fallback for any `useWallet()` call outside a provider.
 */
function unconfiguredService(): WalletService {
  return UNCONFIGURED_SERVICE;
}

const UNCONFIGURED_SERVICE: WalletService = {
  getState: () => DISCONNECTED_WALLET_STATE,
  connect: async () => undefined,
  disconnect: async () => undefined,
};

function DisconnectedWalletRoot({ children }: { children: React.ReactNode }) {
  return (
    <WalletContext.Provider value={UNCONFIGURED_SERVICE}>
      {children}
    </WalletContext.Provider>
  );
}

function ConnectedWalletBridge({ children }: { children: React.ReactNode }) {
  const privy = usePrivy();
  const { wallets } = useWallets();
  const [connecting, setConnecting] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const primary = useMemo(() => {
    const ethereum = wallets.find(
      (wallet) => wallet.type === 'ethereum',
    ) as BaseConnectedEthereumWallet | undefined;
    return ethereum ?? (wallets[0] as BaseConnectedWallet | undefined);
  }, [wallets]);

  const state = useMemo<WalletState>(
    () =>
      mapWalletState({
        configured: true,
        ready: privy.ready,
        authenticated: privy.authenticated,
        connecting,
        address: primary?.address,
        walletClientType: primary?.walletClientType,
        error: localError ?? userSafeError(privy.error),
      }),
    [privy.ready, privy.authenticated, privy.error, primary, connecting, localError],
  );

  const service = useMemo<WalletService>(
    () => ({
      getState: () => state,
      connect: async () => {
        setLocalError(undefined);
        setConnecting(true);
        try {
          privy.connectOrCreateWallet();
        } catch (error: unknown) {
          setLocalError(userSafeError(error));
        } finally {
          setConnecting(false);
        }
      },
      disconnect: async () => {
        setLocalError(undefined);
        try {
          primary?.disconnect();
          await privy.logout();
        } catch (error: unknown) {
          setLocalError(userSafeError(error));
        }
      },
      signMessage: async (message: string) => {
        if (!primary) return undefined;
        if (primary.type !== 'ethereum') {
          setLocalError('The connected wallet cannot sign on this network.');
          return undefined;
        }
        try {
          return await (primary as BaseConnectedEthereumWallet).sign(message);
        } catch (error: unknown) {
          setLocalError(userSafeError(error));
          return undefined;
        }
      },
    }),
    [state, privy, primary],
  );

  return (
    <WalletContext.Provider value={service}>{children}</WalletContext.Provider>
  );
}

/**
 * Wallet state and actions.
 *
 * Returns the disconnected state when no provider is mounted, so calling
 * code never has to branch on whether Privy is configured.
 */
export function useWallet(): { state: WalletState; service: WalletService } {
  const context = useContext(WalletContext);
  const service = context ?? unconfiguredService();
  return { state: service.getState(), service };
}

/** Provider errors are surfaced as plain text, never as a stack trace. */
function userSafeError(error: unknown): string | undefined {
  if (!error) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b0x[a-fA-F0-9]{8,}\b/g, '[REDACTED]').slice(0, 200);
}
