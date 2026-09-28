import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  X,
  Send,
  Bot,
  Layers,
  ArrowRight,
  TrendingUp,
  AlertTriangle,
  Play,
  RotateCcw,
} from 'lucide-react';
import { AIContext } from '../../types/aiContext';
import { AIMessage } from '../../adapters/openrouter/types';
import { openRouterProvider } from '../../adapters/openrouter/provider';
import { Position } from '../../types/trading';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { formatPositionSize } from '../../utils/positionSize';

interface FloatingAIAssistantProps {
  context: AIContext;
  openPositions: Position[];
  onClosePosition: (posId: string) => void;
  onRunBacktestAction?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
}

export const FloatingAIAssistant: React.FC<FloatingAIAssistantProps> = ({
  context,
  openPositions,
  onClosePosition,
  onRunBacktestAction,
  externalPrompt,
  onClearExternalPrompt,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [actionableTrade, setActionableTrade] = useState<Position | null>(null);

  const [messages, setMessages] = useState<AIMessage[]>([
    {
      role: 'assistant',
      content: `Hello! I'm your TradingVibe AI assistant. I can help explain market moves, audit bot logic, answer trading questions, and evaluate your risk exposure.

Tap any suggestion below or ask me anything!`,
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when messages update
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, isLoading]);

  // When external prompt is passed (e.g. from "Ask AI About This Bot" or "Improve with AI"), open assistant and send
  useEffect(() => {
    if (externalPrompt) {
      setIsOpen(true);
      handleSendMessage(externalPrompt);
      if (onClearExternalPrompt) onClearExternalPrompt();
    }
  }, [externalPrompt]);

  // Context-aware suggestion chips
  const getContextChips = () => {
    switch (context.currentTab) {
      case 'quotes':
        return [
          `What is the current technical trend on ${context.selectedMarket || 'EUR/USD'}?`,
          `Are there major support/resistance levels near current price?`,
          `Recommend a risk-adjusted entry setup for ${context.selectedMarket || 'EUR/USD'}`,
        ];
      case 'bots':
        return [
          `How can I improve my bot's win rate?`,
          `What are the best indicators for trending markets?`,
          `Explain how London session breakout works`,
        ];
      case 'trades':
        return [
          `Analyze my open positions and total risk exposure`,
          `Should I take partial profit on winning trades?`,
          `Explain my account margin level and drawdown`,
        ];
      case 'history':
        return [
          `Summarize my trading performance and win rate`,
          `What common patterns led to my losing trades?`,
          `How can I optimize risk-to-reward ratio?`,
        ];
      default:
        return [
          `Explain Hyperliquid market integration`,
          `How does TradingVibe model backtest costs?`,
          `What are best practices for automated bot risk?`,
        ];
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputMessage;
    if (!text.trim() || isLoading) return;

    const userMsg: AIMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInputMessage('');
    setIsLoading(true);

    // Check if user specifically asks to close a trade, provide actionable card
    const lower = text.toLowerCase();
    if (lower.includes('close') && lower.includes('trade')) {
      const matchPos = openPositions.find((p) =>
        lower.includes(p.symbol.toLowerCase()) || lower.includes('position') || openPositions.length === 1
      );
      if (matchPos) {
        setActionableTrade(matchPos);
      }
    }

    try {
      const response = await openRouterProvider.chat(
        newMessages,
        {
          symbol: context.selectedMarket || 'EUR/USD',
          timeframe: '5m',
        }
      );

      setMessages((prev) => [...prev, { role: 'assistant', content: response.content }]);
    } catch (err: any) {
      // Friendly fallback if no BYO OpenRouter key has been added yet
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `To generate live AI responses from Claude 3.5 or GPT-4o, add your personal OpenRouter API key in Settings → AI Provider.\n\nQuick advice for ${context.selectedMarket || 'your strategy'}: Keep your stop loss strictly defined and adhere to maximum 1-2% risk per position.`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* PERSISTENT FLOATING BUTTON (Positioned cleanly above mobile bottom bar) */}
      <div className="fixed bottom-20 right-4 z-40 md:bottom-6 md:right-6">
        <button
          onClick={() => setIsOpen((prev) => !prev)}
          className={`relative p-3.5 rounded-full shadow-2xl transition-all duration-200 active:scale-95 flex items-center justify-center ${
            isOpen
              ? 'bg-slate-800 text-slate-300 border border-slate-700'
              : 'bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-sky-900/60 hover:shadow-sky-800/80 animate-bounce'
          }`}
          style={{ animationDuration: '4s' }}
          title="Open TradingVibe AI Assistant"
        >
          {isOpen ? <X className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}

          {/* Context indicator badge */}
          {!isOpen && (
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500" />
            </span>
          )}
        </button>
      </div>

      {/* MOBILE BOTTOM SHEET / RESPONSIVE DRAWER */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-end bg-black/60 backdrop-blur-xs p-0 md:p-6 animate-in fade-in duration-200">
          <div className="w-full md:w-[420px] h-[82vh] md:h-[680px] bg-[#0c1220] border-t md:border border-[#1e293b] rounded-t-3xl md:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            {/* Sheet Handle on mobile */}
            <div className="w-12 h-1.5 bg-slate-700/60 rounded-full mx-auto mt-2.5 md:hidden" />

            {/* Header */}
            <div className="p-3.5 border-b border-[#1e293b] bg-[#0f172a] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span>TradingVibe AI</span>
                    <span className="text-[10px] font-mono font-medium px-1.5 py-0.2 rounded bg-sky-950 text-sky-400 border border-sky-800/40">
                      Context: {context.currentTab}
                    </span>
                  </h3>
                  <div className="text-[10px] text-slate-400 truncate max-w-[220px]">
                    {context.selectedMarket ? `Market: ${context.selectedMarket}` : 'Active Account Context'}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Chat Messages Scroll Area */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-3 font-sans text-xs">
              {messages.map((m, idx) => {
                const isUser = m.role === 'user';
                return (
                  <div
                    key={idx}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl p-3 leading-relaxed whitespace-pre-wrap ${
                        isUser
                          ? 'bg-sky-600 text-white rounded-br-xs'
                          : 'bg-[#121c2e] text-slate-200 border border-[#1e293b] rounded-bl-xs'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}

              {/* Actionable Confirmation Card (AI Explains, Not Controls) */}
              {actionableTrade && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-amber-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Action Confirmation Required</span>
                  </div>
                  <p className="text-xs text-slate-300">
                    You have 1 open position for{' '}
                    <span className="font-bold text-white font-mono">{actionableTrade.symbol}</span> (
                    {actionableTrade.side} {formatPositionSize(actionableTrade.volume, hyperliquidMarketData.getInstrument(actionableTrade.symbol))}). Current P&L:{' '}
                    <span className="font-bold text-emerald-400">
                      +${actionableTrade.unrealizedPnL.toFixed(2)}
                    </span>
                    .
                  </p>
                  <button
                    onClick={() => {
                      onClosePosition(actionableTrade.id);
                      setActionableTrade(null);
                      setMessages((prev) => [
                        ...prev,
                        {
                          role: 'assistant',
                          content: `Position for ${actionableTrade.symbol} was closed at market price.`,
                        },
                      ]);
                    }}
                    className="w-full py-2 rounded-lg font-bold text-xs bg-rose-600 hover:bg-rose-500 text-white transition-all shadow-sm"
                  >
                    Confirm & Close {actionableTrade.symbol} Position
                  </button>
                </div>
              )}

              {isLoading && (
                <div className="flex items-center gap-2 text-slate-400 text-xs italic p-2">
                  <div className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                  <span>AI analyzing trading context...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Contextual Suggestion Chips */}
            <div className="p-2 border-t border-[#1e293b]/70 bg-[#090e18] overflow-x-auto flex items-center gap-1.5 text-[11px]">
              {getContextChips().map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(chip)}
                  className="px-2.5 py-1 rounded-full bg-[#111927] hover:bg-[#1a2538] text-slate-300 hover:text-white border border-[#1e293b] shrink-0 transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Input Bar */}
            <div className="p-3 border-t border-[#1e293b] bg-[#0c1220] flex items-center gap-2">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendMessage();
                }}
                placeholder="Ask about markets, bots, risk..."
                className="flex-1 bg-[#080d16] border border-[#1e293b] rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />

              <button
                onClick={() => handleSendMessage()}
                disabled={!inputMessage.trim() || isLoading}
                className="p-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white transition-all disabled:opacity-40"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
