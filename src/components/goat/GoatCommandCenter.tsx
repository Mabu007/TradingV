import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleDot,
  Gauge,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Radio,
  ScrollText,
  Send,
  Target,
  Trash2,
  X,
} from 'lucide-react';

import type { GoatOrchestrator } from '../../engine/goat/orchestrator';
import type { GoatMission } from '../../engine/goat/mission';
import type { TradeIdea, Tracker } from '../../engine/goat/types';
import { WorkPlan } from './WorkPlan';

/**
 * The GOAT command centre.
 *
 * One screen, in the order the product actually works, so the hierarchy
 * itself teaches it: what it is doing, what it intends, what it believes,
 * what it is watching, what it has produced.
 *
 *   CURRENT ACTIVITY → WORK PLAN → THESIS → TRACKERS → TRADE PLAN → HISTORY
 *
 * Two rules this screen is built around:
 *
 *   Every value shown is read from a record the runtime wrote. There is no
 *   simulated activity, no animated progress and no placeholder that
 *   "represents" a state the system is not actually in.
 *
 *   The controls are the three that exist: stop, play, and steer. Stop
 *   preserves everything and retires the deployment; play restores the same
 *   deployment and its observation plan rather than starting a new one; and
 *   steer sends the GOAT a note that the next reasoning step reads, without
 *   rewriting what it was asked to do.
 */

export interface GoatCommandCenterProps {
  orchestrator: GoatOrchestrator;
  mission: GoatMission;
  trackers: Tracker[];
  busy?: boolean;
  /**
   * An error raised outside this card — deploying, resuming, archiving.
   * It is rendered here rather than beside this card, because a GOAT has one
   * place to look for trouble and two copies of the same sentence reads as
   * two separate problems.
   */
  error?: string;
  onChanged: () => void;
  onDeploy: () => void;
  onArchive?: () => void;
  onDismissError?: () => void;
}

export const GoatCommandCenter: React.FC<GoatCommandCenterProps> = ({
  orchestrator,
  mission,
  trackers,
  busy,
  onChanged,
  onDeploy,
  onArchive,
  error: externalError,
  onDismissError,
}) => {
  const [steeringOpen, setSteeringOpen] = useState(false);
  const [steeringText, setSteeringText] = useState('');
  const [steeringBusy, setSteeringBusy] = useState(false);

  /*
   * The activity feed, newest first.
   *
   * A projection of the durable timeline, read on every render rather than
   * held in a second piece of state that could disagree with the records it
   * claims to show. Reading it costs nothing: the store already has the
   * events in memory and this is a filter.
   */
  const activity = orchestrator.activityFor(mission.goalId, 12).slice().reverse();
  const [controlError, setError] = useState<string | undefined>();
  const error = controlError ?? externalError;

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const sendSteering = async () => {
    const text = steeringText.trim();
    if (!text) return;
    setSteeringBusy(true);
    await run(async () => {
      await orchestrator.steerGoat(mission.goalId, text);
      setSteeringText('');
      setSteeringOpen(false);
    });
    setSteeringBusy(false);
  };

  const stop = () => run(() => orchestrator.stopGoat(mission.goalId));
  const play = () => run(() => orchestrator.resumeGoat(mission.goalId));

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- identity */}
      <header className="rounded-2xl border border-line bg-surface px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-ink">{mission.name}</h1>
            {mission.description && (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{mission.description}</p>
            )}
            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[10px] text-ink-3">
              <Fact label="Market" value={mission.market ?? 'not deployed'} />
              <Fact label="Mode" value={mission.mode ?? '—'} />
              <Fact label="Environment" value={mission.environment ?? '—'} />
              <Fact
                label="Runtime"
                value={mission.runtime}
                tone={mission.runtime === 'ERROR' ? 'neg' : mission.runtime === 'RUNNING' ? 'pos' : undefined}
              />
              <Fact
                label="May execute"
                value={mission.deployment ? (mission.mayExecute ? 'yes' : 'no') : '—'}
              />
            </dl>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {mission.runtime === 'RUNNING' ? (
              <ActionButton onClick={() => void stop()} disabled={busy} icon={<Pause className="h-3.5 w-3.5" />}>
                Stop
              </ActionButton>
            ) : mission.deployment ? (
              <ActionButton onClick={() => void play()} disabled={busy} icon={<Play className="h-3.5 w-3.5" />}>
                Play
              </ActionButton>
            ) : (
              <ActionButton primary onClick={onDeploy} icon={<Radio className="h-3.5 w-3.5" />}>
                Deploy
              </ActionButton>
            )}

            <ActionButton
              onClick={() => setSteeringOpen(true)}
              disabled={busy}
              icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
            >
              Steer
            </ActionButton>

            {onArchive && (
              <ActionButton
                onClick={onArchive}
                disabled={busy}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                Delete
              </ActionButton>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={() => {
                setError(undefined);
                onDismissError?.();
              }}
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </header>

      {/* ------------------------------------------------------- current activity */}
      <section className="rounded-2xl border border-accent/30 bg-accent-soft/40 px-5 py-4">
        <Eyebrow icon={CircleDot} label="Currently working on" />
        <p className="mt-2 text-[13px] leading-relaxed text-ink">{mission.activity.headline}</p>
        {mission.activity.detail && (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{mission.activity.detail}</p>
        )}

        {mission.activity.watching.length > 0 && (
          <ul className="mt-3 space-y-1">
            {mission.activity.watching.slice(0, 4).map((purpose, index) => (
              <li key={`${purpose}-${index}`} className="flex gap-2 text-[11px] leading-relaxed text-ink-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span className="min-w-0 break-words">{purpose}</span>
              </li>
            ))}
          </ul>
        )}

        {mission.steering.pending > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-[10px] text-warn">
            <Loader2 className="h-3 w-3 animate-spin" />
            Reading {mission.steering.pending} instruction{mission.steering.pending === 1 ? '' : 's'} you gave it
          </p>
        )}

      </section>

      {/* -------------------------------------------------------------- work plan */}
      <WorkPlan steps={mission.workPlan} title="Work plan" />

      {/* ----------------------------------------------------------------- thesis */}
      <section className="rounded-2xl border border-line bg-surface">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="rounded-xl bg-accent-soft p-2 text-accent">
            <Target className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-bold text-ink">Trade Plan</h3>
        </header>

        {mission.thesis ? (
          <div className="space-y-3 px-5 py-4">
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink">
              {mission.thesis.statement}
            </p>

            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="rounded-full border border-line px-2 py-0.5 font-semibold text-ink-2">
                {mission.thesis.state}
              </span>
              {mission.thesis.direction && (
                <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
                  {mission.thesis.direction}
                </span>
              )}
              {mission.thesis.confidence !== undefined && (
                <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">
                  Confidence {(mission.thesis.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>

            {mission.thesis.invalidation && (
              <div className="rounded-xl border border-neg/30 bg-neg-soft/50 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-neg">
                  Invalidation
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-2">
                  {mission.thesis.invalidation}
                </p>
              </div>
            )}

            {mission.thesis.requiredConfirmation.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  Required confirmation
                </div>
                <ul className="mt-1 space-y-0.5">
                  {mission.thesis.requiredConfirmation.map((item) => (
                    <li key={item} className="text-[11px] leading-relaxed text-ink-2">
                      · {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-line pt-2 text-[10px] text-ink-4">
              <span>
                Evidence: {mission.supportingEvidenceCount} supporting,{' '}
                {mission.contradictingEvidenceCount} contradicting
              </span>
              <span>{formatTime(mission.thesis.updatedAt)}</span>
            </div>
          </div>
        ) : (
          <p className="px-5 py-4 text-[11px] leading-relaxed text-ink-3">
            No Trade Plan yet. The GOAT is still working out what it believes, which is the correct
            state before it has one — not an error.
          </p>
        )}
      </section>

      {/* --------------------------------------------------------------- trackers */}
      <section className="rounded-2xl border border-line bg-surface">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="rounded-xl bg-accent-soft p-2 text-accent">
            <Radio className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-ink">Trackers</h3>
            <p className="mt-0.5 text-[10px] text-ink-3">
              The deterministic watchers that wake this GOAT while it is dormant.
            </p>
          </div>
        </header>

        {trackers.length === 0 ? (
          <p className="px-5 py-4 text-[11px] leading-relaxed text-ink-3">
            Nothing is being watched yet. A GOAT sets its conditions once it has a Trade Plan, and goes
            quiet between them.
          </p>
        ) : (
          <ul className="divide-y divide-line/60">
            {trackers.map((tracker) => (
              <li key={tracker.id} className="flex items-start gap-3 px-5 py-3">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    tracker.lifecycle.status === 'ACTIVE'
                      ? 'bg-pos'
                      : tracker.lifecycle.status === 'PAUSED'
                        ? 'bg-warn'
                        : 'bg-ink-4'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[11px] leading-relaxed text-ink">
                    {tracker.purpose}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-ink-4">
                    {tracker.kind}
                    {tracker.timeframe ? ` · ${tracker.timeframe}` : ''} ·{' '}
                    {tracker.lifecycle.eventCount} event
                    {tracker.lifecycle.eventCount === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-3">
                  {tracker.lifecycle.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------ trade plan */}
      <TradePlanPanel
        plan={mission.tradePlan}
        thesis={mission.thesis}
        mayExecute={mission.mayExecute}
        mode={mission.mode}
      />

      {/* --------------------------------------------------------------- activity */}
      <ActivityLog orchestrator={orchestrator} mission={mission} />

      {steeringOpen && (
        <SteerDialog
          value={steeringText}
          onChange={setSteeringText}
          busy={steeringBusy}
          onCancel={() => setSteeringOpen(false)}
          onSend={() => void sendSteering()}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const Eyebrow: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string }> = ({
  icon: Icon,
  label,
}) => (
  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
    <Icon className="h-3 w-3" />
    {label}
  </div>
);

const Fact: React.FC<{ label: string; value: string; tone?: 'pos' | 'neg' }> = ({
  label,
  value,
  tone,
}) => (
  <span>
    <span className="text-ink-4">{label} </span>
    <span className={tone === 'neg' ? 'text-neg' : tone === 'pos' ? 'text-pos' : 'text-ink-2'}>
      {value}
    </span>
  </span>
);

const ActionButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  primary?: boolean;
  children: React.ReactNode;
}> = ({ onClick, disabled, icon, primary, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      primary
        ? 'bg-accent-strong text-accent-contrast hover:bg-accent'
        : 'border border-line text-ink-2 hover:border-accent/50'
    }`}
  >
    {icon}
    {children}
  </button>
);

/**
 * The trade plan, or the honest absence of one.
 *
 * Every number here comes from the plan record. Nothing is derived for
 * display, and an absent field is left absent rather than filled in — a
 * target the GOAT did not set is not a target the UI should invent.
 */
const TradePlanPanel: React.FC<{
  plan?: TradeIdea;
  /**
   * The GOAT's working thesis, shown in place of an absent plan.
   *
   * A Trade Plan and a thesis are the same idea at different stages: the thesis is
   * what the GOAT believes, the plan is what it has decided to trade. Showing
   * "No trade plan yet" beside a fully-formed thesis — as this did — told a reader
   * that the GOAT had nothing to say, while the sentence it had written was sitting
   * a few lines above. The hypothesis is the plan until it is priced.
   */
  thesis?: { statement: string; invalidation?: string; direction?: string };
  mayExecute: boolean;
  mode?: string;
}> = ({ plan, thesis, mayExecute, mode }) => (
  <section className="rounded-2xl border border-line bg-surface">
    <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
      <div className="rounded-xl bg-accent-soft p-2 text-accent">
        <Gauge className="h-4 w-4" />
      </div>
      <div>
        <h3 className="text-sm font-bold text-ink">Trade plan</h3>
        <p className="mt-0.5 text-[10px] text-ink-3">
          The GOAT's output when its evidence supports one.
        </p>
      </div>
      {plan && (
        <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-2">
          {plan.status.replace(/_/g, ' ')}
        </span>
      )}
    </header>

    {!plan && thesis ? (
      /*
        Forming, not empty.

        The GOAT believes something and has said so; it has not yet committed to
        prices. Saying so is more useful than an empty panel, because an empty panel
        next to a stated thesis reads as a contradiction rather than as progress.
      */
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
            {thesis.direction ?? 'WORKING VIEW'}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-3">
            FORMING TRADE PLAN
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-ink">{thesis.statement}</p>
        {thesis.invalidation && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            <span className="font-mono text-[9px] tracking-[0.14em] text-ink-4">WRONG IF </span>
            {thesis.invalidation}
          </p>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-ink-4">
          No entry, stop or target yet — the GOAT has a view but not a priced trade.
        </p>
      </div>
    ) : !plan ? (
      <div className="px-5 py-4">
        <p className="text-[11px] leading-relaxed text-ink-2">
          FORMING TRADE PLAN — the GOAT is still collecting evidence.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
          Doing nothing is a real outcome here: a plan built without evidence would be a guess with an
          entry price on it.
        </p>
      </div>
    ) : (
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
            {plan.symbol} · {plan.direction}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-3">
            {plan.orderType}
          </span>
        </div>

        <Row label="Entry" value={String(plan.entry)} />
        <Row label="Invalidation" value={String(plan.invalidationLevel)} />
        {plan.takeProfits.length > 0 && (
          <Row
            label="Targets"
            value={plan.takeProfits
              .map((target) => `${target.price} (${Math.round(target.fraction * 100)}%)`)
              .join(', ')}
          />
        )}
        {plan.riskContext?.riskCurrency !== undefined && (
          <Row
            label="Risk"
            value={`${plan.riskContext.riskCurrency} account currency${
              plan.riskContext.riskFractionOfEquity !== undefined
                ? ` (${(plan.riskContext.riskFractionOfEquity * 100).toFixed(2)}% of equity)`
                : ''
            }`}
          />
        )}
        {plan.supportingEvidence.length > 0 && (
          <Row label="Evidence" value={`${plan.supportingEvidence.length} record(s) supporting`} />
        )}
        <Row label="Created" value={formatTime(plan.createdAt)} />

        {plan.riskCheck && (
          <div
            className={`rounded-xl border px-3 py-2.5 ${
              plan.riskCheck.approved ? 'border-pos/40 bg-pos-soft/50' : 'border-warn/40 bg-warn-soft/50'
            }`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
              Risk check
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{plan.riskCheck.reason}</p>
          </div>
        )}

        {plan.reasoning && (
          <p className="whitespace-pre-wrap border-t border-line pt-3 text-[11px] leading-relaxed text-ink-2">
            {plan.reasoning}
          </p>
        )}

        {!mayExecute && mode && (
          <p className="text-[10px] leading-relaxed text-ink-4">
            Running in {mode}. A plan reaching this state is risk-validated; nothing is sent to an
            exchange.
          </p>
        )}
      </div>
    )}
  </section>
);

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-3">
    <span className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-4">
      {label}
    </span>
    <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-ink-2">{value}</span>
  </div>
);

/**
 * What has actually happened.
 *
 * Built from records — theses, trackers, events, evidence, plans — rather
 * than from a list of strings that animate. A GOAT that has done nothing
 * shows the honest explanation of why, which is the most useful thing on
 * the screen.
 */
/**
 * The activity log.
 *
 * Read from the durable timeline the runtime appends to, newest first. It
 * used to be reconstructed here from the thesis, the trackers, the evidence
 * and the plan — which looked plausible and was wrong in a way that
 * mattered: a tracker that had never fired was listed with the timestamp of
 * whenever it was created, a plan appeared the moment it was proposed rather
 * than when it was risk-checked, and there was no way to show that the GOAT
 * had deployed, read the market, gone dormant, woken and stopped, because
 * none of that was being recorded anywhere.
 *
 * The feed is the record. If it is empty, the GOAT has done nothing.
 */
const ActivityLog: React.FC<{ orchestrator: GoatOrchestrator; mission: GoatMission }> = ({
  orchestrator,
  mission,
}) => {
  const entries = orchestrator.activityFor(mission.goalId, 15).slice().reverse();

  return (
    <section className="rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <ScrollText className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-ink">Activity</h3>
          <p className="mt-0.5 text-[10px] text-ink-3">
            Everything below was written by the runtime. Nothing here is simulated.
          </p>
        </div>
      </header>

      {entries.length === 0 ? (
        <div className="px-5 py-4">
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-3">
            <Activity className="mt-px h-3.5 w-3.5 shrink-0" />
            Nothing yet. A GOAT forms a Trade Plan, sets its conditions, and then waits for one to
            fire. Every line above that point will appear here.
          </p>
        </div>
      ) : (
        <ol className="divide-y divide-line/60">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-5 py-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
              <span className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-ink-2">
                {entry.text}
              </span>
              <time className="shrink-0 font-mono text-[10px] text-ink-4">
                {formatTime(entry.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

/**
 * Steer the GOAT.
 *
 * The wording matters: this is guidance for the next thinking step, not a
 * new objective. The dialog says so, because a user who believes they are
 * rewriting the GOAT would be misled about what changed.
 */
const SteerDialog: React.FC<{
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSend: () => void;
}> = ({ value, onChange, busy, onCancel, onSend }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-xs">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Steer your GOAT"
      className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 text-ink-2 shadow-2xl"
    >
      <h3 className="text-sm font-bold text-ink">Steer your GOAT</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        Tell it what to reconsider. This is guidance for its next thinking step — it does not change
        the goal you gave it, and it cannot make it trade.
      </p>

      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        placeholder="Focus on confirmation rather than anticipating the breakout."
        className="mt-3 w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
      />

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-[11px] font-semibold text-ink-3 transition-colors hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={!value.trim() || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send
        </button>
      </div>
    </div>
  </div>
);

function formatTime(at: number): string {
  if (!at) return '—';
  return new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
