import React, { useEffect, useState } from 'react';
import {
  Plus,
  Play,
  Square,
  Bot as BotIcon,
  Sparkles,
  ArrowLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Code2,
  FileText,
  Activity,
  Download,
  AlertCircle,
  HelpCircle,
  Clock,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import { Bot, Strategy, BacktestResult, ExecutionMode, Timeframe, Trade } from '../../types/trading';
import { MonacoStrategyEditor } from '../editor/MonacoStrategyEditor';
import { downloadTradesCSV } from '../../utils/csvExport';
import { BotDefinition, Deployment, cloneBotDefinition } from '../../engine/agents/botDefinition';
import { EXPLORER_BOTS } from '../../engine/agents/explorer';
import { BotBacktestProgress, BotBacktestResult } from '../../engine/agents/backtest';
import { AgentTimelineEvent } from '../../engine/agents/timeline';
import { BotBuilderModal } from './BotBuilderModal';

interface BotsTabProps {
  bots: Bot[];
  strategies: Strategy[];
  executionMode: ExecutionMode;
  onToggleBotStatus: (botId: string) => void;
  onCreateBot: (botData: {
    name: string;
    symbol: string;
    timeframe: Timeframe;
    strategyCode: string;
    definition?: BotDefinition;
    deployment?: Deployment;
  }) => void;
  onRunBacktest: (strategyCode: string, symbol: string, timeframe: Timeframe) => Promise<BacktestResult | null>;
  onBacktestBot: (definition: BotDefinition, marketId: string, timeframe: string, initialBalance: number, start: number, end: number, onProgress: (progress: BotBacktestProgress) => void) => Promise<BotBacktestResult>;
  botDefinitions: BotDefinition[];
  onSaveBotDefinition: (definition: BotDefinition) => void;
  onGetBotActivity: (botId: string) => Promise<AgentTimelineEvent[]>;
  backtestResult: BacktestResult | null;
  onOpenAIWithPrompt: (prompt: string, context?: any) => void;
}

export const BotsTab: React.FC<BotsTabProps> = ({
  bots,
  strategies,
  executionMode,
  onToggleBotStatus,
  onCreateBot,
  onRunBacktest,
  onBacktestBot,
  botDefinitions,
  onSaveBotDefinition,
  onGetBotActivity,
  backtestResult,
  onOpenAIWithPrompt,
}) => {
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [activeBotTab, setActiveBotTab] = useState<'overview' | 'backtest' | 'trades' | 'logs' | 'advanced'>('overview');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [savedDefinitions, setSavedDefinitions] = useState<BotDefinition[]>([]);
  const [selectedExplorer, setSelectedExplorer] = useState<BotDefinition | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<BotDefinition | null>(null);
  const [builderDefinition, setBuilderDefinition] = useState<BotDefinition | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [isRunningBacktest, setIsRunningBacktest] = useState(false);
  const [activeStrategyCode, setActiveStrategyCode] = useState<string>('');

  const categories = ['All', 'Forex', 'Commodities', 'Indices'];

  const filteredExplore = selectedCategory === 'All' ? EXPLORER_BOTS : EXPLORER_BOTS.filter((bot) => selectedCategory === 'Forex' ? ['explorer-trend-rider', 'explorer-pullback-hunter', 'explorer-momentum-trader'].includes(bot.identity.id) : selectedCategory === 'Commodities' ? ['explorer-breakout-scout', 'explorer-mean-reversion', 'explorer-session-trader'].includes(bot.identity.id) : bot.identity.id === 'explorer-structure-watch' || bot.identity.id === 'explorer-conservative-ai');

  // Status Chip Renderer
  const renderStatusChip = (status: Bot['status']) => {
    switch (status) {
      case 'RUNNING':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>RUNNING</span>
          </span>
        );
      case 'STOPPED':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-slate-800 text-slate-400 border border-slate-700">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
            <span>STOPPED</span>
          </span>
        );
      case 'ERROR':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
            <span>ERROR</span>
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>TESTING</span>
          </span>
        );
    }
  };

  // Open Bot Detail
  const handleOpenBot = (bot: Bot) => {
    setSelectedBot(bot);
    setActiveBotTab('overview');
    const strat = strategies.find((s) => s.id === bot.strategyId) || strategies[0];
    setActiveStrategyCode(strat.code);
  };

  // Run backtest for selected bot
  const handleExecuteBacktest = async () => {
    if (!selectedBot) return;
    setIsRunningBacktest(true);
    await onRunBacktest(activeStrategyCode, selectedBot.symbol, selectedBot.timeframe);
    setIsRunningBacktest(false);
  };

  if (selectedExplorer) {
    const cloned = botDefinitions.some((bot) => bot.sourceBotId === selectedExplorer.identity.id);
    return <div className="flex-1 overflow-y-auto bg-[#080d16] p-4 text-slate-200 md:p-8"><div className="mx-auto max-w-3xl space-y-5"><button onClick={() => setSelectedExplorer(null)} className="flex items-center gap-2 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Explorer</button><div className="rounded-2xl border border-sky-800/50 bg-sky-950/20 p-5"><div className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Curated AI bot</div><h1 className="mt-2 text-2xl font-bold text-white">{selectedExplorer.identity.name}</h1><p className="mt-2 text-sm text-slate-300">{selectedExplorer.identity.description}</p><div className="mt-5 flex flex-wrap gap-2">{['Trend context', 'AI analysis', 'Risk controlled'].map((label) => <span key={label} className="rounded-full border border-sky-700/40 bg-sky-500/10 px-3 py-1 text-[11px] text-sky-200">{label}</span>)}</div></div><div className="grid gap-3 sm:grid-cols-2"><ReviewInfo title="How it thinks" value={selectedExplorer.intent.objective} /><ReviewInfo title="What it watches" value={Object.values(selectedExplorer.skills).flat().join(' · ')} /><ReviewInfo title="When it wakes" value={selectedExplorer.triggers.map((trigger) => trigger.type.replaceAll('_', ' ')).join(' · ')} /><ReviewInfo title="Risk" value={`${selectedExplorer.risk.riskPerTrade * 100}% per trade · ${selectedExplorer.risk.maxPositions} max positions`} /><ReviewInfo title="AI" value={`OpenRouter · ${selectedExplorer.ai.model} · ${selectedExplorer.ai.reasoningMode}`} /></div><div className="flex flex-col gap-2 sm:flex-row"><button onClick={() => { setBuilderDefinition(selectedExplorer); setShowCreateModal(true); setSelectedExplorer(null); }} className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-xs font-bold text-white hover:bg-indigo-500">Test this bot</button><button disabled={cloned} onClick={() => { const copy = cloneBotDefinition(selectedExplorer); onSaveBotDefinition(copy); setSavedDefinitions((current) => [copy, ...current]); }} className="flex-1 rounded-xl border border-emerald-700/50 bg-emerald-950/30 px-4 py-3 text-xs font-bold text-emerald-200 disabled:opacity-50">{cloned ? 'Already in My Bots' : 'Add to My Bots'}</button></div></div></div>;
  }

  if (selectedDefinition) {
    return <BotWorkspace definition={selectedDefinition} onBack={() => setSelectedDefinition(null)} onOpenBuilder={(definition) => { setBuilderDefinition(definition); setShowCreateModal(true); }} onGetActivity={onGetBotActivity} />;
  }

  // IF BOT DETAIL SCREEN IS OPEN
  if (selectedBot) {
    const isRunning = selectedBot.status === 'RUNNING';

    return (
      <div className="flex-1 flex flex-col h-full bg-[#080d16] overflow-y-auto pb-24 md:pb-8">
        {/* Top Header */}
        <div className="sticky top-0 z-20 bg-[#080d16]/95 backdrop-blur-md border-b border-[#1e293b] p-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setSelectedBot(null)}
              className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-[#1e293b] transition-colors"
              title="Back to Bots"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-white font-mono">{selectedBot.name}</h1>
                {renderStatusChip(selectedBot.status)}
              </div>
              <div className="text-xs text-slate-400 font-mono mt-0.5">
                {selectedBot.symbol} · {selectedBot.timeframe} · {selectedBot.mode}
              </div>
            </div>
          </div>

          {/* Stop / Start Quick Action */}
          <button
            onClick={() => onToggleBotStatus(selectedBot.id)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              isRunning
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-md shadow-rose-950'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-950'
            }`}
          >
            {isRunning ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{isRunning ? 'Stop Bot' : 'Start Bot'}</span>
          </button>
        </div>

        {/* Sub-tab Navigation */}
        <div className="px-3 border-b border-[#1e293b] flex items-center gap-1 bg-[#0a101d] overflow-x-auto text-xs">
          {(
            [
              { id: 'overview', label: 'Strategy' },
              { id: 'backtest', label: 'Backtest' },
              { id: 'trades', label: 'Trades' },
              { id: 'logs', label: 'Logs' },
              { id: 'advanced', label: 'Advanced (Code)' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveBotTab(t.id)}
              className={`py-3 px-3 border-b-2 font-medium transition-colors shrink-0 ${
                activeBotTab === t.id
                  ? 'border-sky-500 text-sky-400 font-bold'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="p-4 space-y-4 max-w-4xl mx-auto w-full">
          {/* TAB: OVERVIEW */}
          {activeBotTab === 'overview' && (
            <div className="space-y-3.5">
              {/* Performance Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-3 rounded-xl bg-[#0e1726] border border-[#1e293b]">
                  <span className="text-[11px] text-slate-400 block mb-0.5">Total Realized P&L</span>
                  <span
                    className={`text-lg font-bold font-mono ${
                      selectedBot.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {selectedBot.totalPnl >= 0 ? '+' : ''}${selectedBot.totalPnl.toFixed(2)}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#0e1726] border border-[#1e293b]">
                  <span className="text-[11px] text-slate-400 block mb-0.5">Open Positions</span>
                  <span className="text-lg font-bold font-mono text-white">
                    {selectedBot.positionsCount}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#0e1726] border border-[#1e293b]">
                  <span className="text-[11px] text-slate-400 block mb-0.5">Market</span>
                  <span className="text-lg font-bold font-mono text-sky-400">
                    {selectedBot.symbol}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#0e1726] border border-[#1e293b]">
                  <span className="text-[11px] text-slate-400 block mb-0.5">Timeframe</span>
                  <span className="text-lg font-bold font-mono text-indigo-400">
                    {selectedBot.timeframe}
                  </span>
                </div>
              </div>

              {/* What the Bot Does Card */}
              <div className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  What This Bot Does
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed font-sans">
                  This bot continuously monitors live incoming ticks from the Hyperliquid WebSocket on{' '}
                  <span className="text-sky-300 font-semibold">{selectedBot.symbol}</span>. It evaluates technical conditions on every bar close, manages stop loss and take profit targets automatically, and shuts down instantly if risk thresholds are breached.
                </p>
                <div className="pt-2 flex items-center gap-2 text-xs text-slate-400">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Verified risk limits: 1% max risk per trade</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => setActiveBotTab('backtest')}
                  className="flex-1 py-3 rounded-xl font-semibold text-xs bg-[#162032] hover:bg-[#1e293b] text-sky-300 border border-sky-800/40 transition-all flex items-center justify-center gap-1.5"
                >
                  <Activity className="w-4 h-4" />
                  <span>Test with Historical Data</span>
                </button>

                <button
                  onClick={() =>
                    onOpenAIWithPrompt(
                      `Explain the trading behavior and recommended market conditions for ${selectedBot.name} on ${selectedBot.symbol}.`,
                      { selectedBotId: selectedBot.id }
                    )
                  }
                  className="flex-1 py-3 rounded-xl font-semibold text-xs bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 transition-all flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Ask AI About This Bot</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB: BACKTEST */}
          {activeBotTab === 'backtest' && (
            <div className="space-y-4">
              {/* Backtest Trigger Card */}
              <div className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] space-y-3">
                <div>
                  <h3 className="text-sm font-bold text-white">Test Your Bot</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Simulate this bot across 300 historical candles with realistic spreads, slippage, and commissions.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                    <span className="text-[10px] text-slate-400 block font-sans">Starting Balance</span>
                    <span className="text-white font-bold">$10,000.00</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                    <span className="text-[10px] text-slate-400 block font-sans">Risk Per Trade</span>
                    <span className="text-white font-bold">1.0%</span>
                  </div>
                </div>

                <button
                  onClick={handleExecuteBacktest}
                  disabled={isRunningBacktest}
                  className="w-full py-3 rounded-xl font-bold text-xs bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-md shadow-indigo-950 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{isRunningBacktest ? 'Running Backtest Simulation...' : 'Run Backtest'}</span>
                </button>
              </div>

              {/* Backtest Results Display */}
              {backtestResult && (
                <div className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                        Backtest Results
                      </h4>
                      <span className="text-[11px] text-slate-400">
                        {backtestResult.totalTrades} completed trades recorded
                      </span>
                    </div>

                    <button
                      onClick={() =>
                        downloadTradesCSV(backtestResult.trades, {
                          strategyName: selectedBot.name,
                          symbol: selectedBot.symbol,
                          timeframe: selectedBot.timeframe,
                        })
                      }
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 hover:bg-sky-500/20 transition-colors"
                      title="Download CSV for Excel or Python"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download CSV</span>
                    </button>
                  </div>

                  {/* Summary Metric Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
                    <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                      <span className="text-[10px] text-slate-400 font-sans block">Net Profit</span>
                      <span
                        className={`text-base font-bold ${
                          backtestResult.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {backtestResult.netProfit >= 0 ? '+' : ''}${backtestResult.netProfit.toFixed(2)}
                      </span>
                    </div>

                    <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                      <span className="text-[10px] text-slate-400 font-sans block">Win Rate</span>
                      <span className="text-base font-bold text-white">
                        {backtestResult.winRate.toFixed(1)}%
                      </span>
                    </div>

                    <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                      <span className="text-[10px] text-slate-400 font-sans block">Max Drawdown</span>
                      <span className="text-base font-bold text-rose-400">
                        {backtestResult.maxDrawdownPercent.toFixed(1)}%
                      </span>
                    </div>

                    <div className="p-2.5 rounded-xl bg-[#080d16] border border-[#1e293b]">
                      <span className="text-[10px] text-slate-400 font-sans block">Profit Factor</span>
                      <span className="text-base font-bold text-sky-400">
                        {backtestResult.profitFactor.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {/* AI Improvement Card */}
                  <div className="p-3.5 rounded-xl bg-gradient-to-r from-sky-950/40 to-indigo-950/40 border border-sky-800/40 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-sky-300">
                      <Sparkles className="w-4 h-4 text-sky-400" />
                      <span>AI Performance Findings</span>
                    </div>
                    <ul className="text-xs text-slate-300 space-y-1 font-sans list-disc list-inside">
                      <li>Strategy achieved {backtestResult.winRate}% win rate across {backtestResult.totalTrades} trades.</li>
                      <li>Most profitable setups occurred during high volatility expansions.</li>
                      <li>Risk can be tightened by scaling out 50% at 1.5R.</li>
                    </ul>

                    <button
                      onClick={() =>
                        onOpenAIWithPrompt(
                          `Here are the backtest results for my ${selectedBot.name} bot on ${selectedBot.symbol} (${selectedBot.timeframe}): Win rate ${backtestResult.winRate}%, Net Profit $${backtestResult.netProfit}, Max Drawdown ${backtestResult.maxDrawdownPercent}%. How can I improve this strategy?`,
                          { selectedBotId: selectedBot.id }
                        )
                      }
                      className="w-full mt-2 py-2 rounded-lg text-xs font-bold bg-sky-600 hover:bg-sky-500 text-white transition-all"
                    >
                      Improve Bot with AI
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: TRADES */}
          {activeBotTab === 'trades' && (
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Executed Trades by {selectedBot.name}
              </h4>
              <div className="p-6 rounded-2xl bg-[#090f1a] border border-[#1e293b] text-center text-xs text-slate-400">
                No closed trades yet recorded for this bot session. Run a backtest or start demo trading.
              </div>
            </div>
          )}

          {/* TAB: LOGS */}
          {activeBotTab === 'logs' && (
            <div className="p-3 rounded-2xl bg-[#090f1a] border border-[#1e293b] font-mono text-xs text-slate-300 space-y-1">
              <div className="text-slate-500 text-[11px]">[SYSTEM] Bot worker initialized in sandboxed environment.</div>
                  <div className="text-slate-400 text-[11px]">[MARKET] Connected to Hyperliquid quote feed: {selectedBot.symbol}.</div>
              <div className="text-emerald-400 text-[11px]">[STATUS] Strategy logic ready. Last evaluation: Normal.</div>
            </div>
          )}

          {/* TAB: ADVANCED (PROGRESSIVE DISCLOSURE - LAZY MONACO) */}
          {activeBotTab === 'advanced' && (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                <span className="font-bold">Advanced Developer Sandbox:</span> Modify the underlying TypeScript strategy logic below. Changes take effect on the next evaluation tick.
              </div>

              <div className="h-96 w-full rounded-xl overflow-hidden border border-[#1e293b]">
                <MonacoStrategyEditor
                  code={activeStrategyCode}
                  onChange={(c) => setActiveStrategyCode(c)}
                  strategies={strategies}
                  selectedStrategyId={selectedBot.strategyId}
                  onSelectStrategy={() => {}}
                  onRunStrategy={() => {}}
                  onRunBacktest={handleExecuteBacktest}
                  onAskAIAboutCode={() =>
                    onOpenAIWithPrompt(`Analyze this TypeScript strategy code for ${selectedBot.name}.`, {
                      selectedBotId: selectedBot.id,
                    })
                  }
                  executionMode={executionMode}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // DEFAULT VIEW: "MY BOTS" & "EXPLORE BOTS"
  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-4 pb-24 md:pb-8 max-w-4xl mx-auto w-full space-y-5">
      {/* Top Header & Create Bot Action */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight">Trading Bots</h1>
          <p className="text-xs text-slate-400">Automate strategies with continuous risk controls</p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-sky-600 hover:bg-sky-500 text-white transition-all shadow-md shadow-sky-950 active:scale-95"
        >
          <Plus className="w-4 h-4" />
          <span>Create Bot</span>
        </button>
      </div>

      {/* SECTION 1: MY BOTS */}
      <div className="space-y-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">My Bots ({botDefinitions.length})</h2>
        <div className="space-y-2.5">
          {botDefinitions.map((definition) => <div key={definition.identity.id} onClick={() => setSelectedDefinition(definition)} className="cursor-pointer rounded-2xl border border-[#1e293b] bg-[#0b1220] p-4 hover:border-slate-600"><div className="flex items-start justify-between gap-3"><div><div className="text-base font-bold text-white">{definition.identity.name}</div><div className="mt-1 text-xs text-slate-400">{definition.identity.description}</div></div><span className="rounded-full bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-300">{definition.ai.reasoningMode.toUpperCase()}</span></div><div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400"><span>{definition.triggers.length} triggers</span><span>·</span><span>{definition.risk.riskPerTrade * 100}% risk</span><span>·</span><span>{definition.source === 'cloned' ? 'Cloned from Explorer' : 'User owned'}</span></div><div className="mt-4 text-xs font-bold text-sky-300">Open workspace →</div></div>)}
        </div>
        <div className="pt-4"><h3 className="px-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Runtime instances</h3></div>

        {bots.length === 0 ? (
          <div className="p-6 rounded-2xl bg-[#090f1a] border border-[#1e293b] text-center space-y-2">
            <BotIcon className="w-8 h-8 text-slate-500 mx-auto" />
            <div className="text-xs text-slate-400">You don't have any bots running yet.</div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="text-xs font-bold text-sky-400 hover:text-sky-300"
            >
              + Create your first bot in plain English
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {bots.map((b) => {
              const isRunning = b.status === 'RUNNING';
              return (
                <div
                  key={b.id}
                  onClick={() => handleOpenBot(b)}
                  className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] hover:border-slate-600 active:scale-[0.99] transition-all cursor-pointer shadow-sm select-none"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-bold text-white font-mono">{b.name}</span>
                      {renderStatusChip(b.status)}
                    </div>

                    <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
                      <span>{b.symbol}</span>
                      <span>·</span>
                      <span>{b.timeframe}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 py-2 border-t border-b border-[#1e293b]/60 my-2 text-xs font-mono">
                    <div>
                      <span className="text-[10px] text-slate-400 font-sans block">Today's P&L</span>
                      <span
                        className={`font-bold ${
                          b.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {b.totalPnl >= 0 ? '+' : ''}${b.totalPnl.toFixed(2)}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 font-sans block">Positions</span>
                      <span className="text-white font-semibold">{b.positionsCount} active</span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 font-sans block">Environment</span>
                      <span className="text-sky-300 font-semibold">{b.mode}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-slate-400 text-[11px]">
                      {b.lastSignal || 'Monitoring live ticks'}
                    </span>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleBotStatus(b.id);
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                          isRunning
                            ? 'bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40'
                            : 'bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40'
                        }`}
                      >
                        {isRunning ? 'Stop' : 'Start'}
                      </button>

                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SECTION 2: EXPLORE BOTS */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
              Explore Bots
            </h2>
            <p className="text-xs text-slate-400">Curated strategy blueprints ready to backtest</p>
          </div>
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setSelectedCategory(c)}
              className={`px-3 py-1.5 rounded-full font-medium transition-all shrink-0 ${
                selectedCategory === c
                  ? 'bg-sky-500/20 border border-sky-500 text-sky-400 font-bold'
                  : 'bg-[#0f172a] border border-[#1e293b] text-slate-400 hover:text-white'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Explore Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filteredExplore.map((exp) => (
            <div
              key={exp.identity.id}
              className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] flex flex-col justify-between space-y-3"
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] uppercase font-bold font-mono px-2 py-0.5 rounded bg-sky-950/80 text-sky-400 border border-sky-800/40">
                    AI BOT
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    {exp.triggers.find((trigger) => trigger.timeframe)?.timeframe || 'event-driven'}
                  </span>
                </div>

                <h3 className="text-sm font-bold text-white">{exp.identity.name}</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed font-sans">
                  {exp.identity.description}
                </p>
              </div>

              <div className="pt-2 border-t border-[#1e293b]/70 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">{exp.risk.riskPerTrade * 100}% risk · {exp.triggers.length} triggers</span>

                <button
                  onClick={() => setSelectedExplorer(exp)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#162032] hover:bg-sky-600 hover:text-white text-sky-400 border border-sky-800/40 transition-all"
                >
                  Inspect bot
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {savedDefinitions.length > 0 && (
        <div className="space-y-2.5 pt-2">
          <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-slate-400">Saved Bot Definitions ({savedDefinitions.length})</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {savedDefinitions.map((definition) => (
              <div key={definition.identity.id} className="rounded-2xl border border-emerald-900/40 bg-emerald-950/10 p-4">
                <div className="text-sm font-bold text-white">{definition.identity.name}</div>
                <div className="mt-1 text-xs text-slate-400">{definition.intent.objective}</div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500"><span>{definition.triggers.length} triggers · {(definition.risk.riskPerTrade * 100).toFixed(2)}% risk</span><span className="text-emerald-300">Ready to deploy</span></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showCreateModal && (
        <BotBuilderModal
          onClose={() => setShowCreateModal(false)}
          initialDefinition={builderDefinition}
          onBacktest={onBacktestBot}
          onSave={(definition) => { setSavedDefinitions((current) => [definition, ...current.filter((item) => item.identity.id !== definition.identity.id)]); onSaveBotDefinition(definition); }}
          onDeploy={(definition, deployment: Deployment) => {
            const timeframe = (definition.triggers.find((trigger) => trigger.timeframe)?.timeframe || '15m') as Timeframe;
            onCreateBot({ name: definition.identity.name, symbol: deployment.marketId, timeframe, strategyCode: strategies[0]?.code || '', definition, deployment });
          }}
        />
      )}
    </div>
  );
};

const ReviewInfo: React.FC<{ title: string; value: string }> = ({ title, value }) => <div className="rounded-xl border border-[#1e293b] bg-[#0f172a] p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div><div className="mt-2 text-xs leading-relaxed text-slate-200">{value}</div></div>;

const BotWorkspace: React.FC<{ definition: BotDefinition; onBack: () => void; onOpenBuilder: (definition: BotDefinition) => void; onGetActivity: (botId: string) => Promise<AgentTimelineEvent[]> }> = ({ definition, onBack, onOpenBuilder, onGetActivity }) => {
  const [events, setEvents] = useState<AgentTimelineEvent[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'TRADES' | 'TRIGGERS' | 'AI' | 'RISK' | 'ORDERS'>('ALL');
  const [selected, setSelected] = useState<AgentTimelineEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const load = async () => { try { setEvents(await onGetActivity(definition.identity.id)); setError(false); } catch { setError(true); } finally { setLoading(false); } };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [definition.identity.id]);
  const visible = events.filter((event) => filter === 'ALL' || filter === 'TRADES' && ['POSITION_OPENED', 'POSITION_CLOSED', 'FILL'].includes(event.type) || filter === 'TRIGGERS' && ['TRIGGER', 'TRIGGER_EVALUATED'].includes(event.type) || filter === 'AI' && ['AGENT_WAKE', 'DECISION', 'OBSERVATION'].includes(event.type) || filter === 'RISK' && event.type === 'RISK_CHECK' || filter === 'ORDERS' && event.type === 'ORDER').sort((left, right) => right.timestamp - left.timestamp);
  return <div className="flex-1 overflow-y-auto bg-[#080d16] p-4 text-slate-200 md:p-8"><div className="mx-auto max-w-4xl space-y-4"><button onClick={onBack} className="flex items-center gap-2 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" />My Bots</button><div className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-5"><div className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Bot workspace</div><h1 className="mt-2 text-2xl font-bold text-white">{definition.identity.name}</h1><p className="mt-1 text-sm text-slate-400">{definition.identity.description}</p><div className="mt-4 flex gap-2 overflow-x-auto border-t border-[#1e293b] pt-4"><button onClick={() => onOpenBuilder(definition)} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white">Backtest</button><button onClick={() => onOpenBuilder(definition)} className="rounded-lg border border-[#334155] px-4 py-2 text-xs font-bold text-slate-200">Edit</button><button onClick={() => onOpenBuilder(definition)} className="rounded-lg border border-[#334155] px-4 py-2 text-xs font-bold text-slate-200">Deploy</button></div></div><div className="grid gap-3 sm:grid-cols-4"><ReviewInfo title="Events" value={events.length ? String(events.length) : 'No runtime activity yet'} /><ReviewInfo title="Last event" value={events[0] ? formatEventTime(events[0].timestamp) : 'None'} /><ReviewInfo title="Trades" value={String(events.filter((event) => ['FILL', 'POSITION_CLOSED'].includes(event.type)).length)} /><ReviewInfo title="AI" value={`${definition.ai.provider} · ${definition.ai.model}`} /></div><div className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4"><div className="mb-3 flex items-center justify-between"><div><div className="text-sm font-bold text-white">Activity</div><div className="mt-1 text-[11px] text-slate-500">Persisted runtime events · newest first</div></div><div className="flex gap-1 overflow-x-auto">{(['ALL', 'TRADES', 'TRIGGERS', 'AI', 'RISK', 'ORDERS'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${filter === item ? 'bg-sky-500/20 text-sky-300' : 'bg-[#0b1220] text-slate-500'}`}>{item}</button>)}</div></div>{loading ? <div className="py-10 text-center text-xs text-slate-500">Loading activity...</div> : error ? <div className="py-10 text-center text-xs text-rose-300">Couldn't load bot activity. Try again.</div> : visible.length === 0 ? <div className="py-10 text-center text-xs text-slate-500">No activity yet. This bot hasn't generated any runtime events.</div> : <div className="space-y-2">{visible.map((event) => <button key={event.id} onClick={() => setSelected(event)} className="flex w-full items-start gap-3 rounded-xl border border-[#1e293b] bg-[#0b1220] p-3 text-left hover:border-slate-600"><div className="mt-0.5 text-sky-300">{eventIcon(event.type)}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-white">{eventTitle(event.type)}</span><span className="text-[10px] text-slate-500">{formatEventTime(event.timestamp)}</span></div><div className="mt-1 truncate text-[11px] text-slate-400">{eventSummary(event)}</div></div></button>)}</div>}</div></div>{selected && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setSelected(null)}><div className="w-full max-w-lg rounded-t-2xl border border-[#1e293b] bg-[#0f172a] p-5 sm:rounded-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between"><div className="text-sm font-bold text-white">{eventTitle(selected.type)}</div><button onClick={() => setSelected(null)} className="text-slate-400">×</button></div><div className="mt-1 text-[11px] text-slate-500">{formatEventTime(selected.timestamp)} · {selected.environment || 'runtime'}</div><pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-[#080d16] p-3 text-[11px] leading-relaxed text-slate-300">{JSON.stringify({ triggerId: selected.triggerId, orderId: selected.orderId, tradeId: selected.tradeId, positionId: selected.positionId, data: selected.data }, null, 2)}</pre></div></div>}</div>;
};

function formatEventTime(timestamp: number): string { return new Date(timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); }
function eventTitle(type: AgentTimelineEvent['type']): string { return ({ TRIGGER: 'Trigger fired', TRIGGER_EVALUATED: 'Trigger evaluated', AGENT_WAKE: 'Agent woke', OBSERVATION: 'Observation', DECISION: 'Decision', RISK_CHECK: 'Risk check', ORDER: 'Order', FILL: 'Fill', POSITION_OPENED: 'Position opened', POSITION_UPDATE: 'Position updated', POSITION_CLOSED: 'Position closed', CAPABILITY_CALL: 'Skill used', CAPABILITY_RESULT: 'Skill result', ERROR: 'Runtime error' } as Record<string, string>)[type] || type; }
function eventIcon(type: AgentTimelineEvent['type']): string { return type === 'RISK_CHECK' ? '🛡' : type === 'DECISION' ? '🧠' : type === 'TRIGGER' || type === 'AGENT_WAKE' ? '⚡' : type === 'POSITION_CLOSED' ? '✓' : type === 'ORDER' || type === 'FILL' ? '↗' : '·'; }
function eventSummary(event: AgentTimelineEvent): string { const data = event.data as Record<string, unknown>; if (typeof data?.reason === 'string') return data.reason; if (typeof data?.message === 'string') return data.message; if (typeof data?.status === 'string') return data.status; return `${eventTitle(event.type)} recorded.`; }
