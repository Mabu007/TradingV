/**
 * The simulation clock.
 *
 * A backtest's "now" is a historical instant, and everything in the system
 * reads it through this object rather than through `Date.now()`. That is the
 * whole reason a GOAT can be run against a market that already happened: the
 * agent is handed a clock, the clock says 15 Jan 2026 10:43, and the agent
 * reasons about that instant as though it were the present.
 *
 * Three properties are load-bearing:
 *
 *   1. **It is not wall-clock time.** Nothing here reads the system clock to
 *      decide what time it is in the simulation. `now()` is derived from the
 *      dataset's start plus everything that has been advanced, so a replay is
 *      reproducible: same dataset and same step sequence, same timestamps,
 *      regardless of how fast the machine running it happens to be.
 *
 *   2. **Speed is a ratio, not a delay.** `speed` is how many simulated
 *      milliseconds pass per real millisecond. At 1x the simulation runs at
 *      the speed of the wall clock; at 60x one historical minute passes per
 *      real second. There is no per-tick sleep anywhere in the runtime — the
 *      clock jumps forward by a step, and everything downstream is told the
 *      new time — so a fast replay costs arithmetic rather than waiting.
 *
 *   3. **It can be advanced without a timer.** `advanceBy` is the whole
 *      mechanism the timer drives, exposed so a test can replay a day in
 *      microseconds and get exactly the same sequence of instants.
 *
 * Deliberately not a wall-clock substitute for the rest of the application.
 * Live GOATs keep using the real clock; only the orchestrator constructed for
 * a simulation is given this one.
 */

export type SimulationSpeed = 1 | 2 | 5 | 10 | 20 | 30 | 60;

/**
 * The speeds offered.
 *
 * A geometric-ish ladder rather than an arbitrary one: each step is roughly
 * twice the legibility of the last, and 60x is the point at which one
 * historical minute passes per real second. Nothing below 1x — watching a
 * replay slower than real time would be theatre.
 */
export const SIMULATION_SPEEDS: readonly SimulationSpeed[] = [1, 2, 5, 10, 20, 30, 60];

/** The speed a simulation starts at when the caller does not choose. */
export const DEFAULT_SIMULATION_SPEED: SimulationSpeed = 10;

/**
 * One simulated frame, in real milliseconds.
 *
 * 250ms is fast enough to feel like a market moving and slow enough that the
 * browser has a frame in which to render one. The step is in *real* time; how
 * far the market moves in it is the speed's business.
 */
export const SIMULATION_STEP_MS = 250;

export function isSimulationSpeed(value: unknown): value is SimulationSpeed {
  return typeof value === 'number' && (SIMULATION_SPEEDS as readonly number[]).includes(value);
}

export interface SimulationClockOptions {
  /** Historical instant the simulation starts at, in epoch ms. */
  start: number;
  speed?: SimulationSpeed;
  /**
   * Injectable timers.
   *
   * The clock is the one place in this feature where a real timer would make a
   * test slow and flaky, so the scheduler is a dependency rather than a global.
   * Omitted, it uses the platform's.
   */
  scheduler?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export class SimulationClock {
  /** The historical instant this simulation starts at. */
  private readonly startAt: number;
  private readonly scheduler: NonNullable<SimulationClockOptions['scheduler']>;
  private simulatedElapsed = 0;
  private currentSpeed: SimulationSpeed;
  private handle: unknown;
  /** The tick callback the running interval was armed with, kept for a speed change. */
  private lastListener?: (now: number) => void;
  private readonly listeners = new Set<(now: number) => void>();

  constructor(options: SimulationClockOptions) {
    this.startAt = options.start;
    this.currentSpeed = options.speed ?? DEFAULT_SIMULATION_SPEED;
    this.scheduler = options.scheduler ?? {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  /** The simulated instant, in epoch ms. Never derived from the wall clock. */
  now(): number {
    return this.startAt + this.simulatedElapsed;
  }

  get speed(): SimulationSpeed {
    return this.currentSpeed;
  }

  /** Human label for the clock UI: "60x" means 60 simulated seconds per real second. */
  get speedLabel(): string {
    return `${this.currentSpeed}x`;
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** Simulated milliseconds elapsed since the dataset's first bar. */
  get elapsed(): number {
    return this.simulatedElapsed;
  }

  /**
   * Change the ratio.
   *
   * Applied to the interval that is already running rather than by restarting
   * it, so changing speed mid-replay cannot drop a step or move the clock
   * backwards. The one thing that does not survive a change is the interval's
   * own cadence, which is why it is re-armed — an armed interval keeps its
   * original period for the rest of its life.
   */
  setSpeed(speed: SimulationSpeed): void {
    if (speed === this.currentSpeed) return;
    const wasRunning = this.handle !== undefined;
    this.currentSpeed = speed;
    /*
     * An armed interval keeps the period it was created with, so a speed change
     * mid-replay has to re-arm it. The clock is only re-armed, never moved:
     * `startAt` and the accumulated elapsed are untouched, so the instant the
     * simulation was at does not shift by the time the new interval first fires.
     */
    if (wasRunning) {
      const listener = this.lastListener;
      this.stop();
      this.start(SIMULATION_STEP_MS, listener);
    }
  }

  /**
   * Move the simulation forward by a real interval.
   *
   * The step is converted once, here: `stepMs * speed` simulated milliseconds
   * per tick. Nothing else in the system multiplies by the speed, so there is
   * exactly one place where "how fast is this replay" is decided.
   */
  advanceBy(realMs: number): number {
    if (!Number.isFinite(realMs) || realMs <= 0) return this.now();
    this.simulatedElapsed += Math.round(realMs * this.currentSpeed);
    const at = this.now();
    for (const listener of this.listeners) {
      try {
        listener(at);
      } catch {
        // One listener's failure must not stop the clock.
      }
    }
    return at;
  }

  /** Move the simulation to an exact historical instant, forwards only. */
  advanceTo(instant: number): number {
    const target = Math.max(this.now(), Math.round(instant));
    this.simulatedElapsed = target - this.startAt;
    const at = this.now();
    for (const listener of this.listeners) {
      try {
        listener(at);
      } catch {
        /* see above */
      }
    }
    return at;
  }

  /**
   * Start driving the clock from a real timer.
   *
   * `onTick` receives the new simulated instant after every step. Listeners
   * registered with `subscribe` receive the same notification, and are called
   * first — the clock's own subscribers are the replay machinery, and the
   * caller's callback is the surface above it.
   */
  start(stepMs: number, onTick?: (now: number) => void): void {
    if (this.handle !== undefined) return;
    this.lastListener = onTick;
    this.handle = this.scheduler.setInterval(() => {
      const at = this.advanceBy(stepMs);
      onTick?.(at);
    }, stepMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = undefined;
  }

  /** Observe every step. Returns an unsubscribe function. */
  subscribe(listener: (now: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** "15 Jan 2026 10:43", the date a reader needs to know where they are. */
export function formatSimulatedDate(instant: number): string {
  const date = new Date(instant);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** "10:43:21", the clock the simulation is actually at. */
export function formatSimulatedTime(instant: number): string {
  const date = new Date(instant);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}