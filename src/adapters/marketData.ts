import { Bar, Quote, Timeframe } from '../types/trading';
import type { MarketFacts } from '../engine/agents/types';

export interface MarketDataProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getQuote(symbol: string): Promise<Quote>;
  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<Bar[]>;
  subscribeQuote(symbol: string, callback: (quote: Quote) => void): () => void;
  subscribeBars(symbol: string, timeframe: Timeframe, callback: (bar: Bar, isClosed: boolean) => void): () => void;
  /**
   * The venue's non-price facts for a market, when it publishes them.
   *
   * Optional: a provider that only serves price and candles is a complete
   * provider, and the capability layer reports the absence rather than
   * inventing a value.
   */
  getMarketContext?(symbol: string): Promise<MarketFacts>;
}
