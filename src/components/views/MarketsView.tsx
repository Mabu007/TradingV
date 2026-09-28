import React, { useState } from 'react';
import { Search, ArrowUpRight, ArrowDownRight, ExternalLink } from 'lucide-react';
import { MarketSymbol } from '../../types/instruments';

interface MarketsViewProps {
  symbols: MarketSymbol[];
  currentSymbol: string;
  onSelectMarket: (symbol: string) => void;
}

export const MarketsView: React.FC<MarketsViewProps> = ({
  symbols,
  currentSymbol,
  onSelectMarket,
}) => {
  const [search, setSearch] = useState('');

  const filtered = symbols.filter(
    (s) =>
      s.symbol.toLowerCase().includes(search.toLowerCase()) ||
      s.displayName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#090d14] text-slate-200">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Markets</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Available Hyperliquid perpetual markets with normalized tick data
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search markets..."
              className="w-full bg-[#111927] border border-[#1e293b] rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500 placeholder:text-slate-500 font-mono"
            />
          </div>
        </div>

        {/* Markets Table */}
        <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg overflow-hidden shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#1e293b] bg-[#0f172a] text-slate-400 font-sans">
                <th className="py-2.5 px-4">Symbol / Name</th>
                <th className="py-2.5 px-4">Last Price</th>
                <th className="py-2.5 px-4">24h Change</th>
                <th className="py-2.5 px-4">24h High</th>
                <th className="py-2.5 px-4">24h Low</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293b]/50 font-mono">
              {filtered.map((s) => {
                const isSelected = s.symbol === currentSymbol;
                const isPositive = s.change24h >= 0;

                return (
                  <tr
                    key={s.symbol}
                    className={`hover:bg-[#131c2e] transition-colors ${
                      isSelected ? 'bg-sky-950/20' : ''
                    }`}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">{s.symbol}</span>
                        {isSelected && (
                          <span className="px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-400 text-[10px] font-sans">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-sans">{s.displayName}</div>
                    </td>

                    <td className="py-3 px-4 font-semibold text-white text-sm tabular-nums">
                      {s.lastPrice}
                    </td>

                    <td className="py-3 px-4 text-slate-300 tabular-nums">
                      —
                    </td>

                    <td className="py-3 px-4 tabular-nums">
                      <div
                        className={`flex items-center gap-1 font-semibold ${
                          isPositive ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isPositive ? (
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowDownRight className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {isPositive ? '+' : ''}
                          {s.change24h}%
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 text-slate-400 tabular-nums">{s.high24h}</td>
                    <td className="py-3 px-4 text-slate-400 tabular-nums">{s.low24h}</td>

                    <td className="py-3 px-4 text-right font-sans">
                      <button
                        onClick={() => onSelectMarket(s.symbol)}
                        className="px-3 py-1 rounded bg-[#1e293b] hover:bg-sky-600 text-slate-200 hover:text-white text-xs font-medium transition-colors"
                      >
                        Trade / IDE
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
