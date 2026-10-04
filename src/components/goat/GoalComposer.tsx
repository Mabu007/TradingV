import React, { useMemo, useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Loader2, Plus, Trash2, PenLine, Check, X } from 'lucide-react';
import { SKILL_TEMPLATE } from '../../engine/goat/skillMarkdown';

/**
 * The GOAT composer.
 *
 * This is the product's front door, and it is two fields.
 *
 *   GOAL    what you want, in your own words, as much or as little
 *           prose as you like
 *   SKILLS  optional, and writable in place
 *
 * There is no market, no timeframe, no indicator picker, no threshold.
 * All of that is either the GOAT's decision or a deployment decision
 * made *after* the user has read what the GOAT made of their goal. A
 * user who has to choose a market before they can press the button is
 * being asked for a technical decision they have not earned yet.
 *
 * The skill editor is inline rather than behind a settings screen,
 * because "I want this GOAT to think like this" is part of creating a
 * GOAT, not a separate chore. A skill written here is a markdown
 * document, validated as it is typed, and it is attached to this GOAT
 * the moment it is saved.
 */

export interface ComposerSkill {
  id: string;
  name: string;
  description: string;
  /** True when the user wrote it, rather than it shipping with the app. */
  user?: boolean;
}

export interface GoalDraft {
  /** Optional display name. Falls back to one derived from the goal. */
  name?: string;
  /** Optional user description. Metadata about the GOAT, not its objective. */
  description?: string;
  goal: string;
  skillIds: string[];
}

export interface GoalComposerProps {
  onSubmit: (draft: GoalDraft) => Promise<void> | void;
  /** Prefill, used when editing a GOAT that already exists. */
  initial?: Partial<GoalDraft>;
  /** Skills available to attach. */
  skills: ComposerSkill[];
  /** Skills the user has written, so they can be listed and deleted. */
  userSkills?: string[];
  /** Validate and store a skill the user wrote. Returns the problems. */
  onSaveSkill?: (markdown: string) => string[];
  onDeleteSkill?: (id: string) => void;
  busy?: boolean;
  /** Shown when the goal could not be acted on. */
  blockedReason?: string;
  /** "Create GOAT" when creating, "Save changes" when editing. */
  submitLabel?: string;
}

const EXAMPLES: Array<{ label: string; goal: string; skills: string[] }> = [
  {
    label: 'Reversal',
    goal: 'Find a potential long opportunity if the current bearish move begins reversing.',
    skills: ['structural-trend-analysis', 'patience'],
  },
  {
    label: 'Breakout',
    goal: 'Watch for a sustained break above recent resistance, and only act if the retest holds.',
    skills: ['structural-trend-analysis', 'breakout-structure'],
  },
  {
    label: 'Patience',
    goal: 'Trade only high-conviction trends, and sit on my hands when the structure is unclear.',
    skills: ['structural-trend-analysis', 'risk-discipline'],
  },
];

export const GoalComposer: React.FC<GoalComposerProps> = ({
  onSubmit,
  initial,
  skills,
  userSkills = [],
  onSaveSkill,
  onDeleteSkill,
  busy,
  blockedReason,
  submitLabel,
}) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [selected, setSelected] = useState<string[]>(initial?.skillIds ?? []);
  const [showSkills, setShowSkills] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(SKILL_TEMPLATE);
  const [skillProblems, setSkillProblems] = useState<string[]>([]);
  const [savedSkill, setSavedSkill] = useState<string | undefined>();

  const canSubmit = goal.trim().length > 0 && !busy;

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );

  const submit = async () => {
    if (!canSubmit) return;
    await onSubmit({
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      goal: goal.trim(),
      skillIds: selected,
    });
  };

  const saveSkill = () => {
    if (!onSaveSkill) return;
    const problems = onSaveSkill(draft);
    setSkillProblems(problems);
    if (problems.length === 0) {
      const id = readSkillId(draft);
      if (id) {
        // Attached on save, so a skill the user just wrote is the skill
        // this GOAT is created with. Making them attach it separately
        // would be a step between writing a thing and using it.
        if (!selected.includes(id)) setSelected((current) => [...current, id]);
        setSavedSkill(id);
        setWriting(false);
      }
    }
  };

  const starterSkill = useMemo(
    () => skills.find((skill) => skill.id === 'structural-trend-analysis')?.name ?? 'the first skill',
    [skills],
  );

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink">Create a GOAT</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">
            A GOAT is a goal and, optionally, the skills you want it to think with.
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <label
              htmlFor="goat-name"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3"
            >
              Name <span className="normal-case text-ink-4">(optional)</span>
            </label>
            <input
              id="goat-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My Breakout GOAT"
              className="w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="min-w-0">
            <label
              htmlFor="goat-description"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3"
            >
              Description <span className="normal-case text-ink-4">(optional)</span>
            </label>
            <input
              id="goat-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Watches breakouts and waits for confirmation"
              className="w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="goat-goal"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3"
          >
            Goal
          </label>
          <textarea
            id="goat-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                void submit();
              }
            }}
            rows={5}
            placeholder={'Find a potential long opportunity if the current bearish move begins reversing.\n\nAdd as much detail as you like — the more you say about what you want, the less the GOAT has to guess.'}
            className="w-full resize-y rounded-xl border border-line bg-surface-2 px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-3">
            State the outcome, not the method. "Find strong opportunities and wait for confirmation"
            is enough — the GOAT works out what to watch for, and you choose the market afterwards.
          </p>
        </div>

        {/* Skills: optional, collapsible, and writable in place. */}
        <div className="rounded-xl border border-line bg-bg-surface-2">
          <button
            type="button"
            onClick={() => setShowSkills((open) => !open)}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
          >
            {showSkills ? (
              <ChevronDown className="h-3.5 w-3.5 text-ink-3" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-ink-3" />
            )}
            <span className="text-xs font-semibold text-ink-2">Skills</span>
            <span className="text-[11px] text-ink-3">
              {selected.length > 0
                ? `${selected.length} attached`
                : 'Optional — how this GOAT should think'}
            </span>
          </button>

          {showSkills && !writing && (
            <div className="space-y-1.5 border-t border-line px-3.5 py-3">
              {skills.map((skill) => {
                const isOn = selected.includes(skill.id);
                const isUser = skill.user ?? userSkills.includes(skill.id);
                return (
                  <div key={skill.id} className="flex items-stretch gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggle(skill.id)}
                      aria-pressed={isOn}
                      className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                        isOn
                          ? 'border-accent bg-accent-soft'
                          : 'border-line bg-surface hover:border-ink-3/40'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-ink">{skill.name}</span>
                        {isUser && (
                          <span className="rounded bg-line/60 px-1 py-px text-[9px] uppercase tracking-wide text-ink-3">
                            yours
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-3">{skill.description}</div>
                    </button>
                    {isUser && onDeleteSkill && (
                      <button
                        type="button"
                        onClick={() => {
                          onDeleteSkill(skill.id);
                          setSelected((current) => current.filter((s) => s !== skill.id));
                        }}
                        aria-label={`Delete ${skill.name}`}
                        className="rounded-lg border border-line px-2 text-ink-3 transition-colors hover:border-red-500/40 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  setWriting(true);
                  setSkillProblems([]);
                  setDraft(SKILL_TEMPLATE);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" />
                Write a new skill
              </button>

              {savedSkill && (
                <p className="pt-1 text-[10px] text-emerald-400">
                  Skill saved and attached to this GOAT.
                </p>
              )}
              <p className="pt-1 text-[10px] text-ink-3">
                A skill shapes how the GOAT reasons. It does not change what you asked for.
              </p>
            </div>
          )}

          {showSkills && writing && (
            <div className="space-y-2 border-t border-line px-3.5 py-3">
              <div className="flex items-center gap-2">
                <PenLine className="h-3.5 w-3.5 text-accent" />
                <span className="text-xs font-semibold text-ink">New skill</span>
                <span className="text-[10px] text-ink-3">
                  Markdown. A header, your steering, optional sections per phase.
                </span>
              </div>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={14}
                spellCheck={false}
                className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink focus:border-accent focus:outline-none"
              />
              {skillProblems.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                  {skillProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveSkill}
                  disabled={!onSaveSkill}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-[11px] font-bold text-accent-contrast disabled:opacity-40"
                >
                  <Check className="h-3.5 w-3.5" />
                  Save &amp; attach
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWriting(false);
                    setSkillProblems([]);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11px] text-ink-2"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {blockedReason && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[11px] text-amber-300">
            {blockedReason}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-5 py-3 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? 'Working…' : (submitLabel ?? 'Create GOAT')}
          </button>
          <span className="text-[10px] text-ink-3">⌘ + Enter</span>
        </div>
      </div>

      <div className="border-t border-line px-5 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          Start from an example
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => {
                setGoal(example.goal);
                setSelected(example.skills);
              }}
              className="rounded-full border border-line bg-bg-surface-2 px-3 py-1.5 text-[11px] text-ink-2 transition-colors hover:border-accent hover:text-ink"
            >
              {example.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-ink-3">
          Examples assume {starterSkill} is a sensible default; change it freely.
        </p>
      </div>
    </div>
  );
};

/** The id a draft will be saved under, so the list can update optimistically. */
function readSkillId(markdown: string): string | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) return undefined;
  const id = /^id\s*:\s*(.+)$/m.exec(match[1]);
  return id ? id[1].trim() : undefined;
}
