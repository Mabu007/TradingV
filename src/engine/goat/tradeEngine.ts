/**
 * The trade engine.
 *
 * ## Where this sits
 *
 * ```
 *   TRACKER      what just happened in the market
 *      ↓
 *   EVIDENCE     recorded, attributed to a resolution
 *      ↓
 *   GOAT         what it believes and what it wants to trade  → Trade Plan
 *      ↓
 *   THIS FILE    is that plan executable? at what price? what is the risk?
 *      ↓
 *   RISK         approve, or refuse with a reason
 *      ↓
 *   ORDER        rest it, watch it, cancel or let it expire
 *      ↓
 *   POSITION     manage it until it closes
 *      ↓
 *   TRADE LOG    record what happened, so the GOAT can look for the next one
 * ```
 *
 * Everything below the GOAT is deterministic. That is the whole design: the model
 * proposes prices and this file decides whether they are coherent, whether they
 * are worth the risk, and when the order becomes a position. A GOAT that proposed
 * a stop on the wrong side of its entry is not wrong because the model was stupid —
 * it is wrong because that plan is not a trade, and saying so in code is more
 * reliable than hoping the model notices.
 *
 * ## Why limit orders are the default
 *
 * A GOAT's job in this product is to find the price at which a trade becomes
 * attractive. "Attractive" is almost never the current price: a breakout is
 * attractive on the retest, a range is attractive at its edge, a failed breakout
 * is attractive on the rejection. Filling a GOAT's idea at whatever the last close
 * happened to be throws away the part of its reasoning that had a price in it, and
 * reports a result the strategy never asked for.
 *
 * So an executable plan becomes a resting order, and the interesting question the
 * replay answers is whether price ever came to it — which is a real thing about
 * the market rather than an artefact of the harness.
 */

import type { TradeIdea } from './types';
import type { SimulatedOrder, SettledOrders } from './backtest/simulationEnvironment';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why an order is no longer resting. Distinct outcomes, not one "done". */
export type OrderOutcome =
  | { kind: 'PENDING' }
  | { kind: 'FILLED'; at: number; fillPrice: number }
  | { kind: 'EXPIRED'; at: number; reason: string }
  | { kind: 'CANCELLED'; at: number; reason: string }
  | { kind: 'REJECTED'; at: number; reason: string };

/**
 * One trade, from intention to result.
 *
 * This is the record the trade log shows and the trade detail opens. It is built
 * here rather than assembled in a view, because the sequence it describes —
 * proposed, ordered, waiting, filled, running, closed — happens over many bars and
 * no single component holds all of it.
 */
export interface TradeRecord {
  id: string;
  /** The GOAT trade plan this came from. */
  planId: string;
  goalId: string;
  agentId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  /** The GOAT's proposed entry. Not the same as what it got. */
  proposedEntry: number;
  /** The price it actually filled at, once it did. */
  fillPrice?: number;
  stopLoss: number;
  takeProfit?: number;
  /** Entry to stop, in price. Always positive. */
  riskDistance: number;
  /** Entry to target, in price. */
  rewardDistance?: number;
  /** reward / risk. Absent when there is no target. */
  riskReward?: number;
  /** Why this price, in the GOAT's words. Never parsed, only shown. */
  reason: string;
  /** What would make the thesis wrong, at the price level. */
  invalidation: string;
  status: TradeStatus;
  orderId?: string;
  positionId?: string;
  placedAt?: number;
  filledAt?: number;
  closedAt?: number;
  /** Seconds the order rested before filling. */
  secondsWaiting?: number;
  /** Seconds the position was open. */
  secondsHeld?: number;
  /** Timestamps above are milliseconds; the two durations above are seconds. */
  exitPrice?: number;
  /** Why it closed, in words. What a person reads. */
  exitReason?: string;
  /** The venue's own code for the exit. What machines and tests compare. */
  exitCode?: string;
  /**
   * Why this trade was refused, when it was.
   *
   * Kept on the record rather than only in a log line, because "why did the GOAT
   * not take this trade?" is a question the trade detail has to answer on its own.
   * A GOAT that never trades looks identical to a broken system until you can read
   * what it would have done and what stopped it.
   */
  rejectionReason?: string;
  pnl?: number;
  pnlPercent?: number;
  /** Price units for the instrument, when it has one. Never assumed to be pips. */
  distance?: number;
  distanceUnit?: string;
}

export type TradeStatus =
  | 'PROPOSED'
  | 'PENDING'
  | 'FILLED'
  | 'RUNNING'
  | 'TAKE_PROFIT'
  | 'STOPPED_OUT'
  | 'EXITED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REJECTED';

/** The deterministic verdict on a plan. The GOAT may not override it. */
export interface TradeDecision {
  approved: boolean;
  /**
   * Whether an order may actually be placed.
   *
   * Separate from `approved` because a shadow deployment can hold a perfectly
   * executable plan and still not be permitted to trade it. Collapsing the two
   * would either place orders a shadow deployment must not place, or report a
   * readable plan as a refusal and make the risk layer look broken.
   */
  canPlaceOrder: boolean;
  /** Plain words. Safe to show a user verbatim. */
  reason: string;
  /** The order the engine would place, when it approves one. */
  order?: ProposedOrder;
  /** The volume to trade, which only risk can decide. */
  volume?: number;
  metrics?: Record<string, number | string>;
}

export interface ProposedOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  volume: number;
  /** Seconds after placement at which the setup stops being interesting. */
  expiresInSeconds?: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Price validation
// ---------------------------------------------------------------------------

/**
 * The account and policy context a decision is made against.
 *
 * Deliberately narrow. Everything here is a fact the engine can check, so a
 * rejection can always be phrased as "this stop is on the wrong side of the
 * entry" rather than "the model seemed unsure".
 */
export interface TradeContext {
  symbol: string;
  /** The last traded price. A limit must be a real distance from it. */
  currentPrice: number;
  maxRiskFractionOfEquity: number;
  equity: number;
  /** Notional per unit of the instrument, for turning a price risk into money. */
  valuePerUnit: number;
  /** Whether this deployment is allowed to submit orders at all. */
  mayExecute: boolean;
  /** Maximum simultaneous positions for this strategy. One is the common case. */
  maxConcurrentPositions: number;
  /** Minimum acceptable reward-to-risk. Below it, the trade is not worth taking. */
  minRiskReward?: number;
}

/**
 * Decide whether a plan is an executable trade, and at what price.
 *
 * Pure. It reads a plan and a context and returns a verdict; it places nothing.
 * That is what makes it exhaustively testable — every rejection in this file is a
 * branch a test can reach without a market, a clock, or a model.
 *
 * The rejections are ordered from most to least fundamental, because the first
 * thing wrong with a plan is the most useful thing to say about it. A model that
 * inverted its stop has a bug; telling it "risk/reward is 0.4" would bury that.
 */
export function decideTrade(idea: TradeIdea, context: TradeContext): TradeDecision {
  const reject = (reason: string, metrics?: Record<string, number | string>): TradeDecision => ({
    approved: false,
    canPlaceOrder: false,
    reason,
    ...(metrics ? { metrics } : {}),
  });

  // 1. The market, checked against the deployment's own market.
  if (idea.symbol !== context.symbol) {
    return reject(
      `This plan prices ${idea.symbol}, but this deployment trades ${context.symbol}.`,
    );
  }

  // 2. Numbers that must be real numbers before anything is compared.
  const entry = idea.entry;
  const stop = idea.invalidationLevel;
  const target = idea.takeProfits[0]?.price;
  if (!Number.isFinite(entry) || entry <= 0) {
    return reject('The proposed entry is not a price.');
  }
  if (!Number.isFinite(stop) || stop <= 0) {
    return reject('The plan has no invalidation price, so there is nowhere for it to be wrong.');
  }

  const isLong = idea.direction === 'LONG';
  const side = isLong ? 'BUY' : 'SELL';

  // 3. The stop, on the correct side of the entry.
  //
  // This is the single most important check in the file, and the one a model is
  // most likely to get wrong: a long whose stop is above its entry is not a trade
  // with a wide stop, it is a trade that is wrong from the moment it fills.
  const riskDistance = isLong ? entry - stop : stop - entry;
  if (riskDistance <= 0) {
    return reject(
      `The stop at ${stop} is on the wrong side of a ${isLong ? 'long' : 'short'} entry at ${entry}. A ${side} stop must sit ${isLong ? 'below' : 'above'} the entry.`,
      { entry, stop, riskDistance },
    );
  }

  // 4. The target, if there is one.
  let rewardDistance: number | undefined;
  if (target !== undefined) {
    if (!Number.isFinite(target) || target <= 0) {
      return reject('The proposed target is not a price.');
    }
    rewardDistance = isLong ? target - entry : entry - target;
    if (rewardDistance <= 0) {
      return reject(
        `The target at ${target} is on the wrong side of a ${isLong ? 'long' : 'short'} entry at ${entry}. A ${side} target must sit ${isLong ? 'above' : 'below'} the entry.`,
        { entry, target, rewardDistance },
      );
    }
  }

  // 5. Reward-to-risk, against the strategy's own floor rather than a constant.
  const riskReward = rewardDistance !== undefined && riskDistance > 0 ? rewardDistance / riskDistance : undefined;
  if (riskReward !== undefined && rewardDistance !== undefined && context.minRiskReward !== undefined && riskReward < context.minRiskReward) {
    return reject(
      `The plan risks ${riskDistance.toFixed(6)} to make ${rewardDistance.toFixed(6)}, which is ${riskReward.toFixed(2)}× against a required minimum of ${context.minRiskReward}×.`,
      { riskDistance, rewardDistance, riskReward },
    );
  }

  // 6. A limit order that is already through the market is not a limit order.
  const wantsLimit = idea.orderType === 'LIMIT';
  if (wantsLimit && entry >= context.currentPrice && isLong) {
    return reject(
      `A BUY LIMIT at ${entry} is at or above the ${context.currentPrice} market, so it would fill immediately. Either wait for a better price or state that entering now is intended.`,
      { entry, currentPrice: context.currentPrice },
    );
  }
  if (wantsLimit && entry <= context.currentPrice && !isLong) {
    return reject(
      `A SELL LIMIT at ${entry} is at or below the ${context.currentPrice} market, so it would fill immediately. Either wait for a better price or state that entering now is intended.`,
      { entry, currentPrice: context.currentPrice },
    );
  }

  // 7. Sizing. Only risk decides volume, and it decides it from the stop the plan
  //    proposed — so a GOAT cannot quietly widen its risk by choosing a size.
  const riskBudget = context.equity * context.maxRiskFractionOfEquity;
  const riskPerUnit = riskDistance * context.valuePerUnit;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) {
    return reject('The risk at the proposed stop could not be valued for this instrument.');
  }
  const volume = riskBudget / riskPerUnit;
  if (!Number.isFinite(volume) || volume <= 0) {
    return reject(
      `Sizing this plan at ${riskBudget.toFixed(2)} of risk across ${riskDistance.toFixed(6)} per unit produced no usable size.`,
    );
  }

  const metrics: Record<string, number | string> = {
    entry,
    stop,
    riskDistance,
    dollarRisk: riskBudget,
    volumeUnits: volume,
    ...(target !== undefined && rewardDistance !== undefined ? { target, rewardDistance } : {}),
    ...(riskReward !== undefined ? { riskReward } : {}),
  };

  if (!context.mayExecute) {
    return {
      approved: true,
      canPlaceOrder: false,
      reason: 'The plan is executable, but this deployment is not permitted to place orders, so none was placed.',
      volume,
      metrics,
    };
  }

  return {
    approved: true,
    canPlaceOrder: true,
    reason:
      wantsLimit
        ? `A resting ${side} LIMIT at ${entry}, risking ${riskDistance.toFixed(6)} to the stop for ${rewardDistance !== undefined ? `${rewardDistance.toFixed(6)}` : 'an unspecified amount'} of reward.`
        : `A ${side} market entry at ${entry}, risking ${riskDistance.toFixed(6)} to the stop.`,
    volume,
    metrics,
    order: {
      symbol: context.symbol,
      side,
      type: wantsLimit ? 'LIMIT' : 'MARKET',
      entryPrice: entry,
      stopLoss: stop,
      ...(target !== undefined ? { takeProfit: target } : {}),
      volume,
      reason: idea.reasoning,
    },
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface TradeEngineDeps {
  /** The simulated book. Narrowed to what this engine needs, not the whole env. */
  book: TradeBook;
  context(): TradeContext;
  now(): number;
  /** Called for every lifecycle transition, so a session can log it once. */
  onTransition?(transition: TradeTransition): void;
}

/** The slice of the simulated book this engine drives. */
export interface TradeBook {
  /**
   * Fill now, at the market.
   *
   * Present because `orderType: 'MARKET'` is a real instruction and silently
   * turning it into a resting order would change the strategy's meaning: a
   * breakout GOAT that says "I want in now" would instead be left waiting for a
   * retest that may never come, and its results would be reported as though it
   * had been patient.
   */
  placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ success: boolean; positionId?: string; fillPrice?: number; error?: string }>;
  placeLimitOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    price: number;
    stopLoss?: number;
    takeProfit?: number;
    expiresAt?: number;
    idempotencyKey?: string;
    planId?: string;
    reason?: string;
    comment?: string;
  }): Promise<{ success: boolean; orderId?: string; error?: string }>;
  cancelOrder(orderId: string, reason?: string): Promise<{ success: boolean; error?: string }>;
  /**
   * Fill resting orders against the newest closed candle.
   *
   * Called by the engine rather than by a caller, because the order of the three
   * per-bar steps is a correctness property and not a stylistic choice.
   */
  settleOrders(): SettledOrders;
  /**
   * Mark open positions to the newest close and close any that hit a stop or a
   * target.
   *
   * On the engine's book this is the same call it always was; on a venue-backed
   * environment it is a no-op, because the venue has already done it.
   */
  settlePositions(): void;
  restingOrders(): SimulatedOrder[];
  orderForPlan(planId: string): SimulatedOrder | undefined;
  simulatedOrders(): SimulatedOrder[];
  openPositions(): Array<{ id: string; side: 'BUY' | 'SELL'; entryPrice: number; volume: number }>;
  /**
   * Realised trades, as the environment recorded them.
   *
   * Mirrors the domain `Trade` rather than restating a subset, so an engine can
   * never drift from the shape it is handed — a narrower local type would compile
   * happily against a superset and quietly lose fields.
   */
  simulatedTrades(): Array<{
    id: string;
    positionId?: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    entryPrice: number;
    exitPrice: number;
    entryTime: number;
    exitTime: number;
    pnl: number;
    pnlPercent: number;
    returnPercent: number;
    commission: number;
    exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL_CLOSE' | 'MANUAL';
  }>;
}

export interface TradeTransition {
  tradeId: string;
  planId: string;
  from: TradeStatus | undefined;
  to: TradeStatus;
  at: number;
  /** Present when there is a price worth reporting. */
  price?: number;
  reason?: string;
  pnl?: number;
}

/**
 * Holds the trades a GOAT has taken and drives their lifecycle.
 *
 * One engine per simulation. It is created when a replay starts and thrown away
 * when it stops, which is what makes "a new backtest has no trades from the last
 * one" true by construction rather than by remembering to clear something.
 */
export class TradeEngine {
  private readonly trades = new Map<string, TradeRecord>();
  private readonly byPlan = new Map<string, string>();
  private nextTradeNumber = 1;

  constructor(private readonly deps: TradeEngineDeps) {}

  /**
   * Evaluate a plan and, if it is executable, rest its order.
   *
   * Returns the decision rather than throwing. A rejected plan is a normal
   * outcome that the GOAT should be able to read and learn from, not an error.
   */
  async submit(plan: TradeIdea, goalId: string): Promise<TradeDecision> {
    // A plan is acted on once. A second call is answered with the decision that
    // was already made rather than placing a second order for one idea.
    const existingTradeId = this.byPlan.get(plan.id);
    if (existingTradeId !== undefined) {
      const existing = this.trades.get(existingTradeId);
      return {
        approved: true,
        canPlaceOrder: false,
        reason: `This plan is already live as ${existingTradeId} (${existing?.status ?? 'unknown'}).`,
      };
    }

    const decision = decideTrade(plan, this.deps.context());

    /*
     * A plan this deployment may not trade is not a rejected trade.
     *
     * It is a plan that was formed, checked, and then left alone — which is exactly
     * what a shadow deployment is for. Recording it as a refusal would put a red
     * risk line in the log for correct behaviour, and would number it as a trade so
     * the trade list claimed activity that never happened.
     */
    if (decision.approved && !decision.canPlaceOrder) return decision;

    const tradeId = `trade_${String(this.nextTradeNumber++).padStart(3, '0')}`;

    if (!decision.approved || !decision.order || decision.volume === undefined) {
      const trade: TradeRecord = {
        id: tradeId,
        planId: plan.id,
        goalId,
        agentId: plan.agentId,
        symbol: plan.symbol,
        side: plan.direction === 'LONG' ? 'BUY' : 'SELL',
        orderType: plan.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
        proposedEntry: plan.entry,
        stopLoss: plan.invalidationLevel,
        ...(plan.takeProfits[0]?.price !== undefined ? { takeProfit: plan.takeProfits[0].price } : {}),
        riskDistance: Math.abs(plan.entry - plan.invalidationLevel),
        reason: plan.reasoning,
        invalidation: plan.invalidation,
        status: 'REJECTED',
        rejectionReason: decision.reason,
      };
      this.trades.set(tradeId, trade);
      this.byPlan.set(plan.id, tradeId);
      this.transition(trade, 'REJECTED', { reason: decision.reason });
      return decision;
    }

    const order = decision.order;
    const trade: TradeRecord = {
      id: tradeId,
      planId: plan.id,
      goalId,
      agentId: plan.agentId,
      symbol: plan.symbol,
      side: order.side,
      orderType: order.type,
      proposedEntry: order.entryPrice,
      stopLoss: order.stopLoss,
      ...(order.takeProfit !== undefined ? { takeProfit: order.takeProfit } : {}),
      riskDistance: Math.abs(order.entryPrice - order.stopLoss),
      ...(order.takeProfit !== undefined
        ? { rewardDistance: Math.abs(order.takeProfit - order.entryPrice) }
        : {}),
      ...(order.takeProfit !== undefined && order.entryPrice !== order.stopLoss
        ? { riskReward: Math.abs(order.takeProfit - order.entryPrice) / Math.abs(order.entryPrice - order.stopLoss) }
        : {}),
      reason: order.reason,
      invalidation: plan.invalidation,
      status: 'PROPOSED',
    };

    // Concurrency is a strategy constraint, not an implementation detail.
    //
    // A GOAT that allows one position at a time must not end up holding two
    // because two trackers fired in the same bar. Refusing here, with the limit
    // quoted, keeps it a visible decision rather than an accident.
    const live = [...this.trades.values()].filter(
      (candidate) => candidate.status === 'PENDING' || candidate.status === 'RUNNING' || candidate.status === 'FILLED',
    );
    if (live.length >= this.deps.context().maxConcurrentPositions) {
      trade.status = 'CANCELLED';
      this.trades.set(tradeId, trade);
      this.byPlan.set(plan.id, tradeId);
      this.transition(trade, 'CANCELLED', {
        reason: `Already holding ${live.length} position${live.length === 1 ? '' : 's'}, which is this strategy's limit.`,
      });
      return { approved: false, canPlaceOrder: false, reason: `This strategy holds at most ${this.deps.context().maxConcurrentPositions} position at a time, and ${live.length === 1 ? 'one is' : `${live.length} are`} already live.` };
    }

    this.trades.set(tradeId, trade);
    this.byPlan.set(plan.id, tradeId);

    if (order.type === 'MARKET') {
      // Fill now, and report it as filled rather than pending — a market order has
      // no waiting state, and logging one would describe an order that cannot exist.
      const filled = await this.deps.book.placeMarketOrder({
        symbol: order.symbol,
        side: order.side,
        volume: decision.volume,
        stopLoss: order.stopLoss,
        ...(order.takeProfit !== undefined ? { takeProfit: order.takeProfit } : {}),
        comment: `GOAT trade ${tradeId}`,
      });
      if (!filled.success || !filled.positionId) {
        trade.status = 'REJECTED';
        trade.rejectionReason = filled.error ?? 'The book refused the order.';
        this.transition(trade, 'REJECTED', {
          reason: filled.error ?? 'The simulated book refused the order for an unstated reason.',
        });
        return { approved: false, canPlaceOrder: false, reason: filled.error ?? 'The order was refused.' };
      }
      trade.placedAt = this.deps.now();
      trade.filledAt = this.deps.now();
      trade.fillPrice = filled.fillPrice ?? order.entryPrice;
      trade.positionId = filled.positionId;
      this.transition(trade, 'FILLED', { price: trade.fillPrice, reason: 'Entered at the market.' });
      this.transition(trade, 'RUNNING', {
        price: trade.fillPrice,
        reason: `Managing an open ${trade.side === 'BUY' ? 'long' : 'short'} from ${trade.fillPrice}.`,
      });
      return decision;
    }

    const placed = await this.deps.book.placeLimitOrder({
      symbol: order.symbol,
      side: order.side,
      volume: decision.volume,
      price: order.entryPrice,
      stopLoss: order.stopLoss,
      ...(order.takeProfit !== undefined ? { takeProfit: order.takeProfit } : {}),
      planId: plan.id,
      // One plan, one order, whatever the transport does with retries.
      idempotencyKey: plan.id,
      reason: order.reason,
      comment: `GOAT trade ${tradeId}`,
    });

    if (!placed.success || !placed.orderId) {
      trade.status = 'REJECTED';
      trade.rejectionReason = placed.error ?? 'The book refused the order.';
      this.transition(trade, 'REJECTED', {
        reason: placed.error ?? 'The simulated book refused the order for an unstated reason.',
      });
      return { approved: false, canPlaceOrder: false, reason: placed.error ?? 'The order was refused.' };
    }

    trade.orderId = placed.orderId;
    trade.placedAt = this.deps.now();
    this.transition(trade, 'PENDING', {
      price: order.entryPrice,
      reason: `Waiting for price to reach ${order.entryPrice}.`,
    });
    return decision;
  }

  /**
   * Advance every live trade by one bar, in the only order that is honest.
   *
   *   1. **Fill resting orders.** An order can only fill on a price the market
   *      actually reached in this candle.
   *   2. **Settle positions.** A position opened or closed by this candle is
   *      marked against the same candle — which is what resolves a candle whose
   *      range spans both an entry and a stop, always against the trade.
   *   3. **Reconcile.** Now that the book has realised anything it closed, report
   *      it against the trade it belonged to.
   *
   * The third step has to come last, and getting it wrong is not a cosmetic bug:
   * reconciling before positions settle means every stop and every target is
   * reported one candle late, so a backtest shows trades still "running" against a
   * book that has already closed them, and the final bar's exits are never reported
   * at all.
   */
  settle(): void {
    const settled = this.deps.book.settleOrders();
    this.deps.book.settlePositions();
    this.reportOrderOutcomes(settled);
    this.settleClosedPositions(this.deps.now());
  }

  /**
   * Report what the book has closed since this was last called.
   *
   * Split out from `settle` so a caller that has just finalised the book — the end
   * of a replay, a stop, a refresh — can reconcile without advancing the market,
   * which would fill orders it is trying to close out.
   */
  reconcile(): void {
    this.settleClosedPositions(this.deps.now());
  }

  /** Report what the order book did with the orders that were resting. */
  private reportOrderOutcomes(settled: SettledOrders): void {

    for (const order of settled.expired) {
      const trade = this.tradeForOrder(order);
      if (!trade || trade.status !== 'PENDING') continue;
      this.transition(trade, 'EXPIRED', {
        reason: order.terminalReason ?? 'The price never came to the order.',
      });
    }

    for (const order of settled.filled) {
      const trade = this.tradeForOrder(order);
      if (!trade) continue;
      trade.fillPrice = order.fillPrice;
      /*
       * The book records its times in seconds; this record is in milliseconds,
       * like `placedAt` and every other timestamp in the application.
       *
       * Mixing the two is not a display bug: `secondsHeld` is a subtraction of one
       * against the other, so a mismatch produces a duration of a billion seconds
       * rather than an obviously wrong one.
       */
      trade.filledAt = order.filledAt !== undefined ? order.filledAt * 1000 : undefined;
      trade.positionId = order.positionId;
      // Both of these are the book's own seconds, so they are subtracted as they
      // are rather than converted.
      if (order.placedAt !== undefined && order.filledAt !== undefined) {
        trade.secondsWaiting = Math.max(0, order.filledAt - order.placedAt);
      }
      this.transition(trade, 'FILLED', { price: order.fillPrice, reason: 'The price came to the order.' });

      /*
       * A fill on the same candle that also touched the stop.
       *
       * OHLC cannot say which came first, and the position is now open, so the
       * position settle for this bar decides it. It checks the stop first, which
       * resolves the ambiguity against the trade. Recorded here as RUNNING rather
       * than left ambiguous, so the log shows the sequence even when the very next
       * transition is a stop-out.
       */
      this.transition(trade, 'RUNNING', {
        price: order.fillPrice,
        reason: `Managing an open ${trade.side === 'BUY' ? 'long' : 'short'} from ${order.fillPrice}.`,
      });
    }
  }

  /**
   * Close out positions that the market closed for us.
   *
   * The environment owns the fill accounting — it is the thing holding the
   * positions — so this reads its trades and reports them against the right
   * GOAT trade. Without this the log would show an order waiting forever after
   * the market had taken it out at the stop.
   */
  private settleClosedPositions(now: number): void {
    const closed = this.deps.book.simulatedTrades();
    for (const result of closed) {
      // A trade with no position id cannot be attributed to one of this GOAT's
      // positions. Skipped rather than guessed: attributing a closure to the
      // wrong trade would show a loss against a setup that never took it.
      if (result.positionId === undefined) continue;
      const trade = this.tradeForPosition(result.positionId);
      if (!trade || trade.status === 'STOPPED_OUT' || trade.status === 'TAKE_PROFIT' || trade.status === 'EXITED') {
        continue;
      }
      this.recordClosure(trade, {
        exitPrice: result.exitPrice,
        exitReason: result.exitReason,
        pnl: result.pnl,
        pnlPercent: result.pnlPercent,
        at: result.exitTime * 1000,
        now,
      });
    }
  }

  private recordClosure(
    trade: TradeRecord,
    outcome: {
      exitPrice: number;
      exitReason: string;
      pnl: number;
      pnlPercent: number;
      at: number;
      now: number;
    },
  ): void {
    trade.exitPrice = outcome.exitPrice;
    trade.exitCode = outcome.exitReason;
    trade.exitReason = humanExitReason(outcome.exitReason);
    trade.pnl = outcome.pnl;
    trade.pnlPercent = outcome.pnlPercent;
    trade.closedAt = outcome.at;
    if (trade.filledAt !== undefined) {
      trade.secondsHeld = Math.max(0, Math.round((outcome.at - trade.filledAt) / 1000));
    }

    const status: TradeStatus =
      outcome.exitReason === 'STOP_LOSS'
        ? 'STOPPED_OUT'
        : outcome.exitReason === 'TAKE_PROFIT'
          ? 'TAKE_PROFIT'
          : 'EXITED';

    this.transition(trade, status, { price: outcome.exitPrice, pnl: outcome.pnl, reason: trade.exitReason });
  }

  /**
   * Withdraw every resting order for a GOAT.
   *
   * Used when a refresh or a shutdown makes the setup meaningless. Open positions
   * are deliberately left alone: cancelling an order withdraws an intention, while
   * closing a position realises an outcome, and a system that conflated the two
   * could erase a loss by deciding not to look.
   */
  async cancelResting(reason: string): Promise<number> {
    let cancelled = 0;
    for (const order of this.deps.book.restingOrders()) {
      const result = await this.deps.book.cancelOrder(order.id, reason);
      if (!result.success) continue;
      const trade = this.tradeForOrder(order);
      if (trade && trade.status === 'PENDING') {
        this.transition(trade, 'CANCELLED', { reason });
      }
      cancelled += 1;
    }
    return cancelled;
  }

  /** Every trade, oldest first. */
  all(): TradeRecord[] {
    return [...this.trades.values()];
  }

  get(id: string): TradeRecord | undefined {
    return this.trades.get(id);
  }

  /** Trades that are waiting for a price or running a position. */
  live(): TradeRecord[] {
    return this.all().filter(
      (trade) => trade.status === 'PENDING' || trade.status === 'FILLED' || trade.status === 'RUNNING',
    );
  }

  private tradeForOrder(order: SimulatedOrder): TradeRecord | undefined {
    if (!order.planId) return undefined;
    const tradeId = this.byPlan.get(order.planId);
    return tradeId === undefined ? undefined : this.trades.get(tradeId);
  }

  private tradeForPosition(positionId: string): TradeRecord | undefined {
    return this.all().find(
      (trade) => trade.positionId === positionId && trade.status === 'RUNNING',
    );
  }

  private transition(
    trade: TradeRecord,
    to: TradeStatus,
    detail: { price?: number; reason?: string; pnl?: number } = {},
  ): void {
    const from = trade.status;
    trade.status = to;
    this.deps.onTransition?.({
      tradeId: trade.id,
      planId: trade.planId,
      from,
      to,
      at: this.deps.now(),
      ...(detail.price !== undefined ? { price: detail.price } : {}),
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
      ...(detail.pnl !== undefined ? { pnl: detail.pnl } : {}),
    });
  }
}

/** A venue's exit reason in words a person would use. */
function humanExitReason(exitReason: string): string {
  switch (exitReason) {
    case 'STOP_LOSS':
      return 'Price reached the stop, so the thesis was wrong.';
    case 'TAKE_PROFIT':
      return 'Price reached the target.';
    case 'MANUAL':
      return 'The GOAT closed this trade itself.';
    default:
      return `Closed by the venue (${exitReason}).`;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Trade statistics.
 *
 * Secondary to the timeline by design: a win rate over three trades is a
 * coincidence with a decimal point, and presenting it prominently is how a backtest
 * starts being believed. So this is derived on demand, never stored, and the
 * sample size is reported alongside the ratio so nobody has to guess what it rests
 * on.
 */
export interface TradeStatistics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate?: number;
  totalPnl: number;
  averageWin?: number;
  averageLoss?: number;
  profitFactor?: number;
  averageHoldSeconds?: number;
  largestWin?: number;
  largestLoss?: number;
  pending: number;
  filled: number;
  cancelled: number;
  expired: number;
  rejected: number;
  running: number;
}

export function tradeStatistics(trades: TradeRecord[]): TradeStatistics {
  const closed = trades.filter(
    (trade) => trade.status === 'TAKE_PROFIT' || trade.status === 'STOPPED_OUT' || trade.status === 'EXITED',
  );
  const wins = closed.filter((trade) => (trade.pnl ?? 0) > 0);
  const losses = closed.filter((trade) => (trade.pnl ?? 0) < 0);
  const breakeven = closed.length - wins.length - losses.length;

  const grossWin = wins.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0));
  const holds = closed.map((trade) => trade.secondsHeld).filter((value): value is number => typeof value === 'number');

  const count = (status: TradeStatus): number => trades.filter((trade) => trade.status === status).length;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    // Left undefined rather than 0 when nothing has closed: a 0% win rate over no
    // trades is a statement about the denominator, and showing one would imply a
    // measurement that was not taken.
    ...(closed.length > 0 ? { winRate: (wins.length / closed.length) * 100 } : {}),
    totalPnl: closed.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0),
    ...(wins.length > 0 ? { averageWin: grossWin / wins.length } : {}),
    ...(losses.length > 0 ? { averageLoss: grossLoss / losses.length } : {}),
    // Undefined when there were no losses, because "infinite" is not a number a
    // percentage column can honestly print.
    ...(grossLoss > 0 ? { profitFactor: grossWin / grossLoss } : {}),
    ...(holds.length > 0 ? { averageHoldSeconds: holds.reduce((a, b) => a + b, 0) / holds.length } : {}),
    ...(wins.length > 0 ? { largestWin: Math.max(...wins.map((trade) => trade.pnl ?? 0)) } : {}),
    ...(losses.length > 0 ? { largestLoss: Math.min(...losses.map((trade) => trade.pnl ?? 0)) } : {}),
    pending: count('PENDING'),
    filled: count('FILLED') + count('RUNNING') + count('TAKE_PROFIT') + count('STOPPED_OUT') + count('EXITED'),
    cancelled: count('CANCELLED'),
    expired: count('EXPIRED'),
    rejected: count('REJECTED'),
    running: count('RUNNING'),
  };
}