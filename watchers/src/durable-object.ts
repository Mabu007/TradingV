/**
 * The watcher Durable Object.
 *
 * One object per `(userId, goatId, deploymentId)`. That is the entire
 * point of using a Durable Object here: the dedup set, the condition
 * latch, the rate-limit windows, and the wake queue all have to be
 * consistent under concurrency, and a single-threaded object per watcher
 * gives that without a distributed lock or a database transaction.
 *
 * What is deliberately *not* here:
 *
 *  - **Condition evaluation.** The Python engine owns measurement. This
 *    object asks it and records the answer.
 *  - **Market data history.** Persisting candles in object storage would
 *    be slow, expensive, and a second source of truth. The engine holds
 *    them; this object only needs the latest event.
 *  - **Execution.** It emits wakes. It cannot trade.
 *
 * Every method is reachable from the Worker over RPC or HTTP, so the
 * logic above is what is tested and this file stays thin.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  MarketEvent,
  WatcherAction,
  WatcherConfig,
  WatcherIdentity,
  WatcherStatus,
} from './contract';
import { watcherIdFor } from './ids';
import type { HealthReport } from './health';
import { Watcher, type EvaluationOutcome, type PersistedWatcher, type WatcherState } from './watcher';
import type { Wake, WakeOutcome } from './wake-queue';
import { HttpConditionEvaluator, type ConditionEvaluator } from './evaluator';

const STATE_KEY = 'watcher:state';
const TERMINAL_KEY = 'watcher:terminal-wakes';
const PENDING_KEY = 'watcher:pending-wakes';
const WAKE_TTL_MS = 60_000;

/** The shape this object is constructed with. */
export interface WatcherEnv {
  /** The condition engine's base URL. */
  ENGINE_URL: string;
  /**
   * The namespace this object lives in, used to re-derive its own
   * durable id and prove it is the object the caller addressed.
   */
  WATCHERS?: DurableObjectNamespace;
  /** Wall-clock, injected so tests can freeze it. */
  now?: () => number;
  evaluator?: ConditionEvaluator;
  queueOptions?: { maxAgeMs?: number; maxSize?: number; historyLimit?: number };
  healthThresholds?: ConstructorParameters<typeof Watcher>[2];
}

/**
 * What the Worker passes to `newBlockConcurrencyWhile`.
 *
 * Identity is part of the constructor input rather than derived inside,
 * so an object can never be created for a watcher it does not own.
 */
export interface WatcherInit {
  identity: WatcherIdentity;
  config: WatcherConfig;
}

export class WatcherObject extends DurableObject<WatcherEnv> {
  private watcher: Watcher | null = null;
  private initialised = false;

  constructor(ctx: DurableObjectState, env: WatcherEnv) {
    super(ctx, env);
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  private evaluator(): ConditionEvaluator {
    return this.env.evaluator ?? new HttpConditionEvaluator(this.env.ENGINE_URL, () => this.now());
  }

  /**
   * Load or create the watcher.
   *
   * `blockConcurrencyWhile` guarantees nothing else observes a
   * half-initialised object, which is what makes a single read of
   * durable storage sufficient.
   */
  private async ready(): Promise<Watcher> {
    if (this.watcher) return this.watcher;

    this.watcher = await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.readStored();
      if (stored) {
        return Watcher.restore(stored, this.env.queueOptions, this.env.healthThresholds);
      }
      return null;
    });

    if (!this.watcher) {
      // No stored state: this object was created but never initialised.
      // A caller must supply an identity, and it is checked against the
      // id this object was addressed by.
      return this.failUninitialised();
    }
    return this.watcher;
  }

  private failUninitialised(): never {
    throw new Error(
      'This watcher object has not been initialised. Deploy through POST /watchers so an identity and configuration are recorded.',
    );
  }

  private async save(): Promise<void> {
    if (!this.watcher) return;
    const snapshot = this.watcher.persist();
    await this.ctx.storage.put(STATE_KEY, snapshot.state);
    await this.ctx.storage.put(TERMINAL_KEY, snapshot.terminalWakes);
    // Pending wakes are persisted: a restart that dropped them would lose
    // a market event that legitimately woke the bot.
    await this.ctx.storage.put(PENDING_KEY, snapshot.pendingWakes);
  }

  /* ------------------------------------------------------------- deploy */

  /**
   * Create or update the watcher.
   *
   * Idempotent on the identity: deploying the same deployment twice
   * updates the configuration in place rather than creating a second
   * watcher, because the object id is derived from the identity and not
   * from the configuration. A configuration whose version is *not*
   * higher is refused, because silently accepting a stale deploy would
   * let a slow caller undo a newer edit.
   */
  async deploy(request: { init?: WatcherInit; identity: WatcherIdentity; config: WatcherConfig; expectedWatcherId: string }): Promise<{
    watcherId: string;
    status: WatcherStatus;
    created: boolean;
    configVersion: number;
    discarded: Wake[];
    problems: string[];
  }> {
    const now = this.now();
    const expectedId = watcherIdFor(request.identity);

    /*
     * Verify this object is the one that id addresses.
     *
     * `ctx.id.name` is not reliably populated by the runtime, so the
     * check is done by re-deriving the id and comparing the resulting
     * Durable Object id with this object's own. If they differ, the caller
     * addressed one object and asked it to write another identity's
     * watcher, which is the one thing this object must never do.
     */
    const addressedId = this.env.WATCHERS?.idFromName
      ? this.env.WATCHERS.idFromName(expectedId).toString()
      : expectedId;
    if (addressedId !== this.ctx.id.toString()) {
      throw new Error(`Watcher id mismatch: this object is ${this.ctx.id.toString()}, ${expectedId} addresses ${addressedId}.`);
    }

    const existing = await this.readStored();
    const problems: string[] = [];

    let watcher: Watcher;
    let created = false;
    let discarded: Wake[] = [];

    if (!existing) {
      try {
        watcher = Watcher.create(request.identity, request.config, now);
        created = true;
      } catch (error) {
        // A rejected configuration is reported, not stored, and the object
        // stays deployable.
        return { watcherId: expectedId, status: 'CREATED', created: false, configVersion: 0, discarded: [], problems: [(error as Error).message] };
      }
    } else {
      watcher = Watcher.restore(existing, this.env.queueOptions, this.env.healthThresholds);
      if (request.config.configVersion === existing.state.config.configVersion && configsEqual(existing.state.config, request.config)) {
        // A true no-op re-deploy. Reported as such rather than as an
        // update, so a retrying deploy script can tell it succeeded.
        this.watcher = watcher;
        return { watcherId: expectedId, status: watcher.status, created: false, configVersion: existing.state.config.configVersion, discarded: [], problems: [] };
      }
      try {
        const result = watcher.updateConfig(request.config, now);
        discarded = result.discarded;
      } catch (error) {
        return { watcherId: expectedId, status: existing.state.status, created: false, configVersion: existing.state.config.configVersion, discarded: [], problems: [(error as Error).message] };
      }
    }

    /*
     * A new watcher is CREATED and has to be DEPLOYING before it can be
     * started. The transition used to run only on an update, which left
     * every freshly created watcher stuck in CREATED with `start` refused
     * - a bot the user could deploy and never run.
     */
    if (watcher.status === 'CREATED') watcher.act('deploy', now);
    this.watcher = watcher;
    await this.save();
    return { watcherId: expectedId, status: watcher.status, created, configVersion: watcher.state.config.configVersion, discarded, problems };
  }

  private async readStored(): Promise<PersistedWatcher | null> {
    const state = await this.ctx.storage.get<WatcherState>(STATE_KEY);
    if (!state) return null;
    const terminalWakes = (await this.ctx.storage.get<Wake[]>(TERMINAL_KEY)) ?? [];
    const pendingWakes = (await this.ctx.storage.get<Wake[]>(PENDING_KEY)) ?? [];
    return { state, pendingWakes, terminalWakes };
  }

  /* ----------------------------------------------------------- lifecycle */

  async act(action: WatcherAction): Promise<{ status: WatcherStatus; discarded: Wake[]; problems: string[] }> {
    const watcher = await this.ready();
    try {
      const result = watcher.act(action, this.now());
      await this.save();
      return { ...result, problems: [] };
    } catch (error) {
      return { status: watcher.status, discarded: [], problems: [(error as Error).message] };
    }
  }

  /* ---------------------------------------------------------------- tick */

  /**
   * Process one market event.
   *
   * A single event per call, and the object is single-threaded, so the
   * read-decide-write sequence is atomic with respect to other events
   * for this watcher. State is written only when something changed, so a
   * burst of rejected events costs no storage.
   */
  async onMarketEvent(event: MarketEvent): Promise<{ outcome: string; reason?: string; wakeId?: string; health: HealthReport }> {
    const watcher = await this.ready();
    const now = this.now();
    const before = JSON.stringify([watcher.status, watcher.state.lastConditionStatus, watcher.state.lastWakeAt, watcher.state.lastMarketDataAt]);

    const result = await watcher.tick(event, this.evaluator(), now);
    const after = JSON.stringify([watcher.status, watcher.state.lastConditionStatus, watcher.state.lastWakeAt, watcher.state.lastMarketDataAt]);
    if (before !== after) await this.save();

    return {
      outcome: result.outcome.kind,
      ...(result.outcome.kind === 'SKIPPED' ? { reason: result.outcome.reason } : {}),
      ...(result.outcome.kind === 'WOKEN' ? { wakeId: result.outcome.wake.id } : {}),
      health: result.health,
    };
  }

  /* -------------------------------------------------------------- wakes */

  async pendingWakes(): Promise<Wake[]> {
    return (await this.ready()).pendingWakes();
  }

  async wakeHistory(limit?: number): Promise<Wake[]> {
    return (await this.ready()).wakeHistory(limit);
  }

  /**
   * Claim wakes for delivery.
   *
   * Acknowledging is separated from fetching so a crash between the two
   * leaves the wake claimable again, rather than lost. The acknowledgement
   * timestamp is recorded so a wake that is claimed and never resolved is
   * detectable as a stall.
   */
  async claimWakes(limit = 10): Promise<Wake[]> {
    const watcher = await this.ready();
    const now = this.now();
    const claimed = watcher.pendingWakes().slice(0, limit);
    for (const wake of claimed) watcher.acknowledgeWake(wake.id, now);
    await this.save();
    return claimed;
  }

  async resolveWake(id: string, outcome: WakeOutcome): Promise<{ resolved: boolean; wake?: Wake }> {
    const watcher = await this.ready();
    const wake = watcher.resolveWake(id, outcome, this.now());
    await this.save();
    return { resolved: wake !== null, ...(wake ? { wake } : {}) };
  }

  /* ------------------------------------------------------------- health */

  async health(): Promise<HealthReport & { watcherId: string; status: WatcherStatus; configVersion: number; pendingWakes: number; staleAcknowledgements: number }> {
    const watcher = await this.ready();
    const now = this.now();
    return {
      ...watcher.health(now),
      watcherId: watcher.id,
      status: watcher.status,
      configVersion: watcher.state.config.configVersion,
      pendingWakes: watcher.pendingWakes().length,
      staleAcknowledgements: watcher.staleAcknowledgements(now).length,
    };
  }

  async snapshot(): Promise<unknown> {
    const watcher = await this.ready();
    return { state: watcher.state, pending: watcher.pendingWakes(), history: watcher.wakeHistory(50) };
  }
}

function configsEqual(left: WatcherConfig, right: WatcherConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export { WAKE_TTL_MS };
export type { EvaluationOutcome };
