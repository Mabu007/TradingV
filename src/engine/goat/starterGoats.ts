/**
 * Starter GOATs.
 *
 * These are pre-authored Goal + Skill combinations, and nothing more.
 * Each one is a real `GoatDefinition` that goes through the same
 * validation, compiles to the same runtime agent, uses the same Tracker
 * SDK and Tracker Runtime, and produces decisions through the same risk
 * and validation boundary as a GOAT a user wrote themselves. Creating one
 * from the Explorer takes exactly the path a typed goal takes: there is
 * no special execution path, no privileged runtime, and no observation
 * plan attached.
 *
 * What a starter is allowed to be is a good default. It states an
 * outcome, names the skills that make that outcome reachable, and
 * declares the ceilings and the decision policy that follow from its
 * philosophy. It does not state an indicator, a level, a timeframe, or a
 * market, because a starter that specified its own method would be the
 * thing this architecture replaced.
 */

import { GoatDefinition, DEFAULT_AI_MODEL } from './definition';
import { GOAT_BUILTIN_SKILLS } from './builtinSkills';

/**
 * The version every shipped skill is published at.
 *
 * Bumped when a skill's guidance changes materially. A GOAT created
 * against version 1 keeps referring to version 1, which is what makes an
 * old decision explicable after the skill has been rewritten.
 */
export const STARTER_SKILL_VERSION = 1;

function skill(id: string, version = STARTER_SKILL_VERSION) {
  return { id, version };
}

function base(input: {
  id: string;
  name: string;
  description: string;
  goal: string;
  philosophy: string;
  watches: string;
  interests: string;
  dormant: string;
  riskPosture: string;
  markets: string[];
  skills: Array<{ id: string; version?: number }>;
  createdAt: number;
  riskPerTrade?: number;
  maxPositions?: number;
  maxActiveTheses?: number;
  maxActiveTrackers?: number;
  decisionPolicy: string;
  reasoningMode?: GoatDefinition['agentConfig']['reasoningMode'];
}): GoatDefinition {
  return {
    schemaVersion: 1,
    version: 1,
    source: 'starter',
    identity: { id: input.id, name: input.name, description: input.description },
    goal: { statement: input.goal, symbols: [], excludedSymbols: [] },
    skills: input.skills.map((s) => skill(s.id, s.version)),
    capabilities: {
      readMarketData: true,
      readHistoricalData: true,
      readAccount: true,
      readPositions: true,
      manageTrackers: true,
      manageThesis: true,
      proposeTrades: true,
      /*
       * No starter GOAT requests execution. That is granted per
       * deployment by a human who has read what the GOAT has been
       * doing, and a template that shipped with trading authority
       * would hand it away before anyone had seen a single decision.
       */
      requestExecution: false,
    },
    agentConfig: {
      provider: 'openrouter',
      model: DEFAULT_AI_MODEL,
      reasoningMode: input.reasoningMode ?? 'advisory',
      confidenceThreshold: 0.7,
      decisionPolicy: input.decisionPolicy,
      maxIterations: 8,
    },
    riskPolicy: {
      riskPerTrade: input.riskPerTrade ?? 0.005,
      maxPositions: input.maxPositions ?? 1,
      maxExposure: 50_000,
      cooldownMs: 60_000,
      maxActiveTheses: input.maxActiveTheses ?? 2,
      maxActiveTrackers: input.maxActiveTrackers ?? 8,
      maxWakeupsPerHour: 20,
      maxToolCallsPerCycle: 24,
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/**
 * The four shipped starters.
 *
 * Each states a goal in outcome terms and carries a philosophy the
 * skills are chosen to produce. The four cover the four genuinely
 * different ways of being wrong about a market: mistaking a displacement
 * for a trend, mistaking a sweep for a breakout, mistaking an extreme for
 * a reversal, and mistaking a clock for a reason.
 */
export const STARTER_GOATS: GoatDefinition[] = [
  base({
    id: 'trend-architect',
    name: 'Trend Architect',
    description:
      'Participates only in sustained directional structure, and only once several independent forms of evidence agree.',
    goal: 'Identify markets that are in a sustained directional move, and keep watching while that structure is still intact.',
    philosophy: [
      'Do not chase movement.',
      'Determine whether movement has structure.',
      'Wait for confirmation.',
      'Participate only when invalidation is clearly defined.',
    ].join(' '),
    watches:
      'Higher-timeframe swing structure, directional persistence, pullbacks that hold prior structure, continuation quality, and whether momentum confirms the leg rather than diverging from it.',
    interests: `A break of the last higher low (or last lower high) on the higher
timeframe, with momentum recovering on the deployment timeframe and the
pullback having respected the structure it is retracing into.`,
    dormant: `While the higher-timeframe sequence is intact but unconfirmed, while
structure is unreadable, while the evidence for and against conflicts and
the higher-timeframe objection is the one that counts, and whenever the
invalidation cannot be stated.`,
    riskPosture:
      'Conservative. Requires two independent pieces of evidence and a higher-timeframe confirmation before a thesis may become actionable, one position at a time, and no idea without an explicit invalidation level.',
    markets: ['Forex', 'Commodities', 'Indices'],
    skills: [
      { id: 'structural-trend-analysis' },
      { id: 'patience' },
      { id: 'risk-discipline' },
    ],
    createdAt: 0,
    maxActiveTheses: 2,
    maxActiveTrackers: 8,
    decisionPolicy:
      'Report what is developing, what would show it is failing, and which observations agree. Do not propose a trade until the higher-timeframe sequence is confirmed, momentum is behind it, and the level that would prove the thesis wrong can be stated. A displacement is not a trend.',
  }),
  base({
    id: 'breakout-hunter',
    name: 'Breakout Hunter',
    description:
      'Investigates compression and structural boundaries, then watches whether a break is real, or a sweep of a level.',
    goal: 'Find markets compressed against a structural boundary, and judge whether a break is holding or being taken back.',
    philosophy: [
      'Compression creates a question.',
      'A breakout provides evidence.',
      'Confirmation determines whether the evidence matters.',
    ].join(' '),
    watches:
      'Ranges and compression, support and resistance that has held more than once, volatility expansion, whether a break is being held, whether a retest holds, and whether a reclaimed boundary was a sweep.',
    interests: `Price escaping a named boundary after compression, the broken level
holding on the retest, momentum expanding rather than fading, and the
range being left behind rather than immediately re-entered.`,
    dormant: `Before the range has formed, while the break has not yet held, after a
boundary has been reclaimed (a failed break is evidence against the thesis,
not for the opposite one), and whenever the same level has been swept
twice without holding.`,
    riskPosture:
      'Measured. Requires two pieces of evidence and an explicit invalidation beyond the boundary, and caps itself at eight trackers so it cannot watch itself into a hundred positions.',
    markets: ['Forex', 'Commodities', 'Indices'],
    skills: [
      { id: 'breakout-structure' },
      { id: 'false-breakout-detection' },
      { id: 'confirmation-discipline' },
      { id: 'risk-discipline' },
    ],
    createdAt: 0,
    maxActiveTheses: 2,
    maxActiveTrackers: 8,
    decisionPolicy:
      'Name the range and the boundary before caring about the break. A break is only interesting once it has held through a retest; a level reclaimed within a few bars is a sweep. Invalidate a breakout thesis when the premise fails rather than defending it because the original reasoning was good.',
  }),
  base({
    id: 'mean-reversion-analyst',
    name: 'Mean Reversion Analyst',
    description:
      'Investigates stretched conditions, and works out whether price will revert or whether the stretch is the start of a new regime.',
    goal: 'Find markets that have moved unusually far from their own recent behaviour, and judge whether that is resolving or extending.',
    philosophy: [
      'An extreme is not automatically a reversal.',
      'First determine whether the market is stretched,',
      'then determine whether there is evidence of reversion.',
    ].join(' '),
    watches:
      'Distance from recent equilibrium measured against the market’s own volatility, the volatility regime, the directional context, failure of continuation, exhaustion, return toward a level that has been respected, and changes of regime.',
    interests: `Price reaching an extreme it has not reached in a long window, from a
range it has respected more than once, with continuation failing to extend
it further and the market reclaiming toward the level it came from.`,
    dormant: `While the market is trending rather than ranging, while the extreme is
extending rather than resolving, while the regime classification is
ambiguous, and whenever a continuation tracker has reported a new
extreme.`,
    riskPosture:
      'The most cautious of the four. Requires three pieces of evidence before a thesis may become actionable, because "it moved a lot" is the weakest claim any of these GOATs can make.',
    markets: ['Forex', 'Commodities', 'Indices'],
    skills: [
      { id: 'reversion-structure' },
      { id: 'regime-awareness' },
      { id: 'patience' },
      { id: 'risk-discipline' },
    ],
    createdAt: 0,
    maxActiveTheses: 2,
    maxActiveTrackers: 6,
    decisionPolicy:
      'Classify the regime before anything else: ranging, trending, or transitioning. A large move is a measurement, not a reason. Invalidate a reversion thesis when price continues decisively beyond the extreme, and never carry a thesis across a regime boundary because the original reasoning was sound.',
  }),
  base({
    id: 'session-hunter',
    name: 'Session Hunter',
    description:
      'Studies time-dependent behaviour, and investigates session transitions, volatility changes and the structure around them.',
    goal: 'Find markets behaving unusually around a session transition, and watch how that behaviour develops.',
    philosophy: [
      'Time is context, not a reason.',
      'A session boundary is where behaviour changes, not evidence that it will.',
      'Every session claim is a structural claim that happens to be time-bounded.',
    ].join(' '),
    watches:
      'Session boundaries and what each session actually did, volatility expanding or contracting around a transition, session highs and lows and whether they held, opening ranges, and the structure that forms after a session transition.',
    interests: `A named session level being respected or broken with the session’s own
history behind it, an opening range being left behind, volatility expanding
into a session rather than contracting out of it, and continuation after a
transition that holds on the following session.`,
    dormant: `Outside a session transition, before an opening range has formed, when the
session’s prior extremes have been swept rather than held, when the
time limit on a session thesis passes without its structural condition
being met, and whenever the claim would still make sense with the session
removed from it.`,
    riskPosture:
      'Conservative, and time-limited by design. Two pieces of evidence, an explicit structural invalidation, at most two live theses, and no idea whose validity depends only on the clock.',
    markets: ['Forex', 'Commodities', 'Indices'],
    skills: [
      { id: 'session-structure' },
      { id: 'volatility-awareness' },
      { id: 'confirmation-discipline' },
      { id: 'risk-discipline' },
    ],
    createdAt: 0,
    maxActiveTheses: 2,
    maxActiveTrackers: 6,
    decisionPolicy:
      'A session open is where behaviour changes; it is not evidence that anything will move. Every session thesis must name a structural level with the session history behind it. When a session thesis reaches its time limit without its structural condition, abandon it rather than extending it.',
  }),
];

/** Every skill id a starter depends on, validated against the registry. */
export function starterSkillIds(): string[] {
  return [...new Set(STARTER_GOATS.flatMap((goat) => goat.skills.map((s) => s.id)))];
}

/** Fail loudly at import time if a starter names a skill that does not exist. */
export function assertStarterSkillsResolve(): void {
  const known = new Set(GOAT_BUILTIN_SKILLS.map((s) => s.id));
  const missing = starterSkillIds().filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Starter GOATs reference skills that are not registered: ${missing.join(', ')}.`,
    );
  }
}

assertStarterSkillsResolve();

/* ================================================================== *
 * The Explorer view of a starter
 * ================================================================== */

/**
 * What the Explorer shows, kept out of the definition itself.
 *
 * A `GoatDefinition` is a validated execution artefact: it has a goal,
 * skills, capabilities and a risk policy, and nothing in it exists to be
 * read by a human deciding whether to try it. The philosophy, what the
 * GOAT watches for, what makes it interested, and what leaves it dormant
 * are the parts a person needs before deploying, and they are answers
 * about the GOAT rather than configuration for it.
 *
 * Keeping them here rather than in the definition is what stops the
 * schema growing fields for marketing copy, and it is why a GOAT a user
 * writes can be shown the same way without those fields existing.
 */
export interface StarterGoatProfile {
  /** Stable id of the starter, matching the definition. */
  id: string;
  name: string;
  version: number;
  /** One or two sentences, for a card. */
  description: string;
  /** The goal, verbatim. What the GOAT is for. */
  goal: string;
  /** How it thinks, in the author's own words. */
  philosophy: string;
  /** What it spends its time looking at. */
  watches: string;
  /** The specific observations that make it act. */
  interests: string;
  /** The conditions under which it deliberately does nothing. */
  dormant: string;
  /** How it behaves with risk, in the author's words. */
  riskPosture: string;
  /** Asset classes it is designed for. */
  markets: string[];
  /** Skill names, resolved for display. */
  skills: Array<{ id: string; name: string; description: string }>;
  /**
   * Whether it is intended to be tried in SHADOW before anything else.
   *
   * Every starter is, because none of them ships with execution
   * authority. The field exists so the Explorer can say so explicitly
   * rather than leaving the user to infer it from a mode they have not
   * chosen yet.
   */
  shadowFirst: boolean;
  /**
   * Rules a person should know about and the runtime cannot enforce.
   *
   * Stated rather than implied. "Does not act when evidence conflicts" is
   * real guidance in the skills and not a guarantee, and pretending
   * otherwise in the Explorer would be the worst place to do it.
   */
  unenforcedRules: string[];
}

const UNENFORCED_RULES: Record<string, string[]> = {
  'trend-architect': [
    'Does not act while higher-timeframe structural evidence conflicts. The skills say so in guidance; the runtime cannot check it.',
    'Treats a displacement as distinct from a trend. That judgement is the GOAT’s, made in prose rather than by a rule.',
  ],
  'breakout-hunter': [
    'Distinguishes a genuine break from a sweep of a level. A reclaim tracker is deployed, but the judgement that a level was swept is the GOAT’s.',
    'Abandons a breakout thesis whose premise has failed, rather than defending it. Encouraged by the false-breakout skill, not enforced.',
  ],
  'mean-reversion-analyst': [
    'Resists "it moved a lot, therefore it will come back". The strongest of the four on this, and still a judgement rather than a rule.',
    'Classifies ranging, trending and transitioning regimes itself. No capability classifies a regime; the classification is reasoning.',
  ],
  'session-hunter': [
    'Treats a session boundary as context rather than as a signal. Enforced only as guidance — the runtime has no notion of a session signal.',
    'Abandons a session thesis when its time limit passes. Nothing in the runtime can expire a thesis on a clock.',
  ],
};

/**
 * Build the Explorer profile for a starter.
 *
 * Derived from the definition rather than authored beside it, so the
 * card cannot drift from the GOAT that will actually be created: the
 * goal and the skills come from the same place the creation path uses.
 */
export function starterProfile(definition: GoatDefinition): StarterGoatProfile {
  const skills = definition.skills.map((reference) => {
    const skill = GOAT_BUILTIN_SKILLS.find((candidate) => candidate.id === reference.id);
    return {
      id: reference.id,
      name: skill?.name ?? reference.id,
      description: skill?.description ?? 'A skill that ships with TradingGOATs.',
    };
  });

  return {
    id: definition.identity.id,
    name: definition.identity.name,
    version: definition.version,
    description: definition.identity.description,
    goal: definition.goal.statement,
    philosophy: philosophyFor(definition.identity.id),
    watches: watchesFor(definition.identity.id),
    interests: interestsFor(definition.identity.id),
    dormant: dormantFor(definition.identity.id),
    riskPosture: riskPostureFor(definition),
    markets: marketsFor(definition.identity.id),
    skills,
    shadowFirst: true,
    unenforcedRules: UNENFORCED_RULES[definition.identity.id] ?? [],
  };
}

/** Every starter, in Explorer order. */
export function starterProfiles(): StarterGoatProfile[] {
  return STARTER_GOATS.map(starterProfile);
}

/** One starter by id, for the detail view. */
export function starterProfileById(id: string): StarterGoatProfile | undefined {
  const definition = STARTER_GOATS.find((candidate) => candidate.identity.id === id);
  return definition ? starterProfile(definition) : undefined;
}

const COPY: Record<string, { philosophy: string; watches: string; interests: string; dormant: string; markets: string[] }> = {
  'trend-architect': {
    philosophy:
      'Do not chase movement. Determine whether movement has structure. Wait for confirmation. Participate only when invalidation is clearly defined.',
    watches:
      'Higher-timeframe swing structure, directional persistence, pullbacks that hold prior structure, continuation quality, and whether momentum confirms the leg rather than diverging from it.',
    interests:
      'A break of the last higher low (or last lower high) on the higher timeframe, with momentum recovering on the deployment timeframe and the pullback having respected the structure it is retracing into.',
    dormant:
      'While the higher-timeframe sequence is intact but unconfirmed, while structure is unreadable, while the evidence conflicts and the higher-timeframe objection is the one that counts, and whenever the invalidation cannot be stated.',
    markets: ['Forex', 'Commodities', 'Indices'],
  },
  'breakout-hunter': {
    philosophy:
      'Compression creates a question. A breakout provides evidence. Confirmation determines whether the evidence matters.',
    watches:
      'Ranges and compression, support and resistance that has held more than once, volatility expansion, whether a break is being held, whether a retest holds, and whether a reclaimed boundary was a sweep.',
    interests:
      'Price escaping a named boundary after compression, the broken level holding on the retest, momentum expanding rather than fading, and the range being left behind rather than immediately re-entered.',
    dormant:
      'Before the range has formed, while the break has not yet held, after a boundary has been reclaimed, and whenever the same level has been swept twice without holding.',
    markets: ['Forex', 'Commodities', 'Indices'],
  },
  'mean-reversion-analyst': {
    philosophy:
      'An extreme is not automatically a reversal. First determine whether the market is stretched, then determine whether there is evidence of reversion.',
    watches:
      'Distance from recent equilibrium measured against the market’s own volatility, the volatility regime, the directional context, failure of continuation, exhaustion, return toward a respected level, and changes of regime.',
    interests:
      'Price reaching an extreme it has not reached in a long window, from a range it has respected more than once, with continuation failing to extend it further and the market reclaiming toward the level it came from.',
    dormant:
      'While the market is trending rather than ranging, while the extreme is extending rather than resolving, while the regime classification is ambiguous, and whenever a continuation tracker has reported a new extreme.',
    markets: ['Forex', 'Commodities', 'Indices'],
  },
  'session-hunter': {
    philosophy:
      'Time is context, not a reason. A session boundary is where behaviour changes, not evidence that it will. Every session claim is a structural claim that happens to be time-bounded.',
    watches:
      'Session boundaries and what each session actually did, volatility expanding or contracting around a transition, session highs and lows and whether they held, opening ranges, and the structure that forms after a transition.',
    interests:
      'A named session level being respected or broken with the session’s own history behind it, an opening range being left behind, volatility expanding into a session rather than contracting out of it, and continuation that holds on the following session.',
    dormant:
      'Outside a session transition, before an opening range has formed, when a session’s prior extremes have been swept rather than held, when a session thesis passes its time limit unmet, and whenever the claim would read the same with the session removed.',
    markets: ['Forex', 'Commodities', 'Indices'],
  },
};

function philosophyFor(id: string): string {
  return COPY[id]?.philosophy ?? 'Stated as an outcome, and left to the GOAT.';
}

function watchesFor(id: string): string {
  return COPY[id]?.watches ?? 'Decided per thesis, not in advance.';
}

function interestsFor(id: string): string {
  return COPY[id]?.interests ?? 'Whatever the thesis it is currently working requires.';
}

function dormantFor(id: string): string {
  return COPY[id]?.dormant ?? 'Whenever its evidence is unconfirmed or conflicting.';
}

function marketsFor(id: string): string[] {
  return COPY[id]?.markets ?? ['Forex', 'Commodities', 'Indices'];
}

/**
 * The risk posture, read off the definition rather than written twice.
 *
 * These are the numbers the definition actually validates against, so
 * the card cannot claim a posture the deployment will not enforce.
 */
function riskPostureFor(definition: GoatDefinition): string {
  const risk = definition.riskPolicy;
  const percentages = [
    `${(risk.riskPerTrade * 100).toFixed(2)}% of the account at risk`,
    `at most ${risk.maxPositions} position${risk.maxPositions === 1 ? '' : 's'} at a time`,
    `at most ${risk.maxActiveTheses} live hypotheses and ${risk.maxActiveTrackers} trackers`,
    'no idea without an explicit invalidation level',
  ];
  return `${percentages.join(', ')}. Ships without execution authority: a deployment decides whether it may trade.`;
}
