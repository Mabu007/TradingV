import React from 'react';
import { Bot, Play, Square, Pause, Plus, Activity } from 'lucide-react';
import { Bot as BotType } from '../../types/trading';

interface BotsViewProps {
  bots: BotType[];
  onToggleBotStatus: (botId: string) => void;
  onOpenBotInIDE: (symbol: string) => void;
}

export const BotsView: React.FC<BotsViewProps> = ({
  bots,
  onToggleBotStatus,
  onOpenBotInIDE,
}) => {
  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#090d14] text-slate-200">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Active Bots & Instances</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Live and demo automated runtime workers executing TradingVibe strategies
            </p>
          </div>
        </div>

        {/* Bots Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {bots.map((b) => {
            const isRunning = b.status === 'RUNNING';

            return (
              <div
                key={b.id}
                className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-4 flex flex-col justify-between shadow-xs"
              >
                <div>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                        }`}
                      />
                      <h3 className="text-sm font-semibold text-white">{b.name}</h3>
                    </div>

                    <span
                      className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded ${
                        b.mode === 'LIVE'
                          ? 'bg-rose-950 text-rose-300 border border-rose-800/40'
                          : b.mode === 'DEMO'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                          : 'bg-indigo-950 text-indigo-300 border border-indigo-800/40'
                      }`}
                    >
                      {b.mode}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 my-3 text-xs font-mono">
                    <div className="bg-[#111927] p-2 rounded border border-[#1e293b]/60">
                      <div className="text-[10px] text-slate-400 font-sans">Market</div>
                      <div className="font-semibold text-white">{b.symbol} · {b.timeframe}</div>
                    </div>

                    <div className="bg-[#111927] p-2 rounded border border-[#1e293b]/60">
                      <div className="text-[10px] text-slate-400 font-sans">Positions</div>
                      <div className="font-semibold text-white tabular-nums">{b.positionsCount}</div>
                    </div>
                  </div>

                  <div className="text-xs space-y-1 text-slate-400 font-sans">
                    <div className="flex justify-between">
                      <span>Last Signal:</span>
                      <span className="text-slate-200 font-mono text-[11px] truncate max-w-[160px]">
                        {b.lastSignal || 'Monitoring ticks...'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Uptime:</span>
                      <span className="text-slate-200 font-mono text-[11px]">
                        {Math.floor((Date.now() - b.startedAt) / 60000)}m
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-4 mt-3 border-t border-[#1e293b]/60">
                  <button
                    onClick={() => onOpenBotInIDE(b.symbol)}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium"
                  >
                    View in IDE &rarr;
                  </button>

                  <button
                    onClick={() => onToggleBotStatus(b.id)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                      isRunning
                        ? 'bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800/50'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {isRunning ? (
                      <>
                        <Square className="w-3 h-3 fill-current" />
                        <span>Stop</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3 fill-current" />
                        <span>Start</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
