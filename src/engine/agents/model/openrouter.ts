import { IAgentModel, AgentModelRequest, AgentModelResponse } from './types';
import { openRouterProvider } from '../../../adapters/openrouter/provider';
import { AIMessage } from '../../../adapters/openrouter/types';

export class OpenRouterAgentModel implements IAgentModel {
  async run(request: AgentModelRequest): Promise<AgentModelResponse> {
    const config = openRouterProvider.getConfig();
    const hasApiKey = Boolean(
      config.apiKey &&
      config.apiKey.trim().length > 10 &&
      config.model.trim().length > 0,
    );

    if (!hasApiKey) {
      return this.runWithoutLLM(request);
    }

    return this.runWithLLM(request);
  }

  private async runWithLLM(
    request: AgentModelRequest,
  ): Promise<AgentModelResponse> {
    const deployedSymbol =
      request.agent.symbols[0] ||
      request.observation.market.quote?.symbol;

    const systemPrompt = `You are a Trading Agent named "${request.agent.name}" operating within the TradingVibe Trading Agent Infrastructure.

You analyze the deployed market using the available observations, skills, and capabilities. You must respect every system-enforced policy.

You do not place orders directly. You return a structured decision, which TradingVibe validates through its policy and risk engines before execution.

### Hard Policies — System Enforced

- Max Risk Per Trade: ${(request.agent.policy.maxRiskPerTrade * 100).toFixed(1)}%
- Max Open Positions: ${request.agent.policy.maxOpenPositions}
- Max Exposure: ${request.agent.policy.maxExposure} instrument units
- Max Orders Per Minute: ${request.agent.policy.maxOrdersPerMinute}
- Max Daily Loss: ${request.agent.policy.maxDailyLoss ?? 'not specified'}
- Allowed Symbols: [${request.agent.policy.allowedSymbols.join(', ')}]
- Trading Allowed: ${request.agent.policy.allowTrading}

These policies cannot be overridden by your instructions or reasoning.

### Deployed Market

${deployedSymbol ? `Current deployed symbol: ${deployedSymbol}` : 'The deployed symbol is provided in the current observation.'}

The bot definition is asset-agnostic. Do not assume EURUSD, Forex, Commodities, or Indices unless the current observation identifies that instrument.

### Core Instructions

${request.instructions}

### Assigned Skills

${request.skillsInstructions}

### Available Capabilities

${JSON.stringify(
  request.capabilitySchemas || request.observation.availableCapabilities,
)}

### Trading Decision Requirements

Before opening a position:

1. Evaluate the current market conditions.
2. Use relevant available skills/capabilities when necessary.
3. Respect the deployed symbol.
4. Respect the risk and execution policies.
5. Provide a protective stop loss.
6. Express volume in instrument units, not lots.
7. Use valid price levels for the deployed instrument.
8. Pips, lots, and standard-lot sizing apply to Forex instruments only. For a commodity or index, use instrument units and raw price distances.
9. Do not invent market data, prices, or fees.
10. If the setup is insufficient, return WAIT.

### Output Format

You MUST respond with valid JSON matching exactly one of these structures.

Tool/capability request:

{
  "thought": "Why this capability is needed.",
  "toolCall": {
    "capability": "capability.id",
    "input": {}
  }
}

Final decision:

{
  "thought": "Concise market and risk assessment.",
  "decision": {
    "type": "WAIT",
    "reason": "Why no trade should be taken."
  }
}

Or:

{
  "thought": "Concise market and risk assessment.",
  "decision": {
    "type": "OPEN_POSITION",
    "symbol": "deployed symbol",
    "side": "BUY",
    "volume": 10000,
    "stopLoss": 0,
    "takeProfit": 0,
    "reason": "Specific technical rationale."
  }
}

For OPEN_POSITION:
- "symbol" must be the deployed symbol.
- "side" must be BUY or SELL.
- "volume" must be a positive number expressed in instrument units.
- "stopLoss" must be a valid protective price level.
- "takeProfit" is optional.
- Never invent a symbol or use an unrelated example instrument.
`;

    const userContent = JSON.stringify(
      {
        currentObservation: {
          timestamp: request.observation.timestamp,
          environment: request.observation.environment,
          market: request.observation.market,
          quote: request.observation.market.quote,
          account: request.observation.account,
          positions: request.observation.positions,
          orders: request.observation.orders,
          session: request.observation.market.session,
          memories: request.observation.recentMemories,
        },
        toolHistory: request.toolHistory,
        iteration: request.iteration,
      },
      null,
      2,
    );

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userContent,
      },
    ];

    try {
      const response = await openRouterProvider.chat(messages, {
        symbol: deployedSymbol,
        timeframe: request.agent.timeframe,
        model: request.agent.ai?.model,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed: unknown = JSON.parse(jsonMatch[0]);

        if (
          isRecord(parsed) &&
          (isToolCall(parsed.toolCall) || isRecord(parsed.decision))
        ) {
          return {
            thought:
              typeof parsed.thought === 'string'
                ? parsed.thought
                : 'Analysis complete.',
            toolCall: isToolCall(parsed.toolCall)
              ? parsed.toolCall
              : undefined,
            decision: isRecord(parsed.decision)
              ? (parsed.decision as AgentModelResponse['decision'])
              : undefined,
          };
        }
      }

      return {
        thought: response.content,
        decision: {
          type: 'WAIT',
          reason: 'The model response did not contain a valid TradingVibe decision.',
        },
      };
    } catch (error) {
      return {
        thought: 'OpenRouter execution failed.',
        decision: {
          type: 'WAIT',
          reason:
            error instanceof Error
              ? `OpenRouter request failed: ${error.message}`
              : 'OpenRouter request failed.',
        },
      };
    }
  }

  /**
   * No fake market reasoning is performed without an OpenRouter API key.
   *
   * The UI should detect the missing key and prompt the user to connect
   * their own OpenRouter account/key before attempting AI trading.
   */
  private runWithoutLLM(
    _request: AgentModelRequest,
  ): AgentModelResponse {
    return {
      thought: 'No OpenRouter API key is configured.',
      decision: {
        type: 'WAIT',
        reason: 'Connect an OpenRouter API key to enable AI agent reasoning.',
      },
    };
  }
}

export const agentModel: IAgentModel = new OpenRouterAgentModel();

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isToolCall(
  value: unknown,
): value is {
  capability: string;
  input: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    typeof value.capability === 'string' &&
    isRecord(value.input)
  );
}