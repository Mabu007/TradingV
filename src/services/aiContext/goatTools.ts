/**
 * The assistant's view of the user's GOAT system.
 *
 * The assistant answers questions like "what is my GOAT doing?" from
 * records, not from what it was told earlier in the conversation. Two
 * reasons, and the second is the important one:
 *
 *   A GOAT's state changes on a tracker event. A prompt written when the
 *   question was asked is a snapshot of a moment the user is no longer
 *   asking about.
 *
 *   "Why hasn't it produced a trade plan?" is a question about the runtime,
 *   and the honest answer is a function of the thesis, the evidence, the
 *   trackers and the last plan's risk verdict. If the assistant cannot see
 *   those, the only available answer is a guess, and a guessed reason for an
 *   agent's silence is the most misleading thing it could say.
 *
 * So this is a tool layer, not a context dump. Each question resolves to
 * one or two small reads, chosen from the wording, and the assistant is
 * told what it could not see.
 *
 * Nothing here reaches a credential. Every payload goes through the same
 * secret guard as the rest of the context, and no API key, wallet secret or
 * signing material is reachable from the orchestrator or the market adapter.
 */

import type { GoatOrchestrator } from '../../engine/goat/orchestrator';
import type { GoatMission } from '../../engine/goat/mission';
import { hyperliquidMarketData } from '../../adapters/hyperliquid/marketData';
import { assertNoSecrets } from './types';

/**
 * What the assistant is allowed to reach.
 *
 * Registered once by the application rather than imported, so this module
 * stays free of engine dependencies and can be exercised in a test with a
 * stub. Nothing is registered by default: with no provider the assistant
 * says it cannot see the GOAT system rather than pretending it is empty.
 */
export interface GoatContextProvider {
  missions(): GoatMission[];
  mission(goalId: string): GoatMission | undefined;
  evidenceFor(goalId: string, limit: number): Array<{ summary: string; polarity: string; source: string; at: number }>;
  activityFor(goalId: string, limit: number): Array<{ at: number; text: string }>;
  trackLiveQuote(symbol: string): Promise<{ symbol: string; bid: number; ask: number; status: string } | undefined>;
}

let provider: GoatContextProvider | undefined;

/** Called by the application once, at start-up. */
export function registerGoatContextProvider(next: GoatContextProvider | undefined): void {
  provider = next;
}

/** Remove it again. Used by tests. */
export function clearGoatContextProvider(): void {
  provider = undefined;
}

export function hasGoatContextProvider(): boolean {
  return provider !== undefined;
}

/* --------------------------------------------------------------------------- *
 * Matching a GOAT
 * --------------------------------------------------------------------------- */

export interface GoatMatch {
  mission?: GoatMission;
  /** Set when the wording matches more than one GOAT. */
  ambiguous?: GoatMission[];
  /** Set when the wording names a GOAT that does not exist. */
  missing?: boolean;
}

/**
 * Find the GOAT a question is about.
 *
 * Matching is on name, then description, then goal words — in that order,
 * because a user says "what is Trend Architect doing" and not "what is the
 * GOAT whose goal statement contains the word architect".
 *
 * An ambiguous match returns both rather than picking one. Guessing which
 * GOAT someone meant and then answering confidently about the wrong one is
 * the failure mode this guards against.
 */
export function findGoat(question: string): GoatMatch {
  if (!provider) return {};

  const missions = provider.missions();
  if (missions.length === 0) return {};

  const haystack = question.toLowerCase();

  // "my GOATs", plural, or no name at all: summarise everything.
  const wantsAll = /\b(my goats|my goat|all goats|each goat|my agents)\b/.test(haystack);
  if (wantsAll) return { ambiguous: missions };

  const named = missions.filter((mission) => {
    const name = mission.name.toLowerCase();
    if (name.length > 3 && haystack.includes(name)) return true;
    // Also match a distinctive fragment of the name ("architect").
    const fragment = name.replace(/\s*goat$/i, '').trim();
    return fragment.length > 3 && haystack.includes(fragment);
  });

  if (named.length === 1) return { mission: named[0] };
  if (named.length > 1) return { ambiguous: named };

  // No name matched: fall back to the only deployed GOAT, if there is one.
  const deployed = missions.filter((mission) => mission.deployment !== undefined);
  if (deployed.length === 1 && /\b(it|its|that)\b/.test(haystack)) {
    return { mission: deployed[0] };
  }

  return {};
}

/* --------------------------------------------------------------------------- *
 * What the question needs
 * --------------------------------------------------------------------------- */

export type GoatIntent =
  | 'status'
  | 'activity'
  | 'thesis'
  | 'trackers'
  | 'evidence'
  | 'plan'
  | 'why-no-plan'
  | 'overview'
  | 'control';

const INTENT_PATTERNS: Array<[GoatIntent, RegExp]> = [
  ['why-no-plan', /\b(why (has|have|did) (it|they)?\s*(not|no|never)|why no (trade )?plan|why (isn't|is not) it trading|what's it waiting for|what is it waiting for)\b/],
  ['plan', /\b(trade plan|trade idea|plan|setup|entry|position)\b/],
  ['trackers', /\b(tracker|trackers|watching|conditions?|watch for|observing)\b/],
  ['evidence', /\b(evidence|support|proof|data it (has|is using))\b/],
  ['thesis', /\b(thesis|believe|thinking|opinion|view|bias|conviction)\b/],
  ['activity', /\b(while i was away|what happened|recently|activity|history|log)\b/],
  ['control', /\b(stop|pause|resume|play|steer|tell it|interrupt)\b/],
  ['status', /\b(what is .*doing|what are .*doing|how is .*going|status|running|working|state)\b/],
];

export function classifyGoatIntent(question: string): GoatIntent | undefined {
  const haystack = question.toLowerCase();
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(haystack)) return intent;
  }
  return /\bgoat\b/.test(haystack) ? 'status' : undefined;
}

/* --------------------------------------------------------------------------- *
 * The reads
 * --------------------------------------------------------------------------- */

interface GoatBrief {
  id: string;
  name: string;
  goal: string;
  stage: string;
  runtime: string;
  market?: string;
  mode?: string;
  watching: number;
  thesis?: string;
  hasPlan: boolean;
  workPlan: string[];
}

function brief(mission: GoatMission): GoatBrief {
  return {
    id: mission.goalId,
    name: mission.name,
    goal: mission.goal,
    stage: mission.stageLabel,
    runtime: mission.runtime,
    market: mission.market,
    mode: mission.mode,
    watching: mission.activeTrackerCount,
    thesis: mission.thesis?.statement,
    hasPlan: mission.tradePlan !== undefined,
    workPlan: mission.workPlan.map(
      (step) =>
        `${step.status === 'done' ? '[done]' : step.status === 'active' ? '[now]' : '[todo]'} ${
          step.label
        }`,
    ),
  };
}

/** Every GOAT the user has, in one line each. */
export function listMyGoats(): GoatBrief[] {
  if (!provider) return [];
  return provider.missions().map(brief);
}

/**
 * Everything about one GOAT, shaped for the specific question.
 *
 * Each branch returns only what was asked for. An assistant that reads the
 * whole GOAT to answer "what is it watching" ends up quoting its thesis, and
 * a user who wanted their trackers has been given an essay.
 */
export function readGoat(mission: GoatMission, intent: GoatIntent): string {
  if (!provider) {
    return 'The GOAT system is not available to this conversation right now.';
  }

  const lines: string[] = [`GOAT: ${mission.name} (${mission.goalId})`];

  switch (intent) {
    case 'thesis':
      lines.push(
        mission.thesis
          ? `Thesis (${mission.thesis.state}): ${mission.thesis.statement}`
          : 'It has no thesis yet, so there is nothing for it to hold a view about.',
      );
      if (mission.thesis?.invalidation) {
        lines.push(`It is wrong if: ${mission.thesis.invalidation}`);
      }
      if (mission.thesis?.confidence !== undefined) {
        lines.push(`Its own confidence: ${(mission.thesis.confidence * 100).toFixed(0)}%`);
      }
      break;

    case 'trackers':
      lines.push(
        mission.activeTrackerCount === 0
          ? 'It is not watching anything right now.'
          : `It is watching ${mission.activeTrackerCount} condition(s):`,
      );
      for (const tracker of mission.trackers.filter((t) => t.status === 'ACTIVE')) {
        lines.push(`- ${tracker.purpose} (${tracker.kind}${tracker.lastEvaluatedAt ? '' : ''})`);
      }
      break;

    case 'evidence': {
      const evidence = provider.evidenceFor(mission.goalId, 8);
      lines.push(
        `Evidence recorded: ${mission.supportingEvidenceCount} supporting, ${mission.contradictingEvidenceCount} contradicting.`,
      );
      for (const item of evidence) lines.push(`- [${item.polarity}] ${item.summary}`);
      break;
    }

    case 'plan':
      lines.push(describePlan(mission));
      break;

    case 'why-no-plan':
      lines.push(describePlan(mission));
      lines.push(...explainNoPlan(mission));
      break;

    case 'activity': {
      const entries = provider.activityFor(mission.goalId, 10);
      lines.push('Recent activity:');
      for (const entry of entries) lines.push(`- ${entry.text}`);
      break;
    }

    default:
      lines.push(`Doing: ${mission.activity.headline}`);
      if (marketOf(mission)) {
        /*
         * The deployment, in full.
         *
         * Market, mode and venue together, because "is it running?" is not
         * answerable from any one of them, and because a GOAT that is
         * watching but may not trade must say so here rather than letting
         * the user infer that "cannot execute" means "not working".
         */
        lines.push(
          `Deployment: ${marketOf(mission)} · ${mission.mode ?? 'no mode'} · venue ${
            mission.environment ?? 'unknown'
          }`,
        );
        lines.push(
          `May execute: ${mission.mayExecute ? 'yes' : 'no — it can research, reason, track and write a plan, but no order will be placed'}`,
        );
      }
      lines.push(`Runtime: ${mission.runtime}`);
      lines.push(`Work plan:`);
      for (const step of brief(mission).workPlan) lines.push(`- ${step}`);
      if (mission.activity.watching.length > 0) {
        lines.push('Waiting on:');
        for (const purpose of mission.activity.watching) lines.push(`- ${purpose}`);
      }
      lines.push(`Trade plan: ${mission.tradePlan ? 'one exists' : 'none yet'}`);
      break;
  }

  return guard(lines.join('\n'), 'goat');
}

function marketOf(mission: GoatMission): string | undefined {
  return mission.market;
}

/**
 * The trade plan, or the honest absence of one.
 *
 * Wording matters here more than anywhere else: "no trade plan yet" is a
 * normal state the assistant should present as normal, not as a problem to
 * be solved by inventing one.
 */
function describePlan(mission: GoatMission): string {
  const plan = mission.tradePlan;
  if (!plan) return 'Trade plan: none. It has not produced one.';

  return [
    `Trade plan: ${plan.symbol} ${plan.direction} ${plan.orderType} (${plan.status.replace(/_/g, ' ')})`,
    `Entry ${plan.entry}, invalidation ${plan.invalidationLevel}, targets ${plan.takeProfits
      .map((target) => target.price)
      .join(', ')}`,
    plan.riskCheck ? `Risk check: ${plan.riskCheck.reason}` : 'Risk check: not run',
  ].join('\n');
}

/**
 * Why there is no plan, from the records that explain it.
 *
 * These are the actual reasons the runtime can be in this state, in the
 * order they are checked. Anything the assistant says beyond this is a
 * story it invented, which is exactly what this question tempts it into.
 */
function explainNoPlan(mission: GoatMission): string[] {
  const reasons: string[] = [];

  if (!mission.deployment) {
    return ['It has not been deployed to a market, so it cannot have a trade plan yet.'];
  }
  if (mission.runtime !== 'RUNNING') {
    return [`It is ${mission.runtime.toLowerCase()}, so nothing is being watched or decided.`];
  }
  if (!mission.thesis) {
    return ['It has not formed a thesis yet. It is still working out what it believes.'];
  }
  if (mission.supportingEvidenceCount === 0) {
    return [
      'It has a thesis but no supporting evidence yet.',
      'A plan is only built from a thesis that has been confirmed by something it asked to watch for.',
    ];
  }
  if (mission.thesis.state !== 'ACTIONABLE') {
    return [
      `Its thesis is ${mission.thesis.state.toLowerCase()}, not actionable.`,
      'The skills attached to this GOAT require confirmation before a thesis may become actionable.',
    ];
  }
  if (mission.activeTrackerCount === 0) {
    return ['Its thesis is actionable but nothing is being watched, so nothing has woken it to act.'];
  }

  return [
    'Nothing has invalidated its plan or satisfied it since it last woke.',
    `It has ${mission.activeTrackerCount} condition(s) watching and is waiting for one of them.`,
  ];
}

/* --------------------------------------------------------------------------- *
 * Live market
 * --------------------------------------------------------------------------- */

/**
 * A live quote for the symbol a question names.
 *
 * Read through the adapter rather than from the published context: the
 * published snapshot is throttled, and "what is gold doing right now"
 * answered from a half-second-old copy is a different question from the one
 * that was asked.
 */
export async function readLiveMarket(question: string): Promise<string | undefined> {
  if (!provider) return undefined;

  const symbol = symbolFromQuestion(question);
  if (!symbol) return undefined;

  try {
    const quote = await provider.trackLiveQuote(symbol);
    if (!quote) {
      return `No live quote is available for ${symbol}. It may not be a symbol this venue trades.`;
    }
    return guard(
      [
        `${symbol} right now (${quote.status}):`,
        `bid ${quote.bid}`,
        `ask ${quote.ask}`,
        `spread ${(quote.ask - quote.bid).toFixed(6)}`,
      ].join('\n'),
      'market',
    );
  } catch (error) {
    return `Could not read ${symbol} right now: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * The symbol a question is about.
 *
 * From the words, not from a list of every market: a question about GOLD
 * should not produce a read of every instrument.
 */
export function symbolFromQuestion(question: string): string | undefined {
  const upper = question.toUpperCase();
  const alias: Record<string, string> = {
    GOLD: 'XAUUSD',
    XAUUSD: 'XAUUSD',
    OIL: 'OIL',
    SP500: 'SP500',
    NASDAQ: 'NASDAQ',
    DOW: 'DOW',
    EURUSD: 'EURUSD',
  };
  for (const [word, symbol] of Object.entries(alias)) {
    if (new RegExp(`\\b${word}\\b`).test(upper)) return symbol;
  }
  // A bare upper-case token that looks like a venue symbol.
  const match = upper.match(/\b[A-Z]{3,10}\b/g);
  return match?.find((token) => /USD|[A-Z]{6}/.test(token));
}

/* --------------------------------------------------------------------------- */

/**
 * The same guard the rest of the context uses.
 *
 * Reused rather than duplicated so there is one place where a
 * credential-shaped string is refused, and so the assistant's GOAT tools
 * cannot become the path that leaks one.
 */
function guard(payload: string, slice: string): string {
  assertNoSecrets(JSON.parse(JSON.stringify({ [slice]: payload })), slice);
  return payload;
}
