import {
  AgentActionValidationResult,
  AgentDecision,
  AgentObservation,
  AgentPolicy,
} from '../types';
import { InstrumentLookup, InstrumentMetadata } from '../../../types/instruments';
import { aggregateExposure, lookupFrom, riskToStop } from '../../execution/valuation';

/**
 * Latest observed price for a symbol, taken from the agent's own
 * observation. The agent never supplies prices for its own risk maths.
 */
function referencePrice(
  observation: AgentObservation,
  symbol: string,
): number | undefined {
  const quote = observation.market.quotes.find(
    (candidate) => candidate.symbol === symbol,
  );

  if (!quote) return undefined;

  return Number.isFinite(quote.ask) && quote.ask > 0
    ? quote.ask
    : quote.bid;
}

export interface ActionValidationContext {
  /**
   * Canonical instrument metadata. Supplied by the environment; the
   * validator never derives instrument facts from a symbol name.
   */
  instruments?: InstrumentLookup | InstrumentMetadata[];
}

export class ActionValidator {
  private recentOrderTimestamps: number[] = [];

  validate(
    decision: AgentDecision,
    policy: AgentPolicy,
    observation: AgentObservation,
    context: ActionValidationContext = {},
  ): AgentActionValidationResult {
    // 1. WAIT decision is always valid
    if (decision.type === 'WAIT') {
      return { valid: true, code: 'APPROVED', reason: decision.reason || 'Agent elected to wait.' };
    }

    // 2. ANALYZE capability call validation
    if (decision.type === 'ANALYZE') {
      if (!observation.availableCapabilities.includes(decision.capability)) {
        return {
          valid: false,
          code: 'UNKNOWN_CAPABILITY',
          reason: `Requested capability "${decision.capability}" is not enabled for this agent's active skills.`,
        };
      }
      return { valid: true, code: 'APPROVED' };
    }

    // 3. For all trading execution actions, policy.allowTrading must be true
    if (!policy.allowTrading && decision.type === 'OPEN_POSITION') {
      return {
        valid: false,
        code: 'TRADING_DISABLED',
        reason: 'Master trading policy is disabled. No market orders are permitted.',
      };
    }

    // 4. Rate-limiting check (Orders per minute)
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    this.recentOrderTimestamps = this.recentOrderTimestamps.filter((t) => t > oneMinuteAgo);

    if (decision.type === 'OPEN_POSITION' && this.recentOrderTimestamps.length >= policy.maxOrdersPerMinute) {
      return {
        valid: false,
        code: 'RATE_LIMITED',
        reason: `Exceeded maximum order velocity (${policy.maxOrdersPerMinute} orders/minute).`,
      };
    }

    // 5. Daily Drawdown Guard
    if (decision.type === 'OPEN_POSITION' && policy.maxDailyLoss !== undefined && observation.account.dailyPnL !== null && observation.account.dailyPnL < 0) {
      const dailyLoss = Math.abs(observation.account.dailyPnL);
      if (dailyLoss >= policy.maxDailyLoss) {
        return {
          valid: false,
          code: 'POLICY_VIOLATION',
          reason: `Daily loss limit of $${policy.maxDailyLoss} reached (Current loss: $${dailyLoss.toFixed(2)}).`,
        };
      }
    }

    if (decision.type === 'OPEN_POSITION' && policy.maxDrawdown !== undefined && observation.account.drawdownPercent !== null && observation.account.drawdownPercent > policy.maxDrawdown * 100) {
      return {
        valid: false,
        code: 'POLICY_VIOLATION',
        reason: `Maximum drawdown threshold (${(policy.maxDrawdown * 100).toFixed(1)}%) exceeded.`,
      };
    }

    // 6. Action-specific validation
    if (decision.type === 'OPEN_POSITION') {
      const stopLoss = decision.stopLoss;
      if (!Number.isFinite(decision.volume) || decision.volume <= 0 || typeof stopLoss !== 'number' || !Number.isFinite(stopLoss) || stopLoss <= 0) {
        return { valid: false, code: 'INVALID_PARAMS', reason: 'A positive finite volume and protective stop loss are required.' };
      }
      if (decision.side === 'BUY' && stopLoss >= (observation.market.quote?.ask ?? Number.POSITIVE_INFINITY)) {
        return { valid: false, code: 'INVALID_PARAMS', reason: 'A BUY stop loss must be below the current ask.' };
      }
      if (decision.side === 'SELL' && stopLoss <= (observation.market.quote?.bid ?? Number.NEGATIVE_INFINITY)) {
        return { valid: false, code: 'INVALID_PARAMS', reason: 'A SELL stop loss must be above the current bid.' };
      }

      // Allowed symbol check
      if (policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(decision.symbol)) {
        return {
          valid: false,
          code: 'DISALLOWED_SYMBOL',
          reason: `Instrument "${decision.symbol}" is not in the allowed policy list: [${policy.allowedSymbols.join(', ')}].`,
        };
      }

      // Allowed session check
      if (
        policy.allowedSessions &&
        policy.allowedSessions.length > 0 &&
        !policy.allowedSessions.includes('ALL')
      ) {
        const currentSession = observation.market.session || 'UNKNOWN';
        if (!policy.allowedSessions.includes(currentSession)) {
          return {
            valid: false,
            code: 'DISALLOWED_SESSION',
            reason: `Current session "${currentSession}" is not within allowed policy sessions: [${policy.allowedSessions.join(', ')}].`,
          };
        }
      }

      // Open positions limit check
      if (observation.positions.length >= policy.maxOpenPositions) {
        return {
          valid: false,
          code: 'POLICY_VIOLATION',
          reason: `Cannot open new position: maximum open positions limit (${policy.maxOpenPositions}) reached.`,
        };
      }

      // Exposure limit, valued in the account currency so positions in
      // different asset classes are never compared as raw quantities.
      const instruments =
        Array.isArray(context.instruments)
          ? lookupFrom(context.instruments)
          : context.instruments;

      {
        const exposure = aggregateExposure(
          [
            ...observation.positions.map((position) => ({
              symbol: position.symbol,
              quantity: Math.abs(position.volume),
              metadata: instruments?.get(position.symbol),
              referencePrice:
                referencePrice(observation, position.symbol) ??
                position.currentPrice ??
                position.entryPrice,
            })),
            {
              symbol: decision.symbol,
              quantity: Math.abs(decision.volume),
              metadata: instruments?.get(decision.symbol),
              referencePrice: referencePrice(observation, decision.symbol),
            },
          ],
        );

        if (!exposure.complete) {
          return {
            valid: false,
            code: 'POLICY_VIOLATION',
            reason: `Exposure cannot be valued for ${exposure.unresolved.join(', ')}.`,
          };
        }

        if (exposure.total > policy.maxExposure) {
          return {
            valid: false,
            code: 'POLICY_VIOLATION',
            reason: `Intended order would take total exposure to $${exposure.total.toFixed(2)}, exceeding the $${policy.maxExposure} exposure policy.`,
          };
        }
      }

      // Mandatory stop loss check
      if (!stopLoss || stopLoss <= 0) {
        return {
          valid: false,
          code: 'INVALID_PARAMS',
          reason: 'Every opened position must specify a protective stopLoss price level.',
        };
      }

      // Safe risk per trade calculation (hard ceiling)
      if (observation.market.quote) {
        const entryPrice = decision.side === 'BUY' ? observation.market.quote.ask : observation.market.quote.bid;
        const metadata = instruments?.get(decision.symbol);

        /*
         * Instrument-aware risk.
         *
         *   price distance x size x contract multiplier x quote->account
         *
         * Every factor comes from instrument metadata and the live
         * quote. There is no pip value, lot size, or hardcoded FX rate
         * anywhere in this calculation.
         */
        const risk = riskToStop({
          symbol: decision.symbol,
          metadata,
          entryPrice,
          stopLoss,
          quantity: decision.volume,
        });

        if (!risk.available) {
          return {
            valid: false,
            code: 'POLICY_VIOLATION',
            reason: `Risk on ${decision.symbol} cannot be expressed in the account currency: ${risk.reason ?? 'insufficient market data'}.`,
          };
        }

        const maxDollarRiskAllowed = observation.account.equity * policy.maxRiskPerTrade;

        if ((risk.value ?? 0) > maxDollarRiskAllowed) {
          return {
            valid: false,
            code: 'POLICY_VIOLATION',
            reason: `Dollar risk ($${(risk.value ?? 0).toFixed(2)}) breaches maximum risk per trade policy ($${maxDollarRiskAllowed.toFixed(2)} / ${(policy.maxRiskPerTrade * 100).toFixed(1)}%).`,
          };
        }
      }

      this.recentOrderTimestamps.push(now);
      return { valid: true, code: 'APPROVED' };
    }

    if (decision.type === 'MODIFY_POSITION') {
      const position = observation.positions.find((p) => p.id === decision.positionId);
      if (!Number.isFinite(decision.changes.stopLoss) && !Number.isFinite(decision.changes.takeProfit)) {
        return { valid: false, code: 'INVALID_PARAMS', reason: 'At least one finite stop loss or take profit change is required.' };
      }
      if (!position) {
        return {
          valid: false,
          code: 'INVALID_PARAMS',
          reason: `Position ID "${decision.positionId}" not found in active open positions.`,
        };
      }
      return { valid: true, code: 'APPROVED' };
    }

    if (decision.type === 'CLOSE_POSITION') {
      const position = observation.positions.find((p) => p.id === decision.positionId);
      if (!position) {
        return {
          valid: false,
          code: 'INVALID_PARAMS',
          reason: `Position ID "${decision.positionId}" not found in active open positions.`,
        };
      }
      return { valid: true, code: 'APPROVED' };
    }

    return { valid: true, code: 'APPROVED' };
  }
}

export const actionValidator = new ActionValidator();
