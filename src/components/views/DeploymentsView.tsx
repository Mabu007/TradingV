import React from 'react';
import { Rocket, Square, Play, Terminal, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Deployment } from '../../types/trading';

interface DeploymentsViewProps {
  deployments: Deployment[];
  onToggleDeployment: (depId: string) => void;
  onOpenTerminalLogs: () => void;
}

export const DeploymentsView: React.FC<DeploymentsViewProps> = ({
  deployments,
  onToggleDeployment,
  onOpenTerminalLogs,
}) => {
  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-bg-bg-alt text-ink-2">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-line">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Strategy Deployments</h1>
            <p className="text-xs text-ink-3 mt-0.5">
              Isolated runtime processes executing TypeScript strategies against Hyperliquid environments
            </p>
          </div>
        </div>

        {/* Deployments Table */}
        <div className="bg-bg-surface border border-line rounded-lg overflow-hidden shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-line bg-bg-surface-2 text-ink-3 font-sans">
                <th className="py-2.5 px-4">Deployment / Strategy</th>
                <th className="py-2.5 px-4">Market</th>
                <th className="py-2.5 px-4">Environment</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Uptime</th>
                <th className="py-2.5 px-4">Trades</th>
                <th className="py-2.5 px-4">P&L</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-line/50 font-mono">
              {deployments.map((d) => {
                const isRunning = d.status === 'RUNNING';

                return (
                  <tr key={d.id} className="hover:bg-bg-surface-3 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-bold text-white text-sm">{d.goatName}</div>
                      <div className="text-[11px] text-ink-3 font-sans">{d.strategyName}</div>
                    </td>

                    <td className="py-3 px-4 font-semibold text-ink-2">
                      {d.symbol} · {d.timeframe}
                    </td>

                    <td className="py-3 px-4">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                          d.mode === 'LIVE'
                            ? 'bg-rose-950 text-rose-300 border border-rose-800/40'
                            : 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                        }`}
                      >
                        {d.mode}
                      </span>
                    </td>

                    <td className="py-3 px-4 font-sans">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                          }`}
                        />
                        <span className={isRunning ? 'text-emerald-400 font-medium' : 'text-ink-3'}>
                          {d.status}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 text-ink-2 tabular-nums">
                      {Math.floor(d.uptimeSeconds / 60)}m {d.uptimeSeconds % 60}s
                    </td>

                    <td className="py-3 px-4 text-ink-2 tabular-nums">{d.tradesCount}</td>

                    <td
                      className={`py-3 px-4 font-semibold tabular-nums ${
                        d.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
                    </td>

                    <td className="py-3 px-4 text-right font-sans">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={onOpenTerminalLogs}
                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-line-strong hover:bg-line-strong text-ink-2 text-xs transition-colors"
                        >
                          <Terminal className="w-3 h-3" />
                          <span>Logs</span>
                        </button>

                        <button
                          onClick={() => onToggleDeployment(d.id)}
                          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                            isRunning
                              ? 'bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800/50'
                              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                          }`}
                        >
                          {isRunning ? 'Stop' : 'Start'}
                        </button>
                      </div>
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
