import { eventBus } from '../../types/events';
import {
  Bar,
  MarketOrderRequest,
  OrderResult,
  Position,
  Quote,
  Timeframe,
} from '../../types/trading';
import {
  InstrumentLookup,
  InstrumentMetadata,
  InstrumentStatus,
} from '../../types/instruments';
import { NormalizedQuote } from '../../types/quotes';
import { riskManager } from '../../engine/execution/risk';
import {
  ExecutionRejection,
  rejection,
} from '../../engine/execution/errors';
import { ACCOUNT_CURRENCY, marginForPosition, valuePriceDistance } from '../../engine/execution/valuation';
import { validateOrderSize } from '../../utils/orderSize';
import { ITradingEnvironment } from '../../engine/agents/types';
import { hyperliquidMarketData } from './marketData';

type DemoMarketOrderResult = {
  success: boolean;
  orderId?: string;
  positionId?: string;
  fillPrice?: number;
  position?: Position;
  error?: string;
  /** Structured reason plus a user-safe message. */
  rejection?: ExecutionRejection;
};

/**
 * Market data the execution adapter depends on.
 *
 * It is an interface so the execution lifecycle (fill, mark, partial
 * close, full close) can be exercised deterministically against fixed
 * quotes. Production always uses the live Hyperliquid adapter.
 */
export interface DemoMarketDataSource {
  getQuote(symbol: string): Promise<Quote>;
  getBars(
    symbol: string,
    timeframe: Timeframe,
    count: number,
  ): Promise<Bar[]>;
  getInstrument(
    symbol: string,
  ): InstrumentMetadata | undefined;
  getInstrumentLookup(): InstrumentLookup;
  getMarketStatus?(symbol: string): Promise<InstrumentStatus>;
  getInstruments?(): Promise<
    Array<InstrumentMetadata & { market?: unknown }>
  >;
}

export type PositionMark = {
  markPrice: number;
  priceDifference: number;
  unrealizedPnL: number;
  unrealizedPnlPercent: number;
  available: boolean;
  reason?: string;
};

/**
 * Mark an open position to a real Hyperliquid bid/ask.
 *
 * Long positions mark to the bid and short positions to the ask, which
 * is the price each side would actually exit at.
 *
 * The valuation itself is delegated to the shared execution valuation
 * model, so a Forex pair quoted in a foreign currency, a commodity, and
 * an index are all priced by the same instrument-aware rule instead of
 * by a Forex pip or lot formula.
 */
export function markPositionToMarket(
  position: Pick<Position, 'side' | 'entryPrice' | 'volume'> & { symbol?: string },
  bid: number,
  ask: number,
  metadata?: InstrumentMetadata,
  accountCurrency: string = ACCOUNT_CURRENCY,
): PositionMark {
  const markPrice =
    position.side === 'BUY'
      ? bid
      : ask;

  const priceDifference =
    position.side === 'BUY'
      ? markPrice - position.entryPrice
      : position.entryPrice - markPrice;

  const unrealizedPnlPercent =
    position.entryPrice > 0
      ? Number(
          (
            (priceDifference /
              position.entryPrice) *
            100
          ).toFixed(2),
        )
      : 0;

  const valuation = valuePriceDistance({
    symbol: position.symbol ?? '',
    metadata,
    priceDistance: priceDifference,
    quantity: position.volume,
    referencePrice: markPrice,
    accountCurrency,
  });

  if (!valuation.available) {
    return {
      markPrice,
      priceDifference,
      unrealizedPnL: 0,
      unrealizedPnlPercent,
      available: false,
      reason: valuation.reason,
    };
  }

  return {
    markPrice,
    priceDifference,
    unrealizedPnL: Number(
      (valuation.value ?? 0).toFixed(2),
    ),
    unrealizedPnlPercent,
    available: true,
  };
}

type DemoCloseResult = {
  success: boolean;
  pnl?: number;
  trade?: {
    id: string;
    symbol: string;
    side: Position['side'];
    volume: number;
    entryPrice: number;
    exitPrice: number;
    entryTime: number;
    exitTime: number;
    pnl: number;
    pnlPercent: number;
    returnPercent: number;
    commission: number;
    exitReason: 'MANUAL';
  };
  error?: string;
  rejection?: ExecutionRejection;
};

export class HyperliquidDemoAdapter implements ITradingEnvironment {
  readonly mode = 'DEMO' as const;

  constructor(
    private readonly marketData: DemoMarketDataSource = hyperliquidMarketData,
  ) {}

  private balance = 10_000;
  private positions: Position[] = [];
  private orders: OrderResult[] = [];
  private unvaluableReported = new Set<string>();
  private instrumentLookup: InstrumentLookup =
    hyperliquidMarketData.getInstrumentLookup();

  /**
   * Return the current real Hyperliquid quote.
   *
   * The demo adapter does not manufacture prices. It uses the same
   * market-data source as the eventual live execution adapter.
   */
  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    const quote = await this.marketData.getQuote(symbol);

    return {
      ...quote,
      symbolId: quote.symbol,
      status: 'LIVE',
    };
  }

  /**
   * Return real historical Hyperliquid candles.
   */
  async getMarketBars(
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<Bar[]> {
    if (!isTimeframe(timeframe)) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    return this.marketData.getBars(
      symbol,
      timeframe,
      count,
    );
  }

  /**
   * Return the current demo account state.
   *
   * P&L is derived from the positions currently held by the
   * demo execution environment.
   */
  async getAccountState() {
    const unrealized = this.positions.reduce(
      (sum, position) => sum + position.unrealizedPnL,
      0,
    );

    const equity = this.balance + unrealized;

    /*
     * Demo margin projection.
     *
     * Hyperliquid publishes a maximum leverage per market, so that is
     * used when it is known. When it is not, `marginForPosition` falls
     * back to a clearly labelled demo approximation (see
     * DEMO_FALLBACK_LEVERAGE). Neither path is presented as a real
     * Hyperliquid margin requirement: real margin comes from the
     * exchange's clearing state, which this demo never queries.
     */
    const margin = this.positions.reduce(
      (sum, position) => {
        const projected = marginForPosition({
          symbol: position.symbol,
          metadata: this.getInstrument(position.symbol),
          quantity: Math.abs(position.volume),
          referencePrice: position.currentPrice,
        });

        return sum + (projected.margin ?? 0);
      },
      0,
    );

    return {
      balance: this.balance,
      equity,
      margin,
      freeMargin: equity - margin,
      dailyPnL: equity - this.balance,
      drawdownPercent: 0,
    };
  }

  /**
   * Canonical instrument metadata for the markets this adapter executes.
   */
  async getInstruments(): Promise<InstrumentMetadata[]> {
    if (!this.marketData.getInstruments) {
      return [];
    }

    return this.marketData.getInstruments();
  }

  private getInstrument(
    symbol: string,
  ): InstrumentMetadata | undefined {
    return this.marketData.getInstrument(symbol);
  }

  /**
   * Structured rejection for a market the execution layer refuses to
   * trade: either it is not listed at all, or it is listed without a
   * current price.
   */
  private async marketRejection(
    symbol: string,
  ): Promise<ExecutionRejection> {
    const status = this.marketData.getMarketStatus
      ? await this.marketData.getMarketStatus(symbol)
      : undefined;

    if (status?.availability === 'UNAVAILABLE') {
      return rejection('MARKET_DATA_UNAVAILABLE', status.reason);
    }

    return rejection(
      'UNKNOWN_INSTRUMENT',
      `No tradeable Hyperliquid market resolved for "${symbol}".`,
    );
  }

  /**
   * Return positions owned by this demo execution environment.
   */
  async getPositions(symbol?: string): Promise<Position[]> {
    return this.positions
      .filter(
        (position) =>
          !symbol || position.symbol === symbol,
      )
      .map((position) => ({
        ...position,
      }));
  }

  /**
   * Return currently pending demo orders.
   */
  async getOrders(): Promise<OrderResult[]> {
    return this.orders
      .filter((order) => order.status === 'PENDING')
      .map((order) => ({
        ...order,
      }));
  }

  /**
   * Mark every open position on this symbol to a real quote.
   *
   * Execution economics are owned here rather than reconstructed by
   * callers, so the UI, the agent runtime, and the close path all
   * observe the exact same P&L for a given quote.
   */
  markToMarket(quote: Quote): void {
    const openPositions = this.positions.filter(
      (position) => position.symbol === quote.symbol,
    );

    if (
      !Number.isFinite(quote.bid) ||
      !Number.isFinite(quote.ask)
    ) {
      return;
    }

    const metadata = this.getInstrument(quote.symbol);

    for (const position of openPositions) {
      const mark = markPositionToMarket(
        position,
        quote.bid,
        quote.ask,
        metadata,
      );

      /*
       * A mark that cannot be expressed in the account currency is not
       * applied. The previous mark is kept rather than publishing a
       * fabricated zero, and the reason is reported once.
       */
      if (!mark.available) {
        this.reportUnvaluable(position.symbol, mark.reason);
        continue;
      }

      position.currentPrice = mark.markPrice;
      position.unrealizedPnL = mark.unrealizedPnL;
      position.unrealizedPnlPercent =
        mark.unrealizedPnlPercent;

      eventBus.emit({
        type: 'POSITION_UPDATE',
        data: {
          ...position,
        },
      });
    }
  }

  private reportUnvaluable(
    symbol: string,
    reason?: string,
  ): void {
    if (this.unvaluableReported.has(symbol)) {
      return;
    }

    this.unvaluableReported.add(symbol);

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `unvaluable-position:${symbol}`,
        timestamp: Date.now(),
        level: 'warn',
        message:
          `Position on ${symbol} cannot be valued in the account currency: ` +
          `${reason ?? 'instrument metadata is incomplete'}. ` +
          'Open P&L is held at its last known value.',
      },
    });
  }

  /**
   * Execute a market order against the current Hyperliquid quote.
   *
   * DEMO mode does not sign or submit a real Hyperliquid order.
   * It simulates the execution using the real live bid/ask.
   *
   * BUY  -> ask
   * SELL -> bid
   */
  async placeMarketOrder(
    params: MarketOrderRequest,
  ): Promise<DemoMarketOrderResult> {
    if (
      !params.symbol ||
      !Number.isFinite(params.volume) ||
      params.volume <= 0
    ) {
      return {
        success: false,
        error: 'Invalid market order parameters.',
        rejection: rejection('INVALID_ORDER'),
      };
    }

    const metadata = this.getInstrument(params.symbol);

    if (!metadata) {
      const blocked = await this.marketRejection(params.symbol);

      return {
        success: false,
        error: blocked.detail ?? blocked.message,
        rejection: blocked,
      };
    }

    /*
     * Execution guard: the order must be a size the venue can accept.
     * This is the single size rule for manual tickets, agents, and any
     * other caller of this adapter.
     */
    const size = validateOrderSize(params.volume, metadata);

    if (!size.valid) {
      return {
        success: false,
        error: size.reason,
        rejection: rejection('ORDER_SIZE_INVALID', size.reason),
      };
    }

    let quote: Quote;

    try {
      quote = await this.marketData.getQuote(params.symbol);
    } catch (error: unknown) {
      return {
        success: false,
        error: 'No valid live execution price is available.',
        rejection: rejection(
          'PRICE_UNAVAILABLE',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }

    const fillPrice =
      params.side === 'BUY'
        ? quote.ask
        : quote.bid;

    if (
      !Number.isFinite(fillPrice) ||
      fillPrice <= 0
    ) {
      return {
        success: false,
        error: 'No valid live execution price is available.',
        rejection: rejection('PRICE_UNAVAILABLE'),
      };
    }

    const risk = riskManager.validateOrder(
      params,
      this.positions,
      true,
      {
        accountCurrency: ACCOUNT_CURRENCY,
        instruments: this.instrumentLookup,
        referencePrices: {
          [quote.symbol]: fillPrice,
          [params.symbol]: fillPrice,
        },
      },
    );

    if (!risk.valid) {
      return {
        success: false,
        error: risk.reason,
        rejection:
          risk.rejection ??
          rejection('RISK_UNVALUABLE', risk.reason),
      };
    }

    const now = Date.now();

    const orderId =
      `hl_demo_ord_${now}`;

    const positionId =
      `hl_demo_pos_${now}`;

    const position: Position = {
      id: positionId,
      symbol: quote.symbol,
      side: params.side,
      volume: params.volume,
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      unrealizedPnL: 0,
      unrealizedPnlPercent: 0,
      timestamp: now,
      commission: 0,
    };

    const result: OrderResult = {
      orderId,
      positionId,
      symbol: quote.symbol,
      side: params.side,
      type: 'MARKET',
      volume: params.volume,
      executionPrice: fillPrice,
      status: 'FILLED',
      timestamp: now,
    };

    /*
     * The adapter owns demo execution state.
     */
    this.orders.push(result);
    this.positions.push(position);

    /*
     * Publish execution events.
     *
     * These events use the existing TradeCodeEvent contract.
     */
    eventBus.emit({
      type: 'ORDER',
      data: result,
    });

    eventBus.emit({
      type: 'POSITION_OPEN',
      data: {
        ...position,
      },
    });

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `hl_log_${now}`,
        timestamp: now,
        level: 'trade',
        message:
          `[DEMO] Hyperliquid market order filled: ` +
          `${params.side} ${params.volume} ` +
          `${quote.symbol} @ ${fillPrice}`,
      },
    });

    return {
      success: true,
      orderId,
      positionId,
      fillPrice,
      position: {
        ...position,
      },
    };
  }

  /**
   * Modify protective levels on an existing position.
   */
  async modifyPosition(
    positionId: string,
    changes: {
      stopLoss?: number;
      takeProfit?: number;
    },
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    const position =
      this.positions.find(
        (candidate) =>
          candidate.id === positionId,
      );

    if (!position) {
      return {
        success: false,
        error: 'Position not found.',
      };
    }

    if (
      changes.stopLoss !== undefined &&
      (!Number.isFinite(changes.stopLoss) ||
        changes.stopLoss <= 0)
    ) {
      return {
        success: false,
        error: 'Invalid stop-loss price.',
      };
    }

    if (
      changes.takeProfit !== undefined &&
      (!Number.isFinite(changes.takeProfit) ||
        changes.takeProfit <= 0)
    ) {
      return {
        success: false,
        error: 'Invalid take-profit price.',
      };
    }

    Object.assign(position, changes);

    eventBus.emit({
      type: 'POSITION_UPDATE',
      data: {
        ...position,
      },
    });

    return {
      success: true,
    };
  }

  /**
   * Close some or all of a position using the current
   * Hyperliquid bid/ask.
   *
   * BUY position  -> close at bid
   * SELL position -> close at ask
   */
  async closePosition(
    positionId: string,
    volume?: number,
  ): Promise<DemoCloseResult> {
    const index =
      this.positions.findIndex(
        (candidate) =>
          candidate.id === positionId,
      );

    if (index < 0) {
      return {
        success: false,
        error: 'Position not found.',
        rejection: rejection('INVALID_ORDER', 'Position not found.'),
      };
    }

    const position =
      this.positions[index];

    const closeVolume =
      volume ?? position.volume;

    if (
      !Number.isFinite(closeVolume) ||
      closeVolume <= 0 ||
      closeVolume > position.volume
    ) {
      return {
        success: false,
        error: 'Invalid close volume.',
        rejection: rejection('INVALID_ORDER', 'Invalid close volume.'),
      };
    }

    const quote =
      await this.marketData.getQuote(
        position.symbol,
      );

    const mark = markPositionToMarket(
      {
        ...position,
        volume: closeVolume,
      },
      quote.bid,
      quote.ask,
      this.getInstrument(position.symbol),
    );

    const exitPrice = mark.markPrice;

    if (
      !Number.isFinite(exitPrice) ||
      exitPrice <= 0
    ) {
      return {
        success: false,
        error: 'No valid live exit price is available.',
        rejection: rejection('PRICE_UNAVAILABLE'),
      };
    }

    if (!mark.available) {
      return {
        success: false,
        error:
          `This position cannot be closed safely: ` +
          `${mark.reason ?? 'the exit value is unavailable'}.`,
        rejection: rejection('RISK_UNVALUABLE', mark.reason),
      };
    }

    const pnl = mark.unrealizedPnL;

    const pnlPercent = mark.unrealizedPnlPercent;

    this.balance += pnl;

    const now = Date.now();

    const trade = {
      id: `hl_demo_trade_${now}`,
      symbol: position.symbol,
      side: position.side,
      volume: closeVolume,
      entryPrice: position.entryPrice,
      exitPrice,
      entryTime: Math.floor(
        position.timestamp / 1000,
      ),
      exitTime: Math.floor(
        now / 1000,
      ),
      pnl,
      pnlPercent,
      returnPercent: pnlPercent,

      /*
       * Commission stays zero.
       *
       * No Hyperliquid fee model is implemented, and no fixed
       * per-lot fee from the previous Forex-era code is reused here.
       * The UI labels this explicitly as "not modelled".
       */
      commission: 0,

      exitReason: 'MANUAL' as const,
    };

    if (closeVolume === position.volume) {
      this.positions.splice(index, 1);
    } else {
      position.volume -= closeVolume;
      position.unrealizedPnL = 0;
      position.unrealizedPnlPercent = 0;

      eventBus.emit({
        type: 'POSITION_UPDATE',
        data: {
          ...position,
        },
      });
    }

    eventBus.emit({
      type: 'POSITION_CLOSE',
      data: {
        position: {
          ...position,
          volume: closeVolume,
        },
        trade,
      },
    });

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `hl_log_close_${now}`,
        timestamp: now,
        level: 'trade',
        message:
          `[DEMO] Hyperliquid position closed: ` +
          `${position.side} ${closeVolume} ` +
          `${position.symbol} @ ${exitPrice} ` +
          `PnL ${pnl}`,
      },
    });

    return {
      success: true,
      pnl,
      trade,
    };
  }

  /**
   * Create a pending demo limit order.
   *
   * The order is not filled automatically here.
   */
  async placeLimitOrder(
    params: MarketOrderRequest & {
      price: number;
    },
  ): Promise<{
    success: boolean;
    orderId?: string;
    error?: string;
    rejection?: ExecutionRejection;
  }> {
    if (
      !params.symbol ||
      !Number.isFinite(params.volume) ||
      params.volume <= 0 ||
      !Number.isFinite(params.price) ||
      params.price <= 0
    ) {
      return {
        success: false,
        error: 'Invalid limit order parameters.',
        rejection: rejection('INVALID_ORDER'),
      };
    }

    const metadata = this.getInstrument(params.symbol);

    if (!metadata) {
      const blocked = await this.marketRejection(params.symbol);

      return {
        success: false,
        error: blocked.detail ?? blocked.message,
        rejection: blocked,
      };
    }

    const size = validateOrderSize(params.volume, metadata);

    if (!size.valid) {
      return {
        success: false,
        error: size.reason,
        rejection: rejection('ORDER_SIZE_INVALID', size.reason),
      };
    }

    const risk = riskManager.validateOrder(
      params,
      this.positions,
      true,
      {
        accountCurrency: ACCOUNT_CURRENCY,
        instruments: this.instrumentLookup,
        referencePrices: { [params.symbol]: params.price },
      },
    );

    if (!risk.valid) {
      return {
        success: false,
        error: risk.reason,
        rejection:
          risk.rejection ??
          rejection('RISK_UNVALUABLE', risk.reason),
      };
    }

    const orderId =
      `hl_demo_limit_${Date.now()}`;

    const order: OrderResult = {
      orderId,
      symbol: params.symbol,
      side: params.side,
      type: 'LIMIT',
      volume: params.volume,
      requestedPrice: params.price,
      status: 'PENDING',
      timestamp: Date.now(),
    };

    this.orders.push(order);

    eventBus.emit({
      type: 'ORDER',
      data: {
        ...order,
      },
    });

    return {
      success: true,
      orderId,
    };
  }

  /**
   * Cancel a pending demo order.
   */
  async cancelOrder(
    orderId: string,
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    const order =
      this.orders.find(
        (candidate) =>
          candidate.orderId === orderId,
      );

    if (!order) {
      return {
        success: false,
        error: 'Order not found.',
      };
    }

    if (order.status !== 'PENDING') {
      return {
        success: false,
        error: `Order is already ${order.status}.`,
      };
    }

    order.status = 'CANCELLED';

    eventBus.emit({
      type: 'ORDER',
      data: {
        ...order,
      },
    });

    return {
      success: true,
    };
  }
}

function isTimeframe(
  value: string,
): value is Timeframe {
  return [
    '1m',
    '5m',
    '15m',
    '30m',
    '1h',
    '4h',
    '1d',
  ].includes(value);
}

export const hyperliquidDemoAdapter =
  new HyperliquidDemoAdapter();