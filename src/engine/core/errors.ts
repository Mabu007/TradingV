/**
 * The error taxonomy.
 *
 * Before this, every failure was an `Error` with a message, so the only
 * way to tell a rate limit from a network drop from a rejected order was
 * to read the text. That is not something to build a system on: retry
 * policy, alerting, and user-facing copy all need the *category*, and
 * string matching on messages breaks the first time someone rewords one.
 *
 * Two rules hold everywhere in the system:
 *
 * 1. **A failure has a category.** `TradingGOATsError` requires one at
 *    construction, so a new throw site cannot forget.
 * 2. **A category is enough to decide what to do.** See `retryable` and
 *    `terminal` below. Nothing should have to inspect the message.
 *
 * Errors are safe to serialise. `redact` is applied on the way out so a
 * credential that reached an error message by accident does not reach a
 * log, and `details` is for diagnostics, never for the user.
 */

export type TradingGOATsErrorCategory =
  /** A watcher, bot, or deployment was configured incorrectly. */
  | 'CONFIG_ERROR'
  /** The venue could not be read, or published nothing usable. */
  | 'MARKET_DATA_ERROR'
  /** A condition tree could not be evaluated. */
  | 'CONDITION_ERROR'
  /** A policy gate declined the action. */
  | 'POLICY_REJECTION'
  /** A risk gate declined the action. */
  | 'RISK_REJECTION'
  /** Credentials were missing, rejected, or insufficient. */
  | 'AUTH_ERROR'
  /** The order attempt itself failed. */
  | 'EXECUTION_ERROR'
  /** A limit was hit: wakes, orders, evaluations, or requests. */
  | 'RATE_LIMIT'
  /** The operation ran out of time. */
  | 'TIMEOUT'
  /** The request never reached the venue. */
  | 'NETWORK_ERROR'
  /** A watcher could not start, run, or stop cleanly. */
  | 'WATCHER_ERROR'
  /** The caller is not permitted to do this. */
  | 'AUTHORIZATION_ERROR'
  /** A bug in this system. */
  | 'INTERNAL_ERROR';

export interface TradingGOATsErrorOptions {
  /** Stable, user-safe explanation. Never contains a secret. */
  message: string;
  /** Category, required, so no throw site can forget to classify. */
  category: TradingGOATsErrorCategory;
  /** Traceability, preserved through every hop. */
  requestId?: string;
  deploymentId?: string;
  goatId?: string;
  watcherId?: string;
  marketEventId?: string;
  evaluationId?: string;
  wakeId?: string;
  executionId?: string;
  orderId?: string;
  /** The underlying error, when there is one. */
  cause?: unknown;
  /** Extra diagnostics. Not shown to users, redacted on serialisation. */
  details?: Record<string, unknown>;
}

/**
 * Categories where retrying the same request could plausibly succeed.
 *
 * A retry is only safe when paired with an idempotency key. `TIMEOUT` and
 * `NETWORK_ERROR` are the dangerous ones precisely because the exchange
 * may have accepted the order before the response was lost, so a blind
 * retry is how one intent becomes two orders.
 */
const RETRYABLE: ReadonlySet<TradingGOATsErrorCategory> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMIT',
  'MARKET_DATA_ERROR',
]);

/**
 * Categories that mean the request was refused on purpose.
 *
 * Retrying any of these will be refused again for the same reason, and
 * doing so either burns rate limit or, worse, looks like a second
 * attempt to force something through.
 */
const TERMINAL: ReadonlySet<TradingGOATsErrorCategory> = new Set([
  'CONFIG_ERROR',
  'POLICY_REJECTION',
  'RISK_REJECTION',
  'AUTHORIZATION_ERROR',
  'CONDITION_ERROR',
]);

export class TradingGOATsError extends Error {
  readonly category: TradingGOATsErrorCategory;
  readonly requestId?: string;
  readonly deploymentId?: string;
  readonly goatId?: string;
  readonly watcherId?: string;
  readonly marketEventId?: string;
  readonly evaluationId?: string;
  readonly wakeId?: string;
  readonly executionId?: string;
  readonly orderId?: string;
  readonly details?: Record<string, unknown>;

  constructor(options: TradingGOATsErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TradingGOATsError';
    this.category = options.category;
    this.requestId = options.requestId;
    this.deploymentId = options.deploymentId;
    this.goatId = options.goatId;
    this.watcherId = options.watcherId;
    this.marketEventId = options.marketEventId;
    this.evaluationId = options.evaluationId;
    this.wakeId = options.wakeId;
    this.executionId = options.executionId;
    this.orderId = options.orderId;
    this.details = options.details;
  }

  /** Whether a retry could plausibly succeed. Never implies it is safe. */
  get retryable(): boolean {
    return RETRYABLE.has(this.category);
  }

  /** Whether the request was refused on purpose. */
  get terminal(): boolean {
    return TERMINAL.has(this.category);
  }

  /**
   * A structured, log-safe representation.
   *
   * The cause chain is included by category only, so a stack trace or an
   * upstream response body cannot smuggle a credential into a log.
   */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      message: redact(this.message),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.deploymentId ? { deploymentId: this.deploymentId } : {}),
      ...(this.goatId ? { goatId: this.goatId } : {}),
      ...(this.watcherId ? { watcherId: this.watcherId } : {}),
      ...(this.marketEventId ? { marketEventId: this.marketEventId } : {}),
      ...(this.evaluationId ? { evaluationId: this.evaluationId } : {}),
      ...(this.wakeId ? { wakeId: this.wakeId } : {}),
      ...(this.executionId ? { executionId: this.executionId } : {}),
      ...(this.orderId ? { orderId: this.orderId } : {}),
      ...(this.details ? { details: redactValue(this.details) } : {}),
      ...(this.cause !== undefined
        ? { cause: causeCategory(this.cause) }
        : {}),
    };
  }

  toJSON(): Record<string, unknown> {
    return this.toLogObject();
  }
}

/* ------------------------------------------------------------------ *
 * Constructors
 *
 * Named helpers rather than inline `new TradingGOATsError({...})` so the
 * category is visible at the call site and cannot be mis-copied.
 * ------------------------------------------------------------------ */

type Ctx = Omit<TradingGOATsErrorOptions, 'category' | 'message'>;

export const configError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'CONFIG_ERROR' });

export const marketDataError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'MARKET_DATA_ERROR' });

export const conditionError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'CONDITION_ERROR' });

export const policyRejection = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'POLICY_REJECTION' });

export const riskRejection = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'RISK_REJECTION' });

export const authError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'AUTH_ERROR' });

export const executionError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'EXECUTION_ERROR' });

export const rateLimitError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'RATE_LIMIT' });

export const timeoutError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'TIMEOUT' });

export const networkError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'NETWORK_ERROR' });

export const watcherError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'WATCHER_ERROR' });

export const authorizationError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'AUTHORIZATION_ERROR' });

export const internalError = (message: string, ctx: Ctx = {}): TradingGOATsError =>
  new TradingGOATsError({ ...ctx, message, category: 'INTERNAL_ERROR' });

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export function isTradingGOATsError(value: unknown): value is TradingGOATsError {
  return value instanceof TradingGOATsError;
}

/**
 * Classify something that was thrown.
 *
 * Existing throw sites raise plain `Error`s, so this maps the shapes we
 * already produce rather than pretending they do not exist. Anything
 * unrecognised becomes `INTERNAL_ERROR`, which is deliberately the
 * noisiest category: an unclassified failure should be visible, not
 * quietly treated as a rate limit.
 */
export function classifyError(value: unknown): TradingGOATsError {
  if (isTradingGOATsError(value)) return value;

  const message = value instanceof Error ? value.message : String(value);
  const name = value instanceof Error ? value.name : '';

  if (name === 'AbortError' || /\b(timeout|timed out|aborted|abort)\b/i.test(message)) {
    return timeoutError(message, { cause: value });
  }
  // Deliberately not conditioned on the error name. A network failure
  // arrives as a plain `Error` from fetch, a wrapped rejection from a
  // client library, or a TypeError depending on the runtime, and requiring
  // `TypeError` meant the common case was classified as INTERNAL_ERROR -
  // which hides a transient outage behind "a bug in this system".
  if (/\bfetch failed\b|\bnetwork\b|ECONNREFUSED|ENOTFOUND|Failed to fetch|ECONNRESET|socket hang up|EAI_AGAIN/i.test(message)) {
    return networkError(message, { cause: value });
  }
  if (/\b(429|rate limit|too many requests)\b/i.test(message)) {
    return rateLimitError(message, { cause: value });
  }
  if (/\b(401|403|unauthor|forbidden|invalid api key|signature)\b/i.test(message)) {
    return authError(message, { cause: value });
  }
  return internalError(message, { cause: value });
}

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

const SECRET_KEYS = /^(api[-_]?key|secret|private[-_]?key|signing[-_]?key|passphrase|token|authorization|cookie|seed|mnemonic|wallet[-_]?secret)$/i;

export const REDACTED = '[redacted]';

/**
 * Replace anything that looks like a credential.
 *
 * Applied on every serialisation path, so a secret that reached a message
 * or a `details` object by accident does not reach a log. The patterns
 * are intentionally broad: over-redacting a log line is a small cost,
 * leaking a key is not.
 */
export function redact(value: string): string {
  let out = value;
  // PEM blocks.
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
  // 0x-prefixed 32-byte keys.
  out = out.replace(/\b0x[0-9a-fA-F]{64}\b/g, REDACTED);
  // Authorization headers first.
  //
  // Order is load-bearing. The labelled rule below matches `Authorization:`
  // and would consume only the `Bearer` scheme, replacing it and leaving the
  // token itself in the log. Greedy over non-whitespace rather than a
  // URL-safe character class, so a token containing an unusual character is
  // fully removed rather than partially redacted and partially logged -
  // which is worse than no pattern, because it looks like it works.
  out = out.replace(/\b(Bearer|Basic)\s+\S+/gi, `$1 ${REDACTED}`);

  // Labelled assignments, however they are spelled. The value is greedy to
  // whitespace so a multi-token secret is removed in full.
  out = out.replace(
    /\b((?:api[-_]?key|secret|private[-_]?key|signing[-_]?key|passphrase|token|authorization|seed|mnemonic)\b\s*[:=]\s*)("?)(\S{6,})\2/gi,
    `$1$2${REDACTED}$2`,
  );
  return out;
}

/** Recursively redact a value for logging. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return out;
}

/** The category of a cause, without its message. */
function causeCategory(cause: unknown): string {
  if (isTradingGOATsError(cause)) return cause.category;
  if (cause instanceof Error) return cause.name || 'Error';
  return typeof cause;
}
