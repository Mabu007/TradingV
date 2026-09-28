import { AgentMemory } from '../types';

export class ScopedAgentMemory implements AgentMemory {
  private store: Map<string, unknown> = new Map();

  constructor(initialData: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initialData)) {
      this.store.set(k, v);
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, cloneMemoryValue(value));
  }

  append(key: string, value: unknown): void {
    const existing = this.store.get(key);
    if (Array.isArray(existing)) {
      existing.push(cloneMemoryValue(value));
      this.store.set(key, existing);
    } else if (existing !== undefined) {
      this.store.set(key, [existing, cloneMemoryValue(value)]);
    } else {
      this.store.set(key, [cloneMemoryValue(value)]);
    }
  }

  clear(): void {
    this.store.clear();
  }

  export(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.store.entries()) {
      obj[k] = cloneMemoryValue(v);
    }
    return obj;
  }
}

function cloneMemoryValue(value: unknown): unknown {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneMemoryValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMemoryValue(item)]));
}
