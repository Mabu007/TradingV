import React, { useState } from 'react';
import {
  History,
  TrendingUp,
  TrendingDown,
  Download,
  Filter,
  Sparkles as GoatIcon,
  Clock,
  X,
  Sparkles,
  ChevronRight,
  Calendar,
} from 'lucide-react';
import { Trade } from '../../types/trading';
import { downloadTradesCSV } from '../../utils/csvExport';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { formatPositionSize } from '../../utils/positionSize';

interface HistoryTabProps {
  trades: Trade[];
  onAskAI: (context: any) => void;
}

export const HistoryTab: React.FC<HistoryTabProps> = ({ trades, onAskAI }) => {
  const [filter, setFilter] = useState<'All' | 'Manual' | 'GOATs' | 'Profitable' | 'Losses'>('All');
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);

  // Group trades by time periods
  const now = Date.now() / 1000;
  const oneDay = 86400;

  const filteredTrades = trades.filter((t) => {
    if (filter === 'Manual') return !t.goatName && !t.goatId;
    if (filter === 'GOATs') return !!t.goatName || !!t.goatId;
    if (filter === 'Profitable') return t.pnl > 0;
    if (filter === 'Losses') return t.pnl < 0;
    return true;
  });

  const todayTrades = filteredTrades.filter((t) => now - t.exitTime <= oneDay);
  const yesterdayTrades = filteredTrades.filter((t) => now - t.exitTime > oneDay && now - t.exitTime <= 2 * oneDay);
  const earlierTrades = filteredTrades.filter((t) => now - t.exitTime > 2 * oneDay);

  const totalPnL = filteredTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winCount = filteredTrades.filter((t) => t.pnl > 0).length;
  const winRate = filteredTrades.length > 0 ? (winCount / filteredTrades.length) * 100 : 0;

  const renderTradeCard = (t: Trade) => {
    const isProfit = t.pnl >= 0;
    const isBuy = t.side === 'BUY';
    const entrySec = t.entryTime > 1e11 ? Math.floor(t.entryTime / 1000) : t.entryTime;
    const exitSec = t.exitTime > 1e11 ? Math.floor(t.exitTime / 1000) : t.exitTime;
    const durationMin = Math.max(1, Math.round((exitSec - entrySec) / 60));

    return (
      <div
        key={t.id}
        onClick={() => setSelectedTrade(t)}
        className="p-3.5 rounded-2xl bg-surface border border-line hover:border-line-strong active:scale-[0.99] transition-all cursor-pointer shadow-xs select-none"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className={`px-2 py-0.5 rounded-md text-[11px] font-bold font-mono ${
                isBuy
                  ? 'bg-emerald-500/20 text-pos border border-pos/40'
                  : 'bg-neg-strong/20 text-neg border border-neg/50/30'
              }`}
            >
              {t.side}
            </span>
            <div>
              <div className="text-base font-bold text-ink font-mono flex items-center gap-2">
                <span>{t.symbol}</span>
                <span className="text-xs text-ink-3 font-sans font-normal">
                  {formatPositionSize(t.volume, hyperliquidMarketData.getInstrument(t.symbol))}
                </span>
              </div>
              <div className="text-[11px] text-ink-3 font-mono mt-0.5">
                {t.entryPrice.toFixed(5)} → {t.exitPrice.toFixed(5)}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div
              className={`text-base font-bold font-mono tracking-tight ${
                isProfit ? 'text-pos' : 'text-neg'
              }`}
            >
              {isProfit ? '+' : ''}${t.pnl.toFixed(2)}
            </div>
            <div
              className={`text-[11px] font-semibold font-mono ${
                isProfit ? 'text-pos/80' : 'text-neg/80'
              }`}
            >
              {isProfit ? '+' : ''}{t.pnlPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-line/60 flex items-center justify-between text-[11px] text-ink-3">
          <div className="flex items-center gap-1.5">
            {t.goatName ? (
              <span className="text-accent-ink font-medium flex items-center gap-1">
                <GoatIcon className="w-3.5 h-3.5 text-accent" />
                <span>{t.goatName}</span>
              </span>
            ) : (
              <span>Manual Trade</span>
            )}
            <span>·</span>
            <span>{durationMin}m duration</span>
          </div>

          <div className="flex items-center gap-1 text-ink-3 font-mono">
            <span>{t.exitReason}</span>
            <ChevronRight className="w-3.5 h-3.5 opacity-60" />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-4 pb-24 md:pb-8 max-w-4xl mx-auto w-full space-y-4">
      {/* Top Header & Export */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-ink tracking-tight">Trade History</h1>
          <p className="text-xs text-ink-3">Audit completed executions and performance metrics</p>
        </div>

        <button
          onClick={() => downloadTradesCSV(filteredTrades)}
          disabled={filteredTrades.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-surface-3 hover:bg-accent-strong hover:text-accent-contrast text-accent border border-accent/40 transition-all disabled:opacity-40"
          title="Download transactions as CSV for Excel or Python"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Download CSV</span>
        </button>
      </div>

      {/* Summary Metrics Bar */}
      <div className="grid grid-cols-3 gap-2 text-xs font-mono">
        <div className="p-3 rounded-xl bg-surface border border-line">
          <span className="text-[10px] text-ink-3 font-sans block mb-0.5">Total Realized P&L</span>
          <span
            className={`text-base font-bold ${
              totalPnL >= 0 ? 'text-pos' : 'text-neg'
            }`}
          >
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
          </span>
        </div>

        <div className="p-3 rounded-xl bg-surface border border-line">
          <span className="text-[10px] text-ink-3 font-sans block mb-0.5">Win Rate</span>
          <span className="text-base font-bold text-ink">{winRate.toFixed(1)}%</span>
        </div>

        <div className="p-3 rounded-xl bg-surface border border-line">
          <span className="text-[10px] text-ink-3 font-sans block mb-0.5">Total Trades</span>
          <span className="text-base font-bold text-accent">{filteredTrades.length}</span>
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        {(['All', 'Manual', 'GOATs', 'Profitable', 'Losses'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full font-medium transition-all shrink-0 ${
              filter === f
                ? 'bg-accent/20 border border-accent text-accent font-bold'
                : 'bg-surface-2 border border-line text-ink-3 hover:text-ink'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Trade Groups */}
      {filteredTrades.length === 0 ? (
        <div className="p-8 rounded-2xl bg-surface-3 border border-line text-center space-y-2">
          <History className="w-8 h-8 text-ink-4 mx-auto" />
          <div className="text-xs text-ink-3">No trades match the selected filter.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {todayTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-accent" />
                <span>Today ({todayTrades.length})</span>
              </h3>
              <div className="space-y-2">{todayTrades.map(renderTradeCard)}</div>
            </div>
          )}

          {yesterdayTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-ink-4" />
                <span>Yesterday ({yesterdayTrades.length})</span>
              </h3>
              <div className="space-y-2">{yesterdayTrades.map(renderTradeCard)}</div>
            </div>
          )}

          {earlierTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-ink-4" />
                <span>Earlier This Month ({earlierTrades.length})</span>
              </h3>
              <div className="space-y-2">{earlierTrades.map(renderTradeCard)}</div>
            </div>
          )}
        </div>
      )}

      {/* History Trade Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-overlay backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-surface border border-line rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="w-12 h-1.5 bg-line-strong/60 rounded-full mx-auto mt-2.5 sm:hidden" />

            <div className="flex items-center justify-between p-4 border-b border-line bg-surface-2">
              <div>
                <h3 className="text-base font-bold text-ink font-mono flex items-center gap-2">
                  <span>{selectedTrade.symbol}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-bold ${
                      selectedTrade.side === 'BUY'
                        ? 'bg-emerald-500/20 text-pos'
                        : 'bg-neg-strong/20 text-neg'
                    }`}
                  >
                    {selectedTrade.side}
                  </span>
                </h3>
                <div className="text-xs text-ink-3 font-mono mt-0.5">
                  ID: {selectedTrade.id}
                </div>
              </div>

              <button
                onClick={() => setSelectedTrade(null)}
                className="p-1.5 rounded-lg text-ink-3 hover:text-ink"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto">
              {/* PnL Hero */}
              <div
                className={`p-4 rounded-xl border flex items-center justify-between ${
                  selectedTrade.pnl >= 0
                    ? 'bg-pos-soft/30 border-pos/40 text-pos'
                    : 'bg-neg-soft/30 border-neg/40/40 text-neg'
                }`}
              >
                <div>
                  <div className="text-xs text-ink-3">Realized Outcome</div>
                  <div className="text-2xl font-bold font-mono tracking-tight mt-0.5">
                    {selectedTrade.pnl >= 0 ? '+' : ''}${selectedTrade.pnl.toFixed(2)} ({selectedTrade.pnlPercent.toFixed(2)}%)
                  </div>
                </div>

                <div className="p-3 rounded-full bg-white/5">
                  {selectedTrade.pnl >= 0 ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                </div>
              </div>

              {/* Execution Details Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <span className="text-[10px] text-ink-3 block font-sans mb-1">Entry Price</span>
                  <span className="text-ink font-bold">{selectedTrade.entryPrice.toFixed(5)}</span>
                </div>

                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <span className="text-[10px] text-ink-3 block font-sans mb-1">Exit Price</span>
                  <span className="text-ink font-bold">{selectedTrade.exitPrice.toFixed(5)}</span>
                </div>

                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <span className="text-[10px] text-ink-3 block font-sans mb-1">Exit Reason</span>
                  <span className="text-accent-ink font-bold">{selectedTrade.exitReason}</span>
                </div>

                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <span className="text-[10px] text-ink-3 block font-sans mb-1">Fees (Demo)</span>
                  <span className="text-ink-2 font-bold">Not modelled</span>
                </div>
              </div>

              {/* GOAT info */}
              <div className="p-3 rounded-xl bg-surface-3 border border-line flex items-center justify-between text-xs">
                <span className="text-ink-3">Execution Origin</span>
                <span className="font-bold text-ink font-mono">
                  {selectedTrade.goatName || 'Manual Trader Order'}
                </span>
              </div>

              {/* AI Analysis Button */}
              <button
                onClick={() => {
                  onAskAI({
                    currentTab: 'history',
                    selectedTradeId: selectedTrade.id,
                    selectedMarket: selectedTrade.symbol,
                  });
                  setSelectedTrade(null);
                }}
                className="w-full py-3 rounded-xl text-xs font-bold bg-accent-soft hover:bg-accent/20 text-accent border border-accent/30 transition-all flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Ask AI to Audit This Trade</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
