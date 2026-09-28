import React from 'react';
import { AlertOctagon, PowerOff, ShieldCheck, X } from 'lucide-react';

interface KillSwitchModalProps {
  isOpen: boolean;
  isEngaged: boolean;
  openPositionsCount: number;
  onToggleKillSwitch: () => void;
  onFlattenAllPositions: () => void;
  onClose: () => void;
}

export const KillSwitchModal: React.FC<KillSwitchModalProps> = ({
  isOpen,
  isEngaged,
  openPositionsCount,
  onToggleKillSwitch,
  onFlattenAllPositions,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-[#0c121e] border border-rose-900/60 rounded-lg shadow-2xl p-5 text-slate-200">
        <div className="flex items-start justify-between pb-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2.5">
            <div
              className={`p-2 rounded ${
                isEngaged ? 'bg-rose-950/80 text-rose-400' : 'bg-amber-950/60 text-amber-400'
              }`}
            >
              <AlertOctagon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">
                Emergency Execution Kill Switch
              </h3>
              <p className="text-xs text-slate-400">TradingVibe Risk Safeguard Intercept</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-3.5 text-xs text-slate-300 leading-relaxed">
          <p>
            The Kill Switch immediately halts the strategy execution bridge. When engaged, all subsequent
            market and limit order requests are instantly intercepted and rejected before reaching
            execution environments.
          </p>

          <div
            className={`p-3 rounded border ${
              isEngaged
                ? 'bg-rose-950/30 border-rose-800/40 text-rose-200'
                : 'bg-[#131c2e] border-[#1e293b] text-slate-300'
            }`}
          >
            <div className="font-semibold mb-1 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isEngaged ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`} />
              <span>Current Status: {isEngaged ? 'ENGAGED (TRADING HALTED)' : 'ARMED / NOMINAL'}</span>
            </div>
            <div className="text-[11px] text-slate-400">
              Open Positions: <strong className="text-white">{openPositionsCount}</strong>
            </div>
          </div>

          {openPositionsCount > 0 && (
            <div className="p-2.5 rounded bg-[#111927] border border-[#1e293b] flex items-center justify-between">
              <div>
                <div className="font-medium text-white">Flatten All Positions</div>
                <div className="text-[10px] text-slate-400">Immediately market-close all {openPositionsCount} open positions</div>
              </div>
              <button
                onClick={onFlattenAllPositions}
                className="px-2.5 py-1 rounded bg-rose-950 hover:bg-rose-900 text-rose-200 border border-rose-800/50 text-[11px] font-semibold transition-colors"
              >
                Close All
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#1e293b]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155] transition-colors"
          >
            Close
          </button>
          <button
            onClick={onToggleKillSwitch}
            className={`px-4 py-1.5 rounded text-xs font-semibold text-white transition-colors shadow-sm ${
              isEngaged
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-rose-600 hover:bg-rose-500'
            }`}
          >
            {isEngaged ? 'Resume Trading Engine' : 'Engage Kill Switch'}
          </button>
        </div>
      </div>
    </div>
  );
};
