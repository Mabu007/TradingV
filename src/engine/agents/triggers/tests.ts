import { AgentRuntime } from '../runtime';
import { AgentPolicy, ITradingEnvironment, TradingAgent } from '../types';
import { AgentModelRequest, IAgentModel } from '../model/types';
import { SkillRegistry } from '../skills/registry';
import { CapabilityRegistry } from '../capabilities/registry';
import { AgentCapability } from '../types';
import { ActionValidator } from '../policy/validator';
import { InMemoryAgentTimelineStore } from '../timeline';
import { TriggerEngine } from './engine';
import { evaluateTrigger, newEvaluationState } from './evaluator';
import { TriggerRegistry } from './registry';
import { AgentTrigger, TriggerInput } from './types';
import { Bar, Position } from '../../../types/trading';
import { NormalizedQuote } from '../../../types/quotes';

const policy: AgentPolicy = { maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 10_000, maxOrdersPerMinute: 2, allowedSymbols: ['EURUSD'], allowTrading: false };
const quote: NormalizedQuote = { symbol: 'EURUSD', symbolId: '1', bid: 1.1, ask: 1.1001, spread: 0.7, timestamp: 1000, status: 'MOCK' };
const bar: Bar = { time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 };

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export async function runTriggerTimelineTests(): Promise<void> {
  let modelCalls = 0;
  let lastRequest: AgentModelRequest | undefined;
  const model: IAgentModel = { async run(request) { modelCalls += 1; lastRequest = request; return { thought: 'short auditable rationale', decision: { type: 'WAIT', reason: 'conditions are unclear' } }; } };
  const skills = new SkillRegistry();
  skills.register({ id: 'observation', name: 'Observation', description: 'Read market', instructions: '', requiredCapabilities: [], enabled: true });
  const timeline = new InMemoryAgentTimelineStore();
  const runtime = new AgentRuntime(new CapabilityRegistry(), skills, new ActionValidator(), model, timeline);
  const env = environment();
  const eurAgent = makeAgent('eur-agent', ['EURUSD']);
  const xauAgent = makeAgent('xau-agent', ['XAUUSD']);
  runtime.registerAgent(eurAgent, env);
  runtime.registerAgent(xauAgent, { ...env, async getMarketQuote(symbol: string) { return { ...quote, symbol }; } });
  await runtime.start(eurAgent.id);
  await runtime.start(xauAgent.id);

  const registry = new TriggerRegistry((id) => runtime.getAgent(id));
  const threshold = makeTrigger('threshold', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { symbol: 'EURUSD', cooldownMs: 0 });
  registry.register(threshold);
  assert(registry.get(threshold.id)?.id === threshold.id && registry.listForAgent(eurAgent.id).length === 1, 'trigger register/get/list');

  const engine = new TriggerEngine(registry, runtime, timeline, () => 0);
  const firedCounts: number[] = [];
  for (let index = 0; index < 1000; index += 1) {
    firedCounts.push((await engine.process(input(index, index === 200 ? 10 : index < 200 ? 9 : 11))).length);
  }
  assert(firedCounts.reduce((sum, count) => sum + count, 0) === 1, 'threshold fires once on transition, not for remaining high ticks');
  assert(modelCalls === 1, '1000 ticks caused one model invocation');
  assert(lastRequest?.wakeReason?.includes('10'), 'trigger wake context explains why the agent woke');
  const timelineEvents = await timeline.getByAgent(eurAgent.id);
  assert(timelineEvents.some((event) => event.type === 'TRIGGER'), 'trigger event recorded');
  assert(timelineEvents.some((event) => event.type === 'OBSERVATION'), 'observation recorded');
  assert(timelineEvents.some((event) => event.type === 'DECISION'), 'decision recorded');
  assert(timelineEvents.some((event) => event.type === 'RISK_CHECK'), 'risk check recorded');
  assert(timelineEvents.every((event) => !('thought' in (event.data as Record<string, unknown>))), 'hidden reasoning is not persisted');

  const cross = makeTrigger('cross', eurAgent.id, 'PRICE_CROSS', { direction: 'ABOVE', level: 20 }, { symbol: 'EURUSD', cooldownMs: 1000 });
  registry.register(cross);
  await engine.process(input(1001, 19));
  const crossing = await engine.process(input(1002, 20));
  const immediatelyBlocked = await engine.process(input(1003, 19));
  assert(crossing.some((event) => event.triggerId === 'cross'), 'price cross above fires');
  assert(immediatelyBlocked.length === 0, 'cooldown blocks immediate trigger repetition');
  await engine.process(input(2003, 19));
  const recross = await engine.process(input(2004, 20));
  assert(recross.some((event) => event.triggerId === 'cross'), 'price cross can fire after cooldown and reset');

  const disabled = makeTrigger('disabled', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 35 }, { symbol: 'EURUSD' });
  registry.register(disabled);
  registry.disable(disabled.id);
  assert((await engine.process(input(3000, 6))).every((event) => event.triggerId !== 'disabled'), 'disabled trigger does not wake agent');
  registry.enable(disabled.id);

  let scopeRejected = false;
  try { registry.register(makeTrigger('scope', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 1 }, { symbol: 'XAUUSD' })); } catch { scopeRejected = true; }
  assert(scopeRejected, 'trigger cannot escape its owner agent symbol scope');
  assert((await engine.process({ ...input(3001, 30), symbol: 'XAUUSD', state: { ...input(3001, 30).state, symbol: 'XAUUSD' } })).length === 0, 'EURUSD-only trigger ignores XAUUSD event');

  const frequency = makeTrigger('limited', eurAgent.id, 'PRICE_CROSS', { direction: 'ABOVE', level: 8 }, { symbol: 'EURUSD', maxFiringsPerMinute: 1 });
  registry.register(frequency);
  await engine.process(input(4000, 7));
  assert((await engine.process(input(4001, 9))).some((event) => event.triggerId === 'limited'), 'frequency-limited trigger first fire');
  await engine.process(input(4002, 7));
  assert((await engine.process(input(4003, 9))).every((event) => event.triggerId !== 'limited'), 'max firing rate blocks noisy trigger');

  const invalid = makeTrigger('bad', eurAgent.id, 'PRICE_CROSS', { direction: 'SIDEWAYS', level: 1 }, { symbol: 'EURUSD' });
  let invalidRejected = false;
  try { registry.register(invalid); } catch { invalidRejected = true; }
  assert(invalidRejected, 'invalid trigger configuration fails closed');

  const orderTrigger = makeTrigger('filled-only', eurAgent.id, 'ORDER_FILLED', {}, { symbol: 'EURUSD' });
  const fillState = newEvaluationState();
  assert(!evaluateTrigger(orderTrigger, { ...input(6000, 1), type: 'ORDER_REQUESTED', state: { ...input(6000, 1).state, order: { status: 'PENDING', symbol: 'EURUSD' } } }, fillState), 'order request does not masquerade as fill');
  assert(Boolean(evaluateTrigger(orderTrigger, { ...input(6001, 1), type: 'ORDER_FILLED', state: { ...input(6001, 1).state, order: { status: 'FILLED', symbol: 'EURUSD' } } }, fillState)), 'actual order fill trigger is supported');

  const otherAgentEvents = await timeline.getByAgent(xauAgent.id);
  assert(otherAgentEvents.length === 0, 'unrelated agent receives no trigger events');

  const state = newEvaluationState();
  const emaTrigger = makeTrigger('ema-cross', eurAgent.id, 'INDICATOR_CROSS', {
    fastKey: 'emaFast', slowKey: 'emaSlow', direction: 'ABOVE',
    fast: { type: 'EMA', key: 'emaFast', period: 2 }, slow: { type: 'EMA', key: 'emaSlow', period: 3 },
  }, { symbol: 'EURUSD', timeframe: '1m' });
  const candle = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close });
  const candles = [candle(1, 3), candle(2, 2), candle(3, 1), candle(4, 3), candle(5, 4)];
  const indicatorInput = (count: number): TriggerInput => ({ id: `indicator-${count}`, type: 'BAR_UPDATE', timestamp: count * 60_000,
    environment: 'DEMO', symbol: 'EURUSD', timeframe: '1m', state: { timestamp: count * 60_000, environment: 'DEMO', symbol: 'EURUSD',
      timeframe: '1m', price: candles[count - 1].close, bars: candles.slice(0, count).map((item) => ({ ...item })) } });
  evaluateTrigger(emaTrigger, indicatorInput(3), state);
  assert(Boolean(evaluateTrigger(emaTrigger, indicatorInput(5), state)), 'indicator cross uses existing deterministic EMA calculations');

  const breakout = makeTrigger('breakout', eurAgent.id, 'BREAKOUT', { direction: 'ABOVE', lookbackBars: 2 }, { symbol: 'EURUSD' });
  const breakoutState = newEvaluationState();
  const belowBreak: TriggerInput = { ...indicatorInput(3), state: { ...indicatorInput(3).state, price: 2 } };
  const aboveBreak: TriggerInput = { ...indicatorInput(5), state: { ...indicatorInput(5).state, price: 5 } };
  evaluateTrigger(breakout, belowBreak, breakoutState);
  assert(Boolean(evaluateTrigger(breakout, aboveBreak, breakoutState)), 'breakout crosses prior range high');

  const stopTrigger = makeTrigger('stop-near', eurAgent.id, 'STOP_APPROACHING', { withinPips: 5 }, { symbol: 'EURUSD' });
  const stopInput: TriggerInput = { ...input(5100, 1.1), type: 'POSITION_UPDATE', state: { ...input(5100, 1.1).state,
    positions: [{ id: 'pos-1', symbol: 'EURUSD', side: 'BUY', currentPrice: 1.0996, stopLoss: 1.0995 }] } };
  assert(Boolean(evaluateTrigger(stopTrigger, stopInput, newEvaluationState())), 'stop proximity trigger fires deterministically');
  const targetTrigger = makeTrigger('target-near', eurAgent.id, 'TARGET_APPROACHING', { withinPips: 5 }, { symbol: 'EURUSD' });
  assert(Boolean(evaluateTrigger(targetTrigger, { ...stopInput, state: { ...stopInput.state, positions: [{ id: 'pos-2', symbol: 'EURUSD', side: 'BUY', currentPrice: 1.1004, takeProfit: 1.1005 }] } }, newEvaluationState())), 'target proximity trigger fires deterministically');

  const spreadTrigger = makeTrigger('spread', eurAgent.id, 'SPREAD_CHANGE', { maxSpread: 1.2 }, { symbol: 'EURUSD' });
  const spreadState = newEvaluationState();
  evaluateTrigger(spreadTrigger, { ...input(5000, 1), state: { ...input(5000, 1).state, spread: 1 } }, spreadState);
  assert(Boolean(evaluateTrigger(spreadTrigger, { ...input(5001, 1), state: { ...input(5001, 1).state, spread: 1.3 } }, spreadState)), 'spread threshold triggers on worsening transition');

  const scheduled = makeTrigger('schedule', eurAgent.id, 'SCHEDULED', { everyMs: 60_000 }, { symbol: 'EURUSD' });
  const scheduleState = newEvaluationState();
  assert(!evaluateTrigger(scheduled, input(60_000, 1), scheduleState), 'scheduled interval initializes without immediate wake');
  assert(Boolean(evaluateTrigger(scheduled, input(120_000, 1), scheduleState)), 'scheduled interval fires deterministically from input clock');
  const scheduledDispatch = makeTrigger('scheduled-dispatch', eurAgent.id, 'SCHEDULED', { everyMs: 60_000 }, { symbol: 'EURUSD' });
  registry.register(scheduledDispatch);
  assert((await engine.tickScheduled(10_000, 'DEMO')).length === 0, 'interval scheduler waits before first interval boundary');
  assert((await engine.tickScheduled(70_000, 'DEMO')).some((event) => event.triggerId === scheduledDispatch.id), 'scheduled wake is delivered through trigger engine clock input');

  const tradeEvent = { id: 'correlated', agentId: eurAgent.id, timestamp: 1, type: 'DECISION' as const, tradeId: 'trade-1', positionId: 'position-1', data: {} };
  await timeline.append(tradeEvent);
  assert((await timeline.getByTrade('trade-1'))[0]?.positionId === 'position-1', 'timeline can retrieve correlated trade lifecycle identifiers');

  const toolTimeline = new InMemoryAgentTimelineStore();
  const toolCaps = new CapabilityRegistry();
  const toolSkillRegistry = new SkillRegistry();
  toolSkillRegistry.register({ id: 'quote-skill', name: 'Quote', description: 'quote capability', instructions: '', requiredCapabilities: ['test.quote'], enabled: true });
  const quoteCapability: AgentCapability<{ symbol: string }, { value: number }> = {
    id: 'test.quote', name: 'Quote', description: 'Read fixture', category: 'market', inputSchema: { symbol: { type: 'string' } }, outputSchema: {},
    async execute() { return { value: 42 }; },
  };
  toolCaps.register(quoteCapability);
  let toolRuntime: AgentRuntime;
  const toolModel: IAgentModel = {
    async run(request) {
      if (request.iteration === 1) return { thought: 'ignored private model trace', toolCall: { capability: 'test.quote', input: { symbol: 'EURUSD' } } };
      return { thought: 'not persisted', decision: { type: 'WAIT', reason: 'analyzed' } };
    },
  };
  toolRuntime = new AgentRuntime(toolCaps, toolSkillRegistry, new ActionValidator(), toolModel, toolTimeline);
  const toolAgent = { ...eurAgent, id: 'tool-agent', skills: ['quote-skill'], capabilities: ['test.quote'] };
  toolRuntime.registerAgent(toolAgent, env);
  await toolRuntime.step(toolAgent.id);
  const toolEvents = await toolTimeline.getByAgent(toolAgent.id);
  assert(toolEvents.some((event) => event.type === 'CAPABILITY_CALL') && toolEvents.some((event) => event.type === 'CAPABILITY_RESULT'), 'capability request/result timeline events recorded');
  assert(!JSON.stringify(toolEvents).includes('ignored private model trace'), 'hidden model thought does not persist');

  const brokenModelTimeline = new InMemoryAgentTimelineStore();
  const brokenRuntime = new AgentRuntime(new CapabilityRegistry(), skills, new ActionValidator(), { async run() { throw new Error('model unavailable'); } }, brokenModelTimeline);
  const brokenAgent = makeAgent('broken-model', ['EURUSD']);
  brokenRuntime.registerAgent(brokenAgent, env);
  const safeDecision = await brokenRuntime.step(brokenAgent.id);
  assert(safeDecision.type === 'WAIT' && (await brokenModelTimeline.getByAgent(brokenAgent.id)).some((item) => item.type === 'ERROR'), 'model errors are timeline events and do not trade');
  await runtime.stop(eurAgent.id);
  await runtime.stop(xauAgent.id);
}

function input(index: number, price: number): TriggerInput {
  return { id: `tick-${index}`, type: 'MARKET_QUOTE', timestamp: index + 2000, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m',
    state: { timestamp: index + 2000, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m', price, spread: 0.7 } };
}

function makeTrigger(id: string, agentId: string, type: AgentTrigger['type'], config: unknown, extra: Partial<AgentTrigger> = {}): AgentTrigger {
  return { id, agentId, type, enabled: true, config, createdAt: 1, updatedAt: 1, ...extra };
}

function makeAgent(id: string, symbols: string[]): TradingAgent {
  return { id, name: id, description: 'test agent', instructions: '', skills: ['observation'], capabilities: [], policy: { ...policy, allowedSymbols: symbols },
    preferredEnvironment: 'DEMO', symbols, enabled: true, createdAt: 1, updatedAt: 1 };
}

function environment(): ITradingEnvironment {
  return { mode: 'DEMO', async getMarketQuote(symbol) { return { ...quote, symbol }; }, async getMarketBars() { return [bar]; },
    async getAccountState() { return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 }; },
    async getPositions(): Promise<Position[]> { return []; }, async getOrders() { return []; }, async placeMarketOrder() { return { success: false, error: 'unused' }; },
    async modifyPosition() { return { success: false, error: 'unused' }; }, async closePosition() { return { success: false, error: 'unused' }; } };
}
