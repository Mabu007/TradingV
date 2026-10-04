export type QuoteStatus = 'LIVE' | 'STALE' | 'OFFLINE' | 'MOCK';

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  /**
   * The socket is open and the venue has said nothing for a while.
   *
   * A state rather than an absence, because the failure it describes is
   * invisible otherwise: the UI keeps showing a last-known price and
   * nothing in the interface says that price is from the past.
   */
  | 'STALE'
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
