/**
 * The execution boundary.
 *
 * Everything that can send an order to a venue goes through this
 * interface, and the engine only ever sees the interface. That matters
 * for a specific reason: when real API keys arrive, the code that
 * handles them is the code that handles money, and it has to be small
 * enough to review. Keeping the venue out of the engine means the money
 * path is one adapter, not a `if (mode === 'DEMO')` scattered through
 * the agent runtime.
 *
 * The contract every implementation must honour:
 *
 *  - **`idempotencyKey` is mandatory and must be forwarded.** A retry
 *    with the same key must not produce a second order. The interface
 *    makes it required rather than optional so no implementation can
 *    quietly skip it.
 *  - **A timeout is not a failure of the order.** The exchange may have
 *    accepted it. `UNKNOWN` exists for exactly that, and an adapter that
 *    maps a timeout to `REJECTED` is a bug.
 *  - **Refusals are categories, not strings.** See `errors.ts`.
 *  - **Credentials are never in the request object.** They are fetched
 *    from a `CredentialStore` inside the adapter, immediately before the
 *    call, and never returned, logged, or stored on the result.
 */

import { TradingGOATsError } from './errors';

export type ExecutionMode = 'DEMO' | 'LIVE';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'market' | 'limit';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  /** Provider instrument units, not notional. The adapter converts. */
  volume: number;
  type: OrderType;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Required. Stable across retries of the same intent, and different
   * for a genuinely new trade.
   */
  idempotencyKey: string;
  /** The wake that caused this, for tracing. Not used for deduplication. */
  wakeId?: string;
  goatId?: string;
  deploymentId?: string;
  /** The configuration version that produced the decision. */
  configVersion?: number;
}

/**
 * What happened to the order.
 *
 * `UNKNOWN` is the load-bearing member. It is not an error state: it
 * means the request may or may not have reached the exchange, and the
 * correct response is to query by idempotency key, not to resubmit. A
 * system with only ACCEPTED and REJECTED cannot express "the response was
 * lost", and that is the situation that produces duplicate orders.
 */
export type OrderOutcome = 'ACCEPTED' | 'FILLED' | 'REJECTED' | 'UNKNOWN';

export interface OrderResult {
  outcome: OrderOutcome;
  /** Present when the venue returned an identifier. */
  orderId?: string;
  positionId?: string;
  /** Present when the order filled. */
  fillPrice?: number;
  filledVolume?: number;
  /** Why it was rejected, when it was. A category, not a sentence. */
  rejection?: TradingGOATsError;
  /**
   * Whether the venue's answer is final.
   *
   * `UNKNOWN` results are not final: the caller must reconcile. This flag
   * exists so "keep polling" and "give up" are distinguishable.
   */
  final: boolean;
  /**
   * Whether it is safe to retry with the same idempotency key.
   *
   * True for a network failure before the venue could have acted, and
   * for an explicit rate limit. False once the venue may have accepted.
   */
  safeToRetry: boolean;
}

export interface PositionSnapshot {
  id: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnlPercent: number;
  timestamp: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  /** Realised plus unrealised for the current day. Not open P&L. */
  dailyPnL: number | null;
  drawdownPercent: number | null;
}

export interface ExecutionAdapter {
  /** Which mode this adapter trades in. Read by the UI; never a toggle. */
  readonly mode: ExecutionMode;

  /**
   * Whether this adapter can trade at all right now.
   *
   * A LIVE adapter with no configured credential is not "LIVE but
   * failing", it is DEMO-capable only. Reporting that honestly is what
   * stops the UI from telling a user their bot is live when it is not.
   */
  ready(): Promise<{ ready: boolean; reason?: string }>;

  placeOrder(request: OrderRequest): Promise<OrderResult>;

  cancelOrder(orderId: string): Promise<{ cancelled: boolean; reason?: string }>;

  /**
   * Ask the venue about an order whose response was lost.
   *
   * This is the counterpart to `safeToRetry`. Reconciliation by
   * idempotency key is how a timeout is resolved without a second order.
   */
  reconcile(request: Pick<OrderRequest, 'idempotencyKey' | 'symbol'>): Promise<OrderResult>;

  getPositions(symbol?: string): Promise<PositionSnapshot[]>;

  getAccount(): Promise<AccountSnapshot>;

  closePosition(positionId: string, volume?: number, context?: { idempotencyKey: string; wakeId?: string }): Promise<OrderResult>;
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/**
 * Reject a request the adapter must not attempt.
 *
 * A missing idempotency key is the one mistake that cannot be made safe
 * later, so it is refused at the boundary rather than defaulted.
 */
export function assertExecutable(request: OrderRequest): void {
  if (!request.idempotencyKey) {
    throw new Error('An order request must carry an idempotencyKey. See idempotencyKeyFor().');
  }
  if (!Number.isFinite(request.volume) || request.volume <= 0) {
    throw new Error('Order volume must be a positive number.');
  }
  if (request.type === 'limit' && (!Number.isFinite(request.limitPrice) || (request.limitPrice as number) <= 0)) {
    throw new Error('A limit order requires a positive limitPrice.');
  }
}

/**
 * Build the result for a request that never reached the venue.
 *
 * `safeToRetry` is true here and only here: nothing could have acted on
 * it. Everything downstream distinguishes this from an `UNKNOWN` that
 * followed a sent request.
 */
export function notAttempted(error: TradingGOATsError, context: OrderRequest): OrderResult {
  return {
    outcome: 'UNKNOWN',
    rejection: error,
    final: false,
    safeToRetry: true,
    orderId: undefined,
    ...(context.wakeId ? { positionId: undefined } : {}),
  };
}
