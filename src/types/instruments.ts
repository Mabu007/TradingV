import { AssetClass, MarketSnapshot, Timeframe } from './trading';

export type { AssetClass };

/**
 * The single canonical description of a tradable instrument.
 *
 * Every layer — discovery, execution guard, risk, sizing, and UI — reads
 * instrument facts from this model. Fields that the provider does not
 * expose stay `undefined`; they are never defaulted to a guessed value.
 *
 * Valuation contract:
 *   - `volume` everywhere in the app is provider instrument units.
 *   - P&L for a linear instrument is
 *       priceDistance x quantity x contractMultiplier x quoteToAccount
 *     where an undefined `contractMultiplier` means the provider's
 *     implicit linear multiplier of 1.
 */
export interface InstrumentMetadata {
  /** Display symbol used throughout the app (e.g. "EUR/USD", "Gold"). */
  symbol: string;

  displayName: string;

  assetClass: AssetClass;

  provider: 'HYPERLIQUID';

  /** Provider-qualified market name (e.g. "xyz:EUR"). Preserved verbatim. */
  providerSymbol: string;

  providerMarketId: string;

  providerDex?: string;

  /** Currency the provider quotes the instrument in. */
  quoteCurrency?: string;

  /** Base asset of the pair when the instrument is a pair. */
  baseCurrency?: string;

  /** Decimal places the provider quotes prices with. */
  pricePrecision?: number;

  /** Decimal places the provider accepts order sizes with (szDecimals). */
  sizePrecision?: number;

  /** Smallest size increment the provider accepts. */
  sizeStep?: number;

  /** Smallest tradable size, when the provider exposes one. */
  minOrderSize?: number;

  /** Largest tradable size, when the provider exposes one. */
  maxOrderSize?: number;

  /**
   * Price increment of one quote unit. Hyperliquid does not publish a
   * separate tick size, so this is derived from `pricePrecision` and is
   * a display/formatting aid rather than an exchange constraint.
   */
  tickSize?: number;

  /**
   * Value of one pip. Only defined for Forex pairs whose quote currency
   * is known, so pip maths can never silently run on Gold, Oil, or an
   * index.
   */
  pipSize?: number;

  /**
   * Units in one standard lot. Only defined for instruments that use
   * lot-based user sizing (Forex).
   */
  lotSize?: number;

  /** Units per contract, when the provider publishes one. */
  contractMultiplier?: number;

  /** Maximum leverage the provider publishes for this market. */
  maxLeverage?: number;
}

/**
 * A live price snapshot for an instrument.
 *
 * It *is* the canonical metadata plus the current prices (the snapshot
 * is always built from one metadata object), so a snapshot can never
 * disagree with the instrument it describes.
 */
export interface MarketSymbol extends InstrumentMetadata {
  lastPrice: number;
  change24h: number;
  high24h: number;
  low24h: number;
}

/**
 * Whether a discovered market can currently produce an executable quote.
 *
 * A market can exist in provider metadata and still be unavailable (for
 * example while the provider publishes a null price for it). Discovered
 * is not the same as tradeable.
 */
export type InstrumentAvailability = 'TRADEABLE' | 'UNAVAILABLE';

export interface InstrumentStatus {
  availability: InstrumentAvailability;
  /** User-safe explanation when the market is unavailable. */
  reason?: string;
}

/**
 * A discovered instrument: canonical metadata plus the platform's
 * runtime concerns (timeframes, activity, current tradeability, and its
 * price snapshot when one is available).
 */
export interface TradingInstrument extends InstrumentMetadata {
  id: string;
  supportedTimeframes: Timeframe[];
  active: boolean;
  availability: InstrumentAvailability;
  unavailableReason?: string;
  market?: MarketSymbol;
}

/** Read-only access to metadata by app symbol. */
export interface InstrumentLookup {
  get(symbol: string): InstrumentMetadata | undefined;
}

export type { MarketSnapshot };
