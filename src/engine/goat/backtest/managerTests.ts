/**
 * Tests for backtest session ownership.
 *
 * ## The failure this exists to prevent
 *
 * `BacktestSurface` used to build its `BacktestSession` into component state.
 * `GoatView` swaps screens by changing one value, so navigating away unmounted
 * the surface and the session object went with it — while the interval its
 * clock had armed kept firing. The replay was neither finished nor stoppable:
 * still executing, still calling models, reachable from nothing.
 *
 * The obvious patch — calling `session.stop()` on unmount — is not a fix, it is
 * the same bug pointed the other way. Leaving a replay would silently kill it,
 * so navigating to check a GOAT would end the run. Ownership was the missing
 * thing, so that is what these tests check: a session registered with the
 * manager survives a detached view, is handed back intact when a view returns,
 * and releases its timer only when someone actually asks.
 *
 * The clock's timer is still injected here, the same seam the audit's
 * reproduction used. It is no longer how the replay is driven — the loop paces
 * itself, because an interval that fires every 250ms cannot wait for a GOAT that
 * is still deciding — so what these tests count is no longer armed handles. What
 * they assert instead is the property those handles were standing in for: a
 * running replay advances by itself, a view detaching changes nothing about that,
 * and execution stops when someone asks and only then.
 */

import type { IAgentModel } from '../../agents/model/types';
import { normalizeModelReply } from '../../agents/model/openrouter';
import type { Bar } from '../../../types/trading';
import {
  AD_HOC_BACKTEST_KEY,
  backtestKeyFor,
  createBacktestManager,
} from './manager';
import { BacktestSession } from './session';

const START_SECONDS = 1_767_225_600; // 2026-01-01T00:00:00Z

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function makeDataset(count = 400): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const drift = index < count / 2 ? 0 : (index - count / 2) * 0.0008;
    const base = 157.8 + drift + Math.sin(index / 9) * 0.0025;
    return {
      time: START_SECONDS + index * 60,
      open: base,
      high: base + 0.0006,
      low: base - 0.0006,
      close: base + 0.0002,
      volume: 1_000 + index,
    };
  });
}

/** A model that answers whatever it is asked, so a session can actually start. */
class SilentModel implements IAgentModel {
  async run(request: { contract?: string }) {
    if (request.contract === 'INVESTIGATION') {
      return normalizeModelReply(JSON.stringify({
        thought: 'Watching the range.', symbols: [], timeframes: [],
        investigationPlan: [], openQuestions: [], actionable: false,
      }));
    }
    return normalizeModelReply(JSON.stringify({
      kind: 'HOLD',
      thesisId: 'held',
      reason: 'nothing yet',
    }));
  }
}

/**
 * A clock whose timer can be counted and driven by hand.
 *
 * `setInterval` records the handle and hands back a callback; `tick()` fires it
 * on demand. This is what turns "is a timer still armed?" into a fact rather
 * than a wait, and it is why these tests need no sleeping.
 */
class CountingScheduler {
  handles = new Set<unknown>();
  ticks = 0;

  readonly scheduler = {
    setInterval: (handler: () => void): unknown => {
      const handle = { handler };
      this.handles.add(handle);
      return handle;
    },
    clearInterval: (handle: unknown): void => {
      this.handles.delete(handle);
    },
  };

  get armed(): number {
    return this.handles.size;
  }

  /** Fire every armed handle once, as the platform timer would. */
  fire(): void {
    for (const handle of this.handles) {
      this.ticks += 1;
      (handle as { handler: () => void }).handler();
    }
  }
}

interface Harness {
  session: BacktestSession;
  timers: CountingScheduler;
}

function makeSession(timers: CountingScheduler, market = 'USD/JPY'): BacktestSession {
  const bars = makeDataset();
  return new BacktestSession({
    goal: 'Trade a USD/JPY range while the higher timeframe stays neutral.',
    market,
    timeframe: '1m',
    timeframes: ['1m', '5m'],
    start: bars[Math.floor(bars.length / 3)].time * 1000,
    end: bars[bars.length - 1].time * 1000,
    bars,
    model: new SilentModel(),
    /*
     * 60x so a handful of steps moves a visible amount of simulated time. At 1x
     * one 250ms step is a quarter of a simulated minute, which `simulatedMinutes`
     * rounds away — progress assertions are then measuring rounding, not the
     * clock.
     */
    speed: 60,
    scheduler: timers.scheduler,
    costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
  });
}

/**
 * Whether a replay is driving its own market.
 *
   * The replacement for "an interval is armed". A session paces itself now, so
   * the question is not whether a handle exists but whether the simulated instant
   * moves without anything outside the session asking it to.
 */
function isDriving(session: BacktestSession): boolean {
  return session.snapshot().state === 'RUNNING';
}

/** Let the loop run until `condition` holds, or give up and return false. */
async function waitFor(condition: () => boolean, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

/** Wait until the replay has actually moved through historical time. */
async function advanced(session: BacktestSession, from: number): Promise<boolean> {
  return waitFor(() => session.simulatedClock.now() > from);
}

async function startHarness(market?: string): Promise<Harness> {
  const timers = new CountingScheduler();
  const session = makeSession(timers, market);
  await session.start();
  await session.play();
  return { session, timers };
}

// ---------------------------------------------------------------------------
// 1. Ownership survives the view going away
// ---------------------------------------------------------------------------

test('ownership: a started replay is registered and survives the view detaching', async () => {
  const manager = createBacktestManager();
  const key = 'goat-alpha';
  const { session } = await startHarness();

  manager.register(key, session);
  assert(isDriving(session), 'the replay is running on its own, with no view attached');

  // The surface unmounts here. It releases its listeners and nothing else.
  assert(manager.get(key) === session, 'the session is still reachable after the view detaches');
  assert(isDriving(session), 'the replay is still driving itself, because nobody asked it to stop');
  assertEqual(session.snapshot().state, 'RUNNING', 'the replay is still running');

  const before = session.simulatedClock.now();
  assert(await advanced(session, before), 'simulated time kept moving after detaching, with nothing firing it');
  assert(session.snapshot().simulatedMinutes > 0, 'and the snapshot reports the progress it made');
  assert(session.snapshot().trades !== undefined, 'the session kept its trade book');

  await manager.dispose(key);
});

test('ownership: a replay in progress is not disturbed by the view unmounting', async () => {
  const manager = createBacktestManager();
  const key = 'goat-alpha';
  const { session } = await startHarness();
  manager.register(key, session);
  await advanced(session, session.simulatedClock.now());
  const detachedSnapshot = session.snapshot();

  // Re-attaching is what navigation does, and it must observe, never disturb.
  let seen = 0;
  const unsubscribe = manager.subscribe(key, () => { seen += 1; });

  assert(manager.get(key) === session, 'the same session object comes back');
  assertEqual(session.snapshot().simulatedMinutes, detachedSnapshot.simulatedMinutes, 'no simulated time was lost');
  assertEqual(session.snapshot().now, detachedSnapshot.now, 'the simulated instant did not shift');
  assertEqual(session.snapshot().state, 'RUNNING', 'a detaching and returning viewer did not pause the run');
  assert(seen >= 1, 'the returning view was told what is running');

  unsubscribe();
  await manager.dispose(key);
});

// ---------------------------------------------------------------------------
// 2. No orphaned timer
// ---------------------------------------------------------------------------

test('orphan: a detached replay is still reachable, and releasing it stops the timer', async () => {
  const manager = createBacktestManager();
  const key = 'goat-orphan';
  const { session } = await startHarness();
  manager.register(key, session);

  assert(isDriving(session), 'the replay is driving itself while running');

  /*
   * The original defect in the shape the audit reproduced it: after the view is
   * gone the replay is still going, and the session is still RUNNING. The
   * difference from before is that the manager can now name it.
   */
  assert(manager.get(key) === session, 'the still-running session is reachable by key');
  assertEqual(session.snapshot().state, 'RUNNING', 'and still reported as running');

  const before = session.simulatedClock.now();
  assert(await advanced(session, before), 'and genuinely still advancing with no view attached');

  await manager.dispose(key, 'Disposed by the test.');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assertEqual(session.snapshot().state, 'STOPPED', 'the session ended, rather than being orphaned');
  const afterDispose = session.simulatedClock.now();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEqual(session.simulatedClock.now(), afterDispose, 'disposing stopped the market moving');
  assertEqual(manager.get(key), undefined, 'the manager no longer exposes it');
});

// ---------------------------------------------------------------------------
// 3. Explicit stop is a decision, not a side effect
// ---------------------------------------------------------------------------

test('stop: an explicit stop halts execution but keeps the report readable', async () => {
  const manager = createBacktestManager();
  const key = 'goat-stopped';
  const { session } = await startHarness();
  manager.register(key, session);

  await manager.stop(key, 'Stopped from the surface.');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert(!isDriving(session), 'stopping stopped the replay driving itself');
  assertEqual(session.snapshot().state, 'STOPPED', 'the replay stopped');
  assert(session.snapshot().report !== undefined, 'a stopped replay still has a report to read');
  assertEqual(manager.get(key), session, 'and it is still filed under its GOAT');

  await manager.dispose(key);
});

test('stop: disposing a stopped replay does not stop it twice', async () => {
  const manager = createBacktestManager();
  const key = 'goat-stopped';
  const { session } = await startHarness();
  manager.register(key, session);

  await manager.stop(key);
  await manager.dispose(key);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert(!isDriving(session), 'still stopped, with no second teardown to corrupt it');
  assertEqual(session.snapshot().state, 'STOPPED', 'and still stopped, not corrupted');
});

// ---------------------------------------------------------------------------
// 4. Two GOATs are two replays
// ---------------------------------------------------------------------------

test('isolation: two GOATs run independently and stopping one leaves the other running', async () => {
  const manager = createBacktestManager();
  const alpha = await startHarness('USD/JPY');
  const beta = await startHarness('EUR/USD');

  manager.register('goat-a', alpha.session);
  manager.register('goat-b', beta.session);

  assert(manager.get('goat-a') !== manager.get('goat-b'), 'each GOAT has its own session');
  assert(manager.keys().length === 2, 'both are filed');

  await advanced(alpha.session, alpha.session.simulatedClock.now());
  const alphaAtStop = alpha.session.simulatedClock.now();
  const betaBefore = beta.session.simulatedClock.now();

  await manager.stop('goat-a');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert(!isDriving(alpha.session), "stopping A stopped A driving itself");
  assertEqual(alpha.session.snapshot().state, 'STOPPED', 'A stopped');
  assertEqual(alpha.session.simulatedClock.now(), alphaAtStop, "and A's market stopped with it");
  assert(isDriving(beta.session), "B's replay is untouched");
  assertEqual(beta.session.snapshot().state, 'RUNNING', 'B is still running');

  assert(await advanced(beta.session, betaBefore), 'B keeps advancing on its own loop');

  await manager.dispose('goat-b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(!isDriving(alpha.session) && !isDriving(beta.session), 'both replays released');
});

test('isolation: replacing a replay for one GOAT stops the incumbent timer', async () => {
  const manager = createBacktestManager();
  const first = await startHarness('USD/JPY');
  manager.register('goat-a', first.session);
  assert(isDriving(first.session), 'the first replay is running');

  const second = await startHarness('USD/JPY');
  manager.register('goat-a', second.session);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert(!isDriving(first.session), 'the replaced replay did not keep running');
  assert(manager.get('goat-a') === second.session, 'the newer replay is the one filed');

  await manager.dispose('goat-a');
});

// ---------------------------------------------------------------------------
// 5. Keys
// ---------------------------------------------------------------------------

test('keys: a GOAT and an ad-hoc replay are filed separately', () => {
  assertEqual(backtestKeyFor('goat-1'), 'goat-1', 'a GOAT keys by its own id');
  assertEqual(backtestKeyFor(undefined), AD_HOC_BACKTEST_KEY, 'a replay with no GOAT gets the ad-hoc key');
  assert(backtestKeyFor('goat-1') !== backtestKeyFor('goat-2'), 'two GOATs never share a key');
});

// ---------------------------------------------------------------------------
// 6. What a late-arriving view sees
// ---------------------------------------------------------------------------

test('remount: a view mounting after the run started is handed the running replay', async () => {
  const manager = createBacktestManager();
  const key = 'goat-late';
  const { session } = await startHarness();
  manager.register(key, session);
  await advanced(session, session.simulatedClock.now());

  // The view comes back only now, well after the run began.
  let received: BacktestSession | undefined;
  const unsubscribe = manager.subscribe(key, (next) => { received = next; });

  assert(received === session, 'subscribing reports the running session immediately');
  assertEqual(received?.snapshot().state, 'RUNNING', 'and it is mid-run, not blank');
  assert(received!.snapshot().simulatedMinutes > 0, 'with its progress intact');

  unsubscribe();
  await manager.dispose(key);
});

async function runManagerTests(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`pass  ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL  ${name}`);
      console.log(`      ${message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) throw new Error(`${failures.length} backtest lifecycle test(s) failed.`);
}

if (import.meta.main) {
  await runManagerTests();
}
