import { Bar } from '../../../types/trading';
import { AgentRuntime } from '../runtime';
import { AgentTimelineStore } from '../timeline';
import { TradingAgent } from '../types';
import { BacktestEnvironment } from '../environment/backtest';
import { TrackerRuntime } from './runtime';
import { TrackerRegistry } from './registry';
import { Tracker, TrackerInput } from './types';

/**
 * Replay bars through a tracker and an agent, in BACKTEST.
 *
 * The point of this path is that it is the *same* runtime the live path
 * uses: one tracker, one evaluator, one wake. A backtest that used a
 * second evaluator would prove nothing about the deployed behaviour, and
 * the agentic surface is explicitly out of scope for it.
 */
export async function replayTrackersBacktest(options: {
  agent: TradingAgent;
  tracker: Tracker;
  bars: Bar[];
  environment: BacktestEnvironment;
  runtime: AgentRuntime;
  timeline: AgentTimelineStore;
  trackers: TrackerRuntime;
  timeframe: string;
}): Promise<{ trackerEvents: number; decisions: number }> {
  const instance = options.runtime.getAgent(options.agent.id);
  if (!instance || instance.env !== options.environment || instance.env.mode !== 'BACKTEST') {
    throw new Error('Agent must be registered with the supplied BACKTEST environment.');
  }
  const registry = new TrackerRegistry((agentId) => options.runtime.getAgent(agentId));
  registry.register(options.tracker);
  let trackerEvents = 0;
  await options.runtime.start(options.agent.id);
  const seenClosedTrades = new Set<string>();
  try {
    for (let index = 0; index < options.bars.length; index += 1) {
      const bar = options.bars[index];
      const input: TrackerInput = {
        id: `backtest:${options.agent.id}:${bar.time}`,
        type: 'BAR_UPDATE',
        timestamp: bar.time * 1000,
        environment: 'BACKTEST',
        symbol: options.agent.symbols[0],
        timeframe: options.timeframe,
        state: {
          timestamp: bar.time * 1000,
          environment: 'BACKTEST',
          symbol: options.agent.symbols[0],
          timeframe: options.timeframe,
          price: bar.close,
          bars: options.bars.slice(Math.max(0, index - 1000), index + 1)
            .map((item) => ({ time: item.time, open: item.open, high: item.high, low: item.low, close: item.close })),
          eventData: { isClosed: true },
        },
      };
      options.environment.setBarIndex(index);
      trackerEvents += (await options.trackers.process(input)).length;
      const closedPositions = options.environment.getClosedTrades();
      for (const trade of closedPositions) {
        if (seenClosedTrades.has(trade.id)) continue;
        seenClosedTrades.add(trade.id);
        if (trade.positionId) {
          await options.trackers.processPositionEvent(options.agent.id, 'POSITION_CLOSE', {
            id: trade.positionId, symbol: trade.symbol, side: trade.side, currentPrice: trade.exitPrice, volume: trade.volume,
          }, bar.time * 1000, 'BACKTEST', trade.id);
        }
      }
      trackerEvents += (await options.trackers.tickScheduled(bar.time * 1000, 'BACKTEST')).length;
    }
  } finally {
    await options.runtime.stop(options.agent.id);
  }
  const decisions = (await options.timeline.getByAgent(options.agent.id, { type: 'DECISION' })).length;
  return { trackerEvents, decisions };
}
