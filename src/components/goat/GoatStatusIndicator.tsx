/**
 * The GOAT status indicator.
 *
 * One dot, and it is the primary signal in the product. Which means it has to
 * be *true* before it is beautiful: the dot reflects what the runtime is
 * doing, not that a deployment record exists.
 *
 * The states, and what each one is claiming:
 *
 *   ANALYZING  a real reasoning step is running right now      fast pulse
 *   ACTIVE     deployed, and something happened recently       slow pulse
 *   WATCHING   deployed, waiting for a meaningful event         dim pulse
 *   STALLED    deployed and running, but its last step failed   dim amber
 *   STOPPED    the operator stopped it                          static
 *   UNDEPLOYED saved, not pointed at a market                    static
 *   ERROR      the runtime is not running it                    static, red
 *
 * The distinction that matters most is WATCHING versus ERROR. A GOAT that is
 * waiting has done its job and is now idle; a GOAT that is broken has stopped
 * doing anything at all. They look identical if you render "idle" for both,
 * and a trading agent spends most of its life idle — so the difference
 * between "waiting" and "broken" is the difference between the product
 * feeling intelligent and feeling abandoned.
 *
 * Motion is CSS only, and only ever present while the state is live.
 */

import type { GoatMission } from '../../engine/goat/mission';

export type GoatStatus =
  | 'ANALYZING'
  | 'ACTIVE'
  | 'WATCHING'
  | 'STALLED'
  | 'STOPPED'
  | 'UNDEPLOYED'
  | 'ERROR';

/** How long after the last real event a GOAT still counts as recently active. */
const ACTIVE_WINDOW_MS = 45_000;

/**
 * Derive the status from real state.
 *
 * Ordered by how much can be wrong. A stopped runtime is stopped whatever the
 * thesis says; an error is an error whatever the trackers say. Only once
 * neither of those is true does it become a question of what the GOAT is
 * currently doing.
 */
export function statusFor(mission: GoatMission, now: number): GoatStatus {
  if (!mission.deployment) return 'UNDEPLOYED';
  if (mission.runtime === 'ERROR') return 'ERROR';
  if (mission.runtime === 'STOPPED' || mission.runtime === 'PAUSED') return 'STOPPED';

  // Only a real, running deployment can be doing anything at all.
  if (mission.runtime !== 'RUNNING') return 'STOPPED';

  /*
   * A wake in flight. `lastWakeAt` is the timestamp of the tracker event the
   * runtime actually recorded, so this cannot be true unless something
   * genuinely fired.
   */
  if (mission.lastWakeAt !== undefined && now - mission.lastWakeAt < 8_000) {
    return mission.stage === 'RE_EVALUATING' ? 'ANALYZING' : 'ACTIVE';
  }
  if (mission.stage === 'RE_EVALUATING' || mission.stage === 'RISK_CHECK' || mission.stage === 'EXECUTING') {
    return 'ANALYZING';
  }

  /*
   * Its last recorded step failed.
   *
   * Checked before "recently active" on purpose. The runtime did do
   * something a moment ago, so an earlier version of this returned ACTIVE —
   * a green, pulsing dot immediately after a recorded model failure. The dot
   * is the primary signal in the product; a green one here would say
   * everything is fine at the moment it is least fine.
   *
   * Time-bounded, so a failure from this morning does not amber the dot
   * forever once something has clearly moved on.
   */
  if (mission.lastFailure && now - mission.lastFailure.at < STALE_MS) {
    return 'STALLED';
  }

  // Deployed and working: recently did something, or is holding a thesis.
  const recentlyActive =
    mission.lastWakeAt !== undefined && now - mission.lastWakeAt < ACTIVE_WINDOW_MS;
  if (recentlyActive) return 'ACTIVE';
  if (mission.activeTrackerCount > 0) return 'WATCHING';
  if (mission.updatedAt !== undefined && now - mission.updatedAt < ACTIVE_WINDOW_MS) return 'ACTIVE';

  return 'WATCHING';
}

const LABELS: Record<GoatStatus, string> = {
  ANALYZING: 'ANALYZING',
  ACTIVE: 'ACTIVE',
  WATCHING: 'WATCHING',
  STALLED: 'STALLED',
  STOPPED: 'STOPPED',
  UNDEPLOYED: 'NOT DEPLOYED',
  ERROR: 'ERROR',
};

/**
 * How long a failure keeps claiming attention before it is just history.
 *
 * The failure itself is resolved by the mission, which knows the whole recent
 * record rather than only its last line: a failed step is normally followed
 * by a `GOAT_WAITING` line, so the newest record is the sleep, not the
 * failure. Checking only the newest record reported a failed GOAT as healthy
 * — found by deploying a real one and watching the dot.
 */
const STALE_MS = 10 * 60_000;

/** What each state means, for anyone who asks. Shown as a title, not as text. */
const EXPLANATIONS: Record<GoatStatus, string> = {
  ANALYZING: 'A real reasoning step is running right now.',
  ACTIVE: 'Deployed, and something happened recently.',
  WATCHING: 'Deployed and waiting for a condition to fire. Nothing to do is not a fault.',
  STALLED: 'Running, but its last recorded step failed. Check the agent log for what failed.',
  STOPPED: 'Stopped. Nothing is being watched.',
  UNDEPLOYED: 'Saved, but not pointed at a market yet.',
  ERROR: 'The runtime is not running this GOAT.',
};

/** The semantic colour class for the dot. Neutral unless there is a signal. */
function dotClass(status: GoatStatus, live: boolean): string {
  const base = 'h-2 w-2 rounded-full shrink-0';
  switch (status) {
    case 'ANALYZING':
      return `${base} bg-accent ${live ? 'animate-goat-pulse-fast' : ''}`;
    case 'ACTIVE':
      return `${base} bg-pos ${live ? 'animate-goat-pulse' : ''}`;
    case 'WATCHING':
      return `${base} bg-pos/45 ${live ? 'animate-goat-pulse-dim' : ''}`;
    case 'STALLED':
      // Amber, not red: the runtime is healthy and the deployment is fine,
      // something upstream failed. Red would be a lie in the other
      // direction — it would send someone looking for a deployment problem.
      return `${base} bg-warn ${live ? 'animate-goat-pulse-dim' : ''}`;
    case 'ERROR':
      return `${base} bg-neg`;
    case 'STOPPED':
      return `${base} bg-ink-4`;
    case 'UNDEPLOYED':
    default:
      return `${base} border border-ink-4/60 bg-transparent`;
  }
}

export interface GoatStatusIndicatorProps {
  mission: GoatMission;
  /** Injected so the indicator is deterministic under test. */
  now: number;
  /** False when the document is hidden: no pulse for something nobody is watching. */
  live?: boolean;
  /** Render the word beside the dot. Off for the tightest headers. */
  withLabel?: boolean;
  className?: string;
}

export const GoatStatusIndicator: React.FC<GoatStatusIndicatorProps> = ({
  mission,
  now,
  live = true,
  withLabel = true,
  className = '',
}) => {
  const status = statusFor(mission, now);
  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      title={EXPLANATIONS[status]}
      data-status={status}
      data-testid="goat-status"
    >
      <span className={dotClass(status, live)} aria-hidden="true" />
      {withLabel && (
        <span className="font-mono text-[10px] tracking-[0.14em] text-ink-2">
          {LABELS[status]}
        </span>
      )}
      <span className="sr-only">{EXPLANATIONS[status]}</span>
    </span>
  );
};

export const STATUS_LABEL: Record<GoatStatus, string> = LABELS;