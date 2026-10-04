/**
 * AI context tools.
 *
 * Narrow, read-only readers. The assistant asks for the slice it needs
 * rather than receiving the whole application state in every prompt,
 * which keeps prompts small and makes it obvious what the model was
 * actually shown.
 *
 * Every result passes through `assertNoSecrets` before it is returned, so
 * no tool can leak a credential even if a caller publishes one by mistake.
 */

import { appContextStore } from './store';
import {
  assertNoSecrets,
  type AccountContext,
  type AppContext,
  type GoatContext,
  type MarketContext,
  type PositionContext,
  type RiskLimitsContext,
  type TradeContext,
  type TrackerContext,
  type WalletContext,
} from './types';

function guard<T>(value: T, name: string): T {
  assertNoSecrets(value, name);
  return value;
}

export function getCurrentAppContext(): Pick<
  AppContext,
  | 'currentTab'
  | 'currentView'
  | 'selectedMarket'
  | 'selectedTimeframe'
  | 'selectedGoatId'
  | 'executionMode'
  | 'openModal'
> {
  const state = appContextStore.snapshot();
  return guard(
    {
      currentTab: state.currentTab,
      currentView: state.currentView,
      selectedMarket: state.selectedMarket,
      selectedTimeframe: state.selectedTimeframe,
      selectedGoatId: state.selectedGoatId,
      executionMode: state.executionMode,
      openModal: state.openModal,
    },
    'appContext',
  );
}

export function getAccountState(): AccountContext {
  return guard({ ...appContextStore.snapshot().account }, 'account');
}

export function getOpenPositions(): PositionContext[] {
  return guard([...appContextStore.snapshot().positions], 'positions');
}

export function getRecentTrades(limit = 20): TradeContext[] {
  const trades = appContextStore.snapshot().trades;
  return guard(
    trades
      .slice()
      .sort((left, right) => right.exitTime - left.exitTime)
      .slice(0, Math.max(1, limit)),
    'trades',
  );
}

export function getAvailableMarkets(filter?: {
  assetClass?: MarketContext['assetClass'];
  tradeableOnly?: boolean;
  search?: string;
}): MarketContext[] {
  const search = filter?.search?.trim().toLowerCase();
  const markets = appContextStore
    .snapshot()
    .markets.filter((market) => {
      if (filter?.assetClass && market.assetClass !== filter.assetClass) {
        return false;
      }
      if (filter?.tradeableOnly && market.availability !== 'TRADEABLE') {
        return false;
      }
      if (search) {
        const haystack = `${market.symbol} ${market.displayName} ${market.providerSymbol}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

  return guard(markets, 'markets');
}

export function getMarketQuote(symbol: string): MarketContext | undefined {
  const markets = appContextStore.snapshot().markets;
  const wanted = symbol.trim().toLowerCase();
  const match = markets.find(
    (market) =>
      market.symbol.toLowerCase() === wanted ||
      market.providerSymbol.toLowerCase() === wanted ||
      market.displayName.toLowerCase() === wanted,
  );
  return match ? guard(match, 'marketQuote') : undefined;
}

export function getGoats(): GoatContext[] {
  return guard([...appContextStore.snapshot().goats], 'goats');
}

export function getGoat(goatId: string): GoatContext | undefined {
  const goat = appContextStore
    .snapshot()
    .goats.find((candidate) => candidate.id === goatId);
  return goat ? guard(goat, 'goat') : undefined;
}

export function getTrackers(goatId?: string): TrackerContext[] {
  const trackers = appContextStore.snapshot().trackers;
  const scoped = goatId
    ? trackers.filter((tracker) => tracker.goatId === goatId)
    : trackers;
  return guard([...scoped], 'trackers');
}

export function getRiskState(): {
  limits: RiskLimitsContext;
  state: AccountContext['riskState'];
  openPositions: number;
  unrealizedPnl: number;
} {
  const { account, riskLimits } = appContextStore.snapshot();
  return guard(
    {
      limits: { ...riskLimits },
      state: account.riskState,
      openPositions: account.openPositions,
      unrealizedPnl: account.unrealizedPnL,
    },
    'risk',
  );
}

/**
 * Wallet state, for "did I connect?" questions.
 *
 * Returns connection *state* and a public address. It can never return a
 * credential, and `liveExecutionEnabled` is typed `false` so connecting a
 * wallet can never be reported as enabling live trading.
 */
export function getWalletState(): WalletContext {
  return guard({ ...appContextStore.snapshot().wallet }, 'wallet');
}

/** Everything, for the rare "give me the whole picture" question. */
export function getFullContext(): AppContext {
  return guard(appContextStore.snapshot(), 'fullContext');
}

/** Tool catalogue, so the UI can list what the assistant can actually read. */
export const AI_CONTEXT_TOOLS = [
  { name: 'getCurrentAppContext', reads: 'page, tab, selected market, environment' },
  { name: 'getAccountState', reads: 'balance, equity, margin, P&L, risk state' },
  { name: 'getOpenPositions', reads: 'open positions and their levels' },
  { name: 'getRecentTrades', reads: 'closed trades and realized P&L' },
  { name: 'getAvailableMarkets', reads: 'discovered instruments and availability' },
  { name: 'getMarketQuote', reads: 'one market: bid, ask, precision, size limits' },
  { name: 'getGoats', reads: 'goal list, status, market, risk profile' },
  { name: 'getGoat', reads: 'one GOAT in detail' },
  { name: 'getTrackers', reads: 'tracker definitions and recent observations' },
  { name: 'getRiskState', reads: 'deterministic risk limits and current state' },
  { name: 'getWalletState', reads: 'wallet connection state (never credentials)' },
] as const;
