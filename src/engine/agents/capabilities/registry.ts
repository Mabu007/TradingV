import { AgentCapability, CapabilityContext } from '../types';

export class CapabilityRegistry {
  private capabilities: Map<string, AgentCapability<unknown, unknown>> = new Map();

  register<TInput = unknown, TOutput = unknown>(capability: AgentCapability<TInput, TOutput>): void {
    if (!capability.id) throw new Error('Capability must have a non-empty id');
    if (this.capabilities.has(capability.id)) throw new Error(`Capability "${capability.id}" is already registered.`);
    if (typeof capability.execute !== 'function') throw new Error(`Capability "${capability.id}" must define an executor.`);
    if (!isRecord(capability.inputSchema) || !isRecord(capability.outputSchema)) throw new Error(`Capability "${capability.id}" must define object schemas.`);
    const registered: AgentCapability<unknown, unknown> = {
      ...capability,
      execute: (input, context) => capability.execute(input as TInput, context),
    };
    this.capabilities.set(capability.id, registered);
  }

  get(id: string): AgentCapability<unknown, unknown> | undefined {
    return this.capabilities.get(id);
  }

  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  list(): AgentCapability<unknown, unknown>[] {
    return Array.from(this.capabilities.values());
  }

  listByCategory(category: AgentCapability['category']): AgentCapability<unknown, unknown>[] {
    return this.list().filter((c) => c.category === category);
  }

  async execute<TInput = unknown, TOutput = unknown>(
    id: string,
    input: TInput,
    context: CapabilityContext
  ): Promise<TOutput> {
    const capability = this.capabilities.get(id);
    if (!capability) {
      throw new Error(`Unknown capability: "${id}". Ensure it is registered and declared in the agent's active skills.`);
    }

    try {
      validateCapabilityInput(id, capability.inputSchema, input);
      validateCapabilityScope(id, input, context);
      return (await capability.execute(input, context)) as TOutput;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Capability execution failed [${id}]: ${message}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCapabilityInput(id: string, schema: Record<string, unknown>, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Capability input for ${id} must be a JSON object.`);
  }
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((key) => !(key in schema));
  if (unknownFields.length > 0) throw new Error(`Capability input for ${id} contains unsupported fields: ${unknownFields.join(', ')}.`);
  for (const [key, definition] of Object.entries(schema)) {
    if (typeof definition !== 'object' || definition === null) continue;
    const descriptor = definition as Record<string, unknown>;
    if (descriptor.required === true && !(key in input)) throw new Error(`Capability input field "${key}" is required.`);
    if (!(key in input)) continue;
    const actual = input[key];
    if (descriptor.type === 'string' && typeof actual !== 'string') {
      throw new Error(`Capability input field "${key}" must be a string.`);
    }
    if (descriptor.type === 'number' && (typeof actual !== 'number' || !Number.isFinite(actual))) {
      throw new Error(`Capability input field "${key}" must be a finite number.`);
    }
    if (descriptor.type === 'boolean' && typeof actual !== 'boolean') {
      throw new Error(`Capability input field "${key}" must be a boolean.`);
    }
    if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(actual)) throw new Error(`Capability input field "${key}" has an unsupported value.`);
    if (descriptor.minimum !== undefined && typeof actual === 'number' && actual < Number(descriptor.minimum)) {
      throw new Error(`Capability input field "${key}" is below its minimum.`);
    }
    if (descriptor.maximum !== undefined && typeof actual === 'number' && actual > Number(descriptor.maximum)) {
      throw new Error(`Capability input field "${key}" exceeds its maximum.`);
    }
  }
}

export const capabilityRegistry = new CapabilityRegistry();

function validateCapabilityScope(id: string, value: unknown, context: CapabilityContext): void {
  if (!isRecord(value) || typeof value.symbol !== 'string') return;
  if (!context.symbols.includes(value.symbol)) throw new Error(`Capability ${id} cannot access out-of-scope symbol ${value.symbol}.`);
}
