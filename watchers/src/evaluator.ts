/**
 * The condition-evaluation seam.
 *
 * The Python engine owns measurement. This is the only place the watcher
 * tier talks to it, and it is deliberately thin: send the tree, receive a
 * three-state answer, translate a transport failure into UNKNOWN.
 *
 * UNKNOWN is the important part. An unreachable engine is not "the
 * conditions are false", and treating it that way would let a bot wake
 * on the previous reading or, worse, latch itself to TRUE while nothing
 * was actually measured.
 */

import type { WatcherConfig, MarketEvent } from './contract';
import { evaluationIdFor } from './ids';
import type { ConditionEvaluator, EvaluationOutcome, EvaluationResult } from './watcher';

export type { ConditionEvaluator, EvaluationResult };

export interface HttpEvaluatorOptions {
  baseUrl: string;
  timeoutMs?: number;
  now?: () => number;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Calls the Python engine over HTTP.
 *
 * The engine returns a `conditionTree` result keyed on the market it
 * watches, so a watcher cannot ask about a market it has no data for;
 * that is enforced here rather than trusted, because a mismatch would
 * otherwise produce a confident answer about the wrong instrument.
 */
export class HttpConditionEvaluator implements ConditionEvaluator {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, now: () => number = () => Date.now(), options: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = now;
    /*
     * `fetch` is bound, and this is not cosmetic.
     *
     * Detached and then called as a method of this evaluator, the
     * runtime's `fetch` throws "Illegal invocation: function called with
     * incorrect `this` reference" - which surfaces as a condition error
     * rather than as the unreachable engine it actually is. Every
     * evaluation then reports UNKNOWN with a TypeError as the reason,
     * and a real outage becomes indistinguishable from a code bug.
     */
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    this.fetchImpl = options.fetch ?? (typeof globalFetch === 'function' ? globalFetch.bind(globalThis) : (undefined as never));
  }

  async evaluate(config: WatcherConfig, event: MarketEvent): Promise<EvaluationOutcome> {
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ tree: config.conditionTree, market: event.market, nowMs: this.now() }),
      });

      if (!response.ok) {
        const detail = await safeText(response);
        throw new Error(`The condition engine answered ${response.status}: ${detail}`);
      }

      const payload = (await response.json()) as { status?: string; summary?: string; conditions?: EvaluationResult['conditions'] };
      const status = normalizeStatus(payload.status);

      return {
        evaluationId: evaluationIdFor('pending', event.marketEventId, config.configVersion),
        durationMs: this.now() - started,
        result: {
          status,
          summary: payload.summary ?? 'The engine did not describe the result.',
          conditions: payload.conditions ?? [],
          ...(status === 'UNKNOWN' ? { reason: 'The engine could not measure these conditions.' } : {}),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turn a transport failure into UNKNOWN.
   *
   * Not a throw. A watcher whose engine is down should report DEGRADED
   * and keep no edge, not crash and lose its configuration.
   */
  fail(config: WatcherConfig, event: MarketEvent, error: unknown): EvaluationOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = /abort|timeout/i.test(message);
    return {
      evaluationId: evaluationIdFor('pending', event.marketEventId, config.configVersion),
      durationMs: 0,
      result: {
        status: 'UNKNOWN',
        summary: aborted ? 'The condition engine did not respond in time.' : 'The condition engine could not be reached.',
        conditions: [],
        reason: aborted
          ? `Timed out after ${this.timeoutMs}ms waiting for the condition engine.`
          : message,
      },
    };
  }
}

/**
 * A table-driven evaluator, for tests.
 *
 * Also useful for replay: a recorded run of market events can be replayed
 * without an engine, which is how the recovery tests work.
 */
export class ScriptedEvaluator implements ConditionEvaluator {
  private readonly answers = new Map<string, EvaluationResult>();
  private readonly fallback: EvaluationResult;
  public calls = 0;

  constructor(fallback: EvaluationResult = { status: 'UNKNOWN', summary: 'No scripted answer.', conditions: [] }) {
    this.fallback = fallback;
  }

  /** Script a result for a specific market event id. */
  when(marketEventId: string, result: EvaluationResult): this {
    this.answers.set(marketEventId, result);
    return this;
  }

  async evaluate(_config: WatcherConfig, event: MarketEvent): Promise<EvaluationOutcome> {
    this.calls += 1;
    return {
      evaluationId: evaluationIdFor('scripted', event.marketEventId, 1),
      durationMs: 0,
      result: this.answers.get(event.marketEventId) ?? this.fallback,
    };
  }

  fail(_config: WatcherConfig, event: MarketEvent, error: unknown): EvaluationOutcome {
    this.calls += 1;
    return {
      evaluationId: evaluationIdFor('scripted', event.marketEventId, 1),
      durationMs: 0,
      result: { status: 'UNKNOWN', summary: 'Scripted failure.', conditions: [], reason: (error as Error).message },
    };
  }
}

function normalizeStatus(value: unknown): 'TRUE' | 'FALSE' | 'UNKNOWN' {
  // The engine is the authority on the three states. Anything else it
  // returns is a contract break, and the safe reading of a broken
  // contract is UNKNOWN, never TRUE.
  if (value === 'TRUE' || value === 'FALSE' || value === 'UNKNOWN') return value;
  return 'UNKNOWN';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}
