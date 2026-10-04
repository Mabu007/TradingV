import { TradingAgent } from '../types';

export const CONSERVATIVE_EURUSD_AGENT: TradingAgent = {
  id: 'agent-conservative-eurusd',
  name: 'Conservative EURUSD Demo Agent',
  description: 'A conservative EURUSD demo integration agent; it is not a profitability claim.',
  instructions: `You are a conservative EURUSD trading agent.

Observe the market before making decisions.

Do not trade simply because an indicator produces a signal.

Use the available market and technical-analysis capabilities to evaluate current conditions.

Before opening a position, inspect account state and risk.

Never exceed the configured risk policy.

If conditions are unclear, WAIT.

Explain the reason for every trading decision.`,
  skills: [
    'market-observation',
    'technical-analysis',
    'risk-discipline',
    'position-sizing',
    'trade-entry',
    'trade-management',
  ],
  capabilities: [
    'market.getQuote',
    'market.getBars',
    'market.getSpread',
    'market.getSession',
    'indicators.sma',
    'indicators.ema',
    'indicators.rsi',
    'indicators.atr',
    'structure.swingHighs',
    'structure.swingLows',
    'structure.supportResistance',
    'structure.breakout',
    'account.getEquity',
    'account.getPositions',
    'risk.calculateRisk',
    'risk.calculateExposure',
    'risk.calculatePositionSize',
    'risk.checkTrade',
    'orders.market',
    'positions.modifyStopLoss',
    'positions.close',
  ],
  policy: {
    maxRiskPerTrade: 0.01, // 1.0% max risk per trade
    maxDailyLoss: 500,     // Max $500 daily loss
    maxDrawdown: 0.05,     // 5% max drawdown
    maxOpenPositions: 1,   // Strictly 1 position at a time
    maxExposure: 50000,    // 0.50 lots max exposure
    maxOrdersPerMinute: 6,
    allowedSymbols: ['EURUSD'],
    allowedSessions: ['LONDON', 'NEW_YORK', 'OVERLAP'],
    allowTrading: true,
  },
  preferredEnvironment: 'DEMO',
  symbols: ['EURUSD'],
  timeframe: '5m',
  enabled: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};
