import { AgentInstance } from '../runtime';
import {
  Tracker,
  TrackerConfig,
  TrackerDataRequirement,
  TrackerEventType,
  TrackerKind,
  TrackerRequest,
  TrackerStatus,
} from './types';
import { agentTimeframes } from '../types';

export type TrackerAgentResolver = (agentId: string) => AgentInstance | undefined;

const SUPPORTED_KINDS: ReadonlySet<TrackerKind> = new Set<TrackerKind>([
  'NEW_BAR', 'PRICE_CROSS', 'PRICE_THRESHOLD', 'INDICATOR_CROSS', 'BREAKOUT',
  'SPREAD_CHANGE', 'VOLATILITY_CHANGE', 'POSITION_UPDATE', 'ORDER_FILLED',
  'STOP_APPROACHING', 'TARGET_APPROACHING', 'SESSION_START', 'SESSION_END', 'SCHEDULED', 'CUSTOM', 'RISK_STATE_CHANGED',
  'POSITION_OPEN', 'POSITION_CLOSE',
]);

const EVENT_TYPES: ReadonlySet<TrackerEventType> = new Set<TrackerEventType>([
  'PRICE_REACHED_LEVEL', 'PRICE_CROSSED_LEVEL', 'INDICATOR_CROSSED', 'VOLATILITY_CHANGED',
  'STRUCTURE_CHANGED', 'SPREAD_CHANGED', 'BAR_CLOSED', 'TIME_WINDOW_STARTED',
  'SESSION_CHANGED', 'CONDITION_MET', 'CUSTOM',
]);

const STATUSES: ReadonlySet<TrackerStatus> = new Set<TrackerStatus>([
  'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'FAILED',
]);

/** Per-agent ceiling, enforced here so no caller can route around it. */
const MAX_TRACKERS_PER_AGENT = 100;

/**
 * The Tracker Registry.
 *
 * The registry is the single source of truth for *which trackers exist*.
 * It owns identity, indexing, and validation; it does not evaluate
 * anything and it does not decide when a tracker reports. That is the
 * runtime's job, and keeping the two apart is what makes "the GOAT asked
 * for this" and "this was observed" separately auditable.
 *
 * Identity is the tracker id, and it is used consistently. The previous
 * version of this registry was keyed by a *derived* id at the call site
 * and by the tracker id internally, so an update could unregister one
 * name and register another, leaving the old definition live and the
 * replacement rejected as a duplicate. There is now exactly one name
 * per tracker, and it is the one the tracker carries.
 */
export class TrackerRegistry {
  private readonly trackers = new Map<string, Tracker>();
  private readonly bySymbol = new Map<string, Set<string>>();
  private readonly unscoped = new Set<string>();

  constructor(private readonly resolveAgent: TrackerAgentResolver) {}

  getAgent(agentId: string): AgentInstance | undefined { return this.resolveAgent(agentId); }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Add a tracker.
   *
   * Validation happens here rather than at each call site, because a
   * tracker is authored by a model and there is no path by which an
   * unvalidated definition should reach the evaluator.
   */
  register(tracker: Tracker): void {
    validateDefinition(tracker);
    this.assertOwnershipAndScope(tracker);
    if (this.trackers.has(tracker.id)) {
      throw new Error(`Tracker ${tracker.id} is already registered.`);
    }
    if (this.countForAgent(tracker.agentId) >= MAX_TRACKERS_PER_AGENT) {
      throw new Error('Agent tracker limit reached.');
    }
    this.index(cloneTracker(tracker));
  }

  /**
   * Replace a tracker's definition in place.
   *
   * In place rather than re-register, because a tracker's identity is its
   * history: events already attributed to it stay attributed to it. The
   * id may not change, which is what makes this safe to call from a
   * request that was handed a tracker object.
   */
  update(tracker: Tracker): Tracker {
    validateDefinition(tracker);
    const existing = this.trackers.get(tracker.id);
    if (!existing) {
      throw new Error(`Unknown tracker: ${tracker.id}`);
    }
    if (existing.agentId !== tracker.agentId) {
      throw new Error('A tracker cannot change owner.');
    }
    this.assertOwnershipAndScope(tracker);
    const stored = cloneTracker(tracker);
    this.deindex(existing);
    this.index(stored);
    return cloneTracker(stored);
  }

  /**
   * The owner has to be real, enabled and not live, and the tracker has
   * to stay inside its owner's market and timeframe scope.
   *
   * Shared by `register` and `update` on purpose: an update that could
   * move a tracker onto a market its GOAT may not trade would be a way
   * around a check that creation enforces.
   */
  private assertOwnershipAndScope(tracker: Tracker): void {
    const agent = this.resolveAgent(tracker.agentId);
    if (!agent || !agent.agent.enabled || agent.env.mode === 'LIVE') {
      throw new Error('Tracker owner must be a registered enabled non-live agent.');
    }
    if (tracker.symbol && (!agent.agent.symbols.includes(tracker.symbol) ||
        agent.agent.policy.allowedSymbols.length > 0 && !agent.agent.policy.allowedSymbols.includes(tracker.symbol))) {
      throw new Error('Tracker symbol is outside its agent symbol scope.');
    }
    if (!tracker.symbol && agent.agent.symbols.length === 0) {
      throw new Error('Unscoped tracker owner must have configured symbols.');
    }
    /*
     * Timeframe is a reasoning choice, not an identity.
     *
     * This used to require a tracker's timeframe to equal the agent's single
     * `timeframe`, which meant a GOAT could only ever watch one resolution no
     * matter what its goal asked for — and contradicted the documented
     * position that "the timeframe belongs to the GOAT's research process,
     * not to the deployment's identity". A tracker may now name any timeframe
     * the agent is allowed to read; the agent declares that menu, and an
     * agent that declares nothing is unrestricted rather than pinned to a
     * default it never chose.
     */
    if (tracker.timeframe) {
      if (!isTimeframe(tracker.timeframe)) {
        throw new Error('Tracker timeframe must be a supported timeframe.');
      }
      const allowed = agentTimeframes(agent.agent);
      if (allowed.length > 0 && !allowed.includes(tracker.timeframe)) {
        throw new Error(
          `Tracker timeframe ${tracker.timeframe} is outside the timeframes this agent may read (${allowed.join(', ')}).`,
        );
      }
    }
  }

  /** Remove a tracker entirely. Returns false when it was not registered. */
  remove(trackerId: string): boolean {
    const tracker = this.trackers.get(trackerId);
    if (!tracker) return false;
    this.deindex(tracker);
    return true;
  }

  get(trackerId: string): Tracker | undefined {
    const tracker = this.trackers.get(trackerId);
    return tracker ? cloneTracker(tracker) : undefined;
  }

  list(): Tracker[] {
    return [...this.trackers.values()].map(cloneTracker);
  }

  listForAgent(agentId: string): Tracker[] {
    return this.list().filter((tracker) => tracker.agentId === agentId);
  }

  listForThesis(thesisId: string): Tracker[] {
    return this.list().filter((tracker) => tracker.thesisId === thesisId);
  }

  countForAgent(agentId: string): number {
    let count = 0;
    for (const tracker of this.trackers.values()) if (tracker.agentId === agentId) count += 1;
    return count;
  }

  /** Drop every tracker. Used by teardown and by tests between cases. */
  clear(): void {
    this.trackers.clear();
    this.bySymbol.clear();
    this.unscoped.clear();
  }

  /**
   * The trackers that could observe a market.
   *
   * Only live ones, because a paused or retired tracker is not watching
   * anything. Symbol scoping is an index rather than a filter so the
   * runtime does not walk every tracker on every tick.
   */
  candidates(symbol?: string): Tracker[] {
    const ids = new Set(this.unscoped);
    if (symbol) for (const id of this.bySymbol.get(symbol) ?? []) ids.add(id);
    return [...ids]
      .map((id) => this.trackers.get(id))
      .filter((tracker): tracker is Tracker => tracker !== undefined && tracker.lifecycle.status === 'ACTIVE');
  }

  // -------------------------------------------------------------------
  // Index maintenance
  // -------------------------------------------------------------------

  private index(tracker: Tracker): void {
    this.trackers.set(tracker.id, tracker);
    if (tracker.symbol) {
      let index = this.bySymbol.get(tracker.symbol);
      if (!index) this.bySymbol.set(tracker.symbol, index = new Set());
      index.add(tracker.id);
    } else {
      this.unscoped.add(tracker.id);
    }
  }

  private deindex(tracker: Tracker): void {
    this.trackers.delete(tracker.id);
    if (tracker.symbol) {
      const index = this.bySymbol.get(tracker.symbol);
      index?.delete(tracker.id);
      if (index?.size === 0) this.bySymbol.delete(tracker.symbol);
    } else {
      this.unscoped.delete(tracker.id);
    }
  }

  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------

  /**
   * Build a valid tracker from a request.
   *
   * Owned here rather than in the runtime so there is exactly one place
   * that knows how a Tracker is put together, whichever layer asked for
   * it: the SDK, a backtest, or a test.
   */
  static fromRequest(input: {
    id: string;
    agentId: string;
    thesisId?: string;
    goalId?: string;
    request: TrackerRequest;
    now: number;
  }): Tracker {
    return {
      id: input.id,
      agentId: input.agentId,
      thesisId: input.thesisId,
      goalId: input.goalId,
      kind: input.request.kind,
      symbol: input.request.symbol,
      timeframe: input.request.timeframe,
      config: { ...input.request.config },
      purpose: input.request.purpose,
      eventType: input.request.eventType ?? 'CONDITION_MET',
      dependencies: input.request.dependencies ?? [],
      dataRequirements: input.request.dataRequirements ?? [],
      evaluation: {
        priority: input.request.priority ?? 0,
        cooldownMs: input.request.cooldownMs ?? 1_000,
        maxEventsPerMinute: input.request.maxEventsPerMinute ?? 10,
      },
      lifecycle: {
        status: 'ACTIVE',
        expiresAt: input.request.expiresAt,
        eventCount: 0,
      },
      createdAt: input.now,
      updatedAt: input.now,
    };
  }
}

/**
 * Validate a tracker definition.
 *
 * Split out of `register` so `update` gets exactly the same checks: a
 * definition that could not be created must not be creatable by
 * editing an existing one.
 */
export function validateDefinition(tracker: Tracker): void {
  if (!tracker.id || !tracker.agentId || !SUPPORTED_KINDS.has(tracker.kind)) {
    throw new Error('Invalid tracker identity or kind.');
  }
  if (typeof tracker.purpose !== 'string' || tracker.purpose.trim().length === 0) {
    throw new Error('A tracker must state what it is waiting for.');
  }
  if (!EVENT_TYPES.has(tracker.eventType)) {
    throw new Error('Invalid tracker event type.');
  }
  if (!STATUSES.has(tracker.lifecycle?.status)) {
    throw new Error('Invalid tracker lifecycle status.');
  }
  if (!Number.isInteger(tracker.lifecycle.eventCount) || tracker.lifecycle.eventCount < 0) {
    throw new Error('Invalid tracker event count.');
  }
  if (!Array.isArray(tracker.dataRequirements) || !Array.isArray(tracker.dependencies)) {
    throw new Error('Invalid tracker collections.');
  }
  if (!tracker.evaluation || !Number.isFinite(tracker.evaluation.priority)) {
    throw new Error('Invalid tracker priority.');
  }
  if (tracker.evaluation.cooldownMs !== undefined && (!Number.isFinite(tracker.evaluation.cooldownMs) || tracker.evaluation.cooldownMs < 0)) {
    throw new Error('Invalid tracker cooldown.');
  }
  if (tracker.evaluation.maxEventsPerMinute !== undefined &&
      (!Number.isInteger(tracker.evaluation.maxEventsPerMinute) || tracker.evaluation.maxEventsPerMinute < 1)) {
    throw new Error('Invalid tracker frequency limit.');
  }
  if (tracker.lifecycle.expiresAt !== undefined && !Number.isFinite(tracker.lifecycle.expiresAt)) {
    throw new Error('Invalid tracker expiry.');
  }
  if (!Number.isFinite(tracker.createdAt) || !Number.isFinite(tracker.updatedAt)) {
    throw new Error('Invalid tracker state/timestamps.');
  }
  if (!isPlainObject(tracker.config)) {
    throw new Error('Tracker config must be a plain object.');
  }
  const config = tracker.config as TrackerConfig;
  if (containsSensitiveKey(config)) {
    throw new Error('Tracker configuration must not contain credentials or secrets.');
  }

  validateKindConfig(tracker.kind, tracker, config);

  const tree = config.conditionTree;
  if (tree !== undefined) {
    if (!isPlainObject(tree) || (tree as { kind?: unknown }).kind !== 'GROUP' || !Array.isArray((tree as { children?: unknown }).children)) {
      throw new Error('Tracker condition tree must be a GROUP node with children.');
    }
  }
  if (tracker.kind === 'CUSTOM') {
    throw new Error('CUSTOM trackers are disabled until an allowlisted application event source is registered.');
  }
}

function validateKindConfig(kind: TrackerKind, tracker: Tracker, config: TrackerConfig): void {
  const finite = (key: string) => config[key] === undefined || (typeof config[key] === 'number' && Number.isFinite(config[key]));
  if (kind === 'PRICE_THRESHOLD' && (!finite('level') || typeof config.level !== 'number' || !['ABOVE', 'BELOW'].includes(String(config.operator)))) {
    throw new Error('Invalid PRICE_THRESHOLD config.');
  }
  if (kind === 'PRICE_CROSS' && (!finite('level') || typeof config.level !== 'number' || !['ABOVE', 'BELOW'].includes(String(config.direction)))) {
    throw new Error('Invalid PRICE_CROSS config.');
  }
  if (kind === 'INDICATOR_CROSS') {
    const crossingPair = typeof config.fastKey === 'string' && typeof config.slowKey === 'string' && isPlainObject(config.fast) && isPlainObject(config.slow);
    const crossingLevel = typeof config.indicatorKey === 'string' && finite('level') && typeof config.level === 'number' && isPlainObject(config.indicator);
    if ((!crossingPair && !crossingLevel) || !['ABOVE', 'BELOW'].includes(String(config.direction))) {
      throw new Error('Invalid INDICATOR_CROSS config.');
    }
    for (const definition of [config.fast, config.slow, config.indicator]) {
      if (!isPlainObject(definition)) continue;
      const item = definition as Record<string, unknown>;
      if (String(item.type).toUpperCase() === 'MACD' && typeof item.key !== 'string' && typeof config.fastKey !== 'string' && typeof config.slowKey !== 'string' && typeof config.indicatorKey !== 'string') {
        throw new Error('MACD tracker definition requires a key.');
      }
      if (String(item.type).toUpperCase() !== 'MACD' && (typeof item.period !== 'number' || !Number.isInteger(item.period) || item.period < 1)) {
        throw new Error('Indicator tracker requires a positive integer period.');
      }
    }
    for (const definition of [config.fast, config.slow, config.indicator]) {
      if (!isPlainObject(definition)) continue;
      const item = definition as Record<string, unknown>;
      if (!['EMA', 'SMA', 'RSI', 'ATR', 'MACD'].includes(String(item.type).toUpperCase())) {
        throw new Error('Unsupported indicator tracker calculation.');
      }
      for (const field of ['period', 'fastPeriod', 'slowPeriod', 'signalPeriod']) {
        if (item[field] !== undefined && (typeof item[field] !== 'number' || !Number.isInteger(item[field]) || item[field] < 1)) {
          throw new Error('Invalid indicator period.');
        }
      }
    }
    if ((config.fast && !config.slow) || (config.slow && !config.fast) || (config.indicator && (config.fast || config.slow))) {
      throw new Error('Indicator tracker must define one indicator level or exactly two crossing indicators.');
    }
  }
  if (kind === 'BREAKOUT' && (!['ABOVE', 'BELOW'].includes(String(config.direction)) ||
      !(typeof config.level === 'number' && Number.isFinite(config.level) || typeof config.lookbackBars === 'number' && Number.isInteger(config.lookbackBars) && config.lookbackBars > 0))) {
    throw new Error('Invalid BREAKOUT config.');
  }
  if (kind === 'BREAKOUT' && config.lookbackBars !== undefined &&
      (typeof config.lookbackBars !== 'number' || !Number.isInteger(config.lookbackBars) || config.lookbackBars < 1 || config.lookbackBars > 1000)) {
    throw new Error('Invalid breakout lookback.');
  }
  if (kind === 'SPREAD_CHANGE' && (!finite('maxSpread') || !finite('expansionPercent') || !(typeof config.maxSpread === 'number' || typeof config.expansionPercent === 'number') ||
      typeof config.maxSpread === 'number' && config.maxSpread < 0 || typeof config.expansionPercent === 'number' && config.expansionPercent <= 0)) {
    throw new Error('Invalid SPREAD_CHANGE config.');
  }
  if (kind === 'SPREAD_CHANGE' && config.maxSpread !== undefined && config.expansionPercent !== undefined) {
    throw new Error('SPREAD_CHANGE supports one threshold condition per tracker.');
  }
  if (kind === 'VOLATILITY_CHANGE' && (!finite('threshold') || !finite('increasePercent') || !(typeof config.threshold === 'number' || typeof config.increasePercent === 'number') ||
      typeof config.threshold === 'number' && config.threshold < 0 || typeof config.increasePercent === 'number' && config.increasePercent <= 0)) {
    throw new Error('Invalid VOLATILITY_CHANGE config.');
  }
  if (kind === 'VOLATILITY_CHANGE' && config.threshold !== undefined && config.increasePercent !== undefined) {
    throw new Error('VOLATILITY_CHANGE supports one threshold condition per tracker.');
  }
  if ((kind === 'STOP_APPROACHING' || kind === 'TARGET_APPROACHING') && !hasProximityThreshold(config)) {
    throw new Error('Invalid position proximity tracker config.');
  }
  if (kind === 'SCHEDULED' && !(typeof config.everyMs === 'number' && Number.isFinite(config.everyMs) && config.everyMs > 0) &&
      !(typeof config.at === 'string' && typeof config.timezone === 'string')) {
    throw new Error('Invalid SCHEDULED config.');
  }
  if (kind === 'SCHEDULED' && typeof config.at === 'string' &&
      (!/^\d{2}:\d{2}$/.test(config.at) || !validTimezone(String(config.timezone)))) {
    throw new Error('Scheduled clock time requires HH:mm and a valid IANA timezone.');
  }
  if (kind === 'SCHEDULED' && typeof config.everyMs === 'number' && config.everyMs < 1000) {
    throw new Error('Scheduled interval must be at least 1000ms.');
  }
  if (kind === 'NEW_BAR' && tracker.timeframe === undefined) {
    throw new Error('NEW_BAR tracker requires a timeframe.');
  }
  if (kind === 'INDICATOR_CROSS' && tracker.timeframe === undefined) {
    throw new Error('INDICATOR_CROSS tracker requires a timeframe.');
  }
  if ((kind === 'SESSION_START' || kind === 'SESSION_END') &&
      (typeof config.timezone !== 'string' || !validTimezone(config.timezone) ||
       typeof config.sessionId !== 'string' || !Number.isFinite(config.startsAt) || !Number.isFinite(config.endsAt) || Number(config.endsAt) <= Number(config.startsAt))) {
    throw new Error('Session trackers require a valid session ID, explicit timezone, and increasing epoch boundaries.');
  }
}

/**
 * A proximity tracker needs at least one non-negative distance threshold.
 *
 * Which thresholds are *measurable* for a given instrument is decided by
 * the evaluator from instrument metadata; registration only checks that
 * the shape is sane. `withinPips` is not required, because it would be
 * meaningless for a commodity or index that declares no pip size.
 */
function hasProximityThreshold(config: TrackerConfig): boolean {
  const keys = ['withinPrice', 'withinPips', 'withinTicks', 'withinPercent', 'withinValue'];
  return keys.some((key) => {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  });
}

function cloneTracker(tracker: Tracker): Tracker {
  return structuredClone(tracker);
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

function isPlainObject(value: unknown): value is TrackerConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Data requirements are declared data, never behaviour. */
export function isDataRequirement(value: unknown): value is TrackerDataRequirement {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  if (typeof kind !== 'string') return false;
  if (!['QUOTE', 'BARS', 'INDICATOR', 'STRUCTURE', 'ACCOUNT'].includes(kind)) return false;
  if (value.timeframe !== undefined && typeof value.timeframe !== 'string') return false;
  if (value.detail !== undefined && typeof value.detail !== 'string') return false;
  if (value.barCount !== undefined && (typeof value.barCount !== 'number' || !Number.isFinite(value.barCount))) return false;
  return true;
}
