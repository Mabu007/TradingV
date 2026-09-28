import React from 'react';
import { AlertOctagon, Sparkles, ChevronDown, User as UserIcon } from 'lucide-react';
import { ExecutionMode } from '../../types/trading';
import { ConnectionStatus } from '../../types/quotes';

interface MobileHeaderProps {
  executionMode: ExecutionMode;
  onToggleMode: (mode: ExecutionMode) => void;
  connectionStatus?: ConnectionStatus;
  pingMs?: number;
  isKillSwitchActive: boolean;
  onOpenKillSwitch: () => void;
  onOpenAI: () => void;
  onOpenProfile?: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  executionMode,
  onToggleMode,
  connectionStatus = 'CONNECTED',
  pingMs = 22,
  isKillSwitchActive,
  onOpenKillSwitch,
  onOpenAI,
  onOpenProfile,
}) => {
  const isConnected = connectionStatus === 'CONNECTED';
  const isConnecting = connectionStatus === 'CONNECTING' || connectionStatus === 'RECONNECTING';

  return (
    <header className="sticky top-0 z-30 w-full bg-[#080d16]/95 backdrop-blur-md border-b border-[#1e293b] px-3.5 py-2.5 flex items-center justify-between select-none">
      {/* Brand & Account Switcher */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-2 font-sans">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white font-mono font-bold text-xs shadow-xs">
            V
          </div>
          <span className="text-white font-bold tracking-tight text-base font-sans">TradingVibe</span>
        </div>

        <div className="h-4 w-[1px] bg-[#1e293b]" />

        {/* Account Mode Pill */}
        <button
          onClick={() => onToggleMode(executionMode === 'DEMO' ? 'LIVE' : 'DEMO')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-all border ${
            executionMode === 'LIVE'
              ? 'bg-rose-950/70 border-rose-700/60 text-rose-300'
              : 'bg-[#111a2c] border-sky-800/40 text-sky-300'
          }`}
          title="Tap to toggle Demo / Live Account"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              executionMode === 'LIVE' ? 'bg-rose-400 animate-pulse' : 'bg-sky-400'
            }`}
          />
          <span className="font-mono text-[11px]">
            {executionMode === 'LIVE' ? 'Live' : 'Demo'}
          </span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </div>

      {/* Right Controls: Connectivity, Kill Switch, AI, Profile */}
      <div className="flex items-center gap-1.5">
        {/* Connection status badge */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#111927] border border-[#1e293b] text-[11px] font-mono text-slate-300"
           title={`Hyperliquid Connection: ${connectionStatus}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected
                ? 'bg-emerald-400'
                : isConnecting
                ? 'bg-amber-400 animate-ping'
                : 'bg-rose-500'
            }`}
          />
          <span className="hidden sm:inline">
             {isConnected ? `Hyperliquid (${pingMs}ms)` : isConnecting ? 'Connecting...' : 'Hyperliquid Offline'}
          </span>
          <span className="sm:hidden">
            {isConnected ? `${pingMs}ms` : 'Off'}
          </span>
        </div>

        {/* Emergency Kill Switch Button */}
        <button
          onClick={onOpenKillSwitch}
          className={`p-2 rounded-xl transition-all border ${
            isKillSwitchActive
              ? 'bg-rose-600 text-white animate-pulse border-rose-500 shadow-lg shadow-rose-900/40'
              : 'bg-rose-950/40 border-rose-900/40 text-rose-400 hover:bg-rose-900/50'
          }`}
          title={isKillSwitchActive ? 'Trading is Halted' : 'Emergency Kill Switch'}
        >
          <AlertOctagon className="w-4 h-4" />
        </button>

        {/* AI Quick Button */}
        <button
          onClick={onOpenAI}
          className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400 hover:bg-sky-500/20 transition-all active:scale-95"
          title="Open AI Assistant"
        >
          <Sparkles className="w-4 h-4" />
        </button>

        {/* Mobile Profile Avatar Shortcut */}
        {onOpenProfile && (
          <button
            onClick={onOpenProfile}
            className="md:hidden p-1 rounded-full bg-[#111927] border border-[#1e293b] text-slate-300 hover:text-white"
            title="Profile"
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs font-mono">
              G
            </div>
          </button>
        )}
      </div>
    </header>
  );
};
