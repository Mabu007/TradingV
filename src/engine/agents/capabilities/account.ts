import { AgentCapability } from '../types';
import { lotSizeFor, resolveInstruments } from './instruments';

export const accountGetBalanceCapability: AgentCapability<
  Record<string, never>,
  { balance: number }
> = {
  id: 'account.getBalance',
  name: 'Get Account Balance',
  description: 'Retrieves current settled cash balance.',
  category: 'account',
  inputSchema: {},
  outputSchema: { balance: { type: 'number' } },
  async execute(_, context) {
    const state = await context.env.getAccountState();
    return { balance: state.balance };
  },
};

export const accountGetEquityCapability: AgentCapability<
  Record<string, never>,
  { equity: number; unrealizedPnL: number }
> = {
  id: 'account.getEquity',
  name: 'Get Account Equity',
  description: 'Retrieves live net equity including all unrealized position profit and loss.',
  category: 'account',
  inputSchema: {},
  outputSchema: {
    equity: { type: 'number' },
    unrealizedPnL: { type: 'number' },
  },
  async execute(_, context) {
    const state = await context.env.getAccountState();
    return {
      equity: state.equity,
      unrealizedPnL: Number((state.equity - state.balance).toFixed(2)),
    };
  },
};

export const accountGetMarginCapability: AgentCapability<
  Record<string, never>,
  { usedMargin: number; freeMargin: number; marginLevelPercent: number | null }
> = {
  id: 'account.getMargin',
  name: 'Get Margin State',
  description: 'Retrieves used margin, free available margin, and margin level ratio.',
  category: 'account',
  inputSchema: {},
  outputSchema: {
    usedMargin: { type: 'number' },
    freeMargin: { type: 'number' },
    marginLevelPercent: { type: 'number' },
  },
  async execute(_, context) {
    const state = await context.env.getAccountState();
    const marginLevelPercent = state.margin > 0 ? (state.equity / state.margin) * 100 : null;
    return {
      usedMargin: state.margin,
      freeMargin: state.freeMargin,
      marginLevelPercent: marginLevelPercent === null ? null : Number(marginLevelPercent.toFixed(1)),
    };
  },
};

export const accountGetPositionsCapability: AgentCapability<
  { symbol?: string },
  { positionsCount: number; totalUnrealizedPnL: number; positions: Array<{ id: string; symbol: string; side: 'BUY' | 'SELL'; volume: number; entryPrice: number; currentPrice: number; unrealizedPnL: number; stopLoss?: number; takeProfit?: number }> }
> = {
  id: 'account.getPositions',
  name: 'Get Open Positions',
  description: 'Retrieves active open market positions, optionally filtered by symbol.',
  category: 'account',
  inputSchema: {
    symbol: { type: 'string', description: 'Optional symbol filter e.g. EURUSD' },
  },
  outputSchema: {
    positionsCount: { type: 'number' },
    totalUnrealizedPnL: { type: 'number' },
    positions: { type: 'array' },
  },
  async execute(input, context) {
    const rawPositions = await context.env.getPositions(input.symbol);
    const positions = rawPositions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnL: p.unrealizedPnL,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    }));

    const totalUnrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);

    return {
      positionsCount: positions.length,
      totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
      positions,
    };
  },
};

export const accountGetOrdersCapability: AgentCapability<
  Record<string, never>,
  { pendingOrdersCount: number; orders: unknown[] }
> = {
  id: 'account.getOrders',
  name: 'Get Pending Orders',
  description: 'Retrieves active resting limit and stop orders.',
  category: 'account',
  inputSchema: {},
  outputSchema: {
    pendingOrdersCount: { type: 'number' },
    orders: { type: 'array' },
  },
  async execute(_, context) {
    const orders = await context.env.getOrders();
    return { pendingOrdersCount: orders.length, orders };
  },
};

export const accountGetExposureCapability: AgentCapability<
  Record<string, never>,
  { totalVolumeUnits: number; totalLots: number | null; exposureBySymbol: Record<string, { longVolume: number; shortVolume: number; netVolume: number }> }
> = {
  id: 'account.getExposure',
  name: 'Get Market Exposure',
  description: 'Calculates total volume units and net directional exposure per instrument.',
  category: 'account',
  inputSchema: {},
  outputSchema: {
    totalVolumeUnits: { type: 'number' },
    totalLots: {
      type: 'number',
      nullable: true,
      description: 'Null when any open instrument is not lot-sized.',
    },
    exposureBySymbol: { type: 'object' },
  },
  async execute(_, context) {
    const positions = await context.env.getPositions();
    const exposureBySymbol: Record<string, { longVolume: number; shortVolume: number; netVolume: number }> = {};
    let totalVolumeUnits = 0;

    for (const pos of positions) {
      totalVolumeUnits += pos.volume;
      if (!exposureBySymbol[pos.symbol]) {
        exposureBySymbol[pos.symbol] = { longVolume: 0, shortVolume: 0, netVolume: 0 };
      }
      if (pos.side === 'BUY') {
        exposureBySymbol[pos.symbol].longVolume += pos.volume;
        exposureBySymbol[pos.symbol].netVolume += pos.volume;
      } else {
        exposureBySymbol[pos.symbol].shortVolume += pos.volume;
        exposureBySymbol[pos.symbol].netVolume -= pos.volume;
      }
    }

    /*
     * A lot total is only meaningful when every open instrument is
     * lot-sized. Gold units and index points are never converted.
     */
    const instruments = await resolveInstruments(context.env);
    const lotSize = lotSizeFor(
      instruments.find(
        (candidate) => candidate.symbol === positions[0]?.symbol,
      ),
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

    return {
      totalVolumeUnits,
      totalLots:
        allLotSized && lotSize
          ? Number((totalVolumeUnits / lotSize).toFixed(2))
          : null,
      exposureBySymbol,
    };
  },
};

export const ACCOUNT_CAPABILITIES = [
  accountGetBalanceCapability,
  accountGetEquityCapability,
  accountGetMarginCapability,
  accountGetPositionsCapability,
  accountGetOrdersCapability,
  accountGetExposureCapability,
];
