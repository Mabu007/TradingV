import React from 'react';
import {
  AlertOctagon,
  Sparkles,
  ChevronDown,
  Wallet,
  Sun,
  Moon,
  Info,
} from 'lucide-react';
import { ExecutionMode } from '../../types/trading';
import { ConnectionStatus } from '../../types/quotes';
import type { VenueEnvironment } from '../../config/venue';
import { useWallet } from '../../services/wallet';
import { useTheme } from '../../services/theme';

interface MobileHeaderProps {
  executionMode: ExecutionMode;
  /** The venue the client is bound to. Shown, never changed from here. */
  venueEnvironment: VenueEnvironment;
  /** Opens the LIVE notice. Never sets LIVE: this build cannot do it. */
  onToggleMode: (mode: ExecutionMode) => void;
  connectionStatus?: ConnectionStatus;
  pingMs?: number;
  isKillSwitchActive: boolean;
  onOpenKillSwitch: () => void;
  onOpenAI: () => void;
  onOpenWalletSettings: () => void;
}

/**
 * Global header.
 *
 * Layout contract, left to right:
 *
 *   TradingGOATs   [environment]            [theme] [AI] [Connect Wallet]
 *
 * - The environment pill is **informational**. Tapping it explains that
 *   LIVE is not implemented; it never switches modes.
 * - `Connect Wallet` is the one prominent action, because it is the only
 *   global identity control the product has. It goes through the
 *   `useWallet()` abstraction and never touches Privy directly.
 * - The theme toggle is compact and sits with the other secondary
 *   controls, not with the brand.
 */
export const MobileHeader: React.FC<MobileHeaderProps> = ({
  executionMode,
  venueEnvironment,
  onToggleMode,
  connectionStatus = 'CONNECTED',
  pingMs,
  isKillSwitchActive,
  onOpenKillSwitch,
  onOpenAI,
  onOpenWalletSettings,
}) => {
  const isConnected = connectionStatus === 'CONNECTED';
  const isConnecting =
    connectionStatus === 'CONNECTING' || connectionStatus === 'RECONNECTING';

  const { state: wallet, service: walletService } = useWallet();
  const { theme, toggleTheme } = useTheme();

  const walletConnected = wallet.status === 'CONNECTED' && Boolean(wallet.address);

  return (
    <header className="sticky top-0 z-30 w-full border-b border-line bg-header/90 backdrop-blur-md select-none">
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2.5">
        {/* Brand + environment */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-accent to-accent-strong text-[13px] font-bold leading-none text-accent-contrast shadow-xs"
              aria-hidden="true"
            >
              G
            </div>
            {/*
              The brand name appears from `lg` up only. Between 640 and
              1024 the sidebar already carries it, and at that width the
              row was crowding the venue and mode pills until they
              overlapped the controls beside them.
            */}
            <span className="hidden text-base font-bold tracking-tight text-ink lg:inline">
              TradingGOATs
            </span>
          </div>

          <div className="hidden h-4 w-px bg-line sm:block" />

          {/*
            The venue environment: which network the market data is
            actually coming from.

            A label, not a control. The two things it would otherwise be
            confused with are handled elsewhere and refuse to happen here —
            the deployment layer will not accept a LIVE GOAT, and the venue
            is changed in Settings, which also restates what the choice
            means.
          */}
          <div
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-1 text-[11px] font-semibold text-ink-3"
            title={`Hyperliquid ${venueEnvironment}. This build has no order-signing service, so nothing trades real value.`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                venueEnvironment === 'MAINNET' ? 'bg-warn' : 'bg-accent'
              }`}
            />
            <span className="font-mono">{venueEnvironment}</span>
          </div>

          {/*
            Execution mode. Clicking LIVE does not enable it — it explains
            why it cannot be enabled, which is the only honest thing this
            button can do. See `handleModeSelect`.
          */}
          {/*
            Hidden on the narrowest screens. This build cannot trade live,
            so on a phone the pill is a control that can only ever explain
            itself; the space is worth more than the affordance, and the
            mode is stated in Settings and beside the GOAT deploy button.
          */}
          <button
            type="button"
            onClick={() => onToggleMode('LIVE')}
            className="hidden items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-1 text-[11px] font-semibold text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2 sm:flex"
            title={`Execution mode: ${executionMode}. Live trading is not implemented in this build.`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                executionMode === 'LIVE' ? 'bg-neg animate-pulse' : 'bg-accent'
              }`}
            />
            <span className="font-mono">{executionMode}</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </button>
        </div>

        <div className="flex-1" />

        {/* Secondary controls */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Venue connection - desktop only, it is diagnostic not action */}
          <div
            className="hidden items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-ink-3 lg:flex"
            title={`Hyperliquid market data: ${connectionStatus}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isConnected
                  ? 'bg-pos'
                  : isConnecting
                    ? 'bg-warn animate-ping'
                    : 'bg-neg'
              }`}
            />
            <span>
              {isConnected
                ? `Hyperliquid${pingMs ? ` (${pingMs}ms)` : ''}`
                : isConnecting
                  ? 'Connecting...'
                  : 'Offline'}
            </span>
          </div>

          {/* Emergency kill switch */}
          <button
            type="button"
            onClick={onOpenKillSwitch}
            className={`rounded-xl border p-2 transition-colors ${
              isKillSwitchActive
                ? 'animate-pulse border-neg bg-neg-strong text-accent-contrast'
                : 'border-neg/30 bg-neg-soft text-neg hover:bg-neg/20'
            }`}
            title={isKillSwitchActive ? 'Trading is halted' : 'Emergency Kill Switch'}
            aria-label="Emergency Kill Switch"
          >
            <AlertOctagon className="h-4 w-4" />
          </button>

          {/* AI assistant */}
          <button
            type="button"
            onClick={onOpenAI}
            className="rounded-xl border border-accent/30 bg-accent-soft p-2 text-accent transition-colors hover:bg-accent/20 active:scale-95"
            title="Open TradingGOATs AI"
            aria-label="Open TradingGOATs AI"
          >
            <Sparkles className="h-4 w-4" />
          </button>

          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-xl border border-line bg-surface-2 p-2 text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label={
              theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            }
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>

          {/* Primary action: wallet */}
          {walletConnected ? (
            <button
              type="button"
              onClick={onOpenWalletSettings}
              className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] font-semibold text-ink transition-colors hover:border-line-strong"
              title={`Wallet ${wallet.address} - open wallet settings`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-pos" />
              <span className="max-w-[92px] truncate">{wallet.shortAddress}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void walletService.connect()}
              disabled={!wallet.configured || wallet.status === 'CONNECTING'}
              className="flex items-center gap-1.5 rounded-xl bg-accent-strong px-2.5 py-1.5 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-4 sm:px-3 sm:text-xs"
              title={
                wallet.configured
                  ? 'Connect your wallet'
                  : 'Wallet sign-in needs a Privy application id (VITE_PRIVY_APP_ID)'
              }
            >
              <Wallet className="h-3.5 w-3.5" />
              <span className="hidden xs:inline sm:inline">
                {wallet.status === 'CONNECTING' ? 'Connecting…' : 'Connect Wallet'}
              </span>
              <span className="sm:hidden">
                {wallet.status === 'CONNECTING' ? '…' : 'Connect'}
              </span>
            </button>
          )}

          {/* Wallet not configured in this build - explain once, quietly */}
          {!wallet.configured ? (
            <span
              className="hidden text-ink-4 lg:inline"
              title="Wallet sign-in needs a Privy application id (VITE_PRIVY_APP_ID)"
            >
              <Info className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
};
