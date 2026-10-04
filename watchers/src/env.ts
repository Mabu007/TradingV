/** The bindings and secrets this worker reads. */
import type { WatcherEnv } from './durable-object';

export interface Env extends WatcherEnv {
  /** Watchers. One object per (userId, goatId, deploymentId). */
  WATCHERS: DurableObjectNamespace;
  /** Per-user list of deployments, so a user can list their watchers. */
  REGISTRY: DurableObjectNamespace;
  /** Per-market list of deployments, so a feed can fan out by symbol. */
  MARKET_INDEX: DurableObjectNamespace;
  /** Per-user request budget, so one caller cannot spin objects. */
  RATE_LIMITS: DurableObjectNamespace;
  /**
   * Shared secret for the market-data feed.
   *
   * Compared with a constant-time comparison, and rejected outright when
   * unset: an unauthenticated feed would let anyone wake any bot.
   */
  MARKET_FEED_TOKEN?: string;
  /**
   * The Firebase project whose ID tokens this worker accepts.
   *
   * Set this and callers are identified by a verified Firebase ID token; the user
   * id comes from the token's signed `sub` claim and cannot be chosen by the
   * caller. Without it the worker falls back to the development secret below,
   * which is why `REQUIRE_FIREBASE_AUTH` exists.
   */
  FIREBASE_PROJECT_ID?: string;
  /**
   * `'true'` refuses every non-Firebase identity.
   *
   * The switch that makes "we forgot to configure the project id" a startup
   * failure in production rather than a silent downgrade to a single shared user.
   */
  REQUIRE_FIREBASE_AUTH?: string;
  /**
   * Development-only shared secret.
   *
   * No longer able to name a user: on this path the caller is the fixed
   * `v0-single-user`. It exists so `wrangler dev` works without a Firebase
   * project, and it must never be the production path.
   */
  AUTH_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
}
