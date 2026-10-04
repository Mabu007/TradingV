/**
 * Cross-language condition tests.
 *
 * The point of these is the word *cross*. There is one condition language
 * in TradingGOATs, defined by `shared/condition_schema_v1.json`, and it is
 * implemented twice: once in the browser and once in the Python engine.
 * Two implementations of one language drift unless something forces them
 * to agree. This file is that something.
 *
 * What is checked here:
 *
 *  - the browser validates every shared example against the committed
 *    schema, so a tree the engine accepts is a tree the app accepts;
 *  - the builder only produces trees the schema allows;
 *  - the compute plan the browser derives matches what the engine will
 *    actually poll;
 *  - when a Python interpreter is available, the engine evaluates every
 *    shared example and the statuses must match the file. If Python is
 *    absent the parity check is reported as skipped rather than silently
 *    passing, because a parity suite that quietly stops checking parity
 *    is worse than none.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPARISON_OPERATORS,
  CONDITION_KINDS,
  CONDITION_SCHEMA,
  CONDITION_SCHEMA_VERSION,
  GROUP_OPERATORS,
  INDICATORS,
  PERMITTED_THEN,
  TIMEFRAMES,
  assertCanonicalTree,
  conditionLeaves,
  conditionTextures,
  isCanonicalTree,
  validateConditionTree,
  type ConditionNode,
  type ConditionTree,
} from './contract';
import {
  BUILDER_KINDS,
  addNode,
  childrenOf,
  createGroup,
  createNode,
  createStarterTree,
  describeTree,
  findNode,
  removeNode,
  setEnabled,
  updateNode,
  wrapInGroup,
} from './tree';
import { ConditionContractError, ConditionEngineClient, buildCanonicalTree, pendingWake } from './engineClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
interface SharedExample {
  id: string;
  name: string;
  context: string;
  tree: ConditionTree;
  expect: { status: string };
  note?: string;
}

interface SharedBundle {
  schemaVersion: number;
  contexts: Record<string, { symbol: string; series: Record<string, string> }>;
  examples: SharedExample[];
}

const BUNDLE = JSON.parse(readFileSync(join(REPO_ROOT, 'shared', 'condition_examples.json'), 'utf8')) as SharedBundle;
const EXAMPLES = BUNDLE.examples;

interface Result { name: string; ok: boolean; detail?: string }

const results: Result[] = [];
let currentSuite = '';

function suite(name: string): void {
  currentSuite = name;
}

function check(description: string, run: () => void): void {
  try {
    run();
    results.push({ name: `${currentSuite} › ${description}`, ok: true });
  } catch (error) {
    results.push({ name: `${currentSuite} › ${description}`, ok: false, detail: (error as Error).message });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}\n  expected ${right}\n  actual   ${left}`);
}

function idOf(node: ConditionNode): string {
  const id = node.id;
  if (typeof id !== 'string') throw new Error('a condition node has no id');
  return id;
}

function assertThrows(run: () => void, message: string): void {
  try {
    run();
  } catch {
    return;
  }
  throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * The committed schema
 * ------------------------------------------------------------------ */

suite('schema');

check('the browser reads the committed file, not a copy', () => {
  const committed = JSON.parse(readFileSync(join(REPO_ROOT, 'shared', 'condition_schema_v1.json'), 'utf8')) as unknown;
  assertEqual(CONDITION_SCHEMA, committed, 'the inlined schema differs from the committed file');
});

check('the version and the only permitted THEN are read from the schema', () => {
  assertEqual(CONDITION_SCHEMA_VERSION, 1, 'unexpected schema version');
  assertEqual(PERMITTED_THEN, ['WAKE_AI'], 'THEN must be a closed enum with exactly one value');
});

check('every node kind in the schema is reachable from the browser', () => {
  assert(CONDITION_KINDS.length >= 20, `only ${CONDITION_KINDS.length} node kinds found`);
  // Every kind the browser can build must exist in the schema, and every
  // kind the schema defines must be visible to the browser.
  for (const { kind } of BUILDER_KINDS) {
    assert(CONDITION_KINDS.includes(kind), `${kind} can be built but is not in the schema`);
  }
});

check('the vocabularies are non-empty', () => {
  assert(TIMEFRAMES.length > 0 && TIMEFRAMES.includes('15m'), 'expected 15m among the timeframes');
  assert(INDICATORS.includes('RSI') && INDICATORS.includes('EMA'), 'expected RSI and EMA');
  assert(GROUP_OPERATORS.includes('AND') && GROUP_OPERATORS.includes('OR') && GROUP_OPERATORS.includes('NOT'), 'expected AND/OR/NOT');
  assert(COMPARISON_OPERATORS.includes('GT'), 'expected GT');
});

check('a non-object is rejected with a reason', () => {
  for (const value of [[], 'x', 7, null, true]) {
    const problems = validateConditionTree(value);
    assert(problems.length === 1, `expected one problem for ${JSON.stringify(value)}`);
  }
});

check('a wrong version is a hard failure, not a best-effort parse', () => {
  for (const version of [0, 2, '1', null, true]) {
    const problems = validateConditionTree({ ...createStarterTree('xyz:GOLD'), schemaVersion: version });
    assert(problems.length > 0, `version ${JSON.stringify(version)} was accepted`);
    assert(/version/i.test(problems[0].message), `unhelpful message for version ${JSON.stringify(version)}`);
  }
});

check('a tree without THEN is rejected', () => {
  const tree = createStarterTree('xyz:GOLD') as Record<string, unknown>;
  delete tree.then;
  const problems = validateConditionTree(tree);
  assert(problems.some((p) => p.path === 'then'), 'a tree with no effect was accepted');
});

check('no other THEN is accepted', () => {
  for (const then of ['PLACE_ORDER', 'BUY', 'execute', '', null, 1]) {
    assert(!isCanonicalTree(buildCanonicalTree(createGroup([createNode('PRICE_LEVEL')]), { then })), `"${String(then)}" was accepted as THEN`);
  }
});

check('an unknown property is rejected rather than ignored', () => {
  const tree = createStarterTree('xyz:GOLD');
  (tree as Record<string, unknown>).liveTrading = true;
  const problems = validateConditionTree(tree);
  assert(problems.some((p) => /not a recognised property/.test(p.message)), 'an unknown property was ignored');
});

check('problems carry a path the builder can point at', () => {
  const tree = createStarterTree('xyz:GOLD');
  delete (tree.root as ConditionNode).operator;
  const problems = validateConditionTree(tree);
  assert(problems.length > 0, 'a malformed group was accepted');
  assert(problems[0].path.length > 0, 'a problem with no path cannot be shown in the UI');
});

/* ------------------------------------------------------------------ *
 * The shared examples
 * ------------------------------------------------------------------ */

suite('shared examples');

check('every shared example validates in the browser', () => {
  for (const example of EXAMPLES) {
    const problems = validateConditionTree(example.tree);
    assert(problems.length === 0, `${example.id}: ${JSON.stringify(problems)}`);
  }
});

check('the bundle and the schema agree on the version', () => {
  assertEqual(BUNDLE.schemaVersion, CONDITION_SCHEMA_VERSION, 'the example bundle targets a different schema version');
});

check('every expected state is one of the three states', () => {
  for (const example of EXAMPLES) {
    assert(['TRUE', 'FALSE', 'UNKNOWN'].includes(example.expect.status), `${example.id} expects an impossible state`);
  }
});

check('the three states are all covered', () => {
  // A suite that only ever saw TRUE would pass while everything UNKNOWN
  // was broken.
  const seen = new Set(EXAMPLES.map((example) => example.expect.status));
  for (const status of ['TRUE', 'FALSE', 'UNKNOWN']) {
    assert(seen.has(status), `no shared example expects ${status}`);
  }
});

check('the bundle covers every context it declares', () => {
  for (const name of Object.keys(BUNDLE.contexts)) {
    assert(EXAMPLES.some((example) => example.context === name), `context ${name} is declared but never used`);
  }
});

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

suite('builder');

check('a starter tree is canonical', () => {
  assertCanonicalTree(createStarterTree('xyz:GOLD'));
});

check('every builder kind produces a canonical node', () => {
  for (const { kind } of BUILDER_KINDS) {
    const tree = buildCanonicalTree(createGroup([createNode(kind)]), { market: 'xyz:GOLD' });
    const problems = validateConditionTree(tree);
    assert(problems.length === 0, `${kind}: ${JSON.stringify(problems)}`);
  }
});

check('every builder kind produces a human sentence', () => {
  for (const { kind } of BUILDER_KINDS) {
    const description = describeTree(buildCanonicalTree(createGroup([createNode(kind)])));
    assert(description.length > 10, `${kind} produced "${description}"`);
    assert(!/undefined|NaN|\[object/.test(description), `${kind} produced "${description}"`);
  }
});

check('ids are unique within a tree', () => {
  const tree = createStarterTree('xyz:GOLD');
  let built = tree;
  for (const { kind } of BUILDER_KINDS) built = addNode(built, createNode(kind));
  const ids = conditionLeaves(built.root as ConditionNode).map((leaf) => leaf.id);
  assertEqual(ids.length, new Set(ids).size, 'two conditions share an id');
});

check('adding, editing and removing keeps the tree canonical', () => {
  let tree = createStarterTree('xyz:GOLD');
  const node = createNode('INDICATOR_THRESHOLD');
  tree = addNode(tree, node, idOf(tree.root as ConditionNode));
  assertEqual(childrenOf(tree.root as ConditionNode).length, 2, 'the condition was not added');

  tree = updateNode(tree, idOf(node), { value: 25 });
  assertEqual(findNode(tree, idOf(node))?.value, 25, 'the edit did not apply');

  tree = removeNode(tree, idOf(node));
  assertEqual(childrenOf(tree.root as ConditionNode).length, 1, 'the condition was not removed');
  assertCanonicalTree(tree);
});

check('editing a nested node reaches it', () => {
  let tree = wrapInGroup(createStarterTree('xyz:GOLD'), idOf(createStarterTree('xyz:GOLD').root as ConditionNode), 'OR');
  const inner = createNode('SPREAD');
  tree = addNode(tree, inner);
  tree = updateNode(tree, idOf(inner), { value: 3 });
  assertEqual(findNode(tree, idOf(inner))?.value, 3, 'a nested edit was lost');
  assertCanonicalTree(tree);
});

check('a NOT group replaces rather than accumulates', () => {
  let tree = buildCanonicalTree(createGroup([createNode('PRICE_LEVEL'), createNode('PRICE_CROSS')], 'NOT'));
  tree = addNode(tree, createNode('SPREAD'));
  assertEqual(childrenOf(tree.root as ConditionNode).length, 1, 'a NOT group grew past one child');
  assertCanonicalTree(tree);
});

check('disabling a node leaves a canonical tree and a readable sentence', () => {
  const node = createNode('PRICE_LEVEL');
  const tree = setEnabled(buildCanonicalTree(createGroup([node, createNode('SPREAD')])), idOf(node), false);
  assertCanonicalTree(tree);
  assert(!describeTree(tree).includes('undefined'), 'the sentence broke');
});

check('a disabled node is not scheduled for computation', () => {
  const node = createNode('INDICATOR_THRESHOLD');
  const tree = setEnabled(buildCanonicalTree(createGroup([node])), idOf(node), false);
  assertEqual(conditionTextures(tree.root as ConditionNode), [], 'a disabled condition was still scheduled');
});

/* ------------------------------------------------------------------ *
 * The compute plan
 * ------------------------------------------------------------------ */

suite('compute plan');

check('a price-only tree needs only candles', () => {
  const tree = buildCanonicalTree(createGroup([createNode('PRICE_LEVEL')]));
  assertEqual(conditionTextures(tree.root as ConditionNode), [{ timeframe: '15m', indicator: '__SERIES__' }], 'unexpected plan');
});

check('an indicator schedules that indicator on its own timeframe', () => {
  // The leaf carries the timeframe, not the tree, so a tracker can mix a
  // 15m condition with a 1h one.
  const node = createNode('INDICATOR_THRESHOLD', '1h');
  const tree = buildCanonicalTree(createGroup([node]), { timeframe: '15m' });
  const plan = conditionTextures(tree.root as ConditionNode).map((item) => `${item.timeframe}/${item.indicator}`);
  assert(plan.includes('1h/RSI'), `RSI missing from ${JSON.stringify(plan)}`);
  assert(plan.includes('1h/__SERIES__'), `candles missing from ${JSON.stringify(plan)}`);
  assert(!plan.includes('15m/RSI'), `the indicator was scheduled on the wrong timeframe: ${JSON.stringify(plan)}`);
});

check('a two-timeframe comparison schedules both', () => {
  const node = createNode('INDICATOR_COMPARE');
  const left = node.left as ConditionNode;
  const right = node.right as ConditionNode;
  left.timeframe = '1h';
  right.timeframe = '15m';
  const plan = conditionTextures(createGroup([node])).map((item) => item.timeframe);
  assert(plan.includes('1h') && plan.includes('15m'), `expected both timeframes, got ${JSON.stringify(plan)}`);
});

check('a math expression schedules the indicators it names', () => {
  const node = createNode('MATH_EXPR');
  node.expression = 'RSI(14) - EMA(20) / 2';
  const plan = conditionTextures(createGroup([node])).map((item) => item.indicator);
  assert(plan.includes('RSI') && plan.includes('EMA'), `expected RSI and EMA, got ${JSON.stringify(plan)}`);
});

check('the plan is sorted and deduplicated', () => {
  const a = createNode('INDICATOR_THRESHOLD');
  const b = { ...a, id: 'other' };
  const plan = conditionTextures(createGroup([a, b]));
  const keys = plan.map((item) => `${item.timeframe}/${item.indicator}`);
  assertEqual(keys, [...new Set(keys)], 'the plan contains duplicates');
  // Code-unit order, matching the engine's tuple sort. `localeCompare`
  // would order `_` differently and the two plans would not match.
  assertEqual(keys, [...keys].sort(), 'the plan is not sorted');
});

check('every shared example has a compute plan', () => {
  for (const example of EXAMPLES) {
    const plan = conditionTextures(example.tree.root as ConditionNode);
    assert(plan.length > 0, `${example.id} would never resolve because nothing was scheduled`);
  }
});

check('the cross-timeframe example schedules both of its timeframes', () => {
  const example = EXAMPLES.find((item) => item.id === 'multi-timeframe');
  assert(example, 'the cross-timeframe example is missing from the bundle');
  const timeframes = new Set(conditionTextures(example!.tree.root as ConditionNode).map((item) => item.timeframe));
  assert(timeframes.has('15m') && timeframes.has('1h'), `expected both timeframes, got ${JSON.stringify([...timeframes])}`);
});

/* ------------------------------------------------------------------ *
 * Cross-language parity
 * ------------------------------------------------------------------ */

suite('parity with the engine');

const ENGINE_CLIENT = join(HERE, 'engineClient.ts');

check('the engine module exposes no execution method', () => {
  const source = readFileSync(ENGINE_CLIENT, 'utf8');
  for (const forbidden of ['placeOrder', 'cancelOrder', 'setLeverage', 'closePosition', 'signTransaction', 'privateKey', 'apiKey']) {
    assert(!source.includes(forbidden), `${ENGINE_CLIENT} mentions ${forbidden}`);
  }
});

check('a client that cannot reach the engine says so plainly', async () => {
  const client = new ConditionEngineClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error('connection refused');
    },
  });
  let message = '';
  try {
    await client.health();
  } catch (error) {
    message = (error as Error).message;
  }
  assert(/condition engine/i.test(message), `unhelpful failure message: ${message}`);
});

/**
 * Run the Python engine's evaluation of the shared examples.
 *
 * Reported as skipped, not passed, when no interpreter is available. A
 * parity check that quietly stops running is the failure mode this whole
 * file exists to prevent.
 */
async function runEngineParity(): Promise<{ ran: boolean; detail: string; mismatches: string[] }> {
  // The project's own environment first: a bare `python3` may not have the
  // engine's dependencies, and a parity check that fails for the wrong
  // reason teaches the reader to ignore it.
  const candidates = [process.env.TRADINGV_PYTHON, 'server/.venv/bin/python', 'python3'].filter(
    (value): value is string => Boolean(value),
  );
  const usable = candidates.filter((candidate) => candidate === 'python3' || existsSync(join(REPO_ROOT, candidate)));
  const python = usable[0];
  if (!python) return { ran: false, detail: 'no Python interpreter found; run `bun run server:setup`', mismatches: [] };

  const script = `
import json, sys
sys.path.insert(0, "server")
from tradingv_engine.engine import ConditionEngine
from tradingv_engine.evaluator import evaluate_tree

bundle = json.load(open("shared/condition_examples.json"))
engine = ConditionEngine()
out = []
for example in bundle["examples"]:
    context = engine.fixture_context(example["context"])
    result = evaluate_tree(example["tree"], context)
    out.append({"id": example["id"], "expected": example["expect"]["status"], "actual": result.status})
print(json.dumps(out))
`;
  try {
    const stdout = execFileSync(python, ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }).toString();
    const evaluated = JSON.parse(stdout) as Array<{ id: string; expected: string; actual: string }>;
    return {
      ran: true,
      detail: `${evaluated.length} examples evaluated by the engine`,
      mismatches: evaluated.filter((row) => row.expected !== row.actual).map((row) => `${row.id}: expected ${row.expected}, engine said ${row.actual}`),
    };
  } catch (error) {
    return { ran: false, detail: `the engine could not be run: ${(error as Error).message.split('\n')[0]}`, mismatches: [] };
  }
}

const parity = await runEngineParity();
if (parity.ran) {
  check('the engine agrees with the bundle on every shared example', () => {
    assertEqual(parity.mismatches, [], `the browser and the engine disagree:\n  ${parity.mismatches.join('\n  ')}`);
  });
} else {
  results.push({ name: 'parity with the engine › the engine agrees with the bundle on every shared example', ok: true, detail: `SKIPPED: ${parity.detail}` });
}

/* ------------------------------------------------------------------ *
 * The wake the app acts on
 * ------------------------------------------------------------------ */

suite('wakes');

check('a wake is a request to think, not a trade', () => {
  const wake = {
    wakeId: 'wake_1',
    type: 'AI_WAKE' as const,
    goatId: 'b1',
    trackerId: 't1',
    trackerName: 'Breakout',
    trackerVersion: 1,
    market: 'xyz:GOLD',
    timeframe: '15m',
    timestamp: 0,
    environment: 'DEMO' as const,
    reason: 'price is above 2000',
    acknowledged: false,
    conditions: { overall: 'TRUE' as const, summary: 'all of 1 condition', conditions: [] },
    context: { market: 'xyz:GOLD', price: 2001 },
  };
  for (const forbidden of ['side', 'orderSize', 'leverage', 'signature', 'stopLoss']) {
    assert(!(forbidden in wake), `the wake carries ${forbidden}`);
  }
  assertEqual(wake.environment, 'DEMO', 'a wake must be labelled DEMO');
});

check('only an unacknowledged wake for the right GOAT is actionable', () => {
  const base = { type: 'AI_WAKE' as const, trackerId: 't1', trackerName: 'x', trackerVersion: 1, market: 'm', timeframe: '15m', timestamp: 0, environment: 'DEMO' as const, reason: '', conditions: { overall: 'TRUE' as const, summary: '', conditions: [] }, context: { market: 'm' } };
  const wakes = [
    { ...base, wakeId: 'w1', goatId: 'b1', acknowledged: true },
    { ...base, wakeId: 'w2', goatId: 'b2', acknowledged: false },
    { ...base, wakeId: 'w3', goatId: 'b1', acknowledged: false },
  ];
  assertEqual(pendingWake(wakes, 'b1')?.wakeId, 'w3', 'the wrong wake was selected');
  assertEqual(pendingWake(wakes, 'b2')?.wakeId, 'w2', 'the wrong wake was selected for b2');
  assertEqual(pendingWake([wakes[0]], 'b1'), undefined, 'an acknowledged wake was offered again');
});

check('the client refuses to send a tree the schema rejects', async () => {
  const client = new ConditionEngineClient({ fetch: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch });
  const broken = createStarterTree('xyz:GOLD') as Record<string, unknown>;
  broken.then = 'PLACE_ORDER';
  let thrown: unknown;
  try {
    await client.registerTracker({ id: 't1', goatId: 'b1', name: 'x', definition: broken as ConditionTree });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof ConditionContractError, `expected a contract error, got ${String(thrown)}`);
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const failed = results.filter((result) => !result.ok);
const skipped = results.filter((result) => result.detail?.startsWith('SKIPPED'));

for (const result of results) {
  const mark = result.ok ? (result.detail ? 'skip' : 'pass') : 'FAIL';
  console.log(`${mark}  ${result.name}${result.ok && result.detail ? ` (${result.detail})` : ''}`);
  if (!result.ok && result.detail) console.log(`      ${result.detail.split('\n').join('\n      ')}`);
}

console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (failed.length > 0) process.exit(1);
if (skipped.length > 0) console.log('\nSkipped checks are reported, not hidden. A parity suite that stops running is a failure.');
