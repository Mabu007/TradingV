import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';

interface LiveConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const LiveConfirmModal: React.FC<LiveConfirmModalProps> = ({
  isOpen,
  onConfirm,
  onCancel,
}) => {
  const [understood, setUnderstood] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');

  if (!isOpen) return null;

  const canConfirm = understood && typedConfirmation.trim().toUpperCase() === 'I UNDERSTAND THE RISKS';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-[#0c121e] border border-rose-900/60 rounded-lg shadow-2xl p-5 text-slate-200">
        <div className="flex items-start justify-between pb-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-rose-950/60 border border-rose-800/60 text-rose-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">
                Switch to LIVE Execution Environment
              </h3>
              <p className="text-xs text-rose-300 font-medium">Deliberate Safety Confirmation Required</p>
            </div>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-3 text-xs leading-relaxed text-slate-300">
          <div className="p-3 rounded bg-rose-950/20 border border-rose-800/30 text-rose-200 space-y-1.5">
            <div className="font-semibold text-rose-300 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              <span>Real Capital at Risk</span>
            </div>
            <p>
              In <strong>LIVE</strong> mode, strategy orders will be transmitted directly to your live
              broker account via Hyperliquid. Live market orders will execute with real capital and incur
              actual broker spread and commission charges.
            </p>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-0.5 rounded border-[#1e293b] text-rose-600 focus:ring-rose-500"
            />
            <span className="text-[11px] text-slate-300">
              I acknowledge that automated algorithmic strategies may experience unexpected slippage, latency,
              or market volatility, and I accept full responsibility for all live orders submitted.
            </span>
          </label>

          <div className="pt-2">
            <label className="block text-[11px] text-slate-400 mb-1">
              Type <span className="font-mono text-white select-all">I UNDERSTAND THE RISKS</span> to confirm:
            </label>
            <input
              type="text"
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              placeholder="I UNDERSTAND THE RISKS"
              className="w-full bg-[#131c2e] text-slate-100 border border-[#1e293b] rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-rose-500"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#1e293b]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-4 py-1.5 rounded text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            Activate Live Trading
          </button>
        </div>
      </div>
    </div>
  );
};
