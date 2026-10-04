import React from 'react';
import { Wallet, LogOut, ShieldCheck, Info } from 'lucide-react';
import { useWallet } from '../../services/wallet';

interface WalletCardProps {
  executionMode: 'BACKTEST' | 'DEMO' | 'LIVE';
}

/**
 * Wallet connection card.
 *
 * Shows only what a user needs to know: whether they are connected, the
 * wallet address, and how to disconnect. There is no balance, no
 * transaction status, and no claim that live trading is available -
 * because it is not.
 */
export const WalletCard: React.FC<WalletCardProps> = ({ executionMode }) => {
  const { state, service } = useWallet();

  const connected = state.status === 'CONNECTED' && Boolean(state.address);

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1">
        Wallet
      </h3>

      <div className="rounded-2xl bg-surface border border-line overflow-hidden divide-y divide-line/60">
        {/* Connection status */}
        <div className="p-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`p-2 rounded-xl border shrink-0 ${
                connected
                  ? 'bg-pos-soft text-pos border-pos/40'
                  : 'bg-surface-3/60 text-ink-2 border-line-strong/40'
              }`}
            >
              <Wallet className="w-5 h-5" />
            </div>

            <div className="min-w-0">
              <div className="text-sm font-bold text-ink flex items-center gap-2 flex-wrap">
                <span>{connected ? 'Wallet connected' : 'Not connected'}</span>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                    connected
                      ? 'bg-pos-soft text-pos border-pos/40'
                      : 'bg-surface-3/60 text-ink-3 border-line-strong/40'
                  }`}
                >
                  {statusLabel(state.status)}
                </span>
              </div>

              {connected ? (
                <div className="text-xs text-ink-3 mt-0.5 font-mono truncate">
                  {state.shortAddress}
                </div>
              ) : (
                <div className="text-xs text-ink-3 mt-0.5 font-sans">
                  {state.configured
                    ? 'Connect to use your own wallet as your trading identity.'
                    : 'Wallet sign-in is not configured in this build.'}
                </div>
              )}
            </div>
          </div>

          {connected ? (
            <button
              onClick={() => void service.disconnect()}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-3 text-ink-2 text-xs font-semibold border border-line transition-colors"
              title="Disconnect wallet"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => void service.connect()}
              disabled={!state.configured || state.status === 'CONNECTING'}
              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-accent-strong hover:bg-accent text-accent-contrast disabled:bg-line disabled:text-ink-4 disabled:cursor-not-allowed"
              title={
                state.configured
                  ? 'Connect your wallet'
                  : 'Set VITE_PRIVY_APP_ID to enable wallet sign-in'
              }
            >
              {state.status === 'CONNECTING' ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>

        {/* What a connected wallet does and does not do */}
        <div className="p-3.5 flex items-start gap-3 text-xs text-ink-3">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-accent" />
          <p className="font-sans leading-relaxed">
            Your wallet is your identity on TradingGOATs. It does not hold
            your funds, and it does not change your trading mode &mdash; you
            are currently in{' '}
            <strong className="text-ink-2">{executionMode}</strong>.
          </p>
        </div>

        {state.error ? (
          <div className="p-3.5 flex items-start gap-3 text-xs text-warn">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="font-sans leading-relaxed">{state.error}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};

function statusLabel(status: string): string {
  switch (status) {
    case 'CONNECTED': return 'Connected';
    case 'CONNECTING': return 'Connecting';
    case 'INITIALISING': return 'Starting';
    case 'ERROR': return 'Unavailable';
    case 'UNCONFIGURED': return 'Not set up';
    default: return 'Disconnected';
  }
}
