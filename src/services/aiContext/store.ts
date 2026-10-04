/**
 * Application context store.
 *
 * The App publishes a snapshot of what it already knows; the AI tools read
 * from it. Keeping the two apart means the assistant can never reach into
 * React state, the execution adapter, or the wallet provider - it can
 * only read the sanitised projection published here.
 *
 * Publishing is shallow-merged per slice so an unrelated tick does not
 * invalidate the whole snapshot.
 */

import type {
  AccountContext,
  AppContext,
  GoatContext,
  MarketContext,
  PositionContext,
  RiskLimitsContext,
  RiskState,
  TradeContext,
  TrackerContext,
  WalletContext,
} from './types';
import type { ExecutionMode } from '../../types/trading';
import type { MainTab } from '../../types/aiContext';

const EMPTY_ACCOUNT: AccountContext = {
  balance: 0,
  equity: 0,
  marginUsed: 0,
  freeMargin: 0,
  unrealizedPnL: 0,
  realizedPnlToday: 0,
  openPositions: 0,
  openTrades: 0,
  runningGoats: 0,
  environment: 'DEMO',
  liveExecutionAvailable: false,
  accountCurrency: 'USD',
  riskState: 'NORMAL',
};

const EMPTY_RISK: RiskLimitsContext = {
  maxOrderSize: 0,
  maxOpenPositions: 0,
  maxExposureNotional: 0,
  maxOrdersPerMinute: 0,
  maxDailyLoss: 0,
  killSwitchActive: false,
};

const EMPTY_WALLET: WalletContext = {
  status: 'UNCONFIGURED',
  authenticated: false,
  configured: false,
  liveExecutionEnabled: false,
};

export interface AppContextState {
  currentTab: MainTab;
  currentView: string;
  selectedMarket?: string;
  selectedTimeframe?: string;
  selectedGoatId?: string;
  executionMode: ExecutionMode;
  openModal?: string;
  account: AccountContext;
  positions: PositionContext[];
  trades: TradeContext[];
  markets: MarketContext[];
  goats: GoatContext[];
  trackers: TrackerContext[];
  riskLimits: RiskLimitsContext;
  wallet: WalletContext;
}

function initialState(): AppContextState {
  return {
    currentTab: 'trades',
    currentView: 'Trades',
    executionMode: 'DEMO',
    account: { ...EMPTY_ACCOUNT },
    positions: [],
    trades: [],
    markets: [],
    goats: [],
    trackers: [],
    riskLimits: { ...EMPTY_RISK },
    wallet: { ...EMPTY_WALLET },
  };
}

class AppContextStore {
  private state: AppContextState = initialState();

  /** Shallow-merge a partial snapshot. Unknown slices are left alone. */
  publish(patch: Partial<AppContextState>): void {
    this.state = {
      ...this.state,
      ...patch,
      account: patch.account
        ? { ...this.state.account, ...patch.account }
        : this.state.account,
      riskLimits: patch.riskLimits
        ? { ...this.state.riskLimits, ...patch.riskLimits }
        : this.state.riskLimits,
      wallet: patch.wallet
        ? { ...this.state.wallet, ...patch.wallet }
        : this.state.wallet,
    };
  }

  /** Full snapshot. Always a copy, so callers cannot mutate the store. */
  snapshot(): AppContextState {
    return {
      ...this.state,
      account: { ...this.state.account },
      riskLimits: { ...this.state.riskLimits },
      wallet: { ...this.state.wallet },
      positions: [...this.state.positions],
      trades: [...this.state.trades],
      markets: [...this.state.markets],
      goats: [...this.state.goats],
      trackers: [...this.state.trackers],
    };
  }

  reset(): void {
    this.state = initialState();
  }
}

export const appContextStore = new AppContextStore();

export type { RiskState };
