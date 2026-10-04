import React, { useState } from 'react';
import { ChevronDown, Pencil, Rocket, Trash2, ChevronRight } from 'lucide-react';
import { ConfirmDestructive } from './ConfirmDestructive';
import type { GoatMission } from '../../engine/goat/mission';

export interface MyGoatCardProps {
  mission: GoatMission;
  busy?: boolean;
  onOpen: (goalId: string) => void;
  onEdit: (goalId: string) => void;
  onDeploy: (goalId: string) => void;
  onArchive: (goalId: string) => void;
}

/**
 * A GOAT the user owns.
 *
 * Three actions, and only three: open it, edit it, deploy it, or get rid
 * of it. Deleting asks first and is honest about what it does — see
 * `ConfirmArchive`.
 */
export const MyGoatCard: React.FC<MyGoatCardProps> = ({
  mission,
  busy,
  onOpen,
  onEdit,
  onDeploy,
  onArchive,
}) => {
  /*
   * The disclosure.
   *
   * A list of GOATs has to stay scannable, so the objective is clamped to a
   * couple of lines and the full description is one click away. The toggle is a
   * separate control from "Open" on purpose: opening a GOAT is navigation, and
   * expanding a card is not — a reader who wants to know what a GOAT is should
   * not have to leave the list to find out.
   *
   * Keyboard-accessible because it is a real `<button>` with `aria-expanded`,
   * and it stops propagation so expanding never doubles as opening.
   */
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const deployed = mission.deployment !== undefined;
  /*
   * Always shown.
   *
   * It was originally conditional on the GOAT having a description or skills, on
   * the reasoning that a card with nothing to add should not offer an expansion.
   * That reasoning is wrong here: the collapsed card already shows a two-line,
   * truncated objective, so the expansion is what makes the *whole* objective
   * readable. Gating it on extra metadata meant the control was absent for exactly
   * the cards that needed it — a starter GOAT with nothing but an objective showed
   * an objective no one could read in full.
   */
  const hasDisclosure = true;

  return (
    <article className="flex flex-col rounded-2xl border border-line bg-surface transition-colors hover:border-accent/40">
      <button
        type="button"
        onClick={() => onOpen(mission.goalId)}
        className="flex-1 px-5 py-4 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{mission.name}</h3>
          <StatusChip mission={mission} />
        </div>

        <p
          className={
            expanded
              ? 'mt-2 text-[11px] leading-relaxed text-ink-3'
              : 'mt-2 line-clamp-2 text-[11px] leading-relaxed text-ink-3'
          }
        >
          {mission.goal}
        </p>

        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-4">
          {mission.market && (
            <span>
              {mission.market}
              {mission.mode ? ` · ${mission.mode}` : ''}
            </span>
          )}
          {mission.timeframes.length > 0 && <span>{mission.timeframes.join(' · ')}</span>}
          {deployed && <span>{mission.activeTrackerCount} watching</span>}
          {mission.tradePlan && <span>plan {mission.tradePlan.status.replace(/_/g, ' ')}</span>}
        </dl>
      </button>

      {hasDisclosure && (
        <div className="border-t border-line/60 px-5 py-2.5">
          <button
            type="button"
            onClick={(event) => {
              // Never let this double as "Open": the card is a button next door.
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} the details of ${mission.name || 'this GOAT'}`}
            data-testid="goat-disclosure"
            data-goat-id={mission.goalId}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-ink-4 transition-colors hover:text-ink-2"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {expanded ? 'HIDE DETAILS' : 'WHAT IT DOES'}
          </button>

          {expanded && (
            <div
              className="mt-2 space-y-2 text-[11px] leading-relaxed text-ink-3"
              data-testid="goat-disclosure-body"
            >
  {mission.description && <p>{mission.description}</p>}
              <p className="text-ink-2">
                <span className="font-mono text-[9px] tracking-[0.14em] text-ink-4">OBJECTIVE </span>
                {mission.goal}
              </p>
              {mission.interpretation && (
                <p className="text-ink-3">
                  <span className="font-mono text-[9px] tracking-[0.14em] text-ink-4">READS IT AS </span>
                  {mission.interpretation}
                </p>
              )}
              {mission.skillIds.length > 0 && (
                <p>
                  <span className="font-mono text-[9px] tracking-[0.14em] text-ink-4">SKILLS </span>
                  {mission.skillIds.join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2.5">
        <CardAction onClick={() => onOpen(mission.goalId)} label={`Open ${mission.name || 'GOAT'}`} icon={<ChevronRight className="h-3 w-3" />}>
          Open
        </CardAction>
        <CardAction onClick={() => onEdit(mission.goalId)} disabled={busy} label={`Edit ${mission.name || 'GOAT'}`} icon={<Pencil className="h-3 w-3" />}>
          Edit
        </CardAction>
        {!deployed && (
          <CardAction
            onClick={() => onDeploy(mission.goalId)}
            disabled={busy}
            primary
            label={`Deploy ${mission.name || 'GOAT'}`}
            icon={<Rocket className="h-3 w-3" />}
          >
            Deploy
          </CardAction>
        )}
        <CardAction
          onClick={() => setConfirming(true)}
          disabled={busy}
          icon={<Trash2 className="h-3 w-3" />}
          label={`Delete ${mission.name || 'this GOAT'}`}
          title="Delete this GOAT"
        />
      </div>

      {/*
        The same dialog the workspace uses. An inline button swap was easy to
        mis-tap on a phone, and two surfaces confirming deletion differently is
        worse than one rule.
      */}
      <ConfirmDestructive
        open={confirming}
        title={`Delete "${mission.name || 'this GOAT'}"?`}
        body="It will stop, and it will be removed from your list. This cannot be undone."
        keptNote="Its theses, evidence and trade plans are kept on record, because what the GOAT worked out is part of the record."
        confirmLabel="Delete GOAT"
        onConfirm={() => {
          setConfirming(false);
          onArchive(mission.goalId);
        }}
        onCancel={() => setConfirming(false)}
      />
    </article>
  );
};

function StatusChip({ mission }: { mission: GoatMission }) {
  const deployed = mission.deployment !== undefined;
  const label = deployed
    ? mission.runtime === 'RUNNING'
      ? mission.stageLabel
      : mission.runtime
    : 'Undeployed';

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        mission.runtime === 'ERROR'
          ? 'border-neg/40 text-neg'
          : deployed && mission.runtime === 'RUNNING'
            ? 'border-pos/40 text-pos'
            : 'border-line text-ink-3'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          mission.runtime === 'ERROR'
            ? 'bg-neg'
            : mission.runtime === 'RUNNING'
              ? 'bg-pos'
              : 'bg-ink-3/50'
        }`}
      />
      {label}
    </span>
  );
}

const CardAction: React.FC<{
  onClick: () => void;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
  /**
   * The accessible name. Needed whenever `children` is absent, which is the
   * case for the destructive action on the card: an icon with only a `title`
   * is announced as an unlabelled button, so the one control that can destroy a
   * GOAT was invisible to a screen reader. `title` alone is not a substitute —
   * it is inconsistently exposed and disappears once the text is read aloud.
   */
  label?: string;
}> = ({ onClick, children, icon, disabled, primary, title, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={label}
    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      primary
        ? 'bg-accent-strong text-accent-contrast hover:bg-accent'
        : 'border border-line text-ink-2 hover:border-accent/40'
    }`}
  >
    {icon}
    {children}
  </button>
);

export default MyGoatCard;
