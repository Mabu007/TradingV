import { CapabilityRegistry } from './capabilities/registry';
import { AgentCapability, AgentDecision, AgentObservation, AgentPolicy, ITradingEnvironment, TradingAgent } from './types';
import { ActionValidator } from './policy/validator';
import { AgentRuntime } from './runtime';
import { SkillRegistry } from './skills/registry';
import { IAgentModel } from './model/types';
import { Bar, Position } from '../../types/trading';
import { InstrumentMetadata } from '../../types/instruments';
import { instrumentMetadata } from '../../adapters/hyperliquid/normalizer';
import { NormalizedQuote } from '../../types/quotes';
import { calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { BacktestEnvironment, replayAgentBacktest } from './environment/backtest';

const policy: AgentPolicy = {
  maxRiskPerTrade: 0.01,
  maxDailyLoss: 500,
  maxDrawdown: 0.05,
  maxOpenPositions: 1,
  maxExposure: 50000,
  maxOrdersPerMinute: 5,
  allowedSymbols: ['EURUSD'],
  allowTrading: true,
};

const quote: NormalizedQuote = { symbol: 'EURUSD', symbolId: '1', bid: 1.1, ask: 1.1001, spread: 1, timestamp: 1000, status: 'MOCK' };
const observation: AgentObservation = {
  timestamp: 1000, environment: 'DEMO',
  market: { quotes: [quote], quote, session: 'LONDON' },
  account: { balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, dailyPnL: 0, drawdownPercent: 0 },
  positions: [], orders: [], availableCapabilities: [], availableSkills: [],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runAgentInfrastructureTests(): Promise<void> {
  assert(JSON.stringify(calculateSMA([1, 2, 3, 4], 2)) === JSON.stringify([null, 1.5, 2.5, 3.5]), 'SMA is deterministic');
  assert(JSON.stringify(calculateEMA([1, 2, 3, 4], 2)) === JSON.stringify([null, 1.5, 2.5, 3.5]), 'EMA is deterministic');
  assert(calculateRSI(Array.from({ length: 20 }, (_, index) => index + 1), 14)[19] === 100, 'RSI is deterministic');
  const registry = new CapabilityRegistry();
  let value = 0;
  const testCapability: AgentCapability<{ amount: number }, number> = {
    id: 'test.increment', name: 'Increment', description: 'Test capability', category: 'market',
    inputSchema: { amount: { type: 'number' } }, outputSchema: {},
    async execute(input) { value += input.amount; return value; },
  };
  registry.register(testCapability);
  assert(registry.has('test.increment'), 'registry has registered capability');
  assert(registry.get('test.increment')?.id === 'test.increment', 'registry gets capability');
  assert(registry.list().length === 1, 'registry lists capabilities');
  assert(await registry.execute('test.increment', { amount: 2 }, { agentId: 'a', environment: 'DEMO', env: stubEnvironment(), policy, symbols: ['EURUSD'] }) === 2, 'registry executes');
  let unknownRejected = false;
  try { await registry.execute('missing', {}, { agentId: 'a', environment: 'DEMO', env: stubEnvironment(), policy, symbols: ['EURUSD'] }); } catch { unknownRejected = true; }
  assert(unknownRejected, 'unknown capability rejects');
  let scopeRejected = false;
  try { await registry.execute('test.increment', { amount: 1, symbol: 'GBPUSD' }, { agentId: 'a', environment: 'DEMO', env: stubEnvironment(), policy, symbols: ['EURUSD'] }); } catch { scopeRejected = true; }
  assert(scopeRejected, 'capability cannot access symbols outside agent scope');
  let malformedRejected = false;
  try { await registry.execute('test.increment', { amount: 'invalid' }, { agentId: 'a', environment: 'DEMO', env: stubEnvironment(), policy, symbols: ['EURUSD'] }); } catch { malformedRejected = true; }
  assert(malformedRejected, 'schema-invalid capability arguments reject');

  const validator = new ActionValidator();
  const validOpen: AgentDecision = { type: 'OPEN_POSITION', symbol: 'EURUSD', side: 'BUY', volume: 1000, stopLoss: 1.099, reason: 'test' };
  assert(validator.validate(validOpen, policy, observation).valid, 'valid trade passes policy');
  assert(!validator.validate({ ...validOpen, symbol: 'GBPUSD' }, policy, observation).valid, 'disallowed symbol rejected');
  assert(!validator.validate({ ...validOpen, volume: 50001 }, policy, observation).valid, 'max exposure rejected');
  assert(!validator.validate({ ...validOpen, volume: 10000, stopLoss: 1.09 }, policy, observation).valid, 'risk ceiling rejected');
  assert(!validator.validate(validOpen, { ...policy, allowTrading: false }, observation).valid, 'disabled trading rejected');
  const occupied = { ...observation, positions: [makePosition()] };
  assert(!validator.validate(validOpen, policy, occupied).valid, 'max positions rejected');
  assert(!validator.validate(validOpen, policy, { ...observation, account: { ...observation.account, dailyPnL: -600 } }).valid, 'daily loss rejected');

  /*
   * Deterministic per-asset risk.
   *
   * Each instrument is priced with its own metadata: a USD-quoted
   * commodity or index is a plain price-distance times size, and a
   * JPY-quoted pair is converted with the live rate. No pip value or
   * 100,000-unit lot appears in the calculation.
   */
  const instruments: InstrumentMetadata[] = [
    instrumentMetadata({ providerSymbol: 'xyz:EUR', assetClass: 'FOREX', pricePrecision: 5, sizePrecision: 1, maxLeverage: 50 }),
    instrumentMetadata({ providerSymbol: 'xyz:JPY', assetClass: 'FOREX', pricePrecision: 2, sizePrecision: 2, maxLeverage: 50 }),
    instrumentMetadata({ providerSymbol: 'xyz:GOLD', assetClass: 'COMMODITY', pricePrecision: 1, sizePrecision: 4, maxLeverage: 25 }),
    instrumentMetadata({ providerSymbol: 'xyz:CL', assetClass: 'COMMODITY', pricePrecision: 2, sizePrecision: 3, maxLeverage: 20 }),
    instrumentMetadata({ providerSymbol: 'xyz:SP500', assetClass: 'INDEX', pricePrecision: 2, sizePrecision: 3, maxLeverage: 50 }),
  ];
  const assetPolicy: AgentPolicy = { ...policy, allowedSymbols: instruments.map((instrument) => instrument.symbol), maxExposure: 250_000 };
  /*
   * A fresh validator keeps the per-asset cases independent of the
   * order-rate window used by the assertions above.
   */
  const assetValidator = new ActionValidator();

  const assetObservation = (instrument: InstrumentMetadata, ask: number, bid: number): AgentObservation => {
    const assetQuote: NormalizedQuote = { symbol: instrument.symbol, symbolId: instrument.providerSymbol, bid, ask, spread: ask - bid, timestamp: 1000, status: 'LIVE' };
    return { ...observation, market: { quotes: [assetQuote], quote: assetQuote, session: 'LONDON' }, account: { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 } };
  };

  const eur = instruments[0];
  assert(
    assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: eur.symbol, side: 'BUY', volume: 1_000, stopLoss: 1.09, reason: 'test' },
      assetPolicy,
      assetObservation(eur, 1.1001, 1.1),
      { instruments },
    ).valid,
    'EUR/USD: a 1% risk with a 100 pip stop is approved',
  );

  const jpy = instruments[1];
  assert(
    assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: jpy.symbol, side: 'BUY', volume: 10_000, stopLoss: 156.33, reason: 'test' },
      assetPolicy,
      assetObservation(jpy, 157.33, 157.32),
      { instruments },
    ).valid,
    'USD/JPY: a 1% risk with a 1 JPY stop is approved (converted at the live rate)',
  );

  const gold = instruments[2];
  assert(
    assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: gold.symbol, side: 'BUY', volume: 10, stopLoss: 4131, reason: 'test' },
      assetPolicy,
      assetObservation(gold, 4141, 4140),
      { instruments },
    ).valid,
    'Gold: a 1% risk with a 1 point stop on 10 units is approved',
  );

  const oil = instruments[3];
  assert(
    assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: oil.symbol, side: 'BUY', volume: 100, stopLoss: 91.53, reason: 'test' },
      assetPolicy,
      assetObservation(oil, 92.53, 92.5),
      { instruments },
    ).valid,
    'WTI: a 1% risk with a 1 point stop on 1,000 units is approved',
  );

  const index = instruments[4];
  assert(
    assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: index.symbol, side: 'SELL', volume: 10, stopLoss: 7710, reason: 'test' },
      assetPolicy,
      assetObservation(index, 7701, 7700),
      { instruments },
    ).valid,
    'S&P 500: a 1% risk with a 1 point stop on 10 units is approved',
  );

  /*
   * The same order is rejected once the risk exceeds the policy, and the
   * ceiling is identical whether it is expressed per pip or per point.
   */
  assert(
    !assetValidator.validate(
      { type: 'OPEN_POSITION', symbol: gold.symbol, side: 'BUY', volume: 100, stopLoss: 4131, reason: 'test' },
      assetPolicy,
      assetObservation(gold, 4141, 4140),
      { instruments },
    ).valid,
    'Gold: a 10x larger position breaches maxRiskPerTrade',
  );

  /*
   * Mixed-asset exposure is a monetary limit: 10 Gold units ($40k) plus
   * a 100,000 unit EUR position (~$110k) breaches a $100k budget even
   * though the raw unit total is small.
   */
  const mixedPolicy: AgentPolicy = { ...assetPolicy, maxExposure: 100_000, maxOpenPositions: 5 };
  const goldQuote: NormalizedQuote = { symbol: 'Gold', symbolId: 'xyz:GOLD', bid: 4000, ask: 4001, spread: 1, timestamp: 1000, status: 'LIVE' };
  const eurQuote: NormalizedQuote = { symbol: 'EUR/USD', symbolId: 'xyz:EUR', bid: 1.1, ask: 1.101, spread: 0.001, timestamp: 1000, status: 'LIVE' };
  const mixedObservation: AgentObservation = {
    ...observation,
    market: { quotes: [goldQuote, eurQuote], quote: eurQuote, session: 'LONDON' },
    positions: [
      { id: 'gold-1', symbol: 'Gold', side: 'BUY', volume: 10, entryPrice: 4001, currentPrice: 4001, unrealizedPnL: 0, unrealizedPnlPercent: 0, timestamp: 1 },
    ],
  };

  const mixedValidator = new ActionValidator();

  const mixedResult = mixedValidator.validate(
    { type: 'OPEN_POSITION', symbol: 'EUR/USD', side: 'BUY', volume: 100_000, stopLoss: 1.1, reason: 'test' },
    mixedPolicy,
    mixedObservation,
    { instruments },
  );

  assert(
    !mixedResult.valid,
    'mixed-asset exposure is compared in the account currency, not as raw units',
  );
  assert(
    String(mixedResult.reason).includes('exposure'),
    'the exposure rejection explains the monetary limit',
  );

  /*
   * A HIP-3 commodity/index quote has no pip or lot semantics, so the
   * risk ceiling must be the entry-to-stop distance times the requested
   * instrument units.
   */
  const commodityQuote: NormalizedQuote = { symbol: 'Gold', symbolId: 'xyz:GOLD', bid: 3000, ask: 3001, spread: 1, timestamp: 1000, status: 'LIVE' };
  const commodityObservation: AgentObservation = { ...observation, market: { ...observation.market, quotes: [commodityQuote], quote: commodityQuote } };
  const commodityPolicy: AgentPolicy = { ...policy, allowedSymbols: ['Gold'], maxExposure: 250000 };
  const commodityOpen: AgentDecision = { type: 'OPEN_POSITION', symbol: 'Gold', side: 'BUY', volume: 10, stopLoss: 2991, reason: 'test' };
  assert(validator.validate(commodityOpen, commodityPolicy, commodityObservation).valid, 'commodity trade sized in instrument units passes the risk ceiling');
  assert(!validator.validate({ ...commodityOpen, volume: 100 }, commodityPolicy, commodityObservation).valid, 'oversized commodity trade breaches the risk ceiling');

  const skills = new SkillRegistry();
  skills.register({ id: 'test-skill', name: 'Test', description: 'Test skill', instructions: '', requiredCapabilities: ['test.increment'], enabled: true });
  const actionCapability: AgentCapability<{ symbol: string; side: 'BUY' | 'SELL'; volume: number; stopLoss: number }, { success: boolean }> = {
    id: 'orders.market', name: 'Market order', description: '', category: 'execution', inputSchema: {}, outputSchema: {},
    async execute(input, context) { return context.env.placeMarketOrder({ ...input }); },
  };
  const runtimeCapabilities = new CapabilityRegistry();
  runtimeCapabilities.register(testCapability);
  runtimeCapabilities.register(actionCapability);
  const env = stubEnvironment();
  const model: IAgentModel = {
    async run(request) {
      if (request.iteration === 1) return { thought: 'inspect', toolCall: { capability: 'test.increment', input: { amount: 3 } } };
      return { thought: 'wait', decision: { type: 'WAIT', reason: 'test complete' } };
    },
  };
  const agent: TradingAgent = {
    id: 'test-agent', name: 'Test Agent', description: '', instructions: '', skills: ['test-skill'], capabilities: ['test.increment'], policy,
    preferredEnvironment: 'DEMO', symbols: ['EURUSD'], timeframe: '5m', enabled: true, createdAt: 1, updatedAt: 1,
  };
  const runtime = new AgentRuntime(runtimeCapabilities, skills, validator, model);
  runtime.registerAgent(agent, env);
  const decision = await runtime.step(agent.id);
  assert(decision.type === 'WAIT', 'runtime returns structured decision');
  assert(runtime.getAuditTrail(agent.id)[0]?.toolCalls[0]?.capability === 'test.increment', 'runtime records tool audit');

  let executed = false;
  const executionEnv = { ...env, async placeMarketOrder(_params: { symbol: string; side: 'BUY' | 'SELL'; volume: number; stopLoss?: number; takeProfit?: number; comment?: string }) { executed = true; return { success: true, positionId: 'p-1' }; } };
  const tradingAgent: TradingAgent = { ...agent, id: 'approved-agent', skills: ['entry'], capabilities: ['orders.market'] };
  const tradingSkills = new SkillRegistry();
  tradingSkills.register({ id: 'entry', name: 'Entry', description: 'Entry skill', instructions: '', requiredCapabilities: ['orders.market'], enabled: true });
  const orderCapability: AgentCapability<Record<string, unknown>, unknown> = {
    id: 'orders.market', name: 'Market', description: '', category: 'execution', inputSchema: {}, outputSchema: {},
    async execute(input) { return executionEnv.placeMarketOrder(input as { symbol: string; side: 'BUY' | 'SELL'; volume: number; stopLoss: number }); },
  };
  const orderRegistry = new CapabilityRegistry();
  orderRegistry.register(orderCapability);
  const approvedRuntime = new AgentRuntime(orderRegistry, tradingSkills, new ActionValidator(), {
    async run() { return { thought: 'approved', decision: validOpen }; },
  });
  approvedRuntime.registerAgent(tradingAgent, executionEnv);
  await approvedRuntime.step(tradingAgent.id);
  assert(executed, 'approved structured decision reaches environment only after validation');

  let riskBypassCalled = false;
  const modelRequest: Record<string, unknown> = {};
  const blockedAgent = { ...agent, id: 'blocked-agent', capabilities: ['orders.market'], skills: ['trade-entry'] };
  const executionSkills = new SkillRegistry();
  executionSkills.register({ id: 'trade-entry', name: 'Entry', description: 'Entry skill', instructions: '', requiredCapabilities: ['orders.market'], enabled: true });
  const blockedRegistry = new CapabilityRegistry();
  blockedRegistry.register({ ...actionCapability, async execute() { riskBypassCalled = true; return { success: true }; } });
  const blockedRuntime = new AgentRuntime(blockedRegistry, executionSkills, validator, {
    async run(request) { Object.assign(modelRequest, request); return { thought: 'order', toolCall: { capability: 'orders.market', input: { symbol: 'GBPUSD', side: 'BUY', volume: 1000, stopLoss: 1.09 } } }; },
  });
  blockedRuntime.registerAgent(blockedAgent, env);
  await blockedRuntime.step(blockedAgent.id);
  assert(!riskBypassCalled, 'execution tool cannot bypass agent symbol policy');
  assert(JSON.stringify(blockedRuntime.getAuditTrail(blockedAgent.id)).includes('REJECTED'), 'policy failure is returned and audited');

  const sameAgentRuntime = new AgentRuntime(runtimeCapabilities, skills, new ActionValidator(), model);
  sameAgentRuntime.registerAgent(agent, { ...env, mode: 'BACKTEST' });
  assert(sameAgentRuntime.getAgent(agent.id)?.env.mode === 'BACKTEST', 'system-selected environment can run an unchanged agent definition');
  const limitedSkills = new SkillRegistry();
  limitedSkills.register({ id: 'partial', name: 'Partial', description: 'Partial capability skill', instructions: '', requiredCapabilities: ['test.increment', 'missing.cap'], enabled: true });
  const limitedAgent = { ...agent, id: 'partial-agent', skills: ['partial'], capabilities: ['test.increment', 'missing.cap'] };
  const limitedRuntime = new AgentRuntime(runtimeCapabilities, limitedSkills, new ActionValidator(), model);
  limitedRuntime.registerAgent(limitedAgent, env);
  assert(limitedRuntime.getAgent(limitedAgent.id)?.allowedCapabilities.join(',') === 'test.increment', 'agent capability set is intersection of registered capabilities and active skills');
  let disabledSkillRejected = false;
  const disabledSkills = new SkillRegistry();
  disabledSkills.register({ id: 'disabled', name: 'Disabled', description: 'Disabled skill', instructions: '', requiredCapabilities: [], enabled: false });
  try { new AgentRuntime(runtimeCapabilities, disabledSkills, validator, model).registerAgent({ ...agent, id: 'disabled-agent', skills: ['disabled'] }, env); } catch { disabledSkillRejected = true; }
  assert(disabledSkillRejected, 'agent cannot activate a disabled skill');

  const historical: Bar[] = Array.from({ length: 3 }, (_, index) => ({
    time: index + 1, open: 1.1 + index * 0.0001, high: 1.101 + index * 0.0001,
    low: 1.099 + index * 0.0001, close: 1.1 + index * 0.0001,
  }));
  const backtestEnvironment = new BacktestEnvironment({ symbol: 'EURUSD', bars: historical });
  assert((await backtestEnvironment.getMarketBars('EURUSD', '5m', 10)).length === 1, 'backtest bars are bounded by deterministic current historical index');
  const backtestAgent: TradingAgent = { ...agent, id: 'backtest-agent' };
  const backtestRuntime = new AgentRuntime(runtimeCapabilities, skills, new ActionValidator(), model);
  backtestRuntime.registerAgent(backtestAgent, backtestEnvironment);
  const replay = await replayAgentBacktest(backtestRuntime, backtestAgent.id, backtestEnvironment);
  assert(replay.length === historical.length, 'same runtime supports deterministic historical event replay');
  assert(!['window', 'document', 'fetch', 'filesystem'].some((name) => name in modelRequest), 'model request excludes ambient execution APIs');
}

function makePosition(): Position {
  return { id: 'position-1', symbol: 'EURUSD', side: 'BUY', volume: 1000, entryPrice: 1.1, currentPrice: 1.1, unrealizedPnL: 0, unrealizedPnlPercent: 0, timestamp: 1 };
}

function stubEnvironment(): ITradingEnvironment {
  const bars: Bar[] = [{ time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 }];
  return {
    mode: 'DEMO', async getMarketQuote() { return quote; }, async getMarketBars() { return bars; },
    async getAccountState() { return { balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, dailyPnL: 0, drawdownPercent: 0 }; },
    async getPositions() { return []; }, async getOrders() { return []; },
    async placeMarketOrder() { return { success: true }; }, async modifyPosition() { return { success: true }; }, async closePosition() { return { success: true }; },
  };
}
