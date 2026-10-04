export {
  assertNoSecrets,
  ContextSecurityError,
  type AccountContext,
  type AppContext,
  type AssetClass,
  type GoatContext,
  type ContextSlice,
  type MarketContext,
  type PositionContext,
  type RiskLimitsContext,
  type RiskState,
  type TradeContext,
  type TrackerContext,
  type WalletContext,
} from './types';

export { appContextStore, type AppContextState } from './store';

export {
  AI_CONTEXT_TOOLS,
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
} from './tools';

export {
  buildContextPrefix,
  renderContextSlice,
  TRADINGGOATS_PRODUCT_CONTEXT,
} from './prompt';

export {
  classifyGoatIntent,
  clearGoatContextProvider,
  findGoat,
  hasGoatContextProvider,
  listMyGoats,
  readGoat,
  readLiveMarket,
  registerGoatContextProvider,
  symbolFromQuestion,
  type GoatContextProvider,
  type GoatIntent,
} from './goatTools';

export {
  NAVIGATION_ACTIONS,
  parseNavigationAction,
  stripNavigationAction,
  type NavigationAction,
  type NavigationTarget,
} from './navigation';
