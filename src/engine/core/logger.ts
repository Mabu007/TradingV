/**
 * Correlation ids and structured logging.
 *
 * A production incident is answered by following one id through the
 * system. `requestId` enters at the edge and travels with the work;
 * `wakeId` and `executionId` are minted where the thing they name is
 * created. Every log line carries whichever apply, so a single id is
 * enough to reconstruct what happened.
 *
 * Two rules:
 *
 *  - **Ids are deterministic where they can be.** A wake's id is derived
 *    from the watcher, the market event, and the config version, so
 *    redelivering the same event produces the same id. That is what makes
 *    duplicate suppression possible without a database.
 *  - **Logs are redacted on the way out**, not at the call site. A call
 *    site that forgets is the whole failure mode.
 */

import { REDACTED, classifyError, redact, redactValue } from './errors';

/** Every id the system mints or propagates. */
export interface TraceContext {
  requestId?: string;
  deploymentId?: string;
  goatId?: string;
  watcherId?: string;
  marketEventId?: string;
  evaluationId?: string;
  wakeId?: string;
  executionId?: string;
  orderId?: string;
  /** The configuration version that produced the work. */
  configVersion?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord extends TraceContext {
  level: LogLevel;
  message: string;
  at: number;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * Monotonic, collision-resistant ids.
 *
 * `crypto.randomUUID` when the platform has it, and a counter plus
 * randomness otherwise. A watcher must be able to mint ids in any
 * runtime, including a Durable Object under test, so this cannot depend
 * on a browser-only API.
 */
let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) return `${prefix}_${globalCrypto.randomUUID()}`;
  const random = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

export function newRequestId(): string {
  return newId('req');
}

/**
 * A short, stable digest.
 *
 * Used for deterministic ids. It is not a security primitive: the input
 * contains no secret, and the output is only ever a correlation handle.
 */
export function digest(...parts: Array<string | number | null | undefined>): string {
  const input = parts.map((part) => String(part ?? '')).join('|');
  // FNV-1a. Small, fast, and dependency-free, which matters because this
  // runs on the hot path of a Durable Object.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * The wake id for a market event under a configuration.
 *
 * Deterministic on purpose. The same event delivered twice, or an event
 * replayed after a restart, produces the same id, so the consumer can
 * drop it without a round trip. Including `configVersion` means an
 * edited bot produces a *different* wake for the same event, which is
 * correct: that is genuinely new work.
 */
export function wakeIdFor(watcherId: string, marketEventId: string, configVersion: number): string {
  return `wk_${digest(watcherId, marketEventId, configVersion)}`;
}

/**
 * The idempotency key for an order attempt.
 *
 * Built from the wake and the attempt number, so a retry of the *same*
 * intent reuses the key and the exchange can collapse it, while a
 * deliberate second trade is a different key.
 *
 * This is the single most important function in the file for V0. Without
 * it, "the response was lost, so we retried" becomes two orders.
 */
export function idempotencyKeyFor(wakeId: string, attempt: number): string {
  return `tv-${digest(wakeId, attempt)}-${wakeId}`;
}

/** The evaluation id for one (market event, config version) pair. */
export function evaluationIdFor(watcherId: string, marketEventId: string, configVersion: number): string {
  return `ev_${digest(watcherId, marketEventId, configVersion)}`;
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The default sink.
 *
 * `console` rather than a logging library: a Durable Object has no
 * filesystem, a browser has no stdout, and adding a dependency to solve
 * that is not worth it. Production wires a real sink in.
 */
class ConsoleSink implements LogSink {
  /** Records arrive already redacted by `Logger.write`. */
  write(record: LogRecord): void {
    const line = {
      at: new Date(record.at).toISOString(),
      level: record.level,
      message: record.message,
      ...stripUndefined({
        requestId: record.requestId,
        deploymentId: record.deploymentId,
        goatId: record.goatId,
        watcherId: record.watcherId,
        marketEventId: record.marketEventId,
        evaluationId: record.evaluationId,
        wakeId: record.wakeId,
        executionId: record.executionId,
        orderId: record.orderId,
        configVersion: record.configVersion,
      }),
      ...(record.data ? { data: record.data } : {}),
    };
    const text = JSON.stringify(line);
    if (record.level === 'error') console.error(text);
    else if (record.level === 'warn') console.warn(text);
    else if (record.level === 'debug') console.debug(text);
    else console.log(text);
  }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * A structured logger.
 *
 * Holds a base context so a watcher logs every line with its own id
 * without threading it through every call. Bounded: an in-memory ring,
 * because a long-lived watcher that appends forever is a leak.
 */
export class Logger {
  private readonly sink: LogSink;
  private readonly base: TraceContext;
  /** Protected so a child logger can share the parent's buffer directly. */
  protected buffer: LogRecord[] = [];
  protected bufferLimit: number;
  private minLevel: LogLevel;

  constructor(options: { sink?: LogSink; context?: TraceContext; minLevel?: LogLevel; bufferLimit?: number } = {}) {
    this.sink = options.sink ?? new ConsoleSink();
    this.base = options.context ?? {};
    this.minLevel = options.minLevel ?? (levelFromEnv() ?? 'info');
    this.bufferLimit = options.bufferLimit ?? 200;
  }

  /** A logger that stamps every line with more context. */
  child(context: TraceContext): Logger {
    const child = new Logger({ sink: this.sink, context: { ...this.base, ...context }, minLevel: this.minLevel, bufferLimit: this.bufferLimit });
    // Share the buffer so a child's records are visible to a parent that
    // a health endpoint reads, rather than being lost in a closure.
    child.shareBufferFrom(this);
    return child;
  }

  private shareBufferFrom(parent: Logger): void {
    // Sharing the buffer is what makes a child's records visible to a
    // health endpoint reading the parent, rather than being lost in a
    // closure the parent cannot reach.
    this.buffer = parent.buffer;
    this.bufferLimit = parent.bufferLimit;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, data?: Record<string, unknown>, context?: TraceContext): void {
    this.write('debug', message, data, context);
  }

  info(message: string, data?: Record<string, unknown>, context?: TraceContext): void {
    this.write('info', message, data, context);
  }

  warn(message: string, data?: Record<string, unknown>, context?: TraceContext): void {
    this.write('warn', message, data, context);
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>, context?: TraceContext): void {
    const classified = error === undefined ? undefined : classifyError(error);
    this.write(
      'error',
      message,
      {
        ...data,
        ...(classified
          ? { error: classified.toLogObject(), causeMessage: classified.message.replace(/[^\x20-\x7e]/g, '?') }
          : {}),
      },
      {
        ...context,
        ...(classified
          ? {
              requestId: classified.requestId ?? context?.requestId,
              deploymentId: classified.deploymentId ?? context?.deploymentId,
              goatId: classified.goatId ?? context?.goatId,
              wakeId: classified.wakeId ?? context?.wakeId,
              executionId: classified.executionId ?? context?.executionId,
              orderId: classified.orderId ?? context?.orderId,
            }
          : {}),
      },
    );
  }

  /** Recent records, for a health or diagnostics endpoint. */
  recent(limit = 50): LogRecord[] {
    return this.buffer.slice(-limit);
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>, context?: TraceContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const record: LogRecord = {
      ...this.base,
      ...context,
      level,
      at: Date.now(),
      // Redacted here rather than in the sink.
      //
      // Redacting in the sink means every *other* sink - a custom one, a
      // file appender, an aggregator - receives the raw, unredacted value.
      // The whole point of centralising redaction is that a call site
      // cannot forget it, and that only holds if it happens before the
      // record leaves the logger.
      message: redact(message),
      ...(data ? { data: redactValue(data) as Record<string, unknown> } : {}),
    };
    this.buffer.push(record);
    if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    this.sink.write(record);
  }
}

function levelFromEnv(): LogLevel | undefined {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TRADINGV_LOG_LEVEL;
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return undefined;
}

/**
 * The process-wide logger.
 *
 * A single instance is deliberate: two loggers means two formatters and
 * interleaved output that cannot be read. Context is attached per call
 * site rather than per instance.
 */
export const logger = new Logger();

/** Keys whose values must never reach a log, re-exported for call sites. */
export { REDACTED };
