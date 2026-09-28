export type QuoteStatus = 'LIVE' | 'STALE' | 'OFFLINE' | 'MOCK';

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR';

export type TradingEnvironment = 'DEMO' | 'LIVE';

export interface NormalizedQuote {
  symbol: string;
  symbolId: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
  change24h?: number;
  changePercent24h?: number;
  status: QuoteStatus;
}

export interface TradingAccount {
  accountId: string;
  accountNumber: string;
  brokerTitle: string;
  currency: string;
  balance: number;
  isLive: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  environment: TradingEnvironment;
  accountId?: string;
  tokenExpiresAt?: number;
}
