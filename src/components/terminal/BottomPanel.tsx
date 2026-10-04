import React, { useState } from 'react';
import {
  Terminal as TerminalIcon,
  BarChart3,
  ListOrdered,
  Layers,
  AlertOctagon,
  Trash2,
  TrendingUp,
  TrendingDown,
  X,
  ChevronDown,
  ChevronUp,
  Download,
  Check,
} from 'lucide-react';
import { BacktestResult, LogEntry, Position, Trade } from '../../types/trading';
import { downloadTradesCSV } from '../../utils/csvExport';

interface BottomPanelProps {
  logs: LogEntry[];
  onClearLogs: () => void;
  backtestResult: BacktestResult | null;
  positions: Position[];
  onClosePosition: (posId: string) => void;
  trades: Trade[];
  activeTab: 'terminal' | 'backtest' | 'trades' | 'positions' | 'errors';
  onTabChange: (tab: 'terminal' | 'backtest' | 'trades' | 'positions' | 'errors') => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const BottomPanel: React.FC<BottomPanelProps> = ({
  logs,
  onClearLogs,
  backtestResult,
  positions,
  onClosePosition,
  trades,
  activeTab,
  onTabChange,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const [logFilter, setLogFilter] = useState<'all' | 'trade' | 'risk' | 'error'>('all');
  const [exportSuccess, setExportSuccess] = useState(false);

  const handleExportBacktestCSV = () => {
    if (!backtestResult || !backtestResult.trades || backtestResult.trades.length === 0) {
      return;
    }
    const success = downloadTradesCSV(backtestResult.trades, {
      strategyName: backtestResult.strategyName,
      symbol: backtestResult.symbol,
      timeframe: backtestResult.timeframe,
      initialBalance: backtestResult.initialBalance,
      finalEquity: backtestResult.finalEquity,
      netProfit: backtestResult.netProfit,
    });
    if (success) {
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 2500);
    }
  };

  const handleExportTradesCSV = () => {
    const list = trades.length > 0 ? trades : (backtestResult?.trades || []);
    if (list.length === 0) return;
    const success = downloadTradesCSV(list, {
      strategyName: backtestResult?.strategyName || 'Live Strategy',
      symbol: list[0]?.symbol || backtestResult?.symbol,
      timeframe: backtestResult?.timeframe,
    });
    if (success) {
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 2500);
    }
  };

  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'all') return true;
    return l.level === logFilter;
  });

  const errorLogs = logs.filter((l) => l.level === 'error' || l.level === 'risk');

  return (
    <div className="flex flex-col h-full w-full bg-surface-2 border-t border-line/70 select-none">
      {/* Tab Navigation Header */}
      <div className="flex items-center justify-between px-3 py-1 bg-surface border-b border-line/70 text-xs">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onTabChange('terminal')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
              activeTab === 'terminal'
                ? 'bg-line-strong text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            <span>Terminal</span>
            {logs.length > 0 && (
              <span className="text-[10px] text-ink-3 font-mono">({logs.length})</span>
            )}
          </button>

          <button
            onClick={() => onTabChange('backtest')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
              activeTab === 'backtest'
                ? 'bg-line-strong text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Backtest</span>
            {backtestResult && (
              <span
                className={`text-[10px] font-mono ${
                  backtestResult.netProfit >= 0 ? 'text-pos' : 'text-neg'
                }`}
              >
                ({backtestResult.netProfit >= 0 ? '+' : ''}${backtestResult.netProfit})
              </span>
            )}
          </button>

          <button
            onClick={() => onTabChange('trades')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
              activeTab === 'trades'
                ? 'bg-line-strong text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <ListOrdered className="w-3.5 h-3.5" />
            <span>Trades</span>
            <span className="text-[10px] text-ink-3 font-mono">
              ({trades.length || backtestResult?.trades.length || 0})
            </span>
          </button>

          <button
            onClick={() => onTabChange('positions')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
              activeTab === 'positions'
                ? 'bg-line-strong text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Positions</span>
            {positions.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-accent/20 text-accent text-[10px] font-mono">
                {positions.length}
              </span>
            )}
          </button>

          <button
            onClick={() => onTabChange('errors')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors ${
              activeTab === 'errors'
                ? 'bg-line-strong text-ink'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <AlertOctagon className="w-3.5 h-3.5 text-neg" />
            <span>Risk & Diagnostics</span>
            {errorLogs.length > 0 && (
              <span className="text-[10px] text-neg font-mono">({errorLogs.length})</span>
            )}
          </button>
        </div>

        {/* Tab Right Controls */}
        <div className="flex items-center gap-2">
          {activeTab === 'backtest' && backtestResult && (
            <button
              onClick={handleExportBacktestCSV}
              disabled={backtestResult.trades.length === 0}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                exportSuccess
                  ? 'bg-pos-soft/80 text-pos border-emerald-700/60'
                  : 'bg-surface-3 hover:bg-accent-strong hover:text-accent-contrast text-accent border-line disabled:opacity-40 disabled:hover:bg-surface-3 disabled:hover:text-accent'
              }`}
              title="Download backtest transaction log as CSV for Excel or Python (pandas)"
            >
              {exportSuccess ? <Check className="w-3.5 h-3.5 text-pos" /> : <Download className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{exportSuccess ? 'Downloaded!' : 'Download CSV'}</span>
            </button>
          )}

          {activeTab === 'trades' && (trades.length > 0 || (backtestResult && backtestResult.trades.length > 0)) && (
            <button
              onClick={handleExportTradesCSV}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                exportSuccess
                  ? 'bg-pos-soft/80 text-pos border-emerald-700/60'
                  : 'bg-surface-3 hover:bg-accent-strong hover:text-accent-contrast text-accent border-line'
              }`}
              title="Download closed transactions log as CSV"
            >
              {exportSuccess ? <Check className="w-3.5 h-3.5 text-pos" /> : <Download className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{exportSuccess ? 'Downloaded!' : 'Download CSV'}</span>
            </button>
          )}

          {activeTab === 'terminal' && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-surface-3 p-0.5 rounded border border-line">
                {(['all', 'trade', 'risk', 'error'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setLogFilter(filter)}
                    className={`px-2 py-0.5 text-[11px] rounded transition-colors uppercase ${
                      logFilter === filter
                        ? 'bg-line-strong text-ink font-medium'
                        : 'text-ink-3 hover:text-ink-2'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              <button
                onClick={onClearLogs}
                className="p-1 rounded text-ink-3 hover:text-ink-2 hover:bg-line-strong transition-colors"
                title="Clear Terminal"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="p-1 rounded text-ink-3 hover:text-ink-2 hover:bg-line-strong transition-colors border border-transparent hover:border-line"
              title={isCollapsed ? 'Expand Bottom Panel' : 'Collapse Bottom Panel'}
            >
              {isCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto p-2 font-mono text-xs text-ink-2 bg-bg-alt">
        {/* TERMINAL VIEW */}
        {activeTab === 'terminal' && (
          <div className="space-y-1">
            {filteredLogs.length === 0 ? (
              <div className="text-ink-4 py-6 text-center italic font-sans text-xs">
                No log output recorded. Click "Run" or "Backtest" to stream execution events.
              </div>
            ) : (
              filteredLogs.map((log) => {
                const timeStr = new Date(log.timestamp).toLocaleTimeString();
                return (
                  <div key={log.id} className="flex items-start gap-2 py-0.5 leading-relaxed">
                    <span className="text-ink-4 text-[11px] shrink-0">[{timeStr}]</span>
                    <span
                      className={`text-[10px] font-semibold uppercase px-1 rounded shrink-0 ${
                        log.level === 'trade'
                          ? 'bg-pos-soft text-pos border border-pos/40'
                          : log.level === 'risk'
                          ? 'bg-warn-soft text-warn border border-warn/40'
                          : log.level === 'error'
                          ? 'bg-neg-soft text-neg border border-neg/40/40'
                          : 'bg-surface-3 text-ink-2'
                      }`}
                    >
                      {log.level}
                    </span>
                    <span
                      className={`break-all ${
                        log.level === 'error'
                          ? 'text-neg'
                          : log.level === 'trade'
                          ? 'text-pos'
                          : log.level === 'risk'
                          ? 'text-warn'
                          : 'text-ink-2'
                      }`}
                    >
                      {log.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* BACKTEST VIEW */}
        {activeTab === 'backtest' && (
          <div>
            {!backtestResult ? (
              <div className="text-ink-4 py-6 text-center italic font-sans text-xs">
                No backtest has been executed yet. Click "Run Backtest" above to simulate this strategy across historical candles.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Backtest Header & CSV Export Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-2 border border-line">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="text-xs font-semibold text-ink flex items-center gap-2">
                        <span>{backtestResult.strategyName || 'Strategy Backtest'}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-soft/80 text-accent border border-accent/40 font-mono font-medium">
                          {backtestResult.symbol} · {backtestResult.timeframe}
                        </span>
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5 font-sans">
                        {backtestResult.totalTrades} closed transactions recorded across historical bars
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="hidden md:inline text-[11px] text-ink-3 font-mono">
                      Format: RFC 4180 (Excel · Python pandas)
                    </span>
                    <button
                      onClick={handleExportBacktestCSV}
                      disabled={backtestResult.trades.length === 0}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all shadow-xs ${
                        exportSuccess
                          ? 'bg-emerald-600 text-ink'
                          : 'bg-accent-strong hover:bg-accent text-ink active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed'
                      }`}
                      title="Download complete transaction log as CSV for analysis in Excel or Python"
                    >
                      {exportSuccess ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                      <span>{exportSuccess ? 'CSV Exported!' : 'Download CSV'}</span>
                    </button>
                  </div>
                </div>

                {/* Metric Summary Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Net P&L</div>
                    <div
                      className={`text-sm font-semibold tabular-nums ${
                        backtestResult.netProfit >= 0 ? 'text-pos' : 'text-neg'
                      }`}
                    >
                      {backtestResult.netProfit >= 0 ? '+' : ''}${backtestResult.netProfit.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      {backtestResult.netProfitPercent >= 0 ? '+' : ''}
                      {backtestResult.netProfitPercent}%
                    </div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Win Rate</div>
                    <div className="text-sm font-semibold text-ink tabular-nums">
                      {backtestResult.winRate}%
                    </div>
                    <div className="text-[10px] text-ink-3">
                      {backtestResult.winningTrades}W / {backtestResult.losingTrades}L
                    </div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Profit Factor</div>
                    <div className="text-sm font-semibold text-ink tabular-nums">
                      {backtestResult.profitFactor}
                    </div>
                    <div className="text-[10px] text-ink-3">Gross W / Gross L</div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Max Drawdown</div>
                    <div className="text-sm font-semibold text-neg tabular-nums">
                      -${backtestResult.maxDrawdown.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      -{backtestResult.maxDrawdownPercent}%
                    </div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Total Trades</div>
                    <div className="text-sm font-semibold text-ink tabular-nums">
                      {backtestResult.totalTrades}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      Avg: ${backtestResult.averageTradeProfit}
                    </div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Sharpe Ratio</div>
                    <div className="text-sm font-semibold text-ink tabular-nums">
                      {backtestResult.sharpeRatio}
                    </div>
                    <div className="text-[10px] text-ink-3">Annualized</div>
                  </div>

                  <div className="bg-surface-2 p-2.5 rounded border border-line">
                    <div className="text-[10px] uppercase text-ink-3 font-sans">Final Equity</div>
                    <div className="text-sm font-semibold text-accent tabular-nums">
                      ${backtestResult.finalEquity.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      Init: ${backtestResult.initialBalance.toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Equity Curve SVG Mini Chart */}
                {backtestResult.equityCurve.length > 1 && (
                  <div className="bg-surface-2 p-3 rounded border border-line">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] uppercase tracking-wider text-ink-3 font-sans font-medium">
                        Equity Curve Evolution ($)
                      </span>
                      <span className="text-[11px] text-ink-3 font-sans">
                        {backtestResult.symbol} · {backtestResult.timeframe} · {backtestResult.equityCurve.length} Bars
                      </span>
                    </div>

                    <div className="h-24 w-full">
                      <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
                        {(() => {
                          const points = backtestResult.equityCurve;
                          const minEq = Math.min(...points.map((p) => p.equity)) * 0.995;
                          const maxEq = Math.max(...points.map((p) => p.equity)) * 1.005;
                          const range = maxEq - minEq || 1;

                          const svgPoints = points
                            .map((p, i) => {
                              const x = (i / (points.length - 1)) * 100;
                              const y = 100 - ((p.equity - minEq) / range) * 100;
                              return `${x},${y}`;
                            })
                            .join(' ');

                          return (
                            <>
                              <polyline
                                fill="none"
                                stroke={backtestResult.netProfit >= 0 ? '#10b981' : '#f43f5e'}
                                strokeWidth="1.8"
                                points={svgPoints}
                              />
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TRADES VIEW */}
        {activeTab === 'trades' && (
          <div className="space-y-2">
            {(() => {
              const displayTrades = trades.length > 0 ? trades : backtestResult?.trades || [];
              if (displayTrades.length === 0) {
                return (
                  <div className="text-ink-4 py-6 text-center italic font-sans text-xs">
                    No closed trades to display yet. Run a backtest or execute a strategy.
                  </div>
                );
              }

              return (
                <>
                  <div className="flex items-center justify-between px-1 py-1">
                    <span className="text-[11px] text-ink-3 font-sans">
                      Showing {displayTrades.length} closed trade transaction{displayTrades.length === 1 ? '' : 's'}
                    </span>
                    <button
                      onClick={handleExportTradesCSV}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-3 hover:bg-accent-strong hover:text-accent-contrast text-accent text-xs font-medium transition-colors border border-line"
                      title="Download transaction log as CSV"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download CSV</span>
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line text-ink-3 font-sans">
                      <th className="py-1 px-2">Exit Time</th>
                      <th className="py-1 px-2">Symbol</th>
                      <th className="py-1 px-2">Side</th>
                      <th className="py-1 px-2">Volume</th>
                      <th className="py-1 px-2">Entry Price</th>
                      <th className="py-1 px-2">Exit Price</th>
                      <th className="py-1 px-2">Net P&L</th>
                      <th className="py-1 px-2">Return</th>
                      <th className="py-1 px-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-line/40">
                    {displayTrades.map((t) => (
                      <tr key={t.id} className="hover:bg-surface-3/60 transition-colors">
                        <td className="py-1 px-2 text-ink-3 text-[11px]">
                          {new Date(t.exitTime * 1000).toLocaleTimeString()}
                        </td>
                        <td className="py-1 px-2 font-semibold text-ink">{t.symbol}</td>
                        <td className="py-1 px-2">
                          <span
                            className={`font-semibold ${
                              t.side === 'BUY' ? 'text-pos' : 'text-neg'
                            }`}
                          >
                            {t.side}
                          </span>
                        </td>
                        <td className="py-1 px-2 tabular-nums text-ink-2">
                          {t.volume.toLocaleString()}
                        </td>
                        <td className="py-1 px-2 tabular-nums text-ink-2">{t.entryPrice}</td>
                        <td className="py-1 px-2 tabular-nums text-ink-2">{t.exitPrice}</td>
                        <td
                          className={`py-1 px-2 tabular-nums font-semibold ${
                            t.pnl >= 0 ? 'text-pos' : 'text-neg'
                          }`}
                        >
                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                        </td>
                        <td
                          className={`py-1 px-2 tabular-nums ${
                            t.returnPercent >= 0 ? 'text-pos' : 'text-neg'
                          }`}
                        >
                          {t.returnPercent >= 0 ? '+' : ''}{t.returnPercent.toFixed(2)}%
                        </td>
                        <td className="py-1 px-2 text-[11px] text-ink-3">
                          {t.exitReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
            })()}
          </div>
        )}

        {/* POSITIONS VIEW */}
        {activeTab === 'positions' && (
          <div className="overflow-x-auto">
            {positions.length === 0 ? (
              <div className="text-ink-4 py-6 text-center italic font-sans text-xs">
                No active open positions currently open.
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-line text-ink-3 font-sans">
                    <th className="py-1 px-2">ID</th>
                    <th className="py-1 px-2">Symbol</th>
                    <th className="py-1 px-2">Side</th>
                    <th className="py-1 px-2">Volume</th>
                    <th className="py-1 px-2">Entry Price</th>
                    <th className="py-1 px-2">Current Price</th>
                    <th className="py-1 px-2">Stop Loss</th>
                    <th className="py-1 px-2">Take Profit</th>
                    <th className="py-1 px-2">Unrealized P&L</th>
                    <th className="py-1 px-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-line/40">
                  {positions.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-3/60 transition-colors">
                      <td className="py-1 px-2 text-ink-3 text-[11px] font-mono">{p.id.slice(-8)}</td>
                      <td className="py-1 px-2 font-semibold text-ink">{p.symbol}</td>
                      <td className="py-1 px-2">
                        <span
                          className={`font-semibold ${
                            p.side === 'BUY' ? 'text-pos' : 'text-neg'
                          }`}
                        >
                          {p.side}
                        </span>
                      </td>
                      <td className="py-1 px-2 tabular-nums text-ink-2">
                        {p.volume.toLocaleString()}
                      </td>
                      <td className="py-1 px-2 tabular-nums text-ink-2">{p.entryPrice}</td>
                      <td className="py-1 px-2 tabular-nums text-ink-2">{p.currentPrice}</td>
                      <td className="py-1 px-2 tabular-nums text-neg">
                        {p.stopLoss || '—'}
                      </td>
                      <td className="py-1 px-2 tabular-nums text-pos">
                        {p.takeProfit || '—'}
                      </td>
                      <td
                        className={`py-1 px-2 tabular-nums font-semibold ${
                          p.unrealizedPnL >= 0 ? 'text-pos' : 'text-neg'
                        }`}
                      >
                        {p.unrealizedPnL >= 0 ? '+' : ''}${p.unrealizedPnL.toFixed(2)}
                      </td>
                      <td className="py-1 px-2 text-right">
                        <button
                          onClick={() => onClosePosition(p.id)}
                          className="px-2 py-0.5 rounded bg-neg-soft/70 hover:bg-neg-soft text-neg text-[11px] font-medium border border-neg/40/40 transition-colors"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* RISK & DIAGNOSTICS VIEW */}
        {activeTab === 'errors' && (
          <div className="space-y-2">
            {errorLogs.length === 0 ? (
              <div className="text-ink-4 py-6 text-center italic font-sans text-xs">
                All systems nominal. No risk violations, execution throttles, or runtime errors detected.
              </div>
            ) : (
              errorLogs.map((err) => (
                <div
                  key={err.id}
                  className="p-2.5 rounded bg-neg-soft/30 border border-neg/40/40 text-xs flex items-start gap-2.5"
                >
                  <AlertOctagon className="w-4 h-4 text-neg shrink-0 mt-0.5" />
                  <div>
                    <div className="text-neg font-semibold mb-0.5">
                      [{new Date(err.timestamp).toLocaleTimeString()}] {err.level.toUpperCase()} Event
                    </div>
                    <div className="text-ink-2 font-mono text-[11px]">{err.message}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
