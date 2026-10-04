/**
 * Model discovery.
 *
 * OpenRouter publishes its catalogue at `GET /api/v1/models`, and it
 * changes: the build that shipped a hand-written list of six had two of
 * them gone within a fortnight, which is why every request 404'd with
 * "model not found". A hard-coded list cannot be right for long, and the
 * cost of being wrong is a product that cannot talk to a model at all.
 *
 * So the list is fetched, filtered to text-in/text-out models, normalised
 * into something a picker can render, and cached. The hand-written list
 * survives only as a small fallback for when the catalogue itself cannot be
 * reached — a fallback that exists to keep the app usable, not to be the
 * source of truth.
 *
 * What the catalogue cannot tell us is whether *this user's key* can
 * actually use a given model. Nothing here pretends otherwise: availability
 * is metadata plus the result of real requests, and the two are reported
 * separately.
 */

import type { ModelCatalogue, OpenRouterModel } from './types';
import { modelsUrl } from './endpoints';
import { classifyProviderFailure } from './errors';

/** How long a fetched catalogue is trusted before it is refetched. */
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_STORAGE_KEY = 'tradingvibe_openrouter_catalogue_v1';

/** Context length at or above which the "long context" filter includes a model. */
export const LONG_CONTEXT_TOKENS = 200_000;

/**
 * The order the picker offers models in "Recommended".
 *
 * A short, ordered list of ids, not names: names change, ids are what a
 * request needs, and every entry here is checked against the live
 * catalogue before it is offered. Anything missing is simply not shown.
 *
 * Ordered by what an MVP tester needs first: free, capable of tools and
 * structured output, and enough context for the agent runtime.
 */
export const RECOMMENDED_MODEL_IDS = [
  'openrouter/free',
  'stealth/space-bunny-alpha',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemini-2.5-flash',
  'openai/gpt-4.1-mini',
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-chat',
  'meta-llama/llama-3.3-70b-instruct',
];

/** The organisation half of a model id, as a readable word. */
export function providerFromId(id: string): string {
  const prefix = id.split('/')[0] ?? '';
  return prettifyVendor(prefix);
}

const VENDOR_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  nvidia: 'NVIDIA',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openrouter: 'OpenRouter',
  'x-ai': 'xAI',
  microsoft: 'Microsoft',
  cohere: 'Cohere',
  liquid: 'Liquid AI',
  poolside: 'Poolside',
  thinkingmachines: 'Thinking Machines',
};

function prettifyVendor(prefix: string): string {
  const known = VENDOR_NAMES[prefix.toLowerCase()];
  if (known) return known;
  return prefix
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The default model.
 *
 * Free, text-capable, and supports both tool calling and structured
 * output, because that is what the GOAT runtime's request format needs. It
 * is still validated against the live catalogue at startup — a default that
 * has quietly disappeared is replaced rather than shipped.
 */
export const DEFAULT_MODEL_ID = 'openrouter/free';

/**
 * Known-good models for when the catalogue cannot be fetched.
 *
 * Deliberately small. This list is not the product's model picker; it is
 * what keeps the app from becoming unusable during an outage, and it is
 * written so that a wrong entry costs one model rather than a screen.
 */
export const FALLBACK_MODELS: OpenRouterModel[] = [
  fallbackModel('openrouter/free', 'Free Models Router', 200_000),
  fallbackModel('stealth/space-bunny-alpha', 'Space Bunny Alpha', 1_000_000),
  fallbackModel('nvidia/nemotron-3-super-120b-a12b:free', 'NVIDIA: Nemotron 3 Super', 262_144),
  fallbackModel('google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', 1_048_576),
  fallbackModel('openai/gpt-4.1-mini', 'OpenAI: GPT-4.1 Mini', 1_047_576),
  fallbackModel('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5', 1_000_000),
  fallbackModel('deepseek/deepseek-chat', 'DeepSeek: V3', 163_840),
  fallbackModel('meta-llama/llama-3.3-70b-instruct', 'Meta: Llama 3.3 70B', 131_072),
];

function fallbackModel(id: string, name: string, contextLength: number): OpenRouterModel {
  return {
    id,
    name,
    provider: providerFromId(id),
    contextLength,
    promptPerMillion: 0,
    completionPerMillion: 0,
    isFree: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsReasoning: true,
    supportsVision: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Is this a model that takes text and answers in text?
 *
 * Everything in the catalogue is a text model in the loose sense, which is
 * exactly the problem: an embedding, rerank or image model also reads text
 * and cannot hold a conversation. The architecture block is what
 * distinguishes them, and both directions have to hold — text in *and*
 * text out.
 */
export function isTextModel(architecture: unknown): boolean {
  if (!isRecord(architecture)) return false;
  const input = architecture['input_modalities'];
  const output = architecture['output_modalities'];
  return (
    Array.isArray(input) && input.includes('text') &&
    Array.isArray(output) && output.includes('text')
  );
}

/**
 * Normalise one catalogue entry, or `undefined` if it is not usable.
 *
 * Nothing here guesses. A model with no context length or an unparseable
 * pricing block is dropped rather than displayed with invented numbers,
 * because the two numbers next to its name are the ones a user compares
 * before paying for it.
 */
export function normaliseModel(raw: unknown): OpenRouterModel | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw['id']).trim();
  if (!id) return undefined;
  if (!isTextModel(raw['architecture'])) return undefined;

  const pricing = isRecord(raw['pricing']) ? raw['pricing'] : {};
  const promptPerMillion = asNumber(pricing['prompt']);
  const completionPerMillion = asNumber(pricing['completion']);
  const contextLength = asNumber(raw['context_length']);
  if (contextLength <= 0) return undefined;

  const parameters = Array.isArray(raw['supported_parameters'])
    ? (raw['supported_parameters'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const architecture = isRecord(raw['architecture']) ? raw['architecture'] : {};
  const inputModalities = Array.isArray(architecture['input_modalities'])
    ? (architecture['input_modalities'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];

  const publishedName = asString(raw['name']).trim();
  const name = publishedName.replace(/\s*\(free\)\s*$/i, '').trim() || id;

  return {
    id,
    name,
    provider: providerFromId(id),
    contextLength,
    promptPerMillion,
    completionPerMillion,
    isFree: id.endsWith(':free') || (promptPerMillion === 0 && completionPerMillion === 0),
    supportsTools: parameters.includes('tools'),
    supportsStructuredOutputs: parameters.includes('structured_outputs'),
    supportsReasoning: parameters.includes('reasoning'),
    supportsVision: inputModalities.includes('image'),
    description: truncate(asString(raw['description']).replace(/\s+/g, ' '), 160),
  };
}

function truncate(value: string, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Normalise a whole `/models` payload. */
export function normaliseCatalogue(payload: unknown): OpenRouterModel[] {
  if (!isRecord(payload)) return [];
  const data = payload['data'];
  if (!Array.isArray(data)) return [];

  const models: OpenRouterModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const model = normaliseModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }

  // Priced and free models mixed together is the normal case; the picker
  // sorts, so the order here only has to be stable.
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Does this model meet what the GOAT runtime's request format needs? */
export function supportsAgentReasoning(model: OpenRouterModel): boolean {
  return model.supportsTools && model.supportsStructuredOutputs;
}

/**
 * Pick a default from whatever catalogue is available.
 *
 * The order of preference is the MVP order: the recommended list first,
 * then any free model that can reason, then anything free, then anything at
 * all. A model that has gone from the catalogue is never returned, which is
 * the entire failure this replaces.
 */
export function pickDefaultModel(models: OpenRouterModel[]): string {
  const available = new Set(models.map((model) => model.id));

  for (const id of RECOMMENDED_MODEL_IDS) {
    if (available.has(id)) return id;
  }

  const freeAgent = models.find((model) => model.isFree && supportsAgentReasoning(model));
  if (freeAgent) return freeAgent.id;

  const free = models.find((model) => model.isFree);
  if (free) return free.id;

  const cheapest = models
    .filter((model) => model.promptPerMillion > 0)
    .sort((a, b) => a.promptPerMillion - b.promptPerMillion)[0];
  if (cheapest) return cheapest.id;

  return models[0]?.id ?? DEFAULT_MODEL_ID;
}

/**
 * Is a persisted model still offered?
 *
 * Used to decide whether the picker shows a "no longer available" notice.
 * The answer is never acted on silently — the user's selection is theirs.
 */
export function isModelAvailable(models: OpenRouterModel[], id: string): boolean {
  return models.some((model) => model.id === id);
}

/** The recommended section, in the order `RECOMMENDED_MODEL_IDS` declares. */
export function recommendedModels(models: OpenRouterModel[]): OpenRouterModel[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const recommended: OpenRouterModel[] = [];
  for (const id of RECOMMENDED_MODEL_IDS) {
    const model = byId.get(id);
    if (model) recommended.push(model);
  }
  return recommended;
}

export interface ModelFilters {
  query?: string;
  freeOnly?: boolean;
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
  longContextOnly?: boolean;
}

/**
 * Search and filter for the picker.
 *
 * Matching runs over the name, the id and the provider, because people
 * search for all three: "gpt", "openai" and "OpenAI" should all find the
 * same models.
 */
export function filterModels(
  models: OpenRouterModel[],
  filters: ModelFilters,
): OpenRouterModel[] {
  const query = (filters.query ?? '').trim().toLowerCase();

  return models.filter((model) => {
    if (filters.freeOnly && !model.isFree) return false;
    if (filters.toolsOnly && !model.supportsTools) return false;
    if (filters.reasoningOnly && !model.supportsReasoning) return false;
    if (filters.longContextOnly && model.contextLength < LONG_CONTEXT_TOKENS) return false;
    if (!query) return true;

    return (
      model.name.toLowerCase().includes(query) ||
      model.id.toLowerCase().includes(query) ||
      model.provider.toLowerCase().includes(query)
    );
  });
}

// ---------------------------------------------------------------------------
// Fetching and caching
// ---------------------------------------------------------------------------

let inflight: Promise<ModelCatalogue> | undefined;
let cached: ModelCatalogue | undefined;

/**
 * Read a stored catalogue back.
 *
 * Stored models are already in the flat shape, not the provider's nested
 * one, so they are validated here rather than through `normaliseModel`:
 * a cache written by an older build with different fields is discarded
 * instead of being read as if it were current.
 */
function coerceStoredModel(raw: unknown): OpenRouterModel | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw['id']).trim();
  const contextLength = asNumber(raw['contextLength']);
  if (!id || contextLength <= 0) return undefined;

  const name = asString(raw['name']).trim() || id;
  return {
    id,
    name,
    provider: asString(raw['provider']).trim() || providerFromId(id),
    contextLength,
    promptPerMillion: asNumber(raw['promptPerMillion']),
    completionPerMillion: asNumber(raw['completionPerMillion']),
    isFree: raw['isFree'] === true,
    supportsTools: raw['supportsTools'] === true,
    supportsStructuredOutputs: raw['supportsStructuredOutputs'] === true,
    supportsReasoning: raw['supportsReasoning'] === true,
    supportsVision: raw['supportsVision'] === true,
    description: asString(raw['description']) || undefined,
  };
}

function readCache(): ModelCatalogue | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const models = Array.isArray(parsed['models']) ? parsed['models'] : [];
    const normalised = models
      .map((entry) => coerceStoredModel(entry))
      .filter((model): model is OpenRouterModel => model !== undefined);
    if (normalised.length === 0) return undefined;
    const fetchedAt = asNumber(parsed['fetchedAt']);
    return { models: normalised, source: 'cache', fetchedAt };
  } catch {
    return undefined;
  }
}

function writeCache(catalogue: ModelCatalogue): void {
  try {
    globalThis.localStorage?.setItem(
      CACHE_STORAGE_KEY,
      JSON.stringify({ models: catalogue.models, fetchedAt: catalogue.fetchedAt }),
    );
  } catch {
    // A full or unavailable storage must not break model selection.
  }
}

/** Drops the in-memory and stored catalogue. Used by "refresh". */
export function clearModelCatalogueCache(): void {
  cached = undefined;
  inflight = undefined;
  try {
    globalThis.localStorage?.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // Nothing to do: the cache is an optimisation.
  }
}

/**
 * Fetch the catalogue.
 *
 * Falls back, in order, to the last successful fetch and then to the small
 * hand-written list. A failure to discover models is never allowed to be a
 * failure to use the app, so every path returns a catalogue and reports
 * which one it is.
 */
export async function fetchModelCatalogue(options?: {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<ModelCatalogue> {
  const now = options?.now ?? Date.now;
  const doFetch = options?.fetchImpl ?? globalThis.fetch;

  if (!options?.force) {
    if (cached && now() - cached.fetchedAt < CATALOGUE_TTL_MS) return cached;
    const stored = readCache();
    if (stored && now() - stored.fetchedAt < CATALOGUE_TTL_MS) {
      cached = stored;
      return stored;
    }
  }

  // One request in flight, however many components ask for it.
  if (inflight && !options?.force) return inflight;

  inflight = (async (): Promise<ModelCatalogue> => {
    try {
      const response = await doFetch(modelsUrl(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => undefined);
        throw new Error(String(classifyProviderFailure(response.status, body).code));
      }

      const payload: unknown = await response.json();
      const models = normaliseCatalogue(payload);
      if (models.length === 0) throw new Error('EMPTY_CATALOGUE');

      const catalogue: ModelCatalogue = { models, source: 'api', fetchedAt: now() };
      cached = catalogue;
      writeCache(catalogue);
      return catalogue;
    } catch {
      const stale = cached ?? readCache();
      if (stale) return { ...stale, source: 'cache' };

      return {
        models: FALLBACK_MODELS,
        source: 'fallback',
        fetchedAt: now(),
        error: {
          code: 'NETWORK_ERROR',
          message: 'Could not load the OpenRouter model list. Showing a small built-in list.',
        },
      };
    } finally {
      inflight = undefined;
    }
  })();

  return inflight;
}

/** The catalogue already held, if any. Never fetches. */
export function currentModelCatalogue(): ModelCatalogue | undefined {
  return cached ?? readCache();
}
