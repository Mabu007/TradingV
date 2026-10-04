import React, { useMemo, useState } from 'react';
import {
  Search,
  Star,
  ArrowLeft,
  Zap,
} from 'lucide-react';
import {
  Quote,
  Bar,
  Position,
  SignalEvent,
  Trade,
  Timeframe,
  OrderSide,
} from '../../types/trading';
import { MarketSymbol } from '../../types/instruments';
import { TradingChart } from '../chart/TradingChart';
import {
  OrderSubmissionResult,
  TradeOrderModal,
} from '../modals/TradeOrderModal';

interface QuotesTabProps {
  symbols: MarketSymbol[];
  quotes?: Record<string, Quote>;
  bars: Bar[];
  positions: Position[];
  signals: SignalEvent[];
  trades: Trade[];
  currentTimeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  onSelectSymbol: (symbol: string) => void;
  onExecuteOrder: (params: {
    symbol: string;
    side: OrderSide;
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
  }) => Promise<OrderSubmissionResult>;
  onAskAI: (context: any) => void;
}

export const QuotesTab: React.FC<QuotesTabProps> = ({
  symbols,
  quotes = {},
  bars,
  positions,
  signals,
  trades,
  currentTimeframe,
  onTimeframeChange,
  onSelectSymbol,
  onExecuteOrder,
  onAskAI,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMarket, setSelectedMarket] = useState<MarketSymbol | null>(null);
  const [favorites, setFavorites] = useState<string[]>([
    'EUR/USD',
    'Gold',
    'S&P 500',
  ]);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);

  const [showIndicators, setShowIndicators] = useState(true);
  const [showPositionsOverlay, setShowPositionsOverlay] = useState(true);
  const [showSignalsOverlay, setShowSignalsOverlay] = useState(true);

  const toggleFavorite = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();

    setFavorites((prev) =>
      prev.includes(sym)
        ? prev.filter((s) => s !== sym)
        : [...prev, sym]
    );
  };

  const categoryOrder = {
    FOREX: 0,
    COMMODITY: 1,
    INDEX: 2,
  } as const;

  const filteredSymbols = useMemo(() => {
    return symbols
      .filter((market) => {
        const query = searchQuery.toLowerCase().trim();

        const matchesSearch =
          !query ||
          market.symbol.toLowerCase().includes(query) ||
          market.displayName.toLowerCase().includes(query);

        const matchesFavorite =
          showFavoritesOnly
            ? favorites.includes(market.symbol)
            : true;

        return matchesSearch && matchesFavorite;
      })
      .sort(
        (left, right) =>
          (
            categoryOrder[left.assetClass || 'INDEX'] -
            categoryOrder[right.assetClass || 'INDEX']
          ) ||
          left.symbol.localeCompare(right.symbol)
      );
  }, [symbols, searchQuery, showFavoritesOnly, favorites]);

  const timeframes: Timeframe[] = [
    '1m',
    '5m',
    '15m',
    '30m',
    '1h',
    '4h',
    '1d',
  ];

  /*
   * Resolve the latest real quote for a market.
   *
   * Quotes come from the Hyperliquid websocket through App.tsx.
   * We intentionally do NOT derive ask from lastPrice + spread.
   */
  const getQuote = (market: MarketSymbol): Quote | null => {
    return quotes[market.symbol] ?? null;
  };

  const getDisplayPrices = (market: MarketSymbol) => {
    const quote = getQuote(market);

    if (!quote) {
      return {
        bid: null,
        ask: null,
        spread: null,
        timestamp: null,
      };
    }

    return {
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
      timestamp: quote.timestamp,
    };
  };

  const formatPrice = (
    price: number | null,
    digits: number
  ): string => {
    if (price === null || !Number.isFinite(price)) {
      return '—';
    }

    return price.toFixed(Math.max(0, digits));
  };

  const formatSpread = (
    market: MarketSymbol,
    spread: number | null
  ): string => {
    if (spread === null || !Number.isFinite(spread)) {
      return '—';
    }

    /*
     * Pips only mean something for a Forex instrument whose metadata
     * declares a pip size. Every other asset class shows the raw
     * bid/ask distance, which always comes from the real quote.
     */
    const pipSize = market.pipSize;

    if (typeof pipSize === 'number' && pipSize > 0) {
      const pips = spread / pipSize;

      if (Number.isFinite(pips)) {
        return `${pips.toFixed(pips >= 10 ? 1 : 2)} pips`;
      }
    }

    return `${spread.toFixed(market.pricePrecision ?? 2)} ${market.quoteCurrency ?? ''}`.trim();
  };

  const formatQuoteAge = (timestamp: number | null): string => {
    if (!timestamp || !Number.isFinite(timestamp)) {
      return 'No live quote';
    }

    const ageMs = Math.max(0, Date.now() - timestamp);

    if (ageMs < 1_000) {
      return 'Live';
    }

    if (ageMs < 10_000) {
      return `${Math.floor(ageMs / 1_000)}s ago`;
    }

    if (ageMs < 60_000) {
      return `${Math.floor(ageMs / 1_000)}s ago`;
    }

    return `${Math.floor(ageMs / 60_000)}m ago`;
  };

  /*
   * MARKET DETAIL SCREEN
   */
  if (selectedMarket) {
    const quote = getQuote(selectedMarket);
    const prices = getDisplayPrices(selectedMarket);

    const isPositive = selectedMarket.change24h >= 0;

    const marketPositions = positions.filter(
      (position) => position.symbol === selectedMarket.symbol
    );

    return (
      <div className="flex-1 flex flex-col h-full bg-bg-alt overflow-y-auto pb-24 md:pb-8">

        {/* Header */}
        <div className="sticky top-0 z-20 bg-bg-alt/95 backdrop-blur-md border-b border-line p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedMarket(null)}
              className="p-1.5 rounded-xl text-ink-2 hover:text-ink hover:bg-line-strong transition-colors"
              title="Back to Quotes"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-ink font-mono">
                  {selectedMarket.symbol}
                </h1>

                <button
                  onClick={(e) =>
                    toggleFavorite(selectedMarket.symbol, e)
                  }
                  className="text-ink-4 hover:text-warn transition-colors"
                >
                  <Star
                    className={`w-4 h-4 ${
                      favorites.includes(selectedMarket.symbol)
                        ? 'fill-amber-400 text-warn'
                        : ''
                    }`}
                  />
                </button>
              </div>

              <div className="text-xs text-ink-3">
                {selectedMarket.displayName}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-lg font-bold font-mono text-ink tracking-tight">
              {quote
                ? formatPrice(
                    (quote.bid + quote.ask) / 2,
                    selectedMarket.pricePrecision ?? 2
                  )
                : '—'}
            </div>

            <div
              className={`text-xs font-semibold font-mono ${
                !Number.isFinite(selectedMarket.change24h)
                  ? 'text-ink-3'
                  : isPositive
                    ? 'text-pos'
                    : 'text-neg'
              }`}
            >
              {Number.isFinite(selectedMarket.change24h)
                ? `${isPositive ? '+' : ''}${selectedMarket.change24h.toFixed(2)}%`
                : '—'}
            </div>
          </div>
        </div>

        {/* Timeframe */}
        <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-1 overflow-x-auto bg-surface-2">
          <div className="flex items-center gap-1">
            {timeframes.map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition-all ${
                  currentTimeframe === tf
                    ? 'bg-accent-strong text-ink font-bold'
                    : 'text-ink-3 hover:text-ink hover:bg-surface-3'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          <button
            onClick={() =>
              setShowIndicators((prev) => !prev)
            }
            className={`px-2 py-1 rounded-lg text-[11px] font-mono transition-colors border ${
              showIndicators
                ? 'bg-accent-soft border-accent/40 text-accent-ink'
                : 'bg-surface-3 border-line text-ink-3'
            }`}
          >
            SMA {showIndicators ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Chart */}
        <div className="w-full h-72 sm:h-96 relative border-b border-line bg-bg-alt">
          <TradingChart
            symbol={selectedMarket.symbol}
            timeframe={currentTimeframe}
            bars={bars}
            positions={
              showPositionsOverlay
                ? marketPositions
                : []
            }
            signals={
              showSignalsOverlay
                ? signals
                : []
            }
            trades={trades}
            showIndicators={showIndicators}
            onToggleIndicators={() =>
              setShowIndicators((prev) => !prev)
            }
          />
        </div>

        {/* Market Data */}
        <div className="p-3.5 space-y-3 max-w-4xl mx-auto w-full">

          {/* Live quote status */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  quote
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-slate-600'
                }`}
              />

              <span className="text-[11px] text-ink-3 font-medium">
                {formatQuoteAge(prices.timestamp)}
              </span>
            </div>

            {quote && (
              <span className="text-[10px] text-ink-4 font-mono">
                {new Date(quote.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Real Bid / Ask */}
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="p-3 rounded-xl bg-surface-3 border border-line">
              <div className="text-[11px] text-ink-3 font-sans">
                BID
              </div>

              <div className="text-lg font-bold font-mono text-ink mt-0.5">
                {formatPrice(
                  prices.bid,
                  selectedMarket.pricePrecision ?? 2
                )}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-surface-3 border border-line">
              <div className="text-[11px] text-ink-3 font-sans">
                ASK
              </div>

              <div className="text-lg font-bold font-mono text-ink mt-0.5">
                {formatPrice(
                  prices.ask,
                  selectedMarket.pricePrecision ?? 2
                )}
              </div>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-2 text-xs font-mono">

            <div className="p-2.5 rounded-xl bg-surface border border-line">
              <span className="text-[10px] text-ink-3 block">
                Spread
              </span>

              <span className="text-ink-2 font-semibold">
                {formatSpread(
                  selectedMarket,
                  prices.spread
                )}
              </span>
            </div>

            <div className="p-2.5 rounded-xl bg-surface border border-line">
              <span className="text-[10px] text-ink-3 block">
                24h High
              </span>

              <span className="text-ink-2 font-semibold">
                {Number.isFinite(selectedMarket.high24h)
                  ? selectedMarket.high24h.toFixed(
                      selectedMarket.pricePrecision ?? 2
                    )
                  : '—'}
              </span>
            </div>

            <div className="p-2.5 rounded-xl bg-surface border border-line">
              <span className="text-[10px] text-ink-3 block">
                24h Low
              </span>

              <span className="text-ink-2 font-semibold">
                {Number.isFinite(selectedMarket.low24h)
                  ? selectedMarket.low24h.toFixed(
                      selectedMarket.pricePrecision ?? 2
                    )
                  : '—'}
              </span>
            </div>
          </div>

          {/* Active Positions */}
          {marketPositions.length > 0 && (
            <div className="p-3 rounded-xl bg-accent-soft border border-accent/30/30">
              <div className="text-xs font-semibold text-accent mb-1">
                {marketPositions.length}{' '}
                Active Position
                {marketPositions.length !== 1 ? 's' : ''}{' '}
                on {selectedMarket.symbol}
              </div>

              <div className="text-xs text-ink-2 font-mono">
                Total Unrealized:{' '}
                <span
                  className={`font-bold ${
                    marketPositions.reduce(
                      (sum, position) =>
                        sum + position.unrealizedPnL,
                      0
                    ) >= 0
                      ? 'text-pos'
                      : 'text-neg'
                  }`}
                >
                  $
                  {marketPositions
                    .reduce(
                      (sum, position) =>
                        sum + position.unrealizedPnL,
                      0
                    )
                    .toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* Trade */}
          <div className="pt-2">
            <button
              onClick={() => setShowOrderModal(true)}
              disabled={!quote}
              className={`w-full py-4 rounded-xl font-bold text-base transition-all shadow-xl active:scale-[0.98] flex items-center justify-center gap-2 ${
                quote
                  ? 'bg-accent-strong hover:bg-accent text-ink shadow-sky-950'
                  : 'bg-surface-3 text-ink-4 cursor-not-allowed shadow-none'
              }`}
            >
              <Zap className="w-5 h-5 fill-current" />

              <span>
                {quote
                  ? `Trade ${selectedMarket.symbol}`
                  : 'Waiting for live quote'}
              </span>
            </button>
          </div>
        </div>

        {/*
          Order Modal.

          `quote` is not optional in practice. Without it the modal's
          `canExecute` is permanently false and the submit button reads
          "Waiting for Live Quote" forever, so no manual order could ever
          be placed from the UI. The live quote is already in scope here,
          so the ticket receives the same one the screen is displaying
          rather than a value it has to re-fetch and possibly disagree
          with.
        */}
        <TradeOrderModal
          market={selectedMarket}
          quote={quote}
          isOpen={showOrderModal}
          onClose={() => setShowOrderModal(false)}
          onExecuteOrder={onExecuteOrder}
        />
      </div>
    );
  }

  /*
   * QUOTES LIST
   */
  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-4 pb-24 md:pb-8 max-w-4xl mx-auto w-full space-y-3.5">

      {/* Search */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-ink-3 absolute left-3.5 top-1/2 -translate-y-1/2" />

          <input
            type="text"
            value={searchQuery}
            onChange={(e) =>
              setSearchQuery(e.target.value)
            }
            placeholder="Search markets (e.g. EUR, Gold, JPY)..."
            className="w-full bg-surface border border-line rounded-xl pl-10 pr-4 py-2.5 text-xs text-ink placeholder-ink-4 focus:outline-none focus:border-accent"
          />
        </div>

        <button
          onClick={() =>
            setShowFavoritesOnly((prev) => !prev)
          }
          className={`p-2.5 rounded-xl border transition-all ${
            showFavoritesOnly
              ? 'bg-amber-500/20 border-amber-500/50 text-warn'
              : 'bg-surface border-line text-ink-3 hover:text-ink'
          }`}
          title="Filter Favorites"
        >
          <Star
            className={`w-4 h-4 ${
              showFavoritesOnly
                ? 'fill-current'
                : ''
            }`}
          />
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between text-[11px] text-ink-3 px-2 font-medium">
        <span>Instrument</span>

        <div className="flex items-center gap-6">
          <span>Bid / Ask</span>
          <span>24h Change</span>
        </div>
      </div>

      {/* Markets */}
      <div className="space-y-2">
        {filteredSymbols.map((item, index) => {
          const isFav = favorites.includes(item.symbol);
          const isPositive = item.change24h >= 0;

          const quote = getQuote(item);
          const prices = getDisplayPrices(item);

          return (
            <React.Fragment key={item.symbol}>

              {/* Category */}
              {(index === 0 ||
                filteredSymbols[index - 1]?.assetClass !==
                  item.assetClass) && (
                <div className="pt-3 px-1 text-[11px] font-bold uppercase tracking-wider text-accent-ink">
                  {item.assetClass || 'Markets'}
                </div>
              )}

              {/* Market row */}
              <div
                onClick={() => {
                  setSelectedMarket(item);
                  onSelectSymbol(item.symbol);
                }}
                className="min-h-[64px] p-3.5 rounded-2xl bg-surface border border-line hover:border-line-strong active:scale-[0.99] transition-all cursor-pointer flex items-center justify-between shadow-xs select-none"
              >

                {/* Left */}
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={(e) =>
                      toggleFavorite(item.symbol, e)
                    }
                    className="p-1 rounded-lg text-ink-4 hover:text-warn transition-colors shrink-0"
                  >
                    <Star
                      className={`w-4 h-4 ${
                        isFav
                          ? 'fill-amber-400 text-warn'
                          : 'text-ink-4'
                      }`}
                    />
                  </button>

                  <div className="min-w-0">
                    <div className="text-base font-bold text-ink font-mono flex items-center gap-2">
                      <span>{item.symbol}</span>

                      {quote && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-pos-soft border border-pos/40 text-pos font-sans font-medium">
                          LIVE
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-ink-3 truncate max-w-[140px] sm:max-w-none">
                      {item.displayName}
                    </div>
                  </div>
                </div>

                {/* Right */}
                <div className="flex items-center gap-3 shrink-0">

                  {/* Real Bid / Ask */}
                  <div className="text-right font-mono text-xs">
                    <div className="text-ink-2 font-semibold flex items-center justify-end gap-1">
                      <span className="text-[10px] text-ink-4 font-sans">
                        Bid
                      </span>

                      <span>
                        {formatPrice(
                          prices.bid,
                          item.pricePrecision ?? 2
                        )}
                      </span>
                    </div>

                    <div className="text-ink-3 text-[11px] flex items-center justify-end gap-1">
                      <span className="text-[10px] text-ink-4 font-sans">
                        Ask
                      </span>

                      <span>
                        {formatPrice(
                          prices.ask,
                          item.pricePrecision ?? 2
                        )}
                      </span>
                    </div>
                  </div>

                  {/* 24h */}
                  <div
                    className={`min-w-[64px] text-center px-2 py-1.5 rounded-xl text-xs font-bold font-mono tracking-tight ${
                      !Number.isFinite(item.change24h)
                        ? 'bg-surface-2 text-ink-3 border border-line'
                        : isPositive
                          ? 'bg-pos-soft text-pos border border-pos/40'
                          : 'bg-neg-strong/15 text-neg border border-neg/50/30'
                    }`}
                  >
                    {isPositive ? '+' : ''}
                    {Number.isFinite(item.change24h)
                      ? item.change24h.toFixed(2)
                      : '—'}
                    {Number.isFinite(item.change24h)
                      ? '%'
                      : ''}
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}

        {filteredSymbols.length === 0 && (
          <div className="p-8 text-center rounded-2xl bg-surface-3 border border-line text-ink-3 text-xs">
            No instruments match "{searchQuery}".
          </div>
        )}
      </div>
    </div>
  );
};