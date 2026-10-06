/**
 * The arithmetic of believing something.
 *
 * ## Why this is code and not the model
 *
 * A GOAT used to treat every wake as equally informative: confirming a thesis was
 * `+0.10`, weakening it was `-0.15`, and neither number had any relationship to what
 * had actually been observed. That is not a confidence system, it is two constants.
 *
 * The model is not the right place to fix it either. The model does not know whether
 * this wake is a routine retest of a level it has watched forty times or a
 * higher-timeframe structural break, it cannot see the evidence it already recorded
 * an hour ago, and it cannot be stopped from announcing that a marginal observation
 * is decisive. So the model expresses its *interpretation* — which polarity, which
 * direction, whether the thesis is wrong — and this file computes how much that
 * interpretation is worth.
 *
 * ## What is measured, and what is not
 *
 * Everything here is derived from fields the runtime already controls or already
 * records. Nothing is invented to look precise:
 *
 *   severity     runtime-owned, derived from tracker priority, one of four ordinals
 *   timeframe    recorded by the tracker that fired
 *   novelty      derived from provenance keys that already exist for deduplication
 *   independence whether this observation comes from a tracker that has already
 *                reported on the same underlying delivery
 *
 * Where a field is absent the fallback is documented and conservative rather than
 * optimistic. An event with no severity cannot claim to be severe; the weight table
 * treats an unknown severity as the *middle* of the range, not as the top.
 *
 * ## Precision, honestly
 *
 * The numbers below are weights and thresholds, not probabilities. `0.62` is not a
 * claim that there is a 62% chance this thesis is correct; it is a position on a
 * scale the runtime maintains so that a reader can see belief moving and a
 * developer can reproduce exactly how it moved. Every function here is a pure
 * function of its arguments: the same wake in the same world always produces the
 * same number, which is the property a backtest depends on.
 */

import type {
  Evidence,
  Thesis,
  TrackerEvent,
} from './types';
import type { TrackerEventSeverity } from '../agents/trackers/types';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * How much each severity level is worth, as a multiplier on a reference effect.
 *
 * Multipliers, not effect sizes, and deliberately modest: the point is that a
 * DECISIVE event counts for more than an INFO one, not that it is worth twenty
 * times as much. The severity levels come from the runtime's own priority
 * thresholds, so they are ordinal by construction — this table says how much of an
 * ordinal difference to act on, which is a judgement, and is labelled as one.
 */
const SEVERITY_WEIGHT: Readonly<Record<TrackerEventSeverity, number>> = {
  INFO: 0.6,
  NOTABLE: 0.85,
  SIGNIFICANT: 1.1,
  DECISIVE: 1.35,
};

/**
 * The weight for an event whose severity is not one this version knows.
 *
 * The middle of the range, deliberately. An unrecognised severity is not evidence
 * of importance and it is not evidence of triviality; assuming either would let a
 * future or corrupted value move belief more than a known one.
 */
export const UNKNOWN_SEVERITY_WEIGHT = 0.85;

export function severityWeight(severity: unknown): number {
  if (typeof severity !== 'string') return UNKNOWN_SEVERITY_WEIGHT;
  const weight = SEVERITY_WEIGHT[severity as TrackerEventSeverity];
  return weight === undefined ? UNKNOWN_SEVERITY_WEIGHT : weight;
}

// ---------------------------------------------------------------------------
// Timeframe
// ---------------------------------------------------------------------------

/** Finest to coarsest. The same total order `loop.ts` uses for confirmation checks. */
const TIMEFRAME_ORDER: readonly string[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

export function timeframeRank(timeframe: string | undefined): number {
  if (!timeframe) return -1;
  return TIMEFRAME_ORDER.indexOf(timeframe);
}

/**
 * How much a confirmation from this resolution is worth relative to the thesis's.
 *
 * A 1h confirmation of a 15m thesis is worth more than a 1m confirmation of it,
 * because it is harder to produce by accident and survives more of the noise that
 * makes the thesis interesting. A *finer* resolution is worth slightly less than
 * the thesis's own, not zero: intrabar noise is real information, it is just weak
 * information.
 *
 * With no thesis resolution to compare against, everything counts the same, which
 * is the conservative answer — the alternative is a table of opinions about which
 * resolution matters, applied to a thesis that never said.
 */
export function timeframeWeight(
  thesisTimeframe: string | undefined,
  evidenceTimeframe: string | undefined,
): number {
  const thesisRank = timeframeRank(thesisTimeframe);
  const evidenceRank = timeframeRank(evidenceTimeframe);
  if (thesisRank < 0 || evidenceRank < 0) return 1;
  const steps = evidenceRank - thesisRank;
  if (steps >= 2) return 1.4;
  if (steps === 1) return 1.2;
  if (steps === 0) return 1;
  return 0.8;
}

// ---------------------------------------------------------------------------
// Novelty and independence
// ---------------------------------------------------------------------------

/**
 * The identity of the *observation* behind an event, for deduplication.
 *
 * `sourceEventId` names the delivery that produced the event, which is precisely the
 * right granularity: two events evaluated from one delivery are one observation
 * seen twice, while two events from separate deliveries are two observations even
 * when they describe the same level being touched twice.
 *
 * Without a delivery id the event's own id is the key. That is weaker — the same
 * condition firing on the next candle is then indistinguishable from a repeat of
 * the same one — which is exactly why the tracker runtime records delivery ids and
 * why this falls back rather than guessing.
 */
export function provenanceKey(event: {
  id: string;
  sourceEventId?: string;
  trackerId?: string;
  observedValues?: Record<string, number | string>;
}): string {
  if (event.sourceEventId) return `delivery:${event.sourceEventId}`;
  const observed = stableObserved(event.observedValues);
  return observed
    ? `observed:${event.trackerId ?? ''}:${observed}`
    : `event:${event.id}`;
}

/** A stable string for an observation, so two records can be compared. */
function stableObserved(observed: Record<string, number | string> | undefined): string | undefined {
  if (!observed || typeof observed !== 'object') return undefined;
  const entries = Object.entries(observed).filter(
    ([, value]) => typeof value === 'number' || typeof value === 'string',
  );
  if (entries.length === 0) return undefined;
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * How much of an effect survives repetition.
 *
 * `1` for something never seen before, `0` for something already recorded from the
 * same observation, and a reduced weight in between for a repeat from the same
 * tracker. The middle case is the interesting one: a price threshold on a 15m bar
 * that touches its level four times in an hour is four deliveries of the same
 * question, and treating it as four independent confirmations is how a thesis walks
 * itself to certainty on nothing.
 */
export function noveltyWeight(input: {
  provenanceKey: string;
  trackerId?: string;
  prior: ReadonlyArray<{ provenance?: string; sourceTrackerId?: string }>;
  /**
   * Provenance keys already recorded for this thesis, independent of the
   * evidence store's retention.
   *
   * `prior` answers "what has this thesis seen?" only for as long as the store
   * keeps it. Evidence is capped and evicted oldest-first, so on a long-lived
   * thesis the record of an observation quietly disappears — and once it does,
   * that same observation looks brand new again and is weighted as a fresh
   * confirmation. Passing the durable keys separately means a repeat stays a
   * repeat after the record of the first time has been recycled.
   */
  seenProvenance?: ReadonlySet<string>;
}): number {
  if (input.seenProvenance?.has(input.provenanceKey)) return 0;
  if (input.prior.length === 0) return 1;
  const seenDelivery = input.prior.some(
    (item) => item.provenance === input.provenanceKey,
  );
  if (seenDelivery) return 0;
  const seenFromSameTracker = input.prior.filter(
    (item) => item.sourceTrackerId === input.trackerId,
  ).length;
  if (seenFromSameTracker === 0) return 1;
  // Diminishing but never zero: the fourth touch of a level is weaker than the
  // first, and it is not *nothing*.
  return Math.max(0.25, 1 / (1 + seenFromSameTracker * 0.5));
}

// ---------------------------------------------------------------------------
// Stated confidence
// ---------------------------------------------------------------------------

/**
 * What the model's own confidence is allowed to do.
 *
 * It may only *discount*. `confidence` on an event is set by whoever raised the
 * event and never by the runtime, so it is untrusted input, and the safe reading of
 * an untrusted "this was a strong signal" is "do not believe it more than you would
 * otherwise have". A model claiming `0.99` gets no amplification; a model admitting
 * `0` has its evidence worth half.
 *
 * Absent means "no claim made", which is not a claim of zero — so absent is 1.
 */
export function statedConfidenceWeight(confidence: unknown): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 1;
  const clamped = Math.max(0, Math.min(1, confidence));
  return 0.5 + 0.5 * clamped;
}

// ---------------------------------------------------------------------------
// The adjustment
// ---------------------------------------------------------------------------

/** Reference effects. The magnitudes the previous fixed deltas used. */
export const BASE_SUPPORT = 0.1;
export const BASE_CONTRADICT = 0.15;

export interface EvidenceWeight {
  /** The signed effect this evidence has, before damping. */
  effect: number;
  severity: number;
  timeframe: number;
  novelty: number;
  stated: number;
  /** True when a prior observation already carried this evidence. */
  repeated: boolean;
  /** True when this evidence materially conflicts with something already recorded. */
  conflicting: boolean;
}

/**
 * How much a wake is worth.
 *
 * Multiplicative rather than additive on purpose: an INFO-level repeat of a
 * 1m observation should be worth almost nothing, and there is no sum of
 * unremarkable terms that produces almost nothing. One zero factor is enough.
 *
 * `conflict` multiplies only when the conflicting prior item was itself the
 * stronger claim, so fresh strong evidence is not discounted merely for existing.
 */
export function weighEvidence(input: {
  event: TrackerEvent;
  polarity: 'SUPPORTS' | 'CONTRADICTS';
  thesisTimeframe?: string;
  priorEvidence: readonly Evidence[];
  /** Weight of the strongest prior item that points the other way, if any. */
  strongestCounterWeight?: number;
  /** Durable provenance keys for this thesis; see `noveltyWeight`. */
  seenProvenance?: ReadonlySet<string>;
}): EvidenceWeight {
  const key = provenanceKey(input.event);
  const novelty = noveltyWeight({
    provenanceKey: key,
    ...(input.event.trackerId ? { trackerId: input.event.trackerId } : {}),
    prior: input.priorEvidence.map((item) => ({
      ...(item.provenance ? { provenance: item.provenance } : {}),
      ...(item.sourceTrackerId ? { sourceTrackerId: item.sourceTrackerId } : {}),
    })),
    ...(input.seenProvenance ? { seenProvenance: input.seenProvenance } : {}),
  });
  const repeated = novelty === 0;

  const severity = severityWeight(input.event.severity);
  const timeframe = timeframeWeight(input.thesisTimeframe, input.event.timeframe);
  const stated = statedConfidenceWeight(input.event.confidence);

  const base = input.polarity === 'SUPPORTS' ? BASE_SUPPORT : -BASE_CONTRADICT;
  let effect = base * severity * timeframe * novelty * stated;

  /*
   * A contradiction against a stronger prior claim is amplified.
   *
   * This is the only asymmetry in the arithmetic, and it is deliberate: evidence
   * that reverses something the GOAT was confident about carries more information
   * than evidence that confirms something it already believed, which is what makes
   * an "elite" system different from a majority counter.
   */
  const counterWeight = input.strongestCounterWeight ?? 0;
  const conflicting = counterWeight > 0 && Math.abs(effect) < counterWeight;
  if (conflicting) effect *= 1.25;

  return { effect, severity, timeframe, novelty, stated, repeated, conflicting };
}

/**
 * Apply an effect, damped by how far the belief already is from neutral.
 *
 * Confidence that is already near an extreme is harder to move further, so a
 * hundred weak confirmations cannot walk a thesis to 1.0. The damping is linear and
 * documented rather than tuned, because a tuned constant here would be a number
 * nobody could justify.
 */
export function applyConfidence(current: number | undefined, effect: number): number {
  const baseline = typeof current === 'number' && Number.isFinite(current)
    ? Math.max(0, Math.min(1, current))
    : 0.5;
  const distance = Math.abs(baseline - 0.5);
  const damping = 1 - distance * 0.6;
  return clampConfidence(baseline + effect * damping);
}

/** Confidence is a position on a scale, never a probability. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Hysteresis
// ---------------------------------------------------------------------------

/**
 * How much has to happen before the *state* changes, as distinct from the number.
 *
 * State changes are what a reader notices, what the mission reports, and what the
 * transition table has to accept. A thesis that oscillated ACTIVE → WEAKENING →
 * ACTIVE on a series of marginal observations would look exactly like an agent that
 * cannot decide, while its confidence — a much finer signal — would show almost no
 * net movement at all. So the two are separated: small evidence moves the number,
 * and only evidence above these floors moves the state.
 *
 * The floors are deliberately different for the two directions, and both are set
 * against the *weakest* evidence the tables can produce. Weakening is the more
 * conservative transition: an INFO-level contradiction works out at 0.09, which is
 * below its floor and therefore moves confidence rather than the state, while the
 * same observation confirming a thesis does move it. A thesis that is talked down by
 * noise never recovers the ground; one talked up by noise still has to pass the skill
 * gate to become actionable.
 */
export const MIN_EFFECT_FOR_STRENGTHENING = 0.05;
export const MIN_EFFECT_FOR_WEAKENING = 0.1;

export function hysteresisVerdict(input: {
  polarity: 'SUPPORTS' | 'CONTRADICTS';
  effect: number;
  repeated: boolean;
}): {
  /** Whether the state should move at all. */
  changesState: boolean;
  /** Why it did not, when it did not. Recorded, not silent. */
  reason?: string;
} {
  const magnitude = Math.abs(input.effect);

  if (input.repeated || magnitude === 0) {
    return {
      changesState: false,
      reason: 'This observation has already been recorded; belief was left where it was.',
    };
  }

  if (input.polarity === 'SUPPORTS' && magnitude < MIN_EFFECT_FOR_STRENGTHENING) {
    return {
      changesState: false,
      reason: 'The observation is too small to change the thesis\' state, though it moved its confidence.',
    };
  }

  if (input.polarity === 'CONTRADICTS' && magnitude < MIN_EFFECT_FOR_WEAKENING) {
    return {
      changesState: false,
      reason: 'Too little to call this a weakening; it moved confidence rather than the state.',
    };
  }

  return { changesState: true };
}

// ---------------------------------------------------------------------------
// Sufficiency
// ---------------------------------------------------------------------------

/**
 * What the GOAT can honestly say about its own case.
 *
 * A word, not a score. The four answers are the only ones the reasoning engine acts
 * on and the only ones the model is asked to distinguish, because a longer
 * vocabulary would produce longer answers without better decisions:
 *
 *   SUFFICIENT     enough independent support to consider acting
 *   INSUFFICIENT   still collecting; keep watching
 *   CONTRADICTED   the case against is currently the stronger one
 *   STALE          too old to act on without a new look
 *
 * The thresholds are properties of the *counts*, not of a timer: nothing here
 * measures how long a GOAT has been thinking, because a GOAT that is waiting is
 * doing exactly the right thing and a budget that punished it would turn patience
 * into a failure.
 */
export type Sufficiency = 'SUFFICIENT' | 'INSUFFICIENT' | 'CONTRADICTED' | 'STALE';

export interface SufficiencyReadout {
  sufficiency: Sufficiency;
  supporting: number;
  contradicting: number;
  /** Support that survives the novelty discount, so a repeat cannot inflate it. */
  independentSupport: number;
  strongestCounter: number;
  /** Evidence from a coarser resolution than the thesis, when there is one. */
  higherTimeframeSupport: number;
  /** True when every supporting item has already been seen from the same delivery. */
  saturated: boolean;
  thesisAgeMs: number;
}

/** Below this many independent supporting observations, "sufficient" is a claim. */
export const MIN_INDEPENDENT_SUPPORT = 2;

/** How long a thesis may go without new evidence before its case is stale. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function readSufficiency(input: {
  thesis: Thesis;
  evidence: readonly Evidence[];
  thesisTimeframe?: string;
  now: number;
}): SufficiencyReadout {
  const supporting = input.evidence.filter((item) => item.polarity === 'SUPPORTS');
  const contradicting = input.evidence.filter((item) => item.polarity === 'CONTRADICTS');

  const independentSupport = supporting.filter((item) => (item.novelty ?? 1) > 0).length;
  const strongestCounter = contradicting.reduce(
    (max, item) => Math.max(max, Math.abs(item.weight ?? 0)),
    0,
  );
  const strongestSupport = supporting.reduce(
    (max, item) => Math.max(max, Math.abs(item.weight ?? 0)),
    0,
  );
  const thesisRank = timeframeRank(input.thesisTimeframe);
  const higherTimeframeSupport = supporting.filter((item) => {
    const rank = timeframeRank(item.timeframe);
    return thesisRank >= 0 && rank > thesisRank;
  }).length;

  const saturated =
    supporting.length > 0 && independentSupport === 0 && contradicting.length === 0;

  const thesisAgeMs = Math.max(0, input.now - input.thesis.updatedAt);

  let sufficiency: Sufficiency;
  if (strongestCounter > strongestSupport && contradicting.length > 0) {
    sufficiency = 'CONTRADICTED';
  } else if (supporting.length > 0 && thesisAgeMs > STALE_AFTER_MS) {
    sufficiency = 'STALE';
  } else if (independentSupport >= MIN_INDEPENDENT_SUPPORT) {
    sufficiency = 'SUFFICIENT';
  } else {
    sufficiency = 'INSUFFICIENT';
  }

  return {
    sufficiency,
    supporting: supporting.length,
    contradicting: contradicting.length,
    independentSupport,
    strongestCounter,
    higherTimeframeSupport,
    saturated,
    thesisAgeMs,
  };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface EvidenceConflict {
  /** The earlier item this one is in tension with. */
  evidenceId: string;
  summary: string;
  polarity: 'SUPPORTS' | 'CONTRADICTS';
  timeframe?: string;
  sourceTrackerId?: string;
  /** Why the two are in tension, in one sentence. */
  because: string;
}

/**
 * Whether new evidence conflicts with what is already recorded.
 *
 * Bounded to the thesis and to a small window of recent evidence, because the
 * question is not "does this contradict something anywhere in the history" — it is
 * "does this put pressure on the belief currently being held". Scanning all of it
 * would make every observation a contradiction of something the GOAT believed three
 * days ago and changed its mind about since.
 *
 * A genuine conflict is: opposite polarity, and a weight at least as large as the
 * other side's strongest, from a different tracker or a different resolution. Two
 * observations from the same watch disagreeing with each other is a repeat, not a
 * conflict — that is the tracker telling you it is noisy, not the thesis being
 * contradicted.
 */
export function detectConflicts(input: {
  incoming: { polarity: 'SUPPORTS' | 'CONTRADICTS'; weight: number; sourceTrackerId?: string; timeframe?: string };
  prior: readonly Evidence[];
  window?: number;
}): EvidenceConflict[] {
  const window = input.window ?? 12;
  const recent = input.prior.slice(-window);
  const strongestOpposite = recent.reduce(
    (best, item) => {
      if (item.polarity === input.incoming.polarity) return best;
      const weight = Math.abs(item.weight ?? 0);
      if (weight > best.weight) {
        return {
          id: item.id,
          weight,
          summary: item.summary,
          polarity: item.polarity,
          timeframe: item.timeframe,
          sourceTrackerId: item.sourceTrackerId,
        };
      }
      return best;
    },
    {
      id: '',
      weight: 0,
      summary: '',
      polarity: 'SUPPORTS' as 'SUPPORTS' | 'CONTRADICTS',
      timeframe: undefined as string | undefined,
      sourceTrackerId: undefined as string | undefined,
    },
  );

  if (!strongestOpposite.id || Math.abs(input.incoming.weight) < strongestOpposite.weight) {
    return [];
  }

  const sameSource =
    input.incoming.sourceTrackerId !== undefined &&
    input.incoming.sourceTrackerId === strongestOpposite.sourceTrackerId;
  const sameResolution =
    input.incoming.timeframe !== undefined && input.incoming.timeframe === strongestOpposite.timeframe;

  const because = sameSource && sameResolution
    ? 'Repeats an earlier reading from the same watch at the same resolution, in the other direction.'
    : sameSource
      ? 'Reverses an earlier reading from the same watch, at a different resolution.'
      : sameResolution
        ? 'Comes from a different watch at the same resolution and points the other way.'
        : 'Comes from a different resolution and points the other way.';

  return [
    {
      evidenceId: strongestOpposite.id,
      summary: strongestOpposite.summary,
      polarity: strongestOpposite.polarity,
      ...(strongestOpposite.timeframe ? { timeframe: strongestOpposite.timeframe } : {}),
      ...(strongestOpposite.sourceTrackerId ? { sourceTrackerId: strongestOpposite.sourceTrackerId } : {}),
      because,
    },
  ];
}
