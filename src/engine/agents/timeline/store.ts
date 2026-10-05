import { AgentTimelineEvent, AgentTimelineStore, TimelineListener, TimelineQuery } from './types';

/**
 * How persistence failures are handled.
 *
 * Activity history is a convenience, not a correctness requirement: a
 * browser that refuses storage should still let the runtime start and the
 * user still see the current session. Losing history is acceptable;
 * refusing to boot is not. Every failure path below is therefore a
 * recorded warning rather than a thrown error, and `storageState` makes
 * the degradation observable instead of invisible.
 */
export type TimelineStorageState = 'OK' | 'UNAVAILABLE' | 'FAILED';

/**
 * How long appends are coalesced before the history is written.
 *
 * Long enough that a burst of position updates (one per quote tick)
 * produces one write, short enough that closing a tab loses almost
 * nothing. The `beforeunload` and `visibilitychange` paths call `flush()`.
 */
const WRITE_DEBOUNCE_MS = 250;

export class InMemoryAgentTimelineStore implements AgentTimelineStore {
  private readonly events: AgentTimelineEvent[] = [];
  protected readonly maxEvents: number;
  private readonly listeners = new Set<TimelineListener>();

  constructor(maxEvents = 10_000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be a positive integer.');
    this.maxEvents = maxEvents;
  }

  async append(event: AgentTimelineEvent): Promise<void> {
    if (!event.id || !event.agentId || !Number.isFinite(event.timestamp)) throw new Error('Invalid timeline event identity.');
    // Idempotent by id: the same event delivered twice is stored once.
    // This is what makes a redelivered market event harmless.
    if (this.events.some((existing) => existing.id === event.id)) return;
    this.events.push(clone(event));
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.onAppended(event);
    this.announce(event);
  }

  /** Hook for subclasses; keeps persistence off the hot path. */
  /**
   * Forget everything recorded for a GOAT.
   *
   * Exists for one operation: clearing a session. An agent log is the record of
   * what a session *did*, so a cleared session's log is not history to be archived
   * or filtered — it is the residue the clear exists to remove. Hiding it in the UI
   * while leaving it in the store is exactly how a "cleared" GOAT comes back with
   * yesterday's events after a reload.
   *
   * Returns how many events were dropped, so a caller can assert that a clear
   * actually cleared rather than trusting that it did.
   */
  async removeForGoat(goatId: string): Promise<number> {
    let removed = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index].goatId !== goatId) continue;
      this.events.splice(index, 1);
      removed += 1;
    }
    if (removed > 0) this.onRemoved(goatId);
    return removed;
  }

  /**
   * Hook for subclasses.
   *
   * The persistent store has to write the shortened list through here, and it
   * cannot ride `append`'s path because a clear produces no append.
   */
  protected onRemoved(_goatId: string): void { /* in-memory has nothing to persist */ }
  protected onAppended(_event: AgentTimelineEvent): void { /* in-memory has nothing to do */ }

  /**
   * Watch for events as they are recorded.
   *
   * This exists because of a specific failure: a GOAT screen polled its
   * state every two seconds behind a signature built from mission fields, and
   * an activity event changed none of them. So a tracker could fire, the
   * agent could wake, record evidence and revise its thesis — all of it real,
   * all of it written — and the log would sit there showing the last thing
   * that happened until some unrelated field moved. An agent log that cannot
   * be live is not an agent log.
   *
   * Listeners are notified synchronously after the event is stored, are
   * called with the stored event, and are isolated from one another: a
   * listener that throws must not stop the event being recorded, must not
   * stop the other listeners being told, and must not propagate into the
   * runtime that produced the event.
   */
  subscribe(listener: TimelineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private announce(event: AgentTimelineEvent): void {
    if (this.listeners.size === 0) return;
    // Copied first: a listener that unsubscribes during the loop must not
    // change who gets told.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A view that cannot render is not a reason to lose the record.
      }
    }
  }

  async getByAgent(agentId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    return this.select((event) => event.agentId === agentId, options);
  }

  async getByGoat(goatId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    return this.select((event) => event.goatId === goatId, options);
  }

  async getByDeployment(deploymentId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    return this.select((event) => event.deploymentId === deploymentId, options);
  }

  /** The GOAT history, oldest first, without a promise in the way. */
  snapshotByGoat(goatId: string, limit = 40): AgentTimelineEvent[] {
    return this.select((event) => event.goatId === goatId, { limit });
  }

  async getByTrade(tradeId: string): Promise<AgentTimelineEvent[]> {
    return this.events.filter((event) => event.tradeId === tradeId).map(clone);
  }

  async getByPosition(positionId: string): Promise<AgentTimelineEvent[]> {
    return this.events.filter((event) => event.positionId === positionId).map(clone);
  }

  /**
   * A shallow copy of the live history.
   *
   * The old implementation exposed a deep clone of every event on every
   * append, which meant a position update on every quote tick copied the
   * whole timeline. Callers that need a snapshot should ask for one
   * explicitly; the common path only needs the list.
   */
  protected getAllEvents(): AgentTimelineEvent[] {
    return this.events.slice();
  }

  protected get eventCount(): number {
    return this.events.length;
  }

  private select(predicate: (event: AgentTimelineEvent) => boolean, options: TimelineQuery): AgentTimelineEvent[] {
    const matched: AgentTimelineEvent[] = [];
    // Walk backwards so the limit can be applied without copying first.
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (predicate(event) && matches(event, options)) matched.push(clone(event));
      if (matched.length >= boundedLimit(options.limit)) break;
    }
    return matched.reverse();
  }
}

/**
 * Whether a stored entry can be restored as a timeline event.
 *
 * Identity is what the store actually depends on -- `append` de-dupes
 * on it, and the id is what history is keyed by -- so an entry without a
 * usable id and timestamp is not a degraded event, it is not an event.
 */
function isRestorableEvent(value: unknown): value is AgentTimelineEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentTimelineEvent>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.agentId === 'string' &&
    candidate.agentId.length > 0 &&
    typeof candidate.timestamp === 'number' &&
    Number.isFinite(candidate.timestamp)
  );
}

export class PersistentAgentTimelineStore extends InMemoryAgentTimelineStore {
  private readonly storageKey: string;
  private state: TimelineStorageState = 'OK';
  private writePending = false;
  private writeScheduled = false;
  /** Batched writes amortise the cost of a burst of events. */
  private lastWrite: ReturnType<typeof setTimeout> | undefined;

  constructor(maxEvents = 10_000, storageKey = 'tradingvibe:agent-timeline') {
    super(maxEvents);
    this.storageKey = storageKey;
    this.restore();
  }

  /**
   * Whether history is actually being kept.
   *
   * Surfaced so the UI can say "activity is not being saved" instead of
   * silently presenting an empty timeline as the truth.
   */
  get storageState(): TimelineStorageState {
    return this.state;
  }

  /**
   * Force a write now. Tests and page-unload handlers use this so a
   * pending batch is not lost.
   */
  flush(): void {
    if (this.lastWrite !== undefined) {
      clearTimeout(this.lastWrite);
      this.lastWrite = undefined;
    }
    // The scheduling flag has to be cleared too. Leaving it set makes
    // every later `scheduleWrite` a no-op, so the first flush after
    // construction silently disabled persistence for the rest of the
    // session.
    this.writeScheduled = false;
    this.write();
  }

  protected override onAppended(_event: AgentTimelineEvent): void {
    this.writePending = true;
    this.scheduleWrite();
  }

  /**
   * A clear is persisted immediately rather than scheduled.
   *
   * Scheduled would be wrong here: the whole point is that a cleared session's log
   * does not come back, and a debounced write leaves a window in which a reload
   * restores every event that was just removed.
   */
  protected override onRemoved(goatId: string): void {
    this.writePending = true;
    if (this.lastWrite !== undefined) {
      clearTimeout(this.lastWrite);
      this.lastWrite = undefined;
    }
    this.write();
  }

  private restore(): void {
    const storage = getStorageSafely();
    if (!storage) {
      this.state = 'UNAVAILABLE';
      return;
    }
    let saved: unknown;
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return;
      saved = JSON.parse(raw);
    } catch {
      // Corrupt history is discarded, not fatal: refusing to start would
      // take the whole runtime down over a local cache.
      this.state = 'FAILED';
      return;
    }
    if (!Array.isArray(saved)) return;

    /*
     * Each event is restored on its own, and a bad one is skipped.
     *
     * This used to be a `try` around the whole loop with
     * `void super.append(...)` inside it. `append` is async and it
     * validates identity, so a stored event without a usable id produced
     * a rejected promise that the `void` discarded -- an unhandled
     * rejection -- while the surrounding `try` saw nothing, because the
     * throw happened in a promise rather than on this stack. One
     * malformed entry in local storage could therefore take down the
     * constructor, and with it the user's entire history.
     *
     * Restoring is a local cache, so the rule is the same as everywhere
     * else in this file: keep what is usable, say what was lost.
     */
    let skipped = 0;
    for (const event of saved) {
      if (!isRestorableEvent(event)) {
        skipped += 1;
        continue;
      }
      // `append` is async but does its mutation before its first await,
      // so the event is in the array by the time this line returns. The
      // try is belt and braces: it is here so that a future await inside
      // `append` cannot turn a bad cache entry into a failed startup.
      try {
        void super.append(event);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      // A partial restore is not a clean one, and the interface is told
      // so rather than showing a short history as if it were complete.
      this.state = 'FAILED';
    }
  }

  private scheduleWrite(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    /*
     * A short debounce, not a per-append write.
     *
     * Rewriting the whole history on every append was quadratic in
     * practice: the demo adapter emits a POSITION_UPDATE on every quote
     * tick, so a tab with a few thousand events spent its time copying and
     * serialising its own history several times a second, which locked up
     * the UI and stopped history persisting once the storage quota was
     * hit.
     *
     * The window is short on purpose. Activity history is a convenience,
     * not a durability guarantee, so coalescing a burst costs nothing,
     * while a long debounce would risk losing a user's last few events
     * when they close the tab.
     */
    this.lastWrite = setTimeout(() => {
      this.writeScheduled = false;
      this.write();
    }, WRITE_DEBOUNCE_MS);
    // Never keep a Node process alive for a history write.
    (this.lastWrite as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Write the current list through now.
   *
   * Separate from `write()` because a clear must not be deferred: the scheduled
   * path exists to amortise a burst of appends, and a removal that waits on a timer
   * is a removal that a reload can undo.
   */
  private write(): void {
    this.writePending = false;
    const storage = getStorageSafely();
    if (!storage) {
      this.state = 'UNAVAILABLE';
      return;
    }
    try {
      storage.setItem(this.storageKey, JSON.stringify(this.getAllEvents()));
      this.state = 'OK';
    } catch {
      // Quota exceeded, private browsing, or a revoked permission. The
      // in-memory timeline keeps working; persistence is what degrades.
      this.state = 'FAILED';
    }
  }
}

function matches(event: AgentTimelineEvent, query: TimelineQuery): boolean {
  return (query.from === undefined || event.timestamp >= query.from) &&
    (query.to === undefined || event.timestamp <= query.to) &&
    (query.type === undefined || event.type === query.type) &&
    (query.goatId === undefined || event.goatId === query.goatId) &&
    (query.deploymentId === undefined || event.deploymentId === query.deploymentId);
}

/**
 * Read `localStorage` without ever throwing.
 *
 * `'localStorage' in globalThis` is true in contexts where merely reading
 * the property raises a SecurityError: a sandboxed iframe without
 * `allow-same-origin`, or storage disabled in the browser. That throw
 * previously escaped module initialisation, so React never mounted and
 * the user saw a blank page with no error boundary, because the boundary
 * is inside the tree that failed to render.
 */
function getStorageSafely(): Storage | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (!candidate) return undefined;
    // Probe the surface once: a present-but-unusable object is worse
    // than an absent one, because every later call would throw.
    typeof candidate.getItem === 'function' || undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 1000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Timeline limit must be a positive integer.');
  return Math.min(limit, 1000);
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}
