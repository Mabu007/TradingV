import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  agentRuntime,
  DemoEnvironment,
  TradingAgent,
} from './engine/agents';

import { AgentTimelineEvent } from './engine/agents/timeline';

import {
  TrackerRegistry,
  TrackerRuntime,
  Tracker,
} from './engine/agents/trackers';

import { MobileHeader } from './components/navigation/MobileHeader';
import { BottomNav } from './components/navigation/BottomNav';

import { TradesTab } from './components/views/TradesTab';
import { QuotesTab } from './components/views/QuotesTab';
import { marketsFromDiscovery } from './components/navigation/marketOptions';
import { HistoryTab } from './components/views/HistoryTab';
import { SettingsTab } from './components/views/SettingsTab';

import { FloatingAIAssistant } from './components/ai/FloatingAIAssistant';

import { DocsView } from './components/views/DocsView';
import { GoatView } from './components/goat';
import { STARTER_GOATS } from './engine/goat/starterGoats';

const starterGoatContext = () =>
  STARTER_GOATS.map((goat) => ({
    id: goat.identity.id,
    statement: goat.goal.statement,
    status: 'STARTER',
    source: goat.source,
    skills: goat.skills.map((s) => s.id),
    lastActivity: goat.updatedAt,
  }));
import { GoatOrchestrator, createGoatStores } from './engine/goat/orchestrator';
import { ProfileView } from './components/views/ProfileView';

import { User, userService } from './services/userService';
import { ConnectionStatus } from './types/quotes';
import { configuredVenue, type VenueEnvironment } from './config/venue';

import { LiveConfirmModal } from './components/layout/LiveConfirmModal';
import { HyperliquidSettingsModal } from './components/layout/HyperliquidSettingsModal';
import { OpenRouterSettingsModal } from './components/layout/OpenRouterSettingsModal';
import { KillSwitchModal } from './components/layout/KillSwitchModal';

import {
  BacktestResult,
  Bar,
  Goat,
  ExecutionMode,
  LogEntry,
  OrderSide,
  Position,
  Quote,
  SignalEvent,
  Strategy,
  Timeframe,
  Trade,
} from './types/trading';

import { TradingInstrument } from './types/instruments';

import { MainTab } from './types/aiContext';
import { eventBus } from './types/events';

import { marketDataService } from './services/marketData';
import { SAMPLE_STRATEGIES } from './services/strategies';

import { historicalMarketDataProvider } from './engine/backtester/historical';

import { hyperliquidMarketData } from './adapters/hyperliquid/marketData';

import { ACCOUNT_CURRENCY } from './engine/execution/valuation';
import { riskManager } from './engine/execution/risk';

import { appContextStore } from './services/aiContext/store';
import { registerGoatContextProvider } from './services/aiContext/goatTools';
import type { NavigationTarget } from './services/aiContext/navigation';
import { useWallet } from './services/wallet';
import type { TrackerConditionContext } from './engine/agents/trackers/conditions';
import { hyperliquidDemoAdapter } from './adapters/hyperliquid/demo';

import { AIProviderConfig } from './adapters/openrouter/types';
import { openRouterProvider } from './adapters/openrouter/provider';


// ============================================================
// TRACKER INFRASTRUCTURE
// ============================================================

/**
 * The registry: which trackers exist, and whose they are.
 *
 * The runtime: what watches them. One instance of each, created here
 * and shared, because a second runtime would be a second observation
 * path and there is only meant to be one.
 */
const trackerRegistry = new TrackerRegistry(
  (agentId) => agentRuntime.getAgent(agentId)
);

const trackerRuntime = new TrackerRuntime({
  registry: trackerRegistry,
  agents: agentRuntime,
  timeline: agentRuntime.getTimelineStore(),
});

trackerRuntime.setEnvironment('DEMO');

/**
 * GOAT — Goal-Oriented Agentic Trader.
 *
 * The reasoning layer that sits over the agent runtime and the tracker
 * runtime. It is created once, alongside them, because a GOAT is not a
 * separate system: it is the same runtime given a goal instead of an
 * observation plan, plus the ability to author its own.
 */
const demoEnvironmentForGoat = new DemoEnvironment();

const goatOrchestrator = new GoatOrchestrator({
  agentRuntime,
  trackers: trackerRuntime,
  env: demoEnvironmentForGoat,
  stores: createGoatStores('PERSISTENT'),
});

/*
 * What the assistant is allowed to reach.
 *
 * The assistant answers questions about GOATs from the same mission read
 * model the screens render, so "what is my GOAT doing?" and the live card
 * cannot disagree. Registered here rather than imported inside aiContext so
 * that module holds no engine dependency and can be exercised with a stub.
 */
registerGoatContextProvider({
  missions: () => goatOrchestrator.missions(),
  mission: (goalId) => goatOrchestrator.mission(goalId),
  evidenceFor: (goalId, limit) => {
    const theses = goatOrchestrator.stores.theses.listForGoal(goalId);
    return theses
      .flatMap((thesis) => goatOrchestrator.stores.evidence.listForThesis(thesis.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((item) => ({
        summary: item.summary,
        polarity: item.polarity,
        source: item.source,
        at: item.createdAt,
      }));
  },
  /*
   * The real feed, straight out of the durable timeline the runtime writes.
   *
   * It used to be reconstructed from `mission.lastActivity`, which is one
   * derived line — so "what happened during the last wake?" could only ever
   * be answered with a single summary, and a GOAT that had deployed, read
   * the market, formed a thesis and gone to sleep looked identical to one
   * that had done nothing.
   */
  activityFor: (goalId, limit) =>
    goatOrchestrator.activityFor(goalId, limit).map((entry) => ({ at: entry.at, text: entry.text })),
  trackLiveQuote: async (symbol) => {
    const quote = await hyperliquidMarketData.getQuote(symbol);
    return {
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      // The read was a live REST call, so the assistant can say the price
      // is current rather than implying a stale snapshot is the same thing.
      status: 'live',
    };
  },
});

/**
 * Ask the GOAT tab to re-read the orchestrator.
 *
 * The assistant can change a GOAT while the user is on another tab. The
 * orchestrator's own 2s poll would catch it, so this only makes it immediate.
 */
let requestGoatViewRefresh: (() => void) | undefined;

function goatViewRefresh(): void {
  requestGoatViewRefresh?.();
}

let trackerRuntimeStarted = false;

/**
 * How often the AI context is republished at most.
 *
 * Quotes arrive continuously; the assistant cannot read faster than a
 * person can, and rebuilding the projection on every tick put a long
 * synchronous handler in the browser's message loop.
 */
const CONTEXT_PUBLISH_INTERVAL_MS = 500;

/** Human label for the current screen, used by the AI context. */
function currentViewLabel(tab: MainTab): string {
  switch (tab) {
    case 'goat': return 'GOAT';
    case 'quotes': return 'Quotes';
    case 'trades': return 'Trades';
    case 'history': return 'History';
    default: return 'Settings';
  }
}

/**
 * Map an AI navigation suggestion onto an application tab.
 *
 * Navigation only. There is no mapping from a suggestion to a financial
 * action, and there never will be.
 */
function tabForNavigation(target: NavigationTarget): MainTab | undefined {
  switch (target) {
    case 'TRADES': return 'trades';
    case 'GOATS':
    case 'CREATE_GOAT': return 'goat';
    case 'QUOTES': return 'quotes';
    case 'HISTORY': return 'history';
    case 'SETTINGS': return 'settings';
    case 'INSPECT_TRACKERS':
    case 'INSPECT_THESIS': return 'goat';
    default: return undefined;
  }
}

function ensureTrackerRuntimeStarted() {
  if (trackerRuntimeStarted) {
    return;
  }

  trackerRuntime.start();
  trackerRuntimeStarted = true;
}

// ============================================================
// APP
// ============================================================

function App() {
  // ----------------------------------------------------------
  // Core UI state
  // ----------------------------------------------------------

  const [currentTab, setCurrentTab] =
    useState<MainTab>('goat');

  const [symbol, setSymbol] =
    useState<string>('');

  const [instruments, setInstruments] =
    useState<TradingInstrument[]>([]);

  const [timeframe, setTimeframe] =
    useState<Timeframe>('5m');

  const [executionMode, setExecutionMode] =
    useState<ExecutionMode>('DEMO');


  // ----------------------------------------------------------
  // Account / trading state
  // ----------------------------------------------------------

  /*
   * No seeded balances, positions, or trades.
   *
   * These collections are populated only when actual account/
   * execution state becomes available.
   */
  const [balance, setBalance] =
    useState<number>(0);

  /*
   * Margin here is the execution environment's own projection, based on
   * the leverage the venue publishes for each market. It is not live
   * clearing or liquidation state, which Hyperliquid does not expose to
   * this client.
   */
  const [margin, setMargin] =
    useState<number>(0);

  const [freeMargin, setFreeMargin] =
    useState<number>(0);

  const [bars, setBars] =
    useState<Bar[]>([]);

  const [signals, setSignals] =
    useState<SignalEvent[]>([]);

  const [logs, setLogs] =
    useState<LogEntry[]>([]);

  const [positions, setPositions] =
    useState<Position[]>([]);

  const [trades, setTrades] =
    useState<Trade[]>([]);


  // ----------------------------------------------------------
  // LIVE MARKET QUOTES
  // ----------------------------------------------------------

  /*
   * Live bid/ask/spread are kept separately from MarketSymbol.
   *
   * MarketSymbol is instrument metadata.
   * Quote is the real-time provider quote from Hyperliquid
   * l2Book.
   */
  const [quotes, setQuotes] =
    useState<Record<string, Quote>>({});


  // ----------------------------------------------------------
  // Bots / strategies
  // ----------------------------------------------------------

  const [strategies] =
    useState<Strategy[]>(SAMPLE_STRATEGIES);

  const [backtestResult, setBacktestResult] =
    useState<BacktestResult | null>(null);


  // ----------------------------------------------------------
  // Modal / UI state
  // ----------------------------------------------------------

  const [showLiveConfirm, setShowLiveConfirm] =
    useState(false);

  const [showHyperliquidModal, setShowHyperliquidModal] =
    useState(false);

  const [showAIModal, setShowAIModal] =
    useState(false);

  const [showKillSwitchModal, setShowKillSwitchModal] =
    useState(false);

  const [showDocsView, setShowDocsView] =
    useState(false);

  const [showProfileView, setShowProfileView] =
    useState(false);

  /*
   * A mirror of the engine's kill switch, not a second copy of it.
   *
   * The engine is the authority: every order is gated on
   * `riskManager`, including ones the interface never sees. React state
   * is only re-rendering information, and it is written *from* the
   * engine after the engine has changed, never independently. A halt
   * engaged anywhere else -- a restored halt, a limit that tripped --
   * therefore cannot leave the header saying "trading active" while the
   * gate is rejecting every order.
   */
  const [isKillSwitchActive, setIsKillSwitchActive] =
    useState(() => riskManager.isKillSwitchActive());

  /**
   * Something the user must be told about that is not a transient toast.
   *
   * Used by the emergency flatten, which can genuinely fail on one
   * position while succeeding on the rest. A user who believes every
   * position closed when one did not is worse off than one who was told.
   */
  const [safetyNotice, setSafetyNotice] =
    useState<string | null>(null);


  // ----------------------------------------------------------
  // User / connection
  // ----------------------------------------------------------

  const [user, setUser] =
    useState<User | null>(null);

  const { state: walletState } = useWallet();

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('CONNECTING');


  // ----------------------------------------------------------
  // Hyperliquid public market-data configuration
  //
  // No signing credentials belong in the browser.
  // ----------------------------------------------------------

  /*
   * The venue environment, read once from the canonical config and then
   * carried explicitly. The adapter is the only thing that decides which
   * hosts a request goes to; this state exists so the UI can state which
   * environment is live and so a change is applied deliberately.
   */
  const [venueEnvironment, setVenueEnvironment] = useState<VenueEnvironment>(
    () => configuredVenue().environment,
  );


  // ----------------------------------------------------------
  // OpenRouter BYO configuration
  // ----------------------------------------------------------

  const [openRouterConfig, setOpenRouterConfig] =
    useState<AIProviderConfig>(
      openRouterProvider.getConfig()
    );

  /*
   * Throttle state for the AI context publish below. A ref rather than
   * state because a render must not be scheduled in order to avoid one.
   */
  const contextPublishRef = useRef<{ last: number; timer: number | null }>({
    last: 0,
    timer: null,
  });

  const [externalAIPrompt, setExternalAIPrompt] =
    useState<string | null>(null);

  /*
   * How many times the assistant has been asked to open.
   *
   * A counter rather than a boolean so opening it twice in a row works:
   * a boolean that is already true would not re-trigger the effect that
   * opens the panel.
   */
  const [aiOpenRequest, setAiOpenRequest] =
    useState(0);

  /*
   * Read by the AI context publisher, which must not re-run whenever a
   * child opens the builder.
   */
  const selectedGoatIdRef = useRef<string | undefined>(undefined);


  // ==========================================================
  // OPENROUTER HELPERS
  // ==========================================================

  const hasOpenRouterKey = (): boolean =>
    Boolean(
      openRouterConfig.apiKey &&
      openRouterConfig.apiKey.trim().length > 10
    );

  /*
   * AI-powered actions must never silently fall back to fake,
   * deterministic, or placeholder trading intelligence.
   *
   * If no BYO OpenRouter key exists, show the configuration
   * modal and stop the requested AI operation.
   */
  const requireOpenRouterKey = (): boolean => {
    if (hasOpenRouterKey()) {
      return true;
    }

    setShowAIModal(true);
    return false;
  };


  // ==========================================================
  // START TRACKER RUNTIME
  // ==========================================================

  useEffect(() => {
    ensureTrackerRuntimeStarted();

    /*
     * Two things have to be true before the product can be used, and both
     * are about state that outlives the session.
     *
     * The configured model is checked against OpenRouter's live catalogue,
     * because a model that has been retired is a 404 on every request and
     * the previous build shipped exactly that. The replacement is reported
     * rather than applied silently to the picker, which keeps the user's
     * own selection intact until they choose one.
     *
     * A GOAT that was deployed but never got to reason — a closed tab
     * between the two — is started here, so "deploy" is not a promise the
     * runtime quietly breaks when the page goes.
     */
    void (async () => {
      try {
        await openRouterProvider.reconcileModel();
        setOpenRouterConfig(openRouterProvider.getConfig());
      } catch {
        // The catalogue is unavailable; the picker falls back and says so.
      }

      try {
        await goatOrchestrator.resumeUnstartedGoats();
      } catch {
        // A GOAT that cannot be resumed is reported as having no thesis.
      }
    })();

    return () => {
      /*
       * The tracker runtime is module-level and shared by the app.
       * Do not dispose it here because React development StrictMode
       * can mount/unmount this component more than once.
       */
    };
  }, []);


  // ==========================================================
  // HYPERLIQUID MARKET DISCOVERY
  // ==========================================================

  useEffect(() => {
    let cancelled = false;

    void hyperliquidMarketData
      .getInstruments()
      .then((discovered) => {
        if (cancelled) {
          return;
        }

        setInstruments(discovered);

        const markets = discovered
          .map((instrument) => instrument.market)
          .filter(
            (market): market is NonNullable<
              TradingInstrument['market']
            > => Boolean(market)
          );

        marketDataService.setSymbols(markets);

        /*
         * Keep the current selection if it still exists.
         * Otherwise select the first actually discovered market.
         */
        if (discovered.length > 0) {
          setSymbol((currentSymbol) => {
            const stillAvailable = discovered.some(
              (instrument) =>
                instrument.symbol === currentSymbol
            );

            return stillAvailable
              ? currentSymbol
              : discovered[0].symbol;
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        eventBus.emit({
          type: 'LOG',
          data: {
            id: `market-discovery-error:${Date.now()}`,
            timestamp: Date.now(),
            level: 'error',
            message:
              error instanceof Error
                ? error.message
                : String(error),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);


  // ==========================================================
  // USER + CONNECTION STATUS
  // ==========================================================

  useEffect(() => {
    let cancelled = false;

    void userService
      .getCurrentUser()
      .then((currentUser) => {
        if (!cancelled) {
          setUser(currentUser);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        eventBus.emit({
          type: 'LOG',
          data: {
            id: `user-load-error:${Date.now()}`,
            timestamp: Date.now(),
            level: 'error',
            message:
              error instanceof Error
                ? error.message
                : String(error),
          },
        });
      });

    const unsubscribeStatus =
      hyperliquidMarketData.onStatusChange(
        (status) => {
          setConnectionStatus(status);
        }
      );

    void hyperliquidMarketData.connect();

    return () => {
      cancelled = true;
      unsubscribeStatus();
    };
  }, []);


  // ==========================================================
  // HISTORICAL / CURRENT MARKET DATA
  // ==========================================================

  useEffect(() => {
    if (!symbol) {
      setBars([]);
      return;
    }

    let cancelled = false;

    void hyperliquidMarketData
      .getBars(symbol, timeframe, 260)
      .then((historicalBars) => {
        if (!cancelled) {
          setBars(historicalBars);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        /*
         * Do not generate synthetic market data as a silent fallback.
         * If the real provider cannot supply bars, leave the chart
         * empty and report the actual failure.
         */
        setBars([]);

        eventBus.emit({
          type: 'LOG',
          data: {
            id: `bars-load-error:${Date.now()}`,
            timestamp: Date.now(),
            level: 'error',
            message:
              error instanceof Error
                ? error.message
                : String(error),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);


  // ==========================================================
  // REALTIME QUOTE SUBSCRIPTIONS
  // ==========================================================

/*
   * Subscribe to every discovered instrument so the Quotes list
   * can show actual provider bid/ask values rather than fabricating
   * them from a cached last price.
   *
   * Hyperliquid's l2Book stream is the source of truth for these
   * values.
   *
   * The subscription list is keyed on the discovered instrument ids,
   * never on a live value: republishing the instrument list on every
   * tick would tear down and rebuild every subscription continuously.
   */
  const subscribedInstrumentIds = useMemo(
    () =>
      instruments
        .map((instrument) => instrument.id)
        .join('|'),
    [instruments]
  );

  useEffect(() => {
    if (instruments.length === 0) {
      return;
    }

    const unsubscribers =
      instruments.map((instrument) =>
        hyperliquidMarketData.subscribeQuote(
          instrument.symbol,
          (quote) => {
            setQuotes((previous) => ({
              ...previous,
              [quote.symbol]: quote,
            }));

            /*
             * Keep the cached midpoint in the market-data registry for
             * consumers that still read a last price. Live bid/ask must
             * come from quotes[].
             */
            marketDataService.updateLastPrice(
              quote.symbol,
              (quote.bid + quote.ask) / 2,
            );

            /*
             * Mark open positions from the real quote.
             *
             * The execution adapter owns position economics so a
             * commodity or index position is valued exactly like a
             * Forex position. No pip, lot, or quote-currency
             * assumption is applied to any instrument here.
             */
            hyperliquidDemoAdapter.markToMarket(
              quote,
            );
          }
        )
      );

    return () => {
      unsubscribers.forEach(
        (unsubscribe) =>
          unsubscribe()
      );
    };
  }, [subscribedInstrumentIds]);




  // ==========================================================
  // INITIAL CURRENT QUOTE
  // ==========================================================

  /*
   * The WebSocket normally provides the first quote quickly.
   *
   * We also request the selected market directly so the currently
   * viewed instrument does not have to wait for the next stream
   * update before displaying a real bid/ask.
   */
  useEffect(() => {
    if (!symbol) {
      return;
    }

    let cancelled = false;

    void hyperliquidMarketData
      .getQuote(symbol)
      .then((quote) => {
        if (cancelled) {
          return;
        }

        setQuotes((previous) => ({
          ...previous,
          [quote.symbol]: quote,
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        eventBus.emit({
          type: 'LOG',
          data: {
            id: `quote-load-error:${Date.now()}`,
            timestamp: Date.now(),
            level: 'error',
            message:
              error instanceof Error
                ? error.message
                : String(error),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [symbol]);


  // ==========================================================
  // REALTIME BAR SUBSCRIPTION
  // ==========================================================

  useEffect(() => {
    if (!symbol) {
      return;
    }

    const unsubscribeBars =
      hyperliquidMarketData.subscribeBars(
        symbol,
        timeframe,
        (bar) => {
          setBars((previous) => {
            const index =
              previous.findIndex(
                (candidate) =>
                  candidate.time ===
                  bar.time
              );

            if (index < 0) {
              return [
                ...previous,
                bar,
              ].slice(-260);
            }

            return previous.map(
              (
                candidate,
                candidateIndex
              ) =>
                candidateIndex ===
                index
                  ? bar
                  : candidate
            );
          });
        }
      );

    return () => {
      unsubscribeBars();
    };
  }, [symbol, timeframe]);


  // ==========================================================
  // EQUITY
  // ==========================================================

  const equity = useMemo(() => {
    const unrealized =
      positions.reduce(
        (sum, position) =>
          sum +
          position.unrealizedPnL,
        0
      );

    return Number(
      (
        balance +
        unrealized
      ).toFixed(2)
    );
  }, [balance, positions]);


// ==========================================================
  // EXECUTION STATE MIRROR
  // ==========================================================

  /*
   * The execution adapter owns execution state.
   *
   * Positions, account balance, and closed trades are projected from
   * the adapter here instead of being rebuilt locally, so manual and
   * agent-driven execution cannot produce two competing views of the
   * same order.
   */
  useEffect(() => {
    const refreshFromAdapter = () => {
      void hyperliquidDemoAdapter
        .getPositions()
        .then((nextPositions) => {
          setPositions(nextPositions);
        });

      void hyperliquidDemoAdapter
        .getAccountState()
        .then((account) => {
          setBalance(account.balance);
          setMargin(account.margin);
          setFreeMargin(account.freeMargin);
        });
    };

    const unsubscribers = [
      eventBus.on('POSITION_OPEN', () => {
        refreshFromAdapter();
      }),

      eventBus.on('POSITION_UPDATE', () => {
        refreshFromAdapter();
      }),

      eventBus.on('POSITION_CLOSE', (event) => {
        const closedTrade = event.data.trade;

        setTrades((previous) => [
          closedTrade,
          ...previous.filter(
            (trade) =>
              trade.id !== closedTrade.id
          ),
        ]);

        refreshFromAdapter();
      }),
    ];

    refreshFromAdapter();

    return () => {
      unsubscribers.forEach(
        (unsubscribe) =>
          unsubscribe()
      );
    };
  }, []);


  // ==========================================================
  // EXECUTE ORDER
  // ==========================================================

  const handleExecuteOrder = async (params: {
  symbol: string;
  side: OrderSide;
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
}): Promise<{
    success: boolean;
    message?: string;
    category?: string;
  }> => {
  /*
   * Frontend execution is currently Demo-only.
   *
   * The execution adapter decides whether the order can be filled and
   * at which real Hyperliquid price (BUY -> ask, SELL -> bid). It also
   * owns the resulting position, order id, and execution events, so
   * nothing is reconstructed here.
   *
   * No wallet/private key/signing credentials are used here.
   */
  const execution =
    await hyperliquidDemoAdapter.placeMarketOrder(params);

  if (!execution.success) {
    /*
     * The deterministic layer decides. The UI receives the same
     * user-safe message that is written to the activity log, so a
     * manual order and an agent order are blocked for the same stated
     * reason.
     */
    const message =
      execution.rejection?.message ??
      'The execution adapter rejected this order.';

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `order-rejected:${Date.now()}`,
        timestamp: Date.now(),
        level: 'error',
        message: execution.rejection?.detail
          ? `${message} (${execution.rejection.detail})`
          : message,
        data: {
          category: execution.rejection?.category,
          symbol: params.symbol,
          side: params.side,
        },
      },
    });

    return {
      success: false,
      message,
      category: execution.rejection?.category,
    };
  }

  return { success: true };
};


  // ==========================================================
  // CLOSE POSITION
  // ==========================================================

  const handleClosePosition = async (
    positionId: string
  ) => {
    /*
     * Closing is an execution action: the adapter fetches the live
     * quote, prices the exit (BUY -> bid, SELL -> ask), realizes the
     * P&L, updates the balance, and emits POSITION_CLOSE with the
     * resulting Trade.
     */
    const execution =
      await hyperliquidDemoAdapter.closePosition(
        positionId,
      );

    if (!execution.success) {
      eventBus.emit({
        type: 'LOG',
        data: {
          id: `close-rejected:${Date.now()}`,
          timestamp: Date.now(),
          level: 'error',
          message:
            execution.error ??
            'The execution adapter could not close this position.',
        },
      });
    }
  };
  // BOT ACTIVITY
  // ==========================================================

  const handleGetBotActivity = async (
    goatId: string
  ): Promise<AgentTimelineEvent[]> => {
    const store =
      agentRuntime.getTimelineStore();

    return store.getByGoat
      ? store.getByGoat(
          goatId,
          {
            limit: 100,
          }
        )
      : [];
  };


  // ==========================================================
  // EMERGENCY KILL SWITCH
  // ==========================================================

  const handleEmergencyKillSwitch =
    () => {
      /*
       * Engage the engine's kill switch first, before anything else.
       *
       * Order matters. The flatten below submits real closes, and if the
       * switch is not already on in `riskManager` those closes race new
       * opens from a running agent. Setting the React state first and the
       * engine second left a window where the UI claimed trading was
       * halted while the engine still allowed orders.
       */
      riskManager.setKillSwitch(
        true
      );

      // Read the flag back from the engine rather than assuming the
      // value we just asked for, so the interface and the gate cannot
      // drift apart.
      setIsKillSwitchActive(
        riskManager.isKillSwitchActive()
      );

      /*
       * Close every currently open position.
       *
       * Each close is a floating promise that can reject (a vanished
       * position, a failed quote). Collecting the failures means the user
       * finds out which position did not close instead of the rejection
       * disappearing into the console.
       */
      const flattenFailures: string[] = [];
      positions.forEach((position) => {
        void handleClosePosition(
          position.id
        ).catch((error: unknown) => {
          flattenFailures.push(`${position.symbol}: ${(error as Error).message}`);
        });
      });
      if (flattenFailures.length > 0) {
        setSafetyNotice(
          `Kill switch engaged, but ${flattenFailures.length} position(s) did not close: ${flattenFailures.join('; ')}`,
        );
      }

      /*
       * Stop every running agent.
       *
       * This used to iterate a `bots` array held in React state, which
       * meant the kill switch only knew about agents something had
       * remembered to record. The runtime is the authority on what is
       * running, so the kill switch asks the runtime — otherwise a GOAT
       * the UI had lost track of would have kept its trackers alive
       * through a kill switch, which is the opposite of what a kill
       * switch is for.
       */
      for (const instance of agentRuntime.listAgents()) {
        if (instance.isRunning) {
          void agentRuntime.stop(instance.agent.id);
        }
      }

      setShowKillSwitchModal(
        false
      );
    };


  // ==========================================================
  // EXECUTION MODE
  // ==========================================================

  /*
   * Execution-mode selection.
   *
   * LIVE is not implemented: `handleModeSelect` never sets it, and asking
   * for it opens a notice explaining why instead. This is the only place
   * the execution mode is written, so a connected wallet — or anything else
   * — cannot turn a connected session into live trading.
   *
   * Two separate notions, deliberately not merged: the execution mode here
   * is what fills are simulated as, while `venueEnvironment` is which
   * Hyperliquid network the data comes from. A GOAT's own deployment mode
   * is a third, and refuses LIVE outright.
   */
  const handleModeSelect = (
    mode: ExecutionMode
  ) => {
    if (
      mode ===
      'LIVE'
    ) {
      setShowLiveConfirm(
        true
      );

      return;
    }

    setExecutionMode(
      mode
    );
  };


  // ==========================================================
  // READ-ONLY AI APPLICATION CONTEXT
  // ==========================================================

  /*
   * The assistant reads from a sanitised projection of state the app
   * already has. It cannot write, cannot reach the execution adapter or
   * the wallet provider, and every payload is checked for
   * credential-shaped keys before it leaves the store.
   *
   * Throttled, because `quotes` is a dependency and quotes arrive
   * continuously: rebuilding every position, trade and instrument on each
   * tick put a long synchronous handler in the browser's message loop for
   * no benefit, since a person cannot read a balance faster than twice a
   * second. The projection may therefore lag real state by up to half a
   * second, which is the right trade for a read-only view of it.
   */
  useEffect(() => {
    const publish = () => appContextStore.publish({
      currentTab,
      currentView: currentViewLabel(currentTab),
      selectedMarket: symbol || undefined,
      selectedTimeframe: timeframe,
      selectedGoatId: selectedGoatIdRef.current || undefined,
      executionMode,
      account: {
        balance,
        equity,
        marginUsed: margin,
        freeMargin,
        unrealizedPnL: positions.reduce(
          (sum, position) => sum + position.unrealizedPnL,
          0
        ),
        realizedPnlToday: trades.reduce(
          (sum, trade) => sum + trade.pnl,
          0
        ),
        openPositions: positions.length,
        openTrades: trades.length,
        runningGoats: goatOrchestrator.stores.goals
          .list()
          .filter((goal) => goal.status === 'MONITORING').length,
        environment: executionMode,
        liveExecutionAvailable: false,
        accountCurrency: ACCOUNT_CURRENCY,
        riskState: isKillSwitchActive
          ? 'KILL_SWITCH'
          : freeMargin <= 0
            ? 'EXPOSURE_LIMITED'
            : 'NORMAL',
      },
      positions: positions.map((position) => ({
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        quantity: position.volume,
        entryPrice: position.entryPrice,
        markPrice: position.currentPrice,
        unrealizedPnL: position.unrealizedPnL,
        unrealizedPnlPercent: position.unrealizedPnlPercent,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        openedAt: position.timestamp,
        goatId: position.goatId,
        goatName: position.goatName,
      })),
      trades: trades.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        quantity: trade.volume,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        realizedPnl: trade.pnl,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        exitReason: trade.exitReason,
        goatId: trade.goatId,
        goatName: trade.goatName,
      })),
      markets: instruments.map((instrument) => ({
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        assetClass: instrument.assetClass,
        providerSymbol: instrument.providerSymbol,
        availability: instrument.availability,
        unavailableReason: instrument.unavailableReason,
        bid: quotes[instrument.symbol]?.bid,
        ask: quotes[instrument.symbol]?.ask,
        lastPrice: instrument.market?.lastPrice,
        change24h: instrument.market?.change24h,
        pricePrecision: instrument.pricePrecision,
        sizePrecision: instrument.sizePrecision,
        sizeStep: instrument.sizeStep,
        minOrderSize: instrument.minOrderSize,
        maxOrderSize: instrument.maxOrderSize,
        maxLeverage: instrument.maxLeverage,
        quoteCurrency: instrument.quoteCurrency,
      })),
      /*
       * The AI context reports what the user is actually pursuing.
       *
       * A GOAT has no hand-authored observation plan to summarise — that
       * is the point of the architecture — so what is reported is the
       * goal, and what it has chosen to watch so far.
       */
      goats: [
        ...goatOrchestrator.stores.goals.list().map((goal) => ({
          id: goal.id,
          statement: goal.statement,
          status: goal.status,
          skills: goal.skillIds,
          updatedAt: goal.updatedAt,
        })),
        ...starterGoatContext(),
      ],
      riskLimits: {
        ...riskManager.getLimits(),
        killSwitchActive: isKillSwitchActive,
      },
      wallet: {
        status: walletState.status,
        authenticated: walletState.authenticated,
        address: walletState.address,
        shortAddress: walletState.shortAddress,
        configured: walletState.configured,
        liveExecutionEnabled: false,
      },
    });

    const now = Date.now();
    const since = now - contextPublishRef.current.last;
    if (since >= CONTEXT_PUBLISH_INTERVAL_MS) {
      contextPublishRef.current.last = now;
      publish();
      return;
    }
    if (contextPublishRef.current.timer !== null) return;
    contextPublishRef.current.timer = window.setTimeout(() => {
      contextPublishRef.current.timer = null;
      contextPublishRef.current.last = Date.now();
      publish();
    }, CONTEXT_PUBLISH_INTERVAL_MS - since);
  }, [
    currentTab, symbol, timeframe, executionMode, balance, equity, margin,
    freeMargin, positions, trades, instruments, quotes, goatOrchestrator,
    isKillSwitchActive, walletState,
  ]);

  // A pending publish must not fire into an unmounted tree.
  useEffect(
    () => () => {
      if (contextPublishRef.current.timer !== null) {
        window.clearTimeout(contextPublishRef.current.timer);
        contextPublishRef.current.timer = null;
      }
    },
    [],
  );


  // ==========================================================
  // CONDITION PREVIEW CONTEXT
  // ==========================================================

  /*
   * The condition preview needs the same state a tracker evaluation would
   * see. It is read-only and lives entirely in the client; the backtest
   * provider is only consulted when the user explicitly loads a range.
   */
  const conditionPreviewContext: TrackerConditionContext | undefined = useMemo(() => {
    if (!symbol) return undefined;

    const instrument = instruments.find(
      (candidate) => candidate.symbol === symbol
    );

    const quote = quotes[symbol];

    return {
      state: {
        timestamp: Date.now(),
        environment: executionMode,
        symbol,
        timeframe,
        price: quote
          ? (quote.bid + quote.ask) / 2
          : instrument?.market?.lastPrice,
        spread: quote?.spread,
        bars,
        positions: positions
          .filter((position) => position.symbol === symbol)
          .map((position) => ({
            id: position.id,
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            currentPrice: position.currentPrice,
            volume: position.volume,
            stopLoss: position.stopLoss,
            takeProfit: position.takeProfit,
          })),
      },
      instrument,
    };
  }, [symbol, instruments, quotes, bars, positions, timeframe, executionMode]);


  // ==========================================================
  // DISCOVERED SYMBOLS
  // ==========================================================

  /*
   * TradingInstrument.market is already the canonical MarketSymbol.
   *
   * Do not reconstruct MarketSymbol here with marketSymbol().
   * That previously reset provider-backed fields such as spread,
   * change, high, and low to synthetic/default values.
   */
  const discoveredSymbols = useMemo(
    () =>
      instruments
        .map((instrument) =>
          instrument.market
        )
        .filter(
          (
            market
          ): market is NonNullable<
            TradingInstrument['market']
          > => Boolean(market)
        ),
    [instruments]
  );


  // ==========================================================
  // RENDER
  // ==========================================================

  return (
    /*
     * App shell.
     *
     * Scrolling model: the *document* is the only vertical scroll region.
     * The sidebar and the header are `sticky`, so they stay put while the
     * content column flows and scrolls at the viewport edge. Nothing here
     * may set a height constraint or `overflow: hidden` on the shell, the
     * sidebar, the header, or `<main>` - that is what previously trapped
     * the page inside an inner scroll box on desktop.
     */
    <div className="flex min-h-screen w-full flex-col md:flex-row bg-bg text-ink-2">

      {/* =====================================================
          BOTTOM NAV
          ===================================================== */}

      <BottomNav
        activeTab={
          currentTab
        }

        onTabChange={(tab) => {
          setCurrentTab(
            tab
          );

          setShowDocsView(
            false
          );

          setShowProfileView(
            false
          );
        }}

        openPositionsCount={
          positions.length
        }

        runningGoatsCount={
          goatOrchestrator.stores.goals
            .list()
            .filter((goal) => goal.status === 'MONITORING')
            .length
        }

        user={
          user ||
          undefined
        }

        onOpenProfile={() =>
          setShowProfileView(
            true
          )
        }

        connectionStatus={
          connectionStatus
        }
      />


      {/* =====================================================
          MAIN APPLICATION
          ===================================================== */}

      <div className="flex min-w-0 flex-1 flex-col">

        {/* ===================================================
            MOBILE / TOP HEADER
            =================================================== */}

        {/*
         * A safety notice is rendered above everything else and cannot be
         * dismissed by accident: if the emergency flatten only partly
         * worked, that fact outranks whatever the user was doing.
         */}
        {safetyNotice && (
          <div
            role="alert"
            className="sticky top-0 z-[100] flex items-start gap-3 border-b border-neg/50 bg-neg-soft/95 px-4 py-3 text-xs text-neg backdrop-blur"
          >
            <span className="flex-1">{safetyNotice}</span>
            <button
              type="button"
              onClick={() => setSafetyNotice(null)}
              className="shrink-0 rounded border border-neg/40 px-2 py-0.5 text-[10px] font-bold uppercase"
            >
              Dismiss
            </button>
          </div>
        )}

        <MobileHeader
          executionMode={
            executionMode
          }

          venueEnvironment={
            venueEnvironment
          }

          onToggleMode={
            handleModeSelect
          }

          connectionStatus={
            connectionStatus
          }

          /*
           * No fabricated latency value.
           */
          pingMs={
            undefined
          }

          isKillSwitchActive={
            isKillSwitchActive
          }

          onOpenKillSwitch={() =>
            setShowKillSwitchModal(
              true
            )
          }

          onOpenAI={() =>
            setAiOpenRequest(
              (count) =>
                count + 1
            )
          }

          onOpenWalletSettings={() => {
            setShowProfileView(false);
            setShowDocsView(false);
            setCurrentTab('settings');
          }}
        />


        {/* ===================================================
            MAIN CONTENT
            =================================================== */}

        <main className="flex min-w-0 flex-1 flex-col">

          {/* =================================================
              PROFILE
              ================================================= */}

          {showProfileView ? (
            <ProfileView
              onBack={() =>
                setShowProfileView(
                  false
                )
              }

              onUserUpdated={(
                updatedUser
              ) =>
                setUser(
                  updatedUser
                )
              }
            />

          ) : showDocsView ? (

            /* ===============================================
               DOCS
               =============================================== */

            <div className="mx-auto w-full max-w-4xl p-4">

              <button
                onClick={() =>
                  setShowDocsView(
                    false
                  )
                }

                className="mb-3 text-xs font-semibold text-accent hover:text-accent-ink"
              >
                ← Back to Settings
              </button>

              <DocsView />

            </div>

          ) : currentTab === 'goat' ? (

            /* ===============================================
               GOAT — Goal-Oriented Agentic Trader
               =============================================== */

            <GoatView
              onRefreshRequest={(
                request,
              ) => {
                requestGoatViewRefresh =
                  request;
              }}

              onOpenAISettings={() =>
                setShowAIModal(
                  true
                )
              }

              orchestrator={
                goatOrchestrator
              }

              markets={
                marketsFromDiscovery(
                  instruments
                )
                  .filter(
                    (market) =>
                      market.tradeable
                  )
                  .map(
                    (market) =>
                      market.id
                  )
              }            />

          ) : currentTab === 'trades' ? (

            /* ===============================================
               TRADES
               =============================================== */

            <TradesTab
              balance={
                balance
              }

              equity={
                equity
              }

              margin={
                margin
              }

              freeMargin={
                freeMargin
              }

              positions={
                positions
              }

              trades={
                trades
              }

              executionMode={
                executionMode
              }

              onClosePosition={
                handleClosePosition
              }

              onOpenMarket={(
                selectedSymbol
              ) => {
                setSymbol(
                  selectedSymbol
                );

                setCurrentTab(
                  'quotes'
                );
              }}

              onOpenBots={() =>
                setCurrentTab(
                  'goat'
                )
              }

              onAskAI={(ctx) => {
                if (
                  !requireOpenRouterKey()
                ) {
                  return;
                }

                setExternalAIPrompt(
                  `Analyze my trade on ${
                    ctx.selectedMarket ||
                    'this position'
                  }`
                );
              }}
            />

          ) : currentTab === 'quotes' ? (

            /* ===============================================
               QUOTES
               =============================================== */

            <QuotesTab
              /*
               * Use markets discovered from Hyperliquid.
               * Live bid/ask/spread are supplied separately through
               * the real Quote map below.
               */
              symbols={
                discoveredSymbols
              }

              quotes={
                quotes
              }

              bars={
                bars
              }

              positions={
                positions
              }

              signals={
                signals
              }

              trades={
                trades
              }

              currentTimeframe={
                timeframe
              }

              onTimeframeChange={(
                nextTimeframe
              ) =>
                setTimeframe(
                  nextTimeframe
                )
              }

              onSelectSymbol={(
                selectedSymbol
              ) =>
                setSymbol(
                  selectedSymbol
                )
              }

              onExecuteOrder={
                handleExecuteOrder
              }

              onAskAI={(ctx) => {
                if (
                  !requireOpenRouterKey()
                ) {
                  return;
                }

                setExternalAIPrompt(
                  `Provide technical analysis and key levels for ${
                    ctx.selectedMarket ||
                    symbol
                  }`
                );
              }}
            />

          ) : currentTab === 'history' ? (

            /* ===============================================
               HISTORY
               =============================================== */

            <HistoryTab
              trades={
                trades
              }

              onAskAI={(ctx) => {
                if (
                  !requireOpenRouterKey()
                ) {
                  return;
                }

                setExternalAIPrompt(
                  `Audit this historical trade on ${
                    ctx.selectedMarket ||
                    'instrument'
                  }`
                );
              }}
            />

          ) : (

            /* ===============================================
               SETTINGS
               =============================================== */

            <SettingsTab
              executionMode={
                executionMode
              }

              user={
                user
              }

              onOpenProfile={() =>
                setShowProfileView(
                  true
                )
              }

              onOpenHyperliquidSettings={() =>
                setShowHyperliquidModal(
                  true
                )
              }

              onOpenAISettings={() =>
                setShowAIModal(
                  true
                )
              }

              onOpenKillSwitchModal={() =>
                setShowKillSwitchModal(
                  true
                )
              }

              isKillSwitchActive={
                isKillSwitchActive
              }

              onOpenDocs={() =>
                setShowDocsView(
                  true
                )
              }

              openRouterConfig={
                openRouterConfig
              }

              accountStats={{
                goatsCount:
                  goatOrchestrator.stores.goals
                    .list()
                    .filter(
                      (goal) =>
                        goal.status === 'MONITORING',
                    ).length,

                tradesCount:
                  trades.length,

                connectedAccounts:
                  0,
              }}
            />
          )}

        </main>


        {/* ===================================================
            FLOATING AI ASSISTANT
            =================================================== */}

        <FloatingAIAssistant
          openPositions={
            positions
          }

          onClosePosition={
            handleClosePosition
          }

          externalPrompt={
            externalAIPrompt
          }

          openRequest={
            aiOpenRequest
          }

          onClearExternalPrompt={() =>
            setExternalAIPrompt(
              null
            )
          }

          hasProviderKey={
            hasOpenRouterKey()
          }

          onOpenProviderSettings={() =>
            setShowAIModal(
              true
            )
          }

          onSelectMarket={(next) => {
            setSymbol(
              next
            );

            setCurrentTab(
              'quotes'
            );
          }}

          onInspectTracker={() =>
            setCurrentTab(
              'goat'
            )
          }

          onTestCondition={() =>
            setCurrentTab(
              'goat'
            )
          }

          onGoatControl={async (
            control,
          ) => {
            /*
             * A GOAT runtime change, pressed by a person.
             *
             * The assistant puts a confirmation card on screen and nothing
             * more; this is where the button lands. There is no path from
             * model output to any of these three methods.
             */
            try {
              if (
                control.kind ===
                'stop'
              ) {
                await goatOrchestrator.stopGoat(
                  control.goalId,
                  'Stopped from the assistant.',
                );
                goatViewRefresh();
                return {
                  ok: true,
                  message: `Stopped. Its goal, thesis, evidence and any trade plan are kept, so you can play it again from the GOAT screen.`,
                };
              }

              if (
                control.kind ===
                'resume'
              ) {
                const resumed =
                  await goatOrchestrator.resumeGoat(
                    control.goalId,
                  );
                goatViewRefresh();
                return {
                  ok: true,
                  message: resumed.alreadyRunning
                    ? 'It was already running.'
                    : `Resumed on the same deployment. ${resumed.investigation.message}`,
                };
              }

              const steered =
                await goatOrchestrator.steerGoat(
                  control.goalId,
                  control.text ??
                    '',
                );
              goatViewRefresh();
              return {
                ok: true,
                message: steered.woke
                  ? 'Sent. It will read that the next time it wakes — it is guidance, not a new goal.'
                  : 'Recorded. It is not deployed, so it will read that when it next starts.',
              };
            } catch (
              caught: unknown
            ) {
              return {
                ok: false,
                message: caught instanceof Error
                  ? caught.message
                  : String(caught),
              };
            }
          }}

          onNavigate={(
            target
          ) => {
            /*
             * Navigation only. The assistant can move the user between
             * screens; it can never place, modify, or close a trade, and
             * it can never change the execution environment.
             */
            const tab = tabForNavigation(target);

            if (!tab) {
              return;
            }

            setShowProfileView(
              false
            );

            setShowDocsView(
              false
            );

            setCurrentTab(
              tab
            );
          }}
        />



      </div>


      {/* =====================================================
          HYPERLIQUID SETTINGS
          ===================================================== */}

      <HyperliquidSettingsModal
        isOpen={
          showHyperliquidModal
        }

        environment={
          venueEnvironment
        }

        status={
          connectionStatus
        }

        onSave={(environment) => {
          setVenueEnvironment(
            environment
          );

          // Changing the environment re-reads every market and drops
          // every cached series, sequence memory and quote from the
          // other one, so nothing crosses over.
          void hyperliquidMarketData
            .setEnvironment(
              environment
            );
        }}

        onClose={() =>
          setShowHyperliquidModal(
            false
          )
        }
      />


      {/* =====================================================
          OPENROUTER SETTINGS
          ===================================================== */}

      <OpenRouterSettingsModal
        isOpen={
          showAIModal
        }

        config={
          openRouterConfig
        }

        onSave={(newConfig) => {
          openRouterProvider.saveConfig(
            newConfig
          );

          setOpenRouterConfig(
            openRouterProvider.getConfig()
          );
        }}

        onClose={() =>
          setShowAIModal(
            false
          )
        }
      />


      {/* =====================================================
          KILL SWITCH
          ===================================================== */}

      <KillSwitchModal
        isOpen={
          showKillSwitchModal
        }

        isEngaged={
          isKillSwitchActive
        }

        openPositionsCount={
          positions.length
        }

        onToggleKillSwitch={
          () => {
            /*
             * The kill switch is a safety control, and `riskManager` is
             * the only thing that actually blocks an order. Toggling the
             * React state alone left the header saying "Trading is halted"
             * while `validateOrder` still returned valid, so every manual
             * and agent order kept filling. The two must move together:
             * the engine is the source of truth and the UI mirrors it.
             */
            setIsKillSwitchActive((previous) => {
              const next = !previous;
              riskManager.setKillSwitch(next);
              return next;
            });
          }
        }

        onFlattenAllPositions={
          handleEmergencyKillSwitch
        }

        onClose={() =>
          setShowKillSwitchModal(
            false
          )
        }
      />


      {/* =====================================================
          LIVE CONFIRMATION
          ===================================================== */}

      <LiveConfirmModal
        isOpen={
          showLiveConfirm
        }

        onClose={() =>
          setShowLiveConfirm(
            false
          )
        }
      />

    </div>
  );
}

export default App;