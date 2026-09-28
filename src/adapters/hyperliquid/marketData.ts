import { eventBus } from '../../types/events';
import { Bar, Quote, Timeframe } from '../../types/trading';
import { MarketDataProvider } from '../marketData';
import { fromHyperliquidCandle, normalizeSymbol, quoteFromBook, toHyperliquidInterval, classifyAsset, instrumentMetadata, marketAvailability, marketSymbol, tradingInstrument, uniqueSymbolLabels } from './normalizer';
import {
  AssetClass,
  InstrumentLookup,
  InstrumentMetadata,
  InstrumentStatus,
  TradingInstrument,
} from '../../types/instruments';

type StatusListener = (status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR') => void;
type HyperliquidNetwork = 'mainnet' | 'testnet';

/**
 * Info-endpoint transport.
 *
 * It is injectable so discovery behaviour (including markets the
 * provider lists without a price) can be verified deterministically
 * without a network round trip. Production always uses the live
 * transport.
 */
export interface HyperliquidTransport {
  request(body: Record<string, unknown>): Promise<unknown>;
}

export interface HyperliquidCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }
interface HyperliquidAsset { name: string; szDecimals: number; isDelisted?: boolean; maxLeverage?: number; }
interface HyperliquidAssetCtx { midPx?: string; markPx?: string; oraclePx?: string; prevDayPx?: string; }
interface HyperliquidDex { name: string; fullName?: string; }

export class HyperliquidMarketDataAdapter implements MarketDataProvider {
  private restUrl: string;
  private wsUrl: string;
  private network: HyperliquidNetwork;
  private socket?: WebSocket;
  private connected = false;
  private statusListeners = new Set<StatusListener>();
  private quoteSubscribers = new Map<string, Set<(quote: Quote) => void>>();
  private barSubscribers = new Map<string, Set<(bar: Bar, isClosed: boolean) => void>>();
  private lastQuotes = new Map<string, Quote>();
  private lastBars = new Map<string, Bar>();
  private subscriptions = new Map<string, Record<string, unknown>>();
  private instruments?: TradingInstrument[];
  private instrumentByProviderSymbol = new Map<string, TradingInstrument>();
  private discoveryPromise?: Promise<TradingInstrument[]>;

  constructor(
    network: HyperliquidNetwork = (import.meta.env.VITE_HYPERLIQUID_NETWORK === 'testnet' ? 'testnet' : 'mainnet'),
    private readonly transport: HyperliquidTransport = {
      request: async (body: Record<string, unknown>) => {
        const response = await fetch(
          `https://${network === 'mainnet' ? 'api.hyperliquid.xyz' : 'api.hyperliquid-testnet.xyz'}/info`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          throw new Error(
            `Hyperliquid info request failed (${response.status}).`,
          );
        }

        return response.json();
      },
    },
  ) {
    this.network = network;
    const host = network === 'mainnet' ? 'api.hyperliquid.xyz' : 'api.hyperliquid-testnet.xyz';
    this.restUrl = `https://${host}/info`; this.wsUrl = `wss://${host}/ws`;
  }

  async setNetwork(network: HyperliquidNetwork): Promise<void> {
    if (network === this.network) return;
    await this.disconnect(); this.network = network;
    const host = network === 'mainnet' ? 'api.hyperliquid.xyz' : 'api.hyperliquid-testnet.xyz';
    this.restUrl = `https://${host}/info`; this.wsUrl = `wss://${host}/ws`;
    this.instruments = undefined; this.discoveryPromise = undefined; this.instrumentByProviderSymbol.clear();
  }

  /**
   * The active trading universe.
   *
   * Only currently tradeable markets are returned. A market the provider
   * lists without a price is excluded here rather than being quoted from
   * an invented value; it is still reachable through
   * {@link getMarketStatus}.
   */
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

  private async discoverOnce(): Promise<TradingInstrument[]> {
    if (this.instruments) return this.instruments;
    if (!this.discoveryPromise) this.discoveryPromise = this.discoverInstruments();
    return this.discoveryPromise;
  }

  onStatusChange(listener: StatusListener): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  getConnectionState() { return { isConnected: this.connected, environment: 'DEMO', pingMs: 0 }; }

  /** Feeds a captured provider candle through the production normalization/event path. */
  ingestCandleFixture(candle: HyperliquidCandle): void { this.handleMessage(JSON.stringify({ channel: 'candle', data: candle })); }

  registerInstrument(instrument: TradingInstrument): void { this.instrumentByProviderSymbol.set(instrument.providerSymbol, instrument); }

  async connect(): Promise<void> {
    if (this.connected || (this.socket && this.socket.readyState === WebSocket.CONNECTING) || typeof WebSocket === 'undefined') return;
    this.emitStatus('CONNECTING');
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      const timeout = setTimeout(() => { if (!this.connected) { socket.close(); this.emitStatus('ERROR'); } resolve(); }, 5000);
      socket.onopen = () => { clearTimeout(timeout); this.connected = true; this.emitStatus('CONNECTED'); this.resubscribe(); resolve(); };
      socket.onmessage = (message) => this.handleMessage(message.data);
      socket.onerror = () => { if (!this.connected) this.emitStatus('ERROR'); };
      socket.onclose = () => { this.connected = false; this.emitStatus('DISCONNECTED'); };
    });
  }

  async disconnect(): Promise<void> { this.socket?.close(); this.socket = undefined; this.connected = false; this.emitStatus('DISCONNECTED'); }

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

  private handleMessage(raw: string): void {
    let message: { channel?: string; data?: unknown }; try { message = JSON.parse(raw); } catch { return; }
    if (message.channel === 'l2Book') {
      const data = message.data as { coin?: string; levels?: Array<Array<{ px: string }>> };
      const providerSymbol = normalizeSymbol(data.coin || ''); const bid = Number(data.levels?.[0]?.[0]?.px); const ask = Number(data.levels?.[1]?.[0]?.px);
      if (!providerSymbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
      const symbol = this.resolveDisplaySymbol(providerSymbol); const quote = quoteFromBook(symbol, bid, ask); this.lastQuotes.set(providerSymbol, quote); this.quoteSubscribers.get(providerSymbol)?.forEach((callback) => callback(quote)); eventBus.emit({ type: 'MARKET_QUOTE', data: quote });
    }
    if (message.channel === 'candle') {
      const rawCandle = message.data as HyperliquidCandle; const providerSymbol = normalizeSymbol(rawCandle.s); const bar = fromHyperliquidCandle(rawCandle); const key = `${providerSymbol}:${rawCandle.i}`;
      const isClosed = Date.now() >= rawCandle.T; this.lastBars.set(key, bar); this.barSubscribers.get(key)?.forEach((callback) => callback(bar, isClosed));
      eventBus.emit({ type: 'BAR_UPDATE', symbol: this.resolveDisplaySymbol(providerSymbol), timeframe: rawCandle.i, bar, isClosed });
    }
  }

  private async discoverInstruments(): Promise<TradingInstrument[]> {
    const [defaultMeta, dexes] = await Promise.all([
      this.request({ type: 'metaAndAssetCtxs' }) as Promise<[ { universe: HyperliquidAsset[] }, HyperliquidAssetCtx[] ]>,
      this.request({ type: 'perpDexs' }) as Promise<Array<HyperliquidDex | null>>,
    ]);
    const metas: Array<{ dex?: string; meta: { universe: HyperliquidAsset[] }; contexts: HyperliquidAssetCtx[] }> = [{ meta: defaultMeta[0], contexts: defaultMeta[1] }];
    const discoveredPrices = new Map<
      string,
      { price: number; availability: { availability: 'TRADEABLE' | 'UNAVAILABLE'; reason?: string } }
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

        discoveredPrices.set(providerSymbol, {
          price,
          availability,
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
      const { price, availability } =
        discoveredPrices.get(resolved.providerSymbol) ?? {
          price: Number.NaN,
          availability: marketAvailability(Number.NaN),
        };

      const instrument = tradingInstrument(
        resolved,
        SUPPORTED_TIMEFRAMES,
        availability.availability === 'TRADEABLE'
          ? marketSymbol(resolved, price)
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
