/**
 * The simulated market.
 *
 * This is the whole of the backtest's safety story, and it is deliberately
 * one file with no dependency on any venue adapter. A backtest reads history
 * and fills simulated orders; it cannot reach an exchange because it has
 * nothing to reach through.
 *
 * The information boundary
 * -----------------------
 *
 * Every read in this file is filtered by one rule:
 *
 *     a bar is visible only when it has CLOSED at or before the clock's now
 *
 * Not "at or before" the bar's open time — its *close*. A 15m candle that runs
 * from 10:30 to 10:45 is not a fact at 10:37; it is a forecast. Handing it to
 * the agent is look-ahead bias in its purest form, and it is the single
 * mistake that makes a backtest worth nothing.
 *
 * Enforcing it here rather than in the agent is the point. Every indicator,
 * every structure read, every support level and every prompt in this system is
 * derived from `visibleBars()`. RSI at 10:37 is computed from candles that all
 * closed before 10:37, not from a series computed once over the whole dataset
 * and then indexed — which is how a "look-ahead-free" backtest still leaks the
 * future through an indicator's warm-up window.
 *
 * Aggregation follows the same rule one level up: a 15m candle exists only
 * once all fifteen of its 1m bars have closed. There is no partial higher
 * timeframe anywhere in this file, because a partial candle is a future value
 * wearing a completed candle's clothes.
 *
 * Execution
 * ---------
 *
 * Orders fill against the visible close plus a modelled spread and slippage,
 * and open positions are evaluated as each new base bar completes. Every
 * execution event carries `simulated: true`, because a reader of a log full of
 * "BUY" lines has no other way to know it was not real money.
 */

import type { Bar, OrderResult, OrderStatus, Position, Trade } from '../../../types/trading';
import type { InstrumentMetadata } from '../../../types/instruments';
import type { NormalizedQuote } from '../../../types/quotes';
import type {
  ITradingEnvironment,
  MarketFacts,
  TradingEnvironmentMode,
} from '../../agents/types';
import type { ExecutionRejection } from '../../execution/errors';
import type { SimulationClock } from './clock';
import { rankOf, timeframeSeconds } from '../timeframes';

/**
 * The finest resolution a replay defaults to.
 *
 * One minute, because it is the resolution every coarser one can be built from
 * and the one a scalper needs. It is a default and not a requirement: a dataset
 * that only exists at 5m can still be replayed, and the environment then says so
 * rather than inventing candles it does not have.
 */
export const SIMULATION_BASE_TIMEFRAME = '1m';

/**
 * What a timeframe means, in seconds.
 *
 * Re-exported from the canonical timeframe model rather than redeclared, so a
 * resolution cannot be readable here and not in the rest of the product.
 */
export { timeframeSeconds, isSupportedTimeframe, SUPPORTED_TIMEFRAMES } from '../timeframes';

/**
 * A point-in-time venue fact.
 *
 * Keyed by the instant the reading was published, so answering "what was the
 * funding rate at 10:37" is a lookup with a boundary rather than a guess about
 * which record was current.
 */
export interface SimulationFact {
  /** Epoch seconds the reading was taken. */
  time: number;
  value: number;
}

export interface SimulationMarketConfig {
  symbol: string;
  /**
   * The dataset, ascending and non-overlapping, at the base resolution.
   *
   * The simulator may hold the entire future — it is the world. Nothing else
   * in the system ever sees it: the agent is served by `visibleBars`, which
   * stops at the clock.
   */
  bars: Bar[];
  /**
   * The resolution the dataset itself is at.
   *
   * Defaults to 1m. A venue that will not serve a year of 1m candles can serve
   * 5m, and replaying that is honest; synthesising 1m candles from it would not
   * be. A dataset is only ever aggregated upwards from here.
   */
  baseTimeframe?: string;
  /** Hourly funding readings, if the dataset carries them. */
  funding?: SimulationFact[];
  /** Open-interest readings, if the dataset carries them. */
  openInterest?: SimulationFact[];
  initialBalance?: number;
  /** Spread as a raw price distance. Modelled, not a venue fee. */
  spreadPrice?: number;
  /** Slippage as a raw price distance. */
  slippagePrice?: number;
  commissionPerLot?: number;
  lotSize?: number;
  pricePrecision?: number;
  leverage?: number;
  /** Pip size, when the instrument has one. Used only to phrase results in pips. */
  pipSize?: number;
  instruments?: InstrumentMetadata[];
}

/**
 * A resting limit order on the simulated book.
 *
 * This is the object that makes the difference between a replay and a trading
 * simulation. Before it existed the only thing a GOAT could do was buy at the
 * current close, which means the backtest could never demonstrate a GOAT
 * *waiting* for its price — the single most characteristic thing about how a
 * trader takes an entry.
 */
export interface SimulatedOrder {
  id: string;
  /** The GOAT trade plan this order came from. The join key back to the plan. */
  planId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT';
  /**
   * The price the GOAT said it would pay.
   *
   * Named `entryPrice` rather than reusing `OrderResult.requestedPrice` because a
   * resting order's price *is* its definition here, and there is no second price
   * until the moment it fills.
   */
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  volume: number;
  status: OrderStatus;
  /** Seconds, matching every other time in this file. */
  placedAt: number;
  /** Seconds. Absent means the order does not time out. */
  expiresAt?: number;
  filledAt?: number;
  fillPrice?: number;
  positionId?: string;
  /** Why the GOAT chose this price, in its own words. Shown, never parsed. */
  reason?: string;
  /** Why an order left the book without filling. */
  terminalReason?: string;
  goatName?: string;
}

/** What happened to resting orders during one bar. */
export interface SettledOrders {
  filled: SimulatedOrder[];
  expired: SimulatedOrder[];
}

export interface SimulatedOrderResult {
  success: boolean;
  positionId?: string;
  fillPrice?: number;
  error?: string;
  rejection?: ExecutionRejection;
  /** Always true here. There is no other kind of order in this file. */
  simulated?: boolean;
}

/**
 * The market, as of the simulation clock.
 *
 * Implements the same `ITradingEnvironment` the live GOAT runs through, which
 * is what makes "the same runtime in a different environment" true rather than
 * aspirational: the agent runtime, the tracker runtime, the capabilities and
 * the GOAT loop all hold this object exactly as they hold the venue one, and
 * none of them can tell the difference.
 */
export class SimulationEnvironment implements ITradingEnvironment {
  public readonly mode: TradingEnvironmentMode = 'BACKTEST';

  private readonly clock: SimulationClock;
  private readonly symbol: string;
  private readonly bars: Bar[];
  private readonly baseSeconds: number;
  private readonly baseTimeframe: string;
  private readonly initialBalance: number;

  private readonly spreadPrice: number;
  private readonly slippagePrice: number;
  private readonly commissionPerLot: number;
  private readonly lotSize: number;
  private readonly leverage: number;
  private readonly pricePrecision: number;
  private readonly pipSize: number | undefined;
  private readonly instruments: InstrumentMetadata[];
  private readonly funding: SimulationFact[];
  private readonly openInterest: SimulationFact[];

  private balance: number;
  private maxEquitySeen: number;
  private readonly positions = new Map<string, Position>();
  private readonly trades: Trade[] = [];
  /** Resting and settled limit orders, oldest first. */
  private readonly orders: SimulatedOrder[] = [];
  private nextPositionId = 0;
  private nextTradeId = 0;
  private nextOrderId = 0;
  /**
   * Index of the first bar that is still in the future.
   *
   * Monotonic, because the clock only moves forwards, so this is a cursor
   * rather than a search: a replay of a day of 1m data costs one pass over the
   * dataset no matter how many times the agent reads it.
   */
  private visibleCount = 0;
  private readonly volumeBearing: boolean;

  constructor(clock: SimulationClock, config: SimulationMarketConfig) {
    this.clock = clock;
    this.symbol = config.symbol;
    this.baseTimeframe = config.baseTimeframe ?? SIMULATION_BASE_TIMEFRAME;
    this.baseSeconds = timeframeSeconds(this.baseTimeframe);

    if (!Array.isArray(config.bars) || config.bars.length === 0) {
      throw new Error('A simulation needs historical bars. There is nothing to replay.');
    }
    this.bars = validateDataset(config.bars);
    this.volumeBearing = this.bars.some((bar) => typeof bar.volume === 'number' && Number.isFinite(bar.volume));

    this.balance = config.initialBalance ?? 10_000;
    this.initialBalance = this.balance;
    this.maxEquitySeen = this.balance;
    this.spreadPrice = config.spreadPrice ?? 0;
    this.slippagePrice = config.slippagePrice ?? 0;
    this.commissionPerLot = config.commissionPerLot ?? 3.5;
    this.lotSize = config.lotSize ?? 100_000;
    this.leverage = config.leverage ?? 100;
    this.pricePrecision = config.pricePrecision ?? 5;
    this.pipSize = typeof config.pipSize === 'number' && config.pipSize > 0 ? config.pipSize : undefined;
    this.instruments = config.instruments ?? [defaultInstrument(config.symbol, this.pricePrecision)];
    this.funding = [...(config.funding ?? [])].sort((a, b) => a.time - b.time);
    this.openInterest = [...(config.openInterest ?? [])].sort((a, b) => a.time - b.time);

    /*
     * The clock may already be past the start of the dataset, so the cursor is
     * advanced once here rather than assuming a fresh simulation always begins
     * at the first bar.
     */
    this.catchUpTo(clock.now());
  }

  // -------------------------------------------------------------------------
  // The boundary
  // -------------------------------------------------------------------------

  /** The last instant any bar in this simulation may have closed. */
  private horizonSeconds(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  /** Advance the visibility cursor to the clock. Never moves backwards. */
  private catchUpTo(instant: number): void {
    const horizon = Math.floor(instant / 1000);
    while (this.visibleCount < this.bars.length) {
      const bar = this.bars[this.visibleCount];
      if (bar.time + this.baseSeconds > horizon) break;
      this.visibleCount += 1;
    }
  }

  /**
   * Every bar the agent is allowed to see.
   *
   * The single choke point for the whole information boundary. Anything not
   * sliced by this method is not reachable by the agent at all, which is why
   * there is no other place in this file that indexes `this.bars` directly for
   * a read.
   */
  private visibleBars(): Bar[] {
    this.catchUpTo(this.clock.now());
    return this.bars.slice(0, this.visibleCount);
  }

  /**
   * The most recent visible bar.
   *
   * Its close is the simulation's price. There is no partial bar: the
   * simulation's world advances on bar boundaries, so "now" always means "the
   * close of the last candle that has finished".
   */
  currentBar(): Bar | undefined {
    const visible = this.visibleBars();
    return visible[visible.length - 1];
  }

  /**
   * The newest instant the agent may observe.
   *
   * Exposed so a test can assert the boundary from the outside rather than
   * inferring it from behaviour.
   */
  horizon(): number {
    const bar = this.currentBar();
    return bar ? (bar.time + this.baseSeconds) * 1000 : this.clock.now();
  }

  /** True when the replay has consumed the whole dataset. */
  get exhausted(): boolean {
    return this.barsConsumed() >= this.bars.length;
  }

  /** How much of the dataset has been revealed so far, [0,1]. */
  get progress(): number {
    this.catchUpTo(this.clock.now());
    return this.bars.length === 0 ? 1 : this.visibleCount / this.bars.length;
  }

  /**
   * Whether this simulation can read a resolution at all.
   *
   * The only thing that makes one unavailable is the dataset: everything
   * coarser than the base is aggregated from it, and nothing finer exists.
   */
  supports(timeframe: string): boolean {
    return rankOf(timeframe) >= rankOf(this.baseTimeframe);
  }

  /** The resolution the dataset is at. The finest thing this replay can read. */
  get resolution(): string {
    return this.baseTimeframe;
  }

  /** Base bars consumed so far. A one-minute tick consumes one. */
  barsConsumed(): number {
    this.catchUpTo(this.clock.now());
    return this.visibleCount;
  }

  /** One base bar, in epoch milliseconds. */
  get baseStepMs(): number {
    return this.baseSeconds * 1000;
  }

  /**
   * The instant the next unseen bar closes, or undefined when there are none.
   *
   * The replay loop advances to this rather than by a duration of its own. It is
   * how "no intermediate bar is skipped" is enforced structurally instead of by
   * arithmetic: the clock is only ever moved to a boundary the dataset actually
   * has, so a speed that would have jumped three minutes in one frame moves three
   * minutes as three boundaries, each of them processed in turn.
   */
  nextBarClose(): number | undefined {
    this.catchUpTo(this.clock.now());
    const bar = this.bars[this.visibleCount];
    return bar ? (bar.time + this.baseSeconds) * 1000 : undefined;
  }

  /**
   * The account as it stands, synchronously.
   *
   * `getAccountState` is the async contract every capability reads, and its
   * implementation was already synchronous — but a trade decision needs the
   * account *while* it is being sized, on a path that cannot await without
   * becoming async all the way up through the engine. Two names for one reading,
   * with the async one delegating, so there is one calculation.
   */
  accountSnapshot(): {
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    dailyPnL: number;
    drawdownPercent: number;
    openPositions: number;
    maxEquity: number;
  } {
    const unrealized = this.unrealized();
    const equity = this.balance + unrealized;
    const margin = [...this.positions.values()].reduce(
      (sum, position) => sum + (Math.abs(position.volume) * position.currentPrice) / this.leverage,
      0,
    );
    return {
      balance: this.round2(this.balance),
      equity: this.round2(equity),
      margin: this.round2(margin),
      freeMargin: this.round2(Math.max(0, equity - margin)),
      dailyPnL: this.round2(equity - this.initialBalance),
      drawdownPercent: this.round2(
        this.maxEquitySeen > 0 ? ((this.maxEquitySeen - equity) / this.maxEquitySeen) * 100 : 0,
      ),
      openPositions: this.positions.size,
      maxEquity: this.round2(this.maxEquitySeen),
    };
  }

  /** Every resting or settled order this replay has known about, oldest first. */
  orderHistory(): SimulatedOrder[] {
    return [...this.orders];
  }

  /**
   * How close the market came to an order's price while it was resting.
   *
   * Scans the bars that existed during the order's life and reports the
   * smallest price distance the market ever came to it. This is the difference
   * between "the order expired" and "the order missed by 0.01", which are very
   * different things to read about a GOAT's patience — and the difference
   * between a replay that only celebrates fills and one that can show what the
   * setup nearly was.
   *
   * A filled order has no near miss: it got its price.
   */
  nearestApproach(order: SimulatedOrder): { distance: number; at: number; price: number } | undefined {
    if (order.status !== 'PENDING' && order.status !== 'EXPIRED' && order.status !== 'CANCELLED') return undefined;
    if (order.filledAt !== undefined) return undefined;
    /*
     * Bounded by the replay's own horizon, not by the dataset's.
     *
     * The question being answered is "how close did the market come to this
     * order", and during a replay that question is only meaningful up to *now*.
     * Reading to the end of the dataset answered it with the future: an order
     * still resting could be reported mid-run as a near miss at a timestamp the
     * replay had not reached yet, and that count fed the run's own verdict. The
     * agent never saw it — the reader, and the score derived from what they
     * read, did.
     */
    const from = order.placedAt;
    const horizon = this.clock.now();
    const to = Math.min(order.expiresAt ?? Number.POSITIVE_INFINITY, horizon);
    if (to < from) return undefined;
    let best: { distance: number; at: number; price: number } | undefined;

    for (const bar of this.bars) {
      if (bar.time < from || bar.time > to) continue;
      // The touch that matters is the one on the order's own side of the market.
      const touch = order.side === 'BUY' ? bar.low : bar.high;
      const distance = Math.abs(order.entryPrice - touch);
      if (!best || distance < best.distance) {
        best = { distance: this.round(Math.min(distance, Math.abs(order.entryPrice - bar.close))), at: bar.time * 1000, price: touch };
      }
    }

    return best;
  }

  /** The whole dataset, for the simulator's own use. Never handed to the agent. */
  dataset(): Bar[] {
    return [...this.bars];
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getMarketQuote(symbol: string): Promise<NormalizedQuote> {
    this.assertSymbol(symbol);
    const bar = this.currentBar();
    if (!bar) throw new Error('No bar has closed yet in this simulation.');
    const mid = bar.close;
    const half = this.spreadPrice / 2;
    return {
      symbol,
      symbolId: '0',
      bid: this.round(mid - half),
      ask: this.round(mid + half),
      spread: this.spreadPrice,
      timestamp: (bar.time + this.baseSeconds) * 1000,
      status: 'MOCK',
    };
  }

  /**
   * Candles for a timeframe, aggregated from the visible base bars.
   *
   * `timeframe` is aggregated rather than fetched, which is what makes the
   * multi-timeframe case work at the replay's own resolution: at 10:37 a 15m
   * read returns the candle that closed at 10:30 and stops, because the one
   * that closes at 10:45 has fifteen minutes of unrevealed price in it.
   */
  async getMarketBars(symbol: string, timeframe: string, count: number): Promise<Bar[]> {
    this.assertSymbol(symbol);
    if (!Number.isInteger(count) || count <= 0) throw new Error('Bar count must be a positive integer.');
    if (!this.supports(timeframe)) {
      /*
       * Refused rather than approximated.
       *
       * Asking a 5m dataset for 1m candles would otherwise be answered by
       * bucketing 5m bars into 1m buckets, which manufactures a resolution the
       * data does not contain and would hand the agent five identical candles
       * per period. A capability that cannot be read says so, and the context
       * layer turns that into a limitation the GOAT is told about.
       */
      throw new Error(
        `This replay's data is at ${this.baseTimeframe}, so ${timeframe} cannot be read from it.`,
      );
    }
    const seconds = timeframeSeconds(timeframe);
    const visible = this.visibleBars();
    if (visible.length === 0) return [];

    if (seconds === this.baseSeconds) return visible.slice(Math.max(0, visible.length - count));

    type Bucket = Bar & { baseBars: number };
    const aggregated: Bucket[] = [];
    const horizon = Math.floor(this.clock.now() / 1000);
    let bucketStart: number | undefined;
    // Carries a member-count alongside the OHLC values, so `flush` can tell a
    // finished bucket from a period the dataset only partly covers.
    let bucket: Bucket | undefined;

    /*
     * A bucket is only a candle once every one of its minutes has closed.
     *
     * The last bucket in the loop is the one that matters, and dropping it is
     * not a detail: at 10:37 the 10:30 bucket has seven minutes of price in it
     * that the agent is not entitled to see, and returning it as a completed
     * candle is look-ahead bias wearing the same shape as a real one. Caught by
     * the boundary test that exists to catch exactly this.
     */
    const flush = (): void => {
      /*
       * Only if the bucket is whole.
       *
       * `bucketStart + seconds <= horizon` says the time period has elapsed; it
       * does not say the period was *filled*. A dataset with a hole — or one
       * stitched from several venue pages — would otherwise have a bucket of nine
       * minutes published as a finished fifteen-minute candle, carrying a close
       * taken from the wrong instant, and the GOAT would be asked to reason about
       * a candle that never happened.
       */
      if (bucket && bucketStart !== undefined && bucketStart + seconds <= horizon && bucket.baseBars >= seconds / this.baseSeconds) {
        aggregated.push(bucket);
      }
      bucket = undefined;
      bucketStart = undefined;
    };

    for (const bar of visible) {
      const start = Math.floor(bar.time / seconds) * seconds;
      if (bucketStart === undefined || start !== bucketStart) {
        flush();
        bucketStart = start;
        bucket = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, baseBars: 0, ...(bar.volume !== undefined ? { volume: 0 } : {}) };
      }
      if (!bucket) continue;
      bucket.baseBars += 1;
      bucket.high = Math.max(bucket.high, bar.high);
      bucket.low = Math.min(bucket.low, bar.low);
      bucket.close = bar.close;
      if (bar.volume !== undefined) bucket.volume = (bucket.volume ?? 0) + bar.volume;
    }
    flush();

    // The member count is bookkeeping for `flush`, not a market fact.
    const candles: Bar[] = aggregated.map((entry) => {
      const { baseBars: _baseBars, ...bar } = entry;
      return bar;
    });
    return candles.slice(Math.max(0, candles.length - count));
  }

  /**
   * Funding, open interest and volume, as of the simulation clock.
   *
   * Every field is read at or before `now` or omitted. A replay that answered
   * with the dataset's last funding print would be handing the agent an
   * outcome: funding is published for a window that has already happened, and
   * the agent would be reasoning with it before it existed.
   *
   * A missing fact is reported as missing, with the reason. The alternative —
   * a plausible zero — is how a GOAT ends up building a thesis on a
   * liquidity assumption nobody measured.
   */
  async getMarketContext(symbol: string): Promise<MarketFacts> {
    this.assertSymbol(symbol);
    const horizon = Math.floor(this.clock.now() / 1000);
    const unavailable: string[] = [];

    const funding = latestAtOrBefore(this.funding, horizon);
    if (funding === undefined) {
      unavailable.push('This dataset publishes no funding rate.');
    }

    const interest = latestAtOrBefore(this.openInterest, horizon);

    const visible = this.visibleBars();
    let volume: number | undefined;
    if (this.volumeBearing) {
      const since = horizon - 86_400;
      volume = visible
        .filter((bar) => bar.time >= since)
        .reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
    } else {
      unavailable.push('This dataset publishes no volume.');
    }

    return {
      symbol,
      ...(funding !== undefined
        ? { fundingRate: funding.value, fundingIntervalHours: 1 }
        : {}),
      ...(interest !== undefined ? { openInterest: interest.value } : {}),
      ...(volume !== undefined ? { dayVolume: volume } : {}),
      ...(unavailable.length > 0 ? { unavailable } : {}),
      /*
       * Where the reading came from, including when. A GOAT shown a funding
       * rate should be able to see it is a replayed reading rather than a live
       * one, and this is the only place that fact exists.
       */
      source: `Historical replay as of ${new Date(this.clock.now()).toISOString()}`,
    };
  }

  async getInstruments(): Promise<InstrumentMetadata[]> {
    return this.instruments;
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  /**
   * The simulation clock, as the environment's own answer to "now".
   *
   * Optional on the environment contract, and implemented here because the
   * backtest genuinely knows the answer: without it, a caller that only wanted a
   * timestamp had to fetch a whole market quote to get one, several times a
   * cycle.
   */
  now(): number {
    return this.clock.now();
  }

  async getAccountState() {
    const account = this.accountSnapshot();
    return {
      balance: account.balance,
      equity: account.equity,
      margin: account.margin,
      freeMargin: account.freeMargin,
      dailyPnL: account.dailyPnL,
      drawdownPercent: account.drawdownPercent,
      realisedSessionPnL: this.balance - this.initialBalance,
    };
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const all = [...this.positions.values()];
    return symbol ? all.filter((position) => position.symbol === symbol) : all;
  }

  /**
   * The book, in the shape the rest of the application reads orders.
   *
   * Not empty: an environment that reports no orders cannot be inspected, and
   * "why is my GOAT still waiting?" is answered by looking at the book.
   */
  async getOrders(): Promise<OrderResult[]> {
    return this.orders.map((order) => ({
      orderId: order.id,
      ...(order.positionId ? { positionId: order.positionId } : {}),
      ...(order.planId ? { clientOrderId: order.planId } : {}),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      volume: order.volume,
      requestedPrice: order.entryPrice,
      ...(order.fillPrice !== undefined ? { executionPrice: order.fillPrice } : {}),
      status: order.status,
      timestamp: order.placedAt * 1000,
      ...(order.terminalReason ? { errorMessage: order.terminalReason } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // Simulated execution
  // -------------------------------------------------------------------------

  /**
   * Fill an order against the simulated book.
   *
   * There is no adapter, no signer and no network path anywhere in this class,
   * so a backtest cannot reach live execution — not because a flag says so, but
   * because there is nothing to call. The `mode` assertion is belt and braces,
   * kept because a subclass that overrode `mode` to `'LIVE'` would otherwise be
   * indistinguishable from a real environment at the interface level.
   */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<SimulatedOrderResult> {
    if (this.mode !== 'BACKTEST') {
      throw new Error('The simulated market refuses to act as anything but a simulation.');
    }
    this.assertSymbol(params.symbol);
    if (!Number.isFinite(params.volume) || params.volume <= 0) {
      return { success: false, error: 'Volume must be positive.', simulated: true };
    }
    const bar = this.currentBar();
    if (!bar) return { success: false, error: 'No bar has closed yet in this simulation.', simulated: true };

    const fillPrice = params.side === 'BUY'
      ? bar.close + this.spreadPrice / 2 + this.slippagePrice
      : bar.close - this.spreadPrice / 2 - this.slippagePrice;

    const positionId = `sim_pos_${this.nextPositionId++}`;
    const commission = this.commissionPerLot * (Math.abs(params.volume) / this.lotSize);
    const position: Position = {
      id: positionId,
      symbol: params.symbol,
      side: params.side,
      volume: params.volume,
      entryPrice: this.round(fillPrice),
      currentPrice: bar.close,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      unrealizedPnL: 0,
      unrealizedPnlPercent: 0,
      timestamp: (bar.time + this.baseSeconds) * 1000,
      commission,
      goatName: params.comment,
    };

    this.balance -= commission;
    this.positions.set(positionId, position);
    if (this.balance + this.unrealized() > this.maxEquitySeen) {
      this.maxEquitySeen = this.balance + this.unrealized();
    }

    return { success: true, positionId, fillPrice: position.entryPrice, simulated: true };
  }

  async modifyPosition(positionId: string, changes: { stopLoss?: number; takeProfit?: number }) {
    const position = this.positions.get(positionId);
    if (!position) return { success: false, error: 'Position not found' };
    if (changes.stopLoss !== undefined) position.stopLoss = changes.stopLoss;
    if (changes.takeProfit !== undefined) position.takeProfit = changes.takeProfit;
    this.positions.set(positionId, position);
    return { success: true };
  }

  async closePosition(
    positionId: string,
    volumeToClose?: number,
  ): Promise<{ success: boolean; pnl?: number; error?: string; rejection?: ExecutionRejection }> {
    const position = this.positions.get(positionId);
    if (!position) return { success: false, error: 'Position not found' };
    if (volumeToClose !== undefined && (!Number.isFinite(volumeToClose) || volumeToClose <= 0 || volumeToClose > position.volume)) {
      return { success: false, error: 'Close volume must be positive and not exceed the open position volume.' };
    }
    const bar = this.currentBar();
    if (!bar) return { success: false, error: 'No bar has closed yet in this simulation.' };

    const exitPrice = position.side === 'BUY'
      ? bar.close - this.spreadPrice / 2 - this.slippagePrice
      : bar.close + this.spreadPrice / 2 + this.slippagePrice;
    const volume = volumeToClose !== undefined && volumeToClose < position.volume ? volumeToClose : position.volume;
    const pnl = this.realise(position, volume, exitPrice, bar.time + this.baseSeconds, 'MANUAL');
    return { success: true, pnl };
  }

  // -------------------------------------------------------------------------
  // The order book
  // -------------------------------------------------------------------------

  /**
   * Rest a limit order.
   *
   * The whole point of this method is that it does *not* fill. It records the
   * price the GOAT said it would pay and returns; the order is only filled later,
   * by a candle that actually traded there. A backtest that filled immediately
   * would be measuring a market order while calling it a limit order.
   *
   * Two refusals, both real:
   *
   *   - **A marketable limit.** A BUY LIMIT above the current price is not a
   *     limit order; it is a market order wearing a limit order's clothes. It is
   *     refused rather than quietly filled at the market, because a GOAT that
   *     proposes one has misunderstood its own order and the replay should say
   *     so instead of grading the intent generously.
   *   - **A non-positive volume or price**, which is a caller bug rather than a
   *     market opinion.
   */
  async placeLimitOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    price: number;
    stopLoss?: number;
    takeProfit?: number;
    /** Seconds. The order stops existing at this instant. */
    expiresAt?: number;
    idempotencyKey?: string;
    planId?: string;
    reason?: string;
    comment?: string;
  }): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (this.mode !== 'BACKTEST') {
      throw new Error('The simulated book refuses to act as anything but a simulation.');
    }
    this.assertSymbol(params.symbol);
    if (!Number.isFinite(params.volume) || params.volume <= 0) {
      return { success: false, error: 'Volume must be positive.' };
    }
    if (!Number.isFinite(params.price) || params.price <= 0) {
      return { success: false, error: 'A limit price must be a positive number.' };
    }

    const bar = this.currentBar();
    if (!bar) return { success: false, error: 'No bar has closed yet in this simulation.' };

    /*
     * Idempotency, because a retried request must not become a second order.
     *
     * The key is the plan's own id, so re-submitting the same trade plan is
     * answered with the order it already produced rather than a duplicate resting
     * at the same price — two orders for one plan is two positions' worth of
     * exposure from one idea.
     */
    const key = params.idempotencyKey ?? params.planId;
    if (key !== undefined) {
      const existing = this.orders.find((order) => order.planId === key && order.status === 'PENDING');
      if (existing) return { success: true, orderId: existing.id };
    }

    if (params.side === 'BUY' && params.price >= bar.close) {
      return {
        success: false,
        error: `A BUY LIMIT at ${params.price} is at or above the ${bar.close} market price, so it would fill immediately rather than wait. Use a market order if entering now is intended.`,
      };
    }
    if (params.side === 'SELL' && params.price <= bar.close) {
      return {
        success: false,
        error: `A SELL LIMIT at ${params.price} is at or below the ${bar.close} market price, so it would fill immediately rather than wait. Use a market order if exiting now is intended.`,
      };
    }

    const order: SimulatedOrder = {
      id: `sim_ord_${this.nextOrderId++}`,
      ...(params.planId ? { planId: params.planId } : {}),
      symbol: params.symbol,
      side: params.side,
      type: 'LIMIT',
      entryPrice: this.round(params.price),
      ...(params.stopLoss !== undefined ? { stopLoss: this.round(params.stopLoss) } : {}),
      ...(params.takeProfit !== undefined ? { takeProfit: this.round(params.takeProfit) } : {}),
      volume: params.volume,
      status: 'PENDING',
      placedAt: bar.time + this.baseSeconds,
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.comment ? { goatName: params.comment } : {}),
    };
    this.orders.push(order);
    return { success: true, orderId: order.id };
  }

  /**
   * Withdraw a resting order.
   *
   * Fills and settled orders cannot be cancelled: an order that has already
   * traded is a position, and cancelling it would be a way to erase a loss by
   * declining to acknowledge it. A second cancellation reports why rather than
   * pretending to have done something.
   */
  async cancelOrder(orderId: string, reason = 'The GOAT withdrew this setup.'): Promise<{ success: boolean; error?: string }> {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    if (!order) return { success: false, error: `No order ${orderId} exists in this replay.` };
    if (order.status !== 'PENDING') {
      return { success: false, error: `Order ${orderId} is ${order.status} and cannot be cancelled.` };
    }
    order.status = 'CANCELLED';
    order.terminalReason = reason;
    return { success: true };
  }

  /**
   * Settle resting orders against the newest visible candle.
   *
   * The fill test is the one the venue would use:
   *
   *   BUY LIMIT fills when `low <= entryPrice` — the market traded down through it
   *   SELL LIMIT fills when `high >= entryPrice` — the market traded up through it
   *
   * and it is evaluated against *closed* candles only, for the same reason stops
   * are: a bar that has not closed has price in it the agent was not entitled to
   * see, and filling against it would be look-ahead wearing a fill's clothes.
   *
   * A fill on a bar that also reaches the stop is resolved by `settleOpenPositions`
   * in the same bar, which checks the stop before the target. That ordering is the
   * honest answer to an OHLC candle whose range spans both the entry and the stop:
   * the data cannot say which came first, so the replay assumes the worse one. The
   * alternative — assuming the entry came first and the stop was never reached —
   * is a flattering guess, and a backtest that flatters itself cannot be used to
   * judge a strategy.
   */
  settleOrders(): SettledOrders {
    const bar = this.currentBar();
    const settled: SettledOrders = { filled: [], expired: [] };
    if (!bar) return settled;

    const nowSeconds = bar.time + this.baseSeconds;
    for (const order of this.orders) {
      if (order.status !== 'PENDING') continue;

      // Expiry is checked before the fill on purpose.
      //
      // An order whose life ended on this boundary did not exist to be filled by
      // it, and resolving the other way would let a bar that arrives exactly on
      // expiry either fill or expire depending on which check ran first — the kind
      // of ordering accident that makes a backtest irreproducible.
      if (order.expiresAt !== undefined && nowSeconds >= order.expiresAt) {
        order.status = 'EXPIRED';
        order.terminalReason = `No fill within ${this.round(order.expiresAt - order.placedAt)} seconds of waiting.`;
        settled.expired.push(order);
        continue;
      }

      const touched = order.side === 'BUY' ? bar.low <= order.entryPrice : bar.high >= order.entryPrice;
      if (!touched) continue;

      // A limit order fills at its limit, not at whatever the candle did. Slippage
      // still applies against us, because a fill at exactly the limit assumes we
      // were first in the queue.
      const fillPrice = order.side === 'BUY'
        ? order.entryPrice + this.slippagePrice
        : order.entryPrice - this.slippagePrice;

      const positionId = this.openPositionFromOrder(order, fillPrice, nowSeconds);
      order.status = 'FILLED';
      order.filledAt = nowSeconds;
      order.fillPrice = this.round(fillPrice);
      order.positionId = positionId;
      settled.filled.push(order);
    }
    return settled;
  }

  /**
   * Turn a filled order into a position.
   *
   * The same accounting a market fill uses — commission, equity tracking, the
   * lot — so a limit fill and a market fill are not two different trades.
   */
  private openPositionFromOrder(order: SimulatedOrder, fillPrice: number, atSeconds: number): string {
    const positionId = `sim_pos_${this.nextPositionId++}`;
    const commission = this.commissionPerLot * (Math.abs(order.volume) / this.lotSize);
    const position: Position = {
      id: positionId,
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entryPrice: this.round(fillPrice),
      currentPrice: this.round(fillPrice),
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      unrealizedPnL: 0,
      unrealizedPnlPercent: 0,
      timestamp: atSeconds * 1000,
      commission,
      ...(order.goatName ? { goatName: order.goatName } : {}),
    };
    this.balance -= commission;
    this.positions.set(positionId, position);
    if (this.balance + this.unrealized() > this.maxEquitySeen) {
      this.maxEquitySeen = this.balance + this.unrealized();
    }
    return positionId;
  }

  /** Every order this replay has seen, oldest first. */
  simulatedOrders(): SimulatedOrder[] {
    return [...this.orders];
  }

  /** Orders still resting. */
  restingOrders(): SimulatedOrder[] {
    return this.orders.filter((order) => order.status === 'PENDING');
  }

  /** The order a trade plan produced, when it produced one. */
  orderForPlan(planId: string): SimulatedOrder | undefined {
    return this.orders.find((order) => order.planId === planId);
  }

  /**
   * Move open positions to the newest visible close.

   *
   * Called once per replayed base bar, never with a bar the agent could not
   * have seen, and evaluated against that bar's own high and low — so a stop
   * is hit if the price reached it inside the bar, which is the only honest
   * treatment of 1m data and the same one the live venue adapter applies to a
   * candle.
   */
  /**
   * Mark open positions to market. The same act as `settleOpenPositions`.
   *
   * Two names for one behaviour: the engine drives the book through the
   * `TradeBook` contract, which names it `settlePositions`, while callers that are
   * only stepping the market — tests, a hand-driven replay — have always called
   * `settleOpenPositions`. Rather than make every one of them change, the
   * descriptive name is kept as the implementation and this is the contract name.
   */
  settlePositions(): void {
    this.settleOpenPositions();
  }

  settleOpenPositions(): void {
    const bar = this.currentBar();
    if (!bar) return;

    for (const position of [...this.positions.values()]) {
      const stopHit = position.side === 'BUY'
        ? position.stopLoss !== undefined && bar.low <= position.stopLoss
        : position.stopLoss !== undefined && bar.high >= position.stopLoss;
      const targetHit = position.side === 'BUY'
        ? position.takeProfit !== undefined && bar.high >= position.takeProfit
        : position.takeProfit !== undefined && bar.low <= position.takeProfit;

      if (stopHit && position.stopLoss !== undefined) {
        // A stop is a promise about a price, so it fills there rather than at
        // wherever the bar closed.
        this.realise(position, position.volume, position.stopLoss, bar.time + this.baseSeconds, 'STOP_LOSS');
        continue;
      }
      if (targetHit && position.takeProfit !== undefined) {
        this.realise(position, position.volume, position.takeProfit, bar.time + this.baseSeconds, 'TAKE_PROFIT');
        continue;
      }

      position.currentPrice = bar.close;
      const difference = position.side === 'BUY' ? bar.close - position.entryPrice : position.entryPrice - bar.close;
      position.unrealizedPnL = this.round2(difference * position.volume);
      position.unrealizedPnlPercent = this.round2((difference / position.entryPrice) * 100);
      this.positions.set(position.id, position);
    }

    if (this.balance + this.unrealized() > this.maxEquitySeen) {
      this.maxEquitySeen = this.balance + this.unrealized();
    }
  }

  /** Close everything at the last visible close, and report what happened. */
  async finalize(): Promise<void> {
    const bar = this.currentBar();
    if (!bar) return;
    for (const position of [...this.positions.values()]) {
      const exitPrice = position.side === 'BUY'
        ? bar.close - this.spreadPrice / 2 - this.slippagePrice
        : bar.close + this.spreadPrice / 2 + this.slippagePrice;
      this.realise(position, position.volume, exitPrice, bar.time + this.baseSeconds, 'MANUAL');
    }
  }

  private realise(
    position: Position,
    volume: number,
    exitPrice: number,
    atSeconds: number,
    reason: Trade['exitReason'],
  ): number {
    const difference = position.side === 'BUY' ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const pnl = this.round2(difference * volume);
    const exitCommission = this.commissionPerLot * (volume / this.lotSize);
    /*
     * The whole round trip, not just this side of it.
     *
     * The balance is charged commission on entry *and* on exit, so a trade
     * carrying only the exit leg described a number the account never saw — and a
     * report built by summing `pnl` therefore disagreed with the equity curve by
     * exactly one commission per trade, with no visible cause. Carrying both legs
     * makes `pnl - commission` the figure that reconciles.
     */
    const commission = this.round2((position.commission ?? 0) + exitCommission);

    this.balance += pnl - exitCommission;
    this.trades.push({
      id: `sim_trd_${this.nextTradeId++}`,
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      volume,
      entryPrice: position.entryPrice,
      exitPrice: this.round(exitPrice),
      entryTime: Math.floor(position.timestamp / 1000),
      exitTime: atSeconds,
      pnl,
      pnlPercent: this.round2((difference / position.entryPrice) * 100),
      returnPercent: this.round2((difference / position.entryPrice) * 100),
      commission,
      exitReason: reason,
    });

    if (volume >= position.volume) {
      this.positions.delete(position.id);
    } else {
      position.volume = this.round(position.volume - volume);
      this.positions.set(position.id, position);
    }

    return pnl;
  }

  /** Closed trades, oldest first. */
  simulatedTrades(): Trade[] {
    return [...this.trades];
  }

  /** Open positions, for the session's own bookkeeping. */
  openPositions(): Position[] {
    return [...this.positions.values()];
  }

  /**
   * The last trade that closed a position, used by the session to report an
   * outcome exactly once.
   */
  tradeCount(): number {
    return this.trades.length;
  }

  /**
   * Pips, when the instrument has a pip.
   *
   * A reporting convenience, not a model: the P&L rule is linear, exactly as it
   * is in the live adapter, and a pip is only ever a way to express a distance
   * the user reads more easily.
   */
  pipsFor(trade: Trade): number | undefined {
    if (this.pipSize === undefined) return undefined;
    return this.round((trade.exitPrice - trade.entryPrice) / this.pipSize) * (trade.side === 'BUY' ? 1 : -1);
  }

  private unrealized(): number {
    return [...this.positions.values()].reduce((sum, position) => sum + (position.unrealizedPnL ?? 0), 0);
  }

  private assertSymbol(symbol: string): void {
    if (symbol !== this.symbol) {
      throw new Error(`This simulation is configured for ${this.symbol}, not ${symbol}.`);
    }
  }

  private round(value: number): number {
    return Number(value.toFixed(this.pricePrecision));
  }

  private round2(value: number): number {
    return Number(value.toFixed(2));
  }
}

/**
 * The newest reading published at or before an instant.
 *
 * The boundary again, for facts rather than candles: a reading published after
 * the horizon does not exist yet, so asking for the closest one would silently
 * answer with the future.
 */
export function latestAtOrBefore(facts: SimulationFact[], horizonSeconds: number): SimulationFact | undefined {
  let found: SimulationFact | undefined;
  for (const fact of facts) {
    if (fact.time <= horizonSeconds) found = fact;
    else break;
  }
  return found;
}

/**
 * Reject a dataset that would make a replay lie.
 *
 * Two checks, both of which have silently corrupted backtests before:
 * out-of-order candles (which make "the last visible bar" mean something else)
 * and a bar whose own OHLC is impossible (which produces indicators no human
 * would believe). A simulation is allowed to be wrong about the market; it is
 * not allowed to be wrong about its own data.
 */
export function validateDataset(bars: Bar[]): Bar[] {
  let previous: Bar | undefined;
  return bars.map((bar, index) => {
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value))) {
      throw new Error(`Historical bar ${index} contains a non-finite value.`);
    }
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) {
      throw new Error(`Historical bar at ${bar.time} is not a possible candle.`);
    }
    if (previous && bar.time <= previous.time) {
      throw new Error(`Historical data must be strictly chronological; ${bar.time} does not follow ${previous.time}.`);
    }
    previous = bar;
    return { ...bar };
  });
}

function defaultInstrument(symbol: string, pricePrecision: number): InstrumentMetadata {
  return {
    symbol,
    displayName: symbol,
    assetClass: 'FOREX',
    provider: 'HYPERLIQUID',
    providerSymbol: symbol,
    providerMarketId: symbol,
    quoteCurrency: 'USD',
    baseCurrency: symbol.slice(0, 3),
    pricePrecision,
    sizePrecision: 0,
    sizeStep: 1,
    minOrderSize: 1,
    maxOrderSize: 1_000_000,
  };
}