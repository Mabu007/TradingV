import { DemoEnvironment } from '../environment/demo';
import { AgentRuntime } from '../runtime';
import { CONSERVATIVE_EURUSD_AGENT } from './conservativeEurusd';

export function registerConservativeEurusdDemoAgent(
  runtime: AgentRuntime,
  environment: DemoEnvironment = new DemoEnvironment()
) {
  return runtime.registerAgent(CONSERVATIVE_EURUSD_AGENT, environment);
}
