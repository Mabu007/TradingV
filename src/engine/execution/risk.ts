import { MarketOrderRequest, Position, RiskLimits } from '../../types/trading';
import { InstrumentLookup } from '../../types/instruments';
import { eventBus } from '../../types/events';
import { ACCOUNT_CURRENCY, aggregateExposure } from './valuation';
import { ExecutionRejection, rejection } from './errors';

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  /*
   * Order size limits are expressed in provider instrument units, so
   * they are not tied to a Forex lot. Their numeric defaults still
   * reflect the original Forex sizing policy and are expected to be
   * configured per account.
   */
  maxOrderSize: 100000,       // Max instrument units per single order
  maxOpenPositions: 5,        // Max 5 concurrent positions
  /*
   * Primary and only exposure cap: notional in the account currency,
   * summed across every open position and every asset class.
   */
  maxExposureNotional: 250000,
  maxOrdersPerMinute: 20,     // Rate limit
  maxDailyLoss: 1000,         // Max $1,000 daily loss
  killSwitchActive: false,
};

/** Everything risk needs to value a mixed-asset book. */
export interface RiskValuationContext {
  accountCurrency?: string;
  instruments?: InstrumentLookup;
  /** Latest price per symbol; falls back to the position's own price. */
  referencePrices?: Record<string, number>;
}

export class RiskManager {
  private limits: RiskLimits;
  private recentOrderTimestamps: number[] = [];
  private currentDailyPnL: number = 0;

  constructor(initialLimits: Partial<RiskLimits> = {}) {
    this.limits = { ...DEFAULT_RISK_LIMITS, ...initialLimits };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  updateLimits(newLimits: Partial<RiskLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
  }

  setKillSwitch(active: boolean): void {
    this.limits.killSwitchActive = active;
    eventBus.emit({
      type: 'STATUS_CHANGE',
      data: {
        mode: 'ALL',
        status: active ? 'KILL_SWITCH_ENGAGED' : 'NORMAL',
        message: active ? 'Emergency Kill Switch ACTIVATED — All order requests blocked' : 'Kill Switch deactivated',
      },
    });
  }

  recordPnL(pnlChange: number): void {
    this.currentDailyPnL += pnlChange;
  }

  resetDailyLoss(): void {
    this.currentDailyPnL = 0;
  }

  /**
   * Deterministic order gate.
   *
   * `reason` stays the technical text for logs; `rejection` carries the
   * category and the user-safe message.
   */
  validateOrder(
    order: MarketOrderRequest,
    openPositions: Position[],
    recordAcceptedOrder: boolean = true,
    context?: RiskValuationContext,
  ): { valid: boolean; reason?: string; rejection?: ExecutionRejection } {
    const now = Date.now();

    // 1. Kill Switch Check
    if (this.limits.killSwitchActive) {
      const reason = 'Emergency Kill Switch is currently ACTIVE. All trading orders rejected.';
      this.notifyViolation('KILL_SWITCH', reason);
      return { valid: false, reason };
    }

    // 2. Max Single Order Size (instrument units of this market)
    if (order.volume > this.limits.maxOrderSize) {
      const detail = `Order volume ${order.volume.toLocaleString()} exceeds maximum allowed size of ${this.limits.maxOrderSize.toLocaleString()} units.`;
      this.notifyViolation('MAX_ORDER_SIZE', detail);
      return { valid: false, reason: detail, rejection: rejection('ORDER_SIZE_INVALID', detail) };
    }

    // 3. Max Concurrent Open Positions
    if (openPositions.length >= this.limits.maxOpenPositions) {
      const detail = `Maximum open positions limit (${this.limits.maxOpenPositions}) reached. Close an existing position first.`;
      this.notifyViolation('MAX_OPEN_POSITIONS', detail);
      return { valid: false, reason: detail, rejection: rejection('MAX_POSITIONS_EXCEEDED', detail) };
    }

    // 4. Exposure, valued in the account currency so quantities from
    //    different asset classes are never compared to each other.
    const exposure = this.validateExposure(order, openPositions, context);

    if (!exposure.valid) {
      const detail = exposure.reason ?? 'Exposure limit exceeded.';
      this.notifyViolation(exposure.category ?? 'MAX_EXPOSURE', detail);
      return {
        valid: false,
        reason: detail,
        rejection: rejection(
          exposure.category ?? 'EXPOSURE_LIMIT_EXCEEDED',
          detail,
        ),
      };
    }

    // 5. Rate Limiting (Orders Per Minute)
    const oneMinuteAgo = now - 60000;
    this.recentOrderTimestamps = this.recentOrderTimestamps.filter((t) => t > oneMinuteAgo);
    if (this.recentOrderTimestamps.length >= this.limits.maxOrdersPerMinute) {
      const detail = `Rate limit exceeded: More than ${this.limits.maxOrdersPerMinute} orders submitted within 60 seconds.`;
      this.notifyViolation('RATE_LIMIT', detail);
      return { valid: false, reason: detail, rejection: rejection('RATE_LIMITED', detail) };
    }

    // 6. Max Daily Loss
    if (this.currentDailyPnL <= -this.limits.maxDailyLoss) {
      const detail = `Daily loss limit of $${this.limits.maxDailyLoss} reached (current daily P&L: $${this.currentDailyPnL.toFixed(2)}). Trading locked for today.`;
      this.notifyViolation('DAILY_LOSS_LIMIT', detail);
      return { valid: false, reason: detail, rejection: rejection('DAILY_LOSS_LIMIT', detail) };
    }

    if (recordAcceptedOrder) this.recentOrderTimestamps.push(now);
    return { valid: true };
  }

  /**
   * Exposure gate.
   *
   * Every leg (open positions plus this order) is valued in the account
   * currency and the notionals are summed, so gold units and EUR units
   * are never added together as if they were the same quantity.
   *
   * When a leg cannot be valued at all - no price, or a quote currency
   * that cannot be converted - the order is rejected rather than
   * approved against a partial picture.
   */
  private validateExposure(
    order: MarketOrderRequest,
    openPositions: Position[],
    context?: RiskValuationContext,
  ): {
    valid: boolean;
    reason?: string;
    category?: 'EXPOSURE_LIMIT_EXCEEDED' | 'MARKET_DATA_UNAVAILABLE' | 'RISK_UNVALUABLE';
  } {
    const accountCurrency = context?.accountCurrency ?? ACCOUNT_CURRENCY;
    const lookup = context?.instruments;
    const referencePriceFor = (
      symbol: string,
      fallback?: number,
    ): number | undefined =>
      context?.referencePrices?.[symbol] ?? fallback;

    const summary = aggregateExposure(
      [
        ...openPositions.map((position) => ({
          symbol: position.symbol,
          quantity: Math.abs(position.volume),
          metadata: lookup?.get(position.symbol),
          referencePrice: referencePriceFor(
            position.symbol,
            position.currentPrice || position.entryPrice,
          ),
        })),
        {
          symbol: order.symbol,
          quantity: Math.abs(order.volume),
          metadata: lookup?.get(order.symbol),
          referencePrice: referencePriceFor(order.symbol),
        },
      ],
      accountCurrency,
    );

    if (!summary.complete) {
      return {
        valid: false,
        category: 'MARKET_DATA_UNAVAILABLE',
        reason: `Exposure cannot be valued for ${summary.unresolved.join(', ')}. Order rejected rather than compared across instruments.`,
      };
    }

    const limit = this.limits.maxExposureNotional;

    if (typeof limit === 'number' && summary.total > limit) {
      return {
        valid: false,
        category: 'EXPOSURE_LIMIT_EXCEEDED',
        reason: `Order would raise total exposure to $${summary.total.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${accountCurrency}, exceeding the $${limit.toLocaleString()} notional limit.`,
      };
    }

    return { valid: true };
  }

  private notifyViolation(rule: string, message: string): void {
    eventBus.emit({
      type: 'RISK_VIOLATION',
      data: {
        rule,
        message,
        timestamp: Date.now(),
      },
    });
  }
}

export const riskManager = new RiskManager();
