/**
 * The Tracker Runtime.
 *
 * This is the whole observation side of the architecture, and it is the
 * real implementation of it rather than a wrapper over anything:
 *
 *   GOAT -> Tracker SDK -> Tracker Registry -> Tracker Runtime
 *        -> Tracker Evaluator -> market data -> TrackerEvent -> GOAT
 *
 * It owns deterministic monitoring and nothing else. It does not
 * reason, it does not interpret, and it does not decide whether a trade
 * should happen. Its entire job is to notice a meaningful observation
 * and wake the GOAT that asked to be told about it.
 *
 * What it holds:
 *
 *   - the subscription to market data, and the fan-out of one delivery
 *     to every tracker that could care about it
 *   - the per-tracker evaluation state (previous sample, last bar,
 *     last schedule, proximity flags)
 *   - deduplication, cooldowns and per-minute rate limits
 *   - tracker lifecycle: pause, resume, cancel, expiry, failure
 *   - resource ceilings, so a runaway GOAT cannot spawn trackers without
 *     bound
 *   - the event log, the wake requests, and the audit trail
 *
 * What it deliberately does not hold: an LLM, a position, an order, or a
 * view. The GOAT reasons; the runtime observes.
 */

import { eventBus, TradingGOATsEvent } from '../../../types/events';
import { AgentRuntime } from '../runtime';
import { agentTimeframes } from '../types';
import { AgentWakeEvent } from '../types';
import { AgentTimelineStore } from '../timeline/types';
import { InstrumentMetadata } from '../../../types/instruments';
import { ITradingEnvironment } from '../types';
import { calculateTrackerIndicators, TrackerEvaluator } from './evaluator';
import { isDataRequirement, TrackerRegistry } from './registry';
import {
  Tracker,
  TrackerDataRequirement,
  TrackerDelivery,
  TrackerEvent,
  TrackerEventSeverity,
  TrackerEventType,
  TrackerInput,
  TrackerKind,
  TrackerRequest,
  TrackerStatus,
  TrackerThesisView,
  TrackerWakeRequest,
} from './types';

interface EventRecord { timestamp: number; }

/**
 * How many delivery ids the runtime remembers for duplicate detection.
 *
 * A duplicate re-delivery arrives within milliseconds of the original,
 * so this is orders of magnitude more than any realistic replay window.
 */
const MAX_REMEMBERED_INPUT_IDS = 10_000;

/** Ceilings that keep a misbehaving GOAT from exhausting the runtime. */
export interface TrackerRuntimeLimits {
  maxTrackersPerThesis: number;
  maxTrackersPerAgent: number;
  maxTrackersTotal: number;
  maxEventsPerTracker: number;
  /** Default expiry when a request does not set one. */
  defaultTtlMs: number;
}

export const DEFAULT_TRACKER_LIMITS: TrackerRuntimeLimits = {
  maxTrackersPerThesis: 12,
  maxTrackersPerAgent: 40,
  maxTrackersTotal: 500,
  maxEventsPerTracker: 200,
  defaultTtlMs: 24 * 60 * 60 * 1000,
};

/** How many wake requests are retained for inspection. */
const MAX_RETAINED_WAKE_REQUESTS = 500;

/**
 * The narrow view of a GOAT the runtime needs for scope checks.
 *
 * Structural rather than the concrete `AgentInstance` so the runtime
 * stays testable without constructing a full agent, and so a backtest
 * can supply scope without a live runtime.
 */
export interface TrackerAgentScope {
  symbols: string[];
  timeframe?: string;
}

/**
 * What the reasoning layer lends the runtime.
 *
 * The runtime is not allowed to depend on the GOAT model, so it asks for
 * exactly three things and nothing more: which thesis owns a tracker,
 * which skills are active for a GOAT, and a callback when something is
 * observed. Bind it once; a runtime with no binding still runs trackers,
 * it just has no thesis to attribute them to.
 */
export interface TrackerDomainBinding {
  resolveThesis(thesisId: string): TrackerThesisView | undefined;
  resolveSkillIds(agentId: string): string[];
  /** Called when a tracker produces an event. The GOAT reasons there. */
  onEvent?(event: TrackerEvent): void | Promise<void>;
}

export class TrackerRuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNKNOWN_THESIS'
      | 'UNKNOWN_TRACKER'
      | 'LIMIT_REACHED'
      | 'INVALID_SPEC'
      | 'FORBIDDEN'
      | 'INVALID_TRANSITION',
  ) {
    super(message);
    this.name = 'TrackerRuntimeError';
  }
}

/**
 * Tracker kinds the runtime will accept.
 *
 * Exported because a caller parsing a model-authored plan has to know the
 * vocabulary too, and two copies of this list would drift.
 */
export const TRACKER_KINDS: ReadonlySet<TrackerKind> = new Set<TrackerKind>([
  'NEW_BAR',
  'PRICE_CROSS',
  'PRICE_THRESHOLD',
  'INDICATOR_CROSS',
  'BREAKOUT',
  'SPREAD_CHANGE',
  'VOLATILITY_CHANGE',
  'SESSION_START',
  'SESSION_END',
  'SCHEDULED',
  'CUSTOM',
]);

/**
 * Maps a tracker kind to the event type the GOAT sees.
 *
 * The mapping is lossy on purpose: the GOAT gets "a level was reached",
 * not "this is bullish". Interpretation is the GOAT's job, and
 * collapsing the two here is exactly the mistake this architecture
 * exists to avoid.
 */
export const EVENT_TYPE_FOR_KIND: Readonly<Record<string, TrackerEventType>> = {
  NEW_BAR: 'BAR_CLOSED',
  PRICE_CROSS: 'PRICE_CROSSED_LEVEL',
  PRICE_THRESHOLD: 'PRICE_REACHED_LEVEL',
  INDICATOR_CROSS: 'INDICATOR_CROSSED',
  BREAKOUT: 'STRUCTURE_CHANGED',
  VOLATILITY_CHANGE: 'VOLATILITY_CHANGED',
  SPREAD_CHANGE: 'SPREAD_CHANGED',
  SESSION_START: 'SESSION_CHANGED',
  SESSION_END: 'SESSION_CHANGED',
  SCHEDULED: 'TIME_WINDOW_STARTED',
  CUSTOM: 'CONDITION_MET',
  POSITION_OPEN: 'CONDITION_MET',
  POSITION_CLOSE: 'CONDITION_MET',
  POSITION_UPDATE: 'CONDITION_MET',
  ORDER_FILLED: 'CONDITION_MET',
  STOP_APPROACHING: 'CONDITION_MET',
  TARGET_APPROACHING: 'CONDITION_MET',
  RISK_STATE_CHANGED: 'CONDITION_MET',
};

export interface TrackerRuntimeOptions {
  registry: TrackerRegistry;
  agents: AgentRuntime;
  timeline: AgentTimelineStore;
  limits?: TrackerRuntimeLimits;
  clock?: () => number;
  idFactory?: (prefix: string) => string;
}

export class TrackerRuntime {
  private readonly registry: TrackerRegistry;
  private readonly agents: AgentRuntime;
  private readonly timeline: AgentTimelineStore;
  private readonly limits: TrackerRuntimeLimits;
  private readonly clockFn?: () => number;
  private readonly idFactoryFn?: (prefix: string) => string;

  /**
   * Per-tracker evaluation state.
   *
   * Keyed by environment as well as tracker id, because a live quote and
   * a historical bar must not share the memory of "what did I see last
   * time". That separation is what lets a backtest and a live run drive
   * an identical tracker.
   */
  private readonly evaluators = new Map<string, TrackerEvaluator>();
  private readonly lastEvent = new Map<string, number>();
  private readonly eventHistory = new Map<string, EventRecord[]>();
  private readonly inFlight = new Set<string>();
  private readonly recentInputIds = new Map<string, number>();
  private readonly processedEvents = new Map<string, Set<string>>();
  private readonly instrumentCache = new Map<string, Promise<InstrumentMetadata | undefined>>();
  private readonly agentByPosition = new Map<string, string>();
  private readonly eventsByTracker = new Map<string, TrackerEvent[]>();
  private readonly allEvents: TrackerEvent[] = [];
  private readonly wakeRequests: TrackerWakeRequest[] = [];

  private readonly delivery: TrackerDelivery;
  private readonly resolveAgent: TrackerRegistry['getAgent'];
  private unsubscribe?: () => void;
  private sourceEnvironment?: 'BACKTEST' | 'DEMO';
  private domain?: TrackerDomainBinding;
  private domainEventSequence = 0;

  constructor(options: TrackerRuntimeOptions) {
    this.registry = options.registry;
    this.agents = options.agents;
    this.timeline = options.timeline;
    this.limits = options.limits ?? DEFAULT_TRACKER_LIMITS;
    this.clockFn = options.clock;
    this.idFactoryFn = options.idFactory;

    this.resolveAgent = (agentId: string) => this.registry.getAgent(agentId);
    this.delivery = {
      wake: async (event: TrackerEvent) => {
        const wakeEvent: AgentWakeEvent = {
          type: wakeType(event.kind),
          symbol: event.symbol,
          timestamp: event.timestamp,
          data: {
            trackerId: event.trackerId,
            trackerKind: event.kind,
            reason: event.reason,
            sourceEventId: event.sourceEventId,
            correlationId: correlationIdFor(event),
          },
        };
        if (this.agents.getAgent(event.agentId)?.isRunning) {
          await this.agents.handleEvent(event.agentId, wakeEvent);
        }
      },
    };
  }

  /**
   * Attach the reasoning layer.
   *
   * Binding rather than construction, because the runtime is created by
   * the application (it needs the agent runtime and the timeline) and
   * the GOAT orchestrator is created afterwards. The binding is the only
   * direction of dependency between the two, and it is three functions.
   */
  bindDomain(binding: TrackerDomainBinding): void {
    this.domain = binding;
  }

  private now(): number {
    return this.clockFn ? this.clockFn() : Date.now();
  }

  private nextId(prefix: string): string {
    if (this.idFactoryFn) return this.idFactoryFn(prefix);
    return `${prefix}_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------------------------------------------------------------------
  // Market data subscription
  // ---------------------------------------------------------------------

  /**
   * Release everything this runtime holds.
   *
   * The bus subscription, the per-tracker evaluation state, the delivery
   * memories and the event log. A disposed runtime holds no memory, and a
   * later `start()` behaves like a new one.
   */
  dispose(): void {
    this.stop();
    this.evaluators.clear();
    this.lastEvent.clear();
    this.eventHistory.clear();
    this.recentInputIds.clear();
    this.processedEvents.clear();
    this.inFlight.clear();
    this.agentByPosition.clear();
    this.instrumentCache.clear();
    this.eventsByTracker.clear();
    this.allEvents.length = 0;
    this.wakeRequests.length = 0;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.onAll((event) => {
      if (!this.sourceEnvironment) return;
      if (event.type === 'MARKET_QUOTE') {
        for (const instance of this.agents.listAgents()) {
          if (instance.isRunning && instance.env.mode === this.sourceEnvironment && instance.agent.symbols.includes(event.data.symbol)) {
            /*
             * The delivery id names the agent as well as the event.
             *
             * An earlier version of this comment claimed that a shared id
             * let one agent starve another. That was not what happened, and
             * the claim was worth re-testing rather than keeping:
             * `processedEvents` is keyed by tracker id, and each agent
             * owns its own trackers, so a shared `input.id` never
             * suppressed a second agent's candidate. A test that forces
             * a shared id still wakes all three agents.
             *
             * The agent-scoped id is kept because the id identifies a
             * *delivery*, and two agents being handed the same one is
             * wrong even when nothing currently reads it that way. It
             * also keeps `recentInputIds` from collapsing three
             * deliveries into one entry. What actually provides the
             * isolation is the per-tracker dedup map; the audit test
             * asserts the isolation, and does not depend on this string.
             */
            const quoteEvent: TrackerInput = {
              id: `quote:${event.data.symbol}:${event.data.timestamp}:${instance.agent.id}`,
              type: 'MARKET_QUOTE',
              timestamp: event.data.timestamp,
              environment: this.sourceEnvironment,
              symbol: event.data.symbol,
              timeframe: instance.agent.timeframe,
              agentId: instance.agent.id,
              state: {
                timestamp: event.data.timestamp,
                environment: this.sourceEnvironment,
                symbol: event.data.symbol,
                timeframe: instance.agent.timeframe,
                price: (event.data.bid + event.data.ask) / 2,
                spread: event.data.spread,
              },
            };
            void this.process(quoteEvent).catch((error: unknown) => this.recordError(instance.agent.id, 'quote-event', quoteEvent.timestamp, error));
          }
        }
        return;
      }
      const input = inputFromDomainEvent(event, this.now(), this.domainEventSequence++);
      if (input) {
        void this.dispatchMarketInput(input).catch((error: unknown) => this.recordError('tracker-runtime', 'event-dispatch', input.timestamp, error));
      }
    });
  }

  setEnvironment(environment: 'BACKTEST' | 'DEMO'): void { this.sourceEnvironment = environment; }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async dispatchMarketInput(input: TrackerInput): Promise<void> {
    if (!input.symbol || !this.sourceEnvironment) return;
    const activeAgents = this.agents.listAgents().filter((instance) => instance.isRunning &&
      instance.env.mode === this.sourceEnvironment && instance.agent.symbols.includes(input.symbol as string));
    for (const instance of activeAgents) {
      const timeframe = instance.agent.timeframe || input.timeframe;
      let state = { ...input.state, symbol: input.symbol, timeframe, environment: this.sourceEnvironment };
      if (input.type === 'BAR_UPDATE' && timeframe) {
        try {
          const history = await instance.env.getMarketBars(input.symbol, timeframe, 1000);
          state = { ...state, bars: history };
        } catch (error: unknown) {
          await this.recordError(instance.agent.id, 'bar-history', input.timestamp, error);
          continue;
        }
      }
      const agentInput: TrackerInput = {
        ...input,
        id: `${input.id}:${instance.agent.id}`,
        agentId: instance.agent.id,
        timeframe,
        environment: this.sourceEnvironment,
        state,
      };
      void this.process(agentInput).catch((error: unknown) => this.recordError(instance.agent.id, 'event-dispatch', input.timestamp, error));
    }
  }

  // ---------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------

  ingest(event: TradingGOATsEvent, environment: 'BACKTEST' | 'DEMO'): Promise<TrackerEvent[]> {
    const input = inputFromDomainEvent(event, this.now(), this.domainEventSequence++);
    if (!input) return Promise.resolve([]);
    return this.process({ ...input, environment, state: { ...input.state, environment } });
  }

  /**
   * Evaluate every tracker that could observe this delivery.
   *
   * The fan-out is the hot path of the whole observation architecture, so
   * the ordering matters: candidates are already narrowed by symbol and
   * liveness by the registry index, then narrowed by agent, timeframe and
   * explicit targeting, then sorted so a higher-priority tracker reports
   * first. A tracker is only ever evaluated once per delivery, whatever
   * its priority.
   */
  async process(input: TrackerInput): Promise<TrackerEvent[]> {
    if (input.type === 'CUSTOM') {
      await this.recordError('tracker-runtime', input.trackerId || 'custom', input.timestamp, new Error('Custom tracker input is disabled until an application event source is registered.'));
      return [];
    }
    if (input.state.environment !== input.environment || !Number.isFinite(input.timestamp) || !input.id || typeof input.state.symbol !== 'string' ||
      input.symbol !== undefined && input.symbol !== input.state.symbol) return [];
    if (input.environment === 'LIVE' || input.environment !== 'BACKTEST' && input.environment !== 'DEMO') return [];
    if (input.timestamp < 0) return [];

    const deliveryKey = `${input.environment}:${input.id}`;
    const now = this.now();
    /*
     * Expiry, enforced on the event path.
     *
     * `expireStale` used to run only when a tracker was created, despite
     * documenting that it runs "on every event". A tracker past its TTL
     * therefore stayed ACTIVE in the candidate index and kept evaluating
     * and waking the GOAT indefinitely — a watcher that outlived the thesis
     * it was watching for, which is precisely what a TTL is supposed to
     * prevent. Sweeping the whole registry here would deep-clone every
     * tracker on every quote, so the check is done against the candidates
     * this delivery could actually reach and only those are transitioned.
     */
    const trackers: Tracker[] = [];
    for (const candidate of this.registry.candidates(input.symbol)) {
      const expiresAt = candidate.lifecycle.expiresAt;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.retireExpired(candidate.id, now);
        continue;
      }
      trackers.push(candidate);
    }
    const scoped = trackers
      .filter((tracker) => input.agentId === undefined || tracker.agentId === input.agentId)
      .filter((tracker) => tracker.symbol === undefined || input.symbol === undefined || tracker.symbol === input.symbol)
      .filter((tracker) => tracker.timeframe === undefined || input.timeframe === undefined || tracker.timeframe === input.timeframe)
      .filter((tracker) => !input.trackerId || tracker.id === input.trackerId)
      .sort((left, right) => (right.evaluation.priority ?? 0) - (left.evaluation.priority ?? 0) || left.id.localeCompare(right.id));

    const fired: TrackerEvent[] = [];
    for (const tracker of scoped) {
      const processed = this.processedEvents.get(tracker.id) ?? new Set<string>();
      if (processed.has(deliveryKey)) continue;
      processed.add(deliveryKey);
      if (processed.size > 10_000) processed.clear();
      this.processedEvents.set(tracker.id, processed);
      this.rememberInputId(deliveryKey, input.timestamp);

      const agent = this.resolveAgent(tracker.agentId);
      if (!agent?.agent.enabled || !agent.isRunning || agent.env.mode !== input.environment) continue;
      if (tracker.symbol && !agent.agent.symbols.includes(tracker.symbol)) continue;
      if (input.symbol && !agent.agent.symbols.includes(input.symbol)) continue;
      if ((tracker.kind === 'STOP_APPROACHING' || tracker.kind === 'TARGET_APPROACHING' || tracker.kind === 'POSITION_UPDATE') &&
          input.type !== 'POSITION_OPEN' && input.type !== 'POSITION_UPDATE' && input.type !== 'POSITION_CLOSE') continue;
      if (tracker.kind === 'ORDER_FILLED' && input.type !== 'ORDER_FILLED') continue;

      const evaluationKey = `${input.environment}:${tracker.id}`;
      let evaluator = this.evaluators.get(evaluationKey);
      if (!evaluator) this.evaluators.set(evaluationKey, evaluator = new TrackerEvaluator());

      let reason: string | undefined;
      try {
        const boundedInput = input.state.bars ? { ...input, state: { ...input.state, bars: input.state.bars.slice(-1000) } } : input;
        reason = evaluator.evaluate(tracker, boundedInput);
      } catch (error: unknown) {
        await this.recordError(tracker.agentId, tracker.id, input.timestamp, error);
        continue;
      }
      if (!reason || !this.canReport(tracker, input.timestamp) || this.inFlight.has(evaluationKey)) continue;
      this.inFlight.add(evaluationKey);
      this.markReported(tracker, input.timestamp);

      const event: TrackerEvent = {
        id: `${tracker.id}:${input.id}`,
        trackerId: tracker.id,
        agentId: tracker.agentId,
        kind: tracker.kind,
        eventType: tracker.eventType,
        timestamp: input.timestamp,
        environment: input.environment,
        thesisId: tracker.thesisId,
        goalId: tracker.goalId,
        symbol: tracker.symbol || input.symbol,
        timeframe: tracker.timeframe || input.timeframe,
        reason,
        marketSnapshot: safeSnapshot(input.state, calculateTrackerIndicators(tracker, input)),
        /*
         * The numbers, on the event itself.
         *
         * `observedValues` is what the GOAT copies into its evidence record,
         * and it was never populated: every tracker-derived piece of
         * evidence therefore carried `observed: undefined` while the actual
         * measurements sat unread in `marketSnapshot`. Evidence is "the
         * record of why the agent believes what it believes", so an
         * observation with no observation attached is the evidence system
         * failing at its one job.
         */
        observedValues: observedValuesFor(input.state, calculateTrackerIndicators(tracker, input)),
        sourceEventId: input.sourceEventId || input.id,
        priority: tracker.evaluation.priority ?? 0,
        severity: severityFor(tracker.evaluation.priority),
        tradeId: input.tradeId,
        orderId: input.orderId,
        positionId: input.positionId,
      };

      fired.push(event);
      try {
        await this.timeline.append({
          id: `timeline:${event.id}:tracker`,
          agentId: tracker.agentId,
          timestamp: event.timestamp,
          type: 'TRACKER',
          environment: input.environment,
          trackerId: tracker.id,
          tradeId: input.tradeId,
          orderId: input.orderId,
          positionId: input.positionId,
          correlationId: correlationIdFor(event),
          data: {
            kind: tracker.kind,
            reason,
            symbol: event.symbol,
            timeframe: event.timeframe,
            snapshot: event.marketSnapshot,
          },
        });
        try {
          await this.delivery.wake(event);
        } catch (error: unknown) {
          await this.timeline.append({
            id: `timeline:${event.id}:wake-error`,
            agentId: tracker.agentId,
            timestamp: input.timestamp,
            type: 'ERROR',
            environment: input.environment,
            trackerId: tracker.id,
            correlationId: correlationIdFor(event),
            data: { code: 'AGENT_WAKE_ERROR', message: redactMessage(error) },
          });
          await this.recordError(tracker.agentId, tracker.id, input.timestamp, error);
        } finally {
          this.inFlight.delete(evaluationKey);
        }
      } catch (error: unknown) {
        this.inFlight.delete(evaluationKey);
        await this.recordError(tracker.agentId, tracker.id, input.timestamp, error);
        continue;
      }

      /*
       * The event is only recorded once the audit trail has it. A tracker
       * that produced an observation which nothing can see is a tracker
       * the GOAT cannot be reasoned about, so a failure to record is a
       * failure to report.
       */
      if (!this.ingestEvent(event)) this.forget(tracker.id);
    }
    return fired;
  }

  async tickScheduled(timestamp: number, environment: 'BACKTEST' | 'DEMO'): Promise<TrackerEvent[]> {
    if (!Number.isFinite(timestamp) || timestamp < 0) return [];

    const trackers = this.registry.list()
      .filter((tracker) => tracker.lifecycle.status === 'ACTIVE' && tracker.kind === 'SCHEDULED')
      .sort((left, right) => (right.evaluation.priority ?? 0) - (left.evaluation.priority ?? 0) || left.id.localeCompare(right.id));

    const fired: TrackerEvent[] = [];

    for (const tracker of trackers) {
      const agent = this.resolveAgent(tracker.agentId);
      if (!agent?.agent.enabled || !agent.isRunning || agent.env.mode !== environment) continue;

      const symbols = tracker.symbol ? [tracker.symbol] : agent.agent.symbols;
      // A scheduled tracker runs on its own resolution, which is the point
      // of scheduling it: a 1h review cannot be expressed as a 15m one.
      if (tracker.timeframe) {
        const allowed = agentTimeframes(agent.agent);
        if (allowed.length > 0 && !allowed.includes(tracker.timeframe)) continue;
      }

      for (const symbol of symbols) {
        const input: TrackerInput = {
          id: `scheduled:${tracker.id}:${symbol}:${timestamp}`,
          trackerId: tracker.id,
          type: 'SCHEDULED',
          timestamp,
          environment,
          agentId: agent.agent.id,
          symbol,
          timeframe: tracker.timeframe,
          state: { timestamp, environment, symbol, timeframe: tracker.timeframe },
        };
        fired.push(...await this.process(input));
      }
    }

    return fired;
  }

  async emitSessionBoundaries(input: TrackerInput): Promise<TrackerEvent[]> {
    const session = input.state.session;
    if (!session || input.environment === 'LIVE') return [];
    if (input.timestamp < session.startsAt || input.timestamp > session.endsAt) return [];
    const fired: TrackerEvent[] = [];
    for (const boundary of [{ kind: 'SESSION_START' as const, timestamp: session.startsAt }, { kind: 'SESSION_END' as const, timestamp: session.endsAt }]) {
      if (input.timestamp < boundary.timestamp || input.timestamp > boundary.timestamp + 60_000) continue;
      const trackers = this.registry.list().filter((tracker) => tracker.lifecycle.status === 'ACTIVE' && tracker.kind === boundary.kind &&
        (!tracker.symbol || tracker.symbol === input.symbol) && (!tracker.timeframe || tracker.timeframe === input.timeframe));
      for (const tracker of trackers) {
        const agent = this.resolveAgent(tracker.agentId);
        if (!agent?.isRunning || agent.env.mode !== input.environment) continue;
        const eventInput: TrackerInput = {
          ...input,
          id: `session:${tracker.agentId}:${session.id}:${boundary.kind}:${boundary.timestamp}`,
          agentId: tracker.agentId,
          trackerId: tracker.id,
          type: boundary.kind,
          timestamp: boundary.timestamp,
        };
        fired.push(...await this.process(eventInput));
      }
    }
    return fired;
  }

  async processRiskState(agentId: string, timestamp: number, environment: 'BACKTEST' | 'DEMO', reason: string): Promise<TrackerEvent[]> {
    const agent = this.resolveAgent(agentId);
    if (!agent) return [];
    const fired: TrackerEvent[] = [];
    for (const symbol of agent.agent.symbols) {
      fired.push(...await this.process({
        id: `risk:${agentId}:${symbol}:${timestamp}:${reason}`,
        agentId,
        type: 'RISK_STATE_CHANGED',
        timestamp,
        environment,
        symbol,
        state: { timestamp, environment, symbol, eventData: { reason } },
      }));
    }
    return fired;
  }

  processPositionEvent(
    agentId: string,
    type: 'POSITION_OPEN' | 'POSITION_UPDATE' | 'POSITION_CLOSE',
    position: NonNullable<TrackerInput['state']['positions']>[number],
    timestamp: number,
    environment: 'BACKTEST' | 'DEMO',
    tradeId?: string,
  ): Promise<TrackerEvent[]> {
    if (type === 'POSITION_OPEN') this.agentByPosition.set(position.id, agentId);
    const sourceInputId = `position:${agentId}:${position.id}:${type}:${timestamp}`;
    const priorDuplicate = this.recentInputIds.get(`${environment}:${sourceInputId}`);
    if (priorDuplicate !== undefined && priorDuplicate === timestamp) return Promise.resolve([]);
    return this.withInstrument(agentId, position.symbol, { timestamp, environment, symbol: position.symbol, positions: [position], eventData: { positionId: position.id } })
      .then((state) => this.process({
        id: sourceInputId,
        agentId,
        positionId: position.id,
        tradeId,
        type,
        timestamp,
        environment,
        symbol: position.symbol,
        state,
      }));
  }

  processTradingEvent(event: TradingGOATsEvent, environment: 'BACKTEST' | 'DEMO', timestamp: number): Promise<TrackerEvent[]> {
    const input = inputFromDomainEvent(event, timestamp, this.domainEventSequence++);
    if (!input) return Promise.resolve([]);
    if (event.type === 'AGENT_ORDER_FILLED' && event.data.positionId) this.agentByPosition.set(event.data.positionId, event.data.agentId);
    if (input.positionId) {
      input.agentId = this.agentByPosition.get(input.positionId);
      if (event.type === 'POSITION_CLOSE') this.agentByPosition.delete(input.positionId);
    }
    return this.process({ ...input, environment, state: { ...input.state, environment } });
  }

  async processOrderFill(input: TrackerInput): Promise<TrackerEvent[]> {
    if (input.type !== 'ORDER_FILLED' || input.state.order?.status !== 'FILLED') return [];
    return this.process(input);
  }

  /**
   * Remember a delivery id, keeping the map bounded.
   *
   * `recentInputIds` is written once per tracker per market event and
   * read back only to recognise an immediate re-delivery. It has no
   * eviction of its own, so a GOAT left running over a long session would
   * grow the map without limit -- one entry per tracker per tick, forever.
   * The map is capped the same way `processedEvents` already was.
   *
   * Insertion order is the eviction order, which is safe here because a
   * re-delivery is only ever compared against the most recent ids: an
   * id evicted after this many newer ones cannot be re-delivered.
   */
  private rememberInputId(deliveryKey: string, timestamp: number): void {
    this.recentInputIds.set(deliveryKey, timestamp);
    if (this.recentInputIds.size > MAX_REMEMBERED_INPUT_IDS) {
      const excess = this.recentInputIds.size - MAX_REMEMBERED_INPUT_IDS;
      let removed = 0;
      for (const key of this.recentInputIds.keys()) {
        this.recentInputIds.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }

  /** Release everything remembered about one GOAT's trackers. */
  disposeAgent(agentId: string): void {
    for (const tracker of this.registry.listForAgent(agentId)) this.forget(tracker.id);
    for (const cacheKey of [...this.instrumentCache.keys()]) {
      if (cacheKey.startsWith(`${agentId}:`)) this.instrumentCache.delete(cacheKey);
    }
  }

  // ---------------------------------------------------------------------
  // Registration and lifecycle
  // ---------------------------------------------------------------------

  /**
   * Create a tracker for a thesis and start watching.
   *
   * The id is minted here and nowhere else, and the same id is the
   * registry key, the evaluation-state key and the event's `trackerId`.
   * There is no second name for a tracker, which is what makes an update
   * replace the definition it meant to replace.
   */
  createTracker(thesisId: string, agentId: string, request: TrackerRequest): Tracker {
    const thesis = this.resolveThesis(thesisId);
    if (!thesis) {
      throw new TrackerRuntimeError(`Cannot create a tracker for unknown thesis ${thesisId}.`, 'UNKNOWN_THESIS');
    }

    this.expireStale();
    this.assertCapacity(thesisId, agentId);

    const spec = this.validateRequest(request, agentId);
    const now = this.now();
    const id = this.nextId('trk');

    const tracker = TrackerRegistry.fromRequest({
      id,
      agentId,
      thesisId,
      goalId: thesis.goalId,
      now,
      request: {
        ...spec,
        eventType: request.eventType ?? EVENT_TYPE_FOR_KIND[spec.kind] ?? 'CUSTOM',
        dataRequirements: request.dataRequirements ?? inferDataRequirements(spec),
        expiresAt: request.expiresAt ?? now + this.limits.defaultTtlMs,
      },
    });

    this.registry.register(tracker);
    return tracker;
  }

  /**
   * Replace a tracker's definition in place.
   *
   * In place rather than recreate, because a tracker's identity is its
   * history: the events already attributed to it stay attributed to it.
   */
  updateTracker(trackerId: string, request: Partial<TrackerRequest>): Tracker {
    const tracker = this.requireTracker(trackerId);
    if (tracker.lifecycle.status === 'CANCELLED') {
      throw new TrackerRuntimeError(`Tracker ${trackerId} is cancelled and cannot be updated.`, 'INVALID_TRANSITION');
    }

    const merged = {
      kind: request.kind ?? tracker.kind,
      purpose: request.purpose ?? tracker.purpose,
      symbol: request.symbol ?? tracker.symbol,
      timeframe: request.timeframe ?? tracker.timeframe,
      config: request.config ?? tracker.config,
    } as TrackerRequest;

    const thesis = this.resolveThesis(tracker.thesisId ?? '');
    if (!thesis) {
      throw new TrackerRuntimeError(`Tracker ${trackerId} has no thesis.`, 'UNKNOWN_THESIS');
    }
    const spec = this.validateRequest(merged, tracker.agentId);

    const updated: Tracker = {
      ...tracker,
      purpose: merged.purpose,
      kind: spec.kind,
      symbol: spec.symbol,
      timeframe: spec.timeframe,
      config: spec.config,
      eventType: request.eventType ?? tracker.eventType,
      dependencies: request.dependencies ?? tracker.dependencies,
      dataRequirements: request.dataRequirements ?? tracker.dataRequirements,
      evaluation: {
        priority: request.priority ?? tracker.evaluation.priority,
        cooldownMs: request.cooldownMs ?? tracker.evaluation.cooldownMs,
        maxEventsPerMinute: request.maxEventsPerMinute ?? tracker.evaluation.maxEventsPerMinute,
      },
      lifecycle: {
        ...tracker.lifecycle,
        status: tracker.lifecycle.status === 'FAILED' ? 'ACTIVE' : tracker.lifecycle.status,
        expiresAt: request.expiresAt ?? tracker.lifecycle.expiresAt,
        failureReason: undefined,
      },
      updatedAt: this.now(),
    };

    return this.registry.update(updated);
  }

  pauseTracker(trackerId: string): Tracker {
    const tracker = this.requireTracker(trackerId);
    if (tracker.lifecycle.status === 'CANCELLED' || tracker.lifecycle.status === 'EXPIRED') {
      throw new TrackerRuntimeError(
        `Tracker ${trackerId} is ${tracker.lifecycle.status.toLowerCase()} and cannot be paused.`,
        'INVALID_TRANSITION',
      );
    }
    return this.setStatus(trackerId, 'PAUSED');
  }

  resumeTracker(trackerId: string): Tracker {
    const tracker = this.requireTracker(trackerId);
    if (tracker.lifecycle.status === 'CANCELLED' || tracker.lifecycle.status === 'EXPIRED') {
      throw new TrackerRuntimeError(
        `Tracker ${trackerId} is ${tracker.lifecycle.status.toLowerCase()} and cannot be resumed.`,
        'INVALID_TRANSITION',
      );
    }
    return this.setStatus(trackerId, 'ACTIVE');
  }

  /**
   * Stop a tracker for good.
   *
   * Cancellation is the thesis giving up on a line of enquiry, so the
   * tracker is retained rather than deleted: "why is GOAT no longer
   * watching this?" is a question the user has to be able to ask.
   */
  cancelTracker(trackerId: string, reason?: string): Tracker {
    const cancelled = this.setStatus(trackerId, 'CANCELLED', reason);
    this.forget(trackerId);
    return cancelled;
  }

  /**
   * Retire trackers whose time is up.
   *
   * Runs before every registration and on every event so a tracker
   * cannot outlive its thesis simply because nothing happened to sweep it.
   */
  expireStale(): Tracker[] {
    const now = this.now();
    const expired: Tracker[] = [];
    for (const tracker of this.registry.list()) {
      const status = tracker.lifecycle.status;
      if (status !== 'ACTIVE' && status !== 'PAUSED') continue;
      const expiresAt = tracker.lifecycle.expiresAt;
      if (expiresAt === undefined || expiresAt > now) continue;
      expired.push(this.retireExpired(tracker.id, now));
    }
    return expired;
  }

  /**
   * Transition one tracker to EXPIRED and drop its evaluation state.
   *
   * Split out of `expireStale` so the event path can expire exactly the
   * tracker it is about to skip, rather than cloning the whole registry to
   * find out what is already known.
   */
  private retireExpired(trackerId: string, now: number): Tracker {
    this.forget(trackerId);
    const current = this.registry.get(trackerId);
    if (!current || (current.lifecycle.status !== 'ACTIVE' && current.lifecycle.status !== 'PAUSED')) {
      return current ?? this.requireTracker(trackerId);
    }
    return this.registry.update({
      ...current,
      lifecycle: { ...current.lifecycle, status: 'EXPIRED' },
      updatedAt: now,
    });
  }

  /** Record an evaluation failure so a broken tracker is visible. */
  markFailed(trackerId: string, reason: string): Tracker {
    const tracker = this.requireTracker(trackerId);
    const failed = this.registry.update({
      ...tracker,
      lifecycle: { ...tracker.lifecycle, status: 'FAILED', failureReason: reason },
      updatedAt: this.now(),
    });
    this.forget(trackerId);
    return failed;
  }

  /**
   * Cancel every tracker belonging to a GOAT.
   *
   * Used when a GOAT stops being deployed: the trackers were watching a
   * market it is no longer pointed at, and leaving them registered would
   * mean a registry holding questions nobody asked any more. They are
   * cancelled rather than removed so "it was watching that, and then it
   * stopped" is still readable.
   */
  cancelTrackersForAgent(agentId: string, reason: string): Tracker[] {
    const cancelled: Tracker[] = [];
    for (const tracker of this.registry.listForAgent(agentId)) {
      if (tracker.lifecycle.status === 'CANCELLED' || tracker.lifecycle.status === 'EXPIRED') continue;
      cancelled.push(this.cancelTracker(tracker.id, reason));
    }
    return cancelled;
  }

  /**
   * Cancel every tracker belonging to a thesis.
   *
   * Used when a thesis is invalidated: leaving its trackers running would
   * mean GOAT keeps collecting evidence for a hypothesis it has already
   * rejected.
   */
  cancelTrackersForThesis(thesisId: string, reason: string): Tracker[] {
    const cancelled: Tracker[] = [];
    for (const tracker of this.registry.listForThesis(thesisId)) {
      if (tracker.lifecycle.status === 'CANCELLED' || tracker.lifecycle.status === 'EXPIRED') continue;
      cancelled.push(this.cancelTracker(tracker.id, reason));
    }
    return cancelled;
  }

  private setStatus(trackerId: string, status: TrackerStatus, reason?: string): Tracker {
    const tracker = this.requireTracker(trackerId);
    return this.registry.update({
      ...tracker,
      lifecycle: {
        ...tracker.lifecycle,
        status,
        failureReason: reason ?? tracker.lifecycle.failureReason,
      },
      updatedAt: this.now(),
    });
  }

  /**
   * Drop everything remembered about a tracker.
   *
   * Called when it stops being watched. Leaving its evaluation state
   * behind would mean a tracker id that is reissued later inherits the
   * previous one's "already reported" memory, which is exactly the class
   * of bug where a fresh tracker is silent for a cooldown.
   */
  private forget(trackerId: string): void {
    this.evaluators.delete(`DEMO:${trackerId}`);
    this.evaluators.delete(`BACKTEST:${trackerId}`);
    this.lastEvent.delete(trackerId);
    this.eventHistory.delete(trackerId);
    this.processedEvents.delete(trackerId);
  }

  private assertCapacity(thesisId: string, agentId: string): void {
    /*
     * Capacity counts what is *being watched*, not what has ever existed.
     *
     * Every count here used to include cancelled and expired trackers.
     * `maxTrackersTotal` in particular counted all of them, and nothing is
     * ever removed from the registry, so a single GOAT that created and
     * abandoned 500 trackers wedged the runtime permanently: creation
     * returned LIMIT_REACHED for the rest of the session with no way to
     * reclaim it. Terminal trackers are retained deliberately — "why is
     * GOAT no longer watching this?" has to stay answerable — but a
     * retained record must not consume a live-watch budget.
     */
    const live = (tracker: Tracker) =>
      tracker.lifecycle.status !== 'CANCELLED' && tracker.lifecycle.status !== 'EXPIRED';
    const all = this.registry.list();
    if (all.filter(live).length >= this.limits.maxTrackersTotal) {
      throw new TrackerRuntimeError(`Global tracker limit reached (${this.limits.maxTrackersTotal}).`, 'LIMIT_REACHED');
    }
    const forThesis = this.listForThesis(thesisId).filter(live).length;
    if (forThesis >= this.limits.maxTrackersPerThesis) {
      throw new TrackerRuntimeError(
        `Thesis ${thesisId} already has ${forThesis} trackers (limit ${this.limits.maxTrackersPerThesis}).`,
        'LIMIT_REACHED',
      );
    }
    const forAgent = this.listForAgent(agentId).filter(live).length;
    if (forAgent >= this.limits.maxTrackersPerAgent) {
      throw new TrackerRuntimeError(
        `Agent ${agentId} already has ${forAgent} trackers (limit ${this.limits.maxTrackersPerAgent}).`,
        'LIMIT_REACHED',
      );
    }
  }

  /**
   * Validate a request before it becomes a tracker.
   *
   * The registry validates the *configuration*; this validates
   * ownership, scope and shape. Both run, because they check different
   * things and a tracker that satisfied only one of them would still be
   * wrong in the other's terms.
   */
  private validateRequest(request: TrackerRequest, agentId: string): TrackerRequest {
    if (!request || typeof request !== 'object') {
      throw new TrackerRuntimeError('A tracker request must be an object.', 'INVALID_SPEC');
    }
    if (typeof request.purpose !== 'string' || request.purpose.trim().length === 0) {
      throw new TrackerRuntimeError('A tracker must state what it is waiting for.', 'INVALID_SPEC');
    }
    if (!TRACKER_KINDS.has(request.kind)) {
      throw new TrackerRuntimeError(`Unsupported tracker kind "${String(request.kind)}".`, 'INVALID_SPEC');
    }
    if (!request.config || typeof request.config !== 'object' || Array.isArray(request.config)) {
      throw new TrackerRuntimeError('A tracker must carry a configuration object.', 'INVALID_SPEC');
    }
    if (request.cooldownMs !== undefined && (!Number.isFinite(request.cooldownMs) || request.cooldownMs < 0)) {
      throw new TrackerRuntimeError('A tracker cooldown must be a non-negative number.', 'INVALID_SPEC');
    }
    if (request.priority !== undefined && !Number.isFinite(request.priority)) {
      throw new TrackerRuntimeError('A tracker priority must be a finite number.', 'INVALID_SPEC');
    }
    if (request.maxEventsPerMinute !== undefined && (!Number.isInteger(request.maxEventsPerMinute) || request.maxEventsPerMinute < 1)) {
      throw new TrackerRuntimeError('A tracker event limit must be a positive whole number.', 'INVALID_SPEC');
    }
    if (request.dependencies && !request.dependencies.every((id) => typeof id === 'string')) {
      throw new TrackerRuntimeError('Tracker dependencies must be tracker ids.', 'INVALID_SPEC');
    }
    if (request.dataRequirements && !request.dataRequirements.every(isDataRequirement)) {
      throw new TrackerRuntimeError('Tracker data requirements must be declared capabilities.', 'INVALID_SPEC');
    }

    /*
     * Symbol scope.
     *
     * A tracker may not observe a market its GOAT is not allowed to trade.
     * Monitoring something you cannot act on burns the wake budget for a
     * decision that can never be taken, and the registry rejects it
     * anyway. When the request omits a symbol the tracker inherits the
     * agent's single deployed market, which is the normal case.
     */
    const agent = this.agentScope(agentId);
    if (request.symbol) {
      if (agent && agent.symbols.length > 0 && !agent.symbols.includes(request.symbol)) {
        throw new TrackerRuntimeError(
          `Tracker symbol ${request.symbol} is outside the agent's market scope.`,
          'INVALID_SPEC',
        );
      }
    }

    return {
      ...request,
      symbol: request.symbol ?? (agent?.symbols.length === 1 ? agent.symbols[0] : undefined),
      config: { ...request.config },
    };
  }

  private agentScope(agentId: string): TrackerAgentScope | undefined {
    const instance = this.resolveAgent(agentId);
    if (!instance) return undefined;
    return { symbols: [...instance.agent.symbols], timeframe: instance.agent.timeframe };
  }

  private resolveThesis(thesisId: string): TrackerThesisView | undefined {
    return this.domain?.resolveThesis(thesisId);
  }

  // ---------------------------------------------------------------------
  // Events and wakes
  // ---------------------------------------------------------------------

  /**
   * Record an observation and wake whoever asked for it.
   *
   * This is the seam between "something was observed" and "the GOAT
   * should think". The event carries no direction and no action: it is a
   * fact, and the GOAT decides what it means.
   *
   * Ownership fields are filled from the registry rather than trusted
   * from the event, so a caller cannot attribute an observation to a
   * tracker, a GOAT, or a thesis it does not belong to.
   */
  ingestEvent(event: TrackerEvent): TrackerEvent | undefined {
    const tracker = this.registry.get(event.trackerId);
    if (!tracker) return undefined;
    // A paused or cancelled tracker must not produce evidence, even if
    // an in-flight evaluation was already past the registry's check.
    if (tracker.lifecycle.status !== 'ACTIVE') return undefined;

    const owned: TrackerEvent = {
      ...event,
      trackerId: tracker.id,
      agentId: tracker.agentId,
      kind: tracker.kind,
      eventType: event.eventType ?? tracker.eventType,
      thesisId: tracker.thesisId,
      goalId: tracker.goalId,
      // The tracker's own scope wins over the claim. An unscoped tracker
      // takes the market it was actually given, because that is the only
      // honest answer for a tracker watching several markets at once.
      symbol: tracker.symbol ?? event.symbol,
      timeframe: tracker.timeframe ?? event.timeframe,
      priority: event.priority ?? tracker.evaluation.priority,
      // The runtime owns the envelope. Severity is a function of the
      // tracker's own priority, so a caller cannot hand a GOAT an
      // observation that reads as more important than it is.
      severity: severityFor(tracker.evaluation.priority),
    };

    this.recordEvent(tracker, owned);
    this.recordWake(tracker, owned);
    return owned;
  }

  private recordEvent(tracker: Tracker, event: TrackerEvent): void {
    const list = this.eventsByTracker.get(tracker.id) ?? [];
    list.push(event);
    if (list.length > this.limits.maxEventsPerTracker) {
      list.splice(0, list.length - this.limits.maxEventsPerTracker);
    }
    this.eventsByTracker.set(tracker.id, list);

    this.allEvents.push(event);
    if (this.allEvents.length > this.limits.maxEventsPerTracker * 10) {
      this.allEvents.splice(0, this.allEvents.length - this.limits.maxEventsPerTracker * 10);
    }

    this.registry.update({
      ...tracker,
      lifecycle: {
        ...tracker.lifecycle,
        lastEventAt: event.timestamp,
        lastEvaluatedAt: event.timestamp,
        eventCount: tracker.lifecycle.eventCount + 1,
      },
      updatedAt: this.now(),
    });
  }

  private recordWake(tracker: Tracker, event: TrackerEvent): void {
    /*
     * A tracker with no thesis is a bare engine-level observation: it is
     * still recorded and still delivered, but there is no hypothesis for
     * it to be evidence about, so there is nothing to wake.
     */
    if (!tracker.thesisId) return;
    const thesis = this.resolveThesis(tracker.thesisId);
    if (!thesis) {
      /*
       * No thesis means there is nothing to evaluate the evidence
       * against. Cancelling the tracker is the right response, not a wake
       * with an empty hypothesis.
       */
      this.cancelTrackersForThesis(tracker.thesisId, 'Thesis no longer exists.');
      return;
    }

    const request: TrackerWakeRequest = {
      thesisId: thesis.id,
      goalId: tracker.goalId ?? thesis.goalId,
      agentId: tracker.agentId,
      event,
      thesis,
      relatedEvents: this.listEventsForTracker(tracker.id).slice(-9),
      skillIds: this.domain?.resolveSkillIds(tracker.agentId) ?? [],
      createdAt: this.now(),
    };

    this.wakeRequests.push(request);
    if (this.wakeRequests.length > MAX_RETAINED_WAKE_REQUESTS) {
      this.wakeRequests.splice(0, this.wakeRequests.length - MAX_RETAINED_WAKE_REQUESTS);
    }

    if (this.domain?.onEvent) {
      void this.domain.onEvent(event);
    }
  }

  /** The most recent wake request, for a deterministic test to await. */
  latestWakeRequest(): TrackerWakeRequest | undefined {
    return this.wakeRequests.at(-1);
  }

  /**
   * The wake request for one specific event.
   *
   * Delivery is asynchronous: a request is queued before its event is
   * announced, but the handler that reacts to the announcement runs later
   * and can find a *newer* request already queued by a second tracker.
   * Reading only the newest request therefore dropped every wake that lost
   * that race — two trackers firing in the same delivery meant one GOAT
   * wake, silently, with the event recorded and nothing reasoning about it.
   */
  wakeRequestForEvent(eventId: string): TrackerWakeRequest | undefined {
    for (let index = this.wakeRequests.length - 1; index >= 0; index -= 1) {
      if (this.wakeRequests[index].event.id === eventId) return this.wakeRequests[index];
    }
    return undefined;
  }

  listWakeRequests(): TrackerWakeRequest[] {
    return [...this.wakeRequests];
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  get(trackerId: string): Tracker | undefined {
    return this.registry.get(trackerId);
  }

  list(): Tracker[] {
    return this.registry.list();
  }

  listForAgent(agentId: string): Tracker[] {
    return this.registry.listForAgent(agentId);
  }

  listForThesis(thesisId: string): Tracker[] {
    return this.registry.listForThesis(thesisId);
  }

  listForGoal(goalId: string): Tracker[] {
    return this.list().filter((t) => t.goalId === goalId);
  }

  /** Only the trackers actually watching, for the "GOAT is watching" view. */
  listWatching(goalId: string): Tracker[] {
    return this.listForGoal(goalId)
      .filter((t) => t.lifecycle.status === 'ACTIVE')
      .sort((a, b) => b.evaluation.priority - a.evaluation.priority || a.createdAt - b.createdAt);
  }

  listEventsForTracker(trackerId: string): TrackerEvent[] {
    return [...(this.eventsByTracker.get(trackerId) ?? [])];
  }

  listEventsForThesis(thesisId: string): TrackerEvent[] {
    return this.allEvents.filter((e) => e.thesisId === thesisId);
  }

  listEvents(): TrackerEvent[] {
    return [...this.allEvents];
  }

  private requireTracker(trackerId: string): Tracker {
    const tracker = this.registry.get(trackerId);
    if (!tracker) {
      throw new TrackerRuntimeError(`Unknown tracker ${trackerId}.`, 'UNKNOWN_TRACKER');
    }
    return tracker;
  }

  // ---------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------

  private canReport(tracker: Tracker, timestamp: number): boolean {
    const last = this.lastEvent.get(tracker.id);
    /*
     * Out of order, not a new clock.
     *
     * This used to delete the cooldown and the whole 60-second window
     * whenever a delivery arrived stamped before the last one, so a single
     * out-of-order or backdated candle re-armed the tracker completely:
     * unlimited events, no cooldown, no rate limit. A regressed timestamp
     * is evidence the feed is late, not that the tracker has been quiet,
     * so the delivery is refused and the state is left intact.
     */
    if (last !== undefined && timestamp < last) return false;
    const cooldownMs = tracker.evaluation.cooldownMs ?? 1_000;
    if (last !== undefined && timestamp - last < cooldownMs) return false;
    const max = tracker.evaluation.maxEventsPerMinute ?? 10;
    const times = (this.eventHistory.get(tracker.id) || []).filter((record) => timestamp >= record.timestamp && timestamp - record.timestamp < 60_000);
    this.eventHistory.set(tracker.id, times);
    return times.length < max;
  }

  private markReported(tracker: Tracker, timestamp: number): void {
    this.lastEvent.set(tracker.id, timestamp);
    const times = this.eventHistory.get(tracker.id) || [];
    for (let index = times.length - 1; index >= 0; index -= 1) {
      if (timestamp - times[index].timestamp >= 60_000 || timestamp < times[index].timestamp) times.splice(index, 1);
    }
    times.push({ timestamp });
    this.eventHistory.set(tracker.id, times);
  }

  // ---------------------------------------------------------------------
  // Instrument metadata
  // ---------------------------------------------------------------------

  /**
   * Resolve canonical instrument metadata from the owning agent's
   * environment and attach it to a tracker input state.
   *
   * Metadata is what lets the evaluator measure pip, tick, multiplier and
   * quote-currency facts without guessing them from a symbol name. It is
   * resolved once per agent+symbol and cached; a market that publishes no
   * usable price still resolves, it simply stays unavailable upstream.
   */
  private async withInstrument(
    agentId: string | undefined,
    symbol: string,
    state: TrackerInput['state'],
  ): Promise<TrackerInput['state']> {
    if (!agentId) return state;
    const cacheKey = `${agentId}:${symbol}`;
    let pending = this.instrumentCache.get(cacheKey);
    if (!pending) {
      pending = this.resolveInstrument(agentId, symbol);
      this.instrumentCache.set(cacheKey, pending);
    }
    const instrument = await pending;
    return instrument ? { ...state, instrument } : state;
  }

  private async resolveInstrument(agentId: string, symbol: string): Promise<InstrumentMetadata | undefined> {
    const env: ITradingEnvironment | undefined = this.resolveAgent(agentId)?.env;
    if (!env?.getInstruments) return undefined;
    try {
      const instruments = await env.getInstruments();
      if (!Array.isArray(instruments)) return undefined;
      return instruments.find((candidate) =>
        candidate.symbol === symbol ||
        candidate.providerSymbol === symbol ||
        candidate.displayName === symbol,
      );
    } catch {
      return undefined;
    }
  }

  private async recordError(agentId: string, trackerId: string, timestamp: number, error: unknown): Promise<void> {
    const message = redactMessage(error);
    try {
      await this.timeline.append({
        id: `tracker-error:${trackerId}:${timestamp}`,
        agentId,
        timestamp,
        trackerId,
        type: 'ERROR',
        data: { code: 'TRACKER_ERROR', message },
      });
    } catch {
      return;
    }
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function severityFor(priority: number): TrackerEventSeverity {
  if (priority >= 100) return 'DECISIVE';
  if (priority >= 50) return 'SIGNIFICANT';
  if (priority >= 10) return 'NOTABLE';
  return 'INFO';
}

function correlationIdFor(event: TrackerEvent): string {
  if (event.tradeId) return `${event.agentId}:trade:${event.tradeId}`;
  if (event.positionId) return `${event.agentId}:position:${event.positionId}`;
  return `${event.agentId}:${event.trackerId}:${event.timestamp}`;
}

/**
 * Infer what a tracker needs from market data.
 *
 * Declared rather than measured, so a tracker that cannot be evaluated
 * says so before it is deployed instead of failing silently at 3am.
 */
function inferDataRequirements(spec: TrackerRequest): TrackerDataRequirement[] {
  const requirements: TrackerDataRequirement[] = [{ kind: 'QUOTE' }];
  const config = spec.config ?? {};

  if (spec.kind === 'NEW_BAR' || spec.kind === 'PRICE_CROSS' || spec.kind === 'BREAKOUT') {
    requirements.push({ kind: 'BARS', timeframe: spec.timeframe, barCount: 100 });
  }
  if (spec.kind === 'INDICATOR_CROSS' || spec.kind === 'VOLATILITY_CHANGE') {
    requirements.push({ kind: 'BARS', timeframe: spec.timeframe, barCount: 200 });
    requirements.push({ kind: 'INDICATOR', timeframe: spec.timeframe, detail: String(config.indicator ?? 'mixed') });
  }
  if (spec.kind === 'BREAKOUT') {
    requirements.push({ kind: 'STRUCTURE', timeframe: spec.timeframe, detail: 'swing' });
  }
  return requirements;
}

function wakeType(kind: TrackerKind): AgentWakeEvent['type'] {
  switch (kind) {
    case 'NEW_BAR': return 'NEW_BAR';
    case 'PRICE_CROSS': case 'PRICE_THRESHOLD': return 'PRICE_THRESHOLD';
    case 'POSITION_OPEN': return 'POSITION_OPENED';
    case 'STOP_APPROACHING': return 'POSITION_APPROACHING_STOP';
    case 'TARGET_APPROACHING': return 'POSITION_REACHED_PROFIT_TARGET';
    case 'ORDER_FILLED': return 'ORDER_FILLED';
    case 'SPREAD_CHANGE': return 'SPREAD_CHANGED';
    case 'SESSION_START': case 'SESSION_END': return 'SESSION_CHANGED';
    case 'RISK_STATE_CHANGED': return 'RISK_STATE_CHANGED';
    case 'SCHEDULED': return 'TIMER_TICK';
    default: return 'TRACKER_OBSERVED';
  }
}

function inputFromDomainEvent(event: TradingGOATsEvent, now: number, sequence: number): TrackerInput | undefined {
  if (event.type === 'MARKET_QUOTE') return {
    id: `quote:${event.data.symbol}:${event.data.timestamp}`, type: 'MARKET_QUOTE', timestamp: event.data.timestamp,
    environment: 'DEMO', symbol: event.data.symbol, state: { timestamp: event.data.timestamp, environment: 'DEMO', symbol: event.data.symbol,
      price: (event.data.bid + event.data.ask) / 2, spread: event.data.spread },
  };
  if (event.type === 'BAR_UPDATE') return {
    id: `bar:${event.symbol}:${event.timeframe || ''}:${event.bar.time}:${sequence}`, type: 'BAR_UPDATE', timestamp: event.bar.time * 1000,
    environment: 'DEMO', symbol: event.symbol, timeframe: event.timeframe, state: { timestamp: event.bar.time * 1000, environment: 'DEMO', symbol: event.symbol, timeframe: event.timeframe,
      price: event.bar.close, bars: [{ time: event.bar.time, open: event.bar.open, high: event.bar.high, low: event.bar.low, close: event.bar.close }], eventData: { isClosed: event.isClosed } },
  };
  if (event.type === 'AGENT_ORDER_FILLED') {
    const symbol = event.data.symbol;
    if (!symbol) return undefined;
    return {
      id: `agent-order-filled:${event.data.agentId}:${event.data.orderId || event.data.timestamp}`,
      agentId: event.data.agentId,
      orderId: event.data.orderId,
      positionId: event.data.positionId,
      type: 'ORDER_FILLED',
      timestamp: event.data.timestamp,
      environment: 'DEMO',
      symbol,
      state: { timestamp: event.data.timestamp, environment: 'DEMO', symbol, order: { status: 'FILLED', orderId: event.data.orderId, positionId: event.data.positionId, symbol } },
    };
  }

  return undefined;
}

export function trackerInputFromEvent(event: TradingGOATsEvent, environment: 'BACKTEST' | 'DEMO', timestamp: number): TrackerInput | undefined {
  const input = inputFromDomainEvent(event, timestamp, 0);
  if (!input) return undefined;
  return { ...input, environment, state: { ...input.state, environment } };
}

/**
 * The finite numbers behind one observation.
 *
 * Deliberately small: symbol, timeframe, price, spread and whichever
 * indicators the tracker actually configured. Only finite values, because
 * `Evidence.observed` is numbers a person is meant to check the agent's
 * claim against, and `NaN` is not that.
 */
function observedValuesFor(
  state: TrackerInput['state'],
  calculatedIndicators: Record<string, number>,
): Record<string, number | string> {
  const observed: Record<string, number | string> = { symbol: state.symbol };
  if (typeof state.timeframe === 'string') observed.timeframe = state.timeframe;
  if (typeof state.price === 'number' && Number.isFinite(state.price)) observed.price = state.price;
  if (typeof state.spread === 'number' && Number.isFinite(state.spread)) observed.spread = state.spread;
  for (const [key, value] of Object.entries({ ...state.indicators, ...calculatedIndicators })) {
    if (typeof value === 'number' && Number.isFinite(value)) observed[key] = value;
  }
  return observed;
}

function safeSnapshot(state: TrackerInput['state'], calculatedIndicators: Record<string, number>): unknown {
  return {
    symbol: state.symbol,
    timeframe: state.timeframe,
    price: state.price,
    spread: state.spread,
    bars: state.bars?.slice(-50),
    indicators: { ...state.indicators, ...calculatedIndicators },
    session: state.session,
    instrument: state.instrument ? {
      symbol: state.instrument.symbol,
      assetClass: state.instrument.assetClass,
      providerSymbol: state.instrument.providerSymbol,
      quoteCurrency: state.instrument.quoteCurrency,
      tickSize: state.instrument.tickSize,
      pipSize: state.instrument.pipSize,
      contractMultiplier: state.instrument.contractMultiplier,
    } : undefined,
  };
}

function redactMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
}
