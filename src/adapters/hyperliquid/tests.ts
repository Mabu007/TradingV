import { HyperliquidMarketDataAdapter } from './marketData';
import { markPositionToMarket } from './demo';
import {
  classifyAsset,
  displayNameFor,
  instrumentMetadata,
  normalizeSymbol,
  symbolLabel,
  uniqueSymbolLabels,
} from './normalizer';
import { runHyperliquidExecutionTests } from './executionTests';
import { AgentRuntime } from '../../engine/agents/runtime';
import { TrackerRegistry } from '../../engine/agents/trackers/registry';
import { TrackerRuntime } from '../../engine/agents/trackers/runtime';
import { Tracker } from '../../engine/agents/trackers/types';
import { CapabilityRegistry } from '../../engine/agents/capabilities/registry';
import { SkillRegistry } from '../../engine/agents/skills/registry';
import { ActionValidator } from '../../engine/agents/policy/validator';
import { InMemoryAgentTimelineStore } from '../../engine/agents/timeline';
import { IAgentModel } from '../../engine/agents/model/types';
import { ITradingEnvironment, TradingAgent } from '../../engine/agents/types';
import { eventBus } from '../../types/events';
import { Bar } from '../../types/trading';
import { NormalizedQuote } from '../../types/quotes';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const bar: Bar = { time: Math.floor(Date.now() / 1000) - 600, open: 1.14, high: 1.15, low: 1.13, close: 1.145, volume: 100 };
const environment: ITradingEnvironment = {
  mode: 'DEMO',
  async getMarketQuote(symbol): Promise<NormalizedQuote> { return { symbol, symbolId: 'xyz:EUR', bid: 1.144, ask: 1.146, spread: 0.002, timestamp: bar.time * 1000, status: 'MOCK' }; },
  async getMarketBars() { return [bar]; },
  async getAccountState() { return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 }; },
  async getPositions() { return []; },
  async getOrders() { return []; },
  async placeMarketOrder() { return { success: false, error: 'fixture' }; },
  async modifyPosition() { return { success: false, error: 'fixture' }; },
  async closePosition() { return { success: false, error: 'fixture' }; },
};

const model: IAgentModel = {
  async run() { return { thought: 'fixture wake handled', decision: { type: 'WAIT', reason: 'deterministic fixture' } }; },
};

/**
 * Market data -> tracker -> GOAT wake, through the real adapters.
 *
 * This is the observation path end to end: a normalized Hyperliquid
 * candle reaches the tracker runtime, the tracker reports, and the agent
 * is woken. The tracker is deliberately a bare engine-level one, because
 * what is under test is the market-data half, not the thesis layer.
 */
export async function runHyperliquidTrackerIntegrationTest(): Promise<void> {
  const runtime = new AgentRuntime(new CapabilityRegistry(), new SkillRegistry(), new ActionValidator(), model, new InMemoryAgentTimelineStore());
  const agent: TradingAgent = { id: 'fixture-agent', name: 'Fixture Agent', description: '', instructions: '', skills: [], capabilities: [], policy: { maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 10_000, maxOrdersPerMinute: 5, allowedSymbols: ['EUR/USD'], allowTrading: true }, preferredEnvironment: 'DEMO', symbols: ['EUR/USD'], timeframe: '5m', enabled: true, createdAt: 1, updatedAt: 1 };
  runtime.registerAgent(agent, environment); await runtime.start(agent.id);
  const registry = new TrackerRegistry((agentId) => runtime.getAgent(agentId));
  const tracker: Tracker = {
    id: 'fixture-new-bar',
    agentId: agent.id,
    kind: 'NEW_BAR',
    symbol: 'EUR/USD',
    timeframe: '5m',
    config: {},
    purpose: 'Know when a 5m candle closes.',
    eventType: 'BAR_CLOSED',
    dependencies: [],
    dataRequirements: [{ kind: 'BARS', timeframe: '5m', barCount: 100 }],
    evaluation: { priority: 0, cooldownMs: 0, maxEventsPerMinute: 10 },
    lifecycle: { status: 'ACTIVE', eventCount: 0 },
    createdAt: 1,
    updatedAt: 1,
  };
  registry.register(tracker);
  const trackers = new TrackerRuntime({ registry, agents: runtime, timeline: runtime.getTimelineStore() });
  trackers.setEnvironment('DEMO'); trackers.start();
  const adapter = new HyperliquidMarketDataAdapter('TESTNET');
  const events: string[] = []; const unsubscribe = eventBus.on('BAR_UPDATE', (event) => events.push(`${event.symbol}:${event.timeframe}:${event.isClosed}`));
  adapter.registerInstrument({ id: 'fixture', symbol: 'EUR/USD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX', provider: 'HYPERLIQUID', providerSymbol: 'xyz:EUR', providerMarketId: 'xyz:EUR', providerDex: 'xyz', supportedTimeframes: ['5m'], active: true, availability: 'TRADEABLE', market: { symbol: 'EUR/USD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX', provider: 'HYPERLIQUID', providerSymbol: 'xyz:EUR', providerMarketId: 'xyz:EUR', providerDex: 'xyz', pricePrecision: 5, sizePrecision: 1, availability: 'TRADEABLE' } as never });
  adapter.ingestCandleFixture({ t: bar.time * 1000, T: Date.now() - 1, s: 'xyz:EUR', i: '5m', o: '1.14', c: '1.145', h: '1.15', l: '1.13', v: '100', n: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  unsubscribe(); trackers.stop(); await runtime.stop(agent.id);
  assert(events.includes('EUR/USD:5m:true'), 'fixture emitted normalized BAR_UPDATE');
  assert((await runtime.getTimelineStore().getByAgent(agent.id)).some((entry) => entry.type === 'TRACKER'), 'BAR_UPDATE fired NEW_BAR and woke the agent');
  assert(trackers.listEventsForTracker(tracker.id).length > 0, 'the tracker reported an observation');
  console.log('Hyperliquid deterministic market-data -> tracker -> agent-wake test passed.');
}

/**
 * Execution economics must not depend on the asset group.
 *
 * A HIP-3 commodity/index position is sized in instrument units, so the
 * same price distance must produce the same P&L per unit as a Forex
 * position, with no pip value, lot size, or quote-currency conversion.
 */
export function runHyperliquidExecutionEconomicsTest(): void {
  const longMark = markPositionToMarket({ side: 'BUY', entryPrice: 3000, volume: 2 }, 3010, 3010.5);
  assert(longMark.markPrice === 3010, 'long positions mark to the bid');
  assert(longMark.priceDifference === 10, 'long mark uses the raw bid/ask distance');
  assert(longMark.unrealizedPnL === 20, 'commodity P&L is price distance x instrument units');
  assert(longMark.unrealizedPnlPercent === 0.33, 'commodity P&L percent is relative to entry price');

  const shortMark = markPositionToMarket({ side: 'SELL', entryPrice: 3000, volume: 2 }, 3010, 3010.5);
  assert(shortMark.markPrice === 3010.5, 'short positions mark to the ask');
  assert(shortMark.unrealizedPnL === -21, 'short positions lose the ask-side distance x units');

  const forexMark = markPositionToMarket({ side: 'BUY', entryPrice: 1.1, volume: 1000 }, 1.101, 1.1011);
  assert(forexMark.unrealizedPnL === 1, 'forex P&L remains price distance x instrument units');

  console.log('Hyperliquid asset-agnostic execution economics test passed.');
}

/**
 * Discovery normalization across the three supported asset groups.
 *
 * It runs on the exact provider universe the product trades, without a
 * network call, so namespace, precision, and lot/pip rules are pinned.
 */
export function runHyperliquidDiscoveryNormalizationTest(): void {
  const universe: Array<{
    providerSymbol: string;
    assetClass: 'FOREX' | 'COMMODITY' | 'INDEX';
    symbol: string;
    sizePrecision: number;
    pip: boolean;
    lots: boolean;
  }> = [
    { providerSymbol: 'xyz:EUR', assetClass: 'FOREX', symbol: 'EUR/USD', sizePrecision: 1, pip: true, lots: true },
    { providerSymbol: 'xyz:GBP', assetClass: 'FOREX', symbol: 'GBP/USD', sizePrecision: 0, pip: true, lots: true },
    { providerSymbol: 'xyz:JPY', assetClass: 'FOREX', symbol: 'USD/JPY', sizePrecision: 2, pip: true, lots: true },
    { providerSymbol: 'xyz:GOLD', assetClass: 'COMMODITY', symbol: 'Gold', sizePrecision: 4, pip: false, lots: false },
    { providerSymbol: 'xyz:SILVER', assetClass: 'COMMODITY', symbol: 'Silver', sizePrecision: 2, pip: false, lots: false },
    { providerSymbol: 'xyz:CL', assetClass: 'COMMODITY', symbol: 'WTI Crude Oil', sizePrecision: 3, pip: false, lots: false },
    { providerSymbol: 'xyz:BRENTOIL', assetClass: 'COMMODITY', symbol: 'Brent Crude Oil', sizePrecision: 2, pip: false, lots: false },
    { providerSymbol: 'xyz:COPPER', assetClass: 'COMMODITY', symbol: 'Copper', sizePrecision: 2, pip: false, lots: false },
    { providerSymbol: 'xyz:NATGAS', assetClass: 'COMMODITY', symbol: 'Natural Gas', sizePrecision: 1, pip: false, lots: false },
    { providerSymbol: 'xyz:PLATINUM', assetClass: 'COMMODITY', symbol: 'Platinum', sizePrecision: 4, pip: false, lots: false },
    { providerSymbol: 'xyz:PALLADIUM', assetClass: 'COMMODITY', symbol: 'Palladium', sizePrecision: 4, pip: false, lots: false },
    { providerSymbol: 'xyz:SP500', assetClass: 'INDEX', symbol: 'S&P 500', sizePrecision: 3, pip: false, lots: false },
    { providerSymbol: 'xyz:JP225', assetClass: 'INDEX', symbol: 'Japan 225', sizePrecision: 5, pip: false, lots: false },
    { providerSymbol: 'xyz:KR200', assetClass: 'INDEX', symbol: 'Korea 200', sizePrecision: 4, pip: false, lots: false },
    { providerSymbol: 'mkts:US500', assetClass: 'INDEX', symbol: 'US 500', sizePrecision: 3, pip: false, lots: false },
    { providerSymbol: 'mkts:USTECH', assetClass: 'INDEX', symbol: 'US Tech 100', sizePrecision: 3, pip: false, lots: false },
    { providerSymbol: 'mkts:SMALL2000', assetClass: 'INDEX', symbol: 'Small 2000', sizePrecision: 3, pip: false, lots: false },
  ];

  for (const entry of universe) {
    const normalized = normalizeSymbol(entry.providerSymbol);

    assert(
      classifyAsset(normalized) === entry.assetClass,
      `${entry.providerSymbol} is classified as ${entry.assetClass}`,
    );

    assert(
      symbolLabel(normalized, entry.assetClass) === entry.symbol,
      `${entry.providerSymbol} normalizes to ${entry.symbol}`,
    );

    assert(
      displayNameFor(normalized, entry.assetClass) ===
        `${entry.symbol} Perpetual`,
      `${entry.providerSymbol} keeps its perpetual display name`,
    );

    const metadata = instrumentMetadata({
      providerSymbol: normalized,
      assetClass: entry.assetClass,
      pricePrecision: 4,
      sizePrecision: entry.sizePrecision,
      maxLeverage: 25,
    });

    assert(
      metadata.providerSymbol === normalized,
      `${entry.providerSymbol} preserves its provider namespace`,
    );

    assert(
      metadata.providerMarketId === normalized,
      `${entry.providerSymbol} exposes a provider market id`,
    );

    assert(
      metadata.sizePrecision === entry.sizePrecision,
      `${entry.providerSymbol} preserves the venue size precision`,
    );

    assert(
      metadata.sizeStep === 10 ** -entry.sizePrecision,
      `${entry.providerSymbol} derives its size step from szDecimals`,
    );

    assert(
      (metadata.pipSize !== undefined) === entry.pip,
      `${entry.providerSymbol} exposes a pip size only for Forex`,
    );

    assert(
      (metadata.lotSize !== undefined) === entry.lots,
      `${entry.providerSymbol} exposes a lot size only for lot-sized Forex`,
    );
  }

  assert(
    normalizeSymbol('XYZ:eur') === 'xyz:EUR',
    'provider namespaces are lowercased and assets uppercased',
  );

  assert(
    instrumentMetadata({
      providerSymbol: 'xyz:JPY',
      assetClass: 'FOREX',
      pricePrecision: 2,
      sizePrecision: 2,
    }).quoteCurrency === 'JPY',
    'a JPY pair is quoted in JPY, not assumed to be USD',
  );

  assert(
    instrumentMetadata({
      providerSymbol: 'xyz:EUR',
      assetClass: 'FOREX',
      pricePrecision: 5,
      sizePrecision: 1,
    }).quoteCurrency === 'USD',
    'a EUR pair is quoted in USD',
  );

  assert(
    instrumentMetadata({
      providerSymbol: 'xyz:GOLD',
      assetClass: 'COMMODITY',
      pricePrecision: 1,
      sizePrecision: 4,
    }).quoteCurrency === 'USD',
    'commodity markets are quoted in the account currency',
  );

  assert(
    instrumentMetadata({
      providerSymbol: 'xyz:GOLD',
      assetClass: 'COMMODITY',
      pricePrecision: 1,
      sizePrecision: 4,
    }).contractMultiplier === undefined,
    'no contract multiplier is invented',
  );

  assert(
    instrumentMetadata({
      providerSymbol: 'xyz:GOLD',
      assetClass: 'COMMODITY',
      pricePrecision: 1,
      sizePrecision: 4,
    }).minOrderSize === undefined,
    'no minimum order size is invented when the venue publishes none',
  );

  /*
   * The same asset is published in more than one namespace, so app
   * symbols must stay unique or an order could be validated against a
   * different market than the one it names.
   */
  const ambiguous = [
    instrumentMetadata({ providerSymbol: 'xyz:GOLD', assetClass: 'COMMODITY', providerDex: 'xyz', pricePrecision: 1, sizePrecision: 4 }),
    instrumentMetadata({ providerSymbol: 'mkts:GOLD', assetClass: 'COMMODITY', providerDex: 'mkts', pricePrecision: 1, sizePrecision: 4 }),
    instrumentMetadata({ providerSymbol: 'xyz:SP500', assetClass: 'INDEX', providerDex: 'xyz', pricePrecision: 2, sizePrecision: 3 }),
  ];

  const unique = uniqueSymbolLabels(ambiguous);

  assert(
    unique.get('xyz:GOLD') === 'Gold (xyz)' &&
      unique.get('mkts:GOLD') === 'Gold (mkts)',
    'colliding labels are disambiguated by namespace',
  );

  assert(
    unique.get('xyz:SP500') === 'S&P 500',
    'a label with no collision is left untouched',
  );

  assert(
    new Set(unique.values()).size === ambiguous.length,
    'every discovered market keeps a unique app symbol',
  );
}

if (import.meta.main) {
  await runHyperliquidTrackerIntegrationTest();
  runHyperliquidExecutionEconomicsTest();
  runHyperliquidDiscoveryNormalizationTest();
  await runHyperliquidExecutionTests();
}
