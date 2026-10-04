import React from 'react';
import { AlertTriangle, ChevronRight, Layers, Target, Radio, Sparkles } from 'lucide-react';
import type { GoatMission } from '../../engine/goat/mission';
import { WorkPlan } from './WorkPlan';

/**
 * The first thing a user sees: what is running right now.
 *
 * Everything on this card is read from the mission model, which reads it
 * from the runtime's records. A card that says MONITORING means there is a
 * live executor and at least one tracker watching; a card that says ERROR
 * means there is a deployment and no executor, which is the state this
 * product used to render as a GOAT that was simply quiet.
 *
 * There is deliberately no "thinking…" state on the card. The stage names
 * are the stages; a spinner would be decoration standing in for a fact.
 */

const TONE: Record<string, string> = {
  RUNNING: 'bg-pos',
  STOPPED: 'bg-ink-3/60',
  PAUSED: 'bg-warn',
  UNDEPLOYED: 'bg-ink-3/40',
  ERROR: 'bg-neg',
};

export interface LiveGoatCardProps {
  mission: GoatMission;
  onOpen: (goalId: string) => void;
}

export const LiveGoatCard: React.FC<LiveGoatCardProps> = ({ mission, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(mission.goalId)}
    className="flex w-full flex-col rounded-2xl border border-line bg-surface p-5 text-left transition-colors hover:border-accent/50"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-bold text-ink">{mission.name}</h3>
        <p className="mt-0.5 font-mono text-[10px] text-ink-3">
          {mission.market ?? 'no market'}
          {mission.mode ? ` · ${mission.mode}` : ''}
        </p>
      </div>
      <span
        className={`flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
          mission.runtime === 'ERROR' ? 'text-neg' : 'text-ink-2'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            mission.runtime === 'RUNNING' ? 'animate-pulse' : ''
          } ${TONE[mission.runtime] ?? 'bg-ink-3/40'}`}
        />
        {stageChip(mission.stage)}
      </span>
    </div>

    {/*
      What this GOAT is, in its own words.

      A live card used to show only what the GOAT was doing this second, which meant
      understanding *what kind* of GOAT it was required going back to the library.
      The description is the strategy, and it belongs where the strategy is running.
      Compact, one clamp, and quiet — it is context, not the headline.
    */}
    {mission.description && (
      <p
        className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-ink-4"
        data-testid="live-goat-description"
      >
        {mission.description}
      </p>
    )}

    {mission.runtime === 'ERROR' ? (
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-neg">
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
        {mission.activity.headline}
      </p>
    ) : (
      <p className="mt-3 text-[11px] leading-relaxed text-ink-2">{mission.activity.headline}</p>
    )}

    <ul className="mt-3 space-y-1 text-[10px] text-ink-3">
      <li className="flex items-center gap-1.5">
        <Radio className="h-3 w-3 shrink-0" />
        {mission.activeTrackerCount > 0
          ? `Watching ${mission.activeTrackerCount} condition${mission.activeTrackerCount === 1 ? '' : 's'}`
          : 'Nothing being watched yet'}
      </li>
      <li className="flex items-center gap-1.5">
        <Target className="h-3 w-3 shrink-0" />
        {tradePlanLine(mission)}
      </li>
      {mission.thesis && (
        <li className="flex items-start gap-1.5">
          <Layers className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{mission.thesis.statement}</span>
        </li>
      )}
    </ul>

    <div className="mt-4 border-t border-line pt-3">
      <WorkPlan steps={mission.workPlan.slice(0, 4)} dense />
    </div>

    <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
      Open GOAT
      <ChevronRight className="h-3.5 w-3.5" />
    </span>
  </button>
);

function stageChip(stage: GoatMission['stage']): string {
  switch (stage) {
    case 'MONITORING':
      return 'Monitoring';
    case 'COLLECTING_EVIDENCE':
      return 'Collecting evidence';
    case 'FORMING_THESIS':
      return 'Forming thesis';
    case 'RESEARCHING':
      return 'Researching';
    case 'RE_EVALUATING':
      return 'Re-evaluating';
    case 'BUILDING_TRADE_PLAN':
      return 'Building plan';
    case 'RISK_CHECK':
      return 'Risk check';
    case 'READY':
      return 'Plan ready';
    case 'EXECUTING':
      return 'Executing';
    case 'MANAGING':
      return 'Managing';
    case 'WAITING':
      return 'Waiting';
    case 'STOPPED':
      return 'Stopped';
    case 'ERROR':
      return 'Needs attention';
    default:
      return 'Not deployed';
  }
}

/**
 * The trade plan line, or the honest reason there isn't one.
 *
 * "No trade plan yet" is a normal state and is written as one. A GOAT with
 * no evidence has done the correct thing.
 */
function tradePlanLine(mission: GoatMission): string {
  const plan = mission.tradePlan;
  if (!plan) {
    // The GOAT's working view, not an absence.
    //
    // "No trade plan yet" next to a thesis the GOAT has already stated told a reader
    // it had nothing to say. The hypothesis is the plan until it is priced, so it is
    // shown instead — truncated by the card, which is a display decision rather
    // than a different claim.
    if (mission.thesis) {
      return `${mission.thesis.direction ?? ''} ${mission.thesis.statement}`.trim();
    }
    return 'Forming a Trade Plan — still gathering evidence';
  }
  const status = plan.status.toLowerCase().replace(/_/g, ' ');
  return `${plan.direction} ${plan.symbol} · ${status}`;
}

/** Used by the empty state so the two cards stay visually identical. */
export const LiveGoatPlaceholder: React.FC = () => (
  <div className="rounded-2xl border border-dashed border-line px-5 py-6 text-center">
    <Sparkles className="mx-auto h-5 w-5 text-ink-4" />
    <p className="mt-2 text-[11px] text-ink-3">
      Nothing is running yet. Deploy a GOAT and it will start here.
    </p>
  </div>
);
