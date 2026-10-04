/**
 * Tracker condition trees.
 *
 * A tracker may observe one parameter (`PRICE_CROSS` and friends, whose
 * parameters live in `Tracker.config`) or a whole tree of them. A tree is
 * the general form, and it is what the mental model teaches:
 *
 *   IF  <condition tree>  THEN  wake the GOAT
 *
 * A condition tree is a structured value, never a string. Leaves are
 * facts the runtime can already measure; groups combine them with
 * `AND` / `OR` / `NOT` to arbitrary depth.
 *
 * Constraints this module holds to:
 *
 *  - **Only real capabilities.** Every leaf maps onto a measurement the
 *    tracker evaluator already performs (price levels, indicator
 *    crossings, breakout, spread, volatility, position proximity, and the
 *    event/position/session/schedule kinds). No leaf invents an
 *    indicator or a data source.
 *  - **Read-only and side-effect free.** Evaluating a tree never places,
 *    modifies, or closes anything, and never mutates the input.
 *  - **No fabricated prices.** A leaf that cannot be measured reports
 *    `UNKNOWN`, not `false`, so an unavailable market can never be
 *    presented as a satisfied condition.
 *  - **A wake, not a trade.** `evaluateTrackerConditionTree` answers "should the
 *    GOAT be woken?" and nothing else. The agent, policy, risk, and the
 *    execution guard still run afterwards.
 *
 * ---------------------------------------------------------------------------
 * STATUS: BROWSER EVALUATOR, NOT THE CONDITION AUTHORITY
 *
 * This module and the Python engine are two evaluators, and the engine is
 * the authority. That was not obvious from the code, and the previous pass
 * reported it as an unqualified risk, so the actual arrangement is written
 * down here rather than left to be rediscovered.
 *
 * Who runs what:
 *
 *   - The **builder preview** ("Test this condition") calls the Python
 *     engine over HTTP. That is the engine, and it is authoritative.
 *   - The **tracker runtime** decides whether to wake a GOAT using *this*
 *     module, through `trackers/evaluator.ts`. It is not the engine.
 *
 * The two do not share a condition vocabulary, so they cannot simply
 * disagree about a shared condition:
 *
 *   - This module has a `CROSS` kind meaning "two indicators cross", and
 *     threshold kinds that are *level* tests ("at or above").
 *   - The schema has `CROSS_ABOVE` / `CROSS_BELOW` operators, which are
 *     *transition* tests, and they work on a threshold as well as on two
 *     indicators.
 *
 * An earlier version of this comment claimed a shared quote delivery id
 * starved a second agent's wake. Re-testing showed the per-tracker dedup
 * map in `trackers/runtime.ts` prevents that, so the claim was not real;
 * the id is still agent-scoped because an id ought to name one delivery.
 *
 * The consequence to keep in mind when editing here: a change to a
 * condition kind can change what an agent wakes for without changing what the
 * builder preview shows for the same tree, because the preview goes to the
 * engine. The parity tests in `conditions/parity` cover the kinds the
 * browser previews; a new kind that both sides support needs a case there.
 * ---------------------------------------------------------------------------
 */

import {
  calculateATR,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
} from '../../indicators';
import { valuePriceDistance } from '../../execution/valuation';
import { InstrumentMetadata } from '../../../types/instruments';
import type { TrackerObservation } from './types';

export type TrackerConditionOperator = 'AND' | 'OR' | 'NOT';

export type IndicatorKind = 'RSI' | 'SMA' | 'EMA' | 'ATR' | 'MACD';

export type TrackerCondition =
  | TrackerPriceLevelCondition
  | TrackerPriceCrossCondition
  | TrackerIndicatorThresholdCondition
  | TrackerIndicatorCrossCondition
  | TrackerBreakoutCondition
  | TrackerVolatilityCondition
  | TrackerSpreadCondition
  | TrackerProximityCondition
  | TrackerEventCondition;

export type TrackerConditionGroup = {
  id: string;
  kind: 'GROUP';
  operator: TrackerConditionOperator;
  children: TrackerConditionNode[];
  enabled?: boolean;
  label?: string;
};

export type TrackerConditionNode = TrackerCondition | TrackerConditionGroup;

export interface TrackerConditionBase {
  id: string;
  kind: string;
  enabled?: boolean;
  /** Optional user-facing label shown instead of the generated summary. */
  label?: string;
}

/* ------------------------------------------------------------------ *
 * Leaves
 * ------------------------------------------------------------------ */

export interface TrackerPriceLevelCondition extends TrackerConditionBase {
  kind: 'PRICE_LEVEL';
  /** `ABOVE` = price at or above the level, `BELOW` = at or below. */
  direction: 'ABOVE' | 'BELOW';
  level: number;
}

export interface TrackerPriceCrossCondition extends TrackerConditionBase {
  kind: 'PRICE_CROSS';
  direction: 'ABOVE' | 'BELOW';
  level: number;
}

export interface TrackerIndicatorThresholdCondition extends TrackerConditionBase {
  kind: 'INDICATOR_THRESHOLD';
  indicator: IndicatorKind;
  period: number;
  /** `BELOW` = indicator at or below the level, `ABOVE` = at or above. */
  direction: 'ABOVE' | 'BELOW';
  level: number;
  /** Only used by MACD, which has no single period. */
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  component?: 'macd' | 'signal' | 'histogram';
}

export interface TrackerIndicatorCrossCondition extends TrackerConditionBase {
  kind: 'INDICATOR_CROSS';
  direction: 'ABOVE' | 'BELOW';
  fast: { indicator: Exclude<IndicatorKind, 'MACD'>; period: number };
  slow: { indicator: Exclude<IndicatorKind, 'MACD'>; period: number };
}

export interface TrackerBreakoutCondition extends TrackerConditionBase {
  kind: 'BREAKOUT';
  direction: 'ABOVE' | 'BELOW';
  lookbackBars?: number;
  level?: number;
}

export interface TrackerVolatilityCondition extends TrackerConditionBase {
  kind: 'VOLATILITY';
  /** `ABOVE` = ATR at or above the threshold. */
  direction: 'ABOVE' | 'BELOW';
  period?: number;
  threshold: number;
}

export interface TrackerSpreadCondition extends TrackerConditionBase {
  kind: 'SPREAD';
  direction: 'ABOVE' | 'BELOW';
  maxSpread?: number;
  expansionPercent?: number;
}

/**
 * Distance from a position level.
 *
 * Thresholds are metadata-driven; see `engine/agents/trackers/proximity.ts`
 * for the measurement rules. A pip or tick threshold is only honoured when
 * the instrument declares that size.
 */
export interface TrackerProximityCondition extends TrackerConditionBase {
  kind: 'PROXIMITY';
  level: 'stopLoss' | 'takeProfit';
  withinPrice?: number;
  withinPips?: number;
  withinTicks?: number;
  withinPercent?: number;
  withinValue?: number;
}

export type PositionEventType =
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'POSITION_UPDATED'
  | 'ORDER_FILLED';

export interface TrackerEventCondition extends TrackerConditionBase {
  kind: 'EVENT';
  event: PositionEventType;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type TrackerConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN' | 'DISABLED';

export interface TrackerConditionResult {
  id: string;
  status: TrackerConditionStatus;
  summary: string;
  /** Current measured value, when one exists. */
  value?: number;
  /** The threshold it was compared against. */
  threshold?: number;
  unit?: string;
  /** Why the condition could not be measured. */
  reason?: string;
  children?: TrackerConditionResult[];
  operator?: TrackerConditionOperator;
}

export interface TrackerConditionTreeResult {
  status: Exclude<TrackerConditionStatus, 'DISABLED'>;
  results: TrackerConditionResult[];
  /** Every condition in the tree, flattened, for the "explain" view. */
  flat: TrackerConditionResult[];
}

export interface TrackerConditionTreeDefinition {
  name?: string;
  description?: string;
  timeframe?: string;
  root: TrackerConditionGroup;
  /** Minimum milliseconds between wakes. Applied by the engine. */
  cooldownMs?: number;
  /** Hard cap on wakes per minute. Applied by the engine. */
  maxWakesPerMinute?: number;
  /** Do not wake while the market is unavailable. */
  requireTradeableMarket?: boolean;
  /** Only evaluate on a closed bar of this timeframe. */
  barObservedOnly?: boolean;
}

/* ------------------------------------------------------------------ *
 * Catalogue (used by the builder UI)
 * ------------------------------------------------------------------ */

export interface TrackerConditionSpec {
  kind: TrackerCondition['kind'];
  label: string;
  category: string;
  /** True when the condition needs bars / an indicator. */
  needsBars: boolean;
  needsPosition: boolean;
  needsInstrument: boolean;
  create(): TrackerCondition;
}

export const TRACKER_CONDITION_CATALOGUE: TrackerConditionSpec[] = [
  { kind: 'PRICE_LEVEL', label: 'Price is above / below a level', category: 'Market price', needsBars: false, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'PRICE_LEVEL', direction: 'ABOVE', level: 0 }) },
  { kind: 'PRICE_CROSS', label: 'Price crosses a level', category: 'Market price', needsBars: false, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'PRICE_CROSS', direction: 'ABOVE', level: 0 }) },
  { kind: 'INDICATOR_THRESHOLD', label: 'Indicator above / below a level', category: 'Indicators', needsBars: true, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'INDICATOR_THRESHOLD', indicator: 'RSI', period: 14, direction: 'BELOW', level: 30 }) },
  { kind: 'INDICATOR_CROSS', label: 'Two indicators cross', category: 'Indicators', needsBars: true, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'INDICATOR_CROSS', direction: 'ABOVE', fast: { indicator: 'EMA', period: 20 }, slow: { indicator: 'SMA', period: 50 } }) },
  { kind: 'BREAKOUT', label: 'Breakout of the recent range', category: 'Market structure', needsBars: true, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'BREAKOUT', direction: 'ABOVE', lookbackBars: 20 }) },
  { kind: 'VOLATILITY', label: 'ATR volatility threshold', category: 'Market conditions', needsBars: true, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'VOLATILITY', direction: 'ABOVE', period: 14, threshold: 1 }) },
  { kind: 'SPREAD', label: 'Spread threshold', category: 'Market conditions', needsBars: false, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'SPREAD', direction: 'BELOW', maxSpread: 2 }) },
  { kind: 'PROXIMITY', label: 'Position near its stop or target', category: 'Position', needsBars: false, needsPosition: true, needsInstrument: true,
    create: (): TrackerCondition => ({ id: 'c', kind: 'PROXIMITY', level: 'stopLoss', withinPrice: 0.001 }) },
  { kind: 'EVENT', label: 'Position or order event', category: 'Events', needsBars: false, needsPosition: false, needsInstrument: false,
    create: (): TrackerCondition => ({ id: 'c', kind: 'EVENT', event: 'POSITION_OPENED' }) },
];

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export interface TrackerConditionContext {
  state: TrackerObservation;
  instrument?: InstrumentMetadata;
  /** Previous price, for crossing conditions. */
  previousPrice?: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a condition carries a direction this evaluator can read.
 *
 * `PROXIMITY` and `EVENT` are not directional, so they are exempt. Every
 * other leaf is, and an unreadable one must not fall through to the `else`
 * branch of a ternary and quietly mean the opposite of what was written.
 */
function hasReadableDirection(condition: TrackerCondition): boolean {
  if (condition.kind === 'PROXIMITY' || condition.kind === 'EVENT') return true;
  const direction = (condition as { direction?: unknown }).direction;
  return direction === 'ABOVE' || direction === 'BELOW';
}

/**
 * Two samples of a fast/slow pair, named so they cannot be mixed up.
 *
 * See `lastPair` for why this is an object and not a tuple.
 */
export interface CrossoverSamples {
  previous: { fast: number; slow: number };
  current: { fast: number; slow: number };
}

function withinTolerance(value: number, limit: number): boolean {
  if (limit === 0) return Math.abs(value) <= 1e-9;
  return Math.abs(value) <= limit * 1e-9 + 1e-12;
}

function currentPrice(context: TrackerConditionContext): number | undefined {
  const fromState = context.state.price;
  if (finite(fromState) && fromState > 0) return fromState;
  const lastBar = context.state.bars?.at(-1)?.close;
  return finite(lastBar) && lastBar > 0 ? lastBar : undefined;
}

function barCloses(context: TrackerConditionContext): number[] | undefined {
  const bars = context.state.bars;
  if (!bars || bars.length === 0) return undefined;
  if (
    !bars.every(
      (bar) =>
        [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
        bar.high >= bar.low,
    )
  ) {
    return undefined;
  }
  return bars.map((bar) => bar.close);
}

function atrSeries(context: TrackerConditionContext, period: number): number[] | undefined {
  const bars = context.state.bars;
  if (!bars || period < 1) return undefined;
  return calculateATR(
    bars as Array<{ time: number; open: number; high: number; low: number; close: number }>,
    period,
  );
}

function lastFinite(series: Array<number | null> | undefined): number | undefined {
  if (!series) return undefined;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index];
    if (finite(value)) return value;
  }
  return undefined;
}

function indicatorValue(
  condition: TrackerIndicatorThresholdCondition,
  context: TrackerConditionContext,
): { value?: number; reason?: string } {
  const closes = barCloses(context);
  if (!closes) return { reason: 'No usable price history for this market yet.' };

  const period = condition.period;

  if (!Number.isInteger(period) || period < 1) {
    return { reason: 'Indicator period must be a positive whole number.' };
  }

  switch (condition.indicator) {
    case 'RSI':
      return { value: lastFinite(calculateRSI(closes, period)) };
    case 'SMA':
      return { value: lastFinite(calculateSMA(closes, period)) };
    case 'EMA':
      return { value: lastFinite(calculateEMA(closes, period)) };
    case 'ATR':
      return { value: lastFinite(atrSeries(context, period)) };
    case 'MACD': {
      const fast = condition.fastPeriod ?? 12;
      const slow = condition.slowPeriod ?? 26;
      const signal = condition.signalPeriod ?? 9;
      if (fast >= slow) return { reason: 'MACD needs a fast period below its slow period.' };
      const macd = calculateMACD(closes, fast, slow, signal);
      const component = condition.component ?? 'macd';
      return { value: lastFinite(component === 'signal' ? macd.signal : component === 'histogram' ? macd.histogram : macd.macd) };
    }
    default:
      return { reason: 'Unsupported indicator.' };
  }
}

function positionFor(context: TrackerConditionContext) {
  const positions = context.state.positions ?? [];
  return positions.find((position) => position.symbol === context.state.symbol) ?? positions[0];
}

function evaluateLeaf(condition: TrackerCondition, context: TrackerConditionContext): TrackerConditionResult {
  /*
   * A direction nobody recognises is not "below".
   *
   * Every comparison in this switch reads `direction === 'ABOVE' ? ... :
   * ...`, so a model that authored `"above"` instead of `'ABOVE'` got the
   * opposite condition: a tracker written to wake when price rose through
   * a level watched for price falling through it instead, silently and
   * without ever reporting a problem. A directional condition whose
   * direction cannot be read has not been evaluated at all, and the only
   * honest answer to that is UNKNOWN.
   */
  if (!hasReadableDirection(condition)) {
    return {
      id: condition.id,
      status: 'UNKNOWN',
      summary: describeTrackerCondition(condition),
      reason: 'This condition has no readable direction, so it cannot be evaluated.',
    };
  }
  switch (condition.kind) {
    case 'PRICE_LEVEL': {
      const price = currentPrice(context);
      if (price === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No live price is available for this market.' };
      }
      if (!finite(condition.level)) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No level is set.' };
      }
      const satisfied = condition.direction === 'ABOVE'
        ? price >= condition.level
        : price <= condition.level;
      return {
        id: condition.id,
        status: satisfied ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        value: price,
        threshold: condition.level,
        unit: 'price',
      };
    }

    case 'PRICE_CROSS': {
      const price = currentPrice(context);
      const previous = context.previousPrice;
      if (price === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No live price is available for this market.' };
      }
      if (!finite(previous) || !finite(condition.level)) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'Waiting for a second price sample to detect a cross.' };
      }
      const crossed = condition.direction === 'ABOVE'
        ? previous < condition.level && price >= condition.level
        : previous > condition.level && price <= condition.level;
      return {
        id: condition.id,
        status: crossed ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        value: price,
        threshold: condition.level,
        unit: 'price',
      };
    }

    case 'INDICATOR_THRESHOLD': {
      const { value, reason } = indicatorValue(condition, context);
      if (value === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: reason ?? 'Indicator is not available yet.' };
      }
      if (!finite(condition.level)) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No level is set.' };
      }
      const satisfied = condition.direction === 'ABOVE'
        ? value >= condition.level
        : value <= condition.level;
      return {
        id: condition.id,
        status: satisfied ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        value,
        threshold: condition.level,
        unit: condition.indicator,
      };
    }

    case 'INDICATOR_CROSS': {
      const closes = barCloses(context);
      if (!closes) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No usable price history for this market yet.' };
      }
      const fast = seriesFor(condition.fast, closes);
      const slow = seriesFor(condition.slow, closes);
      if (fast === undefined || slow === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'Indicators are not available yet.' };
      }
      const pair = lastPair(fast, slow);
      if (!pair) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'Waiting for two indicator samples to detect a cross.' };
      }
      const crossed = condition.direction === 'ABOVE'
        ? pair.previous.fast <= pair.previous.slow && pair.current.fast > pair.current.slow
        : pair.previous.fast >= pair.previous.slow && pair.current.fast < pair.current.slow;
      return {
        id: condition.id,
        status: crossed ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        value: pair.current.fast - pair.current.slow,
      };
    }

    case 'BREAKOUT': {
      const bars = context.state.bars;
      const price = currentPrice(context);
      if (!bars || bars.length < 2 || price === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'Not enough closed candles to measure a range.' };
      }
      if (finite(condition.level)) {
        const above = condition.direction === 'ABOVE' ? price >= condition.level : price <= condition.level;
        return { id: condition.id, status: above ? 'TRUE' : 'FALSE', summary: describeTrackerCondition(condition), value: price, threshold: condition.level, unit: 'price' };
      }
      const lookback = Number.isInteger(condition.lookbackBars) ? Math.max(1, Math.min(condition.lookbackBars as number, 500)) : 20;
      if (bars.length < lookback + 1) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: `Needs ${lookback + 1} candles; ${bars.length} available.` };
      }
      const reference = bars.slice(-(lookback + 1), -1);
      const boundary = condition.direction === 'ABOVE'
        ? Math.max(...reference.map((bar) => bar.high))
        : Math.min(...reference.map((bar) => bar.low));
      const broken = condition.direction === 'ABOVE' ? price > boundary : price < boundary;
      return { id: condition.id, status: broken ? 'TRUE' : 'FALSE', summary: describeTrackerCondition(condition), value: price, threshold: boundary, unit: 'price' };
    }

    case 'VOLATILITY': {
      const { value, reason } = indicatorValue(
        {
          id: condition.id,
          kind: 'INDICATOR_THRESHOLD',
          indicator: 'ATR',
          period: condition.period ?? 14,
          direction: 'ABOVE',
          level: Number.NaN,
        },
        context,
      );
      if (value === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: reason ?? 'ATR is not available yet.' };
      }
      const satisfied = condition.direction === 'ABOVE'
        ? value >= condition.threshold
        : value <= condition.threshold;
      return { id: condition.id, status: satisfied ? 'TRUE' : 'FALSE', summary: describeTrackerCondition(condition), value, threshold: condition.threshold, unit: 'ATR' };
    }

    case 'SPREAD': {
      const spread = context.state.spread;
      if (!finite(spread)) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No spread is available for this market.' };
      }
      if (finite(condition.maxSpread)) {
        const satisfied = condition.direction === 'BELOW' ? spread <= condition.maxSpread : spread >= condition.maxSpread;
        return { id: condition.id, status: satisfied ? 'TRUE' : 'FALSE', summary: describeTrackerCondition(condition), value: spread, threshold: condition.maxSpread, unit: 'price' };
      }
      if (finite(condition.expansionPercent)) {
        const prior = context.state.indicators?.spread;
        if (!finite(prior) || prior <= 0) {
          return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'Waiting for a second spread sample.' };
        }
        const expanded = spread >= prior * (1 + condition.expansionPercent / 100);
        return { id: condition.id, status: expanded ? 'TRUE' : 'FALSE', summary: describeTrackerCondition(condition), value: spread, threshold: condition.expansionPercent, unit: '%' };
      }
      return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No spread threshold is set.' };
    }

    case 'PROXIMITY': {
      const position = positionFor(context);
      if (!position) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No open position for this market.' };
      }
      const target = position[condition.level];
      if (!finite(target)) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: `This position has no ${condition.level === 'stopLoss' ? 'stop loss' : 'take profit'}.` };
      }
      const price = finite(position.currentPrice) && position.currentPrice > 0
        ? position.currentPrice
        : currentPrice(context);
      if (price === undefined) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No live price is available for this market.' };
      }
      const distance = Math.abs(price - target);
      const checks: Array<{ limit: number; value: number; unit: string }> = [];
      /*
       * A threshold that cannot be measured blocks the evaluation.
       *
       * `proximity.ts` already fails closed this way for the kind-based
       * path. This one used to skip the unmeasurable thresholds and judge
       * the condition on whatever was left, so a PROXIMITY leaf on gold —
       * which has no pip size — configured "within 50 pips OR within 6
       * price units" was reported TRUE on the price test alone. That is
       * UNKNOWN being laundered into a positive, and it is the exact
       * disagreement between the two proximity implementations that made
       * it invisible: the tracker woke on a weaker question than the one
       * it was asked.
       */
      const unmeasurable: string[] = [];

      if (finite(condition.withinPrice)) checks.push({ limit: condition.withinPrice, value: distance, unit: 'price' });
      if (finite(condition.withinPips)) {
        const pipSize = context.instrument?.pipSize;
        if (finite(pipSize) && pipSize > 0) checks.push({ limit: condition.withinPips, value: distance / pipSize, unit: 'pips' });
        else unmeasurable.push('pips (this market has no pip size)');
      }
      if (finite(condition.withinTicks)) {
        const tickSize = context.instrument?.tickSize;
        if (finite(tickSize) && tickSize > 0) checks.push({ limit: condition.withinTicks, value: distance / tickSize, unit: 'ticks' });
        else unmeasurable.push('ticks (this market has no tick size)');
      }
      if (finite(condition.withinPercent)) checks.push({ limit: condition.withinPercent, value: (distance / price) * 100, unit: '%' });
      if (finite(condition.withinValue)) {
        if (finite(position.volume)) {
          const valuation = valuePriceDistance({
            symbol: position.symbol,
            metadata: context.instrument,
            priceDistance: distance,
            quantity: Math.abs(position.volume),
            referencePrice: price,
          });
          if (valuation.available && finite(valuation.value)) {
            checks.push({ limit: condition.withinValue, value: valuation.value, unit: 'USD' });
          } else {
            unmeasurable.push('account value (this position cannot be valued)');
          }
        } else {
          unmeasurable.push('account value (this position has no usable volume)');
        }
      }

      if (checks.length === 0) {
        return { id: condition.id, status: 'UNKNOWN', summary: describeTrackerCondition(condition), reason: 'No measurable threshold is configured for this instrument.' };
      }
      if (unmeasurable.length > 0) {
        return {
          id: condition.id,
          status: 'UNKNOWN',
          summary: describeTrackerCondition(condition),
          reason: `This market cannot express the distance in ${unmeasurable.join(' or ')}.`,
        };
      }

      const failed = checks.find((check) => !withinTolerance(check.value, check.limit) && check.value > check.limit);
      const satisfied = failed === undefined;

      return {
        id: condition.id,
        status: satisfied ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        value: checks[0].value,
        threshold: checks[0].limit,
        unit: checks[0].unit,
      };
    }

    case 'EVENT': {
      const observed = readEventType(context);
      const satisfied = observed === condition.event;
      return {
        id: condition.id,
        status: satisfied ? 'TRUE' : 'FALSE',
        summary: describeTrackerCondition(condition),
        reason: satisfied ? undefined : `Waiting for ${labelForEvent(condition.event)}.`,
      };
    }

    default: {
      const unknown = condition as TrackerCondition;
      return { id: (unknown as TrackerConditionBase).id ?? 'unknown', status: 'UNKNOWN', summary: describeTrackerCondition(unknown), reason: 'Unsupported condition.' };
    }
  }
}

function seriesFor(
  spec: { indicator: Exclude<IndicatorKind, 'MACD'>; period: number },
  closes: number[],
): Array<number | null> | undefined {
  const { indicator, period } = spec;
  if (!Number.isInteger(period) || period < 1) return undefined;
  if (indicator === 'RSI') return calculateRSI(closes, period);
  if (indicator === 'SMA') return calculateSMA(closes, period);
  if (indicator === 'EMA') return calculateEMA(closes, period);
  return undefined;
}

/**
 * The last two samples of a fast and a slow series, named.
 *
 * This returns a named pair rather than a positional tuple on purpose.
 * A tuple can be destructured in the wrong order and TypeScript will not
 * complain, because all four elements are `number`. The original bug was
 * exactly that: the helper produced `[fast[n-1], fast[n-2], slow[n-1],
 * slow[n-2]]` and the caller read it as
 * `[previousFast, previousSlow, currentFast, currentSlow]`, so it
 * compared the fast series against itself and the slow series against
 * itself, and reported FALSE at the one bar a cross happens on.
 *
 * With named fields, `pair.previous.fast` cannot be confused with
 * `pair.current.slow`, so a future edit has to be deliberate to repeat
 * the mistake. `auditRegressionTests.ts` pins the specific bar.
 */
function lastPair(
  fast: Array<number | null>,
  slow: Array<number | null>,
): CrossoverSamples | undefined {
  const length = Math.min(fast.length, slow.length);
  if (length < 2) return undefined;

  const current = { fast: fast[length - 1], slow: slow[length - 1] };
  const previous = { fast: fast[length - 2], slow: slow[length - 2] };

  if (!finite(current.fast) || !finite(current.slow) || !finite(previous.fast) || !finite(previous.slow)) {
    return undefined;
  }
  return {
    previous: { fast: previous.fast as number, slow: previous.slow as number },
    current: { fast: current.fast as number, slow: current.slow as number },
  };
}

function readEventType(context: TrackerConditionContext): string | undefined {
  const data = context.state.eventData;
  if (data && typeof data === 'object' && 'type' in data) {
    return String((data as { type: unknown }).type);
  }
  return undefined;
}

function labelForEvent(event: PositionEventType): string {
  switch (event) {
    case 'POSITION_OPENED': return 'a position to open';
    case 'POSITION_CLOSED': return 'a position to close';
    case 'POSITION_UPDATED': return 'a position update';
    default: return 'an order fill';
  }
}

/**
 * Evaluate one node.
 *
 * `UNKNOWN` is contagious upward in a way that cannot be satisfied: an
 * unknown child makes an `AND` unknown, and makes an `OR` unknown unless
 * another child is definitively `TRUE`.
 */
function evaluateNode(node: TrackerConditionNode, context: TrackerConditionContext): TrackerConditionResult {
  if (node.kind === 'GROUP') {
    if (node.enabled === false) {
      return { id: node.id, status: 'DISABLED', summary: 'Disabled group', operator: node.operator, children: [] };
    }
    const children = node.children.map((child) => evaluateNode(child, context));
    const active = children.filter(
      (child): child is TrackerConditionResult & { status: Exclude<TrackerConditionStatus, 'DISABLED'> } =>
        child.status !== 'DISABLED',
    );
    const status = combine(node.operator, active.map((child) => child.status));
    return {
      id: node.id,
      status,
      summary: node.operator,
      operator: node.operator,
      children,
    };
  }

  if (node.enabled === false) {
    return { id: node.id, status: 'DISABLED', summary: describeTrackerCondition(node) };
  }

  return evaluateLeaf(node, context);
}

function combine(
  operator: TrackerConditionOperator,
  statuses: Array<Exclude<TrackerConditionStatus, 'DISABLED'>>,
): Exclude<TrackerConditionStatus, 'DISABLED'> {
  if (statuses.length === 0) return 'UNKNOWN';

  switch (operator) {
    case 'AND':
      if (statuses.some((status) => status === 'FALSE')) return 'FALSE';
      if (statuses.some((status) => status === 'UNKNOWN')) return 'UNKNOWN';
      return 'TRUE';
    case 'OR':
      if (statuses.some((status) => status === 'TRUE')) return 'TRUE';
      if (statuses.some((status) => status === 'UNKNOWN')) return 'UNKNOWN';
      return 'FALSE';
    case 'NOT': {
      const only = statuses[0];
      if (only === 'TRUE') return 'FALSE';
      if (only === 'FALSE') return 'TRUE';
      return 'UNKNOWN';
    }
    default:
      return 'UNKNOWN';
  }
}

function flatten(results: TrackerConditionResult[], into: TrackerConditionResult[] = []): TrackerConditionResult[] {
  for (const result of results) {
    into.push(result);
    if (result.children) flatten(result.children, into);
  }
  return into;
}

/**
 * Evaluate a whole tree.
 *
 * `status === 'TRUE'` is the only state that wakes the AI.
 */
export function evaluateTrackerConditionTree(
  root: TrackerConditionGroup,
  context: TrackerConditionContext,
): TrackerConditionTreeResult {
  const evaluated = evaluateNode(root, context);
  const results = evaluated.children ?? [];
  return {
    status: evaluated.status as Exclude<TrackerConditionStatus, 'DISABLED'>,
    results,
    flat: flatten(results),
  };
}

/* ------------------------------------------------------------------ *
 * Human-readable description
 * ------------------------------------------------------------------ */

const INDICATOR_LABELS: Record<IndicatorKind, string> = {
  RSI: 'RSI',
  SMA: 'SMA',
  EMA: 'EMA',
  ATR: 'ATR',
  MACD: 'MACD',
};

export function formatNumber(value: number, decimals = 2): string {
  if (!finite(value)) return '?';
  return value
    .toFixed(decimals)
    .replace(/\.?0+$/, '')
    .replace(/^-0$/, '0') || '0';
}

/** One-line, non-technical description of a leaf condition. */
export function describeTrackerCondition(condition: TrackerCondition): string {
  switch (condition.kind) {
    case 'PRICE_LEVEL':
      return `Price is ${condition.direction === 'ABOVE' ? 'at or above' : 'at or below'} ${formatNumber(condition.level, 6)}`;
    case 'PRICE_CROSS':
      return `Price crosses ${condition.direction === 'ABOVE' ? 'above' : 'below'} ${formatNumber(condition.level, 6)}`;
    case 'INDICATOR_THRESHOLD':
      return `${INDICATOR_LABELS[condition.indicator]}(${condition.period}) is ${condition.direction === 'ABOVE' ? 'at or above' : 'at or below'} ${formatNumber(condition.level, 2)}`;
    case 'INDICATOR_CROSS':
      return `${INDICATOR_LABELS[condition.fast.indicator]}(${condition.fast.period}) crosses ${condition.direction === 'ABOVE' ? 'above' : 'below'} ${INDICATOR_LABELS[condition.slow.indicator]}(${condition.slow.period})`;
    case 'BREAKOUT':
      return condition.level !== undefined
        ? `Price breaks ${condition.direction === 'ABOVE' ? 'above' : 'below'} ${formatNumber(condition.level, 6)}`
        : `Price breaks ${condition.direction === 'ABOVE' ? 'above' : 'below'} the last ${condition.lookbackBars ?? 20} candles`;
    case 'VOLATILITY':
      return `ATR volatility is ${condition.direction === 'ABOVE' ? 'at or above' : 'at or below'} ${formatNumber(condition.threshold, 4)}`;
    case 'SPREAD':
      return condition.maxSpread !== undefined
        ? `Spread is ${condition.direction === 'BELOW' ? 'at or below' : 'at or above'} ${formatNumber(condition.maxSpread, 6)}`
        : `Spread expands by at least ${formatNumber(condition.expansionPercent ?? 0, 1)}%`;
    case 'PROXIMITY': {
      const target = condition.level === 'stopLoss' ? 'stop loss' : 'take profit';
      const parts: string[] = [];
      if (finite(condition.withinPrice)) parts.push(`${formatNumber(condition.withinPrice, 6)} price units`);
      if (finite(condition.withinPips)) parts.push(`${formatNumber(condition.withinPips, 1)} pips`);
      if (finite(condition.withinTicks)) parts.push(`${formatNumber(condition.withinTicks, 1)} ticks`);
      if (finite(condition.withinPercent)) parts.push(`${formatNumber(condition.withinPercent, 2)}%`);
      if (finite(condition.withinValue)) parts.push(`${formatNumber(condition.withinValue, 2)} USD of value`);
      return `Position is within ${parts.join(' and ') || 'an unconfigured distance'} of its ${target}`;
    }
    case 'EVENT':
      return `On ${labelForEvent(condition.event)}`;
    default:
      return 'Unsupported condition';
  }
}

/**
 * "IF … THEN wake the GOAT" summary, rendered as a single sentence.
 *
 * Groups are shown with parentheses so nesting stays readable.
 */
export function summariseTrackerTree(
  root: TrackerConditionGroup,
  options: { symbol?: string; timeframe?: string } = {},
): string {
  const subject = options.symbol ? `${options.symbol} ` : '';
  const timeframe = options.timeframe ? ` on ${options.timeframe}` : '';
  return `IF ${subject}${summariseTrackerNode(root)}${timeframe} THEN wake the GOAT`;
}

export function summariseTrackerNode(node: TrackerConditionNode): string {
  if (node.kind !== 'GROUP') {
    return node.enabled === false ? `${describeTrackerCondition(node)} (off)` : describeTrackerCondition(node);
  }

  const children = node.children.filter((child) => child !== undefined);

  if (node.operator === 'NOT') {
    return `NOT (${children.length === 1 ? summariseTrackerNode(children[0]) : children.map(summariseTrackerNode).join(' OR ')})`;
  }

  if (children.length === 0) return 'no conditions';

  const joiner = node.operator === 'AND' ? ' AND ' : ' OR ';
  const joined = children.map(summariseTrackerNode).join(joiner);

  return children.length > 1 ? `(${joined})` : joined;
}

/* ------------------------------------------------------------------ *
 * Tree construction helpers (used by the builder)
 * ------------------------------------------------------------------ */

let idCounter = 0;

export function conditionId(prefix = 'cond'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeGroup(
  operator: TrackerConditionOperator = 'AND',
  children: TrackerConditionNode[] = [],
): TrackerConditionGroup {
  return { id: conditionId('group'), kind: 'GROUP', operator, children };
}

export function makeCondition(spec: TrackerConditionSpec): TrackerCondition {
  const created = spec.create();
  return { ...created, id: conditionId() } as TrackerCondition;
}

export function isGroup(node: TrackerConditionNode): node is TrackerConditionGroup {
  return node.kind === 'GROUP';
}

/** Depth-first walk, used by the editor to renumber and re-key. */
export function walkTree(
  node: TrackerConditionNode,
  visit: (node: TrackerConditionNode, depth: number, parent?: TrackerConditionGroup) => void,
  depth = 0,
  parent?: TrackerConditionGroup,
): void {
  visit(node, depth, parent);
  if (isGroup(node)) {
    for (const child of node.children) walkTree(child, visit, depth + 1, node);
  }
}

export function countConditions(root: TrackerConditionGroup): number {
  let count = 0;
  walkTree(root, (node) => {
    if (!isGroup(node)) count += 1;
  });
  return count;
}

export function countGroups(root: TrackerConditionGroup): number {
  let count = 0;
  walkTree(root, (node) => {
    if (isGroup(node)) count += 1;
  });
  return count;
}

/** Structural validation. Returns every problem, not just the first. */
export function validateTrackerConditionTree(root: TrackerConditionGroup): string[] {
  const problems: string[] = [];

  walkTree(root, (node) => {
    if (isGroup(node)) {
      if (node.operator === 'NOT' && node.children.length > 1) {
        problems.push('A NOT group must contain exactly one condition.');
      }
      if (node.children.length === 0) {
        problems.push('An empty group cannot be evaluated. Add a condition or remove it.');
      }
      if (node.operator !== 'NOT' && node.children.length === 1) {
        problems.push(`A group with one condition does not need ${node.operator}. Use the condition directly.`);
      }
      return;
    }

    if (node.kind === 'INDICATOR_THRESHOLD') {
      if (!Number.isInteger(node.period) || node.period < 1) {
        problems.push('Indicator period must be a whole number of at least 1.');
      }
      if (!finite(node.level)) {
        problems.push('This indicator condition has no level.');
      }
    }
    if (node.kind === 'VOLATILITY') {
      if (node.period !== undefined && (!Number.isInteger(node.period) || node.period < 1)) {
        problems.push('ATR period must be a whole number of at least 1.');
      }
      if (!finite(node.threshold)) {
        problems.push('This volatility condition has no threshold.');
      }
    }
    if (node.kind === 'PRICE_LEVEL' || node.kind === 'PRICE_CROSS') {
      if (!finite(node.level) || node.level <= 0) {
        problems.push('A price level must be greater than zero.');
      }
    }
    if (node.kind === 'SPREAD' && !finite(node.maxSpread) && !finite(node.expansionPercent)) {
      problems.push('A spread condition needs a maximum spread or an expansion percentage.');
    }
    if (node.kind === 'PROXIMITY') {
      const configured = [node.withinPrice, node.withinPips, node.withinTicks, node.withinPercent, node.withinValue].some(finite);
      if (!configured) {
        problems.push('A position condition needs at least one distance threshold.');
      }
    }
    if (node.kind === 'BREAKOUT' && !finite(node.level) && !Number.isInteger(node.lookbackBars ?? 20)) {
      problems.push('A breakout needs either a level or a lookback.');
    }
  });

  if (countConditions(root) === 0) {
    problems.push('Add at least one condition.');
  }

  return Array.from(new Set(problems));
}
