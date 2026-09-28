import { eventBus, TradeCodeEvent } from '../../../types/events';
import { AgentRuntime } from '../runtime';
import { AgentWakeEvent } from '../types';
import { AgentTimelineStore } from '../timeline/types';
import { calculateTriggerIndicators, evaluateTrigger, newEvaluationState } from './evaluator';
import { AgentTrigger, AgentTriggerEvent, TriggerDelivery, TriggerInput } from './types';
import { TriggerRegistry } from './registry';

interface Firing { timestamp: number; }

export class TriggerEngine {
  dispose() {
    throw new Error('Method not implemented.');
  }
  private readonly evaluationStates = new Map<string, ReturnType<typeof newEvaluationState>>();
  private readonly lastFired = new Map<string, number>();
  private readonly firingHistory = new Map<string, Firing[]>();
  private readonly inFlightTriggers = new Set<string>();
  private unsubscribe?: () => void;
  private readonly delivery: TriggerDelivery;
  private sourceEnvironment?: 'BACKTEST' | 'DEMO';
  private readonly resolveAgent: TriggerRegistry['getAgent'];
  private readonly agentByPosition = new Map<string, string>();
  private readonly recentInputIds = new Map<string, number>();
  private readonly processedEvents = new Map<string, Set<string>>();
  private domainEventSequence = 0;

  constructor(
    private readonly registry: TriggerRegistry,
    private readonly runtime: AgentRuntime,
    private readonly timeline: AgentTimelineStore,
    private readonly clock: () => number = Date.now
  ) {
    this.resolveAgent = (agentId) => this.registry.getAgent(agentId);
    this.delivery = {
      wake: async (event) => {
        const wakeEvent: AgentWakeEvent = {
          type: wakeType(event.type), symbol: event.symbol, timestamp: event.timestamp,
          data: { triggerId: event.triggerId, triggerType: event.type, reason: event.reason, sourceEventId: event.sourceEventId,
            correlationId: event.tradeId ? `${event.agentId}:trade:${event.tradeId}` : event.positionId ? `${event.agentId}:position:${event.positionId}` : `${event.agentId}:${event.triggerId}:${event.timestamp}` },
        };
        if (this.runtime.getAgent(event.agentId)?.isRunning) await this.runtime.handleEvent(event.agentId, wakeEvent);
      },
    };
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.onAll((event) => {
      if (!this.sourceEnvironment) return;
      if (event.type === 'MARKET_QUOTE') {
        for (const instance of this.runtime.listAgents()) {
          if (instance.isRunning && instance.env.mode === this.sourceEnvironment && instance.agent.symbols.includes(event.data.symbol)) {
            const quoteEvent: TriggerInput = { id: `quote:${event.data.symbol}:${event.data.timestamp}`, type: 'MARKET_QUOTE', timestamp: event.data.timestamp,
              environment: this.sourceEnvironment, symbol: event.data.symbol, timeframe: instance.agent.timeframe,
              state: { timestamp: event.data.timestamp, environment: this.sourceEnvironment, symbol: event.data.symbol, timeframe: instance.agent.timeframe,
                price: (event.data.bid + event.data.ask) / 2, spread: event.data.spread } };
            void this.process(quoteEvent).catch((error: unknown) => this.recordError(instance.agent.id, 'quote-event', quoteEvent.timestamp, error));
          }
        }
        return;
      }
      const input = inputFromDomainEvent(event, this.clock(), this.domainEventSequence++);
      if (input) {
        void this.dispatchMarketInput(input).catch((error: unknown) => this.recordError('trigger-engine', 'event-dispatch', input.timestamp, error));
      }
    });
  }

  private async dispatchMarketInput(input: TriggerInput): Promise<void> {
    if (!input.symbol || !this.sourceEnvironment) return;
    const activeAgents = this.runtime.listAgents().filter((instance) => instance.isRunning &&
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
          const agentInput = { ...input, id: `${input.id}:${instance.agent.id}`, agentId: instance.agent.id, timeframe, environment: this.sourceEnvironment, state };
      void this.process(agentInput).catch((error: unknown) => this.recordError(instance.agent.id, 'event-dispatch', input.timestamp, error));
    }
  }

  setEnvironment(environment: 'BACKTEST' | 'DEMO'): void { this.sourceEnvironment = environment; }

  ingest(event: TradeCodeEvent, environment: 'BACKTEST' | 'DEMO'): Promise<AgentTriggerEvent[]> {
    const input = inputFromDomainEvent(event, this.clock(), this.domainEventSequence++);
    if (!input) return Promise.resolve([]);
    return this.process({ ...input, environment, state: { ...input.state, environment } });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async process(input: TriggerInput): Promise<AgentTriggerEvent[]> {
    if (input.type === 'CUSTOM') {
      await this.recordError('trigger-engine', input.triggerId || 'custom', input.timestamp, new Error('Custom trigger input is disabled until an application event source is registered.'));
      return [];
    }
    if (input.state.environment !== input.environment || !Number.isFinite(input.timestamp) || !input.id || typeof input.state.symbol !== 'string' ||
      input.symbol !== undefined && input.symbol !== input.state.symbol) return [];
    if (input.environment === 'LIVE' || input.environment !== 'BACKTEST' && input.environment !== 'DEMO') return [];
    if (input.timestamp < 0) return [];
    const deliveryKey = `${input.environment}:${input.id}`;
    const triggers = this.registry.candidates(input.symbol)
      .filter((trigger) => input.agentId === undefined || trigger.agentId === input.agentId)
      .filter((trigger) => trigger.enabled && (trigger.symbol === undefined || input.symbol === undefined || trigger.symbol === input.symbol))
      .filter((trigger) => trigger.timeframe === undefined || input.timeframe === undefined || trigger.timeframe === input.timeframe)
      .filter((trigger) => !input.triggerId || trigger.id === input.triggerId)
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
    const fired: AgentTriggerEvent[] = [];
    for (const trigger of triggers) {
      const processed = this.processedEvents.get(trigger.id) ?? new Set<string>();
      if (processed.has(deliveryKey)) continue;
      processed.add(deliveryKey);
      if (processed.size > 10_000) processed.clear();
      this.processedEvents.set(trigger.id, processed);
      this.recentInputIds.set(deliveryKey, input.timestamp);
      const agent = this.resolveAgent(trigger.agentId);
      if (!agent?.agent.enabled || !agent.isRunning || agent.env.mode !== input.environment) continue;
      if (trigger.symbol && !agent.agent.symbols.includes(trigger.symbol)) continue;
      if (input.symbol && !agent.agent.symbols.includes(input.symbol)) continue;
      if ((trigger.type === 'STOP_APPROACHING' || trigger.type === 'TARGET_APPROACHING' || trigger.type === 'POSITION_UPDATE') &&
          input.type !== 'POSITION_OPEN' && input.type !== 'POSITION_UPDATE' && input.type !== 'POSITION_CLOSE') continue;
      if (trigger.type === 'ORDER_FILLED' && input.type !== 'ORDER_FILLED') continue;
      const evaluationKey = `${input.environment}:${trigger.id}`;
      let evaluationState = this.evaluationStates.get(evaluationKey);
      if (!evaluationState) this.evaluationStates.set(evaluationKey, evaluationState = newEvaluationState());
      let reason: string | undefined;
      try {
        const boundedInput = input.state.bars ? { ...input, state: { ...input.state, bars: input.state.bars.slice(-1000) } } : input;
        reason = evaluateTrigger(trigger, boundedInput, evaluationState);
      }
      catch (error: unknown) { await this.recordError(trigger.agentId, trigger.id, input.timestamp, error); continue; }
      if (!reason || !this.canFire(trigger, input.timestamp) || this.inFlightTriggers.has(evaluationKey)) continue;
      this.inFlightTriggers.add(evaluationKey);
      this.markFired(trigger, input.timestamp);

      const triggerEvent: AgentTriggerEvent = {
        id: `${trigger.id}:${input.id}`,
        triggerId: trigger.id,
        agentId: trigger.agentId,
        type: trigger.type,
        timestamp: input.timestamp,
        environment: input.environment,
        symbol: trigger.symbol || input.symbol,
        timeframe: trigger.timeframe || input.timeframe,
        reason,
        marketSnapshot: safeSnapshot(input.state, calculateTriggerIndicators(trigger, input)),
        sourceEventId: input.sourceEventId || input.id,
        priority: trigger.priority ?? 0,
        tradeId: input.tradeId,
        orderId: input.orderId,
        positionId: input.positionId,
      };
      fired.push(triggerEvent);
      try {
      await this.timeline.append({
        id: `timeline:${triggerEvent.id}:trigger`, agentId: trigger.agentId, timestamp: triggerEvent.timestamp,
        type: 'TRIGGER', environment: input.environment, triggerId: trigger.id, tradeId: input.tradeId,
        orderId: input.orderId, positionId: input.positionId,
        correlationId: typeof input.state.eventData === 'object' && input.state.eventData !== null && 'correlationId' in input.state.eventData
          ? String((input.state.eventData as { correlationId: unknown }).correlationId)
          : input.tradeId ? `${trigger.agentId}:trade:${input.tradeId}` : input.positionId ? `${trigger.agentId}:position:${input.positionId}`
            : `${trigger.agentId}:${trigger.id}:${input.timestamp}`,
        data: { type: trigger.type, reason, symbol: triggerEvent.symbol, timeframe: triggerEvent.timeframe, snapshot: triggerEvent.marketSnapshot },
      });
      try {
        await this.delivery.wake(triggerEvent);
      } catch (error: unknown) {
        await this.timeline.append({ id: `timeline:${triggerEvent.id}:wake-error`, agentId: trigger.agentId, timestamp: input.timestamp,
          type: 'ERROR', environment: input.environment, triggerId: trigger.id, correlationId: `${trigger.agentId}:${trigger.id}:${input.timestamp}`,
          data: { code: 'AGENT_WAKE_ERROR', message: redactMessage(error) } });
        await this.recordError(trigger.agentId, trigger.id, input.timestamp, error);
      } finally {
        this.inFlightTriggers.delete(evaluationKey);
      }
      } catch (error: unknown) {
        this.inFlightTriggers.delete(evaluationKey);
        await this.recordError(trigger.agentId, trigger.id, input.timestamp, error);
      }
    }
    return fired;
  }

  async tickScheduled(timestamp: number, environment: 'BACKTEST' | 'DEMO'): Promise<AgentTriggerEvent[]> {
    if (!Number.isFinite(timestamp) || timestamp < 0) return [];

    const triggers = this.registry.list()
      .filter((trigger) => trigger.enabled && trigger.type === 'SCHEDULED')
      .sort(
        (left, right) =>
          (right.priority ?? 0) - (left.priority ?? 0) ||
          left.id.localeCompare(right.id),
      );

    const fired: AgentTriggerEvent[] = [];

    for (const trigger of triggers) {
      const agent = this.resolveAgent(trigger.agentId);

      if (!agent?.agent.enabled || !agent.isRunning || agent.env.mode !== environment) {
        continue;
      }

      const symbols = trigger.symbol ? [trigger.symbol] : agent.agent.symbols;

      if (trigger.timeframe && agent.agent.timeframe !== trigger.timeframe) {
        continue;
      }

      for (const symbol of symbols) {
        const input: TriggerInput = {
          id: `scheduled:${trigger.id}:${symbol}:${timestamp}`,
          triggerId: trigger.id,
          type: 'SCHEDULED',
          timestamp,
          environment,
          agentId: agent.agent.id,
          symbol,
          timeframe: trigger.timeframe,
          state: {
            timestamp,
            environment,
            symbol,
            timeframe: trigger.timeframe,
          },
        };
        fired.push(...await this.process(input));
      }
    }

    return fired;
  }

  async emitSessionBoundaries(input: TriggerInput): Promise<AgentTriggerEvent[]> {
    const session = input.state.session;
    if (!session || input.environment === 'LIVE') return [];
    if (input.timestamp < session.startsAt || input.timestamp > session.endsAt) return [];
    const fired: AgentTriggerEvent[] = [];
    for (const boundary of [{ type: 'SESSION_START' as const, timestamp: session.startsAt }, { type: 'SESSION_END' as const, timestamp: session.endsAt }]) {
      if (input.timestamp < boundary.timestamp || input.timestamp > boundary.timestamp + 60_000) continue;
      const triggers = this.registry.list().filter((trigger) => trigger.enabled && trigger.type === boundary.type &&
        (!trigger.symbol || trigger.symbol === input.symbol) && (!trigger.timeframe || trigger.timeframe === input.timeframe));
      for (const trigger of triggers) {
        const agent = this.resolveAgent(trigger.agentId);
        if (!agent?.isRunning || agent.env.mode !== input.environment) continue;
        const eventInput: TriggerInput = { ...input, id: `session:${trigger.agentId}:${session.id}:${boundary.type}:${boundary.timestamp}`,
          agentId: trigger.agentId, triggerId: trigger.id, type: boundary.type, timestamp: boundary.timestamp };
        fired.push(...await this.process(eventInput));
      }
    }
    return fired;
  }

  async processRiskState(agentId: string, timestamp: number, environment: 'BACKTEST' | 'DEMO', reason: string): Promise<AgentTriggerEvent[]> {
    const agent = this.resolveAgent(agentId);
    if (!agent) return [];
    const fired: AgentTriggerEvent[] = [];
    for (const symbol of agent.agent.symbols) fired.push(...await this.process({ id: `risk:${agentId}:${symbol}:${timestamp}:${reason}`, agentId,
      type: 'RISK_STATE_CHANGED', timestamp, environment, symbol, state: { timestamp, environment, symbol, eventData: { reason } } }));
    return fired;
  }

  disposeAgent(agentId: string): void {
    for (const trigger of this.registry.listForAgent(agentId)) {
      this.evaluationStates.delete(`DEMO:${trigger.id}`);
      this.evaluationStates.delete(`BACKTEST:${trigger.id}`);
      this.lastFired.delete(trigger.id);
      this.firingHistory.delete(trigger.id);
    }
  }

  processPositionEvent(agentId: string, type: 'POSITION_OPEN' | 'POSITION_UPDATE' | 'POSITION_CLOSE', position: NonNullable<TriggerInput['state']['positions']>[number], timestamp: number, environment: 'BACKTEST' | 'DEMO', tradeId?: string): Promise<AgentTriggerEvent[]> {
    if (type === 'POSITION_OPEN') this.agentByPosition.set(position.id, agentId);
    const sourceInputId = `position:${agentId}:${position.id}:${type}:${timestamp}`;
    const priorDuplicate = this.recentInputIds.get(`${environment}:${sourceInputId}`);
    if (priorDuplicate !== undefined && priorDuplicate === timestamp) return Promise.resolve([]);
    return this.process({ id: sourceInputId, agentId, positionId: position.id, tradeId, type, timestamp, environment, symbol: position.symbol,
      state: { timestamp, environment, symbol: position.symbol, positions: [position], eventData: { positionId: position.id } } });
  }

  processTradingEvent(event: TradeCodeEvent, environment: 'BACKTEST' | 'DEMO', timestamp: number): Promise<AgentTriggerEvent[]> {
    const input = inputFromDomainEvent(event, timestamp, this.domainEventSequence++);
    if (!input) return Promise.resolve([]);
    if (event.type === 'AGENT_ORDER_FILLED' && event.data.positionId) this.agentByPosition.set(event.data.positionId, event.data.agentId);
    if (input.positionId) {
      input.agentId = this.agentByPosition.get(input.positionId);
      if (event.type === 'POSITION_CLOSE') this.agentByPosition.delete(input.positionId);
    }
    return this.process({ ...input, environment, state: { ...input.state, environment } });
  }

  async processOrderFill(input: TriggerInput): Promise<AgentTriggerEvent[]> {
    if (input.type !== 'ORDER_FILLED' || input.state.order?.status !== 'FILLED') return [];
    return this.process(input);
  }

  private canFire(trigger: AgentTrigger, timestamp: number): boolean {
    let last = this.lastFired.get(trigger.id);
    if (last !== undefined && timestamp < last) {
      this.lastFired.delete(trigger.id);
      this.firingHistory.delete(trigger.id);
      last = undefined;
    }
    if (last !== undefined && (timestamp < last || timestamp - last < (trigger.cooldownMs ?? 1000))) return false;
    const max = trigger.maxFiringsPerMinute ?? 10;
    const times = (this.firingHistory.get(trigger.id) || []).filter((firing) => timestamp - firing.timestamp < 60_000);
    this.firingHistory.set(trigger.id, times);
    return times.length < max;
  }

  private markFired(trigger: AgentTrigger, timestamp: number): void {
    this.lastFired.set(trigger.id, timestamp);
    const times = this.firingHistory.get(trigger.id) || [];
    for (let index = times.length - 1; index >= 0; index -= 1) {
      if (timestamp - times[index].timestamp >= 60_000 || timestamp < times[index].timestamp) times.splice(index, 1);
    }
    times.push({ timestamp });
    this.firingHistory.set(trigger.id, times);
  }

  private async recordError(agentId: string, triggerId: string, timestamp: number, error: unknown): Promise<void> {
    const message = redactMessage(error);
    try {
      await this.timeline.append({ id: `trigger-error:${triggerId}:${timestamp}`, agentId, timestamp, triggerId, type: 'ERROR',
        data: { code: 'TRIGGER_ERROR', message } });
    } catch {
      return;
    }
  }
}

function wakeType(type: AgentTriggerEvent['type']): AgentWakeEvent['type'] {
  switch (type) {
    case 'NEW_BAR': return 'NEW_BAR';
    case 'PRICE_CROSS': case 'PRICE_THRESHOLD': return 'PRICE_THRESHOLD';
    case 'POSITION_OPEN': return 'POSITION_OPENED';
    case 'POSITION_UPDATE': return 'TRIGGER_FIRED';
    case 'POSITION_CLOSE': return 'TRIGGER_FIRED';
    case 'STOP_APPROACHING': return 'POSITION_APPROACHING_STOP';
    case 'TARGET_APPROACHING': return 'POSITION_REACHED_PROFIT_TARGET';
    case 'ORDER_FILLED': return 'ORDER_FILLED';
    case 'SPREAD_CHANGE': return 'SPREAD_CHANGED';
    case 'SESSION_START': case 'SESSION_END': return 'SESSION_CHANGED';
    case 'RISK_STATE_CHANGED': return 'RISK_STATE_CHANGED';
    case 'SCHEDULED': return 'TIMER_TICK';
    default: return 'TRIGGER_FIRED';
  }
}

function inputFromDomainEvent(event: TradeCodeEvent, now: number, sequence: number): TriggerInput | undefined {
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
    return { id: `agent-order-filled:${event.data.agentId}:${event.data.orderId || event.data.timestamp}`, agentId: event.data.agentId,
      orderId: event.data.orderId, positionId: event.data.positionId, type: 'ORDER_FILLED', timestamp: event.data.timestamp,
      environment: 'DEMO', symbol, state: { timestamp: event.data.timestamp, environment: 'DEMO', symbol,
        order: { status: 'FILLED', orderId: event.data.orderId, positionId: event.data.positionId, symbol } } };
  }

  return undefined;
}

export function triggerInputFromEvent(event: TradeCodeEvent, environment: 'BACKTEST' | 'DEMO', timestamp: number): TriggerInput | undefined {
  const input = inputFromDomainEvent(event, timestamp, 0);
  if (!input) return undefined;
  return { ...input, environment, state: { ...input.state, environment } };
}

function safeSnapshot(state: TriggerInput['state'], calculatedIndicators: Record<string, number>): unknown {
  return { symbol: state.symbol, timeframe: state.timeframe, price: state.price, spread: state.spread,
    bars: state.bars?.slice(-50), indicators: { ...state.indicators, ...calculatedIndicators }, session: state.session };
}

function redactMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
}
