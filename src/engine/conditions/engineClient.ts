/**
 * The client for the Python condition engine.
 *
 * The division of labour this file encodes:
 *
 *  - **The engine measures.** It reads market data, computes indicators,
 *    and evaluates condition trees. The browser does not reimplement any
 *    of that, so there is no second answer to disagree with.
 *  - **The browser builds and shows.** It composes a tree, validates it
 *    against the shared contract, renders the result, and registers the
 *    tracker with the engine.
 *
 * There is no method here that places, sizes, approves, or cancels an
 * order, and there is no way to pass a credential. Turning an `AI_WAKE`
 * into a trade happens in the app, behind the existing policy, risk and
 * DEMO execution guard.
 */

import { CONDITION_SCHEMA_VERSION, validateConditionTree, type ConditionNode, type ConditionTree } from './contract';

export type ConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN';

export interface ConditionLeafResult {
  id: string;
  kind: string;
  status: ConditionStatus;
  summary: string;
  value?: number;
  threshold?: number;
  unit?: string;
  reason?: string;
  operator?: string;
  children?: ConditionLeafResult[];
}

export interface EvaluationResult {
  status: ConditionStatus;
  summary: string;
  conditions: ConditionLeafResult[];
  explanation: string;
  textures: Array<{ timeframe: string; indicator: string }>;
}

export interface ConditionErrorDetail {
  path: string;
  message: string;
}

export class ConditionContractError extends Error {
  readonly problems: ConditionErrorDetail[];

  constructor(problems: ConditionErrorDetail[]) {
    super(`Not a canonical condition tree:\n${problems.map((p) => `  ${p.path || 'root'}: ${p.message}`).join('\n')}`);
    this.name = 'ConditionContractError';
    this.problems = problems;
  }
}

/** The engine refused a tree, or could not be reached. */
export class ConditionEngineError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConditionEngineError';
    this.status = status;
  }
}

export interface WakeEvent {
  wakeId: string;
  type: 'AI_WAKE';
  goatId: string;
  trackerId: string;
  trackerName: string;
  trackerVersion: number;
  market: string;
  timeframe: string;
  timestamp: number;
  environment: 'DEMO';
  reason: string;
  acknowledged: boolean;
  conditions: { overall: ConditionStatus; summary: string; conditions: ConditionLeafResult[] };
  context: {
    tracker?: string;
    market: string;
    timeframe?: string;
    price?: number | null;
    spread?: number | null;
    recentCandles?: Array<{ open: number; high: number; low: number; close: number }>;
    positions?: unknown[];
    account?: unknown;
  };
}

export interface EngineInstrument {
  symbol: string;
  providerSymbol: string;
  assetClass: string;
  displayName: string;
  dex: string;
  availability: 'TRADEABLE' | 'UNAVAILABLE';
  unavailableReason: string;
  pricePrecision: number | null;
  sizePrecision: number | null;
  maxLeverage: number | null;
  tickSize: number | null;
  pipSize: number | null;
}

export interface EngineStatus {
  running: boolean;
  liveTradingEnabled: false;
  schemaVersion: number;
  trackers: unknown[];
  requiredSeries: Array<{ symbol: string; timeframe: string }>;
  fetchCount: number;
  wakeCount: number;
  pendingWakes: number;
}

export interface ConditionEngineClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Abort a request that has not answered in this many milliseconds. */
  timeoutMs?: number;
}

export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8099';

export class ConditionEngineClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ConditionEngineClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ENGINE_URL).replace(/\/$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /* ---------------------------------------------------------------- plumbing */

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        // A 422 from the engine means the tree broke the shared contract,
        // so the problems are surfaced rather than flattened into a string.
        if (response.status === 422 && typeof body.detail === 'string' && body.detail.includes('Not a canonical')) {
          throw new ConditionContractError([{ path: '', message: body.detail }]);
        }
        throw new ConditionEngineError(typeof body.detail === 'string' ? body.detail : `${path} failed`, response.status);
      }
      return body as T;
    } catch (error) {
      if (error instanceof ConditionEngineError || error instanceof ConditionContractError) throw error;
      throw new ConditionEngineError(
        `Could not reach the condition engine at ${this.baseUrl}. Is it running? (${(error as Error).message})`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate against the shared schema before spending a round trip.
   *
   * The engine validates again; this is so the builder can show the
   * problem next to the condition while the user is still typing.
   */
  private assertCanonical(tree: ConditionTree): void {
    const problems = validateConditionTree(tree);
    if (problems.length > 0) throw new ConditionContractError(problems);
  }

  /* ------------------------------------------------------------------ health */

  /** Cheap liveness probe, used by the settings panel and by the tests. */
  async health(): Promise<{ ok: boolean; schemaVersion: number; liveTradingEnabled: false; capabilities: Record<string, boolean> }> {
    const health = await this.request<{ ok: boolean; schemaVersion: number; liveTradingEnabled: false; capabilities: Record<string, boolean> }>('/health');
    if (health.schemaVersion !== CONDITION_SCHEMA_VERSION) {
      throw new ConditionEngineError(
        `The engine implements condition schema v${health.schemaVersion}, this app builds v${CONDITION_SCHEMA_VERSION}.`,
        0,
      );
    }
    return health;
  }

  async status(): Promise<EngineStatus> {
    return this.request<EngineStatus>('/status');
  }

  /* -------------------------------------------------------------- catalogue */

  /** The condition catalogue, for the builder's "add a condition" menu. */
  async catalogue(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/catalogue');
  }

  /* ------------------------------------------------------------ instruments */

  async instruments(refresh = false): Promise<{ tradeable: string[]; instruments: Record<string, EngineInstrument> }> {
    return this.request<{ tradeable: string[]; instruments: Record<string, EngineInstrument> }>(
      `/instruments${refresh ? '?refresh=true' : ''}`,
    );
  }

  /* ------------------------------------------------------------- evaluation */

  /**
   * Evaluate a tree against the engine's current cached market data.
   *
   * The market must be one a registered tracker is watching, otherwise
   * the engine is not keeping data for it and says so rather than
   * answering from nothing.
   */
  async evaluate(tree: ConditionTree, market: string, nowMs?: number): Promise<EvaluationResult> {
    this.assertCanonical(tree);
    return this.request<EvaluationResult>('/evaluate', {
      method: 'POST',
      body: JSON.stringify({ tree, market, nowMs }),
    });
  }

  /**
   * Evaluate a tree against a committed fixture.
   *
   * This is what the builder calls while the user is still editing. It
   * never touches a live market, so a half-finished tree can be checked
   * safely and the answer is reproducible.
   */
  async test(tree: ConditionTree, context = 'gold15mSpike'): Promise<EvaluationResult> {
    this.assertCanonical(tree);
    return this.request<EvaluationResult>('/test', {
      method: 'POST',
      body: JSON.stringify({ tree, context }),
    });
  }

  /** The fixture contexts the engine can test against, for a picker. */
  async fixtureContexts(): Promise<string[]> {
    const bundle = await this.request<{ contexts: Record<string, unknown> }>('/fixtures');
    return Object.keys(bundle.contexts);
  }

  /* --------------------------------------------------------------- trackers */

  /**
   * Register a tracker with the engine.
   *
   * This is the engine half of what the Tracker SDK does in the browser:
   * both exist so the deterministic observation has one owner, and both
   * validate the tree against the same shared contract.
   */
  async registerTracker(input: { id: string; goatId: string; name: string; definition: ConditionTree; version?: number }) {
    this.assertCanonical(input.definition);
    return this.request<{ id: string; goatId: string; market: string; then: 'WAKE_AI' }>('/trackers', {
      method: 'POST',
      body: JSON.stringify({ ...input, version: input.version ?? 1 }),
    });
  }

  async unregisterTracker(trackerId: string): Promise<void> {
    await this.request(`/trackers/${encodeURIComponent(trackerId)}`, { method: 'DELETE' });
  }

  async trackerStatus(trackerId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/trackers/${encodeURIComponent(trackerId)}/status`);
  }

  /* ------------------------------------------------------------------ wakes */

  async wakes(limit = 20): Promise<WakeEvent[]> {
    const payload = await this.request<{ wakes: WakeEvent[] }>(`/wakes?limit=${limit}`);
    return payload.wakes;
  }

  /**
   * Tell the engine the app received a wake.
   *
   * The engine never learns what the app then decided, because what the
   * app decides is not its business. It only needs to know the wake was
   * delivered so it is not redelivered forever.
   */
  async acknowledgeWake(wakeId: string): Promise<void> {
    await this.request(`/wakes/${encodeURIComponent(wakeId)}/ack`, { method: 'POST' });
  }

  /* ----------------------------------------------------------------- events */

  async events(options: { limit?: number; goatId?: string; trackerId?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams();
    if (options.limit) query.set('limit', String(options.limit));
    if (options.goatId) query.set('goatId', options.goatId);
    if (options.trackerId) query.set('trackerId', options.trackerId);
    const suffix = query.toString() ? `?${query}` : '';
    const payload = await this.request<{ events: Array<Record<string, unknown>> }>(`/events${suffix}`);
    return payload.events;
  }
}

/**
 * A single shared client.
 *
 * The engine is a local process, so one client is enough and it keeps the
 * base URL in one place.
 */
let shared: ConditionEngineClient | null = null;

export function conditionEngine(options?: ConditionEngineClientOptions): ConditionEngineClient {
  if (options) {
    shared = new ConditionEngineClient(options);
    return shared;
  }
  if (!shared) shared = new ConditionEngineClient();
  return shared;
}

/**
 * The wake an agent should act on, if any.
 *
 * A wake is a *request to think*, not a trade. What follows is the app's
 * own pipeline: policy, risk, and the DEMO execution guard, in that order.
 */
export function pendingWake(wakes: WakeEvent[], goatId: string): WakeEvent | undefined {
  return wakes.find((wake) => wake.goatId === goatId && !wake.acknowledged);
}

export function buildCanonicalTree(root: ConditionNode, overrides: Partial<ConditionTree> = {}): ConditionTree {
  return { schemaVersion: CONDITION_SCHEMA_VERSION, then: 'WAKE_AI', root, ...overrides };
}
