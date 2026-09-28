import { Bar, Quote, Timeframe } from '../types/trading';

export interface MarketDataProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getQuote(symbol: string): Promise<Quote>;
  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<Bar[]>;
  subscribeQuote(symbol: string, callback: (quote: Quote) => void): () => void;
  subscribeBars(symbol: string, timeframe: Timeframe, callback: (bar: Bar, isClosed: boolean) => void): () => void;
}
