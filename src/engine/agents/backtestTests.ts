import { Bar } from '../../types/trading';
import { compileQuickBuild, createDeployment } from './botDefinition';
import { runBotDefinitionBacktest } from './backtest';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runBotDefinitionBacktestTests(): Promise<void> {
  const bars: Bar[] = [
    { time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 },
    { time: 2, open: 1.1, high: 1.102, low: 1.1, close: 1.101 },
    { time: 3, open: 1.101, high: 1.104, low: 1.101, close: 1.103 },
  ];
  const definition = compileQuickBuild('Build a conservative trend bot.').definition;
  definition.capabilities = { ...definition.capabilities, orders: true, automation: true };
  definition.skills = { ...definition.skills, context: [...definition.skills.context, 'trade-entry'] };
  definition.ai = { ...definition.ai, reasoningMode: 'autonomous' };
  const deployment = createDeployment({ id: 'bt-deployment', botId: definition.identity.id, marketId: 'EUR/USD', accountId: 'paper-account', mode: 'paper', status: 'active' }, 1);
  let observedBars = 0;
  const result = await runBotDefinitionBacktest({
    definition,
    deployment,
    runtimeSymbol: 'EUR/USD',
    timeframe: '15m',
    bars,
    initialBalance: 10000,
    model: {
      async run(request) {
        observedBars = Math.max(observedBars, request.observation.market.recentBars?.length || 0);
        return request.iteration === 1
          ? { thought: 'Historical setup observed.', decision: { type: 'OPEN_POSITION', symbol: 'EUR/USD', side: 'BUY', volume: 1000, stopLoss: 1.09, reason: 'deterministic test decision' } }
          : { thought: 'No new opportunity.', decision: { type: 'WAIT', reason: 'test wait' } };
      },
    },
  });
  assert(result.trades.length === 1, `BotDefinition backtest produces a deterministic simulated trade (${JSON.stringify(result.events)})`);
  assert(result.equityCurve.length > 0, 'BotDefinition backtest records an equity curve');
  assert(result.events.some((event) => event.type === 'TRIGGER'), 'historical trigger events are recorded');
  assert(result.triggerStats[0]?.evaluations === bars.length, 'trigger evaluations follow historical chronology');
  assert(observedBars <= bars.length, 'agent observations never include future bars');
  const repeat = await runBotDefinitionBacktest({
    definition,
    deployment,
    runtimeSymbol: 'EUR/USD',
    timeframe: '15m',
    bars,
    initialBalance: 10000,
    model: { async run(request) { return request.iteration === 1 ? { thought: 'test', decision: { type: 'OPEN_POSITION', symbol: 'EUR/USD', side: 'BUY', volume: 1000, stopLoss: 1.09, reason: 'deterministic test decision' } } : { thought: 'wait', decision: { type: 'WAIT', reason: 'test wait' } }; } },
  });
  assert(result.netPnl === repeat.netPnl && result.trades[0]?.pnl === repeat.trades[0]?.pnl, 'identical BotDefinition inputs produce deterministic results');
}
