import { AgentCapability } from '../types';

/**
 * What each execution capability means, stated next to the capability.
 *
 * ## Why this table exists rather than a descriptor on the capability
 *
 * The obvious design is an optional `execution` field on `AgentCapability`, read
 * off the registered object. It was tried and it cannot be adopted safely yet:
 * capabilities are registered by id in several places that have no business knowing
 * about trading decisions — tests, the wallet harness, the adapter tests — and an
 * id-only registration would silently become "unknown capability" instead of being
 * validated. A validation table that only half the registrations answer to is worse
 * than one every registration answers to.
 *
 * So the knowledge moved here, beside the definitions it describes, and the runtime
 * asks this module rather than spelling out capability names in the middle of its
 * execution gate. `CapabilityRegistry` spreading an extra field is not relied upon;
 * when every registration can carry its own shape, this table becomes the default
 * that a capability overrides, and the runtime stops caring either way.
 *
 * ## Why the runtime still decides
 *
 * This says what a capability *is*. It says nothing about whether the agent may use
 * it, whether policy allows it, or whether risk permits it — those are the runtime's
 * answers, and they are computed from the account and the deployment, never from
 * this table.
 */
export interface ExecutionCapabilityShape {
  /** The decision this capability is a way of asking for. */
  decision: 'OPEN_POSITION' | 'CLOSE_POSITION' | 'MODIFY_POSITION';
  /**
   * Refused by the execution contract itself.
   *
   * A capability the environment cannot serve is refused with the reason rather
   * than being validated and then failing at the venue, which would be a worse
   * place to learn it.
   */
  unsupported?: string;
  /** Closes part of a position, which is a different act from closing all of it. */
  partial?: boolean;
  /** Which field of the input carries the invalidation, when the capability takes one. */
  invalidationField?: 'stopLoss' | 'takeProfit';
  /** The input field carrying the volume to close, for a partial close. */
  volumeField?: string;
}

export const EXECUTION_CAPABILITY_SHAPES: Readonly<Record<string, ExecutionCapabilityShape>> = {
  'orders.market': { decision: 'OPEN_POSITION' },
  'positions.close': { decision: 'CLOSE_POSITION' },
  'positions.partialClose': { decision: 'CLOSE_POSITION', partial: true, volumeField: 'volumeToClose' },
  'positions.modifyStopLoss': { decision: 'MODIFY_POSITION', invalidationField: 'stopLoss' },
  'positions.modifyTakeProfit': { decision: 'MODIFY_POSITION', invalidationField: 'takeProfit' },
  'orders.limit': {
    decision: 'OPEN_POSITION',
    unsupported:
      'is not supported by the configured environment execution contract.',
  },
  'orders.cancel': {
    decision: 'OPEN_POSITION',
    unsupported:
      'is not supported by the configured environment execution contract.',
  },
};

/** The shape of an execution capability, when it has one. */
export function executionShapeFor(
  id: string,
): ExecutionCapabilityShape | undefined {
  return EXECUTION_CAPABILITY_SHAPES[id];
}

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
