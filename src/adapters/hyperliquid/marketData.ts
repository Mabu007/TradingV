import { eventBus } from '../../types/events';
import { Bar, Quote, Timeframe } from '../../types/trading';
import type { MarketFacts } from '../../engine/agents/types';
import { MarketDataProvider } from '../marketData';
import {
  configuredVenue,
  parseVenueEnvironment,
  venueFor,
  type Venue,
  type VenueEnvironment,
} from '../../config/venue';
import { fromHyperliquidCandle, normalizeSymbol, quoteFromBook, toHyperliquidInterval, classifyAsset, instrumentMetadata, marketAvailability, marketSymbol, tradingInstrument, uniqueSymbolLabels } from './normalizer';
import {
  AssetClass,
  InstrumentLookup,
  InstrumentMetadata,
  InstrumentStatus,
  TradingInstrument,
} from '../../types/instruments';

/**
 * What the venue connection is doing.
 *
 * `STALE` is the important one. A socket can be open and receiving
 * nothing, and a UI that only distinguishes connected from disconnected
 * will happily keep showing a last-known price as though it were live.
 * Staleness is a state, not an absence, precisely so it can be shown.
 */
export type MarketDataStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'STALE'
  | 'ERROR';

type StatusListener = (status: MarketDataStatus) => void;

/**
 * How long a connection may be silent before it is called stale.
 *
 * Well inside any interval the venue publishes on for the markets this
 * product trades, and well outside a normal network hiccup. A quote
 * older than this is not shown as a current price.
 */
export const STALE_AFTER_MS = 30_000;

/** Reconnect backoff. Bounded, because a silent infinite retry is a hang. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Info-endpoint transport.
 *
 * It is injectable so discovery behaviour (including markets the
 * provider lists without a price) can be verified deterministically
 * without a network round trip. Production always uses the live
 * transport.
 */
/**
 * How long a published funding figure is treated as current.
 *
 * Hyperliquid funds hourly, so a minute is well inside the window in which
 * the number is still the number.
 */
const CONTEXT_TTL_MS = 60_000;

export interface HyperliquidTransport {
  request(body: Record<string, unknown>): Promise<unknown>;
}

export interface HyperliquidCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }
interface HyperliquidAsset { name: string; szDecimals: number; isDelisted?: boolean; maxLeverage?: number; }
/*
 * The per-asset context the venue publishes.
 *
 * `funding`, `openInterest` and `dayNtlVlm` are the non-price facts that
 * decide whether a move has anything behind it. They are all optional here
 * because the venue omits them for assets that do not have them, and that
 * omission is a real answer rather than a missing feature: a spot index has
 * no funding, and reporting one would be inventing it.
 */
interface HyperliquidAssetCtx {
  midPx?: string;
  markPx?: string;
  oraclePx?: string;
  prevDayPx?: string;
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
}
interface HyperliquidDex { name: string; fullName?: string; }

export class HyperliquidMarketDataAdapter implements MarketDataProvider {
  private venue: Venue;
  private socket?: WebSocket;
  private connected = false;
  private statusListeners = new Set<StatusListener>();
  private quoteSubscribers = new Map<string, Set<(quote: Quote) => void>>();
  private barSubscribers = new Map<string, Set<(bar: Bar, isClosed: boolean) => void>>();
  private lastQuotes = new Map<string, Quote>();
  private lastBars = new Map<string, Bar>();
  private subscriptions = new Map<string, Record<string, unknown>>();
  private instruments?: TradingInstrument[];
  /**
   * The last venue context row, held briefly.
   *
   * Funding is quoted on a schedule and this is read per reasoning step, so a
   * short memo keeps a burst of reads from turning into a burst of round
   * trips without making the answer stale enough to mislead.
   */
  private contextCache?: { coin: string; at: number; ctx: HyperliquidAssetCtx | undefined };
  private instrumentByProviderSymbol = new Map<string, TradingInstrument>();
  private discoveryPromise?: Promise<TradingInstrument[]>;
  /** Wall clock of the last message the venue actually sent us. */
  private lastMessageAt?: number;
  /** Last venue sequence accepted per (market, timeframe). */
  private lastSequence = new Map<string, number>();
  /** Last venue close timestamp accepted per (market, timeframe). */
  private lastCandleTime = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Set when the caller asked to disconnect, so a close is not retried. */
  private closingIntentionally = false;
  /**
   * Incremented by every deliberate disconnect.
   *
   * A deliberate disconnect has to invalidate an attempt that is *already
   * in flight*, not just one that has not been scheduled yet. Without a
   * token, a connect that was awaiting its socket when `disconnect()`
   * landed still completes, and the user is left with a socket they
   * asked to close — plus a status change they did not cause. Every
   * callback captured by an attempt carries the token it started with and
   * does nothing if it is stale, which makes "this attempt is over" a
   * checkable fact rather than a hope about ordering.
   */
  private connectionEpoch = 0;

  constructor(
    environment: VenueEnvironment = configuredVenue().environment,
    private readonly transport: HyperliquidTransport = {
      request: async (body: Record<string, unknown>) => {
        // The URL comes from the resolved venue, so a caller cannot hand
        // this transport a host that belongs to the other environment.
        const response = await fetch(venueFor(environment).restInfoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(
            `Hyperliquid info request failed (${response.status}).`,
          );
        }

        return response.json();
      },
    },
  ) {
    this.venue = venueFor(environment);
  }

  /**
   * Move to the other environment.
   *
   * The whole point of it being one method rather than a field: every
   * piece of environment-derived state is dropped together — the socket,
   * the subscriptions' venue binding, the discovery memo and the sequence
   * memories — so a client cannot come back from a network switch
   * carrying candles from the venue it left.
   */
  async setEnvironment(environment: VenueEnvironment): Promise<void> {
    if (environment === this.venue.environment) return;
    await this.disconnect();
    this.venue = venueFor(environment);
    this.instruments = undefined;
    this.discoveryPromise = undefined;
    this.instrumentByProviderSymbol.clear();
    this.lastSequence.clear();
    this.lastCandleTime.clear();
    this.lastQuotes.clear();
    this.lastBars.clear();
    this.lastMessageAt = undefined;
  }

  /** The environment this client is bound to. Never inferred by a caller. */
  get environment(): VenueEnvironment {
    return this.venue.environment;
  }

  /** The live venue, for diagnostics and the audit trail. */
  get venueConfig(): Venue {
    return this.venue;
  }

  /**
   * The active trading universe.
   *
   * Only currently tradeable markets are returned. A market the provider
   * lists without a price is excluded here rather than being quoted from
   * an invented value; it is still reachable through
   * {@link getMarketStatus}.
   */
  /**
   * What the venue publishes about a market beyond price and candles.
   *
   * Reads the same `metaAndAssetCtxs` payload the instrument discovery
   * already fetches, memoised for the short window in which it stays true,
   * because funding changes on a schedule and this is called per reasoning
   * step rather than per tick.
   *
   * A field the venue does not publish is reported in `unavailable` with a
   * reason. It is never filled in with a zero: a GOAT told funding is zero
   * concludes funding is neutral, and a GOAT told there is no funding on this
   * market plans around that. Those are different claims and only one is true.
   */
  async getMarketContext(symbol: string): Promise<MarketFacts> {
    const unavailable: string[] = [];

    if (!this.instruments && !normalizeSymbol(symbol).includes(':')) await this.getInstruments();
    /*
     * Resolved through the adapter's own symbol matching rather than a second,
     * weaker version of it. The first attempt here compared the raw symbol and
     * a `providerSymbol` suffix, which matched nothing: the app's canonical
     * form is `EURUSD` while this venue publishes `EUR/USD` as `xyz:EUR`, so
     * every instrument came back "not a market this venue serves" and the
     * feature reported itself unavailable while being perfectly capable.
     */
    const found = this.findDiscovered(this.instruments, symbol);
    const coin = found
      ? found.providerSymbol.split(':').pop() ?? found.providerSymbol
      : normalizeSymbol(symbol);

    const now = Date.now();
    if (this.contextCache && this.contextCache.coin === coin && now - this.contextCache.at < CONTEXT_TTL_MS) {
      return this.readContext(symbol, coin, this.contextCache.ctx, unavailable);
    }

    if (!found) {
      return {
        symbol,
        unavailable: [`${symbol} is not a market this venue serves.`],
        source: 'hyperliquid:metaAndAssetCtxs',
      };
    }

    /*
     * Read from discovery's own snapshot.
     *
     * This used to issue its own `metaAndAssetCtxs` with no `dex`, which
     * returns only the default dex — the perp universe, containing BTC and
     * ETH. Every instrument this product actually trades lives on a HIP-3
     * namespace, and those universes list their assets fully qualified
     * (`xyz:EUR`). So the lookup matched nothing and every symbol came back
     * "the venue published no context row". Reusing the rows discovery already
     * paid for fixes both mistakes at once.
     */
    const context = this.contextByProviderSymbol.get(found.providerSymbol.toLowerCase())
      ?? this.contextByProviderSymbol.get(found.providerSymbol);
    this.contextCache = { coin, at: now, ctx: context };
    return this.readContext(symbol, coin, context, unavailable);
  }

  /** Turn one venue context row into the facts a GOAT may reason over. */
  private readContext(
    symbol: string,
    coin: string,
    context: HyperliquidAssetCtx | undefined,
    unavailable: string[],
  ): MarketFacts {
    if (!context) {
      return {
        symbol,
        unavailable: [`The venue published no context row for ${symbol}.`],
        source: 'hyperliquid:metaAndAssetCtxs',
      };
    }

    const number = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const funding = number(context.funding);
    const mark = number(context.markPx);
    const previous = number(context.prevDayPx);
    if (funding === undefined) {
      unavailable.push(`No funding rate is published for ${symbol}.`);
    }

    return {
      symbol,
      ...(funding !== undefined ? { fundingRate: funding, fundingIntervalHours: 1 } : {}),
      ...(number(context.openInterest) !== undefined ? { openInterest: number(context.openInterest) } : {}),
      ...(number(context.dayNtlVlm) !== undefined ? { dayVolume: number(context.dayNtlVlm) } : {}),
      ...(mark !== undefined ? { markPrice: mark } : {}),
      ...(number(context.oraclePx) !== undefined ? { oraclePrice: number(context.oraclePx) } : {}),
      ...(mark !== undefined && previous !== undefined && previous !== 0
        ? { change24hPercent: ((mark - previous) / previous) * 100 }
        : {}),
      ...(unavailable.length > 0 ? { unavailable } : {}),
      source: 'hyperliquid:metaAndAssetCtxs',
    };
  }

  async getInstruments(assetClasses: AssetClass[] = ['FOREX', 'COMMODITY', 'INDEX']): Promise<TradingInstrument[]> {
    const discovered = await this.discoverOnce();

    return discovered.filter(
      (instrument) =>
        assetClasses.includes(instrument.assetClass) &&
        instrument.availability === 'TRADEABLE',
    );
  }

  /**
   * Discovered markets, including ones the provider currently lists
   * without a price. Used for diagnostics, never for execution.
   */
  async getDiscoveredInstruments(
    assetClasses: AssetClass[] = ['FOREX', 'COMMODITY', 'INDEX'],
  ): Promise<TradingInstrument[]> {
    const discovered = await this.discoverOnce();

    return discovered.filter((instrument) =>
      assetClasses.includes(instrument.assetClass),
    );
  }

  /**
   * Why a market can or cannot be traded right now.
   */
  async getMarketStatus(
    symbol: string,
  ): Promise<InstrumentStatus> {
    const discovered = await this.discoverOnce();
    const instrument = this.findDiscovered(discovered, symbol);

    if (!instrument) {
      return {
        availability: 'UNAVAILABLE',
        reason: 'This market is not available on Hyperliquid.',
      };
    }

    return instrument.availability === 'TRADEABLE'
      ? { availability: 'TRADEABLE' }
      : {
          availability: 'UNAVAILABLE',
          reason:
            instrument.unavailableReason ??
            'This market is not publishing a price right now.',
        };
  }

  /**
   * Memoised discovery, retried after a failure.
   *
   * The in-flight promise is shared so concurrent callers make one request
   * rather than a stampede. It is cleared on rejection, because a cached
   * rejected promise is permanent: one offline blip or one 429 left the
   * app with no instruments, no quotes, and no orders for the rest of the
   * session, with no way back short of a page reload.
   */
  private async discoverOnce(): Promise<TradingInstrument[]> {
    if (this.instruments) return this.instruments;
    if (!this.discoveryPromise) {
      const attempt = this.discoverInstruments();
      this.discoveryPromise = attempt;
      // Clearing on failure means the next caller retries. Clearing on
      // success is unnecessary (`this.instruments` short-circuits) but
      // keeps the memo from holding a large array alive twice.
      attempt.catch(() => {
        if (this.discoveryPromise === attempt) this.discoveryPromise = undefined;
      });
    }
    return this.discoveryPromise;
  }

  onStatusChange(listener: StatusListener): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }

  /**
   * What the connection is doing, honestly.
   *
   * `isConnected` alone is a lie in the case that matters: a socket that
   * opened and then went quiet is open, connected, and not receiving
   * anything. So the state is derived from the last message as well as
   * the socket, and `STALE` is reported for the window where a price on
   * screen is a price from the past.
   */
  getConnectionState() {
    const lastMessageAt = this.lastMessageAt;
    const stale =
      this.connected &&
      lastMessageAt !== undefined &&
      Date.now() - lastMessageAt > STALE_AFTER_MS;
    return {
      isConnected: this.connected,
      /** True when the venue has sent nothing for longer than it should. */
      isStale: Boolean(stale),
      environment: this.venue.environment,
      venue: this.venue.host,
      lastMessageAt,
      /** Milliseconds since the last venue message, or undefined if none. */
      silenceMs: lastMessageAt === undefined ? undefined : Date.now() - lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /** Feeds a captured provider candle through the production normalization/event path. */
  ingestCandleFixture(candle: HyperliquidCandle): void { this.handleMessage(JSON.stringify({ channel: 'candle', data: candle })); }

  registerInstrument(instrument: TradingInstrument): void { this.instrumentByProviderSymbol.set(instrument.providerSymbol, instrument); }

  async connect(): Promise<void> {
    if (this.connected || (this.socket && this.socket.readyState === WebSocket.CONNECTING) || typeof WebSocket === 'undefined') return;
    this.closingIntentionally = false;
    const epoch = this.connectionEpoch;
    this.emitStatus('CONNECTING');
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(this.venue.websocketUrl);
      this.socket = socket;
      const timeout = setTimeout(() => {
        // A deliberate disconnect during the handshake makes this timer
        // irrelevant. Without the epoch check it would fire later and
        // report an error for a connection the user closed on purpose.
        if (epoch !== this.connectionEpoch) return;
        if (!this.connected) { socket.close(); this.emitStatus('ERROR'); }
        resolve();
      }, 5000);
      socket.onopen = () => {
        clearTimeout(timeout);
        if (epoch !== this.connectionEpoch) { socket.close(); resolve(); return; }
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        this.emitStatus('CONNECTED');
        // A reconnect that forgets its subscriptions is a reconnect that
        // silently stops delivering quotes, which looks identical to a
        // quiet market.
        this.resubscribe();
        resolve();
      };
      socket.onmessage = (message) => {
        // A socket from a superseded attempt must not deliver into the
        // current one. Two live sockets interleaving messages is how a
        // chart ends up with bars from two environments on it.
        if (epoch !== this.connectionEpoch) return;
        this.handleMessage(message.data);
      };
      socket.onerror = () => { if (epoch === this.connectionEpoch && !this.connected) this.emitStatus('ERROR'); };
      socket.onclose = () => {
        // A superseded attempt's socket is not the current connection,
        // so its close is not a disconnect worth reporting.
        if (epoch !== this.connectionEpoch) return;
        this.connected = false;
        this.socket = undefined;
        if (this.closingIntentionally) {
          this.emitStatus('DISCONNECTED');
          return;
        }
        this.scheduleReconnect();
      };
    });
  }

  /**
   * Reconnect with bounded backoff.
   *
   * Bounded on purpose. A venue that is down should present as down; an
   * unbounded retry loop presents as "connecting" forever, which is a
   * state a user cannot act on and a developer cannot diagnose.
   */
  private scheduleReconnect(): void {
    if (this.closingIntentionally) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emitStatus('ERROR');
      return;
    }
    this.reconnectAttempts += 1;
    this.emitStatus('RECONNECTING');
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.closingIntentionally = true;
    // Invalidate any attempt in flight before touching the socket, so its
    // callbacks are already stale by the time `close()` runs them.
    this.connectionEpoch += 1;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.lastMessageAt = undefined;
    this.emitStatus('DISCONNECTED');
    socket?.close();
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (!this.instruments && !normalizeSymbol(symbol).includes(':')) await this.getInstruments();
    const coin = this.resolveProviderSymbol(symbol);
    const response = await this.request({ type: 'l2Book', coin });
    const levels = response as { levels?: Array<Array<{ px: string; sz: string }>> };
    const bid = Number(levels.levels?.[0]?.[0]?.px);
    const ask = Number(levels.levels?.[1]?.[0]?.px);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) throw new Error(`Hyperliquid returned no order book for ${coin}.`);
    const quote = quoteFromBook(this.resolveDisplaySymbol(coin), bid, ask);
    this.lastQuotes.set(coin, quote);
    return quote;
  }

  async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<Bar[]> {
    if (!this.instruments && !normalizeSymbol(symbol).includes(':')) await this.getInstruments();
    const endTime = Date.now();
    const startTime = endTime - intervalMilliseconds(timeframe) * count;
    const bars = await this.getBarsInRange(symbol, timeframe, startTime, endTime);
    return bars.slice(-count);
  }

  async getBarsInRange(symbol: string, timeframe: Timeframe, startTime: number, endTime: number): Promise<Bar[]> {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) throw new Error('Historical candle range must be finite and increasing.');
    if (!this.instruments && !normalizeSymbol(symbol).includes(':')) await this.getInstruments();
    const coin = this.resolveProviderSymbol(symbol);
    const rangeResponse = await this.request({ type: 'candleSnapshot', req: { coin, interval: toHyperliquidInterval(timeframe), startTime, endTime } });
    const bars = (rangeResponse as HyperliquidCandle[]).map((raw) => fromHyperliquidCandle(raw));
    if (bars.length === 0) throw new Error(`Hyperliquid returned no candles for ${coin}.`);
    return bars;
  }

  subscribeQuote(symbol: string, callback: (quote: Quote) => void): () => void {
    const coin = this.resolveProviderSymbol(symbol); const set = this.quoteSubscribers.get(coin) || new Set(); set.add(callback); this.quoteSubscribers.set(coin, set);
    this.subscribe({ type: 'l2Book', coin }); void this.connect();
    return () => { set.delete(callback); if (set.size === 0) this.quoteSubscribers.delete(coin); };
  }

  subscribeBars(symbol: string, timeframe: Timeframe, callback: (bar: Bar, isClosed: boolean) => void): () => void {
    const coin = this.resolveProviderSymbol(symbol); const key = `${coin}:${timeframe}`; const set = this.barSubscribers.get(key) || new Set(); set.add(callback); this.barSubscribers.set(key, set);
    this.subscribe({ type: 'candle', coin, interval: toHyperliquidInterval(timeframe) }); void this.connect();
    return () => { set.delete(callback); if (set.size === 0) this.barSubscribers.delete(key); };
  }

  private subscribe(subscription: Record<string, unknown>): void {
    const key = JSON.stringify(subscription); this.subscriptions.set(key, subscription);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ method: 'subscribe', subscription }));
  }

  private resubscribe(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const subscription of this.subscriptions.values()) this.socket.send(JSON.stringify({ method: 'subscribe', subscription }));
  }

  private async request(body: Record<string, unknown>): Promise<unknown> {
    return this.transport.request(body);
  }

  /**
   * One venue message, guarded.
   *
   * Three things happen here that did not happen before, and all three
   * exist because a websocket is not a stream in order:
   *
   *  - **Staleness is published.** Every accepted message restarts the
   *    silence clock, so the connection state can be honest about a feed
   *    that has gone quiet while the socket is still open.
   *  - **Duplicates and reordering are refused.** The venue sends a
   *    per-candle sequence and a close timestamp; a message that is not
   *    newer than the last accepted one for that market and timeframe is
   *    dropped rather than normalised into a bar update. Without this a
   *    reconnect that replays its tail moves the chart backwards.
   *  - **Nothing is invented.** A message that does not parse, or that
   *    carries no usable price, produces no event at all rather than a
   *    plausible one.
   */
  private handleMessage(raw: string): void {
    let message: { channel?: string; data?: unknown }; try { message = JSON.parse(raw); } catch { return; }
    this.lastMessageAt = Date.now();
    if (message.channel === 'l2Book') {
      const data = message.data as { coin?: string; levels?: Array<Array<{ px: string }>> };
      const providerSymbol = normalizeSymbol(data.coin || ''); const bid = Number(data.levels?.[0]?.[0]?.px); const ask = Number(data.levels?.[1]?.[0]?.px);
      if (!providerSymbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
      const symbol = this.resolveDisplaySymbol(providerSymbol); const quote = quoteFromBook(symbol, bid, ask); this.lastQuotes.set(providerSymbol, quote); this.quoteSubscribers.get(providerSymbol)?.forEach((callback) => callback(quote)); eventBus.emit({ type: 'MARKET_QUOTE', data: quote });
    }
    if (message.channel === 'candle') {
      const rawCandle = message.data as HyperliquidCandle;
      if (!rawCandle || typeof rawCandle.s !== 'string' || typeof rawCandle.i !== 'string') return;
      const providerSymbol = normalizeSymbol(rawCandle.s);
      if (!providerSymbol) return;
      const key = `${providerSymbol}:${rawCandle.i}`;

      if (!this.acceptCandle(key, rawCandle)) return;

      const bar = fromHyperliquidCandle(rawCandle);
      const isClosed = Date.now() >= rawCandle.T;
      this.lastBars.set(key, bar);
      this.barSubscribers.get(key)?.forEach((callback) => callback(bar, isClosed));
      eventBus.emit({ type: 'BAR_UPDATE', symbol: this.resolveDisplaySymbol(providerSymbol), timeframe: rawCandle.i, bar, isClosed });
    }
  }

  /**
   * Whether a candle is newer than the last one accepted for its key.
   *
   * The venue sequence is authoritative where the venue provides one.
   * Where it does not, the close timestamp is used, because a candle that
   * reports a time at or before the last accepted one is by definition not
   * news. Clock skew between the venue and the browser is tolerated by
   * comparing sequences when they exist and timestamps only when they do
   * not.
   */
  private acceptCandle(key: string, candle: HyperliquidCandle): boolean {
    const sequence = typeof candle.n === 'number' ? candle.n : undefined;
    const lastSequence = this.lastSequence.get(key);
    if (sequence !== undefined && lastSequence !== undefined) {
      if (sequence <= lastSequence) return false;
      this.lastSequence.set(key, sequence);
      if (Number.isFinite(candle.T)) this.lastCandleTime.set(key, candle.T);
      return true;
    }

    const lastTime = this.lastCandleTime.get(key);
    if (lastTime !== undefined && Number.isFinite(candle.T)) {
      if (candle.T < lastTime) return false;
      this.lastCandleTime.set(key, candle.T);
      if (sequence !== undefined) this.lastSequence.set(key, sequence);
      return true;
    }

    if (sequence !== undefined) this.lastSequence.set(key, sequence);
    if (Number.isFinite(candle.T)) this.lastCandleTime.set(key, candle.T);
    return true;
  }

  /**
   * Context rows captured during discovery, keyed by provider symbol.
   *
   * Discovery already fetches `metaAndAssetCtxs` for the default dex *and*
   * every HIP-3 namespace, and the funding, open interest and volume it needs
   * are in that same payload. This map keeps them, so reading market context
   * costs no extra request and cannot drift from the prices quoted beside it.
   */
  private readonly contextByProviderSymbol = new Map<string, HyperliquidAssetCtx>();

  private async discoverInstruments(): Promise<TradingInstrument[]> {
    const [defaultMeta, dexes] = await Promise.all([
      this.request({ type: 'metaAndAssetCtxs' }) as Promise<[ { universe: HyperliquidAsset[] }, HyperliquidAssetCtx[] ]>,
      this.request({ type: 'perpDexs' }) as Promise<Array<HyperliquidDex | null>>,
    ]);
    const metas: Array<{ dex?: string; meta: { universe: HyperliquidAsset[] }; contexts: HyperliquidAssetCtx[] }> = [{ meta: defaultMeta[0], contexts: defaultMeta[1] }];
    const discoveredPrices = new Map<
      string,
      { price: number; availability: { availability: 'TRADEABLE' | 'UNAVAILABLE'; reason?: string }; previousDayPrice: number }
    >();
    const namedDexes = dexes.filter((dex): dex is HyperliquidDex => Boolean(dex?.name));
    const dexResults = await Promise.all(namedDexes.map(async (dex) => {
      try {
        const result = await this.request({ type: 'metaAndAssetCtxs', dex: dex.name }) as [{ universe: HyperliquidAsset[] }, HyperliquidAssetCtx[]];
        return { dex: dex.name, meta: result[0], contexts: result[1] };
      } catch { return undefined; }
    }));
    metas.push(...dexResults.filter((result): result is NonNullable<typeof result> => Boolean(result)));

    const discovered: TradingInstrument[] = [];
    const discoveredMetadata: InstrumentMetadata[] = [];

    for (const { dex, meta, contexts } of metas) {
      meta.universe.forEach((asset, index) => {
        const providerSymbol = normalizeSymbol(asset.name);
        const assetClass = classifyAsset(providerSymbol);
        const context = contexts[index];
        if (context) this.contextByProviderSymbol.set(providerSymbol, context);

        // The product universe is sourced from deployed HIP-3 namespaces;
        // default-DEX assets are not treated as FX, commodity, or index
        // instruments.
        if (!dex || !assetClass || asset.isDelisted) return;

        /*
         * Tradeability requires a price the venue actually quotes a
         * market with: the mid of the book, or the mark price. An
         * oracle-only market has no book behind it, so it is listed but
         * not tradeable. The oracle price is never promoted into an
         * executable price.
         */
        const quotedPrice = context?.midPx ?? context?.markPx;
        const price = Number(quotedPrice);
        const availability = marketAvailability(price);

        // Precision is a formatting fact, so any published price works.
        const precision = decimalPlaces(
          context?.midPx ?? context?.markPx ?? context?.oraclePx,
        );

        discoveredMetadata.push(instrumentMetadata({
          providerSymbol,
          assetClass,
          providerDex: dex,
          pricePrecision: precision,
          sizePrecision: asset.szDecimals,
          maxLeverage: typeof asset.maxLeverage === 'number' && asset.maxLeverage > 0 ? asset.maxLeverage : undefined,
        }));

        /*
         * The venue publishes its own 24h-ago reference price with every
         * asset context. It is the only honest basis for a 24h change:
         * deriving one from candles loaded so far would measure the
         * window that happens to be cached, not 24 hours.
         */
        const previousDayPrice = Number(context?.prevDayPx);

        discoveredPrices.set(providerSymbol, {
          price,
          availability,
          previousDayPrice,
        });
      });
    }

    /*
     * Two namespaces can publish the same asset. Colliding labels are
     * made unique before anything is published, so an order can never be
     * validated against a different market than the one it names.
     */
    const uniqueSymbols = uniqueSymbolLabels(discoveredMetadata);

    for (const metadata of discoveredMetadata) {
      const symbol = uniqueSymbols.get(metadata.providerSymbol) ?? metadata.symbol;
      const resolved: InstrumentMetadata = { ...metadata, symbol };
      const { price, availability, previousDayPrice } =
        discoveredPrices.get(resolved.providerSymbol) ?? {
          price: Number.NaN,
          availability: marketAvailability(Number.NaN),
          previousDayPrice: Number.NaN,
        };

      const instrument = tradingInstrument(
        resolved,
        SUPPORTED_TIMEFRAMES,
        availability.availability === 'TRADEABLE'
          ? marketSymbol(resolved, price, previousDayPrice)
          : undefined,
      );

      discovered.push(instrument);
      this.instrumentByProviderSymbol.set(resolved.providerSymbol, instrument);
    }

    this.instruments = discovered;

    const unavailable = discovered.filter(
      (instrument) => instrument.availability === 'UNAVAILABLE',
    );

    if (unavailable.length > 0) {
      eventBus.emit({
        type: 'LOG',
        data: {
          id: `unavailable-markets:${unavailable.length}`,
          timestamp: Date.now(),
          level: 'warn',
          message:
            `${unavailable.length} discovered market(s) are not publishing a price ` +
            `and are excluded from trading: ${unavailable
              .map((instrument) => instrument.providerSymbol)
              .join(', ')}.`,
        },
      });
    }

    return discovered;
  }

  /**
   * Canonical metadata for an app symbol or provider symbol.
   *
   * Execution, risk, and sizing resolve instruments exclusively through
   * this lookup so no layer has to re-derive instrument facts.
   */
  getInstrument(symbol: string): InstrumentMetadata | undefined {
    return this.resolveInstrument(this.instruments, symbol);
  }

  /** Instrument metadata lookup that also answers during discovery. */
  getInstrumentLookup(): InstrumentLookup {
    return { get: (symbol: string) => this.getInstrument(symbol) };
  }

  /**
   * Resolve an instrument for execution.
   *
   * Only currently tradeable markets resolve. A market without a price
   * deliberately resolves to nothing so no order can be sized, valued,
   * or routed for it.
   */
  private resolveInstrument(
    instruments: TradingInstrument[] | undefined,
    symbol: string,
  ): InstrumentMetadata | undefined {
    const found = this.findDiscovered(instruments, symbol);

    return found?.availability === 'TRADEABLE' ? found : undefined;
  }

  /** Locate a discovered market regardless of whether it is tradeable. */
  private findDiscovered(
    instruments: TradingInstrument[] | undefined,
    symbol: string,
  ): TradingInstrument | undefined {
    if (!symbol) return undefined;

    const normalized = normalizeSymbol(symbol);

    return (
      this.instrumentByProviderSymbol.get(normalized) ??
      instruments?.find(
        (candidate) =>
          candidate.symbol === symbol ||
          candidate.displayName === symbol ||
          candidate.id === symbol,
      ) ??
      instruments?.find((candidate) =>
        assetLabelMatches(candidate, symbol),
      )
    );
  }

  private resolveProviderSymbol(symbol: string): string {
    const normalized = normalizeSymbol(symbol);
    if (this.instrumentByProviderSymbol.has(normalized)) return normalized;
    const instrument = this.instruments?.find((candidate) => candidate.symbol === symbol || candidate.displayName === symbol || candidate.id === symbol);
    return instrument?.providerSymbol || normalized;
  }

  private resolveDisplaySymbol(providerSymbol: string): string {
    return this.instrumentByProviderSymbol.get(normalizeSymbol(providerSymbol))?.symbol || normalizeSymbol(providerSymbol);
  }

  private emitStatus(status: StatusListener extends (status: infer T) => void ? T : never): void { this.statusListeners.forEach((listener) => listener(status)); eventBus.emit({ type: 'STATUS_CHANGE', data: { mode: 'DEMO', status, message: `Hyperliquid ${status.toLowerCase()}.` } }); }
}

function decimalPlaces(value?: string): number | undefined {
  if (!value || !value.includes('.')) return 0;
  return value.split('.')[1].replace(/0+$/, '').length;
}

const SUPPORTED_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

/** Matches an app symbol case/space-insensitively, e.g. "gold" -> "Gold". */
function assetLabelMatches(instrument: TradingInstrument, symbol: string): boolean {
  const needle = symbol.trim().toLowerCase();
  return (
    instrument.symbol.toLowerCase() === needle ||
    instrument.displayName.toLowerCase() === needle
  );
}

function intervalMilliseconds(timeframe: Timeframe): number {
  const minutes: Record<Timeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
  return minutes[timeframe] * 60_000;
}

export const hyperliquidMarketData = new HyperliquidMarketDataAdapter();
