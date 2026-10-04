/**
 * The TRADES view, and the detail behind each row.
 *
 * ## Why trades need their own view
 *
 * The activity log answers "what has this GOAT been doing". A trade answers a
 * different question — "did it make money, and was the reasoning any good" — and
 * the two have different shapes. An activity line is one sentence about one moment;
 * a trade spans hours of simulated time and has an entry, a stop, a target, a
 * duration and a result. Forcing that into a single line either loses the numbers
 * or makes the log unreadable.
 *
 * So trades are shown as records, newest first, each one clickable into the full
 * account of what was intended and what happened.
 *
 * ## Honesty in the display
 *
 * Two rules, both learned the hard way in the engine:
 *
 *   1. **A resting order says PENDING, not FILLED.** A trade that has not been
 *      filled has no entry price and no result, and showing a P/L next to one is
 *      the single most misleading thing this component could render.
 *   2. **A refusal shows its reason.** A rejected plan is a legitimate outcome and
 *      often the most instructive line in the list — it is the risk layer declining
 *      a bad idea, which is the product working.
 */

import React, { useMemo, useState } from 'react';

import type { TradeRecord, TradeStatistics } from '../../engine/goat/tradeEngine';

export interface TradeLogProps {
  trades: TradeRecord[];
  statistics?: TradeStatistics;
  /** The market's own price unit name, when it has one. Never assumed. */
  unitLabel?: string;
  /** Opens a trade in the GOAT conversation, for analysis. */
  onAnalyseTrade?: (trade: TradeRecord) => void;
  className?: string;
}

/** The one-word state a row leads with. */
function statusWord(status: TradeRecord['status']): string {
  switch (status) {
    case 'PENDING':
      return 'PENDING';
    case 'RUNNING':
    case 'FILLED':
      return 'RUNNING';
    case 'TAKE_PROFIT':
      return 'TAKE PROFIT';
    case 'STOPPED_OUT':
      return 'STOP LOSS';
    case 'EXITED':
      return 'EXITED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return status;
  }
}

const TONE: Record<TradeRecord['status'], string> = {
  PENDING: 'text-ink-3 border-line',
  FILLED: 'text-accent border-accent/40',
  RUNNING: 'text-accent border-accent/40',
  TAKE_PROFIT: 'text-pos border-pos/40',
  STOPPED_OUT: 'text-neg border-neg/40',
  EXITED: 'text-ink-2 border-line',
  EXPIRED: 'text-ink-4 border-line',
  CANCELLED: 'text-ink-4 border-line',
  REJECTED: 'text-warn border-warn/40',
  PROPOSED: 'text-ink-3 border-line',
};

function price(value: number | undefined, digits = 5): string {
  return value === undefined ? '—' : value.toFixed(digits);
}

function signed(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

/** A duration in words, because "4821s" is not readable. */
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

export function TradeLog({
  trades,
  statistics,
  unitLabel,
  onAnalyseTrade,
  className,
}: TradeLogProps): React.ReactElement {
  const [selected, setSelected] = useState<string | undefined>();
  const open = trades.find((trade) => trade.id === selected);

  /*
   * Newest first, because a reader arriving mid-replay is asking "what just
   * happened", and the newest row is the answer. A trade log that grows downwards
   * makes the reader scroll to learn what the GOAT just did.
   */
  const ordered = useMemo(() => [...trades].reverse(), [trades]);

  return (
    <section className={`flex flex-col ${className ?? ''}`} data-testid="trade-log">
      <header className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h3 className="font-mono text-[10px] tracking-[0.18em] text-ink-4">TRADES</h3>
        {statistics && <TradeSummary statistics={statistics} unitLabel={unitLabel} />}
      </header>

      {ordered.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface px-4 py-6 text-center text-[11px] leading-relaxed text-ink-4">
          No trade yet. This GOAT places an order only when its own analysis produces one, so an empty
          list can mean it is still researching — or that the price it wants has not been reached.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ordered.map((trade) => (
            <li key={trade.id}>
              <button
                type="button"
                onClick={() => setSelected(trade.id === selected ? undefined : trade.id)}
                aria-expanded={trade.id === selected}
                data-testid={`trade-row-${trade.id}`}
                className={`w-full rounded-xl border bg-surface px-3 py-2 text-left transition-colors hover:border-accent/50 ${
                  TONE[trade.status]
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] tracking-[0.14em]">
                    {trade.id.replace('trade_', '#')} · {trade.side === 'BUY' ? 'BUY' : 'SELL'} {trade.orderType}
                  </span>
                  <span className="font-mono text-[10px] tracking-[0.14em]">{statusWord(trade.status)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-ink-4">
                  <span>{trade.symbol}</span>
                  {/* The price shown is the fill when there is one and the offer when there is not. */}
                  <span>{price(trade.fillPrice ?? trade.proposedEntry)}</span>
                  <span>SL {price(trade.stopLoss)}</span>
                  {trade.takeProfit !== undefined && <span>TP {price(trade.takeProfit)}</span>}
                  {/* No P/L for a trade that has not closed. Rendering one anyway is the lie this component exists to avoid. */}
                  {trade.pnl !== undefined && (
                    <span className={trade.pnl >= 0 ? 'text-pos' : 'text-neg'}>
                      {signed(trade.pnl)}
                      {unitLabel ? ` ${unitLabel}` : ''}
                    </span>
                  )}
                </div>
              </button>

              {trade.id === selected && (
                <TradeDetail trade={trade} unitLabel={unitLabel} onAnalyseTrade={onAnalyseTrade} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The headline numbers, kept small on purpose — the timeline is the point. */
function TradeSummary({ statistics, unitLabel }: { statistics: TradeStatistics; unitLabel?: string }): React.ReactElement {
  const settled = statistics.wins + statistics.losses;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-ink-4">
      <span>{statistics.trades} trade{statistics.trades === 1 ? '' : 's'}</span>
      {/* The win rate carries its sample size, so "100%" over one trade cannot be read as a record. */}
      {statistics.winRate !== undefined && (
        <span>
          {statistics.winRate.toFixed(0)}% of {settled}
        </span>
      )}
      {statistics.totalPnl !== 0 && (
        <span className={statistics.totalPnl >= 0 ? 'text-pos' : 'text-neg'}>
          {signed(statistics.totalPnl)}
          {unitLabel ? ` ${unitLabel}` : ''}
        </span>
      )}
      {statistics.pending > 0 && <span>{statistics.pending} waiting</span>}
      {statistics.expired > 0 && <span>{statistics.expired} expired</span>}
    </div>
  );
}

/**
 * Everything about one trade.
 *
 * Ordered the way the trade happened rather than by category, because the reader's
 * question is chronological: what did it believe, what did it want, what did it get,
 * and what came of it.
 */
export function TradeDetail({
  trade,
  unitLabel,
  onAnalyseTrade,
}: {
  trade: TradeRecord;
  unitLabel?: string;
  onAnalyseTrade?: (trade: TradeRecord) => void;
}): React.ReactElement {
  const riskReward = trade.riskReward;

  return (
    <div
      className="mt-1.5 rounded-xl border border-line bg-surface-2/40 px-3 py-3 text-[11px] leading-relaxed text-ink-3"
      data-testid={`trade-detail-${trade.id}`}
    >
      <Row label="STATUS">
        {statusWord(trade.status)}
        {trade.rejectionReason ? ` — ${trade.rejectionReason}` : ''}
      </Row>

      <Row label="SETUP">{trade.reason}</Row>
      <Row label="WRONG IF">{trade.invalidation}</Row>

      <Row label="ENTRY">
        {trade.fillPrice !== undefined ? (
          <>
            filled at {price(trade.fillPrice)}
            {trade.fillPrice !== trade.proposedEntry && (
              <span className="text-ink-4"> (offered {price(trade.proposedEntry)})</span>
            )}
          </>
        ) : (
          <>
            proposed {price(trade.proposedEntry)}
            {trade.secondsWaiting !== undefined && (
              <span className="text-ink-4"> · waiting {duration(trade.secondsWaiting)}</span>
            )}
          </>
        )}
      </Row>

      <Row label="RISK">
        SL {price(trade.stopLoss)} · risk {price(Math.abs(trade.proposedEntry - trade.stopLoss))}
        {trade.takeProfit !== undefined && (
          <>
            {' '}
            · reward {price(Math.abs(trade.takeProfit - trade.proposedEntry))}
          </>
        )}
        {riskReward !== undefined && <> · {riskReward.toFixed(2)}R</>}
      </Row>

      {trade.pnl !== undefined && (
        <Row label="RESULT">
          <span className={trade.pnl >= 0 ? 'text-pos' : 'text-neg'}>
            {signed(trade.pnl)}
            {unitLabel ? ` ${unitLabel}` : ''}
            {trade.pnlPercent !== undefined && ` (${signed(trade.pnlPercent)}%)`}
          </span>
          {trade.exitReason ? ` · ${trade.exitReason}` : ''}
          {trade.secondsHeld !== undefined ? ` · held ${duration(trade.secondsHeld)}` : ''}
        </Row>
      )}

      {onAnalyseTrade && (
        <button
          type="button"
          onClick={() => onAnalyseTrade(trade)}
          data-testid={`analyse-trade-${trade.id}`}
          className="mt-2 rounded-md border border-line px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-ink-3 transition-colors hover:border-accent/50 hover:text-ink-2"
        >
          AI ANALYSE TRADE
        </button>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-16 shrink-0 font-mono text-[9px] tracking-[0.14em] text-ink-4">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export default TradeLog;