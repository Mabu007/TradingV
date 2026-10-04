/**
 * The one place the browser's two backends are related.
 *
 * Firebase holds the identity and the product data. The watcher service holds the
 * durable runtime. They are joined by exactly one thing: a Firebase ID token, and
 * the rule that nothing else may cross between them.
 *
 * ```
 *   Firebase Auth ──idToken()──▶ WatchersClient ──Authorization: Bearer──▶ Worker
 *        │                                                                       │
 *        └── uid ──▶ Firestore users/{uid}/…                                      │
 *                            and the worker's identity is (uid, goatId, deploymentId)
 * ```
 *
 * The user id the worker derives from the token is the same uid the Firestore
 * rules key ownership on, so the two databases agree about who owns what without
 * either one being told about the other.
 *
 * ## What is not here
 *
 * No orchestration. This module builds the two clients and knows how to name the
 * identity a deployment registers under; deciding *when* to deploy is
 * `GoatOrchestrator`'s job, and duplicating that decision here would give the
 * runtime two places that could disagree about whether a GOAT is running.
 */

import { firebaseServices } from '../firebase/configure';
import {
  createWatchersClient,
  type WatchersClient,
} from './watchersClient';

export interface RuntimeServices {
  /** The watcher client, when the service is configured. */
  watchers: WatchersClient | null;
  /** Why there is no client, when there is not one. */
  unavailableReason: string | null;
  /** Whether the watcher service answered its health check. Null when unknown. */
  reachable: boolean | null;
}

let built: RuntimeServices | null = null;

/**
 * Build the runtime services from the environment.
 *
 * The token provider is a closure over the Firebase session rather than a token
 * captured at build time, because the session can be established or lost at any
 * point — a token captured once would be presented long after it expired.
 */
export function configureRuntimeServices(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<string, string | undefined>,
): RuntimeServices {
  const firebase = firebaseServices();
  const builtClient = createWatchersClient(env, async () => firebase.backend?.auth.idToken() ?? null);

  if ('unavailable' in builtClient) {
    built = { watchers: null, unavailableReason: builtClient.unavailable, reachable: null };
    return built;
  }

  built = { watchers: builtClient.client, unavailableReason: null, reachable: null };
  return built;
}

/** The services, building them on first use. */
export function runtimeServices(): RuntimeServices {
  return built ?? configureRuntimeServices();
}

/**
 * Ask the watcher service whether it is there.
 *
 * Deliberately the only method called without a session: a health check answers
 * "is this configured and reachable", which is useful before anybody signs in.
 * The result is cached because a status line must not become a polling loop.
 */
export async function probeWatcherService(): Promise<boolean> {
  const services = runtimeServices();
  if (services.watchers === null) return false;
  if (services.reachable !== null) return services.reachable;
  const reachable = await services.watchers.healthy();
  services.reachable = reachable;
  return reachable;
}

/** Forget the health result, so a status line can refresh it. */
export function resetRuntimeProbe(): void {
  if (built !== null) built.reachable = null;
}