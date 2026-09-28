import { Timeframe } from '../types/trading';
import { MarketSymbol } from '../types/instruments';

/**
 * Registry of the instruments discovered from the real market-data
 * adapter.
 *
 * This service holds provider-backed metadata only. It deliberately has
 * no quote, tick, or price-synthesis API: fabricating a price here would
 * let a synthetic bid/ask reach an execution path. Quotes come from
 * `hyperliquidMarketData` and execution prices come from the execution
 * adapter.
 */
export const SUPPORTED_SYMBOLS: MarketSymbol[] = [];

export function timeframeToSeconds(tf: Timeframe): number {
  switch (tf) {
    case '1m': return 60;
    case '5m': return 300;
    case '15m': return 900;
    case '30m': return 1800;
    case '1h': return 3600;
    case '4h': return 14400;
    case '1d': return 86400;
  }
}

class MarketDataService {
  private symbolMetadata: Map<string, MarketSymbol> = new Map();

  constructor() {
    SUPPORTED_SYMBOLS.forEach((s) => this.symbolMetadata.set(s.symbol, s));
  }

  setSymbols(symbols: MarketSymbol[]): void {
    SUPPORTED_SYMBOLS.splice(0, SUPPORTED_SYMBOLS.length, ...symbols);
    this.symbolMetadata = new Map(symbols.map((symbol) => [symbol.symbol, symbol]));
  }

  getSymbol(symbol: string): MarketSymbol {
    const market = this.symbolMetadata.get(symbol);
    if (!market) throw new Error(`No discovered market metadata for ${symbol}.`);
    return market;
  }

  /**
   * Look up discovered metadata for a symbol without falling back to an
   * unrelated market or throwing.
   */
  findSymbol(symbol: string): MarketSymbol | undefined {
    return this.symbolMetadata.get(symbol);
  }

  getAllSymbols(): MarketSymbol[] {
    return SUPPORTED_SYMBOLS;
  }

  /**
   * Refresh the live price of a single instrument in place.
   *
   * Realtime quote handling must not churn this registry: consumers
   * subscribe to the market-data adapter's streams, and re-publishing
   * the whole registry on every tick would restart those subscriptions.
   */
  updateLastPrice(symbol: string, lastPrice: number): void {
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;

    const market = this.symbolMetadata.get(symbol);

    if (!market) return;

    market.lastPrice = lastPrice;

    if (lastPrice > market.high24h) market.high24h = lastPrice;
    if (lastPrice < market.low24h) market.low24h = lastPrice;
  }
}

export const marketDataService = new MarketDataService();
