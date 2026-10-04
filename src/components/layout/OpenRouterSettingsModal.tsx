import React, { useCallback, useEffect, useState } from 'react';
import { X, Sparkles, ExternalLink, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { AIProviderConfig } from '../../adapters/openrouter/types';
import { looksLikeApiKey } from '../../adapters/openrouter/provider';
import { ModelPicker, useModelCatalogue } from '../ai/ModelPicker';

interface OpenRouterSettingsModalProps {
  isOpen: boolean;
  config: AIProviderConfig;
  onSave: (config: Partial<AIProviderConfig>) => void;
  onClose: () => void;
}

/**
 * Where the key and the model are chosen.
 *
 * The model list is fetched rather than typed in, because the typed-in
 * version is what this screen used to ship with and it went stale: two of
 * its six entries had left OpenRouter's catalogue, and every request made
 * with one of them 404'd.
 */
export const OpenRouterSettingsModal: React.FC<OpenRouterSettingsModalProps> = ({
  isOpen,
  config,
  onSave,
  onClose,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.model);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const { catalogue, loading, error, refresh } = useModelCatalogue();

  useEffect(() => {
    if (!isOpen) return;
    setApiKey(config.apiKey || '');
    setModel(config.model);
    setSaved(false);
    setSaving(false);
  }, [isOpen, config.apiKey, config.model]);

  // Escape closes, so the dialog is not a trap.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const trimmedKey = apiKey.trim();
  const keyUnchanged = trimmedKey === (config.apiKey ?? '');
  const keyInvalid = trimmedKey.length > 0 && !looksLikeApiKey(trimmedKey);
  const canSave = Boolean(trimmedKey) && !keyInvalid && !saving;

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSave) return;

      setSaving(true);
      onSave({ apiKey: trimmedKey, model });
      setSaved(true);

      window.setTimeout(() => {
        setSaving(false);
        setSaved(false);
        onClose();
      }, 650);
    },
    [canSave, model, onClose, onSave, trimmedKey],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay p-3 backdrop-blur-xs sm:p-4">
      <div className="my-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-5 text-ink-2 shadow-2xl">
        <div className="flex items-start justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-accent-soft p-2 text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-ink">Connect OpenRouter</h3>
              <p className="mt-0.5 text-[11px] text-ink-3">
                Your key pays for your AI. It never reaches a TradingGOATs server.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 pt-4 text-xs">
          <div>
            <label htmlFor="openrouter-key" className="mb-1.5 block text-[11px] font-semibold text-ink-2">
              OpenRouter API key
            </label>
            <input
              id="openrouter-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste your OpenRouter API key"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border border-line bg-surface-3 px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            {keyInvalid ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-warn">
                <AlertTriangle className="h-3 w-3" />
                That does not look like an OpenRouter key. Check for a stray space or a partial paste.
              </p>
            ) : (
              <p className="mt-1.5 text-[10px] text-ink-3">
                Sent from your browser straight to OpenRouter, and kept only in this browser.
              </p>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold text-ink-2">Model</span>
            <ModelPicker
              value={model}
              onChange={setModel}
              catalogue={catalogue}
              loading={loading}
              onRefresh={refresh}
            />
            {error && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-ink"
            >
              <span>Get an OpenRouter API key</span>
              <ExternalLink className="h-3 w-3" />
            </a>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-3"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSave}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-4 py-1.5 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : saved ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : null}
                {saved ? 'Saved' : saving ? 'Saving…' : keyUnchanged ? 'Save model' : 'Save key'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
