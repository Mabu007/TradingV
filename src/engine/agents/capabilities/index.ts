import { capabilityRegistry, CapabilityRegistry } from './registry';
import { AgentCapability } from '../types';
import { MARKET_CAPABILITIES } from './market';
import { INDICATOR_CAPABILITIES } from './indicators';
import { STRUCTURE_CAPABILITIES } from './structure';
import { ACCOUNT_CAPABILITIES } from './account';
import { RISK_CAPABILITIES } from './risk';
import { EXECUTION_CAPABILITIES } from './execution';

export * from './registry';
export * from './market';
export * from './indicators';
export * from './structure';
export * from './account';
export * from './risk';
export * from './execution';

export function initializeDefaultCapabilities(registry: CapabilityRegistry = capabilityRegistry): CapabilityRegistry {
  const all = [
    ...MARKET_CAPABILITIES,
    ...INDICATOR_CAPABILITIES,
    ...STRUCTURE_CAPABILITIES,
    ...ACCOUNT_CAPABILITIES,
    ...RISK_CAPABILITIES,
    ...EXECUTION_CAPABILITIES,
  ];

  for (const cap of all as AgentCapability<unknown, unknown>[]) {
    if (!registry.has(cap.id)) {
      registry.register(cap);
    }
  }

  return registry;
}

// Auto-register on module load
initializeDefaultCapabilities(capabilityRegistry);
