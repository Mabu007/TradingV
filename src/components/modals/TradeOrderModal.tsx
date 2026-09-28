import React, { useMemo, useState } from 'react';
import {
  X,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
} from 'lucide-react';
import {
  OrderSide,
  Quote,
} from '../../types/trading';
import { MarketSymbol } from '../../types/instruments';
import {
  instrumentUnitsToLots,
  lotsToInstrumentUnits,
  snapOrderSize,
  validateOrderSize,
} from '../../utils/orderSize';

export interface OrderSubmissionResult {
  success: boolean;
  /** User-safe explanation from the deterministic execution/risk layer. */
  message?: string;
  category?: string;
}

interface TradeOrderModalProps {
  market: MarketSymbol;
  quote?: Quote | null;
  isOpen: boolean;
  onClose: () => void;
  onExecuteOrder: (params: {
    symbol: string;
    side: OrderSide;
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
  }) => Promise<OrderSubmissionResult>;
}

export const TradeOrderModal: React.FC<TradeOrderModalProps> = ({
  market,
  quote,
  isOpen,
  onClose,
  onExecuteOrder,
}) => {
  const [side, setSide] = useState<OrderSide>('BUY');

  const [submitting, setSubmitting] = useState(false);

  const [submitError, setSubmitError] = useState<string | null>(null);

  const metadata = market;

  /*
   * Lot sizing and pip distances are Forex-only affordances. They are
   * enabled strictly by instrument metadata, never by the symbol's
   * appearance, so a commodity or index can never be traded in lots.
   */
  const isForex =
    metadata.assetClass === 'FOREX' &&
    typeof metadata.lotSize === 'number';

  const pipSize =
    typeof metadata.pipSize === 'number' && metadata.pipSize > 0
      ? metadata.pipSize
      : undefined;

  const [lots, setLots] = useState<number>(0.1);
  const [volume, setVolume] = useState<number>(1);

  /*
   * For Forex these represent pips.
   * For non-Forex they represent absolute price distance.
   */
  const [slDistance, setSlDistance] = useState<string>(
    isForex ? '25' : '1'
  );

  const [tpDistance, setTpDistance] = useState<string>(
    isForex ? '50' : '2'
  );

  /*
   * A real executable quote must exist before an order can be placed.
   *
   * BUY  -> Ask
   * SELL -> Bid
   */
  const entryPrice = useMemo(() => {
    if (!quote) return null;

    if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
      return null;
    }

    return side === 'BUY'
      ? quote.ask
      : quote.bid;
  }, [quote, side]);

  /*
   * The execution contract is instrument units. Forex lots are converted
   * through the instrument's declared lot size and snapped onto the
   * venue's size grid so a lot can never produce a size the exchange
   * would reject.
   */
  const volumeUnits = useMemo(() => {
    if (isForex) {
      return lotsToInstrumentUnits(
        lots,
        metadata,
      ).units;
    }

    return snapOrderSize(
      Number.isFinite(volume) ? volume : 0,
      metadata,
    ).value;
  }, [isForex, lots, volume, metadata]);

  const sizeCheck = useMemo(
    () => validateOrderSize(volumeUnits, metadata),
    [volumeUnits, metadata],
  );

  const lotsLabel = useMemo(
    () => instrumentUnitsToLots(volumeUnits, metadata),
    [volumeUnits, metadata],
  );

  /*
   * Convert the user's risk distance into an actual price distance.
   *
   * Forex:
   *     pips × pipSize
   *
   * Everything else:
   *     direct price distance
   */
  const priceDistance = useMemo(() => {
    const distance = Number.parseFloat(slDistance);

    if (!Number.isFinite(distance) || distance <= 0) {
      return null;
    }

    if (pipSize !== undefined) {
      return distance * pipSize;
    }

    return distance;
  }, [slDistance, pipSize]);

  const takeProfitDistance = useMemo(() => {
    const distance = Number.parseFloat(tpDistance);

    if (!Number.isFinite(distance) || distance <= 0) {
      return null;
    }

    if (pipSize !== undefined) {
      return distance * pipSize;
    }

    return distance;
  }, [tpDistance, pipSize]);

  const stopLoss = useMemo(() => {
    if (
      entryPrice === null ||
      priceDistance === null
    ) {
      return undefined;
    }

    return side === 'BUY'
      ? entryPrice - priceDistance
      : entryPrice + priceDistance;
  }, [entryPrice, priceDistance, side]);

  const takeProfit = useMemo(() => {
    if (
      entryPrice === null ||
      takeProfitDistance === null
    ) {
      return undefined;
    }

    return side === 'BUY'
      ? entryPrice + takeProfitDistance
      : entryPrice - takeProfitDistance;
  }, [
    entryPrice,
    takeProfitDistance,
    side,
  ]);

  const hasValidQuote =
    quote !== null &&
    quote !== undefined &&
    Number.isFinite(quote.bid) &&
    Number.isFinite(quote.ask) &&
    quote.bid > 0 &&
    quote.ask > 0 &&
    entryPrice !== null;

  const canExecute =
    hasValidQuote &&
    sizeCheck.valid &&
    volumeUnits > 0 &&
    !submitting;

  const formatPrice = (
    price: number | undefined
  ): string => {
    if (
      price === undefined ||
      !Number.isFinite(price)
    ) {
      return '—';
    }

    return price.toFixed(
      Math.max(0, metadata.pricePrecision ?? 2)
    );
  };

  const formatTimestamp = (
    timestamp?: number
  ): string => {
    if (
      !timestamp ||
      !Number.isFinite(timestamp)
    ) {
      return 'No live quote';
    }

    return new Date(timestamp).toLocaleTimeString();
  };

  /*
   * Submitting hands the order to the deterministic execution layer.
   * The ticket only closes once that layer confirms the fill; a
   * rejection keeps the ticket open with the reason shown, because the
   * same block applies whether a human or an agent placed the order.
   */
  const handleExecute = async () => {
    if (!canExecute || submitting) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const result = await onExecuteOrder({
        symbol: market.symbol,
        side,
        volume: volumeUnits,
        stopLoss,
        takeProfit,
      });

      if (result?.success) {
        onClose();
        return;
      }

      setSubmitError(
        result?.message ??
          'The order was blocked by the execution and risk checks.',
      );
    } catch {
      setSubmitError(
        'The order could not be submitted. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  /*
   * Forex uses lots.
   */
  const quickLots = [
    0.01,
    0.05,
    0.1,
    0.5,
    1.0,
  ];

  /*
   * HIP-3 markets use direct size rather than
   * pretending everything is a 100,000-unit Forex lot. Every quick size
   * is snapped onto the instrument's own size grid.
   */
  const quickVolumes = [
    1,
    5,
    10,
    25,
    50,
  ]
    .map((value) => snapOrderSize(value, metadata))
    .filter((snapped) => snapped.value > 0)
    .map((snapped) => snapped.value);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-md bg-[#0c1322] border border-[#1e293b] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col">

        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 bg-slate-700/60 rounded-full mx-auto mt-2.5 sm:hidden" />

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1e293b] bg-[#0f172a]">
          <div>
            <h3 className="text-base font-bold text-white font-mono flex items-center gap-2">
              <span>{market.symbol}</span>

              <span className="text-xs text-slate-400 font-sans font-normal">
                {metadata.displayName}
              </span>
            </h3>

            <div className="text-xs text-slate-400 font-mono mt-1 flex items-center gap-2">
              <span>
                Market Execution
              </span>

              <span className="text-slate-600">
                ·
              </span>

              <span
                className={
                  hasValidQuote
                    ? 'text-emerald-400'
                    : 'text-slate-500'
                }
              >
                {hasValidQuote
                  ? 'Live Quote'
                  : 'Waiting for Quote'}
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Live Quote */}
        <div className="px-4 pt-4">
          <div className="grid grid-cols-2 gap-2">

            {/* Bid */}
            <div className="p-3 rounded-xl bg-[#090f1a] border border-[#1e293b]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-medium">
                  BID
                </span>

                {side === 'SELL' && (
                  <span className="text-[9px] text-rose-400 font-bold">
                    SELL PRICE
                  </span>
                )}
              </div>

              <div className="text-lg font-bold font-mono text-white mt-1">
                {formatPrice(quote?.bid)}
              </div>
            </div>

            {/* Ask */}
            <div className="p-3 rounded-xl bg-[#090f1a] border border-[#1e293b]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-medium">
                  ASK
                </span>

                {side === 'BUY' && (
                  <span className="text-[9px] text-emerald-400 font-bold">
                    BUY PRICE
                  </span>
                )}
              </div>

              <div className="text-lg font-bold font-mono text-white mt-1">
                {formatPrice(quote?.ask)}
              </div>
            </div>
          </div>

          {/* Quote metadata */}
          <div className="flex items-center justify-between px-1 pt-2">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  hasValidQuote
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-slate-600'
                }`}
              />

              <span className="text-[10px] text-slate-500">
                {hasValidQuote
                  ? 'Live market data'
                  : 'Live market data unavailable'}
              </span>
            </div>

            {quote?.timestamp && (
              <span className="text-[10px] text-slate-600 font-mono">
                {formatTimestamp(
                  quote.timestamp
                )}
              </span>
            )}
          </div>
        </div>

        {/* Form */}
        <div className="p-4 space-y-4">

          {/* Side Selector */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-[#090f1a] rounded-xl border border-[#1e293b]">

            <button
              type="button"
              onClick={() => setSide('BUY')}
              className={`py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                side === 'BUY'
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <ArrowUpRight className="w-4 h-4" />

              <span>
                BUY
              </span>

              {quote && (
                <span className="font-mono text-xs opacity-90">
                  {formatPrice(quote.ask)}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setSide('SELL')}
              className={`py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                side === 'SELL'
                  ? 'bg-rose-600 text-white shadow-md shadow-rose-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <ArrowDownRight className="w-4 h-4" />

              <span>
                SELL
              </span>

              {quote && (
                <span className="font-mono text-xs opacity-90">
                  {formatPrice(quote.bid)}
                </span>
              )}
            </button>
          </div>

          {/* Entry Price */}
          <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">
                Estimated Entry
              </span>

              <span
                className={`text-sm font-bold font-mono ${
                  side === 'BUY'
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {formatPrice(entryPrice ?? undefined)}
              </span>
            </div>
          </div>

          {/* Volume */}
          <div>
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
              <span>
                {isForex
                  ? 'Trade Volume'
                  : 'Position Size'}
              </span>

              <span className="font-mono text-slate-300 font-semibold">
                {isForex && lotsLabel !== undefined
                  ? `${lotsLabel.toFixed(2)} Lots · `
                  : ''}
                {volumeUnits.toLocaleString()} units
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {isForex
                ? quickLots.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() =>
                        setLots(value)
                      }
                      className={`flex-1 py-2 rounded-lg text-xs font-mono font-semibold transition-all border ${
                        lots === value
                          ? 'bg-sky-500/20 border-sky-500 text-sky-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-white'
                      }`}
                    >
                      {value}
                    </button>
                  ))
                : quickVolumes.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() =>
                        setVolume(value)
                      }
                      className={`flex-1 py-2 rounded-lg text-xs font-mono font-semibold transition-all border ${
                        volume === value
                          ? 'bg-sky-500/20 border-sky-500 text-sky-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-white'
                      }`}
                    >
                      {value}
                    </button>
                  ))}
            </div>

            {/* Size feedback */}
            {!sizeCheck.valid && (
              <div className="text-[11px] text-amber-400">
                {sizeCheck.reason}
              </div>
            )}
          </div>

          {/* Risk Controls */}
          <div className="grid grid-cols-2 gap-3 text-xs">

            {/* Stop Loss */}
            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <label className="text-slate-400 block mb-1.5 font-medium">
                Stop Loss{' '}
                <span className="text-slate-600">
                  ({pipSize !== undefined ? 'Pips' : 'Price'})
                </span>
              </label>

              <input
                type="number"
                min="0"
                step="any"
                value={slDistance}
                onChange={(e) =>
                  setSlDistance(e.target.value)
                }
                className="w-full bg-[#080d16] border border-[#1e293b] rounded-lg px-2.5 py-1.5 font-mono text-rose-400 font-semibold text-sm focus:outline-none focus:border-rose-500"
              />

              <span className="text-[10px] text-slate-400 font-mono mt-1 block">
                Target:{' '}
                <span className="text-rose-300">
                  {formatPrice(stopLoss)}
                </span>
              </span>
            </div>

            {/* Take Profit */}
            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <label className="text-slate-400 block mb-1.5 font-medium">
                Take Profit{' '}
                <span className="text-slate-600">
                  ({pipSize !== undefined ? 'Pips' : 'Price'})
                </span>
              </label>

              <input
                type="number"
                min="0"
                step="any"
                value={tpDistance}
                onChange={(e) =>
                  setTpDistance(e.target.value)
                }
                className="w-full bg-[#080d16] border border-[#1e293b] rounded-lg px-2.5 py-1.5 font-mono text-emerald-400 font-semibold text-sm focus:outline-none focus:border-emerald-500"
              />

              <span className="text-[10px] text-slate-400 font-mono mt-1 block">
                Target:{' '}
                <span className="text-emerald-300">
                  {formatPrice(takeProfit)}
                </span>
              </span>
            </div>
          </div>

          {/* No live quote warning */}
          {!hasValidQuote && (
            <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
              <div className="text-xs text-amber-400 font-semibold">
                Waiting for live market data
              </div>

              <div className="text-[11px] text-slate-500 mt-1">
                An order cannot be submitted until a
                current Hyperliquid bid/ask quote is
                available.
              </div>
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="p-4 border-t border-[#1e293b] bg-[#0f172a]">
          <button
            onClick={handleExecute}
            disabled={!canExecute}
            className={`w-full py-3.5 rounded-xl font-bold text-sm text-white transition-all shadow-lg flex items-center justify-center gap-2 ${
              !canExecute
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed shadow-none'
                : side === 'BUY'
                  ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950 active:scale-[0.98]'
                  : 'bg-rose-600 hover:bg-rose-500 shadow-rose-950 active:scale-[0.98]'
            }`}
          >
            <Zap className="w-4 h-4 fill-current" />

            <span>
              {!hasValidQuote
                ? 'Waiting for Live Quote'
                : submitting
                  ? 'Submitting...'
                  : `Place ${side} Order`}
            </span>
          </button>

          {/* Execution / risk rejection */}
          {submitError && (
            <div
              className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3"
              role="alert"
            >
              <div className="text-xs font-semibold text-amber-300">
                Order not placed
              </div>

              <div className="mt-1 text-[11px] text-slate-300">
                {submitError}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};