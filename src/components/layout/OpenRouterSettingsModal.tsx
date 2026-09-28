import React, { useEffect, useState } from 'react';
import { X, Sparkles, ExternalLink, CheckCircle2 } from 'lucide-react';
import { AIProviderConfig } from '../../adapters/openrouter/types';
import { POPULAR_MODELS } from '../../adapters/openrouter/provider';

interface OpenRouterSettingsModalProps {
  isOpen: boolean;
  config: AIProviderConfig;
  onSave: (config: Partial<AIProviderConfig>) => void;
  onClose: () => void;
}

export const OpenRouterSettingsModal: React.FC<OpenRouterSettingsModalProps> = ({
  isOpen,
  config,
  onSave,
  onClose,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.model);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    setApiKey(config.apiKey || '');
    setModel(config.model);
    setSavedSuccess(false);
  }, [isOpen, config.apiKey, config.model]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedKey = apiKey.trim();

    if (!trimmedKey) {
      return;
    }

    onSave({
      apiKey: trimmedKey,
      model,
    });

    setSavedSuccess(true);

    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-[#0c121e] border border-[#1e293b] rounded-lg shadow-2xl p-5 text-slate-200">

        <div className="flex items-start justify-between pb-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-sky-500/10 text-sky-400">
              <Sparkles className="w-4 h-4" />
            </div>

            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">
                Add OpenRouter API
              </h3>

              <p className="text-xs text-slate-400">
                Connect your OpenRouter API key to enable AI reasoning
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="py-4 space-y-4 text-xs">

          <div className="p-3 rounded bg-[#131c2e] border border-[#1e293b] text-slate-300 leading-relaxed text-[11px]">
            <p>
              TradingVibe uses your own OpenRouter API key for AI requests.
              You control your OpenRouter account, usage, and billing.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              OpenRouter API Key
            </label>

            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your OpenRouter API key"
              autoComplete="off"
              className="w-full bg-[#131c2e] text-slate-100 border border-[#1e293b] rounded px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-sky-500"
            />

            <p className="text-[10px] text-slate-400 mt-1">
              An API key is required for AI-powered bots and AI analysis.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              Language Model
            </label>

            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-[#131c2e] text-slate-100 border border-[#1e293b] rounded px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500"
            >
              {POPULAR_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-[#1e293b]">

            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1"
            >
              <span>Get OpenRouter API Key</span>
              <ExternalLink className="w-3 h-3" />
            </a>

            <div className="flex items-center gap-2">

              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155] transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={!apiKey.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {savedSuccess ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Saved!</span>
                  </>
                ) : (
                  <span>Save Key</span>
                )}
              </button>

            </div>
          </div>

        </form>
      </div>
    </div>
  );
};