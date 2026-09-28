import React from 'react';
import {
  Activity,
  AlertOctagon,
  Cpu,
  Layers,
  Server,
  Settings2,
  Sparkles,
  Maximize2,
  Minimize2,
  Code2,
  Terminal,
  PanelRight,
} from 'lucide-react';
import { ExecutionMode, Timeframe } from '../../types/trading';
import { MarketSymbol } from '../../types/instruments';

interface HeaderProps {
  currentSymbol: string;
  symbols: MarketSymbol[];
  onSymbolChange: (symbol: string) => void;
  currentTimeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  executionMode: ExecutionMode;
  onModeSelect: (mode: ExecutionMode) => void;
  balance: number;
  equity: number;
  openPositionsCount: number;
  isKillSwitchActive: boolean;
  onOpenKillSwitchModal: () => void;
  onOpenHyperliquidSettings: () => void;
  onOpenAISettings: () => void;
  connectionState: { isConnected: boolean; environment: string; pingMs: number };
  isChartFullscreen?: boolean;
  onToggleChartFullscreen?: () => void;
  showEditor?: boolean;
  onToggleEditor?: () => void;
  showBottomPanel?: boolean;
  onToggleBottomPanel?: () => void;
  showAIPanel?: boolean;
  onToggleAIPanel?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentSymbol,
  symbols,
  onSymbolChange,
  currentTimeframe,
  onTimeframeChange,
  executionMode,
  onModeSelect,
  balance,
  equity,
  openPositionsCount,
  isKillSwitchActive,
  onOpenKillSwitchModal,
  onOpenHyperliquidSettings,
  onOpenAISettings,
  connectionState,
  isChartFullscreen = false,
  onToggleChartFullscreen,
  showEditor = true,
  onToggleEditor,
  showBottomPanel = true,
  onToggleBottomPanel,
  showAIPanel = true,
  onToggleAIPanel,
}) => {
  const timeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

  return (
    <header className="h-12 w-full bg-[#0a0f18] border-b border-[#1e293b] flex items-center justify-between px-3 shrink-0 select-none">
      {/* ZONE 1: Brand Wordmark (Single text element wordmark as per Top Bar Contract) */}
      <div className="flex items-center gap-3">
        <a href="/" className="text-base font-bold tracking-tight text-white flex items-center gap-1.5 font-mono">
          <span className="text-sky-400 font-bold">&gt;</span>
          <span>TradingVibes</span>
        </a>

        <div className="h-4 w-[1px] bg-[#1e293b]" />

        {/* Symbol Selector */}
        <div className="flex items-center gap-1">
          <select
            value={currentSymbol}
            onChange={(e) => onSymbolChange(e.target.value)}
            className="bg-[#111927] text-white font-mono font-semibold text-xs border border-[#1e293b] rounded px-2 py-1 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Timeframe Selector */}
        <div className="hidden md:flex items-center bg-[#111927] p-0.5 rounded border border-[#1e293b] text-xs font-mono">
          {timeframes.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframeChange(tf)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                currentTimeframe === tf
                  ? 'bg-sky-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* ZONE 2: Environment Selector & Account Metrics */}
      <div className="flex items-center gap-3">
        {/* Environment Segmented Selector */}
        <div className="flex items-center bg-[#111927] p-0.5 rounded border border-[#1e293b] text-xs font-mono font-medium">
          <button
            onClick={() => onModeSelect('BACKTEST')}
            className={`px-2.5 py-1 rounded transition-colors ${
              executionMode === 'BACKTEST'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Backtest
          </button>
          <button
            onClick={() => onModeSelect('DEMO')}
            className={`px-2.5 py-1 rounded transition-colors ${
              executionMode === 'DEMO'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Demo
          </button>
          <button
            onClick={() => onModeSelect('LIVE')}
            className={`px-2.5 py-1 rounded transition-colors ${
              executionMode === 'LIVE'
                ? 'bg-rose-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Live
          </button>
        </div>

        {/* Account Balance & Equity */}
        <div className="hidden lg:flex items-center gap-3 text-xs font-mono border-l border-[#1e293b] pl-3">
          <div className="flex flex-col">
            <span className="text-[10px] text-slate-400 font-sans">Balance</span>
            <span className="text-slate-200 font-medium tabular-nums">
              ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="flex flex-col">
            <span className="text-[10px] text-slate-400 font-sans">Equity</span>
            <span
              className={`font-semibold tabular-nums ${
                equity >= balance ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              ${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {/* Connection Indicator */}
        <div
          onClick={onOpenHyperliquidSettings}
          className="hidden xl:flex items-center gap-1.5 px-2 py-1 rounded bg-[#111927] border border-[#1e293b] cursor-pointer hover:border-slate-600 text-xs font-mono"
          title="Hyperliquid market data connection state"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              connectionState.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
            }`}
          />
          <span className="text-slate-300 text-[11px]">
            {connectionState.isConnected ? `Hyperliquid (${connectionState.pingMs}ms)` : 'Offline'}
          </span>
        </div>
      </div>

      {/* ZONE 3: Panel Visibility Toggles & Primary Actions */}
      <div className="flex items-center gap-2">
        {/* Panel Viewport Toggles */}
        <div className="flex items-center bg-[#111927] p-0.5 rounded border border-[#1e293b] text-xs">
          {onToggleChartFullscreen && (
            <button
              onClick={onToggleChartFullscreen}
              className={`px-2 py-1 rounded text-xs transition-colors flex items-center gap-1 font-medium ${
                isChartFullscreen
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-300 hover:text-white hover:bg-[#1e293b]'
              }`}
              title={isChartFullscreen ? 'Exit Fullscreen Chart' : 'Toggle Fullscreen Chart'}
            >
              {isChartFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              <span className="hidden xl:inline">{isChartFullscreen ? 'Exit Fullscreen' : 'Fullscreen Chart'}</span>
            </button>
          )}

          {onToggleEditor && !isChartFullscreen && (
            <button
              onClick={onToggleEditor}
              className={`p-1.5 rounded text-xs transition-colors ${
                showEditor
                  ? 'text-sky-400 bg-[#1e293b]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={showEditor ? 'Hide Code Editor' : 'Show Code Editor'}
            >
              <Code2 className="w-3.5 h-3.5" />
            </button>
          )}

          {onToggleBottomPanel && !isChartFullscreen && (
            <button
              onClick={onToggleBottomPanel}
              className={`p-1.5 rounded text-xs transition-colors ${
                showBottomPanel
                  ? 'text-sky-400 bg-[#1e293b]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={showBottomPanel ? 'Hide Terminal / Bottom Panel' : 'Show Terminal / Bottom Panel'}
            >
              <Terminal className="w-3.5 h-3.5" />
            </button>
          )}

          {onToggleAIPanel && (
            <button
              onClick={onToggleAIPanel}
              className={`p-1.5 rounded text-xs transition-colors ${
                showAIPanel
                  ? 'text-sky-400 bg-[#1e293b]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={showAIPanel ? 'Hide AI Panel' : 'Show AI Panel'}
            >
              <PanelRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Emergency Kill Switch */}
        <button
          onClick={onOpenKillSwitchModal}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
            isKillSwitchActive
              ? 'bg-rose-600 text-white animate-pulse'
              : 'bg-rose-950/60 text-rose-300 hover:bg-rose-900 border border-rose-800/40'
          }`}
          title="Emergency Trading Halt / Kill Switch"
        >
          <AlertOctagon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">
            {isKillSwitchActive ? 'HALTED' : 'KILL SWITCH'}
          </span>
        </button>

        {/* Hyperliquid Settings */}
        <button
          onClick={onOpenHyperliquidSettings}
          className="p-1.5 rounded bg-[#131c2e] hover:bg-[#1e293b] text-slate-300 hover:text-white border border-[#1e293b] transition-colors"
          title="Hyperliquid Settings"
        >
          <Server className="w-4 h-4 text-slate-400" />
        </button>

        {/* OpenRouter AI Settings */}
        <button
          onClick={onOpenAISettings}
          className="p-1.5 rounded bg-[#131c2e] hover:bg-[#1e293b] text-sky-400 hover:text-sky-300 border border-[#1e293b] transition-colors"
          title="AI Provider Settings (OpenRouter BYO Key)"
        >
          <Sparkles className="w-4 h-4 text-sky-400" />
        </button>
      </div>
    </header>
  );
};
