/**
 * The Worker.
 *
 * A thin HTTP front door plus an authorisation gate. It owns no trading
 * logic and no watcher state; both live behind the Durable Object.
 *
 * ## Authorisation
 *
 * Every request carries a user id, supplied by the authentication layer
 * that sits in front of this Worker. That id is checked against the
 * watcher's own `identity.userId` before anything is read or changed.
 *
 * The check is explicit on every route rather than in a middleware,
 * because the failure mode of getting it wrong is one user reading or
 * stopping another's bot. A missing check is a `null` id, which fails
 * closed, not an implicit "trusted".
 *
 * ## Deployment
 *
 * `POST /watchers` is idempotent on `(userId, goatId, deploymentId)`,
 * because the Durable Object id is derived from exactly that triple. A
 * retried deploy therefore updates one watcher rather than creating a
 * second one, which is the failure that produces duplicate wakes and
 * duplicate orders.
 */

import { DurableObject } from 'cloudflare:workers';
import { WatcherObject, type WatcherEnv, type WatcherInit } from './durable-object';

/*
 * Re-exported so the runtime can resolve the bound classes.
 *
 * Without these exports the Worker starts, binds `WATCHERS`, and then
 * fails every request that touches a Durable Object. The error names a
 * missing export, which reads as a build problem rather than as "you
 * forgot to export the class", so it is worth the explicit comment.
 */
export { WatcherObject };
import { isOwnedBy, validateWatcherConfig, type MarketEvent, type WatcherConfig, type WatcherIdentity } from './contract';
import { watcherIdFor } from './ids';
import { consume, isPreflight, type RateBucket, type RateDecision, type RateLimitState } from './rate-limit';
import type { WatcherAction } from './contract';
import type { HealthReport } from './health';
import type { Env } from './env';
import { identifyCaller } from './auth';

export type { Env } from './env';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** Responses are never cached: health and pending wakes are per-request. */
const NO_STORE = { 'Cache-Control': 'no-store' };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      return json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const cors = applyCors(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (path === '/health') {
    return json({ ok: true, service: 'tradingvibe-watchers', now: Date.now() }, 200, cors);
  }

  // The market feed is authenticated with its own secret, not a user
  // token: it is a service-to-service call, and routing it through the
  // user path would let a user impersonate a price feed.
  if (path === '/feed') {
    // Keyed by the feed, not by a user: the feed has no user id, and
    // an unlimited feed can wake every watcher on the platform.
    if (!isPreflight(request.method)) {
      const decision = await consumeRate(env, 'feed', 'feed');
      if (!decision.allowed) return rateLimited(decision, cors);
    }
    return handleFeed(request, env, cors);
  }
  if (path.startsWith('/feed')) return json({ error: 'NOT_FOUND' }, 404, cors);

  const userId = await authenticate(request, env);
  if (!userId) {
    return json({ error: 'UNAUTHENTICATED', message: 'A valid authorization token is required.' }, 401, cors);
  }

  if (path === '/watchers' && request.method === 'GET') {
    return limited(request, env, userId, 'read', cors, () => listWatchers(request, env, userId, cors));
  }
  if (path === '/watchers' && request.method === 'POST') {
    return limited(request, env, userId, 'lifecycle', cors, () => deployWatcher(request, env, userId, cors));
  }

  const match = /^\/watchers\/([A-Za-z0-9_]+)(?:\/(\w+))?$/.exec(path);
  if (match) {
    const [, watcherId, action] = match;
    /*
     * A GET on a watcher is a read; a POST to a lifecycle action is a
     * state change and costs storage. An evaluation is its own bucket
     * because it is the one a stuck retry loop hammers.
     */
    const bucket: RateBucket = request.method === 'GET' ? 'read'
      : action === 'evaluate' ? 'evaluate'
        : 'lifecycle';
    return limited(request, env, userId, bucket, cors, () =>
      handleWatcherRoute(request, env, userId, watcherId, action, cors));
  }

  return json({ error: 'NOT_FOUND', message: `No route for ${request.method} ${path}.` }, 404, cors);
}

/* ------------------------------------------------------------------ *
 * Feed
 * ------------------------------------------------------------------ */

async function handleFeed(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, cors);

  if (!env.MARKET_FEED_TOKEN) {
    // Failing closed: with no configured token there is no way to
    // authenticate a feed, and an open feed would let anyone wake anyone.
    return json({ error: 'FEED_DISABLED', message: 'MARKET_FEED_TOKEN is not configured; the feed is closed.' }, 503, cors);
  }
  const presented = request.headers.get('X-Feed-Token') ?? '';
  if (!constantTimeEquals(presented, env.MARKET_FEED_TOKEN)) {
    return json({ error: 'UNAUTHENTICATED', message: 'Invalid feed token.' }, 401, cors);
  }

  const body = (await request.json().catch(() => null)) as { events?: MarketEvent[] } | null;
  if (!body || !Array.isArray(body.events)) {
    return json({ error: 'BAD_REQUEST', message: 'Expected { events: MarketEvent[] }.' }, 400, cors);
  }
  if (body.events.length > 1000) {
    return json({ error: 'TOO_MANY', message: 'At most 1000 events per request.' }, 413, cors);
  }

  /*
   * Routed by market rather than by watcher.
   *
   * The feed knows a symbol; it does not know which watchers care. Fan
   * out here so one HTTP request becomes one dispatch per interested
   * watcher, and a watcher that does not watch this market is never
   * touched. The watcher itself re-checks the market, so a wrong
   * fan-out cannot wake a bot.
   */
  const byMarket = new Map<string, MarketEvent[]>();
  for (const event of body.events) {
    if (!event || typeof event.market !== 'string' || typeof event.marketEventId !== 'string') continue;
    const list = byMarket.get(event.market) ?? [];
    list.push(event);
    byMarket.set(event.market, list);
  }

  const results: Array<{ watcherId: string; market: string; outcome: string; reason?: string }> = [];

  for (const [market, events] of byMarket) {
    const ids = await watchersForMarket(env, market);
    for (const watcherId of ids) {
      const stub = env.WATCHERS.get(env.WATCHERS.idFromName(watcherId));
      const watcher = stub as unknown as WatcherObject;
      for (const event of events) {
        const result = await watcher.onMarketEvent(event);
        results.push({ watcherId, market, outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
      }
    }
  }

  return json({ accepted: results.length, results }, 200, cors);
}

/**
 * Which watchers watch a market.
 *
 * A Durable Object namespace cannot be enumerated, so the mapping is
 * kept in a tiny index object per market. That is a deliberate
 * trade-off: a queryable index is the price of fanning out by symbol,
 * and it is the one piece of cross-watcher state in the design.
 */
async function watchersForMarket(env: Env, market: string): Promise<string[]> {
  const index = env.MARKET_INDEX.get(env.MARKET_INDEX.idFromName(`market:${market}`)) as unknown as MarketIndexObject;
  const identities = await index.list();
  return identities.map((identity) => watcherIdFor(identity));
}

/* ------------------------------------------------------------------ *
 * Watcher routes
 * ------------------------------------------------------------------ */

async function listWatchers(request: Request, env: Env, userId: string, cors: Record<string, string>): Promise<Response> {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`user:${userId}`)) as unknown as UserRegistryObject;
  const identities = await registry.list();
  const results = await Promise.all(
    identities.map(async (identity) => {
      const watcher = env.WATCHERS.get(env.WATCHERS.idFromName(watcherIdFor(identity))) as unknown as WatcherObject;
      const health = await watcher.health();
      return { identity, health };
    }),
  );
  return json({ watchers: results }, 200, cors);
}

async function deployWatcher(request: Request, env: Env, userId: string, cors: Record<string, string>): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { goatId?: string; deploymentId?: string; config?: WatcherConfig } | null;
  if (!body || !body.goatId || !body.deploymentId || !body.config) {
    return json({ error: 'BAD_REQUEST', message: 'Expected { goatId, deploymentId, config }.' }, 400, cors);
  }

  const validation = validateWatcherConfig(body.config);
  if (!validation.valid) {
    return json({ error: 'CONFIG_ERROR', problems: validation.problems }, 422, cors);
  }

  // The owner comes from the token, never from the body. Trusting a
  // userId in the request would let anyone deploy into another user's
  // namespace by writing their id in the payload.
  const identity: WatcherIdentity = { userId, goatId: body.goatId, deploymentId: body.deploymentId };
  const watcherId = watcherIdFor(identity);

  const stub = env.WATCHERS.get(env.WATCHERS.idFromName(watcherId));
  const watcher = stub as unknown as WatcherObject;
  const result = await watcher.deploy({ identity, config: body.config, expectedWatcherId: watcherId });

  if (result.problems.length > 0) {
    return json({ error: 'CONFIG_ERROR', problems: result.problems, watcherId }, 422, cors);
  }

  // Register in the two indexes. Both are idempotent.
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`user:${userId}`)) as unknown as UserRegistryObject;
  await registry.add(identity);
  const marketIndex = env.MARKET_INDEX.get(env.MARKET_INDEX.idFromName(`market:${body.config.market}`)) as unknown as MarketIndexObject;
  await marketIndex.add(identity);

  return json(
    {
      watcherId,
      status: result.status,
      created: result.created,
      configVersion: result.configVersion,
      discardedWakes: result.discarded.length,
    },
    result.created ? 201 : 200,
    cors,
  );
}

async function handleWatcherRoute(
  request: Request,
  env: Env,
  userId: string,
  watcherId: string,
  action: string | undefined,
  cors: Record<string, string>,
): Promise<Response> {
  const stub = env.WATCHERS.get(env.WATCHERS.idFromName(watcherId));
  const watcher = stub as unknown as WatcherObject;

  /*
   * Ownership.
   *
   * The object is addressed by a digest of (userId, goatId,
   * deploymentId), so knowing the id is not proof of ownership. This
   * check is the only thing standing between a leaked id and another
   * user's bot, and it runs before any read or write.
   */
  const snapshot = (await watcher.snapshot()) as { state?: { identity?: WatcherIdentity } } | null;
  const identity = snapshot?.state?.identity;
  if (!identity) {
    return json({ error: 'NOT_FOUND', message: 'No watcher with that id, or it has not been deployed.' }, 404, cors);
  }
  if (!isOwnedBy(identity, userId)) {
    // 404, not 403: confirming that the id exists would itself leak that
    // another user has a bot there.
    return json({ error: 'NOT_FOUND', message: 'No watcher with that id.' }, 404, cors);
  }

  if (!action) {
    if (request.method === 'GET') return json(snapshot, 200, cors);
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405, cors);
  }

  if (action === 'health' && request.method === 'GET') {
    return json(await watcher.health(), 200, cors);
  }

  if (action === 'wakes' && request.method === 'GET') {
    const pending = await watcher.pendingWakes();
    return json({ pending }, 200, cors);
  }

  if (action === 'wakes:claim' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { limit?: number };
    const claimed = await watcher.claimWakes(Math.min(body.limit ?? 10, 50));
    return json({ claimed }, 200, cors);
  }

  if (action === 'wakes:resolve' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { wakeId?: string; outcome?: string } | null;
    if (!body?.wakeId || !body.outcome) {
      return json({ error: 'BAD_REQUEST', message: 'Expected { wakeId, outcome }.' }, 400, cors);
    }
    const result = await watcher.resolveWake(body.wakeId, body.outcome as never);
    return json(result, 200, cors);
  }

  if (request.method === 'POST' && ['start', 'pause', 'resume', 'stop', 'retry', 'deploy'].includes(action)) {
    const result = await watcher.act(action as WatcherAction);
    if (result.problems.length > 0) {
      return json({ error: 'INVALID_TRANSITION', problems: result.problems, status: result.status }, 409, cors);
    }
    return json({ status: result.status, discardedWakes: result.discarded.length }, 200, cors);
  }

  return json({ error: 'NOT_FOUND', message: `Unknown action "${action}".` }, 404, cors);
}

/* ------------------------------------------------------------------ *
 * Index objects
 * ------------------------------------------------------------------ */

/**
 * A per-user list of deployments.
 *
 * One small Durable Object per user, holding ids only. The reason it is
 * an Object rather than KV: listing is a read-modify-write, and doing
 * that concurrently on KV loses entries.
 */
export class UserRegistryObject extends DurableObject<Env> {
  private readonly listKey = 'identities';

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async add(identity: WatcherIdentity): Promise<void> {
    const existing = (await this.ctx.storage.get<WatcherIdentity[]>(this.listKey)) ?? [];
    if (existing.some((entry) => entry.deploymentId === identity.deploymentId)) {
      // Idempotent: a retried deploy must not duplicate the entry.
      return;
    }
    existing.push(identity);
    await this.ctx.storage.put(this.listKey, existing);
  }

  async remove(deploymentId: string): Promise<boolean> {
    const existing = (await this.ctx.storage.get<WatcherIdentity[]>(this.listKey)) ?? [];
    const next = existing.filter((entry) => entry.deploymentId !== deploymentId);
    await this.ctx.storage.put(this.listKey, next);
    return next.length !== existing.length;
  }

  async list(): Promise<WatcherIdentity[]> {
    return (await this.ctx.storage.get<WatcherIdentity[]>(this.listKey)) ?? [];
  }
}

/**
 * One request budget per caller.
 *
 * An Object rather than KV because the read-modify-write has to be
 * serialized: two concurrent requests reading the same count and both
 * writing back `count + 1` would let a client exceed the limit by
 * exactly as much as it sends in parallel, which is the one case that
 * matters for an abuse control.
 */
export class RateLimitObject extends DurableObject<Env> {
  private readonly stateKey = 'window';

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async take(bucket: RateBucket, now: number): Promise<RateDecision> {
    const stored = await this.ctx.storage.get<RateLimitState>(this.stateKey);
    const { state, decision } = consume(stored, bucket, now);
    await this.ctx.storage.put(this.stateKey, state);
    return decision;
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/** Spend one request from a caller's budget. */
async function consumeRate(env: Env, bucket: RateBucket, key: string): Promise<RateDecision> {
  if (!env.RATE_LIMITS) {
    /*
     * Failing open on a missing binding is deliberate and loud. The
     * alternative -- refusing every request because a binding was
     * forgotten -- takes the whole watcher tier down, and the abuse
     * this bounds is bounded by the platform's own protections until
     * the binding exists.
     */
    return { allowed: true, limit: 0, remaining: 0, retryAfterSeconds: 0 };
  }
  const stub = env.RATE_LIMITS.get(env.RATE_LIMITS.idFromName(key)) as unknown as RateLimitObject;
  return stub.take(bucket, Date.now());
}

function rateLimited(decision: RateDecision, cors: Record<string, string>): Response {
  return json(
    { error: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    429,
    {
      ...cors,
      'Retry-After': String(decision.retryAfterSeconds),
      'X-RateLimit-Limit': String(decision.limit),
      'X-RateLimit-Remaining': '0',
    },
  );
}

/** Run a handler only if the caller has budget left for this bucket. */
async function limited(
  request: Request,
  env: Env,
  userId: string,
  bucket: RateBucket,
  cors: Record<string, string>,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (isPreflight(request.method)) return handler();
  const decision = await consumeRate(env, bucket, `user:${userId}`);
  if (!decision.allowed) return rateLimited(decision, cors);
  const response = await handler();
  response.headers.set('X-RateLimit-Limit', String(decision.limit));
  response.headers.set('X-RateLimit-Remaining', String(decision.remaining));
  return response;
}

/** A per-market list of deployments, so a feed can fan out by symbol. */
export class MarketIndexObject extends DurableObject<Env> {
  private readonly listKey = 'identities';

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async add(identity: WatcherIdentity): Promise<void> {
    const existing = (await this.ctx.storage.get<WatcherIdentity[]>(this.listKey)) ?? [];
    if (existing.some((entry) => entry.deploymentId === identity.deploymentId)) return;
    existing.push(identity);
    await this.ctx.storage.put(this.listKey, existing);
  }

  async list(): Promise<WatcherIdentity[]> {
    return (await this.ctx.storage.get<WatcherIdentity[]>(this.listKey)) ?? [];
  }
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/**
 * Identify the caller, or refuse.
 *
 * Thin wrapper over `identifyCaller`, so a route reads as "who is this, and is
 * that anybody?" rather than reaching for a header.
 */
async function authenticate(request: Request, env: Env): Promise<string | null> {
  const caller = await identifyCaller(request, env);
  return caller.userId.length > 0 ? caller.userId : null;
}

/** Length-independent comparison, so a mismatch does not leak by timing. */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * CORS.
 *
 * An allowlist, never `*`, because the browser is expected to carry an
 * authorization token and a wildcard origin would let any site make
 * authenticated requests on a user's behalf. A request with an
 * `Origin` that is not allowed simply gets no CORS headers, so the
 * browser blocks it.
 */
function applyCors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const headers: Record<string, string> = { ...NO_STORE };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-User-Id, X-Feed-Token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(payload: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export type { HealthReport };
