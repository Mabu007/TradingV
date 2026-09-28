import React from 'react';
import {
  CandlestickChart,
  Code2,
  Bot,
  BarChart3,
  Brain,
  Rocket,
  Globe2,
  BookOpen,
} from 'lucide-react';

export type MainView =
  | 'ide'
  | 'markets'
  | 'strategies'
  | 'bots'
  | 'backtests'
  | 'skills'
  | 'deployments'
  | 'docs';

interface SidebarProps {
  activeView: MainView;
  onSelectView: (view: MainView) => void;
  openBotsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onSelectView,
  openBotsCount,
}) => {
  const navItems: { id: MainView; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'ide', label: 'IDE Workspace', icon: <CandlestickChart className="w-4 h-4" /> },
    { id: 'markets', label: 'Markets', icon: <Globe2 className="w-4 h-4" /> },
    { id: 'strategies', label: 'Strategies', icon: <Code2 className="w-4 h-4" /> },
    { id: 'bots', label: 'Bots', icon: <Bot className="w-4 h-4" />, badge: openBotsCount },
    { id: 'backtests', label: 'Backtests', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'skills', label: 'AI Skills', icon: <Brain className="w-4 h-4" /> },
    { id: 'deployments', label: 'Deployments', icon: <Rocket className="w-4 h-4" /> },
    { id: 'docs', label: 'Documentation', icon: <BookOpen className="w-4 h-4" /> },
  ];

  return (
    <aside className="w-14 md:w-48 bg-[#080c14] border-r border-[#1e293b] flex flex-col justify-between shrink-0 select-none py-2">
      {/* Top Nav Items */}
      <div className="space-y-1 px-1.5">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelectView(item.id)}
            className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
              activeView === item.id
                ? 'bg-[#162032] text-white border-l-2 border-sky-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#0f172a]'
            }`}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="hidden md:inline truncate">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="ml-auto hidden md:inline px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-mono">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Bottom Version / SDK Indicator */}
      <div className="px-3 py-2 border-t border-[#1e293b]/50 hidden md:block">
        <div className="text-[11px] text-slate-400 font-mono">TradingVibes SDK</div>
        <div className="text-[10px] text-slate-400">TypeScript · Hyperliquid</div>
      </div>
    </aside>
  );
};
