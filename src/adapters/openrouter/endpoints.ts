/**
 * OpenRouter endpoints, in one place.
 *
 * The 404 this build shipped with was a path problem in every version of
 * the guess: a base that already carried `/api/v1/chat/completions` with
 * `/chat/completions` appended to it, or a relative URL resolved against
 * the dev server. Both produce a request to a URL that does not exist,
 * and OpenRouter answers an unknown path with the same 404 it uses for an
 * unknown model — which is why the UI could only say "the model may be
 * unavailable" and be half right.
 *
 * So there is exactly one base, one path builder, and one normaliser, and
 * every request in this adapter goes through them. A duplicated or
 * relative path is now a construction that cannot be written.
 *
 * Verified against the live API (no credential required for the
 * catalogue, 401 for the chat endpoint, which is what a wrong path would
 * never return):
 *
 *   POST https://openrouter.ai/api/v1/chat/completions  -> 401 unauthenticated
 *   GET  https://openrouter.ai/api/v1/models            -> 200
 */

/** The documented API base. No trailing slash, no version duplication. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const OPENROUTER_CHAT_PATH = '/chat/completions';
export const OPENROUTER_MODELS_PATH = '/models';

/**
 * Join the base with a path, collapsing any accidental repetition.
 *
 * The collapsing is not decoration. If a caller ever hands this function a
 * base that already ends in `/api/v1`, or a path that already starts with
 * `/api/v1`, the result is still one correct URL rather than a request to
 * `/api/v1/api/v1/chat/completions`.
 */
export function openRouterUrl(
  path: string,
  base: string = OPENROUTER_BASE_URL,
): string {
  const wanted = path.trim().replace(/^\/+/, '');
  const trimmedBase = base.trim().replace(/\/+$/, '');

  /*
   * A base that already ends in the requested path is the URL. This is the
   * exact shape of the bug that shipped: a base holding
   * `.../api/v1/chat/completions` with `/chat/completions` appended to it.
   */
  if (trimmedBase.endsWith(`/${wanted}`)) {
    return trimmedBase;
  }

  const withoutVersion = trimmedBase.replace(/\/api\/v\d+$/, '');
  const pathWithoutVersion = wanted.replace(/^api\/v\d+\//, '');

  return `${withoutVersion}/api/v1/${pathWithoutVersion}`;
}

/** `https://openrouter.ai/api/v1/chat/completions` */
export function chatCompletionsUrl(base?: string): string {
  return openRouterUrl(OPENROUTER_CHAT_PATH, base);
}

/** `https://openrouter.ai/api/v1/models` */
export function modelsUrl(base?: string): string {
  return openRouterUrl(OPENROUTER_MODELS_PATH, base);
}
