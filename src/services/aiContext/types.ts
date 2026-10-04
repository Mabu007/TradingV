/**
 * Read-only application context for the AI assistant.
 *
 * The assistant answers questions about *this* application: where things
 * are, what the account looks like, which markets exist, why a bot did
 * not trade. To do that it needs a view of current state.
 *
 * Two rules govern everything in this file:
 *
 * 1. **Read-only.** Every reader is a pure projection of state the app
 *    already has. Nothing here can place, modify, or close anything.
 *    There is no write path, and no tool that reaches the execution
 *    adapter, the risk manager, or the agent runtime.
 *
 * 2. **No secrets, ever.** The snapshot shape below has no field for a
 *    private key, seed phrase, signing secret, or API key, and
 *    `assertNoSecrets` is applied to every payload that leaves this
 *    module. The wallet contributes connection *state* and a public
 *    address only. A connected wallet does not change the execution
 *    environment and is never reported as enabling live trading.
 */

import { AssetClass, InstrumentAvailability } from '../../types/instruments';

export type { AssetClass, InstrumentAvailability };
import { ExecutionMode } from '../../types/trading';
import { MainTab } from '../../types/aiContext';

export type RiskState = 'NORMAL' | 'DRAWDOWN_GUARD' | 'KILL_SWITCH' | 'EXPOSURE_LIMITED';

export interface AccountContext {
  balance: number;
  equity: number;
  marginUsed: number;
  freeMargin: number;
  unrealizedPnL: number;
  realizedPnlToday: number;
  openPositions: number;
  openTrades: number;
  runningGoats: number;
  environment: ExecutionMode;
  liveExecutionAvailable: false;
  accountCurrency: string;
  riskState: RiskState;
}

export interface PositionContext {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnL: number;
  unrealizedPnlPercent: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  goatId?: string;
  goatName?: string;
}

export interface TradeContext {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
  goatId?: string;
  goatName?: string;
}

export interface MarketContext {
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  providerSymbol: string;
  availability: InstrumentAvailability;
  unavailableReason?: string;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  change24h?: number;
  pricePrecision?: number;
  sizePrecision?: number;
  sizeStep?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
  maxLeverage?: number;
  quoteCurrency?: string;
}

/**
 * A GOAT as the assistant sees it.
 *
 * There is no tracker list, because a GOAT has none in its definition:
 * what it watches is decided at runtime from its thesis and reported
 * separately, if at all. What the assistant needs is what the user
 * wants and what the agent has chosen to do about it.
 */
export interface GoatContext {
  id: string;
  /** The user's objective, in their words. */
  statement: string;
  status: string;
  /** A starter template is a proposal, not a deployed GOAT. */
  source?: 'starter' | 'user' | 'cloned';
  skills: string[];
  /** What the GOAT is currently watching, when it has said so. */
  watching?: number;
  lastActivity?: number;
}

export interface TrackerContext {
  id: string;
  name: string;
  type: string;
  goatId?: string;
  symbol?: string;
  timeframe?: string;
  enabled: boolean;
  cooldownMs?: number;
  maxEventsPerMinute?: number;
  summary: string;
  lastEventAt?: number;
  lastReason?: string;
  eventCount: number;
}

export interface RiskLimitsContext {
  maxOrderSize: number;
  maxOpenPositions: number;
  maxExposureNotional: number;
  maxOrdersPerMinute: number;
  maxDailyLoss: number;
  killSwitchActive: boolean;
}

export interface WalletContext {
  /** Connection state only. Never a credential, never a capability. */
  status: string;
  authenticated: boolean;
  address?: string;
  shortAddress?: string;
  configured: boolean;
  /** Always false: connecting a wallet does not enable live trading. */
  liveExecutionEnabled: false;
}

export interface AppContext {
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

export type ContextSlice =
  | 'app'
  | 'account'
  | 'positions'
  | 'trades'
  | 'markets'
  | 'goats'
  | 'trackers'
  | 'risk'
  | 'wallet';

/**
 * Keys that must never appear in any AI payload.
 *
 * Checked by `assertNoSecrets`, which runs over the serialised form of
 * every tool result, so a future field cannot quietly leak.
 */
const FORBIDDEN_KEY_PATTERN =
  /(private.?key|secret|mnemonic|seed.?phrase|signing.?key|api.?key|bearer|authorization|token|credential|password|passphrase)/i;

/*
 * Value shapes that indicate a credential rather than application data.
 *
 * A public 0x address (exactly 40 hex characters) is legitimate and must
 * pass, because the wallet contributes its address. Anything that is a
 * 32-byte private key, a long unlabelled base64 blob, or a provider key
 * prefix is refused.
 */
const RAW_SECRET_HEX = /^(0x)?[0-9a-fA-F]{64,}$/;
const BASE64_SECRET = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const PROVIDER_KEY = /\b(sk|pk|rk|api|key)-[A-Za-z0-9_-]{12,}\b/;

function isForbiddenValue(value: string): boolean {
  if (RAW_SECRET_HEX.test(value)) return true;
  if (PROVIDER_KEY.test(value)) return true;
  // A 0x-prefixed 40-character address is a public address, not a key.
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  return BASE64_SECRET.test(value);
}

export class ContextSecurityError extends Error {
  constructor(key: string) {
    super(`Refusing to expose "${key}" in AI context.`);
    this.name = 'ContextSecurityError';
  }
}

/**
 * Reject any payload containing a credential-shaped key or value.
 *
 * This is a backstop, not the primary defence: the snapshot types have no
 * such fields. It exists so a future edit that adds one fails loudly
 * instead of shipping user secrets to a third-party model.
 */
export function assertNoSecrets(payload: unknown, path = 'context'): void {
  const visit = (value: unknown, trail: string): void => {
    if (typeof value === 'string') {
      if (isForbiddenValue(value)) {
        throw new ContextSecurityError(`${trail} (value)`);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${trail}[${index}]`));
      return;
    }

    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_KEY_PATTERN.test(key)) {
          throw new ContextSecurityError(`${trail}.${key}`);
        }
        visit(nested, `${trail}.${key}`);
      }
    }
  };

  visit(payload, path);
}
