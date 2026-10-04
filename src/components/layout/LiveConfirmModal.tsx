import React from 'react';
import { ShieldOff, X } from 'lucide-react';

interface LiveConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * LIVE execution is not implemented.
 *
 * This dialog exists to make that state explicit when a user asks for
 * LIVE. It deliberately offers no way to confirm: there is no typed
 * consent, no "Activate Live Trading" button, and no path that sets the
 * execution mode to LIVE.
 *
 * The reason is not a missing confirmation step. LIVE requires a
 * server-side Hyperliquid signing boundary that does not exist yet.
 * Connecting a wallet does not change that - a wallet is an identity,
 * not an execution permission. See `docs/security.md`.
 */
export const LiveConfirmModal: React.FC<LiveConfirmModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-surface border border-line-strong/60 rounded-lg shadow-2xl p-5 text-ink-2">
        <div className="flex items-start justify-between pb-3 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-surface-3 text-ink-2 border border-line-strong">
              <ShieldOff className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink tracking-wide">
                Live trading is not available
              </h3>
              <p className="text-xs text-ink-3 font-medium">
                This build can only run DEMO and BACKTEST
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-3 text-xs leading-relaxed text-ink-2">
          <p>
            LIVE execution stays disabled until the signing and execution
            boundary is implemented and verified. Real orders cannot be
            signed or sent from this application yet, so there is nothing to
            confirm.
          </p>
          <p>
            You can use <strong className="text-ink">DEMO</strong> with
            live Hyperliquid quotes and simulated fills, or{' '}
            <strong className="text-ink">BACKTEST</strong> on historical
            candles. Connecting a wallet in Settings gives you an identity; it
            does not enable live trading.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-semibold text-ink-2 bg-line-strong hover:bg-line-strong transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
