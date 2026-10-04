/**
 * What a GOAT knows about a market before it forms a thesis.
 *
 * The order here is the whole argument of this file:
 *
 *     raw market data
 *          ↓
 *     deterministic tools
 *          ↓
 *     structured evidence
 *          ↓
 *     GOAT reasoning
 *
 * A GOAT used to be handed an empty quote list and asked what it believed.
 * It answered from its priors, which is indistinguishable from inventing.
 * Everything below is therefore read from the same capabilities the agent
 * runtime already exposes, over the same Hyperliquid feed, and nothing is
 * computed by a language model.
 *
 * Two implementation notes that matter more than they look:
 *
 *   The tools are executed through the capability registry rather than
 *   re-implemented here. One place decides what "an ATR" means, and the
 *   GOAT cannot disagree with the rest of the system about it.
 *
 *   The environment is memoised for the duration of one collection. The
 *   Hyperliquid adapter fetches bars over REST on every call, so ten tools
 *   would otherwise be ten round trips for the same candles — and, worse,
 *   ten slightly different answers for the same market.
 */

import type { AgentPolicy, ITradingEnvironment, TradingEnvironmentMode } from '../agents/types';
import type { CapabilityRegistry } from '../agents/capabilities';
import type { NormalizedQuote } from '../../types/quotes';
import type { Bar } from '../../types/trading';

export interface MarketContextRequest {
  agentId: string;
  symbol: string;
  timeframe: string;
  policy: AgentPolicy;
  mode: TradingEnvironmentMode;
}

export interface StructureContext {
  swingHighs?: Array<{ price: number; time: number }>;
  swingLows?: Array<{ price: number; time: number }>;
  resistanceLevels?: number[];
  supportLevels?: number[];
  breakout?: { breakout: string; level?: number; priceDistance?: number };
}

export interface IndicatorContext {
  sma?: Record<string, unknown>;
  ema?: Record<string, unknown>;
  rsi?: Record<string, unknown>;
  atr?: Record<string, unknown>;
}

export interface MarketContext {
  symbol: string;
  timeframe: string;
  /** The observation this context was built from, so callers need not refetch. */
  quote?: NormalizedQuote;
  spread?: Record<string, unknown>;
  session?: Record<string, unknown>;
  bars: { requested: number; received: number; firstTime?: number; lastTime?: number };
  structure: StructureContext;
  indicators: IndicatorContext;
  /**
   * What could not be read, in words.
   *
   * A limitation is not an error: a GOAT with no ATR is a GOAT that knows
   * it has no ATR, and telling it so is better than letting it assume zero
   * volatility and reason from that.
   */
  limitations: string[];
}

const BAR_COUNT = 120;

/**
 * The tools consulted, in the order that costs the fewest round trips.
 *
 * `input` is filtered against each tool's declared schema before the call,
 * because the registry refuses an input carrying a field the tool did not
 * ask for. Sending `timeframe` to a tool that does not take it is refused
 * rather than ignored, so the filter here is what keeps a tool working.
 */
const TOOLS: Array<{ id: string; input: Record<string, unknown> }> = [
  { id: 'market.getQuote', input: {} },
  { id: 'market.getSpread', input: {} },
  { id: 'market.getSession', input: {} },
  { id: 'structure.swingHighs', input: {} },
  { id: 'structure.swingLows', input: {} },
  { id: 'structure.supportResistance', input: {} },
  { id: 'structure.breakout', input: {} },
  { id: 'indicators.atr', input: { period: 14 } },
  { id: 'indicators.rsi', input: { period: 14 } },
  { id: 'indicators.sma', input: { period: 20 } },
  { id: 'indicators.ema', input: { period: 50 } },
];

/**
 * The subset of `input` a tool declares.
 *
 * A capability's `inputSchema` is a flat map of field name to descriptor —
 * `{ symbol: { type: 'string' } }` — and the registry refuses any field not
 * in it. Reading that map is how one caller can serve eleven tools with
 * eleven different shapes without knowing any of them.
 *
 * It also means a tool that asks for nothing gets nothing: `market.getSession`
 * declares no fields at all, so passing it a symbol would be refused.
 */
function inputFor(
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return {};

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key in schema) filtered[key] = value;
  }
  return filtered;
}

/**
 * One collection, one set of answers.
 *
 * Scoped to a single collection on purpose: a cache that outlives one
 * collection is a cache that shows the GOAT yesterday's candles as if they
 * were current, which is the specific failure this file exists to remove.
 */
function memoisedEnvironment(env: ITradingEnvironment): ITradingEnvironment {
  const quotes = new Map<string, Promise<NormalizedQuote>>();
  const bars = new Map<string, Promise<Bar[]>>();

  const bound: ITradingEnvironment = {
    ...env,
    mode: env.mode,
    getMarketQuote: (symbol) => {
      const existing = quotes.get(symbol);
      if (existing) return existing;
      const pending = env.getMarketQuote(symbol);
      quotes.set(symbol, pending);
      return pending;
    },
    getMarketBars: (symbol, timeframe, count) => {
      const key = `${symbol}:${timeframe}:${count}`;
      const existing = bars.get(key);
      if (existing) return existing;
      const pending = env.getMarketBars(symbol, timeframe, count);
      bars.set(key, pending);
      return pending;
    },
  };
  return bound;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect market context for one symbol.
 *
 * Never throws. A GOAT that cannot read the market still needs to be able
 * to say so, and a hard failure here would leave it unable to form any
 * thesis at all, which is the same as inventing one.
 */
export async function collectMarketContext(
  env: ITradingEnvironment,
  capabilities: CapabilityRegistry,
  request: MarketContextRequest,
): Promise<MarketContext> {
  const context: MarketContext = {
    symbol: request.symbol,
    timeframe: request.timeframe,
    bars: { requested: BAR_COUNT, received: 0 },
    structure: {},
    indicators: {},
    limitations: [],
  };

  if (!request.symbol.trim()) {
    /*
     * Named here rather than only by the caller, because an empty symbol
     * reaching a tool produces a scope error rather than an honest answer,
     * and a GOAT told "symbol  is outside this agent's scope" has learned
     * nothing useful about its situation.
     */
    context.limitations.push('No market has been chosen yet.');
    return context;
  }

  const cached = memoisedEnvironment(env);
  const capabilityContext = {
    agentId: request.agentId,
    environment: request.mode,
    env: cached,
    symbol: request.symbol,
    timeframe: request.timeframe,
    policy: request.policy,
    symbols: request.policy.allowedSymbols?.length
      ? request.policy.allowedSymbols
      : [request.symbol],
  };

  for (const tool of TOOLS) {
    const capability = capabilities.get(tool.id);
    if (!capability) {
      context.limitations.push(`${tool.id} is not available.`);
      continue;
    }
    try {
      const result = await capabilities.execute(
        tool.id,
        inputFor(capability.inputSchema, {
          ...tool.input,
          symbol: request.symbol,
          timeframe: request.timeframe,
        }),
        capabilityContext,
      );
      if (tool.id === 'market.getQuote' && isRecord(result)) {
        context.quote = { ...(result as unknown as NormalizedQuote) };
        continue;
      }
      if (tool.id === 'structure.swingHighs' && isRecord(result) && Array.isArray(result.highs)) {
        context.structure.swingHighs = result.highs as Array<{ price: number; time: number }>;
        continue;
      }
      if (tool.id === 'structure.swingLows' && isRecord(result) && Array.isArray(result.lows)) {
        context.structure.swingLows = result.lows as Array<{ price: number; time: number }>;
        continue;
      }
      if (tool.id === 'structure.supportResistance' && isRecord(result)) {
        context.structure.resistanceLevels = toNumbers(result.resistanceLevels);
        context.structure.supportLevels = toNumbers(result.supportLevels);
        continue;
      }
      if (tool.id === 'structure.breakout' && isRecord(result)) {
        context.structure.breakout = {
          breakout: String(result.breakout ?? 'UNKNOWN'),
          ...(typeof result.level === 'number' ? { level: result.level } : {}),
          ...(typeof result.priceDistance === 'number'
            ? { priceDistance: result.priceDistance }
            : {}),
        };
        continue;
      }
      if (tool.id.startsWith('indicators.') && isRecord(result)) {
        const key = tool.id.split('.')[1] as keyof IndicatorContext;
        context.indicators[key] = result;
        continue;
      }
      if (tool.id === 'market.getSpread' && isRecord(result)) {
        context.spread = result;
        continue;
      }
      if (tool.id === 'market.getSession' && isRecord(result)) {
        context.session = result;
      }
    } catch (error) {
      context.limitations.push(
        `${tool.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /*
   * The candle range is read from the same memoised environment, so this
   * costs nothing beyond what the tools already fetched. It is recorded
   * because "these numbers came from 120 fifteen-minute candles" is part
   * of what the GOAT is entitled to know.
   */
  try {
    const bars = await cached.getMarketBars(request.symbol, request.timeframe, BAR_COUNT);
    context.bars = {
      requested: BAR_COUNT,
      received: bars.length,
      firstTime: bars[0]?.time,
      lastTime: bars[bars.length - 1]?.time,
    };
    if (bars.length === 0) {
      context.limitations.push('No candles were returned for this market and timeframe.');
    }
  } catch (error) {
    context.limitations.push(
      `Candles: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return context;
}

function toNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is number => typeof entry === 'number');
}

/**
 * Render market context for a prompt.
 *
 * Deliberately flat and numeric. Every value here was computed by a
 * deterministic tool, and a model asked to reason over prose is a model
 * being asked to do arithmetic.
 */
export function renderMarketContext(context: MarketContext): string {
  const lines: string[] = [];

  lines.push(`Symbol: ${context.symbol}`);
  lines.push(`Timeframe: ${context.timeframe}`);
  lines.push(
    `Candles available: ${context.bars.received} (requested ${context.bars.requested})`,
  );

  if (context.quote) {
    lines.push(
      `Quote: bid ${context.quote.bid} / ask ${context.quote.ask} / spread ${context.quote.spread} (${context.quote.status})`,
    );
  }
  if (context.spread && typeof context.spread.spreadBps === 'number') {
    lines.push(`Spread: ${context.spread.spreadBps} bps`);
  }
  if (context.session && typeof context.session.activeSession === 'string') {
    lines.push(`Session: ${context.session.activeSession} (UTC ${context.session.utcHour ?? '??'}:${String(context.session.utcMinute ?? '??').padStart(2, '0')})`);
  }

  const { structure, indicators } = context;
  if (structure.swingHighs?.length) {
    lines.push(`Recent swing highs: ${structure.swingHighs.slice(-4).map((s) => s.price).join(', ')}`);
  }
  if (structure.swingLows?.length) {
    lines.push(`Recent swing lows: ${structure.swingLows.slice(-4).map((s) => s.price).join(', ')}`);
  }
  if (structure.resistanceLevels?.length) {
    lines.push(`Resistance: ${structure.resistanceLevels.join(', ')}`);
  }
  if (structure.supportLevels?.length) {
    lines.push(`Support: ${structure.supportLevels.join(', ')}`);
  }
  if (structure.breakout) {
    lines.push(
      `Breakout state: ${structure.breakout.breakout}${
        structure.breakout.level !== undefined ? ` at ${structure.breakout.level}` : ''
      }${
        structure.breakout.priceDistance !== undefined
          ? ` (price is ${structure.breakout.priceDistance} away)`
          : ''
      }`,
    );
  }

  lines.push(...indicatorLines('ATR (14)', indicators.atr, ['latestValue', 'latestPips']));
  lines.push(...indicatorLines('RSI (14)', indicators.rsi, ['latest', 'condition']));
  lines.push(...indicatorLines('SMA (20)', indicators.sma, ['latest']));
  lines.push(...indicatorLines('EMA (50)', indicators.ema, ['latest']));

  if (context.limitations.length > 0) {
    lines.push('');
    lines.push('What you could not read (assume nothing about these):');
    for (const limitation of context.limitations) lines.push(`- ${limitation}`);
  }

  return lines.join('\n');
}

function indicatorLines(
  label: string,
  indicator: Record<string, unknown> | undefined,
  fields: string[],
): string[] {
  if (!indicator) return [];
  const parts: string[] = [];
  for (const field of fields) {
    const value = indicator[field];
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${field} ${value}`);
    else if (typeof value === 'string') parts.push(`${field} ${value}`);
  }
  return parts.length > 0 ? [`${label}: ${parts.join(', ')}`] : [];
}

/**
 * The numbers worth keeping as evidence.
 *
 * Only what is both finite and decision-relevant. A full indicator series
 * in the evidence log would be unreadable and would grow without bound;
 * these are the values a person needs in order to check the GOAT's claim.
 */
export function marketContextEvidence(
  context: MarketContext,
): Record<string, number | string> {
  const observed: Record<string, number | string> = {
    symbol: context.symbol,
    timeframe: context.timeframe,
    candles: context.bars.received,
  };

  if (context.quote) {
    observed.bid = context.quote.bid;
    observed.ask = context.quote.ask;
  }
  const atr = context.indicators.atr?.['latestValue'];
  if (typeof atr === 'number' && Number.isFinite(atr)) observed.atr = atr;
  const rsi = context.indicators.rsi?.['latest'];
  if (typeof rsi === 'number' && Number.isFinite(rsi)) observed.rsi = rsi;
  const breakout = context.structure.breakout?.breakout;
  if (breakout) observed.breakout = breakout;

  return observed;
}
