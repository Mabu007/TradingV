import { Quote, Bar, OrderResult, Position, Trade, SignalEvent, LogEntry } from './trading';

export type TradeCodeEvent =
  | { type: 'AGENT_STARTED'; data: { agentId: string; timestamp: number } }
  | { type: 'AGENT_STOPPED'; data: { agentId: string; timestamp: number } }
  | { type: 'AGENT_OBSERVED'; data: { agentId: string; timestamp: number } }
  | { type: 'AGENT_REASONING'; data: { agentId: string; iteration: number; timestamp: number } }
  | { type: 'AGENT_TOOL_REQUESTED'; data: { agentId: string; capability: string; input: unknown; timestamp: number } }
  | { type: 'AGENT_TOOL_RESULT'; data: { agentId: string; capability: string; result: unknown; timestamp: number } }
  | { type: 'AGENT_DECISION'; data: { agentId: string; decision: unknown; timestamp: number } }
  | { type: 'AGENT_ACTION_APPROVED'; data: { agentId: string; decision: unknown; timestamp: number } }
  | { type: 'AGENT_ACTION_REJECTED'; data: { agentId: string; reason?: string; timestamp: number } }
  | { type: 'AGENT_ORDER_SUBMITTED'; data: { agentId: string; result: unknown; timestamp: number } }
  | { type: 'AGENT_ORDER_FILLED'; data: { agentId: string; result: unknown; symbol?: string; orderId?: string; positionId?: string; timestamp: number } }
  | { type: 'AGENT_ERROR'; data: { agentId: string; message: string; timestamp: number } }
  | { type: 'MARKET_QUOTE'; data: Quote }
  | { type: 'BAR_UPDATE'; symbol: string; timeframe?: string; bar: Bar; isClosed: boolean }
  | { type: 'SIGNAL'; data: SignalEvent }
  | { type: 'ORDER'; data: OrderResult }
  | { type: 'POSITION_OPEN'; data: Position }
  | { type: 'POSITION_UPDATE'; data: Position }
  | { type: 'POSITION_CLOSE'; data: { position: Position; trade: Trade } }
  | { type: 'LOG'; data: LogEntry }
  | { type: 'RISK_VIOLATION'; data: { rule: string; message: string; timestamp: number } }
  | { type: 'STATUS_CHANGE'; data: { mode: string; status: string; message?: string } };

export type EventListener<T extends TradeCodeEvent = TradeCodeEvent> = (event: T) => void;

class EventBus {
  private listeners: Map<string, Set<(event: any) => void>> = new Map();

  on<T extends TradeCodeEvent['type']>(
    type: T,
    listener: (event: Extract<TradeCodeEvent, { type: T }>) => void
  ): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  emit(event: TradeCodeEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      handlers.forEach((h) => {
        try {
          h(event);
        } catch (err) {
          console.error(`Error in event listener for ${event.type}:`, err);
        }
      });
    }

    // Also support wildcard listener
    const allHandlers = this.listeners.get('*');
    if (allHandlers) {
      allHandlers.forEach((h) => h(event));
    }
  }

  onAll(listener: (event: TradeCodeEvent) => void): () => void {
    if (!this.listeners.has('*')) {
      this.listeners.set('*', new Set());
    }
    this.listeners.get('*')!.add(listener);
    return () => {
      this.listeners.get('*')?.delete(listener);
    };
  }
}

export const eventBus = new EventBus();
