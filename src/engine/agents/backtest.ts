import { Bar, EquityPoint, Trade } from '../../types/trading';
import { agentModel } from './model/openrouter';
import { IAgentModel } from './model/types';
import { actionValidator } from './policy/validator';
import {
  AgentTimelineEvent,
  InMemoryAgentTimelineStore,
} from './timeline';
import { capabilityRegistry } from './capabilities';
import { skillRegistry } from './skills';
import { AgentRuntime } from './runtime';
import { BacktestEnvironment } from './environment/backtest';
import { TriggerEngine } from './triggers/engine';
import { TriggerRegistry } from './triggers/registry';
import {
  BotDefinition,
  Deployment,
  compileBotDefinition,
  migrateBotDefinition,
  validateBotDefinition,
} from './botDefinition';

export interface BotBacktestOptions {
  definition: BotDefinition;
  deployment: Deployment;
  runtimeSymbol: string;
  timeframe: string;
  bars: Bar[];
  initialBalance: number;

  spreadPips?: number;
  spreadPrice?: number;
  commissionPerLot?: number;
  lotSize?: number;
  pipSize?: number;
  slippagePips?: number;
  slippagePrice?: number;
  pricePrecision?: number;

  gaps?: Array<{
    from: number;
    to: number;
  }>;

  model?: IAgentModel;

  onProgress?: (
    progress: BotBacktestProgress,
  ) => void;
}

export interface BotBacktestProgress {
  phase:
    | 'preparing'
    | 'replay'
    | 'settling'
    | 'complete';

  processed: number;
  total: number;
}

export interface BotBacktestTriggerStat {
  triggerId: string;
  type: string;
  evaluations: number;
  fired: number;
}

export interface BotBacktestResult {
  id: string;

  botId: string;
  botName: string;

  marketId: string;
  timeframe: string;

  startTime: number;
  endTime: number;

  initialBalance: number;
  endingBalance: number;

  netPnl: number;
  returnPct: number;

  maxDrawdown: number;
  maxDrawdownPct: number;

  winRate: number;
  profitFactor: number;
  averageTrade: number;

  trades: Trade[];
  equityCurve: EquityPoint[];
  events: AgentTimelineEvent[];

  triggerStats: BotBacktestTriggerStat[];

  gaps: Array<{
    from: number;
    to: number;
  }>;

  totalFees: number;
}

/**
 * Run a BotDefinition against historical market data.
 *
 * Pipeline:
 *
 * Historical bars
 *      ↓
 * BacktestEnvironment
 *      ↓
 * TriggerEngine
 *      ↓
 * AgentRuntime
 *      ↓
 * AI decision
 *      ↓
 * Deterministic policy/risk
 *      ↓
 * Simulated execution
 *      ↓
 * Trades + equity + timeline
 *
 * The backtester deliberately does not:
 * - generate synthetic market data
 * - invent trades
 * - bypass trigger evaluation
 * - bypass deterministic risk validation
 * - expose future candles to the agent
 *
 * At candle index N, the agent receives only bars [0..N].
 */
export async function runBotDefinitionBacktest(
  options: BotBacktestOptions,
): Promise<BotBacktestResult> {
  validateBacktestOptions(options);

  const definition = migrateBotDefinition(
    options.definition,
  );

  validateBotDefinition(definition);

  const bars = options.bars;
  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];

  const timeline = new InMemoryAgentTimelineStore();

  reportProgress(
    options,
    'preparing',
    0,
    bars.length,
  );

  /*
   * Resolve dependencies once.
   *
   * The injected model is especially useful for deterministic tests.
   * Production execution falls back to the configured OpenRouter model.
   */
  const model = options.model ?? agentModel;

  const runtime = new AgentRuntime(
    capabilityRegistry,
    skillRegistry,
    actionValidator,
    model,
    timeline,
  );

  const agent = compileBotDefinition(
    definition,
    options.deployment,
    options.runtimeSymbol,
    'BACKTEST',
  );

  const environment = new BacktestEnvironment({
    initialBalance: options.initialBalance,
    symbol: options.runtimeSymbol,
    timeframe: options.timeframe,

    spreadPips: options.spreadPips,
    spreadPrice: options.spreadPrice,
    commissionPerLot: options.commissionPerLot,
    lotSize: options.lotSize,
    pipSize: options.pipSize,
    slippagePips: options.slippagePips,
    slippagePrice: options.slippagePrice,
    pricePrecision: options.pricePrecision,

    bars,
  });

  runtime.registerAgent(
    agent,
    environment,
  );

  const registry = new TriggerRegistry(
    (agentId) => runtime.getAgent(agentId),
  );

  /*
   * Resolve the bot's deployment-specific symbol here.
   *
   * BotDefinition remains asset-agnostic.
   */
  for (const trigger of definition.triggers) {
    registry.register({
      ...trigger,
      agentId: agent.id,
      symbol: options.runtimeSymbol,
    });
  }

  const engine = new TriggerEngine(
    registry,
    runtime,
    timeline,
    () => 0,
  );

  const triggers = registry.list();

  const firedCounts = new Map<string, number>();
  const evaluationCounts = new Map<string, number>();
  const seenClosedTrades = new Set<string>();

  /*
   * Start the runtime before replay.
   *
   * Everything after this point is inside the lifecycle guard so the
   * runtime and engine are cleaned up even when a candle causes an error.
   */
  let runtimeStarted = false;

  try {
    await runtime.start(agent.id);
    runtimeStarted = true;

    for (
      let index = 0;
      index < bars.length;
      index += 1
    ) {
      const bar = bars[index];

      reportProgress(
        options,
        'replay',
        index + 1,
        bars.length,
      );

      /*
       * IMPORTANT:
       *
       * Only expose the historical prefix through the current candle.
       * This prevents future-data leakage/lookahead.
       */
      const historicalBars = bars.slice(
        0,
        index + 1,
      );

      environment.setBarIndex(index);

      const sourceEventTimestamp =
        bar.time * 1000;

      const result = await engine.process({
        id: `backtest:${agent.id}:${bar.time}`,

        agentId: agent.id,

        type: 'BAR_UPDATE',

        timestamp: sourceEventTimestamp,

        environment: 'BACKTEST',

        symbol: options.runtimeSymbol,

        timeframe: options.timeframe,

        state: {
          timestamp: sourceEventTimestamp,
          environment: 'BACKTEST',
          symbol: options.runtimeSymbol,
          timeframe: options.timeframe,

          price: bar.close,

          /*
           * Prefix-only historical state.
           *
           * Never replace this with the complete `bars` array.
           */
          bars: historicalBars,

          eventData: {
            isClosed: true,
          },
        },
      });

      /*
       * Record deterministic trigger evaluation results.
       *
       * Every registered trigger gets one evaluation per replayed bar.
       */
      for (const trigger of triggers) {
        const fired = result.some(
          (event) =>
            event.triggerId === trigger.id,
        );

        evaluationCounts.set(
          trigger.id,
          (evaluationCounts.get(trigger.id) ?? 0) + 1,
        );

        await timeline.append({
          id: `evaluation:${agent.id}:${trigger.id}:${bar.time}`,

          agentId: agent.id,

          timestamp: sourceEventTimestamp,

          type: 'TRIGGER_EVALUATED',

          environment: 'BACKTEST',

          triggerId: trigger.id,

          data: {
            fired,
            symbol: options.runtimeSymbol,
            timeframe: options.timeframe,
          },
        });
      }

      /*
       * TriggerEngine has already determined which triggers fired.
       *
       * A fired trigger wakes the agent; it does not automatically mean
       * a trade occurs.
       */
      for (const event of result) {
        firedCounts.set(
          event.triggerId,
          (firedCounts.get(event.triggerId) ?? 0) + 1,
        );

        await timeline.append({
          id: `wake:${event.id}`,

          agentId: agent.id,

          timestamp: event.timestamp,

          type: 'AGENT_WAKE',

          environment: 'BACKTEST',

          triggerId: event.triggerId,

          data: {
            reason: event.reason,
            sourceEventId: event.sourceEventId,
          },
        });
      }

      /*
       * Closed trades are emitted by the simulated environment.
       *
       * We process each newly observed close exactly once so the runtime
       * receives the corresponding position lifecycle event.
       */
      const closedTrades =
        environment.getClosedTrades();

      for (const trade of closedTrades) {
        if (seenClosedTrades.has(trade.id)) {
          continue;
        }

        seenClosedTrades.add(trade.id);

        await engine.processPositionEvent(
          agent.id,
          'POSITION_CLOSE',
          {
            id: trade.positionId || trade.id,
            symbol: trade.symbol,
            side: trade.side,
            currentPrice: trade.exitPrice,
            volume: trade.volume,
          },
          sourceEventTimestamp,
          'BACKTEST',
          trade.id,
        );
      }
    }
  } finally {
    /*
     * Always settle the environment before collecting final results.
     */
    reportProgress(
      options,
      'settling',
      bars.length,
      bars.length,
    );

    try {
      await environment.finalize();
    } finally {
      /*
       * Runtime cleanup must happen even if finalization fails.
       */
      if (runtimeStarted) {
        await runtime.stop(agent.id);
      }

      engine.stop();
    }
  }

  /*
   * Collect final simulation state only after settlement.
   */
  const events = (
    await timeline.getByAgent(agent.id)
  ).sort(compareTimelineEvents);

  const trades =
    environment.getClosedTrades();

  const equityCurve =
    environment.getEquityCurve();

  const accountState =
    await environment.getAccountState();

  const endingBalance =
    accountState.equity;

  const netPnl = round(
    endingBalance - options.initialBalance,
    2,
  );

  const performance =
    calculatePerformance(
      trades,
      netPnl,
      equityCurve,
    );

  const result: BotBacktestResult = {
    id: createBacktestId(
      definition,
      options.deployment,
      firstBar.time,
      lastBar.time,
    ),

    botId: definition.identity.id,

    botName: definition.identity.name,

    marketId: options.deployment.marketId,

    timeframe: options.timeframe,

    startTime: firstBar.time,

    endTime: lastBar.time,

    initialBalance:
      options.initialBalance,

    endingBalance,

    netPnl,

    returnPct: round(
      (netPnl / options.initialBalance) * 100,
      2,
    ),

    maxDrawdown:
      performance.maxDrawdown,

    maxDrawdownPct:
      performance.maxDrawdownPct,

    winRate:
      performance.winRate,

    profitFactor:
      performance.profitFactor,

    averageTrade:
      performance.averageTrade,

    trades,

    equityCurve,

    events,

    triggerStats:
      triggers.map((trigger) => ({
        triggerId: trigger.id,

        type: trigger.type,

        evaluations:
          evaluationCounts.get(trigger.id) ?? 0,

        fired:
          firedCounts.get(trigger.id) ?? 0,
      })),

    gaps:
      options.gaps ?? [],

    totalFees:
      calculateTotalFees(trades),
  };

  reportProgress(
    options,
    'complete',
    bars.length,
    bars.length,
  );

  return result;
}

/**
 * Validate the backtest boundary before constructing runtime components.
 *
 * Keeping these checks here makes failures much easier to diagnose from
 * the UI than errors occurring deep inside TriggerEngine or execution.
 */
function validateBacktestOptions(
  options: BotBacktestOptions,
): void {
  if (!options) {
    throw new Error(
      'Backtest options are required.',
    );
  }

  if (!options.definition) {
    throw new Error(
      'BotDefinition is required for a backtest.',
    );
  }

  if (!options.deployment) {
    throw new Error(
      'Deployment is required for a backtest.',
    );
  }

  if (!nonEmpty(options.runtimeSymbol)) {
    throw new Error(
      'A runtime symbol is required for a backtest.',
    );
  }

  if (!nonEmpty(options.timeframe)) {
    throw new Error(
      'A timeframe is required for a backtest.',
    );
  }

  if (!Array.isArray(options.bars) || options.bars.length === 0) {
    throw new Error(
      'Historical data is required for a BotDefinition backtest.',
    );
  }

  if (
    !Number.isFinite(options.initialBalance) ||
    options.initialBalance <= 0
  ) {
    throw new Error(
      'Initial balance must be positive.',
    );
  }

  validateHistoricalBars(options.bars);
}

/**
 * Basic historical-bar integrity checks.
 *
 * This does not replace the historical provider's full validation.
 * It simply prevents obviously invalid data from entering replay.
 */
function validateHistoricalBars(
  bars: Bar[],
): void {
  let previousTime = -Infinity;

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];

    if (!bar || !Number.isFinite(bar.time)) {
      throw new Error(
        `Historical data contains an invalid timestamp at bar ${index}.`,
      );
    }

    if (bar.time <= previousTime) {
      throw new Error(
        `Historical data must be strictly chronological. Invalid bar at index ${index}.`,
      );
    }

    if (
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close)
    ) {
      throw new Error(
        `Historical data contains invalid OHLC values at bar ${index}.`,
      );
    }

    if (
      bar.high < bar.low ||
      bar.high < bar.open ||
      bar.high < bar.close ||
      bar.low > bar.open ||
      bar.low > bar.close
    ) {
      throw new Error(
        `Historical data contains an impossible OHLC relationship at bar ${index}.`,
      );
    }

    previousTime = bar.time;
  }
}

function calculatePerformance(
  trades: Trade[],
  netPnl: number,
  equityCurve: EquityPoint[],
): {
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  averageTrade: number;
} {
  const wins = trades.filter(
    (trade) => trade.pnl > 0,
  );

  const losses = trades.filter(
    (trade) => trade.pnl < 0,
  );

  const grossProfit = wins.reduce(
    (sum, trade) => sum + trade.pnl,
    0,
  );

  const grossLoss = Math.abs(
    losses.reduce(
      (sum, trade) => sum + trade.pnl,
      0,
    ),
  );

  const maxDrawdown = Math.max(
    0,
    ...equityCurve.map(
      (point) => point.drawdown,
    ),
  );

  const maxDrawdownPct = Math.max(
    0,
    ...equityCurve.map(
      (point) => point.drawdownPercent,
    ),
  );

  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? 99.9
        : 0;

  return {
    maxDrawdown: round(
      maxDrawdown,
      2,
    ),

    maxDrawdownPct: round(
      maxDrawdownPct,
      2,
    ),

    winRate:
      trades.length > 0
        ? round(
            (wins.length / trades.length) * 100,
            2,
          )
        : 0,

    profitFactor: round(
      profitFactor,
      2,
    ),

    averageTrade:
      trades.length > 0
        ? round(
            netPnl / trades.length,
            2,
          )
        : 0,
  };
}

function calculateTotalFees(
  trades: Trade[],
): number {
  return round(
    trades.reduce(
      (sum, trade) =>
        sum + (Number.isFinite(trade.commission)
          ? trade.commission
          : 0),
      0,
    ),
    2,
  );
}

function createBacktestId(
  definition: BotDefinition,
  deployment: Deployment,
  startTime: number,
  endTime: number,
): string {
  return [
    definition.identity.id,
    deployment.id,
    startTime,
    endTime,
  ].join(':');
}

function compareTimelineEvents(
  left: AgentTimelineEvent,
  right: AgentTimelineEvent,
): number {
  return (
    left.timestamp - right.timestamp ||
    left.id.localeCompare(right.id)
  );
}

function reportProgress(
  options: BotBacktestOptions,
  phase: BotBacktestProgress['phase'],
  processed: number,
  total: number,
): void {
  options.onProgress?.({
    phase,
    processed,
    total,
  });
}

function round(
  value: number,
  decimals: number,
): number {
  const multiplier = 10 ** decimals;

  return (
    Math.round(
      (value + Number.EPSILON) *
        multiplier,
    ) / multiplier
  );
}

function nonEmpty(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0
  );
}