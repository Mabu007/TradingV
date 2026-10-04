/**
 * Built-in GOAT skills.
 *
 * Authored as Markdown documents — the same format a user writes a skill
 * in — and parsed at load by the same parser. A shipped skill and an
 * authored one are therefore not two kinds of thing: they are the same
 * thing, written in one place and loaded in one way, and a reader who
 * understands one understands the other.
 *
 * These are the skills the four starter GOATs are built from, and they
 * are written to be used rather than to be read once and forgotten: each
 * one carries guidance for every phase of the loop, so a skill shapes
 * goal interpretation, investigation, thesis formation, what the GOAT
 * decides to watch, how it reads an observation, when it changes its
 * mind, and how it builds an idea.
 *
 * Two rules govern everything in this file.
 *
 * **Only enforceable constraints.** Every `constraints` entry is one the
 * runtime can check: evidence counted before a thesis may become
 * actionable, a stated invalidation before an idea may exist, ceilings on
 * trackers and theses, forbidden order types, a higher-timeframe
 * confirmation requirement. Where a rule is worth stating and cannot be
 * enforced — "take no action when structural evidence conflicts", for
 * instance — it is written as guidance and the skill says so, because a
 * fake enforcement would be worse than an honest instruction. See
 * `UNENFORCEABLE.md` notes in each skill.
 *
 * **Phases, not paragraphs.** `## PHASE` text is compiled into the
 * prompt at the moment that phase happens, so tracker-planning guidance
 * is in front of the GOAT when it is choosing what to watch rather than
 * only when it was started.
 *
 * The tracker SDK is granted by these skills, because a GOAT that could
 * not deploy a tracker would be reduced to polling the market, which is
 * the one behaviour this architecture exists to eliminate. Those are
 * observation capabilities only: nothing here places, sizes, approves or
 * cancels an order.
 */

import { SkillPackage } from './skills';
import { parseSkillMarkdown } from './skillMarkdown';
import { ALL_GOAT_CAPABILITIES } from './trackerSdk';

/**
 * Tracker authority, granted by every shipped skill.
 *
 * The list is the SDK's own, so a new tracker capability cannot be added
 * without every skill granting it, and cannot be granted here without
 * existing as a capability at all.
 */
const OBSERVATION_AUTHORITY = ALL_GOAT_CAPABILITIES;

/** Reading market structure: swings, levels, and where they break. */
const STRUCTURE_READING = [
  'structure.swingHighs',
  'structure.swingLows',
  'structure.supportResistance',
  'structure.breakout',
];

/** Reading indicators as measures of a market rather than as signals. */
const INDICATOR_READING = [
  'indicators.rsi',
  'indicators.ema',
  'indicators.sma',
  'indicators.atr',
];

/** Bars, quote and spread: the raw material every judgement is made on. */
const MARKET_READING = ['market.getBars', 'market.getQuote', 'market.getSpread'];

/** Sizing and checking an idea against the account. */
const ACCOUNT_AND_RISK = [
  'account.getEquity',
  'account.getBalance',
  'account.getPositions',
  'account.getExposure',
  'risk.calculateRisk',
  'risk.calculatePositionSize',
  'risk.calculateExposure',
  'risk.checkTrade',
];

/* ================================================================== *
 * Trend Architect
 * ================================================================== */

/**
 * Structural trend analysis.
 *
 * The hardest part of trend-following is not spotting a move; it is
 * refusing to treat a displacement as a trend. This skill exists to
 * enforce that separation, and to make the higher-timeframe claim
 * explicit rather than assumed.
 */
/**
 * Loads a shipped skill from its Markdown document.
 *
 * The Markdown is the source of truth, not a rendering of an object
 * literal. Every shipped skill is parsed by the same parser that reads a
 * user-authored skill, so:
 *
 *  - a shipped skill cannot be correct in the object model and wrong in
 *    the document a user would edit,
 *  - a skill document that cannot be parsed fails here, at import, with
 *    line numbers, rather than being quietly interpreted differently from
 *    its own source,
 *  - and the round trip through `toSkillMarkdown` is exercised by every
 *    test that loads the shipped set.
 *
 * The two placeholders exist because the capability lists are shared
 * constants. Writing forty capability names into ten documents would mean
 * ten places to keep in step with the tracker SDK, and the SDK is the thing
 * that should decide what a skill may require — not the skill document.
 */
function shippedSkill(
  document: string,
  options: { id: string; requires: string[]; grants: string[] },
): SkillPackage {
  const resolved = document
    // The document starts on the line after the opening backtick, which
    // reads better here and means nothing to the parser.
    .replace(/^\n+/, '')
    .replace('{{REQUIRES}}', options.requires.join(', '))
    .replace('{{GRANTS}}', options.grants.join(', '));

  const parsed = parseSkillMarkdown(resolved);

  if (!parsed.ok || !parsed.skill) {
    throw new Error(
      `Shipped skill "${options.id}" does not parse:\n  ${parsed.problems.join('\n  ')}`,
    );
  }

  // A document whose id disagrees with the constant that names it is a
  // rename that missed one of the two.
  if (parsed.skill.id !== options.id) {
    throw new Error(
      `Shipped skill "${options.id}" declares id "${parsed.skill.id}" in its document.`,
    );
  }

  return parsed.skill;
}

export const structuralTrendAnalysisSkill: SkillPackage = shippedSkill(`
---
id: structural-trend-analysis
name: Structural Trend Analysis
description: Establishes higher-timeframe directional context, separates a trend from a temporary displacement, and requires coherent continuation evidence before a trend is claimed.
order: 10
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Do not chase movement. Determine whether movement has structure. Wait for
confirmation. Participate only when invalidation is clearly defined.

A displacement is a fast, one-directional move that has not yet produced
a sequence of swings behind it. It is the most common way a market looks
like a trend and is not one. A trend is a sequence: successive higher
highs and higher lows (or the mirror), where each leg has a swing behind
it that price has respected.

Continuation evidence means independent agreement, not repetition. Three
observations of the same fact are one fact observed three times.

## GOAL_INTERPRETATION

When the goal asks for a trend, a continuation or a pullback, read it as a
claim about the swing sequence rather than about direction. "Trend" means
the sequence is intact. "Pullback" means a leg is retracing into a level
the prior leg respected.

## INVESTIGATION

Establish the higher-timeframe context first, before looking at anything
on the deployment timeframe. Use structure.swingHighs and
structure.swingLows to name the most recent confirmed swing high and swing
low on both timeframes, and note the last break of structure on each.

Then classify what is happening as one of: an intact directional sequence,
a range, a counter-trend displacement, or a market with no readable
structure. Say which, and why. "No readable structure" is a legitimate
finding and is more useful than a guess.

## THESIS_FORMATION

State the thesis as the structural claim it is: which swing must form for
this to be continuation, and which swing must break for it to be wrong.
If the thesis cannot be written as a sequence, it is a claim about an
indicator and should be discarded or restated.

The invalidation is the swing that would break the sequence, not a level
chosen for convenience.

## TRACKER_PLANNING

Deploy the trackers the thesis actually needs, and no others:
- the swing that would confirm continuation (BREAKOUT above the last
  higher low, or below the last lower high)
- the swing that would invalidate the thesis, on the higher timeframe
  where possible
- a momentum confirmation on the deployment timeframe, if the thesis
  requires momentum rather than structure alone
- a tracker for the invalidation on the higher timeframe, always

Set a cooldown on every one of them long enough that a single impulse
cannot wake you three times with one fact.

## EVENT_INTERPRETATION

A break in the direction of the thesis is a fact about structure. It is not
a confirmation until the retest has held, because a break that immediately
fails to hold is a break in the other direction.

Conflicting evidence is the important case. When one observation confirms
the thesis and another contradicts it, record both, say which is on the
higher timeframe, and treat the higher-timeframe objection as the one
that counts. Deciding to ignore an objection because the other side is
nicer is how a thesis becomes a position.

## THESIS_REVISION

Weaken on a break against the thesis that has not yet been confirmed.
Invalidate on a confirmed break of the sequence, meaning the break held
and the retest failed. These are different acts at different thresholds,
and conflating them throws a good thesis away early or keeps a dead one
too long.

Never raise confidence on a single observation. A thesis that can be
doubled in strength by one tracker event is a thesis that will be halved
by the next one.

## TRADE_CONSTRUCTION

Place the invalidation beyond the swing that breaks the sequence, not at a
round number and not inside the structure the thesis depends on. Derive
the size from the distance to that invalidation and the account, not from
conviction.

Refuse any idea whose invalidation sits inside the range that established
it. That is a stop that will be reached by ordinary noise.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- REQUIRE_INVALIDATION_BEFORE_TRADE
- REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION
- MAX_TRACKERS: 8
- MAX_THESES: 2

`, {
  id: 'structural-trend-analysis',
  requires: [...STRUCTURE_READING, ...INDICATOR_READING, ...MARKET_READING, ...ACCOUNT_AND_RISK],
  grants: OBSERVATION_AUTHORITY,
});

/* ================================================================== *
 * Shared discipline
 * ================================================================== */

/**
 * Patience.
 *
 * Shared by the trend and reversion GOATs, because both are vulnerable
 * to the same failure: acting because something is happening rather than
 * because something was confirmed.
 */
export const patienceSkill: SkillPackage = shippedSkill(`
---
id: patience
name: Patience
description: Requires confirmation after structural change, prefers waiting to acting on a low-quality setup, and treats an unconfirmed idea as no idea at all.
order: 20
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Prefer waiting. A missed move is a cost; a wrong one is a lesson with a
price tag.

Entering because price is moving is entering on the observation you were
given for free. What you are paid for is the part you had to work out.

## INVESTIGATION

Record what would have to be true before you would consider acting, before
you look for reasons it might be. A list written after the evidence is a
rationalisation, and it is recognisable because every item on it already
happened.

## THESIS_FORMATION

Require the confirmation to be stated in advance, in measurable terms, and
requiring more than one kind of evidence. "The trend continues" is not a
confirmation. "A pullback holds the last higher low and momentum recovers
on the deployment timeframe" is.

## TRACKER_PLANNING

Prefer fewer trackers with longer cooldowns over many with short ones. Six
trackers that each report every few minutes will wake you constantly and
tell you nothing; three that report on structural change will.

## EVENT_INTERPRETATION

An observation is a reason to reconsider, not a reason to act. Ask what
would still have to be true for the thesis to work, and check whether it
is. Most observations will leave you waiting, and that is the expected
outcome rather than a failure.

## TRADE_CONSTRUCTION

If the only reason to enter is that something has already happened, wait.
The idea will still be there after the confirmation, and it will be a
better idea then.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2

`, {
  id: 'patience',
  requires: [...MARKET_READING],
  grants: OBSERVATION_AUTHORITY,
});

/**
 * Risk discipline.
 *
 * Shared by all four starters. This is the skill that turns a thesis
 * into something that can be acted on at a known size, and it is the
 * one that most of the other skills depend on for their own limits.
 */
export const riskDisciplineSkill: SkillPackage = shippedSkill(`
---
id: risk-discipline
name: Risk Discipline
description: Requires a defined invalidation on every actionable thesis, rejects structurally invalid ideas, and sizes from the account rather than from conviction.
order: 30
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Every actionable thesis has a level at which it is wrong, stated before
any size is considered. If that level cannot be stated, there is no
thesis, and proposing an idea would be guessing with a position attached.

Size is a consequence of the distance to the invalidation, not a decision
made first and justified afterwards.

## GOAL_INTERPRETATION

Read "make money" and "be aggressive" as statements about risk posture, not
about direction. An aggressive goal that cannot say what it is willing to
lose is not actionable, and the questions below are the ones to ask.

## THESIS_FORMATION

Write the invalidation before the confirmation. The invalidation is the
observation that would prove this wrong; if you cannot name it, the thesis
is a feeling with a tracker attached.

## TRACKER_PLANNING

Always deploy a tracker for the thesis's own invalidation, on the highest
timeframe available. A thesis whose invalidation is not being watched is a
thesis that will be discovered to be wrong after it has cost money.

## EVENT_INTERPRETATION

If the invalidation level is reached, the thesis is invalid regardless of
how every other observation reads. Record that as invalidation, not as
something to be weighed against the other evidence.

## THESIS_REVISION

If a thesis cannot be stated with an invalidation, it cannot become
actionable, however good the supporting evidence looks. A thesis that
cannot say what would prove it wrong is not a thesis.

## TRADE_CONSTRUCTION

Derive the stop from the invalidation, then derive the size from the stop
distance and the account. Use account.getEquity, risk.calculateRisk and
risk.calculatePositionSize. Never widen an invalidation to make a size
fit, and never reduce a stop below the structure that gives the thesis
its meaning.

Reject an idea whose risk exceeds what the account can carry, even if the
thesis is your best one. The thesis can be taken again; the drawdown
cannot be undone.

## Constraints

- REQUIRE_INVALIDATION_BEFORE_TRADE
- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_TRACKERS: 6

`, {
  id: 'risk-discipline',
  requires: [...ACCOUNT_AND_RISK, ...MARKET_READING],
  grants: OBSERVATION_AUTHORITY,
});

/* ================================================================== *
 * Breakout Hunter
 * ================================================================== */

/**
 * Breakout structure.
 *
 * Compression and expansion is the whole subject. The skill's job is to
 * make the GOAT name the range it is watching, so that "a breakout" is
 * never a phrase without a level attached.
 */
export const breakoutStructureSkill: SkillPackage = shippedSkill(`
---
id: breakout-structure
name: Breakout Structure
description: Identifies compression and the structural boundaries holding it, and treats a break as a question answered rather than a trade taken.
order: 40
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Compression creates a question. A breakout provides evidence.
Confirmation determines whether the evidence matters.

Name the range before you care about the break. "A breakout" without a
named boundary is not an observation, it is a mood.

## INVESTIGATION

Locate the boundaries that are currently holding price, using
structure.supportResistance and the swing sequence. A range worth
watching has boundaries that have been respected more than once and is
narrow enough that the participant understands the risk.

Read the volatility regime with indicators.atr. Compression is a
contraction of range relative to recent movement, so a range that was
never volatile is not a range worth breaking out of.

## THESIS_FORMATION

Name the boundary, not "the resistance". "Gold breaks above 2,650 after
compressing for eleven sessions" is a thesis. "Gold breaks out" is not.

State what the break would mean and what its failure would look like,
before deciding whether either is plausible yet.

## TRACKER_PLANNING

Deploy two trackers where both are warranted, and never only the first:
- the break itself, as a PRICE_CROSS or BREAKOUT against the named level
- the retest, watching whether the broken level is held from the other
  side

A tracker on the break alone will report a level that was reclaimed two
bars later as a success. That is the specific failure this pair prevents.

Set the cooldown on both long enough that a single spike through the level
does not read as a break and a retest.

## EVENT_INTERPRETATION

A break is evidence about a level, not about direction. Decide whether the
break is being held, and keep deciding: the first observation after a
break is the least informative one.

## THESIS_REVISION

When a breakout thesis is invalidated, invalidate it. Holding a broken
breakout thesis because the original reasoning was good is how an agent
ends up defending a position with a story instead of an observation.

## TRADE_CONSTRUCTION

The invalidation belongs on the other side of the boundary, plus room for
the retest to fail cleanly. An idea whose invalidation is inside the range
it just left will be stopped by the range's own noise.

## Constraints

- REQUIRE_INVALIDATION_BEFORE_TRADE
- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_TRACKERS: 8

`, {
  id: 'breakout-structure',
  requires: [...STRUCTURE_READING, ...INDICATOR_READING, ...MARKET_READING, ...ACCOUNT_AND_RISK],
  grants: OBSERVATION_AUTHORITY,
});

/**
 * False-breakout detection.
 *
 * The single most valuable thing a breakout GOAT can do, and the reason
 * a retest tracker exists at all.
 */
export const falseBreakoutDetectionSkill: SkillPackage = shippedSkill(`
---
id: false-breakout-detection
name: False Breakout Detection
description: Distinguishes a real break from a sweep of a level, and treats a reclaimed boundary as evidence against the thesis rather than as a break in the other direction.
order: 41
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

A level that is taken and immediately given back was liquidity, not
structure. The event is called a sweep, and it is evidence *against* the
thesis that was waiting on the break — not evidence for the opposite
thesis, which is a distinction worth keeping, because "false break up"
frequently precedes a fall but does not promise one.

## INVESTIGATION

Note whether the level being watched has been swept before, and what
happened after. A boundary that has been swept twice is a level where
price reaches for liquidity and reverses; treat a break of it as needing
far more evidence than a break of a level that has held.

## THESIS_FORMATION

State the sweep explicitly as the failure case. A breakout thesis without a
named failure mode is a thesis that will be maintained indefinitely, which
is worse than not having one.

## TRACKER_PLANNING

Watch the reclaim, not just the break. A tracker for "price closes back
below the level it broke above" is what distinguishes the two outcomes,
and it must exist before the break happens.

## EVENT_INTERPRETATION

A reclaim of the broken level within a few bars is a failed break. Record
it as evidence against the thesis, state whether the level has now been
swept rather than broken, and do not convert it into a thesis about the
opposite direction without independent evidence.

## THESIS_REVISION

One failed break weakens the thesis. Two failed breaks of the same level
invalidate it: the boundary is doing the opposite of what the thesis
assumed, and the premise needs to be restated rather than retried.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_TRACKERS: 8

`, {
  id: 'false-breakout-detection',
  requires: [],
  grants: OBSERVATION_AUTHORITY,
});

/**
 * Confirmation discipline.
 *
 * Shared by the breakout and session GOATs, which both act on evidence
 * that is only ever provisional at the moment it arrives.
 */
export const confirmationDisciplineSkill: SkillPackage = shippedSkill(`
---
id: confirmation-discipline
name: Confirmation Discipline
description: Requires the confirmation that follows an event before it counts as evidence for a thesis, and keeps a hypothesis revisable rather than merely maintained.
order: 42
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

The observation that fires a tracker is the one you already had. The
information is in what happens next, and a GOAT that acts on the first
observation is acting on the information it was given for free.

## THESIS_FORMATION

State the confirmation that would be required, and be specific about what
would not count. "Volume confirms" is not a requirement; "the retest holds
above the level for at least two closes" is.

## TRACKER_PLANNING

Where a thesis needs a confirmation, the confirmation needs a tracker. A
confirmation that is waited for without being watched is a confirmation
that will be noticed late, if at all.

## EVENT_INTERPRETATION

Classify every observation as one of: confirms, weakens, neither. "Neither"
is a legitimate and common result, and it is the correct answer far more
often than confirmation.

## THESIS_REVISION

Keep the thesis revisable. A hypothesis that can only be strengthened is
not a hypothesis, it is a position. When evidence is ambiguous, prefer
weakening over confirming, because an over-strengthened thesis is harder
to escape than a weak one.

## TRADE_CONSTRUCTION

Require the confirmation to have actually been observed before an idea is
constructed from the thesis. An idea built on an unconfirmed break is a
bet on the next bar, priced as though it were a conclusion.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2

`, {
  id: 'confirmation-discipline',
  requires: [...MARKET_READING],
  grants: OBSERVATION_AUTHORITY,
});

/* ================================================================== *
 * Mean Reversion Analyst
 * ================================================================== */

/**
 * Reversion structure.
 *
 * The skill whose main job is to prevent the most common failure of a
 * reversion agent: "it moved a lot, therefore it will come back".
 */
export const reversionStructureSkill: SkillPackage = shippedSkill(`
---
id: reversion-structure
name: Reversion Structure
description: Determines whether a market is genuinely stretched from its own equilibrium, and whether there is evidence of reversion rather than merely a large move.
order: 50
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

An extreme is not automatically a reversal. First determine whether the
market is stretched; then determine whether there is evidence of the
stretch resolving.

"Price moved a lot, therefore short it" and "price fell a lot, therefore
buy it" are the same error. A large move is a measurement, not a reason.
The reason has to be that the move has gone somewhere the market is
unlikely to stay.

## INVESTIGATION

Establish what "normal" has been for this market, over a window long
enough to be meaningful, and measure the current distance from it in
terms of the market's own volatility rather than in pips. Use
indicators.atr to size the distance, and market.getBars to find the range
price has been occupying.

Then ask the prior question: has this market moved away from equilibrium
before, and what happened next? A market that trends is one where a large
move is an early signal rather than a late one.

## THESIS_FORMATION

A reversion thesis is a claim about a return toward a level that has
reasonably been respected. State the level, and state the reason the
market is expected to respect it again. "It is extended" is a measurement;
"it is extended from a range it has respected four times, with momentum
failing to extend further" is a thesis.

## TRACKER_PLANNING

Deploy:
- a tracker for the level price would have to reclaim or lose to show the
  reversion has begun
- a tracker for continuation beyond the extreme, so the thesis is
  falsified by observation rather than by patience
- an exhaustion tracker where the thesis depends on the move running out
  of fuel rather than reversing

The continuation tracker is the one that matters. Without it, a reversion
thesis has no way to be told it is wrong.

## EVENT_INTERPRETATION

A new extreme is not evidence for the thesis. In a market that has just
reached an extreme and made another, the more likely reading is that the
regime is different from the one the thesis assumed — unless there is
independent evidence of exhaustion, which is rare and should be named as
rare.

## THESIS_REVISION

Invalidate a reversion thesis when price continues decisively beyond the
extreme. The reason to hold a mean-reverting thesis is that the extreme is
unusual, and a continuing move is evidence that it is not.

## TRADE_CONSTRUCTION

The invalidation is beyond the extreme, not at it. A reversion idea stopped
at the high is stopped by the ordinary process that made the high.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 3
- REQUIRE_INVALIDATION_BEFORE_TRADE
- MAX_TRACKERS: 6

`, {
  id: 'reversion-structure',
  requires: [...MARKET_READING, ...INDICATOR_READING],
  grants: OBSERVATION_AUTHORITY,
});

/**
 * Regime awareness.
 *
 * The question every reversion thesis has to answer before it is
 * entertained: is this a reverting market or a trending one?
 */
export const regimeAwarenessSkill: SkillPackage = shippedSkill(`
---
id: regime-awareness
name: Regime Awareness
description: Classifies the market as ranging, trending or transitioning before any reversion claim is made, and treats a regime change as invalidating a thesis formed in the previous one.
order: 51
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

A reversion thesis is a bet on the regime continuing. In a trending
regime it is a bet against it, and it needs evidence that is
correspondingly stronger.

Classify the regime explicitly, on every investigation, and record the
classification in the evidence. Unclassified is not an option: it is
where most mistakes live.

## INVESTIGATION

Classify the regime from the swing sequence, not from a single indicator:
- ranging: overlapping swings, no sequence of higher highs or lower lows
- trending: a sequence, with pullbacks that hold
- transitioning: the sequence has broken but the new one has not formed

Note the timeframe the classification was made on. A market can be ranging
on the deployment timeframe and trending on the higher one, and that
combination is where most mean-reversion ideas go wrong.

## THESIS_FORMATION

State the regime the thesis assumes, and what would show the assumption to
be wrong. "This reverts because it is ranging" and "this reverts because
it is trending" are different theses with different risks, and a thesis
that does not say which one it is relying on cannot be evaluated.

## TRACKER_PLANNING

Deploy a tracker for the structure that would show the regime has changed,
in addition to the reversion tracker. A reversion thesis watched only for
reversion will be told it is right right up until it is very wrong.

## EVENT_INTERPRETATION

When the regime classification changes, say so plainly and reconsider every
live thesis that was formed under the previous one. A thesis formed in a
ranging market is not automatically still true in a trending one, even if
its level has not been touched.

## THESIS_REVISION

Weaken a reversion thesis when the regime is ambiguous. Invalidate it when
the regime has clearly changed. Do not carry it across a regime boundary
because the original reasoning was sound.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_THESES: 2

`, {
  id: 'regime-awareness',
  requires: [...STRUCTURE_READING, ...INDICATOR_READING],
  grants: OBSERVATION_AUTHORITY,
});

/* ================================================================== *
 * Session Hunter
 * ================================================================== */

/**
 * Session structure.
 *
 * Time is contextual evidence. This skill exists to stop a session
 * boundary being read as a signal.
 */
export const sessionStructureSkill: SkillPackage = shippedSkill(`
---
id: session-structure
name: Session Structure
description: Reads session boundaries, opening ranges and session extremes as context for a structural claim, never as a reason in themselves.
order: 60
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Time is context, not a trigger. A session open is where behaviour changes;
it is not evidence that anything will move.

Every session-based claim must be a claim about structure that happens to
be time-bounded. "The London open breaks the Asian range" is a structural
claim. "It's the London open" is a schedule.

## INVESTIGATION

Establish where the session boundaries fall for the market being traded, and
what the prior session did: its range, where it started, where it closed
relative to its own midpoint, and whether the extremes were respected
afterwards. Use market.getSession for the boundaries and market.getBars
for what actually happened.

That history is the base rate. A session that has respected its high six
times out of the last eight is different from one that has not.

## THESIS_FORMATION

State the session claim as structure plus time: which level, in which
session, with what history. Note explicitly that the time component is
context. If removing the session from the sentence leaves something
meaningful, the thesis is sound; if it leaves nothing, the thesis is a
schedule.

## TRACKER_PLANNING

Deploy trackers for the structural levels and let the session be the
context, rather than deploying a tracker per session boundary:
- the session's prior extreme, as the level that matters
- the opening range boundary, once the range has formed
- the invalidation, always

A tracker that fires every session boundary reports a calendar, not a
market. Use a SCHEDULED tracker only to re-examine the setup, and set it
so it does not wake you on boundaries that carry no open thesis.

## EVENT_INTERPRETATION

A session boundary is not a confirmation. Ask what the structure says, and
use the session only to explain why the structure might be more or less
reliable right now.

## THESIS_REVISION

When a session-based thesis reaches its time limit without its structural
condition being met, abandon it. It is not a thesis that is going to
resolve itself; it is one whose window has closed.

## TRADE_CONSTRUCTION

The invalidation is structural, not time-based. A session idea that can only
be "right" until a clock says otherwise is a timed bet, and it should say
so in its reasoning.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- REQUIRE_INVALIDATION_BEFORE_TRADE
- MAX_TRACKERS: 6
- MAX_THESES: 2

`, {
  id: 'session-structure',
  requires: [...STRUCTURE_READING, ...MARKET_READING],
  grants: OBSERVATION_AUTHORITY,
});

/**
 * Volatility awareness.
 *
 * Shared with the session GOAT for the specific reason that session
 * boundaries are volatility events, and with the trend GOAT because a
 * trend in a dead market is not a trend worth trading.
 */
export const volatilityAwarenessSkill: SkillPackage = shippedSkill(`
---
id: volatility-awareness
name: Volatility Awareness
description: Reads the volatility regime before sizing or trusting a level, and treats expansion and contraction as context for every other judgement.
order: 61
requires: {{REQUIRES}}
grants: {{GRANTS}}
---

Volatility decides whether anything is worth doing. A correct
identification in a dead market is not an opportunity, and a level that
was respected yesterday is not a level today.

Size from the distance, not from the account alone. If the invalidation
is far away because the market is moving, the position is smaller, and
that is a feature.

## INVESTIGATION

Measure the current volatility regime with indicators.atr before forming
any opinion about a level's significance. Note where the current reading
sits against the market's own recent history, since an absolute ATR means
nothing without context.

A level inside the current daily range is noise. A level at the edge of it
is structure.

## THESIS_FORMATION

State the volatility the thesis assumes. "This holds while volatility
expands from here" and "this holds in a contracting range" are different
claims, and the difference decides whether the invalidation is likely to be
reached by noise.

## TRACKER_PLANNING

Deploy an expansion or contraction tracker when the thesis depends on
volatility changing, and prefer level-based trackers otherwise. A
volatility tracker fires often; give it a long cooldown and a high rate
limit or it will crowd out the structural observations.

## EVENT_INTERPRETATION

An expansion or contraction is a change in the conditions the thesis was
formed under. Ask whether the thesis still means what it meant. A
structural break during a volatility expansion is less reliable evidence
than the same break during a contraction, and the difference is worth
recording.

## THESIS_REVISION

Weaken a thesis when its assumptions about volatility no longer hold.
Invalidate it when volatility expands against it in a way the invalidation
was not wide enough to survive — and note that as a statement about the
invalidation's width, not about the thesis being wrong.

## TRADE_CONSTRUCTION

Derive size from the distance to the invalidation and the current
volatility. A wider stop demands a smaller position; a tighter stop in a
volatile market is a stop that will be taken out by the ordinary
movement of the market, and an idea with such a stop should be rejected
rather than resized.

## Constraints

- REQUIRE_INVALIDATION_BEFORE_TRADE
- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2

`, {
  id: 'volatility-awareness',
  requires: [...MARKET_READING],
  grants: OBSERVATION_AUTHORITY,
});

/* ================================================================== *
 * The shipped set
 * ================================================================== */

/**
 * Every skill a starter GOAT can be built from.
 *
 * The list is also the contract: `starterGoats.ts` asserts at import
 * time that every starter's skills exist here, so a starter cannot
 * reference a skill the product does not ship.
 */
export const GOAT_BUILTIN_SKILLS: SkillPackage[] = [
  structuralTrendAnalysisSkill,
  patienceSkill,
  riskDisciplineSkill,
  breakoutStructureSkill,
  falseBreakoutDetectionSkill,
  confirmationDisciplineSkill,
  reversionStructureSkill,
  regimeAwarenessSkill,
  sessionStructureSkill,
  volatilityAwarenessSkill,
];

/** Every skill id the shipped skills require or grant, for the loader. */
export const BUILTIN_SKILL_IDS: string[] = GOAT_BUILTIN_SKILLS.map((skill) => skill.id);
