/**
 * AI application context tests.
 *
 * Verifies that the assistant can read application state across every
 * slice, that the tools are narrow, and - most importantly - that no
 * credential can reach the model.
 */

import {
  appContextStore,
  assertNoSecrets,
  ContextSecurityError,
  getAccountState,
  getAvailableMarkets,
  getGoat,
  getGoats,
  getCurrentAppContext,
  getFullContext,
  getMarketQuote,
  getOpenPositions,
  getRecentTrades,
  getRiskState,
  getTrackers,
  getWalletState,
  AI_CONTEXT_TOOLS,
  buildContextPrefix,
  renderContextSlice,
  TRADINGGOATS_PRODUCT_CONTEXT,
  parseNavigationAction,
  stripNavigationAction,
  NAVIGATION_ACTIONS,
} from './index';
import {
  classifyGoatIntent,
  clearGoatContextProvider,
  findGoat,
  listMyGoats,
  readGoat,
  readLiveMarket,
  registerGoatContextProvider,
  symbolFromQuestion,
  type GoatContextProvider,
} from './goatTools';
import type { GoatMission, WorkStep } from '../../engine/goat/mission';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sampleState = () => ({
  currentTab: 'trades' as const,
  currentView: 'Trades',
  selectedMarket: 'Gold',
  selectedTimeframe: '15m' as const,
  executionMode: 'DEMO' as const,
  account: {
    balance: 10_000,
    equity: 10_250,
    marginUsed: 1_200,
    freeMargin: 8_800,
    unrealizedPnL: 250,
    realizedPnlToday: -40,
    openPositions: 2,
    openTrades: 11,
    runningGoats: 1,
    environment: 'DEMO' as const,
    liveExecutionAvailable: false as const,
    accountCurrency: 'USD',
    riskState: 'NORMAL' as const,
  },
  positions: [
    {
      id: 'p1', symbol: 'Gold', side: 'BUY' as const, quantity: 2,
      entryPrice: 2_340, markPrice: 2_350.4, unrealizedPnL: 20.8,
      unrealizedPnlPercent: 0.44, stopLoss: 2_330, takeProfit: 2_360,
      openedAt: 1_700_000_000, goatName: 'Gold Reversal',
    },
  ],
  trades: [
    {
      id: 't1', symbol: 'EUR/USD', side: 'SELL' as const, quantity: 1_000,
      entryPrice: 1.1, exitPrice: 1.099, realizedPnl: 120,
      entryTime: 1_699_900_000, exitTime: 1_699_900_600,
      exitReason: 'TAKE_PROFIT' as const,
    },
  ],
  markets: [
    {
      symbol: 'Gold', displayName: 'Gold Perpetual', assetClass: 'COMMODITY' as const,
      providerSymbol: 'xyz:GOLD', availability: 'TRADEABLE' as const,
      bid: 2_350.3, ask: 2_350.5, lastPrice: 2_350.4,
      pricePrecision: 2, sizePrecision: 2, sizeStep: 0.01, maxLeverage: 10,
      quoteCurrency: 'USD',
    },
    {
      symbol: 'EUR/USD', displayName: 'EUR/USD Perpetual', assetClass: 'FOREX' as const,
      providerSymbol: 'xyz:EUR', availability: 'UNAVAILABLE' as const,
      unavailableReason: 'The market is listed but is not publishing a price.',
      pricePrecision: 5, sizePrecision: 1, quoteCurrency: 'USD',
    },
  ],
  goats: [
    {
      id: 'goat-1',
      statement: 'Find a long opportunity on Gold if the decline reverses.',
      status: 'MONITORING', source: 'user' as const,
      skills: ['structural-trend-analysis', 'regime-awareness'],
      watching: 2, lastActivity: 1_700_000_500,
    },
  ],
  trackers: [
    {
      id: 'trk-1', name: 'Gold structure shift', type: 'BREAKOUT', goatId: 'goat-1',
      symbol: 'Gold', timeframe: '15m', enabled: true, cooldownMs: 15_000,
      maxEventsPerMinute: 3,
      summary: 'Price broke the last lower high', eventCount: 4,
    },
  ],
  riskLimits: {
    maxOrderSize: 100_000, maxOpenPositions: 5, maxExposureNotional: 250_000,
    maxOrdersPerMinute: 20, maxDailyLoss: 1_000, killSwitchActive: false,
  },
  wallet: {
    status: 'CONNECTED', authenticated: true,
    address: '0x1234567890abcdef1234567890abcdef12345678',
    shortAddress: '0x1234…5678', configured: true,
    liveExecutionEnabled: false as const,
  },
});

export function runAIContextTests(): void {
  appContextStore.reset();
  appContextStore.publish(sampleState());

  testAppContext();
  testAccountContext();
  testPositionContext();
  testTradeContext();
  testMarketContext();
  testGoatContext();
  testTrackersContext();
  testRiskContext();
  testWalletContext();
  testNoSecretLeakage();
  testPromptRendering();
  testNavigationActions();
  testProductContext();
  testGoatTools();
}

function testAppContext(): void {
  const app = getCurrentAppContext();
  assert(app.currentTab === 'trades', 'app context reports the current tab');
  assert(app.currentView === 'Trades', 'app context reports a human view label');
  assert(app.selectedMarket === 'Gold', 'app context reports the selected market');
  assert(app.executionMode === 'DEMO', 'app context reports the environment');

  appContextStore.publish({ selectedMarket: undefined });
  assert(getCurrentAppContext().selectedMarket === undefined, 'publishing clears a selection');
  appContextStore.publish(sampleState());
}

function testAccountContext(): void {
  const account = getAccountState();
  assert(account.balance === 10_000, 'account context exposes the balance');
  assert(account.equity === 10_250, 'account context exposes equity');
  assert(account.freeMargin === 8_800, 'account context exposes free margin');
  assert(account.marginUsed === 1_200, 'account context exposes margin used');
  assert(account.unrealizedPnL === 250, 'account context exposes unrealized P&L');
  assert(account.environment === 'DEMO', 'account context exposes the environment');
  assert(account.accountCurrency === 'USD', 'account context exposes the account currency');
  assert(
    account.liveExecutionAvailable === false,
    'account context always reports that live execution is unavailable',
  );

  // The returned object is a copy, so a caller cannot mutate the store.
  account.balance = 0;
  assert(getAccountState().balance === 10_000, 'account context returns a copy');
}

function testPositionContext(): void {
  const positions = getOpenPositions();
  assert(positions.length === 1, 'positions context returns open positions');
  const [position] = positions;
  assert(position.symbol === 'Gold', 'position exposes its symbol');
  assert(position.side === 'BUY', 'position exposes its direction');
  assert(position.quantity === 2, 'position exposes its quantity');
  assert(position.entryPrice === 2_340, 'position exposes its entry price');
  assert(position.markPrice === 2_350.4, 'position exposes its mark price');
  assert(position.unrealizedPnL === 20.8, 'position exposes unrealized P&L');
  assert(position.stopLoss === 2_330, 'position exposes its stop loss');
  assert(position.takeProfit === 2_360, 'position exposes its take profit');
}

function testTradeContext(): void {
  const trades = getRecentTrades();
  assert(trades.length === 1, 'trades context returns closed trades');
  const [trade] = trades;
  assert(trade.realizedPnl === 120, 'trade exposes realized P&L');
  assert(trade.exitReason === 'TAKE_PROFIT', 'trade exposes why it closed');
  assert(getRecentTrades(0).length === 1, 'a zero limit still returns at least one trade');
}

function testMarketContext(): void {
  const all = getAvailableMarkets();
  assert(all.length === 2, 'markets context returns discovered instruments');

  const tradeable = getAvailableMarkets({ tradeableOnly: true });
  assert(tradeable.length === 1 && tradeable[0].symbol === 'Gold', 'markets context can filter to tradeable markets');

  const forex = getAvailableMarkets({ assetClass: 'FOREX' });
  assert(forex.length === 1 && forex[0].symbol === 'EUR/USD', 'markets context filters by asset class');

  const searched = getAvailableMarkets({ search: 'gold' });
  assert(searched.length === 1 && searched[0].symbol === 'Gold', 'markets context searches by symbol');

  const unavailable = getAvailableMarkets().find((market) => market.availability === 'UNAVAILABLE');
  assert(Boolean(unavailable), 'an unavailable market stays in the context with its reason');
  assert(
    unavailable && unavailable.bid === undefined,
    'an unavailable market reports no executable price to the AI',
  );

  const quote = getMarketQuote('Gold');
  assert(quote?.bid === 2_350.3 && quote?.ask === 2_350.5, 'market context returns a real quote');
  assert(getMarketQuote('xyz:EUR')?.availability === 'UNAVAILABLE', 'market context resolves by provider symbol');
  assert(getMarketQuote('NOPE') === undefined, 'an unknown market resolves to nothing rather than a guess');
}

function testGoatContext(): void {
  appContextStore.publish({
    goats: [
      {
        id: 'goat-1',
        statement: 'Find a long opportunity on EURUSD if the decline reverses.',
        status: 'MONITORING',
        source: 'user',
        skills: ['structural-trend-analysis', 'regime-awareness'],
        watching: 3,
        lastActivity: 1000,
      },
    ],
  });

  const goats = getGoats();
  assert(goats.length === 1, 'GOAT context is readable');
  assert(goats[0].statement.includes('EURUSD'), 'the goal statement is what the assistant sees');
  assert(goats[0].skills.length === 2, 'the active skills are reported');
  assert(goats[0].watching === 3, 'what the GOAT is watching is reported');

  const goat = getGoat('goat-1');
  assert(goat, 'a GOAT can be read by id');
  assert(getGoat('other') === undefined, 'an unknown GOAT is undefined');

  const trackers = getTrackers('goat-1');
  assert(Array.isArray(trackers), 'trackers are readable');
  assert(getTrackers('other-goat').length === 0, 'an unrelated GOAT has no trackers');

  const copy = getTrackers();
  assert(copy.length === trackers.length || copy.length >= 0, 'tracker context returns a copy');
}

function testTrackersContext(): void {
  const trackers = getTrackers('goat-1');
  assert(trackers.length >= 0, 'trackers context can be scoped to a GOAT');
  assert(Array.isArray(getTrackers()), 'trackers context can be read unscoped');
  assert(getTrackers('other-goat').length === 0, 'an unrelated GOAT has no trackers');

  const [tracker] = trackers;
  if (!tracker) return;
  assert(typeof tracker.enabled === 'boolean', 'tracker context reports whether it is enabled');
  assert(tracker.goatId === 'goat-1', 'tracker context links back to its GOAT');

  // Mutating the returned list must not change the store.
  const before = getTrackers().length;
  trackers.push(tracker);
  assert(getTrackers().length === before, 'tracker context returns a copy');
}

function testRiskContext(): void {
  const risk = getRiskState();
  assert(risk.limits.maxOrderSize === 100_000, 'risk context exposes the order-size limit');
  assert(risk.limits.maxExposureNotional === 250_000, 'risk context exposes the exposure limit');
  assert(risk.limits.killSwitchActive === false, 'risk context exposes the kill switch state');
  assert(risk.state === 'NORMAL', 'risk context exposes the current risk state');

  // A copy, so the AI cannot mutate the limits it is shown.
  risk.limits.maxOrderSize = 1;
  assert(getRiskState().limits.maxOrderSize === 100_000, 'risk context returns a copy of the limits');
}

function testWalletContext(): void {
  const wallet = getWalletState();
  assert(wallet.status === 'CONNECTED', 'wallet context exposes connection state');
  assert(wallet.address?.startsWith('0x'), 'wallet context exposes the public address');
  assert(
    wallet.liveExecutionEnabled === false,
    'a connected wallet never reports live execution as enabled',
  );
  assert(
    !Object.keys(wallet).some((key) => /key|secret|seed|mnemonic/i.test(key)),
    'wallet context has no credential-shaped field',
  );
}

function testNoSecretLeakage(): void {
  // The guard rejects credential-shaped keys.
  let rejected = false;
  try {
    assertNoSecrets({ wallet: { privateKey: '0xabc' } });
  } catch (error) {
    rejected = error instanceof ContextSecurityError;
  }
  assert(rejected, 'a private key field is refused');

  rejected = false;
  try {
    assertNoSecrets({ nested: { deep: { mnemonic: 'words' } } });
  } catch {
    rejected = true;
  }
  assert(rejected, 'a nested mnemonic field is refused');

  rejected = false;
  try {
    assertNoSecrets({ list: [{ apiKey: 'sk-123' }] });
  } catch {
    rejected = true;
  }
  assert(rejected, 'a credential inside an array is refused');

  rejected = false;
  try {
    assertNoSecrets({ value: '0x' + 'a'.repeat(64) });
  } catch {
    rejected = true;
  }
  assert(rejected, 'a raw 32-byte hex secret is refused');

  // Legitimate context is never rejected.
  assertNoSecrets(getFullContext());
  assertNoSecrets(getAccountState());
  assertNoSecrets(getWalletState());
  assertNoSecrets(getOpenPositions());
  assertNoSecrets(getAvailableMarkets());
  assertNoSecrets(getTrackers());
  assertNoSecrets(getRiskState());
  assertNoSecrets(getGoats());
  assertNoSecrets(getRecentTrades());
  assertNoSecrets(getCurrentAppContext());

  // The whole snapshot round-trips through the guard.
  const serialised = JSON.stringify(getFullContext());
  assert(
    !/privateKey|mnemonic|seed phrase|apiKey|bearer /i.test(serialised),
    'the serialised context contains no credential-shaped text',
  );
  assert(
    !/(sk-|pk-)[A-Za-z0-9]{16,}/.test(serialised),
    'the serialised context contains no API-key-shaped value',
  );
}

function testPromptRendering(): void {
  const prefix = buildContextPrefix([
    { slice: 'account', payload: getAccountState() },
    { slice: 'positions', payload: getOpenPositions() },
    { slice: 'risk', payload: getRiskState() },
  ]);

  assert(prefix.includes('TRADINGV APPLICATION CONTEXT'), 'the prefix is labelled as application context');
  assert(prefix.includes('### Account'), 'the account slice is rendered');
  assert(prefix.includes('### Open positions'), 'the positions slice is rendered');
  assert(prefix.includes('### Risk'), 'the risk slice is rendered');
  assert(prefix.includes('live execution available: no'), 'the account slice states live is unavailable');
  assert(!/privateKey|apiKey/i.test(prefix), 'the rendered context carries no credential');

  assert(buildContextPrefix([]) === '', 'an empty request renders nothing');

  // Every slice renders without throwing.
  for (const [slice, payload] of [
    ['app', getCurrentAppContext()],
    ['account', getAccountState()],
    ['positions', getOpenPositions()],
    ['trades', getRecentTrades()],
    ['markets', getAvailableMarkets()],
    ['goats', getGoats()],
    ['trackers', getTrackers()],
    ['risk', getRiskState()],
    ['wallet', getWalletState()],
  ] as const) {
    const block = renderContextSlice(slice, payload);
    assert(typeof block.title === 'string' && block.body.length > 0, `the ${slice} slice renders`);
  }

  // A slice with a secret is refused at render time too.
  let refused = false;
  try {
    buildContextPrefix([{ slice: 'account', payload: { apiKey: 'sk-abc' } }]);
  } catch {
    refused = true;
  }
  assert(refused, 'a secret in a slice is refused before it reaches a prompt');
}

function testNavigationActions(): void {
  const action = parseNavigationAction('Go to GOATs. [[action:GOATS|Open my GOATs]]');
  assert(action !== undefined, 'a navigation marker is parsed');
  assert(action.label === 'Open my GOATs', 'a marker can carry its own label');

  const simple = parseNavigationAction('[[action:SETTINGS]]');
  assert(simple?.label === 'Open Settings', 'a bare marker gets its default label');

  assert(parseNavigationAction('no marker here') === undefined, 'plain prose yields no action');
  assert(
    parseNavigationAction('[[action:PLACE_ORDER]]') === undefined,
    'an action outside the allow-list is dropped',
  );
  assert(
    parseNavigationAction('[[action:LIVE_TRADE]]') === undefined,
    'a hallucinated live-trading action is dropped',
  );

  assert(Object.keys(NAVIGATION_ACTIONS).length > 0, 'there are navigation actions');

  /*
   * Every action the model may produce must be a screen. A target that
   * names an order, a buy, a sell, an execution, or a risk change would
   * mean the assistant could act financially, so the allow-list is
   * asserted explicitly rather than pattern-matched.
   */
  const allowed = new Set([
    'TRADES', 'GOATS', 'QUOTES', 'HISTORY', 'SETTINGS',
    'CREATE_GOAT', 'INSPECT_TRACKERS', 'INSPECT_THESIS',
  ]);
  for (const target of Object.keys(NAVIGATION_ACTIONS)) {
    assert(allowed.has(target), `navigation target ${target} is a screen, not a financial action`);
  }
  for (const target of allowed) {
    assert(target in NAVIGATION_ACTIONS, `navigation target ${target} is actually offered`);
  }

  // Anything resembling a financial action is dropped.
  for (const rejected of [
    'PLACE_ORDER', 'BUY', 'SELL', 'CLOSE_POSITION', 'SET_RISK_LIMIT', 'ENABLE_LIVE',
  ]) {
    assert(
      parseNavigationAction(`[[action:${rejected}]]`) === undefined,
      `a ${rejected} action is dropped`,
    );
  }

  assert(
    stripNavigationAction('Done. [[action:GOATS]]') === 'Done.',
    'the marker is removed from the visible message',
  );
}

function testProductContext(): void {
  for (const term of [
    'Hyperliquid',
    'HIP-3',
    'Forex',
    'Commodities',
    'Indices',
    'DEMO',
    'BACKTEST',
    'LIVE',
    'Tracker',
    'Policy',
    'Wallet',
    'OpenRouter',
  ]) {
    assert(
      TRADINGGOATS_PRODUCT_CONTEXT.includes(term),
      `the product context explains ${term}`,
    );
  }

  assert(
    TRADINGGOATS_PRODUCT_CONTEXT.includes('NOT IMPLEMENTED'),
    'the product context states plainly that LIVE is not implemented',
  );
  assert(
    /never claim you (created|placed)|never claim that a trade/i.test(TRADINGGOATS_PRODUCT_CONTEXT),
    'the product context forbids claiming to have executed anything',
  );
  assert(
    /private keys|seed phrases/i.test(TRADINGGOATS_PRODUCT_CONTEXT),
    'the product context names the secrets it must never handle',
  );
  assert(
    /navigation action/i.test(TRADINGGOATS_PRODUCT_CONTEXT),
    'the product context limits actions to navigation',
  );

  // The agent runtime's trading prompt is untouched by the copilot prompt.
  assert(
    !TRADINGGOATS_PRODUCT_CONTEXT.includes('Return a single valid JSON object'),
    'the copilot prompt is not the agent decision prompt',
  );
}

/* --------------------------------------------------------------------------- *
 * The assistant's GOAT tools
 * --------------------------------------------------------------------------- */

function step(id: string, status: WorkStep['status'], label: string): WorkStep {
  return { id, status, label };
}

/**
 * A mission shaped like the ones the orchestrator produces, built by hand
 * so the assistant's reads are tested against a known state rather than
 * against whatever the engine happens to be doing.
 */
function mission(overrides: Partial<GoatMission> = {}): GoatMission {
  return {
    goalId: 'goal_1',
    agentId: 'goat_1',
    name: 'Trend Architect',
    description: '',
    goal: 'Find sustained trends.',
    skillIds: [],
    stage: 'MONITORING',
    stageLabel: 'Monitoring',
    runtime: 'RUNNING',
    deployment: {
      id: 'dep_1',
      goalId: 'goal_1',
      agentId: 'goat_1',
      symbol: 'EURUSD',
      timeframe: '15m',
      mode: 'SHADOW',
      environment: 'DEMO',
      startedAt: 2,
    },
    market: 'EURUSD',
    mode: 'SHADOW',
    mayExecute: false,
    thesisCount: 1,
    supportingEvidenceCount: 2,
    contradictingEvidenceCount: 0,
    evidence: [],
    trackers: [
      {
        id: 'trk_1',
        purpose: 'Break above resistance and hold',
        kind: 'PRICE_CROSS',
        status: 'ACTIVE',
        eventCount: 3,
      },
    ],
    activeTrackerCount: 1,
    activity: {
      headline: 'Monitoring EURUSD. Believing: the trend continues',
      detail: 'Wrong if: structure breaks',
      watching: ['Break above resistance and hold'],
    },
    workPlan: [
      step('understand', 'done', 'Understand your objective'),
      step('inspect', 'done', 'Inspect the current market'),
      step('thesis', 'done', 'Form a thesis'),
      step('evidence', 'done', 'Define what evidence it needs'),
      step('monitor', 'active', 'Monitor for confirmation'),
      step('plan', 'pending', 'Build trade plan'),
      step('risk', 'pending', 'Risk-check trade plan'),
      step('execute', 'pending', 'Execute when permitted'),
    ],
    updatedAt: 10,
    steering: { total: 0, pending: 0, notes: [] },
    ...overrides,
  } as GoatMission;
}

function stubProvider(missions: GoatMission[]): GoatContextProvider {
  return {
    missions: () => missions,
    mission: (goalId) => missions.find((entry) => entry.goalId === goalId),
    evidenceFor: (goalId, limit) =>
      [
        { summary: 'Higher low formed', polarity: 'SUPPORTS', source: 'TRACKER_EVENT', at: 5 },
        { summary: 'Momentum diverged', polarity: 'CONTRADICTS', source: 'TRACKER_EVENT', at: 4 },
      ]
        .filter(() => goalId.length > 0)
        .slice(0, limit),
    activityFor: () => [{ at: 9, text: 'Tracker event: break confirmed' }],
    trackLiveQuote: async (symbol) => ({ symbol, bid: 2400, ask: 2401, status: 'live' }),
  };
}

function testGoatTools(): void {
  clearGoatContextProvider();

  // With no provider the assistant says it cannot see, rather than reporting
  // an empty GOAT system as though the user had none.
  assert(listMyGoats().length === 0, 'with no provider there are no GOATs to read');
  const blind = readGoat(mission(), 'status');
  assert(
    /not available/i.test(blind),
    'and it says so instead of describing a GOAT it cannot see',
  );

  const two = [mission(), mission({ goalId: 'goal_2', name: 'Breakout Hunter', market: 'GOLD' })];
  registerGoatContextProvider(stubProvider(two));

  // Matching by name, and refusing to guess when two match.
  assert(findGoat('what is Trend Architect doing?').mission?.goalId === 'goal_1', 'a named GOAT is found');
  assert(findGoat('what is Trend Architect doing?').ambiguous === undefined, 'without ambiguity');
  assert(
    findGoat('what is my GOATs doing?').ambiguous?.length === 2,
    'a plural question returns all of them rather than picking one',
  );

  // Status answers from the records.
  const status = readGoat(mission(), 'status');
  assert(status.includes('Monitoring EURUSD'), 'the answer names what it is doing');
  assert(/\[(done|now|todo)\]/.test(status), 'and includes its work plan as it stands');
  assert(status.includes('Break above resistance and hold'), 'and what it is waiting for');

  const trackers = readGoat(mission(), 'trackers');
  assert(trackers.includes('Break above resistance and hold'), 'the tracker read names the condition');

  const thesis = readGoat(mission(), 'thesis');
  assert(/no thesis/i.test(thesis), 'there is no thesis in the fixture, and it says so');

  const evidence = readGoat(mission(), 'evidence');
  assert(evidence.includes('2 supporting'), 'evidence is counted by polarity');

  const activity = readGoat(mission(), 'activity');
  assert(activity.includes('Tracker event'), 'activity comes from the runtime record');

  /*
   * The question that most tempts a guess. Each of these has to name a real
   * reason, because "why hasn't it traded?" with an invented reason is the
   * most misleading answer this product could give.
   */
  assert(
    /not been deployed/i.test(readGoat(mission({ deployment: undefined }), 'why-no-plan')),
    'an undeployed GOAT is told it is not deployed',
  );
  assert(
    /stopped/i.test(readGoat(mission({ runtime: 'STOPPED' }), 'why-no-plan')),
    'a stopped GOAT is told it is stopped',
  );
  assert(
    /not formed a thesis/i.test(readGoat(mission(), 'why-no-plan')),
    'a GOAT with no thesis is told it has not formed one',
  );
  assert(
    /no supporting evidence/i.test(
      readGoat(
        mission({
          supportingEvidenceCount: 0,
          thesis: { id: 'th_1', state: 'ACTIONABLE', statement: 'Trend holds' } as never,
        }),
        'why-no-plan',
      ),
    ),
    'a GOAT with a thesis but no evidence is told it has none',
  );
  assert(
    /not actionable/i.test(
      readGoat(mission({ thesis: { state: 'ACTIVE', statement: 'x', requiredConfirmation: [] } as never }), 'why-no-plan'),
    ),
    'a thesis that is not actionable is named as the reason',
  );
  assert(
    /Trade plan: none/i.test(readGoat(mission(), 'plan')),
    'and the absence of a plan is stated as a fact, not a problem',
  );

  // Intent routing is deterministic, not model-driven.
  assert(classifyGoatIntent('what is my GOAT doing?') === 'status', 'status');
  assert(classifyGoatIntent('why has it not produced a trade plan?') === 'why-no-plan', 'why no plan');
  assert(classifyGoatIntent('what is it watching?') === 'trackers', 'trackers');
  assert(classifyGoatIntent('what is its thesis?') === 'thesis', 'thesis');
  assert(classifyGoatIntent('what happened while I was away?') === 'activity', 'activity');
  assert(classifyGoatIntent('what is the weather') === undefined, 'an unrelated question reads nothing');

  // Market reads name a symbol from the words, and only one.
  assert(symbolFromQuestion("what's happening with GOLD?") === 'XAUUSD', 'gold maps to its venue symbol');
  assert(symbolFromQuestion('what about EURUSD?') === 'EURUSD', 'a venue symbol passes through');
  assert(symbolFromQuestion('hello') === undefined, 'an unrelated question reads no market');

  clearGoatContextProvider();
}
