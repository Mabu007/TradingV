/**
 * Tests for caller identification.
 *
 * The most important test in this file is `a caller cannot choose which user it
 * is`. It is a regression test for a real hole: the previous implementation
 * compared a shared secret and then returned `request.headers.get('X-User-Id')`,
 * which meant one token was authority over every account. If that test ever fails,
 * the change that broke it is the most serious thing that has happened here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import { identifyCaller, resetKeyCache } from '../src/auth';
import type { Env } from '../src/env';

const PROJECT_ID = 'tradecode-test';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

/*
 * `CryptoKey`, not jose's old `KeyLike`.
 *
 * jose 6 dropped the `KeyLike` export in favour of the WebCrypto type, which is
 * what `generateKeyPair` actually returns here. Naming the real return type keeps
 * this compiling against the SDK's own signature rather than a shim.
 */
let privateKey: CryptoKey;
let jwk: JWK;

/** Sign a token Firebase would accept. */
async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    ...overrides,
    iss: ISSUER,
    aud: PROJECT_ID,
    sub: 'user_alice',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
}

/** A request carrying a bearer token. */
function callWith(bearer: string | null, headers: Record<string, string> = {}): Request {
  return new Request('https://watchers.test/watchers', {
    headers: {
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
      ...headers,
    },
  });
}

function env(overrides: Partial<Env> = {}): Env {
  return { FIREBASE_PROJECT_ID: PROJECT_ID, ...overrides } as Env;
}

beforeEach(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  resetKeyCache();

  // The worker fetches Google's keys over the network; serving our own here is
  // what makes the signature actually checked rather than assumed.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('jwk')) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetKeyCache();
});

describe('identifyCaller', () => {
  it('accepts a valid Firebase ID token and returns its subject', async () => {
    const caller = await identifyCaller(callWith(await token()), env());
    expect(caller.via).toBe('FIREBASE');
    expect(caller.userId).toBe('user_alice');
  });

  it('refuses a request with no credentials at all', async () => {
    const caller = await identifyCaller(callWith(null), env());
    expect(caller.via).toBe('NONE');
    expect(caller.userId).toBe('');
  });

  it('refuses a token that is not signed by the expected key', async () => {
    // Signed by a *different* key, so the signature check must reject it.
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({
      iss: ISSUER,
      aud: PROJECT_ID,
      sub: 'user_alice',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(other.privateKey);

    const caller = await identifyCaller(callWith(forged), env());
    expect(caller.via).toBe('NONE');
  });

  it('refuses an expired token', async () => {
    const expired = await new SignJWT({
      iss: ISSUER,
      aud: PROJECT_ID,
      sub: 'user_alice',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);

    expect((await identifyCaller(callWith(expired), env())).via).toBe('NONE');
  });

  it('refuses a token minted for a different project', async () => {
    const foreign = await new SignJWT({
      iss: 'https://securetoken.google.com/some-other-project',
      aud: 'some-other-project',
      sub: 'user_alice',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);

    expect((await identifyCaller(callWith(foreign), env())).via).toBe('NONE');
  });

  it('refuses an unsigned "alg: none" token', async () => {
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '');
    const body = btoa(
      JSON.stringify({ iss: ISSUER, aud: PROJECT_ID, sub: 'user_alice', exp: 9999999999 }),
    ).replace(/=+$/, '');

    expect((await identifyCaller(callWith(`${header}.${body}.`), env())).via).toBe('NONE');
  });

  it('does not fall back to the development secret when a Firebase token fails', async () => {
    /*
     * The downgrade that must not happen.
     *
     * A browser with an expired token should be told it is unauthenticated. If a
     * failed Firebase check fell through to the shared secret, a stale token would
     * silently authenticate as the dev user instead — and, in an environment where
     * the secret is still configured, that is a way in.
     */
    const caller = await identifyCaller(callWith('not-a-real-token'), env({ AUTH_TOKEN: 'shared-secret' }));
    expect(caller.via).toBe('NONE');
    expect(caller.userId).toBe('');
  });

  describe('development fallback', () => {
    it('identifies a shared-secret caller as the single development user', async () => {
      const caller = await identifyCaller(
        callWith('shared-secret'),
        { AUTH_TOKEN: 'shared-secret' } as Env,
      );
      expect(caller.via).toBe('DEV_SHARED_SECRET');
      expect(caller.userId).toBe('v0-single-user');
    });

    it('a caller cannot choose which user it is', async () => {
      /*
       * The regression test.
       *
       * The old implementation returned the `X-User-Id` header after checking a
       * shared secret, so this request was user_victim with a perfectly valid
       * token. Now the header is not consulted at all: a caller with the secret
       * is the development user and nothing else.
       */
      const caller = await identifyCaller(
        callWith('shared-secret', { 'X-User-Id': 'user_victim' }),
        { AUTH_TOKEN: 'shared-secret' } as Env,
      );
      expect(caller.userId).not.toBe('user_victim');
      expect(caller.userId).toBe('v0-single-user');
    });

    it('is refused entirely when Firebase auth is required', async () => {
      const caller = await identifyCaller(
        callWith('shared-secret'),
        { AUTH_TOKEN: 'shared-secret', REQUIRE_FIREBASE_AUTH: 'true' } as Env,
      );
      expect(caller.via).toBe('NONE');
    });

    it('refuses the wrong secret', async () => {
      const caller = await identifyCaller(callWith('wrong'), { AUTH_TOKEN: 'shared-secret' } as Env);
      expect(caller.via).toBe('NONE');
    });
  });
});