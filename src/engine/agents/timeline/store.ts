import { AgentTimelineEvent, AgentTimelineStore, TimelineQuery } from './types';

export class InMemoryAgentTimelineStore implements AgentTimelineStore {
  private readonly events: AgentTimelineEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 10_000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be a positive integer.');
    this.maxEvents = maxEvents;
  }

  async append(event: AgentTimelineEvent): Promise<void> {
    if (!event.id || !event.agentId || !Number.isFinite(event.timestamp)) throw new Error('Invalid timeline event identity.');
    if (this.events.some((existing) => existing.id === event.id)) return;
    this.events.push(clone(event));
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  async getByAgent(agentId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    const matched = this.events.filter((event) => event.agentId === agentId && matches(event, options));
    return matched.slice(-boundedLimit(options.limit)).map(clone);
  }

  async getByBot(botId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    const matched = this.events.filter((event) => event.botId === botId && matches(event, options));
    return matched.slice(-boundedLimit(options.limit)).map(clone);
  }

  async getByDeployment(deploymentId: string, options: TimelineQuery = {}): Promise<AgentTimelineEvent[]> {
    const matched = this.events.filter((event) => event.deploymentId === deploymentId && matches(event, options));
    return matched.slice(-boundedLimit(options.limit)).map(clone);
  }

  protected getAllEvents(): AgentTimelineEvent[] { return this.events.map(clone); }

  async getByTrade(tradeId: string): Promise<AgentTimelineEvent[]> {
    return this.events.filter((event) => event.tradeId === tradeId).map(clone);
  }

  async getByPosition(positionId: string): Promise<AgentTimelineEvent[]> {
    return this.events.filter((event) => event.positionId === positionId).map(clone);
  }
}

export class PersistentAgentTimelineStore extends InMemoryAgentTimelineStore {
  private readonly storageKey: string;

  constructor(maxEvents = 10_000, storageKey = 'tradingvibe:agent-timeline') {
    super(maxEvents);
    this.storageKey = storageKey;
    const storage = getStorage();
    if (!storage) return;
    try {
      const saved: unknown = JSON.parse(storage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) for (const event of saved) if (event && typeof event === 'object') void super.append(event as AgentTimelineEvent);
    } catch { /* Corrupt local activity must not prevent the runtime from starting. */ }
  }

  override async append(event: AgentTimelineEvent): Promise<void> {
    await super.append(event);
    const events = super.getAllEvents();
    const storage = getStorage();
    if (storage) storage.setItem(this.storageKey, JSON.stringify(events));
  }
}

function matches(event: AgentTimelineEvent, query: TimelineQuery): boolean {
  return (query.from === undefined || event.timestamp >= query.from) &&
    (query.to === undefined || event.timestamp <= query.to) &&
    (query.type === undefined || event.type === query.type) &&
    (query.botId === undefined || event.botId === query.botId) &&
    (query.deploymentId === undefined || event.deploymentId === query.deploymentId);
}

function getStorage(): Storage | undefined {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? globalThis.localStorage : undefined;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 1000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Timeline limit must be a positive integer.');
  return Math.min(limit, 1000);
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}
