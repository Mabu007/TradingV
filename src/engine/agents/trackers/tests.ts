import { AgentRuntime } from '../runtime';
import { AgentPolicy, ITradingEnvironment, TradingAgent } from '../types';
import { AgentModelRequest, IAgentModel } from '../model/types';
import { SkillRegistry } from '../skills/registry';
import { CapabilityRegistry } from '../capabilities/registry';
import { AgentCapability } from '../types';
import { ActionValidator } from '../policy/validator';
import { InMemoryAgentTimelineStore } from '../timeline';
import { TrackerRuntime } from './runtime';
import { evaluateTracker, newEvaluationState } from './evaluator';
import { evaluateProximity } from './proximity';
import { TrackerRegistry } from './registry';
import { Tracker, TrackerConfig, TrackerInput, TrackerKind } from './types';
import { Bar, Position } from '../../../types/trading';
import { InstrumentMetadata } from '../../../types/instruments';
import { NormalizedQuote } from '../../../types/quotes';

const policy: AgentPolicy = { maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 10_000, maxOrdersPerMinute: 2, allowedSymbols: ['EURUSD'], allowTrading: false };
const quote: NormalizedQuote = { symbol: 'EURUSD', symbolId: '1', bid: 1.1, ask: 1.1001, spread: 0.7, timestamp: 1000, status: 'MOCK' };
const bar: Bar = { time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 };

/*
 * Instrument metadata fixtures. Each one carries only the facts the real
 * Hyperliquid normalizer publishes, so proximity maths is exercised with
 * provider-shaped metadata rather than hand-tuned numbers.
 */
const forexInstrument: InstrumentMetadata = {
  symbol: 'EUR/USD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX', provider: 'HYPERLIQUID',
  providerSymbol: 'xyz:EUR', providerMarketId: 'xyz:EUR', providerDex: 'xyz',
  baseCurrency: 'EUR', quoteCurrency: 'USD', pricePrecision: 5, sizePrecision: 1,
  tickSize: 0.00001, pipSize: 0.0001, lotSize: 100_000,
};

const goldInstrument: InstrumentMetadata = {
  symbol: 'Gold', displayName: 'Gold Perpetual', assetClass: 'COMMODITY', provider: 'HYPERLIQUID',
  providerSymbol: 'xyz:GOLD', providerMarketId: 'xyz:GOLD', providerDex: 'xyz',
  quoteCurrency: 'USD', pricePrecision: 2, sizePrecision: 2, tickSize: 0.01,
};

const indexInstrument: InstrumentMetadata = {
  symbol: 'S&P 500', displayName: 'S&P 500 Perpetual', assetClass: 'INDEX', provider: 'HYPERLIQUID',
  providerSymbol: 'xyz:SP500', providerMarketId: 'xyz:SP500', providerDex: 'xyz',
  quoteCurrency: 'USD', pricePrecision: 1, sizePrecision: 2, tickSize: 0.1,
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

/**
 * Proximity regression suite.
 *
 * Covers Forex, commodity, and index instruments for long and short
 * positions, plus the unavailable-price case, and asserts the evaluator
 * contains no Forex-shaped fallback (a pip threshold on an instrument
 * that declares no pip size must never report).
 */
export function runPositionProximityTests(): void {
  const proximityTracker = (kind: TrackerKind, config: TrackerConfig): Tracker =>
    makeTracker(`prox-${kind}-${JSON.stringify(config)}`, 'prox-agent', kind, config);

  const build = (
    position: { id: string; symbol: string; side: 'BUY' | 'SELL'; currentPrice: number; volume?: number; stopLoss?: number; takeProfit?: number },
    instrument: InstrumentMetadata | undefined,
    price?: number,
  ): TrackerInput => ({
    id: `prox-${position.id}-${price ?? 'none'}`,
    type: 'POSITION_UPDATE',
    timestamp: 1_000,
    environment: 'DEMO',
    symbol: position.symbol,
    state: {
      timestamp: 1_000,
      environment: 'DEMO',
      symbol: position.symbol,
      price,
      instrument,
      positions: [position],
      eventData: { positionId: position.id },
    },
  });

  const state = newEvaluationState();

  // --- Forex, long position, pip threshold from metadata -------------
  const forexLong = { id: 'fx-long', symbol: 'EUR/USD', side: 'BUY' as const, currentPrice: 1.1, volume: 1_000, stopLoss: 1.096 };
  const forexStop = evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPips: 50 }), build(forexLong, forexInstrument), state);
  assert(Boolean(forexStop), 'forex long stop proximity reports from metadata pip size');
  assert(Boolean(forexStop?.includes('pips')), 'forex proximity reason reports pips');

  // --- Forex, short position ------------------------------------------
  const forexShort = { id: 'fx-short', symbol: 'EUR/USD', side: 'SELL' as const, currentPrice: 1.1, volume: 1_000, takeProfit: 1.1004 };
  assert(Boolean(evaluateTracker(proximityTracker('TARGET_APPROACHING', { withinPips: 5 }), build(forexShort, forexInstrument), state)), 'forex short target proximity reports');

  // Far away in pips must not report even though the raw price distance
  // looks tiny compared with an index point.
  const forexFar = { id: 'fx-far', symbol: 'EUR/USD', side: 'BUY' as const, currentPrice: 1.1, volume: 1_000, stopLoss: 1.09 };
  assert(!evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPips: 5 }), build(forexFar, forexInstrument), state), 'forex stop far from level does not report');

  // --- Commodity, long and short -------------------------------------
  const goldLong = { id: 'gold-long', symbol: 'Gold', side: 'BUY' as const, currentPrice: 2_350.4, volume: 2, stopLoss: 2_345 };
  const goldStop = evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPrice: 6 }), build(goldLong, goldInstrument), state);
  assert(Boolean(goldStop), 'gold long stop proximity reports on absolute price distance');
  assert(!goldStop?.includes('pip'), 'gold proximity reason is not expressed in pips');
  const goldShort = { id: 'gold-short', symbol: 'Gold', side: 'SELL' as const, currentPrice: 2_350.4, volume: 2, takeProfit: 2_352 };
  assert(Boolean(evaluateTracker(proximityTracker('TARGET_APPROACHING', { withinPercent: 0.1 }), build(goldShort, goldInstrument), state)), 'gold short target proximity reports on percentage distance');
  assert(!evaluateTracker(proximityTracker('TARGET_APPROACHING', { withinPercent: 0.01 }), build(goldShort, goldInstrument), state), 'gold target outside percentage band does not report');

  // A pip threshold on gold has no pip size to measure against, so it
  // must stay silent instead of borrowing the Forex assumption. The
  // fixture is deliberately close enough that a 0.0001 pip fallback would
  // report it as within 50 pips, so this fails if the fallback returns.
  const goldTight = { id: 'gold-tight', symbol: 'Gold', side: 'BUY' as const, currentPrice: 2_350.4, volume: 2, stopLoss: 2_350.397 };
  assert(
    Boolean(evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPrice: 0.01 }), build(goldTight, goldInstrument), state)),
    'the same close gold stop does report on an absolute price distance',
  );
  assert(
    !evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPips: 50 }), build(goldTight, goldInstrument), state),
    'pip threshold does not report for a commodity with no pip size',
  );

  // The same must hold with no instrument metadata at all, and for a
  // symbol whose name would tempt a name-based pip heuristic.
  assert(
    !evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPips: 50 }), build({ ...goldTight, id: 'gold-nometa' }, undefined), state),
    'pip threshold does not report without instrument metadata',
  );
  assert(
    !evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPips: 50 }), build({ ...goldTight, id: 'jpy-named', symbol: 'USD/JPY' }, goldInstrument), state),
    'a symbol name never supplies a pip size the metadata does not declare',
  );

  // A metric that cannot be measured blocks the whole evaluation rather
  // than half-checking it: the price limit is met, the pip limit cannot be
  // measured, so nothing is reported.
  assert(
    !evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPrice: 1, withinPips: 50 }), build(goldTight, goldInstrument), state),
    'an unmeasurable threshold blocks the entire proximity evaluation',
  );

  // --- Index, long and short -----------------------------------------
  const indexLong = { id: 'index-long', symbol: 'S&P 500', side: 'BUY' as const, currentPrice: 5_498.2, volume: 1, stopLoss: 5_480 };
  assert(Boolean(evaluateTracker(proximityTracker('STOP_APPROACHING', { withinTicks: 200 }), build(indexLong, indexInstrument), state)), 'index long stop proximity reports in metadata tick units');
  const indexShort = { id: 'index-short', symbol: 'S&P 500', side: 'SELL' as const, currentPrice: 5_498.2, volume: 1, takeProfit: 5_530 };
  assert(Boolean(evaluateTracker(proximityTracker('TARGET_APPROACHING', { withinPrice: 40 }), build(indexShort, indexInstrument), state)), 'index short target proximity reports on absolute price distance');

  // --- Monetary distance uses position quantity, metadata, and price ---
  // 5.4 price distance x 2 units x 1 (Hyperliquid quotes linearly)
  // = 10.80 USD from the account currency, with no hardcoded multiplier.
  const goldValue = evaluateProximity({
    position: { id: 'gold-value', symbol: 'Gold', side: 'BUY', currentPrice: 2_350.4, volume: 2, stopLoss: 2_345 },
    level: 'stopLoss',
    config: { withinValue: 20 },
    instrument: goldInstrument,
  });
  assert(goldValue.within, 'gold stop within a monetary threshold reports');
  assert(goldValue.valueDistance !== undefined && Math.abs(goldValue.valueDistance - 10.8) < 1e-6, 'monetary distance is derived from price distance, quantity, and metadata');
  const goldValueOutside = evaluateProximity({
    position: { id: 'gold-value-2', symbol: 'Gold', side: 'BUY', currentPrice: 2_350.4, volume: 2, stopLoss: 2_340 },
    level: 'stopLoss',
    config: { withinValue: 20 },
    instrument: goldInstrument,
  });
  assert(!goldValueOutside.within, 'gold stop beyond the monetary threshold does not report');
  assert(goldValueOutside.valueDistance !== undefined && Math.abs(goldValueOutside.valueDistance - 20.8) < 1e-6, 'a wider price distance produces a wider monetary distance');

  // A monetary threshold is refused when the instrument's quote currency
  // cannot be expressed in the account currency, rather than approximated.
  const unconvertible = evaluateProximity({
    position: { id: 'unconvertible', symbol: 'EUR/USD', side: 'BUY', currentPrice: 1.1, volume: 1_000, stopLoss: 1.0995 },
    level: 'stopLoss',
    config: { withinValue: 1_000 },
    instrument: { ...forexInstrument, quoteCurrency: 'CHF', baseCurrency: 'CHF' },
  });
  assert(!unconvertible.within && Boolean(unconvertible.unmeasurable), 'a monetary threshold on an unconvertible instrument does not report');

  // --- Unavailable price ----------------------------------------------
  const unavailable = { id: 'unavailable', symbol: 'Gold', side: 'BUY' as const, currentPrice: Number.NaN, volume: 2, stopLoss: 2_345 };
  const unavailableResult = evaluateProximity({ position: unavailable, level: 'stopLoss', config: { withinPrice: 100 }, instrument: goldInstrument });
  assert(!unavailableResult.within, 'a market with no usable price never reports proximity');
  assert(!evaluateTracker(proximityTracker('STOP_APPROACHING', { withinPrice: 100 }), build(unavailable, goldInstrument, Number.NaN), state), 'unavailable price does not wake the agent');
  const missingPrice = evaluateProximity({
    position: { id: 'missing', symbol: 'Gold', side: 'BUY', currentPrice: 2_350, stopLoss: 2_345 },
    level: 'stopLoss',
    config: { withinPrice: 100 },
    instrument: goldInstrument,
    price: 0,
  });
  assert(missingPrice.within, 'a zero venue price falls back to the position mark price rather than being treated as a distance');
  const noPriceAtAll = evaluateProximity({
    position: { id: 'missing-2', symbol: 'Gold', side: 'BUY', currentPrice: Number.NaN, stopLoss: 2_345 },
    level: 'stopLoss',
    config: { withinPrice: 100 },
    instrument: goldInstrument,
    price: Number.NaN,
  });
  assert(!noPriceAtAll.within && Boolean(noPriceAtAll.unmeasurable), 'a null or zero venue price is never turned into an executable price');

  // --- Edge detection is preserved (reports once per approach) ---------
  const approachState = newEvaluationState();
  const stopTracker = proximityTracker('STOP_APPROACHING', { withinPrice: 6 });
  assert(Boolean(evaluateTracker(stopTracker, build(goldLong, goldInstrument), approachState)), 'proximity reports on first approach');
  assert(!evaluateTracker(stopTracker, build(goldLong, goldInstrument), approachState), 'proximity does not re-report while still within the band');
  assert(!evaluateTracker(stopTracker, build({ ...goldLong, id: 'gold-long', currentPrice: 2_300 }, goldInstrument), approachState), 'proximity resets when price leaves the band');
  assert(Boolean(evaluateTracker(stopTracker, build(goldLong, goldInstrument), approachState)), 'proximity reports again after re-entering the band');

  // --- A tracker never turns into an execution decision ---------------
  const observed = evaluateTracker(stopTracker, build(goldLong, goldInstrument), newEvaluationState());
  assert(typeof observed === 'string' && !observed.includes('order'), 'proximity produces a wake reason only, never an order instruction');
  assert(!evaluateTracker(stopTracker, build(goldLong, goldInstrument, 2_350.4), newEvaluationState())?.includes('risk'), 'proximity wake reason does not claim a risk decision');
}

/**
 * Registry lifecycle.
 *
 * The registry is the only thing that knows which trackers exist, so its
 * identity handling is tested directly rather than through the runtime.
 * The last case is the regression: an update has to replace the record
 * that is actually registered, under the name that is actually
 * registered. A registry that kept the old record would report the
 * update as a duplicate and leave the GOAT watching a definition it had
 * already changed.
 */
export function runTrackerRegistryTests(): void {
  const skills = new SkillRegistry();
  skills.register({ id: 'observation', name: 'Observation', description: 'Read market', instructions: '', requiredCapabilities: [], enabled: true });
  const runtime = new AgentRuntime(
    new CapabilityRegistry(),
    skills,
    new ActionValidator(),
    { async run() { return { thought: '', decision: { type: 'WAIT' as const, reason: 'unused' } }; } },
    new InMemoryAgentTimelineStore(),
  );
  const agent = makeAgent('registry-agent', ['EURUSD', 'XAUUSD']);
  runtime.registerAgent(agent, environment());
  const registry = new TrackerRegistry((id) => runtime.getAgent(id));

  const tracker = makeTracker('registry-1', agent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { symbol: 'EURUSD' });
  registry.register(tracker);

  assert(registry.get(tracker.id)?.id === tracker.id, 'a registered tracker can be read back by its own id');
  assert(registry.list().length === 1 && registry.listForAgent(agent.id).length === 1, 'a registered tracker is listed for its agent');
  assert(registry.candidates('EURUSD').length === 1, 'a live tracker is a candidate for its market');
  assert(registry.candidates('XAUUSD').length === 0, 'a scoped tracker is not a candidate for another market');

  const updated = registry.update({ ...tracker, config: { operator: 'ABOVE', level: 42 } });
  assert(updated.config.level === 42, 'an update returns the stored record');
  assert(registry.get(tracker.id)?.config.level === 42, 'an update replaces the definition in place, under the same id');
  assert(registry.list().length === 1, 'an update does not create a second tracker');
  assert(registry.candidates('EURUSD').length === 1, 'an update re-indexes the tracker under its market');

  // A move to another market must drop the old index entry, or the
  // tracker would be evaluated against a market it no longer watches.
  registry.update({ ...tracker, symbol: 'XAUUSD' });
  assert(registry.candidates('EURUSD').length === 0, 'a tracker moved off a market is no longer a candidate for it');
  assert(registry.candidates('XAUUSD').length === 1, 'and is a candidate for the market it moved to');

  // An unscoped tracker watches every market its GOAT may trade, which is
  // a deliberate widening rather than a leak: the owner check still caps
  // it at the agent's own symbols.
  registry.update({ ...tracker, symbol: undefined });
  assert(registry.candidates('EURUSD').length === 1 && registry.candidates('XAUUSD').length === 1,
    'an unscoped tracker is a candidate for every market its owner may trade');
  registry.update({ ...tracker, symbol: 'EURUSD' });

  let removed = registry.remove(tracker.id);
  assert(removed && registry.get(tracker.id) === undefined, 'a removed tracker is gone');
  assert(!registry.remove(tracker.id), 'removing an unknown tracker reports that it was not there');

  registry.register({ ...tracker, id: 'registry-2' });
  registry.register({ ...tracker, id: 'registry-3' });
  registry.clear();
  assert(registry.list().length === 0 && registry.candidates('EURUSD').length === 0, 'clear removes every tracker and its index');

  /*
   * The identity regression.
   *
   * This used to be two names for one tracker: the definition was
   * registered under a derived id while the index was keyed by the
   * tracker's own. An update therefore unregistered one name and
   * registered another, leaving the old definition live and the
   * replacement rejected as a duplicate -- and, because the *second*
   * update in a row hit the same trap, a tracker could not be changed
   * twice. There is now one name per tracker, and these three cases are
   * what hold it there.
   */
  const first = makeTracker('identity', agent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { symbol: 'EURUSD' });
  registry.register(first);
  registry.update({ ...first, config: { operator: 'ABOVE', level: 11 } });
  registry.update({ ...first, config: { operator: 'ABOVE', level: 12 } });
  const twice = registry.get('identity');
  assertEqual(twice?.config.level, 12, 'a tracker can be updated more than once, and the second update lands');
  assertEqual(registry.list().length, 1, 'and updating twice never creates a second tracker');

  // A rejected update must leave the tracker watching what it was
  // watching, not a half-applied definition.
  let rejected = false;
  try { registry.update({ ...first, config: { operator: 'ABOVE', level: 13 }, timeframe: '3m' }); } catch { rejected = true; }
  assert(rejected, 'an unsupported timeframe is refused');
  assertEqual(registry.get('identity')?.config.level, 12, 'and the previously accepted definition survives the refusal');
  assertEqual(registry.candidates('EURUSD').length, 1, 'the tracker is still indexed under its market');

  let duplicateRejected = false;
  registry.register(tracker);
  try { registry.register(tracker); } catch { duplicateRejected = true; }
  assert(duplicateRejected, 'the same id cannot be registered twice');
  registry.clear();
}

/**
 * The runtime, the registry and the evaluator, end to end.
 *
 * This is the canonical chain: market data in, TrackerEvent out, GOAT
 * woken. Everything asserted here is behaviour the architecture depends
 * on, not an implementation detail.
 */
export async function runTrackerTimelineTests(): Promise<void> {
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

  const registry = new TrackerRegistry((id) => runtime.getAgent(id));
  const threshold = makeTracker('threshold', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 10 }, { symbol: 'EURUSD', cooldownMs: 0 });
  registry.register(threshold);
  assert(registry.get(threshold.id)?.id === threshold.id && registry.listForAgent(eurAgent.id).length === 1, 'tracker register/get/list');

  const trackers = new TrackerRuntime({ registry, agents: runtime, timeline, clock: () => 0 });
  const firedCounts: number[] = [];
  for (let index = 0; index < 1000; index += 1) {
    firedCounts.push((await trackers.process(input(index, index === 200 ? 10 : index < 200 ? 9 : 11))).length);
  }
  assert(firedCounts.reduce((sum, count) => sum + count, 0) === 1, 'threshold reports once on transition, not for remaining high ticks');
  assert(modelCalls === 1, '1000 ticks caused one model invocation');
  assert(lastRequest?.wakeReason?.includes('10'), 'tracker wake context explains why the agent woke');
  const timelineEvents = await timeline.getByAgent(eurAgent.id);
  assert(timelineEvents.some((event) => event.type === 'TRACKER'), 'tracker event recorded');
  assert(timelineEvents.some((event) => event.type === 'OBSERVATION'), 'observation recorded');
  assert(timelineEvents.some((event) => event.type === 'DECISION'), 'decision recorded');
  assert(timelineEvents.some((event) => event.type === 'RISK_CHECK'), 'risk check recorded');
  assert(timelineEvents.every((event) => !('thought' in (event.data as Record<string, unknown>))), 'hidden reasoning is not persisted');

  const cross = makeTracker('cross', eurAgent.id, 'PRICE_CROSS', { direction: 'ABOVE', level: 20 }, { symbol: 'EURUSD', cooldownMs: 1000 });
  registry.register(cross);
  await trackers.process(input(1001, 19));
  const crossing = await trackers.process(input(1002, 20));
  const immediatelyBlocked = await trackers.process(input(1003, 19));
  assert(crossing.some((event) => event.trackerId === 'cross'), 'price cross above reports');
  assert(immediatelyBlocked.length === 0, 'cooldown blocks an immediate repeat event');
  await trackers.process(input(2003, 19));
  const recross = await trackers.process(input(2004, 20));
  assert(recross.some((event) => event.trackerId === 'cross'), 'price cross can report again after the cooldown and a reset');

  const paused = makeTracker('paused', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 5 }, { symbol: 'EURUSD', cooldownMs: 0 });
  registry.register(paused);
  // A delivery below the level, so the crossing that follows is real
  // rather than the first sample a threshold tracker ever sees.
  await trackers.process(input(3000, 4));
  trackers.pauseTracker(paused.id);
  assert((await trackers.process(input(3001, 6))).every((event) => event.trackerId !== paused.id), 'a paused tracker does not wake the agent');
  assert(registry.get(paused.id)?.lifecycle.status === 'PAUSED', 'a paused tracker stays registered, so resuming needs no re-authoring');
  trackers.resumeTracker(paused.id);
  assert((await trackers.process(input(3002, 6))).some((event) => event.trackerId === paused.id), 'a resumed tracker reports again');

  let scopeRejected = false;
  try { registry.register(makeTracker('scope', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 1 }, { symbol: 'XAUUSD' })); } catch { scopeRejected = true; }
  assert(scopeRejected, 'a tracker cannot escape its owner agent symbol scope');
  assert((await trackers.process({ ...input(3001, 30), symbol: 'XAUUSD', state: { ...input(3001, 30).state, symbol: 'XAUUSD' } })).length === 0, 'an EURUSD-only tracker ignores an XAUUSD event');

  const frequency = makeTracker('limited', eurAgent.id, 'PRICE_CROSS', { direction: 'ABOVE', level: 8 }, { symbol: 'EURUSD', maxEventsPerMinute: 1 });
  registry.register(frequency);
  await trackers.process(input(4000, 7));
  assert((await trackers.process(input(4001, 9))).some((event) => event.trackerId === 'limited'), 'rate-limited tracker first report');
  await trackers.process(input(4002, 7));
  assert((await trackers.process(input(4003, 9))).every((event) => event.trackerId !== 'limited'), 'the per-minute ceiling blocks a noisy tracker');

  const invalid = makeTracker('bad', eurAgent.id, 'PRICE_CROSS', { direction: 'SIDEWAYS', level: 1 }, { symbol: 'EURUSD' });
  let invalidRejected = false;
  try { registry.register(invalid); } catch { invalidRejected = true; }
  assert(invalidRejected, 'an invalid tracker configuration fails closed');

  let secretRejected = false;
  try {
    registry.register(makeTracker('secret', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 1, apiKey: 'sk-live-nope' }, { symbol: 'EURUSD' }));
  } catch { secretRejected = true; }
  assert(secretRejected, 'a tracker configuration cannot carry credentials');

  const purposeless = makeTracker('purposeless', eurAgent.id, 'PRICE_THRESHOLD', { operator: 'ABOVE', level: 1 }, { symbol: 'EURUSD' });
  let refused = false;
  try { registry.register({ ...purposeless, purpose: '   ' }); } catch { refused = true; }
  assert(refused, 'a tracker must state what it is waiting for');

  const orderTracker = makeTracker('filled-only', eurAgent.id, 'ORDER_FILLED', {}, { symbol: 'EURUSD' });
  const fillState = newEvaluationState();
  assert(!evaluateTracker(orderTracker, { ...input(6000, 1), type: 'ORDER_REQUESTED', state: { ...input(6000, 1).state, order: { status: 'PENDING', symbol: 'EURUSD' } } }, fillState), 'an order request does not masquerade as a fill');
  assert(Boolean(evaluateTracker(orderTracker, { ...input(6001, 1), type: 'ORDER_FILLED', state: { ...input(6001, 1).state, order: { status: 'FILLED', symbol: 'EURUSD' } } }, fillState)), 'an actual order fill is supported');

  const otherAgentEvents = await timeline.getByAgent(xauAgent.id);
  assert(otherAgentEvents.length === 0, 'an unrelated agent receives no tracker events');

  const state = newEvaluationState();
  const emaTracker = makeTracker('ema-cross', eurAgent.id, 'INDICATOR_CROSS', {
    fastKey: 'emaFast', slowKey: 'emaSlow', direction: 'ABOVE',
    fast: { type: 'EMA', key: 'emaFast', period: 2 }, slow: { type: 'EMA', key: 'emaSlow', period: 3 },
  }, { symbol: 'EURUSD', timeframe: '1m' });
  const candle = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close });
  const candles = [candle(1, 3), candle(2, 2), candle(3, 1), candle(4, 3), candle(5, 4)];
  const indicatorInput = (count: number): TrackerInput => ({ id: `indicator-${count}`, type: 'BAR_UPDATE', timestamp: count * 60_000,
    environment: 'DEMO', symbol: 'EURUSD', timeframe: '1m', state: { timestamp: count * 60_000, environment: 'DEMO', symbol: 'EURUSD',
      timeframe: '1m', price: candles[count - 1].close, bars: candles.slice(0, count).map((item) => ({ ...item })) } });
  evaluateTracker(emaTracker, indicatorInput(3), state);
  assert(Boolean(evaluateTracker(emaTracker, indicatorInput(5), state)), 'indicator cross uses the existing deterministic EMA calculations');

  const breakout = makeTracker('breakout', eurAgent.id, 'BREAKOUT', { direction: 'ABOVE', lookbackBars: 2 }, { symbol: 'EURUSD' });
  const breakoutState = newEvaluationState();
  const belowBreak: TrackerInput = { ...indicatorInput(3), state: { ...indicatorInput(3).state, price: 2 } };
  const aboveBreak: TrackerInput = { ...indicatorInput(5), state: { ...indicatorInput(5).state, price: 5 } };
  evaluateTracker(breakout, belowBreak, breakoutState);
  assert(Boolean(evaluateTracker(breakout, aboveBreak, breakoutState)), 'breakout crosses the prior range high');

  const stopTracker = makeTracker('stop-near', eurAgent.id, 'STOP_APPROACHING', { withinPips: 5 }, { symbol: 'EURUSD' });
  const stopInput: TrackerInput = { ...input(5100, 1.1), type: 'POSITION_UPDATE', state: { ...input(5100, 1.1).state,
    instrument: forexInstrument,
    positions: [{ id: 'pos-1', symbol: 'EURUSD', side: 'BUY', currentPrice: 1.0996, stopLoss: 1.0995 }] } };
  assert(Boolean(evaluateTracker(stopTracker, stopInput, newEvaluationState())), 'stop proximity reports deterministically');
  const targetTracker = makeTracker('target-near', eurAgent.id, 'TARGET_APPROACHING', { withinPips: 5 }, { symbol: 'EURUSD' });
  assert(Boolean(evaluateTracker(targetTracker, { ...stopInput, state: { ...stopInput.state, positions: [{ id: 'pos-2', symbol: 'EURUSD', side: 'BUY', currentPrice: 1.1004, takeProfit: 1.1005 }] } }, newEvaluationState())), 'target proximity reports deterministically');
  runPositionProximityTests();

  const spreadTracker = makeTracker('spread', eurAgent.id, 'SPREAD_CHANGE', { maxSpread: 1.2 }, { symbol: 'EURUSD' });
  const spreadState = newEvaluationState();
  evaluateTracker(spreadTracker, { ...input(5000, 1), state: { ...input(5000, 1).state, spread: 1 } }, spreadState);
  assert(Boolean(evaluateTracker(spreadTracker, { ...input(5001, 1), state: { ...input(5001, 1).state, spread: 1.3 } }, spreadState)), 'a spread threshold reports on a worsening transition');

  const scheduled = makeTracker('schedule', eurAgent.id, 'SCHEDULED', { everyMs: 60_000 }, { symbol: 'EURUSD' });
  const scheduleState = newEvaluationState();
  assert(!evaluateTracker(scheduled, input(60_000, 1), scheduleState), 'a scheduled interval initialises without an immediate wake');
  assert(Boolean(evaluateTracker(scheduled, input(120_000, 1), scheduleState)), 'a scheduled interval reports deterministically from the input clock');
  const scheduledDispatch = makeTracker('scheduled-dispatch', eurAgent.id, 'SCHEDULED', { everyMs: 60_000 }, { symbol: 'EURUSD' });
  registry.register(scheduledDispatch);
  assert((await trackers.tickScheduled(10_000, 'DEMO')).length === 0, 'the interval scheduler waits before the first interval boundary');
  assert((await trackers.tickScheduled(70_000, 'DEMO')).some((event) => event.trackerId === scheduledDispatch.id), 'a scheduled wake is delivered through the runtime clock input');

  const tradeEvent = { id: 'correlated', agentId: eurAgent.id, timestamp: 1, type: 'DECISION' as const, tradeId: 'trade-1', positionId: 'position-1', data: {} };
  await timeline.append(tradeEvent);
  assert((await timeline.getByTrade('trade-1'))[0]?.positionId === 'position-1', 'the timeline can retrieve correlated trade lifecycle identifiers');

  const toolTimeline = new InMemoryAgentTimelineStore();
  const toolCaps = new CapabilityRegistry();
  const toolSkillRegistry = new SkillRegistry();
  toolSkillRegistry.register({ id: 'quote-skill', name: 'Quote', description: 'quote capability', instructions: '', requiredCapabilities: ['test.quote'], enabled: true });
  const quoteCapability: AgentCapability<{ symbol: string }, { value: number }> = {
    id: 'test.quote', name: 'Quote', description: 'Read fixture', category: 'market', inputSchema: { symbol: { type: 'string' } }, outputSchema: {},
    async execute() { return { value: 42 }; },
  };
  toolCaps.register(quoteCapability);
  const toolModel: IAgentModel = {
    async run(request) {
      if (request.iteration === 1) return { thought: 'ignored private model trace', toolCall: { capability: 'test.quote', input: { symbol: 'EURUSD' } } };
      return { thought: 'not persisted', decision: { type: 'WAIT', reason: 'analyzed' } };
    },
  };
  const toolRuntime = new AgentRuntime(toolCaps, toolSkillRegistry, new ActionValidator(), toolModel, toolTimeline);
  const toolAgent = { ...eurAgent, id: 'tool-agent', skills: ['quote-skill'], capabilities: ['test.quote'] };
  toolRuntime.registerAgent(toolAgent, env);
  // Started: a capability runs only for an agent that is running, so the
  // instrumentation being asserted here is an instrumentation of a live agent.
  await toolRuntime.start(toolAgent.id);
  await toolRuntime.step(toolAgent.id);
  const toolEvents = await toolTimeline.getByAgent(toolAgent.id);
  assert(toolEvents.some((event) => event.type === 'CAPABILITY_CALL') && toolEvents.some((event) => event.type === 'CAPABILITY_RESULT'), 'capability request/result timeline events recorded');
  assert(!JSON.stringify(toolEvents).includes('ignored private model trace'), 'a hidden model thought does not persist');

  const brokenModelTimeline = new InMemoryAgentTimelineStore();
  const brokenRuntime = new AgentRuntime(new CapabilityRegistry(), skills, new ActionValidator(), { async run() { throw new Error('model unavailable'); } }, brokenModelTimeline);
  const brokenAgent = makeAgent('broken-model', ['EURUSD']);
  brokenRuntime.registerAgent(brokenAgent, env);
  const safeDecision = await brokenRuntime.step(brokenAgent.id);
  assert(safeDecision.type === 'WAIT' && (await brokenModelTimeline.getByAgent(brokenAgent.id)).some((item) => item.type === 'ERROR'), 'model errors are timeline events and do not trade');
  await runtime.stop(eurAgent.id);
  await runtime.stop(xauAgent.id);
}

function input(index: number, price: number): TrackerInput {
  return { id: `tick-${index}`, type: 'MARKET_QUOTE', timestamp: index + 2000, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m',
    state: { timestamp: index + 2000, environment: 'DEMO', symbol: 'EURUSD', timeframe: '5m', price, spread: 0.7 } };
}

interface TrackerOverrides extends Partial<Omit<Tracker, 'evaluation'>> {
  /** Shorthand for the evaluation block, which every test touches. */
  cooldownMs?: number;
  maxEventsPerMinute?: number;
  priority?: number;
}

function makeTracker(id: string, agentId: string, kind: TrackerKind, config: TrackerConfig, extra: TrackerOverrides = {}): Tracker {
  const { cooldownMs, maxEventsPerMinute, priority, ...rest } = extra;
  return {
    id,
    agentId,
    kind,
    config,
    purpose: `Observe ${kind} on the agent's market.`,
    eventType: 'CONDITION_MET',
    dependencies: [],
    dataRequirements: [],
    evaluation: { priority: priority ?? 0, cooldownMs: cooldownMs ?? 1_000, maxEventsPerMinute: maxEventsPerMinute ?? 10 },
    lifecycle: { status: 'ACTIVE', eventCount: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  };
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
