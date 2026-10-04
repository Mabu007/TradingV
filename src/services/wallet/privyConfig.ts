/**
 * Privy configuration.
 *
 * Privy is initialized once, at the application root, from these values.
 * No component constructs a Privy client of its own.
 *
 * Only the public application id (and optional client id) are read here.
 * Privy's server-side secret, auth secret, and verification key are not
 * used by the browser and must never be given a `VITE_` prefix.
 */

import type { PrivyClientConfig } from '@privy-io/react-auth';
import {
  privyApiUrl,
  privyAppId,
  privyClientId,
  privyLoginMethods,
} from '../../config/env';

export interface PrivySetup {
  /** False when no application id is configured; the provider is not mounted. */
  configured: boolean;
  appId?: string;
  clientId?: string;
  apiUrl?: string;
  config: PrivyClientConfig;
}

const ALLOWED_LOGIN_METHODS = new Set([
  'wallet',
  'email',
  'sms',
  'google',
  'twitter',
  'discord',
  'github',
  'linkedin',
  'spotify',
  'instagram',
  'tiktok',
  'line',
  'twitch',
  'apple',
  'farcaster',
  'telegram',
  'passkey',
]);

function loginMethods(): PrivyClientConfig['loginMethods'] {
  const raw = privyLoginMethods();
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((method) => method.trim().toLowerCase())
    .filter((method) => method.length > 0);
  const supported = parsed.filter(
    (method): method is NonNullable<PrivyClientConfig['loginMethods']>[number] =>
      ALLOWED_LOGIN_METHODS.has(method),
  );
  return supported.length > 0 ? supported : undefined;
}

/**
 * Build the Privy client configuration.
 *
 * The appearance block matches the dark, mobile-first TradingGOATs shell.
 * Hyperliquid's own markets (HIP-3) are settled on Arbitrum, so the
 * wallet is requested on that chain; this is identity configuration only
 * and does not enable any execution path.
 */
export function privySetup(): PrivySetup {
  const appId = privyAppId();

  if (!appId) {
    return { configured: false, config: {} };
  }

  return {
    configured: true,
    appId,
    clientId: privyClientId(),
    apiUrl: privyApiUrl(),
    config: {
      appearance: {
        theme: 'dark',
        accentColor: '#0ea5e9',
        landingHeader: 'Sign in to TradingGOATs',
        loginMessage: 'Use your wallet or an email to continue.',
        walletChainType: 'ethereum-only',
      },
      loginMethods: loginMethods(),
    },
  };
}
