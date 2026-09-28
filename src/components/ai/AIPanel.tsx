import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Send,
  HelpCircle,
  Bug,
  Sliders,
  Settings2,
  FileCode,
  ArrowRight,
  BookOpen,
  Check,
  RefreshCw,
  X,
} from 'lucide-react';
import { AIMessage, AIResponse } from '../../adapters/openrouter/types';
import { openRouterProvider } from '../../adapters/openrouter/provider';
import { AISkill } from '../../types/trading';

interface AIPanelProps {
  currentCode: string;
  symbol: string;
  timeframe: string;
  skills: AISkill[];
  onOpenSettings: () => void;
  onPreviewDiff: (suggestedCode: string, explanation?: string) => void;
  onClose?: () => void;
}

export const AIPanel: React.FC<AIPanelProps> = ({
  currentCode,
  symbol,
  timeframe,
  skills,
  onOpenSettings,
  onPreviewDiff,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'ai' | 'explain' | 'audit' | 'optimize'>('ai');
  const [inputMessage, setInputMessage] = useState('');
  const [messages, setMessages] = useState<AIMessage[]>([
    {
      role: 'assistant',
      content: `Welcome to TradingVibes AI Assistant. I can help you write, explain, audit, and optimize automated trading strategies in TypeScript.

Click any quick action below or describe the strategy logic you'd like to implement.`,
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSuggestedCode, setLastSuggestedCode] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const aiConfig = openRouterProvider.getConfig();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputMessage;
    if (!text.trim() || isLoading) return;

    const newMessages: AIMessage[] = [...messages, { role: 'user', content: text.trim() }];
    setMessages(newMessages);
    if (!textToSend) setInputMessage('');
    setIsLoading(true);

    try {
      // Gather active skills instructions to enrich context
      const activeSkillsText = skills
        .filter((s) => s.enabled)
        .map((s) => `[Skill: ${s.name}]: ${s.instructions}`)
        .join('\n');

      const response: AIResponse = await openRouterProvider.chat(
        [
          ...(activeSkillsText
            ? [{ role: 'system' as const, content: `Active Domain Knowledge Modules:\n${activeSkillsText}` }]
            : []),
          ...newMessages,
        ],
        { currentCode, symbol, timeframe }
      );

      setMessages((prev) => [...prev, { role: 'assistant', content: response.content }]);

      if (response.suggestedCode) {
        setLastSuggestedCode(response.suggestedCode);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Execution error: ${err.message}` },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickAction = (promptText: string) => {
    handleSendMessage(promptText);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0c121e] border-l border-[#1e293b]/70 select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e293b]/70 bg-[#0f172a]">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-sky-500/10 text-sky-400">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-white tracking-wide">AI Strategy Engineer</h3>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155] transition-colors"
            title="Configure OpenRouter BYO API Key"
          >
            <Settings2 className="w-3 h-3 text-slate-400" />
            <span className="hidden sm:inline">Settings</span>
          </button>

          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
              title="Hide AI Assistant (Expands Workspace)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-[#1e293b]/70 bg-[#0a0f18] px-2 text-xs">
        <button
          onClick={() => setActiveTab('ai')}
          className={`flex items-center gap-1 py-1.5 px-2.5 font-medium border-b-2 transition-colors ${
            activeTab === 'ai'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Chat</span>
        </button>
        <button
          onClick={() => {
            setActiveTab('explain');
            handleQuickAction('Explain this strategy step-by-step and describe the entry/exit mechanics.');
          }}
          className={`flex items-center gap-1 py-1.5 px-2.5 font-medium border-b-2 transition-colors ${
            activeTab === 'explain'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Explanation</span>
        </button>
        <button
          onClick={() => {
            setActiveTab('audit');
            handleQuickAction('Audit this strategy for syntax errors, missing warm-up buffers, and risk vulnerabilities.');
          }}
          className={`flex items-center gap-1 py-1.5 px-2.5 font-medium border-b-2 transition-colors ${
            activeTab === 'audit'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Audit</span>
        </button>
        <button
          onClick={() => {
            setActiveTab('optimize');
            handleQuickAction('Analyze the strategy code and suggest optimizations to improve win rate and reduce drawdown.');
          }}
          className={`flex items-center gap-1 py-1.5 px-2.5 font-medium border-b-2 transition-colors ${
            activeTab === 'optimize'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Optimization</span>
        </button>
      </div>

      {/* Provider Info Banner */}
      <div className="px-3 py-1 bg-[#131c2e]/60 border-b border-[#1e293b]/40 flex items-center justify-between text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5 truncate">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span className="truncate">
            {aiConfig.apiKey ? aiConfig.model : 'Local Quantitative Intelligence Engine'}
          </span>
        </div>
        <span className="text-[10px] text-slate-400 shrink-0">
          {skills.filter((s) => s.enabled).length} skills active
        </span>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`max-w-[94%] rounded-lg p-3 leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-sky-950/60 border border-sky-800/40 text-sky-100'
                  : 'bg-[#111927] border border-[#1e293b] text-slate-200'
              }`}
            >
              <div className="whitespace-pre-wrap font-sans text-xs break-words">
                {msg.content}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-slate-400 text-xs py-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" />
            <span>Analyzing quantitative logic...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Code Preview Action Banner */}
      {lastSuggestedCode && (
        <div className="px-3 py-2 bg-sky-950/40 border-t border-sky-900/50 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-sky-200">
            <FileCode className="w-3.5 h-3.5 text-sky-400" />
            <span>AI suggested updated code</span>
          </div>
          <button
            onClick={() => onPreviewDiff(lastSuggestedCode, 'AI suggested changes to your strategy')}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs transition-colors shadow-sm"
          >
            <span>Review Diff</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Quick Action Suggestions */}
      <div className="px-3 py-1.5 bg-[#0a0f18] border-t border-[#1e293b]/60 flex items-center gap-1.5 overflow-x-auto text-[11px]">
        <button
          onClick={() => handleQuickAction('Add an RSI 14 filter and 1:2 risk-reward take profit / stop loss.')}
          className="whitespace-nowrap px-2 py-0.5 rounded bg-[#162032] hover:bg-[#202d44] text-slate-300 hover:text-white transition-colors"
        >
          + Add RSI Filter
        </button>
        <button
          onClick={() => handleQuickAction('Create an EUR/USD breakout strategy for 15m.')}
          className="whitespace-nowrap px-2 py-0.5 rounded bg-[#162032] hover:bg-[#202d44] text-slate-300 hover:text-white transition-colors"
        >
          + London Breakout
        </button>
        <button
          onClick={() => handleQuickAction('Check my strategy for common pitfalls and edge cases.')}
          className="whitespace-nowrap px-2 py-0.5 rounded bg-[#162032] hover:bg-[#202d44] text-slate-300 hover:text-white transition-colors"
        >
          + Check Pitfalls
        </button>
      </div>

      {/* Chat Input */}
      <div className="p-2.5 bg-[#0e1524] border-t border-[#1e293b]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="Ask AI to modify strategy or explain code..."
            className="flex-1 bg-[#131c2e] text-slate-200 border border-[#1e293b] rounded px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500 placeholder:text-slate-500"
          />
          <button
            type="submit"
            disabled={!inputMessage.trim() || isLoading}
            className="p-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
