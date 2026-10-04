/**
 * The GOAT detail surface.
 *
 * Two columns on a desktop, one narrative on a phone, and the two things a
 * person came for separated by an unmistakable distinction:
 *
 *   TRADE PLAN   what the GOAT is trying to prove, and what it would do
 *   AGENT LOG    what the GOAT is actually doing right now
 *
 * The plan does not repeat itself into the log and the log does not summarise
 * the plan. The log reports *changes*; the plan shows the current state.
 *
 * Liveness is the reason this component exists rather than a set of cards.
 * `activityFor` used to be read behind a poll whose signature ignored activity
 * entirely, so a GOAT could wake, record evidence and revise its thesis — all
 * real, all recorded — and the log would not move. It now subscribes to the
 * timeline directly, so an event appears the moment the runtime writes it, and
 * the poll remains only as the fallback for non-timeline state.
 *
 * Every value rendered here is read from a record. There is no simulated
 * activity anywhere in this file, and no indicator that moves unless the
 * runtime moved it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Loader2, Pause, Play, Rocket, Send, Trash2 } from 'lucide-react';

import type { GoatOrchestrator } from '../../engine/goat/orchestrator';
import type { AgentEventView } from '../../engine/goat/agentEvents';
import { buildPlanView } from '../../engine/goat/planView';
import type { GoatMission } from '../../engine/goat/mission';

import { AgentLog } from './AgentLog';
import { GoatStatusIndicator } from './GoatStatusIndicator';
import { TradePlanPanel } from './TradePlanPanel';
import { ConfirmDestructive } from './ConfirmDestructive';

/** How recently an event must have arrived for the log to read as live. */
const LIVE_WINDOW_MS = 6_000;

export interface GoatWorkspaceProps {
  orchestrator: GoatOrchestrator;
  mission: GoatMission;
  busy?: boolean;
  error?: string;
  onChanged: () => void;
  onDismissError?: () => void;
  onDeploy: () => void;
  onArchive?: () => void;
}

export const GoatWorkspace: React.FC<GoatWorkspaceProps> = ({
  orchestrator,
  mission,
  busy,
  error,
  onChanged,
  onDismissError,
  onDeploy,
  onArchive,
}) => {
  /*
   * The clock ticks once a second and only so that time-relative labels stay
   * honest — "32s ago" must not freeze while someone watches. It is not a
   * data poll: all state below comes from the orchestrator, and the only
   * thing this interval can change is a rendered age.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // A tick that only changes `now` must not re-read the whole log.
  const [entries, setEntries] = useState<AgentEventView[]>(() => orchestrator.agentLog(mission.goalId));
  useEffect(() => {
    setEntries(orchestrator.agentLog(mission.goalId));
  }, [orchestrator, mission.goalId]);

  /*
   * The push path. The runtime tells us when it recorded something for this
   * GOAT; we re-read and re-render. Batched through a microtask because a
   * single wake writes several events in a row and one render per event is
   * one render too many.
   */
  const pending = useRef(false);
  useEffect(() => {
    const flush = () => {
      if (pending.current) return;
      pending.current = true;
      queueMicrotask(() => {
        pending.current = false;
        setEntries(orchestrator.agentLog(mission.goalId));
      });
    };
    return orchestrator.observeActivity(mission.goalId, flush);
  }, [orchestrator, mission.goalId]);

  // Stop pulsing when nobody is looking. A hidden tab is not an audience.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const plan = useMemo(() => buildPlanView(mission), [mission]);

  /*
   * Whether the runtime has a model request outstanding, re-read on the same
   * push path as the log. The workspace does not infer it from the age of the
   * last event: the orchestrator knows, and a surface that guessed would
   * eventually report a stuck agent as busy.
   */
  const waitingForModel = Boolean(orchestrator.pendingModelRequest(mission.agentId));

  const newestAt = entries.length > 0 ? entries[entries.length - 1].at : 0;
  const live = pageVisible && newestAt > 0 && now - newestAt < LIVE_WINDOW_MS;
  const watching =
    mission.activeTrackerCount > 0 &&
    (mission.runtime === 'RUNNING' || mission.runtime === 'PAUSED');

  /*
   * Deleting needs confirmation on this surface, not just on the card.
   *
   * It previously did not: one tap in the GOAT's own workspace stopped it and
   * removed it, with no undo anywhere in the system. `archiveGoat` does keep
   * the thesis and evidence, so the dialog says exactly that rather than
   * implying either a clean sweep or a total loss.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteGoat = useCallback(async () => {
    if (!onArchive) return;
    setDeleting(true);
    try {
      onArchive();
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [onArchive]);

  const [steeringOpen, setSteeringOpen] = useState(false);
  const [steeringText, setSteeringText] = useState('');
  const [steeringBusy, setSteeringBusy] = useState(false);

  const sendSteering = useCallback(async () => {
    const instruction = steeringText.trim();
    if (!instruction) return;
    setSteeringBusy(true);
    try {
      await orchestrator.steerGoat(mission.goalId, instruction);
      setSteeringText('');
      setSteeringOpen(false);
      onChanged();
    } finally {
      setSteeringBusy(false);
    }
  }, [orchestrator, mission.goalId, steeringText, onChanged]);

  return (
    <div className="space-y-4">
      <GoatHeader
        mission={mission}
        now={now}
        live={pageVisible}
        steeringPending={mission.steering.pending}
        busy={Boolean(busy)}
        onSteer={() => setSteeringOpen((open) => !open)}
        onStop={() => void orchestrator.stopGoat(mission.goalId).then(onChanged)}
        onPlay={() => void orchestrator.resumeGoat(mission.goalId).then(onChanged)}
        onDeploy={onDeploy}
        onArchive={onArchive ? () => setConfirmDelete(true) : undefined}
      />

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-2xl border border-neg/40 bg-neg/[0.06] px-4 py-3"
        >
          <p className="text-[11px] leading-relaxed text-neg">{error}</p>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="shrink-0 font-mono text-[10px] text-neg/70 hover:text-neg"
            >
              dismiss
            </button>
          )}
        </div>
      )}

      {/*
       * Plan and log side by side where there is room, stacked where there is
       * not. The plan keeps its own column because it is the thing a reader
       * refers back to; the log takes the rest because it is the thing watched.
       */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4 lg:sticky lg:top-4">
          <TradePlanPanel plan={plan} />
          {steeringOpen && (
            <SteerComposer
              value={steeringText}
              busy={steeringBusy || Boolean(busy)}
              onChange={setSteeringText}
              onCancel={() => setSteeringOpen(false)}
              onSend={() => void sendSteering()}
            />
          )}
        </div>

        <AgentLog
          entries={entries}
          live={live}
          watching={watching}
          waitingForModel={waitingForModel}
          now={now}
          className="h-[26rem] lg:h-[calc(100dvh-15rem)] lg:min-h-[30rem]"
        />
      </div>

      {onArchive && (
        <ConfirmDestructive
          open={confirmDelete}
          busy={deleting}
          title={`Delete "${mission.name || 'this GOAT'}"?`}
          body="It will stop, and it will be removed from your list. This cannot be undone."
          keptNote="Its theses, evidence and trade plans are kept on record, because what the GOAT worked out is part of the record."
          confirmLabel="Delete GOAT"
          onConfirm={() => void deleteGoat()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface GoatHeaderProps {
  mission: GoatMission;
  now: number;
  live: boolean;
  steeringPending: number;
  busy: boolean;
  onSteer: () => void;
  onStop: () => void;
  onPlay: () => void;
  onDeploy: () => void;
  onArchive?: () => void;
}

/**
 * Everything about the current state, readable in one glance.
 *
 * This is what someone sees after being away for an hour, so it carries the
 * market, the belief, the status and the next thing — in that order, because
 * that is the order the questions arrive in.
 */
const GoatHeader: React.FC<GoatHeaderProps> = ({
  mission, now, live, steeringPending, busy, onSteer, onStop, onPlay, onDeploy, onArchive,
}) => {
  const stopped = mission.runtime === 'STOPPED' || mission.runtime === 'PAUSED';
  return (
  <header className="rounded-2xl border border-line bg-surface px-5 py-4">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <GoatStatusIndicator mission={mission} now={now} live={live} />
      {/*
        The three controls that exist: stop, play, steer. Which of stop/play
        is offered is decided by the runtime's own state rather than by a
        remembered flag, so the button can never disagree with the status dot
        directly above it.
      */}
      <div className="flex flex-wrap items-center gap-1.5">
        {mission.runtime === 'RUNNING' ? (
          <ControlButton onClick={onStop} disabled={busy} icon={<Pause className="h-3 w-3" />}>
            Stop
          </ControlButton>
        ) : mission.deployment ? (
          <ControlButton onClick={onPlay} disabled={busy} icon={<Play className="h-3 w-3" />}>
            Play
          </ControlButton>
        ) : (
          <ControlButton onClick={onDeploy} disabled={busy} primary icon={<Rocket className="h-3 w-3" />}>
            Deploy
          </ControlButton>
        )}
        <ControlButton onClick={onSteer} icon={<Compass className="h-3 w-3" />}>
          Steer
        </ControlButton>
        {onArchive && (
          <ControlButton onClick={onArchive} icon={<Trash2 className="h-3 w-3" />} label="Delete" />
        )}
      </div>
    </div>

    <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {mission.market && <span className="font-mono text-[15px] text-ink">{mission.market}</span>}
      {mission.thesis?.direction && (
        <span className="font-mono text-[10px] tracking-[0.12em] text-ink-3">
          {mission.thesis.direction}
        </span>
      )}
      {mission.mode && (
        <span className="font-mono text-[10px] tracking-[0.12em] text-ink-4">{mission.mode}</span>
      )}
    </div>

    {/*
     * The next action, and the reason it is trustworthy: it is the same line
     * the runtime derives, including the cases where nothing is coming.
     */}
    <div className="mt-3 border-t border-line/60 pt-3">
      {/*
        A stopped GOAT is not a paused one.

        "Paused" implies time held still for the agent, and it did not: the
        market moved, candles closed and the funding rate changed. So the
        stopped state says so, says when it was last alive, and says what
        PLAY will do — because the most useful thing to know before restarting
        is that it will re-read the world rather than pick up where it left off.
      */}
      {stopped ? (
        <>
          <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">NEXT</p>
          <p className="mt-1 text-[12px] leading-5 text-ink-2" data-testid="goat-stopped-note">
            Not monitoring the market.
          </p>
          {mission.lastActivity && (
            <p className="mt-1 font-mono text-[10.5px] text-ink-4">
              Last active {formatRelative(mission.lastActivity.at, now)}
            </p>
          )}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-4" data-testid="goat-restart-note">
            On PLAY it rebuilds its market context and reassesses its thesis
            before it watches anything again.
          </p>
        </>
      ) : (
        <>
          <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">NEXT</p>
          <p
            className={`mt-1 text-[12px] leading-5 ${mission.next.blocked ? 'text-ink-3' : 'text-ink-2'}`}
            data-testid="goat-next"
            data-blocked={mission.next.blocked}
          >
            {mission.next.waitFor ? `${mission.next.label} — ${mission.next.waitFor}` : mission.next.label}
          </p>
        </>
      )}
      {steeringPending > 0 && (
        <p className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[10px] text-accent-ink">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Reading {steeringPending} instruction{steeringPending === 1 ? '' : 's'} you gave it
        </p>
      )}
    </div>
  </header>
  );
};

/** "4m ago", because that is the question, and a timestamp is not. */
function formatRelative(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${Math.max(seconds, 1)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface ControlButtonProps {
  onClick: () => void;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  /** Icon-only, with the name available to assistive tech. */
  label?: string;
}

const ControlButton: React.FC<ControlButtonProps> = ({
  onClick, children, icon, disabled, primary, label,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] transition-colors disabled:opacity-40 ${
      primary
        ? 'border-accent/40 bg-accent-soft/40 text-accent-ink'
        : 'border-line text-ink-3 hover:border-accent/40 hover:text-ink-2'
    }`}
  >
    {icon}
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

interface SteerComposerProps {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSend: () => void;
}

/**
 * Steering: the human half of the loop.
 *
 * Kept small and inline, because it is a correction rather than a workspace.
 * The copy says plainly what a steering note can and cannot do, since "tell
 * your trading agent what to do" invites exactly the wrong expectation.
 */
const SteerComposer: React.FC<SteerComposerProps> = ({ value, busy, onChange, onCancel, onSend }) => (
  <section
    className="rounded-2xl border border-accent/30 bg-accent-soft/30 px-5 py-4"
    aria-label="Steer your GOAT"
  >
    <label
      htmlFor="goat-steer"
      className="block font-mono text-[10px] tracking-[0.16em] text-accent-ink"
    >
      TELL THE GOAT WHAT TO RECONSIDER
    </label>
    <textarea
      id="goat-steer"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      rows={3}
      placeholder="Re-evaluate the breakout confirmation"
      className="mt-2 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-accent/50"
    />
    <p className="mt-2 text-[10px] leading-relaxed text-ink-4">
      Guidance for its next thinking step. It does not change the goal you
      gave it, and it cannot make it trade.
    </p>
    <div className="mt-3 flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg px-3 py-1.5 font-mono text-[10px] text-ink-4 transition-colors hover:text-ink-2"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSend}
        disabled={!value.trim() || busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-mono text-[10px] text-accent-contrast transition-opacity disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Send className="h-3 w-3" aria-hidden="true" />}
        Send
      </button>
    </div>
  </section>
);