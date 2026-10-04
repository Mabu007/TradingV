/**
 * What every GOAT is allowed to read.
 *
 * A GOAT was previously granted tracker and thesis tools and nothing else,
 * so the agent it asked about a market was reasoning from nothing. That is
 * the same failure as inventing data, just slower: it produces confident
 * structure out of priors instead of out of candles.
 *
 * This list closes that gap, and it is deliberately a fixed allowlist
 * rather than a category:
 *
 *   Reading the market      market.*, structure.*, indicators.*
 *   Reading the account     account.get* (read-only)
 *   Asking about risk       risk.calculate*, risk.checkTrade, limits
 *
 * What is *not* here is the point of the file. No `orders.*`, no
 * `positions.modify*`, no `positions.close`, and nothing that can reach the
 * signing path. Order submission remains behind the deployment's execution
 * permissions and the runtime's own pre-flight validation, exactly as it
 * was before a GOAT could read a quote.
 *
 * So this widens what a GOAT can *know*, and does not widen what it can
 * *do*. A GOAT that has read equity, exposure and a stop distance can now
 * construct a risk-checked plan; it still cannot place one unless its
 * deployment says so, and a SHADOW deployment never does.
 */
export const GOAT_RESEARCH_CAPABILITIES: readonly string[] = [
  // The market itself.
  'market.getQuote',
  'market.getBars',
  'market.getSpread',
  'market.getSession',
  /*
   * What the venue publishes beyond price and candles.
   *
   * Added because funding, open interest and volume decide whether a move has
   * anything behind it, and a GOAT that cannot ask cannot reason about them.
   * It reports honestly when the venue publishes none of it, so this grants
   * the ability to find out — not a promise that the answer exists.
   */
  'market.getContext',

  // Deterministic structure, so the GOAT does not eyeball swings.
  'structure.swingHighs',
  'structure.swingLows',
  'structure.supportResistance',
  'structure.breakout',

  // Deterministic calculations, so the GOAT does not do arithmetic.
  'indicators.sma',
  'indicators.ema',
  'indicators.rsi',
  'indicators.atr',

  // The account, read-only.
  'account.getBalance',
  'account.getEquity',
  'account.getMargin',
  'account.getPositions',
  'account.getOrders',
  'account.getExposure',

  // Risk, as arithmetic rather than as an opinion.
  'risk.calculatePositionSize',
  'risk.calculateRisk',
  'risk.calculateExposure',
  'risk.checkTrade',
  'risk.getDailyLoss',
  'risk.getDrawdown',
];

/**
 * Capabilities that must never appear in the list above.
 *
 * Not enforced by this module — a list cannot police itself — but asserted
 * by the test suite, so that adding a trading capability to the research
 * set is a deliberate, visible act rather than an accident.
 */
export const GOAT_EXECUTION_CAPABILITIES: readonly string[] = [
  'orders.market',
  'orders.limit',
  'orders.cancel',
  'positions.modifyStopLoss',
  'positions.modifyTakeProfit',
  'positions.close',
  'positions.partialClose',
];
