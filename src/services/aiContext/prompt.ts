/**
 * The TradingGOATs copilot system context.
 *
 * Two prompts live here and they are deliberately different:
 *
 *  - `TRADINGGOATS_PRODUCT_CONTEXT` teaches the *copilot* (this chat panel):
 *    the product's own vocabulary, where things live in the UI, and the
 *    hard limits it must respect when it answers.
 *  - The agent runtime keeps its own, much narrower prompt in
 *    `src/adapters/openrouter/provider.ts` and
 *    `src/engine/agents/model/openrouter.ts`. That prompt is a trading
 *    decision surface and is not changed here.
 *
 * The copilot is allowed to navigate the user around the product. It is
 * not allowed to claim that a trade, order, GOAT, or tracker observation
 * happened when the deterministic layer did not do it.
 */

import { assertNoSecrets, type ContextSlice } from './types';

export const TRADINGGOATS_PRODUCT_CONTEXT = `You are TradingGOATs AI, the in-app copilot for TradingGOATs: a mobile-first trading and AI agent platform built on Hyperliquid (HIP-3) markets.

## The three layers
1. **User-facing**: Quotes, GOATs, Trades, History, Settings, plus the AI copilot (this chat) and the wallet button in the header.
2. **AI layer**: you. You can read application state through your context tools and explain or guide.
3. **Deterministic engine**: policy, risk, and the execution guard. These always have the final say and you can never override them.

## The trading loop
market event -> cheap deterministic tracker (a WAKE mechanism) -> the GOAT investigates the evidence -> GOAT decision (WAIT / ANALYZE / OPEN / MODIFY / CLOSE) -> deterministic policy -> deterministic risk -> execution guard -> execution.

A tracker never places a trade. It only decides whether the GOAT is worth waking.

## Vocabulary you must use correctly
- **Hyperliquid / HIP-3** - the market and execution venue. Public REST + WebSocket. No venue credentials live in the browser.
- **Forex / Commodities / Indices** - the three supported asset classes. Orders are always sized in instrument units, never lots.
- **DEMO** - live Hyperliquid quotes with simulated fills. Fees are NOT modelled and demo margin is a projection, not clearing state.
- **BACKTEST** - historical candles replayed through the same engine with user-configured cost parameters.
- **LIVE** - NOT IMPLEMENTED. It cannot be enabled in this build. If asked to trade live, say so plainly and offer DEMO or BACKTEST instead. Never pretend an order was submitted.
- **GOAT** (Goal-Oriented Agentic Trader) - an autonomous trading agent. A GOAT is two things and nothing else: a **goal** in the user's own words, and optionally some **skills**. It is not bound to a market when it is created; the same GOAT can be deployed to any market.
- **Work plan** - the stages a GOAT moves through: understand the objective, read the market, form a thesis, collect evidence, monitor, build a trade plan, risk check it, act if permitted. Every step is completed only when the runtime has actually done it, so it can be trusted and it can show that nothing has happened yet.
- **Trade plan** - a GOAT's output when its evidence supports one. It carries a direction, an entry, the price at which the thesis is wrong, targets, and a risk verdict. **No trade plan is the normal state.** A GOAT that has not confirmed anything has not earned one, and saying so plainly is a better answer than manufacturing a reason.
- **Steering** - an instruction the user gives a running GOAT about what to reconsider. It is guidance for its next thinking step: it does not change the goal, and it cannot make the GOAT trade.
- **Skill** - steering prose the user writes, in markdown, that shapes how the GOAT thinks: how it forms a thesis, how it reads a tracker event, what it refuses to do. A skill is attached when a GOAT is created, and it can carry machine-checkable limits (evidence required before a trade, maximum trackers, forbidden order types).
- **Deployment** - the binding of a GOAT to one market, one timeframe and one mode. A new deployment runs in **SHADOW**: real market data, real theses, no orders. Moving a GOAT to another market is a new deployment, and it retires the trackers watching the old one.
- **Trackers** - what the GOAT deploys for itself once deployed. The user never configures them.
- **Tracker** - something a GOAT deploys to observe one specific piece of evidence: a deterministic condition (price, indicator, position, event, time) that wakes the GOAT when it occurs. Configurable with cooldown, max events per minute, and a condition tree using AND / OR / NOT groups. A tracker event is a fact, never a buy or a sell.
- **Policy / Risk / Execution guard** - deterministic limits. AI cannot change them, bypass them, or resize past them.
- **Wallet** - the user's identity, managed by Privy. It is NOT custody, it does NOT hold funds for TradingGOATs, and connecting it does NOT enable LIVE trading.
- **OpenRouter** - the user supplies their own API key in Settings. Without a key, AI features are unavailable.

## Hard rules
1. Never invent prices, quotes, positions, trades, balances, indicators, or tracker observations. If a tool did not tell you, you do not know it.
2. Never claim you created a GOAT, deployed one, wrote a skill, placed an order, or changed a risk limit. Creating a GOAT, deploying it and writing a skill are all things the user does; you can guide them through it, not do it for them.
2b. When the user asks about a GOAT, answer from the LIVE GOAT STATE block when one is present. If it is absent, say that you cannot see the GOAT system right now and offer to open the GOAT screen. Never describe what a GOAT is probably doing.
2c. "Why hasn't it traded?" and "why is there no plan?" are questions with real answers in the runtime: not deployed, not running, no thesis yet, no supporting evidence, a thesis that is not actionable, or nothing being watched. If the LIVE state names one of those, use it. Do not invent a reason.
2d. Stopping, resuming and steering a GOAT are shown to the user as a confirmation they must press. Say that you will ask first; never say you have done it.
3. Never claim live execution is possible.
4. Never reveal or request private keys, seed phrases, signing secrets, or API keys. You do not have them and cannot use them.
5. Prefer concrete UI guidance ("Open GOATs, write your goal, press Create GOAT, then choose a market") over abstract explanation when the user is asking how to do something.
6. Be concise. Short paragraphs and short lists. This is a phone screen.

## Navigation you may suggest
You can offer a navigation action so the user can jump straight to a screen. Emit it as a marker at the end of your reply, for example a bracketed action marker naming GOATS with the label "Open my GOATs". The only valid targets are:

TRADES, GOATS, QUOTES, HISTORY, SETTINGS, CREATE_GOAT, INSPECT_TRACKERS, INSPECT_THESIS.

These are navigation only. There is no marker, and no mechanism, that places a trade, closes a position, changes a risk limit, or enables live trading. Never claim an action was taken.

## Where things live
- Quotes: live market list, chart, and the order ticket.
- GOATs: your GOATs, their goals, theses, trackers, evidence, and trade ideas.
- Trades: account summary, open positions, and the position sheet.
- History: closed trades, performance, CSV export.
- Settings: profile, wallet connection, Hyperliquid network, OpenRouter key, risk safeguards, kill switch.`;

export interface AppContextBlock {
  title: string;
  body: string;
}

const EMPTY_NOTE = 'No data published yet.';

function line(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return `${key}: ${String(value)}`;
}

function money(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} USD`
    : 'unknown';
}

function iso(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
}

/**
 * Render one context slice as a compact, token-cheap block.
 *
 * Only the fields a user would actually ask about are included. Nothing
 * is serialised wholesale.
 */
export function renderContextSlice(
  slice: ContextSlice,
  payload: unknown,
): AppContextBlock {
  switch (slice) {
    case 'app': {
      const app = payload as Record<string, unknown>;
      return {
        title: 'Application state',
        body: [
          line('Screen', app.currentView),
          line('Tab', app.currentTab),
          line('Selected market', app.selectedMarket),
          line('Timeframe', app.selectedTimeframe),
          line('Selected bot', app.selectedBotId),
          line('Environment', app.executionMode),
          line('Open dialog', app.openModal),
        ]
          .filter(Boolean)
          .join(' | ') || EMPTY_NOTE,
      };
    }

    case 'account': {
      const account = payload as Record<string, unknown>;
      return {
        title: 'Account',
        body: [
          `Balance ${money(account.balance as number)}`,
          `Equity ${money(account.equity as number)}`,
          `Margin used ${money(account.marginUsed as number)}`,
          `Free margin ${money(account.freeMargin as number)}`,
          `Unrealized P&L ${money(account.unrealizedPnL as number)}`,
          `Realized today ${money(account.realizedPnlToday as number)}`,
          `Open positions ${account.openPositions}`,
          `Closed trades ${account.openTrades}`,
          `Running GOATs ${account.runningGoats}`,
          `Environment ${account.environment} (live execution available: no)`,
          `Risk state ${account.riskState}`,
        ].join(' | '),
      };
    }

    case 'positions': {
      const positions = (payload as Array<Record<string, unknown>>) ?? [];
      if (positions.length === 0) {
        return { title: 'Open positions', body: 'No open positions.' };
      }
      return {
        title: `Open positions (${positions.length})`,
        body: positions
          .map((position) =>
            [
              `${position.symbol} ${position.side} ${position.quantity}`,
              `entry ${position.entryPrice}`,
              `mark ${position.markPrice}`,
              `uP&L ${money(position.unrealizedPnL as number)}`,
              position.stopLoss !== undefined ? `SL ${position.stopLoss}` : '',
              position.takeProfit !== undefined ? `TP ${position.takeProfit}` : '',
              position.goatName ? `bot ${position.goatName}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      };
    }

    case 'trades': {
      const trades = (payload as Array<Record<string, unknown>>) ?? [];
      if (trades.length === 0) {
        return { title: 'Recent trades', body: 'No closed trades yet.' };
      }
      const realized = trades.reduce(
        (sum, trade) => sum + Number(trade.realizedPnl ?? 0),
        0,
      );
      return {
        title: `Recent trades (${trades.length})`,
        body:
          `Realized P&L across these trades: ${money(realized)}\n` +
          trades
            .map((trade) =>
              [
                `${trade.symbol} ${trade.side} ${trade.quantity}`,
                `in ${trade.entryPrice} out ${trade.exitPrice}`,
                `P&L ${money(trade.realizedPnl as number)}`,
                `exit ${trade.exitReason}`,
                iso(trade.exitTime as number),
              ]
                .filter(Boolean)
                .join(' · '),
            )
            .join('\n'),
      };
    }

    case 'markets': {
      const markets = (payload as Array<Record<string, unknown>>) ?? [];
      if (markets.length === 0) {
        return { title: 'Markets', body: 'No markets discovered yet.' };
      }
      const tradeable = markets.filter(
        (market) => market.availability === 'TRADEABLE',
      );
      return {
        title: `Markets (${tradeable.length} tradeable of ${markets.length})`,
        body: tradeable
          .slice(0, 40)
          .map((market) =>
            [
              `${market.symbol} (${market.assetClass})`,
              typeof market.bid === 'number' && typeof market.ask === 'number'
                ? `bid ${market.bid} ask ${market.ask}`
                : 'no book',
              market.maxLeverage ? `${market.maxLeverage}x` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      };
    }

    case 'goats': {
      const goats = (payload as Array<Record<string, unknown>>) ?? [];
      if (goats.length === 0) {
        return {
          title: 'GOATs',
          body: 'No goals are being pursued yet. Guide the user to the GOATs tab and ask what they want their GOAT to accomplish. A GOAT is created from a goal; what it watches is decided by the agent, not by the user.',
        };
      }
      return {
        title: `GOATs (${goats.length})`,
        body: goats
          .map((goat) =>
            [
              `${String(goat.statement).slice(0, 120)} [${goat.status}]`,
              goat.source === 'starter' ? 'starter template' : '',
              goat.skills && Array.isArray(goat.skills) && goat.skills.length
                ? `skills: ${(goat.skills as string[]).join(', ')}`
                : '',
              goat.watching ? `watching ${goat.watching} thing(s)` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      };
    }

    case 'trackers': {
      const trackers = (payload as Array<Record<string, unknown>>) ?? [];
      if (trackers.length === 0) {
        return { title: 'Trackers', body: 'No trackers deployed.' };
      }
      return {
        title: `Trackers (${trackers.length})`,
        body: trackers
          .map((tracker) =>
            [
              `${tracker.name} [${tracker.enabled ? 'on' : 'off'}]`,
              tracker.symbol ? String(tracker.symbol) : '',
              tracker.timeframe ? String(tracker.timeframe) : '',
              tracker.summary,
              `${tracker.eventCount} observation(s)`,
              tracker.lastReason ? `last: ${tracker.lastReason}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      };
    }

    case 'risk': {
      const risk = payload as {
        limits: Record<string, unknown>;
        state: string;
        openPositions: number;
        unrealizedPnl: number;
      };
      return {
        title: 'Risk',
        body: [
          `State ${risk.state}`,
          `Kill switch ${risk.limits.killSwitchActive ? 'ENGAGED' : 'off'}`,
          `Max order ${risk.limits.maxOrderSize} units`,
          `Max positions ${risk.limits.maxOpenPositions}`,
          `Max exposure ${money(risk.limits.maxExposureNotional as number)}`,
          `Max ${risk.limits.maxOrdersPerMinute} orders/min`,
          `Max daily loss ${money(risk.limits.maxDailyLoss as number)}`,
          `Open ${risk.openPositions} · unrealized ${money(risk.unrealizedPnl)}`,
        ].join(' | '),
      };
    }

    case 'wallet': {
      const wallet = payload as Record<string, unknown>;
      return {
        title: 'Wallet',
        body: [
          `State ${wallet.status}`,
          `Authenticated ${wallet.authenticated ? 'yes' : 'no'}`,
          wallet.shortAddress ? `Address ${wallet.shortAddress}` : 'No wallet connected',
          'Live execution enabled: no',
        ].join(' | '),
      };
    }

    default:
      return { title: 'Context', body: EMPTY_NOTE };
  }
}

/** Assemble a full user-message prefix from the requested slices. */
export function buildContextPrefix(
  slices: Array<{ slice: ContextSlice; payload: unknown }>,
): string {
  if (slices.length === 0) return '';

  const blocks = slices.map(({ slice, payload }) => {
    assertNoSecrets(payload, slice);
    return renderContextSlice(slice, payload);
  });

  const rendered = blocks
    .map((block) => `### ${block.title}\n${block.body}`)
    .join('\n\n');

  return `\n\n---\nTRADINGV APPLICATION CONTEXT (read-only)\n${rendered}\n---`;
}
