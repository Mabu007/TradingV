import { Bar, EquityPoint, OrderResult, Position, Trade } from '../../../types/trading';
import { NormalizedQuote } from '../../../types/quotes';
import { ITradingEnvironment, TradingEnvironmentMode } from '../types';
import type { AgentRuntime } from '../runtime';
import type { AgentDecision } from '../types';

/**
 * Backtest cost model.
 *
 * P&L in this engine is linear: price distance x position size, the same
 * rule the live execution adapter uses. Pips are only a way to *express*
 * spread and slippage for instruments that have a pip (Forex), and
 * costs are expressed per standard lot, which is an explicit modelling
 * choice rather than a venue fee.
 */
export interface BacktestEnvironmentConfig {
  initialBalance?: number;
  symbol: string;
  timeframe?: string;
  /** Spread expressed in pips. Forex parameterization. */
  spreadPips?: number;
  /** Spread expressed as a raw price distance. Use for commodities/indices. */
  spreadPrice?: number;
  /** Price increment of one pip, when the instrument has one. */
  pipSize?: number;
  /** Slippage expressed in pips. */
  slippagePips?: number;
  /** Slippage expressed as a raw price distance. */
  slippagePrice?: number;
  /** Modelled cost per standard lot. Explicit backtest assumption. */
  commissionPerLot?: number;
  /** Units in one standard lot for the cost model. */
  lotSize?: number;
  /** Decimal places used when rounding simulated quotes. */
  pricePrecision?: number;
  /**
   * Leverage used only for the simulated margin requirement.
   * Backtest-only approximation; real leverage is provider metadata.
   */
  leverage?: number;
  bars: Bar[];
}

/** Standard lot used by the backtest cost model when none is supplied. */
export const DEFAULT_BACKTEST_LOT_SIZE = 100_000;

/** Backtest-only margin approximation. Never a live venue requirement. */
export const DEFAULT_BACKTEST_LEVERAGE = 100;

export class BacktestEnvironment implements ITradingEnvironment {
  public mode: TradingEnvironmentMode = 'BACKTEST';
  private balance: number = 10000;
  private equity: number = 10000;
  private maxEquitySeen: number = 10000;
  private currentBarIndex: number = 0;
  private bars: Bar[] = [];
  private positions: Map<string, Position> = new Map();
  private closedTrades: Trade[] = [];
  private spreadPrice: number = 0;
  private slippagePrice: number = 0;
  private commissionPerLot: number = 3.5;
  private lotSize: number = DEFAULT_BACKTEST_LOT_SIZE;
  private leverage: number = DEFAULT_BACKTEST_LEVERAGE;
  private pricePrecision: number = 5;
  private initialBalance: number = 10000;
  private symbol: string;
  private nextPositionId: number = 0;
  private pendingOrders: OrderResult[] = [];
  private equityCurve: EquityPoint[] = [];
  private nextTradeId = 0;

  constructor(config: BacktestEnvironmentConfig) {
    this.balance = config.initialBalance ?? 10000;
    this.equity = this.balance;
    this.maxEquitySeen = this.balance;
    this.symbol = config.symbol;
    this.commissionPerLot = config.commissionPerLot ?? 3.5;
    this.lotSize = config.lotSize ?? DEFAULT_BACKTEST_LOT_SIZE;
    this.leverage = config.leverage ?? DEFAULT_BACKTEST_LEVERAGE;
    this.pricePrecision = config.pricePrecision ?? 5;
    this.initialBalance = this.balance;

    /*
     * Spread and slippage are converted once, here, from whichever unit
     * the caller used. No symbol-name heuristics are involved, so a
     * commodity backtest cannot inherit a JPY pip size.
     */
    const pipSize = config.pipSize;
    this.spreadPrice =
      config.spreadPrice ??
      (pipSize !== undefined ? (config.spreadPips ?? 0) * pipSize : 0);
    this.slippagePrice =
      config.slippagePrice ??
      (pipSize !== undefined ? (config.slippagePips ?? 0) * pipSize : 0);
    this.bars = config.bars;
    if (this.bars.length === 0) throw new Error('Backtest environment requires deterministic historical bars.');
  }

  getCurrentBar(): Bar | undefined {
    return this.bars[this.currentBarIndex];
  }

  getBarIndex(): number {
    return this.currentBarIndex;
  }

  getBarCount(): number {
    return this.bars.length;
  }

  setBarIndex(idx: number): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.bars.length) throw new Error(`Invalid backtest bar index: ${idx}`);
    this.currentBarIndex = idx;
    this.evaluateOpenPositions(this.bars[idx]);
  }

  advanceBar(): boolean {
    if (this.currentBarIndex < this.bars.length - 1) {
      this.currentBarIndex++;
      this.evaluateOpenPositions(this.bars[this.currentBarIndex]);
      return true;
    }
    return false;
  }

  private evaluateOpenPositions(bar: Bar) {
    for (const [id, pos] of this.positions.entries()) {
      let exitPrice: number | null = null;
      let exitReason: Trade['exitReason'] = 'MANUAL';

      if (pos.side === 'BUY') {
        if (pos.stopLoss && bar.low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'STOP_LOSS';
        } else if (pos.takeProfit && bar.high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TAKE_PROFIT';
        }
      } else {
        if (pos.stopLoss && bar.high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'STOP_LOSS';
        } else if (pos.takeProfit && bar.low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TAKE_PROFIT';
        }
      }

      if (exitPrice !== null) {
        const priceDiff = pos.side === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
        const pnl = Number((priceDiff * pos.volume).toFixed(2));
        this.balance += pnl;

        this.closedTrades.push({
          id: `trd_${this.nextTradeId++}`,
          positionId: id,
          symbol: pos.symbol,
          side: pos.side,
          volume: pos.volume,
          entryPrice: pos.entryPrice,
          exitPrice,
          entryTime: Math.floor(pos.timestamp / 1000),
          exitTime: bar.time,
          pnl,
          pnlPercent: Number(((priceDiff / pos.entryPrice) * 100).toFixed(2)),
          returnPercent: Number(((priceDiff / pos.entryPrice) * 100).toFixed(2)),
          commission: pos.commission ?? this.costForVolume(pos.volume),
          exitReason,
        });

        this.positions.delete(id);
      } else {
        // Update unrealized mark to market
        const priceDiff = pos.side === 'BUY' ? bar.close - pos.entryPrice : pos.entryPrice - bar.close;
        pos.currentPrice = bar.close;
        pos.unrealizedPnL = Number((priceDiff * pos.volume).toFixed(2));
        pos.unrealizedPnlPercent = Number(((priceDiff / pos.entryPrice) * 100).toFixed(2));
        this.positions.set(id, pos);
      }
    }

    const unrealized = Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnL, 0);
    this.equity = this.balance + unrealized;
    if (this.equity > this.maxEquitySeen) {
      this.maxEquitySeen = this.equity;
    }
    this.recordEquity(this.bars[this.currentBarIndex]);
  }

  private recordEquity(bar: Bar): void {
    const drawdown = Math.max(0, this.maxEquitySeen - this.equity);
    this.equityCurve.push({
      time: bar.time,
      equity: Number(this.equity.toFixed(2)),
      balance: Number(this.balance.toFixed(2)),
      drawdown: Number(drawdown.toFixed(2)),
      drawdownPercent: this.maxEquitySeen > 0 ? Number(((drawdown / this.maxEquitySeen) * 100).toFixed(2)) : 0,
    });
  }

  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    if (symbol !== this.symbol) throw new Error(`Backtest data is configured for ${this.symbol}, not ${symbol}.`);
    const bar = this.getCurrentBar() || this.bars[0];
    const bid = bar ? bar.close : 1.085;
    const ask = Number((bid + this.spreadPrice).toFixed(this.pricePrecision));

    return {
      symbol,
      symbolId: '0',
      bid,
      ask,
      spread: this.spreadPrice,
      timestamp: (bar ? bar.time : Date.now()) * 1000,
      status: 'MOCK',
    };
  }

  async getMarketBars(symbol: string, _timeframe: string, count: number): Promise<Bar[]> {
    if (symbol !== this.symbol) throw new Error(`Backtest data is configured for ${this.symbol}, not ${symbol}.`);
    if (!Number.isInteger(count) || count <= 0) throw new Error('Bar count must be a positive integer.');
    const end = this.currentBarIndex + 1;
    const start = Math.max(0, end - count);
    return this.bars.slice(start, end);
  }

  async getAccountState() {
    const unrealized = Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnL, 0);
    const equity = this.balance + unrealized;
    const drawdown = this.maxEquitySeen > 0 ? ((this.maxEquitySeen - equity) / this.maxEquitySeen) * 100 : 0;
    /*
     * Simulated margin requirement: notional divided by the backtest's
     * assumed leverage. It is an approximation for simulation only.
     */
    const margin = Array.from(this.positions.values()).reduce(
      (sum, p) => sum + (Math.abs(p.volume) * p.currentPrice) / this.leverage,
      0,
    );

    return {
      balance: Number(this.balance.toFixed(2)),
      equity: Number(equity.toFixed(2)),
      margin: Number(margin.toFixed(2)),
      freeMargin: Math.max(0, equity - margin),
      /*
       * Session P&L over the whole backtest: realized plus unrealized,
       * measured against the starting balance rather than open P&L only.
       */
      dailyPnL: Number((equity - this.initialBalance).toFixed(2)),
      drawdownPercent: Number(drawdown.toFixed(2)),
    };
  }

  async getOrders() {
    return [...this.pendingOrders];
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const list = Array.from(this.positions.values());
    return symbol ? list.filter((p) => p.symbol === symbol) : list;
  }

  /** Modelled cost for a traded volume, using the configured lot size. */
  private costForVolume(volume: number): number {
    return this.commissionPerLot * (Math.abs(volume) / this.lotSize);
  }

  getClosedTrades(): Trade[] {
    return [...this.closedTrades];
  }

  getEquityCurve(): EquityPoint[] {
    return [...this.equityCurve];
  }

  async finalize(): Promise<void> {
    const bar = this.getCurrentBar();
    if (!bar) return;
    for (const position of [...this.positions.values()]) await this.closePosition(position.id);
    this.recordEquity(bar);
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ success: boolean; positionId?: string; fillPrice?: number; error?: string }> {
    const quote = await this.getMarketQuote(params.symbol);
    const slippage = this.slippagePrice;
    const fillPrice = params.side === 'BUY' ? quote.ask + slippage : quote.bid - slippage;
    if (params.symbol !== this.symbol) return { success: false, error: `Backtest data is configured for ${this.symbol}, not ${params.symbol}.` };
    const positionId = `sim_pos_${this.currentBarIndex}_${this.nextPositionId++}`;
    const bar = this.getCurrentBar();
    if (!bar) return { success: false, error: 'No current historical bar is available.' };

    const newPosition: Position = {
      id: positionId,
      symbol: params.symbol,
      side: params.side,
      volume: params.volume,
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      unrealizedPnL: 0,
      unrealizedPnlPercent: 0,
      timestamp: (bar ? bar.time : Date.now()) * 1000,
      commission: this.costForVolume(params.volume),
      goatName: params.comment,
    };

    this.balance -= newPosition.commission || 0;
    this.positions.set(positionId, newPosition);
    return {
      success: true,
      positionId,
      fillPrice,
    };
  }

  async modifyPosition(positionId: string, changes: { stopLoss?: number; takeProfit?: number }): Promise<{ success: boolean; error?: string }> {
    const pos = this.positions.get(positionId);
    if (!pos) return { success: false, error: 'Position not found' };
    if (changes.stopLoss !== undefined) pos.stopLoss = changes.stopLoss;
    if (changes.takeProfit !== undefined) pos.takeProfit = changes.takeProfit;
    this.positions.set(positionId, pos);
    return { success: true };
  }

  async closePosition(positionId: string, volumeToClose?: number): Promise<{ success: boolean; pnl?: number; error?: string }> {
    const pos = this.positions.get(positionId);
    if (!pos) return { success: false, error: 'Position not found' };
    if (volumeToClose !== undefined && (!Number.isFinite(volumeToClose) || volumeToClose <= 0 || volumeToClose > pos.volume)) {
      return { success: false, error: 'Close volume must be positive and not exceed the open position volume.' };
    }

    const quote = await this.getMarketQuote(pos.symbol);
    const slippage = this.slippagePrice;
    const exitPrice = pos.side === 'BUY' ? quote.bid - slippage : quote.ask + slippage;
    const priceDiff = pos.side === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const closeVol = volumeToClose && volumeToClose < pos.volume ? volumeToClose : pos.volume;
    const pnl = Number((priceDiff * closeVol).toFixed(2));
    const bar = this.getCurrentBar();

    this.balance += pnl;

    this.closedTrades.push({
      id: `trd_${this.nextTradeId++}`,
      positionId,
      symbol: pos.symbol,
      side: pos.side,
      volume: closeVol,
      entryPrice: pos.entryPrice,
      exitPrice,
      entryTime: Math.floor(pos.timestamp / 1000),
      exitTime: bar ? bar.time : Math.floor(Date.now() / 1000),
      pnl,
      pnlPercent: Number(((priceDiff / pos.entryPrice) * 100).toFixed(2)),
      returnPercent: Number(((priceDiff / pos.entryPrice) * 100).toFixed(2)),
      commission: this.costForVolume(closeVol),
      exitReason: 'MANUAL',
    });

    if (closeVol >= pos.volume) {
      this.positions.delete(positionId);
    } else {
      pos.volume -= closeVol;
      this.positions.set(positionId, pos);
    }

    return { success: true, pnl };
  }
}

export async function replayAgentBacktest(
  runtime: AgentRuntime,
  agentId: string,
  environment: BacktestEnvironment
): Promise<AgentDecision[]> {
  if (runtime.getAgent(agentId)?.env.mode !== 'BACKTEST') throw new Error('Backtest replay requires a BACKTEST-configured agent.');
  await runtime.start(agentId);
  const decisions: AgentDecision[] = [];
  for (let index = 0; index < environment.getBarCount(); index += 1) {
    environment.setBarIndex(index);
    decisions.push(await runtime.step(agentId, {
      type: 'NEW_BAR',
      symbol: environment.getCurrentBar() ? runtime.getAgent(agentId)?.agent.symbols[0] : undefined,
      timestamp: (environment.getCurrentBar()?.time ?? 0) * 1000,
    }));
  }
  await runtime.stop(agentId);
  return decisions;
}
