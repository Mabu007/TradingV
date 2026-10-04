import React, { useState } from 'react';
import {
  Plus,
  Sparkles,
  Target,
  Eye,
  EyeOff,
  ShieldCheck,
  Layers,
  Check,
  Loader2,
  Info,
  ArrowLeft,
  ArrowRight,
  Compass,
} from 'lucide-react';
import type { StarterGoatProfile } from '../../engine/goat/starterGoats';

/**
 * The GOAT Explorer.
 *
 * A catalogue of agents, not a marketplace. Nothing here is for sale,
 * nothing is rated, nothing is "popular", and there is no install count.
 * What is on this screen is a set of pre-authored goals with the skills
 * that make each one reachable, written down well enough that a person
 * can decide whether they want this particular way of thinking before
 * deploying it.
 *
 * The card is the product surface, so it answers four questions and stops:
 *
 *   What is it?          the name and one sentence
 *   What does it want?   the goal, in the author's words
 *   What does it watch?  the attention it spends
 *   What can it do?      the skills, named rather than described at length
 *
 * The full internal skill document is deliberately not on the card. It is
 * one click away on the detail view, where there is room to be read rather
 * than skimmed.
 *
 * Two things are deliberately *not* shown, and both absences are
 * deliberate. Internal provider and model identifiers are not, because a
 * GOAT is a way of thinking, not an API configuration. And the rules the
 * runtime cannot enforce are not hidden either: the detail view lists what
 * each starter is asked to do in prose the system does not check, because a
 * card that implied stronger guarantees than exist would be the worst place
 * to be misleading.
 */

export interface GoatExplorerProps {
  starters: StarterGoatProfile[];
  /** Create a GOAT from this starter. Resolves when it has been created. */
  onUse: (starterId: string) => Promise<void> | void;
  busy?: boolean;
  /** The starter currently being created, for the card's own state. */
  creatingId?: string;
  /** Called when the user backs out of a detail view. */
  onBack?: () => void;
  /** Write a goal from nothing, rather than starting from a template. */
  onCreateNew?: () => void;
}

export const GoatExplorer: React.FC<GoatExplorerProps> = ({
  starters,
  onUse,
  busy,
  creatingId,
  onBack,
  onCreateNew,
}) => {
  const [openId, setOpenId] = useState<string | undefined>();

  const open = openId ? starters.find((starter) => starter.id === openId) : undefined;
  if (open) {
    return (
      <GoatDetail
        starter={open}
        onUse={onUse}
        onBack={() => setOpenId(undefined)}
        busy={busy}
        creating={creatingId === open.id}
      />
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Explore GOATs</h2>
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-ink-3">
            Ready-made GOATs for common approaches. Each one is a goal plus the skills that make it
            reachable — no special powers, and no second way of running. Use one and you can rename
            it, edit it and attach different skills like any GOAT you wrote.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line px-2.5 py-1 text-[10px] font-semibold text-ink-3">
            {starters.length} available
          </span>
          {onCreateNew && (
            <button
              type="button"
              onClick={onCreateNew}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[10px] font-semibold text-ink-2 transition-colors hover:border-accent/50"
            >
              <Plus className="h-3 w-3" />
              Write my own
            </button>
          )}
        </div>
      </div>

      {starters.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-line px-5 py-8 text-center text-[11px] text-ink-3">
          No starter GOATs are registered in this build. You can still write your own goal.
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {starters.map((starter) => (
            <StarterCard
              key={starter.id}
              starter={starter}
              onOpen={() => setOpenId(starter.id)}
              onUse={() => void onUse(starter.id)}
              busy={busy}
              creating={creatingId === starter.id}
            />
          ))}
        </div>
      )}
    </section>
  );
};

/** The card. Enough to decide, not so much that it becomes a manual. */
const StarterCard: React.FC<{
  starter: StarterGoatProfile;
  onOpen: () => void;
  onUse: (starterId: string) => void;
  busy?: boolean;
  creating: boolean;
}> = ({ starter, onOpen, onUse, busy, creating }) => (
  <article className="flex flex-col rounded-2xl border border-line bg-surface transition-colors hover:border-accent/40">
    <div className="flex-1 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-ink">{starter.name}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{starter.description}</p>
        </div>
      </div>

      <div className="mt-3.5 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          <Target className="h-3 w-3" />
          Goal
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">{starter.goal}</p>
      </div>

      <div className="mt-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          <Eye className="h-3 w-3" />
          What it looks for
        </div>
        <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-ink-2">
          {starter.interests}
        </p>
      </div>

      <div className="mt-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          <Layers className="h-3 w-3" />
          Skills
        </div>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {starter.skills.map((skill) => (
            <li
              key={skill.id}
              className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-2"
            >
              {skill.name}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {starter.markets.map((market) => (
          <span
            key={market}
            className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-4"
          >
            {market}
          </span>
        ))}
        {starter.shadowFirst && (
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300">
            Ships without trading authority
          </span>
        )}
      </div>
    </div>

    <div className="flex items-center gap-2 border-t border-line px-5 py-3">
      <button
        type="button"
        onClick={() => onUse(starter.id)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {creating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ArrowRight className="h-3.5 w-3.5" />
        )}
        Use this GOAT
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/40"
      >
        <Compass className="h-3.5 w-3.5" />
        How it thinks
      </button>
    </div>
  </article>
);

/**
 * The detail view.
 *
 * Reads like a description of a person, because that is roughly what it
 * is: what they are for, what they look at, what they act on, and when
 * they do nothing. The "not enforced" panel is the part that is usually
 * left off, and it is the part that makes the rest of the page
 * trustworthy.
 */
const GoatDetail: React.FC<{
  starter: StarterGoatProfile;
  onUse: (starterId: string) => void;
  onBack: () => void;
  busy?: boolean;
  creating: boolean;
}> = ({ starter, onUse, onBack, busy, creating }) => (
  <div className="space-y-4">
    <button
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1.5 text-[11px] text-ink-3 transition-colors hover:text-ink-2"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      All GOATs
    </button>

    <div className="rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ink">{starter.name}</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-2">{starter.description}</p>
        </div>
        <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-ink-3">
          v{starter.version}
        </span>
      </header>

      <div className="space-y-3 px-5 py-4">
        <Section icon={Target} label="Goal" body={starter.goal} />
        <Section icon={Sparkles} label="Philosophy" body={starter.philosophy} italic />
        <Section icon={Eye} label="What it looks for" body={starter.watches} />
        <Section icon={Check} label="What makes it interested" body={starter.interests} />
        <Section icon={EyeOff} label="What keeps it dormant" body={starter.dormant} />
        <Section icon={ShieldCheck} label="Risk posture" body={starter.riskPosture} />
      </div>
    </div>

    <div className="rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <Layers className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-ink">Skills</h3>
          <p className="mt-0.5 text-[10px] text-ink-3">
            The steering it reasons with. You can change these before deploying.
          </p>
        </div>
      </header>
      <ul className="divide-y divide-line/60">
        {starter.skills.map((skill) => (
          <li key={skill.id} className="px-5 py-3">
            <div className="text-xs font-semibold text-ink">{skill.name}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{skill.description}</div>
          </li>
        ))}
      </ul>
    </div>

    {starter.unenforcedRules.length > 0 && (
      <div className="rounded-2xl border border-line bg-surface px-5 py-4">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5 text-ink-3" />
          <h3 className="text-xs font-bold text-ink-2">What is guidance, not a guarantee</h3>
        </div>
        <ul className="mt-2 space-y-1.5">
          {starter.unenforcedRules.map((rule) => (
            <li key={rule} className="flex gap-2 text-[11px] leading-relaxed text-ink-3">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-3/50" />
              {rule}
            </li>
          ))}
        </ul>
      </div>
    )}

    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => onUse(starter.id)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-4 py-2.5 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
        Use this GOAT
      </button>
      <span className="text-[10px] text-ink-3">
        Creates an ordinary GOAT. You will see how it read the goal, then choose the market.
      </span>
    </div>
  </div>
);

const Section: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  body: string;
  italic?: boolean;
}> = ({ icon: Icon, label, body, italic }) => (
  <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
      <Icon className="h-3 w-3" />
      {label}
    </div>
    <p className={`mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-2 ${italic ? 'italic' : ''}`}>
      {body}
    </p>
  </div>
);
