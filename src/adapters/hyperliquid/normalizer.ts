import { Bar, MarketSnapshot, Quote, Timeframe } from '../../types/trading';
import { AssetClass, InstrumentMetadata, MarketSymbol, TradingInstrument } from '../../types/instruments';

const INTERVALS: Record<Timeframe, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d',
};

/**
 * Hyperliquid settles and collateralizes its perps in USDC, which is the
 * account currency of this platform. Commodity and index markets are
 * therefore quoted in the account currency, while a Forex pair can be
 * quoted in its own quote currency (for example USD/JPY is quoted in
 * JPY).
 */
export const HYPERLIQUID_ACCOUNT_CURRENCY = 'USD';

/** Units in one standard lot, used only for lot-based Forex sizing. */
export const FOREX_LOT_UNITS = 100_000;

export function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim();
  if (normalized.includes(':')) {
    const [dex, asset] = normalized.split(':', 2);
    return `${dex.toLowerCase()}:${asset.toUpperCase()}`;
  }
  return normalized.toUpperCase();
}

export function toHyperliquidInterval(timeframe: Timeframe): string { return INTERVALS[timeframe]; }

export function fromHyperliquidCandle(raw: unknown): Bar {
  const candle = raw as Record<string, unknown>;
  const number = (key: string) => Number(candle[key]);
  return {
    time: Math.floor(number('t') / 1000),
    open: number('o'), high: number('h'), low: number('l'), close: number('c'), volume: number('v'),
  };
}

export function quoteFromBook(symbol: string, bid: number, ask: number, timestamp = Date.now()): Quote {
  return { symbol, timestamp, bid, ask, spread: ask - bid };
}

const FOREX_ASSETS = new Set(['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'KRW', 'MXN', 'ZAR', 'SGD', 'HKD']);
const COMMODITY_ASSETS = new Set(['GOLD', 'SILVER', 'CL', 'BRENTOIL', 'WTI', 'USOIL', 'OIL', 'COPPER', 'NATGAS', 'GAS', 'URANIUM', 'ALUMINIUM', 'PLATINUM', 'PALLADIUM', 'CORN', 'WHEAT', 'TTF']);
const INDEX_ASSETS = new Set(['SP500', 'USA500', 'US500', 'USA100', 'USTECH', 'NASDAQ', 'DOW', 'DJI', 'JP225', 'KR200', 'DAX', 'FTSE', 'NIFTY', 'IBOV', 'VIX', 'DXY', 'SMALL2000']);

/** Forex pairs the product supports, with the currencies each side. */
const FOREX_PAIRS: Record<string, { base: string; quote: string; label: string }> = {
  EUR: { base: 'EUR', quote: 'USD', label: 'EUR/USD' },
  GBP: { base: 'GBP', quote: 'USD', label: 'GBP/USD' },
  JPY: { base: 'USD', quote: 'JPY', label: 'USD/JPY' },
  AUD: { base: 'AUD', quote: 'USD', label: 'AUD/USD' },
  NZD: { base: 'NZD', quote: 'USD', label: 'NZD/USD' },
  CAD: { base: 'USD', quote: 'CAD', label: 'USD/CAD' },
  CHF: { base: 'USD', quote: 'CHF', label: 'USD/CHF' },
  KRW: { base: 'USD', quote: 'KRW', label: 'USD/KRW' },
};

const COMMODITY_NAMES: Record<string, string> = {
  GOLD: 'Gold', SILVER: 'Silver', CL: 'WTI Crude Oil', BRENTOIL: 'Brent Crude Oil', COPPER: 'Copper',
  NATGAS: 'Natural Gas', PLATINUM: 'Platinum', PALLADIUM: 'Palladium', ALUMINIUM: 'Aluminium', CORN: 'Corn',
};

const INDEX_NAMES: Record<string, string> = {
  SP500: 'S&P 500', USA500: 'S&P 500', US500: 'US 500', USA100: 'Nasdaq 100', USTECH: 'US Tech 100',
  NASDAQ: 'Nasdaq 100', DOW: 'Dow 30', DJI: 'Dow 30', JP225: 'Japan 225', KR200: 'Korea 200', SMALL2000: 'Small 2000',
};

export function classifyAsset(providerSymbol: string): AssetClass | undefined {
  const asset = normalizeSymbol(providerSymbol).split(':').at(-1) || '';
  if (FOREX_ASSETS.has(asset)) return 'FOREX';
  if (COMMODITY_ASSETS.has(asset)) return 'COMMODITY';
  if (INDEX_ASSETS.has(asset)) return 'INDEX';
  return undefined;
}

export function assetLabel(providerSymbol: string): string {
  return normalizeSymbol(providerSymbol).split(':').at(-1) || normalizeSymbol(providerSymbol);
}

/** Short label used as the app symbol, e.g. "EUR/USD", "Gold", "S&P 500". */
export function symbolLabel(providerSymbol: string, assetClass: AssetClass): string {
  const asset = assetLabel(providerSymbol);
  if (assetClass === 'FOREX') {
    return FOREX_PAIRS[asset]?.label || asset;
  }
  if (assetClass === 'COMMODITY') {
    return COMMODITY_NAMES[asset] || asset;
  }
  return INDEX_NAMES[asset] || asset;
}

export function displayNameFor(providerSymbol: string, assetClass: AssetClass): string {
  return `${symbolLabel(providerSymbol, assetClass)} Perpetual`;
}

/**
 * Build canonical instrument metadata from what the provider actually
 * returned. Anything the provider did not publish stays undefined.
 */
export function instrumentMetadata(input: {
  providerSymbol: string;
  assetClass: AssetClass;
  providerDex?: string;
  pricePrecision?: number;
  sizePrecision?: number;
  maxLeverage?: number;
}): InstrumentMetadata {
  const asset = assetLabel(input.providerSymbol);
  const isForex = input.assetClass === 'FOREX';
  const pair = isForex ? FOREX_PAIRS[asset] : undefined;
  const quoteCurrency = isForex ? pair?.quote : HYPERLIQUID_ACCOUNT_CURRENCY;

  const metadata: InstrumentMetadata = {
    symbol: symbolLabel(input.providerSymbol, input.assetClass),
    displayName: displayNameFor(input.providerSymbol, input.assetClass),
    assetClass: input.assetClass,
    provider: 'HYPERLIQUID',
    providerSymbol: input.providerSymbol,
    providerMarketId: input.providerSymbol,
    providerDex: input.providerDex,
    pricePrecision: input.pricePrecision,
    sizePrecision: input.sizePrecision,
    baseCurrency: pair?.base,
    quoteCurrency,
    // Hyperliquid does not publish a contract multiplier; its perps are
    // linear in the quoted unit, so this stays undefined by design.
    contractMultiplier: undefined,
    minOrderSize: undefined,
    maxOrderSize: undefined,
    maxLeverage: input.maxLeverage,
  };

  if (typeof input.sizePrecision === 'number' && input.sizePrecision >= 0) {
    metadata.sizeStep = 10 ** -input.sizePrecision;
  }

  if (typeof input.pricePrecision === 'number' && input.pricePrecision >= 0) {
    metadata.tickSize = 10 ** -input.pricePrecision;
  }

  /*
   * Lot sizing and pip maths exist only for Forex pairs whose quote
   * currency is known. Commodities and indices never receive a lot size
   * or a pip size, which is what stops generic code from pricing a
   * barrel of WTI in EUR/USD pips.
   */
  if (isForex && pair) {
    metadata.lotSize = FOREX_LOT_UNITS;
    metadata.pipSize = pair.quote === 'JPY' ? 0.01 : 0.0001;
  }

  return metadata;
}

/**
 * Tradeability of a discovered market.
 *
 * A market is only tradeable when the provider currently publishes a
 * usable price. A null or non-positive price leaves the market
 * unavailable: its metadata is kept, but no price is invented and it is
 * kept out of the active trading universe.
 */
export function marketAvailability(
  price: number,
): { availability: 'TRADEABLE' | 'UNAVAILABLE'; reason?: string } {
  if (!Number.isFinite(price) || price <= 0) {
    return {
      availability: 'UNAVAILABLE',
      reason:
        'The market is listed by the provider but is not publishing a current price, so it cannot be quoted or traded right now.',
    };
  }

  return { availability: 'TRADEABLE' };
}

/**
 * Percentage change of a price against its own 24-hour reference.
 *
 * Returns NaN rather than 0 when there is no usable reference. A missing
 * reference is not a flat market, and reporting 0.00% for a market whose
 * reference was never fetched is a confident wrong answer that no reader
 * can distinguish from a real one.
 */
export function percentChange24h(price: number, previousDayPrice?: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(previousDayPrice) || (previousDayPrice as number) <= 0) {
    return Number.NaN;
  }
  return ((price - (previousDayPrice as number)) / (previousDayPrice as number)) * 100;
}

/**
 * Attach a live price snapshot to canonical metadata.
 *
 * `previousDayPrice` is the venue's own 24h-ago reference price. It is
 * what makes `change24h` a measurement rather than a constant.
 *
 * `high24h` and `low24h` are left NaN when the caller has no 24h range.
 * The previous shape took an optional snapshot and, with no caller ever
 * passing one, silently substituted the current price for both -- so
 * "24h High" and "24h Low" rendered as the live price and looked
 * plausible. A NaN is honest: the UI already renders "unavailable"
 * rather than a fabricated number.
 */
export function marketSymbol(
  metadata: InstrumentMetadata,
  price: number,
  previousDayPrice?: number,
  range?: { high: number; low: number },
): MarketSymbol {
  return {
    ...metadata,
    lastPrice: price,
    change24h: percentChange24h(price, previousDayPrice),
    high24h: range?.high ?? Number.NaN,
    low24h: range?.low ?? Number.NaN,
  };
}

/**
 * Make every app symbol unique across provider namespaces.
 *
 * HIP-3 deployments can publish the same asset in more than one namespace
 * (for example Gold exists in both `xyz` and `mkts`). Without this,
 * two distinct markets would share one app symbol and orders could be
 * validated against the wrong market's precision. Colliding labels are
 * suffixed with their namespace so every market stays reachable.
 */
export function uniqueSymbolLabels(
  instruments: InstrumentMetadata[],
): Map<string, string> {
  const occurrences = new Map<string, number>();

  for (const instrument of instruments) {
    occurrences.set(
      instrument.symbol,
      (occurrences.get(instrument.symbol) ?? 0) + 1,
    );
  }

  return new Map(
    instruments.map((instrument) => [
      instrument.providerSymbol,
      (occurrences.get(instrument.symbol) ?? 0) > 1
        ? `${instrument.symbol} (${
            instrument.providerDex ??
            instrument.providerSymbol.split(':')[0]
          })`
        : instrument.symbol,
    ]),
  );
}

export function tradingInstrument(
  metadata: InstrumentMetadata,
  supportedTimeframes: Timeframe[],
  market?: MarketSymbol,
): TradingInstrument {
  const availability =
    market !== undefined
      ? marketAvailability(market.lastPrice)
      : marketAvailability(Number.NaN);

  return {
    ...metadata,
    id: `hyperliquid:${metadata.providerSymbol}`,
    supportedTimeframes,
    active: true,
    availability: availability.availability,
    unavailableReason: availability.reason,
    market,
  };
}
