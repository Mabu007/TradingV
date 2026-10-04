/**
 * What a replay did, and how the agent behaved while it did it.
 *
 * Two reports, on purpose. The first is the one a backtest is expected to
 * produce — trades, wins, losses, net result, drawdown — and it is small. The
 * second is the one this product actually exists to produce: what the *agent*
 * did, which no P&L number can tell you.
 *
 * "Did the strategy make money?" and "how did my GOAT behave?" are different
 * questions about the same run, and a results screen that answers only the
 * first throws away the evidence that makes the run worth inspecting. Both are
 * computed from records: trades from the simulated book, behaviour from the
 * agent log the runtime itself wrote.
 *
 * Nothing here is estimated, and nothing is inferred from a trade count. The
 * hypothesis count is the number the runtime formed; the waiting figure is the
 * number of times it recorded going dormant. A report that had to guess would
 * be a report a user could not act on.
 */

import type { Trade } from '../../../types/trading';
import type { AgentTimelineEvent } from '../../agents/timeline/types';

/** The money. Small, familiar, and secondary. */
export interface BacktestPerformance {
  trades: number;
  wins: number;
  losses: number;
  /** Net result in the account currency. */
  netPnl: number;
  /** Net result expressed in units of risk taken per trade. */
  netR: number | undefined;
  winRatePercent: number;
  /** Account value when the run ended. */
  endingEquity: number;
  /** Deepest peak-to-trough fall in account currency, as a positive number. */
  maxDrawdown: number;
  maxDrawdownPercent: number;
  /** Mean win and mean loss, so a reader can see whether the wins pay. */
  averageWin: number;
  averageLoss: number;
}

/**
 * The agent. The reason to watch a backtest at all.
 *
 * Each field answers a question someone watching a GOAT would actually ask,
 * and each one is counted from the log rather than derived from the outcome:
 * a run where the agent did nothing but refuse to trade is a different run
 * from one where it traded and lost, and it needs to be legible as such.
 */
export interface BacktestBehaviour {
  /** Hypotheses the agent formed. */
  hypothesesFormed: number;
  /** Hypotheses it revised after holding them. */
  hypothesesRevised: number;
  /** Hypotheses it abandoned or invalidated. */
  hypothesesInvalidated: number;
  /** Conditions it armed. */
  trackersCreated: number;
  /** Conditions that actually fired. */
  trackersFired: number;
  /** Plans it wrote. */
  plansCreated: number;
  /** Plans the risk layer declined. */
  plansRejectedByRisk: number;
  /** Wakes it handled. */
  wakes: number;
  /** Times it recorded going dormant — waiting for a market event. */
  waits: number;
  /** Model requests it submitted. */
  modelCalls: number;
  /** How many of those the model could not answer. */
  modelFailures: number;
  /** Total real milliseconds spent waiting on the model. */
  modelLatencyMs: number;
  /** Simulated minutes between the first and last tick. */
  simulatedMinutes: number;
  /** The longest the agent went without acting, in simulated minutes. */
  longestSilenceMinutes: number;
}

export interface BacktestReport {
  performance: BacktestPerformance;
  behaviour: BacktestBehaviour;
  /** Every closed trade, oldest first, for a reader who wants the detail. */
  trades: Trade[];
  /** Why the run ended. */
  outcome: 'COMPLETED' | 'STOPPED' | 'ERROR';
  message?: string;
}

/** Risk taken per trade, needed to express a net result in R. */
function riskPerTrade(trades: Trade[]): number | undefined {
  const risks = trades
    .map((trade) => Math.abs(trade.exitPrice - trade.entryPrice) * trade.volume)
    .filter((value) => value > 0);
  if (risks.length === 0) return undefined;
  return risks.reduce((sum, value) => sum + value, 0) / risks.length;
}

export function summarisePerformance(trades: Trade[], initialBalance: number, equity: number): BacktestPerformance {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const netPnl = round2(trades.reduce((sum, trade) => sum + trade.pnl, 0));

  let peak = initialBalance;
  let maxDrawdown = 0;
  let running = initialBalance;
  for (const trade of trades) {
    running += trade.pnl;
    if (running > peak) peak = running;
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }

  const risk = riskPerTrade(trades);
  const averageWin = wins.length > 0 ? round2(wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length) : 0;
  const averageLoss = losses.length > 0 ? round2(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length) : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnl,
    netR: risk !== undefined && risk > 0 ? round2(netPnl / risk) : undefined,
    winRatePercent: trades.length > 0 ? round2((wins.length / trades.length) * 100) : 0,
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPercent: initialBalance > 0 ? round2((maxDrawdown / initialBalance) * 100) : 0,
    averageWin,
    averageLoss,
    endingEquity: round2(equity),
  };
}

/**
 * Count what the agent did, from the log it wrote.
 *
 * `startAt` and `endAt` bound the run in simulated time. The behaviour of a
 * replay is only interesting between the moment the simulation started and
 * the moment it stopped: counting every event a GOAT ever recorded would mix a
 * historical run with a live session and produce a number that means nothing.
 */
export function summariseBehaviour(
  events: AgentTimelineEvent[],
  bounds: { startAt: number; endAt: number },
): BacktestBehaviour {
  const scoped = events.filter((event) => event.timestamp >= bounds.startAt && event.timestamp <= bounds.endAt);

  let modelCalls = 0;
  let modelFailures = 0;
  let modelLatencyMs = 0;

  for (const event of scoped) {
    switch (event.type) {
      case 'MODEL_REQUEST':
        modelCalls += 1;
        break;
      case 'MODEL_RESPONSE':
        modelLatencyMs += elapsedOf(event.data);
        break;
      case 'MODEL_FAILURE':
        modelFailures += 1;
        modelLatencyMs += elapsedOf(event.data);
        break;
      default:
        break;
    }
  }

  /*
   * The longest silence, measured in simulated minutes between recorded
   * activity. It is the honest version of "how long did the agent spend
   * doing nothing": a GOAT waiting on a tracker is doing its job, and a reader
   * who wants to know whether it was engaged can see both this and `waits`.
   */
  let longestSilenceMinutes = 0;
  let previous: number | undefined;
  for (const event of scoped) {
    if (event.type === 'GOAT_WAITING') {
      if (previous !== undefined) {
        longestSilenceMinutes = Math.max(longestSilenceMinutes, (event.timestamp - previous) / 60_000);
      }
      previous = undefined;
      continue;
    }
    if (previous !== undefined) {
      longestSilenceMinutes = Math.max(longestSilenceMinutes, (event.timestamp - previous) / 60_000);
    }
    previous = event.timestamp;
  }
  longestSilenceMinutes = Math.max(longestSilenceMinutes, previous !== undefined && scoped.length > 0
    ? (bounds.endAt - previous) / 60_000
    : 0);

  return {
    hypothesesFormed: countOf(scoped, 'THESIS_FORMED'),
    hypothesesRevised: countOf(scoped, 'THESIS_REVISED'),
    hypothesesInvalidated: countOf(scoped, 'THESIS_INVALIDATED'),
    trackersCreated: countOf(scoped, 'TRACKER_CREATED'),
    trackersFired: countOf(scoped, 'TRACKER_FIRED'),
    plansCreated: countOf(scoped, 'TRADE_PLAN_CREATED'),
    plansRejectedByRisk: countOf(scoped, 'TRADE_PLAN_REJECTED'),
    wakes: countOf(scoped, 'GOAT_WOKE'),
    waits: countOf(scoped, 'GOAT_WAITING'),
    modelCalls,
    modelFailures,
    modelLatencyMs: Math.round(modelLatencyMs),
    simulatedMinutes: Math.max(0, Math.round((bounds.endAt - bounds.startAt) / 60_000)),
    longestSilenceMinutes: Math.round(longestSilenceMinutes),
  };
}

function countOf(events: AgentTimelineEvent[], type: AgentTimelineEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

function elapsedOf(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0;
  const value = (data as { elapsedMs?: unknown }).elapsedMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/** "157.84", the price a reader wants at the size a log line allows. */
export function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(5)));
}

/** "+1.8R", or undefined when no trade took a defined risk. */
export function formatR(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${value >= 0 ? '+' : ''}${value}R`;
}