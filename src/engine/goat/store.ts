/**
 * Goal, Thesis, Evidence and TradeIdea persistence.
 *
 * The previous architecture persisted exactly one agent artefact that
 * mattered: the timeline. Goals, theses, evidence and trade ideas had
 * no home at all, so "why did the agent do that?" was unanswerable.
 *
 * These stores close that gap. They follow the same rules the timeline
 * store already established: keep what is usable, say what was lost,
 * never let a corrupt entry take down a constructor.
 *
 * In-memory implementations are the default; the persistent subclasses
 * add debounced localStorage writes. That matches the timeline, so there
 * is one storage story in the app rather than two.
 */

import {
  Evidence,
  Goal,
  GoalStatus,
  Thesis,
  TradeIdea,
  isThesisState,
} from './types';

export interface GoalStore {
  save(goal: Goal): void;
  get(id: string): Goal | undefined;
  list(): Goal[];
  listForAgent(agentId: string): Goal[];
  getForAgent(agentId: string): Goal | undefined;
  remove(id: string): boolean;
}

export interface ThesisStore {
  save(thesis: Thesis): void;
  get(id: string): Thesis | undefined;
  list(): Thesis[];
  listForGoal(goalId: string): Thesis[];
  /**
   * Theses that can still change. Terminal theses are retained and
   * still readable, they just stop appearing as live hypotheses.
   */
  listLiveForGoal(goalId: string): Thesis[];
  remove(id: string): boolean;
}

export interface EvidenceStore {
  append(evidence: Evidence): void;
  listForThesis(thesisId: string): Evidence[];
  list(): Evidence[];
  /**
   * Evidence that argues against a thesis.
   *
   * Surfaced on its own because a thesis that only ever accumulates
   * support is a thesis the agent stopped checking.
   */
  listContradicting(thesisId: string): Evidence[];
  removeForThesis(thesisId: string): void;
}

export interface TradeIdeaStore {
  save(idea: TradeIdea): void;
  get(id: string): TradeIdea | undefined;
  list(): TradeIdea[];
  listForThesis(thesisId: string): TradeIdea[];
  listForGoal(goalId: string): TradeIdea[];
  remove(id: string): boolean;
}

export type StoreState = 'OK' | 'UNAVAILABLE' | 'FAILED';

/** Deep copy on the way in and out, so callers cannot mutate stored state. */
function copy<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryGoalStore implements GoalStore {
  private readonly goals = new Map<string, Goal>();

  save(goal: Goal): void {
    this.goals.set(goal.id, copy(goal));
  }

  get(id: string): Goal | undefined {
    const goal = this.goals.get(id);
    return goal ? copy(goal) : undefined;
  }

  list(): Goal[] {
    return [...this.goals.values()].map(copy);
  }

  listForAgent(agentId: string): Goal[] {
    return this.list()
      .filter((goal) => goal.agentId === agentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getForAgent(agentId: string): Goal | undefined {
    return this.listForAgent(agentId).at(-1);
  }

  remove(id: string): boolean {
    return this.goals.delete(id);
  }
}

export class InMemoryThesisStore implements ThesisStore {
  private readonly theses = new Map<string, Thesis>();

  save(thesis: Thesis): void {
    this.theses.set(thesis.id, copy(thesis));
  }

  get(id: string): Thesis | undefined {
    const thesis = this.theses.get(id);
    return thesis ? copy(thesis) : undefined;
  }

  list(): Thesis[] {
    return [...this.theses.values()].map(copy);
  }

  listForGoal(goalId: string): Thesis[] {
    return this.list()
      .filter((thesis) => thesis.goalId === goalId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listLiveForGoal(goalId: string): Thesis[] {
    return this.listForGoal(goalId).filter(
      (thesis) => thesis.state !== 'INVALIDATED' && thesis.state !== 'ABANDONED' && thesis.state !== 'COMPLETED',
    );
  }

  remove(id: string): boolean {
    return this.theses.delete(id);
  }
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly items: Evidence[] = [];

  /**
   * Bounded because evidence is the one store that grows without limit
   * in normal operation: a long-lived thesis accrues an item per event.
   */
  constructor(private readonly maxItems = 5_000) {}

  append(evidence: Evidence): void {
    if (this.items.some((item) => item.id === evidence.id)) return;
    this.items.push(copy(evidence));
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
  }

  listForThesis(thesisId: string): Evidence[] {
    return this.items.filter((item) => item.thesisId === thesisId).map(copy);
  }

  listContradicting(thesisId: string): Evidence[] {
    return this.items
      .filter((item) => item.thesisId === thesisId && item.polarity === 'CONTRADICTS')
      .map(copy);
  }

  list(): Evidence[] {
    return this.items.map(copy);
  }

  removeForThesis(thesisId: string): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].thesisId === thesisId) this.items.splice(i, 1);
    }
  }
}

export class InMemoryTradeIdeaStore implements TradeIdeaStore {
  private readonly ideas = new Map<string, TradeIdea>();

  save(idea: TradeIdea): void {
    this.ideas.set(idea.id, copy(idea));
  }

  get(id: string): TradeIdea | undefined {
    const idea = this.ideas.get(id);
    return idea ? copy(idea) : undefined;
  }

  list(): TradeIdea[] {
    return [...this.ideas.values()].map(copy);
  }

  listForThesis(thesisId: string): TradeIdea[] {
    return this.list()
      .filter((idea) => idea.thesisId === thesisId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listForGoal(goalId: string): TradeIdea[] {
    return this.list()
      .filter((idea) => idea.goalId === goalId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id: string): boolean {
    return this.ideas.delete(id);
  }
}

export function getStorageSafely(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    // Reading can itself throw inside a sandboxed frame.
    const probe = '__goat_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}

/**
 * A JSON-backed store with debounced writes.
 *
 * Shared by the persistent goal/thesis/idea stores. Writes are batched
 * for the same reason the timeline batches: an agent mid-burst would
 * otherwise serialise its entire state on every event.
 */
export abstract class PersistentJsonStore<T> {
  protected state: StoreState = 'OK';
  private writeScheduled = false;
  private lastWrite: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  /*
   * Deliberately does NOT restore.
   *
   * It used to, and that was a silent data-loss bug: a base constructor
   * runs before the subclass's field initialisers, so `restore()` was
   * populating a `Map` that did not exist yet. Every write then threw
   * inside `accept()`, the throw was swallowed as "skipped", and the store
   * came back empty — with `storageState: 'FAILED'` as the only clue. In
   * practice that meant a deployed GOAT lost its goal, thesis, evidence and
   * deployment on every reload, which made "reload and press play" untestable.
   *
   * Each subclass calls `restoreFromStorage()` as the last statement of its
   * own constructor, after its state exists.
   */
  constructor(
    protected readonly storageKey: string,
    private readonly debounceMs = 250,
  ) {}

  get storageState(): StoreState {
    return this.state;
  }

  /**
   * Everything this store currently holds.
   *
   * Named for what it is rather than for where it comes from, because the
   * two jobs must not be confused. A store that implemented this by
   * re-reading storage wrote its own saved copy back over its live one,
   * which is how deployments and skills could be created, run all session,
   * and vanish on reload.
   */
  protected abstract snapshot(): T[];

  /** Write the whole store out. Only called after something changed. */
  protected abstract persist(items: T[]): void;
  protected abstract isRestorable(item: unknown): boolean;

  protected markDirty(): void {
    this.dirty = true;
    this.scheduleWrite();
  }

  flush(): void {
    if (this.lastWrite !== undefined) {
      clearTimeout(this.lastWrite);
      this.lastWrite = undefined;
    }
    this.writeScheduled = false;
    if (this.dirty) this.write();
  }

  /**
   * Load what was saved.
   *
   * Public to subclasses only: called from their constructors, after their
   * own fields exist. Never call it twice — `restoreFromStorage` is
   * idempotent precisely because a constructor can be reached by more than
   * one path in a subclass.
   */
  protected restoreFromStorage(): void {
    if (this.restored) return;
    this.restored = true;
    this.restore();
  }

  private restored = false;

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
      this.state = 'FAILED';
      return;
    }
    if (!Array.isArray(saved)) return;

    let skipped = 0;
    for (const item of saved) {
      if (!this.isRestorable(item)) {
        skipped += 1;
        continue;
      }
      try {
        this.accept(item);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) this.state = 'FAILED';
  }

  /** Rehydrate one entry. Must not validate again; restore already did. */
  protected abstract accept(item: unknown): void;

  private scheduleWrite(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    this.lastWrite = setTimeout(() => {
      this.lastWrite = undefined;
      this.writeScheduled = false;
      this.write();
    }, this.debounceMs);
  }

  private write(): void {
    const storage = getStorageSafely();
    if (!storage) {
      this.state = 'UNAVAILABLE';
      return;
    }
    try {
      this.persist(this.snapshot());
      this.dirty = false;
      this.state = 'OK';
    } catch {
      // A full quota is not a reason to lose the in-memory record.
      this.state = 'FAILED';
    }
  }
}

function hasStringId(value: unknown): value is { id: string } {
  if (!value || typeof value !== 'object') return false;
  const candidate = (value as { id?: unknown }).id;
  return typeof candidate === 'string' && candidate.length > 0;
}

export class PersistentGoalStore extends PersistentJsonStore<Goal> implements GoalStore {
  private readonly goals = new Map<string, Goal>();

  constructor(storageKey = 'goat:goals') {
    super(storageKey);
    // After the field initialisers above: restoring into a Map that does
    // not exist yet is what this call used to do, silently.
    this.restoreFromStorage();
  }

  protected isRestorable(item: unknown): boolean {
    if (!hasStringId(item)) return false;
    const goal = item as Partial<Goal>;
    return typeof goal.agentId === 'string' && typeof goal.statement === 'string';
  }

  protected accept(item: unknown): void {
    this.goals.set((item as Goal).id, copy(item as Goal));
  }

  protected snapshot(): Goal[] {
    return [...this.goals.values()];
  }

  protected persist(items: Goal[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  save(goal: Goal): void {
    this.goals.set(goal.id, copy(goal));
    this.markDirty();
  }

  get(id: string): Goal | undefined {
    const goal = this.goals.get(id);
    return goal ? copy(goal) : undefined;
  }

  list(): Goal[] {
    return [...this.goals.values()].map(copy);
  }

  listForAgent(agentId: string): Goal[] {
    return this.list().filter((g) => g.agentId === agentId).sort((a, b) => a.createdAt - b.createdAt);
  }

  getForAgent(agentId: string): Goal | undefined {
    return this.listForAgent(agentId).at(-1);
  }

  remove(id: string): boolean {
    const removed = this.goals.delete(id);
    if (removed) this.markDirty();
    return removed;
  }
}

export class PersistentThesisStore extends PersistentJsonStore<Thesis> implements ThesisStore {
  private readonly theses = new Map<string, Thesis>();

  constructor(storageKey = 'goat:theses') {
    super(storageKey);
    this.restoreFromStorage();
  }

  protected isRestorable(item: unknown): boolean {
    if (!hasStringId(item)) return false;
    const thesis = item as Partial<Thesis>;
    /*
     * Admission, not transition. Every state the system can record has to
     * survive a reload — including DRAFT, INVESTIGATING, ACTIONABLE and
     * the terminal states, because "why did GOAT give up on this?" is a
     * question only a retained terminal thesis can answer. A thesis that
     * fails this check is dropped from storage on the next write, so the
     * check has to be a recogniser and nothing stricter.
     */
    return (
      typeof thesis.goalId === 'string' &&
      typeof thesis.statement === 'string' &&
      isThesisState(thesis.state)
    );
  }

  protected accept(item: unknown): void {
    this.theses.set((item as Thesis).id, copy(item as Thesis));
  }

  protected snapshot(): Thesis[] {
    return [...this.theses.values()];
  }

  protected persist(items: Thesis[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  save(thesis: Thesis): void {
    this.theses.set(thesis.id, copy(thesis));
    this.markDirty();
  }

  get(id: string): Thesis | undefined {
    const thesis = this.theses.get(id);
    return thesis ? copy(thesis) : undefined;
  }

  list(): Thesis[] {
    return [...this.theses.values()].map(copy);
  }

  listForGoal(goalId: string): Thesis[] {
    return this.list().filter((t) => t.goalId === goalId).sort((a, b) => a.createdAt - b.createdAt);
  }

  listLiveForGoal(goalId: string): Thesis[] {
    return this.listForGoal(goalId).filter(
      (t) => t.state !== 'INVALIDATED' && t.state !== 'ABANDONED' && t.state !== 'COMPLETED',
    );
  }

  remove(id: string): boolean {
    const removed = this.theses.delete(id);
    if (removed) this.markDirty();
    return removed;
  }
}

export class PersistentEvidenceStore extends PersistentJsonStore<Evidence> implements EvidenceStore {
  private readonly items: Evidence[] = [];

  constructor(
    private readonly maxItems = 5_000,
    storageKey = 'goat:evidence',
  ) {
    super(storageKey);
    this.restoreFromStorage();
  }

  protected isRestorable(item: unknown): boolean {
    if (!hasStringId(item)) return false;
    const evidence = item as Partial<Evidence>;
    return typeof evidence.thesisId === 'string' && typeof evidence.summary === 'string';
  }

  protected accept(item: unknown): void {
    const evidence = copy(item as Evidence);
    if (this.items.some((existing) => existing.id === evidence.id)) return;
    this.items.push(evidence);
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
  }

  protected snapshot(): Evidence[] {
    return [...this.items];
  }

  protected persist(items: Evidence[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  append(evidence: Evidence): void {
    if (this.items.some((item) => item.id === evidence.id)) return;
    this.items.push(copy(evidence));
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
    this.markDirty();
  }

  listForThesis(thesisId: string): Evidence[] {
    return this.items.filter((item) => item.thesisId === thesisId).map(copy);
  }

  listContradicting(thesisId: string): Evidence[] {
    return this.items.filter((i) => i.thesisId === thesisId && i.polarity === 'CONTRADICTS').map(copy);
  }

  list(): Evidence[] {
    return this.items.map(copy);
  }

  removeForThesis(thesisId: string): void {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].thesisId === thesisId) this.items.splice(i, 1);
    }
    if (this.items.length !== before) this.markDirty();
  }
}

export class PersistentTradeIdeaStore extends PersistentJsonStore<TradeIdea> implements TradeIdeaStore {
  private readonly ideas = new Map<string, TradeIdea>();

  constructor(storageKey = 'goat:trade-ideas') {
    super(storageKey);
    this.restoreFromStorage();
  }

  protected isRestorable(item: unknown): boolean {
    if (!hasStringId(item)) return false;
    const idea = item as Partial<TradeIdea>;
    return typeof idea.thesisId === 'string' && typeof idea.symbol === 'string';
  }

  protected accept(item: unknown): void {
    this.ideas.set((item as TradeIdea).id, copy(item as TradeIdea));
  }

  protected snapshot(): TradeIdea[] {
    return [...this.ideas.values()];
  }

  protected persist(items: TradeIdea[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  save(idea: TradeIdea): void {
    this.ideas.set(idea.id, copy(idea));
    this.markDirty();
  }

  get(id: string): TradeIdea | undefined {
    const idea = this.ideas.get(id);
    return idea ? copy(idea) : undefined;
  }

  list(): TradeIdea[] {
    return [...this.ideas.values()].map(copy);
  }

  listForThesis(thesisId: string): TradeIdea[] {
    return this.list().filter((i) => i.thesisId === thesisId).sort((a, b) => a.createdAt - b.createdAt);
  }

  listForGoal(goalId: string): TradeIdea[] {
    return this.list().filter((i) => i.goalId === goalId).sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id: string): boolean {
    const removed = this.ideas.delete(id);
    if (removed) this.markDirty();
    return removed;
  }
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status === 'ACHIEVED' || status === 'ABANDONED';
}
