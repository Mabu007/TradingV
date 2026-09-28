import { AIMessage, AIProviderConfig, AIResponse, IAIProvider } from './types';

const STORAGE_KEY = 'tradingvibe_openrouter_config';

export const POPULAR_MODELS = [
  {
    id: 'inclusionai/ling-3.0-flash-fin:free',
    name: 'Ling 3.0 Flash (Free)',
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
  },
  {
    id: 'openai/gpt-4o',
    name: 'OpenAI GPT-4o',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B',
  },
  {
    id: 'google/gemini-2.0-flash-001',
    name: 'Gemini 2.0 Flash',
  },
];

export const DEFAULT_AI_CONFIG: AIProviderConfig = {
  apiKey: '',
  model: 'inclusionai/ling-3.0-flash-fin:free',
  siteUrl: 'https://tradingvibe.local',
  siteName: 'TradingVibe',
};

const SYSTEM_PROMPT = `You are TradingVibe AI, an expert quantitative trading engineer and autonomous trading-agent reasoning system.

TradingVibe agents operate on deployed trading instruments selected outside the bot definition. The bot itself is asset-agnostic.

The agent may receive:
- Current market quote
- Recent completed candles
- Technical indicator results
- Market structure information
- Account state
- Open positions
- Orders
- Trigger information
- Available skills
- Available capabilities
- Previous tool results

The agent must reason only from information actually provided by the TradingVibe runtime.

IMPORTANT RULES:

1. Never invent market data, prices, candles, indicators, positions, balances, orders, or execution results.
2. Never assume a particular instrument such as EUR/USD unless that instrument is explicitly provided by the runtime.
3. Always use the deployed symbol supplied by the runtime when making a trading decision.
4. Never use placeholder market values.
5. If the available information is insufficient to make a responsible decision, return WAIT.
6. A trading decision must include a concrete stop loss.
7. Respect the bot's risk policy, capabilities, and execution policy.
8. Do not bypass risk controls.
9. Do not claim an order was executed. The TradingVibe runtime performs execution and reports the result separately.
10. The AI does not have access to signing credentials or exchange credentials.
11. Do not provide financial-advice language. You are operating as a trading-system reasoning component.
12. Prefer WAIT when evidence is ambiguous or conflicting.

AVAILABLE DECISIONS:

WAIT
Use when there is no valid trading opportunity or more information is required.

ANALYZE
Use when additional analysis through an available capability is required before deciding.

OPEN_POSITION
Use only when the available evidence supports a trade and the bot's capabilities and policies permit trading.

MODIFY_POSITION
Use when an existing position requires a stop-loss or take-profit modification.

CLOSE_POSITION
Use when an existing position should be closed.

Return a single valid JSON object matching the requested decision schema.
Do not wrap the JSON in markdown.
Do not add explanatory text outside the JSON.`;

interface OpenRouterContext {
  currentCode?: string;
  symbol?: string;
  timeframe?: string;
  model?: string;
}

export class OpenRouterProvider implements IAIProvider {
  private config: AIProviderConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig(): AIProviderConfig {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved);

        return {
          ...DEFAULT_AI_CONFIG,
          ...parsed,
        };
      }
    } catch {
      // Invalid or unavailable local storage should not prevent the app from loading.
    }

    return {
      ...DEFAULT_AI_CONFIG,
    };
  }

  saveConfig(newConfig: Partial<AIProviderConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
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
    return Boolean(
      this.config.apiKey &&
        this.config.apiKey.trim().length > 10,
    );
  }

  async chat(
    messages: AIMessage[],
    context?: OpenRouterContext,
  ): Promise<AIResponse> {
    if (!this.hasApiKey()) {
      return {
        content: 'OPENROUTER_API_KEY_REQUIRED',
      };
    }

    return this.callOpenRouter(messages, context);
  }

  private async callOpenRouter(
    messages: AIMessage[],
    context?: OpenRouterContext,
  ): Promise<AIResponse> {
    const contextPrefix = this.buildContextPrefix(context);

    const payloadMessages = [
      {
        role: 'system' as const,
        content: SYSTEM_PROMPT + contextPrefix,
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
      const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey.trim()}`,
            'HTTP-Referer':
              this.config.siteUrl || 'https://tradingvibe.local',
            'X-Title':
              this.config.siteName || 'TradingVibe',
          },
          body: JSON.stringify({
            model,
            messages: payloadMessages,
            temperature: 0.2,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `OpenRouter HTTP ${response.status}: ${errorText}`,
        );
      }

      const json = await response.json();

      const content =
        json?.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(
          'OpenRouter returned an empty response.',
        );
      }

      return {
        content: content.trim(),
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown OpenRouter error';

      console.error('OpenRouter request failed:', error);

      return {
        content: `OPENROUTER_REQUEST_FAILED:${message}`,
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

    if (context.currentCode) {
      sections.push(
        `Active strategy code:\n${context.currentCode}`,
      );
    }

    if (sections.length === 0) {
      return '';
    }

    return `\n\nTRADINGVIBE RUNTIME CONTEXT:\n${sections.join('\n')}`;
  }
}

export const openRouterProvider = new OpenRouterProvider();