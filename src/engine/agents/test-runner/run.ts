import { runAgentInfrastructureTests } from '../tests';
import { runTriggerTimelineTests } from '../triggers/tests';
import { runBotDefinitionTests } from '../botDefinitionTests';
import { runBotDefinitionBacktestTests } from '../backtestTests';
import { runHistoricalValidationTests } from '../../backtester/historicalTests';
import { runActivityPersistenceTests } from '../activityTests';
import { runExecutionRiskTests } from '../../execution/tests';

await runAgentInfrastructureTests();
await runTriggerTimelineTests();
runBotDefinitionTests();
await runBotDefinitionBacktestTests();
runHistoricalValidationTests();
await runExecutionRiskTests();
await runActivityPersistenceTests();
console.log('Agent infrastructure and trigger/timeline tests passed.');
