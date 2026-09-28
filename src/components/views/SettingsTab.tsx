import React from 'react';
import {
  Server,
  Sparkles,
  AlertOctagon,
  Shield,
  BookOpen,
  Info,
  ChevronRight,
  CheckCircle2,
  KeyRound,
} from 'lucide-react';
import { ExecutionMode } from '../../types/trading';
import { User } from '../../services/userService';
import { AIProviderConfig } from '../../adapters/openrouter/types';

interface SettingsTabProps {
  executionMode: ExecutionMode;
  user?: User | null;
  onOpenProfile?: () => void;
  onOpenHyperliquidSettings: () => void;
  onOpenAISettings: () => void;
  onOpenKillSwitchModal: () => void;
  isKillSwitchActive: boolean;
  onOpenDocs: () => void;
  openRouterConfig: AIProviderConfig;
  accountStats: {
    botsCount: number;
    tradesCount: number;
    connectedAccounts: number;
  };
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  executionMode,
  user,
  onOpenProfile,
  onOpenHyperliquidSettings,
  onOpenAISettings,
  onOpenKillSwitchModal,
  isKillSwitchActive,
  onOpenDocs,
  openRouterConfig,
  accountStats,
}) => {
  const username = user?.username || 'Gift';
  const email = user?.email || 'gtebogo75@gmail.com';
  const tier = user?.tier || 'Pro';

  const hasOpenRouterKey = Boolean(
    openRouterConfig.apiKey && openRouterConfig.apiKey.trim().length > 10
  );

  const modelName = openRouterConfig.model || 'inclusionai/ling-3.0-flash-fin:free';

  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-4 pb-24 md:pb-8 max-w-4xl mx-auto w-full space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-white tracking-tight">
          Settings & Accounts
        </h1>
        <p className="text-xs text-slate-400">
          Manage connections, broker APIs, risk limits, and AI keys
        </p>
      </div>

      {/* USER PROFILE CARD */}
      <div
        onClick={onOpenProfile}
        className="p-4 rounded-2xl bg-[#0b1220] hover:bg-[#111927] border border-[#1e293b] hover:border-slate-600 transition-all cursor-pointer flex items-center justify-between shadow-xs select-none group"
        title="View & Edit Profile"
      >
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-600 text-white font-bold text-lg flex items-center justify-center font-mono shadow-xs border border-white/10 group-hover:scale-105 transition-transform">
            {username.charAt(0).toUpperCase()}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white font-sans group-hover:text-sky-300 transition-colors">
                {username}
              </h2>

              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-sky-500/20 text-sky-300 border border-sky-500/30">
                {tier} TRADER
              </span>
            </div>

            <div className="text-xs text-slate-400 font-mono mt-0.5">
              {email}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-right hidden sm:block font-mono text-xs text-slate-400">
            <div>{accountStats.connectedAccounts} Accounts</div>
            <div>{accountStats.botsCount} Active Bots</div>
          </div>

          <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-slate-300" />
        </div>
      </div>

      {/* TRADING ACCOUNTS */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
          Trading Accounts & Broker Connect
        </h3>

        <div className="rounded-2xl bg-[#0b1220] border border-[#1e293b] overflow-hidden divide-y divide-[#1e293b]/60">
          {/* Hyperliquid Connection */}
          <div
            onClick={onOpenHyperliquidSettings}
            className="p-3.5 flex items-center justify-between hover:bg-[#111927] transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <Server className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <span>Hyperliquid Market Data</span>

                  <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span>Testnet Demo Connected</span>
                  </span>
                </div>

                <div className="text-xs text-slate-400 mt-0.5 font-sans">
                  Hyperliquid public REST + real-time WebSocket
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-slate-500" />
          </div>

          {/* Configure Network */}
          <div
            onClick={onOpenHyperliquidSettings}
            className="p-3.5 flex items-center justify-between hover:bg-[#111927] transition-colors cursor-pointer text-xs font-semibold text-sky-400"
          >
            <span>Configure Hyperliquid network</span>
            <ChevronRight className="w-4 h-4 text-slate-500" />
          </div>
        </div>
      </div>

      {/* AI ASSISTANT CONFIG */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
          AI Strategy Engine (BYO Key)
        </h3>

        <div
          onClick={onOpenAISettings}
          className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] hover:border-slate-600 transition-all cursor-pointer flex items-center justify-between shadow-xs select-none"
        >
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl border ${
                hasOpenRouterKey
                  ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
              }`}
            >
              {hasOpenRouterKey ? (
                <Sparkles className="w-5 h-5" />
              ) : (
                <KeyRound className="w-5 h-5" />
              )}
            </div>

            <div>
              <div className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
                <span>OpenRouter AI Provider</span>

                {hasOpenRouterKey ? (
                  <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                    <CheckCircle2 className="w-3 h-3" />
                    Connected
                  </span>
                ) : (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800/40">
                    API Key Required
                  </span>
                )}
              </div>

              <div className="text-xs text-slate-400 mt-0.5 font-sans">
                {hasOpenRouterKey
                  ? `Model: ${modelName}`
                  : 'Add your OpenRouter API key to enable AI reasoning'}
              </div>
            </div>
          </div>

          <ChevronRight className="w-4 h-4 text-slate-500" />
        </div>
      </div>

      {/* RISK & SAFEGUARDS */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
          Risk Management & Safeguards
        </h3>

        <div className="rounded-2xl bg-[#0b1220] border border-[#1e293b] overflow-hidden divide-y divide-[#1e293b]/60">
          {/* Emergency Kill Switch */}
          <div
            onClick={onOpenKillSwitchModal}
            className="p-3.5 flex items-center justify-between hover:bg-[#111927] transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div
                className={`p-2 rounded-xl border ${
                  isKillSwitchActive
                    ? 'bg-rose-600 text-white border-rose-500'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                }`}
              >
                <AlertOctagon className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <span>Emergency Kill Switch</span>

                  {isKillSwitchActive && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-600 text-white animate-pulse">
                      HALTED
                    </span>
                  )}
                </div>

                <div className="text-xs text-slate-400 mt-0.5">
                  Instantly close all open positions and halt all running bot orders
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-slate-500" />
          </div>

          {/* Daily Drawdown Guard */}
          <div className="p-3.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-slate-800 text-slate-300">
                <Shield className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-white">
                  Daily Drawdown Guard
                </div>

                <div className="text-slate-400 mt-0.5">
                  Auto-halt trading if equity drops 5.0% in 24 hours
                </div>
              </div>
            </div>

            <span className="font-mono text-emerald-400 font-bold">
              Enabled (5%)
            </span>
          </div>
        </div>
      </div>

      {/* DOCUMENTATION & ABOUT */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
          Documentation & Platform
        </h3>

        <div className="rounded-2xl bg-[#0b1220] border border-[#1e293b] overflow-hidden divide-y divide-[#1e293b]/60">
          {/* Documentation */}
          <div
            onClick={onOpenDocs}
            className="p-3.5 flex items-center justify-between hover:bg-[#111927] transition-colors cursor-pointer text-xs"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400">
                <BookOpen className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-white">
                  Developer Documentation
                </div>

                <div className="text-slate-400 mt-0.5">
                  Architecture, Hyperliquid integration, market data & bot SDK
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-slate-500" />
          </div>

          {/* Platform Info */}
          <div className="p-3.5 flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-slate-800 text-slate-400">
                <Info className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-300">
                  TradingVibe Engine
                </div>

                <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                  v2.5.0 Mobile-Native Edition
                </div>
              </div>
            </div>

            <span className="font-mono text-slate-500">
              Hyperliquid adapter
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};