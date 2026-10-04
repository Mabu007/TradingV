/**
 * Building canonical condition trees.
 *
 * The builder UI needs to create nodes, wire them into groups, and hand
 * the result to the engine. It must do that without inventing a second
 * shape, so every constructor here produces a node that validates against
 * `shared/condition_schema_v1.json`, and `createNode` takes its defaults
 * from the same committed file.
 *
 * The defaults are read from the schema rather than hardcoded. If the
 * schema changes the legal indicator set or the default comparison
 * operator, a new node follows it.
 */

import {
  CONDITION_SCHEMA_VERSION,
  COMPARISON_OPERATORS,
  GROUP_OPERATORS,
  INDICATORS,
  TIMEFRAMES,
  type ConditionNode,
  type ConditionTree,
} from './contract';

export const DEFAULT_TIMEFRAME = TIMEFRAMES.includes('15m') ? '15m' : (TIMEFRAMES[0] ?? '15m');

/** Node kinds the builder can create today, with a human label. */
export const BUILDER_KINDS = [
  { kind: 'PRICE_LEVEL', label: 'Price is above / below a level', group: 'Market price' },
  { kind: 'PRICE_CROSS', label: 'Price crosses a level', group: 'Market price' },
  { kind: 'SPREAD', label: 'Spread is under a limit', group: 'Market conditions' },
  { kind: 'INDICATOR_THRESHOLD', label: 'An indicator passes a level', group: 'Indicators' },
  { kind: 'INDICATOR_COMPARE', label: 'Two indicators compare', group: 'Indicators' },
  { kind: 'MOMENTUM_BAND', label: 'An oscillator is overbought or oversold', group: 'Indicators' },
  { kind: 'TREND_DIRECTION', label: 'Trend direction', group: 'Trend' },
  { kind: 'VOLATILITY_COMPARE', label: 'Fast vs slow volatility', group: 'Market conditions' },
  { kind: 'VOLUME', label: 'Volume', group: 'Market conditions' },
  { kind: 'ADX_STRENGTH', label: 'Trend strength (ADX)', group: 'Trend' },
  { kind: 'VOLATILITY', label: 'Volatility (ATR, bands, or standard deviation)', group: 'Market conditions' },
  { kind: 'PRICE_ACTION', label: 'Candle and price-action measure', group: 'Market structure' },
  { kind: 'CONSECUTIVE', label: 'Consecutive rising or falling bars', group: 'Market structure' },
  { kind: 'STRUCTURE', label: 'Market structure (higher highs and lows)', group: 'Market structure' },
  { kind: 'PATTERN', label: 'Chart pattern', group: 'Market structure' },
  { kind: 'BREAKOUT', label: 'Breakout of the recent range', group: 'Market structure' },
  { kind: 'MATH_EXPR', label: 'Arithmetic on indicators', group: 'Advanced' },
  { kind: 'TIME', label: 'Time of day', group: 'Schedule' },
  { kind: 'SESSION', label: 'Trading session', group: 'Schedule' },
  { kind: 'PROXIMITY', label: 'Position near its stop or target', group: 'Position' },
  { kind: 'POSITION', label: 'Open position state', group: 'Position' },
  { kind: 'ACCOUNT', label: 'Account state', group: 'Account' },
  { kind: 'RISK', label: 'Risk state', group: 'Account' },
  { kind: 'EVENT', label: 'Position or order event', group: 'Events' },
] as const;

export type BuilderKind = (typeof BUILDER_KINDS)[number]['kind'];

/** Kinds whose evaluation reads candles, and so need a timeframe. */
const SERIES_KINDS = new Set<BuilderKind>([
  'PRICE_LEVEL', 'PRICE_CROSS', 'INDICATOR_THRESHOLD', 'INDICATOR_COMPARE', 'MOMENTUM_BAND',
  'TREND_DIRECTION', 'ADX_STRENGTH', 'VOLATILITY', 'VOLATILITY_COMPARE', 'VOLUME',
  'PRICE_ACTION', 'CONSECUTIVE', 'STRUCTURE', 'PATTERN', 'BREAKOUT', 'MATH_EXPR',
  'PROXIMITY', 'POSITION', 'TIME',
]);

let counter = 0;

/** A stable, readable id. Ids are how the UI points at a node. */
export function nextNodeId(prefix = 'c'): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}

export function resetNodeIds(): void {
  counter = 0;
}

function indicator(): string {
  return INDICATORS.includes('RSI') ? 'RSI' : (INDICATORS[0] ?? 'RSI');
}

function operator(preferred: string): string {
  return COMPARISON_OPERATORS.includes(preferred) ? preferred : (COMPARISON_OPERATORS[0] ?? 'GT');
}

/**
 * A new leaf with schema-valid defaults.
 *
 * The defaults are chosen so the node is *meaningful*, not just legal: a
 * new RSI condition defaults to oversold, which is the reason a trader
 * opens the menu in the first place.
 */
export function createNode(kind: BuilderKind, timeframe = DEFAULT_TIMEFRAME): ConditionNode {
  const id = nextNodeId();
  // Only kinds that read candles carry a timeframe. ACCOUNT, RISK and
  // SESSION have no series, and a timeframe on them would make the
  // monitor poll data nothing reads.
  const base = SERIES_KINDS.has(kind) ? { id, kind, timeframe } : { id, kind };

  switch (kind) {
    case 'PRICE_LEVEL':
      return { ...base, direction: 'ABOVE', level: 0 };
    case 'PRICE_CROSS':
      return { ...base, direction: 'ABOVE', level: 0 };
    case 'SPREAD':
      return { ...base, operator: operator('LTE'), value: 0 };
    case 'INDICATOR_THRESHOLD':
      return { ...base, indicator: indicator(), period: 14, operator: operator('LT'), value: 30 };
    case 'INDICATOR_COMPARE':
      return {
        ...base,
        operator: operator('GT'),
        left: { indicator: indicator(), period: 14 },
        right: { indicator: indicator(), period: 20 },
      };
    case 'MOMENTUM_BAND':
      // Oversold is the band a trader opens this menu for, so it is the
      // default; 30/70 are the conventional RSI boundaries.
      return { ...base, oscillator: indicator(), period: 14, lower: 30, upper: 70 };
    case 'TREND_DIRECTION':
      // The engine reads the trend from the indicator's own direction, so
      // the only thing to choose here is which comparison means "up".
      return { ...base, indicator: 'EMA', period: 20, operator: operator('GT') };
    case 'ADX_STRENGTH':
      return { ...base, operator: operator('GTE'), value: 25 };
    case 'VOLATILITY':
      return { ...base, measure: 'ATR', period: 14, operator: operator('LTE'), value: 1 };
    case 'VOLATILITY_COMPARE':
      return { ...base, fast: 5, slow: 20, operator: operator('GT') };
    case 'VOLUME':
      return { ...base, measure: 'VOLUME_RATIO', period: 20, operator: operator('GTE'), value: 1.5 };
    case 'PRICE_ACTION':
      return { ...base, measure: 'BULLISH_CANDLE', operator: operator('EQ'), value: 1 };
    case 'CONSECUTIVE':
      return { ...base, direction: 'UP', count: 3 };
    case 'STRUCTURE':
      return { ...base, structure: 'UPTREND', operator: operator('EQ') };
    case 'PATTERN':
      return { ...base, pattern: 'DOUBLE_BOTTOM' };
    case 'BREAKOUT':
      return { ...base, direction: 'ABOVE', lookbackBars: 20 };
    case 'MATH_EXPR':
      return { ...base, expression: 'close - EMA(20)', operator: operator('GT'), value: 0 };
    case 'TIME':
      return { ...base, measure: 'HOUR_OF_DAY', operator: operator('GTE'), value: 8 };
    case 'SESSION':
      // Times are minutes from midnight in the given timezone, so a
      // session is self-contained and needs no external calendar.
      return { ...base, boundary: 'WITHIN', sessionId: 'LONDON', timezone: 'UTC', startsAtMinute: 480, endsAtMinute: 1020 };
    case 'PROXIMITY':
      return { ...base, level: 'stopLoss', withinPrice: 0 };
    case 'POSITION':
      return { ...base, measure: 'HAS_POSITION', operator: operator('EQ'), value: 1 };
    case 'ACCOUNT':
      return { id, kind, measure: 'EXPOSURE_RATIO', operator: operator('LTE'), value: 0.25 };
    case 'RISK':
      return { id, kind, measure: 'KILL_SWITCH', operator: operator('EQ'), value: 0 };
    case 'EVENT':
      return { ...base, event: 'ORDER_FILLED' };
    default: {
      const exhaustive: never = kind;
      throw new Error(`No defaults defined for ${String(exhaustive)}`);
    }
  }
}

export function createGroup(children: ConditionNode[] = [], operator: 'AND' | 'OR' | 'NOT' = 'AND'): ConditionNode {
  return { id: nextNodeId('g'), kind: 'GROUP', operator, children };
}

/** A starter tree, so a new tracker is never an empty screen. */
export function createStarterTree(market: string, timeframe = DEFAULT_TIMEFRAME): ConditionTree {
  /*
   * The starter condition is disabled.
   *
   * It used to be `price is above 0`, which is a condition that is true
   * of every price that has ever existed. Armed, it meant a brand-new
   * agent passed its wake test on the first bar it was ever shown, before
   * anyone had chosen a market, a direction, or a level -- the shape of
   * a condition that looks configured and is not.
   *
   * Choosing instead a sensible-looking default would have been worse.
   * Anything specific enough to be worth saving implies a view about
   * when to trade, and a user who saves a GOAT has not expressed one.
   *
   * Disabled is the honest state: the engine reports a group with no
   * active conditions as UNKNOWN, and UNKNOWN never wakes anything, so
   * a half-built GOAT is inert rather than armed. Turning it on is a
   * deliberate act, and the card shows it as off.
   */
  const starter = createNode('PRICE_LEVEL', timeframe);
  return {
    schemaVersion: CONDITION_SCHEMA_VERSION,
    name: 'Untitled tracker',
    market,
    timeframe,
    then: 'WAKE_AI',
    cooldownMs: 900_000,
    maxWakesPerHour: 4,
    maxWakesPerDay: 24,
    requireTradeableMarket: true,
    root: createGroup([{ ...starter, enabled: false }]),
  };
}

/* ------------------------------------------------------------------ *
 * Tree editing
 *
 * Every operation returns a new tree. The builder holds the tree in
 * React state, and mutating it in place would make "undo" and the
 * validation feedback both lie about what is on screen.
 * ------------------------------------------------------------------ */

export function updateNode(tree: ConditionTree, id: string, changes: Partial<ConditionNode>): ConditionTree {
  const patch = (node: ConditionNode): ConditionNode => {
    if (node.id === id) return { ...node, ...changes };
    if (node.kind === 'GROUP') {
      return { ...node, children: (node.children as ConditionNode[]).map(patch) };
    }
    return node;
  };
  return { ...tree, root: patch(tree.root as ConditionNode) };
}

export function setEnabled(tree: ConditionTree, id: string, enabled: boolean): ConditionTree {
  return updateNode(tree, id, { enabled });
}

export function addNode(tree: ConditionTree, node: ConditionNode, groupId?: string): ConditionTree {
  const target = groupId ?? (tree.root as ConditionNode).id;
  const patch = (current: ConditionNode): ConditionNode => {
    if (current.id === target) {
      const children = (current.children ?? []) as ConditionNode[];
      // A NOT group holds one child by definition. Letting it grow would
      // produce a tree that reads as "not both" but means "not either",
      // so the new node replaces the old rather than joining it.
      return { ...current, children: current.operator === 'NOT' ? [node] : [...children, node] };
    }
    if (current.kind === 'GROUP') {
      return { ...current, children: (current.children as ConditionNode[]).map(patch) };
    }
    return current;
  };
  return { ...tree, root: patch(tree.root as ConditionNode) };
}

export function removeNode(tree: ConditionTree, id: string): ConditionTree {
  const strip = (node: ConditionNode): ConditionNode => {
    if (node.kind !== 'GROUP') return node;
    return {
      ...node,
      children: (node.children as ConditionNode[]).filter((child) => child.id !== id).map(strip),
    };
  };
  return { ...tree, root: strip(tree.root as ConditionNode) };
}

export function wrapInGroup(tree: ConditionTree, nodeId: string, operator: 'AND' | 'OR' | 'NOT' = 'OR'): ConditionTree {
  const wrap = (node: ConditionNode): ConditionNode => {
    if (node.id === nodeId) return createGroup([node], operator);
    if (node.kind === 'GROUP') {
      return { ...node, children: (node.children as ConditionNode[]).map(wrap) };
    }
    return node;
  };
  return { ...tree, root: wrap(tree.root as ConditionNode) };
}

/** A group's children, or an empty list for a leaf. */
export function childrenOf(node: ConditionNode): ConditionNode[] {
  return Array.isArray(node.children) ? (node.children as ConditionNode[]) : [];
}

export function findNode(tree: ConditionTree, id: string): ConditionNode | undefined {
  const visit = (node: ConditionNode): ConditionNode | undefined => {
    if (node.id === id) return node;
    if (node.kind !== 'GROUP') return undefined;
    for (const child of node.children as ConditionNode[]) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(tree.root as ConditionNode);
}

/* ------------------------------------------------------------------ *
 * One line, in plain English
 *
 * The engine returns the authoritative summary for a tree it has
 * evaluated. This is for the draft state, before anything is sent.
 * ------------------------------------------------------------------ */

const LABELS: Record<string, string> = {
  PRICE_LEVEL: 'price', PRICE_CROSS: 'price crossing', SPREAD: 'spread',
  INDICATOR_THRESHOLD: 'indicator', INDICATOR_COMPARE: 'indicators compared',
  MOMENTUM_BAND: 'oscillator', TREND_DIRECTION: 'trend', ADX_STRENGTH: 'trend strength',
  VOLATILITY: 'volatility', VOLATILITY_COMPARE: 'volatility compared', VOLUME: 'volume',
  PRICE_ACTION: 'price action', CONSECUTIVE: 'consecutive bars', STRUCTURE: 'structure',
  PATTERN: 'pattern', BREAKOUT: 'breakout', MATH_EXPR: 'calculation', TIME: 'the time',
  SESSION: 'the session', PROXIMITY: 'distance to level', POSITION: 'position',
  ACCOUNT: 'the account', RISK: 'risk state', EVENT: 'event',
};

const COMPARATORS: Record<string, string> = {
  GT: 'is above', GTE: 'is at or above', LT: 'is below', LTE: 'is at or below',
  EQ: 'is exactly', NE: 'is not', GTE_LTE: 'is between', OUTSIDE: 'is outside',
  CROSSES_ABOVE: 'crosses above', CROSSES_BELOW: 'crosses below', INSIDE: 'is inside',
  WIDENS: 'widens', NARROWS: 'narrows',
};

function describe(node: ConditionNode): string {
  if (typeof node.label === 'string' && node.label) return node.label;
  const name = LABELS[node.kind as string] ?? String(node.kind).toLowerCase().replace(/_/g, ' ');

  switch (node.kind) {
    case 'PRICE_LEVEL':
      return `price ${node.direction === 'ABOVE' ? 'is above' : 'is below'} ${node.level}`;
    case 'PRICE_CROSS':
      return `price ${node.direction === 'ABOVE' ? 'crosses above' : 'crosses below'} ${node.level}`;
    case 'INDICATOR_THRESHOLD':
    case 'VOLATILITY':
    case 'PRICE_ACTION':
    case 'MATH_EXPR':
      return `${name} ${COMPARATORS[String(node.operator)] ?? 'compares to'} ${node.value}`;
    case 'INDICATOR_COMPARE': {
      const left = node.left as ConditionNode | undefined;
      const right = node.right as ConditionNode | undefined;
      const name2 = (entry?: ConditionNode) => (entry ? `${entry.indicator}(${entry.period})` : '?');
      return `${name2(left)} ${COMPARATORS[String(node.operator)] ?? 'compares to'} ${name2(right)}`;
    }
    case 'MOMENTUM_BAND':
      return `${node.oscillator}(${node.period}) is between ${node.lower} and ${node.upper}`;
    case 'TREND_DIRECTION':
      return `${node.indicator ?? 'trend'}(${node.period}) is ${node.operator === 'GT' ? 'rising' : 'falling'}`;
    case 'VOLATILITY_COMPARE':
      return `${node.fast}-period volatility is ${COMPARATORS[String(node.operator)] ?? 'compared to'} ${node.slow}-period volatility`;
    case 'VOLUME':
      return `${String(node.measure).toLowerCase().replace(/_/g, ' ')} ${COMPARATORS[String(node.operator)] ?? 'is'} ${node.value}`;
    case 'ADX_STRENGTH':
      return `trend strength ${COMPARATORS[String(node.operator)] ?? 'is'} ${node.value}`;
    case 'CONSECUTIVE':
      return `${node.count} consecutive ${String(node.direction).toLowerCase()} bars`;
    case 'BREAKOUT':
      return `price breaks ${String(node.direction).toLowerCase()} the last ${node.lookbackBars} bars`;
    case 'PATTERN':
    case 'STRUCTURE':
      return `${node.structure === 'UPTREND' ? 'higher highs and higher lows' : 'lower highs and lower lows'} are present`;
    case 'TIME':
      return `the ${String(node.measure).toLowerCase().replace(/_/g, ' ')} ${COMPARATORS[String(node.operator)] ?? 'is'} ${node.value}`;
    case 'PROXIMITY':
      return `price is within ${node.withinPrice} of the ${String(node.level).toLowerCase()}`;
    case 'SESSION':
      return `the ${String(node.sessionId ?? 'named').toLowerCase()} session ${String(node.boundary).toLowerCase()}`;
    case 'POSITION':
      return `${String(node.measure).toLowerCase().replace(/_/g, ' ')} ${COMPARATORS[String(node.operator)] ?? 'is'} ${node.value}`;
    case 'RISK':
      return `${String(node.measure).toLowerCase().replace(/_/g, ' ')} ${COMPARATORS[String(node.operator)] ?? 'is'} ${node.value ?? 'off'}`;
    case 'EVENT':
      return `a ${String(node.event).toLowerCase()} event happens`;
    case 'GROUP': {
      const children = (node.children ?? []) as ConditionNode[];
      if (children.length === 0) return 'nothing yet';
      const joiner = node.operator === 'OR' ? ' or ' : node.operator === 'NOT' ? 'except ' : ' and ';
      return children.map(describe).join(joiner);
    }
    default:
      return name;
  }
}

export function describeTree(tree: ConditionTree): string {
  return `When ${describe(tree.root as ConditionNode)}, wake the AI.`;
}

export function describeNode(node: ConditionNode): string {
  return describe(node);
}
