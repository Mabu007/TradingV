/**
 * Public (client-visible) application configuration.
 *
 * Every value read through `import.meta.env.VITE_*` is shipped to the
 * browser bundle. This module is therefore the single place where a
 * client-visible value is read, and it only ever reads `VITE_`-prefixed
 * variables. No private key, seed phrase, signing secret, or server-side
 * credential may be added here: those belong in a server-only variable
 * and must never be prefixed with `VITE_`.
 *
 * The full set of variables, including the server-only ones, is
 * documented in `.env.example` and `docs/environment.md`.
 */

function readPublicEnv(key: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Privy application id. Public by design: it identifies the app, not a secret. */
export function privyAppId(): string | undefined {
  return readPublicEnv('VITE_PRIVY_APP_ID');
}

/** Optional Privy app client id, when the dashboard issues one. */
export function privyClientId(): string | undefined {
  return readPublicEnv('VITE_PRIVY_CLIENT_ID');
}

/** Optional Privy API URL override. Development and testing only. */
export function privyApiUrl(): string | undefined {
  return readPublicEnv('VITE_PRIVY_API_URL');
}

/** Optional comma-separated Privy login methods, e.g. "email,wallet". */
export function privyLoginMethods(): string | undefined {
  return readPublicEnv('VITE_PRIVY_LOGIN_METHODS');
}

/**
 * The configured venue environment.
 *
 * Re-exported from `config/venue` rather than decided here. This module
 * is the place that reads public environment variables; the venue module
 * is the place that knows what a venue environment *is*. Two readers of
 * the same variable that could disagree is the bug this avoids.
 */
export { configuredVenue as hyperliquidNetwork, type VenueEnvironment as HyperliquidNetwork } from './venue';

/**
 * Public base URL for the deployed app.
 *
 * The bundler only substitutes `VITE_` variables, so the conventional
 * `APP_URL` is read from `VITE_APP_URL` and the non-prefixed value is
 * read from `process.env` when running under a server/bundler that
 * provides it.
 */
export function appUrl(): string | undefined {
  return (
    readPublicEnv('VITE_APP_URL') ??
    (typeof process !== 'undefined' ? process.env?.APP_URL : undefined)
  );
}

/**
 * Optional build-time OpenRouter key.
 *
 * Prefer entering a key in Settings, which keeps it in the user's own
 * browser. A key placed here is public and must be treated as such.
 */
export function openRouterApiKey(): string | undefined {
  return readPublicEnv('VITE_OPENROUTER_API_KEY');
}

/**
 * Every client-visible variable the application reads, with the reason it
 * exists. Used by the configuration test to keep `.env.example` honest.
 */
export const PUBLIC_ENVIRONMENT_VARIABLES: Array<{
  name: string;
  required: boolean;
  purpose: string;
}> = [
  {
    name: 'VITE_PRIVY_APP_ID',
    required: true,
    purpose: 'Privy application id used to initialize the wallet/authentication provider.',
  },
  {
    name: 'VITE_PRIVY_CLIENT_ID',
    required: false,
    purpose: 'Privy app client id, when the dashboard issues one for this app.',
  },
  {
    name: 'VITE_PRIVY_LOGIN_METHODS',
    required: false,
    purpose: 'Comma-separated Privy login methods to show, e.g. "email,wallet".',
  },
  {
    name: 'VITE_PRIVY_API_URL',
    required: false,
    purpose: 'Privy API URL override. Development and testing only.',
  },
  {
    name: 'VITE_HYPERLIQUID_NETWORK',
    required: false,
    purpose: 'Hyperliquid network for discovery, quotes, and candles: mainnet or testnet.',
  },
  {
    name: 'VITE_APP_URL',
    required: false,
    purpose: 'Public base URL of the deployed app for self-referential links.',
  },
  {
    name: 'VITE_OPENROUTER_API_KEY',
    required: false,
    purpose: 'Optional build-time OpenRouter key. Public; prefer a key entered in Settings.',
  },
];

/**
 * Variables that must never carry a `VITE_` prefix, because anything
 * prefixed that way is visible to every browser that loads the app.
 */
export const SERVER_ONLY_ENVIRONMENT_VARIABLES: Array<{
  name: string;
  purpose: string;
}> = [
  {
    name: 'PRIVY_SECRET_KEY',
    purpose: 'Privy server-side API secret. Used only by a backend for privileged Privy API calls.',
  },
  {
    name: 'PRIVY_VERIFICATION_KEY',
    purpose: 'Privy access-token verification key, used server-side to validate a user JWT.',
  },
  {
    name: 'PRIVY_AUTH_SECRET',
    purpose: 'Privy JWT auth secret, used server-side to mint and verify tokens.',
  },
  {
    name: 'HYPERLIQUID_API_WALLET',
    purpose: 'Server-side Hyperliquid API wallet address for a future agent signer.',
  },
  {
    name: 'HYPERLIQUID_PRIVATE_KEY',
    purpose: 'Server-side Hyperliquid agent private key. Must never reach the browser or an agent.',
  },
  {
    name: 'HYPERLIQUID_WALLET_SECRET',
    purpose: 'Server-side secret used to encrypt the Hyperliquid agent wallet.',
  },
  {
    name: 'OPENROUTER_API_KEY',
    purpose: 'Server-side OpenRouter key for trusted backend calls. Never a VITE_ variable.',
  },
];
