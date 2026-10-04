/**
 * Worker and Durable Object integration.
 *
 * These run against Miniflare, so they exercise the real runtime: actual
 * Durable Object instances, actual storage, actual request routing, and
 * the authorisation gate in front of them. Everything above them is unit
 * tested without a runtime, which is the right split: the decision logic
 * does not need a runtime, but the *plumbing* does, and plumbing is where
 * identity, persistence and authorisation actually live.
 */

import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { watcherIdFor, type WatcherConfig, type WatcherIdentity } from '../src/contract';

const AUTH = 'test-auth-token';
const FEED = 'test-feed-token';

const IDENTITY: WatcherIdentity = { userId: 'v0-single-user', goatId: 'bot-1', deploymentId: 'dep-1' };
const T0 = 1_700_000_000_000;

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    configVersion: 1,
    name: 'Gold breakout',
    market: 'xyz:GOLD',
    conditionTree: {
      schemaVersion: 1,
      then: 'WAKE_AI',
      root: { id: 'g', kind: 'GROUP', operator: 'AND', children: [{ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 1 }] },
    },
    minEvaluationIntervalMs: 1_000,
    cooldownMs: 0,
    maxWakesPerHour: 60,
    maxWakesPerDay: 1_000,
    ...overrides,
  };
}

function authed(extra: Record<string, string> = {}): RequestInit {
  return { headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json', ...extra } };
}

function feedAuthed(body: unknown): RequestInit {
  return { headers: { 'X-Feed-Token': FEED, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://watcher.test${path}`, init as RequestInit);
}

async function deploy(identity: WatcherIdentity = IDENTITY, cfg: WatcherConfig = config()): Promise<Response> {
  return call('/watchers', {
    method: 'POST',
    ...authed(),
    body: JSON.stringify({ goatId: identity.goatId, deploymentId: identity.deploymentId, config: cfg }),
  });
}

describe('authentication', () => {
  it('refuses a request with no token', async () => {
    const response = await call('/watchers');
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('UNAUTHENTICATED');
  });

  it('refuses a request with the wrong token', async () => {
    const response = await call('/watchers', { headers: { Authorization: 'Bearer wrong' } });
    expect(response.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    const response = await call('/watchers', authed());
    expect(response.status).toBe(200);
  });

  it('does not let a user id in the body override the authenticated one', async () => {
    // Trusting a userId from the payload would let anyone deploy into
    // another user's namespace by writing their id in the JSON.
    const before = await call('/watchers', authed()).then((r) => r.json());
    await call('/watchers', {
      method: 'POST',
      ...authed(),
      body: JSON.stringify({ goatId: 'bot-x', deploymentId: 'dep-x', userId: 'someone-else', config: config() }),
    });
    const after = await call('/watchers', authed()).then((r) => r.json());
    const identities = after.watchers.map((w: { identity: WatcherIdentity }) => w.identity.userId);
    expect(identities.every((id: string) => id === 'v0-single-user')).toBe(true);
    expect(before.watchers.length).toBeLessThan(after.watchers.length);
  });
});

describe('deployment', () => {
  it('creates a watcher and returns 201', async () => {
    const response = await deploy({ ...IDENTITY, goatId: 'new-bot', deploymentId: 'new-dep' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(body.watcherId).toBe(watcherIdFor({ ...IDENTITY, goatId: 'new-bot', deploymentId: 'new-dep' }));
  });

  it('is idempotent: the same deployment twice is one watcher', async () => {
    const identity = { ...IDENTITY, goatId: 'idem-bot', deploymentId: 'idem-dep' };
    const first = await deploy(identity);
    expect(first.status).toBe(201);
    const second = await deploy(identity);
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);

    const list = await call('/watchers', authed()).then((r) => r.json());
    const matching = list.watchers.filter((w: { identity: WatcherIdentity }) => w.identity.deploymentId === 'idem-dep');
    expect(matching).toHaveLength(1);
  });

  it('a repeated identical deploy is a no-op, not an error', async () => {
    const identity = { ...IDENTITY, goatId: 'same-bot', deploymentId: 'same-dep' };
    await deploy(identity);
    const again = await deploy(identity);
    expect(again.status).toBe(200);
    expect((await again.json()).problems).toEqual([]);
  });

  it('rejects an invalid configuration with the problems listed', async () => {
    const response = await call('/watchers', {
      method: 'POST',
      ...authed(),
      body: JSON.stringify({ goatId: 'bad-bot', deploymentId: 'bad-dep', config: config({ maxWakesPerHour: 0 }) }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('CONFIG_ERROR');
  });

  it('rejects a request with no configuration at all', async () => {
    const response = await call('/watchers', { method: 'POST', ...authed(), body: JSON.stringify({ goatId: 'b', deploymentId: 'd' }) });
    expect(response.status).toBe(400);
  });
});

describe('lifecycle over HTTP', () => {
  it('walks a watcher to RUNNING and back', async () => {
    const identity = { ...IDENTITY, goatId: 'lc-bot', deploymentId: 'lc-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);

    const start = await call(`/watchers/${watcherId}/start`, { method: 'POST', ...authed() });
    expect(start.status).toBe(200);
    expect((await start.json()).status).toBe('RUNNING');

    const pause = await call(`/watchers/${watcherId}/pause`, { method: 'POST', ...authed() });
    expect((await pause.json()).status).toBe('PAUSED');

    const resume = await call(`/watchers/${watcherId}/resume`, { method: 'POST', ...authed() });
    expect((await resume.json()).status).toBe('RUNNING');

    const stop = await call(`/watchers/${watcherId}/stop`, { method: 'POST', ...authed() });
    expect((await stop.json()).status).toBe('STOPPING');
  });

  it('an invalid transition is a 409 with an explanation, not a silent no-op', async () => {
    const identity = { ...IDENTITY, goatId: 'tr-bot', deploymentId: 'tr-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);
    // Pausing a CREATED watcher is not allowed.
    const response = await call(`/watchers/${watcherId}/pause`, { method: 'POST', ...authed() });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('INVALID_TRANSITION');
    expect(body.problems.join()).toMatch(/Cannot pause/);
  });

  it('an unknown watcher id is a 404', async () => {
    const response = await call('/watchers/w_doesnotexist/health', authed());
    expect(response.status).toBe(404);
  });
});

describe('authorisation', () => {
  it('another user cannot read a watcher they do not own', async () => {
    const identity = { ...IDENTITY, goatId: 'own-bot', deploymentId: 'own-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);

    // Same token, different claimed user. The check compares the
    // watcher's own identity with the authenticated user, not the token.
    const response = await call(`/watchers/${watcherId}/health`, authed({ 'X-User-Id': 'someone-else' }));
    expect(response.status).toBe(404);
  });

  it('another user cannot stop a watcher they do not own', async () => {
    const identity = { ...IDENTITY, goatId: 'stop-bot', deploymentId: 'stop-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);
    const response = await call(`/watchers/${watcherId}/stop`, { method: 'POST', ...authed({ 'X-User-Id': 'attacker' }) });
    expect(response.status).toBe(404);
  });

  it('a 404 for someone else does not confirm the watcher exists', async () => {
    // Answering 403 would be an oracle for enumerating other users' bots.
    const identity = { ...IDENTITY, goatId: 'oracle-bot', deploymentId: 'oracle-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);
    const foreign = await call(`/watchers/${watcherId}/health`, authed({ 'X-User-Id': 'attacker' }));
    const absent = await call('/watchers/w_nothinghere/health', authed({ 'X-User-Id': 'attacker' }));
    expect(foreign.status).toBe(absent.status);
    expect(await foreign.text()).toBe(await absent.text());
  });
});

describe('the market feed', () => {
  it('is closed when no token is configured', async () => {
    // Failing closed: an open feed would let anyone wake anyone's bot.
    const response = await call('/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [] }) });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('FEED_DISABLED');
  });

  it('refuses a wrong feed token', async () => {
    const response = await call('/feed', { method: 'POST', headers: { 'X-Feed-Token': 'wrong' }, body: JSON.stringify({ events: [] }) });
    expect(response.status).toBe(401);
  });

  it('accepts an authenticated feed and reports what it did', async () => {
    const response = await call('/feed', feedAuthed({
      events: [{ marketEventId: 'feed-1', market: 'xyz:GOLD', timestamp: T0, eventType: 'QUOTE', price: 2300 }],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('rejects a malformed feed body', async () => {
    const response = await call('/feed', { method: 'POST', headers: { 'X-Feed-Token': FEED }, body: JSON.stringify({ nope: true }) });
    expect(response.status).toBe(400);
  });

  it('rejects an oversized batch rather than processing it', async () => {
    const events = Array.from({ length: 1001 }, (_, index) => ({ marketEventId: `e${index}`, market: 'xyz:GOLD', timestamp: T0 }));
    const response = await call('/feed', feedAuthed({ events }));
    expect(response.status).toBe(413);
  });

  it('does not let the feed path be used as a user path', async () => {
    // A user token must not authenticate a price feed.
    const response = await call('/feed', { method: 'POST', ...authed(), body: JSON.stringify({ events: [] }) });
    expect(response.status).toBe(401);
  });
});

describe('health over HTTP', () => {
  it('reports the shape the UI needs', async () => {
    const identity = { ...IDENTITY, goatId: 'health-bot', deploymentId: 'health-dep' };
    await deploy(identity);
    const watcherId = watcherIdFor(identity);
    await call(`/watchers/${watcherId}/start`, { method: 'POST', ...authed() });

    const body = await call(`/watchers/${watcherId}/health`, authed()).then((r) => r.json());
    expect(body).toMatchObject({ watcherId, status: 'RUNNING', configVersion: 1 });
    expect(typeof body.healthy).toBe('boolean');
    expect(typeof body.summary).toBe('string');
    expect(body.age).toHaveProperty('marketData');
    expect(body.age).toHaveProperty('evaluation');
    expect(body.pendingWakes).toBe(0);
  });
});

describe('CORS', () => {
  it('does not return an allow-all origin', async () => {
    const response = await call('/health', { headers: { Origin: 'https://evil.example' } });
    // No allowlist entry, so no CORS headers: the browser blocks it.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows a configured origin', async () => {
    const response = await call('/health', { headers: { Origin: 'http://localhost:3000' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight', async () => {
    const response = await call('/watchers', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('observability', () => {
  it('health responses are not cacheable', async () => {
    // A cached health response would show a watcher as running after it
    // stopped.
    const response = await call('/health');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
