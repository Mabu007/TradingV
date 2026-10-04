/**
 * The browser's client for the Durable Object watcher tier.
 *
 * ## What this connects, and what it deliberately does not
 *
 * The DO tier already owns the durable runtime identity of a deployed tracker:
 * its last evaluation, its cooldowns, its pending wake, its heartbeat. This client
 * is the *only* way the browser reaches it, and it does four things:
 *
 *   1. Presents a **Firebase ID token**, so the worker knows who is asking and the
 *      user id is a signed claim rather than a header the caller chose.
 *   2. Registers a watcher when a GOAT deployment goes live, using the worker's
 *      existing identity: `(userId, goatId, deploymentId)`. No second id scheme.
 *   3. Sends a tracker's canonical condition tree, so the worker decides *when* to
 *      wake and this application decides nothing about timing.
 *   4. Reports failures as failures. A deployment that could not be registered is
 *      reported as such, not as a deployment that happens to be running.
 *
 * It does **not** execute anything. A wake the worker grants means this
 * application should re-run its condition engine — the same engine, the same
 * evidence, the same risk rules. There is no path from a worker response to an
 * order.
 *
 * ## Why there is no Firebase SDK import here
 *
 * The token comes from an injected function. The browser's Firebase Auth instance
 * supplies it in the application; a test supplies a stub. Coupling this client to
 * the SDK would make the identity path untestable and would put an auth client in
 * a module that has no business holding one.
 */

/*
 * The contract is imported from the worker, not copied.
 *
 * `watchers/src/contract.ts` holds no Cloudflare types — it is the pure decision
 * logic — so both sides of the wire can share one file. A copy here would be a
 * second definition of what a valid watcher configuration is, and the two would
 * disagree the first time either was edited; the divergence would then show up as
 * a validation error in a browser and a silent acceptance in a worker.
 */
import { validateWatcherConfig, type WatcherConfig } from '../../../watchers/src/contract';

/** Supplies a bearer token, or null when nobody is signed in. */
export type TokenProvider = () => Promise<string | null>;

export type WatcherClientErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_SIGNED_IN'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'NETWORK'
  | 'BAD_RESPONSE';

export class WatcherClientError extends Error {
  constructor(
    readonly code: WatcherClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WatcherClientError';
  }
}

/** The worker endpoint, from the environment. */
export function watchersEndpointFromEnv(
  env: Record<string, string | undefined>,
): { url: string } | { unavailable: string } {
  const url = env['VITE_WATCHERS_URL']?.replace(/\/+$/, '');
  if (!url) {
    return {
      unavailable:
        'The watcher service is not configured (VITE_WATCHERS_URL). GOATs still run in this tab, but nothing survives the tab being closed.',
    };
  }
  return { url };
}

/**
 * Builds the configuration the worker stores.
 *
 * The worker's contract is the authority: `validateWatcherConfig` is the *same*
 * function the worker runs, imported rather than copied, so a configuration this
 * accepts cannot be one the worker rejects. The clamps are the contract's limits,
 * surfaced as numbers a user can see rather than silently applied.
 */
export function buildWatcherConfig(input: {
  name: string;
  market: string;
  conditionTree: unknown;
  configVersion: number;
  /** What the user asked for, before the contract's limits. */
  desired?: {
    minEvaluationIntervalMs?: number;
    cooldownMs?: number;
    maxWakesPerHour?: number;
    maxWakesPerDay?: number;
  };
}): { config: WatcherConfig; clamped: string[] } | { problems: string[] } {
  const clamped: string[] = [];
  const clamp = (name: string, requested: number | undefined, min: number, max: number, fallback: number): number => {
    if (requested === undefined) return fallback;
    const bounded = Math.min(Math.max(Math.round(requested), min), max);
    if (bounded !== requested) clamped.push(`${name} ${requested} → ${bounded}`);
    return bounded;
  };

  const candidate: WatcherConfig = {
    configVersion: input.configVersion,
    name: input.name,
    market: input.market,
    conditionTree: input.conditionTree,
    // Defaults chosen from the contract's own bounds rather than invented: an
    // hourly floor keeps a quiet market from costing anything, and the wake
    // ceilings are low enough that a runaway condition cannot become a bill.
    minEvaluationIntervalMs: clamp(
      'minimum interval',
      input.desired?.minEvaluationIntervalMs,
      1_000,
      3_600_000,
      3_600_000,
    ),
    cooldownMs: clamp('cooldown', input.desired?.cooldownMs, 0, 86_400_000, 900_000),
    maxWakesPerHour: clamp('wakes per hour', input.desired?.maxWakesPerHour, 1, 60, 6),
    maxWakesPerDay: clamp('wakes per day', input.desired?.maxWakesPerDay, 1, 1_440, 48),
  };

  const validation = validateWatcherConfig(candidate);
  if (!validation.valid) return { problems: validation.problems };
  return { config: candidate, clamped };
}

export interface DeployRequest {
  goatId: string;
  deploymentId: string;
  config: WatcherConfig;
}

export interface WatcherSummary {
  watcherId: string;
  status: string;
  configVersion: number;
  lastEvaluatedAt?: number;
  pendingWakes: number;
}

export interface WatchersClientOptions {
  baseUrl: string;
  token: TokenProvider;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * The client.
 *
 * Every method returns a value or throws a `WatcherClientError` — never a
 * partially-applied result. A caller can therefore always tell the difference
 * between "registered" and "not registered", which is the distinction that
 * matters when somebody closes the tab.
 */
export class WatchersClient {
  private readonly doFetch: typeof fetch;

  private readonly baseUrl: string;

  constructor(private readonly options: WatchersClientOptions) {
    this.doFetch = options.fetch ?? fetch;
    /*
     * Normalised here rather than only in `createWatchersClient`.
     *
     * A trailing slash produces `//watchers`, which most servers answer with a
     * redirect — and a redirected request drops the `Authorization` header on some
     * paths, producing an authentication failure that looks like a session
     * problem. Cheap to prevent here, so it is prevented for every caller rather
     * than for the ones that remembered to go through the factory.
     */
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Register a deployment's watcher. Idempotent for the same deployment. */
  async deploy(request: DeployRequest): Promise<WatcherSummary> {
    const validation = validateWatcherConfig(request.config);
    if (!validation.valid) {
      // Checked here as well as in the worker: a request the worker will refuse is
      // better refused before it costs a round trip and a rate-limit token.
      throw new WatcherClientError('INVALID_CONFIG', validation.problems.join(' '));
    }
    const body = await this.send('POST', '/watchers', request);
    return body as WatcherSummary;
  }

  /** The worker's own view of a watcher — the authority on whether it is running. */
  async status(watcherId: string): Promise<WatcherSummary> {
    return (await this.send('GET', `/watchers/${encodeURIComponent(watcherId)}`)) as WatcherSummary;
  }

  /** Every watcher this user has, as the worker knows them. */
  async list(): Promise<WatcherSummary[]> {
    const body = await this.send('GET', '/watchers');
    return Array.isArray((body as { watchers?: unknown }).watchers)
      ? ((body as { watchers: WatcherSummary[] }).watchers)
      : [];
  }

  /** A lifecycle action: pause, resume, stop. */
  async act(watcherId: string, action: 'pause' | 'resume' | 'stop'): Promise<WatcherSummary> {
    return (await this.send('POST', `/watchers/${encodeURIComponent(watcherId)}/${action}`)) as WatcherSummary;
  }

  /** Whether the service is reachable at all. Used by a status line. */
  async healthy(): Promise<boolean> {
    try {
      const response = await this.doFetch(`${this.baseUrl}/health`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ask for a watcher to re-evaluate now.
   *
   * Not a scheduling tool: it is the manual "look again" a person presses when
   * they have just changed something. The worker's cooldown still applies, so this
   * cannot be used to force an evaluation the contract would not otherwise allow.
   */
  async evaluate(watcherId: string): Promise<unknown> {
    return this.send('POST', `/watchers/${encodeURIComponent(watcherId)}/evaluate`, {});
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.options.token();
    if (token === null || token.length === 0) {
      throw new WatcherClientError('NOT_SIGNED_IN', 'Signing in is required to use the watcher service.');
    }

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new WatcherClientError(
        'NETWORK',
        `Could not reach the watcher service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text().catch(() => '');
    const parsed = text.length > 0 ? safeParse(text) : {};

    if (!response.ok) {
      throw new WatcherClientError(codeForStatus(response.status), messageFor(response.status, parsed), response.status);
    }
    return parsed;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A body that is not JSON from a service that promises JSON is a server
    // problem, and it is reported as one rather than as an empty success.
    throw new WatcherClientError('BAD_RESPONSE', 'The watcher service returned a response that was not JSON.');
  }
}

function codeForStatus(status: number): WatcherClientErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'SERVER' : 'BAD_RESPONSE';
  }
}

function messageFor(status: number, body: unknown): string {
  const fromServer =
    typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : '';
  if (fromServer.length > 0) return fromServer;
  switch (status) {
    case 401:
      return 'The watcher service did not accept the session. Sign in again.';
    case 403:
      return 'The watcher service refused this action.';
    case 404:
      return 'That watcher is not registered.';
    case 429:
      return 'The watcher service is rate limiting this account. Try again shortly.';
    default:
      return `The watcher service returned ${status}.`;
  }
}

/** Build a client from the environment, or explain why there is none. */
export function createWatchersClient(
  env: Record<string, string | undefined>,
  token: TokenProvider,
): { client: WatchersClient } | { unavailable: string } {
  const endpoint = watchersEndpointFromEnv(env);
  if ('unavailable' in endpoint) return endpoint;
  return {
    client: new WatchersClient({
      baseUrl: endpoint.url,
      token,
      // The browser sends its own credentials so the worker's CORS preflight has
      // an allow-listed header rather than an opaque one.
      fetch: (input, init) => fetch(input, { ...init, credentials: 'omit' }),
    }),
  };
}