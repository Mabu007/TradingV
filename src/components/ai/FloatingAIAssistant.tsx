import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  X,
  Send,
  AlertTriangle,
  Compass,
  KeyRound,
  Loader2,
  Minus,
  RefreshCw,
  Settings2,
} from 'lucide-react';

import { AIMessage } from '../../adapters/openrouter/types';
import { openRouterProvider } from '../../adapters/openrouter/provider';
import { isCredentialFailure, isModelFailure } from '../../adapters/openrouter/errors';
import { Position } from '../../types/trading';
import {
  AI_CONTEXT_TOOLS,
  TRADINGGOATS_PRODUCT_CONTEXT,
  buildContextPrefix,
  classifyGoatIntent,
  findGoat,
  hasGoatContextProvider,
  listMyGoats,
  readGoat,
  readLiveMarket,
  getAccountState,
  getAvailableMarkets,
  getGoats,
  getCurrentAppContext,
  getMarketQuote,
  getOpenPositions,
  getRecentTrades,
  getRiskState,
  getTrackers,
  getWalletState,
  parseNavigationAction,
  stripNavigationAction,
  type ContextSlice,
  type NavigationAction,
} from '../../services/aiContext';
import { formatPositionSize } from '../../utils/positionSize';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { ModelPicker, useModelCatalogue } from './ModelPicker';

export interface FloatingAIAssistantProps {
  openPositions: Position[];
  onClosePosition: (posId: string) => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
  /**
   * Increment to open the panel.
   *
   * The assistant owns whether it is open, so anything outside it that
   * wants it open — the header button, on every screen size — asks by
   * raising this rather than by deciding on its behalf. It was opening a
   * canned question and, with no key configured, a settings modal instead
   * of the thing the button is labelled as.
   */
  openRequest?: number;
  /** Navigation actions the model may offer. UI only, never financial. */
  onNavigate?: (action: NavigationAction['target']) => void;
  /** False when the user has not added an OpenRouter key. */
  hasProviderKey?: boolean;
  onOpenProviderSettings?: () => void;
  /** Open a market in Quotes. */
  onSelectMarket?: (symbol: string) => void;
  /** Open the GOAT inspector, where the trackers are listed. */
  onInspectTracker?: () => void;
  /** Open the thesis view, where an event can be read back. */
  onTestCondition?: () => void;
  /**
   * Applies a GOAT change the user confirmed.
   *
   * The assistant never receives this as an instruction from the model. It
   * renders a card, the person presses the button, and this is called with
   * the intent they chose. The model can put the card on screen; it cannot
   * make it do anything.
   */
  onGoatControl?: (
    control: { kind: 'stop' | 'resume' | 'steer'; goalId: string; text?: string },
  ) => Promise<{ ok: boolean; message: string }>;
}

/**
 * What an empty assistant should offer.
 *
 * Questions about this app and this account, in the user's words. None of
 * them claim to know the market: "what is the current market overview" is
 * answerable from the quotes the runtime actually holds, and the assistant
 * is told to say so when it holds none.
 */
const STARTER_PROMPTS = [
  'What is the current market overview?',
  'Explain what my GOAT is doing.',
  'Help me create a GOAT.',
  'What should I watch for?',
  'Explain this thesis.',
];

const MISSING_KEY_MESSAGE =
  'TradingGOATs AI needs your own OpenRouter API key before it can answer. Add one in Settings, then ask me again.';

const OPENING_MESSAGE = `I'm your TradingGOATs copilot. I can answer questions about this app, explain what your account and GOATs are doing, and walk you through the screens you need.

I read the app to answer — I do not trade for you. Every order still goes through the deterministic risk and execution checks.`;

interface ChatMessage extends AIMessage {
  id: string;
  action?: NavigationAction;
  /** A recovery the user can take without being told what went wrong. */
  recovery?: 'MODEL' | 'SETTINGS';
  /**
   * A runtime change the user asked for, rendered as a confirmation.
   *
   * The assistant can explain and inspect freely; changing a GOAT's runtime
   * state needs a person to press a button. Nothing here is triggered by
   * model output — the card exists because the person typed "stop my GOAT",
   * and it does nothing until they confirm.
   */
  control?: GoatControl;
}

interface GoatControl {
  kind: 'stop' | 'resume' | 'steer';
  goalId: string;
  goalName: string;
  /** Only for steering. */
  prompt?: string;
}

interface MessageState {
  messages: ChatMessage[];
  isLoading: boolean;
  actionableTrade: Position | null;
  input: string;
}

/**
 * TradingGOATs AI.
 *
 * Reads application context through narrow, read-only tools rather than
 * dumping state into every prompt, and can offer navigation actions so a
 * question like "where do I do that" ends with a button.
 *
 * It cannot place, modify, or close a trade, cannot change a risk limit,
 * and cannot enable live trading. The only actions it can produce are
 * navigation targets.
 *
 * Layout is deliberately two different layouts rather than one that
 * stretches: on a desktop this is a side panel beside the app, and on a
 * phone it is the whole screen, because a 400px column with a 40px
 * composer at the bottom of a phone screen is unusable.
 */
export const FloatingAIAssistant: React.FC<FloatingAIAssistantProps> = ({
  openPositions,
  onClosePosition,
  externalPrompt,
  onClearExternalPrompt,
  openRequest,
  onNavigate,
  hasProviderKey,
  onOpenProviderSettings,
  onSelectMarket,
  onInspectTracker,
  onTestCondition,
  onGoatControl,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [model, setModel] = useState(() => openRouterProvider.getConfig().model);
  const [{ messages, isLoading, actionableTrade, input }, setChat] = useState<MessageState>({
    messages: [],
    isLoading: false,
    actionableTrade: null,
    input: '',
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /*
   * Refs, not state, for the two things a double-click can beat.
   * `setIsLoading` is applied after the render that read it as false, so
   * two clicks in the same tick would both send; and a request that
   * resolves after the panel is closed must not set state on a component
   * that is no longer showing anything.
   */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const nextId = useRef(0);

  const { catalogue, loading: catalogueLoading } = useModelCatalogue();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const missingKey = hasProviderKey === false;

  useEffect(() => {
    if (!isOpen) return;
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading, isOpen]);

  /**
   * Decide which context slices this question actually needs.
   *
   * This is the "narrow tools" rule: the model only ever sees state that
   * is relevant to what was asked, which keeps prompts small and makes
   * the provenance of an answer obvious.
   */
  const selectSlices = useCallback((question: string): ContextSlice[] => {
    const text = question.toLowerCase();
    const slices = new Set<ContextSlice>(['app']);

    if (/\b(position|exposure|open|holding|unrealized)\b/.test(text)) slices.add('positions');
    if (/\b(trade|history|realized|closed|p&l|performance)\b/.test(text)) slices.add('trades');
    if (/\b(market|price|quote|gold|forex|index|commodit|symbol|spread|overview)\b/.test(text)) slices.add('markets');
    if (/\b(goat|goal|thesis|watching|evidence)\b/.test(text)) slices.add('goats');
    if (/\b(tracker|wake|condition|fired|signal)\b/.test(text)) slices.add('trackers');
    if (/\b(risk|exposure|limit|margin|drawdown|stop|kill)\b/.test(text)) slices.add('risk');
    if (/\b(wallet|connect|privy|address)\b/.test(text)) slices.add('wallet');
    if (/\b(equity|balance|account)\b/.test(text)) slices.add('account');

    return [...slices];
  }, []);

  const gatherContext = useCallback(
    (slices: ContextSlice[]) =>
      slices.map((slice) => {
        switch (slice) {
          case 'app': return { slice, payload: getCurrentAppContext() };
          case 'account': return { slice, payload: getAccountState() };
          case 'positions': return { slice, payload: getOpenPositions() };
          case 'trades': return { slice, payload: getRecentTrades(15) };
          case 'markets': return { slice, payload: getAvailableMarkets() };
          case 'goats': return { slice, payload: getGoats() };
          case 'trackers': return { slice, payload: getTrackers() };
          case 'risk': return { slice, payload: getRiskState() };
          case 'wallet': return { slice, payload: getWalletState() };
          default: return { slice, payload: {} };
        }
      }),
    [],
  );

  /** Nudge the user toward a real screen instead of only explaining. */
  const suggestAction = useCallback((question: string): NavigationAction | undefined => {
    const text = question.toLowerCase();
    /*
     * "Create a GOAT" is the primary action, and it is reached by
     * describing a goal rather than by hand-authoring a monitoring
     * configuration, which is no longer what the assistant offers first.
     */
    if (/\b(goal|find|look for|watch|opportunit|hypothes|thesis)\b/.test(text)) {
      return { target: 'CREATE_GOAT', label: 'Start a GOAT' };
    }
    if (/\b(create|make|build|new)\b.*\b(goat|agent)\b|\b(goat|agent)\b.*\b(create|make|build|new)\b/.test(text)) {
      return { target: 'CREATE_GOAT', label: 'Create a GOAT' };
    }
    if (/\b(create|new|add|set up)\b.*\b(tracker)\b|\b(tracker)\b.*\b(create|new|add)\b/.test(text)) {
      return { target: 'CREATE_GOAT', label: 'Create a GOAT' };
    }
    if (/\btest\b.*\b(condition|tracker)\b|\bwhy\b.*\bnot\b.*\b(fire|firing|watching|observing)\b|\bnot firing\b|\bnot trading\b/.test(text)) {
      return { target: 'INSPECT_THESIS', label: 'Inspect Thesis' };
    }
    if (/\b(risk|limit|margin|drawdown|kill switch)\b/.test(text)) {
      return { target: 'SETTINGS', label: 'Open Settings' };
    }
    if (/\b(wallet|connect wallet|privy)\b/.test(text)) {
      return { target: 'SETTINGS', label: 'Open Settings' };
    }
    if (/\b(market|price|chart|quote|gold|forex|index)\b/.test(text)) {
      return { target: 'QUOTES', label: 'Open Quotes' };
    }
    if (/\b(position|trade|open)\b/.test(text)) {
      return { target: 'TRADES', label: 'Open Trades' };
    }
    if (/\b(history|past|closed trade|performance)\b/.test(text)) {
      return { target: 'HISTORY', label: 'Open History' };
    }
    return undefined;
  }, []);

  const runNavigation = useCallback(
    (action: NavigationAction) => {
      switch (action.target) {
        case 'QUOTES':
        case 'GOATS':
        case 'TRADES':
        case 'HISTORY':
        case 'SETTINGS':
          onNavigate?.(action.target);
          break;
        case 'CREATE_GOAT':
          onNavigate?.('GOATS');
          break;
        case 'INSPECT_TRACKERS':
          onInspectTracker?.();
          break;
        case 'INSPECT_THESIS':
          onTestCondition?.();
          break;
        default:
          break;
      }
    },
    [onNavigate, onInspectTracker, onTestCondition],
  );

  const append = useCallback((message: Omit<ChatMessage, 'id'>) => {
    if (!mounted.current) return;
    const id = `msg-${(nextId.current += 1)}`;
    setChat((state) => ({ ...state, messages: [...state.messages, { ...message, id }] }));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || inFlight.current || missingKey) return;

      const userMessage: ChatMessage = {
        id: `user-${(nextId.current += 1)}`,
        role: 'user',
        content: trimmed,
      };

      const history = [...messages, userMessage];
      setChat((state) => ({ ...state, messages: history, input: '' }));
      inFlight.current = true;
      setChat((state) => ({ ...state, isLoading: true }));

      // A close request still needs the user to confirm in the UI. The
      // assistant explains and offers; it never closes anything itself.
      const lower = trimmed.toLowerCase();
      if (lower.includes('close') && lower.includes('trade') && openPositions.length > 0) {
        setChat((state) => ({
          ...state,
          actionableTrade:
            openPositions.find((position) => lower.includes(position.symbol.toLowerCase())) ??
            (openPositions.length === 1 ? openPositions[0] : undefined) ??
            null,
        }));
      }

      if (missingKey) {
        append({ role: 'assistant', content: MISSING_KEY_MESSAGE, recovery: 'SETTINGS' });
        setChat((state) => ({ ...state, isLoading: false }));
        inFlight.current = false;
        return;
      }

      /*
       * A request to change a GOAT's runtime is answered with a
       * confirmation card instead of being carried out, and never by the
       * model. The assistant explains what the button will do; the person
       * decides whether it happens.
       */
      const control = detectControl(trimmed);
      if (control) {
        append({ role: 'assistant', content: controlPrompt(control), control });
        setChat((state) => ({ ...state, isLoading: false }));
        inFlight.current = false;
        return;
      }

      const slices = selectSlices(trimmed);
      const contextPrefix = buildContextPrefix(gatherContext(slices));
      /*
       * GOAT questions and market questions are answered from the runtime
       * and the live feed, not from the throttled context snapshot: a
       * tracker can fire between the snapshot and the answer, and
       * "what is it waiting for" is a question about right now.
       */
      const live = await resolveLiveContext(trimmed);

      try {
        const response = await openRouterProvider.chat(
          history.map((message) => ({ role: message.role, content: message.content })),
          {
            systemPrompt: TRADINGGOATS_PRODUCT_CONTEXT,
            contextPrefix: live ? `${contextPrefix}\n\n${live}` : contextPrefix,
            model,
          },
        );

        /*
         * Failures are read from `error`, not parsed out of `content`.
         * The message shown here was written to be shown to a person; the
         * provider's own text never reaches this component, so there is
         * nothing here that a paste of a support ticket can leak.
         *
         * What the user is offered depends on which failure it was: a
         * rejected key is fixed in settings, a dead model in the picker.
         * The selection is never changed behind their back.
         */
        if (response.error) {
          append({
            role: 'assistant',
            content: response.error.message,
            recovery: isCredentialFailure(response.error)
              ? 'SETTINGS'
              : isModelFailure(response.error)
                ? 'MODEL'
                : undefined,
          });
          return;
        }

        const action = parseNavigationAction(response.content);
        append({
          role: 'assistant',
          content: stripNavigationAction(response.content) || response.content,
          action: action ?? suggestAction(trimmed),
        });
      } catch {
        append({
          role: 'assistant',
          content: 'Something went wrong reaching the model. Try again.',
        });
      } finally {
        inFlight.current = false;
        if (mounted.current) setChat((state) => ({ ...state, isLoading: false }));
      }
    },
    [
      messages,
      missingKey,
      model,
      openPositions,
      selectSlices,
      gatherContext,
      suggestAction,
      append,
    ],
  );

  useEffect(() => {
    if (!openRequest) return;
    openPanel();
  }, [openRequest]);

  useEffect(() => {
    if (!externalPrompt) return;
    setIsOpen(true);
    void send(externalPrompt);
    onClearExternalPrompt?.();
    // `send` changes with the conversation; re-running on it would resend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt]);

  const handleAction = useCallback(
    (action: NavigationAction) => {
      if (action.target === 'QUOTES' && onSelectMarket) {
        const app = getCurrentAppContext();
        if (app.selectedMarket) onSelectMarket(app.selectedMarket);
      }
      runNavigation(action);
    },
    [runNavigation, onSelectMarket],
  );

  const chooseModel = useCallback((modelId: string) => {
    /*
     * Changing the model keeps the conversation. The next message is sent
     * with the new one, and the history is not truncated — a person
     * switching models mid-thread is comparing them, not starting over.
     */
    openRouterProvider.setModel(modelId);
    setModel(modelId);
  }, []);

  const openPanel = useCallback(() => {
    setIsOpen(true);
    setMinimised(false);
  }, []);

  const selectedLabel = useMemo(
    () => catalogue?.models.find((entry) => entry.id === model)?.name ?? model,
    [catalogue, model],
  );

  const canSend = input.trim().length > 0 && !isLoading && !missingKey;

  return (
    <>
      {isOpen && minimised && (
        <button
          type="button"
          onClick={() => setMinimised(false)}
          className="fixed bottom-20 right-4 z-50 flex items-center gap-2 rounded-full bg-accent-strong px-4 py-2.5 text-xs font-bold text-accent-contrast shadow-xl md:bottom-6 md:right-6"
        >
          <Sparkles className="h-4 w-4" />
          <span className="max-w-[10rem] truncate">{selectedLabel}</span>
        </button>
      )}

      {isOpen && !minimised && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Mobile only: tapping away closes a screen-sized dialog. */}
          <button
            type="button"
            aria-label="Close assistant"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-overlay md:hidden"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="TradingGOATs AI"
            className="relative flex h-[100dvh] w-full flex-col overflow-hidden border-line bg-surface md:my-6 md:mr-5 md:h-[min(640px,calc(100dvh-3rem))] md:w-[min(25rem,calc(100vw-2.5rem))] md:rounded-2xl md:border md:shadow-2xl"
          >
            {/* Header: stays put, so the conversation never scrolls it away. */}
            <header className="shrink-0 border-b border-line bg-surface-2">
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-xs font-bold text-ink">AI Assistant</h3>
                  <p className="truncate text-[10px] text-ink-3">
                    {missingKey ? 'No API key connected' : `Reads this app · ${selectedLabel}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMinimised(true)}
                  className="hidden shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink md:block"
                  aria-label="Minimise assistant"
                  title="Minimise"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
                  aria-label="Close assistant"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/*
                The model on its own row. Beside the title it was
                truncated to three letters, which is worse than useless:
                the whole point of a model picker is being able to see
                which model is answering.
              */}
              <div className="px-3 pb-2">
                <ModelPicker
                  value={model}
                  onChange={chooseModel}
                  catalogue={catalogue}
                  loading={catalogueLoading}
                  variant="compact"
                  allowTest={false}
                />
              </div>
            </header>

            {/* Conversation. The only part that scrolls. */}
            <div
              ref={scrollerRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain overflow-x-hidden px-3 py-3 text-xs"
            >
              {messages.length === 0 ? (
                <EmptyState onPick={(prompt) => void send(prompt)} disabled={isLoading} showPrompts={!missingKey} />
              ) : (
                messages.map((message) => (
                  <Bubble
                    key={message.id}
                    message={message}
                    onAction={handleAction}
                    onControl={onGoatControl}
                    onReply={append}
                    onRecovery={(kind) => {
                      if (kind === 'SETTINGS') onOpenProviderSettings?.();
                    }}
                  />
                ))
              )}

              {actionableTrade && (
                <div className="space-y-2 rounded-xl border border-warn/40 bg-warn-soft p-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-warn">
                    <AlertTriangle className="h-4 w-4" />
                    Confirm to close
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-2">
                    {actionableTrade.side}{' '}
                    {formatPositionSize(
                      actionableTrade.volume,
                      hyperliquidMarketData.getInstrument(actionableTrade.symbol),
                    )}{' '}
                    on {actionableTrade.symbol}, currently{' '}
                    <span className={actionableTrade.unrealizedPnL >= 0 ? 'text-pos' : 'text-neg'}>
                      {actionableTrade.unrealizedPnL >= 0 ? '+' : ''}$
                      {actionableTrade.unrealizedPnL.toFixed(2)}
                    </span>
                    . I can explain, but closing is yours to confirm.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onClosePosition(actionableTrade.id);
                      const symbol = actionableTrade.symbol;
                      setChat((state) => ({ ...state, actionableTrade: null }));
                      append({
                        role: 'assistant',
                        content: `You closed the ${symbol} position at market. It shows up in History.`,
                      });
                    }}
                    className="w-full rounded-lg bg-neg-strong py-2 text-xs font-bold text-accent-contrast transition-colors hover:bg-neg"
                  >
                    Confirm and close {actionableTrade.symbol}
                  </button>
                </div>
              )}

              {isLoading && (
                <div className="flex items-center gap-2 px-1 text-[11px] text-ink-3">
                  <RefreshCw className="h-3 w-3 animate-spin text-accent" />
                  {selectedLabel} is thinking…
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer: pinned, so it is never below the fold. */}
            <div className="shrink-0 border-t border-line bg-surface px-3 py-2.5">
              {missingKey ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] leading-relaxed text-ink-3">
                    Add your OpenRouter API key to use the assistant. It goes straight from your
                    browser to OpenRouter and is never stored on a TradingGOATs server.
                  </p>
                  <button
                    type="button"
                    onClick={onOpenProviderSettings}
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2.5 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Open AI settings
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canSend) void send(input);
                  }}
                  className="flex items-end gap-2"
                >
                  <textarea
                    ref={composerRef}
                    rows={1}
                    value={input}
                    onChange={(event) => {
                      const next = event.target.value;
                      setChat((state) => ({ ...state, input: next }));
                      // Grow with the text, up to a few lines, then scroll.
                      event.target.style.height = 'auto';
                      event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        if (canSend) void send(input);
                      }
                    }}
                    placeholder="Ask anything…"
                    aria-label="Message the assistant"
                    className="max-h-[7.5rem] min-h-[2.5rem] w-full resize-none rounded-xl border border-line bg-inset px-3 py-2.5 text-xs leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={!canSend}
                    aria-label="Send message"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-strong text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              )}
              {!missingKey && (
                <p className="mt-1.5 text-[10px] text-ink-4">
                  Enter sends · Shift+Enter starts a new line
                </p>
              )}
            </div>

            {/* Transparency: what the assistant can read, and what it cannot do. */}
            <details className="shrink-0 border-t border-line bg-surface-2 px-3 py-1.5 text-[10px] text-ink-4">
              <summary className="cursor-pointer font-semibold text-ink-3">
                What I can read, and what I cannot do
              </summary>
              <div className="mt-2 space-y-1.5">
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {AI_CONTEXT_TOOLS.map((tool) => (
                    <div key={tool.name} className="truncate" title={tool.reads}>
                      <span className="font-mono">{tool.name}</span>
                    </div>
                  ))}
                </div>
                <p className="border-t border-line pt-1.5">
                  I read application state only. I never receive keys, seed phrases, or signing
                  secrets, I cannot place or change a trade, and I cannot enable live trading.
                </p>
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
};

/**
 * Read the GOAT system and the live feed for the parts of a question the
 * throttled snapshot cannot answer.
 *
 * Returns rendered text, or nothing when the question needs neither. Each
 * branch is deliberately small: an assistant handed a whole GOAT answers
 * with an essay and buries the answer the user wanted.
 */
async function resolveLiveContext(question: string): Promise<string | undefined> {
  const blocks: string[] = [];

  const intent = classifyGoatIntent(question);
  if (intent && hasGoatContextProvider()) {
    const match = findGoat(question);

    if (match.ambiguous && match.ambiguous.length > 1 && intent !== 'overview') {
      blocks.push(
        [
          'LIVE GOAT STATE (more than one GOAT matched, so none is assumed):',
          ...match.ambiguous.map((mission) => `- ${mission.name} (${mission.goalId}): ${mission.stageLabel}`),
          'Ask about one by name if you need its detail.',
        ].join('\n'),
      );
    } else if (match.mission) {
      blocks.push(readGoat(match.mission, intent));
    } else if (intent !== 'overview') {
      const all = listMyGoats();
      if (all.length > 0) {
        blocks.push(
          [
            'LIVE GOAT STATE (no single GOAT was named; here are all of them):',
            ...all.map(
              (goat) =>
                `- ${goat.name}: ${goat.stage}; ${goat.market ?? 'not deployed'}; ${
                  goat.watching
                } watching; plan ${goat.hasPlan ? 'exists' : 'none yet'}`,
            ),
          ].join('\n'),
        );
      }
    }
  }

  const market = await readLiveMarket(question);
  if (market) blocks.push(`LIVE MARKET:
${market}`);

  if (blocks.length === 0) return undefined;
  return `TRADINGGOATS LIVE STATE (read now, read-only):\n\n${blocks.join('\n\n')}`;
}

/**
 * Does this question ask to change a GOAT?
 *
 * Returns undefined for anything it does not recognise, which is the safe
 * default: an unrecognised request is answered as a question, not turned
 * into a button that changes runtime state.
 */
function detectControl(question: string): GoatControl | undefined {
  if (!hasGoatContextProvider()) return undefined;
  const text = question.toLowerCase();

  const kind =
    /\b(stop|pause|halt)\b/.test(text) && /\bgoat\b|\bit\b|\bmy\b/.test(text)
      ? 'stop'
      : /\b(resume|restart|play|start it again)\b/.test(text) && /\bgoat\b|\bit\b|\bmy\b/.test(text)
        ? 'resume'
        : /\b(steer|tell it|interrupt|instruct it)\b/.test(text) && /\bgoat\b|\bit\b|\bmy\b/.test(text)
          ? 'steer'
          : undefined;

  if (!kind) return undefined;

  const match = findGoat(question);
  if (match.ambiguous && match.ambiguous.length > 1) return undefined;

  // A control with no clearly identified GOAT is not offered: acting on the
  // wrong agent because the wording was loose is worse than asking.
  const target = match.mission;
  if (!target) return undefined;

  return {
    kind,
    goalId: target.goalId,
    goalName: target.name,
    ...(kind === 'steer' ? { prompt: '' } : {}),
  };
}

function controlPrompt(control: GoatControl): string {
  switch (control.kind) {
    case 'stop':
      return `I can stop ${control.goalName}. Stopping keeps everything it worked out — thesis, evidence and any trade plan — and only pauses the watching.`;
    case 'resume':
      return `I can resume ${control.goalName}. It will restart on the same deployment with the conditions it was watching.`;
    default:
      return `I can send ${control.goalName} an instruction. It is guidance for its next thinking step — it does not change the goal you gave it, and it cannot make it trade.`;
  }
}

/**
 * The empty state.
 *
 * A blank box teaches nothing. This offers the five questions a first
 * session is actually about, and says what the assistant is — before it
 * has said anything at all.
 */
/**
 * A confirmation for a runtime change.
 *
 * Rendered because the person typed a request, not because the model asked
 * for it. Nothing here happens until the button is pressed, and the button
 * says exactly what it will do — including that stopping keeps the history.
 */
const ControlCard: React.FC<{
  control: GoatControl;
  onCancel: () => void;
  onConfirm: (text?: string) => Promise<void>;
}> = ({ control, onCancel, onConfirm }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const label =
    control.kind === 'stop' ? 'Stop it' : control.kind === 'resume' ? 'Resume it' : 'Send';

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-accent/40 bg-accent-soft/60 p-3">
      {control.kind === 'steer' && (
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          placeholder="Focus on confirmation rather than anticipating the breakout."
          aria-label="Instruction for your GOAT"
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || (control.kind === 'steer' && !text.trim())}
          onClick={() => {
            setBusy(true);
            void onConfirm(control.kind === 'steer' ? text.trim() : undefined).finally(() =>
              setBusy(false),
            );
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {label}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-2.5 py-2 text-[11px] font-semibold text-ink-3 transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{
  onPick: (prompt: string) => void;
  disabled: boolean;
  showPrompts: boolean;
}> = ({ onPick, disabled, showPrompts }) => (
  <div className="space-y-3 py-2">
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink-2">{OPENING_MESSAGE}</p>
    </div>
    {showPrompts && (
      <div>
        <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
          Start with one of these
        </div>
        <div className="mt-2 space-y-1.5">
          {STARTER_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              disabled={disabled}
              className="flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[11px] text-ink-2 transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
            >
              <span className="min-w-0 break-words">{prompt}</span>
              <Compass className="h-3 w-3 shrink-0 text-ink-4" />
            </button>
          ))}
        </div>
      </div>
    )}
  </div>
);

const Bubble: React.FC<{
  message: ChatMessage;
  onAction: (action: NavigationAction) => void;
  onRecovery: (kind: 'MODEL' | 'SETTINGS') => void;
  onControl?: (
    control: { kind: 'stop' | 'resume' | 'steer'; goalId: string; text?: string },
  ) => Promise<{ ok: boolean; message: string }>;
  /** Append an assistant message without going through the model. */
  onReply?: (message: Omit<ChatMessage, 'id'>) => void;
}> = ({ message, onAction, onRecovery, onControl, onReply }) => (
  <div className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
    <div
      className={`max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2.5 leading-relaxed ${
        message.role === 'user'
          ? 'rounded-br-sm bg-accent-strong text-accent-contrast'
          : 'rounded-bl-sm border border-line bg-surface-2 text-ink-2'
      }`}
    >
      {message.content}
    </div>

    {/* Navigation only. Never a financial action. */}
    {message.action && (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onAction(message.action!)}
          className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[11px] font-bold text-accent-ink transition-colors hover:bg-accent/20"
        >
          <Compass className="h-3 w-3" />
          {message.action.label}
        </button>
      </div>
    )}

    {message.control && onControl && (
      <ControlCard
        control={message.control}
        onCancel={() =>
          onReply?.({
            role: 'assistant',
            content: `Left ${message.control!.goalName} as it was.`,
          })
        }
        onConfirm={async (text?: string) => {
          const outcome = await onControl({
            kind: message.control!.kind,
            goalId: message.control!.goalId,
            ...(text ? { text } : {}),
          });
          onReply?.({ role: 'assistant', content: outcome.message });
        }}
      />
    )}

    {message.recovery && (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => onRecovery(message.recovery!)}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/50"
        >
          <Settings2 className="h-3 w-3" />
          {message.recovery === 'MODEL' ? 'Choose another model' : 'Open AI settings'}
        </button>
      </div>
    )}
  </div>
);
