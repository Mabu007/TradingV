/**
 * The watcher contract.
 *
 * A watcher is one deployed bot. It holds a copy of the bot's condition
 * tree, decides when a market event has produced a new edge, and emits
 * wakes. It does not evaluate conditions (the Python engine does) and it
 * does not trade.
 *
 * ## Identity
 *
 * A watcher is addressed by `userId + goatId + deploymentId` and nothing
 * else. Deliberately *not* by the condition tree, the bot's name, or its
 * market: a watcher whose id changed when the user edited a condition
 * would silently become a second watcher, while the first kept waking on
 * a configuration nobody could see any more. Editing a bot updates the
 * configuration in place and bumps `configVersion`.
 *
 * ## Concurrency
 *
 * One Durable Object instance serves one watcher. That is what makes the
 * dedup and rate-limit state correct without a distributed lock: market
 * events are processed in arrival order against state only that instance
 * can see.
 *
 * This module holds no Cloudflare types, so all of the decision logic is
 * testable without a runtime. `durable-object.ts` is a thin shell.
 */

import { digest } from './ids';

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export interface WatcherIdentity {
  userId: string;
  goatId: string;
  deploymentId: string;
}

export function watcherIdFor(identity: WatcherIdentity): string {
  return `w_${digest(identity.userId, identity.goatId, identity.deploymentId)}`;
}

/**
 * Whether a caller owns a watcher.
 *
 * Checked on every mutating and reading call. Authorisation is not
 * inferred from an id being hard to guess: the durable object id is a
 * routing handle, and anyone who learns it could address the object
 * directly.
 */
export function isOwnedBy(identity: WatcherIdentity, userId: string): boolean {
  return identity.userId === userId;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export type WatcherStatus =
  | 'CREATED'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED'
  | 'ERROR';

export type WatcherAction = 'deploy' | 'start' | 'pause' | 'resume' | 'stop' | 'fail' | 'retry';

/**
 * The transition table.
 *
 * Written out rather than derived, because "can I go from here to there"
 * is a product question: a user who clicks start on a STOPPED watcher
 * should be refused with an explanation, not silently have a new watcher
 * appear.
 *
 * `start` from STOPPING *cancels* the stop rather than completing it.
 * The alternative - where `start` means "the stop finished" - meant that
 * pressing start after stop left the watcher STOPPED, so it took two
 * presses to get a watcher running again. Both directions are idempotent
 * now: `stop` from STOPPING completes it, `start` from STOPPING undoes it.
 *
 * `fail` is reachable from every running state, because an error can
 * happen anywhere. `retry` is only reachable from ERROR and STOPPED: a
 * failed watcher is retried, a deliberately stopped one is started.
 */
const TRANSITIONS: Readonly<Record<WatcherStatus, Partial<Record<WatcherAction, WatcherStatus>>>> = {
  CREATED: { deploy: 'DEPLOYING', stop: 'STOPPED', fail: 'ERROR' },
  DEPLOYING: { start: 'RUNNING', fail: 'ERROR', stop: 'STOPPING' },
  RUNNING: { pause: 'PAUSED', stop: 'STOPPING', fail: 'ERROR' },
  PAUSED: { resume: 'RUNNING', stop: 'STOPPING', fail: 'ERROR' },
  STOPPING: { start: 'RUNNING', stop: 'STOPPED', fail: 'ERROR' },
  STOPPED: { deploy: 'DEPLOYING', retry: 'DEPLOYING', start: 'RUNNING' },
  ERROR: { retry: 'DEPLOYING', stop: 'STOPPING' },
};

export function nextStatus(from: WatcherStatus, action: WatcherAction): WatcherStatus | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

export function canTransition(from: WatcherStatus, action: WatcherAction): boolean {
  return nextStatus(from, action) !== null;
}

export function allowedActions(from: WatcherStatus): WatcherAction[] {
  return Object.keys(TRANSITIONS[from] ?? {}) as WatcherAction[];
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: WatcherStatus, readonly action: WatcherAction) {
    super(`Cannot ${action} a watcher that is ${from}. Allowed: ${allowedActions(from).join(', ') || 'nothing'}.`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Apply a transition.
 *
 * Idempotent where the product wants idempotence: acting twice on an
 * already-converged state is a no-op rather than an error, because
 * "start" and "stop" are the two a user and a deploy script both press.
 */
export function applyAction(from: WatcherStatus, action: WatcherAction): WatcherStatus {
  if (isIdempotentNoOp(from, action)) return from;
  const next = nextStatus(from, action);
  if (!next) throw new InvalidTransitionError(from, action);
  return next;
}

function isIdempotentNoOp(from: WatcherStatus, action: WatcherAction): boolean {
  if (action === 'start' && from === 'RUNNING') return true;
  if (action === 'pause' && from === 'PAUSED') return true;
  if (action === 'resume' && from === 'RUNNING') return true;
  /*
   * Only an *already settled* stop is a no-op. STOPPING is not settled:
   * the transition table sends STOPPING --stop--> STOPPED, and treating a
   * stop while stopping as a no-op meant the watcher could never finish
   * stopping. It sat in STOPPING for the rest of its life, reporting a
   * status it had no way to leave.
   */
  if (action === 'stop' && from === 'STOPPED') return true;
  if (action === 'deploy' && (from === 'DEPLOYING' || from === 'RUNNING')) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface WatcherConfig {
  /** Bumped on every edit. A wake records the version that produced it. */
  configVersion: number;
  name: string;
  market: string;
  /** The canonical condition tree, validated by the contract. */
  conditionTree: unknown;
  /** Milliseconds between evaluations, floor for this watcher. */
  minEvaluationIntervalMs: number;
  cooldownMs: number;
  maxWakesPerHour: number;
  maxWakesPerDay: number;
}

/**
 * Hard limits, applied at the boundary.
 *
 * A bot that asks for an unbounded rate is a bug in the bot, and the cost
 * of that bug is paid by the whole service. Documented rather than
 * silently clamped, so the user is told their value was refused.
 */
export const CONFIG_LIMITS = {
  minEvaluationIntervalMs: { min: 1_000, max: 3_600_000 },
  cooldownMs: { min: 0, max: 86_400_000 },
  maxWakesPerHour: { min: 1, max: 60 },
  maxWakesPerDay: { min: 1, max: 1_440 },
  maxConditionsPerTree: 200,
} as const;

export interface ConfigValidation {
  valid: boolean;
  problems: string[];
}

/** Validate a watcher configuration before it is ever stored. */
export function validateWatcherConfig(config: unknown): ConfigValidation {
  const problems: string[] = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, problems: ['A watcher configuration must be an object.'] };
  }
  const candidate = config as Partial<WatcherConfig>;

  if (!Number.isInteger(candidate.configVersion) || (candidate.configVersion as number) < 1) {
    problems.push('configVersion must be a positive integer.');
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    problems.push('A watcher needs a name.');
  }
  if (typeof candidate.market !== 'string' || !candidate.market.trim()) {
    problems.push('A watcher needs a market.');
  }
  if (candidate.conditionTree === undefined || candidate.conditionTree === null) {
    problems.push('A watcher needs a condition tree.');
  } else {
    const count = countNodes(candidate.conditionTree);
    if (count > CONFIG_LIMITS.maxConditionsPerTree) {
      problems.push(`The condition tree has ${count} nodes; the limit is ${CONFIG_LIMITS.maxConditionsPerTree}.`);
    }
  }
  problems.push(...checkRange('minEvaluationIntervalMs', candidate.minEvaluationIntervalMs, CONFIG_LIMITS.minEvaluationIntervalMs));
  problems.push(...checkRange('cooldownMs', candidate.cooldownMs, CONFIG_LIMITS.cooldownMs));
  problems.push(...checkRange('maxWakesPerHour', candidate.maxWakesPerHour, CONFIG_LIMITS.maxWakesPerHour));
  problems.push(...checkRange('maxWakesPerDay', candidate.maxWakesPerDay, CONFIG_LIMITS.maxWakesPerDay));

  return { valid: problems.length === 0, problems };
}

function checkRange(field: string, value: unknown, bounds: { min: number; max: number }): string[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [`${field} must be a number.`];
  }
  if (value < bounds.min || value > bounds.max) {
    return [`${field} must be between ${bounds.min} and ${bounds.max}; got ${value}.`];
  }
  return [];
}

/**
 * Every node in a condition tree, for the size limit. Bounded by the limit
 * itself.
 *
 * Handles both shapes a tree arrives in: a bare root node
 * (`{kind: 'GROUP', children}`) and the canonical wrapper the shared
 * schema defines (`{schemaVersion, then, root: {...}}`). Walking only
 * `children` would count a wrapped tree as a single node, so the limit
 * would never fire for a real configuration and an oversized tree would
 * be stored without complaint.
 */
export function countNodes(node: unknown, seen = 0): number {
  if (seen > CONFIG_LIMITS.maxConditionsPerTree * 4) return seen;
  if (!node || typeof node !== 'object') return seen;

  const record = node as { kind?: unknown; children?: unknown; root?: unknown };
  let total = seen + 1;
  if (Array.isArray(record.children)) {
    for (const child of record.children) total = countNodes(child, total);
  }
  // A wrapper is not itself a condition; its root is.
  if (record.root && typeof record.root === 'object' && record.kind === undefined) {
    total = seen + countNodes(record.root, 0);
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Market events
 * ------------------------------------------------------------------ */

export type MarketEventType = 'QUOTE' | 'BAR' | 'SESSION' | 'ORDER' | 'HEARTBEAT';

export interface MarketEvent {
  /** Stable across redelivery. The venue's own id, or one we derive. */
  marketEventId: string;
  market: string;
  /** Milliseconds since the epoch, UTC. */
  timestamp: number;
  eventType: MarketEventType;
  timeframe?: string;
  price?: number;
  volume?: number;
  /** The venue's ordering key, when it has one. */
  sequence?: number;
  payload?: Record<string, unknown>;
}

export type EventRejection =
  | 'DUPLICATE'
  | 'STALE'
  | 'OUT_OF_ORDER'
  | 'WRONG_MARKET'
  | 'FUTURE_TIMESTAMP'
  | 'PAUSED'
  | 'NOT_RUNNING';

export interface EventAcceptance {
  accepted: boolean;
  reason?: EventRejection;
  detail?: string;
}

/**
 * Whether an event should be processed at all.
 *
 * Market data is assumed to be duplicated, delayed, reordered, and
 * occasionally wrong. Every one of those is a way to wake a bot at the
 * wrong moment, so the checks are explicit and each has a named reason.
 *
 * `sequence` is preferred over `timestamp` for ordering when the venue
 * provides one: timestamps collide and clocks disagree, sequences do not.
 */
export function shouldProcessEvent(
  event: MarketEvent,
  state: { market: string; status: WatcherStatus; lastSequence?: number | null; lastTimestamp?: number | null },
  nowMs: number,
  options: { maxFutureSkewMs?: number } = {},
): EventAcceptance {
  if (state.status === 'PAUSED') return { accepted: false, reason: 'PAUSED', detail: 'The watcher is paused.' };
  if (state.status !== 'RUNNING') {
    return { accepted: false, reason: 'NOT_RUNNING', detail: `The watcher is ${state.status}.` };
  }
  if (event.market !== state.market) {
    return { accepted: false, reason: 'WRONG_MARKET', detail: `This watcher watches ${state.market}, not ${event.market}.` };
  }
  if (!event.marketEventId) {
    return { accepted: false, reason: 'DUPLICATE', detail: 'An event with no id cannot be deduplicated and is refused.' };
  }
  if (!Number.isFinite(event.timestamp)) {
    return { accepted: false, reason: 'STALE', detail: 'The event has no usable timestamp.' };
  }

  const maxFutureSkew = options.maxFutureSkewMs ?? 5_000;
  if (event.timestamp > nowMs + maxFutureSkew) {
    // A far-future timestamp usually means a broken clock upstream. Acting
    // on it would let one bad event pass every rate limit at once.
    return { accepted: false, reason: 'FUTURE_TIMESTAMP', detail: `The event is ${event.timestamp - nowMs}ms in the future.` };
  }

  if (state.lastSequence !== null && state.lastSequence !== undefined && event.sequence !== undefined) {
    if (event.sequence <= state.lastSequence) {
      return {
        accepted: false,
        reason: event.sequence === state.lastSequence ? 'DUPLICATE' : 'OUT_OF_ORDER',
        detail: `Sequence ${event.sequence} is not ahead of ${state.lastSequence}.`,
      };
    }
    return { accepted: true };
  }

  if (state.lastTimestamp !== null && state.lastTimestamp !== undefined) {
    if (event.timestamp < state.lastTimestamp) {
      return { accepted: false, reason: 'OUT_OF_ORDER', detail: `The event is older than the last one processed.` };
    }
    if (event.timestamp === state.lastTimestamp) {
      return { accepted: false, reason: 'DUPLICATE', detail: 'An event with the same timestamp was already processed.' };
    }
  }

  return { accepted: true };
}
