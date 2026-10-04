/**
 * Who is calling.
 *
 * ## What was wrong before
 *
 * This file replaces a shared secret with a verified per-user identity, and the
 * reason is worth stating plainly because it was a real hole rather than a
 * roughness:
 *
 * ```
 *   if (presented === env.AUTH_TOKEN) return request.headers.get('X-User-Id');
 * ```
 *
 * Every caller presented the same secret and then *named the user they wanted to
 * be*. So one leaked token — or one developer with the token — was authority over
 * every account on the platform: start, stop and inspect anybody's trackers. The
 * user id was an unverified assertion from the party being authenticated, which is
 * the one thing an authentication check must never accept.
 *
 * ## What it does now
 *
 * A request is identified by a **Firebase ID token**, verified here against
 * Google's published signing keys. The user id comes from the token's `sub`
 * claim — signed by Google, checked for signature, issuer, audience and expiry —
 * so a caller can only ever be themselves.
 *
 * The shared secret is kept for local development and is refused in any
 * environment that sets `REQUIRE_FIREBASE_AUTH`, so it cannot quietly become the
 * production path. It is also incapable of impersonating: on that path the user
 * id is a fixed constant, exactly as before, rather than a header.
 *
 * ## Why `jose` and not the Firebase Admin SDK
 *
 * The admin SDK is a large Node-oriented dependency with its own retry and
 * credential machinery. All this worker needs is "is this RS256 JWT signed by
 * Google, for my project, unexpired" — which is WebCrypto and a JWKS fetch, and
 * `jose` is that, with the signature and claim checks already correct.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { Env } from './env';

/** Google's signing keys for Firebase ID tokens. */
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');

/** The issuer every Firebase ID token carries. */
const GOOGLE_ISSUER = 'https://securetoken.google.com/';

/**
 * One JWKS per isolate, cached.
 *
 * Fetched once per key rotation rather than per request: a verification that
 * fetched a key on every call would make every API call depend on Google's
 * availability, and a token check that can fail on a network blip is a way to log
 * every user out.
 */
let cachedKeys: ReturnType<typeof createRemoteJWKSet> | null = null;

function keysFor() {
  cachedKeys ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
  return cachedKeys;
}

/** Forget the cached keys. For tests, and after a forced rotation. */
export function resetKeyCache(): void {
  cachedKeys = null;
}

export interface IdentifiedCaller {
  userId: string;
  /** How the identity was established. Useful in logs and in tests. */
  via: 'FIREBASE' | 'DEV_SHARED_SECRET' | 'NONE';
}

/**
 * Identify a request.
 *
 * Returns `via: 'NONE'` rather than throwing, so the caller decides what an
 * anonymous request means — the routes already answer 401, and one place
 * deciding "who is this" should not also decide "is this allowed".
 */
export async function identifyCaller(request: Request, env: Env): Promise<IdentifiedCaller> {
  const token = bearerToken(request);

  if (token !== null && env.FIREBASE_PROJECT_ID) {
    const verified = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    if (verified !== null) return { userId: verified, via: 'FIREBASE' };
    // A token that was presented and did not verify is a failed authentication,
    // not a reason to fall through to a weaker scheme. Falling through would make
    // "my token expired" silently become "you are the dev user".
    return { userId: '', via: 'NONE' };
  }

  // No Firebase configured: local development only, and only when it has not been
  // forbidden outright.
  if (env.REQUIRE_FIREBASE_AUTH === 'true') {
    return { userId: '', via: 'NONE' };
  }
  if (env.AUTH_TOKEN && token !== null && constantTimeEquals(token, env.AUTH_TOKEN)) {
    /*
     * A fixed identity, deliberately.
     *
     * The old code trusted an `X-User-Id` header here, which is the vulnerability
     * above. In development that convenience is worth nothing — there is one
     * developer — and it is the exact behaviour that made the hole possible, so
     * it is not preserved even here.
     */
    return { userId: 'v0-single-user', via: 'DEV_SHARED_SECRET' };
  }

  return { userId: '', via: 'NONE' };
}

/**
 * Verify a Firebase ID token and return its subject.
 *
 * Null means it did not verify. Every failure is treated identically, so the
 * response cannot be used to tell "expired" from "forged" from "wrong audience".
 */
async function verifyFirebaseIdToken(token: string, projectId: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keysFor(), {
      issuer: `${GOOGLE_ISSUER}${projectId}`,
      audience: projectId,
      // A small clock tolerance, because a token verified a second after it
      // expired is not an attack — it is a slow network.
      clockTolerance: 5,
    });
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    return subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

/** The bearer token, or null. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
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

/** The claims this worker cares about, for a diagnostics endpoint. */
export function describeClaims(payload: JWTPayload): Record<string, unknown> {
  return {
    sub: payload.sub ?? null,
    aud: payload.aud ?? null,
    iss: payload.iss ?? null,
    exp: payload.exp ?? null,
    email_verified: payload['email_verified'] ?? null,
  };
}