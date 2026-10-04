import { PersistentAgentTimelineStore } from './timeline';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export async function runActivityPersistenceTests(): Promise<void> {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => undefined, clear: () => values.clear(), key: () => null, length: 0 };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const first = new PersistentAgentTimelineStore(100, 'test:activity');
  await first.append({ id: 'event-a', agentId: 'agent-a', goatId: 'goat-a', deploymentId: 'deployment-a', timestamp: 10, type: 'TRACKER', data: { reason: 'test' } });
  await first.append({ id: 'event-b', agentId: 'agent-b', goatId: 'goat-b', deploymentId: 'deployment-b', timestamp: 20, type: 'DECISION', data: { decision: 'WAIT' } });
  /*
   * Writes are debounced, so the first store is flushed before a second
   * instance reads the persisted history. The assertion is unchanged: a
   * new store must see what the previous one recorded.
   */
  first.flush();
  const second = new PersistentAgentTimelineStore(100, 'test:activity');
  assert((await second.getByGoat('goat-a', { limit: 50 })).map((event) => event.id).join() === 'event-a', 'activity query scopes events by GOAT');
  assert((await second.getByDeployment('deployment-b', { limit: 50 })).map((event) => event.id).join() === 'event-b', 'activity query scopes events by deployment');
  assert((await second.getByGoat('goat-a', { type: 'DECISION' })).length === 0, 'activity filters by event type');
}

/**
 * Durability under a burst.
 *
 * The store coalesces writes because the timeline receives one
 * POSITION_UPDATE per quote tick; serialising the whole history each time
 * locked up the UI. These assert the two properties that tradeoff has to
 * keep: a burst costs a bounded number of writes, and nothing is lost when
 * the debounce is allowed to elapse on its own.
 */
export async function runTimelineWriteCoalescingTests(): Promise<void> {
  const values = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { writes += 1; values.set(key, value); },
    removeItem: () => undefined, clear: () => values.clear(), key: () => null, length: 0,
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  const store = new PersistentAgentTimelineStore(2000, 'test:coalescing');
  for (let index = 0; index < 200; index += 1) {
    await store.append({ id: `seed-${index}`, agentId: 'agent-a', goatId: 'goat-a', deploymentId: 'dep', timestamp: index, type: 'TRACKER', data: {} });
  }
  store.flush();
  writes = 0;

  for (let index = 0; index < 200; index += 1) {
    await store.append({ id: `burst-${index}`, agentId: 'agent-a', goatId: 'goat-a', deploymentId: 'dep', timestamp: 1000 + index, type: 'POSITION_UPDATE', data: {} });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert(writes <= 3, `a 200-event burst caused ${writes} full-history writes; they must be coalesced`);
  const persisted = JSON.parse(values.get('test:coalescing') || '[]') as Array<{ id: string }>;
  assert(persisted.length === 400, `expected 400 persisted events, found ${persisted.length}`);
}
