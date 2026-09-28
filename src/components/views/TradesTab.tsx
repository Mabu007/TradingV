import React, { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Bot as BotIcon,
  Shield,
  Plus,
  Clock,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { Position, Trade, ExecutionMode } from '../../types/trading';
import { PositionDetailModal } from '../modals/PositionDetailModal';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { formatPositionSize } from '../../utils/positionSize';

interface TradesTabProps {
  balance: number;
  equity: number;
  /** Demo margin projection from the execution environment. */
  margin: number;
  freeMargin: number;
  positions: Position[];
  trades: Trade[];
  executionMode: ExecutionMode;
  onClosePosition: (posId: string) => void;
  onOpenMarket: (symbol: string) => void;
  onOpenBots: () => void;
  onAskAI: (context: any) => void;
}

export const TradesTab: React.FC<TradesTabProps> = ({
  balance,
  equity,
  margin,
  freeMargin,
  positions,
  trades,
  executionMode,
  onClosePosition,
  onOpenMarket,
  onOpenBots,
  onAskAI,
}) => {
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);

  // Compute today's realized + unrealized P&L
  const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
  const todaysClosedTrades = trades.slice(0, 10);
  const realizedPnLToday = todaysClosedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalPnLToday = unrealizedPnL + realizedPnLToday;
  const isPositiveToday = totalPnLToday >= 0;

  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-4 pb-24 md:pb-8 max-w-4xl mx-auto w-full space-y-4">
      {/* ACCOUNT SUMMARY HERO CARD */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#0e1728] via-[#0b1220] to-[#080d16] border border-[#1e293b] p-4.5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Account</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-medium bg-[#1e293b] text-sky-300">
              {executionMode === 'LIVE' ? 'Live Broker Account' : 'Demo Account'}
            </span>
          </div>

          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold font-mono ${
              isPositiveToday
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
            }`}
          >
            {isPositiveToday ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            <span>
              Today: {isPositiveToday ? '+' : ''}${totalPnLToday.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Balance & Equity figures */}
        <div className="grid grid-cols-2 gap-4 pt-1">
          <div>
            <div className="text-xs text-slate-400 mb-0.5">Net Equity</div>
            <div className="text-2xl sm:text-3xl font-bold font-mono text-white tracking-tight">
              ${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-0.5">Balance</div>
            <div className="text-xl sm:text-2xl font-semibold font-mono text-slate-300 tracking-tight">
              ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-0.5">
              Margin Used
              <span className="text-slate-600"> · demo estimate</span>
            </div>
            <div className="text-lg sm:text-xl font-semibold font-mono text-slate-300 tracking-tight">
              ${margin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-0.5">Available</div>
            <div className="text-lg sm:text-xl font-semibold font-mono text-slate-300 tracking-tight">
              ${freeMargin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Quick Account Footnote */}
        <div className="mt-3.5 pt-3 border-t border-[#1e293b]/70 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-mono">
              Hyperliquid Demo · no liquidation data
            </span>
          </div>
          <span className="font-mono text-[11px] text-slate-300">
            {positions.length} Open Position{positions.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* OPEN POSITIONS SECTION */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <span>Open Positions</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {positions.length}
            </span>
          </h2>

          <button
            onClick={() => onOpenMarket('EUR/USD')}
            className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Trade</span>
          </button>
        </div>

        {positions.length === 0 ? (
          <div className="p-6 rounded-2xl bg-[#090f1a] border border-[#1e293b]/80 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-slate-800/60 border border-[#1e293b] flex items-center justify-center text-slate-400 mx-auto">
              <Layers className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">No Open Positions</div>
              <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                You have no active market exposure. Explore quotes to place a trade, or start an automated bot.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                onClick={() => onOpenMarket('EUR/USD')}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white transition-all shadow-sm active:scale-95"
              >
                Explore Quotes
              </button>
              <button
                onClick={onOpenBots}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#162032] hover:bg-[#1e293b] text-slate-200 border border-[#1e293b] transition-all active:scale-95"
              >
                Browse Bots
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {positions.map((pos) => {
              const isBuy = pos.side === 'BUY';
              const isProfit = pos.unrealizedPnL >= 0;
              const size = formatPositionSize(pos.volume, hyperliquidMarketData.getInstrument(pos.symbol));

              return (
                <div
                  key={pos.id}
                  onClick={() => setSelectedPosition(pos)}
                  className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] hover:border-slate-600 active:scale-[0.99] transition-all cursor-pointer shadow-sm select-none"
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
                        {pos.side}
                      </span>
                      <div>
                        <div className="text-base font-bold text-white font-mono flex items-center gap-2">
                          <span>{pos.symbol}</span>
                          <span className="text-xs text-slate-400 font-sans font-normal">
                            {size}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                          Entry: {pos.entryPrice.toFixed(5)} → Current: {pos.currentPrice.toFixed(5)}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div
                        className={`text-base font-bold font-mono tracking-tight ${
                          isProfit ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isProfit ? '+' : ''}${pos.unrealizedPnL.toFixed(2)}
                      </div>
                      <div
                        className={`text-[11px] font-semibold font-mono ${
                          isProfit ? 'text-emerald-400/80' : 'text-rose-400/80'
                        }`}
                      >
                        {isProfit ? '+' : ''}{pos.unrealizedPnlPercent.toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  {/* Bot Origin or Stop Loss footer */}
                  <div className="mt-2.5 pt-2 border-t border-[#1e293b]/60 flex items-center justify-between text-[11px] text-slate-400">
                    <div className="flex items-center gap-1.5">
                      {pos.botName ? (
                        <>
                          <BotIcon className="w-3.5 h-3.5 text-sky-400" />
                          <span className="text-sky-300 font-medium">Bot: {pos.botName}</span>
                        </>
                      ) : (
                        <span>Manual Market Order</span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 text-slate-400">
                      <span>Tap to view / close</span>
                      <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* RECENT ACTIVITY SECTION */}
      <div className="space-y-2.5 pt-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
            Recent Activity
          </h2>
          <span className="text-xs text-slate-400">Last 5 Closed Trades</span>
        </div>

        {todaysClosedTrades.length === 0 ? (
          <div className="p-4 rounded-xl bg-[#090f1a] border border-[#1e293b]/60 text-center text-xs text-slate-400">
            No closed trades today yet.
          </div>
        ) : (
          <div className="space-y-1.5">
            {todaysClosedTrades.slice(0, 5).map((t) => {
              const isProfit = t.pnl >= 0;
              return (
                <div
                  key={t.id}
                  className="p-3 rounded-xl bg-[#090f1a] border border-[#1e293b]/60 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono ${
                        t.side === 'BUY'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-rose-500/10 text-rose-400'
                      }`}
                    >
                      {t.side}
                    </span>
                    <div>
                      <span className="font-bold text-white font-mono">{t.symbol}</span>
                      <span className="text-slate-400 ml-2 font-mono text-[11px]">
                        {t.exitPrice.toFixed(5)}
                      </span>
                    </div>
                  </div>

                  <div className="text-right font-mono">
                    <span
                      className={`font-bold ${
                        isProfit ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {isProfit ? '+' : ''}${t.pnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Position Detail Modal */}
      <PositionDetailModal
        position={selectedPosition}
        onClose={() => setSelectedPosition(null)}
        onClosePosition={onClosePosition}
        onAskAI={(pos) =>
          onAskAI({
            currentTab: 'trades',
            selectedPositionId: pos.id,
            selectedMarket: pos.symbol,
          })
        }
      />
    </div>
  );
};
