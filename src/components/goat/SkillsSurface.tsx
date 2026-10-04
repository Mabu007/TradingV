/**
 * The skills surface.
 *
 * A GOAT's skills are not decoration and should not be hidden inside the
 * goal composer, where they are only reachable while writing a GOAT and are
 * invisible afterwards. "What can my GOAT actually do?" is a standing
 * question, and it deserves a place that is always one tap away.
 *
 * Everything here reads the canonical registry. There is no parallel skill
 * system: what is listed is what `GoatSkillRegistry` holds, what is toggled
 * is what a GOAT's `skillIds` will carry, and the capabilities shown beside a
 * skill are the ones the runtime would actually grant it — so the answer to
 * "what does this do" is the same answer the engine gives.
 *
 * The one thing this deliberately does not do is present a toggle as a
 * capability grant on its own. Skills are attached to a GOAT when it is
 * created or edited; changing one here changes what future GOATs can be given
 * and what the runtime knows about, not a GOAT that is already running. That
 * distinction is stated in the copy rather than left to be discovered.
 */

import { useState } from 'react';
import { Check, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';

import type { SkillPackage } from '../../engine/goat/skills';

export interface SkillsSurfaceProps {
  skills: SkillPackage[];
  userSkillIds: string[];
  /** Replaced when a GOAT is running; tells the user that. */
  attachedCount?: number;
  busy?: boolean;
  onSave: (markdown: string) => string[];
  onDelete: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  /**
   * The stored markdown for a skill, for loading back into the editor.
   *
   * Editing is the half of CRUD that was missing: a skill could be written and
   * deleted but never revised, so improving one meant starting over and
   * retyping it. Built-ins return `undefined` and are left read-only, because
   * their meaning lives in code rather than in a document.
   */
  onLoadMarkdown?: (id: string) => string | undefined;
}

export const SkillsSurface: React.FC<SkillsSurfaceProps> = ({
  skills,
  userSkillIds,
  attachedCount = 0,
  busy,
  onSave,
  onDelete,
  onToggle,
  onLoadMarkdown,
}) => {
  const [writing, setWriting] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState(SKILL_TEMPLATE);
  const [problems, setProblems] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(undefined);

  /*
   * No separate update path: `saveUserSkill` upserts on the id in the
   * document's own frontmatter, so saving an edited skill over the original is
   * an update. Keeping one write path means an edit cannot drift from a create
   * in how it validates.
   */
  const save = () => {
    const found = onSave(draft);
    setProblems(found);
    if (found.length === 0) {
      setWriting(false);
      setEditingId(undefined);
      setDraft(SKILL_TEMPLATE);
    }
  };

  const beginEdit = (id: string) => {
    const markdown = onLoadMarkdown?.(id);
    if (markdown === undefined) return;
    setEditingId(id);
    setDraft(markdown);
    setProblems([]);
    setWriting(true);
  };

  return (
    <section className="space-y-3" aria-label="Skills">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-ink">SKILLS</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            What a GOAT can think with. Each one grants it real tools and adds
            rules the runtime enforces — a skill that says to be patient changes
            what the GOAT is allowed to do.
          </p>
          {attachedCount > 0 && (
            <p className="mt-1 text-[10px] text-ink-4">
              {attachedCount} attached to your GOATs right now. Changes here apply
              when you create or edit a GOAT.
            </p>
          )}
        </div>
        {!writing && (
          <button
            type="button"
            onClick={() => {
              setWriting(true);
              setProblems([]);
              setDraft(SKILL_TEMPLATE);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 font-mono text-[10px] text-ink-2 transition-colors hover:border-accent hover:text-ink"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            Write a skill
          </button>
        )}
      </header>

      {writing && (
        <div className="space-y-2 rounded-2xl border border-accent/30 bg-accent-soft/25 px-4 py-3.5">
          <label htmlFor="skill-draft" className="block font-mono text-[10px] tracking-[0.14em] text-accent-ink">
            {editingId ? `EDITING ${editingId} — MARKDOWN` : 'NEW SKILL — MARKDOWN'}
          </label>
          <textarea
            id="skill-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink focus:border-accent focus:outline-none"
          />
          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[10.5px] leading-relaxed text-warn">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 font-mono text-[10px] font-bold text-accent-contrast disabled:opacity-40"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setWriting(false);
                setEditingId(undefined);
                setProblems([]);
                setDraft(SKILL_TEMPLATE);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-mono text-[10px] text-ink-2"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-line-60 overflow-hidden rounded-2xl border border-line bg-surface">
        {skills.map((skill) => {
          const isUser = userSkillIds.includes(skill.id);
          const expanded = open === skill.id;
          const capabilities = [
            ...(skill.requiredCapabilities ?? []),
            ...(skill.grants ?? []),
          ];
          return (
            <li key={skill.id}>
              <div className="flex items-start gap-2 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? undefined : skill.id)}
                  aria-expanded={expanded}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <ChevronRight
                      className={`h-3 w-3 shrink-0 text-ink-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="text-[12px] font-semibold text-ink">{skill.name}</span>
                    {isUser && (
                      <span className="rounded bg-line/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-ink-3">
                        yours
                      </span>
                    )}
                    {skill.enabled === false && (
                      <span className="rounded bg-line/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-ink-4">
                        off
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-ink-3">
                    {skill.description}
                  </span>
                </button>

                {onToggle && !isUser && (
                  <button
                    type="button"
                    onClick={() => onToggle(skill.id, skill.enabled === false)}
                    aria-pressed={skill.enabled !== false}
                    className={`shrink-0 rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors ${
                      skill.enabled === false
                        ? 'border-line text-ink-4'
                        : 'border-accent/40 bg-accent-soft/40 text-accent-ink'
                    }`}
                  >
                    {skill.enabled === false ? 'Enable' : 'On'}
                  </button>
                )}

                {isUser && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => beginEdit(skill.id)}
                      disabled={busy || !onLoadMarkdown}
                      aria-label={`Edit ${skill.name}`}
                      className="rounded-lg border border-line px-2 py-1 text-ink-3 transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(skill.id)}
                      disabled={busy}
                      aria-label={`Delete ${skill.name}`}
                      className="shrink-0 rounded-lg border border-line px-2 py-1 text-ink-3 transition-colors hover:border-neg/40 hover:text-neg disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>

              {expanded && (
                <div className="border-t border-line-60 px-4 py-3">
                  {skill.constraints && skill.constraints.length > 0 && (
                    <>
                      <h3 className="font-mono text-[9px] tracking-[0.16em] text-ink-4">
                        RULES THE RUNTIME ENFORCES
                      </h3>
                      <ul className="mt-1.5 space-y-1">
                        {skill.constraints.map((constraint) => (
                          <li key={constraint.kind} className="text-[11px] leading-5 text-ink-3">
                            {describeConstraint(constraint)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {capabilities.length > 0 && (
                    <>
                      <h3 className="mt-3 font-mono text-[9px] tracking-[0.16em] text-ink-4">
                        TOOLS IT GIVES THE GOAT
                      </h3>
                      <p className="mt-1.5 break-words font-mono text-[10.5px] leading-5 text-ink-3">
                        {capabilities.join(' · ')}
                      </p>
                    </>
                  )}
                  {skill.phases && Object.keys(skill.phases).length > 0 && (
                    <>
                      <h3 className="mt-3 font-mono text-[9px] tracking-[0.16em] text-ink-4">
                        WHEN IT APPLIES
                      </h3>
                      <p className="mt-1.5 font-mono text-[10.5px] leading-5 text-ink-3">
                        {Object.keys(skill.phases).join(' · ')}
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

function describeConstraint(constraint: NonNullable<SkillPackage['constraints']>[number]): string {
  switch (constraint.kind) {
    case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
      return 'Refuses to write a trade idea without an explicit invalidation level.';
    case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
      return `Needs at least ${constraint.minimum} supporting pieces of evidence before the thesis may become actionable.`;
    case 'MAX_TRACKERS':
      return `Allows at most ${constraint.maximum} watches at once.`;
    case 'MAX_THESES':
      return `Allows at most ${constraint.maximum} live hypotheses at once.`;
    case 'FORBID_ORDER_TYPE':
      return `Refuses ${constraint.orderType} orders.`;
    case 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION':
      return 'Asks for confirmation on a higher timeframe. Shown on the plan until a coarser observation exists — not a hard gate, because a single-timeframe GOAT could never satisfy it.';
    default:
      return 'Unknown rule.';
  }
}

const SKILL_TEMPLATE = `---
id: my-skill
name: My Skill
description: One line describing what this makes the GOAT better at.
requires: market.getBars, structure.breakout
---

Steer the GOAT in this skill's own words.

## Investigation

What to look at first.

## Tracker planning

What to watch for, and what would count.
`;