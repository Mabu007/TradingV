/**
 * The wake queue, and the rules about what happens to a pending wake
 * when the bot is edited.
 *
 * ## The failure this prevents
 *
 * A wake is a *request to act* that has left the watcher but may not yet
 * have been consumed. If the user edits the bot while a wake is in
 * flight, there are three defensible answers: execute it under the old
 * configuration, discard it, or re-evaluate it. Silently doing a
 * mixture of two of them is the one option that is not defensible,
 * because the user cannot tell which one happened.
 *
 * The choice here is **discard**, and the reasoning is that the other two
 * are worse:
 *
 *  - *Execute under the old version* means acting on a configuration the
 *    user has already changed. If they narrowed the conditions, the bot
 *    may still open a position they have just decided against.
 *  - *Re-evaluate* means the engine evaluates a configuration that may
 *    no longer be the one on screen, and the resulting decision is harder
 *    to explain than either of the others.
 *  - *Discard* is the only one where "nothing happened" is the literal
 *    truth, and it is recoverable: the next market event re-evaluates
 *    under the new version and wakes if the new conditions hold.
 *
 * The discarded wake is not silently dropped. It is recorded with a
 * `CONFIG_CHANGED` outcome, so the timeline can say "the wake you were
 * about to act on was cancelled because you edited the bot".
 */

import { evaluationIdFor, wakeIdFor } from './ids';

export type WakeStatus = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTED' | 'REJECTED' | 'DISCARDED';

/**
 * Why a wake is no longer pending.
 *
 * Terminal outcomes exist so the app can distinguish "I acted on this"
 * from "this is gone" without parsing strings.
 */
export type WakeOutcome =
  | 'ACKNOWLEDGED'
  | 'EXECUTED'
  | 'REJECTED'
  /** The bot was edited after the wake was emitted. See the module note. */
  | 'CONFIG_CHANGED'
  /** The watcher was stopped or deleted before the wake was consumed. */
  | 'WATCHER_STOPPED'
  /** The bot no longer exists. */
  | 'BOT_DELETED'
  /** The market is no longer tradeable. */
  | 'MARKET_UNAVAILABLE'
  /** The engine could not evaluate the conditions. */
  | 'CONDITION_UNKNOWN'
  /** Deliberately expired: too old to act on. */
  | 'STALE'
  /** The queue was full. */
  | 'QUEUE_FULL';

export interface Wake {
  id: string;
  watcherId: string;
  goatId: string;
  deploymentId: string;
  marketEventId: string;
  evaluationId: string;
  /** The configuration version that produced this wake. */
  configVersion: number;
  status: WakeStatus;
  outcome?: WakeOutcome;
  createdAt: number;
  terminalAt?: number;
  acknowledgedAt?: number;
  /** Why the conditions fired, for the AI. Never an order. */
  reason: string;
  conditions: { overall: string; summary: string };
  /** The context the AI needs. Small, and read-only. */
  context?: Record<string, unknown>;
}

export interface WakeQueueOptions {
  /**
   * How long a wake stays actionable.
   *
   * A wake is a statement about a moment that has passed. Acting on a
   * twenty-minute-old "price just crossed 2000" is not what the user
   * meant, so the default is deliberately short.
   */
  maxAgeMs?: number;
  maxSize?: number;
  /** How many terminal wakes to keep for the timeline. */
  historyLimit?: number;
}

const DEFAULTS: Required<WakeQueueOptions> = {
  maxAgeMs: 5 * 60_000,
  maxSize: 100,
  historyLimit: 200,
};

export type EnqueueResult =
  | { accepted: true; wake: Wake }
  | { accepted: false; reason: 'DUPLICATE'; existing: Wake }
  | { accepted: false; reason: 'QUEUE_FULL'; dropped: Wake[] };

/**
 * A bounded, deduplicating wake queue.
 *
 * Deduplication is by wake id, which is derived from
 * (watcher, market event, config version). That means the same market
 * event delivered twice cannot produce two wakes, and a config edit
 * legitimately can.
 */
export class WakeQueue {
  private readonly pending = new Map<string, Wake>();
  private readonly terminal: Wake[] = [];
  private readonly options: Required<WakeQueueOptions>;

  constructor(options: WakeQueueOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get size(): number {
    return this.pending.size;
  }

  get capacity(): number {
    return this.options.maxSize;
  }

  /** Pending wakes, oldest first. */
  list(): Wake[] {
    return [...this.pending.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * Restore pending wakes after hibernation.
   *
   * A pending wake is a request to act that the app has not collected yet.
   * Dropping it on restart would silently lose a market event that
   * legitimately woke the bot, so pending wakes are persisted alongside
   * the terminal ones. Anything already terminal is refused here, because
   * a restore must never resurrect something that has already acted.
   */
  restorePending(wakes: Wake[]): void {
    for (const wake of wakes) {
      if (wake.status !== 'PENDING') continue;
      if (this.pending.has(wake.id)) continue;
      if (this.terminal.some((entry) => entry.id === wake.id)) continue;
      this.pending.set(wake.id, { ...wake });
    }
  }

  /** Terminal wakes, newest first, for the timeline. */
  history(limit = this.options.historyLimit): Wake[] {
    return [...this.terminal].reverse().slice(0, limit);
  }

  get(id: string): Wake | undefined {
    return this.pending.get(id) ?? this.terminal.find((wake) => wake.id === id);
  }

  /**
   * Add a wake, unless it is already pending.
   *
   * A terminal wake with the same id is *not* re-enqueued: the id encodes
   * the configuration version, and re-adding a wake that already acted
   * would be a second trade from one market event.
   */
  enqueue(input: Omit<Wake, 'status'> & { status?: WakeStatus }, nowMs: number): EnqueueResult {
    if (this.pending.has(input.id)) {
      return { accepted: false, reason: 'DUPLICATE', existing: this.pending.get(input.id)! };
    }
    if (this.terminal.some((wake) => wake.id === input.id)) {
      return { accepted: false, reason: 'DUPLICATE', existing: this.terminal.find((wake) => wake.id === input.id)! };
    }

    const wake: Wake = { ...input, status: 'PENDING' };

    this.expire(nowMs);

    if (this.pending.size >= this.options.maxSize) {
      /*
       * Drop the oldest rather than the newest.
       *
       * A watcher's newest observation is the one most likely to still be
       * true, and the oldest has already been overtaken by events. The
       * alternative, refusing the new wake, means a bot that is running
       * behind never catches up.
       */
      const oldest = this.list()[0];
      const dropped: Wake[] = [];
      if (oldest) {
        this.pending.delete(oldest.id);
        this.terminalise(oldest, 'QUEUE_FULL', nowMs);
        dropped.push(oldest);
      }
      this.pending.set(wake.id, wake);
      return { accepted: false, reason: 'QUEUE_FULL', dropped };
    }

    this.pending.set(wake.id, wake);
    return { accepted: true, wake };
  }

  /**
   * Restore a wake that was already terminal before hibernation.
   *
   * Needed because a Durable Object loses its heap when it hibernates.
   * Restoring keeps the timeline intact across a restart, and re-adding
   * a pending wake this way is refused, so a restore can never
   * resurrect something that had already been acted on.
   */
  restoreTerminal(wakes: Wake[]): void {
    for (const wake of wakes) {
      if (wake.status === 'PENDING') continue;
      if (this.terminal.some((entry) => entry.id === wake.id)) continue;
      this.terminal.push({ ...wake });
    }
    if (this.terminal.length > this.options.historyLimit) {
      this.terminal.splice(0, this.terminal.length - this.options.historyLimit);
    }
  }

  /**
   * Confirm the app received a wake.
   *
   * Acknowledging is not the same as executing: the app takes the wake,
   * runs policy and risk, and only then reports an outcome. A wake that
   * is acknowledged and then never resolved is a bug in the app, and
   * `staleAcknowledged` exists so it can be found.
   */
  acknowledge(id: string, nowMs: number): Wake | null {
    const wake = this.pending.get(id);
    if (!wake) return null;
    wake.acknowledgedAt = nowMs;
    return wake;
  }

  /** Move a pending wake to a terminal outcome. Idempotent. */
  resolve(id: string, outcome: WakeOutcome, nowMs: number): Wake | null {
    const wake = this.pending.get(id);
    if (!wake) {
      // Resolving an already-terminal wake is a no-op, not an error:
      // the app may retry its acknowledgement after a network failure.
      return this.terminal.find((entry) => entry.id === id) ?? null;
    }
    this.pending.delete(id);
    this.terminalise(wake, outcome, nowMs);
    return wake;
  }

  /**
   * Discard every pending wake produced under a superseded configuration.
   *
   * Called when a watcher's config is edited. This is the "discard"
   * decision from the module note, and it returns what it discarded so
   * the caller can report it.
   */
  discardForConfigChange(newConfigVersion: number, nowMs: number): Wake[] {
    const discarded: Wake[] = [];
    for (const wake of this.list()) {
      if (wake.configVersion < newConfigVersion) {
        this.pending.delete(wake.id);
        this.terminalise(wake, 'CONFIG_CHANGED', nowMs);
        discarded.push(wake);
      }
    }
    return discarded;
  }

  /** Discard everything pending, because the watcher is stopping. */
  discardAllForStop(nowMs: number, outcome: WakeOutcome = 'WATCHER_STOPPED'): Wake[] {
    const discarded: Wake[] = [];
    for (const wake of this.list()) {
      this.pending.delete(wake.id);
      this.terminalise(wake, outcome, nowMs);
      discarded.push(wake);
    }
    return discarded;
  }

  /**
   * Expire wakes that are too old to act on.
   *
   * A pending wake that is never consumed would otherwise sit in the
   * queue until the size limit evicted it, and would be acted on much
   * later than the moment it described.
   */
  expire(nowMs: number): Wake[] {
    const expired: Wake[] = [];
    for (const wake of this.list()) {
      if (nowMs - wake.createdAt > this.options.maxAgeMs) {
        this.pending.delete(wake.id);
        this.terminalise(wake, 'STALE', nowMs);
        expired.push(wake);
      }
    }
    return expired;
  }

  /**
   * Acknowledged but never resolved.
   *
   * A symptom to be alerted on, not a state to act on: it means the app
   * took a wake and then something went wrong on its side. Returned by
   * health so a stalled pipeline is visible.
   */
  staleAcknowledged(nowMs: number, olderThanMs = 30_000): Wake[] {
    return this.list().filter(
      (wake) => wake.acknowledgedAt !== undefined && nowMs - wake.acknowledgedAt > olderThanMs,
    );
  }

  private terminalise(wake: Wake, outcome: WakeOutcome, nowMs: number): void {
    wake.status = outcome === 'EXECUTED' || outcome === 'ACKNOWLEDGED' || outcome === 'REJECTED' ? outcome : 'DISCARDED';
    wake.outcome = outcome;
    wake.terminalAt = nowMs;
    this.terminal.push(wake);
    if (this.terminal.length > this.options.historyLimit) {
      this.terminal.splice(0, this.terminal.length - this.options.historyLimit);
    }
  }
}

/** Build a wake for a market event. The id is derived, never generated. */
export function buildWake(params: {
  watcherId: string;
  goatId: string;
  deploymentId: string;
  marketEventId: string;
  configVersion: number;
  status: string;
  summary: string;
  reason: string;
  conditions: { overall: string; summary: string };
  context?: Record<string, unknown>;
  nowMs: number;
}): Wake {
  return {
    id: wakeIdFor(params.watcherId, params.marketEventId, params.configVersion),
    watcherId: params.watcherId,
    goatId: params.goatId,
    deploymentId: params.deploymentId,
    marketEventId: params.marketEventId,
    evaluationId: evaluationIdFor(params.watcherId, params.marketEventId, params.configVersion),
    configVersion: params.configVersion,
    status: 'PENDING',
    createdAt: params.nowMs,
    reason: params.reason,
    conditions: params.conditions,
    ...(params.context ? { context: params.context } : {}),
  };
}
