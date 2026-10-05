/**
 * Backtest session ownership.
 *
 * ## The invariant
 *
 * A running replay outlives the screen that started it. `BacktestSurface` is a
 * view over a session, never its owner: the session is registered here, keyed by
 * GOAT, and stays reachable whether or not a surface is mounted.
 *
 * ## Why this had to move
 *
 * The surface used to construct the session into component state and read it
 * back from there. `GoatView` swaps screens by changing one piece of state, so
 * leaving a backtest unmounted the surface, which dropped the session object —
 * while the clock the session had armed kept ticking. The result was worse than
 * lost state: a replay still executing, still spending model calls, that no code
 * path could reach, pause, or read. There was nothing left holding it but the
 * timer it had installed, and nothing that could stop it.
 *
 * Cleanup could not simply be added to the unmount handler, because that would
 * trade one failure for its mirror image: a replay that dies the moment the user
 * looks away, so navigating to check a GOAT would terminate the run silently.
 * Ownership is the thing that was missing, and adding `session.stop()` to a
 * cleanup function would have hidden the real defect behind a plausible patch.
 *
 * ## The distinction that matters
 *
 * Unmounting is not stopping. The surface detaching releases UI subscriptions
 * and its own refresh interval and nothing else; the session keeps running
 * because the user never asked it to stop. Execution ends when someone says so —
 * `stop` for a user pressing stop, `dispose` for a GOAT being torn down — and
 * both release the clock on the way out.
 *
 * ## What this does not do
 *
 * Sessions live in memory, so this covers React route and screen navigation
 * within one page load. It is not reload persistence and not tab-closure
 * survival: a refresh destroys this registry along with the JavaScript context
 * that holds it. Making a replay outlive the page is a different problem with a
 * different answer (a server-side runner), and pretending otherwise would be a
 * claim this module cannot keep.
 */

import { BacktestSession } from './session';
import type { BacktestRequest, BacktestSnapshot } from './session';

/**
 * The key a session is filed under.
 *
 * A GOAT's own id when the replay came from one, and a fixed key for the ad-hoc
 * case where someone replayed a market without a GOAT behind it. Two replays of
 * the same GOAT are the same subject, so they share a slot; the replacement is
 * an explicit `restart`, which is a decision, not an accident of mounting.
 */
export const AD_HOC_BACKTEST_KEY = 'backtest:ad-hoc';

export function backtestKeyFor(goatId: string | undefined): string {
  return goatId ?? AD_HOC_BACKTEST_KEY;
}

export type BacktestListener = (session: BacktestSession | undefined) => void;

export interface BacktestManager {
  /** The session running for this key, or undefined when nothing is. */
  get(key: string): BacktestSession | undefined;
  /** Every live key. Diagnostic, and what makes "two GOATs are independent" checkable. */
  keys(): string[];
  /**
   * Register a session as the one running for `key`.
   *
   * Any session already filed under that key is stopped first: a key names one
   * subject, and silently leaving two replays of one GOAT running would make
   * whichever finished last look like the answer to a question both were asking.
   */
  register(key: string, session: BacktestSession): BacktestSession;
  /** Take the session out of the registry without stopping it. Rarely correct. */
  release(key: string): void;
  /**
   * Stop execution because the user asked. The session is kept, because a
   * stopped run still has a report and trades worth reading.
   */
  stop(key: string, reason?: string): Promise<void>;
  /** Stop and forget: the slot is cleared and the timer released. */
  dispose(key: string, reason?: string): Promise<void>;
  /**
   * Watch a key's session. Fires immediately with the current one so a view
   * mounting late re-attaches to a run already in progress rather than sitting
   * blank until the next tick.
   */
  subscribe(key: string, listener: BacktestListener): () => void;
}

export function createBacktestManager(): BacktestManager {
  const sessions = new Map<string, BacktestSession>();
  const listeners = new Map<string, Set<BacktestListener>>();

  const publish = (key: string): void => {
    const session = sessions.get(key);
    for (const listener of listeners.get(key) ?? []) listener(session);
  };

  return {
    get: (key) => sessions.get(key),

    keys: () => [...sessions.keys()],

    register: (key, session) => {
      const existing = sessions.get(key);
      if (existing && existing !== session) {
        // Stop the incumbent's timer rather than dropping the reference: a
        // replaced session that kept ticking would orphan exactly as before.
        void existing.stop('Replaced by a newer replay of this GOAT.');
      }
      sessions.set(key, session);
      publish(key);
      return session;
    },

    release: (key) => {
      if (!sessions.has(key)) return;
      sessions.delete(key);
      publish(key);
    },

    stop: async (key, reason) => {
      const session = sessions.get(key);
      if (!session) return;
      await session.stop(reason);
      // The session stays filed: its report and trades remain readable.
    },

    dispose: async (key, reason) => {
      const session = sessions.get(key);
      if (!session) return;
      sessions.delete(key);
      publish(key);
      await session.stop(reason);
    },

    subscribe: (key, listener) => {
      const set = listeners.get(key) ?? new Set<BacktestListener>();
      set.add(listener);
      listeners.set(key, set);
      listener(sessions.get(key));
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}

/**
 * The application-wide registry.
 *
 * Module scope on purpose: this is the object whose lifetime is the page's, not
 * a component's, which is the entire point. A React context would tie ownership
 * to the provider's tree and reintroduce the original bug one level up.
 */
export const backtestManager: BacktestManager = createBacktestManager();

/** Builds the session and files it under `key`. The only construction path. */
export function createManagedBacktest(
  key: string,
  request: BacktestRequest,
): BacktestSession {
  return backtestManager.register(key, new BacktestSession(request));
}

/** Snapshot of every running replay, for diagnostics and tests. */
export function backtestSummaries(): Record<string, BacktestSnapshot> {
  const summaries: Record<string, BacktestSnapshot> = {};
  for (const [key, session] of backtestManager.keys().map((k) => [k, backtestManager.get(k)!] as const)) {
    summaries[key] = session.snapshot();
  }
  return summaries;
}
