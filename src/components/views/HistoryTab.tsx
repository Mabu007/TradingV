import React, { useState } from 'react';
import {
  History,
  TrendingUp,
  TrendingDown,
  Download,
  Filter,
  Bot as BotIcon,
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
  const [filter, setFilter] = useState<'All' | 'Manual' | 'Bots' | 'Profitable' | 'Losses'>('All');
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);

  // Group trades by time periods
  const now = Date.now() / 1000;
  const oneDay = 86400;

  const filteredTrades = trades.filter((t) => {
    if (filter === 'Manual') return !t.botName && !t.botId;
    if (filter === 'Bots') return !!t.botName || !!t.botId;
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
        className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] hover:border-slate-600 active:scale-[0.99] transition-all cursor-pointer shadow-xs select-none"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className={`px-2 py-0.5 rounded-md text-[11px] font-bold font-mono ${
                isBuy
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }`}
            >
              {t.side}
            </span>
            <div>
              <div className="text-base font-bold text-white font-mono flex items-center gap-2">
                <span>{t.symbol}</span>
                <span className="text-xs text-slate-400 font-sans font-normal">
                  {formatPositionSize(t.volume, hyperliquidMarketData.getInstrument(t.symbol))}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                {t.entryPrice.toFixed(5)} → {t.exitPrice.toFixed(5)}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div
              className={`text-base font-bold font-mono tracking-tight ${
                isProfit ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isProfit ? '+' : ''}${t.pnl.toFixed(2)}
            </div>
            <div
              className={`text-[11px] font-semibold font-mono ${
                isProfit ? 'text-emerald-400/80' : 'text-rose-400/80'
              }`}
            >
              {isProfit ? '+' : ''}{t.pnlPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#1e293b]/60 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            {t.botName ? (
              <span className="text-sky-300 font-medium flex items-center gap-1">
                <BotIcon className="w-3.5 h-3.5 text-sky-400" />
                <span>{t.botName}</span>
              </span>
            ) : (
              <span>Manual Trade</span>
            )}
            <span>·</span>
            <span>{durationMin}m duration</span>
          </div>

          <div className="flex items-center gap-1 text-slate-400 font-mono">
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
          <h1 className="text-lg font-bold text-white tracking-tight">Trade History</h1>
          <p className="text-xs text-slate-400">Audit completed executions and performance metrics</p>
        </div>

        <button
          onClick={() => downloadTradesCSV(filteredTrades)}
          disabled={filteredTrades.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-[#162032] hover:bg-sky-600 hover:text-white text-sky-400 border border-sky-800/40 transition-all disabled:opacity-40"
          title="Download transactions as CSV for Excel or Python"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Download CSV</span>
        </button>
      </div>

      {/* Summary Metrics Bar */}
      <div className="grid grid-cols-3 gap-2 text-xs font-mono">
        <div className="p-3 rounded-xl bg-[#0b1220] border border-[#1e293b]">
          <span className="text-[10px] text-slate-400 font-sans block mb-0.5">Total Realized P&L</span>
          <span
            className={`text-base font-bold ${
              totalPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
          </span>
        </div>

        <div className="p-3 rounded-xl bg-[#0b1220] border border-[#1e293b]">
          <span className="text-[10px] text-slate-400 font-sans block mb-0.5">Win Rate</span>
          <span className="text-base font-bold text-white">{winRate.toFixed(1)}%</span>
        </div>

        <div className="p-3 rounded-xl bg-[#0b1220] border border-[#1e293b]">
          <span className="text-[10px] text-slate-400 font-sans block mb-0.5">Total Trades</span>
          <span className="text-base font-bold text-sky-400">{filteredTrades.length}</span>
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        {(['All', 'Manual', 'Bots', 'Profitable', 'Losses'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full font-medium transition-all shrink-0 ${
              filter === f
                ? 'bg-sky-500/20 border border-sky-500 text-sky-400 font-bold'
                : 'bg-[#0f172a] border border-[#1e293b] text-slate-400 hover:text-white'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Trade Groups */}
      {filteredTrades.length === 0 ? (
        <div className="p-8 rounded-2xl bg-[#090f1a] border border-[#1e293b] text-center space-y-2">
          <History className="w-8 h-8 text-slate-500 mx-auto" />
          <div className="text-xs text-slate-400">No trades match the selected filter.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {todayTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-sky-400" />
                <span>Today ({todayTrades.length})</span>
              </h3>
              <div className="space-y-2">{todayTrades.map(renderTradeCard)}</div>
            </div>
          )}

          {yesterdayTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-500" />
                <span>Yesterday ({yesterdayTrades.length})</span>
              </h3>
              <div className="space-y-2">{yesterdayTrades.map(renderTradeCard)}</div>
            </div>
          )}

          {earlierTrades.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-500" />
                <span>Earlier This Month ({earlierTrades.length})</span>
              </h3>
              <div className="space-y-2">{earlierTrades.map(renderTradeCard)}</div>
            </div>
          )}
        </div>
      )}

      {/* History Trade Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-[#0c1322] border border-[#1e293b] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="w-12 h-1.5 bg-slate-700/60 rounded-full mx-auto mt-2.5 sm:hidden" />

            <div className="flex items-center justify-between p-4 border-b border-[#1e293b] bg-[#0f172a]">
              <div>
                <h3 className="text-base font-bold text-white font-mono flex items-center gap-2">
                  <span>{selectedTrade.symbol}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-bold ${
                      selectedTrade.side === 'BUY'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}
                  >
                    {selectedTrade.side}
                  </span>
                </h3>
                <div className="text-xs text-slate-400 font-mono mt-0.5">
                  ID: {selectedTrade.id}
                </div>
              </div>

              <button
                onClick={() => setSelectedTrade(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto">
              {/* PnL Hero */}
              <div
                className={`p-4 rounded-xl border flex items-center justify-between ${
                  selectedTrade.pnl >= 0
                    ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-400'
                    : 'bg-rose-950/30 border-rose-800/40 text-rose-400'
                }`}
              >
                <div>
                  <div className="text-xs text-slate-400">Realized Outcome</div>
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
                <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
                  <span className="text-[10px] text-slate-400 block font-sans mb-1">Entry Price</span>
                  <span className="text-white font-bold">{selectedTrade.entryPrice.toFixed(5)}</span>
                </div>

                <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
                  <span className="text-[10px] text-slate-400 block font-sans mb-1">Exit Price</span>
                  <span className="text-white font-bold">{selectedTrade.exitPrice.toFixed(5)}</span>
                </div>

                <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
                  <span className="text-[10px] text-slate-400 block font-sans mb-1">Exit Reason</span>
                  <span className="text-sky-300 font-bold">{selectedTrade.exitReason}</span>
                </div>

                <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
                  <span className="text-[10px] text-slate-400 block font-sans mb-1">Fees (Demo)</span>
                  <span className="text-slate-300 font-bold">Not modelled</span>
                </div>
              </div>

              {/* Bot Info */}
              <div className="p-3 rounded-xl bg-[#090f1a] border border-[#1e293b] flex items-center justify-between text-xs">
                <span className="text-slate-400">Execution Origin</span>
                <span className="font-bold text-white font-mono">
                  {selectedTrade.botName || 'Manual Trader Order'}
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
                className="w-full py-3 rounded-xl text-xs font-bold bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 transition-all flex items-center justify-center gap-2"
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
