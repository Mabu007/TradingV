/**
 * The tracker config contracts, in the same place as the validator.
 *
 * This exists because a prompt described them and got them wrong.
 *
 * `validateKindConfig` was the only description of what a tracker config may
 * contain, and it was not readable from outside the file. So the model was
 * asked for `"config": {}` with a list of eight kinds and told that
 * NEW_BAR, SESSION_START and SESSION_END "are always available". In practice
 * PRICE_CROSS needs a `direction` as well as a `level`,
 * VOLATILITY_CHANGE needs a `threshold` or an `increasePercent`, and
 * SESSION_START needs a session id, an IANA timezone and two epoch
 * boundaries the model cannot know. A real model, reasoning honestly from
 * that prompt, proposed three trackers and had all three refused — leaving a
 * GOAT holding a thesis with nothing to wake it.
 *
 * So the contracts are written once, here, next to the code that enforces
 * them, and the prompt is generated from them. The two cannot drift: a
 * change to the validator that is not mirrored here shows up as a refused
 * tracker in the regression test that renders this into a prompt.
 */

import type { TrackerKind } from './types';

export interface TrackerKindContract {
  kind: TrackerKind;
  /** What the config must contain, field by field. */
  config: string;
  /** Extra requirement on the tracker itself. */
  requires?: string;
  /**
   * Why a model may not write this config.
   *
   * Set only where the values are not knowable at authoring time — session
   * boundaries arrive with the observation, not with the intent. Those kinds
   * are excluded from what a model may propose, rather than offered and then
   * refused.
   */
  notModelWritable?: string;
}

/**
 * Kinds a GOAT may propose, with the config each one requires.
 *
 * `NEW_BAR` is first and is the safest thing to reach for: it needs no
 * number at all, so it cannot be wrong in the way a level can.
 */
export const MODEL_WRITABLE_TRACKER_CONTRACTS: TrackerKindContract[] = [
  {
    kind: 'NEW_BAR',
    config: '{} — no config at all',
    requires: 'a "timeframe"',
  },
  {
    kind: 'PRICE_THRESHOLD',
    config: '{ "level": <number>, "operator": "ABOVE" | "BELOW" }',
  },
  {
    kind: 'PRICE_CROSS',
    config: '{ "level": <number>, "direction": "ABOVE" | "BELOW" }',
  },
  {
    kind: 'BREAKOUT',
    config:
      '{ "direction": "ABOVE" | "BELOW", "level": <number> } or { "direction": "ABOVE" | "BELOW", "lookbackBars": <1..1000 integer> }',
  },
  {
    kind: 'VOLATILITY_CHANGE',
    config:
      '{ "threshold": <number >= 0> } or { "increasePercent": <number > 0> } — one of them, never both',
  },
  {
    kind: 'SPREAD_CHANGE',
    config:
      '{ "maxSpread": <number >= 0> } or { "expansionPercent": <number > 0> } — one of them, never both',
  },
  {
    kind: 'SCHEDULED',
    config:
      '{ "everyMs": <number >= 1000> } or { "at": "HH:MM", "timezone": "<IANA timezone>" }',
  },
  {
    kind: 'INDICATOR_CROSS',
    config:
      '{ "direction": "ABOVE" | "BELOW", "indicatorKey": "...", "level": <number>, "indicator": { "type": "RSI" | "SMA" | "EMA" | "ATR" | "MACD", "period": <positive integer>, "key": "..." } } — or a pair: { "direction", "fastKey", "slowKey", "fast": {...}, "slow": {...} }',
    requires: 'a "timeframe"',
  },
];

/**
 * Kinds whose config only the runtime can produce.
 *
 * Listed so the prompt can say why, rather than leaving a model to discover
 * it by having its trackers refused.
 */
export const RUNTIME_ONLY_TRACKER_CONTRACTS: TrackerKindContract[] = [
  {
    kind: 'SESSION_START',
    config: '{ "sessionId": "...", "timezone": "<IANA>", "startsAt": <epoch ms>, "endsAt": <epoch ms> }',
    notModelWritable:
      'session boundaries are only known once the venue publishes the session, so this config cannot be written ahead of time',
  },
  {
    kind: 'SESSION_END',
    config: '{ "sessionId": "...", "timezone": "<IANA>", "startsAt": <epoch ms>, "endsAt": <epoch ms> }',
    notModelWritable:
      'session boundaries are only known once the venue publishes the session, so this config cannot be written ahead of time',
  },
  {
    kind: 'STOP_APPROACHING',
    config: 'a proximity threshold against an open position',
    notModelWritable: 'requires an open position to be meaningful',
  },
  {
    kind: 'TARGET_APPROACHING',
    config: 'a proximity threshold against an open position',
    notModelWritable: 'requires an open position to be meaningful',
  },
  {
    kind: 'POSITION_OPEN',
    config: '{}',
    notModelWritable: 'watching a position the deployment may not open',
  },
  {
    kind: 'POSITION_CLOSE',
    config: '{}',
    notModelWritable: 'watching a position the deployment may not open',
  },
  {
    kind: 'ORDER_FILLED',
    config: '{}',
    notModelWritable: 'watching a fill the deployment may not cause',
  },
  {
    kind: 'POSITION_UPDATE',
    config: '{}',
    notModelWritable: 'watching a position the deployment may not open',
  },
  {
    kind: 'RISK_STATE_CHANGED',
    config: '{}',
    notModelWritable: 'derived from the account, which the deployment may not reach',
  },
  {
    kind: 'CUSTOM',
    config: 'none — this kind is disabled',
    notModelWritable: 'disabled until an allowlisted application event source is registered',
  },
];

/** The contract block for a prompt, generated from the two tables above. */
export function describeModelWritableTrackers(): string {
  const lines: string[] = [];

  for (const contract of MODEL_WRITABLE_TRACKER_CONTRACTS) {
    lines.push(`- "${contract.kind}"  config: ${contract.config}`);
    if (contract.requires) lines.push(`  also requires: ${contract.requires}`);
  }

  lines.push('');
  lines.push('You may not use these kinds, and proposing one will be refused:');
  for (const contract of RUNTIME_ONLY_TRACKER_CONTRACTS) {
    lines.push(`- "${contract.kind}" — ${contract.notModelWritable}`);
  }

  return lines.join('\n');
}

/**
 * The plan the runtime instruments itself when a model proposes nothing it
 * can actually watch.
 *
 * Without this, a model that reasons well but writes one unusable config
 * leaves a GOAT holding a thesis and no way to be woken — asleep, holding a
 * view, indefinitely. A GOAT that has been given a hypothesis is entitled to
 * at least the means of re-reading it, and "a new bar on the thesis's own
 * timeframe" is the smallest honest version of that.
 *
 * It is not a substitute for the model's own plan and it does not pretend to
 * be: the caller records that the observation plan was defaulted, so the
 * activity feed says so.
 */
export function defaultObservationPlan(timeframe: string): Array<{
  purpose: string;
  kind: TrackerKind;
  timeframe: string;
  config: Record<string, unknown>;
  cooldownMs: number;
}> {
  return [
    {
      purpose: `A new ${timeframe} bar, so the thesis can be re-read against the market as it actually is.`,
      kind: 'NEW_BAR',
      timeframe,
      config: {},
      // One bar per thesis re-read. A shorter cooldown would wake the GOAT on
      // every candle and turn a dormant agent into a poller.
      cooldownMs: 15 * 60_000,
    },
  ];
}
