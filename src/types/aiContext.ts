export type MainTab = 'goat' | 'quotes' | 'trades' | 'history' | 'settings';

export interface AIContext {
  currentTab: MainTab;
  selectedMarket?: string;
  selectedBotId?: string;
  selectedBotName?: string;
  selectedTradeId?: string;
  selectedPositionId?: string;
  accountBalance?: number;
  openPositionsCount?: number;
  activeBotsCount?: number;
  lastAction?: string;
}
