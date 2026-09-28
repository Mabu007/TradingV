import { AgentCapability } from '../types';
import {
  aggregateExposure,
  riskToStop,
} from '../../execution/valuation';
import {
  lotSizeFor,
  pipSizeFor,
  resolveInstrument,
  resolveInstruments,
} from './instruments';

export const riskCalculatePositionSizeCapability: AgentCapability<
  {
    symbol?: string;
    /** Forex stop distance in pips. Only valid for pip-quoted instruments. */
    stopLossPips?: number;
    /** Stop price. Works for every asset class. */
    stopPrice?: number;
    /** Current price used when only a pip distance is supplied. */
    referencePrice?: number;
    riskPercent?: number;
  },
  {
    volumeUnits: number;
    lots: number | null;
    dollarRisk: number;
    maxAllowedUnits: number;
    calculations: {
      accountEquity: number;
      priceDistance: number;
      referencePrice?: number;
      stopLossPips?: number;
      unitLabel: string;
    };
  }
> = {
  id: 'risk.calculatePositionSize',
  name: 'Calculate Position Size',
  description:
    'Calculates a safe position size in instrument units from account equity and a stop. Accepts a stop price for any asset, or a pip distance for pip-quoted (Forex) instruments only.',
  category: 'risk',
  inputSchema: {
    symbol: { type: 'string' },
    stopPrice: { type: 'number', minimum: 0 },
    stopLossPips: {
      type: 'number',
      minimum: 0,
      description:
        'Forex only. Requires an instrument whose metadata declares a pip size.',
    },
    referencePrice: {
      type: 'number',
      minimum: 0,
      description:
        'Current price, required with stopLossPips to convert pips to a price distance.',
    },
    riskPercent: { type: 'number', minimum: 0, default: 1.0, maximum: 100 },
  },
  outputSchema: {
    volumeUnits: { type: 'number', description: 'Size in instrument units.' },
    lots: {
      type: 'number',
      nullable: true,
      description: 'Null for instruments that are not sized in lots.',
    },
    dollarRisk: { type: 'number' },
    maxAllowedUnits: { type: 'number' },
    calculations: { type: 'object' },
  },
  async execute(input, context) {
    const symbol = input.symbol || context.symbol || 'EURUSD';
    const metadata = await resolveInstrument(context.env, symbol);

    const pipSize = pipSizeFor(metadata);
    const account = await context.env.getAccountState();

    if (!Number.isFinite(account.equity) || account.equity <= 0) {
      throw new Error(
        'A positive authoritative account equity is required to size positions.',
      );
    }

    if (input.riskPercent !== undefined && (!Number.isFinite(input.riskPercent) || input.riskPercent < 0)) {
      throw new Error('riskPercent must be a non-negative finite number.');
    }

    const policyPercent = context.policy.maxRiskPerTrade * 100;
    const requestedPercent = input.riskPercent ?? policyPercent;
    const riskPercent = Math.min(Math.max(requestedPercent, 0), policyPercent);
    const riskBudget = account.equity * (riskPercent / 100);

    let priceDistance: number;
    let referencePrice = input.referencePrice;

    if (input.stopPrice !== undefined) {
      if (!Number.isFinite(input.stopPrice) || input.stopPrice <= 0) {
        throw new Error('stopPrice must be a positive finite number.');
      }

      if (referencePrice === undefined) {
        const quote = await context.env.getMarketQuote(symbol);
        referencePrice = quote.ask > 0 ? quote.ask : quote.bid;
      }

      if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        throw new Error('A positive reference price is required to size a position.');
      }

      priceDistance = Math.abs(referencePrice - input.stopPrice);
    } else if (input.stopLossPips !== undefined) {
      /*
       * Pips are a Forex concept. They may only be used when the
       * instrument's own metadata declares a pip size, so a commodity
       * or index can never be sized with EUR/USD pip maths.
       */
      if (!Number.isFinite(input.stopLossPips) || input.stopLossPips <= 0) {
        throw new Error('stopLossPips must be a positive finite number.');
      }

      if (!pipSize) {
        throw new Error(
          `${symbol} is not a pip-quoted instrument. Provide stopPrice instead of stopLossPips.`,
        );
      }

      if (referencePrice === undefined) {
        const quote = await context.env.getMarketQuote(symbol);
        referencePrice = quote.ask > 0 ? quote.ask : quote.bid;
      }

      if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        throw new Error('A positive reference price is required to convert pips to a price distance.');
      }

      priceDistance = input.stopLossPips * pipSize;
    } else {
      throw new Error(
        'Provide stopPrice for any instrument, or stopLossPips for a pip-quoted Forex instrument.',
      );
    }

    if (priceDistance <= 0) {
      throw new Error('The stop must be a different price from the entry.');
    }

    const rawUnits = riskBudget / priceDistance;
    const existingPositions = await context.env.getPositions();
    const currentUnits = existingPositions.reduce(
      (sum, position) => sum + Math.abs(position.volume),
      0,
    );
    const remainingExposure = Math.max(
      0,
      context.policy.maxExposure - currentUnits,
    );

    /*
     * Clamp to a whole step of the instrument's own size grid, and to
     * the exposure the policy still allows. `maxExposure` here is a
     * notional budget, so the unit clamp only uses the remaining budget
     * expressed as the maximum single-order unit allowance.
     */
    const step = metadata?.sizeStep;
    const steppedUnits =
      step && step > 0
        ? Math.floor(rawUnits / step) * step
        : Math.floor(rawUnits);

    const volumeUnits = Number(
      Math.max(0, Math.min(steppedUnits, remainingExposure)).toFixed(
        metadata?.sizePrecision ?? 8,
      ),
    );

    const lotSize = lotSizeFor(metadata);

    return {
      volumeUnits,
      lots:
        typeof lotSize === 'number'
          ? Number((volumeUnits / lotSize).toFixed(2))
          : null,
      dollarRisk: Number(
        (priceDistance * volumeUnits).toFixed(2),
      ),
      maxAllowedUnits: remainingExposure,
      calculations: {
        accountEquity: account.equity,
        priceDistance,
        referencePrice,
        stopLossPips: input.stopLossPips,
        unitLabel:
          typeof lotSize === 'number'
            ? 'lots (converted to instrument units)'
            : 'instrument units',
      },
    };
  },
};

export const riskCalculateRiskCapability: AgentCapability<
  { symbol?: string; volume: number; entryPrice: number; stopLossPrice: number },
  { dollarRisk: number; available: boolean; reason?: string; percentOfEquity: number | null; priceDistance: number; pipDistance: number | null }
> = {
  id: 'risk.calculateRisk',
  name: 'Calculate Trade Risk',
  description:
    'Calculates the loss at a stop in the account currency, for any asset class.',
  category: 'risk',
  inputSchema: {
    symbol: { type: 'string' },
    volume: { type: 'number' },
    entryPrice: { type: 'number' },
    stopLossPrice: { type: 'number' },
  },
  outputSchema: {
    dollarRisk: { type: 'number' },
    available: { type: 'boolean' },
    reason: { type: 'string' },
    percentOfEquity: { type: 'number', nullable: true },
    priceDistance: { type: 'number' },
    pipDistance: {
      type: 'number',
      nullable: true,
      description: 'Only defined for pip-quoted Forex instruments.',
    },
  },
  async execute(input, context) {
    if (!Number.isFinite(input.volume) || input.volume <= 0 || !Number.isFinite(input.entryPrice) || input.entryPrice <= 0 ||
        !Number.isFinite(input.stopLossPrice) || input.stopLossPrice <= 0) {
      throw new Error('volume, entryPrice, and stopLossPrice must be positive finite numbers.');
    }

    const symbol = input.symbol || context.symbol || 'EURUSD';
    const metadata = await resolveInstrument(context.env, symbol);

    const account = await context.env.getAccountState();

    const risk = riskToStop({
      symbol,
      metadata,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLossPrice,
      quantity: input.volume,
    });

    const pipSize = pipSizeFor(metadata);

    const dollarRisk = risk.available
      ? Number((risk.value ?? 0).toFixed(2))
      : 0;

    return {
      dollarRisk,
      available: risk.available,
      reason: risk.reason,
      percentOfEquity:
        risk.available && account.equity > 0
          ? Number(((dollarRisk / account.equity) * 100).toFixed(2))
          : null,
      priceDistance: risk.priceDistance,
      pipDistance: pipSize
        ? Number((risk.priceDistance / pipSize).toFixed(1))
        : null,
    };
  },
};

export const riskCalculateExposureCapability: AgentCapability<
  Record<string, never>,
  {
    totalUnits: number;
    totalLots: number | null;
    totalNotional: number;
    complete: boolean;
    unresolved: string[];
    notionalBySymbol: Record<string, number>;
    maxAllowedNotional: number;
    exposureRatioPercent: number | null;
  }
> = {
  id: 'risk.calculateExposure',
  name: 'Calculate Account Exposure',
  description:
    'Audits total exposure valued in the account currency, across every open position and asset class.',
  category: 'risk',
  inputSchema: {},
  outputSchema: {
    totalUnits: { type: 'number' },
    totalLots: {
      type: 'number',
      nullable: true,
      description: 'Null when any open instrument is not lot-sized.',
    },
    totalNotional: { type: 'number' },
    complete: { type: 'boolean' },
    unresolved: { type: 'array' },
    notionalBySymbol: { type: 'object' },
    maxAllowedNotional: { type: 'number' },
    exposureRatioPercent: { type: 'number', nullable: true },
  },
  async execute(_, context) {
    const positions = await context.env.getPositions();
    const instruments = await resolveInstruments(context.env);

    const summary = aggregateExposure(
      positions.map((position) => {
        const metadata = instruments.find(
          (candidate) => candidate.symbol === position.symbol,
        );

        return {
          symbol: position.symbol,
          quantity: Math.abs(position.volume),
          metadata,
          referencePrice:
            position.currentPrice || position.entryPrice,
        };
      }),
    );

    const notionalBySymbol: Record<string, number> = {};
    summary.legs.forEach((leg) => {
      notionalBySymbol[leg.symbol] = Number(
        (notionalBySymbol[leg.symbol] ?? 0) + (leg.value ?? 0),
      );
    });

    const totalUnits = positions.reduce(
      (sum, position) => sum + Math.abs(position.volume),
      0,
    );

    const allLotSized =
      positions.length > 0 &&
      positions.every((position) =>
        lotSizeFor(
          instruments.find(
            (candidate) => candidate.symbol === position.symbol,
          ),
        ),
      );

    const lotSize = lotSizeFor(
      instruments.find((candidate) => candidate.symbol === positions[0]?.symbol),
    );

    const maxAllowedNotional = context.policy.maxExposure;

    return {
      totalUnits,
      totalLots:
        allLotSized && lotSize
          ? Number((totalUnits / lotSize).toFixed(2))
          : null,
      totalNotional: Number(summary.total.toFixed(2)),
      complete: summary.complete,
      unresolved: summary.unresolved,
      notionalBySymbol,
      maxAllowedNotional,
      exposureRatioPercent:
        summary.complete && maxAllowedNotional > 0
          ? Number(
              ((summary.total / maxAllowedNotional) * 100).toFixed(1),
            )
          : null,
    };
  },
};

export const riskCheckTradeCapability: AgentCapability<
  { symbol: string; side: 'BUY' | 'SELL'; volume: number; stopLossPrice?: number },
  { approved: boolean; reason?: string; metrics: { maxPositionsAllowed: number; currentPositions: number; exposureAfterTrade: number } }
> = {
  id: 'risk.checkTrade',
  name: 'Pre-Trade Risk Verification',
  description: 'Validates an intended order against risk limits before submission.',
  category: 'risk',
  inputSchema: {
    symbol: { type: 'string' },
    side: { type: 'string' },
    volume: { type: 'number' },
    stopLossPrice: { type: 'number' },
  },
  outputSchema: {
    approved: { type: 'boolean' },
    reason: { type: 'string' },
    metrics: { type: 'object' },
  },
  async execute(input, context) {
    const positions = await context.env.getPositions();
    const currentPositions = positions.length;
    const state = await context.env.getAccountState();
    const maxPositionsAllowed = context.policy.maxOpenPositions;
    const instruments = await resolveInstruments(context.env);

    const quote = await context.env.getMarketQuote(input.symbol);
    const entryPrice = input.side === 'BUY' ? quote.ask : quote.bid;
    const stopLossPrice = input.stopLossPrice;
    const validStop =
      typeof stopLossPrice === 'number' &&
      Number.isFinite(stopLossPrice) &&
      (input.side === 'BUY'
        ? stopLossPrice < entryPrice
        : stopLossPrice > entryPrice);

    const newLeg = {
      symbol: input.symbol,
      quantity: Math.abs(input.volume),
      metadata: instruments.find(
        (candidate) => candidate.symbol === input.symbol,
      ),
      referencePrice: entryPrice,
    };

    const exposure = aggregateExposure([
      ...positions.map((position) => ({
        symbol: position.symbol,
        quantity: Math.abs(position.volume),
        metadata: instruments.find(
          (candidate) => candidate.symbol === position.symbol,
        ),
        referencePrice:
          position.currentPrice || position.entryPrice,
      })),
      newLeg,
    ]);

    const exposureAfterTrade = exposure.complete
      ? exposure.total
      : Number.NaN;

    const risk = validStop
      ? riskToStop({
          symbol: input.symbol,
          metadata: newLeg.metadata,
          entryPrice,
          stopLoss: stopLossPrice,
          quantity: input.volume,
        })
      : undefined;

    const metrics = {
      maxPositionsAllowed,
      currentPositions,
      exposureAfterTrade,
    };

    if (!context.policy.allowTrading) {
      return { approved: false, reason: 'Trading is disabled by agent policy.', metrics };
    }
    if (context.policy.allowedSymbols.length > 0 && !context.policy.allowedSymbols.includes(input.symbol)) {
      return { approved: false, reason: `Symbol ${input.symbol} is not allowed by agent policy.`, metrics };
    }
    if (context.policy.maxDailyLoss !== undefined && state.dailyPnL !== null && state.dailyPnL <= -context.policy.maxDailyLoss) {
      return { approved: false, reason: 'Maximum daily loss exceeded.', metrics };
    }
    if (context.policy.maxDrawdown !== undefined && state.drawdownPercent !== null && state.drawdownPercent > context.policy.maxDrawdown * 100) {
      return { approved: false, reason: 'Maximum drawdown exceeded.', metrics };
    }
    if (currentPositions >= maxPositionsAllowed) {
      return {
        approved: false,
        reason: `Maximum open positions limit (${maxPositionsAllowed}) reached.`,
        metrics,
      };
    }

    if (!Number.isFinite(input.volume) || input.volume <= 0) {
      return {
        approved: false,
        reason: 'Requested volume must be a positive finite number.',
        metrics,
      };
    }

    if (!exposure.complete) {
      return {
        approved: false,
        reason: `Exposure cannot be valued for ${exposure.unresolved.join(', ')}.`,
        metrics,
      };
    }

    if (exposure.total > context.policy.maxExposure) {
      return {
        approved: false,
        reason: `Exposure would reach $${exposure.total.toFixed(2)}, above the $${context.policy.maxExposure} policy limit.`,
        metrics,
      };
    }

    if (!validStop) {
      return {
        approved: false,
        reason: 'A protective stop price on the correct side of the entry price is required.',
        metrics,
      };
    }

    if (!risk?.available) {
      return {
        approved: false,
        reason: `Risk cannot be expressed in the account currency: ${risk?.reason ?? 'insufficient market data'}.`,
        metrics,
      };
    }

    if (risk.value !== undefined && risk.value > state.equity * context.policy.maxRiskPerTrade) {
      return {
        approved: false,
        reason: 'Trade risk exceeds maxRiskPerTrade policy.',
        metrics,
      };
    }

    return {
      approved: true,
      reason: 'Trade passed all risk validation checks.',
      metrics,
    };
  },
};

export const riskGetDailyLossCapability: AgentCapability<
  Record<string, never>,
  { dailyLoss: number; dailyLossLimit: number | null; remainingAllowance: number | null }
> = {
  id: 'risk.getDailyLoss',
  name: 'Get Daily Loss State',
  description: 'Audits today realized and unrealized net drawdowns against daily loss budget.',
  category: 'risk',
  inputSchema: {},
  outputSchema: {
    dailyLoss: { type: 'number' },
    dailyLossLimit: { type: 'number' },
    remainingAllowance: { type: 'number' },
  },
  async execute(_, context) {
    const state = await context.env.getAccountState();
    const dailyLoss = state.dailyPnL !== null && state.dailyPnL < 0 ? Math.abs(state.dailyPnL) : 0;
    const dailyLossLimit = context.policy.maxDailyLoss ?? null;
    const remainingAllowance = dailyLossLimit === null ? null : Math.max(0, dailyLossLimit - dailyLoss);

    return {
      dailyLoss: Number(dailyLoss.toFixed(2)),
      dailyLossLimit,
      remainingAllowance: remainingAllowance === null ? null : Number(remainingAllowance.toFixed(2)),
    };
  },
};

export const riskGetDrawdownCapability: AgentCapability<
  Record<string, never>,
  { currentDrawdownPercent: number; maxAllowedDrawdownPercent: number | null; isWithinLimits: boolean }
> = {
  id: 'risk.getDrawdown',
  name: 'Get Account Drawdown',
  description: 'Retrieves current peak-to-trough account drawdown percentage.',
  category: 'risk',
  inputSchema: {},
  outputSchema: {
    currentDrawdownPercent: { type: 'number' },
    maxAllowedDrawdownPercent: { type: 'number' },
    isWithinLimits: { type: 'boolean' },
  },
  async execute(_, context) {
    const state = await context.env.getAccountState();
    const maxAllowed = context.policy.maxDrawdown === undefined ? null : context.policy.maxDrawdown * 100;
    return {
      currentDrawdownPercent: state.drawdownPercent ?? 0,
      maxAllowedDrawdownPercent: maxAllowed,
      isWithinLimits: maxAllowed === null || state.drawdownPercent !== null && state.drawdownPercent <= maxAllowed,
    };
  },
};

export const RISK_CAPABILITIES = [
  riskCalculatePositionSizeCapability,
  riskCalculateRiskCapability,
  riskCalculateExposureCapability,
  riskCheckTradeCapability,
  riskGetDailyLossCapability,
  riskGetDrawdownCapability,
];
