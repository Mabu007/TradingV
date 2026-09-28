/**
 * Structured rejections from the deterministic execution and risk
 * layers.
 *
 * Every rejection carries a machine-readable category plus a message
 * that is safe to show a user. Internal detail (a specific missing
 * price, an unconvertible currency) is kept separate and never
 * presented as the headline reason.
 *
 * The risk engine stays authoritative: an AI agent cannot downgrade,
 * ignore, or retry its way past a rejection.
 */

export type RejectionCategory =
  | 'KILL_SWITCH_ACTIVE'
  | 'ORDER_SIZE_INVALID'
  | 'MAX_POSITIONS_EXCEEDED'
  | 'EXPOSURE_LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'DAILY_LOSS_LIMIT'
  | 'UNKNOWN_INSTRUMENT'
  | 'MARKET_DATA_UNAVAILABLE'
  | 'PRICE_UNAVAILABLE'
  | 'RISK_UNVALUABLE'
  | 'INVALID_ORDER';

export interface ExecutionRejection {
  category: RejectionCategory;
  /** User-safe explanation. No stack traces, no internal identifiers. */
  message: string;
  /** Optional diagnostic detail for logs and the agent timeline. */
  detail?: string;
}

const MESSAGES: Record<RejectionCategory, string> = {
  KILL_SWITCH_ACTIVE:
    'Trading is halted by the emergency kill switch. Turn it off to resume.',
  ORDER_SIZE_INVALID:
    'That order size is not valid for this market. Check the allowed size and precision.',
  MAX_POSITIONS_EXCEEDED:
    'You already have the maximum number of open positions.',
  EXPOSURE_LIMIT_EXCEEDED:
    'Order blocked because it would exceed your configured exposure limit.',
  RATE_LIMITED:
    'Too many orders were submitted in the last minute. Wait a moment and try again.',
  DAILY_LOSS_LIMIT:
    'Trading is paused for today because the daily loss limit was reached.',
  UNKNOWN_INSTRUMENT:
    'That market is not available for trading.',
  MARKET_DATA_UNAVAILABLE:
    'Trading is temporarily blocked because reliable market data is unavailable.',
  PRICE_UNAVAILABLE:
    'No live price is available right now, so this order cannot be executed.',
  RISK_UNVALUABLE:
    'This order cannot be risk-checked right now, so it was blocked rather than approved on incomplete information.',
  INVALID_ORDER:
    'That order is not valid. Check the size and price levels.',
};

/** Build a rejection with the user-safe message for its category. */
export function rejection(
  category: RejectionCategory,
  detail?: string,
): ExecutionRejection {
  return {
    category,
    message: MESSAGES[category],
    ...(detail ? { detail } : {}),
  };
}

export function rejectionMessage(
  category: RejectionCategory,
): string {
  return MESSAGES[category];
}
