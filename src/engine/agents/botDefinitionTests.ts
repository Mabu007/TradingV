import { compileQuickBuild, createDeployment, migrateBotDefinition, validateBotDefinition, BotDefinition } from './botDefinition';
import { EXPLORER_BOTS } from './explorer';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function runBotDefinitionTests(): void {
  const built = compileQuickBuild('Build me a conservative trend-following bot that avoids overtrading.');
  validateBotDefinition(built.definition);
  assert(built.definition.intent.objective.length > 0, 'quick build creates intent');
  assert(built.definition.triggers.length > 0, 'quick build creates triggers');
  assert(!('symbols' in built.definition), 'bot definitions are asset independent');

  /*
   * Every shipped template must stay market-free so the runtime, not the
   * definition, resolves bot + instrument -> metadata -> execution/risk.
   */
  const assetClasses: Array<{ symbol: string; assetClass: string }> = [
    { symbol: 'EUR/USD', assetClass: 'FOREX' },
    { symbol: 'Gold', assetClass: 'COMMODITY' },
    { symbol: 'S&P 500', assetClass: 'INDEX' },
  ];

  assert(EXPLORER_BOTS.length === 8, 'all shipped bot templates are present');

  for (const template of EXPLORER_BOTS) {
    assert(
      !('symbols' in template) && !('market' in template) && !('marketId' in template),
      `${template.identity.name} carries no market`,
    );

    validateBotDefinition(template);

    for (const asset of assetClasses) {
      const deployment = createDeployment(
        {
          id: `${template.identity.id}:${asset.symbol}`,
          botId: template.identity.id,
          marketId: asset.symbol,
          accountId: 'paper-account',
          mode: 'demo',
          status: 'active',
        },
        1,
      );

      assert(
        deployment.marketId === asset.symbol,
        `${template.identity.name} deploys onto ${asset.assetClass} without changing the definition`,
      );
    }
  }

  let rejected = false;
  try {
    validateBotDefinition({ ...built.definition, risk: { ...built.definition.risk, maxPositions: 0 } });
  } catch { rejected = true; }
  assert(rejected, 'invalid bot definition is rejected');

  const edited: BotDefinition = {
    ...built.definition,
    identity: { ...built.definition.identity, name: 'Edited Bot' },
  };
  validateBotDefinition(edited);

  const first = createDeployment({ id: 'deployment-eur', botId: edited.identity.id, marketId: 'market-eur', accountId: 'paper-account', mode: 'paper', status: 'active' });
  const second = createDeployment({ id: 'deployment-gold', botId: edited.identity.id, marketId: 'market-gold', accountId: 'paper-account', mode: 'paper', status: 'active' });
  assert(first.botId === second.botId && first.marketId !== second.marketId, 'one definition supports multiple deployments');

  rejected = false;
  try {
    validateBotDefinition({ ...edited, capabilities: { ...edited.capabilities, orders: true, automation: false } });
  } catch { rejected = true; }
  assert(rejected, 'execution cannot be enabled without automation');
  for (const explorerBot of EXPLORER_BOTS) validateBotDefinition(explorerBot);
  const migrated = migrateBotDefinition({ id: 'legacy-bot', name: 'Legacy Bot', instructions: 'Observe before acting.' });
  assert(migrated.schemaVersion === 2 && migrated.ai.provider === 'openrouter', 'legacy bot definitions migrate to the current schema');
}
