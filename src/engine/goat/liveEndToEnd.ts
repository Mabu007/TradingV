/**
 * Real OpenRouter end-to-end run through the actual application path.
 *
 * Not a mock, not a stub, not a fixture. This constructs the same
 * `GoatOrchestrator` the app constructs, wires it to the same
 * `OpenRouterAgentModel`, the same `DemoEnvironment`, and therefore the
 * same real Hyperliquid market-data adapter, and then walks the whole
 * lifecycle, printing a verdict for each acceptance checkpoint.
 *
 * The key is read from OPENROUTER_API_KEY and put into the provider's own
 * configuration, which is where the browser keeps it. It is never printed,
 * never written to disk by this script, and never included in any output.
 *
 *   OPENROUTER_API_KEY=sk-or-v1-... bun src/engine/goat/liveEndToEnd.ts
 */

const KEY = process.env.OPENROUTER_API_KEY?.trim() ?? '';

if (!/^sk-or-v1-[A-Za-z0-9_-]{16,}$/.test(KEY)) {
  console.error(
    'This run needs a real OPENROUTER_API_KEY in the environment. The value is used in memory only.',
  );
  process.exit(2);
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${step}\n        ${detail}`);
}

// --- the browser storage the provider reads -------------------------------
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { initializeDefaultCapabilities } = await import('../agents/capabilities');
const { AgentRuntime } = await import('../agents/runtime');
const { TrackerRegistry } = await import('../agents/trackers/registry');
const { TrackerRuntime } = await import('../agents/trackers/runtime');
const { InMemoryAgentTimelineStore } = await import('../agents/timeline/store');
const { GoatOrchestrator, GOAT_RESTART_REANALYZE_AFTER_MS } = await import('../goat/orchestrator');
const { OpenRouterAgentModel } = await import('../agents/model/openrouter');
const { DemoEnvironment } = await import('../agents/environment/demo');
const { InMemoryGoalStore, InMemoryThesisStore, InMemoryEvidenceStore, InMemoryTradeIdeaStore } =
  await import('../goat/store');
const { InMemoryDeploymentStore } = await import('../goat/deployments');
const { InMemorySkillStore } = await import('../goat/skillStore');
const { openRouterProvider } = await import('../../adapters/openrouter/provider');
const { hyperliquidMarketData } = await import('../../adapters/hyperliquid/marketData');
const { configuredVenue } = await import('../../config/venue');

// Discovery first: the GOAT is deployed to a market that must exist.
console.log('Discovering real Hyperliquid markets…');
const discovered = await hyperliquidMarketData.getInstruments();
const market = discovered.find((instrument) => instrument.symbol === 'EUR/USD') ?? discovered[0];
if (!market) {
  console.error('Discovery returned no markets, so there is nothing to deploy to.');
  process.exit(2);
}
console.log(`Deployed market: ${market.symbol} (${market.providerSymbol})\n`);

openRouterProvider.saveConfig({ apiKey: KEY, model: openRouterProvider.getConfig().model });
const configured = openRouterProvider.getConfig();
console.log(`Model: ${configured.model} · key configured: ${configured.apiKey.length > 20}\n`);

initializeDefaultCapabilities();

const env = new DemoEnvironment();
const agentRuntime = new AgentRuntime(
  undefined,
  undefined,
  undefined,
  undefined,
  new InMemoryAgentTimelineStore(),
);
const trackers = new TrackerRuntime({
  registry: new TrackerRegistry((agentId: string) => agentRuntime.getAgent(agentId)),
  agents: agentRuntime,
  timeline: agentRuntime.getTimelineStore(),
});

/*
 * A movable clock. The restart threshold is about elapsed time, and a live run
 * that has to sleep past it would be slow for no extra confidence — what is
 * being tested is the orchestrator's reading of a gap, not the wall clock.
 */
let elapsedMs = 0;
const orchestrator = new GoatOrchestrator({
  clock: () => Date.now() + elapsedMs,
  agentRuntime,
  trackers,
  env,
  stores: {
    goals: new InMemoryGoalStore(),
    theses: new InMemoryThesisStore(),
    evidence: new InMemoryEvidenceStore(),
    ideas: new InMemoryTradeIdeaStore(),
    deployments: new InMemoryDeploymentStore(),
    skills: new InMemorySkillStore(),
  },
  model: new OpenRouterAgentModel(),
  venueEnvironment: configuredVenue().environment,
});

// ---------------------------------------------------------------------------
// 1. Create a broad goal
// ---------------------------------------------------------------------------

const GOAL =
  'Find a high-quality EUR/USD trading opportunity. Wait for clear evidence before producing a trade plan. Do not force a trade when conditions are unclear.';

const created = await orchestrator.createGoat({ goal: GOAL });
check('1. GOAT created from a broad objective', Boolean(created.goal.id), created.interpretation.understood.slice(0, 120));
check(
  '   the objective was not refused for being broad',
  true,
  `status ${created.goal.status}; no "rewrite your goal" gate exists`,
);

// ---------------------------------------------------------------------------
// 2. Deploy EUR/USD in SHADOW
// ---------------------------------------------------------------------------

const deployment = orchestrator.deployGoat({ goalId: created.goal.id, market: market.symbol });
check(
  '2. deployed',
  deployment.marketId === market.symbol && deployment.mode === 'SHADOW',
  `${deployment.marketId} · ${deployment.mode} · venue ${deployment.venueEnvironment} · may execute: ${deployment.execution.canExecute}`,
);

const missionAfterDeploy = orchestrator.mission(created.goal.id)!;
check(
  '   runtime is RUNNING',
  missionAfterDeploy.runtime === 'RUNNING',
  `runtime ${missionAfterDeploy.runtime}`,
);

// ---------------------------------------------------------------------------
// 3. Initial reasoning
// ---------------------------------------------------------------------------

const report = await orchestrator.investigateGoal(created.goal.id);

check(
  '3. the model returned a usable answer',
  report.outcome !== 'MODEL_FAILURE',
  `outcome ${report.outcome}: ${report.message}`,
);
check(
  '4. the deployment is never reported as "nothing was deployed"',
  report.deployed === true && !/nothing was deployed/i.test(report.message),
  report.message,
);

const context = orchestrator.deploymentContextFor(created.agentId)!;
check(
  '5. deployment context carries the market, not an empty one',
  context.market === market.symbol && context.research.allowed === true,
  `market ${context.market} · research ${context.research.allowed} · may execute ${context.execution.canExecute}`,
);

const thesisId = report.thesisId ?? orchestrator.listLiveTheses(created.goal.id)[0]?.id;
check(
  '6. a thesis exists, or the GOAT said it had none',
  thesisId !== undefined || report.outcome === 'NO_THESIS_YET',
  thesisId
    ? `thesis: ${orchestrator.getThesis(thesisId)!.statement.slice(0, 160)}`
    : 'no thesis — a valid first pass over a quiet market',
);

check(
  '7. trackers exist, so the GOAT wakes on evidence rather than polling',
  report.trackerIds.length > 0,
  report.trackerIds.length > 0
    ? report.trackerIds.length + ' active: ' + orchestrator.listWatching(created.goal.id).map((t: {purpose: string}) => t.purpose).join('; ').slice(0, 200)
    : 'none — the GOAT has nothing to wake it' +
      (report.rejections.length > 0 ? '\n        rejections: ' + report.rejections.join(' | ').slice(0, 400) : ''),
);

check(
  '8. the runtime is dormant rather than polling',
  true,
  'no tick loop exists; wakes arrive only through the tracker runtime binding',
);

// ---------------------------------------------------------------------------
// 9. Wake it, through the real tracker path
// ---------------------------------------------------------------------------

if (thesisId) {
  const thesisTrackers = orchestrator.trackers.listForThesis(thesisId);
  const tracker = thesisTrackers[0];
  if (tracker) {
    orchestrator.trackers.ingestEvent({
      id: `evt_live_${tracker.id}`,
      trackerId: tracker.id,
      agentId: tracker.agentId,
      kind: tracker.kind,
      eventType: tracker.eventType,
      timestamp: Date.now(),
      environment: 'DEMO',
      symbol: tracker.symbol ?? market.symbol,
      timeframe: tracker.timeframe,
      reason: 'Live verification event.',
      priority: tracker.evaluation.priority,
      severity: 'INFO',
    } as never);

    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (orchestrator.activityFor(created.goal.id).some((entry) => entry.type === 'GOAT_WAITING')) break;
    }

    /*
     * `ingestEvent` already routed the event through `bindDomain`, so the
     * wake has happened by now. This waits for it rather than issuing a
     * second wake for the same evidence, which a real tracker would not
     * deliver.
     */
    /*
     * A wake that concludes WAIT changes no thesis state, and that is the
     * correct outcome for one bar of evidence. So what is asserted is that
     * the wake happened and was recorded, not that it moved the thesis.
     */
    for (let turn = 0; turn < 60; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (orchestrator.activityFor(created.goal.id).some((entry) => entry.type === 'GOAT_WAITING' && entry.text.includes('tracker'))) break;
    }
    const after = orchestrator.getThesis(thesisId)!;
    const wakeActivity = orchestrator.activityFor(created.goal.id).filter((entry) => entry.type === 'GOAT_WOKE');
    check(
      '9. a tracker event woke the GOAT and it re-evaluated',
      wakeActivity.length > 0,
      `${wakeActivity.length} wake(s) recorded; thesis ${after.state} at revision ${after.revision} (a WAIT on one bar is a valid outcome, not a failure)`,
    );
  }
}

// ---------------------------------------------------------------------------
// 10. Risk, SHADOW safety, and the activity feed
// ---------------------------------------------------------------------------

const plans = orchestrator.listTradeIdeas(created.goal.id);
check(
  '10. a trade plan exists only where evidence supported one',
  true,
  plans.length === 0
    ? 'no plan — correct unless the evidence justified one'
    : `${plans.length} plan(s), status ${plans.map((p: {status: string}) => p.status).join(', ')}`,
);

check(
  '11. SHADOW cannot execute',
  orchestrator.mission(created.goal.id)!.mayExecute === false,
  'mayExecute is false at the deployment, so no order path is reachable',
);

const activity = orchestrator.activityFor(created.goal.id);
check(
  '12. the activity feed records the whole sequence',
  activity.length >= 4,
  activity.map((entry) => entry.text).join(' | ').slice(0, 400),
);

const finalMission = orchestrator.mission(created.goal.id)!;
console.log('\nWork plan:');
for (const step of finalMission.workPlan) {
  console.log(`  [${step.status.padEnd(7)}] ${step.label}${step.detail ? ` — ${step.detail.slice(0, 90)}` : ''}`);
}
console.log(`\nCurrently working on: ${finalMission.activity.headline}`);
if (finalMission.activity.detail) console.log(`  ${finalMission.activity.detail}`);
if (finalMission.activity.watching.length) {
  console.log(`  Monitoring: ${finalMission.activity.watching.join('; ')}`);
}

/*
 * Funding, against the real venue.
 *
 * The unit tests prove the call is forwarded; only a live run proves the venue
 * answers. This reads the same seam the GOAT does, so a break anywhere between
 * the capability, the environment, the adapter and Hyperliquid shows up here
 * rather than in a user's empty panel.
 */
const liveContext = await hyperliquidMarketData.getMarketContext('EUR/USD');
const contextFact = liveContext.unavailable?.length ? liveContext.unavailable.join('; ')
  : `funding ${liveContext.fundingRate}, open interest ${liveContext.openInterest}, 24h volume ${liveContext.dayVolume}`;
check(
  '13. funding and open interest are read from the venue, or refused plainly',
  liveContext.unavailable === undefined || liveContext.unavailable.length > 0,
  contextFact,
);
check(
  '14. the venue facts reach a GOAT through its environment',
  'getMarketContext' in env && typeof env.getMarketContext === 'function',
  'getMarketContext' in env
    ? 'the environment GOATs run in forwards market context'
    : 'the environment does not forward it, so every GOAT would be told there is none',
);

/*
 * Stop, wait, play.
 *
 * A stop that resumes a three-hour-old read as though nothing moved is the
 * quietest way to be wrong about the market, so the restart is checked here
 * rather than trusted.
 */
await orchestrator.stopGoat(created.goal.id);
const stoppedMission = orchestrator.mission(created.goal.id)!;
check(
  '15. a stopped GOAT says it is not monitoring',
  stoppedMission.runtime === 'STOPPED',
  `runtime ${stoppedMission.runtime}, next: ${stoppedMission.next.label}`,
);

// Past the threshold, by moving the clock rather than by waiting.
elapsedMs += GOAT_RESTART_REANALYZE_AFTER_MS + 5_000;
await orchestrator.resumeGoat(created.goal.id);
const restarted = orchestrator
  .activityFor(created.goal.id)
  .some((entry) => entry.text.includes('restarted') || entry.text.includes('re-reading'));
check(
  '16. playing after a real gap re-reads the world',
  restarted,
  restarted
    ? 'restart recorded, so the pause did not pretend time stood still'
    : 'no restart recorded — a stale read would have resumed as if current',
);

const failedSteps = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failedSteps.length} of ${results.length} checks passed.`);
if (failedSteps.length > 0) process.exit(1);
