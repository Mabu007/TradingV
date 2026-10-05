/**
 * Turning an OpenRouter HTTP failure into something a person can act on.
 *
 * The previous behaviour mapped 400, 404 and 422 to one message: "the
 * selected model may be unavailable for this key". That was wrong in both
 * directions — it hid a rejected key behind a model problem, and it hid a
 * genuinely broken endpoint behind a key that was fine.
 *
 * So the status is classified first, and the response body is read only to
 * separate the two things a 404 can mean:
 *
 *   the model is unknown or has no provider   -> pick another model
 *   the path is wrong                         -> this is a bug, not the user
 *
 * The body is used as a signal and never as text. A provider error page
 * can echo the credential that was sent to it, so the substring test below
 * is deliberately a fixed list of phrases rather than a message, and no
 * part of the response ever reaches a user, an agent's reasoning, or a
 * timeline entry. Diagnostics keep the status, the classification and the
 * model id — which is enough to debug and contains nothing secret.
 */

import type { AIProviderError, AIProviderErrorCode } from './types';
import { redactSecrets } from './redact';

/** How much of a failure body is read, and only to classify it. */
const BODY_SNIFF_LIMIT = 2048;

const MODEL_UNAVAILABLE_HINTS = [
  'no endpoints found',
  'no endpoints available',
  'no available providers',
  'not available for your account',
  'model is currently unavailable',
  'provider returned an error',
];

/**
 * OpenRouter answers 404 when the account's own privacy settings filter
 * out every provider that could serve the request — most often the free
 * endpoints. It is a 404 that has nothing to do with the model id, and
 * telling the user to pick another model would send them round in circles,
 * so it gets its own message.
 */
const ACCOUNT_FILTER_HINTS = ['guardrail', 'data policy', 'zdr'];

/**
 * "No such model", in the several shapes OpenRouter uses it.
 *
 * A fixed list of phrases and word orderings rather than a message
 * comparison, because the id sits between the two halves:
 * `Model "vendor/name" not found`.
 */
const MODEL_UNKNOWN_PATTERNS = [
  /model\s+"[^"]*"\s+not found/,
  /model\s+not found/,
  /no such model/,
  /unknown model/,
  /not a valid model/,
  /model does not exist/,
  /models? matching/,
];

/**
 * Reduce a body to something a fixed phrase list can match against.
 *
 * The two normalisations are there because a JSON error body escapes its
 * own quotes: `Model \"vendor/name\" not found` is the same sentence as
 * `Model "vendor/name" not found`, and without dropping the backslashes
 * every phrase list fails on exactly the payload it exists to recognise.
 */
function bodyHints(body: string): string {
  return body
    .slice(0, BODY_SNIFF_LIMIT)
    .toLowerCase()
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ');
}

function includes(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function matchesAny(haystack: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

/** Whether a 404 body is about the model rather than about the path. */
function isModelFailureBody(hints: string): 'unknown' | 'unavailable' | undefined {
  if (matchesAny(hints, MODEL_UNKNOWN_PATTERNS)) return 'unknown';
  if (includes(hints, MODEL_UNAVAILABLE_HINTS)) return 'unavailable';
  return undefined;
}

function failure(
  code: AIProviderErrorCode,
  message: string,
  status?: number,
): AIProviderError {
  return status === undefined ? { code, message } : { code, message, status };
}

/**
 * Classify a non-2xx response.
 *
 * `body` is the raw response text and is used only as a signal. Passing
 * `undefined` is fine and simply makes the classification status-only,
 * which is the honest answer when the body could not be read.
 */
export function classifyProviderFailure(
  status: number,
  body: string | undefined,
  model?: string,
): AIProviderError {
  const hints = body ? bodyHints(body) : '';

  // A 404 is the ambiguous one, and the ambiguity is the whole bug.
  if (status === 404) {
    const modelFailure = body ? isModelFailureBody(hints) : undefined;
    if (modelFailure === 'unknown') {
      return failure(
        'MODEL_NOT_FOUND',
        'This model is currently unavailable. Choose another model.',
        status,
      );
    }
    if (modelFailure === 'unavailable') {
      const filteredByAccount = body ? includes(hints, ACCOUNT_FILTER_HINTS) : false;
      return failure(
        'MODEL_UNAVAILABLE',
        filteredByAccount
          ? 'OpenRouter is filtering out every provider for this model because of your account privacy settings. Check Settings → Privacy on OpenRouter, or pick a paid model.'
          : 'This model has no provider available right now. Choose another model.',
        status,
      );
    }
    /*
     * An unknown path and an unknown model answer with the same status.
     * Saying "your model is unavailable" for a mistyped endpoint sends the
     * user to change something that was never wrong.
     */
    return failure(
      'ENDPOINT_NOT_FOUND',
      'TradingGOATs could not reach the OpenRouter chat endpoint. This is a bug, not your key.',
      status,
    );
  }

  switch (status) {
    case 400:
      return failure(
        'BAD_REQUEST',
        'OpenRouter rejected the request as malformed. Try again, and pick another model if it keeps happening.',
        status,
      );
    case 401:
      return failure(
        'INVALID_KEY',
        'Your OpenRouter API key was rejected. Check the key and try again.',
        status,
      );
    case 402:
      return failure(
        'OUT_OF_CREDITS',
        'Your OpenRouter account does not have enough credits for this request.',
        status,
      );
    case 403:
      return failure(
        'UNAUTHORIZED',
        'This key is not allowed to use the selected model. Choose another model or check the key.',
        status,
      );
    case 408:
      return failure(
        'PROVIDER_ERROR',
        'OpenRouter did not answer in time. Try again.',
        status,
      );
    case 422:
      return failure(
        'BAD_REQUEST',
        'OpenRouter could not process the request for this model. Try another model.',
        status,
      );
    case 429:
      return failure(
        'RATE_LIMITED',
        'This model is temporarily rate-limited. Try another model or try again shortly.',
        status,
      );
    default:
      break;
  }

  if (status === 503) {
    return failure(
      'MODEL_UNAVAILABLE',
      'No provider is available for this model right now. Try another model, or try again shortly.',
      status,
    );
  }

  if (status >= 500) {
    return failure(
      'PROVIDER_ERROR',
      'OpenRouter or the model provider is having trouble. Try again shortly.',
      status,
    );
  }

  return failure(
    'UNKNOWN',
    'The request to OpenRouter did not succeed. Try again.',
    status,
  );
}

/** Transport failure: nothing was answered at all. */
export function networkFailure(error: unknown): AIProviderError {
  /*
   * Logged through the same redaction as everything else, and only ever to
   * the console: a user pasting a console into an issue report should not
   * be pasting their own key.
   */
  console.warn(
    `OpenRouter request failed: ${redactSecrets(
      error instanceof Error ? error.message : 'unknown error',
    )}`,
  );

  return {
    code: 'NETWORK_ERROR',
    message: 'Could not reach OpenRouter. Check your connection and try again.',
  };
}

/**
 * Developer-facing line for a classified failure.
 *
 * No body, no headers, no credential: status, class and model id.
 */
export function diagnostics(error: AIProviderError, model?: string): string {
  const parts = [`OpenRouter ${error.code}`];
  if (error.status !== undefined) parts.push(`status ${error.status}`);
  if (model) parts.push(`model ${model}`);
  return parts.join(' · ');
}

/**
 * Whether a failure is the user's key rather than the model.
 *
 * The distinction decides what the UI offers: a key problem is fixed in
 * settings, a model problem is fixed in the picker.
 */
export function isCredentialFailure(error: AIProviderError): boolean {
  return error.code === 'KEY_REQUIRED' || error.code === 'INVALID_KEY' || error.code === 'UNAUTHORIZED';
}

/** Whether switching the model is the useful next step. */
export function isModelFailure(error: AIProviderError): boolean {
  return (
    error.code === 'MODEL_NOT_FOUND' ||
    error.code === 'MODEL_UNAVAILABLE' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'BAD_REQUEST'
  );
}

/**
 * Codes that mean "the provider answered, and the answer was unusable".
 *
 * ## Why this exists
 *
 * Every other code here describes a provider that could not be reached or would
 * not accept the request, and the retry behaviour attached to those is correct:
 * the same call a minute later is likely to work, so arming a bounded retry is
 * exactly what should happen.
 *
 * A response that arrived and could not be read is a different situation. The
 * transport worked, so waiting does not fix it, and retrying the identical call
 * burns a model request per attempt to arrive at the same unreadable answer.
 * These were previously folded into `EMPTY_RESPONSE` and therefore treated as an
 * outage.
 */
const RESPONSE_SHAPE_CODES: ReadonlySet<AIProviderErrorCode> = new Set<AIProviderErrorCode>([
  'EMPTY_RESPONSE',
  'NO_CHOICES',
  'CONTENT_FILTERED',
  'UNREADABLE_RESPONSE',
]);

/**
 * Whether the provider answered with something this adapter could not use.
 *
 * True means the call reached the provider and came back unusable, so outage
 * recovery — retries, reconsideration timers — is the wrong response. It does not
 * mean the call succeeded: there is still no answer to reason from.
 */
export function isResponseShapeFailure(error: AIProviderError): boolean {
  return RESPONSE_SHAPE_CODES.has(error.code);
}

/**
 * The inverse, named so call sites can ask the availability question directly.
 *
 * The codes that mean the provider could not be reached or would not accept the
 * request. Availability, retry and reconsideration are keyed on this, so it is
 * stated as one list rather than left implicit in the shape codes above.
 */
const OUTAGE_CODES: ReadonlySet<AIProviderErrorCode> = new Set<AIProviderErrorCode>([
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'MODEL_NOT_FOUND',
  'UNAUTHORIZED',
  'INVALID_KEY',
  'OUT_OF_CREDITS',
  'KEY_REQUIRED',
  'ENDPOINT_NOT_FOUND',
  'BAD_REQUEST',
  'UNKNOWN',
]);

/** Whether this code means the provider could not be reached or would not serve. */
export function isProviderOutageCode(code: AIProviderErrorCode): boolean {
  return OUTAGE_CODES.has(code);
}
