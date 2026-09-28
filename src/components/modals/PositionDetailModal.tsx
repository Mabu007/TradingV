import React, { useState } from 'react';
import {
  X,
  TrendingUp,
  TrendingDown,
  Shield,
  Bot,
  Clock,
  Layers,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { Position } from '../../types/trading';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { formatPositionSize } from '../../utils/positionSize';

interface PositionDetailModalProps {
  position: Position | null;
  onClose: () => void;
  onClosePosition: (positionId: string) => void;
  onAskAI: (pos: Position) => void;
}

export const PositionDetailModal: React.FC<PositionDetailModalProps> = ({
  position,
  onClose,
  onClosePosition,
  onAskAI,
}) => {
  const [confirmingClose, setConfirmingClose] = useState(false);

  if (!position) return null;

  const isBuy = position.side === 'BUY';
  const isProfit = position.unrealizedPnL >= 0;
  const timeFormatted = new Date(position.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleCloseTrigger = () => {
    if (!confirmingClose) {
      setConfirmingClose(true);
    } else {
      onClosePosition(position.id);
      setConfirmingClose(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-[#0c1322] border border-[#1e293b] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Drag handle pill on mobile */}
        <div className="w-12 h-1.5 bg-slate-700/60 rounded-full mx-auto mt-2.5 sm:hidden" />

        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1e293b] bg-[#0f172a]">
          <div className="flex items-center gap-2.5">
            <span
              className={`px-2 py-0.5 rounded-md text-xs font-bold font-mono ${
                isBuy
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }`}
            >
              {position.side}
            </span>
            <div>
              <div className="text-base font-bold text-white font-mono flex items-center gap-2">
                <span>{position.symbol}</span>
                <span className="text-xs text-slate-400 font-sans font-normal">
                  {formatPositionSize(position.volume, hyperliquidMarketData.getInstrument(position.symbol))}
                </span>
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              setConfirmingClose(false);
              onClose();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Main P&L Banner */}
          <div
            className={`p-4 rounded-xl border flex items-center justify-between ${
              isProfit
                ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-400'
                : 'bg-rose-950/30 border-rose-800/40 text-rose-400'
            }`}
          >
            <div>
              <div className="text-xs text-slate-400 font-sans">Unrealized P&L</div>
              <div className="text-2xl font-bold font-mono tracking-tight flex items-baseline gap-1 mt-0.5">
                <span>{isProfit ? '+' : ''}${position.unrealizedPnL.toFixed(2)}</span>
                <span className="text-sm font-semibold opacity-80">
                  ({isProfit ? '+' : ''}{position.unrealizedPnlPercent.toFixed(2)}%)
                </span>
              </div>
            </div>

            <div className="p-3 rounded-full bg-white/5">
              {isProfit ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
            </div>
          </div>

          {/* Pricing Grid */}
          <div className="grid grid-cols-2 gap-2.5 text-xs font-mono">
            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <span className="text-[11px] text-slate-400 font-sans block mb-1">Entry Price</span>
              <span className="text-white font-semibold text-sm">{position.entryPrice.toFixed(5)}</span>
            </div>

            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <span className="text-[11px] text-slate-400 font-sans block mb-1">Current Price</span>
              <span className="text-white font-semibold text-sm">{position.currentPrice.toFixed(5)}</span>
            </div>

            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <span className="text-[11px] text-slate-400 font-sans block mb-1">Stop Loss</span>
              <span className="text-rose-400 font-semibold text-sm">
                {position.stopLoss ? position.stopLoss.toFixed(5) : 'Not set'}
              </span>
            </div>

            <div className="p-3 rounded-xl bg-[#0f172a] border border-[#1e293b]">
              <span className="text-[11px] text-slate-400 font-sans block mb-1">Take Profit</span>
              <span className="text-emerald-400 font-semibold text-sm">
                {position.takeProfit ? position.takeProfit.toFixed(5) : 'Not set'}
              </span>
            </div>
          </div>

          {/* Bot Origin or Manual badge */}
          <div className="p-3 rounded-xl bg-[#111927] border border-[#1e293b] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-slate-300">
              <Bot className="w-4 h-4 text-sky-400" />
              <span>Executed by</span>
            </div>
            <span className="font-semibold text-white">
              {position.botName || 'Manual Market Order'}
            </span>
          </div>

          {/* Time & Fees */}
          <div className="flex items-center justify-between text-xs text-slate-400 px-1 font-mono">
            <div className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              <span>Opened at {timeFormatted}</span>
            </div>
            <div>
              <span>
                Fees (Demo): not modelled
              </span>
            </div>
          </div>
        </div>

        {/* Modal Actions with Deliberate Confirmation */}
        <div className="p-4 border-t border-[#1e293b] bg-[#0f172a] flex flex-col gap-2.5">
          {!confirmingClose ? (
            <>
              <button
                onClick={handleCloseTrigger}
                className="w-full py-3.5 rounded-xl font-bold text-sm bg-rose-600 hover:bg-rose-500 text-white transition-all shadow-lg shadow-rose-900/40 active:scale-98 flex items-center justify-center gap-2"
              >
                <span>Close Position</span>
              </button>

              <button
                onClick={() => {
                  onAskAI(position);
                  onClose();
                }}
                className="w-full py-2.5 rounded-xl text-xs font-semibold text-sky-400 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 transition-all active:scale-98"
              >
                Ask AI to analyze this trade
              </button>
            </>
          ) : (
            <div className="space-y-2 p-3 rounded-xl bg-rose-950/40 border border-rose-800/50 animate-in fade-in">
              <div className="flex items-center gap-2 text-xs font-bold text-rose-300">
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                <span>Confirm Position Close</span>
              </div>
              <p className="text-xs text-slate-300">
                Are you sure you want to close this {position.side} position on {position.symbol} at current market price?
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => setConfirmingClose(false)}
                  className="flex-1 py-2.5 rounded-xl font-semibold text-xs bg-[#162032] hover:bg-[#1e293b] text-slate-300 border border-[#1e293b]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCloseTrigger}
                  className="flex-1 py-2.5 rounded-xl font-bold text-xs bg-rose-600 hover:bg-rose-500 text-white shadow-md shadow-rose-950"
                >
                  Yes, Close Position
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
