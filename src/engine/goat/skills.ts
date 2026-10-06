/**
 * Skills.
 *
 * A Skill is how an advanced user influences HOW GOAT approaches a
 * problem. It is not a tool (that is a capability), not a goal (that is
 * the user's objective) and not a tracker (that is what the runtime
 * watches).
 *
 * The previous skill system had exactly two effects: it granted
 * capabilities and it injected a block of prompt text at
 * initialisation. Both are kept. What is added is the part that
 * actually matters for an agentic system — a skill participates in
 * every phase of the loop, not just the first one.
 *
 * A skill declares guidance per phase. The same `market-structure`
 * skill therefore shapes goal interpretation, thesis formation,
 * tracker planning, event interpretation, revision and trade
 * construction, instead of being read once and forgotten.
 *
 * Skills are also permission-shaped. `grants` widens what a skill's
 * holder may do, but only for capabilities the registry already knows,
 * and never past what the deploying agent was given. A skill cannot
 * reach the database, the network, or execution: those are not
 * capabilities it can name.
 */

import { AgentCapability } from '../agents/types';

/**
 * The phases of the GOAT loop a skill can take part in.
 *
 * Modelled explicitly rather than as free text, so "this skill only
 * shapes tracker planning" is a checkable claim rather than a comment.
 */
export type SkillPhase =
  | 'GOAL_INTERPRETATION'
  | 'INVESTIGATION'
  | 'THESIS_FORMATION'
  | 'TRACKER_PLANNING'
  | 'EVENT_INTERPRETATION'
  | 'THESIS_REVISION'
  | 'TRADE_CONSTRUCTION';

export const ALL_SKILL_PHASES: SkillPhase[] = [
  'GOAL_INTERPRETATION',
  'INVESTIGATION',
  'THESIS_FORMATION',
  'TRACKER_PLANNING',
  'EVENT_INTERPRETATION',
  'THESIS_REVISION',
  'TRADE_CONSTRUCTION',
];

/**
 * A skill package.
 *
 * Modular by construction: a skill is a self-contained record of
 * instructions, phase guidance, granted capabilities, constraints and
 * optional deterministic evaluators. The fields that are present but
 * unused cost nothing, and a skill that only supplies instructions is
 * still a valid skill.
 */
export interface SkillPackage {
  id: string;
  name: string;
  description: string;
  enabled: boolean;

  /** Baseline guidance, present in every phase. */
  instructions: string;

  /**
   * Phase-specific guidance.
   *
   * Compiled per phase and injected where that phase happens, so a
   * skill's tracker-planning rules are in front of the agent when it is
   * choosing what to watch, not only when it was started.
   */
  phases?: Partial<Record<SkillPhase, string>>;

  /**
   * Capabilities this skill requires.
   *
   * Intersected with the agent's declared capabilities and the
   * registered set, exactly as the existing runtime already does, so a
   * skill can never widen an agent's authority on its own.
   */
  requiredCapabilities?: string[];

  /**
   * Capabilities this skill contributes to a holder.
   *
   * Used for the tracker SDK capabilities, which are granted by
   * attaching a skill rather than by listing them on the agent.
   */
  grants?: string[];

  /**
   * Rules the skill imposes on GOAT's reasoning.
   *
   * Declarative and machine-checkable, unlike instructions. A
   * constraint the runtime can enforce is worth more than a sentence
   * asking nicely, so these are validated and reported on.
   */
  constraints?: SkillConstraint[];

  /**
   * Deterministic evaluators the skill provides.
   *
   * These are ordinary capabilities registered alongside the skill, so
   * they run through the existing permission and audit path. A skill
   * providing `liquidity.detectSweep` is how a skill turns into
   * specialised capability without bypassing anything.
   */
  evaluators?: AgentCapability[];

  /** Ordering hint for the UI. Lower sorts first. */
  order?: number;
}

/**
 * A machine-checkable limit on GOAT's behaviour.
 *
 * Only the kinds the runtime can actually enforce are modelled. A
 * constraint the system cannot check is a preference, and pretending
 * otherwise is how a safety property quietly stops being one.
 */
export type SkillConstraint =
  | { kind: 'REQUIRE_INVALIDATION_BEFORE_TRADE' }
  | { kind: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE'; minimum: number }
  | { kind: 'MAX_TRACKERS'; maximum: number }
  | { kind: 'MAX_THESES'; maximum: number }
  | { kind: 'FORBID_ORDER_TYPE'; orderType: 'MARKET' | 'LIMIT' | 'STOP' }
  | { kind: 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION' }
  /**
   * How many times a trade construction may be re-proposed after the risk layer
   * refuses it.
   *
   * Exists because a strategy around a moving account may legitimately need to
   * re-price several times, and a fixed global bound would be a claim about every
   * strategy made by one of them. It bounds the *retry*, never the gate: no value of
   * this lets a GOAT place anything the risk layer refused.
   */
  | { kind: 'MAX_RISK_REVISIONS'; maximum: number };

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

export interface SkillRegistryDeps {
  /**
   * Ids the registry will accept in `requiredCapabilities`/`grants`.
   *
   * Supplied by the caller so the skill registry does not have to know
   * about the capability registry, and so a test can supply a smaller
   * universe.
   */
  knownCapabilityIds(): string[];
}

/**
 * A validated collection of skills.
 *
 * Extends rather than replaces the existing `SkillRegistry`: the old
 * one granted capabilities and compiled prompt text, and both
 * behaviours are still wanted. What is added is validation, phase
 * compilation and constraint aggregation.
 */
export class GoatSkillRegistry {
  private readonly skills = new Map<string, SkillPackage>();

  constructor(private readonly deps: SkillRegistryDeps) {}

  /**
   * Replace a registered skill in place.
   *
   * A skill that could only be registered could never be enabled, disabled or
   * edited, which is why the surface had no toggle: there was no operation to
   * call. Validation runs on the way in, exactly as it does for a new skill,
   * so an edit cannot smuggle in a capability the registry does not know.
   */
  update(skill: SkillPackage): SkillPackage {
    this.validate(skill);
    this.skills.set(skill.id, skill);
    return skill;
  }

  register(skill: SkillPackage): void {
    this.validate(skill);
    if (this.skills.has(skill.id)) {
      throw new SkillValidationError(`Skill "${skill.id}" is already registered.`);
    }
    this.skills.set(skill.id, skill);
  }

  registerAll(skills: SkillPackage[]): void {
    for (const skill of skills) this.register(skill);
  }

  /**
   * Add a skill, or replace one with the same id.
   *
   * The editor needs this: saving an edited skill is not a second skill,
   * it is the same one with different steering, and a registry that
   * refused the second save would make editing impossible.
   */
  upsert(skill: SkillPackage): void {
    this.validate(skill);
    this.skills.set(skill.id, skill);
  }

  /**
   * Remove a skill.
   *
   * Only meaningful for user-authored skills. Built-in skills can be
   * removed the same way, and the cost of that is visible rather than
   * silent: a GOAT that referenced one loses a phase of its guidance,
   * and `resolveActive` reports the missing skill loudly.
   */
  remove(id: string): boolean {
    return this.skills.delete(id);
  }

  private validate(skill: SkillPackage): void {
    if (!skill.id || typeof skill.id !== 'string') {
      throw new SkillValidationError('A skill must have a non-empty id.');
    }
    if (!skill.name || typeof skill.name !== 'string') {
      throw new SkillValidationError(`Skill "${skill.id}" must have a name.`);
    }
    if (!skill.description || typeof skill.description !== 'string') {
      throw new SkillValidationError(`Skill "${skill.id}" must have a description.`);
    }
    if (typeof skill.instructions !== 'string') {
      throw new SkillValidationError(`Skill "${skill.id}" must have instructions.`);
    }
    if (typeof skill.enabled !== 'boolean') {
      throw new SkillValidationError(`Skill "${skill.id}" must declare whether it is enabled.`);
    }

    if (skill.phases) {
      for (const phase of Object.keys(skill.phases)) {
        if (!ALL_SKILL_PHASES.includes(phase as SkillPhase)) {
          throw new SkillValidationError(
            `Skill "${skill.id}" declares unknown phase "${phase}".`,
          );
        }
      }
    }

    for (const capabilityId of [...(skill.requiredCapabilities ?? []), ...(skill.grants ?? [])]) {
      if (!this.deps.knownCapabilityIds().includes(capabilityId)) {
        throw new SkillValidationError(
          `Skill "${skill.id}" names unknown capability "${capabilityId}". A skill cannot require or grant something that does not exist.`,
        );
      }
    }

    for (const constraint of skill.constraints ?? []) {
      switch (constraint.kind) {
        case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
          if (!Number.isInteger(constraint.minimum) || constraint.minimum < 0) {
            throw new SkillValidationError(
              `Skill "${skill.id}" must require a non-negative integer evidence count.`,
            );
          }
          break;
        case 'MAX_TRACKERS':
        case 'MAX_THESES':
        case 'MAX_RISK_REVISIONS':
          if (!Number.isInteger(constraint.maximum) || constraint.maximum < 1) {
            throw new SkillValidationError(
              `Skill "${skill.id}" constraint ${constraint.kind} needs a positive integer.`,
            );
          }
          break;
        case 'FORBID_ORDER_TYPE':
          if (!['MARKET', 'LIMIT', 'STOP'].includes(constraint.orderType)) {
            throw new SkillValidationError(
              `Skill "${skill.id}" cannot forbid an unknown order type.`,
            );
          }
          break;
        case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
        case 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION':
          break;
        default:
          throw new SkillValidationError(
            `Skill "${skill.id}" declares an unknown constraint kind.`,
          );
      }
    }
  }

  get(id: string): SkillPackage | undefined {
    return this.skills.get(id);
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  list(): SkillPackage[] {
    return [...this.skills.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name),
    );
  }

  listEnabled(): SkillPackage[] {
    return this.list().filter((skill) => skill.enabled);
  }

  /**
   * Resolve active skills, rejecting any that is missing or disabled.
   *
   * A silently ignored skill is worse than a rejected one: the user
   * believes their risk discipline is in force when it is not.
   */
  resolveActive(skillIds: string[]): SkillPackage[] {
    const active: SkillPackage[] = [];
    const problems: string[] = [];
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (!skill) {
        problems.push(`missing skill "${id}"`);
        continue;
      }
      if (!skill.enabled) {
        problems.push(`disabled skill "${id}"`);
        continue;
      }
      active.push(skill);
    }
    if (problems.length > 0) {
      throw new SkillValidationError(`Cannot resolve skills: ${problems.join(', ')}.`);
    }
    return active;
  }

  /** Union of required and granted capabilities over enabled skills. */
  resolveCapabilities(skillIds: string[]): string[] {
    const granted = new Set<string>();
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (!skill?.enabled) continue;
      for (const capability of skill.requiredCapabilities ?? []) granted.add(capability);
      for (const capability of skill.grants ?? []) granted.add(capability);
    }
    return [...granted];
  }

  /**
   * Every constraint active for a set of skills, de-duplicated.
   *
   * When two skills constrain the same thing the tighter value wins,
   * because a constraint is a ceiling and the strictest reading is the
   * safe one.
   */
  resolveConstraints(skillIds: string[]): SkillConstraint[] {
    const merged = new Map<string, SkillConstraint>();
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (!skill?.enabled) continue;
      for (const constraint of skill.constraints ?? []) {
        const key = constraintKey(constraint);
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, constraint);
          continue;
        }
        merged.set(key, tighter(existing, constraint));
      }
    }
    return [...merged.values()];
  }

  /**
   * Compile the instructions for one phase.
   *
   * This is the mechanism that makes skills participate throughout the
   * loop. The same skill contributes different text to goal
   * interpretation and to event interpretation, and neither is a
   * generic system prompt appended once.
   */
  compilePhase(skillIds: string[], phase: SkillPhase): string {
    const lines: string[] = [];
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (!skill || !skill.enabled) continue;

      const parts: string[] = [];
      if (phase === 'GOAL_INTERPRETATION') parts.push(skill.instructions.trim());
      const specific = skill.phases?.[phase];
      if (specific) parts.push(specific.trim());
      if (parts.length === 0) continue;

      lines.push(`### Skill: ${skill.name} (${phase})`);
      lines.push(parts.join('\n\n'));
      lines.push('');
    }
    return lines.join('\n');
  }

  /** The constraint summary shown to the agent and the user alike. */
  describeConstraints(skillIds: string[]): string[] {
    return this.resolveConstraints(skillIds).map(describeConstraint);
  }
}

function constraintKey(constraint: SkillConstraint): string {
  switch (constraint.kind) {
    case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
      return `${constraint.kind}`;
    case 'MAX_TRACKERS':
    case 'MAX_THESES':
    case 'MAX_RISK_REVISIONS':
      return `${constraint.kind}`;
    case 'FORBID_ORDER_TYPE':
      return `${constraint.kind}:${constraint.orderType}`;
    default:
      return constraint.kind;
  }
}

function tighter(a: SkillConstraint, b: SkillConstraint): SkillConstraint {
  if (a.kind === 'MAX_TRACKERS' && b.kind === 'MAX_TRACKERS') {
    return { kind: 'MAX_TRACKERS', maximum: Math.min(a.maximum, b.maximum) };
  }
  if (a.kind === 'MAX_THESES' && b.kind === 'MAX_THESES') {
    return { kind: 'MAX_THESES', maximum: Math.min(a.maximum, b.maximum) };
  }
  if (a.kind === 'MAX_RISK_REVISIONS' && b.kind === 'MAX_RISK_REVISIONS') {
    // The tighter of two bounds wins, and so does the *smaller* of two: a skill that
    // allows three retries does not license a second skill to allow five.
    return { kind: 'MAX_RISK_REVISIONS', maximum: Math.min(a.maximum, b.maximum) };
  }
  if (
    a.kind === 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE' &&
    b.kind === 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE'
  ) {
    return { kind: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE', minimum: Math.max(a.minimum, b.minimum) };
  }
  return a;
}

export function describeConstraint(constraint: SkillConstraint): string {
  switch (constraint.kind) {
    case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
      return 'Every trade idea must carry an explicit invalidation level.';
    case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
      return `A thesis needs at least ${constraint.minimum} pieces of supporting evidence before it may become actionable.`;
    case 'MAX_TRACKERS':
      return `At most ${constraint.maximum} trackers may be active at once.`;
    case 'MAX_THESES':
      return `At most ${constraint.maximum} live theses per goal.`;
    case 'MAX_RISK_REVISIONS':
      return `A refused trade construction may be re-proposed at most ${constraint.maximum} times before the thesis gives up on it.`;
    case 'FORBID_ORDER_TYPE':
      return `${constraint.orderType} orders are not permitted.`;
    case 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION':
      return 'A thesis must be confirmed on a higher timeframe before it becomes actionable.';
    default:
      return 'Unknown constraint.';
  }
}
