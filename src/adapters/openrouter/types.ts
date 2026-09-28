export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIProviderConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
}

export interface AIResponse {
  content: string;
  suggestedCode?: string;
  diffExplanation?: string;
}

export interface IAIProvider {
  chat(messages: AIMessage[], context?: { currentCode?: string; symbol?: string; timeframe?: string; model?: string }): Promise<AIResponse>;
}
