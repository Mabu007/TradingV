import { AgentInstance } from '../runtime';
import { AgentTrigger, TriggerType } from './types';
import type { BotDefinition } from '../botDefinition';

export type TriggerAgentResolver = (agentId: string) => AgentInstance | undefined;
const SUPPORTED_TYPES = new Set<TriggerType>([
  'NEW_BAR', 'PRICE_CROSS', 'PRICE_THRESHOLD', 'INDICATOR_CROSS', 'BREAKOUT',
  'SPREAD_CHANGE', 'VOLATILITY_CHANGE', 'POSITION_UPDATE', 'ORDER_FILLED',
  'STOP_APPROACHING', 'TARGET_APPROACHING', 'SESSION_START', 'SESSION_END', 'SCHEDULED', 'CUSTOM', 'RISK_STATE_CHANGED',
  'POSITION_OPEN', 'POSITION_CLOSE',
]);

export class TriggerRegistry {
  private readonly triggers = new Map<string, AgentTrigger>();
  private readonly bySymbol = new Map<string, Set<string>>();
  private readonly unscoped = new Set<string>();

  constructor(private readonly resolveAgent: TriggerAgentResolver) {}

  getAgent(agentId: string): AgentInstance | undefined { return this.resolveAgent(agentId); }

  register(trigger: AgentTrigger): void {
    validateDefinition(trigger);
    const agent = this.resolveAgent(trigger.agentId);
    if (!agent || !agent.agent.enabled || agent.env.mode === 'LIVE') throw new Error('Trigger owner must be a registered enabled non-live agent.');
    if (trigger.symbol && (!agent.agent.symbols.includes(trigger.symbol) ||
        agent.agent.policy.allowedSymbols.length > 0 && !agent.agent.policy.allowedSymbols.includes(trigger.symbol))) throw new Error('Trigger symbol is outside its agent symbol scope.');
    if (!trigger.symbol && agent.agent.symbols.length === 0) throw new Error('Unscoped trigger owner must have configured symbols.');
    if (trigger.timeframe && (!isTimeframe(trigger.timeframe) || agent.agent.timeframe && trigger.timeframe !== agent.agent.timeframe)) throw new Error('Trigger timeframe must match a supported agent timeframe.');
    if (this.triggers.has(trigger.id)) throw new Error(`Trigger ${trigger.id} is already registered.`);
    if (this.countForAgent(trigger.agentId) >= 100) throw new Error('Agent trigger limit reached.');
    const stored = cloneTrigger(trigger);
    this.triggers.set(stored.id, stored);
    if (stored.symbol) {
      let index = this.bySymbol.get(stored.symbol);
      if (!index) this.bySymbol.set(stored.symbol, index = new Set());
      index.add(stored.id);
    } else this.unscoped.add(stored.id);
  }

  registerBotTriggers(definition: BotDefinition, agentId: string, runtimeSymbol: string): void {
    for (const trigger of definition.triggers) {
      this.register({
        ...trigger,
        agentId,
        symbol: runtimeSymbol,
      });
    }
  }

  unregister(triggerId: string): boolean {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return false;
    this.triggers.delete(triggerId);
    if (trigger.symbol) {
      const index = this.bySymbol.get(trigger.symbol);
      index?.delete(triggerId);
      if (index?.size === 0) this.bySymbol.delete(trigger.symbol);
    } else this.unscoped.delete(triggerId);
    return true;
  }

  get(triggerId: string): AgentTrigger | undefined {
    const trigger = this.triggers.get(triggerId);
    return trigger ? cloneTrigger(trigger) : undefined;
  }

  list(): AgentTrigger[] {
    return [...this.triggers.values()].map(cloneTrigger);
  }

  listForAgent(agentId: string): AgentTrigger[] {
    return [...this.triggers.values()].filter((trigger) => trigger.agentId === agentId).map(cloneTrigger);
  }

  countForAgent(agentId: string): number {
    let count = 0;
    for (const trigger of this.triggers.values()) if (trigger.agentId === agentId) count += 1;
    return count;
  }

  candidates(symbol?: string): AgentTrigger[] {
    const ids = new Set(this.unscoped);
    if (symbol) for (const id of this.bySymbol.get(symbol) ?? []) ids.add(id);
    return [...ids].map((id) => this.triggers.get(id)).filter((trigger): trigger is AgentTrigger => Boolean(trigger));
  }

  enable(triggerId: string): void { this.setEnabled(triggerId, true); }
  disable(triggerId: string): void { this.setEnabled(triggerId, false); }

  private setEnabled(triggerId: string, enabled: boolean): void {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) throw new Error(`Unknown trigger: ${triggerId}`);
    const agent = this.resolveAgent(trigger.agentId);
    if (!agent?.agent.enabled || agent.env.mode === 'LIVE') throw new Error('Trigger owner is unavailable.');
    this.triggers.set(triggerId, { ...trigger, enabled, updatedAt: Date.now() });
  }
}

function validateDefinition(trigger: AgentTrigger): void {
  if (!trigger.id || !trigger.agentId || !SUPPORTED_TYPES.has(trigger.type)) throw new Error('Invalid trigger identity or type.');
  if (typeof trigger.enabled !== 'boolean' || !Number.isFinite(trigger.createdAt) || !Number.isFinite(trigger.updatedAt)) throw new Error('Invalid trigger state/timestamps.');
  if (trigger.cooldownMs !== undefined && (!Number.isFinite(trigger.cooldownMs) || trigger.cooldownMs < 0)) throw new Error('Invalid trigger cooldown.');
  if (trigger.maxFiringsPerMinute !== undefined && (!Number.isInteger(trigger.maxFiringsPerMinute) || trigger.maxFiringsPerMinute < 1)) throw new Error('Invalid trigger frequency limit.');
  if (trigger.priority !== undefined && !Number.isFinite(trigger.priority)) throw new Error('Invalid trigger priority.');
  if (!trigger.config || typeof trigger.config !== 'object' || Array.isArray(trigger.config) || Object.getPrototypeOf(trigger.config) !== Object.prototype) throw new Error('Trigger config must be a plain object.');
  const config = trigger.config as Record<string, unknown>;
  if (containsSensitiveKey(config)) throw new Error('Trigger configuration must not contain credentials or secrets.');
  const finite = (key: string) => config[key] === undefined || (typeof config[key] === 'number' && Number.isFinite(config[key]));
  if (trigger.type === 'PRICE_THRESHOLD' && (!finite('level') || typeof config.level !== 'number' || !['ABOVE', 'BELOW'].includes(String(config.operator)))) throw new Error('Invalid PRICE_THRESHOLD config.');
  if (trigger.type === 'PRICE_CROSS' && (!finite('level') || typeof config.level !== 'number' || !['ABOVE', 'BELOW'].includes(String(config.direction)))) throw new Error('Invalid PRICE_CROSS config.');
  if (trigger.type === 'INDICATOR_CROSS') {
    const crossingPair = typeof config.fastKey === 'string' && typeof config.slowKey === 'string' && isPlainObject(config.fast) && isPlainObject(config.slow);
    const crossingLevel = typeof config.indicatorKey === 'string' && finite('level') && typeof config.level === 'number' && isPlainObject(config.indicator);
    if ((!crossingPair && !crossingLevel) || !['ABOVE', 'BELOW'].includes(String(config.direction))) throw new Error('Invalid INDICATOR_CROSS config.');
  }
  if (trigger.type === 'INDICATOR_CROSS') {
    for (const definition of [config.fast, config.slow, config.indicator]) {
      if (!isPlainObject(definition)) continue;
      const item = definition as Record<string, unknown>;
      if (String(item.type).toUpperCase() === 'MACD' && typeof item.key !== 'string' && typeof config.fastKey !== 'string' && typeof config.slowKey !== 'string' && typeof config.indicatorKey !== 'string') throw new Error('MACD trigger definition requires a key.');
      if (String(item.type).toUpperCase() !== 'MACD' && (typeof item.period !== 'number' || !Number.isInteger(item.period) || item.period < 1)) throw new Error('Indicator trigger requires a positive integer period.');
    }
    for (const definition of [config.fast, config.slow, config.indicator]) {
      if (!isPlainObject(definition)) continue;
      const item = definition as Record<string, unknown>;
      if (!['EMA', 'SMA', 'RSI', 'ATR', 'MACD'].includes(String(item.type).toUpperCase())) throw new Error('Unsupported indicator trigger calculation.');
      for (const field of ['period', 'fastPeriod', 'slowPeriod', 'signalPeriod']) {
        if (item[field] !== undefined && (typeof item[field] !== 'number' || !Number.isInteger(item[field]) || item[field] < 1)) throw new Error('Invalid indicator period.');
      }
    }
    if ((config.fast && !config.slow) || (config.slow && !config.fast) || (config.indicator && (config.fast || config.slow))) throw new Error('Indicator trigger must define one indicator level or exactly two crossing indicators.');
  }
  if (trigger.type === 'BREAKOUT' && (!['ABOVE', 'BELOW'].includes(String(config.direction)) ||
      !(typeof config.level === 'number' && Number.isFinite(config.level) || typeof config.lookbackBars === 'number' && Number.isInteger(config.lookbackBars) && config.lookbackBars > 0))) throw new Error('Invalid BREAKOUT config.');
  if (trigger.type === 'BREAKOUT' && config.lookbackBars !== undefined &&
      (typeof config.lookbackBars !== 'number' || !Number.isInteger(config.lookbackBars) || config.lookbackBars < 1 || config.lookbackBars > 1000)) throw new Error('Invalid breakout lookback.');
  if (trigger.type === 'SPREAD_CHANGE' && (!finite('maxSpread') || !finite('expansionPercent') || !(typeof config.maxSpread === 'number' || typeof config.expansionPercent === 'number') ||
      typeof config.maxSpread === 'number' && config.maxSpread < 0 || typeof config.expansionPercent === 'number' && config.expansionPercent <= 0)) throw new Error('Invalid SPREAD_CHANGE config.');
  if (trigger.type === 'SPREAD_CHANGE' && config.maxSpread !== undefined && config.expansionPercent !== undefined) throw new Error('SPREAD_CHANGE supports one threshold condition per trigger.');
  if (trigger.type === 'VOLATILITY_CHANGE' && (!finite('threshold') || !finite('increasePercent') || !(typeof config.threshold === 'number' || typeof config.increasePercent === 'number') ||
      typeof config.threshold === 'number' && config.threshold < 0 || typeof config.increasePercent === 'number' && config.increasePercent <= 0)) throw new Error('Invalid VOLATILITY_CHANGE config.');
  if (trigger.type === 'VOLATILITY_CHANGE' && config.threshold !== undefined && config.increasePercent !== undefined) throw new Error('VOLATILITY_CHANGE supports one threshold condition per trigger.');
  if ((trigger.type === 'STOP_APPROACHING' || trigger.type === 'TARGET_APPROACHING') && (typeof config.withinPips !== 'number' || !Number.isFinite(config.withinPips) || config.withinPips < 0)) throw new Error('Invalid position proximity trigger config.');
  if (trigger.type === 'SCHEDULED' && !(typeof config.everyMs === 'number' && Number.isFinite(config.everyMs) && config.everyMs > 0) && !(typeof config.at === 'string' && typeof config.timezone === 'string')) throw new Error('Invalid SCHEDULED config.');
  if (trigger.type === 'SCHEDULED' && typeof config.at === 'string' &&
      (!/^\d{2}:\d{2}$/.test(config.at) || !validTimezone(String(config.timezone)))) throw new Error('Scheduled clock time requires HH:mm and a valid IANA timezone.');
  if (trigger.type === 'SCHEDULED' && typeof config.everyMs === 'number' && config.everyMs < 1000) throw new Error('Scheduled interval must be at least 1000ms.');
  if (trigger.type === 'NEW_BAR' && trigger.timeframe === undefined) throw new Error('NEW_BAR trigger requires a timeframe.');
  if (trigger.type === 'INDICATOR_CROSS' && trigger.timeframe === undefined) throw new Error('INDICATOR_CROSS trigger requires a timeframe.');
  if ((trigger.type === 'SESSION_START' || trigger.type === 'SESSION_END') &&
      (typeof config.timezone !== 'string' || !validTimezone(config.timezone) ||
       typeof config.sessionId !== 'string' || !Number.isFinite(config.startsAt) || !Number.isFinite(config.endsAt) || Number(config.endsAt) <= Number(config.startsAt))) {
    throw new Error('Session triggers require a valid session ID, explicit timezone, and increasing epoch boundaries.');
  }
  if (trigger.type === 'CUSTOM') throw new Error('CUSTOM triggers are disabled until an allowlisted application event source is registered.');
}

function cloneTrigger(trigger: AgentTrigger): AgentTrigger {
  return structuredClone(trigger);
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => /api.?key|secret|token|password|credential/i.test(key) || containsSensitiveKey(nested));
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function isTimeframe(value: string): boolean {
  return ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
