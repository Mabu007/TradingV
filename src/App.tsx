import React, { useEffect, useMemo, useState } from 'react';

import {
  agentRuntime,
  DemoEnvironment,
  TradingAgent,
} from './engine/agents';

import {
  BotDefinition,
  Deployment,
  createDeployment,
} from './engine/agents/botDefinition';

import {
  BotBacktestProgress,
  BotBacktestResult,
  runBotDefinitionBacktest,
} from './engine/agents/backtest';

import { AgentTimelineEvent } from './engine/agents/timeline';

import {
  TriggerEngine,
  TriggerRegistry,
  AgentTrigger,
} from './engine/agents/triggers';

import { MobileHeader } from './components/navigation/MobileHeader';
import { BottomNav } from './components/navigation/BottomNav';

import { TradesTab } from './components/views/TradesTab';
import { QuotesTab } from './components/views/QuotesTab';
import { BotsTab } from './components/views/BotsTab';
import { HistoryTab } from './components/views/HistoryTab';
import { SettingsTab } from './components/views/SettingsTab';

import { FloatingAIAssistant } from './components/ai/FloatingAIAssistant';

import { DocsView } from './components/views/DocsView';
import { ProfileView } from './components/views/ProfileView';

import { User, userService } from './services/userService';
import { ConnectionStatus } from './types/quotes';

import { LiveConfirmModal } from './components/layout/LiveConfirmModal';
import { HyperliquidSettingsModal } from './components/layout/HyperliquidSettingsModal';
import { OpenRouterSettingsModal } from './components/layout/OpenRouterSettingsModal';
import { KillSwitchModal } from './components/layout/KillSwitchModal';

import {
  BacktestResult,
  Bar,
  Bot,
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

import { MainTab, AIContext } from './types/aiContext';
import { eventBus } from './types/events';

import { marketDataService } from './services/marketData';
import { SAMPLE_STRATEGIES } from './services/strategies';

import { historicalMarketDataProvider } from './engine/backtester/historical';

import { hyperliquidMarketData } from './adapters/hyperliquid/marketData';
import { hyperliquidDemoAdapter } from './adapters/hyperliquid/demo';

import { AIProviderConfig } from './adapters/openrouter/types';
import { openRouterProvider } from './adapters/openrouter/provider';


// ============================================================
// TRIGGER INFRASTRUCTURE
// ============================================================

const triggerRegistry = new TriggerRegistry(
  (agentId) => agentRuntime.getAgent(agentId)
);

const triggerEngine = new TriggerEngine(
  triggerRegistry,
  agentRuntime,
  agentRuntime.getTimelineStore()
);

triggerEngine.setEnvironment('DEMO');

let triggerEngineStarted = false;

function ensureTriggerEngineStarted() {
  if (triggerEngineStarted) {
    return;
  }

  triggerEngine.start();
  triggerEngineStarted = true;
}


// ============================================================
// APP
// ============================================================

function App() {
  // ----------------------------------------------------------
  // Core UI state
  // ----------------------------------------------------------

  const [currentTab, setCurrentTab] =
    useState<MainTab>('trades');

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

  /*
   * Explorer bots are templates.
   *
   * User-owned bots only appear here after the user actually
   * creates/clones/deploys one.
   */
  const [bots, setBots] =
    useState<Bot[]>([]);

  const [botDefinitions, setBotDefinitions] =
    useState<BotDefinition[]>([]);

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

  const [isKillSwitchActive, setIsKillSwitchActive] =
    useState(false);


  // ----------------------------------------------------------
  // User / connection
  // ----------------------------------------------------------

  const [user, setUser] =
    useState<User | null>(null);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('CONNECTING');


  // ----------------------------------------------------------
  // Hyperliquid public market-data configuration
  //
  // No signing credentials belong in the browser.
  // ----------------------------------------------------------

  const [hyperliquidNetwork, setHyperliquidNetwork] =
    useState<'testnet' | 'mainnet'>('mainnet');


  // ----------------------------------------------------------
  // OpenRouter BYO configuration
  // ----------------------------------------------------------

  const [openRouterConfig, setOpenRouterConfig] =
    useState<AIProviderConfig>(
      openRouterProvider.getConfig()
    );

  const [externalAIPrompt, setExternalAIPrompt] =
    useState<string | null>(null);

  const [aiCustomContext, setAiCustomContext] =
    useState<any>(null);


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
  // START TRIGGER ENGINE
  // ==========================================================

  useEffect(() => {
    ensureTriggerEngineStarted();

    return () => {
      /*
       * The trigger engine is module-level and shared by the app.
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



  // ==========================================================
  // TOGGLE BOT / AGENT
  // ==========================================================

  const handleToggleBotStatus = (
    botId: string
  ) => {
    const bot =
      bots.find(
        (candidate) =>
          candidate.id ===
          botId
      );

    if (!bot) {
      return;
    }


    // --------------------------------------------------------
    // Agent-based bot
    // --------------------------------------------------------

    if (bot.agentId) {
      if (
        bot.status ===
        'RUNNING'
      ) {
        void agentRuntime.stop(
          bot.agentId
        );

        setBots((previous) =>
          previous.map(
            (candidate) =>
              candidate.id ===
              botId
                ? {
                    ...candidate,

                    status:
                      'STOPPED',

                    lastSignal:
                      'Agent stopped',

                    lastActivity:
                      Date.now(),
                  }
                : candidate
          )
        );

        return;
      }


      /*
       * An AI agent cannot start without the user's
       * OpenRouter configuration.
       */
      if (
        !requireOpenRouterKey()
      ) {
        return;
      }

      ensureTriggerEngineStarted();

      void agentRuntime.start(
        bot.agentId
      );

      setBots((previous) =>
        previous.map(
          (candidate) =>
            candidate.id ===
            botId
              ? {
                  ...candidate,

                  status:
                    'RUNNING',

                  lastSignal:
                    'Agent running — waiting for trigger',

                  lastActivity:
                    Date.now(),
                }
              : candidate
        )
      );

      return;
    }


    // --------------------------------------------------------
    // Legacy bot
    //
    // Kept for backwards compatibility with existing Bot
    // objects. New AI bots should use agentId.
    // --------------------------------------------------------

    setBots((previous) =>
      previous.map((candidate) => {
        if (
          candidate.id !==
          botId
        ) {
          return candidate;
        }

        const nextStatus =
          candidate.status ===
          'RUNNING'
            ? 'STOPPED'
            : 'RUNNING';

        return {
          ...candidate,

          status:
            nextStatus,

          lastActivity:
            Date.now(),
        };
      })
    );
  };


  // ==========================================================
  // CREATE TRADING AGENT
  // ==========================================================

  const handleCreateBot = (botData: {
    name: string;
    symbol: string;
    timeframe: Timeframe;
    strategyCode: string;
    definition?: BotDefinition;
    deployment?: Deployment;
  }) => {
    /*
     * BotDefinition-based bots are AI agents.
     *
     * Do not create/deploy them without an OpenRouter key.
     */
    if (
      botData.definition &&
      !requireOpenRouterKey()
    ) {
      return;
    }

    const now =
      Date.now();

    const botId =
      `bot_${now}`;

    const agentId =
      `agent_${now}`;


    // ========================================================
    // CANONICAL BOT DEFINITION PATH
    // ========================================================

    if (botData.definition) {
      try {
        const deployment =
          botData.deployment ||
          createDeployment(
            {
              id:
                `${botData.definition.identity.id}-${now}`,

              /*
               * The BotDefinition itself remains asset-agnostic.
               * The deployment binds it to the selected market.
               */
              botId:
                botData.definition.identity.id,

              marketId:
                botData.symbol,

              accountId:
                'paper-account',

              mode:
                'demo',

              status:
                'active',
            },
            now
          );

        const demoEnvironment =
          new DemoEnvironment();

        const instance =
          agentRuntime.registerBot(
            botData.definition,
            deployment,
            botData.symbol,
            demoEnvironment
          );

        triggerRegistry.registerBotTriggers(
          botData.definition,
          instance.agent.id,
          botData.symbol
        );

        ensureTriggerEngineStarted();

        void agentRuntime.start(
          instance.agent.id
        );

        const newBot: Bot = {
          id:
            botId,

          name:
            botData.definition.identity.name,

          strategyId:
            `bot-definition:${botData.definition.identity.id}`,

          symbol:
            botData.symbol,

          timeframe:
            botData.timeframe,

          mode:
            'DEMO',

          status:
            'RUNNING',

          lastSignal:
            'Agent running — waiting for trigger',

          lastActivity:
            now,

          positionsCount:
            0,

          totalPnl:
            0,

          startedAt:
            now,

          agentId:
            instance.agent.id,
        };

        setBots((previous) => [
          newBot,
          ...previous,
        ]);

        setBotDefinitions((previous) => [
          botData.definition!,
          ...previous.filter(
            (definition) =>
              definition.identity.id !==
              botData.definition!.identity.id
          ),
        ]);
      } catch (error) {
        console.error(
          'Failed to deploy BotDefinition:',
          error
        );
      }

      return;
    }


    // ========================================================
    // LEGACY / DIRECT AGENT PATH
    // ========================================================

    const agent: TradingAgent = {
      id:
        agentId,

      name:
        botData.name,

      description:
        `Trading agent created from the user's strategy request for ${botData.symbol}.`,

      instructions:
        `
You are the trading agent "${botData.name}".

Strategy instructions:
${botData.strategyCode}

Operate only within the configured policy.

Before making any trading decision:
1. Observe current market conditions.
2. Use the available market and technical-analysis capabilities.
3. Check account state and existing positions.
4. Check risk before opening a position.
5. If conditions are unclear, WAIT.

Never exceed the configured risk policy.
Never trade outside the allowed symbol or session.
Never invent market data.
Never invent account data.
Explain the reason for every trading decision.
        `.trim(),

      skills: [
        'market-observation',
        'technical-analysis',
        'risk-management',
        'position-sizing',
        'trade-entry',
        'trade-management',
      ],

      capabilities: [
        'market.getQuote',
        'market.getBars',
        'market.getSpread',
        'market.getSession',

        'indicators.sma',
        'indicators.ema',
        'indicators.rsi',
        'indicators.atr',

        'structure.swingHighs',
        'structure.swingLows',
        'structure.supportResistance',
        'structure.breakout',

        'account.getEquity',
        'account.getPositions',

        'risk.calculateRisk',
        'risk.calculateExposure',
        'risk.calculatePositionSize',
        'risk.checkTrade',

        'orders.market',

        'positions.modifyStopLoss',
        'positions.close',
      ],

      policy: {
        maxRiskPerTrade:
          0.01,

        maxDailyLoss:
          500,

        maxDrawdown:
          0.05,

        maxOpenPositions:
          1,

        maxExposure:
          50000,

        maxOrdersPerMinute:
          6,

        allowedSymbols: [
          botData.symbol,
        ],

        allowedSessions: [
          'LONDON',
          'NEW_YORK',
          'OVERLAP',
        ],

        allowTrading:
          true,
      },

      preferredEnvironment:
        'DEMO',

      symbols: [
        botData.symbol,
      ],

      timeframe:
        botData.timeframe,

      enabled:
        true,

      createdAt:
        now,

      updatedAt:
        now,
    };


    try {
      const demoEnvironment =
        new DemoEnvironment();

      agentRuntime.registerAgent(
        agent,
        demoEnvironment
      );


      // ------------------------------------------------------
      // Default NEW_BAR trigger
      // ------------------------------------------------------

      const defaultTrigger: AgentTrigger = {
        id:
          `trigger_${now}`,

        agentId,

        type:
          'NEW_BAR',

        enabled:
          true,

        symbol:
          botData.symbol,

        timeframe:
          botData.timeframe,

        config:
          {},

        priority:
          10,

        cooldownMs:
          1000,

        maxFiringsPerMinute:
          20,

        createdAt:
          now,

        updatedAt:
          now,
      };

      triggerRegistry.register(
        defaultTrigger
      );


      // ------------------------------------------------------
      // Create user-owned bot
      // ------------------------------------------------------

      const newBot: Bot = {
        id:
          botId,

        name:
          botData.name,

        strategyId:
          `agent_strategy_${now}`,

        symbol:
          botData.symbol,

        timeframe:
          botData.timeframe,

        mode:
          'DEMO',

        status:
          'STOPPED',

        lastSignal:
          'Agent ready — start in Demo',

        lastActivity:
          now,

        positionsCount:
          0,

        totalPnl:
          0,

        startedAt:
          now,

        agentId,
      };

      setBots((previous) => [
        newBot,
        ...previous,
      ]);


      ensureTriggerEngineStarted();

      void agentRuntime.start(
        agentId
      );


      setBots((previous) =>
        previous.map((bot) =>
          bot.id === botId
            ? {
                ...bot,

                status:
                  'RUNNING',

                lastSignal:
                  'Agent running — waiting for trigger',

                lastActivity:
                  Date.now(),
              }
            : bot
        )
      );
    } catch (error) {
      console.error(
        'Failed to create trading agent:',
        error
      );
    }
  };


  // ==========================================================
  // BOT DEFINITION BACKTEST
  // ==========================================================

  const handleRunBotBacktest = async (
    definition: BotDefinition,
    marketId: string,
    botTimeframe: string,
    initialBalance: number,
    start: number,
    end: number,
    onProgress: (
      progress: BotBacktestProgress
    ) => void,
  ): Promise<BotBacktestResult> => {
    /*
     * AI backtests must use the user's own OpenRouter key.
     * There is intentionally no deterministic/fake AI fallback.
     */
    if (!requireOpenRouterKey()) {
      throw new Error(
        'OpenRouter API key required for AI bot backtesting.'
      );
    }

    const timeframeForData =
      botTimeframe as Timeframe;


    // --------------------------------------------------------
    // Real historical market data
    // --------------------------------------------------------

    const historical =
      await historicalMarketDataProvider.getBars({
        marketId,
        timeframe:
          timeframeForData,
        start,
        end,
      });


    if (
      !historical.bars ||
      historical.bars.length === 0
    ) {
      throw new Error(
        `No historical market data available for ${marketId}.`
      );
    }


    // --------------------------------------------------------
    // Backtest deployment
    // --------------------------------------------------------

    const deployment =
      createDeployment(
        {
          id:
            `${definition.identity.id}-backtest`,

          botId:
            definition.identity.id,

          marketId,

          accountId:
            'paper-account',

          mode:
            'paper',

          status:
            'active',
        }
      );


    // --------------------------------------------------------
    // Resolve instrument configuration
    // --------------------------------------------------------

    const instrument =
      marketDataService.getSymbol(
        marketId
      );

    if (!instrument) {
      throw new Error(
        `No trading instrument configuration found for ${marketId}.`
      );
    }


    // --------------------------------------------------------
    // Run canonical BotDefinition backtest
    // --------------------------------------------------------

    return runBotDefinitionBacktest({
      definition,

      deployment,

      /*
       * Market is bound at deployment/runtime level.
       * The BotDefinition itself remains asset-agnostic.
       */
      runtimeSymbol:
        marketId,

      timeframe:
        botTimeframe,

      bars:
        historical.bars,

      initialBalance,

      /*
       * Backtest cost model.
       *
       * Pips are supplied only for instruments that actually declare
       * one, so a commodity or index backtest is never sized in Forex
       * pips. The commission figure is an explicit simulation
       * assumption, not a Hyperliquid fee.
       */
      pipSize:
        instrument.pipSize,

      spreadPips:
        instrument.pipSize
          ? 0.8
          : 0,

      slippagePips:
        instrument.pipSize
          ? 0.2
          : 0,

      spreadPrice:
        instrument.pipSize
          ? undefined
          : 0,

      commissionPerLot:
        3.5,

      lotSize:
        instrument.lotSize ??
        100_000,

      pricePrecision:
        instrument.pricePrecision,

      gaps:
        historical.gaps,

      onProgress,
    });
  };


  // ==========================================================
  // BOT ACTIVITY
  // ==========================================================

  const handleGetBotActivity = async (
    botId: string
  ): Promise<AgentTimelineEvent[]> => {
    const store =
      agentRuntime.getTimelineStore();

    return store.getByBot
      ? store.getByBot(
          botId,
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
      setIsKillSwitchActive(
        true
      );

      /*
       * Close every currently open position.
       *
       * The kill switch also stops every UI-known running bot.
       */
      positions.forEach((position) => {
        void handleClosePosition(
          position.id
        );
      });

      bots.forEach((bot) => {
        if (
          bot.agentId &&
          bot.status ===
            'RUNNING'
        ) {
          void agentRuntime.stop(
            bot.agentId
          );
        }
      });

      setBots((previous) =>
        previous.map((bot) => ({
          ...bot,
          status:
            'STOPPED',
        }))
      );

      setShowKillSwitchModal(
        false
      );
    };


  // ==========================================================
  // EXECUTION MODE
  // ==========================================================

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
  // AI CONTEXT
  // ==========================================================

  const aiContext: AIContext = {
    currentTab,

    selectedMarket:
      symbol,

    accountBalance:
      balance,

    openPositionsCount:
      positions.length,

    activeBotsCount:
      bots.filter(
        (bot) =>
          bot.status ===
          'RUNNING'
      ).length,

    ...aiCustomContext,
  };


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
    <div className="flex flex-col md:flex-row h-screen w-screen overflow-hidden bg-[#070b13] text-slate-200 select-none">

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

        runningBotsCount={
          bots.filter(
            (bot) =>
              bot.status ===
              'RUNNING'
          ).length
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

      <div className="flex-1 flex flex-col h-full overflow-hidden relative">

        {/* ===================================================
            MOBILE / TOP HEADER
            =================================================== */}

        <MobileHeader
          executionMode={
            executionMode
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

          onOpenAI={() => {
            if (
              !requireOpenRouterKey()
            ) {
              return;
            }

            setExternalAIPrompt(
              'What is the current market overview?'
            );
          }}

          onOpenProfile={() =>
            setShowProfileView(
              true
            )
          }
        />


        {/* ===================================================
            MAIN CONTENT
            =================================================== */}

        <main className="flex-1 flex flex-col overflow-hidden relative">

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

            <div className="flex-1 overflow-y-auto p-4 max-w-4xl mx-auto w-full">

              <button
                onClick={() =>
                  setShowDocsView(
                    false
                  )
                }

                className="mb-3 text-xs font-semibold text-sky-400 hover:text-sky-300"
              >
                ← Back to Settings
              </button>

              <DocsView />

            </div>

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
                  'bots'
                )
              }

              onAskAI={(ctx) => {
                if (
                  !requireOpenRouterKey()
                ) {
                  return;
                }

                setAiCustomContext(
                  ctx
                );

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

                setAiCustomContext(
                  ctx
                );

                setExternalAIPrompt(
                  `Provide technical analysis and key levels for ${
                    ctx.selectedMarket ||
                    symbol
                  }`
                );
              }}
            />

          ) : currentTab === 'bots' ? (

            /* ===============================================
               BOTS / AGENTS
               =============================================== */

            <BotsTab
              bots={
                bots
              }

              strategies={
                strategies
              }

              executionMode={
                executionMode
              }

              onToggleBotStatus={
                handleToggleBotStatus
              }

              onCreateBot={
                handleCreateBot
              }

              /*
               * Legacy backtest callback remains available to
               * BotsTab for compatibility.
               *
               * It should not be used for AI BotDefinition
               * backtesting; onBacktestBot is the canonical path.
               */
              onRunBacktest={
                async () => null
              }

              onBacktestBot={
                handleRunBotBacktest
              }

              botDefinitions={
                botDefinitions
              }

              onSaveBotDefinition={(
                definition
              ) =>
                setBotDefinitions(
                  (current) => [
                    definition,

                    ...current.filter(
                      (item) =>
                        item.identity.id !==
                        definition.identity.id
                    ),
                  ]
                )
              }

              onGetBotActivity={
                handleGetBotActivity
              }

              backtestResult={
                backtestResult
              }

              onOpenAIWithPrompt={(
                prompt,
                ctx
              ) => {
                if (
                  !requireOpenRouterKey()
                ) {
                  return;
                }

                setAiCustomContext(
                  ctx
                );

                setExternalAIPrompt(
                  prompt
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

                setAiCustomContext(
                  ctx
                );

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
                botsCount:
                  bots.filter(
                    (bot) =>
                      bot.status ===
                      'RUNNING'
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
          context={
            aiContext
          }

          openPositions={
            positions
          }

          onClosePosition={
            handleClosePosition
          }

          externalPrompt={
            externalAIPrompt
          }

          onClearExternalPrompt={() =>
            setExternalAIPrompt(
              null
            )
          }
        />

      </div>


      {/* =====================================================
          HYPERLIQUID SETTINGS
          ===================================================== */}

      <HyperliquidSettingsModal
        isOpen={
          showHyperliquidModal
        }

        network={
          hyperliquidNetwork
        }

        onSave={(network) => {
          setHyperliquidNetwork(
            network
          );

          void hyperliquidMarketData
            .setNetwork(
              network
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

        onToggleKillSwitch={() =>
          setIsKillSwitchActive(
            (previous) =>
              !previous
          )
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

        onConfirm={() => {
          setExecutionMode(
            'LIVE'
          );

          setShowLiveConfirm(
            false
          );
        }}

        onCancel={() =>
          setShowLiveConfirm(
            false
          )
        }
      />

    </div>
  );
}

export default App;