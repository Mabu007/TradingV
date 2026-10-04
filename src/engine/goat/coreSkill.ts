/**
 * The baseline every GOAT carries.
 *
 * `AgentRuntime` intersects an agent's declared capabilities with the ones
 * its skills grant, and the Tracker SDK checks a GOAT's permission against
 * that same intersection. Both of those are load-bearing: they are what
 * stop a skill from conferring authority nobody granted it.
 *
 * They also have a consequence worth stating plainly. A GOAT created with
 * no skills attached used to arrive with no capabilities at all: it could
 * not read the market it had been pointed at, and it could not deploy a
 * single tracker. Since skills are optional in this product — the user
 * supplies a goal and the agent works out the rest — that made the most
 * ordinary GOAT in the product completely inert.
 *
 * So the baseline hangs off an internal skill that every GOAT carries:
 *
 *   reading and calculating   the research set, so it knows the market
 *   its own mind               thesis, evidence and tracker SDK tools, so it
 *                             can form a hypothesis and watch for it
 *
 * Properties that matter:
 *
 *   It is registered, not special-cased. Both grants still pass through the
 *   runtime's own skill registry and its own intersection.
 *   It is internal. It is never offered in the composer's skill list and
 *   never appears on a GOAT's attached skills; it is not a suggestion the
 *   user can attach or detach.
 *   It grants no trading authority whatsoever. Not one `orders.*` or
 *   `positions.*` capability appears here, so nothing reachable from this
 *   skill can place, modify or close an order. Whether a trade plan is ever
 *   acted on remains the deployment's decision and the risk layer's.
 */

import { GOAT_RESEARCH_CAPABILITIES } from './researchCapabilities';
import { ALL_GOAT_CAPABILITIES } from './trackerSdk';

export const GOAT_CORE_SKILL_ID = 'goat-core';

export const GOAT_CORE_SKILL = {
  id: GOAT_CORE_SKILL_ID,
  name: 'Market access and observation',
  description:
    'Read the market and the account, compute what can be computed exactly, and watch for the evidence you asked for.',
  instructions: [
    'You have tools for reading the market, reading the account, and for',
    'calculating indicators, structure, volatility and position size. Use',
    'them instead of estimating: every price, level, spread, ATR, RSI and',
    'swing you reason about should come from a tool, because a number you',
    'inferred is a number you invented. If a tool could not answer, say you',
    'do not know rather than reasoning around the gap.',
    '',
    'You also have your own tools for holding a thesis, recording evidence,',
    'and deploying trackers — the deterministic watchers that wake you when',
    'something you asked for actually happens. You do not poll the market.',
    '',
    'None of these tools can trade. Proposing a trade plan is a separate,',
    'later step, and it is checked by the risk layer before anything could',
    'act on it.',
  ].join('\n'),
  requiredCapabilities: [...GOAT_RESEARCH_CAPABILITIES, ...ALL_GOAT_CAPABILITIES],
  enabled: true,
};
