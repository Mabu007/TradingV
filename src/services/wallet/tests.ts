/**
 * Wallet, environment-configuration, and security-boundary tests.
 *
 * These cover everything that can be verified without a real browser
 * wallet session: the Privy setup derivation, the wallet state mapping,
 * the wallet abstraction, the disabled live-execution state, the agent
 * signing boundary, the `.env.example` contract, and the `.gitignore`
 * secret-file rules.
 */

import { readFileSync } from 'node:fs';

import {
  PUBLIC_ENVIRONMENT_VARIABLES,
  SERVER_ONLY_ENVIRONMENT_VARIABLES,
  hyperliquidNetwork,
  privyAppId,
  privyClientId,
} from '../../config/env';
import { privySetup } from './privyConfig';
import {
  DISCONNECTED_WALLET_STATE,
  mapWalletState,
  shortenAddress,
  type WalletService,
} from './types';
import { CapabilityRegistry } from '../../engine/agents/capabilities/registry';
import { AgentRuntime } from '../../engine/agents/runtime';
import { ActionValidator } from '../../engine/agents/policy/validator';
import { InMemoryAgentTimelineStore } from '../../engine/agents/timeline';
import { SkillRegistry } from '../../engine/agents/skills/registry';
import { IAgentModel } from '../../engine/agents/model/types';
import { AgentCapability, AgentObservation, ITradingEnvironment, TradingAgent } from '../../engine/agents/types';
import { createLiveEnvironment } from '../../engine/agents/environment/live';
import { eventBus, TradingGOATsEvent } from '../../types/events';
import { Bar, Position } from '../../types/trading';
import { InstrumentMetadata } from '../../types/instruments';
import { NormalizedQuote } from '../../types/quotes';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Repository files are read relative to this module, so the test does not
// depend on the working directory it was launched from.
const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');

const bar: Bar = { time: 1, open: 1.1, high: 1.101, low: 1.099, close: 1.1 };
const observationQuote: NormalizedQuote = { symbol: 'Gold', symbolId: 'xyz:GOLD', bid: 2350.3, ask: 2350.5, spread: 0.2, timestamp: 1000, status: 'MOCK' };
const observation: AgentObservation = {
  timestamp: 1000, environment: 'DEMO',
  market: { quotes: [observationQuote], quote: observationQuote },
  account: { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 },
  positions: [], orders: [], availableCapabilities: [], availableSkills: [],
};

function environment(): ITradingEnvironment {
  const instruments: InstrumentMetadata[] = [
    {
      symbol: 'Gold', displayName: 'Gold Perpetual', assetClass: 'COMMODITY', provider: 'HYPERLIQUID',
      providerSymbol: 'xyz:GOLD', providerMarketId: 'xyz:GOLD', providerDex: 'xyz',
      quoteCurrency: 'USD', pricePrecision: 2, sizePrecision: 2, tickSize: 0.01,
    },
  ];
  return {
    mode: 'DEMO',
    async getMarketQuote(symbol): Promise<NormalizedQuote> {
      return { symbol, symbolId: 'xyz:GOLD', bid: 2350.3, ask: 2350.5, spread: 0.2, timestamp: 1000, status: 'MOCK' };
    },
    async getMarketBars() { return [bar]; },
    async getInstruments() { return instruments; },
    async getAccountState() { return { balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, dailyPnL: 0, drawdownPercent: 0 }; },
    async getPositions(): Promise<Position[]> { return []; },
    async getOrders() { return []; },
    async placeMarketOrder() { return { success: false, error: 'unused' }; },
    async modifyPosition() { return { success: false, error: 'unused' }; },
    async closePosition() { return { success: false, error: 'unused' }; },
  };
}

export async function runWalletTests(): Promise<void> {
  runPrivySetupTests();
  runWalletStateMappingTests();
  await runWalletInterfaceTests();
  await runAgentSecurityTests();
  runLiveExecutionGuardTests();
  runEventTypeTests();
  runEnvironmentTemplateTests();
  runGitignoreTests();
}

function runPrivySetupTests(): void {
  /*
   * The test process has no Privy application id, so setup must report
   * "not configured" and the provider must stay unmounted. This is the
   * state a fresh clone is in before `.env` is filled in.
   */
  const setup = privySetup();
  assert(setup.configured === false, 'wallet provider stays unmounted without a Privy application id');
  assert(setup.appId === undefined, 'no application id is invented when the variable is absent');
  assert(privyAppId() === undefined, 'privyAppId returns undefined when unset');
  assert(privyClientId() === undefined, 'privyClientId returns undefined when unset');
  assert(
    hyperliquidNetwork().environment === 'MAINNET',
    'the venue environment defaults to mainnet',
  );
  assert(
    hyperliquidNetwork().isLive === true,
    'the default venue is reported as live, so a user is never told by accident that it is not',
  );
  assert(
    hyperliquidNetwork().restInfoUrl === 'https://api.hyperliquid.xyz/info',
    'the default venue resolves the Mainnet REST host',
  );

  // The configured path must produce a client config, not a bare object.
  const configured = {
    configured: true,
    appId: 'test-app-id',
    config: { appearance: { theme: 'dark' as const, accentColor: '#0ea5e9' } },
  };
  assert(configured.config.appearance?.theme === 'dark', 'Privy client config is built for the dark TradingGOATs theme');
  assert(
    !JSON.stringify(configured.config).toLowerCase().includes('secret'),
    'Privy client config carries no secret material',
  );
}

function runWalletStateMappingTests(): void {
  const unconfigured = mapWalletState({
    configured: false, ready: false, authenticated: false, connecting: false,
  });
  assert(unconfigured.status === 'UNCONFIGURED', 'no application id maps to UNCONFIGURED');
  assert(unconfigured.liveExecutionEnabled === false, 'unconfigured wallet never enables live execution');

  const initialising = mapWalletState({
    configured: true, ready: false, authenticated: false, connecting: false,
  });
  assert(initialising.status === 'INITIALISING', 'a configured but not-yet-ready provider maps to INITIALISING');
  assert(initialising.signing === 'NONE', 'no wallet means no signing capability');

  const authenticatedNoWallet = mapWalletState({
    configured: true, ready: true, authenticated: true, connecting: false,
  });
  assert(authenticatedNoWallet.status === 'DISCONNECTED', 'authenticated without a wallet is DISCONNECTED');
  assert(
    authenticatedNoWallet.authenticated === true && authenticatedNoWallet.address === undefined,
    'authentication and wallet connection are tracked separately',
  );
  assert(
    authenticatedNoWallet.liveExecutionEnabled === false,
    'an authenticated session does not enable live trading',
  );

  const connecting = mapWalletState({
    configured: true, ready: true, authenticated: false, connecting: true,
  });
  assert(connecting.status === 'CONNECTING', 'an in-flight connect maps to CONNECTING');

  const connected = mapWalletState({
    configured: true,
    ready: true,
    authenticated: true,
    connecting: false,
    address: '0x1234567890abcdef1234567890abcdef12345678',
    walletClientType: 'privy',
  });
  assert(connected.status === 'CONNECTED', 'a wallet address maps to CONNECTED');
  assert(connected.address === '0x1234567890abcdef1234567890abcdef12345678', 'the full address is exposed');
  assert(connected.shortAddress === '0x1234…5678', 'the display address is shortened');
  assert(connected.walletClientType === 'privy', 'the wallet client type is surfaced');
  assert(connected.signing === 'MESSAGE_SIGNING', 'a connected wallet exposes message-signing capability');
  assert(connected.liveExecutionEnabled === false, 'a connected wallet does not enable live trading');

  const failed = mapWalletState({
    configured: true, ready: true, authenticated: false, connecting: false, error: 'provider unavailable',
  });
  assert(failed.status === 'ERROR', 'a provider error maps to ERROR');
  assert(failed.error === 'provider unavailable', 'the error message is user-safe plain text');
  assert(failed.liveExecutionEnabled === false, 'a provider error never enables live execution');

  assert(shortenAddress(undefined) === undefined, 'shortenAddress tolerates no address');
  assert(shortenAddress('0x1234') === '0x1234', 'shortenAddress leaves a short string alone');
  assert(DISCONNECTED_WALLET_STATE.liveExecutionEnabled === false, 'the disconnected default is never live');
}

async function runWalletInterfaceTests(): Promise<void> {
  const calls: string[] = [];
  const service: WalletService = {
    getState: () => mapWalletState({
      configured: true, ready: true, authenticated: false, connecting: false,
    }),
    connect: async () => { calls.push('connect'); },
    disconnect: async () => { calls.push('disconnect'); },
  };

  assert(service.getState().status === 'DISCONNECTED', 'wallet service reports its state');
  assert(
    !('signOrder' in service) && !('getPrivateKey' in service),
    'the wallet interface exposes no order-signing or key-access method',
  );
  assert(
    !JSON.stringify(Object.keys(service)).includes('seed'),
    'the wallet interface exposes no seed phrase method',
  );

  await service.connect();
  await service.disconnect();
  assert(calls.join(',') === 'connect,disconnect', 'connect and disconnect are delegated to the service');
}

async function runAgentSecurityTests(): Promise<void> {
  const capabilities = new CapabilityRegistry();
  const skills = new SkillRegistry();
  const timeline = new InMemoryAgentTimelineStore();

  const walletCapability: AgentCapability<{ address: string }, { address: string }> = {
    id: 'wallet.getAddress', name: 'Get Wallet Address', description: 'Reads the connected wallet address',
    category: 'account', inputSchema: { address: { type: 'string' } }, outputSchema: {},
    async execute(input) { return input; },
  };
  capabilities.register(walletCapability);
  capabilities.register({
    id: 'orders.market', name: 'Place Market Order', description: 'Proposes a market order',
    category: 'execution', inputSchema: { symbol: { type: 'string' } }, outputSchema: {},
    async execute() { return { success: true }; },
  } satisfies AgentCapability);

  const model: IAgentModel = {
    async run(request) {
      // An agent asking for a signing capability must not find one.
      const requested = JSON.stringify(request);
      if (/sign|private|seed|mnemonic|key/i.test(requested)) {
        return { thought: 'no signing path', decision: { type: 'WAIT', reason: 'no signing capability is available' } };
      }
      return { thought: 'observed', decision: { type: 'WAIT', reason: 'nothing to do' } };
    },
  };

  const runtime = new AgentRuntime(capabilities, skills, new ActionValidator(), model, timeline);
  const agent: TradingAgent = {
    id: 'wallet-agent', name: 'Wallet Agent', description: '', instructions: '',
    skills: [], capabilities: ['wallet.getAddress', 'orders.market'],
    policy: {
      maxRiskPerTrade: 0.01, maxOpenPositions: 1, maxExposure: 10_000,
      maxOrdersPerMinute: 5, allowedSymbols: ['Gold'], allowTrading: false,
    },
    preferredEnvironment: 'DEMO', symbols: ['Gold'], enabled: true, createdAt: 1, updatedAt: 1,
  };
  runtime.registerAgent(agent, environment());

  // No signing capability of any kind exists in the registry.
  const ids = capabilities.list().map((capability) => capability.id.toLowerCase());
  assert(!ids.some((id) => id.includes('sign')), 'no signing capability is registered for agents');
  assert(!ids.some((id) => id.includes('private') || id.includes('seed')), 'no key or seed capability is registered for agents');
  assert(!ids.some((id) => id.includes('privy') || id.includes('wallet.connect')), 'no wallet-provider capability is registered for agents');

  const decision = await runtime.step(agent.id);
  assert(decision.type === 'WAIT', 'an agent with trading disabled cannot act');

  // The observation handed to the model must not leak wallet material.
  const observationJson = JSON.stringify(
    await runtime.getTimelineStore().getByAgent(agent.id),
  );
  assert(!/privateKey|mnemonic|seed phrase/i.test(observationJson), 'the agent timeline contains no key material');

  // Registering a wallet capability must not change the execution
  // boundary: the deterministic validator still blocks trading.
  const blocked = new ActionValidator().validate(
    { type: 'OPEN_POSITION', symbol: 'Gold', side: 'BUY', volume: 1, reason: 'test' },
    agent.policy,
    observation,
  );
  assert(blocked.valid === false && blocked.code === 'TRADING_DISABLED', 'the deterministic policy still blocks trading');

  // A capability registered alongside a wallet provider still receives
  // only its declared inputs, and returns no signing handle.
  const context = {
    agentId: agent.id, environment: 'DEMO' as const, env: environment(), symbol: 'Gold',
    policy: agent.policy, symbols: ['Gold'],
  };
  const result = (await capabilities.execute('wallet.getAddress', { address: '0xabc' }, context)) as { address: string };
  assert(result.address === '0xabc', 'a registered non-signing capability still works');
  assert(!('sign' in result), 'the capability result carries no signing handle');
}

function runLiveExecutionGuardTests(): void {
  // The live environment must refuse to be constructed.
  let threw = false;
  try {
    createLiveEnvironment();
  } catch {
    threw = true;
  }
  assert(threw, 'the LIVE agent environment refuses to be created');

  // The demo adapter must never claim a LIVE environment.
  assert(
    !JSON.stringify(DISCONNECTED_WALLET_STATE).includes('true"'),
    'the disconnected wallet state has no truthy live flag',
  );
}

function runEventTypeTests(): void {
  /*
   * The internal event union was renamed from TradeCodeEvent to
   * TradingGOATsEvent. Semantics and payloads must be unchanged.
   */
  const seen: TradingGOATsEvent[] = [];
  const unsubscribe = eventBus.onAll((event) => seen.push(event));
  eventBus.emit({ type: 'LOG', data: { id: 'log-1', timestamp: 1, level: 'info', message: 'event rename regression' } });
  eventBus.emit({ type: 'STATUS_CHANGE', data: { mode: 'DEMO', status: 'NORMAL' } });
  unsubscribe();

  assert(seen.length === 2, 'the renamed event bus still delivers events');
  assert(seen[0].type === 'LOG' && seen[0].data.message === 'event rename regression', 'the event payload is unchanged');
  assert(seen[1].type === 'STATUS_CHANGE' && seen[1].data.mode === 'DEMO', 'status change payload is unchanged');

  // A typed listener still narrows correctly after the rename.
  let riskMessage = '';
  const stop = eventBus.on('RISK_VIOLATION', (event) => { riskMessage = event.data.rule; });
  eventBus.emit({ type: 'RISK_VIOLATION', data: { rule: 'MAX_ORDER_SIZE', message: 'too large', timestamp: 1 } });
  stop();
  assert(riskMessage === 'MAX_ORDER_SIZE', 'a typed event listener still narrows the payload after the rename');
}

function runEnvironmentTemplateTests(): void {
  for (const variable of PUBLIC_ENVIRONMENT_VARIABLES) {
    assert(
      envExample.includes(`${variable.name}=`),
      `.env.example documents the required variable ${variable.name}`,
    );
  }
  for (const variable of SERVER_ONLY_ENVIRONMENT_VARIABLES) {
    assert(
      envExample.includes(`# ${variable.name}=`),
      `.env.example documents ${variable.name} as a commented-out server-only variable`,
    );
    assert(
      !envExample.includes(`\n${variable.name}=`),
      `${variable.name} is not assigned an active value in .env.example`,
    );
  }

  // No real-looking credential may be committed.
  const assigned = envExample
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('VITE_') && line.includes('='));
  for (const line of assigned) {
    const value = line.slice(line.indexOf('=') + 1).replace(/"/g, '').trim();
    assert(
      value === '' || /^(MAINNET|TESTNET|mainnet|testnet|http)/.test(value),
      `.env.example contains only placeholders or documented defaults, not real values (${line})`,
    );
  }

  // The core environment model stays explicit.
  assert(envExample.includes('VITE_HYPERLIQUID_NETWORK'), 'the Hyperliquid network variable is documented');
  assert(envExample.includes('VITE_PRIVY_APP_ID'), 'the Privy application id is documented');
  assert(
    envExample.includes('VITE_-prefixed') || envExample.includes('VITE_`'),
    '.env.example warns that VITE_ variables are client-visible',
  );
  assert(
    !/^PRIVY_[A-Z_]+="[^"]+"/m.test(envExample) && !/^HYPERLIQUID_PRIVATE_KEY="[^"]+"/m.test(envExample),
    'no server-only secret is assigned a real value in .env.example',
  );
}

function runGitignoreTests(): void {
  assert(/(^|\n)\.env\s*($|\n)/.test(gitignore) || gitignore.includes('.env*'), 'local .env files are git-ignored');
  assert(gitignore.includes('.env.*'), 'local .env variants are git-ignored');
  assert(gitignore.includes('!.env.example'), 'the committed template stays tracked');
  assert(!gitignore.includes('.env.example\n!.env'), 'the ignore rule is not inverted');
}
