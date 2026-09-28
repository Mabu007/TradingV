import { AgentSkill } from '../types';
import { skillRegistry } from './registry';

export const marketObservationSkill: AgentSkill = {
  id: 'market-observation',
  name: 'Market Observation',
  description: 'Monitors real-time quotes, spread conditions, active session liquidity, and historical context.',
  instructions: `
- Inspect current market spread using market.getSpread before planning orders.
- Confirm market session using market.getSession; avoid entering during low-liquidity session transitions or weekend closes.
- Use market.getQuote to evaluate the live Bid and Ask spread.
`,
  requiredCapabilities: [
    'market.getQuote',
    'market.getBars',
    'market.getSpread',
    'market.getSession',
  ],
  enabled: true,
};

export const technicalAnalysisSkill: AgentSkill = {
  id: 'technical-analysis',
  name: 'Technical Analysis',
  description: 'Calculates trend momentum, RSI exhaustion, ATR volatility, swing fractals, and breakout structures.',
  instructions: `
- Evaluate trend direction using indicators.ema (20 and 50 period) and indicators.sma.
- Check momentum exhaustion using indicators.rsi; do not buy into overbought (>70) or sell into oversold (<30) markets.
- Measure current bar volatility using indicators.atr. Use latestValue (a price distance) for every asset class, and latestPips only for pip-quoted Forex instruments.
- Identify key levels and breakout expansion using structure.supportResistance and structure.breakout.
`,
  requiredCapabilities: [
    'market.getBars',
    'indicators.sma',
    'indicators.ema',
    'indicators.rsi',
    'indicators.atr',
    'structure.swingHighs',
    'structure.swingLows',
    'structure.supportResistance',
    'structure.breakout',
  ],
  enabled: true,
};

export const riskManagementSkill: AgentSkill = {
  id: 'risk-management',
  name: 'Risk Management',
  description: 'Enforces hard drawdown budgets, exposure ceilings, and safe maximum loss calculations.',
  instructions: `
- Always check account equity using account.getEquity before proposing any order.
- Verify total exposure using risk.calculateExposure. Exposure is reported in the account currency and compares instruments of every asset class, so never add up raw quantities yourself.
- Run risk.checkTrade on any intended trade. If risk.checkTrade reports approved=false, do NOT attempt to trade.
- Respect daily loss thresholds using risk.getDailyLoss.
`,
  requiredCapabilities: [
    'account.getEquity',
    'account.getPositions',
    'risk.calculateRisk',
    'risk.calculateExposure',
    'risk.calculatePositionSize',
    'risk.checkTrade',
    'risk.getDailyLoss',
    'risk.getDrawdown',
  ],
  enabled: true,
};

export const positionSizingSkill: AgentSkill = {
  id: 'position-sizing',
  name: 'Position Sizing',
  description: 'Calculates mathematically safe volume units based on stop loss distance and risk targets.',
  instructions: `
- Never guess a position size. Always call risk.calculatePositionSize.
- Pass stopPrice for every asset. Use stopLossPips only for a pip-quoted Forex instrument, and never for a commodity or index.
- Read volumeUnits as instrument units. Convert to lots only when the capability returns a lot value.
- Base size strictly on fractional account equity (default 1.0% risk).
`,
  requiredCapabilities: [
    'account.getEquity',
    'risk.calculatePositionSize',
    'risk.calculateRisk',
  ],
  enabled: true,
};

export const tradeEntrySkill: AgentSkill = {
  id: 'trade-entry',
  name: 'Trade Entry',
  description: 'Formulates and submits market orders equipped with mandatory Stop Loss and Take Profit.',
  instructions: `
- Every trade MUST define a protective stopLoss.
- Check market.getSpread before dispatching orders.market. Judge normality with the instrument's own units: spread or maxSpread for any asset, maxSpreadPips only for pip-quoted Forex.
- Provide a clear, concise justification for the trade.
`,
  requiredCapabilities: [
    'orders.market',
    'orders.limit',
    'risk.checkTrade',
    'market.getQuote',
  ],
  enabled: true,
};

export const tradeManagementSkill: AgentSkill = {
  id: 'trade-management',
  name: 'Trade Management',
  description: 'Monitors open positions, manages trailing stops, takes partial profits, or closes positions on invalidation.',
  instructions: `
- Regularly inspect open trades with account.getPositions.
- If a position achieves 1.5R or meets technical resistance, consider positions.modifyStopLoss to breakeven.
- If technical market structure invalidates the trade thesis, close the position immediately via positions.close.
`,
  requiredCapabilities: [
    'account.getPositions',
    'positions.modifyStopLoss',
    'positions.modifyTakeProfit',
    'positions.close',
    'positions.partialClose',
  ],
  enabled: true,
};

export const BUILTIN_SKILLS: AgentSkill[] = [
  marketObservationSkill,
  technicalAnalysisSkill,
  riskManagementSkill,
  positionSizingSkill,
  tradeEntrySkill,
  tradeManagementSkill,
];

export function initializeDefaultSkills(registry: typeof skillRegistry = skillRegistry) {
  for (const skill of BUILTIN_SKILLS) {
    if (!registry.has(skill.id)) {
      registry.register(skill);
    }
  }
}

// Auto-register on module load
initializeDefaultSkills(skillRegistry);
