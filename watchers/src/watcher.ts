/**
 * The watcher state machine.
 *
 * All of the decision logic lives here, with no Cloudflare types, so it
 * can be tested exhaustively without a runtime. `durable-object.ts` is a
 * thin adapter that persists `WatcherState` and delegates here.
 *
 * The shape of a tick:
 *
 *   market event
 *     -> accepted?            (fresh, in order, right market, running)
 *     -> evaluation due?      (minEvaluationIntervalMs)
 *     -> engine says what?    (TRUE / FALSE / UNKNOWN)
 *     -> edge?                (FALSE -> TRUE, not latched, not capped)
 *     -> wake enqueued
 *
 * Anything that would produce a wake from a non-edge, a duplicate, an
 * UNKNOWN, or a running cap is dropped here, with a named reason, rather
 * than downstream where it would be a duplicate trade.
 */

import {
  applyAction,
  shouldProcessEvent,
  validateWatcherConfig,
  watcherIdFor,
  type MarketEvent,
  type WatcherAction,
  type WatcherConfig,
  type WatcherIdentity,
  type WatcherStatus,
} from './contract';
import { assessHealth, DEFAULT_HEALTH_THRESHOLDS, type HealthReport, type HealthThresholds } from './health';
import { evaluationIdFor, wakeIdFor } from './ids';
import { WakeQueue, buildWake, type Wake, type WakeOutcome } from './wake-queue';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface WatcherState {
  identity: WatcherIdentity;
  watcherId: string;
  status: WatcherStatus;
  config: WatcherConfig;
  createdAt: number;
  updatedAt: number;
  /** Timestamps, in epoch milliseconds, UTC. */
  lastHeartbeatAt: number | null;
  lastMarketDataAt: number | null;
  lastEvaluationAt: number | null;
  lastSuccessfulEvaluationAt: number | null;
  lastWakeAt: number | null;
  lastConfigChangeAt: number | null;
  /** For ordering. Prefers the venue's sequence. */
  lastSequence: number | null;
  lastTimestamp: number | null;
  /** The condition's previous state, for edge detection. */
  lastConditionStatus: string | null;
  lastError: { message: string; category?: string; at: number } | null;
  consecutiveEvaluationFailures: number;
  /** Wakes this watcher has emitted, for the hourly and daily caps. */
  fireTimestamps: number[];
}

export interface PersistedWatcher {
  state: WatcherState;
  /**
   * Wakes that have not been collected yet.
   *
   * Persisted because a pending wake is a request to act: losing it on a
   * restart would silently drop a market event that legitimately woke the
   * bot, and the user would never find out.
   */
  pendingWakes: Wake[];
  /** Serialised terminal wakes, so the timeline survives hibernation. */
  terminalWakes: Wake[];
}

/* ------------------------------------------------------------------ *
 * The condition evaluator seam
 * ------------------------------------------------------------------ */

export type ConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN';

export interface EvaluationResult {
  status: ConditionStatus;
  summary: string;
  /** Per-condition detail, for the wake payload. */
  conditions: Array<{ id: string; status: string; summary: string; value?: number; threshold?: number }>;
  reason?: string;
}

export interface EvaluationOutcome {
  evaluationId: string;
  result: EvaluationResult;
  /** Milliseconds the evaluation took, for the health thresholds. */
  durationMs: number;
}

/**
 * Evaluates a condition tree.
 *
 * An interface, not a function, because the real implementation is the
 * Python engine over HTTP and the test double is a table of answers. The
 * watcher must work identically either way, including when the engine
 * is unreachable, which is why `fail` is part of the signature: an
 * unreachable engine is a health problem, not a silent TRUE.
 */
export interface ConditionEvaluator {
  evaluate(config: WatcherConfig, event: MarketEvent): Promise<EvaluationOutcome>;
  fail(config: WatcherConfig, event: MarketEvent, error: unknown): EvaluationOutcome;
}

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

export type TickOutcome =
  | { kind: 'WOKEN'; wake: Wake }
  | { kind: 'EVALUATED'; evaluationId: string; status: ConditionStatus }
  | { kind: 'SKIPPED'; reason: string; detail?: string };

export interface WatcherTickResult {
  outcome: TickOutcome;
  /** Wakes discarded because the configuration changed under them. */
  discarded: Wake[];
  /** Wakes that expired because nobody consumed them. */
  expired: Wake[];
  health: HealthReport;
}

/* ------------------------------------------------------------------ *
 * The machine
 * ------------------------------------------------------------------ */

export class Watcher {
  private readonly queue: WakeQueue;
  private readonly thresholds: HealthThresholds;

  constructor(
    state: WatcherState,
    private readonly queueOptions: { maxAgeMs?: number; maxSize?: number; historyLimit?: number } = {},
    healthThresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  ) {
    this.state = state;
    this.queue = new WakeQueue(queueOptions);
    this.thresholds = healthThresholds;
  }

  readonly state: WatcherState;

  get id(): string {
    return this.state.watcherId;
  }

  get status(): WatcherStatus {
    return this.state.status;
  }

  static create(identity: WatcherIdentity, config: WatcherConfig, nowMs: number): Watcher {
    const validation = validateWatcherConfig(config);
    if (!validation.valid) {
      throw new Error(`Refusing to create a watcher with an invalid configuration: ${validation.problems.join('; ')}`);
    }
    return new Watcher({
      identity,
      watcherId: watcherIdFor(identity),
      status: 'CREATED',
      config,
      createdAt: nowMs,
      updatedAt: nowMs,
      lastHeartbeatAt: nowMs,
      lastMarketDataAt: null,
      lastEvaluationAt: null,
      lastSuccessfulEvaluationAt: null,
      lastWakeAt: null,
      lastConfigChangeAt: nowMs,
      lastSequence: null,
      lastTimestamp: null,
      lastConditionStatus: null,
      lastError: null,
      consecutiveEvaluationFailures: 0,
      fireTimestamps: [],
    });
  }

  static restore(persisted: PersistedWatcher, queueOptions = {}, healthThresholds?: HealthThresholds): Watcher {
    const watcher = new Watcher(persisted.state, queueOptions, healthThresholds);
    watcher.queue.restorePending(persisted.pendingWakes ?? []);
    watcher.queue.restoreTerminal(persisted.terminalWakes ?? []);
    return watcher;
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Apply a lifecycle action.
   *
   * Stopping and pausing discard pending wakes, because a watcher the
   * user has just stopped must not produce a wake that then gets acted
   * on. The discarded wakes are returned so the caller can report them.
   */
  act(action: WatcherAction, nowMs: number): { status: WatcherStatus; discarded: Wake[] } {
    const previous = this.state.status;
    const next = applyAction(previous, action);
    this.state.status = next;
    this.state.lastHeartbeatAt = nowMs;
    this.state.updatedAt = nowMs;

    if (next === 'STOPPED' || next === 'PAUSED' || next === 'STOPPING') {
      const discarded = this.queue.discardAllForStop(nowMs, next === 'PAUSED' ? 'WATCHER_STOPPED' : 'WATCHER_STOPPED');
      // A stopped watcher has not evaluated, so it must not remember that
      // it was true. Otherwise restarting would see a stale TRUE and
      // produce an edge for a condition that never actually changed.
      this.state.lastConditionStatus = null;
      return { status: next, discarded };
    }
    return { status: next, discarded: [] };
  }

  /**
   * Replace the configuration.
   *
   * Bumps the version and discards any wake produced under the old one.
   * See `wake-queue.ts` for why discard rather than execute-or-re-evaluate.
   */
  updateConfig(config: WatcherConfig, nowMs: number): { discarded: Wake[]; configVersion: number } {
    const validation = validateWatcherConfig(config);
    if (!validation.valid) {
      throw new Error(`Refusing to store an invalid configuration: ${validation.problems.join('; ')}`);
    }
    if (config.configVersion <= this.state.config.configVersion) {
      throw new Error(
        `Configuration versions must increase: got ${config.configVersion}, current is ${this.state.config.configVersion}.`,
      );
    }

    const previousVersion = this.state.config.configVersion;
    this.state.config = config;
    this.state.lastConfigChangeAt = nowMs;
    this.state.updatedAt = nowMs;
    this.state.lastHeartbeatAt = nowMs;

    const discarded = this.queue.discardForConfigChange(config.configVersion, nowMs);

    if (previousVersion === config.configVersion - 1) {
      /*
       * The market may have moved while the user was editing, so the
       * remembered condition state no longer describes anything. Forget
       * it: the next evaluation re-establishes it, and a forgotten state
       * costs one missed edge rather than a spurious one.
       */
      this.state.lastConditionStatus = null;
    }
    return { discarded, configVersion: config.configVersion };
  }

  /* --------------------------------------------------------------- tick */

  async tick(event: MarketEvent, evaluator: ConditionEvaluator, nowMs: number): Promise<WatcherTickResult> {
    this.state.lastHeartbeatAt = nowMs;
    this.state.updatedAt = nowMs;
    // Pruned on every tick, not only when a wake fires. Otherwise the bound
    // is incidental: a watcher that stops waking keeps its history
    // forever, which is exactly the sort of slow growth that a long-lived
    // Durable Object turns into a storage bill.
    this.pruneFireTimestamps(nowMs);

    const expired = this.queue.expire(nowMs);
    const health = () => this.health(nowMs);

    const acceptance = shouldProcessEvent(event, {
      market: this.state.config.market,
      status: this.state.status,
      lastSequence: this.state.lastSequence,
      lastTimestamp: this.state.lastTimestamp,
    }, nowMs);

    if (!acceptance.accepted) {
      return {
        outcome: { kind: 'SKIPPED', reason: acceptance.reason ?? 'REJECTED', ...(acceptance.detail ? { detail: acceptance.detail } : {}) },
        discarded: [],
        expired,
        health: health(),
      };
    }

    // Accepted: the event is fresh and in order, so record it.
    this.state.lastMarketDataAt = nowMs;
    if (event.sequence !== undefined) this.state.lastSequence = event.sequence;
    this.state.lastTimestamp = event.timestamp;

    if (nowMs - (this.state.lastEvaluationAt ?? 0) < this.state.config.minEvaluationIntervalMs) {
      return {
        outcome: { kind: 'SKIPPED', reason: 'EVALUATION_INTERVAL', detail: 'The watcher asked not to be evaluated this often.' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    const evaluationId = evaluationIdFor(this.id, event.marketEventId, this.state.config.configVersion);

    let evaluation: EvaluationOutcome;
    try {
      evaluation = await evaluator.evaluate(this.state.config, event);
    } catch (error) {
      evaluation = evaluator.fail(this.state.config, event, error);
    }

    this.state.lastEvaluationAt = nowMs;

    if (evaluation.result.status === 'UNKNOWN') {
      /*
       * UNKNOWN deliberately does not touch `lastConditionStatus`.
       *
       * An unmeasurable market must not re-arm a tracker that was
       * already true, and must not suppress the next genuine edge. This
       * is the difference between "I could not measure" and "the
       * condition is false", and collapsing it is how a bot ends up
       * trading on a stale price.
       */
      this.state.consecutiveEvaluationFailures += 1;
      this.state.lastError = {
        message: evaluation.result.reason || 'Conditions could not be evaluated.',
        category: 'CONDITION_ERROR',
        at: nowMs,
      };
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: 'UNKNOWN' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    this.state.lastSuccessfulEvaluationAt = nowMs;
    this.state.consecutiveEvaluationFailures = 0;
    this.state.lastError = null;

    const previous = this.state.lastConditionStatus;
    const current = evaluation.result.status;
    this.state.lastConditionStatus = current;

    if (current !== 'TRUE') {
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: current },
        discarded: [],
        expired,
        health: health(),
      };
    }

    // TRUE. Only a FALSE -> TRUE transition is an edge.
    if (previous === 'TRUE') {
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: 'TRUE' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    const cap = this.capBreached(nowMs);
    if (cap) {
      /*
       * The condition is latched as TRUE even though the wake was
       * refused. That is deliberate: the condition did not become true
       * again, so a later poll must not deliver a wake for a moment that
       * has already passed. The next genuine FALSE -> TRUE is a new
       * opportunity.
       */
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: 'TRUE' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    const cooldownRemaining = this.cooldownRemaining(nowMs);
    if (cooldownRemaining > 0) {
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: 'TRUE' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    const wake = buildWake({
      watcherId: this.id,
      goatId: this.state.identity.goatId,
      deploymentId: this.state.identity.deploymentId,
      marketEventId: event.marketEventId,
      configVersion: this.state.config.configVersion,
      status: evaluation.result.status,
      summary: evaluation.result.summary,
      reason: evaluation.result.summary,
      conditions: { overall: evaluation.result.status, summary: evaluation.result.summary },
      context: { market: this.state.config.market, price: event.price, timeframe: event.timeframe },
      nowMs,
    });

    const enqueued = this.queue.enqueue(wake, nowMs);
    this.state.fireTimestamps.push(nowMs);
    this.pruneFireTimestamps(nowMs);
    this.state.lastWakeAt = nowMs;

    if (!enqueued.accepted) {
      return {
        outcome: { kind: 'EVALUATED', evaluationId, status: 'TRUE' },
        discarded: [],
        expired,
        health: health(),
      };
    }

    return { outcome: { kind: 'WOKEN', wake: enqueued.wake }, discarded: [], expired, health: health() };
  }

  /* --------------------------------------------------------- wake queue */

  pendingWakes(): Wake[] {
    return this.queue.list();
  }

  wakeHistory(limit?: number): Wake[] {
    return this.queue.history(limit);
  }

  getWake(id: string): Wake | undefined {
    return this.queue.get(id);
  }

  acknowledgeWake(id: string, nowMs: number): Wake | null {
    const wake = this.queue.acknowledge(id, nowMs);
    if (wake) this.state.lastHeartbeatAt = nowMs;
    return wake;
  }

  resolveWake(id: string, outcome: WakeOutcome, nowMs: number): Wake | null {
    const wake = this.queue.resolve(id, outcome, nowMs);
    if (wake) this.state.lastHeartbeatAt = nowMs;
    return wake;
  }

  /** Acknowledged but never resolved. A symptom, surfaced not swallowed. */
  staleAcknowledgements(nowMs: number, olderThanMs?: number): Wake[] {
    return this.queue.staleAcknowledged(nowMs, olderThanMs);
  }

  /* -------------------------------------------------------------- health */

  health(nowMs: number): HealthReport {
    return assessHealth(
      {
        status: this.state.status,
        lastHeartbeatAt: this.state.lastHeartbeatAt,
        lastMarketDataAt: this.state.lastMarketDataAt,
        lastEvaluationAt: this.state.lastEvaluationAt,
        lastSuccessfulEvaluationAt: this.state.lastSuccessfulEvaluationAt,
        lastWakeAt: this.state.lastWakeAt,
        lastError: this.state.lastError,
        consecutiveEvaluationFailures: this.state.consecutiveEvaluationFailures,
        lastConfigChangeAt: this.state.lastConfigChangeAt,
      },
      nowMs,
      this.thresholds,
    );
  }

  /* ------------------------------------------------------------ internals */

  /**
   * The wake id this watcher would mint for an event.
   *
   * Exposed so a caller can pre-check duplication, and so a test can
   * assert determinism without going through a tick.
   */
  wakeIdForEvent(marketEventId: string): string {
    return wakeIdFor(this.id, marketEventId, this.state.config.configVersion);
  }

  private capBreached(nowMs: number): boolean {
    this.pruneFireTimestamps(nowMs);
    const hour = this.state.fireTimestamps.filter((stamp) => nowMs - stamp <= 3_600_000).length;
    if (hour >= this.state.config.maxWakesPerHour) return true;
    const day = this.state.fireTimestamps.filter((stamp) => nowMs - stamp <= 86_400_000).length;
    return day >= this.state.config.maxWakesPerDay;
  }

  private cooldownRemaining(nowMs: number): number {
    if (this.state.config.cooldownMs <= 0) return 0;
    const last = this.state.lastWakeAt;
    if (last === null) return 0;
    return Math.max(0, this.state.config.cooldownMs - (nowMs - last));
  }

  private pruneFireTimestamps(nowMs: number): void {
    const cutoff = nowMs - 86_400_000;
    while (this.state.fireTimestamps.length > 0 && this.state.fireTimestamps[0] < cutoff) {
      this.state.fireTimestamps.shift();
    }
  }

  /** Snapshot for durable storage. */
  persist(): PersistedWatcher {
    return {
      state: this.state,
      pendingWakes: this.queue.list(),
      terminalWakes: this.queue.history(Number.MAX_SAFE_INTEGER),
    };
  }
}
