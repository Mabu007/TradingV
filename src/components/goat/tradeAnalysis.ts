/**
 * Turning a trade into a question the assistant can answer.
 *
 * ## Why this reuses the conversation
 *
 * There is already a GOAT conversation surface with the market context, the wallet
 * state and the ability to act on an answer. A second chat, opened only for trade
 * review, would have none of that and would answer a poorer version of the same
 * question. So this builds the *prompt* and hands it to the existing assistant,
 * which is what the other "ask the AI" actions in this product already do.
 *
 * ## What goes in
 *
 * Enough for the assistant to actually critique the decision rather than restate
 * it: what the GOAT believed, what it wanted to buy, what it was risking, what it
 * took, and what came of it. A prompt that says "analyse trade #004" alone would
 * get a paragraph of general trading advice; one that carries the numbers gets an
 * answer about *this* trade.
 *
 * The prices are included as plain text rather than as a structure the assistant
 * has to parse, because it reads prose and a table of numbers in a prompt is not
 * something to be reconstructed.
 */

import type { TradeRecord } from '../../engine/goat/tradeEngine';

export interface TradeAnalysisContext {
  tradeId: string;
  market: string;
  /** The prompt, ready to hand to the assistant. */
  prompt: string;
}

/**
 * Build the analysis prompt for one trade.
 *
 * Every field is written to be readable on its own. The assistant sees this without
 * any of the surrounding replay state, so "risk 0.14 (0.9R)" is useful and
 * "see the trade record" is not.
 */
export function tradeAnalysisPrompt(trade: TradeRecord): TradeAnalysisContext {
  const lines: string[] = [];

  lines.push(`Analyse Trade #${trade.id.replace(/^trade_/, '')} — ${trade.symbol}.`);
  lines.push('');
  lines.push('SETUP');
  lines.push(`  The GOAT believed: ${trade.reason}`);
  lines.push(`  It would be wrong if: ${trade.invalidation}`);

  lines.push('');
  lines.push('ENTRY');
  if (trade.fillPrice !== undefined) {
    lines.push(`  A ${trade.side} ${trade.orderType} was proposed at ${format(trade.proposedEntry)} and filled at ${format(trade.fillPrice)}.`);
    if (trade.secondsWaiting !== undefined) {
      lines.push(`  It waited ${trade.secondsWaiting}s for that price.`);
    }
  } else {
    lines.push(`  A ${trade.side} ${trade.orderType} was proposed at ${format(trade.proposedEntry)} and has not filled.`);
    lines.push(`  Status: ${trade.status}${trade.rejectionReason ? ` — ${trade.rejectionReason}` : ''}`);
  }

  const risk = Math.abs(trade.proposedEntry - trade.stopLoss);
  lines.push('');
  lines.push('RISK');
  lines.push(`  Stop loss: ${format(trade.stopLoss)} (risk distance ${format(risk)})`);
  if (trade.takeProfit !== undefined) {
    lines.push(`  Take profit: ${format(trade.takeProfit)} (reward distance ${format(Math.abs(trade.takeProfit - trade.proposedEntry))})`);
  }
  if (trade.riskReward !== undefined) {
    lines.push(`  Reward-to-risk: ${trade.riskReward.toFixed(2)}:1`);
  }

  if (trade.pnl !== undefined) {
    lines.push('');
    lines.push('RESULT');
    lines.push(`  Closed at ${format(trade.exitPrice)} for ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}${trade.pnlPercent !== undefined ? ` (${trade.pnlPercent.toFixed(2)}%)` : ''}.`);
    lines.push(`  Exit reason: ${trade.exitReason ?? 'not stated'}`);
    if (trade.secondsHeld !== undefined) {
      lines.push(`  Held for ${trade.secondsHeld}s.`);
    }
  }

  lines.push('');
  lines.push(
    'Please assess: why this trade was taken, whether the limit price was well placed for a ' +
      'retest entry, whether the stop sat in the right place structurally, whether the target was ' +
      'realistic against the setup, and whether the outcome was consistent with the reasoning. ' +
      'Say what could be improved.',
  );

  return {
    tradeId: trade.id,
    market: trade.symbol,
    prompt: lines.join('\n'),
  };
}

function format(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

export default tradeAnalysisPrompt;