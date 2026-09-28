import { PersistentAgentTimelineStore } from './timeline';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export async function runActivityPersistenceTests(): Promise<void> {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => undefined, clear: () => values.clear(), key: () => null, length: 0 };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const first = new PersistentAgentTimelineStore(100, 'test:activity');
  await first.append({ id: 'event-a', agentId: 'agent-a', botId: 'bot-a', deploymentId: 'deployment-a', timestamp: 10, type: 'TRIGGER', data: { reason: 'test' } });
  await first.append({ id: 'event-b', agentId: 'agent-b', botId: 'bot-b', deploymentId: 'deployment-b', timestamp: 20, type: 'DECISION', data: { decision: 'WAIT' } });
  const second = new PersistentAgentTimelineStore(100, 'test:activity');
  assert((await second.getByBot('bot-a', { limit: 50 })).map((event) => event.id).join() === 'event-a', 'activity query scopes events by bot');
  assert((await second.getByDeployment('deployment-b', { limit: 50 })).map((event) => event.id).join() === 'event-b', 'activity query scopes events by deployment');
  assert((await second.getByBot('bot-a', { type: 'DECISION' })).length === 0, 'activity filters by event type');
}
