import { InstrumentLookup, InstrumentMetadata } from '../../types/instruments';

/**
 * Valuation core.
 *
 * Every monetary number in TradingVibe is derived here so that P&L,
 * risk, exposure, and margin use one model for Forex, commodities, and
 * indices alike.
 *
 * The model is deliberately data-driven:
 *
 *   value (account currency)
 *     = quantity x price x contractMultiplier x quoteToAccount
 *
 * - `contractMultiplier` is 1 for providers that quote linearly
 *   (Hyperliquid does), and is never invented when unknown.
 * - `quoteToAccount` is derived from instrument metadata and the live
 *   reference price. When the conversion cannot be established from
 *   data we have, the result is reported as unavailable rather than
 *   approximated with a hardcoded FX rate.
 */

export const ACCOUNT_CURRENCY = 'USD';

/**
 * Leverage used only by the DEMO account projection when the provider
 * did not publish leverage for a market. It is an approximation of a
 * demo balance sheet, not a Hyperliquid margin requirement.
 */
export const DEMO_FALLBACK_LEVERAGE = 10;

export interface QuantityValuation {
  symbol: string;
  quantity: number;
  referencePrice?: number;
  multiplier: number;
  conversionFactor?: number;
  /** Value denominated in the instrument's quote currency. */
  quoteValue?: number;
  /** Value denominated in the account currency. */
  value?: number;
  available: boolean;
  /**
   * True when the value is denominated in the instrument's own quote
   * currency because instrument metadata was unavailable, so no
   * conversion to the account currency could be established.
   */
  assumedQuoteCurrency?: boolean;
  reason?: string;
}

/** Linear providers (Hyperliquid) size positions in quoted units. */
export function effectiveMultiplier(metadata?: InstrumentMetadata): number {
  const multiplier = metadata?.contractMultiplier;
  return typeof multiplier === 'number' && multiplier > 0 ? multiplier : 1;
}

/**
 * Exact conversion factor from the instrument's quote currency into the
 * account currency, or undefined when it cannot be established.
 *
 * Two cases are provable from instrument metadata plus a live price:
 *  - the instrument is quoted directly in the account currency (factor 1);
 *  - the account currency is the pair's base currency, so the live price
 *    is account-per-base and its reciprocal converts quote to account
 *    (for example USD/JPY quoted at 157.33 -> 1 JPY = 1/157.33 USD).
 *
 * No rate is ever hardcoded.
 */
export function quoteToAccountFactor(
  metadata: InstrumentMetadata | undefined,
  referencePrice: number | undefined,
  accountCurrency: string = ACCOUNT_CURRENCY,
): number | undefined {
  /*
   * No metadata at all: the price distance cannot be converted, but it
   * is still expressed in the instrument's own quote currency. Callers
   * are told this explicitly instead of being handed an invented rate.
   */
  if (!metadata) return undefined;

  const quoteCurrency = metadata.quoteCurrency;

  if (!quoteCurrency) return undefined;

  if (quoteCurrency === accountCurrency) return 1;

  if (
    metadata.baseCurrency === accountCurrency &&
    typeof referencePrice === 'number' &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0
  ) {
    return 1 / referencePrice;
  }

  return undefined;
}

/**
 * True when an instrument declares a quote currency that cannot be
 * expressed in the account currency from metadata alone.
 *
 * It is structural: it does not depend on a price being available.
 */
function isUnconvertible(
  metadata: InstrumentMetadata | undefined,
  accountCurrency: string,
): boolean {
  if (!metadata) return false;

  const quoteCurrency = metadata.quoteCurrency;

  if (!quoteCurrency) return true;

  if (quoteCurrency === accountCurrency) return false;

  return metadata.baseCurrency !== accountCurrency;
}

/** Value of a position quantity in account currency. */
export function valueQuantity(input: {
  symbol: string;
  metadata?: InstrumentMetadata;
  quantity: number;
  referencePrice?: number;
  accountCurrency?: string;
}): QuantityValuation {
  const accountCurrency = input.accountCurrency ?? ACCOUNT_CURRENCY;
  const multiplier = effectiveMultiplier(input.metadata);
  const conversionFactor = quoteToAccountFactor(
    input.metadata,
    input.referencePrice,
    accountCurrency,
  );

  if (
    typeof input.quantity !== 'number' ||
    !Number.isFinite(input.quantity)
  ) {
    return {
      symbol: input.symbol,
      quantity: Number(input.quantity) || 0,
      multiplier,
      available: false,
      reason: 'Quantity is not a finite number.',
    };
  }

  if (
    typeof input.referencePrice !== 'number' ||
    !Number.isFinite(input.referencePrice) ||
    input.referencePrice <= 0
  ) {
    return {
      symbol: input.symbol,
      quantity: input.quantity,
      multiplier,
      available: false,
      reason: 'No usable reference price for this instrument.',
    };
  }

  const quoteValue = input.referencePrice * input.quantity * multiplier;

  if (conversionFactor === undefined) {
    if (isUnconvertible(input.metadata, accountCurrency)) {
      return {
        symbol: input.symbol,
        quantity: input.quantity,
        referencePrice: input.referencePrice,
        multiplier,
        quoteValue,
        available: false,
        reason: `Cannot express ${input.metadata?.quoteCurrency ?? 'an unknown quote currency'} in ${accountCurrency} from available market data.`,
      };
    }

    return {
      symbol: input.symbol,
      quantity: input.quantity,
      referencePrice: input.referencePrice,
      multiplier,
      quoteValue,
      value: quoteValue,
      available: true,
      assumedQuoteCurrency: true,
      reason:
        'Instrument metadata is unavailable; notional is denominated in the instrument quote currency.',
    };
  }

  return {
    symbol: input.symbol,
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    multiplier,
    conversionFactor,
    quoteValue,
    value: quoteValue * conversionFactor,
    available: true,
  };
}

/**
 * Value a price *distance* (a move, a stop distance, a P&L) in the
 * account currency.
 *
 *   distance x quantity x contractMultiplier x quoteToAccount
 *
 * `referencePrice` is only used to establish the quote-to-account
 * conversion; it is not part of the distance.
 */
export function valuePriceDistance(input: {
  symbol: string;
  metadata?: InstrumentMetadata;
  priceDistance: number;
  quantity: number;
  referencePrice?: number;
  accountCurrency?: string;
}): QuantityValuation {
  const accountCurrency = input.accountCurrency ?? ACCOUNT_CURRENCY;
  const multiplier = effectiveMultiplier(input.metadata);
  const conversionFactor = quoteToAccountFactor(
    input.metadata,
    input.referencePrice,
    accountCurrency,
  );

  if (
    !Number.isFinite(input.priceDistance) ||
    !Number.isFinite(input.quantity)
  ) {
    return {
      symbol: input.symbol,
      quantity: input.quantity,
      multiplier,
      available: false,
      reason: 'Price distance or quantity is not a finite number.',
    };
  }

  const quoteValue =
    input.priceDistance * input.quantity * multiplier;

  if (conversionFactor === undefined) {
    /*
     * The instrument's quote currency is known but cannot be expressed
     * in the account currency from available data. Refuse rather than
     * inventing a rate.
     */
    if (isUnconvertible(input.metadata, accountCurrency)) {
      return {
        symbol: input.symbol,
        quantity: input.quantity,
        referencePrice: input.referencePrice,
        multiplier,
        quoteValue,
        available: false,
        reason: `Cannot express ${input.metadata?.quoteCurrency ?? 'an unknown quote currency'} in ${accountCurrency} from available market data.`,
      };
    }

    /*
     * No instrument metadata at all (for example a simulation
     * environment). The amount stays in the instrument's quote currency
     * and is flagged as such; execution paths that trade real markets
     * always resolve metadata first.
     */
    return {
      symbol: input.symbol,
      quantity: input.quantity,
      referencePrice: input.referencePrice,
      multiplier,
      quoteValue,
      value: quoteValue,
      available: true,
      assumedQuoteCurrency: true,
      reason:
        'Instrument metadata is unavailable; the amount is denominated in the instrument quote currency.',
    };
  }

  return {
    symbol: input.symbol,
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    multiplier,
    conversionFactor,
    quoteValue,
    value: quoteValue * conversionFactor,
    available: true,
  };
}

/**
 * Loss incurred when a protective stop at `stopLoss` is hit, expressed in
 * the account currency.
 */
export function riskToStop(input: {
  symbol: string;
  metadata?: InstrumentMetadata;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  accountCurrency?: string;
}): QuantityValuation & { priceDistance: number } {
  const priceDistance = Math.abs(input.entryPrice - input.stopLoss);

  const valuation = valuePriceDistance({
    symbol: input.symbol,
    metadata: input.metadata,
    priceDistance,
    quantity: input.quantity,
    referencePrice: input.entryPrice,
    accountCurrency: input.accountCurrency,
  });

  return { ...valuation, priceDistance };
}

export interface ExposureLeg {
  symbol: string;
  quantity: number;
  metadata?: InstrumentMetadata;
  referencePrice?: number;
}

export interface ExposureSummary {
  /** Total exposure in the account currency, counting only valued legs. */
  total: number;
  /** True when every leg could be valued in the account currency. */
  complete: boolean;
  /** Symbols that could not be valued, so callers can fail safely. */
  unresolved: string[];
  legs: QuantityValuation[];
}

/**
 * Aggregate exposure across instruments of different asset classes.
 *
 * Quantities of unrelated instruments (gold units, EUR units, index
 * points) are never added together. Each leg is valued in the account
 * currency first and the notionals are summed.
 */
export function aggregateExposure(
  legs: ExposureLeg[],
  accountCurrency: string = ACCOUNT_CURRENCY,
): ExposureSummary {
  const valuations = legs.map((leg) =>
    valueQuantity({
      symbol: leg.symbol,
      metadata: leg.metadata,
      quantity: leg.quantity,
      referencePrice: leg.referencePrice,
      accountCurrency,
    }),
  );

  const unresolved = [
    ...new Set(
      valuations
        .filter((valuation) => !valuation.available)
        .map((valuation) => valuation.symbol),
    ),
  ];

  return {
    total: valuations.reduce(
      (sum, valuation) => sum + (valuation.value ?? 0),
      0,
    ),
    complete: unresolved.length === 0,
    unresolved,
    legs: valuations,
  };
}

export interface LeverageRequirement {
  leverage: number;
  source: 'PROVIDER' | 'DEMO_FALLBACK';
}

/**
 * Leverage for the demo margin projection: the provider's published
 * maximum leverage when it exists, otherwise a clearly labelled demo
 * approximation.
 */
export function leverageRequirement(
  metadata?: InstrumentMetadata,
): LeverageRequirement {
  const published = metadata?.maxLeverage;

  if (
    typeof published === 'number' &&
    Number.isFinite(published) &&
    published > 0
  ) {
    return { leverage: published, source: 'PROVIDER' };
  }

  return {
    leverage: DEMO_FALLBACK_LEVERAGE,
    source: 'DEMO_FALLBACK',
  };
}

/**
 * Margin for one position in the account currency.
 *
 * Uses the provider's leverage when published. When a position cannot be
 * valued in the account currency this returns undefined rather than
 * inventing a notional.
 */
export function marginForPosition(input: {
  symbol: string;
  metadata?: InstrumentMetadata;
  quantity: number;
  referencePrice?: number;
  accountCurrency?: string;
}): { margin?: number; leverage: LeverageRequirement; reason?: string } {
  const leverage = leverageRequirement(input.metadata);

  const valuation = valueQuantity({
    symbol: input.symbol,
    metadata: input.metadata,
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    accountCurrency: input.accountCurrency,
  });

  if (!valuation.available || valuation.value === undefined) {
    return {
      leverage,
      reason:
        valuation.reason ??
        'Position cannot be valued in the account currency.',
    };
  }

  return {
    margin: valuation.value / leverage.leverage,
    leverage,
  };
}

/** Resolve metadata for a symbol through a lookup, tolerating absence. */
export function resolveMetadata(
  instruments: InstrumentLookup | undefined,
  symbol: string,
): InstrumentMetadata | undefined {
  return instruments?.get(symbol);
}

/**
 * Build a lookup from a flat metadata list, matching the exact app
 * symbol and the provider symbol.
 */
export function lookupFrom(
  instruments: InstrumentMetadata[] | undefined,
): InstrumentLookup {
  const list = instruments ?? [];

  return {
    get(symbol: string): InstrumentMetadata | undefined {
      if (!symbol) return undefined;
      return list.find(
        (candidate) =>
          candidate.symbol === symbol ||
          candidate.providerSymbol === symbol,
      );
    },
  };
}
