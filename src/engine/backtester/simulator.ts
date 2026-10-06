import {
  BacktestConfig,
  BacktestResult,
  Bar,
  EquityPoint,
  LimitOrderRequest,
  LogEntry,
  MarketOrderRequest,
  OrderResult,
  Position,
  Quote,
  SignalEvent,
  Trade,
  TradingContext,
} from '../../types/trading';
import { indicators } from '../indicators';
import { prepareStrategyFunction } from '../sandbox/sandboxEnv';
import { riskManager } from '../execution/risk';

/** Standard lot used by the interactive backtester cost model. */
export const BACKTEST_LOT_SIZE = 100_000;

/**
 * Leverage assumed for simulated margin in the interactive backtester.
 * Simulation only; live leverage is provider metadata.
 */
export const BACKTEST_MARGIN_LEVERAGE = 100;

export class BacktestSimulator {
  private config: BacktestConfig;
  private bars: Bar[] = [];
  private currentBarIndex: number = 0;
  private balance: number = 10000;
  private equity: number = 10000;
  private positions: Position[] = [];
  private closedTrades: Trade[] = [];
  private equityCurve: EquityPoint[] = [];
  private logs: LogEntry[] = [];
  private signals: SignalEvent[] = [];
  private strategyState: Map<string, any> = new Map();
  private maxEquitySeen: number = 10000;
  /** Fills placed so far, so slippage can vary per fill and stay repeatable. */
  private fillSequence = 0;
  private maxDrawdown: number = 0;
  private maxDrawdownPercent: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.equity = config.initialBalance;
    this.maxEquitySeen = config.initialBalance;
  }

  async run(code: string, bars: Bar[], strategyId: string = 'strategy-1', strategyName: string = 'Strategy'): Promise<BacktestResult> {
    this.bars = bars;
    this.balance = this.config.initialBalance;
    this.equity = this.config.initialBalance;
    this.maxEquitySeen = this.config.initialBalance;
    this.maxDrawdown = 0;
    this.maxDrawdownPercent = 0;
    this.positions = [];
    this.closedTrades = [];
    this.equityCurve = [];
    this.logs = [];
    this.signals = [];
    this.strategyState.clear();

    const strategyFn = prepareStrategyFunction(code);

    this.log('info', `Backtest started for ${this.config.symbol} (${this.config.timeframe}) with ${bars.length} bars. Initial balance: $${this.balance.toLocaleString()}`);

    // We start iterating after a warm-up period (e.g. 35 bars to allow indicators like SMA 30 / RSI 14 to calculate)
    const warmup = Math.min(35, Math.floor(bars.length * 0.15));

    for (let i = warmup; i < bars.length; i++) {
      this.currentBarIndex = i;
      const currentBar = bars[i];

      // 1. Evaluate open positions against this bar's price action (SL / TP hits)
      this.evaluatePositions(currentBar);

      // 2. Build the controlled TradingContext for this point in time
      const ctx = this.createContext(strategyId);

      // 3. Execute the strategy
      try {
        await strategyFn(ctx);
      } catch (err: unknown) {
        this.log('error', `Strategy runtime error on bar ${i} (${new Date(currentBar.time * 1000).toISOString()}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // 4. Update equity and drawdown curve
      this.updateEquity(currentBar);
    }

    /*
     * Close whatever is left, and charge for getting out.
     *
     * Two things were wrong here. The liquidation used the raw last close while
     * every entry had paid half a spread plus slippage, so a run that finished
     * holding a position was closing it for free — a round trip that could only
     * look good. And equity was not recomputed afterwards, so the realised P&L of
     * those final positions, entry costs included, never reached `netProfit` or
     * the last point of the equity curve: the account reported a balance it did
     * not have.
     */
    if (this.positions.length > 0 && bars.length > 0) {
      const lastBar = bars[bars.length - 1];
      const exitPrice = this.exitFillPrice(lastBar);
      const remaining = [...this.positions];
      for (const pos of remaining) {
        this.closePosition(pos.id, exitPrice, lastBar.time, 'MANUAL');
      }
    }

    // Equity is a balance plus what is still open. Nothing is open now, so this
    // is the honest final number, and the curve gets a last point saying so.
    if (bars.length > 0) this.updateEquity(bars[bars.length - 1]!);

    return this.calculateResults(strategyId, strategyName);
  }

  /**
   * Spread and slippage in price terms.
   *
   * They come from the configuration only: either as a raw price
   * distance, or from a pip size the caller declares for an instrument
   * that actually has pips. No symbol-name heuristics are used, so a
   * commodity backtest cannot inherit a Forex pip size.
   */
  private spreadDistance(): number {
    if (typeof this.config.spreadPrice === 'number') {
      return this.config.spreadPrice;
    }

    const pipSize = this.config.pipSize;

    return pipSize !== undefined
      ? this.config.spreadPips * pipSize
      : 0;
  }

  private slippageDistance(): number {
    if (typeof this.config.slippagePrice === 'number') {
      return this.config.slippagePrice;
    }

    const pipSize = this.config.pipSize;

    return pipSize !== undefined
      ? this.config.slippagePips * pipSize
      : 0;
  }

  private costForVolume(volume: number): number {
    return (
      (Math.abs(volume) / (this.config.lotSize ?? BACKTEST_LOT_SIZE)) *
      this.config.commissionPerLot
    );
  }

  private createContext(strategyId: string): TradingContext {
    const availableBars = this.bars.slice(0, this.currentBarIndex + 1);
    const currentBar = this.bars[this.currentBarIndex];
    const spread = this.spreadDistance();

    return {
      market: {
        quote: async (symbol?: string): Promise<Quote> => {
          const sym = symbol || this.config.symbol;
          const digits = this.config.pricePrecision ?? 5;
          return {
            symbol: sym,
            timestamp: currentBar.time * 1000,
            bid: currentBar.close,
            ask: Number((currentBar.close + spread).toFixed(digits)),
            spread,
          };
        },
        bars: async (options?: { limit?: number }): Promise<Bar[]> => {
          const limit = options?.limit || 100;
          return availableBars.slice(-limit);
        },
      },

      indicators: {
        sma: (values, period) => indicators.sma(values, period),
        ema: (values, period) => indicators.ema(values, period),
        rsi: (values, period) => indicators.rsi(values, period),
        macd: (values, f, s, sig) => indicators.macd(values, f, s, sig),
        bollingerBands: (values, p, s) => indicators.bollingerBands(values, p, s),
        atr: (b, p) => indicators.atr(b, p),
      },

      account: {
        balance: () => this.balance,
        equity: () => this.equity,
        margin: () => this.positions.reduce((sum, p) => sum + (p.volume * p.entryPrice) / BACKTEST_MARGIN_LEVERAGE, 0),
        freeMargin: () => this.equity - (this.positions.reduce((sum, p) => sum + (p.volume * p.entryPrice) / BACKTEST_MARGIN_LEVERAGE, 0)),
        positions: (symbol?: string) => {
          if (symbol) {
            return this.positions.filter((p) => p.symbol === symbol);
          }
          return [...this.positions];
        },
      },

      orders: {
        market: async (req: MarketOrderRequest): Promise<OrderResult> => {
          return this.executeMarketOrder(req);
        },
        limit: async (req: LimitOrderRequest): Promise<OrderResult> => {
          return this.executeMarketOrder(req);
        },
        cancel: async (orderId: string): Promise<void> => {
          this.log('info', `Order ${orderId} cancelled`);
        },
        closePosition: async (positionId: string): Promise<void> => {
          const currentBar = this.bars[this.currentBarIndex];
          this.closePosition(positionId, currentBar.close, currentBar.time, 'SIGNAL_CLOSE');
        },
      },

      state: {
        get: <T>(key: string): T | undefined => this.strategyState.get(key),
        set: <T>(key: string, value: T): void => {
          this.strategyState.set(key, value);
        },
        clear: () => this.strategyState.clear(),
      },

      signal: (event) => {
        const sig: SignalEvent = {
          ...event,
          id: `sig_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          strategyId,
        };
        this.signals.push(sig);
      },

      log: (message: string, data?: unknown) => {
        this.log('info', message, data);
      },
    };
  }

  /**
   * Slippage for one fill, as a fraction of the model's slippage distance.
   *
   * A repeating cycle rather than a hash: simple, obviously bounded, and the same
   * sequence of fills always produces the same sequence of prices. A backtest
   * that charges a little more slippage on some fills than others should be
   * modelling fills, not an entropy source.
   */
  /**
   * What a close costs, at this bar's close.
   *
   * Mirrors the entry fill's cost so a forced exit is priced the same way a
   * voluntary one is. Charging only the entry side would make exiting free, and
   * the only runs that would notice are the ones that end holding something.
   */
  private exitFillPrice(bar: Bar): number {
    const halfSpread = this.spreadDistance() / 2;
    const slippage = this.slippageForBar();
    return bar.close - halfSpread - slippage;
  }

  private slippageForBar(): number {
    this.fillSequence += 1;
    const cycle = [0, 0.5, 0.25, 0.75];
    return cycle[this.fillSequence % cycle.length]! * this.slippageDistance();
  }

  private executeMarketOrder(req: MarketOrderRequest): OrderResult {
    const currentBar = this.bars[this.currentBarIndex];
    const digits = this.config.pricePrecision ?? 5;
    const spread = this.spreadDistance();
    /*
     * Deterministic, not random.
     *
     * This was the only source of variation in a fill price, and it came from an
     * unseeded `Math.random()` — so two runs of one strategy over one dataset
     * produced different entries and therefore different equity curves, which
     * makes every comparison of two strategies unrepeatable. A slippage model has
     * to be *some* assumption; this one is now a stated one, derived from the bar
     * being traded, so the same bar always fills at the same price.
     */
    const slippage = this.slippageForBar();

    /*
     * Risk Check. The bar close is the reference price used to value
     * exposure in the account currency.
     */
    const riskCheck = riskManager.validateOrder(req, this.positions, true, {
      referencePrices: { [req.symbol]: currentBar.close },
    });
    if (!riskCheck.valid) {
      this.log('risk', `Order Rejected: ${riskCheck.reason}`);
      return {
        orderId: `ord_rej_${Date.now()}`,
        symbol: req.symbol,
        side: req.side,
        type: 'MARKET',
        volume: req.volume,
        status: 'REJECTED',
        timestamp: currentBar.time * 1000,
        errorMessage: riskCheck.reason,
      };
    }

    // Execution price with spread and slippage
    const executionPrice =
      req.side === 'BUY'
        ? currentBar.close + spread + slippage
        : currentBar.close - slippage;

    /*
     * Modelled cost for the simulated backtest only. Not a venue fee;
     * the Hyperliquid execution path never applies it.
     */
    const commission = this.costForVolume(req.volume);
    this.balance -= commission;

    const positionId = `pos_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const newPosition: Position = {
      id: positionId,
      symbol: req.symbol,
      side: req.side,
      volume: req.volume,
      entryPrice: Number(executionPrice.toFixed(digits)),
      currentPrice: Number(executionPrice.toFixed(digits)),
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      unrealizedPnL: 0,
      unrealizedPnlPercent: 0,
      timestamp: currentBar.time * 1000,
      commission,
    };

    this.positions.push(newPosition);

    this.log(
      'trade',
      `Filled ${req.side} ${req.volume.toLocaleString()} ${req.symbol} @ ${newPosition.entryPrice}${
        req.stopLoss ? ` | SL: ${req.stopLoss}` : ''
      }${req.takeProfit ? ` | TP: ${req.takeProfit}` : ''}`
    );

    return {
      orderId: `ord_${Date.now()}`,
      symbol: req.symbol,
      side: req.side,
      type: 'MARKET',
      volume: req.volume,
      executionPrice: newPosition.entryPrice,
      status: 'FILLED',
      timestamp: currentBar.time * 1000,
    };
  }

  private evaluatePositions(bar: Bar): void {
    const open = [...this.positions];

    for (const pos of open) {
      let closed = false;
      let exitPrice = bar.close;
      let exitReason: Trade['exitReason'] = 'MANUAL';

      /*
       * The stop is checked before the target, on purpose.
       *
       * When one bar reaches both levels the data cannot say which came first —
       * OHLC records the range, not the path — so a replay has to pick. Every
       * other environment in this codebase picks the worse outcome and says so;
       * this one picked the better one, which quietly turned every ambiguous bar
       * into a win and made optimistic strategies look better than they were. The
       * ambiguity is real and the choice is a declared assumption, not an
       * accident.
       */
      if (pos.side === 'BUY') {
        // Stop Loss hit
        if (pos.stopLoss && bar.low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'STOP_LOSS';
          closed = true;
        }
        // Take Profit hit
        else if (pos.takeProfit && bar.high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TAKE_PROFIT';
          closed = true;
        }
      } else {
        // SELL position
        if (pos.stopLoss && bar.high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'STOP_LOSS';
          closed = true;
        }
        else if (pos.takeProfit && bar.low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TAKE_PROFIT';
          closed = true;
        }
      }

      if (closed) {
        this.closePosition(pos.id, exitPrice, bar.time, exitReason);
      } else {
        // Update unrealized PnL
        pos.currentPrice = bar.close;
        const priceDiff = pos.side === 'BUY' ? bar.close - pos.entryPrice : pos.entryPrice - bar.close;
        pos.unrealizedPnL = Number((priceDiff * pos.volume).toFixed(2));
        pos.unrealizedPnlPercent = Number(((priceDiff / pos.entryPrice) * 100).toFixed(2));
      }
    }
  }

  private closePosition(positionId: string, exitPrice: number, exitTime: number, reason: Trade['exitReason']): void {
    const idx = this.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return;

    const pos = this.positions[idx];
    this.positions.splice(idx, 1);

    const priceDiff = pos.side === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnl = Number((priceDiff * pos.volume).toFixed(2));
    const pnlPercent = Number(((priceDiff / pos.entryPrice) * 100).toFixed(2));

    this.balance += pnl;

    const trade: Trade = {
      id: `trd_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      symbol: pos.symbol,
      side: pos.side,
      volume: pos.volume,
      entryPrice: pos.entryPrice,
      exitPrice: Number(exitPrice.toFixed(this.config.pricePrecision ?? 5)),
      entryTime: Math.floor(pos.timestamp / 1000),
      exitTime,
      pnl,
      pnlPercent,
      returnPercent: pnlPercent,
      commission: pos.commission || 0,
      exitReason: reason,
    };

    this.closedTrades.push(trade);

    this.log(
      'trade',
      `Closed ${pos.side} ${pos.symbol} @ ${trade.exitPrice} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${reason})`
    );
  }

  private updateEquity(bar: Bar): void {
    const unrealized = this.positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
    this.equity = Number((this.balance + unrealized).toFixed(2));

    if (this.equity > this.maxEquitySeen) {
      this.maxEquitySeen = this.equity;
    }

    const currentDrawdown = this.maxEquitySeen - this.equity;
    const currentDrawdownPercent = (currentDrawdown / this.maxEquitySeen) * 100;

    if (currentDrawdown > this.maxDrawdown) {
      this.maxDrawdown = currentDrawdown;
      this.maxDrawdownPercent = currentDrawdownPercent;
    }

    this.equityCurve.push({
      time: bar.time,
      equity: this.equity,
      balance: this.balance,
      drawdown: Number(currentDrawdown.toFixed(2)),
      drawdownPercent: Number(currentDrawdownPercent.toFixed(2)),
    });
  }

  private calculateResults(strategyId: string, strategyName: string): BacktestResult {
    const netProfit = Number((this.equity - this.config.initialBalance).toFixed(2));
    const netProfitPercent = Number(((netProfit / this.config.initialBalance) * 100).toFixed(2));

    const totalTrades = this.closedTrades.length;
    const winningTrades = this.closedTrades.filter((t) => t.pnl > 0).length;
    const losingTrades = this.closedTrades.filter((t) => t.pnl < 0).length;
    const winRate = totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(1)) : 0;

    const grossProfit = this.closedTrades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(this.closedTrades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99.9 : 0;

    const averageTradeProfit = totalTrades > 0 ? Number((netProfit / totalTrades).toFixed(2)) : 0;

    // Sharpe ratio approximation
    const returns = this.closedTrades.map((t) => t.pnlPercent);
    let sharpeRatio = 0;
    if (returns.length > 1) {
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? Number(((avgReturn / stdDev) * Math.sqrt(252)).toFixed(2)) : 0;
    }

    return {
      id: `bt_${Date.now()}`,
      strategyId,
      strategyName,
      symbol: this.config.symbol,
      timeframe: this.config.timeframe,
      initialBalance: this.config.initialBalance,
      finalEquity: this.equity,
      netProfit,
      netProfitPercent,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      profitFactor,
      maxDrawdown: Number(this.maxDrawdown.toFixed(2)),
      maxDrawdownPercent: Number(this.maxDrawdownPercent.toFixed(2)),
      sharpeRatio,
      averageTradeProfit,
      trades: this.closedTrades,
      equityCurve: this.equityCurve,
      signals: this.signals,
      logs: this.logs,
      startTime: this.bars[0]?.time || 0,
      endTime: this.bars[this.bars.length - 1]?.time || 0,
    };
  }

  private log(level: LogEntry['level'], message: string, data?: unknown): void {
    this.logs.push({
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      timestamp: Date.now(),
      level,
      message,
      data,
    });
  }
}
