import {
  IAgentModel,
  AgentModelRequest,
  AgentModelResponse,
  AgentResponseContract,
} from './types';
import { openRouterProvider } from '../../../adapters/openrouter/provider';
import type { AIProviderErrorCode } from '../../../adapters/openrouter/types';
import { AIMessage } from '../../../adapters/openrouter/types';
import { describeModelWritableTrackers } from '../trackers/contracts';

/**
 * What the agent says when it could not be consulted, per cause.
 *
 * The reason a GOAT has no thesis is shown to the person who wrote the
 * goal, so it has to name the actual problem. "The reasoning model is
 * unavailable" sends someone to debug a model; "connect your OpenRouter
 * key" sends them to the one button that fixes it.
 */
const UNAVAILABLE: Record<AIProviderErrorCode, string> = {
  KEY_REQUIRED:
    'This GOAT needs your own OpenRouter API key before it can reason. Add one in Settings, then try again.',
  INVALID_KEY:
    'OpenRouter rejected your API key, so this GOAT could not reason. Check the key in Settings.',
  UNAUTHORIZED:
    'Your OpenRouter key is not allowed to use this GOAT\'s model. Check the key, or choose another model.',
  OUT_OF_CREDITS:
    'Your OpenRouter account has no credit left, so this GOAT could not reason.',
  RATE_LIMITED:
    'OpenRouter is rate-limiting this model right now. Try again shortly, or choose another model.',
  MODEL_NOT_FOUND:
    'The model this GOAT was set to use no longer exists on OpenRouter. Choose another model in Settings.',
  MODEL_UNAVAILABLE:
    'The model this GOAT was set to use has no provider available right now. Choose another model in Settings.',
  ENDPOINT_NOT_FOUND:
    'TradingGOATs could not reach the OpenRouter chat endpoint, so this GOAT could not reason.',
  BAD_REQUEST:
    'OpenRouter would not accept this GOAT\'s request. Try another model in Settings.',
  PROVIDER_ERROR:
    'OpenRouter or its provider is having trouble, so this GOAT could not reason. Try again shortly.',
  NETWORK_ERROR:
    'TradingGOATs could not reach OpenRouter, so this GOAT could not reason. Check your connection.',
  EMPTY_RESPONSE: 'The model returned nothing, so this GOAT could not reason. Try again.',
  UNKNOWN: 'This GOAT could not reach its reasoning model. Try again.',
};

/**
 * The one response schema per phase.
 *
 * Every one of these is a complete answer on its own, and none of them
 * mentions another. The previous prompt described the decision schema and
 * then, forty lines later, described a *different* decision schema while
 * the caller was asking for a thesis — so a model that read carefully
 * followed the wrong one and was reported as having no opinion.
 */
const CONTRACTS: Record<AgentResponseContract, string> = {
  DECISION: `### Response format

Answer with one JSON object and nothing else. No prose before or after it, no markdown fence.

{
  "thought": "Concise market and risk assessment.",
  "decision": {
    "type": "WAIT",
    "reason": "Why no trade should be taken."
  }
}

"decision.type" is one of WAIT, ANALYZE, OPEN_POSITION, MODIFY_POSITION, CLOSE_POSITION.

For OPEN_POSITION, "decision" must also carry:
  "symbol"   the deployed symbol, unchanged
  "side"     BUY or SELL
  "volume"   a positive number in instrument units
  "stopLoss" a concrete protective price level

To ask for more information instead of deciding, answer with:
{
  "thought": "Why this capability is needed.",
  "toolCall": { "capability": "capability.id", "input": {} }
}`,

  INVESTIGATION: `### Response format

Answer with one JSON object and nothing else. No prose before or after it, no markdown fence.

{
  "thought": "one paragraph on what you see and why",
  "thesis": {
    "statement": "the specific, testable claim you are investigating",
    "direction": "BULLISH | BEARISH | NEUTRAL",
    "invalidation": "the condition that proves this wrong",
    "requiredConfirmation": ["what would have to be true for this to be worth acting on"]
  },
  "trackers": [
    {
      "purpose": "the specific evidence you are waiting for, in one sentence",
      "kind": "NEW_BAR",
      "timeframe": "1m | 5m | 15m | 1h | 4h | 1d",
      "config": {},
      "priority": 1,
      "cooldownMs": 900000
    }
  ]
}

Every tracker needs a \`config\` that satisfies the contract below exactly. A
tracker whose config is wrong is refused, and a GOAT whose trackers are all
refused has no way to wake.

${describeModelWritableTrackers()}

If a thesis level is needed and you were not given a number, use NEW_BAR: it
needs no number and is never refused.

This object replaces any trading-decision format entirely. Do not answer with a decision instead.`,

  PLAN: `### Response format

Answer with one JSON object and nothing else. No prose before or after it, no markdown fence.

{
  "kind": "WAIT | CONFIRM_THESIS | WEAKEN_THESIS | INVALIDATE_THESIS | REVISE_THESIS | CREATE_TRACKER | REMOVE_TRACKER | PROPOSE_TRADE_IDEA",
  "reason": "one sentence on why",
  "thesisId": "the thesis this acts on"
}

REVISE_THESIS also carries "statement", "invalidation" and "confidence".
CREATE_TRACKER also carries "spec": { "purpose", "kind", "timeframe", "config" }.
REMOVE_TRACKER also carries "trackerId".
PROPOSE_TRADE_IDEA also carries "idea": { "symbol", "direction", "orderType",
"entry", "invalidationLevel", "takeProfits": [{ "price", "fraction" }], "reasoning" }.

This object replaces any trading-decision format entirely. Do not answer with a decision instead.`,

  INTERPRETATION: `### Response format

Answer with one JSON object and nothing else. No prose before or after it, no markdown fence.

{
  "understood": "your reading of the objective, in your own words",
  "symbols": [],
  "timeframes": [],
  "investigationPlan": ["what you will examine first"],
  "openQuestions": ["anything about the objective you cannot resolve"],
  "actionable": true
}

This object replaces any trading-decision format entirely. Do not answer with a decision instead.`,
};

/**
 * The part of the prompt that is the same whatever is being asked.
 *
 * The two permission blocks are separate on purpose and are described in
 * those words. A SHADOW deployment cannot place an order, and that has
 * nothing to do with whether it may read the market, form a thesis, or
 * decide what to watch — and when the two were reported as one "Trading
 * Allowed: false" line next to the deployed symbol, models read it as "you
 * may not investigate this market" and declined to. Research is always
 * permitted on a deployed market; only submission is gated.
 */
function commonPrompt(request: AgentModelRequest, deployedSymbol: string | undefined): string {
  const { policy } = request.agent;

  /*
   * The objective, verbatim.
   *
   * A GOAT's objective lives on `agent.description`, and it used to be
   * dropped here: the model was shown a market, a policy and a tool list,
   * and asked what it believed — with no idea what it was trying to
   * accomplish. It inferred one, and its inference ("the user has not yet
   * specified a concrete trading objective") was then recorded as the GOAT's
   * understanding of the user's own words. Anything an agent reasons
   * towards has to be stated first.
   */
  const objective = (request.objective ?? request.agent.description ?? '').trim();

  return `You are a Trading Agent named "${request.agent.name}" operating within the TradingGOATs Trading Agent Infrastructure.

You do not place orders directly. You return a structured decision, which TradingGOATs validates through its policy and risk engines before any execution.

### The objective you are pursuing

${objective || '(none supplied — say so rather than inventing one)'}

This is what the user asked for, in their own words. It is deliberately broad. Working out what to investigate, what to hypothesise, what evidence would confirm or refute it, and what to watch for in the meantime is your job, not theirs. Do not answer that the objective is unspecified, and do not ask for it to be rewritten into a strategy.

### What you are doing right now

${request.instructions}

### Your skills

${request.skillsInstructions || '(no skills attached beyond the GOAT baseline)'}

### Available capabilities

${JSON.stringify(request.capabilitySchemas || request.observation.availableCapabilities)}

You reason through tools rather than reading application state directly, and you cannot mutate anything except by calling a tool. A tool that returns an \`error\` is telling you something went wrong — read it, do not retry the same call unchanged.

### Research permission — granted

You are deployed, and reading this market is exactly what you are here to do. You may fetch quotes, candles, indicators and market structure; you may form and revise a hypothesis; you may decide what evidence you need and deploy trackers to watch for it; you may write a trade plan.

This is granted even when the deployment below cannot submit anything. "Cannot execute" is about orders, not about analysis.

### Execution permission

- Market you are deployed on: ${deployedSymbol ?? 'the symbol in the observation below'}
- Trading allowed (order submission): ${policy.allowTrading}
- Allowed symbols for orders: [${policy.allowedSymbols.join(', ')}]
- Allowed order types: [${(policy.allowedOrderTypes ?? []).join(', ') || 'none'}]
- Max risk per trade: ${(policy.maxRiskPerTrade * 100).toFixed(1)}%
- Max open positions: ${policy.maxOpenPositions}
- Max exposure: ${policy.maxExposure} instrument units
- Max orders per minute: ${policy.maxOrdersPerMinute}
- Max daily loss: ${policy.maxDailyLoss ?? 'not specified'}

If order submission is not allowed, that only means a trade plan you write will be simulated or refused. It is never a reason to decline to investigate, and it is never a reason to answer that you cannot see the market.

### Rules

1. Reason only from values supplied in the observation below. Never invent a price, candle, indicator value, level or volume. If you need a number you were not given, ask for it with a tool or say what is missing.
2. Use the deployed symbol exactly as given. Do not assume an asset class it was not identified as.
3. A thesis is a hypothesis, not a trade. It may be wrong. State the condition that would prove it wrong.
4. You do not poll. You deploy trackers for what you need to observe, then stop. A tracker waking you is a fact, not a signal: decide for yourself what it means.
5. Do not claim an order was executed. The runtime performs execution and reports the result separately.
6. You have no access to signing credentials or exchange credentials.

${CONTRACTS[request.contract ?? 'DECISION']}`;
}

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

    /*
     * One system message, built from the phase's contract, and sent as the
     * `systemPrompt` of the provider context rather than as a message of
     * our own. The provider prepends `systemPrompt + runtime context` as
     * message zero; adding a second one duplicated the whole prompt and
     * doubled the token bill.
     */
    const systemPrompt = commonPrompt(request, deployedSymbol);

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
        wakeReason: request.wakeReason,
      },
      null,
      2,
    );

    const messages: AIMessage[] = [
      {
        role: 'user',
        content: userContent,
      },
    ];

    try {
      const response = await openRouterProvider.chat(messages, {
        /*
         * Passed explicitly, and this is load-bearing rather than
         * cosmetic. Without it the provider falls back to its own
         * `SYSTEM_PROMPT`, which is a *decision* contract — WAIT /
         * ANALYZE / OPEN_POSITION — and prepends it as a second system
         * message in front of this one. A model asked for a thesis and
         * handed two system prompts, one of them demanding a decision,
         * followed the stronger instruction and returned a WAIT. Every
         * downstream parser then reported "no hypothesis".
         */
        systemPrompt,
        symbol: deployedSymbol,
        timeframe: request.agent.timeframe,
        model: request.agent.ai?.model,
      });

      if (response.error) {
        return {
          thought: 'OpenRouter was not consulted.',
          decision: {
            type: 'WAIT',
            /*
             * A fixed reason. The provider message belongs in a log and in
             * a UI panel written for the user; `reason` is recorded in the
             * timeline and read back as though the agent had thought it.
             */
            reason: 'The reasoning model was unavailable.',
          },
          unavailable: {
            code: response.error.code,
            message: UNAVAILABLE[response.error.code] ?? UNAVAILABLE.UNKNOWN,
          },
        };
      }

      return normalizeModelReply(response.content);
    } catch {
      /*
       * The reason is a fixed string. A provider message belongs in a log
       * with redaction, not in an agent's reasoning: `reason` is recorded
       * in the timeline and is read back as though the agent had thought
       * it, so anything pasted in here becomes the agent's own account of
       * why it did nothing.
       */
      return {
        thought: 'OpenRouter execution failed.',
        decision: {
          type: 'WAIT',
          reason: 'OpenRouter request failed.',
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
      unavailable: { code: 'KEY_REQUIRED', message: UNAVAILABLE.KEY_REQUIRED },
    };
  }
}

/**
 * Turn raw model text into the canonical response.
 *
 * This is the whole of the AI boundary, and it is deliberately the only
 * place that knows a model might wrap its JSON in a fence, in prose, or in
 * both, or might answer a decision when a thesis was requested. Everything
 * downstream receives `payload` and never re-parses provider output.
 *
 * Three outcomes, and they are different facts:
 *
 *   - `payload` present    the model answered in a shape we can read
 *   - `malformed`          it tried to answer in JSON and failed; retryable
 *   - neither              it answered in prose; the caller's problem
 */
export function normalizeModelReply(content: string): AgentModelResponse {
  const text = content.trim();
  const parsed = extractJsonObject(text);

  if (parsed.kind === 'malformed') {
    return {
      thought: text,
      malformed: true,
      decision: { type: 'WAIT', reason: 'The model response could not be parsed.' },
    };
  }

  if (parsed.kind === 'none') {
    return {
      thought: text,
      decision: { type: 'WAIT', reason: 'The model response did not contain a JSON object.' },
    };
  }

  const payload = parsed.value;

  return {
    /*
     * `thought` is the model's own prose, and `payload` is everything it
     * said. Previously a response carrying a `decision` had its payload
     * reduced to the `thought` string and the rest discarded, so a caller
     * looking for a thesis found nothing in a reply that had contained one.
     */
    thought: typeof payload.thought === 'string' ? payload.thought : text,
    payload,
    ...(isToolCall(payload.toolCall) ? { toolCall: payload.toolCall } : {}),
    ...(isRecord(payload.decision)
      ? { decision: payload.decision as AgentModelResponse['decision'] }
      : {}),
  };
}

type Extracted =
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'malformed' }
  | { kind: 'none' };

/**
 * Pull one JSON object out of whatever the model wrapped it in.
 *
 * Brace-balanced rather than greedy, because a greedy `\{[\s\S]*\}` matches
 * from the first brace to the *last* one in the response: a model that
 * wrote a fenced example after its answer produced
 * `{answer}{your example}`, which is not JSON and is discarded.
 */
function extractJsonObject(text: string): Extracted {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const balanced = firstBalancedObject(candidate);
    if (balanced === undefined) continue;

    try {
      const value: unknown = JSON.parse(balanced);
      if (isRecord(value)) return { kind: 'ok', value };
      // A JSON array is valid JSON and still not what was asked for.
      return { kind: 'malformed' };
    } catch {
      // It looked like an object and would not parse. Keep looking: a model
      // that printed a broken template before the real answer should still
      // be understood.
      continue;
    }
  }

  /*
   * Nothing parsed. Distinguish "there was JSON here and it was broken"
   * from "there was never any JSON", because only one of those is a
   * transport problem worth retrying.
   */
  return /[[{]/.test(text) ? { kind: 'malformed' } : { kind: 'none' };
}

/** The first brace-balanced `{...}` in a string, skipping braces in strings. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  /*
   * A leading `[` means the model wrapped its answer in an array. Digging
   * the first object out of it would be a guess about what it meant, and a
   * guess here is how a wrong thesis gets stored as a right one.
   */
  const before = text.slice(0, start).trim();
  if (before.endsWith('[')) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
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
