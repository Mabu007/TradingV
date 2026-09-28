import { calculateATR, calculateEMA, calculateRSI, calculateSMA, calculateMACD } from '../../indicators';
import { AgentTrigger, TriggerInput, TriggerType } from './types';

export interface TriggerEvaluationState {
  previous: Map<string, TriggerMarketStateSnapshot>;
  lastBar: Map<string, number>;
  lastSession: Map<string, string>;
  lastSchedule: Map<string, number>;
  sessionStarts: Set<string>;
  sessionEnds: Set<string>;
  proximity: Map<string, boolean>;
}

export interface TriggerMarketStateSnapshot {
  timestamp: number;
  price?: number;
  spread?: number;
  indicators?: Record<string, number>;
  barTime?: number;
  sessionId?: string;
  bars?: TriggerInput['state']['bars'];
}

export function evaluateTrigger(trigger: AgentTrigger, input: TriggerInput, state: TriggerEvaluationState): string | undefined {
  const key = trigger.id;
  const previous = state.previous.get(key);
  const current = snapshot(trigger, input);
  let reason: string | undefined;
  switch (trigger.type) {
    case 'NEW_BAR': reason = evaluateNewBar(trigger, input, state); break;
    case 'PRICE_THRESHOLD': reason = evaluatePriceThreshold(trigger, input, previous); break;
    case 'PRICE_CROSS': reason = evaluatePriceCross(trigger, input, previous); break;
    case 'INDICATOR_CROSS': reason = evaluateIndicatorCross(trigger, input, previous); break;
    case 'BREAKOUT': reason = evaluateBreakout(trigger, input, previous); break;
    case 'SPREAD_CHANGE': reason = evaluateSpread(trigger, input, previous); break;
    case 'VOLATILITY_CHANGE': reason = evaluateVolatility(trigger, input, previous); break;
    case 'POSITION_UPDATE': reason = evaluatePositionUpdate(trigger, input); break;
    case 'POSITION_OPEN': reason = input.type === 'POSITION_OPEN' ? 'A position opened.' : undefined; break;
    case 'POSITION_CLOSE': reason = input.type === 'POSITION_CLOSE' ? 'A position closed.' : undefined; break;
    case 'RISK_STATE_CHANGED': reason = input.type === 'RISK_STATE_CHANGED' ? 'Trading risk state changed.' : undefined; break;
    case 'ORDER_FILLED': reason = input.type === 'ORDER_FILLED' && input.state.order?.status === 'FILLED' ? `Order ${input.state.order.orderId || ''} filled.` : undefined; break;
    case 'STOP_APPROACHING': reason = evaluatePositionProximity(trigger, input, state, 'stopLoss'); break;
    case 'TARGET_APPROACHING': reason = evaluatePositionProximity(trigger, input, state, 'takeProfit'); break;
    case 'SESSION_START': reason = evaluateSession(trigger, input, state, true); break;
    case 'SESSION_END': reason = evaluateSession(trigger, input, state, false); break;
    case 'SCHEDULED': reason = evaluateScheduled(trigger, input, state); break;
    case 'CUSTOM': reason = evaluateCustom(trigger, input); break;
    default: assertNever(trigger.type);
  }
  state.previous.set(key, current);
  return reason;
}

export function newEvaluationState(): TriggerEvaluationState {
  return { previous: new Map(), lastBar: new Map(), lastSession: new Map(), lastSchedule: new Map(), sessionStarts: new Set(), sessionEnds: new Set(), proximity: new Map() };
}

export function calculateTriggerIndicators(trigger: AgentTrigger, input: TriggerInput): Record<string, number> {
  return computeConfiguredIndicators(record(trigger.config), input);
}

function evaluateNewBar(trigger: AgentTrigger, input: TriggerInput, state: TriggerEvaluationState): string | undefined {
  if (input.type !== 'BAR_UPDATE' && input.type !== 'NEW_BAR') return undefined;
  const payload = record(input.state.eventData);
  if (payload?.isClosed === false) return undefined;
  if (!input.state.bars?.length) return undefined;
  const barTime = input.state.bars[input.state.bars.length - 1].time;
  const bucket = timeframeBucket(barTime, trigger.timeframe || input.timeframe);
  if (bucket === undefined || state.lastBar.get(trigger.id) === bucket) return undefined;
  if (input.type === 'BAR_UPDATE' && (payload?.isClosed !== true || bucket !== timeframeBucket(input.timestamp / 1000, trigger.timeframe || input.timeframe))) return undefined;
  state.lastBar.set(trigger.id, bucket);
  return `New ${trigger.timeframe || input.timeframe || 'bar'} for ${trigger.symbol || input.symbol}.`;
}

function evaluatePriceThreshold(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const level = number(config?.level);
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const operator = config?.operator;
  if (level === undefined || price === undefined || (operator !== 'ABOVE' && operator !== 'BELOW')) return undefined;
  const wasSatisfied = previous?.price !== undefined && (operator === 'ABOVE' ? previous.price >= level : previous.price <= level);
  const satisfied = operator === 'ABOVE' ? price >= level : price <= level;
  return previous !== undefined && !wasSatisfied && satisfied ? `Price crossed ${operator.toLowerCase()} ${level}.` : undefined;
}

function evaluatePriceCross(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const level = number(config?.level);
  const prior = previous?.price;
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const direction = config?.direction;
  if (level === undefined || prior === undefined || price === undefined || (direction !== 'ABOVE' && direction !== 'BELOW')) return undefined;
  const crossed = direction === 'ABOVE' ? prior < level && price >= level : prior > level && price <= level;
  return crossed ? `Price crossed ${direction.toLowerCase()} ${level}.` : undefined;
}

function evaluateIndicatorCross(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const direction = config?.direction;
  if (direction !== 'ABOVE' && direction !== 'BELOW') return undefined;
  const current = computeConfiguredIndicators(config, input);
  const prior = previous?.indicators;
  const fastKey = typeof config?.fastKey === 'string' ? config.fastKey : undefined;
  const slowKey = typeof config?.slowKey === 'string' ? config.slowKey : undefined;
  const level = number(config?.level);
  if (fastKey && slowKey && current[fastKey] !== undefined && current[slowKey] !== undefined && prior?.[fastKey] !== undefined && prior[slowKey] !== undefined) {
    const crossed = direction === 'ABOVE'
      ? prior[fastKey] <= prior[slowKey] && current[fastKey] > current[slowKey]
      : prior[fastKey] >= prior[slowKey] && current[fastKey] < current[slowKey];
    return crossed ? `${fastKey} crossed ${direction.toLowerCase()} ${slowKey}.` : undefined;
  }
  const indicator = typeof config?.indicatorKey === 'string' ? config.indicatorKey : undefined;
  if (indicator && level !== undefined && current[indicator] !== undefined && prior?.[indicator] !== undefined) {
    const crossed = direction === 'ABOVE' ? prior[indicator] < level && current[indicator] >= level : prior[indicator] > level && current[indicator] <= level;
    return crossed ? `${indicator} crossed ${direction.toLowerCase()} ${level}.` : undefined;
  }
  return undefined;
}

function computeConfiguredIndicators(config: Record<string, unknown> | undefined, input: TriggerInput): Record<string, number> {
  const bars = input.state.bars;
  if (!bars || !config) return input.state.indicators || {};
  if (!bars.every((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.high >= bar.low)) return input.state.indicators || {};
  const closes = bars.map((bar) => bar.close);
  const result: Record<string, number> = { ...(input.state.indicators || {}) };
  const fast = record(config.fast);
  const slow = record(config.slow);
  if (fast) assignIndicator(result, { ...fast, key: config.fastKey }, closes, bars);
  if (slow) assignIndicator(result, { ...slow, key: config.slowKey }, closes, bars);
  const single = record(config.indicator);
  if (single) assignIndicator(result, { ...single, key: config.indicatorKey }, closes, bars);
  return result;
}

function assignIndicator(result: Record<string, number>, definition: Record<string, unknown>, closes: number[], bars: TriggerInput['state']['bars']): void {
  const key = typeof definition.key === 'string' ? definition.key : undefined;
  const type = typeof definition.type === 'string' ? definition.type.toUpperCase() : '';
  const period = number(definition.period);
  if (!key) return;
  if (type === 'MACD') {
    const macd = calculateMACD(closes, number(definition.fastPeriod) ?? 12, number(definition.slowPeriod) ?? 26, number(definition.signalPeriod) ?? 9);
    const component = definition.component === 'signal' ? macd.signal : definition.component === 'histogram' ? macd.histogram : macd.macd;
    const latest = component.at(-1);
    if (latest !== undefined && Number.isFinite(latest)) result[key] = latest;
    return;
  }
  if (!period || period < 1 || !Number.isInteger(period)) return;
  let values: number[];
  if (type === 'EMA') values = calculateEMA(closes, period);
  else if (type === 'SMA') values = calculateSMA(closes, period);
  else if (type === 'RSI') values = calculateRSI(closes, period);
  else if (type === 'ATR' && bars && bars.every((bar) => 'open' in bar)) values = calculateATR(bars as Array<{ time: number; open: number; high: number; low: number; close: number }>, period);
  else return;
  const latest = values.at(-1);
  if (latest !== undefined && Number.isFinite(latest)) result[key] = latest;
}

function evaluateBreakout(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const direction = config?.direction;
  const bars = input.state.bars;
  const price = input.state.price ?? input.state.bars?.at(-1)?.close;
  const level = number(config?.level);
  if (price === undefined || (direction !== 'ABOVE' && direction !== 'BELOW')) return undefined;
  if (level !== undefined) {
    if (previous?.price === undefined) return undefined;
    return direction === 'ABOVE' && previous.price < level && price >= level || direction === 'BELOW' && previous.price > level && price <= level
      ? `Price broke ${direction.toLowerCase()} configured level ${level}.` : undefined;
  }
  const lookback = number(config?.lookbackBars) ?? 20;
  if (!bars || bars.length < lookback + 1 || previous?.price === undefined) return undefined;
  const reference = bars.slice(-(lookback + 1), -1);
  const boundary = direction === 'ABOVE' ? Math.max(...reference.map((bar) => bar.high)) : Math.min(...reference.map((bar) => bar.low));
  const broken = direction === 'ABOVE' ? previous.price < boundary && price >= boundary : previous.price > boundary && price <= boundary;
  return broken ? `${direction} breakout of prior ${lookback}-bar boundary ${boundary}.` : undefined;
}

function evaluateSpread(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const spread = input.state.spread;
  const prior = previous?.spread;
  if (spread === undefined) return undefined;
  const maximum = number(config?.maxSpread);
  if (maximum !== undefined && spread > maximum && (prior === undefined || prior <= maximum)) return `Spread expanded above ${maximum}.`;
  const expansionPercent = number(config?.expansionPercent);
  if (expansionPercent !== undefined && prior !== undefined && prior > 0 && spread >= prior * (1 + expansionPercent / 100)) return `Spread expanded by at least ${expansionPercent}%.`;
  return undefined;
}

function evaluateVolatility(trigger: AgentTrigger, input: TriggerInput, previous?: TriggerMarketStateSnapshot): string | undefined {
  const config = record(trigger.config);
  const key = typeof config?.indicatorKey === 'string' ? config.indicatorKey : 'atr';
  const values = computeConfiguredIndicators(config, input);
  const atr = values[key];
  const threshold = number(config?.threshold);
  const prior = previous?.indicators?.[key];
  if (atr === undefined) return undefined;
  if (threshold !== undefined && atr >= threshold && (prior === undefined || prior < threshold)) return `${key} crossed volatility threshold ${threshold}.`;
  const increasePercent = number(config?.increasePercent);
  if (increasePercent !== undefined && prior !== undefined && prior > 0 && atr >= prior * (1 + increasePercent / 100)) return `${key} increased by at least ${increasePercent}%.`;
  return undefined;
}

function evaluatePositionUpdate(trigger: AgentTrigger, input: TriggerInput): string | undefined {
  const config = record(trigger.config);
  const expectedId = typeof config?.positionId === 'string' ? config.positionId : undefined;
  const data = record(input.state.eventData);
  if (expectedId && data?.positionId !== expectedId) return undefined;
  if (input.type !== 'POSITION_OPEN' && input.type !== 'POSITION_UPDATE' && input.type !== 'POSITION_CLOSE') return undefined;
  return `Position ${typeof data?.positionId === 'string' ? data.positionId : ''} updated (${input.type}).`;
}

function evaluatePositionProximity(trigger: AgentTrigger, input: TriggerInput, state: TriggerEvaluationState, key: 'stopLoss' | 'takeProfit'): string | undefined {
  const config = record(trigger.config);
  const maxDistance = number(config?.withinPips);
  const maxPriceDistance = number(config?.withinPrice);
  const positions = input.state.positions || [];
  if (input.symbol === undefined) return undefined;
  if (maxDistance === undefined && maxPriceDistance === undefined) return undefined;
  if (maxDistance !== undefined && maxDistance < 0) return undefined;
  if (maxPriceDistance !== undefined && maxPriceDistance < 0) return undefined;
  /*
   * `withinPips` is a Forex-shaped threshold and this evaluator has no
   * access to instrument metadata by design, so the pip size is an
   * approximation for Forex pairs only. Triggers on commodity or index
   * instruments should use the raw `withinPrice` distance instead.
   */
  const pipSize = input.symbol.includes('JPY') ? 0.01 : 0.0001;
  for (const position of positions) {
    if (position.symbol !== (trigger.symbol || input.symbol)) continue;
    const target = position[key];
    if (target === undefined) continue;
    const rawDistance = Math.abs(position.currentPrice - target);
    const withinLimit = maxPriceDistance !== undefined
      ? rawDistance <= maxPriceDistance
      : maxDistance !== undefined && rawDistance / pipSize <= maxDistance;
    const distancePips = rawDistance / pipSize;
    const proximityKey = `${trigger.id}:${position.id}:${key}`;
    const wasNear = state.proximity.get(proximityKey) === true;
    if (withinLimit && !wasNear) { state.proximity.set(proximityKey, true); return `Position ${position.id} is ${distancePips.toFixed(1)} pips from ${key}.`; }
    if (!withinLimit) state.proximity.set(proximityKey, false);
  }
  return undefined;
}

function evaluateSession(trigger: AgentTrigger, input: TriggerInput, state: TriggerEvaluationState, starting: boolean): string | undefined {
  const session = input.state.session;
  if (!session || !validTimezone(session.timezone)) return undefined;
  const triggerConfig = record(trigger.config);
  const configuredSession = triggerConfig?.sessionId;
  if (typeof configuredSession === 'string' && configuredSession !== session.id) return undefined;
  if (number(triggerConfig?.startsAt) !== session.startsAt || number(triggerConfig?.endsAt) !== session.endsAt) return undefined;
  const boundaryKey = `${trigger.id}:${session.id}:${starting ? 'start' : 'end'}`;
  if (starting && input.timestamp >= session.startsAt && input.timestamp <= session.startsAt + 60_000 && !state.sessionStarts.has(boundaryKey)) {
    state.sessionStarts.add(boundaryKey);
    return `Session ${session.id} started (${session.timezone}).`;
  }
  if (!starting && input.timestamp >= session.endsAt && input.timestamp <= session.endsAt + 60_000 && !state.sessionEnds.has(boundaryKey)) {
    state.sessionEnds.add(boundaryKey);
    return `Session ${session.id} ended (${session.timezone}).`;
  }
  return undefined;
}

function evaluateScheduled(trigger: AgentTrigger, input: TriggerInput, state: TriggerEvaluationState): string | undefined {
  const config = record(trigger.config);
  const everyMs = number(config?.everyMs);
  const last = state.lastSchedule.get(trigger.id);
  if (everyMs !== undefined && everyMs > 0) {
    if (last === undefined) { state.lastSchedule.set(trigger.id, input.timestamp); return undefined; }
    if (input.timestamp - last >= everyMs) { state.lastSchedule.set(trigger.id, input.timestamp); return `Scheduled interval (${everyMs}ms) elapsed.`; }
    return undefined;
  }
  const at = typeof config?.at === 'string' ? config.at : undefined;
  const timezone = typeof config?.timezone === 'string' ? config.timezone : undefined;
  if (!at || !timezone || !validTimezone(timezone) || !/^\d{2}:\d{2}$/.test(at)) return undefined;
  const [hour, minute] = at.split(':').map(Number);
  if (hour > 23 || minute > 59) return undefined;
  const currentMinute = Math.floor(input.timestamp / 60_000);
  const scheduledMinute = findLocalMinute(currentMinute, timezone, hour, minute);
  if (scheduledMinute === undefined || last === scheduledMinute) return undefined;
  state.lastSchedule.set(trigger.id, scheduledMinute);
  return `Scheduled wake at ${at} ${timezone}.`;
}

function findLocalMinute(currentMinute: number, timezone: string, hour: number, minute: number): number | undefined {
  for (let candidate = currentMinute - 2; candidate <= currentMinute; candidate += 1) {
    const date = new Date(candidate * 60_000);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    if (parts === `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`) return candidate;
  }
  return undefined;
}

function evaluateCustom(trigger: AgentTrigger, input: TriggerInput): string | undefined {
  const data = record(input.state.eventData);
  const eventName = record(trigger.config)?.eventName;
  return input.type === 'CUSTOM' && typeof eventName === 'string' && data?.customTriggerName === eventName ? `Registered custom trigger ${eventName}.` : undefined;
}

function snapshot(trigger: AgentTrigger, input: TriggerInput): TriggerMarketStateSnapshot {
  return { timestamp: input.timestamp, price: input.state.price ?? input.state.bars?.at(-1)?.close, spread: input.state.spread,
    indicators: computeConfiguredIndicators(record(trigger.config), input), barTime: input.state.bars?.at(-1)?.time,
    sessionId: input.state.session?.id, bars: input.state.bars };
}

function timeframeBucket(timeSeconds: number, timeframe?: string): number | undefined {
  const seconds: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const duration = timeframe ? seconds[timeframe] : undefined;
  return duration ? Math.floor(timeSeconds / duration) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function validTimezone(value: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }
function assertNever(value: never): never { throw new Error(`Unsupported trigger type: ${String(value)}`); }
