import { BotDefinition, CURRENT_BOT_SCHEMA_VERSION, validateBotDefinition } from './botDefinition';

const now = 1700000000000;

const base = (id: string, name: string, description: string, objective: string, guidance: string[], skills: string[], triggers: BotDefinition['triggers'], risk = 0.005): BotDefinition => ({
  schemaVersion: CURRENT_BOT_SCHEMA_VERSION,
  source: 'explorer',
  identity: { id, name, description },
  intent: { objective, longBias: 'Prefer long opportunities when structure and momentum support the thesis.', shortBias: 'Prefer short opportunities when structure and momentum support the thesis.', guidance },
  skills: { marketAnalysis: ['market-observation', 'technical-analysis'], indicators: [], patterns: [], context: [...skills] },
  capabilities: { marketData: true, accountData: true, orders: true, positions: true, automation: true },
  triggers,
  risk: { riskPerTrade: risk, maxDailyLoss: 500, maxPositions: 2, maxExposure: 50000, cooldown: 900000 },
  execution: { orderType: 'market', slippage: 0.2, executionRules: ['Require a protective stop loss.', 'Respect deterministic risk validation.'] },
  ai: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', reasoningMode: 'autonomous', confidenceThreshold: 0.7, decisionPolicy: 'Investigate the complete context before acting; WAIT when the setup is weak or ambiguous.' },
  createdAt: now,
  updatedAt: now,
});

const bar = (id: string, timeframe = '15m'): BotDefinition['triggers'][number] => ({ id, type: 'NEW_BAR', enabled: true, timeframe, config: {}, cooldownMs: 900000, createdAt: now, updatedAt: now });
const volatility = (id: string): BotDefinition['triggers'][number] => ({ id, type: 'VOLATILITY_CHANGE', enabled: true, timeframe: '15m', config: { increasePercent: 20 }, cooldownMs: 1800000, createdAt: now, updatedAt: now });
const price = (id: string): BotDefinition['triggers'][number] => ({ id, type: 'PRICE_THRESHOLD', enabled: true, timeframe: '15m', config: { level: 0, operator: 'ABOVE' }, cooldownMs: 900000, createdAt: now, updatedAt: now });

export const EXPLORER_BOTS: BotDefinition[] = [
  base('explorer-trend-rider', 'Trend Rider', 'Follows established directional moves and waits for controlled pullbacks.', 'Participate in healthy trend continuation while avoiding weak and choppy conditions.', ['Confirm broader structure before acting.', 'Prefer controlled pullbacks over extended entries.', 'Use volatility to judge whether continuation is actionable.'], ['risk-management', 'position-sizing'], [bar('trend-bar'), volatility('trend-volatility')]),
  base('explorer-pullback-hunter', 'Pullback Hunter', 'Looks for measured retracements inside an established trend.', 'Find controlled pullbacks that offer a better entry than chasing momentum.', ['Evaluate pullback quality in the context of the dominant trend.', 'Avoid entries when momentum is exhausted.', 'Wait for recovery evidence before acting.'], ['risk-management', 'position-sizing', 'trade-management'], [bar('pullback-bar'), price('pullback-reference')]),
  base('explorer-breakout-scout', 'Breakout Scout', 'Investigates meaningful range breaks and filters weak expansion.', 'Identify high-quality breaks from consolidation without treating every level touch as a trade.', ['Assess the quality of the range before a breakout.', 'Require context and volatility confirmation.', 'Avoid chasing late or immediately rejected breaks.'], ['risk-management', 'position-sizing'], [bar('breakout-bar'), volatility('breakout-volatility')]),
  base('explorer-mean-reversion', 'Mean Reversion', 'Finds stretched conditions where context supports a return toward fair value.', 'Investigate potential reversion after meaningful extension while avoiding strong directional trends.', ['Measure extension and momentum exhaustion.', 'Check trend regime before fading a move.', 'Prefer clear invalidation and controlled risk.'], ['risk-management', 'position-sizing'], [bar('reversion-bar'), volatility('reversion-volatility')], 0.004),
  base('explorer-momentum-trader', 'Momentum Trader', 'Wakes on momentum expansion and evaluates whether participation is justified.', 'Capture strong momentum events with structure and volatility confirmation.', ['Distinguish clean momentum from unstable spikes.', 'Check broader structure and available room.', 'Do not trade solely because momentum increased.'], ['risk-management', 'position-sizing'], [bar('momentum-bar'), volatility('momentum-expansion')]),
  base('explorer-session-trader', 'Session Trader', 'Focuses evaluation around active market conditions and session transitions.', 'Concentrate attention when liquidity and market context are more suitable for evaluation.', ['Use session context before considering an opportunity.', 'Reduce activity during unsuitable transitions.', 'Require independent market structure confirmation.'], ['risk-management', 'position-sizing', 'trade-management'], [bar('session-bar'), volatility('session-volatility')], 0.004),
  base('explorer-structure-watch', 'Structure Watch', 'Studies support, resistance, swings, and regime changes before acting.', 'Build decisions around meaningful market structure rather than isolated indicator signals.', ['Map the current structure before considering direction.', 'Treat breaks and failures as context, not automatic entries.', 'Keep risk small when structure is unclear.'], ['risk-management', 'position-sizing'], [bar('structure-bar'), price('structure-event')]),
  base('explorer-conservative-ai', 'Conservative AI Trader', 'A cautious general-purpose agent that favors observation and low activity.', 'Find only the clearest opportunities while preserving capital through strict risk boundaries.', ['Prefer WAIT when evidence conflicts.', 'Use multiple skills before proposing a trade.', 'Avoid overtrading and repeated entries.'], ['risk-management', 'position-sizing', 'trade-management'], [bar('conservative-bar')], 0.0025),
];

for (const bot of EXPLORER_BOTS) validateBotDefinition(bot);

export function getExplorerBot(id: string): BotDefinition | undefined { return EXPLORER_BOTS.find((bot) => bot.identity.id === id); }
