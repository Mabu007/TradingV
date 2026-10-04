/**
 * GOAT — Goal-Oriented Agentic Trader.
 *
 * The public surface of the reasoning layer. Everything the UI, the
 * tests and the backtester need, and nothing that would let them
 * bypass the tracker runtime or the permission boundary.
 */

export * from './types';
export * from './definition';
export * from './starterGoats';
export * from './agentTools';
export * from './store';
export * from './skills';
export * from './builtinSkills';
export * from './trackerSdk';
export * from './loop';
export * from './orchestrator';
export * from './mission';
export * from './marketContext';
export * from './researchCapabilities';
export * from './steering';

/*
 * The observation half of the architecture, re-exported so an
 * application wires the GOAT layer and the tracker runtime from one
 * place. The canonical home is `agents/trackers`; nothing here wraps it.
 */
export { TrackerRegistry, validateDefinition } from '../agents/trackers/registry';
export type { TrackerAgentResolver } from '../agents/trackers/registry';
export { TrackerRuntime, TrackerRuntimeError, DEFAULT_TRACKER_LIMITS, EVENT_TYPE_FOR_KIND } from '../agents/trackers/runtime';
export { evaluateTracker, TrackerEvaluator, conditionTreeOf } from '../agents/trackers/evaluator';
