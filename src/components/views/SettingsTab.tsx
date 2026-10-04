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
import { WalletCard } from './WalletCard';

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
    goatsCount: number;
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
        <h1 className="text-lg font-bold text-ink tracking-tight">
          Settings & Accounts
        </h1>
        <p className="text-xs text-ink-3">
          Manage your wallet, market data, risk limits, and AI keys
        </p>
      </div>

      {/* USER PROFILE CARD */}
      <div
        onClick={onOpenProfile}
        className="p-4 rounded-2xl bg-surface hover:bg-surface-3 border border-line hover:border-line-strong transition-all cursor-pointer flex items-center justify-between shadow-xs select-none group"
        title="View & Edit Profile"
      >
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-accent via-indigo-500 to-purple-600 text-accent-contrast font-bold text-lg flex items-center justify-center font-mono shadow-xs border border-line-strong/50 group-hover:scale-105 transition-transform">
            {username.charAt(0).toUpperCase()}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-ink font-sans group-hover:text-accent-ink transition-colors">
                {username}
              </h2>

              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-accent/20 text-accent-ink border border-accent/30">
                {tier} TRADER
              </span>
            </div>

            <div className="text-xs text-ink-3 font-mono mt-0.5">
              {email}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-right hidden sm:block font-mono text-xs text-ink-3">
            <div>{accountStats.connectedAccounts} Accounts</div>
            <div>{accountStats.goatsCount} Active GOATs</div>
          </div>

          <ChevronRight className="w-4 h-4 text-ink-4 group-hover:text-ink-2" />
        </div>
      </div>

      {/* TRADING ACCOUNTS */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1">
          Trading Accounts & Broker Connect
        </h3>

        <div className="rounded-2xl bg-surface border border-line overflow-hidden divide-y divide-border-line/60">
          {/* Hyperliquid Connection */}
          <div
            onClick={onOpenHyperliquidSettings}
            className="p-3.5 flex items-center justify-between hover:bg-surface-3 transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-accent-soft text-accent border border-accent/20">
                <Server className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-ink flex items-center gap-2">
                  <span>Hyperliquid Market Data</span>

                  <span className="flex items-center gap-1 text-[11px] font-mono text-pos font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span>Testnet Demo Connected</span>
                  </span>
                </div>

                <div className="text-xs text-ink-3 mt-0.5 font-sans">
                  Hyperliquid public REST + real-time WebSocket
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-ink-4" />
          </div>

          {/* Configure Network */}
          <div
            onClick={onOpenHyperliquidSettings}
            className="p-3.5 flex items-center justify-between hover:bg-surface-3 transition-colors cursor-pointer text-xs font-semibold text-accent"
          >
            <span>Configure Hyperliquid network</span>
            <ChevronRight className="w-4 h-4 text-ink-4" />
          </div>
        </div>
      </div>

      {/* WALLET (Privy authentication + wallet identity) */}
      <WalletCard executionMode={executionMode} />

      {/* AI ASSISTANT CONFIG */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1">
          AI Strategy Engine (BYO Key)
        </h3>

        <div
          onClick={onOpenAISettings}
          className="p-3.5 rounded-2xl bg-surface border border-line hover:border-line-strong transition-all cursor-pointer flex items-center justify-between shadow-xs select-none"
        >
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl border ${
                hasOpenRouterKey
                  ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                  : 'bg-warn-soft text-warn border-warn/40'
              }`}
            >
              {hasOpenRouterKey ? (
                <Sparkles className="w-5 h-5" />
              ) : (
                <KeyRound className="w-5 h-5" />
              )}
            </div>

            <div>
              <div className="text-sm font-bold text-ink flex items-center gap-2 flex-wrap">
                <span>OpenRouter AI Provider</span>

                {hasOpenRouterKey ? (
                  <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-pos-soft text-pos border border-pos/40">
                    <CheckCircle2 className="w-3 h-3" />
                    Connected
                  </span>
                ) : (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-warn-soft text-warn border border-warn/40">
                    API Key Required
                  </span>
                )}
              </div>

              <div className="text-xs text-ink-3 mt-0.5 font-sans">
                {hasOpenRouterKey
                  ? `Model: ${modelName}`
                  : 'Add your OpenRouter API key to enable AI reasoning'}
              </div>
            </div>
          </div>

          <ChevronRight className="w-4 h-4 text-ink-4" />
        </div>
      </div>

      {/* RISK & SAFEGUARDS */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1">
          Risk Management & Safeguards
        </h3>

        <div className="rounded-2xl bg-surface border border-line overflow-hidden divide-y divide-border-line/60">
          {/* Emergency Kill Switch */}
          <div
            onClick={onOpenKillSwitchModal}
            className="p-3.5 flex items-center justify-between hover:bg-surface-3 transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div
                className={`p-2 rounded-xl border ${
                  isKillSwitchActive
                    ? 'bg-neg-strong text-ink border-neg/50'
                    : 'bg-neg-strong/10 text-neg border-neg/50/20'
                }`}
              >
                <AlertOctagon className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-ink flex items-center gap-2">
                  <span>Emergency Kill Switch</span>

                  {isKillSwitchActive && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-neg-strong text-accent-contrast animate-pulse">
                      HALTED
                    </span>
                  )}
                </div>

                <div className="text-xs text-ink-3 mt-0.5">
                  Instantly close all open positions and halt all running GOAT orders
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-ink-4" />
          </div>

          {/* Daily Drawdown Guard */}
          <div className="p-3.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-surface-3 text-ink-2">
                <Shield className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-ink">
                  Daily Drawdown Guard
                </div>

                <div className="text-ink-3 mt-0.5">
                  Auto-halt trading if equity drops 5.0% in 24 hours
                </div>
              </div>
            </div>

            <span className="font-mono text-pos font-bold">
              Enabled (5%)
            </span>
          </div>
        </div>
      </div>

      {/* DOCUMENTATION & ABOUT */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink-3 px-1">
          Documentation & Platform
        </h3>

        <div className="rounded-2xl bg-surface border border-line overflow-hidden divide-y divide-border-line/60">
          {/* Documentation */}
          <div
            onClick={onOpenDocs}
            className="p-3.5 flex items-center justify-between hover:bg-surface-3 transition-colors cursor-pointer text-xs"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400">
                <BookOpen className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-bold text-ink">
                  Developer Documentation
                </div>

                <div className="text-ink-3 mt-0.5">
                  Architecture, Hyperliquid integration, market data & GOAT SDK
                </div>
              </div>
            </div>

            <ChevronRight className="w-4 h-4 text-ink-4" />
          </div>

          {/* Platform Info */}
          <div className="p-3.5 flex items-center justify-between text-xs text-ink-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-surface-3 text-ink-3">
                <Info className="w-5 h-5" />
              </div>

              <div>
                <div className="text-sm font-semibold text-ink-2">
                  TradingGOATs Engine
                </div>

                <div className="text-[11px] text-ink-4 font-mono mt-0.5">
                  v2.5.0 Mobile-Native Edition
                </div>
              </div>
            </div>

            <span className="font-mono text-ink-4">
              Hyperliquid adapter
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};