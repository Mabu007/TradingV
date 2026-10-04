/**
 * The agent tool layer.
 *
 * These are the tools GOAT reasons *through*. They are ordinary
 * capabilities, registered into the existing `CapabilityRegistry`, which
 * means they inherit everything that registry already enforces: input
 * schema validation, symbol scope validation, the agent's granted
 * allowlist, and the audit record of every call.
 *
 * The separation that matters is between what the model may *ask* and
 * what the runtime will *do*. The model emits a tool call naming one of
 * these. The registry decides whether the agent is allowed to make it.
 * There is no path from a model response to application state that does
 * not go through this file and the checks above it.
 */

import {
  AgentCapability,
  AgentPolicy,
  CapabilityContext,
  ITradingEnvironment,
  TradingAgent,
} from '../agents/types';
import { AgentObservation, AgentWakeEvent } from '../agents/types';
import { AgentPlan, Goal, Thesis, TrackerEvent } from './types';
import { GoatLoop } from './loop';
import { GoatSkillRegistry } from './skills';

/**
 * What a tool call is allowed to reach.
 *
 * Narrow on purpose. A tool gets the thesis and evidence stores and the
 * loop's mutation helpers — not the environment, not the policy, not
 * the agent registry. The tracker SDK is reachable through capabilities
 * like any other tool, so adding tracker authority here would create a
 * second, unpermissioned route to it.
 */
export interface AgentToolContext extends CapabilityContext {
  thesisStore: { get(id: string): Thesis | undefined; listForGoal(goalId: string): Thesis[] };
  evidenceStore: {
    listForThesis(thesisId: string): Array<{
      id: string;
      polarity: 'SUPPORTS' | 'CONTRADICTS';
      summary: string;
      source: string;
      createdAt: number;
    }>;
  };
  goalStore: { get(id: string): Goal | undefined; getForAgent(agentId: string): Goal | undefined };
  trackerStore: {
    listForThesis(thesisId: string): Array<{ id: string; purpose: string; status: string; eventCount: number }>;
  };
  loop: GoatLoop;
}

/**
 * The thesis an agent is working on, from the context.
 *
 * A tool that takes an explicit thesis id is the norm; this is the
 * fallback for tools that operate on "the current" thesis, and it
 * refuses rather than guessing when there is more than one.
 */
function resolveThesis(
  context: AgentToolContext,
  thesisId: string | undefined,
): Thesis | undefined {
  if (thesisId) return context.thesisStore.get(thesisId);
  const goal = context.goalStore.getForAgent(context.agentId);
  if (!goal) return undefined;
  const live = context.thesisStore
    .listForGoal(goal.id)
    .filter((thesis) => thesis.state !== 'INVALIDATED' && thesis.state !== 'ABANDONED');
  return live.length === 1 ? live[0] : undefined;
}

export const AGENT_TOOL_IDS = {
  readThesis: 'thesis.read',
  updateThesis: 'thesis.update',
  readEvidence: 'evidence.read',
  proposeIdea: 'trades.proposeIdea',
} as const;

/*
 * Deliberately no `readTrackers` tool here.
 *
 * Listing trackers is `READ_TRACKERS`, which the Tracker SDK already
 * provides. Registering a second capability under a different name that
 * does the same thing would mean two permission checks for one
 * authority, and the two could disagree about who is allowed to see it.
 * The tool set owns the agent's mind; the SDK owns what it watches.
 */

/**
 * Build the thesis, evidence and decision tools, bound to a loop.
 *
 * Returned as capabilities rather than a bare object so the runtime's
 * existing permission model applies unchanged: an agent can only call
 * `thesis.update` if a skill granted it and its definition asked for
 * `manageThesis`.
 */
export function buildAgentTools(deps: { loop: GoatLoop }): AgentCapability[] {
  const thesisRead: AgentCapability = {
    id: AGENT_TOOL_IDS.readThesis,
    name: 'Read Thesis',
    description:
      'Read the current hypothesis, what it is waiting to be confirmed by, and the level at which it is wrong.',
    category: 'structure',
    inputSchema: { thesisId: { type: 'string' } },
    outputSchema: { thesis: { type: 'object' } as unknown as Record<string, unknown> },
    execute: async (input: unknown, context: CapabilityContext) => {
      const tool = context as AgentToolContext;
      const thesis = resolveThesis(tool, (input as { thesisId?: string }).thesisId);
      if (!thesis) {
        return { error: 'No single thesis is in play. Pass thesisId explicitly.' };
      }
      const watching = tool.trackerStore.listForThesis(thesis.id);
      return {
        thesis: {
          id: thesis.id,
          statement: thesis.statement,
          direction: thesis.direction,
          state: thesis.state,
          confidence: thesis.confidence,
          requiredConfirmation: thesis.requiredConfirmation,
          invalidation: thesis.invalidation,
          revision: thesis.revision,
        },
        watching: watching.map((tracker) => ({
          id: tracker.id,
          purpose: tracker.purpose,
          status: tracker.status,
          observed: tracker.eventCount,
        })),
      };
    },
  };

  const thesisUpdate: AgentCapability = {
    id: AGENT_TOOL_IDS.updateThesis,
    name: 'Update Thesis',
    description:
      'Move a thesis to a new state, or restate it. Use INVALIDE only when the hypothesis is disproven, not when it is merely under pressure.',
    category: 'structure',
    inputSchema: {
      thesisId: { type: 'string' },
      state: { type: 'string' },
      statement: { type: 'string' },
      invalidation: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', required: true },
    },
    outputSchema: { thesisId: { type: 'string' }, state: { type: 'string' } },
    execute: async (input: unknown, context: CapabilityContext) => {
      const tool = context as AgentToolContext;
      const request = input as {
        thesisId?: string;
        state?: Thesis['state'];
        statement?: string;
        invalidation?: string;
        confidence?: number;
      };
      const thesis = resolveThesis(tool, request.thesisId);
      if (!thesis) {
        return { error: 'No single thesis is in play. Pass thesisId explicitly.' };
      }
      try {
        /*
         * Transitions go through the loop, not around it, so the state
         * machine and the evidence gates apply to a tool call exactly
         * as they do to a wake.
         */
        const updated = tool.loop.reviseThesis(thesis.id, {
          state: request.state,
          statement: request.statement,
          invalidation: request.invalidation,
          confidence: request.confidence,
        });
        return { thesisId: updated.id, state: updated.state, revision: updated.revision };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const evidenceRead: AgentCapability = {
    id: AGENT_TOOL_IDS.readEvidence,
    name: 'Read Evidence',
    description:
      'Read everything gathered for or against a thesis, including what contradicts it. Contradicting evidence is the reason this exists.',
    category: 'structure',
    inputSchema: { thesisId: { type: 'string' } },
    outputSchema: { supporting: { type: 'array' } as unknown as Record<string, unknown>, contradicting: { type: 'array' } as unknown as Record<string, unknown> },
    execute: async (input: unknown, context: CapabilityContext) => {
      const tool = context as AgentToolContext;
      const thesis = resolveThesis(tool, (input as { thesisId?: string }).thesisId);
      if (!thesis) {
        return { error: 'No single thesis is in play. Pass thesisId explicitly.' };
      }
      const all = tool.evidenceStore.listForThesis(thesis.id);
      return {
        supporting: all.filter((item) => item.polarity === 'SUPPORTS'),
        contradicting: all.filter((item) => item.polarity === 'CONTRADICTS'),
        counts: {
          supporting: all.filter((i) => i.polarity === 'SUPPORTS').length,
          contradicting: all.filter((i) => i.polarity === 'CONTRADICTS').length,
        },
      };
    },
  };

  const proposeIdea: AgentCapability = {
    id: AGENT_TOOL_IDS.proposeIdea,
    name: 'Propose Trade Idea',
    description:
      'Construct a structured trade idea from an actionable thesis, with an explicit level at which it is wrong. This proposes; it does not place an order.',
    category: 'structure',
    inputSchema: {
      thesisId: { type: 'string', required: true },
      symbol: { type: 'string', required: true },
      direction: { type: 'string', required: true },
      orderType: { type: 'string', required: true },
      entry: { type: 'number', required: true },
      invalidationLevel: { type: 'number', required: true },
      takeProfits: { type: 'array' } as unknown as Record<string, unknown>,
      reasoning: { type: 'string', required: true },
    },
    outputSchema: { tradeIdeaId: { type: 'string' }, status: { type: 'string' } },
    execute: async (input: unknown, context: CapabilityContext) => {
      const tool = context as AgentToolContext;
      const request = input as {
        thesisId: string;
        symbol: string;
        direction: 'LONG' | 'SHORT';
        orderType: 'MARKET' | 'LIMIT' | 'STOP';
        entry: number;
        invalidationLevel: number;
        takeProfits: Array<{ price: number; fraction: number }>;
        reasoning: string;
      };

      /*
       * Constructing an idea is a *reasoning* outcome and needs no
       * execution permission. What it does need is a thesis that has
       * earned the right to be actionable, which the loop enforces
       * against the goal's active skills.
       */
      const wake: {
        thesisId: string;
        goalId: string;
        agentId: string;
        event: TrackerEvent;
        thesis: Thesis;
        relatedEvents: TrackerEvent[];
        skillIds: string[];
        createdAt: number;
      } | undefined = (() => {
        const thesis = tool.thesisStore.get(request.thesisId);
        if (!thesis) return undefined;
        return {
          thesisId: thesis.id,
          goalId: thesis.goalId,
          agentId: thesis.agentId,
          event: {
            id: `synthetic_${thesis.id}`,
            trackerId: '',
            agentId: thesis.agentId,
            kind: 'CUSTOM',
            eventType: 'CUSTOM',
            timestamp: Date.now(),
            environment: 'DEMO',
            reason: 'Agent proposed a trade idea directly.',
            priority: 0,
            severity: 'INFO',
          },
          thesis,
          relatedEvents: [],
          skillIds: tool.goalStore.get(thesis.goalId)?.skillIds ?? [],
          createdAt: Date.now(),
        };
      })();

      if (!wake) return { error: `Unknown thesis ${request.thesisId}.` };

      const outcome = tool.loop.applyPlan(wake as never, {
        kind: 'PROPOSE_TRADE_IDEA',
        thesisId: request.thesisId,
        reason: request.reasoning,
        idea: {
          symbol: request.symbol,
          direction: request.direction,
          orderType: request.orderType,
          entry: request.entry,
          invalidationLevel: request.invalidationLevel,
          takeProfits: request.takeProfits ?? [],
          reasoning: request.reasoning,
        },
      });

      return {
        tradeIdeaId: outcome.tradeIdeaId,
        status: outcome.tradeIdeaId ? 'PROPOSED' : 'REJECTED',
        rejections: outcome.rejections,
      };
    },
  };

  return [thesisRead, thesisUpdate, evidenceRead, proposeIdea];
}

export function registerAgentTools(
  loop: GoatLoop,
  registry: { register(capability: AgentCapability): void; has(id: string): boolean },
): void {
  for (const capability of buildAgentTools({ loop })) {
    if (!registry.has(capability.id)) registry.register(capability);
  }
}

/**
 * Guidance describing the tool set, injected where the agent reasons.
 *
 * Shipped with the tools rather than left implicit: an agent that
 * cannot see what it can do will not do it.
 */
export const AGENT_TOOL_GUIDE = `
### Your tools

You reason through tools. You do not read application state directly
and you cannot mutate anything except by calling a tool.

- ${AGENT_TOOL_IDS.readThesis} — what you currently believe, what would
  confirm it, and the level at which it is wrong
- ${AGENT_TOOL_IDS.updateThesis} — move a thesis on, or restate it
- ${AGENT_TOOL_IDS.readEvidence} — everything gathered for and against a
  thesis, including what contradicts it
- CREATE_TRACKER / UPDATE_TRACKER / REMOVE_TRACKER / READ_TRACKERS —
  decide what to watch
- ${AGENT_TOOL_IDS.proposeIdea} — construct a trade idea, once a thesis is
  actionable

Read the thesis before you judge it. Read the contradicting evidence
before you strengthen it. A tool that returns an \`error\` is telling you
something went wrong — read it, do not retry the same call unchanged.
`.trim();
