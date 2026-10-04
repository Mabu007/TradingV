/**
 * Skills, authored as markdown.
 *
 * A Skill is how a user influences *how* their GOAT approaches a
 * problem. It is not a tool (that is a capability), not a goal (that is
 * the objective) and not a tracker (that is what the runtime watches).
 *
 * This file is the authoring surface. A skill is a markdown document:
 * frontmatter for identity, prose for steering, an optional section per
 * loop phase, and an optional list of machine-checkable constraints.
 *
 * The format is markdown rather than a JSON form because a skill is
 * prose. Steering a model is writing, not configuring, and a skill the
 * user cannot read in one sitting is a skill they will not write.
 *
 *   ---
 *   id: structure-first
 *   name: Structure First
 *   description: Read the market as swings, not indicator readings.
 *   ---
 *
 *   Read the market as a sequence of swings, not a set of indicator
 *   readings. A higher high and a higher low is an uptrend.
 *
 *   ## THESIS_FORMATION
 *
 *   Identify the most recent confirmed swing high and swing low before
 *   forming any opinion.
 *
 *   ## Constraints
 *
 *   - REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
 *   - MAX_TRACKERS: 8
 *
 * Parsing is strict on purpose. A skill is loaded into the same registry
 * that decides what a GOAT is allowed to do, so a typo that silently
 * dropped a constraint would be a rule the user believed was in force
 * and was not. Every problem is reported with the line it came from.
 */

import { ALL_SKILL_PHASES, SkillConstraint, SkillPackage, SkillPhase } from './skills';

/** The section that carries machine-checkable limits rather than prose. */
const CONSTRAINTS_HEADING = 'Constraints';

export interface ParsedSkill {
  /** The skill, when the document was usable. */
  skill?: SkillPackage;
  /** Every problem found, each naming the line it came from. */
  problems: string[];
  /** True when the document parses to a valid skill. */
  ok: boolean;
}

const PHASE_BY_HEADING = new Map<string, SkillPhase>(
  ALL_SKILL_PHASES.map((phase) => [phase.toUpperCase(), phase]),
);

/**
 * Parse a skill document.
 *
 * Never throws. A skill the user is halfway through writing has to be
 * previewable with its problems listed, not rejected with an exception
 * the editor cannot show.
 */
export function parseSkillMarkdown(markdown: string): ParsedSkill {
  const problems: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let index = 0;
  const frontmatter: Record<string, string> = {};

  if (lines[0]?.trim() === '---') {
    index = 1;
    let closed = false;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '---') {
        closed = true;
        index += 1;
        break;
      }
      const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (match) {
        frontmatter[match[1].toLowerCase()] = match[2].trim();
      } else if (line.trim() !== '') {
        problems.push(`Line ${index + 1}: expected "key: value" in the header, found "${line.trim()}".`);
      }
      index += 1;
    }
    if (!closed) {
      problems.push('The header is never closed. Add a "---" line under it.');
    }
  } else {
    problems.push('A skill starts with a "---" header block.');
  }

  const id = (frontmatter.id ?? '').trim();
  const name = (frontmatter.name ?? '').trim();
  const description = (frontmatter.description ?? '').trim();

  if (!id) problems.push('The header needs an id.');
  if (!name) problems.push('The header needs a name.');
  if (!description) problems.push('The header needs a description.');

  // Body, split into the leading prose and any `## ` sections.
  const instructions: string[] = [];
  const phases: Partial<Record<SkillPhase, string>> = {};
  const constraints: SkillConstraint[] = [];
  let currentPhase: SkillPhase | undefined;
  let currentConstraints = false;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    if (currentConstraints) {
      for (const line of text.split('\n')) constraints.push(...parseConstraintLine(line, problems));
      return;
    }
    if (currentPhase) {
      phases[currentPhase] = phases[currentPhase] ? `${phases[currentPhase]}\n\n${text}` : text;
      return;
    }
    instructions.push(text);
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1].trim();
      const phase = PHASE_BY_HEADING.get(title.toUpperCase());
      if (phase) {
        currentPhase = phase;
        currentConstraints = false;
        continue;
      }
      if (title.toLowerCase() === CONSTRAINTS_HEADING.toLowerCase()) {
        currentPhase = undefined;
        currentConstraints = true;
        continue;
      }
      problems.push(
        `Line ${index + 1}: unknown section "${title}". Use a loop phase (${ALL_SKILL_PHASES.join(', ')}) or "Constraints".`,
      );
      currentPhase = undefined;
      currentConstraints = false;
      continue;
    }
    buffer.push(line);
  }
  flush();

  const instructionText = instructions.join('\n\n').trim();
  if (!instructionText && Object.keys(phases).length === 0) {
    problems.push('A skill needs steering text: some prose, or at least one phase section.');
  }

  if (problems.length > 0) return { problems, ok: false };

  const orderRaw = frontmatter.order;
  let order: number | undefined;
  if (orderRaw !== undefined && orderRaw !== '') {
    const parsed = Number(orderRaw);
    if (!Number.isFinite(parsed)) {
      problems.push(`The header "order" must be a number, found "${orderRaw}".`);
    } else {
      order = parsed;
    }
  }

  const grants = parseList(frontmatter.grants);
  const required = parseList(frontmatter.requires ?? frontmatter['required-capabilities']);
  if (problems.length > 0) return { problems, ok: false };

  return {
    ok: true,
    problems,
    skill: {
      id,
      name,
      description,
      enabled: true,
      instructions: instructionText,
      ...(Object.keys(phases).length > 0 ? { phases } : {}),
      ...(required.length > 0 ? { requiredCapabilities: required } : {}),
      ...(grants.length > 0 ? { grants } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      ...(order !== undefined ? { order } : {}),
    },
  };
}

/** A comma-separated header list, e.g. `grants: CREATE_TRACKER, READ_TRACKERS`. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * One constraint line, e.g. `MAX_TRACKERS: 8`.
 *
 * Only the kinds the runtime can enforce are accepted. A constraint the
 * system cannot check is a preference, and a skill file that pretends
 * otherwise would be asking the user to trust something unenforceable.
 */
function parseConstraintLine(line: string, problems: string[]): SkillConstraint[] {
  const text = line.replace(/^[-*]\s*/, '').trim();
  if (!text) return [];
  const [rawKind, ...rest] = text.split(':');
  const kind = rawKind.trim().toUpperCase();
  const argument = rest.join(':').trim();

  switch (kind) {
    case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
    case 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION':
      return [{ kind }];
    case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE': {
      const minimum = Number(argument);
      if (!Number.isInteger(minimum) || minimum < 0) {
        problems.push(`"REQUIRE_EVIDENCE_BEFORE_ACTIONABLE" needs a whole number, found "${argument}".`);
        return [];
      }
      return [{ kind, minimum }];
    }
    case 'MAX_TRACKERS':
    case 'MAX_THESES': {
      const maximum = Number(argument);
      if (!Number.isInteger(maximum) || maximum < 1) {
        problems.push(`"${kind}" needs a positive whole number, found "${argument}".`);
        return [];
      }
      return [{ kind, maximum }];
    }
    case 'FORBID_ORDER_TYPE': {
      const orderType = argument.toUpperCase();
      if (!['MARKET', 'LIMIT', 'STOP'].includes(orderType)) {
        problems.push(`"FORBID_ORDER_TYPE" must be MARKET, LIMIT or STOP, found "${argument}".`);
        return [];
      }
      return [{ kind, orderType: orderType as 'MARKET' | 'LIMIT' | 'STOP' }];
    }
    default:
      problems.push(`Unknown constraint "${rawKind.trim()}". Nothing was guessed on your behalf.`);
      return [];
  }
}

/**
 * Render a skill back to markdown.
 *
 * The inverse of the parser, so a skill can be exported, version
 * controlled, or handed to someone else and read back unchanged. A
 * round trip that loses the phase sections or the constraints would
 * quietly weaken a skill every time it was saved.
 */
export function toSkillMarkdown(skill: SkillPackage): string {
  const header = [
    '---',
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `description: ${singleLine(skill.description)}`,
    ...(skill.order !== undefined ? [`order: ${skill.order}`] : []),
    ...(skill.requiredCapabilities?.length ? [`requires: ${skill.requiredCapabilities.join(', ')}`] : []),
    ...(skill.grants?.length ? [`grants: ${skill.grants.join(', ')}`] : []),
    '---',
  ];

  const body: string[] = ['', skill.instructions.trim(), ''];
  for (const phase of ALL_SKILL_PHASES) {
    const text = skill.phases?.[phase]?.trim();
    if (!text) continue;
    body.push(`## ${phase}`, '', text, '');
  }
  if (skill.constraints?.length) {
    body.push(`## ${CONSTRAINTS_HEADING}`, '');
    for (const constraint of skill.constraints) {
      body.push(`- ${describeConstraintLine(constraint)}`);
    }
    body.push('');
  }
  return `${header.join('\n')}\n${body.join('\n')}`;
}

/** Frontmatter values are one line each, so a newline is collapsed. */
function singleLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

function describeConstraintLine(constraint: SkillConstraint): string {
  switch (constraint.kind) {
    case 'REQUIRE_INVALIDATION_BEFORE_TRADE':
    case 'REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION':
      return constraint.kind;
    case 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE':
      return `${constraint.kind}: ${constraint.minimum}`;
    case 'MAX_TRACKERS':
    case 'MAX_THESES':
      return `${constraint.kind}: ${constraint.maximum}`;
    case 'FORBID_ORDER_TYPE':
      return `${constraint.kind}: ${constraint.orderType}`;
    default:
      return String((constraint as { kind: string }).kind);
  }
}

/** A starter document, so the editor is never an empty screen. */
export const SKILL_TEMPLATE = `---
id: my-skill
name: My Skill
description: One line on what this skill changes about how the GOAT thinks.
---

Steering text, present in every phase of the loop. Write it as advice
you would give a careful junior analyst.

## THESIS_FORMATION

Guidance used when the GOAT forms a hypothesis.

## EVENT_INTERPRETATION

Guidance used when a tracker reports something.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_TRACKERS: 8
`;
