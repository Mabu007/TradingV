import { Trade } from '../types/trading';

export interface CSVExportMetadata {
  strategyName?: string;
  symbol?: string;
  timeframe?: string;
  initialBalance?: number;
  finalEquity?: number;
  netProfit?: number;
}

/**
 * Converts a timestamp (seconds or milliseconds) to an ISO 8601 formatted date-time string.
 */
function formatTimestamp(timestamp: number): string {
  if (!timestamp) return '';
  const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/**
 * Escapes CSV field value according to RFC 4180
 */
function escapeCSVField(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates and triggers download of a standardized CSV file containing
 * the transaction log / trades for external analysis in Excel, Python (pandas), R, etc.
 */
export function downloadTradesCSV(trades: Trade[], metadata?: CSVExportMetadata): boolean {
  if (!trades || trades.length === 0) {
    return false;
  }

  const headers = [
    'Trade ID',
    'Strategy',
    'Symbol',
    'Side',
    'Volume (Instrument Units)',
    'Entry Time (UTC)',
    'Exit Time (UTC)',
    'Entry Timestamp',
    'Exit Timestamp',
    'Duration (Seconds)',
    'Entry Price',
    'Exit Price',
    'PnL ($)',
    'PnL (%)',
    'Return (%)',
    'Fees (not modelled in demo execution)',
    'Exit Reason',
  ];

  const rows = trades.map((t) => {
    const entrySec = t.entryTime > 1e11 ? Math.floor(t.entryTime / 1000) : t.entryTime;
    const exitSec = t.exitTime > 1e11 ? Math.floor(t.exitTime / 1000) : t.exitTime;
    const duration = exitSec >= entrySec ? exitSec - entrySec : 0;

    return [
      escapeCSVField(t.id),
      escapeCSVField(metadata?.strategyName || 'Strategy'),
      escapeCSVField(t.symbol),
      escapeCSVField(t.side),
      escapeCSVField(t.volume),
      escapeCSVField(formatTimestamp(t.entryTime)),
      escapeCSVField(formatTimestamp(t.exitTime)),
      escapeCSVField(entrySec),
      escapeCSVField(exitSec),
      escapeCSVField(duration),
      escapeCSVField(t.entryPrice.toFixed(5)),
      escapeCSVField(t.exitPrice.toFixed(5)),
      escapeCSVField(t.pnl.toFixed(2)),
      escapeCSVField(t.pnlPercent.toFixed(2)),
      escapeCSVField((t.returnPercent ?? t.pnlPercent).toFixed(2)),
      escapeCSVField((t.commission ?? 0).toFixed(2)),
      escapeCSVField(t.exitReason),
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  const symbolTag = metadata?.symbol ? `_${metadata.symbol}` : '';
  const tfTag = metadata?.timeframe ? `_${metadata.timeframe}` : '';
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `tradingvibes_backtest_trades${symbolTag}${tfTag}_${dateStr}.csv`;

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return true;
}
