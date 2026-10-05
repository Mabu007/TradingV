import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';

import { openRouterProvider } from '../../adapters/openrouter/provider';
import {
  LONG_CONTEXT_TOKENS,
  filterModels,
  recommendedModels,
} from '../../adapters/openrouter/catalogue';
import type { ModelCatalogue, OpenRouterModel } from '../../adapters/openrouter/types';

/**
 * The model picker.
 *
 * OpenRouter publishes hundreds of text models and changes the list
 * constantly, so the selector is built around discovery rather than a
 * stored array: it fetches, filters and searches, and every number shown
 * comes from the catalogue rather than from a table someone remembered.
 *
 * Two rules the UI depends on:
 *
 *   The name shown is the human name. "NVIDIA: Nemotron 3.5 Lightning" is
 *   what a person recognises; `nvidia/nemotron-3.5-lightning:free` is
 *   routing detail, so it stays a secondary line.
 *
 *   Appearance is not usability. The catalogue says a model exists; it
 *   cannot say whether this user's key can use it. So nothing is marked
 *   "available" here — there is a "Test model" action instead, and the
 *   last model that actually answered is remembered.
 */

export interface ModelCatalogueState {
  catalogue: ModelCatalogue | undefined;
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

/** Fetches the catalogue once, shared by every component that asks. */
export function useModelCatalogue(): ModelCatalogueState {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | undefined>(() =>
    openRouterProvider.knownModels(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    openRouterProvider
      .listModels()
      .then((result) => {
        if (cancelled) return;
        setCatalogue(result);
        if (result.error) setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the OpenRouter model list.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { catalogue, loading, error, refresh };
}

/** Reconciles a stale persisted model against the catalogue, once. */
export function useModelReconciliation(): string | undefined {
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void openRouterProvider
      .listModels()
      .then((catalogue) => {
        if (cancelled) return;
        const selected = openRouterProvider.getConfig().model;
        if (catalogue.models.some((model) => model.id === selected)) return;
        setMessage(
          `Your saved model "${selected}" is no longer offered by OpenRouter. Pick another one to continue.`,
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return message;
}

interface Filters {
  query: string;
  freeOnly: boolean;
  toolsOnly: boolean;
  reasoningOnly: boolean;
  longContextOnly: boolean;
}

const NO_FILTERS: Filters = {
  query: '',
  freeOnly: false,
  toolsOnly: false,
  reasoningOnly: false,
  longContextOnly: false,
};

export interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  catalogue: ModelCatalogue | undefined;
  loading?: boolean;
  onRefresh?: () => void;
  /** `modal` is the full picker; `compact` is the chatbot header. */
  variant?: 'modal' | 'compact';
  /** Offer the one-request "does this key work with this model" check. */
  allowTest?: boolean;
  /**
   * Increment this to open the picker from outside it.
   *
   * A number rather than a boolean so the same value can request the picker
   * twice: a "choose another model" button has to be able to reopen a picker the
   * user has just closed, which a boolean latch cannot express. The picker owns
   * its open state — this only asks, and the user can still close it.
   */
  openSignal?: number;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  value,
  onChange,
  catalogue,
  loading = false,
  onRefresh,
  variant = 'modal',
  allowTest = true,
  openSignal = 0,
}) => {
  const [open, setOpen] = useState(false);
  const lastSignal = useRef(openSignal);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [testState, setTestState] = useState<
    { id: string; status: 'testing' } | { id: string; status: 'ok' } | { id: string; status: 'failed'; message: string }
  >();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const models = catalogue?.models ?? [];
  const selected = models.find((model) => model.id === value);
  const recommended = useMemo(() => recommendedModels(models), [models]);
  const matches = useMemo(() => filterModels(models, filters), [models, filters]);
  const missingSelected = Boolean(value) && models.length > 0 && !selected;

  /*
   * `matches` is the answer the filters already produced, and it is the whole
   * answer. The All section used to hand it to a filter that kept only the
   * recommended ids, which turned a 466-model catalogue into 8 rows and a
   * 96-result search into 1 — the count in the heading came from `matches`
   * while the rows came from the thinned list, so the two disagreed on screen.
   *
   * Recommended models are dropped from All so nothing is listed twice, but
   * only while their own section is on screen. The heading is hidden as soon
   * as there is a query, so excluding them unconditionally would throw away
   * matching models during a search — the one moment the All list is the only
   * list. A model that matches belongs in front of the user either way.
   */
  const recommendedVisible = recommended.length > 0 && !filters.query;
  const allMatches = useMemo(
    () => sectionModelRows(matches, recommended, recommendedVisible).all,
    [matches, recommended, recommendedVisible],
  );

  /*
   * Open when asked from outside, and only then: a repeated identical signal is
   * ignored so a parent re-rendering with the same number cannot yank the list
   * open while somebody is reading it.
   */
  useEffect(() => {
    if (openSignal === lastSignal.current) return;
    lastSignal.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  // Close on an outside click or Escape: a panel that only closes on its own
  // button is a panel people get stuck in.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const runTest = async () => {
    setTestState({ id: value, status: 'testing' });
    const response = await openRouterProvider.testModel(value);
    setTestState(
      response.error
        ? { id: value, status: 'failed', message: response.error.message }
        : { id: value, status: 'ok' },
    );
  };

  const freeCount = models.filter((model) => model.isFree).length;
  const compact = variant === 'compact';

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex w-full items-center gap-2 rounded-xl border border-line bg-surface-3 text-left text-ink transition-colors hover:border-accent/50 ${
          compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
        }`}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">
            {selected?.name ?? (loading ? 'Loading models…' : value || 'Choose a model')}
          </span>
          {!compact && (
            <span className="mt-0.5 block truncate text-[10px] text-ink-3">
              {selected
                ? [selected.provider, formatContext(selected.contextLength), selected.isFree ? 'Free' : formatPrice(selected)]
                    .filter(Boolean)
                    .join(' · ')
                : 'Not in the OpenRouter catalogue'}
            </span>
          )}
        </span>
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-3" />
        ) : (
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1.5 w-[min(23rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        >
          <div className="border-b border-line p-2.5">
            <div className="flex items-center gap-2 rounded-xl border border-line bg-inset px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              <input
                ref={searchRef}
                value={filters.query}
                onChange={(event) => setFilters((state) => ({ ...state, query: event.target.value }))}
                placeholder="Search models…"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-4"
              />
              {filters.query && (
                <button
                  type="button"
                  onClick={() => setFilters((state) => ({ ...state, query: '' }))}
                  aria-label="Clear search"
                  className="text-ink-3 hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              <FilterChip
                label={`Free (${freeCount})`}
                active={filters.freeOnly}
                onClick={() => setFilters((state) => ({ ...state, freeOnly: !state.freeOnly }))}
              />
              <FilterChip
                label="Tool calling"
                active={filters.toolsOnly}
                onClick={() => setFilters((state) => ({ ...state, toolsOnly: !state.toolsOnly }))}
              />
              <FilterChip
                label="Reasoning"
                active={filters.reasoningOnly}
                onClick={() => setFilters((state) => ({ ...state, reasoningOnly: !state.reasoningOnly }))}
              />
              <FilterChip
                label={`${LONG_CONTEXT_TOKENS / 1000}k+ context`}
                active={filters.longContextOnly}
                onClick={() =>
                  setFilters((state) => ({ ...state, longContextOnly: !state.longContextOnly }))
                }
              />
            </div>
          </div>

          <div className="max-h-[min(22rem,50vh)] overflow-y-auto overscroll-contain">
            {loading && models.length === 0 && (
              <Row>
                <span className="flex items-center gap-2 text-[11px] text-ink-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading models…
                </span>
              </Row>
            )}

            {!loading && models.length === 0 && (
              <Row>
                <span className="text-[11px] text-ink-3">
                  No models matched. Clear the search or refresh the catalogue.
                </span>
              </Row>
            )}

            {missingSelected && (
              <div className="border-b border-line bg-warn-soft px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-warn">
                  Selected model unavailable
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-2">
                  <span className="font-mono">{value}</span> is not in the OpenRouter catalogue any
                  more. It has not been changed for you — choose another model to continue.
                </p>
              </div>
            )}

            {recommendedVisible && (
              <>
                <GroupLabel label="Recommended" />
                {recommended
                  .filter((model) => filterModels([model], filters).length > 0)
                  .map((model) => (
                    <ModelRow
                      key={`rec-${model.id}`}
                      model={model}
                      selected={model.id === value}
                      testState={testState?.id === model.id ? testState.status : undefined}
                      onSelect={() => choose(model.id)}
                    />
                  ))}
              </>
            )}

            {allMatches.length > 0 && (
              <>
                <GroupLabel label={`All text models (${allMatches.length})`} />
                {allMatches.map((model) => (
                  <ModelRow
                    key={`all-${model.id}`}
                    model={model}
                    selected={model.id === value}
                    testState={testState?.id === model.id ? testState.status : undefined}
                    onSelect={() => choose(model.id)}
                  />
                ))}
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <span className="truncate text-[10px] text-ink-4">
              {catalogue?.source === 'fallback'
                ? 'Offline list · OpenRouter catalogue unavailable'
                : `${models.length} text models from OpenRouter`}
            </span>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-ink-3 hover:text-ink"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            )}
          </div>
        </div>
      )}

      {allowTest && !compact && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={!value || testState?.status === 'testing'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/50 disabled:opacity-40"
          >
            {testState?.status === 'testing' && <Loader2 className="h-3 w-3 animate-spin" />}
            Test this model
          </button>
          {testState?.status === 'ok' && testState.id === value && (
            <span className="text-[11px] font-semibold text-pos">
              Works with your key. Chat and GOAT reasoning will use it.
            </span>
          )}
          {testState?.status === 'failed' && testState.id === value && (
            <span className="text-[11px] text-warn">{testState.message}</span>
          )}
        </div>
      )}
    </div>
  );
};

const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
      active
        ? 'border-accent bg-accent-soft text-ink'
        : 'border-line bg-surface-3 text-ink-3 hover:border-ink-3/40'
    }`}
  >
    {label}
  </button>
);

const GroupLabel: React.FC<{ label: string }> = ({ label }) => (
  <div className="sticky top-0 z-10 border-y border-line bg-surface-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
    {label}
  </div>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3 py-3">{children}</div>
);

const ModelRow: React.FC<{
  model: OpenRouterModel;
  selected: boolean;
  testState?: 'testing' | 'ok' | 'failed';
  onSelect: () => void;
}> = ({ model, selected, testState, onSelect }) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    onClick={onSelect}
    className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${
      selected ? 'bg-accent-soft' : ''
    }`}
  >
    <span className="mt-0.5 h-3.5 w-3.5 shrink-0">
      {selected ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-xs font-semibold text-ink">{model.name}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-3">
        <span>{model.provider}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{formatContext(model.contextLength)}</span>
        <span aria-hidden>·</span>
        <span className={model.isFree ? 'text-pos' : ''}>
          {model.isFree ? 'Free' : formatPrice(model)}
        </span>
        {model.supportsTools && <Badge label="Tools" />}
        {model.supportsStructuredOutputs && <Badge label="JSON" />}
        {model.supportsReasoning && <Badge label="Reasoning" />}
        {model.supportsVision && <Badge label="Vision" />}
        {testState === 'testing' && <Badge label="Testing…" />}
        {testState === 'ok' && <Badge label="Works" tone="good" />}
        {testState === 'failed' && <Badge label="Failed" tone="bad" />}
      </span>
    </span>
  </button>
);

const Badge: React.FC<{ label: string; tone?: 'good' | 'bad' }> = ({ label, tone }) => (
  <span
    className={`rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
      tone === 'good'
        ? 'border-pos/40 bg-pos-soft text-pos'
        : tone === 'bad'
          ? 'border-neg/40 bg-neg-soft text-neg'
          : 'border-line text-ink-4'
    }`}
  >
    {label}
  </span>
);

/**
 * Split a filtered catalogue into the two rows the list actually renders.
 *
 * This used to live inline in the render, where the All section filtered
 * `matches` down to the recommended ids — inverting the section's purpose and
 * discarding everything the filters had kept. Splitting it out makes the rule
 * stated once and testable without a DOM.
 *
 * `recommendedVisible` is passed in rather than derived, because it depends on
 * whether the caller is searching. While there is a query the Recommended
 * heading is not rendered, so a matching recommended model must stay in All
 * rather than vanish between two lists that both claim it.
 */
export function sectionModelRows(
  matches: OpenRouterModel[],
  recommended: OpenRouterModel[],
  recommendedVisible: boolean,
): { all: OpenRouterModel[] } {
  if (!recommendedVisible) return { all: matches };
  const recommendedIds = new Set(recommended.map((model) => model.id));
  return { all: matches.filter((model) => !recommendedIds.has(model.id)) };
}

function formatContext(tokens: number): string {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

function formatPrice(model: OpenRouterModel): string {
  const prompt = model.promptPerMillion;
  if (!prompt) return 'Free';
  if (prompt < 0.01) return `$${prompt.toFixed(4)}/M in`;
  return `$${prompt.toFixed(2)}/M in`;
}
