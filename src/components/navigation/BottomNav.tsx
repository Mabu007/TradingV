import React from 'react';
import {
  TrendingUp,
  Sparkles,
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
  runningGoatsCount: number;
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
  runningGoatsCount,
  /* No default identity: signed out is nobody, not a particular person. */
  user = { username: '', email: '' },
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
      id: 'goat',
      label: 'GOATs',
      icon: () => <Sparkles className="w-5 h-5" />,
      badge: runningGoatsCount > 0 ? runningGoatsCount : undefined,
    },
    {
      id: 'trades',
      label: 'Trades',
      icon: (isActive: boolean) => (
        <Layers
          className={`transition-transform duration-200 ${
            isActive ? 'w-6 h-6 text-ink scale-110' : 'w-6 h-6 text-accent-ink'
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
    /*
     * Mobile: fixed bottom bar. Desktop: sticky full-height sidebar.
     *
     * `md:sticky md:top-0 md:self-start md:h-screen` keeps the sidebar
     * fixed in the viewport while the document scrolls. `md:overflow-y-auto`
     * is allowed *only* here, so the sidebar can scroll its own contents
     * on a short window without ever scrolling the page.
     */
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-line bg-nav/95 backdrop-blur-md px-3 pt-1 pb-[env(safe-area-inset-bottom,8px)] select-none md:sticky md:top-0 md:z-30 md:h-screen md:self-start md:w-64 md:flex md:flex-col md:justify-between md:overflow-y-auto md:border-t-0 md:border-r md:bg-sidebar md:p-4">
      {/* NAVIGATION ITEMS */}
      <div className="flex items-center justify-between md:flex-col md:items-stretch md:space-y-1.5">
        {/* Desktop Brand Header */}
        <div className="hidden md:flex items-center gap-2.5 px-3 py-3 mb-4 border-b border-line">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-accent to-accent-strong flex items-center justify-center text-accent-contrast font-mono font-bold text-base shadow-sm">
            V
          </div>
          <div>
            <div className="text-sm font-bold text-ink tracking-tight flex items-center gap-1.5 font-sans">
              <span>TradingGOATs</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-accent-soft text-accent border border-accent/40">
                PRO
              </span>
            </div>
            <div className="text-[11px] text-ink-3">Mobile-First Trading Platform</div>
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
                        ? 'text-ink md:bg-accent-soft md:text-accent'
                        : 'text-ink-3 hover:text-ink-2 md:hover:bg-surface-3'
                    }`}
                  >
                    {/* Mobile Centerpiece Button Container (Approx 2x visual weight) */}
                    <div
                      className={`flex items-center justify-center w-13 h-13 rounded-2xl shadow-xl transition-all duration-200 md:w-auto md:h-auto md:p-0 md:bg-transparent md:shadow-none ${
                        isActive
                          ? 'bg-gradient-to-tr from-accent to-accent-strong ring-4 ring-accent/20 shadow-accent/60 scale-105'
                          : 'bg-surface-3 border border-accent/30 text-accent-ink hover:border-accent'
                      }`}
                    >
                      {tab.icon(isActive)}

                      {tab.badge !== undefined && (
                        <span className="absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-accent text-accent-contrast min-w-[16px] text-center shadow-xs border border-nav">
                          {tab.badge}
                        </span>
                      )}
                    </div>

                    {/* Label */}
                    <span
                      className={`text-[10px] font-bold tracking-tight mt-1 md:text-sm md:mt-0 ${
                        isActive ? 'text-accent' : 'text-ink-2 md:text-ink-3'
                      }`}
                    >
                      {tab.label}
                    </span>
                  </button>
                </div>
              );
            }

            // Normal Navigation Tabs (Markets, GOATs, Trades, History, Settings)
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`relative flex flex-col items-center justify-center py-1.5 px-3 rounded-xl transition-all duration-150 touch-manipulation md:flex-row md:justify-start md:gap-3 md:py-3 md:px-3.5 md:rounded-xl ${
                  isActive
                    ? 'text-accent bg-accent-soft font-semibold'
                    : 'text-ink-3 hover:text-ink-2 active:scale-95 md:hover:bg-surface-3'
                }`}
              >
                <div className="relative">
                  {tab.icon(isActive)}
                  {tab.badge !== undefined && (
                    <span className="absolute -top-1.5 -right-2 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-accent text-accent-contrast min-w-[16px] text-center shadow-xs">
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
      <div className="hidden md:block pt-3 border-t border-line">
        {/* Connection status pill */}
        <div className="flex items-center justify-between px-3 py-2 mb-3 rounded-lg bg-surface border border-line/60 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionStatus === 'CONNECTED'
                  ? 'bg-emerald-400 animate-pulse'
                  : connectionStatus === 'CONNECTING' || connectionStatus === 'RECONNECTING'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-neg-strong'
              }`}
            />
            <span className="text-ink-2 font-mono text-[11px]">
              {connectionStatus === 'CONNECTED'
                 ? 'Hyperliquid Connected'
                : connectionStatus === 'CONNECTING'
                ? 'Connecting...'
                : connectionStatus === 'RECONNECTING'
                ? 'Reconnecting...'
                 : 'Hyperliquid Offline'}
            </span>
          </div>
          <span className="text-[10px] text-ink-3 font-mono">DEMO</span>
        </div>

        {/* Clickable Profile Card */}
        <div
          onClick={onOpenProfile}
          className="flex items-center gap-3 p-2.5 rounded-xl bg-surface hover:bg-surface-3 border border-line hover:border-line-strong transition-all cursor-pointer group"
          title="Open Profile Settings"
        >
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-accent to-accent-strong flex items-center justify-center text-accent-contrast font-bold font-mono text-sm shadow-xs border border-line-strong/50 group-hover:scale-105 transition-transform">
            {user.username.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-ink truncate font-sans group-hover:text-accent-ink transition-colors">
              {user.username}
            </div>
            <div className="text-[11px] text-ink-3 truncate font-mono">
              {user.email}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};
