/**
 * The condition contract, read from the one committed file.
 *
 * There is exactly one condition language in TradingGOATs, and its
 * definition is `shared/condition_schema_v1.json`. This module imports
 * *that file* - not a transcription of it - and interprets it. The
 * vocabularies below (timeframes, operators, indicator names, node kinds,
 * the permitted `THEN`) are read out of the schema at load time, so the
 * browser cannot drift from the Python engine by forgetting to update a
 * list.
 *
 * The interpreter covers the JSON Schema subset the condition schema
 * actually uses. It is small on purpose: a smaller subset is a smaller
 * surface for the two sides to disagree about.
 *
 * What this module deliberately does *not* do is evaluate conditions.
 * Measurement belongs to the engine. See `engineClient.ts` for how a
 * draft is tested against a committed fixture.
 */

// The committed schema, inlined by the bundler and by the test runner.
// `?raw` is a Vite import suffix; its type is declared in
// `src/types/raw-imports.d.ts`.
import RAW_SCHEMA from '../../../shared/condition_schema_v1.json?raw';

export type ConditionTree = Record<string, unknown>;
export type ConditionNode = Record<string, unknown>;

export interface SchemaProblem {
  /** Dotted path to the offending value, e.g. `root.children.0.level`. */
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

const schema: Schema = JSON.parse(RAW_SCHEMA) as Schema;

export const CONDITION_SCHEMA: Schema = schema;

const rootProperties = schema.properties as Record<string, Schema>;
const defs = schema.$defs as Record<string, Schema>;

/** The one supported version, read from the file rather than hardcoded. */
export const CONDITION_SCHEMA_VERSION: number = rootProperties.schemaVersion.const as number;

/** The legal values of one property, whether the schema says enum or const. */
function legalValues(property: Schema | undefined): string[] {
  if (!property) return [];
  if (Array.isArray(property.enum)) return property.enum as string[];
  if (property.const !== undefined) return [String(property.const)];
  return [];
}

/** The legal values of `key` on a branch that has `properties`. */
function valuesOf(branch: Schema, key: string): string[] {
  return legalValues((branch.properties as Record<string, Schema> | undefined)?.[key]);
}

/* ------------------------------------------------------------------ *
 * Vocabularies, derived from the committed schema
 * ------------------------------------------------------------------ */

const nodeSchema = defs.node;

/** Maps a node `kind` to the schema branch that describes it. */
const BRANCH_BY_KIND: Record<string, Schema> = (() => {
  const branches = (nodeSchema.oneOf ?? []) as Array<{ $ref: string }>;
  const table: Record<string, Schema> = {};
  for (const branch of branches) {
    const name = branch.$ref.replace('#/$defs/', '');
    const definition = defs[name];
    for (const kind of valuesOf(definition, 'kind')) table[kind] = definition;
  }
  return table;
})();

export const CONDITION_KINDS: readonly string[] = Object.keys(BRANCH_BY_KIND).sort();

export const TIMEFRAMES: readonly string[] = legalValues(defs.timeframe);
export const INDICATORS: readonly string[] = legalValues(defs.indicator);
export const COMPARISON_OPERATORS: readonly string[] = legalValues(defs.operator);
export const GROUP_OPERATORS: readonly string[] = valuesOf(defs.group, 'operator');

/** The only permitted THEN. Reading it from the schema keeps it closed. */
export const PERMITTED_THEN: readonly string[] = legalValues(rootProperties.then);

export const CONDITIONS_THAT_NEED_BARS: readonly string[] = [
  'PRICE_LEVEL', 'PRICE_CROSS', 'INDICATOR_THRESHOLD', 'INDICATOR_COMPARE', 'MOMENTUM_BAND',
  'TREND_DIRECTION', 'ADX_STRENGTH', 'VOLATILITY', 'VOLATILITY_COMPARE', 'VOLUME',
  'PRICE_ACTION', 'CONSECUTIVE', 'STRUCTURE', 'PATTERN', 'MATH_EXPR', 'BREAKOUT', 'SPREAD',
];

/* ------------------------------------------------------------------ *
 * Interpreter
 * ------------------------------------------------------------------ */

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported schema reference: ${ref}`);
  let node: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) throw new Error(`Unresolvable schema reference: ${ref}`);
  }
  return node as Schema;
}

/**
 * Validate one value against one schema branch.
 *
 * Only the keywords the condition schema uses are interpreted. An
 * unrecognised keyword is ignored rather than guessed at, which is why
 * `contract.test.ts` fails if the schema ever grows a keyword this
 * interpreter would silently skip.
 */
function validate(value: unknown, node: Schema, path: string, root: Schema, out: SchemaProblem[]): void {
  const ref = node.$ref as string | undefined;
  if (ref) {
    validate(value, resolveRef(ref, root), path, root, out);
    return;
  }

  const declaredConst = (node as { const?: unknown }).const;
  if (declaredConst !== undefined && value !== declaredConst) {
    out.push({ path, message: `must be ${JSON.stringify(node.const)}` });
    return;
  }

  const declaredEnum = node.enum as unknown[] | undefined;
  if (Array.isArray(declaredEnum) && !declaredEnum.includes(value)) {
    out.push({ path, message: `must be one of ${declaredEnum.join(', ')}` });
    return;
  }

  const declaredType = node.type as string | string[] | undefined;
  if (declaredType) {
    const types = Array.isArray(declaredType) ? declaredType : [declaredType];
    if (!types.some((type) => matchesType(value, type))) {
      out.push({ path, message: `must be ${types.join(' or ')}` });
      return;
    }
  }

  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) {
      out.push({ path, message: `must be at least ${node.minimum}` });
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      out.push({ path, message: `must be at most ${node.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      out.push({ path, message: `must be at least ${node.minLength} characters` });
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      out.push({ path, message: `must be at most ${node.maxLength} characters` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      out.push({ path, message: `must have at least ${node.minItems} item(s)` });
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      out.push({ path, message: `must have at most ${node.maxItems} item(s)` });
    }
    if (node.items) {
      value.forEach((item, index) => validate(item, node.items as Schema, `${path}[${index}]`, root, out));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (node.properties ?? {}) as Record<string, Schema>;
    const required = (node.required ?? []) as string[];

    for (const key of required) {
      if (!(key in record)) out.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
    }

    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          out.push({ path: path ? `${path}.${key}` : key, message: 'is not a recognised property' });
        }
      }
    }

    for (const [key, child] of Object.entries(properties as Record<string, Schema>)) {
      if (key in record) validate(record[key], child, path ? `${path}.${key}` : key, root, out);
    }
  }

  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf as Schema[];
    const passing = branches.filter((branch) => collect(value, branch, root).length === 0);
    if (passing.length === 0) {
      // Report the branch that came closest. "Matched none of N shapes" on
      // its own tells a user nothing about what to change.
      const best = branches
        .map((branch) => ({ branch, problems: collect(value, branch, root) }))
        .sort((a, b) => a.problems.length - b.problems.length)[0];
      const detail = best?.problems[0];
      out.push({
        path,
        message: detail
          ? `does not match any condition type (closest match reports: ${detail.path || 'root'} ${detail.message})`
          : 'does not match any condition type',
      });
    }
  }
}

function collect(value: unknown, node: Schema, root: Schema): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  validate(value, node, '', root, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Validate a whole tree against the committed schema.
 *
 * Returns an empty array when the tree is canonical. Problems are
 * reported, not thrown, because the builder shows them next to the
 * condition that caused them.
 */
export function validateConditionTree(tree: unknown): SchemaProblem[] {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    return [{ path: 'root', message: 'A condition tree must be an object.' }];
  }

  const version = (tree as { schemaVersion?: unknown }).schemaVersion;
  if (version !== CONDITION_SCHEMA_VERSION) {
    return [{
      path: 'schemaVersion',
      message: `unsupported condition schema version ${JSON.stringify(version)}; this app implements ${CONDITION_SCHEMA_VERSION}`,
    }];
  }

  return collect(tree, schema, schema);
}

export function isCanonicalTree(tree: unknown): boolean {
  return validateConditionTree(tree).length === 0;
}

export function assertCanonicalTree(tree: unknown): void {
  const problems = validateConditionTree(tree);
  if (problems.length === 0) return;
  throw new Error(`Not a canonical condition tree:\n${problems.map((p) => `  ${p.path || 'root'}: ${p.message}`).join('\n')}`);
}

/** Every leaf in the tree, depth first. */
export function conditionLeaves(node: ConditionNode): ConditionNode[] {
  if (!node || node.kind !== 'GROUP') return node ? [node] : [];
  const children = (node.children ?? []) as ConditionNode[];
  return children.flatMap(conditionLeaves);
}

/** Every (timeframe, indicator) the tree needs, which is the compute plan. */
export function conditionTextures(node: ConditionNode): Array<{ timeframe: string; indicator: string }> {
  const defaultTimeframe = DEFAULT_TIMEFRAME;
  const found = new Map<string, { timeframe: string; indicator: string }>();
  const note = (timeframe: unknown, indicator: string) => {
    const resolved = typeof timeframe === 'string' && TIMEFRAMES.includes(timeframe) ? timeframe : defaultTimeframe;
    found.set(`${resolved}/${indicator}`, { timeframe: resolved, indicator });
  };

  for (const leaf of conditionLeaves(node)) {
    if (leaf.enabled === false) continue;
    if (CONDITIONS_THAT_NEED_BARS.includes(leaf.kind as string)) note(leaf.timeframe, '__SERIES__');
    for (const side of ['left', 'right']) {
      const entry = leaf[side];
      if (entry && typeof entry === 'object' && typeof (entry as ConditionNode).indicator === 'string') {
        note((entry as ConditionNode).timeframe ?? leaf.timeframe, (entry as ConditionNode).indicator as string);
      }
    }
    if (typeof leaf.indicator === 'string') note(leaf.timeframe, leaf.indicator);
    if (typeof leaf.measure === 'string' && INDICATORS.includes(leaf.measure)) note(leaf.timeframe, leaf.measure);
    if (leaf.kind === 'MATH_EXPR' && typeof leaf.expression === 'string') {
      for (const match of leaf.expression.matchAll(/([A-Z_]+)\s*\(/g)) note(leaf.timeframe, match[1]);
    }
  }

  const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  return [...found.values()].sort((a, b) =>
    a.timeframe === b.timeframe ? byCodeUnit(a.indicator, b.indicator) : byCodeUnit(a.timeframe, b.timeframe));
}

export const DEFAULT_TIMEFRAME = TIMEFRAMES.includes('15m') ? '15m' : (TIMEFRAMES[0] ?? '15m');
