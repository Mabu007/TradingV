import {
  AIChatContext,
  AIMessage,
  AIProviderConfig,
  AIProviderError,
  AIResponse,
  IAIProvider,
  ModelCatalogue,
  OpenRouterModel,
} from './types';
import { chatCompletionsUrl } from './endpoints';
import {
  classifyProviderFailure,
  diagnostics,
  networkFailure,
} from './errors';
import {
  DEFAULT_MODEL_ID,
  clearModelCatalogueCache,
  currentModelCatalogue,
  fetchModelCatalogue,
  isModelAvailable,
  pickDefaultModel,
} from './catalogue';

/**
 * Sentinels the UI already branches on, kept stable.
 *
 * They appear in `content` so the existing copilot keeps working, and
 * deliberately carry nothing else. An earlier version appended the
 * provider's own error text to the sentinel, which meant provider payload
 * travelled through the same channel as model output — into agent
 * reasoning and into the timeline, where it is indistinguishable from
 * something the model said. The text now travels in `error`.
 */
export const KEY_REQUIRED = 'OPENROUTER_API_KEY_REQUIRED';
export const REQUEST_FAILED = 'OPENROUTER_REQUEST_FAILED';

export { redactSecrets } from './redact';

/**
 * Whether a string is plausibly an OpenRouter key.
 *
 * Shape, not length. A length check alone accepts a pasted sentence, and
 * "has a key" is the question the whole UI turns on: a key that is present
 * but wrong should be reported as wrong before a request is made, not
 * discovered as a 401 later.
 */
export function looksLikeApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 20) return false;
  if (/\s/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return false;
  return true;
}

const STORAGE_KEY = 'tradingvibe_openrouter_config';

/**
 * The shipped default.
 *
 * Not a hand-picked favourite: it is a free, text-capable model that
 * supports tool calling and structured output, because that is the request
 * format the GOAT runtime sends. It is still validated against the live
 * catalogue at startup (see `reconcileModel`) so a model that disappears
 * does not take the product down with it.
 */
export const DEFAULT_AI_CONFIG: AIProviderConfig = {
  apiKey: '',
  model: DEFAULT_MODEL_ID,
  siteUrl: 'https://tradinggoats.local',
  siteName: 'TradingGOATs',
};

const SYSTEM_PROMPT = `You are TradingGOATs AI, an expert quantitative trading engineer and autonomous trading-agent reasoning system.

GOAT agents operate on the market their deployment is bound to. The GOAT itself is asset-agnostic.

The agent may receive:
- Current market quote
- Recent completed candles
- Technical indicator results
- Market structure information
- Account state
- Open positions
- Orders
- Tracker information
- Available skills
- Available capabilities
- Previous tool results

The agent must reason only from information actually provided by the TradingGOATs runtime.

IMPORTANT RULES:

1. Never invent market data, prices, candles, indicators, positions, balances, orders, or execution results.
2. Never assume a particular instrument such as EUR/USD unless that instrument is explicitly provided by the runtime.
3. Always use the deployed symbol supplied by the runtime when making a trading decision.
4. Never use placeholder market values.
5. If the available information is insufficient to make a responsible decision, return WAIT.
6. A trading decision must include a concrete stop loss.
7. Respect the GOAT's risk policy, capabilities, and deployment permissions.
8. Do not bypass risk controls.
9. Do not claim an order was executed. The TradingGOATs runtime performs execution and reports the result separately.
10. The AI does not have access to signing credentials or exchange credentials.
11. Do not provide financial-advice language. You are operating as a trading-system reasoning component.
12. Prefer WAIT when evidence is ambiguous or conflicting.

AVAILABLE DECISIONS:

WAIT
Use when there is no valid trading opportunity or more information is required.

ANALYZE
Use when additional analysis through an available capability is required before deciding.

OPEN_POSITION
Use only when the available evidence supports a trade and the GOAT's capabilities and policies permit it.

MODIFY_POSITION
Use when an existing position requires a stop-loss or take-profit modification.

CLOSE_POSITION
Use when an existing position should be closed.

Return a single valid JSON object matching the requested decision schema.
Do not wrap the JSON in markdown.
Do not add explanatory text outside the JSON.`;

type OpenRouterContext = AIChatContext;

export class OpenRouterProvider implements IAIProvider {
  private config: AIProviderConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Reads persisted configuration, validating every field.
   *
   * A blind spread of whatever is in local storage means a stale shape from
   * an older build, a hand-edited value, or a half-written record can put
   * an object where a string belongs — and then `hasApiKey()` reads a
   * truthy object as a valid key. Field by field, each with the type it is
   * supposed to have, is what makes the rest of this class able to assume
   * its config is well formed.
   */
  loadConfig(): AIProviderConfig {
    const config: AIProviderConfig = { ...DEFAULT_AI_CONFIG };

    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed: unknown = JSON.parse(saved);

        if (isRecord(parsed)) {
          if (typeof parsed.apiKey === 'string') config.apiKey = parsed.apiKey;
          if (typeof parsed.model === 'string' && parsed.model.trim()) {
            config.model = parsed.model.trim();
          }
          if (typeof parsed.siteUrl === 'string') config.siteUrl = parsed.siteUrl;
          if (typeof parsed.siteName === 'string') config.siteName = parsed.siteName;
          if (typeof parsed.lastWorkingModel === 'string' && parsed.lastWorkingModel.trim()) {
            config.lastWorkingModel = parsed.lastWorkingModel.trim();
          }
        }
      }
    } catch {
      // Invalid or unavailable local storage should not prevent the app from loading.
    }

    return config;
  }

  /** Merges only the fields that were supplied, and only of the right type. */
  saveConfig(newConfig: Partial<AIProviderConfig>): void {
    const merged: AIProviderConfig = { ...this.config };

    if (typeof newConfig.apiKey === 'string') merged.apiKey = newConfig.apiKey;
    if (typeof newConfig.model === 'string' && newConfig.model.trim()) {
      merged.model = newConfig.model.trim();
    }
    if (typeof newConfig.siteUrl === 'string') merged.siteUrl = newConfig.siteUrl;
    if (typeof newConfig.siteName === 'string') merged.siteName = newConfig.siteName;
    if (typeof newConfig.lastWorkingModel === 'string' && newConfig.lastWorkingModel.trim()) {
      merged.lastWorkingModel = newConfig.lastWorkingModel.trim();
    }

    this.config = merged;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // Configuration remains available in memory for the current session.
    }
  }

  /**
   * Forgets the credential.
   *
   * Removing a BYO key is a thing a user does for a reason — a shared
   * machine, a key they think leaked — so it has to actually remove it
   * from disk and not only from memory.
   */
  clearApiKey(): void {
    this.config = { ...this.config, apiKey: '' };

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Configuration remains available in memory for the current session.
    }
  }

  getConfig(): AIProviderConfig {
    return {
      ...this.config,
    };
  }

  hasApiKey(): boolean {
    return looksLikeApiKey(this.config.apiKey);
  }

  // -------------------------------------------------------------------------
  // Model catalogue
  // -------------------------------------------------------------------------

  /**
   * The models OpenRouter currently offers.
   *
   * Fetched rather than listed, because a listed set of ids goes stale and
   * a stale id is a 404 on every request. Never throws: an unreachable
   * catalogue degrades to a small built-in list so the app stays usable.
   */
  async listModels(options?: { force?: boolean }): Promise<ModelCatalogue> {
    return fetchModelCatalogue(options);
  }

  /** The catalogue already in hand, if one has been fetched. */
  knownModels(): ModelCatalogue | undefined {
    return currentModelCatalogue();
  }

  refreshModels(): Promise<ModelCatalogue> {
    clearModelCatalogueCache();
    return fetchModelCatalogue({ force: true });
  }

  /** Select a model, without touching anything else in the configuration. */
  setModel(modelId: string): void {
    const trimmed = modelId.trim();
    if (trimmed) this.saveConfig({ model: trimmed });
  }

  /**
   * Check a persisted model against the live catalogue.
   *
   * Returns whether the selection is still offered. It deliberately does
   * *not* change the selection: silently switching a user's model is worse
   * than telling them it is gone, because then the answer they get back is
   * not from the model they chose.
   */
  async isSelectedModelAvailable(): Promise<boolean> {
    const catalogue = await this.listModels();
    return isModelAvailable(catalogue.models, this.config.model);
  }

  /**
   * A model that is currently listed, preferring the current selection.
   *
   * Used at startup so a default which has been retired stops being
   * requested. Returns the id to use; never null, because the fallback list
   * always has something in it.
   */
  async reconcileModel(): Promise<string> {
    const catalogue = await this.listModels();
    const previous = this.config.model;
    if (isModelAvailable(catalogue.models, previous)) {
      return previous;
    }
    const replacement = pickDefaultModel(catalogue.models);
    if (replacement && replacement !== previous) {
      this.setModel(replacement);
      console.info(
        `OpenRouter model "${previous}" is no longer offered. Using "${replacement}".`,
      );
    }
    return this.config.model;
  }

  /**
   * Send one short prompt to one model, to find out whether it works.
   *
   * A user who is about to trust a model with a GOAT needs to know before
   * they deploy it, and a model picker is the only place that question
   * makes sense. It costs one cheap completion, which is why it is an
   * action and not something that happens for all fifty models.
   */
  async testModel(modelId: string): Promise<AIResponse> {
    return this.chat([{ role: 'user', content: 'Reply with the single word: ready' }], {
      model: modelId,
      systemPrompt: 'You are a connectivity check. Reply with one short word.',
    });
  }

  async chat(
    messages: AIMessage[],
    context?: OpenRouterContext,
  ): Promise<AIResponse> {
    if (!this.hasApiKey()) {
      return {
        content: KEY_REQUIRED,
        error: {
          code: 'KEY_REQUIRED',
          message: 'Connect an OpenRouter API key to use AI features.',
        },
      };
    }

    return this.callOpenRouter(messages, context);
  }

  private async callOpenRouter(
    messages: AIMessage[],
    context?: OpenRouterContext,
  ): Promise<AIResponse> {
    const contextPrefix = this.buildContextPrefix(context);

    /*
     * The copilot supplies its own product prompt. The agent runtime does
     * not, and keeps the trading-decision prompt above unchanged.
     */
    const systemPrompt = context?.systemPrompt?.trim()
      ? context.systemPrompt.trim()
      : SYSTEM_PROMPT;

    const payloadMessages = [
      {
        role: 'system' as const,
        content: systemPrompt + contextPrefix,
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    const model =
      context?.model?.trim() ||
      this.config.model ||
      DEFAULT_AI_CONFIG.model;

    try {
      /*
       * One URL, built in one place. The previous 404 was a duplicated
       * path; the exact string this resolves to is asserted in the tests
       * and must stay
       * `https://openrouter.ai/api/v1/chat/completions`.
       */
      const response = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // BYO key: sent from the user's browser straight to OpenRouter.
          // TradingGOATs never proxies or logs it.
          Authorization: `Bearer ${this.config.apiKey.trim()}`,
          'HTTP-Referer':
            this.config.siteUrl || 'https://tradinggoats.local',
          'X-Title':
            this.config.siteName || 'TradingGOATs',
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        /*
         * The body is read to classify the failure and then thrown away.
         * A provider error page can echo the credential that was sent to
         * it, and there is no version of surfacing it that is safe. The
         * status, plus the fixed set of phrases that separate "no such
         * model" from "no such endpoint", is all that is needed.
         */
        const body = await response.text().catch(() => undefined);
        const error: AIProviderError = classifyProviderFailure(
          response.status,
          body,
          model,
        );

        // Status, class and model id. Never the body, never the credential.
        console.warn(diagnostics(error, model));

        return {
          content: REQUEST_FAILED,
          error,
        };
      }

      const json: unknown = await response.json().catch(() => undefined);

      const extracted = extractResponseText(json);

      /*
       * Each outcome is named for what happened rather than collapsed into one
       * "empty response", so the reason a call produced nothing is legible to
       * whoever reads the failure instead of being a guess.
       */
      if (extracted.kind !== 'text') {
        return {
          content: REQUEST_FAILED,
          error: {
            code: RESPONSE_SHAPE_ERROR[extracted.kind],
            message: RESPONSE_SHAPE_MESSAGE[extracted.kind],
            status: response.status,
          },
        };
      }

      const content = extracted.text;

      /*
       * A model that answered is a model this key can use. Remembered so
       * the picker can offer "last known working" without making the user
       * discover it by failing first.
       */
      if (model === this.config.model) this.saveConfig({ lastWorkingModel: model });

      return {
        content: content.trim(),
      };
    } catch (error) {
      return {
        content: REQUEST_FAILED,
        error: networkFailure(error),
      };
    }
  }

  private buildContextPrefix(
    context?: OpenRouterContext,
  ): string {
    if (!context) {
      return '';
    }

    const sections: string[] = [];

    if (context.symbol) {
      sections.push(
        `Deployed instrument: ${context.symbol}`,
      );
    }

    if (context.timeframe) {
      sections.push(
        `Active timeframe: ${context.timeframe}`,
      );
    }

    if (context.contextPrefix) {
      sections.push(context.contextPrefix);
    }

    if (context.currentCode) {
      sections.push(
        `Active strategy code:\n${context.currentCode}`,
      );
    }

    if (sections.length === 0) {
      return '';
    }

    return `\n\nTRADINGGOATS RUNTIME CONTEXT:\n${sections.join('\n')}`;
  }
}

export const openRouterProvider = new OpenRouterProvider();
/**
 * How each unusable-but-received response is named.
 *
 * The provider was reached in every one of these cases, which is the whole
 * reason they are named separately from the codes that mean it could not be.
 */
const RESPONSE_SHAPE_ERROR: Record<
  Exclude<ExtractedContent['kind'], 'text'>,
  AIProviderError['code']
> = {
  empty: 'EMPTY_RESPONSE',
  no_choices: 'NO_CHOICES',
  filtered: 'CONTENT_FILTERED',
  null_content: 'EMPTY_RESPONSE',
  unreadable: 'UNREADABLE_RESPONSE',
};

const RESPONSE_SHAPE_MESSAGE: Record<Exclude<ExtractedContent['kind'], 'text'>, string> = {
  empty: 'The model returned an empty response. Try again.',
  no_choices: 'OpenRouter returned no answer for this model, which usually means no provider was free to serve it.',
  filtered: 'The provider blocked this response before the model could answer.',
  null_content: 'The model returned no text for this request. Try again.',
  unreadable:
    'OpenRouter answered in a format TradingGOATs could not read. This is a problem on our side, not an outage.',
};

/** Narrow an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a provider response turned out to be.
 *
 * The distinction being preserved is between "nothing came back" and "something
 * came back and this is what it was". A single `EMPTY_RESPONSE` for every
 * unusable 200 made a refusal, a filter, an empty routing result and an
 * unfamiliar envelope indistinguishable — and then routed all four into the
 * availability path, which is built for a provider that cannot be reached.
 */
type ExtractedContent =
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'no_choices' }
  | { kind: 'filtered' }
  | { kind: 'null_content' }
  | { kind: 'unreadable' };

/**
 * `finish_reason` values that mean the provider declined to answer.
 *
 * Matched on substrings because OpenRouter and the providers behind it do not
 * agree on spelling (`content_filter` and `content-filtered` both occur), and
 * treating an unrecognised sibling as an ordinary empty answer would be the same
 * mistake in miniature.
 */
const FILTER_FINISH_REASONS = ['content_filter', 'content-filtered', 'safety', 'blocked'];

/**
 * Pull the assistant text out of a response, tolerating the shapes providers
 * actually use.
 *
 * A string is the common case. An array of parts is equally common and was
 * being read as nothing at all, which turned an ordinary answer into an outage.
 * Null content is not an answer and is reported as such rather than as text.
 */
export function extractResponseText(json: unknown): ExtractedContent {
  if (!isRecord(json)) return { kind: 'unreadable' };

  const choices = json['choices'];
  if (!Array.isArray(choices)) return { kind: 'unreadable' };
  if (choices.length === 0) return { kind: 'no_choices' };

  const first = choices[0];
  if (!isRecord(first)) return { kind: 'unreadable' };

  /*
   * Checked before the message is read, and only as a signal: a filter that
   * leaves `content: null` is otherwise indistinguishable from a model that
   * simply had nothing to say.
   */
  const finishReason = first['finish_reason'];
  if (typeof finishReason === 'string') {
    const lowered = finishReason.toLowerCase();
    if (FILTER_FINISH_REASONS.some((reason) => lowered.includes(reason))) {
      return { kind: 'filtered' };
    }
  }

  const message = first['message'];
  if (!isRecord(message)) return { kind: 'unreadable' };

  const content = message['content'];

  if (typeof content === 'string') {
    return content.trim() ? { kind: 'text', text: content } : { kind: 'empty' };
  }

  if (Array.isArray(content)) {
    // Parts are joined in order; a part's `text` is the only field read.
    const parts = content
      .filter(isRecord)
      .map((part) => part['text'])
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
    const joined = parts.join('').trim();
    return joined ? { kind: 'text', text: joined } : { kind: 'empty' };
  }

  // Explicitly null is the provider declining to answer, not a missing field.
  if (content === null) return { kind: 'null_content' };

  return { kind: 'unreadable' };
}
