import { Bar, Position, Timeframe } from '../../../types/trading';
import { InstrumentMetadata } from '../../../types/instruments';
import { NormalizedQuote } from '../../../types/quotes';
import { MarketFacts, ITradingEnvironment, TradingEnvironmentMode } from '../types';
import { ExecutionRejection } from '../../execution/errors';
import { hyperliquidDemoAdapter } from '../../../adapters/hyperliquid/demo';
import { MarketDataProvider } from '../../../adapters/marketData';

export class DemoEnvironment implements ITradingEnvironment {
  public readonly mode: TradingEnvironmentMode = 'DEMO';
  private readonly adapter = hyperliquidDemoAdapter;

  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    return this.adapter.getMarketQuote(symbol);
  }

  getMarketBars(symbol: string, timeframe: string, count: number): Promise<Bar[]> {
    if (!isTimeframe(timeframe)) throw new Error(`Unsupported timeframe: ${timeframe}`);
    return this.adapter.getMarketBars(symbol, timeframe, count);
  }

  /**
   * Canonical instrument metadata for this environment's market data.
   * The agent runtime and risk layer resolve sizing facts through here,
   * so they never need provider-specific knowledge.
   */
  async getInstruments(): Promise<InstrumentMetadata[]> {
    return this.adapter.getInstruments();
  }

  /**
   * Funding, open interest and volume, where the venue publishes them.
   *
   * This was the seam where the whole market-context feature could have stayed
   * quietly dead: the adapter could read funding perfectly well, and the
   * capability could ask for it, but the environment sitting between them did
   * not forward it. `market.getContext` would then have answered "this
   * environment publishes no market context" on every instrument, forever,
   * while the code that fetches it sat there looking finished.
   *
   * Optional on the interface, so the check is a real one rather than an
   * assumption: an adapter without the method reports the fact as unavailable
   * instead of inventing zeroes for funding.
   */
  async getMarketContext(symbol: string): Promise<MarketFacts> {
    const adapter = this.adapter as Partial<MarketDataProvider>;
    if (typeof adapter.getMarketContext !== 'function') {
      return {
        symbol,
        unavailable: ['This venue publishes no funding, open interest or volume.'],
      };
    }
    return adapter.getMarketContext(symbol);
  }

  async getAccountState() {
    return this.adapter.getAccountState();
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    return this.adapter.getPositions(symbol);
  }

  async getOrders() {
    return this.adapter.getOrders();
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ success: boolean; positionId?: string; fillPrice?: number; error?: string; rejection?: ExecutionRejection }> {
    return this.adapter.placeMarketOrder(params);
  }

  async placeLimitOrder(params: { symbol: string; side: 'BUY' | 'SELL'; volume: number; price: number; stopLoss?: number; takeProfit?: number }) {
    return this.adapter.placeLimitOrder(params);
  }

  async cancelOrder(orderId: string) {
    return this.adapter.cancelOrder(orderId);
  }

  async modifyPosition(positionId: string, changes: { stopLoss?: number; takeProfit?: number }): Promise<{ success: boolean; error?: string }> {
    return this.adapter.modifyPosition(positionId, changes);
  }

  async closePosition(positionId: string, volume?: number): Promise<{ success: boolean; pnl?: number; error?: string; rejection?: ExecutionRejection }> {
    return this.adapter.closePosition(positionId, volume);
  }
}

function isTimeframe(value: string): value is Timeframe {
  return ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(value);
}
