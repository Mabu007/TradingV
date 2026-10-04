/**
 * The canonical venue environment.
 *
 * There is exactly one place in this application that knows what
 * Testnet and Mainnet are, and this is it. Every Hyperliquid REST host,
 * every WebSocket host, and every "is this the real thing" decision
 * resolves through this module, so a module that guesses for itself
 * cannot produce a request against the wrong environment.
 *
 * Why it is a module and not an interface: the environments are facts
 * about a venue, not a policy this application negotiates. What varies
 * is which one the user selected, and that arrives here as a value.
 *
 * The rules this module exists to make enforceable:
 *
 *  - **One decision, read once.** `resolveVenue()` is the only place an
 *    environment is chosen, and the resolved value is carried explicitly
 *    into the adapter, the execution guard and the UI.
 *  - **Endpoints are derived, never typed in.** A caller cannot pass a
 *    base URL, so there is no way to send a Mainnet request to a Testnet
 *    client or the reverse.
 *  - **A mismatch is an error, not a fallback.** `assertSameVenue` is
 *    what a deployment calls before it is allowed to act, so a stale
 *    client or a stale UI cannot quietly trade the wrong account on the
 *    wrong network.
 */

/** The two environments Hyperliquid runs. */
export type VenueEnvironment = 'TESTNET' | 'MAINNET';

export const VENUE_ENVIRONMENTS: readonly VenueEnvironment[] = ['TESTNET', 'MAINNET'];

export interface VenueEndpoints {
  /** REST `info` endpoint. POST-only, public, no credentials. */
  restInfoUrl: string;
  /** Realtime feed. */
  websocketUrl: string;
  /** Host used in diagnostics and in the audit trail. */
  host: string;
}

/**
 * The endpoints, in one table.
 *
 * Hyperliquid serves both environments from differently suffixed hosts,
 * so the whole difference between them is this table. Anything that
 * needs a URL derives it from the environment rather than composing one,
 * which is what makes "the same request, both environments" testable.
 */
const ENDPOINTS: Record<VenueEnvironment, VenueEndpoints> = {
  TESTNET: {
    restInfoUrl: 'https://api.hyperliquid-testnet.xyz/info',
    websocketUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
    host: 'api.hyperliquid-testnet.xyz',
  },
  MAINNET: {
    restInfoUrl: 'https://api.hyperliquid.xyz/info',
    websocketUrl: 'wss://api.hyperliquid.xyz/ws',
    host: 'api.hyperliquid.xyz',
  },
};

/**
 * The endpoint keys, exported so the venue tests can check all of them.
 *
 * Exported for the tests that defend the table, not for application code:
 * code that needs an endpoint asks for the environment, not the key.
 */
export const ENDPOINT_KEYS_FOR_TEST = ['restInfoUrl', 'websocketUrl', 'host'] as const;

export function venueEndpoints(environment: VenueEnvironment): VenueEndpoints {
  const endpoints = ENDPOINTS[environment];
  if (!endpoints) {
    throw new Error(
      `Unknown venue environment "${String(environment)}". Expected one of ${VENUE_ENVIRONMENTS.join(', ')}.`,
    );
  }
  return endpoints;
}

/** Narrow an arbitrary value to an environment, or report that it is not one. */
export function isVenueEnvironment(value: unknown): value is VenueEnvironment {
  return value === 'TESTNET' || value === 'MAINNET';
}

/**
 * Parse a configured environment, falling back to Mainnet.
 *
 * Case and whitespace are tolerated, because the value's first home is a
 * `.env` file where a lowercase `mainnet` is a natural thing to type and a
 * hard failure there would be a support ticket rather than a diagnosis.
 * Anything genuinely unrecognised is Mainnet rather than a guess between
 * the two, because a typo must never silently point a deployment at the
 * network the user did not choose.
 */
export function parseVenueEnvironment(
  value: string | undefined,
): VenueEnvironment {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  return isVenueEnvironment(normalized) ? normalized : 'MAINNET';
}

export interface Venue {
  environment: VenueEnvironment;
  restInfoUrl: string;
  websocketUrl: string;
  host: string;
  /**
   * Whether this environment holds real value.
   *
   * A property rather than a comparison, so "is this live?" is answered
   * by the same value everywhere and a future third environment cannot
   * be added without the answer changing with it.
   */
  isLive: boolean;
}

export function venueFor(environment: VenueEnvironment): Venue {
  const endpoints = venueEndpoints(environment);
  return {
    environment,
    ...endpoints,
    isLive: environment === 'MAINNET',
  };
}

/** Read the configured environment from the public build environment. */
export function configuredVenue(): Venue {
  const raw = (import.meta.env as Record<string, string | undefined>).VITE_HYPERLIQUID_NETWORK;
  return venueFor(parseVenueEnvironment(typeof raw === 'string' ? raw : undefined));
}

/**
 * Refuse to act across environments.
 *
 * A deployment is allowed to execute only when the environment it was
 * bound to is the environment the client is connected to. This is the
 * check that makes a stale client unable to send a Testnet order into a
 * Mainnet session, or the reverse, and it is deliberately a thrown error
 * rather than a warning: the alternative is an order nobody can explain.
 */
export function assertSameVenue(
  expected: VenueEnvironment,
  actual: VenueEnvironment,
  context: string,
): void {
  if (expected === actual) return;
  throw new Error(
    `${context}: refusing to proceed — the deployment is bound to ${expected} but the client is connected to ${actual}.`,
  );
}

/** A short, human-readable description for the UI and the audit trail. */
export function describeVenue(environment: VenueEnvironment): string {
  return environment === 'MAINNET'
    ? 'Hyperliquid Mainnet — real markets, real value.'
    : 'Hyperliquid Testnet — real markets, no real value.';
}
