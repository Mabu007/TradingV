/**
 * Asset-agnostic position proximity maths for agent wake decisions.
 *
 * `STOP_APPROACHING` and `TARGET_APPROACHING` are *wake mechanisms*, not
 * execution decisions. They decide only whether it is worth spending an
 * agent investigation; they never place, resize, or approve an order,
 * and they never bypass the deterministic risk layer.
 *
 * Design rules:
 *
 *  - No Forex assumption anywhere. There is no 100000/10000/100 lot
 *    constant, no pip multiplier, no symbol-name heuristic, and no
 *    Gold-specific branch. A pip or tick distance is only honoured when
 *    the instrument's own metadata declares that size.
 *  - A threshold that cannot be expressed for the instrument is not
 *    approximated. The tracker simply does not report, which is the safe
 *    direction: no agent wake, no order, no invented distance.
 *  - An unavailable price is never treated as proximity. With no
 *    executable or mark price there is no distance, so nothing fires.
 *  - Thresholds may be expressed as absolute price distance, as a
 *    percentage of the current price, in metadata pip/tick units, or as
 *    a monetary distance in the account currency (which is what makes
 *    position quantity relevant without inventing a multiplier).
 */

import { InstrumentMetadata } from '../../../types/instruments';
import { valuePriceDistance } from '../../execution/valuation';

export type ProximityLevel = 'stopLoss' | 'takeProfit';

export interface ProximityPosition {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  currentPrice: number;
  volume?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ProximityConfig {
  /** Absolute price distance in the instrument's own quote currency. */
  withinPrice?: number;
  /** Distance in the instrument's own pip unit. Requires `pipSize`. */
  withinPips?: number;
  /** Distance in the instrument's own tick/price-increment unit. */
  withinTicks?: number;
  /** Distance as a percentage of the current price. */
  withinPercent?: number;
  /** Monetary distance remaining, in the account currency. */
  withinValue?: number;
}

export type ProximityLimit =
  | { kind: 'PRICE'; limit: number; distance: number; unit: string }
  | { kind: 'PIPS'; limit: number; distance: number; pipSize: number; unit: string }
  | { kind: 'TICKS'; limit: number; distance: number; tickSize: number; unit: string }
  | { kind: 'PERCENT'; limit: number; distance: number; unit: string }
  | { kind: 'VALUE'; limit: number; distance: number; unit: string };

export interface ProximityEvaluation {
  /** True only when every configured limit is met and measurable. */
  within: boolean;
  /** Why a configured limit could not be measured, when one could not. */
  unmeasurable?: string;
  /** Raw price distance between the current price and the level. */
  priceDistance?: number;
  /** Monetary distance remaining, when it could be valued. */
  valueDistance?: number;
  /** Limits that were measured, in configured order. */
  limits: ProximityLimit[];
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate how close a position is to one of its protective or profit
 * levels.
 *
 * `price` is the current executable/mark price for the instrument. When
 * it is missing or non-positive the evaluation reports "not within" and
 * measures nothing, because an unavailable price must never become a
 * distance.
 */
export function evaluateProximity(input: {
  position: ProximityPosition;
  level: ProximityLevel;
  config: ProximityConfig;
  instrument?: InstrumentMetadata;
  /** Current executable or mark price for the instrument. */
  price?: number;
  accountCurrency?: string;
}): ProximityEvaluation {
  const { position, level, config, instrument, accountCurrency } = input;
  const target = position[level];

  if (!nonNegative(target)) {
    return { within: false, limits: [] };
  }

  const price = positive(input.price)
    ? input.price
    : positive(position.currentPrice)
      ? position.currentPrice
      : undefined;

  if (price === undefined) {
    return {
      within: false,
      unmeasurable: 'No executable or mark price is available for this position.',
      limits: [],
    };
  }

  const priceDistance = Math.abs(price - target);
  const limits: ProximityLimit[] = [];
  const unmeasurable: string[] = [];

  if (nonNegative(config.withinPrice)) {
    limits.push({
      kind: 'PRICE',
      limit: config.withinPrice,
      distance: priceDistance,
      unit: 'price',
    });
  }

  if (nonNegative(config.withinPips)) {
    const pipSize = instrument?.pipSize;
    if (positive(pipSize)) {
      limits.push({
        kind: 'PIPS',
        limit: config.withinPips,
        distance: priceDistance / pipSize,
        pipSize,
        unit: 'pips',
      });
    } else {
      unmeasurable.push(
        'This instrument does not define a pip size, so a pip threshold cannot be measured for it.',
      );
    }
  }

  if (nonNegative(config.withinTicks)) {
    const tickSize = instrument?.tickSize;
    if (positive(tickSize)) {
      limits.push({
        kind: 'TICKS',
        limit: config.withinTicks,
        distance: priceDistance / tickSize,
        tickSize,
        unit: 'ticks',
      });
    } else {
      unmeasurable.push(
        'This instrument does not define a tick size, so a tick threshold cannot be measured for it.',
      );
    }
  }

  if (nonNegative(config.withinPercent)) {
    limits.push({
      kind: 'PERCENT',
      limit: config.withinPercent,
      distance: (priceDistance / price) * 100,
      unit: '%',
    });
  }

  let valueDistance: number | undefined;

  if (nonNegative(config.withinValue)) {
    const quantity = typeof position.volume === 'number' ? Math.abs(position.volume) : undefined;
    if (quantity === undefined || !Number.isFinite(quantity)) {
      unmeasurable.push(
        'Position quantity is unknown, so a monetary proximity threshold cannot be measured.',
      );
    } else {
      const valuation = valuePriceDistance({
        symbol: position.symbol,
        metadata: instrument,
        priceDistance,
        quantity,
        referencePrice: price,
        accountCurrency,
      });
      if (valuation.available && typeof valuation.value === 'number' && Number.isFinite(valuation.value)) {
        valueDistance = valuation.value;
        const unit = accountCurrency ?? (valuation.value === valuation.quoteValue ? 'quote currency' : 'account currency');
        limits.push({
          kind: 'VALUE',
          limit: config.withinValue,
          distance: valuation.value,
          unit,
        });
      } else {
        unmeasurable.push(
          valuation.reason ??
            'This position cannot be valued in the account currency, so a monetary proximity threshold cannot be measured.',
        );
      }
    }
  }

  if (limits.length === 0) {
    return {
      within: false,
      unmeasurable:
        unmeasurable[0] ?? 'No measurable proximity threshold is configured.',
      priceDistance,
      valueDistance,
      limits,
    };
  }

  /*
   * A threshold we cannot measure blocks the whole evaluation. A tracker
   * that is half-checked is worse than one that stays silent.
   */
  if (unmeasurable.length > 0) {
    return { within: false, unmeasurable: unmeasurable[0], priceDistance, valueDistance, limits };
  }

  return {
    within: limits.every((limit) => withinLimit(limit.distance, limit.limit)),
    priceDistance,
    valueDistance,
    limits,
  };
}

/**
 * Distance comparison with a relative tolerance.
 *
 * A price distance divided by a tick or pip size is binary floating
 * point arithmetic, so a position sitting exactly on the configured
 * threshold can land one ULP above it. The tolerance is relative to the
 * limit and far below any threshold that a trader would set, so it never
 * widens a band in a way that would change a decision.
 */
function withinLimit(distance: number, limit: number): boolean {
  if (limit === 0) return distance <= Number.EPSILON * Math.max(1, distance);
  return distance <= limit * (1 + 1e-9);
}

/**
 * Human-readable summary of a proximity evaluation, used as the tracker
 * wake reason. It states the measured distance in whatever units the
 * instrument actually supports.
 */
export function describeProximity(
  positionId: string,
  level: ProximityLevel,
  evaluation: ProximityEvaluation,
): string {
  const label = level === 'stopLoss' ? 'stop loss' : 'take profit';
  const parts: string[] = [];

  for (const limit of evaluation.limits) {
    const decimals = limit.kind === 'PRICE' ? undefined : limit.kind === 'VALUE' ? 2 : 1;
    const distance = decimals === undefined
      ? formatNumber(limit.distance, 6)
      : limit.distance.toFixed(decimals);
    parts.push(`${distance} ${limit.unit}`);
  }

  if (evaluation.valueDistance !== undefined) {
    parts.push(`${formatNumber(evaluation.valueDistance, 2)} of value at the level`);
  }

  return `Position ${positionId} is ${parts.join(', ')} from its ${label}.`;
}

function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '') || '0';
}
