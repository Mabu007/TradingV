/**
 * Correlation ids for the watcher tier.
 *
 * The rule that makes duplicate suppression work: an id derived from
 * *what happened* is stable, so redelivering the same market event
 * produces the same wake id and the consumer can drop it without a
 * round trip. Ids derived from a clock or a counter are not, and would
 * need durable state to deduplicate.
 *
 * These are short digests, not cryptographic commitments. They contain
 * no secret and are never an authorisation token.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the joined parts.
 *
 * Dependency-free on purpose: this runs inside a Durable Object, where a
 * bundled hashing library is a cost with no benefit, and the input is
 * short and non-adversarial.
 */
export function digest(...parts: Array<string | number | null | undefined>): string {
  const input = parts.map((part) => String(part ?? '')).join('|');
  let hash = FNV_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  // Two independent rounds, so a short input still produces a long id
  // and the odds of a collision across thousands of watchers are
  // negligible.
  const second = mix(hash ^ FNV_OFFSET);
  return (hash >>> 0).toString(36).padStart(7, '0') + (second >>> 0).toString(36).padStart(6, '0');
}

function mix(value: number): number {
  let out = value >>> 0;
  out ^= out >>> 16;
  out = Math.imul(out, 0x85ebca6b) >>> 0;
  out ^= out >>> 13;
  out = Math.imul(out, 0xc2b2ae35) >>> 0;
  out ^= out >>> 16;
  return out >>> 0;
}

/** The watcher id for a deployment. Stable, and independent of configuration. */
export function watcherIdFor(identity: { userId: string; goatId: string; deploymentId: string }): string {
  return `w_${digest(identity.userId, identity.goatId, identity.deploymentId)}`;
}

/** The evaluation id for one (market event, configuration version) pair. */
export function evaluationIdFor(watcherId: string, marketEventId: string, configVersion: number): string {
  return `ev_${digest(watcherId, marketEventId, configVersion)}`;
}

/**
 * The wake id for a market event under a configuration.
 *
 * Deterministic, which is the whole point: the same event redelivered,
 * or replayed after a restart, produces the same id and is dropped rather
 * than waking the bot twice. `configVersion` is included so that editing
 * the bot produces a *new* wake for the same market event, which is
 * correct: that is genuinely different work.
 */
export function wakeIdFor(watcherId: string, marketEventId: string, configVersion: number): string {
  return `wk_${digest(watcherId, marketEventId, configVersion)}`;
}

/**
 * The idempotency key for an order attempt.
 *
 * Stable across retries of the same intent, different for a deliberate
 * second trade. A retry after a lost response must reuse this so the
 * venue can collapse it, which is the difference between one order and
 * two.
 */
export function idempotencyKeyFor(wakeId: string, attempt: number): string {
  return `tv-${wakeId}-a${attempt}`;
}

/** A random id, for things that must not collide rather than be reproducible. */
export function randomId(prefix: string, entropy?: () => number): string {
  const next = entropy ?? Math.random;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(next() * 0xffffff).toString(36)}`;
}
