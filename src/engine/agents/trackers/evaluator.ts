import { calculateATR, calculateEMA, calculateRSI, calculateSMA, calculateMACD } from '../../indicators';
import { describeProximity, evaluateProximity, ProximityConfig, ProximityLevel } from './proximity';
import { Tracker, TrackerConfig, TrackerInput } from './types';
import {
  TrackerConditionGroup,
  evaluateTrackerConditionTree,
  TrackerConditionStatus,
  TrackerConditionTreeResult,
  describeTrackerCondition,
  summariseTrackerTree,
} from './conditions';

export interface TrackerEvaluationState {
  previous: Map<string, TrackerObservationSnapshot>;
  lastBar: Map<string, number>;
  lastSession: Map<string, string>;
  lastSchedule: Map<string, number>;
  sessionStarts: Set<string>;
  sessionEnds: Set<string>;
  proximity: Map<string, boolean>;
  /**
   * Last observed root status per condition-tree tracker, used for
   * false -> true edge detection so a condition that stays true does not
   * wake the GOAT on every tick.
   */
  conditionTrees: Map<string, TrackerConditionStatus>;
}

export interface TrackerObservationSnapshot {
  timestamp: number;
  price?: number;
  spread?: number;
  indicators?: Record<string, number>;
  barTime?: number;
  sessionId?: string;
  bars?: TrackerInput['state']['bars'];
}

export function newEvaluationState(): TrackerEvaluationState {
  return {
    previous: new Map(),
    lastBar: new Map(),
    lastSession: new Map(),
    lastSchedule: new Map(),
    sessionStarts: new Set(),
    sessionEnds: new Set(),
    proximity: new Map(),
    conditionTrees: new Map(),
  };
}

/**
 * Evaluate one tracker against one delivery of market state.
 *
 * Returns the reason to report something, or undefined for "nothing
 * happened". It is a pure function of (tracker, input, state) with one
 * exception: `state` carries the previous samples the edge-detection
 * cases need, and it is advanced here. Nothing else is retained.
 *
 * There is no reasoning here, and there must never be: the return value
 * is a measurement ("price crossed 1.1050"), not an opinion about it.
 */
export function evaluateTracker(tracker: Tracker, input: TrackerInput, state: TrackerEvaluationState): string | undefined {
  const key = tracker.id;
  const previous = state.previous.get(key);
  const current = snapshot(tracker, input);
  let reason: string | undefined;

  /*
   * A condition tree takes precedence over the single-kind evaluation.
   * It is the modern path: one tracker can hold many conditions combined
   * with AND / OR / NOT, which a single `kind` cannot express.
   */
  const tree = conditionTreeOf(tracker);
  if (tree) {
    state.previous.set(key, current);
    return evaluateConditionTreeTracker(tracker, tree, input, state);
  }

  switch (tracker.kind) {
    case 'NEW_BAR': reason = evaluateNewBar(tracker, input, state); break;
    case 'PRICE_THRESHOLD': reason = evaluatePriceThreshold(tracker, input, previous); break;
    case 'PRICE_CROSS': reason = evaluatePriceCross(tracker, input, previous); break;
    case 'INDICATOR_CROSS': reason = evaluateIndicatorCross(tracker, input, previous); break;
    case 'BREAKOUT': reason = evaluateBreakout(tracker, input, previous); break;
    case 'SPREAD_CHANGE': reason = evaluateSpread(tracker, input, previous); break;
    case 'VOLATILITY_CHANGE': reason = evaluateVolatility(tracker, input, previous); break;
    case 'POSITION_UPDATE': reason = evaluatePositionUpdate(tracker, input); break;
    case 'POSITION_OPEN': reason = input.type === 'POSITION_OPEN' ? 'A position opened.' : undefined; break;
    case 'POSITION_CLOSE': reason = input.type === 'POSITION_CLOSE' ? 'A position closed.' : undefined; break;
    case 'RISK_STATE_CHANGED': reason = input.type === 'RISK_STATE_CHANGED' ? 'Trading risk state changed.' : undefined; break;
    case 'ORDER_FILLED': reason = input.type === 'ORDER_FILLED' && input.state.order?.status === 'FILLED' ? `Order ${input.state.order.orderId || ''} filled.` : undefined; break;
    case 'STOP_APPROACHING': reason = evaluatePositionProximity(tracker, input, state, 'stopLoss'); break;
    case 'TARGET_APPROACHING': reason = evaluatePositionProximity(tracker, input, state, 'takeProfit'); break;
    case 'SESSION_START': reason = evaluateSession(tracker, input, state, true); break;
    case 'SESSION_END': reason = evaluateSession(tracker, input, state, false); break;
    case 'SCHEDULED': reason = evaluateScheduled(tracker, input, state); break;
    case 'CUSTOM': reason = evaluateCustom(tracker, input); break;
    default: assertNever(tracker.kind);
  }
  state.previous.set(key, current);
  return reason;
}

/**
 * The stateful face of evaluation.
 *
 * One instance per tracker, so "has this tracker seen the previous
 * sample?" is answered by the object that holds the previous sample
 * rather than by a map keyed by a string that a caller could get wrong.
 * The runtime keeps these; nothing else should.
 */
export class TrackerEvaluator {
  private readonly state = newEvaluationState();

  evaluate(tracker: Tracker, input: TrackerInput): string | undefined {
    return evaluateTracker(tracker, input, this.state);
  }

  /** Drop everything remembered, e.g. when a tracker is removed. */
  reset(): void {
    for (const key of Object.keys(this.state)) {
      const value = (this.state as unknown as Record<string, unknown>)[key];
      if (value instanceof Map || value instanceof Set) value.clear();
    }
  }
}

/** Read a condition tree out of a tracker config, if it has one. */
export function conditionTreeOf(tracker: Tracker): TrackerConditionGroup | undefined {
  const config = record(tracker.config);
  const tree = config?.conditionTree;
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return undefined;
  if ((tree as { kind?: unknown }).kind !== 'GROUP') return undefined;
  return tree as unknown as TrackerConditionGroup;
}

/**
 * Evaluate a condition-tree tracker.
 *
 * The report is edge-detected: the GOAT is woken when the tree becomes
 * true, and not again until the tree stops being true. That is the
 * deterministic debounce that keeps an expensive reasoning step from
 * running on every tick. The runtime's own cooldown and per-minute cap
 * still apply on top.
 */
function evaluateConditionTreeTracker(
  tracker: Tracker,
  tree: TrackerConditionGroup,
  input: TrackerInput,
  state: TrackerEvaluationState,
): string | undefined {
  const result = evaluateTrackerConditionTree(tree, {
    state: input.state,
    instrument: input.state.instrument,
    previousPrice: state.previous.get(tracker.id)?.price,
  });

  const edgeKey = tracker.id;
  /*
   * UNKNOWN is neither an edge nor the end of one.
   *
   * A new edge is FALSE -> TRUE, and an unobserved condition is TRUE ->
   * TRUE. Both used to be computed as "the previous sample was not TRUE",
   * which made UNKNOWN indistinguishable from FALSE: a feed that went
   * quiet and came back looked exactly like a condition that had lapsed,
   * so TRUE -> UNKNOWN -> TRUE woke the GOAT a second time for a
   * condition that never stopped holding. That is a duplicate wake and a
   * duplicate piece of evidence manufactured by a missing candle rather
   * than by the market.
   */
  const previous = state.conditionTrees.get(edgeKey);
  const isTrue = result.status === 'TRUE';

  state.conditionTrees.set(edgeKey, result.status);

  if (!isTrue) return undefined;
  if (previous === 'TRUE' || previous === 'UNKNOWN') return undefined;

  return `Condition met: ${describeTreeOutcome(tree, result, tracker, input)}`;
}

/** Human-readable report reason, plus which conditions held. */
function describeTreeOutcome(
  tree: TrackerConditionGroup,
  result: TrackerConditionTreeResult,
  tracker: Tracker,
  input: TrackerInput,
): string {
  const held = result.flat
    .filter((node) => node.status === 'TRUE')
    .map((node) => node.summary);
  const summary = summariseTrackerTree(tree, {
    symbol: tracker.symbol ?? input.symbol,
    timeframe: tracker.timeframe ?? input.timeframe,
  });
  return held.length > 0 ? `${summary} (${held.join('; ')})` : summary;
}

export function calculateTrackerIndicators(tracker: Tracker, input: TrackerInput): Record<string, number> {
  return computeConfiguredIndicators(record(tracker.config), input);
}

function evaluateNewBar(tracker: Tracker, input: TrackerInput, state: TrackerEvaluationState): string | undefined {
  if (input.type !== 'BAR_UPDATE' && input.type !== 'NEW_BAR') return undefined;
  const payload = record(input.state.eventData);
  if (payload?.isClosed === false) return undefined;
  if (!input.state.bars?.length) return undefined;
  const barTime = input.state.bars[input.state.bars.length - 1].time;
  const bucket = timeframeBucket(barTime, tracker.timeframe || input.timeframe);
  if (bucket === undefined || state.lastBar.get(tracker.id) === bucket) return undefined;
  if (input.type === 'BAR_UPDATE' && (payload?.isClosed !== true || bucket !== timeframeBucket(input.timestamp / 1000, tracker.timeframe || input.timeframe))) return undefined;
  state.lastBar.set(tracker.id, bucket);
  return `New ${tracker.timeframe || input.timeframe || 'bar'} for ${tracker.symbol || input.symbol}.`;
}

function evaluatePriceThreshold(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const level = number(config?.level);
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const operator = config?.operator;
  if (level === undefined || price === undefined || (operator !== 'ABOVE' && operator !== 'BELOW')) return undefined;
  const wasSatisfied = previous?.price !== undefined && (operator === 'ABOVE' ? previous.price >= level : previous.price <= level);
  const satisfied = operator === 'ABOVE' ? price >= level : price <= level;
  return previous !== undefined && !wasSatisfied && satisfied ? `Price crossed ${operator.toLowerCase()} ${level}.` : undefined;
}

function evaluatePriceCross(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const level = number(config?.level);
  const prior = previous?.price;
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const direction = config?.direction;
  if (level === undefined || prior === undefined || price === undefined || (direction !== 'ABOVE' && direction !== 'BELOW')) return undefined;
  const crossed = direction === 'ABOVE' ? prior < level && price >= level : prior > level && price <= level;
  return crossed ? `Price crossed ${direction.toLowerCase()} ${level}.` : undefined;
}

function evaluateIndicatorCross(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const direction = config?.direction;
  if (direction !== 'ABOVE' && direction !== 'BELOW') return undefined;
  const current = computeConfiguredIndicators(config, input);
  const prior = previous?.indicators;
  const fastKey = typeof config?.fastKey === 'string' ? config.fastKey : undefined;
  const slowKey = typeof config?.slowKey === 'string' ? config.slowKey : undefined;
  const level = number(config?.level);
  if (fastKey && slowKey && current[fastKey] !== undefined && current[slowKey] !== undefined && prior?.[fastKey] !== undefined && prior?.[slowKey] !== undefined) {
    const crossed = direction === 'ABOVE'
      ? prior[fastKey] <= prior[slowKey] && current[fastKey] > current[slowKey]
      : prior[fastKey] >= prior[slowKey] && current[fastKey] < current[slowKey];
    return crossed ? `${fastKey} crossed ${direction.toLowerCase()} ${slowKey}.` : undefined;
  }
  const indicator = typeof config?.indicatorKey === 'string' ? config.indicatorKey : undefined;
  if (indicator && level !== undefined && current[indicator] !== undefined && prior?.[indicator] !== undefined) {
    const crossed = direction === 'ABOVE' ? prior[indicator] < level && current[indicator] >= level : prior[indicator] > level && current[indicator] <= level;
    return crossed ? `${indicator} crossed ${direction.toLowerCase()} ${level}.` : undefined;
  }
  return undefined;
}

function computeConfiguredIndicators(config: TrackerConfig | undefined, input: TrackerInput): Record<string, number> {
  const bars = input.state.bars;
  if (!bars || !config) return input.state.indicators || {};
  if (!bars.every((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.high >= bar.low)) return input.state.indicators || {};
  const closes = bars.map((bar) => bar.close);
  const result: Record<string, number> = { ...(input.state.indicators || {}) };
  const fast = record(config.fast);
  const slow = record(config.slow);
  if (fast) assignIndicator(result, { ...fast, key: config.fastKey }, closes, bars);
  if (slow) assignIndicator(result, { ...slow, key: config.slowKey }, closes, bars);
  const single = record(config.indicator);
  if (single) assignIndicator(result, { ...single, key: config.indicatorKey }, closes, bars);
  return result;
}

function assignIndicator(result: Record<string, number>, definition: Record<string, unknown>, closes: number[], bars: TrackerInput['state']['bars']): void {
  const key = typeof definition.key === 'string' ? definition.key : undefined;
  const type = typeof definition.type === 'string' ? definition.type.toUpperCase() : '';
  const period = number(definition.period);
  if (!key) return;
  if (type === 'MACD') {
    const macd = calculateMACD(closes, number(definition.fastPeriod) ?? 12, number(definition.slowPeriod) ?? 26, number(definition.signalPeriod) ?? 9);
    const component = definition.component === 'signal' ? macd.signal : definition.component === 'histogram' ? macd.histogram : macd.macd;
    const latest = component.at(-1);
    if (latest !== undefined && Number.isFinite(latest)) result[key] = latest;
    return;
  }
  if (!period || period < 1 || !Number.isInteger(period)) return;
  let values: number[];
  if (type === 'EMA') values = calculateEMA(closes, period);
  else if (type === 'SMA') values = calculateSMA(closes, period);
  else if (type === 'RSI') values = calculateRSI(closes, period);
  else if (type === 'ATR' && bars && bars.every((bar) => 'open' in bar)) values = calculateATR(bars as Array<{ time: number; open: number; high: number; low: number; close: number }>, period);
  else return;
  const latest = values.at(-1);
  if (latest !== undefined && Number.isFinite(latest)) result[key] = latest;
}

function evaluateBreakout(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const direction = config?.direction;
  const bars = input.state.bars;
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const level = number(config?.level);
  if (price === undefined || (direction !== 'ABOVE' && direction !== 'BELOW')) return undefined;
  if (level !== undefined) {
    if (previous?.price === undefined) return undefined;
    return direction === 'ABOVE' && previous.price < level && price >= level || direction === 'BELOW' && previous.price > level && price <= level
      ? `Price broke ${direction.toLowerCase()} configured level ${level}.` : undefined;
  }
  const lookback = number(config?.lookbackBars) ?? 20;
  if (!bars || bars.length < lookback + 1 || previous?.price === undefined) return undefined;
  const reference = bars.slice(-(lookback + 1), -1);
  const boundary = direction === 'ABOVE' ? Math.max(...reference.map((bar) => bar.high)) : Math.min(...reference.map((bar) => bar.low));
  const broken = direction === 'ABOVE' ? previous.price < boundary && price >= boundary : previous.price > boundary && price <= boundary;
  return broken ? `${direction} breakout of prior ${lookback}-bar boundary ${boundary}.` : undefined;
}

function evaluateSpread(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const spread = input.state.spread;
  const prior = previous?.spread;
  if (spread === undefined) return undefined;
  const maximum = number(config?.maxSpread);
  if (maximum !== undefined && spread > maximum && (prior === undefined || prior <= maximum)) return `Spread expanded above ${maximum}.`;
  const expansionPercent = number(config?.expansionPercent);
  if (expansionPercent !== undefined && prior !== undefined && prior > 0 && spread >= prior * (1 + expansionPercent / 100)) return `Spread expanded by at least ${expansionPercent}%.`;
  return undefined;
}

function evaluateVolatility(tracker: Tracker, input: TrackerInput, previous?: TrackerObservationSnapshot): string | undefined {
  const config = record(tracker.config);
  const key = typeof config?.indicatorKey === 'string' ? config.indicatorKey : 'atr';
  const values = computeConfiguredIndicators(config, input);
  const atr = values[key];
  const threshold = number(config?.threshold);
  const prior = previous?.indicators?.[key];
  if (atr === undefined) return undefined;
  if (threshold !== undefined && atr >= threshold && (prior === undefined || prior < threshold)) return `${key} crossed volatility threshold ${threshold}.`;
  const increasePercent = number(config?.increasePercent);
  if (increasePercent !== undefined && prior !== undefined && prior > 0 && atr >= prior * (1 + increasePercent / 100)) return `${key} increased by at least ${increasePercent}%.`;
  return undefined;
}

function evaluatePositionUpdate(tracker: Tracker, input: TrackerInput): string | undefined {
  const config = record(tracker.config);
  const expectedId = typeof config?.positionId === 'string' ? config.positionId : undefined;
  const data = record(input.state.eventData);
  if (expectedId && data?.positionId !== expectedId) return undefined;
  if (input.type !== 'POSITION_OPEN' && input.type !== 'POSITION_UPDATE' && input.type !== 'POSITION_CLOSE') return undefined;
  return `Position ${typeof data?.positionId === 'string' ? data.positionId : ''} updated (${input.type}).`;
}

/*
 * Proximity reporting.
 *
 * A tracker only decides whether the GOAT is worth waking; it never
 * decides whether an order is allowed. The distance is measured from the
 * instrument's own metadata (`ProximityConfig` supports absolute price,
 * percentage, metadata pip/tick, and account-currency distance) so the
 * same evaluator is correct for Forex, commodities, and indices. When a
 * threshold cannot be measured for the instrument, the tracker stays
 * silent rather than approximating.
 */
function evaluatePositionProximity(tracker: Tracker, input: TrackerInput, state: TrackerEvaluationState, level: ProximityLevel): string | undefined {
  const config = record(tracker.config);
  const positions = input.state.positions || [];
  if (input.symbol === undefined) return undefined;
  const proximityConfig: ProximityConfig = {
    withinPrice: number(config?.withinPrice),
    withinPips: number(config?.withinPips),
    withinTicks: number(config?.withinTicks),
    withinPercent: number(config?.withinPercent),
    withinValue: number(config?.withinValue),
  };
  if (Object.values(proximityConfig).every((value) => value === undefined)) return undefined;
  for (const position of positions) {
    if (position.symbol !== (tracker.symbol || input.symbol)) continue;
    if (position[level] === undefined) continue;
    const evaluation = evaluateProximity({
      position,
      level,
      config: proximityConfig,
      instrument: input.state.instrument,
      price: input.state.price,
    });
    const proximityKey = `${tracker.id}:${position.id}:${level}`;
    const wasNear = state.proximity.get(proximityKey) === true;
    if (evaluation.within && !wasNear) {
      state.proximity.set(proximityKey, true);
      return describeProximity(position.id, level, evaluation);
    }
    if (!evaluation.within) state.proximity.set(proximityKey, false);
  }
  return undefined;
}

function evaluateSession(tracker: Tracker, input: TrackerInput, state: TrackerEvaluationState, starting: boolean): string | undefined {
  const session = input.state.session;
  if (!session || !validTimezone(session.timezone)) return undefined;
  const trackerConfig = record(tracker.config);
  const configuredSession = trackerConfig?.sessionId;
  if (typeof configuredSession === 'string' && configuredSession !== session.id) return undefined;
  if (number(trackerConfig?.startsAt) !== session.startsAt || number(trackerConfig?.endsAt) !== session.endsAt) return undefined;
  const boundaryKey = `${tracker.id}:${session.id}:${starting ? 'start' : 'end'}`;
  if (starting && input.timestamp >= session.startsAt && input.timestamp <= session.startsAt + 60_000 && !state.sessionStarts.has(boundaryKey)) {
    state.sessionStarts.add(boundaryKey);
    return `Session ${session.id} started (${session.timezone}).`;
  }
  if (!starting && input.timestamp >= session.endsAt && input.timestamp <= session.endsAt + 60_000 && !state.sessionEnds.has(boundaryKey)) {
    state.sessionEnds.add(boundaryKey);
    return `Session ${session.id} ended (${session.timezone}).`;
  }
  return undefined;
}

function evaluateScheduled(tracker: Tracker, input: TrackerInput, state: TrackerEvaluationState): string | undefined {
  const config = record(tracker.config);
  const everyMs = number(config?.everyMs);
  const last = state.lastSchedule.get(tracker.id);
  if (everyMs !== undefined && everyMs > 0) {
    if (last === undefined) { state.lastSchedule.set(tracker.id, input.timestamp); return undefined; }
    if (input.timestamp - last >= everyMs) { state.lastSchedule.set(tracker.id, input.timestamp); return `Scheduled interval (${everyMs}ms) elapsed.`; }
    return undefined;
  }
  const at = typeof config?.at === 'string' ? config.at : undefined;
  const timezone = typeof config?.timezone === 'string' ? config.timezone : undefined;
  if (!at || !timezone || !validTimezone(timezone) || !/^\d{2}:\d{2}$/.test(at)) return undefined;
  const [hour, minute] = at.split(':').map(Number);
  if (hour > 23 || minute > 59) return undefined;
  const currentMinute = Math.floor(input.timestamp / 60_000);
  const scheduledMinute = findLocalMinute(currentMinute, timezone, hour, minute);
  if (scheduledMinute === undefined || last === scheduledMinute) return undefined;
  state.lastSchedule.set(tracker.id, scheduledMinute);
  return `Scheduled wake at ${at} ${timezone}.`;
}

function findLocalMinute(currentMinute: number, timezone: string, hour: number, minute: number): number | undefined {
  for (let candidate = currentMinute - 2; candidate <= currentMinute; candidate += 1) {
    const date = new Date(candidate * 60_000);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    if (parts === `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`) return candidate;
  }
  return undefined;
}

function evaluateCustom(tracker: Tracker, input: TrackerInput): string | undefined {
  const data = record(input.state.eventData);
  const eventName = record(tracker.config)?.eventName;
  return input.type === 'CUSTOM' && typeof eventName === 'string' && data?.customTrackerName === eventName
    ? `Registered custom tracker observation ${eventName}.`
    : undefined;
}

function snapshot(tracker: Tracker, input: TrackerInput): TrackerObservationSnapshot {
  return {
    timestamp: input.timestamp,
    price: input.state.price ?? input.state.bars?.at(-1)?.close,
    spread: input.state.spread,
    indicators: computeConfiguredIndicators(record(tracker.config), input),
    barTime: input.state.bars?.at(-1)?.time,
    sessionId: input.state.session?.id,
    bars: input.state.bars,
  };
}

function timeframeBucket(timeSeconds: number, timeframe?: string): number | undefined {
  const seconds: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const duration = timeframe ? seconds[timeframe] : undefined;
  return duration ? Math.floor(timeSeconds / duration) : undefined;
}

function record(value: unknown): TrackerConfig | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as TrackerConfig : undefined;
}
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function validTimezone(value: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }
function assertNever(value: never): never { throw new Error(`Unsupported tracker kind: ${String(value)}`); }
