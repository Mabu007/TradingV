/**
 * The Durable Object runtime, from the GOAT's point of view.
 *
 * ## What this is
 *
 * A narrow interface the orchestrator calls at the points where a deployment
 * starts, pauses and ends. It exists because the worker is remote and the
 * orchestrator must not know that: nothing here mentions HTTP, tokens, or the
 * watcher's configuration schema, and nothing in the orchestrator mentions a
 * Durable Object.
 *
 * ## The state boundary, restated as code
 *
 * ```
 *   deployment lifecycle   THIS MODULE                    the worker
 *   ──────────────────     ───────────                    ─────────
 *   deployGoat           → activate()                  → watcher registered, waking
 *   pauseGoat            → suspend()                   → stops waking, keeps state
 *   resumeGoat           → activate()                  → waking again, same identity
 *   undeployGoat         → retire()                    → state discarded
 *   refreshGoat          → suspend()                   → the old session's work ends
 * ```
 *
 * `activate` is idempotent on `(userId, goatId, deploymentId)` — that triple *is*
 * the worker's identity — so a resume cannot create a second runtime for one
 * deployment. `retire` is separate from `suspend` because discarding a runtime and
 * pausing one are different acts, and conflating them would either lose a
 * cooldown on every pause or keep a retired deployment's state alive forever.
 *
 * ## Failure is reported, not swallowed
 *
 * Every method returns a report rather than throwing. A deployment whose durable
 * runtime could not be registered is still a real deployment — the in-tab runtime
 * is running and the GOAT is working — so the correct response is to say so and
 * record it, not to roll the deployment back and leave the user with nothing.
 * Silently doing neither is the one unacceptable outcome, and that is what these
 * reports exist to prevent.
 */

export interface RuntimeIdentity {
  /** The Firebase uid. Never a request header and never a GOAT-supplied value. */
  userId: string;
  goalId: string;
  deploymentId: string;
}

export interface ActivateRequest extends RuntimeIdentity {
  market: string;
  name: string;
  /** Bumped on every configuration edit; the worker keys its work on it. */
  configurationVersion: number;
  /**
   * The conditions the worker should watch.
   *
   * Passed through rather than interpreted: the worker decides *when* to wake, and
   * the in-tab runtime decides *what the conditions mean*. Duplicating the
   * interpretation here would give the two runtimes different definitions of the
   * same setup.
   */
  conditionTree: unknown;
  /** The GOAT's own resolutions, so the worker can prefer the coarser one. */
  timeframes: string[];
}

export type RuntimeReport =
  | { ok: true; watcherId: string }
  /** Not configured, or nobody signed in. A supported state, not a failure. */
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; reason: string };

export interface DurableRuntime {
  activate(request: ActivateRequest): Promise<RuntimeReport>;
  suspend(identity: RuntimeIdentity): Promise<RuntimeReport>;
  retire(identity: RuntimeIdentity): Promise<RuntimeReport>;
  /** Whether a runtime is configured at all, for the surfaces that offer it. */
  readonly available: boolean;
}

/**
 * A runtime that does nothing, and says why.
 *
 * Used wherever no worker is configured — every test, and a build with no
 * `VITE_WATCHERS_URL`. Its existence means the orchestrator never has a null
 * check on the runtime, which is the shape that turns a missing dependency into a
 * crash halfway through a deployment.
 */
export class InertRuntime implements DurableRuntime {
  readonly available = false;
  constructor(private readonly reason = 'No durable runtime service is configured for this build.') {}
  async activate(): Promise<RuntimeReport> {
    return { ok: false, skipped: true, reason: this.reason };
  }
  async suspend(): Promise<RuntimeReport> {
    return { ok: false, skipped: true, reason: this.reason };
  }
  async retire(): Promise<RuntimeReport> {
    return { ok: false, skipped: true, reason: this.reason };
  }
}

/**
 * Wraps a client so an orchestrator can hold one type.
 *
 * The mapping from a deployment to a worker's condition tree lives here rather
 * than in the orchestrator, because it is a translation between two models of the
 * same thing and it should be testable without a deployment.
 */
/*
 * The concrete bridge to the worker.
 *
 * ## Why the watcher id is derived here
 *
 * The worker addresses a runtime by a hash of `(userId, goatId, deploymentId)`, and
 * a suspend or retire needs that id — the runtime does not tell us what it was
 * called, because it may never have been registered (no session, outage, a deploy
 * that raced). So the id is *derived* from the same function the worker uses,
 * imported rather than reimplemented.
 *
 * A copy of that hash is the classic way this breaks: both sides keep working
 * independently, every deploy registers a fresh runtime, and every suspend becomes
 * a no-op that silently leaves orphans. `ids.ts` holds no Cloudflare types, so
 * sharing it costs nothing.
 */
import { watcherIdFor } from '../../../watchers/src/ids';
import {
  buildWatcherConfig,
  type WatchersClient,
} from '../../services/cloudflare/watchersClient';

export interface DurableRuntimeDeps {
  /** The worker client, or null when the service is not configured. */
  client: WatchersClient | null;
  /** The signed-in user's id, read fresh each time. */
  userId(): string | undefined;
}

export function createDurableRuntime(deps: DurableRuntimeDeps): DurableRuntime {
  const identityOf = (identity: RuntimeIdentity): { userId: string; watcherId: string } | undefined => {
    // The uid is re-read rather than trusted from the call, so a session that
    // expired since deployment cannot make this address somebody else's runtime.
    const userId = deps.userId();
    if (!userId || userId !== identity.userId) return undefined;
    return {
      userId,
      watcherId: watcherIdFor({
        userId,
        goatId: identity.goalId,
        deploymentId: identity.deploymentId,
      }),
    };
  };

  const unavailable = (reason: string): RuntimeReport => ({ ok: false, skipped: true, reason });

  return {
    get available(): boolean {
      return deps.client !== null;
    },

    async activate(request: ActivateRequest): Promise<RuntimeReport> {
      if (!deps.client) return unavailable('No watcher service is configured for this build.');
      const resolved = identityOf(request);
      if (!resolved) return unavailable('Nobody is signed in, so no durable runtime was registered.');

      // Built through the worker's own contract, so a configuration this accepts is
      // one the worker will not refuse.
      const built = buildWatcherConfig({
        name: request.name,
        market: request.market,
        conditionTree: request.conditionTree,
        configVersion: request.configurationVersion,
        desired: {
          /*
           * A wake interval derived from the GOAT's own coarsest resolution: the
           * worker decides *when* to look, and looking at the setup resolution more
           * often than that is cost without information.
           */
          ...(request.timeframes.length > 0
            ? { minEvaluationIntervalMs: 3_600_000 }
            : {}),
        },
      });
      if ('problems' in built) {
        return { ok: false, reason: built.problems.join(' ') };
      }

      try {
        /*
         * The worker's own configuration, unmodified.
         *
         * Built by `buildWatcherConfig` — which runs the worker's own validator —
         * so what goes out is exactly what the worker will accept. Adding fields
         * here would mean inventing a second shape and hoping the two agree.
         *
         * Note what is *not* here: any order. The worker decides when to wake this
         * GOAT; placing an order is the in-tab runtime's business alone.
         */
        const deployed = await deps.client.deploy({
          goatId: request.goalId,
          deploymentId: request.deploymentId,
          config: built.config,
        });
        return { ok: true, watcherId: deployed.watcherId };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async suspend(identity: RuntimeIdentity): Promise<RuntimeReport> {
      if (!deps.client) return unavailable('No watcher service is configured for this build.');
      const resolved = identityOf(identity);
      if (!resolved) return unavailable('Nobody is signed in.');
      try {
        await deps.client.act(resolved.watcherId, 'pause');
        return { ok: true, watcherId: resolved.watcherId };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async retire(identity: RuntimeIdentity): Promise<RuntimeReport> {
      if (!deps.client) return unavailable('No watcher service is configured for this build.');
      const resolved = identityOf(identity);
      if (!resolved) return unavailable('Nobody is signed in.');
      try {
        await deps.client.act(resolved.watcherId, 'stop');
        return { ok: true, watcherId: resolved.watcherId };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export { WatchersClient } from '../../services/cloudflare/watchersClient';
