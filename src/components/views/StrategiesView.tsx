import React, { useState } from 'react';
import { Plus, Play, Code2, Copy, Trash2, ArrowUpRight } from 'lucide-react';
import { Strategy } from '../../types/trading';

interface StrategiesViewProps {
  strategies: Strategy[];
  selectedStrategyId: string;
  onOpenInEditor: (id: string) => void;
  onRunBacktest: (id: string) => void;
  onCreateStrategy: (name: string, symbol: string, timeframe: any, category: any) => void;
  onDeleteStrategy: (id: string) => void;
}

export const StrategiesView: React.FC<StrategiesViewProps> = ({
  strategies,
  selectedStrategyId,
  onOpenInEditor,
  onRunBacktest,
  onCreateStrategy,
  onDeleteStrategy,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newStratName, setNewStratName] = useState('');
  const [newStratSymbol, setNewStratSymbol] = useState('EUR/USD');
  const [newStratTf, setNewStratTf] = useState('5m');
  const [newStratCat, setNewStratCat] = useState<'Trend' | 'Breakout' | 'Mean Reversion'>('Trend');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStratName.trim()) return;
    onCreateStrategy(newStratName.trim(), newStratSymbol, newStratTf, newStratCat);
    setNewStratName('');
    setShowCreateModal(false);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-bg-bg-alt text-ink-2">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-line">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Strategies</h1>
            <p className="text-xs text-ink-3 mt-0.5">
              TypeScript strategy routines compatible across Backtest, Demo, and Live environments
            </p>
          </div>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>New Strategy</span>
          </button>
        </div>

        {/* Strategies Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {strategies.map((strat) => {
            const isSelected = strat.id === selectedStrategyId;

            return (
              <div
                key={strat.id}
                className={`bg-bg-surface border rounded-lg p-4 flex flex-col justify-between transition-colors shadow-xs ${
                  isSelected ? 'border-sky-500/60' : 'border-line hover:border-line-strong'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="text-sm font-semibold text-white tracking-tight">{strat.name}</h3>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface-3 text-ink-2 border border-line">
                      {strat.category}
                    </span>
                  </div>

                  <p className="text-xs text-ink-3 mb-4 line-clamp-2 leading-relaxed">
                    {strat.description}
                  </p>

                  <div className="flex items-center gap-2 text-xs font-mono text-ink-2 mb-4">
                    <span className="font-semibold text-white">{strat.symbol}</span>
                    <span className="text-ink-4">·</span>
                    <span>{strat.timeframe}</span>
                    <span className="text-ink-4">·</span>
                    <span className="text-ink-3 text-[11px] font-sans">
                      {new Date(strat.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-line/60 gap-2">
                  <div className="flex items-center gap-1">
                    {strategies.length > 1 && (
                      <button
                        onClick={() => onDeleteStrategy(strat.id)}
                        className="p-1 rounded text-ink-4 hover:text-rose-400 hover:bg-line-strong transition-colors"
                        title="Delete Strategy"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onRunBacktest(strat.id)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-950/60 hover:bg-indigo-900 text-indigo-300 border border-indigo-800/40 text-xs font-medium transition-colors"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Backtest</span>
                    </button>

                    <button
                      onClick={() => onOpenInEditor(strat.id)}
                      className="flex items-center gap-1 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors"
                    >
                      <span>Open</span>
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-bg-surface border border-line rounded-lg shadow-2xl p-5 text-ink-2">
            <h3 className="text-sm font-bold text-white mb-1">Create New Strategy</h3>
            <p className="text-xs text-ink-3 mb-4">
              Scaffold a clean TypeScript trading strategy with TradingGOATs SDK types.
            </p>

            <form onSubmit={handleCreate} className="space-y-3 text-xs">
              <div>
                <label className="block text-ink-2 font-medium mb-1">Strategy Name</label>
                <input
                  type="text"
                  required
                  value={newStratName}
                  onChange={(e) => setNewStratName(e.target.value)}
                  placeholder="e.g. Bollinger Squeeze Scalper"
                  className="w-full bg-bg-surface-3 text-white border border-line rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-ink-2 font-medium mb-1">Default Symbol</label>
                  <select
                    value={newStratSymbol}
                    onChange={(e) => setNewStratSymbol(e.target.value)}
                    className="w-full bg-bg-surface-3 text-white border border-line rounded px-2.5 py-1.5 focus:outline-none focus:border-sky-500 text-xs font-mono"
                  >
                    <option value="EUR/USD">EUR/USD</option>
                    <option value="GBP/USD">GBP/USD</option>
                    <option value="USD/JPY">USD/JPY</option>
                    <option value="Gold">Gold</option>
                    <option value="S&P 500">S&amp;P 500</option>
                  </select>
                </div>

                <div>
                  <label className="block text-ink-2 font-medium mb-1">Timeframe</label>
                  <select
                    value={newStratTf}
                    onChange={(e) => setNewStratTf(e.target.value)}
                    className="w-full bg-bg-surface-3 text-white border border-line rounded px-2.5 py-1.5 focus:outline-none focus:border-sky-500 text-xs font-mono"
                  >
                    <option value="1m">1m</option>
                    <option value="5m">5m</option>
                    <option value="15m">15m</option>
                    <option value="1h">1h</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-ink-2 font-medium mb-1">Archetype Category</label>
                <select
                  value={newStratCat}
                  onChange={(e) => setNewStratCat(e.target.value as any)}
                  className="w-full bg-bg-surface-3 text-white border border-line rounded px-2.5 py-1.5 focus:outline-none focus:border-sky-500 text-xs"
                >
                  <option value="Trend">Trend Following</option>
                  <option value="Breakout">Breakout / Expansion</option>
                  <option value="Mean Reversion">Mean Reversion</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 rounded text-xs text-ink-2 hover:text-white bg-line-strong transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 transition-colors shadow-sm"
                >
                  Create Strategy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
