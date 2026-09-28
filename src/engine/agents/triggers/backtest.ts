import { Bar } from '../../../types/trading';
import { AgentRuntime } from '../runtime';
import { AgentTimelineStore } from '../timeline';
import { TradingAgent } from '../types';
import { BacktestEnvironment } from '../environment/backtest';
import { TriggerEngine } from './engine';
import { TriggerRegistry } from './registry';
import { AgentTrigger, TriggerInput } from './types';
import { Trade } from '../../../types/trading';

export async function replayTriggersBacktest(options: {
  agent: TradingAgent;
  trigger: AgentTrigger;
  bars: Bar[];
  environment: BacktestEnvironment;
  runtime: AgentRuntime;
  timeline: AgentTimelineStore;
  timeframe: string;
}): Promise<{ triggersFired: number; decisions: number }> {
  const instance = options.runtime.getAgent(options.agent.id);
  if (!instance || instance.env !== options.environment || instance.env.mode !== 'BACKTEST') throw new Error('Agent must be registered with the supplied BACKTEST environment.');
  const registry = new TriggerRegistry((agentId) => options.runtime.getAgent(agentId));
  registry.register(options.trigger);
  const engine = new TriggerEngine(registry, options.runtime, options.timeline, () => 0);
  let triggersFired = 0;
  await options.runtime.start(options.agent.id);
  const seenClosedTrades = new Set<string>();
  try {
    for (let index = 0; index < options.bars.length; index += 1) {
      const bar = options.bars[index];
      const input: TriggerInput = {
        id: `backtest:${options.agent.id}:${bar.time}`, type: 'BAR_UPDATE', timestamp: bar.time * 1000,
        environment: 'BACKTEST', symbol: options.agent.symbols[0], timeframe: options.timeframe,
        state: { timestamp: bar.time * 1000, environment: 'BACKTEST', symbol: options.agent.symbols[0], timeframe: options.timeframe,
          price: bar.close, bars: options.bars.slice(Math.max(0, index - 1000), index + 1).map((item) => ({ time: item.time, open: item.open, high: item.high, low: item.low, close: item.close })),
          eventData: { isClosed: true } },
      };
      options.environment.setBarIndex(index);
      triggersFired += (await engine.process(input)).length;
      const closedPositions = options.environment.getClosedTrades();
      for (const trade of closedPositions) {
        if (seenClosedTrades.has(trade.id)) continue;
        seenClosedTrades.add(trade.id);
        if (trade.positionId) await engine.processPositionEvent(options.agent.id, 'POSITION_CLOSE', {
          id: trade.positionId, symbol: trade.symbol, side: trade.side, currentPrice: trade.exitPrice, volume: trade.volume,
        }, bar.time * 1000, 'BACKTEST', trade.id);
      }
      triggersFired += (await engine.tickScheduled(bar.time * 1000, 'BACKTEST')).length;
    }
  } finally {
    await options.runtime.stop(options.agent.id);
  }
  const decisions = (await options.timeline.getByAgent(options.agent.id, { type: 'DECISION' })).length;
  return { triggersFired, decisions };
}
