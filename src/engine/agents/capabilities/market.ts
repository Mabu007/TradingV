import { AgentCapability } from '../types';
import { pipSizeFor, resolveInstrument } from './instruments';

export const marketGetQuoteCapability: AgentCapability<
  { symbol?: string },
  { symbol: string; bid: number; ask: number; spread: number; status: string; timestamp: number }
> = {
  id: 'market.getQuote',
  name: 'Get Market Quote',
  description: 'Retrieves the latest bid, ask, and spread for a specified market instrument.',
  category: 'market',
  inputSchema: {
    symbol: { type: 'string', description: 'Instrument symbol e.g. EURUSD' },
  },
  outputSchema: {
    symbol: { type: 'string' },
    bid: { type: 'number' },
    ask: { type: 'number' },
    spread: { type: 'number' },
    status: { type: 'string' },
    timestamp: { type: 'number' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const quote = await context.env.getMarketQuote(symbol);
    return {
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
      status: quote.status,
      timestamp: quote.timestamp,
    };
  },
};

export const marketGetBarsCapability: AgentCapability<
  { symbol?: string; timeframe?: string; count?: number },
  { symbol: string; timeframe: string; count: number; bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }> }
> = {
  id: 'market.getBars',
  name: 'Get Historical Bars',
  description: 'Retrieves historical OHLCV candlestick bars for a specified symbol and timeframe.',
  category: 'market',
  inputSchema: {
    symbol: { type: 'string', description: 'Symbol e.g. EURUSD' },
    timeframe: { type: 'string', default: '5m' },
    count: { type: 'number', default: 50, maximum: 300 },
  },
  outputSchema: {
    symbol: { type: 'string' },
    timeframe: { type: 'string' },
    count: { type: 'number' },
    bars: { type: 'array' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const timeframe = input.timeframe || context.timeframe || '5m';
    if (input.count !== undefined && (!Number.isInteger(input.count) || input.count <= 0)) throw new Error('count must be a positive integer.');
    const requestedCount = input.count ?? 50;
    if (!Number.isInteger(requestedCount) || requestedCount < 1) throw new Error('count must be a positive integer.');
    const count = Math.min(requestedCount, 300);
    const bars = await context.env.getMarketBars(symbol, timeframe, count);
    return {
      symbol,
      timeframe,
      count: bars.length,
      bars,
    };
  },
};

export const marketGetSpreadCapability: AgentCapability<
  { symbol?: string; maxSpread?: number; maxSpreadPips?: number },
  {
    symbol: string;
    spread: number;
    spreadPips: number | null;
    spreadBps: number;
    isNormal: boolean;
    thresholdConfigured: boolean;
  }
> = {
  id: 'market.getSpread',
  name: 'Get Market Spread',
  description: 'Evaluates current broker spread and flags whether spread is normal or widened.',
  category: 'market',
  inputSchema: {
    symbol: { type: 'string', description: 'Symbol e.g. EUR/USD' },
    maxSpread: {
      type: 'number',
      description:
        'Widest acceptable spread as a raw price distance. Use for any asset class.',
    },
    maxSpreadPips: {
      type: 'number',
      description:
        'Widest acceptable spread in pips. Forex only; requires a pip-quoted instrument.',
    },
  },
  outputSchema: {
    symbol: { type: 'string' },
    spread: { type: 'number', description: 'Bid/ask difference in price.' },
    spreadPips: {
      type: 'number',
      nullable: true,
      description: 'Only defined for pip-quoted Forex instruments.',
    },
    spreadBps: {
      type: 'number',
      description: 'Spread relative to price, in basis points.',
    },
    isNormal: { type: 'boolean' },
    thresholdConfigured: { type: 'boolean' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    if (!context.symbols.includes(symbol)) throw new Error(`Symbol ${symbol} is outside this agent's configured scope.`);
    const quote = await context.env.getMarketQuote(symbol);

    /*
     * There is no universal "normal" spread: it depends on the
     * instrument and its liquidity. The real spread is always reported;
     * whether it is normal is only judged when the caller supplies a
     * threshold for that instrument.
     */
    const pipSize = pipSizeFor(
      await resolveInstrument(context.env, symbol),
    );

    const mid =
      Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.ask > 0
        ? (quote.bid + quote.ask) / 2
        : 0;

    const spreadBps =
      mid > 0 ? Number(((quote.spread / mid) * 10_000).toFixed(2)) : 0;

    const threshold =
      input.maxSpread ??
      (pipSize !== undefined && input.maxSpreadPips !== undefined
        ? input.maxSpreadPips * pipSize
        : undefined);

    return {
      symbol,
      spread: quote.spread,
      spreadPips:
        pipSize !== undefined
          ? Number((quote.spread / pipSize).toFixed(2))
          : null,
      spreadBps,
      isNormal: threshold !== undefined ? quote.spread <= threshold : true,
      thresholdConfigured: threshold !== undefined,
    };
  },
};

export const marketGetSessionCapability: AgentCapability<
  Record<string, never>,
  { activeSession: 'LONDON' | 'NEW_YORK' | 'ASIAN' | 'WEEKEND_CLOSE' | 'OVERLAP'; utcHour: number; utcMinute: number; description: string }
> = {
  id: 'market.getSession',
  name: 'Get Market Session',
  description: 'Identifies the active global trading session based on current UTC time.',
  category: 'market',
  inputSchema: {},
  outputSchema: {
    activeSession: { type: 'string' },
    utcHour: { type: 'number' },
    utcMinute: { type: 'number' },
    description: { type: 'string' },
  },
  async execute(_, context) {
    const currentTime = context.env.mode === 'BACKTEST'
      ? (await context.env.getMarketBars(context.symbol || 'EURUSD', context.timeframe || '5m', 1))[0]?.time
      : undefined;
    const now = new Date(currentTime ? currentTime * 1000 : Date.now());
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const day = now.getUTCDay();

    // Weekend (Saturday after 21:00 UTC through Sunday 21:00 UTC)
    if (day === 6 || (day === 0 && utcHour < 21) || (day === 5 && utcHour >= 22)) {
      return {
        activeSession: 'WEEKEND_CLOSE',
        utcHour,
        utcMinute,
        description: 'Global forex markets are closed for the weekend.',
      };
    }

    // London: 07:00 - 16:00 UTC; New York: 12:00 - 21:00 UTC; Overlap: 12:00 - 16:00 UTC
    if (utcHour >= 12 && utcHour < 16) {
      return {
        activeSession: 'OVERLAP',
        utcHour,
        utcMinute,
        description: 'London / New York Session Overlap — Highest global volume and liquidity.',
      };
    }

    if (utcHour >= 7 && utcHour < 16) {
      return {
        activeSession: 'LONDON',
        utcHour,
        utcMinute,
        description: 'London European Session — Strong trending breakouts and session expansion.',
      };
    }

    if (utcHour >= 12 && utcHour < 21) {
      return {
        activeSession: 'NEW_YORK',
        utcHour,
        utcMinute,
        description: 'New York Session — High momentum driven by US economic releases.',
      };
    }

    return {
      activeSession: 'ASIAN',
      utcHour,
      utcMinute,
      description: 'Tokyo / Asian Session — Lower volatility consolidation ranges.',
    };
  },
};

/**
 * What the venue publishes about a market beyond price and candles.
 *
 * This is the capability that makes research open rather than a fixed list of
 * five price-shaped fields. Funding, open interest and volume decide whether
 * a breakout has anything behind it, and an agent that cannot ask cannot
 * reason about them — so it asks here rather than guessing.
 *
 * The honesty rule is the whole design: a fact the venue does not publish
 * comes back in `unavailable` with a reason, never as a zero. A GOAT told
 * "this market has no funding" plans around it; a GOAT told `fundingRate: 0`
 * concludes funding is neutral, which is a different and wrong claim.
 */
const marketGetContextCapability: AgentCapability = {
  id: 'market.getContext',
  name: 'Get Market Context',
  description:
    'Reads what the venue publishes beyond price and candles: funding rate, open interest, 24h volume, mark price and 24h change. Reports honestly when the venue publishes none of it.',
  category: 'market',
  inputSchema: {},
  outputSchema: {
    fundingRate: { type: 'number' },
    fundingAnnualPercent: { type: 'number' },
    openInterest: { type: 'number' },
    dayVolume: { type: 'number' },
    markPrice: { type: 'number' },
    change24hPercent: { type: 'number' },
    unavailable: { type: 'array' },
  },
  async execute(_, context) {
    const symbol = context.symbol || '';
    const unavailable: string[] = [];

    if (typeof context.env.getMarketContext !== 'function') {
      return {
        unavailable: ['This environment publishes no market context beyond price and candles.'],
        source: 'none',
      };
    }

    let facts;
    try {
      facts = await context.env.getMarketContext(symbol);
    } catch (error) {
      // A failed read is a missing fact, and is reported as one. Returning
      // zeros here would be the single most damaging thing this file could
      // do: every downstream judgement would look measured and be invented.
      return {
        unavailable: [
          `The venue did not return market context for ${symbol || 'this market'}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        source: 'error',
      };
    }

    for (const reason of facts.unavailable ?? []) unavailable.push(reason);

    const annualise = (rate: number): number => {
      const hours = facts.fundingIntervalHours ?? 1;
      const periodsPerYear = (365 * 24) / hours;
      return rate * periodsPerYear * 100;
    };

    if (typeof facts.fundingRate !== 'number' || !Number.isFinite(facts.fundingRate)) {
      unavailable.push(`No funding rate is published for ${symbol || 'this market'}.`);
    }

    return {
      ...(typeof facts.fundingRate === 'number' ? { fundingRate: facts.fundingRate } : {}),
      ...(typeof facts.fundingRate === 'number'
        ? { fundingAnnualPercent: annualise(facts.fundingRate) }
        : {}),
      ...(typeof facts.fundingIntervalHours === 'number'
        ? { fundingIntervalHours: facts.fundingIntervalHours }
        : {}),
      ...(typeof facts.openInterest === 'number' ? { openInterest: facts.openInterest } : {}),
      ...(typeof facts.dayVolume === 'number' ? { dayVolume: facts.dayVolume } : {}),
      ...(typeof facts.markPrice === 'number' ? { markPrice: facts.markPrice } : {}),
      ...(typeof facts.oraclePrice === 'number' ? { oraclePrice: facts.oraclePrice } : {}),
      ...(typeof facts.change24hPercent === 'number'
        ? { change24hPercent: facts.change24hPercent }
        : {}),
      ...(unavailable.length > 0 ? { unavailable } : {}),
      ...(facts.source ? { source: facts.source } : {}),
    };
  },
};

export const MARKET_CAPABILITIES = [
  marketGetQuoteCapability,
  marketGetBarsCapability,
  marketGetSpreadCapability,
  marketGetSessionCapability,
  marketGetContextCapability,
];
