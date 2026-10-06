/**
 * The replay as a story.
 *
 * ## Why this file exists
 *
 * A backtest writes a lot of events, and almost none of them are about the GOAT.
 * The runtime is honest — it records the request, the read, the cache write, the
 * decision, the risk verdict, the order — because it cannot know in advance which
 * of those a person will want later. A surface that renders the log verbatim is
 * therefore technically complete and practically unreadable: a reader watching a
 * GOAT think wants to know that a thesis formed, that a watch fired, that an entry
 * filled, and that the target paid. They do not want the six supporting events
 * that each of those came with.
 *
 * So there are two views of the same records, and this file owns the second one:
 *
 *   semantic activity   what happened, in the words a person uses
 *   audit detail        everything, still on the timeline, still readable
 *
 * Nothing is deleted and nothing is invented. Every line here is derived from
 * events the runtime actually wrote, and every line can name the event it came
 * from — which is what makes it safe to compress: compression is only honest if
 * the original is still reachable.
 *
 * ## Deterministic, or it is not here
 *
 * The verdict and the behaviour score are counted, never judged. There is no
 * model in this file and no heuristics dressed as insight: "entered two trades
 * before confirmation" is a fact about two recorded plans, and it is written
 * because it is in the log. Anything the log does not support is reported as `—`
 * rather than filled in with a plausible number, because an invented score on a
 * screen labelled "how your GOAT behaves" is worse than no score at all.
 */

import type { AgentTimelineEvent } from '../../agents/timeline/types';
import type { BacktestBehaviour, BacktestPerformance } from './results';
import { formatSimulatedTime } from './clock';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * What the GOAT is doing, in the words the replay uses.
 *
 * Deliberately not the transport states (`RUNNING`, `PAUSED`, `COMPLETED`): those
 * describe the clock, and a reader's question is about the agent. The active state
 * is also the one the surface animates, so it has to be worth animating.
 */
export type GoatState =
  | 'BUILDING HISTORICAL WORLD'
  | 'DEPLOYING GOAT'
  | 'INVESTIGATING'
  | 'THESIS FORMING'
  | 'WATCHING'
  | 'WAITING'
  | 'WOKEN'
  | 'RE-EVALUATING'
  | 'TRADE PLAN READY'
  | 'ORDER WAITING'
  | 'POSITION OPEN'
  | 'TARGET HIT'
  | 'STOP HIT'
  | 'THESIS INVALIDATED'
  | 'DONE';

/**
 * Derive the GOAT's state from the run.
 *
 * Ordered by what a reader most needs to know, so the first match wins: a position
 * that is open outranks a plan that was written, which outranks a wake, which
 * outranks "it is thinking". Nothing here consults the wall clock or the browser,
 * so the same events always produce the same word.
 */
export function deriveGoatState(input: {
  state?: string;
  agentBusy?: boolean;
  tradePhase?: string;
  hasPlan?: boolean;
  openPositions?: number;
  restingOrders?: number;
  lastOutcome?: 'TAKE_PROFIT' | 'STOP_LOSS' | 'EXITED';
  thesisCount?: number;
  invalidatedTheses?: number;
  progress?: number;
}): GoatState {
  if (input.state === 'LOADING') return 'BUILDING HISTORICAL WORLD';
  if (input.state === 'SETTING_UP' || input.state === 'IDLE') return 'DEPLOYING GOAT';
  if (input.state === 'COMPLETED' || input.state === 'STOPPED') {
    return input.openPositions && input.openPositions > 0 ? 'DONE' : 'DONE';
  }

  if (input.lastOutcome === 'TAKE_PROFIT') return 'TARGET HIT';
  if (input.lastOutcome === 'STOP_LOSS') return 'STOP HIT';
  if ((input.openPositions ?? 0) > 0) return 'POSITION OPEN';
  if ((input.restingOrders ?? 0) > 0) return 'ORDER WAITING';
  if (input.hasPlan) return 'TRADE PLAN READY';
  if (input.agentBusy) return 'RE-EVALUATING';
  if ((input.thesisCount ?? 0) === 0) return 'INVESTIGATING';
  if (input.invalidatedTheses && input.invalidatedTheses > 0 && input.progress !== undefined && input.progress > 0.5) {
    return 'THESIS INVALIDATED';
  }
  return 'WATCHING';
}

/** Whether a state is worth a pulse. Deliberately a short list. */
export function isAnimatedState(state: GoatState): boolean {
  return (
    state === 'INVESTIGATING' ||
    state === 'RE-EVALUATING' ||
    state === 'WOKEN' ||
    state === 'POSITION OPEN' ||
    state === 'TARGET HIT' ||
    state === 'STOP HIT' ||
    state === 'BUILDING HISTORICAL WORLD'
  );
}

// ---------------------------------------------------------------------------
// Key moments
// ---------------------------------------------------------------------------

export type MomentKind =
  | 'THESIS'
  | 'WATCH_ARMED'
  | 'WATCH_FIRED'
  | 'PLAN'
  | 'ORDER'
  | 'FILL'
  | 'POSITION'
  | 'TARGET'
  | 'STOP'
  | 'INVALIDATION'
  | 'NEAR_MISS';

export interface KeyMoment {
  at: number;
  kind: MomentKind;
  /** The line, in a reader's words. */
  headline: string;
  /** The numbers, when there are any worth reading. */
  detail?: string;
  /** The activity-log entry this came from, so a click can go to it. */
  eventId?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(event: AgentTimelineEvent): Record<string, unknown> {
  return typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : {};
}

/**
 * The moments worth stopping for.
 *
 * Derived from the log rather than tracked as it happens, so it is available for a
 * run that is still going, for one that finished an hour ago, and for one that was
 * reloaded — and so it cannot disagree with the events it is made of. Internal
 * machinery (`MODEL_REQUEST`, `MARKET_CONTEXT_LOADED`, the cache writes, the
 * tick) is deliberately absent: it is all still on the timeline, and none of it is
 * the story.
 */
export function deriveKeyMoments(
  events: AgentTimelineEvent[],
  nearMisses: Array<{ at: number; kind: MomentKind; headline: string; detail: string }> = [],
): KeyMoment[] {
  const moments: KeyMoment[] = [];

  for (const event of events) {
    const data = record(event);
    switch (event.type) {
      case 'THESIS_FORMED': {
        const statement = text(data.statement) ?? text(data.thesis) ?? 'A hypothesis was formed.';
        moments.push({
          at: event.timestamp,
          kind: 'THESIS',
          headline: statement,
          ...(text(data.direction) ? { detail: `${text(data.direction)} bias` } : {}),
          eventId: event.id,
        });
        break;
      }
      case 'TRACKER_CREATED': {
        const level = number(data.level);
        const condition = text(data.condition) ?? text(data.purpose);
        moments.push({
          at: event.timestamp,
          kind: 'WATCH_ARMED',
          headline: condition ? `Watching: ${condition}` : 'A watch was armed.',
          ...(level !== undefined ? { detail: `Level ${level}` } : {}),
          eventId: event.id,
        });
        break;
      }
      case 'TRACKER_FIRED': {
        const price = number(data.price);
        const level = number(data.level);
        moments.push({
          at: event.timestamp,
          kind: 'WATCH_FIRED',
          headline: text(data.purpose) ?? 'A watch fired.',
          ...(price !== undefined
            ? { detail: `${price} reached${level !== undefined ? ` against ${level}` : ''}` }
            : undefined),
          eventId: event.id,
        });
        break;
      }
      case 'TRADE_PLAN_CREATED':
        moments.push({
          at: event.timestamp,
          kind: 'PLAN',
          headline: text(data.summary) ?? text(data.reason) ?? 'A trade plan was written.',
          ...(text(data.side) && number(data.entry) !== undefined
            ? { detail: `${text(data.side)} ${number(data.entry)}` }
            : {}),
          eventId: event.id,
        });
        break;
      case 'TRADE_PLAN_RISK_CHECKED':
        moments.push({
          at: event.timestamp,
          kind: 'PLAN',
          headline: 'The risk layer checked the plan.',
          ...(text(data.reason) ? { detail: text(data.reason) } : {}),
          eventId: event.id,
        });
        break;
      case 'ORDER_PLACED':
        moments.push({
          at: event.timestamp,
          kind: 'ORDER',
          headline: number(data.entry) !== undefined ? `Simulated order at ${number(data.entry)}` : 'A simulated order was placed.',
          ...(text(data.side) ? { detail: `${text(data.side)} · resting until filled or expired` } : {}),
          eventId: event.id,
        });
        break;
      case 'ORDER_FILLED':
        moments.push({
          at: event.timestamp,
          kind: 'FILL',
          headline: number(data.price) !== undefined ? `Order simulated at ${number(data.price)}` : 'Order simulated.',
          eventId: event.id,
        });
        break;
      case 'POSITION_OPENED':
        moments.push({
          at: event.timestamp,
          kind: 'POSITION',
          headline: 'Position open.',
          eventId: event.id,
        });
        break;
      case 'TRADE_CLOSED': {
        const pnl = number(data.pnl);
        const reason = text(data.reason) ?? text(data.detail);
        const won = pnl !== undefined && pnl > 0;
        moments.push({
          at: event.timestamp,
          kind: won ? 'TARGET' : 'STOP',
          headline: won ? 'Closed in profit.' : reason ? `Closed: ${reason}` : 'Closed.',
          ...(pnl !== undefined ? { detail: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` } : {}),
          eventId: event.id,
        });
        break;
      }
      case 'THESIS_INVALIDATED':
        moments.push({
          at: event.timestamp,
          kind: 'INVALIDATION',
          headline: text(data.reason) ?? 'The thesis was invalidated.',
          eventId: event.id,
        });
        break;
      case 'GOAT_WAITING':
        moments.push({
          at: event.timestamp,
          kind: 'WATCH_ARMED',
          headline: 'Dormant — waiting for a condition it set.',
          eventId: event.id,
        });
        break;
      default:
        break;
    }
  }

  for (const miss of nearMisses) {
    moments.push({ at: miss.at, kind: 'NEAR_MISS', headline: miss.headline, detail: miss.detail });
  }

  return moments.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Near misses
// ---------------------------------------------------------------------------

export interface NearMiss {
  at: number;
  kind: MomentKind;
  headline: string;
  detail: string;
  /** Price distance, in the instrument's own units. */
  distance: number;
}

/**
 * Setups that nearly happened.
 *
 * A replay that only celebrates fills teaches a GOAT nothing about its patience.
 * "Price reached 149.51, entry was 149.50, it reversed" is one of the most useful
 * sentences a backtest can produce, and it is only available because the
 * simulation knows every bar the order was alive for.
 *
 * The threshold is a tenth of one percent of the level itself — 0.16 on a 157.9
 * entry — because the alternative is manufacturing drama. An order the market never
 * came near is not a near miss and is not dressed up as one; an order it missed by
 * four points on the same instrument genuinely was never close.
 *
 * Measured as a fraction of the price rather than as a raw distance, because the
 * same number means something completely different on EUR/USD and on a
 * zero-decimal commodity, and a threshold that cannot survive being applied to
 * another instrument is not a rule.
 */
export interface NearMissCandidate {
  id: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  status: string;
  filledAt?: number;
  expiresAt?: number;
  placedAt: number;
}

export function deriveNearMisses<TOrder extends NearMissCandidate>(
  orders: TOrder[],
  nearestApproach: (order: TOrder) => { distance: number; at: number; price: number } | undefined,
  options: { maxDistanceFraction?: number; pricePrecision?: number } = {},
): NearMiss[] {
  const misses: NearMiss[] = [];
  const fraction = options.maxDistanceFraction ?? 0.001;
  const precision = options.pricePrecision ?? 5;

  for (const order of orders) {
    if (order.filledAt !== undefined) continue;
    if (order.status === 'FILLED' || order.status === 'CANCELLED') continue;
    const approach = nearestApproach(order);
    if (!approach) continue;
    // A near miss has to be near. Measured against nothing, every unfilled order
    // is dramatic; measured against the risk the setup was taking, it is a fact.
    const bar = order.entryPrice * fraction;
    if (!(approach.distance > 0) || approach.distance > Math.max(bar, 1e-9)) continue;

    misses.push({
      at: approach.at,
      kind: 'NEAR_MISS',
      headline:
        order.status === 'EXPIRED'
          ? 'NEAR MISS — the entry was never reached.'
          : 'NEAR MISS — the price came to this level and turned.',
      detail: `Reached ${approach.price.toFixed(precision)} · entry ${order.entryPrice.toFixed(precision)} · missed by ${approach.distance.toFixed(precision)}`,
      distance: approach.distance,
    });
  }

  return misses.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * What the run says about the GOAT.
 *
 * Counted sentences. Each clause names the events it came from, because a verdict
 * a reader cannot check is an opinion wearing a number's clothes.
 */
export function deriveVerdict(input: {
  behaviour: BacktestBehaviour;
  performance: BacktestPerformance;
  nearMisses?: number;
}): { summary: string; observations: string[] } {
  const { behaviour, performance } = input;
  const observations: string[] = [];

  const selectivity = behaviour.trackersCreated > 0 ? behaviour.trackersFired / behaviour.trackersCreated : undefined;
  if (selectivity !== undefined) {
    observations.push(
      selectivity <= 0.4
        ? `Selective: ${behaviour.trackersFired} of ${behaviour.trackersCreated} armed watches were met by the market.`
        : selectivity >= 0.8
          ? `Reactive: ${behaviour.trackersFired} of ${behaviour.trackersCreated} armed watches fired — most of what it waited for happened.`
          : `It waited on ${behaviour.trackersCreated} conditions and ${behaviour.trackersFired} of them came true.`,
    );
  }

  if (behaviour.plansCreated > 0) {
    const blocked = behaviour.plansRejectedByRisk;
    observations.push(
      blocked === 0
        ? `Every one of its ${behaviour.plansCreated} plans passed the risk layer.`
        : `The risk layer stopped ${blocked} of ${behaviour.plansCreated} plans before they could be placed.`,
    );
  } else {
    observations.push('It never wrote a trade plan in this window.');
  }

  if (performance.trades > 0) {
    const winRate = performance.winRatePercent;
    observations.push(
      `${performance.trades} simulated ${performance.trades === 1 ? 'trade' : 'trades'}, ${performance.wins} won and ${performance.losses} lost (${winRate.toFixed(0)}%).`,
    );
    if (performance.maxDrawdownPercent > 0) {
      observations.push(`Deepest drawdown on equity: ${performance.maxDrawdownPercent.toFixed(1)}%.`);
    }
  }

  if ((input.nearMisses ?? 0) > 0) {
    observations.push(
      `${input.nearMisses} setup${input.nearMisses === 1 ? '' : 's'} came close to filling without ever filling.`,
    );
  }

  if (behaviour.longestSilenceMinutes > 0) {
    observations.push(`Its longest silence was ${Math.round(behaviour.longestSilenceMinutes)} simulated minutes.`);
  }

  const summary =
    performance.trades === 0
      ? 'Patient rather than active: it watched, and the market never gave it its price.'
      : performance.netR !== undefined && performance.netR > 0
        ? 'Selective and net positive across the window it was given.'
        : performance.netR !== undefined && performance.netR < 0
          ? 'Active, and it cost more than it made over this window.'
          : 'Active, and it finished the window about where it started.';

  return { summary, observations };
}

// ---------------------------------------------------------------------------
// Behaviour score
// ---------------------------------------------------------------------------

export type ScoreDimension = 'DISCIPLINE' | 'SELECTIVITY' | 'RISK CONTROL' | 'ADAPTABILITY' | 'EXECUTION';

export interface ScoreLine {
  dimension: ScoreDimension;
  /** `undefined` means "not enough recorded data to say" — rendered as `—`. */
  score?: number;
  /** How the number was arrived at. Always shown; this is a measurement, not a verdict. */
  basis: string;
}

export interface BehaviourScore {
  /** Mean of the dimensions that could be measured, or undefined when none could. */
  overall?: number;
  lines: ScoreLine[];
}

/**
 * A transparent score, or nothing.
 *
 * Every dimension is a ratio of two counted facts, and the counting is written out
 * beside the number so a reader can disagree with it. A dimension whose denominator
 * is zero is reported as absent rather than as a zero: "the risk layer never had to
 * stop it" is not the same claim as "it scored zero on risk control", and only one
 * of them is true.
 */
export function deriveBehaviourScore(input: {
  behaviour: BacktestBehaviour;
  performance: BacktestPerformance;
}): BehaviourScore {
  const { behaviour, performance } = input;
  const lines: ScoreLine[] = [];

  // Discipline: of the times it woke with an opportunity, how often did it wait?
  const decisions = behaviour.wakes + behaviour.waits;
  lines.push(
    decisions > 0
      ? {
          dimension: 'DISCIPLINE',
          score: Math.round((behaviour.waits / decisions) * 100),
          basis: `${behaviour.waits} dormancies out of ${decisions} wakes — how often it chose to keep waiting.`,
        }
      : { dimension: 'DISCIPLINE', basis: 'No wake was recorded, so there is nothing to measure patience against.' },
  );

  // Selectivity: conditions armed versus met. A high number is not automatically good.
  lines.push(
    behaviour.trackersCreated > 0
      ? {
          dimension: 'SELECTIVITY',
          score: Math.round((1 - behaviour.trackersFired / behaviour.trackersCreated) * 100),
          basis: `${behaviour.trackersFired} of ${behaviour.trackersCreated} armed conditions were ever met.`,
        }
      : { dimension: 'SELECTIVITY', basis: 'It armed no conditions in this window.' },
  );

  // Risk control: of the plans that reached the gate, how many were allowed through?
  const gated = behaviour.plansCreated;
  lines.push(
    gated > 0
      ? {
          dimension: 'RISK CONTROL',
          score: Math.round(((gated - behaviour.plansRejectedByRisk) / gated) * 100),
          basis: `${behaviour.plansRejectedByRisk} of ${gated} plans were refused by the risk layer.`,
        }
      : { dimension: 'RISK CONTROL', basis: 'No plan reached the risk layer in this window.' },
  );

  // Adaptability: how often a held thesis was revised rather than defended.
  const held = behaviour.hypothesesFormed;
  lines.push(
    held > 0
      ? {
          dimension: 'ADAPTABILITY',
          score: Math.round((behaviour.hypothesesRevised / held) * 100),
          basis: `${behaviour.hypothesesRevised} revisions against ${held} hypotheses formed.`,
        }
      : { dimension: 'ADAPTABILITY', basis: 'It formed no hypothesis to revise.' },
  );

  // Execution: plans that became simulated trades.
  lines.push(
    gated > 0
      ? {
          dimension: 'EXECUTION',
          score: Math.round((performance.trades / gated) * 100),
          basis: `${performance.trades} simulated trades from ${gated} plans.`,
        }
      : { dimension: 'EXECUTION', basis: 'No plan was written, so nothing was executed.' },
  );

  const measured = lines.filter((line): line is ScoreLine & { score: number } => line.score !== undefined);
  const overall =
    measured.length === 0
      ? undefined
      : Math.round(measured.reduce((sum, line) => sum + line.score, 0) / measured.length);

  return { ...(overall !== undefined ? { overall } : {}), lines };
}

/** "14:37", for a moment list. */
export function momentTime(at: number): string {
  return formatSimulatedTime(at);
}
