import React, { useState } from 'react';
import { Pencil, Rocket, Trash2, ChevronRight } from 'lucide-react';
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
  const [confirming, setConfirming] = useState(false);
  const deployed = mission.deployment !== undefined;

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

        {mission.description && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-2">
            {mission.description}
          </p>
        )}
        <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-ink-3">{mission.goal}</p>

        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-4">
          {mission.market && (
            <span>
              {mission.market}
              {mission.mode ? ` · ${mission.mode}` : ''}
            </span>
          )}
          {deployed && <span>{mission.activeTrackerCount} watching</span>}
          {mission.tradePlan && <span>plan {mission.tradePlan.status.replace(/_/g, ' ')}</span>}
        </dl>
      </button>

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
