export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIProviderConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
  /**
   * The last model this key actually got a successful completion from.
   *
   * Separate from `model` on purpose: `model` is what the user selected
   * and is never changed on their behalf, while this is the thing the
   * picker can offer as "known working" when the selected model turns out
   * to be unusable.
   */
  lastWorkingModel?: string;
}

export interface AIResponse {
  content: string;
  suggestedCode?: string;
  diffExplanation?: string;
  /**
   * A structured failure, when this response is a failure.
   *
   * The distinction that matters: `content` is what a language model said
   * and is treated as model output — reasoned over, put in a timeline,
   * shown to a user as the model's words. Provider error text does not
   * belong in any of those. An error belongs here, where it can carry a
   * message written to be shown to a person and cannot be mistaken for the
   * model's opinion.
   */
  error?: AIProviderError;
}

/**
 * What went wrong, named precisely.
 *
 * The distinction the UI acts on: a credential problem is fixed in
 * settings, a model problem is fixed in the picker, and neither is fixed
 * by retyping the same request.
 */
export type AIProviderErrorCode =
  /** No key configured at all. Never reaches the network. */
  | 'KEY_REQUIRED'
  /** 401. The key was not accepted. */
  | 'INVALID_KEY'
  /** 403. The key is real but not allowed to do this. */
  | 'UNAUTHORIZED'
  /** 402. The account cannot pay for it. */
  | 'OUT_OF_CREDITS'
  /** 429. Too much, too fast. */
  | 'RATE_LIMITED'
  /** 404 naming the model: the model does not exist. */
  | 'MODEL_NOT_FOUND'
  /** 404/503 naming availability: no provider for this model right now. */
  | 'MODEL_UNAVAILABLE'
  /** 404 with nothing model-shaped in it: the request path itself is wrong. */
  | 'ENDPOINT_NOT_FOUND'
  /** 400/422. The request was not accepted as written. */
  | 'BAD_REQUEST'
  /** 5xx. OpenRouter or the provider behind it. */
  | 'PROVIDER_ERROR'
  /** The request never got an answer. */
  | 'NETWORK_ERROR'
  /** A 200 with nothing usable in it. */
  | 'EMPTY_RESPONSE'
  /** Status and body both failed to identify anything. */
  | 'UNKNOWN';

export interface AIProviderError {
  code: AIProviderErrorCode;
  /** Written to be shown to a user. Contains no provider payload. */
  message: string;
  /** The HTTP status, when there was one. Never the response body. */
  status?: number;
}

export interface AIChatContext {
  currentCode?: string;
  symbol?: string;
  timeframe?: string;
  model?: string;
  /**
   * Replaces the built-in prompt. Used by the in-app copilot, which needs
   * product guidance rather than the agent runtime's trading-decision
   * prompt. Omitted, the agent prompt is used.
   */
  systemPrompt?: string;
  /**
   * Read-only application context, appended after the system prompt.
   * Produced by `services/aiContext`; never contains credentials.
   */
  contextPrefix?: string;
}

export interface IAIProvider {
  chat(messages: AIMessage[], context?: AIChatContext): Promise<AIResponse>;
}

/** One model as the catalogue describes it, normalised for the picker. */
export interface OpenRouterModel {
  /** The provider-side id. Used for requests; never the primary label. */
  id: string;
  /** The human-readable name OpenRouter publishes. */
  name: string;
  /** The organisation prefix, prettified: "OpenAI", "NVIDIA", "Anthropic". */
  provider: string;
  contextLength: number;
  /** USD per million prompt / completion tokens. */
  promptPerMillion: number;
  completionPerMillion: number;
  isFree: boolean;
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  /** One line of the publisher's own description, when there is one. */
  description?: string;
}

export interface ModelCatalogue {
  models: OpenRouterModel[];
  /** Where the list came from, so the UI can be honest about it. */
  source: 'api' | 'cache' | 'fallback';
  /** Set when the API could not be reached and the fallback is in use. */
  error?: AIProviderError;
  /** When the catalogue was fetched, for the cache header. */
  fetchedAt: number;
}
