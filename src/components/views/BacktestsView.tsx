import React, { useState } from 'react';
import { Play, BarChart3, AlertCircle, ArrowUpRight, TrendingUp, TrendingDown } from 'lucide-react';
import { BacktestConfig, BacktestResult, Strategy, Timeframe } from '../../types/trading';
import { SUPPORTED_SYMBOLS } from '../../services/marketData';

interface BacktestsViewProps {
  strategies: Strategy[];
  selectedStrategyId: string;
  onSelectStrategy: (id: string) => void;
  onRunBacktestWithConfig: (config: BacktestConfig) => void;
  lastBacktestResult: BacktestResult | null;
  onOpenInIDE: () => void;
}

export const BacktestsView: React.FC<BacktestsViewProps> = ({
  strategies,
  selectedStrategyId,
  onSelectStrategy,
  onRunBacktestWithConfig,
  lastBacktestResult,
  onOpenInIDE,
}) => {
  const [symbol, setSymbol] = useState('EUR/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [initialBalance, setInitialBalance] = useState(10000);
  const [spreadPips, setSpreadPips] = useState(0.8);
  const [commissionPerLot, setCommissionPerLot] = useState(3.5);
  const [slippagePips, setSlippagePips] = useState(0.2);
  const [barCount, setBarCount] = useState(300);
  const [isRunning, setIsRunning] = useState(false);

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRunning(true);
    await onRunBacktestWithConfig({
      symbol,
      timeframe,
      initialBalance,
      spreadPips,
      commissionPerLot,
      slippagePips,
      barCount,
    });
    setIsRunning(false);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#090d14] text-slate-200">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Backtesting Workspace</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Simulate strategy performance across historical candles. Spread, slippage and commission are modelling assumptions, not live Hyperliquid fees.
            </p>
          </div>

          {lastBacktestResult && (
            <button
              onClick={onOpenInIDE}
              className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 font-medium"
            >
              <span>Inspect on Chart &rarr;</span>
            </button>
          )}
        </div>

        {/* Configuration Form */}
        <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-5 shadow-xs">
          <form onSubmit={handleRun} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Target Strategy</label>
                <select
                  value={selectedStrategyId}
                  onChange={(e) => onSelectStrategy(e.target.value)}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-medium"
                >
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Market Symbol</label>
                <select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono"
                >
                  {SUPPORTED_SYMBOLS.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Timeframe</label>
                <select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono"
                >
                  <option value="1m">1m (Scalping)</option>
                  <option value="5m">5m (Intraday)</option>
                  <option value="15m">15m (Short-term)</option>
                  <option value="1h">1h (Swing)</option>
                  <option value="4h">4h (Position)</option>
                  <option value="1d">1d (Daily)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Historical Depth (Bars)</label>
                <input
                  type="number"
                  min={50}
                  max={2000}
                  step={50}
                  value={barCount}
                  onChange={(e) => setBarCount(Number(e.target.value))}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Initial Balance ($)</label>
                <input
                  type="number"
                  min={100}
                  max={1000000}
                  step={1000}
                  value={initialBalance}
                  onChange={(e) => setInitialBalance(Number(e.target.value))}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Simulated Spread (pips)</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={spreadPips}
                  onChange={(e) => setSpreadPips(Number(e.target.value))}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Commission ($ / standard lot)
                </label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.5}
                  value={commissionPerLot}
                  onChange={(e) => setCommissionPerLot(Number(e.target.value))}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono tabular-nums"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Avg Slippage (pips)</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  value={slippagePips}
                  onChange={(e) => setSlippagePips(Number(e.target.value))}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 font-mono tabular-nums"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-[#1e293b]">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <AlertCircle className="w-3.5 h-3.5 text-slate-400" />
                <span>Zero-lookahead execution with tick-level stop-loss & take-profit detection</span>
              </div>

              <button
                type="submit"
                disabled={isRunning}
                className="flex items-center gap-1.5 px-5 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs transition-colors shadow-sm disabled:opacity-50"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{isRunning ? 'Simulating...' : 'Run Backtest'}</span>
              </button>
            </div>
          </form>
        </div>

        {/* Results Showcase */}
        {lastBacktestResult && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-white tracking-wide uppercase">
              Simulation Results: {lastBacktestResult.strategyName} ({lastBacktestResult.symbol} {lastBacktestResult.timeframe})
            </h2>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Net Profit</div>
                <div
                  className={`text-base font-bold font-mono tabular-nums mt-0.5 ${
                    lastBacktestResult.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {lastBacktestResult.netProfit >= 0 ? '+' : ''}${lastBacktestResult.netProfit.toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  {lastBacktestResult.netProfitPercent >= 0 ? '+' : ''}
                  {lastBacktestResult.netProfitPercent}%
                </div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Win Rate</div>
                <div className="text-base font-bold text-white font-mono tabular-nums mt-0.5">
                  {lastBacktestResult.winRate}%
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  {lastBacktestResult.winningTrades}W / {lastBacktestResult.losingTrades}L
                </div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Profit Factor</div>
                <div className="text-base font-bold text-white font-mono tabular-nums mt-0.5">
                  {lastBacktestResult.profitFactor}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">Gross Gain / Loss</div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Max Drawdown</div>
                <div className="text-base font-bold text-rose-400 font-mono tabular-nums mt-0.5">
                  -${lastBacktestResult.maxDrawdown.toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  -{lastBacktestResult.maxDrawdownPercent}%
                </div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Total Trades</div>
                <div className="text-base font-bold text-white font-mono tabular-nums mt-0.5">
                  {lastBacktestResult.totalTrades}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Avg ${lastBacktestResult.averageTradeProfit}
                </div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Sharpe Ratio</div>
                <div className="text-base font-bold text-sky-400 font-mono tabular-nums mt-0.5">
                  {lastBacktestResult.sharpeRatio}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">Risk-Adjusted</div>
              </div>

              <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-3">
                <div className="text-[10px] text-slate-400 uppercase font-sans">Ending Equity</div>
                <div className="text-base font-bold text-white font-mono tabular-nums mt-0.5">
                  ${lastBacktestResult.finalEquity.toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Init ${lastBacktestResult.initialBalance.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Backtest Disclaimer Notice */}
            <div className="p-3 bg-[#111927] border border-[#1e293b] rounded-lg text-xs text-slate-400 leading-relaxed">
              <strong className="text-slate-200">Simulation Transparency Notice:</strong> Historical backtest
              performance does not guarantee future financial results. Backtests model deterministic historical
              price movement; actual live trading entails liquidity variance, broker execution latency, and unpredictable
              macroeconomic slippage.
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
