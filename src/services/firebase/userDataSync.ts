/**
 * Connecting the authenticated account to the application's own stores.
 *
 * ## The problem this solves
 *
 * `PersistenceService` was complete and tested, and nothing called it. The GOAT
 * store persisted to `localStorage`, so a refresh brought back the same data on
 * the same browser and nothing at all on another one — which reads exactly like
 * a working feature until the moment somebody signs in on a second device, or
 * clears their browser. There was no path from "Firebase knows who this is" to
 * "here are this user's GOATs".
 *
 * ## The ordering rule
 *
 * Load, then write. Never the other way round.
 *
 * A refresh restores the session asynchronously and rehydrates the local store
 * from the last device's copy. If a write were allowed to reach Firestore before
 * the read returned, that local copy would overwrite the account's data with a
 * blank state — the classic "my GOATs disappeared" bug, caused by the app
 * winning a race it should not have entered. So writes made during hydration are
 * *queued* and flushed only after the read has landed, and the queue is dropped
 * rather than flushed if the account turns out to have data the local store did
 * not know about, because that data is authoritative.
 *
 * ## Ownership
 *
 * Every read and write is scoped by the Firebase `uid` from the session. There is
 * no fallback owner, no device id standing in for a user, and no path that reads
 * another account's documents. Signing out clears the binding, so a stale
 * reference cannot keep reading the last user's data after the tab moves on.
 *
 * ## What is deliberately not synced
 *
 * Runtime state. Live tracker execution, timers, model request bookkeeping and
 * deployment handles belong to the process that owns them; writing them to
 * Firestore would restore a machine's memory onto a different machine and imply
 * a resumption that does not exist. Only what the user authored is persisted.
 */

import type { AuthSession, AuthService } from './auth';
import type { PersistenceService } from './persistence';
import type { GoatRecord } from './contract';
import type { Goal, GoalStatus } from '../../engine/goat/types';
import type { GoalStore } from '../../engine/goat/store';

/** The part of `GoalStore` a GOAT's persisted form can be rebuilt from. */
export interface HydratableGoalStore {
  get(id: string): Goal | undefined;
  list(): Goal[];
  save(goal: Goal): void;
}

export type SyncState = 'SIGNED_OUT' | 'HYDRATING' | 'READY' | 'ERROR';

export interface UserDataSyncOptions {
  auth: AuthService;
  data: PersistenceService;
  goals: HydratableGoalStore;
  /** Report state to the UI. */
  onState?: (state: SyncState, detail?: string) => void;
}

export interface UserDataSync {
  /**
   * Wrap the GOAT store so saving a GOAT also saves it to the account.
   *
   * This is what makes Firestore the data path rather than a copy of it. The
   * wrapper holds no state of its own: writes land in the device store first —
   * so the UI is never waiting on a network round trip — and are then pushed to
   * the account. A push that fails is reported, never silently dropped.
   *
   * Writes made while hydrating are queued rather than pushed, because pushing
   * before the read lands is the overwrite this module exists to prevent.
   */
  goalStore(inner: GoalStore): GoalStore;
  /** Where the data path is, for a surface that says so. */
  readonly state: SyncState;
  /** The uid currently bound, or null when signed out. */
  readonly uid: string | null;
  /** Wait for hydration to settle. Tests and a manual refresh use this. */
  ready(): Promise<void>;
  /** The uid the bound account's data is written under, for diagnostics. */
  describe(): string;
  dispose(): void;
}

/*
 * The two vocabularies are deliberately different sizes.
 *
 * The runtime distinguishes a GOAT that is still being written from one that has
 * been pointed at a market (`DRAFT`, `INVESTIGATING`), and treats a finished or
 * abandoned GOAT as part of the archived family. The stored record has no use for
 * the first distinction — a GOAT that is not monitoring is simply not monitoring
 * — and does carry `ARCHIVED`, which is where a finished or abandoned GOAT
 * belongs.
 *
 * So the mapping is written out rather than cast: only `MONITORING` survives the
 * round trip unchanged, and everything else collapses toward `UNDEPLOYED` on the
 * way in and toward `ARCHIVED` on the way out.
 */
const RECORD_TO_GOAL: Readonly<Record<GoatRecord['status'], GoalStatus>> = {
  MONITORING: 'MONITORING',
  UNDEPLOYED: 'UNDEPLOYED',
  PAUSED: 'UNDEPLOYED',
  ARCHIVED: 'ABANDONED',
};

function recordStatusToGoal(status: GoatRecord['status']): GoalStatus {
  return RECORD_TO_GOAL[status] ?? 'UNDEPLOYED';
}

function goalStatusToRecord(status: GoalStatus): GoatRecord['status'] {
  if (status === 'MONITORING') return 'MONITORING';
  if (status === 'ACHIEVED' || status === 'ABANDONED') return 'ARCHIVED';
  return 'UNDEPLOYED';
}

/**
 * A stored GOAT, back into the shape the runtime works with.
 *
 * Returns undefined rather than a partially-built goal: a record the app cannot
 * read must not become a half-restored GOAT that the UI would offer to deploy.
 */
export function goalFromRecord(record: GoatRecord, agentId: string): Goal | undefined {
  if (!record?.id) return undefined;
  const status = recordStatusToGoal(record.status);
  return {
    id: record.id,
    agentId,
    name: record.name,
    description: record.description,
    statement: record.objective,
    ...(record.interpretation ? { interpretation: record.interpretation } : {}),
    symbols: Array.isArray(record.symbols) ? [...record.symbols] : [],
    timeframes: Array.isArray(record.timeframes) ? [...record.timeframes] : [],
    skillIds: Array.isArray(record.skillIds) ? [...record.skillIds] : [],
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** A runtime goal, in the form Firestore stores. */
export function recordFromGoal(goal: Goal): Omit<GoatRecord, 'ownerId' | 'schemaVersion' | 'createdAt' | 'updatedAt'> {
  return {
    id: goal.id,
    name: goal.name ?? '',
    description: goal.description ?? '',
    objective: goal.statement,
    ...(goal.interpretation ? { interpretation: goal.interpretation } : {}),
    symbols: [...goal.symbols],
    timeframes: [...goal.timeframes],
    skillIds: [...goal.skillIds],
    status: goalStatusToRecord(goal.status),
  };
}

/**
 * Start syncing one account's GOATs to and from Firestore.
 *
 * Returns immediately; hydration runs off the caller's stack. Call `ready()` to
 * await it.
 */
export function startUserDataSync(options: UserDataSyncOptions): UserDataSync {
  const { auth, data, goals, onState } = options;

  let state: SyncState = auth.current ? 'HYDRATING' : 'SIGNED_OUT';
  let uid: string | null = null;
  /** Writes made before the read landed. Flushed, or dropped, after it. */
  let queued: Goal[] = [];
  let settled: Promise<void> = Promise.resolve();
  let disposed = false;

  const publish = (next: SyncState, detail?: string): void => {
    if (disposed) return;
    state = next;
    onState?.(next, detail);
  };

  /**
   * Adopt the account's GOATs, then release anything written while we waited.
   *
   * The account is authoritative. A GOAT that exists in Firestore and not
   * locally is restored rather than overwritten, which is the whole reason the
   * read happens before any write is allowed through.
   */
  const hydrate = async (owner: string, agentId: string): Promise<void> => {
    publish('HYDRATING');

    if (!data.available) {
      // No Firestore: the device-local store is the product, not a degraded copy.
      publish('READY', 'Firestore is unavailable; this device keeps its own data.');
      return;
    }

    try {
      const records = await data.listGoats(owner);
      if (disposed || uid !== owner) return;

      let restored = 0;
      for (const record of records) {
        const goal = goalFromRecord(record, agentId);
        // Never clobber a local goal with a stale stored one.
        if (!goal) continue;
        if (goals.get(goal.id)?.updatedAt && goals.get(goal.id)!.updatedAt > goal.updatedAt) continue;
        goals.save(goal);
        restored += 1;
      }

      /*
       * Writes are drained after the read, not from a snapshot taken before it.
       * A snapshot misses everything queued *during* the read — which is the
       * whole window this ordering exists for, and would silently drop the one
       * write that mattered.
       *
       * Each is released only if the account does not already hold something at
       * least as new; the account wins a tie, so a local edit can never roll back
       * a change made elsewhere.
       */
      for (let drained = 0; queued.length > 0 && drained < 50; drained += 1) {
        const pending = queued;
        queued = [];
        for (const goal of pending) {
          if (records.some((record) => record.id === goal.id && record.updatedAt >= goal.updatedAt)) continue;
          await push(owner, goal);
        }
      }

      publish('READY', restored > 0 ? `Restored ${restored} GOATs from this account.` : undefined);
    } catch (error) {
      // A failed read must not cost the user their local state.
      publish('ERROR', error instanceof Error ? error.message : String(error));
    }
  };

  const push = async (owner: string, goal: Goal): Promise<void> => {
    if (!data.available) return;
    try {
      const payload = recordFromGoal(goal);
      const existing = await data.getGoat(owner, goal.id);
      if (existing) await data.updateGoat(owner, goal.id, payload);
      else await data.createGoat(owner, payload);
    } catch (error) {
      // Surfaced rather than swallowed: a rejected write must not look saved.
      publish('ERROR', error instanceof Error ? error.message : String(error));
    }
  };

  const removeFromAccount = async (owner: string, goatId: string): Promise<void> => {
    if (!data.available) return;
    try {
      await data.deleteGoat(owner, goatId);
    } catch (error) {
      publish('ERROR', error instanceof Error ? error.message : String(error));
    }
  };

  const bind = async (session: AuthSession | null): Promise<void> => {
    if (disposed) return;
    uid = session?.uid ?? null;
    if (!session) {
      queued = [];
      publish('SIGNED_OUT');
      settled = Promise.resolve();
      return;
    }
    publish('HYDRATING');
    settled = hydrate(session.uid, session.uid);
    await settled;
  };

  const unsubscribe = auth.subscribe((session) => {
    void bind(session);
  });

  // The session may already be restored by the time the app mounts.
  if (auth.current) {
    // Bound before hydrating: `hydrate` checks that it is still the owner of the
    // read it started, and an unbound start would abandon its own read.
    uid = auth.current.uid;
    settled = hydrate(auth.current.uid, auth.current.uid);
  } else {
    settled = Promise.resolve();
  }

  return {
    /*
     * Only `save` and `remove` are intercepted. Everything else is the store's
     * own behaviour passed straight through: reads must not be able to trigger a
     * write, and a wrapper that reimplemented them would be a second source of
     * truth about what exists.
     */
    goalStore: (inner: GoalStore): GoalStore => ({
      ...inner,
      get: (id) => inner.get(id),
      list: () => inner.list(),
      listForAgent: (agentId) => inner.listForAgent(agentId),
      getForAgent: (agentId) => inner.getForAgent(agentId),
      remove: (id) => {
        const removed = inner.remove(id);
        if (removed && uid && state === 'READY') void removeFromAccount(uid, id);
        return removed;
      },
      save: (goal: Goal) => {
        inner.save(goal);
        if (!uid) return;
        if (state === 'HYDRATING') {
          queued.push(goal);
          return;
        }
        if (state !== 'READY') return;
        void push(uid, goal);
      },
    }),
    get state() {
      return state;
    },
    get uid() {
      return uid;
    },
    ready: () => settled,
    describe: () => (uid ? `Firestore as ${uid}` : 'device-local'),
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}