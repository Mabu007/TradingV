import React from 'react';
import {
  TrendingUp,
  Bot,
  Layers,
  History,
  Settings,
  User as UserIcon,
} from 'lucide-react';
import { MainTab } from '../../types/aiContext';
import { ConnectionStatus } from '../../types/quotes';

interface BottomNavProps {
  activeTab: MainTab;
  onTabChange: (tab: MainTab) => void;
  openPositionsCount: number;
  runningBotsCount: number;
  user?: {
    username: string;
    email: string;
    avatarUrl?: string;
  };
  onOpenProfile?: () => void;
  connectionStatus?: ConnectionStatus;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  openPositionsCount,
  runningBotsCount,
  user = { username: 'Gift', email: 'gtebogo75@gmail.com' },
  onOpenProfile,
  connectionStatus = 'CONNECTED',
}) => {
  const tabs: {
    id: MainTab;
    label: string;
    icon: (isActive: boolean) => React.ReactNode;
    badge?: number;
    isCenterpiece?: boolean;
  }[] = [
    {
      id: 'quotes',
      label: 'Quotes',
      icon: () => <TrendingUp className="w-5 h-5" />,
    },
    {
      id: 'bots',
      label: 'Bots',
      icon: () => <Bot className="w-5 h-5" />,
      badge: runningBotsCount > 0 ? runningBotsCount : undefined,
    },
    {
      id: 'trades',
      label: 'Trades',
      icon: (isActive: boolean) => (
        <Layers
          className={`transition-transform duration-200 ${
            isActive ? 'w-6 h-6 text-white scale-110' : 'w-6 h-6 text-sky-200'
          }`}
        />
      ),
      badge: openPositionsCount > 0 ? openPositionsCount : undefined,
      isCenterpiece: true,
    },
    {
      id: 'history',
      label: 'History',
      icon: () => <History className="w-5 h-5" />,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: () => <Settings className="w-5 h-5" />,
    },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[#080d16]/95 backdrop-blur-md border-t border-[#1e293b] pb-[env(safe-area-inset-bottom,8px)] pt-1 px-3 select-none md:static md:w-64 md:border-t-0 md:border-r md:bg-[#070b13] md:p-4 md:flex md:flex-col md:justify-between md:h-full">
      {/* NAVIGATION ITEMS */}
      <div className="flex items-center justify-between md:flex-col md:items-stretch md:space-y-1.5">
        {/* Desktop Brand Header */}
        <div className="hidden md:flex items-center gap-2.5 px-3 py-3 mb-4 border-b border-[#1e293b]">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white font-mono font-bold text-base shadow-sm">
            V
          </div>
          <div>
            <div className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5 font-sans">
              <span>TradingVibe</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-950 text-sky-400 border border-sky-800/40">
                PRO
              </span>
            </div>
            <div className="text-[11px] text-slate-400">Mobile-First Trading Platform</div>
          </div>
        </div>

        {/* TABS CONTAINER */}
        <div className="flex items-center justify-around w-full md:flex-col md:items-stretch md:space-y-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;

            // TRADES: Centerpiece Highlight on Mobile
            if (tab.isCenterpiece) {
              return (
                <div key={tab.id} className="relative -mt-4 md:mt-0 flex flex-col items-center">
                  <button
                    onClick={() => onTabChange('trades')}
                    className={`relative flex flex-col items-center justify-center transition-all duration-200 touch-manipulation md:flex-row md:justify-start md:gap-3 md:py-3 md:px-3.5 md:rounded-xl md:w-full ${
                      isActive
                        ? 'text-white md:bg-sky-500/15 md:text-sky-400'
                        : 'text-slate-400 hover:text-slate-200 md:hover:bg-[#111927]'
                    }`}
                  >
                    {/* Mobile Centerpiece Button Container (Approx 2x visual weight) */}
                    <div
                      className={`flex items-center justify-center w-13 h-13 rounded-2xl shadow-xl transition-all duration-200 md:w-auto md:h-auto md:p-0 md:bg-transparent md:shadow-none ${
                        isActive
                          ? 'bg-gradient-to-tr from-sky-500 to-indigo-600 ring-4 ring-sky-500/20 shadow-sky-900/60 scale-105'
                          : 'bg-[#131d2e] border border-sky-500/30 text-sky-300 hover:border-sky-400'
                      }`}
                    >
                      {tab.icon(isActive)}

                      {tab.badge !== undefined && (
                        <span className="absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-sky-500 text-white min-w-[16px] text-center shadow-xs border border-[#080d16]">
                          {tab.badge}
                        </span>
                      )}
                    </div>

                    {/* Label */}
                    <span
                      className={`text-[10px] font-bold tracking-tight mt-1 md:text-sm md:mt-0 ${
                        isActive ? 'text-sky-400' : 'text-slate-300 md:text-slate-400'
                      }`}
                    >
                      {tab.label}
                    </span>
                  </button>
                </div>
              );
            }

            // Normal Navigation Tabs (Quotes, Bots, History, Settings)
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`relative flex flex-col items-center justify-center py-1.5 px-3 rounded-xl transition-all duration-150 touch-manipulation md:flex-row md:justify-start md:gap-3 md:py-3 md:px-3.5 md:rounded-xl ${
                  isActive
                    ? 'text-sky-400 bg-sky-500/10 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 active:scale-95 md:hover:bg-[#111927]'
                }`}
              >
                <div className="relative">
                  {tab.icon(isActive)}
                  {tab.badge !== undefined && (
                    <span className="absolute -top-1.5 -right-2 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-sky-500 text-white min-w-[16px] text-center shadow-xs">
                      {tab.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] mt-1 tracking-tight md:text-sm md:mt-0">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* DESKTOP PROFILE AREA (Requirement #5: Bottom of desktop sidebar) */}
      <div className="hidden md:block pt-3 border-t border-[#1e293b]">
        {/* Connection status pill */}
        <div className="flex items-center justify-between px-3 py-2 mb-3 rounded-lg bg-[#0c121e] border border-[#1e293b]/60 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionStatus === 'CONNECTED'
                  ? 'bg-emerald-400 animate-pulse'
                  : connectionStatus === 'CONNECTING' || connectionStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-rose-500'
              }`}
            />
            <span className="text-slate-300 font-mono text-[11px]">
              {connectionStatus === 'CONNECTED'
                 ? 'Hyperliquid Connected'
                : connectionStatus === 'CONNECTING'
                ? 'Connecting...'
                : connectionStatus === 'RECONNECTING'
                ? 'Reconnecting...'
                 : 'Hyperliquid Offline'}
            </span>
          </div>
          <span className="text-[10px] text-slate-400 font-mono">DEMO</span>
        </div>

        {/* Clickable Profile Card */}
        <div
          onClick={onOpenProfile}
          className="flex items-center gap-3 p-2.5 rounded-xl bg-[#0c121e] hover:bg-[#131d2e] border border-[#1e293b] hover:border-slate-600 transition-all cursor-pointer group"
          title="Open Profile Settings"
        >
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white font-bold font-mono text-sm shadow-xs border border-white/10 group-hover:scale-105 transition-transform">
            {user.username.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-white truncate font-sans group-hover:text-sky-300 transition-colors">
              {user.username}
            </div>
            <div className="text-[11px] text-slate-400 truncate font-mono">
              {user.email}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};
