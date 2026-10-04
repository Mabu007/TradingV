/**
 * Watcher health.
 *
 * The distinction this exists for: a watcher whose process is alive and a
 * watcher that is actually working are different states. A Durable Object
 * that is receiving no market data is not healthy, it is starved, and
 * reporting that as healthy is how a bot silently stops without anyone
 * noticing until a position moves against them.
 *
 * So health is derived from timestamps, never from "the object exists".
 * An object that has just woken from hibernation legitimately has no
 * history yet, which is why STARTING is distinct from STARVED: the first
 * is a few seconds old, the second has been running and receiving
 * nothing.
 */

export type HealthState =
  /** Never evaluated, and not old enough to be a problem. */
  | 'STARTING'
  /** Running, evaluating, and receiving data. */
  | 'HEALTHY'
  /** Alive but no market data has arrived. */
  | 'STARVED'
  /** Alive but evaluations keep failing. */
  | 'DEGRADED'
  /** A recorded error is outstanding. */
  | 'ERROR'
  /** Deliberately not running. */
  | 'STOPPED';

export interface HealthTimestamps {
  /** Last time the object did anything at all. Proves liveness only. */
  lastHeartbeatAt: number | null;
  /** Last time a market event was accepted. */
  lastMarketDataAt: number | null;
  /** Last time a condition evaluation ran, successful or not. */
  lastEvaluationAt: number | null;
  /** Last time an evaluation produced a definite state. */
  lastSuccessfulEvaluationAt: number | null;
  /** Last time a wake was emitted. */
  lastWakeAt: number | null;
  /** Last time the configuration changed. */
  lastConfigChangeAt: number | null;
}

export interface HealthInput extends HealthTimestamps {
  status: string;
  /** When the configuration last changed, for display. */
  lastConfigChangeAt: number | null;
  lastError?: { message: string; category?: string; at: number } | null;
  /** Consecutive evaluation failures. Reset by any success. */
  consecutiveEvaluationFailures: number;
}

export interface HealthThresholds {
  /** No market data for this long is STARVED. */
  marketDataStaleMs: number;
  /** No evaluation for this long is a problem. */
  evaluationStaleMs: number;
  /** This many consecutive failures is DEGRADED. */
  degradedAfterFailures: number;
  /** How long STARTING lasts before it becomes suspicious. */
  graceMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  marketDataStaleMs: 60_000,
  evaluationStaleMs: 120_000,
  degradedAfterFailures: 3,
  graceMs: 15_000,
};

export interface HealthReport {
  state: HealthState;
  /** True only for HEALTHY. A caller must not treat "not unhealthy" as healthy. */
  healthy: boolean;
  /** Human-readable explanation, safe to show a user. */
  summary: string;
  /** Ages in milliseconds, for a UI that renders "2.4s ago". */
  age: {
    heartbeat: number | null;
    marketData: number | null;
    evaluation: number | null;
    wake: number | null;
  };
  lastError?: { message: string; category?: string; at: number };
  thresholds: HealthThresholds;
}

/**
 * Classify a watcher.
 *
 * Order matters. ERROR outranks everything because an outstanding error
 * is the most actionable fact, and a STOPPED watcher is not "unhealthy",
 * it is off. STARTING is checked before STARVED so a freshly created
 * watcher does not immediately report a problem it cannot have caused.
 */
export function assessHealth(input: HealthInput, nowMs: number, thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthReport {
  const age = {
    heartbeat: ageOf(input.lastHeartbeatAt, nowMs),
    marketData: ageOf(input.lastMarketDataAt, nowMs),
    evaluation: ageOf(input.lastEvaluationAt, nowMs),
    wake: ageOf(input.lastWakeAt, nowMs),
  };

  const base = { age, thresholds, ...(input.lastError ? { lastError: input.lastError } : {}) };

  if (input.status === 'STOPPED' || input.status === 'CREATED' || input.status === 'STOPPING') {
    return {
      ...base,
      state: 'STOPPED',
      healthy: false,
      summary: input.status === 'STOPPED' ? 'The watcher is stopped.' : `The watcher is ${input.status.toLowerCase()}.`,
    };
  }

  if (input.status === 'PAUSED') {
    return { ...base, state: 'STOPPED', healthy: false, summary: 'The watcher is paused.' };
  }

  if (input.lastError) {
    return {
      ...base,
      state: 'ERROR',
      healthy: false,
      summary: `Last error ${describeAge(ageOf(input.lastError.at, nowMs))} ago: ${input.lastError.message}`,
    };
  }

  const sinceStart = nowMs - (input.lastHeartbeatAt ?? nowMs);
  if (input.lastHeartbeatAt === null || sinceStart < thresholds.graceMs) {
    return { ...base, state: 'STARTING', healthy: false, summary: 'The watcher is starting.' };
  }

  if (input.consecutiveEvaluationFailures >= thresholds.degradedAfterFailures) {
    return {
      ...base,
      state: 'DEGRADED',
      healthy: false,
      summary: `${input.consecutiveEvaluationFailures} evaluations have failed in a row.`,
    };
  }

  if (input.lastMarketDataAt === null || age.marketData! > thresholds.marketDataStaleMs) {
    return {
      ...base,
      state: 'STARVED',
      healthy: false,
      summary:
        input.lastMarketDataAt === null
          ? 'The watcher has never received market data.'
          : `No market data for ${describeAge(age.marketData)}.`,
    };
  }

  if (input.lastEvaluationAt === null || age.evaluation! > thresholds.evaluationStaleMs) {
    return {
      ...base,
      state: 'DEGRADED',
      healthy: false,
      summary: input.lastEvaluationAt === null ? 'The watcher has not evaluated anything yet.' : `No evaluation for ${describeAge(age.evaluation)}.`,
    };
  }

  return {
    ...base,
    state: 'HEALTHY',
    healthy: true,
    summary: `Watching ${describeAge(age.marketData)} of data, evaluated ${describeAge(age.evaluation)} ago.`,
  };
}

function ageOf(timestamp: number | null, nowMs: number): number | null {
  if (timestamp === null) return null;
  // A clock that moved backwards must not produce a negative age, which
  // would render as "-3s ago" and compare as fresh forever.
  return Math.max(0, nowMs - timestamp);
}

/** "2.4s ago", "4m ago". Kept short because it goes in a status line. */
export function describeAge(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** The state string the UI shows, so the backend vocabulary is not invented twice. */
export const HEALTH_LABELS: Record<HealthState, string> = {
  STARTING: 'Starting',
  HEALTHY: 'Running',
  STARVED: 'No market data',
  DEGRADED: 'Running, but not evaluating',
  ERROR: 'Error',
  STOPPED: 'Stopped',
};
