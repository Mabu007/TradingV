import { AgentCapability } from '../types';

export const ordersMarketCapability: AgentCapability<
  { symbol: string; side: 'BUY' | 'SELL'; volume: number; stopLoss?: number; takeProfit?: number; comment?: string },
  { success: boolean; positionId?: string; fillPrice?: number; error?: string }
> = {
  id: 'orders.market',
  name: 'Place Market Order',
  description: 'Submits an immediate market execution order routed through the TradingGOATs Risk Engine.',
  category: 'execution',
  inputSchema: {
    symbol: { type: 'string', required: true },
    side: { type: 'string', required: true, enum: ['BUY', 'SELL'] },
    volume: { type: 'number', required: true, minimum: 1 },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    comment: { type: 'string' },
  },
  outputSchema: {
    success: { type: 'boolean' },
    positionId: { type: 'string' },
    fillPrice: { type: 'number' },
    error: { type: 'string' },
  },
  async execute(input, context) {
    return context.env.placeMarketOrder({
      symbol: input.symbol,
      side: input.side,
      volume: input.volume,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      comment: input.comment || `Agent ${context.agentId}`,
    });
  },
};

export const ordersLimitCapability: AgentCapability<
  { symbol: string; side: 'BUY' | 'SELL'; targetPrice: number; volume: number; stopLoss?: number; takeProfit?: number },
  { success: boolean; orderId?: string; error?: string }
> = {
  id: 'orders.limit',
  name: 'Place Limit Order',
  description: 'Places a resting limit order at a specified entry price.',
  category: 'execution',
  inputSchema: {
    symbol: { type: 'string' },
    side: { type: 'string', required: true, enum: ['BUY', 'SELL'] },
    targetPrice: { type: 'number' },
    volume: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
  },
  outputSchema: {
    success: { type: 'boolean' },
    orderId: { type: 'string' },
    error: { type: 'string' },
  },
  async execute(input, context) {
    if (!context.env.placeLimitOrder) return { success: false, error: 'Limit orders are not supported by the current environment.' };
    return context.env.placeLimitOrder({ symbol: input.symbol, side: input.side, volume: input.volume, price: input.targetPrice, stopLoss: input.stopLoss, takeProfit: input.takeProfit });
  },
};

export const ordersCancelCapability: AgentCapability<
  { orderId: string },
  { success: boolean; error?: string }
> = {
  id: 'orders.cancel',
  name: 'Cancel Order',
  description: 'Cancels a resting pending limit or stop order.',
  category: 'execution',
  inputSchema: {
    orderId: { type: 'string' },
  },
  outputSchema: {
    success: { type: 'boolean' },
  },
  async execute(input, context) {
    if (!context.env.cancelOrder) return { success: false, error: 'Order cancellation is not supported by the current environment.' };
    return context.env.cancelOrder(input.orderId);
  },
};

export const positionsModifyStopLossCapability: AgentCapability<
  { positionId: string; stopLoss: number },
  { success: boolean; positionId: string; stopLoss: number; error?: string }
> = {
  id: 'positions.modifyStopLoss',
  name: 'Modify Position Stop Loss',
  description: 'Updates or trails the stop loss price level on an active open position.',
  category: 'execution',
  inputSchema: {
    positionId: { type: 'string', required: true },
    stopLoss: { type: 'number', required: true },
  },
  outputSchema: {
    success: { type: 'boolean' },
    positionId: { type: 'string', required: true },
    stopLoss: { type: 'number', required: true },
    error: { type: 'string' },
  },
  async execute(input, context) {
    const res = await context.env.modifyPosition(input.positionId, {
      stopLoss: input.stopLoss,
    });
    return {
      success: res.success,
      positionId: input.positionId,
      stopLoss: input.stopLoss,
      error: res.error,
    };
  },
};

export const positionsModifyTakeProfitCapability: AgentCapability<
  { positionId: string; takeProfit: number },
  { success: boolean; positionId: string; takeProfit: number; error?: string }
> = {
  id: 'positions.modifyTakeProfit',
  name: 'Modify Position Take Profit',
  description: 'Updates the take profit target on an active open position.',
  category: 'execution',
  inputSchema: {
    positionId: { type: 'string', required: true },
    takeProfit: { type: 'number', required: true },
  },
  outputSchema: {
    success: { type: 'boolean' },
    positionId: { type: 'string', required: true },
    takeProfit: { type: 'number', required: true },
    error: { type: 'string' },
  },
  async execute(input, context) {
    const res = await context.env.modifyPosition(input.positionId, {
      takeProfit: input.takeProfit,
    });
    return {
      success: res.success,
      positionId: input.positionId,
      takeProfit: input.takeProfit,
      error: res.error,
    };
  },
};

export const positionsCloseCapability: AgentCapability<
  { positionId: string },
  { success: boolean; positionId: string; pnl?: number; error?: string }
> = {
  id: 'positions.close',
  name: 'Close Position',
  description: 'Closes an open position at current market price.',
  category: 'execution',
  inputSchema: {
    positionId: { type: 'string' },
  },
  outputSchema: {
    success: { type: 'boolean' },
    positionId: { type: 'string' },
    pnl: { type: 'number' },
    error: { type: 'string' },
  },
  async execute(input, context) {
    const res = await context.env.closePosition(input.positionId);
    return {
      success: res.success,
      positionId: input.positionId,
      pnl: res.pnl,
      error: res.error,
    };
  },
};

export const positionsPartialCloseCapability: AgentCapability<
  { positionId: string; volumeToClose: number },
  { success: boolean; positionId: string; closedVolume: number; error?: string }
> = {
  id: 'positions.partialClose',
  name: 'Partial Close Position',
  description: 'Closes a fraction of an open position volume to secure partial profits.',
  category: 'execution',
  inputSchema: {
    positionId: { type: 'string' },
    volumeToClose: { type: 'number' },
  },
  outputSchema: {
    success: { type: 'boolean' },
    positionId: { type: 'string' },
    closedVolume: { type: 'number' },
    error: { type: 'string' },
  },
  async execute(input, context) {
    const res = await context.env.closePosition(input.positionId, input.volumeToClose);
    return {
      success: res.success,
      positionId: input.positionId,
      closedVolume: input.volumeToClose,
      error: res.error,
    };
  },
};

export const EXECUTION_CAPABILITIES = [
  ordersMarketCapability,
  ordersLimitCapability,
  ordersCancelCapability,
  positionsModifyStopLossCapability,
  positionsModifyTakeProfitCapability,
  positionsCloseCapability,
  positionsPartialCloseCapability,
];
