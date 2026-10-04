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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-surface border border-neg/40/60 rounded-lg shadow-2xl p-5 text-ink-2">
        <div className="flex items-start justify-between pb-3 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div
              className={`p-2 rounded ${
                isEngaged ? 'bg-neg-soft/80 text-neg' : 'bg-warn-soft/60 text-warn'
              }`}
            >
              <AlertOctagon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink tracking-wide">
                Emergency Execution Kill Switch
              </h3>
              <p className="text-xs text-ink-3">TradingGOATs Risk Safeguard Intercept</p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-3.5 text-xs text-ink-2 leading-relaxed">
          <p>
            The Kill Switch immediately halts the strategy execution bridge. When engaged, all subsequent
            market and limit order requests are instantly intercepted and rejected before reaching
            execution environments.
          </p>

          <div
            className={`p-3 rounded border ${
              isEngaged
                ? 'bg-neg-soft/30 border-neg/40/40 text-rose-200'
                : 'bg-surface-3 border-line text-ink-2'
            }`}
          >
            <div className="font-semibold mb-1 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isEngaged ? 'bg-neg-strong animate-pulse' : 'bg-emerald-500'}`} />
              <span>Current Status: {isEngaged ? 'ENGAGED (TRADING HALTED)' : 'ARMED / NOMINAL'}</span>
            </div>
            <div className="text-[11px] text-ink-3">
              Open Positions: <strong className="text-ink">{openPositionsCount}</strong>
            </div>
          </div>

          {openPositionsCount > 0 && (
            <div className="p-2.5 rounded bg-surface-3 border border-line flex items-center justify-between">
              <div>
                <div className="font-medium text-ink">Flatten All Positions</div>
                <div className="text-[10px] text-ink-3">Immediately market-close all {openPositionsCount} open positions</div>
              </div>
              <button
                onClick={onFlattenAllPositions}
                className="px-2.5 py-1 rounded bg-neg-soft hover:bg-neg-soft text-rose-200 border border-neg/40/50 text-[11px] font-semibold transition-colors"
              >
                Close All
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs text-ink-2 hover:text-ink bg-line-strong hover:bg-line-strong transition-colors"
          >
            Close
          </button>
          <button
            onClick={onToggleKillSwitch}
            className={`px-4 py-1.5 rounded text-xs font-semibold text-ink transition-colors shadow-sm ${
              isEngaged
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-neg-strong hover:bg-neg-strong'
            }`}
          >
            {isEngaged ? 'Resume Trading Engine' : 'Engage Kill Switch'}
          </button>
        </div>
      </div>
    </div>
  );
};
