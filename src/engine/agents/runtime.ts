import {
  AgentActionOutcome,
  AgentActionValidationResult,
  AgentAuditRecord,
  AgentDecision,
  AgentObservation,
  AgentWakeEvent,
  ITradingEnvironment,
  TradingAgent,
} from './types';
import {
  capabilityRegistry,
  executionShapeFor,
  CapabilityRegistry,
} from './capabilities';
import { skillRegistry, SkillRegistry } from './skills';
import { actionValidator, ActionValidator } from './policy/validator';
import { ScopedAgentMemory } from './memory/memory';
import { agentModel } from './model/openrouter';
import { IAgentModel } from './model/types';
import { eventBus } from '../../types/events';
import { Position } from '../../types/trading';
import { InstrumentMetadata } from '../../types/instruments';
import { riskManager } from '../execution/risk';
import { lookupFrom } from '../execution/valuation';
import {
  AgentTimelineEvent,
  AgentTimelineStore,
  InMemoryAgentTimelineStore,
  PersistentAgentTimelineStore,
} from './timeline';
import { GoatDefinition, GoatDeployment, compileGoatDefinition } from '../goat/definition';

export interface AgentInstance {
  agent: TradingAgent;
  env: ITradingEnvironment;
  memory: ScopedAgentMemory;
  isRunning: boolean;
  allowedCapabilities: string[];
  skillsInstructions: string;
  validator: ActionValidator;
  goatId?: string;
  deploymentId?: string;
  /**
   * The agent's right to execute, as a counter rather than a flag.
   *
   * `isRunning` says what an agent is *allowed* to be doing; it says nothing
   * about what a cycle that already started is *doing* right now. Stopping an
   * agent flips the flag, and a cycle that was mid-model-call carried on and
   * submitted its order afterwards — the flag was never consulted again. This
   * counter is what a cycle re-reads at each execution boundary: it is bumped
   * by `stop()` and by `unregisterAgent()`, so a cycle that was already
   * running cannot reach an environment call afterwards, however far through
   * the model it was.
   *
   * A number rather than an opaque token because "which generation is this
   * cycle?" has to be answerable after the fact, when reading a timeline that
   * says an order was cancelled and asking why.
   */
  executionGeneration: number;
  /**
   * The model-facing capability schemas for this agent, resolved once.
   *
   * Static for the lifetime of a registration — the allowed set is fixed at
   * `registerAgent` — so resolving them on every model iteration was paying
   * for the same object graph five times a cycle.
   */
  capabilitySchemas: Array<{
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/**
 * One reasoning cycle: one `step()`.
 *
 * Everything a cycle writes is written through this, which is what makes the
 * chain readable: the observation, the tool calls, the decision, the risk
 * verdict, the order and the position all carry the same `cycleId`, and the
 * lineage (`trackerId`, `correlationId`) it was woken under rides alongside it.
 */
interface AgentCycle {
  agentId: string;
  /** The instance this cycle started on. Identity, not id: a re-registration is a different agent. */
  instance: AgentInstance;
  cycleId: string;
  /** The generation this cycle was authorised under. */
  generation: number;
  trackerId?: string;
  correlationId: string;
  wakeEvent: AgentWakeEvent;
  /** The wake payload, once it is known to be an object. */
  wakeData?: Record<string, unknown>;
}

/**
 * Whether a cycle may still execute.
 *
 * A refusal carries its reason, because "nothing happened" and "the GOAT was
 * stopped before it acted" are different facts and a log that only records the
 * first one teaches a reader that GOATs stall for no reason.
 */
type CycleGate =
  | { live: true }
  | { live: false; reason: string };

/** One executed decision's result, in outcome terms. */
interface DecisionExecution {
  outcome: Extract<
    AgentActionOutcome,
    'NOT_ACTIONABLE' | 'REJECTED' | 'CANCELLED' | 'EXECUTED' | 'FAILED'
  >;
  result?: unknown;
  error?: string;
}

/**
 * How much tool history the model is shown in one request.
 *
 * Five iterations can produce five calls, and every one of them was resent in
 * full on every subsequent request — so a single capability returning a large
 * payload was paid for again on each round trip, and the prompt grew until the
 * provider refused it. The audit trail keeps the untruncated record; this is
 * only the model's view of it.
 */
const MAX_MODEL_TOOL_HISTORY = 12;

/** Ceiling on one capability result handed to the model, in characters. */
const MAX_MODEL_TOOL_RESULT_CHARS = 4_000;


export class AgentRuntime {
  private instances: Map<string, AgentInstance> = new Map();
  private auditLog: AgentAuditRecord[] = [];
  private maxAuditEntries: number = 200;
  private activeCycles: Set<string> = new Set();
  private timelineSequence = 0;
  private cycleSequence = 0;
  /**
   * Position-correlation listeners, held so they can be let go.
   *
   * `eventBus.on` hands back an unsubscribe function, so the subscriptions
   * made in the constructor are removable. Without this every constructed
   * runtime left a listener behind forever, so a second runtime — a test, a
   * hot reload, a reconstructed app — had two of them writing the same
   * timeline rows.
   */
  private readonly subscriptions: Array<() => void> = [];

  private readonly positionCorrelations = new Map<
    string,
    { agentId: string; trackerId?: string; correlationId: string; cycleId?: string }
  >();

  constructor(
    private capabilities: CapabilityRegistry = capabilityRegistry,
    private skills: SkillRegistry = skillRegistry,
    private validator: ActionValidator = actionValidator,
    private model: IAgentModel = agentModel,
    private timeline: AgentTimelineStore = new InMemoryAgentTimelineStore()
  ) {
    this.subscriptions.push(
      eventBus.on('POSITION_UPDATE', (event) => {
        void this.recordPositionEvent(
          event.data.id,
          'UPDATED',
          event.data
        );
      }),

      eventBus.on('POSITION_CLOSE', (event) => {
        void this.recordPositionEvent(
          event.data.position.id,
          'CLOSED',
          {
            position: event.data.position,
            tradeId: event.data.trade.id,
          }
        );
      })
    );
  }

  /**
   * Release this runtime's subscriptions to the event bus.
   *
   * Not a teardown of the runtime — the agents, the audit trail and the
   * timeline all stay readable. It only lets go of the two bus listeners, so
   * a runtime that is being replaced stops writing position rows. Idempotent,
   * because calling it twice must not make a later `start`-less reconstruction
   * fail.
   */
  dispose(): void {
    while (this.subscriptions.length > 0) {
      this.subscriptions.pop()?.();
    }
  }

  getTimelineStore(): AgentTimelineStore {
    return this.timeline;
  }

  registerAgent(
    agentDefinition: TradingAgent,
    env: ITradingEnvironment
  ): AgentInstance {
    const agent: TradingAgent = Object.freeze({
      ...agentDefinition,
      skills: Object.freeze([
        ...agentDefinition.skills,
      ]) as unknown as string[],
      capabilities: Object.freeze([
        ...agentDefinition.capabilities,
      ]) as unknown as string[],
      symbols: Object.freeze([
        ...agentDefinition.symbols,
      ]) as unknown as string[],
      policy: Object.freeze({
        ...agentDefinition.policy,
        allowedSymbols: Object.freeze([
          ...agentDefinition.policy.allowedSymbols,
        ]) as unknown as string[],
        allowedSessions: agentDefinition.policy.allowedSessions
          ? Object.freeze([
              ...agentDefinition.policy.allowedSessions,
            ]) as unknown as string[]
          : undefined,
      }),
    });

    if (env.mode === 'LIVE') {
      throw new Error(
        'Live agent execution is disabled until an explicitly confirmed production environment is implemented.'
      );
    }

    if (!agent.enabled) {
      throw new Error(`Agent ${agent.id} is disabled.`);
    }

    const skillCapabilities = this.skills.resolveCapabilities(
      agent.skills
    );

    const unknownSkills = agent.skills.filter(
      (id) => !this.skills.get(id)?.enabled
    );

    if (unknownSkills.length > 0) {
      throw new Error(
        `Agent references missing or disabled skills: ${unknownSkills.join(', ')}.`
      );
    }

    const allowedCapabilities = agent.capabilities.filter(
      (capability) =>
        skillCapabilities.includes(capability) &&
        this.capabilities.has(capability)
    );

    const unsafeAgentFields = Object.keys(
      agent as unknown as Record<string, unknown>
    ).filter((key) =>
      /secret|token|password|api.?key|credential/i.test(key)
    );

    if (unsafeAgentFields.length > 0) {
      throw new Error(
        'Agent definitions must not contain credentials or secrets.'
      );
    }

    const skillsInstructions =
      this.skills.compileInstructions(agent.skills);

    const memory = new ScopedAgentMemory();

    const validator =
      this.validator === actionValidator
        ? new ActionValidator()
        : this.validator;

    const instance: AgentInstance = {
      agent,
      env,
      memory,
      isRunning: false,
      allowedCapabilities,
      skillsInstructions,
      validator,
      goatId: agent.goatId,
      deploymentId: agent.deploymentId,
      executionGeneration: 0,
      capabilitySchemas: allowedCapabilities.flatMap((id) => {
        const capability = this.capabilities.get(id);
        return capability
          ? [
              {
                id,
                description: capability.description,
                inputSchema: capability.inputSchema,
              },
            ]
          : [];
      }),
    };

    if (
      agent.capabilities.length !==
      new Set(agent.capabilities).size
    ) {
      throw new Error(
        'Duplicate capability identifiers are not allowed.'
      );
    }

    this.instances.set(agent.id, instance);

    return instance;
  }

  /**
   * Register the runtime agent for a deployed GOAT.
   *
   * Note what this does not take: no observation plan. The agent is given
   * its goal, its skills and its authority, and then it works out what
   * to monitor through the Tracker SDK. The observation plan is its own
   * output.
   */
  registerGoat(
    definition: GoatDefinition,
    deployment: GoatDeployment,
    runtimeSymbol: string,
    env: ITradingEnvironment,
  ): AgentInstance {
    const agent = compileGoatDefinition({
      definition,
      deployment,
      marketSymbol: runtimeSymbol,
      env,
    });
    return this.registerAgent(agent, env);
  }

  /**
   * Forget an agent entirely.
   *
   * A GOAT is bound to a market by *deployment*, not by creation, so
   * moving one to another market means the old executor has to go. Stop
   * it first if it is running: this drops the instance, and a stopped
   * agent that is dropped cannot wake, decide, or place anything.
   *
   * The generation is bumped *before* the instance is removed, and that
   * ordering is the whole point of this method: a cycle already in flight
   * holds a reference to the instance object itself, so deleting the map
   * entry leaves that cycle reading a perfectly healthy-looking agent that no
   * longer exists. Revoking its generation first means the next boundary it
   * reaches refuses, whatever the map says.
   *
   * The tracker runtime keeps its own memory keyed by agent, so the
   * caller retires that too — otherwise a redeployed GOAT would inherit
   * the previous market's "already reported" state and stay silent.
   */
  unregisterAgent(agentId: string): boolean {
    const instance = this.instances.get(agentId);
    if (!instance) return false;
    instance.isRunning = false;
    this.revokeExecution(instance);
    this.instances.delete(agentId);
    this.activeCycles.delete(agentId);
    eventBus.emit({
      type: 'AGENT_STOPPED',
      data: { agentId, timestamp: Date.now() },
    });
    return true;
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.instances.get(agentId);
  }

  listAgents(): AgentInstance[] {
    return Array.from(this.instances.values());
  }

  async start(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId);

    if (!instance) {
      throw new Error(`Agent ${agentId} not found`);
    }

    instance.isRunning = true;

    eventBus.emit({
      type: 'AGENT_STARTED',
      data: {
        agentId,
        timestamp: Date.now(),
      },
    });

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `agent_start_${Date.now()}`,
        level: 'info',
        message: `Trading Agent "${instance.agent.name}" STARTED in ${instance.env.mode} mode.`,
        timestamp: Date.now(),
      },
    });
  }

  async stop(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId);

    if (!instance) {
      throw new Error(`Agent ${agentId} not found`);
    }

    this.stopInstance(instance);
  }

  /**
   * Stop every running agent.
   *
   * The emergency path used to reach into the runtime's registry from the UI,
   * filter for `isRunning`, and call `stop()` per agent — which meant every
   * caller had to know the runtime's own rule for what counts as running, and
   * one of them would eventually get it subtly wrong. This is that rule, in
   * the runtime that owns it.
   *
   * `listAgents()` stays: the tracker runtime reads it to find the agents that
   * match a market. Stopping everything is not the same question as enumerating.
   *
   * Returns the agents it actually stopped, so a caller can say what happened
   * rather than assume.
   */
  async stopAll(
    reason = 'All agents stopped.'
  ): Promise<string[]> {
    const stopped: string[] = [];

    for (const instance of Array.from(this.instances.values())) {
      if (!instance.isRunning) continue;
      this.stopInstance(instance, reason);
      stopped.push(instance.agent.id);
    }

    return stopped;
  }

  /**
   * The single stop path.
   *
   * Revoking the generation is not an addition to `isRunning = false` — it is
   * what makes the flag mean anything for work already in progress. A cycle
   * that captured generation N cannot act once the counter is N+1, so a stop
   * during a model call ends at the next boundary instead of at the next wake.
   */
  private stopInstance(instance: AgentInstance, reason?: string): void {
    const agentId = instance.agent.id;

    instance.isRunning = false;
    this.revokeExecution(instance);

    eventBus.emit({
      type: 'AGENT_STOPPED',
      data: {
        agentId,
        timestamp: Date.now(),
      },
    });

    eventBus.emit({
      type: 'LOG',
      data: {
        id: `agent_stop_${Date.now()}`,
        level: 'info',
        message:
          `Trading Agent "${instance.agent.name}" STOPPED.` +
          `${reason ? ` ${reason}` : ''}`,
        timestamp: Date.now(),
      },
    });
  }

  /** Withdraw the authority every in-flight cycle is holding. */
  private revokeExecution(instance: AgentInstance): void {
    instance.executionGeneration += 1;
  }

  /**
   * Whether a cycle may still act.
   *
   * Four things have to hold, and each of them covers a case that really
   * happens: the agent is still running; the generation has not been revoked
   * by a stop or an unregister; the instance is still the one the cycle began
   * on (a re-registration replaces it); and the cycle is still the one holding
   * the agent's single cycle slot.
   *
   * Fail-closed by construction — anything not positively confirmed returns a
   * refusal with a reason, so a caller that forgets to handle a gate still
   * cannot execute.
   */
  private cycleGate(cycle: AgentCycle): CycleGate {
    const registered = this.instances.get(cycle.agentId);

    if (registered !== cycle.instance) {
      return {
        live: false,
        reason:
          `Agent ${cycle.agentId} is no longer the instance this cycle started on.`,
      };
    }

    if (cycle.instance.executionGeneration !== cycle.generation) {
      return {
        live: false,
        reason:
          `Agent ${cycle.agentId} was stopped or replaced while cycle ${cycle.cycleId} was running.`,
      };
    }

    if (!cycle.instance.isRunning) {
      return {
        live: false,
        reason: `Agent ${cycle.agentId} is not running.`,
      };
    }

    if (!this.activeCycles.has(cycle.agentId)) {
      return {
        live: false,
        reason: `Cycle ${cycle.cycleId} is no longer the active cycle for ${cycle.agentId}.`,
      };
    }

    return { live: true };
  }

  /**
   * The market this agent observes.
   *
   * There used to be a fallback here: `symbols[0] || 'EURUSD'`. It meant an
   * agent bound to nothing — an undeployed GOAT, a registration that lost its
   * market — quietly read EUR/USD, and every conclusion it then drew was about
   * an instrument nobody asked it about, with nothing in the record to say so.
   * The deployment's market is the only acceptable answer, so an agent without
   * one fails the observation instead, and the failure says why.
   */
  private observationSymbol(instance: AgentInstance): string {
    const symbol = instance.agent.symbols.find(
      (configured) =>
        typeof configured === 'string' &&
        configured.trim().length > 0
    );

    if (!symbol) {
      throw new Error(
        `Agent ${instance.agent.id} has no configured symbol, so it cannot observe a market. ` +
          'A TradingGOATs agent observes the market of its deployment and must not be given a substitute.',
      );
    }

    return symbol;
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const instance = this.instances.get(agentId);

    if (!instance) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const symbol = this.observationSymbol(instance);

    if (
      !instance.agent.symbols.every(
        (configuredSymbol) =>
          instance.agent.policy.allowedSymbols.length === 0 ||
          instance.agent.policy.allowedSymbols.includes(
            configuredSymbol
          )
      )
    ) {
      throw new Error(
        'Agent symbols exceed the policy allowedSymbols boundary.'
      );
    }

    const quote = await instance.env.getMarketQuote(symbol);

    const recentBars = await instance.env.getMarketBars(
      symbol,
      instance.agent.timeframe || '5m',
      15
    );

    if (
      !recentBars.every((bar) =>
        [bar.open, bar.high, bar.low, bar.close, bar.time].every(
          Number.isFinite
        )
      )
    ) {
      throw new Error(
        'Environment returned malformed historical bars.'
      );
    }

    if (
      ![quote.bid, quote.ask, quote.spread].every(
        Number.isFinite
      ) ||
      quote.bid <= 0 ||
      quote.ask < quote.bid
    ) {
      throw new Error(
        'Environment returned an invalid market quote.'
      );
    }

    const account = await instance.env.getAccountState();
    const positions = await instance.env.getPositions();
    const orders = await instance.env.getOrders();

    if (
      ![
        account.balance,
        account.equity,
        account.margin,
        account.freeMargin,
      ].every(Number.isFinite)
    ) {
      throw new Error(
        'Environment returned invalid account state.'
      );
    }

    let session = 'UNKNOWN';

    if (
      instance.allowedCapabilities.includes(
        'market.getSession'
      )
    ) {
      const sessionResult = await this.capabilities.execute<
        Record<string, never>,
        { activeSession: string }
      >(
        'market.getSession',
        {},
        {
          agentId,
          environment: instance.env.mode,
          env: instance.env,
          symbol,
          timeframe: instance.agent.timeframe,
          policy: instance.agent.policy,
          symbols: instance.agent.symbols,
        }
      );

      session = sessionResult.activeSession || 'UNKNOWN';
    }

    return {
      timestamp: quote.timestamp,
      environment: instance.env.mode,
      market: {
        quotes: [quote],
        quote,
        recentBars,
        spread: quote.spread,
        session,
      },
      account,
      positions,
      orders,
      availableCapabilities: instance.allowedCapabilities,
      availableSkills: instance.agent.skills.filter(
        (id) => this.skills.get(id)?.enabled
      ),
      recentMemories: instance.memory.export(),
    };
  }

  /**
   * Primary Agent Reasoning Cycle.
   * Runs the tool-calling reasoning loop with a hard
   * maximum of 5 model iterations.
   */
  async step(
    agentId: string,
    event?: AgentWakeEvent
  ): Promise<AgentDecision> {
    const instance = this.instances.get(agentId);

    if (!instance) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (this.activeCycles.has(agentId)) {
      throw new Error(
        `Agent ${agentId} is already processing a cycle.`
      );
    }

    /*
     * The cycle's authority, captured once.
     *
     * Everything this cycle goes on to do is authorised against this number,
     * so a stop or an unregister that lands at any point from here on
     * invalidates it at the next boundary. Note what is *not* checked here:
     * whether the agent is running. A manual wake and a backtest replay both
     * drive cycles that were never "started" through a tracker, and the
     * reason they are still safe is that they cannot execute — which is a
     * property of the execution boundary, not of the entry point.
     */
    const wakeEvent: AgentWakeEvent =
      event || {
        type: 'MANUAL_WAKE',
        timestamp: Date.now(),
        /*
         * The first configured symbol, or nothing at all. Not a substitute: an
         * agent with no market still gets to run its cycle, and fails at the
         * observation — where the refusal is recorded as a fact about the agent
         * — rather than throwing out of `step` as a caller error.
         */
        symbol: instance.agent.symbols.find(
          (configured) =>
            typeof configured === 'string' &&
            configured.trim().length > 0
        ),
      };

    const wakeData = isRecord(wakeEvent.data)
      ? wakeEvent.data
      : undefined;

    const trackerId =
      typeof wakeData?.trackerId === 'string'
        ? wakeData.trackerId
        : undefined;

    const correlationId =
      typeof wakeData?.correlationId === 'string'
        ? wakeData.correlationId
        : trackerId
          ? `${agentId}:${trackerId}:${wakeEvent.timestamp}`
          : `${agentId}:cycle:${wakeEvent.timestamp}`;

    const cycle: AgentCycle = {
      agentId,
      instance,
      cycleId: `${agentId}:${++this.cycleSequence}`,
      generation: instance.executionGeneration,
      trackerId,
      correlationId,
      wakeEvent,
      wakeData,
    };

    this.activeCycles.add(agentId);

    try {
      return await this.runStep(cycle);
    } finally {
      this.activeCycles.delete(agentId);
    }
  }

  private async runStep(
    cycle: AgentCycle
  ): Promise<AgentDecision> {
    const { agentId, instance, trackerId, correlationId, cycleId, wakeEvent, wakeData } = cycle;


    let observation: AgentObservation;

      try {
        observation = await this.observe(agentId);
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        await this.appendTimeline({
          agentId,
          timestamp: wakeEvent.timestamp,
          type: 'ERROR',
          trackerId,
          correlationId,
          cycleId,
          data: {
            code: 'OBSERVATION_ERROR',
            message,
          },
        });


      eventBus.emit({
        type: 'AGENT_ERROR',
        data: {
          agentId,
          message,
          timestamp: wakeEvent.timestamp,
        },
      });

      return {
        type: 'WAIT',
        reason:
          'Unable to obtain a valid observation; safely defaulting to WAIT.',
      };
    }

    await this.appendTimeline({
      agentId,
      timestamp: observation.timestamp,
      type: 'OBSERVATION',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: observationSnapshot(observation),
    });

    const toolHistory: Array<{
      capability: string;
      input: unknown;
      result: unknown;
      durationMs: number;
    }> = [];

    const maxIterations = 5;
    let iteration = 0;

    let finalDecision: AgentDecision = {
      type: 'WAIT',
      reason: 'Maximum reasoning iterations reached.',
    };

    let cycleError: string | undefined;

    while (iteration < maxIterations) {
      iteration++;

      eventBus.emit({
        type: 'AGENT_REASONING',
        data: {
          agentId,
          iteration,
          timestamp: Date.now(),
        },
      });

      let modelResponse;

      try {
        modelResponse = await this.model.run({
          agent: instance.agent,
          observation,
          instructions: instance.agent.instructions,
          skillsInstructions: instance.skillsInstructions,
          /*
           * The model sees a bounded window of what this cycle has done; the
           * audit trail below keeps the whole of it. Unbounded growth here is
           * what turns one chatty capability into a request the provider
           * refuses, and a refused request looks exactly like a GOAT that has
           * stopped thinking.
           */
          toolHistory: modelToolHistory(toolHistory),
          capabilitySchemas: instance.capabilitySchemas,
          iteration,
          wakeReason:
            typeof wakeData?.reason === 'string'
              ? wakeData.reason
              : wakeEvent.type,
        });
      } catch (error: unknown) {
        cycleError =
          error instanceof Error
            ? error.message
            : String(error);

        finalDecision = {
          type: 'WAIT',
          reason:
            'Model failed; safely defaulting to WAIT.',
        };

        eventBus.emit({
          type: 'AGENT_ERROR',
          data: {
            agentId,
            message: cycleError,
            timestamp: Date.now(),
          },
        });

        await this.appendTimeline({
          agentId,
          timestamp: await this.nowFor(instance),
          type: 'ERROR',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          cycleId,
          data: {
            code: 'MODEL_ERROR',
            message: cycleError,
          },
        });

        break;
      }

      /*
       * Model requested a capability/tool.
       */
      if (modelResponse.toolCall) {
        const {
          capability: capId,
          input,
        } = modelResponse.toolCall;

        if (
          typeof capId !== 'string' ||
          !capId ||
          !isRecord(input)
        ) {
          toolHistory.push({
            capability: String(capId),
            input,
            result: {
              error:
                'Malformed capability request.',
            },
            durationMs: 0,
          });

          continue;
        }

        /*
         * One gateway, for every way the model can reach a capability.
         *
         * Permission, capability lookup, policy and risk validation, the
         * lifecycle gate, sanitisation, history and timeline instrumentation
         * all live in `invokeCapability`. This branch used to hold its own
         * copy of the first three, which is how the two paths drifted.
         */
        toolHistory.push(
          await this.invokeCapability(cycle, capId, input, observation)
        );

        continue;
      }

      /*
       * Model emitted a decision.
       */
      if (modelResponse.decision) {
        if (!isAgentDecision(modelResponse.decision)) {
          finalDecision = {
            type: 'WAIT',
            reason:
              'Model returned a malformed decision; defaulting safely to WAIT.',
          };

          break;
        }

        if (
          modelResponse.decision.type === 'ANALYZE'
        ) {
          const {
            capability: capId,
            input,
          } = modelResponse.decision;

          /*
           * ANALYZE is a decision, not an exemption.
           *
           * It used to reach `capabilities.execute` directly, which meant the
           * model could name any allowed capability in an ANALYZE decision and
           * have it run — including `orders.market`, which calls
           * `env.placeMarketOrder` itself. That path skipped the policy
           * validator, `riskManager` and the lifecycle gate entirely, so a
           * capability the tool-call path would have refused executed anyway
           * just by being phrased as analysis. It goes through the same
           * gateway now, and an analysis capability is unaffected by it:
           * nothing outside the `execution` category gets risk-validated.
           */
          toolHistory.push(
            await this.invokeCapability(
              cycle,
              capId,
              input,
              observation
            )
          );

          continue;
        }

        finalDecision =
          modelResponse.decision;

        break;
      }

      break;
    }

    /*
     * Instrument metadata for policy and risk decisions.
     *
     * It is read from the execution environment, the only layer that
     * knows the provider. The agent never supplies instrument facts, and
     * risk enforcement stays deterministic here in the runtime.
     */
    const instruments =
      await this.resolveInstruments(instance);

    /*
     * Validate final decision against Agent Policy
     * and system-level risk.
     */
    let validation: AgentActionValidationResult =
      instance.validator.validate(
        finalDecision,
        instance.agent.policy,
        observation,
        { instruments }
      );

    if (
      validation.valid &&
      finalDecision.type === 'OPEN_POSITION'
    ) {
      const systemRisk =
        riskManager.validateOrder(
          {
            symbol: finalDecision.symbol,
            side: finalDecision.side,
            volume: finalDecision.volume,
            stopLoss: finalDecision.stopLoss,
            takeProfit: finalDecision.takeProfit,
          },
          observation.positions,
          false,
          {
            instruments: instruments
              ? lookupFrom(instruments)
              : undefined,
            referencePrices:
              referencePricesFrom(observation),
          },
        );

      if (!systemRisk.valid) {
        validation = {
          valid: false,
          code: 'RISK_REJECTED',
          reason: systemRisk.reason,
        };
      }
    }

    await this.appendTimeline({
      agentId,
      timestamp: await this.nowFor(instance),
      type: 'RISK_CHECK',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: {
        status:
          finalDecision.type === 'WAIT'
            ? 'NOT_REQUIRED'
            : validation.valid
              ? 'PASS'
              : 'REJECTED',
        code: validation.code,
        reason: validation.reason,
        limits: {
          maxRiskPerTrade:
            instance.agent.policy.maxRiskPerTrade,
          maxDailyLoss:
            instance.agent.policy.maxDailyLoss,
          maxDrawdown:
            instance.agent.policy.maxDrawdown,
          maxOpenPositions:
            instance.agent.policy.maxOpenPositions,
          maxExposure:
            instance.agent.policy.maxExposure,
        },
      },
    });

    let executionResult: unknown = undefined;

    /*
     * The decision's outcome, which is not its verdict.
     *
     * These were one field. An order the environment rejected produced
     * `APPROVED` in memory and in the audit record, because "policy said yes"
     * and "the thing happened" were being recorded in the same place — and the
     * log could not tell a filled order from a refused one. They are separate
     * now, and `executeDecision` is the only thing that can turn an approval
     * into an execution.
     */
    let outcome: AgentActionOutcome;

    if (finalDecision.type === 'WAIT') {
      outcome = 'WAIT';
    } else if (
      !validation.valid ||
      validation.code !== 'APPROVED'
    ) {
      outcome = 'REJECTED';
    } else {
      const execution = await this.executeDecision(
        cycle,
        finalDecision,
        observation,
        instruments
      );

      outcome = execution.outcome;
      executionResult = execution.result;

      if (execution.error) {
        cycleError = execution.error;
      }
    }

    /*
     * Save decision to agent memory.
     */
    instance.memory.set(
      'lastDecision',
      finalDecision
    );

    instance.memory.append(
      'decisionHistory',
      {
        timestamp: Date.now(),
        decision: finalDecision,
        reason: finalDecision.reason,
      }
    );

    instance.memory.set(
      'lastDecisionTimestamp',
      Date.now()
    );

    instance.memory.set(
      'lastWakeEvent',
      wakeEvent.type
    );

    instance.memory.set(
      'lastCycleAt',
      Date.now()
    );

    instance.memory.set(
      'lastActionResult',
      {
        /*
         * `status` now carries the outcome, not the verdict.
         *
         * It read `APPROVED` for anything validation let through, which meant
         * an agent reading its own memory could not tell that its order had
         * been rejected by the environment. `validation` is kept beside it, so
         * "permitted and did not happen" is answerable as well as reportable.
         */
        status: outcome,
        outcome,
        validation,
        reason:
          validation.reason ??
          cycleError,
        executionResult:
          sanitizeAuditValue(
            executionResult
          ),
        cycleId,
      }
    );

    /*
     * Record audit trail.
     */
    const auditRecord: AgentAuditRecord = {
      id: `audit_${Date.now()}_${this.auditLog.length}`,
      agentId,
      timestamp: Date.now(),
      cycleId,
      event: sanitizeAuditValue(
        wakeEvent
      ) as AgentWakeEvent,
      observationSummary:
        `${observation.market.quote?.symbol || 'unknown'} ` +
        `Bid: ${observation.market.quote?.bid} | ` +
        `Equity: $${observation.account.equity} | ` +
        `Positions: ${observation.positions.length}`,
      skillsUsed:
        instance.agent.skills.filter(
          (id) => this.skills.get(id)?.enabled
        ),
      toolCalls: toolHistory,
      decision: sanitizeAuditValue(
        finalDecision
      ) as AgentDecision,
      validation,
      outcome,
      executionResult:
        sanitizeAuditValue(executionResult),
      error:
        cycleError ||
        (!validation.valid
          ? validation.reason
          : undefined),
    };

    eventBus.emit({
      type: 'AGENT_OBSERVED',
      data: {
        agentId,
        timestamp: observation.timestamp,
      },
    });

    const observableDecision =
      sanitizeAuditValue(finalDecision);

    eventBus.emit({
      type: 'AGENT_DECISION',
      data: {
        agentId,
        decision: observableDecision,
        timestamp: auditRecord.timestamp,
      },
    });

    /*
     * What the rest of the system hears about the decision is what happened,
     * not what was permitted.
     *
     * `AGENT_ACTION_APPROVED` used to be emitted whenever validation passed,
     * which is how a refused order was announced as an approved action. It
     * now means the environment accepted it; a refusal and a cancellation are
     * both refusals, and they say which gate stopped it.
     */
    if (finalDecision.type !== 'WAIT') {
      if (outcome === 'EXECUTED') {
        eventBus.emit({
          type: 'AGENT_ACTION_APPROVED',
          data: {
            agentId,
            decision: observableDecision,
            timestamp:
              auditRecord.timestamp,
          },
        });
      } else {
        eventBus.emit({
          type: 'AGENT_ACTION_REJECTED',
          data: {
            agentId,
            reason:
              validation.reason ??
              cycleError ??
              `The runtime declined this decision: ${outcome}.`,
            timestamp:
              auditRecord.timestamp,
          },
        });
      }
    }

    this.auditLog.unshift(auditRecord);

    if (
      this.auditLog.length >
      this.maxAuditEntries
    ) {
      this.auditLog.pop();
    }

    await this.appendTimeline({
      agentId,
      timestamp: auditRecord.timestamp,
      type: 'DECISION',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: {
        decision:
          sanitizeAuditValue(finalDecision),
        reason: finalDecision.reason,
        skillsUsed:
          auditRecord.skillsUsed,
        validation,
        /*
         * On the timeline as well as in memory, because the timeline is what a
         * person reads months later and "approved" on its own is a claim they
         * cannot check.
         */
        outcome,
        cycleId,
      },
    });

    if (
      finalDecision.type ===
        'OPEN_POSITION' &&
      validation.valid &&
      isRecord(executionResult) &&
      executionResult.success === true &&
      typeof executionResult.positionId ===
        'string'
    ) {
      const position = (
        await instance.env.getPositions(
          finalDecision.symbol
        )
      ).find(
        (candidate) =>
          candidate.id ===
          executionResult.positionId
      );

      if (position) {
        await this.notifyAgentPosition(
          agentId,
          'POSITION_OPEN',
          position,
          await this.nowFor(instance)
        );
      }
    }

    return finalDecision;
  }

  /**
   * The final execution boundary for a decision.
   *
   * The last gate before an environment mutation, and the only place in this
   * class that turns an approved decision into an order. Three things are
   * rechecked here rather than trusted from earlier in the cycle, because each
   * of them can change while the model is thinking:
   *
   *   - the cycle's authority (stopped, unregistered, replaced, or no longer
   *     the active cycle),
   *   - the risk gate, which includes the kill switch — a user who pulls it
   *     during a model call must not have the order they were stopping sent
   *     afterwards,
   *   - that the decision is an action at all.
   *
   * It fails closed: a refusal returns without touching the environment, and
   * records why it refused so a stopped cycle is distinguishable from a
   * stalled one.
   *
   * Idempotency: `placeMarketOrder` takes no idempotency key — the environment
   * contract only carries one for resting orders — so duplicate suppression is
   * not available here and is not faked. What *is* guaranteed is that a
   * cancelled cycle never reaches this method, so the ambiguous case (a
   * response lost in flight) cannot be re-driven by a retry inside the runtime.
   * `cycleId` is the deterministic identifier to hand the venue if that
   * contract ever grows one.
   */
  private async executeDecision(
    cycle: AgentCycle,
    decision: AgentDecision,
    observation: AgentObservation,
    instruments: InstrumentMetadata[] | undefined
  ): Promise<DecisionExecution> {
    const { agentId, instance, cycleId, trackerId, correlationId } = cycle;

    if (
      decision.type === 'WAIT' ||
      decision.type === 'ANALYZE'
    ) {
      return { outcome: 'NOT_ACTIONABLE' };
    }

    const gate = this.cycleGate(cycle);

    if (!gate.live) {
      return this.refuseExecution(
        cycle,
        gate.reason,
        'STOPPED_DURING_CYCLE'
      );
    }

    /*
     * Re-run the deterministic risk gate against the state as it is now.
     *
     * The one above ran against the observation this cycle opened with, which
     * may be several seconds and one model call old. `recordAcceptedOrder` is
     * false here for the same reason it is false above: this is a check, not an
     * order, and the adapter records the submission itself.
     */
    if (decision.type === 'OPEN_POSITION') {
      const systemRisk = riskManager.validateOrder(
        {
          symbol: decision.symbol,
          side: decision.side,
          volume: decision.volume,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
        },
        observation.positions,
        false,
        {
          instruments: instruments
            ? lookupFrom(instruments)
            : undefined,
          referencePrices: referencePricesFrom(observation),
        }
      );

      if (!systemRisk.valid) {
        await this.appendTimeline({
          agentId,
          timestamp: await this.nowFor(instance),
          type: 'RISK_CHECK',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          cycleId,
          data: {
            status: 'REJECTED',
            stage: 'execution-boundary',
            code: 'RISK_REJECTED',
            reason: systemRisk.reason,
          },
        });

        return {
          outcome: 'REJECTED',
          error: systemRisk.reason,
          result: {
            success: false,
            error: systemRisk.reason,
          },
        };
      }
    }

    /*
     * And the lifecycle, once more, now that the risk gate has had its say.
     * The two awaits above are exactly the window this closes.
     */
    const finalGate = this.cycleGate(cycle);

    if (!finalGate.live) {
      return this.refuseExecution(
        cycle,
        finalGate.reason,
        'STOPPED_BEFORE_SUBMISSION'
      );
    }

    let executionResult: unknown;

    try {
      if (decision.type === 'OPEN_POSITION') {
        executionResult = await instance.env.placeMarketOrder({
          symbol: decision.symbol,
          side: decision.side,
          volume: decision.volume,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
          comment: `Agent: ${instance.agent.name}`,
        });

        eventBus.emit({
          type: 'AGENT_ORDER_SUBMITTED',
          data: {
            agentId,
            result: executionResult,
            timestamp: Date.now(),
          },
        });

        const executionRecord = isRecord(executionResult)
          ? executionResult
          : {};

        await this.appendTimeline({
          agentId,
          timestamp: await this.nowFor(instance),
          type: 'ORDER',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          cycleId,
          orderId:
            typeof executionRecord.orderId === 'string'
              ? executionRecord.orderId
              : undefined,
          positionId:
            typeof executionRecord.positionId === 'string'
              ? executionRecord.positionId
              : undefined,
          data: {
            status:
              executionRecord.success === true
                ? 'SUBMITTED'
                : 'REJECTED',
            symbol: decision.symbol,
            side: decision.side,
            volume: decision.volume,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
            rejection:
              isRecord(executionRecord.rejection)
                ? executionRecord.rejection
                : undefined,
            result: sanitizeAuditValue(executionResult),
          },
        });

        if (isSuccessfulExecution(executionResult)) {
          if (
            typeof executionRecord.positionId === 'string'
          ) {
            await this.correlateOpenedPosition(
              cycle,
              executionRecord.positionId,
              executionResult
            );
          }

          eventBus.emit({
            type: 'AGENT_ORDER_FILLED',
            data: {
              agentId,
              result: executionResult,
              symbol: decision.symbol,
              orderId:
                typeof executionRecord.orderId === 'string'
                  ? executionRecord.orderId
                  : undefined,
              positionId:
                typeof executionRecord.positionId === 'string'
                  ? executionRecord.positionId
                  : undefined,
              timestamp: Date.now(),
            },
          });
        }
      } else if (decision.type === 'MODIFY_POSITION') {
        executionResult = await instance.env.modifyPosition(
          decision.positionId,
          decision.changes
        );
      } else {
        executionResult = await instance.env.closePosition(
          decision.positionId
        );
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      executionResult = { success: false, error: message };

      eventBus.emit({
        type: 'AGENT_ERROR',
        data: {
          agentId,
          message,
          timestamp: Date.now(),
        },
      });

      await this.appendTimeline({
        agentId,
        timestamp: await this.nowFor(instance),
        type: 'ERROR',
        environment: instance.env.mode,
        trackerId,
        correlationId,
        cycleId,
        data: {
          code: 'EXECUTION_ERROR',
          message,
        },
      });

      return {
        outcome: 'FAILED',
        result: executionResult,
        error: message,
      };
    }

    /*
     * The environment answered. "Answered" is not "filled": an adapter that
     * rejects an order answers too, and reporting that as an approval is the
     * bug this whole distinction exists to fix.
     */
    if (
      isRecord(executionResult) &&
      executionResult.success === false &&
      typeof executionResult.error === 'string'
    ) {
      return {
        outcome: 'FAILED',
        result: executionResult,
        error: executionResult.error,
      };
    }

    return { outcome: 'EXECUTED', result: executionResult };
  }

  /**
   * Record that the runtime declined to act, and why.
   *
   * `DECISION_REFUSED` rather than an error, because nothing failed: the
   * system did exactly what it is for. It is still written down, because a GOAT
   * that proposed an order and then went quiet is otherwise indistinguishable
   * from one whose model never answered.
   */
  private async refuseExecution(
    cycle: AgentCycle,
    reason: string,
    kind: string
  ): Promise<DecisionExecution> {
    const { agentId, instance, cycleId, trackerId, correlationId } = cycle;

    await this.appendTimeline({
      agentId,
      timestamp: await this.nowFor(instance),
      type: 'DECISION_REFUSED',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: {
        kind,
        reason,
      },
    });

    eventBus.emit({
      type: 'AGENT_ERROR',
      data: {
        agentId,
        message: reason,
        timestamp: Date.now(),
      },
    });

    return {
      outcome: 'CANCELLED',
      error: reason,
    };
  }

  /**
   * Remember which cycle opened a position, and write that it opened.
   *
   * Shared by the decision path and the capability path, so an order submitted
   * as a tool call is correlated to its cycle exactly as one submitted as a
   * decision is. It used to happen only for decisions, which meant a
   * capability-placed position had no lineage and its later updates and close
   * wrote no timeline at all.
   */
  private async correlateOpenedPosition(
    cycle: AgentCycle,
    positionId: string,
    result: unknown
  ): Promise<void> {
    const { agentId, instance, cycleId, trackerId, correlationId } = cycle;

    this.positionCorrelations.set(positionId, {
      agentId,
      trackerId,
      correlationId,
      cycleId,
    });

    await this.appendTimeline({
      agentId,
      timestamp: await this.nowFor(instance),
      type: 'POSITION_UPDATE',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      positionId,
      data: {
        status: 'OPENED',
        result: sanitizeAuditValue(result),
      },
    });
  }

  /**
   * Run one capability on behalf of the model.
   *
   * The single way the model reaches a capability, whether it asked as a
   * tool call or as an `ANALYZE` decision. The order of the gates is the
   * contract:
   *
   *   permission -> capability exists -> lifecycle -> policy and risk ->
   *   lifecycle again -> capability runs -> recorded
   *
   * The lifecycle gate sits before the risk gate so a stopped agent is not
   * charged a risk evaluation it will never use, and again after it, because
   * the risk evaluation awaits and a stop can land inside that await.
   *
   * Nothing outside the `execution` category is risk-validated. Reading a
   * quote is not a trade, and applying order limits to a market read would be
   * both wrong and a way to make analysis fail for no reason.
   */
  private async invokeCapability(
    cycle: AgentCycle,
    capabilityId: string,
    input: Record<string, unknown>,
    observation: AgentObservation
  ): Promise<{
    capability: string;
    input: unknown;
    result: unknown;
    durationMs: number;
  }> {
    const { agentId, instance, cycleId, trackerId, correlationId } = cycle;
    const startedAt = Date.now();

    const refuse = (
      outcome: 'REJECTED' | 'NOT_ACTIONABLE' | 'CANCELLED',
      reason: string,
      validation?: AgentActionValidationResult
    ): {
      capability: string;
      input: unknown;
      result: unknown;
      durationMs: number;
    } => ({
      capability: capabilityId,
      input: sanitizeAuditValue(input),
      result: { status: outcome, reason },
      durationMs: Date.now() - startedAt,
    });

    if (!instance.allowedCapabilities.includes(capabilityId)) {
      return refuse(
        'REJECTED',
        `Permission denied: Capability "${capabilityId}" not assigned to agent skills.`
      );
    }

    const capability = this.capabilities.get(capabilityId);

    if (!capability) {
      return refuse(
        'NOT_ACTIONABLE',
        `Capability "${capabilityId}" is not registered.`
      );
    }

    const gate = this.cycleGate(cycle);

    if (!gate.live) {
      await this.appendTimeline({
        agentId,
        timestamp: await this.nowFor(instance),
        type: 'DECISION_REFUSED',
        environment: instance.env.mode,
        trackerId,
        correlationId,
        cycleId,
        data: {
          kind: 'CAPABILITY_CANCELLED',
          capability: capabilityId,
          reason: gate.reason,
        },
      });

      return refuse('CANCELLED', gate.reason);
    }

    /*
     * An execution capability reaches the environment on the agent's behalf, so
     * it is validated exactly as a decision would be — against a *fresh*
     * observation, since the one this cycle opened with predates every tool
     * call it has made since.
     */
    if (capability.category === 'execution') {
      let currentObservation = observation;

      try {
        currentObservation = await this.observe(agentId);
      } catch (error: unknown) {
        return refuse(
          'NOT_ACTIONABLE',
          `Cannot validate execution capability "${capabilityId}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const executionValidation = await this.validateExecutionTool(
        instance,
        currentObservation,
        capabilityId,
        input
      );

      if (!executionValidation.valid) {
        await this.appendTimeline({
          agentId,
          timestamp: await this.nowFor(instance),
          type: 'RISK_CHECK',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          cycleId,
          data: {
            status: 'REJECTED',
            reason: executionValidation.reason,
            capability: capabilityId,
          },
        });

        return refuse(
          'REJECTED',
          executionValidation.reason ??
            'Refused by policy or risk.',
          executionValidation
        );
      }

      const preExecutionGate = this.cycleGate(cycle);

      if (!preExecutionGate.live) {
        await this.appendTimeline({
          agentId,
          timestamp: await this.nowFor(instance),
          type: 'DECISION_REFUSED',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          cycleId,
          data: {
            kind: 'CAPABILITY_CANCELLED',
            capability: capabilityId,
            reason: preExecutionGate.reason,
          },
        });

        return refuse('CANCELLED', preExecutionGate.reason);
      }
    }

    eventBus.emit({
      type: 'AGENT_TOOL_REQUESTED',
      data: {
        agentId,
        capability: capabilityId,
        input: sanitizeAuditValue(input),
        timestamp: Date.now(),
      },
    });

    await this.appendTimeline({
      agentId,
      timestamp: await this.nowFor(instance),
      type: 'CAPABILITY_CALL',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: {
        capability: capabilityId,
        input: summarize(input),
      },
    });

    let toolResult: unknown;
    let failure: string | undefined;

    try {
      toolResult = await this.capabilities.execute(
        capabilityId,
        input,
        {
          agentId,
          environment: instance.env.mode,
          env: instance.env,
          symbol:
            observation.market.quote?.symbol ||
            this.observationSymbol(instance),
          timeframe: instance.agent.timeframe,
          policy: instance.agent.policy,
          symbols: instance.agent.symbols,
        }
      );
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
      toolResult = { error: failure };
    }

    /*
     * Real elapsed time, in every mode.
     *
     * This used to be a difference between a wall-clock start and the
     * environment's market timestamp, which in BACKTEST is a *simulated* clock:
     * the tool appeared to take longer than the epoch, or negative, depending on
     * the candles. A duration is a measure of this process, so it is measured
     * with the process's own clock and the market clock is left to timestamps.
     */
    const durationMs = Date.now() - startedAt;

    eventBus.emit({
      type: 'AGENT_TOOL_RESULT',
      data: {
        agentId,
        capability: capabilityId,
        result: sanitizeAuditValue(toolResult),
        timestamp: Date.now(),
      },
    });

    await this.appendTimeline({
      agentId,
      timestamp: await this.nowFor(instance),
      type: 'CAPABILITY_RESULT',
      environment: instance.env.mode,
      trackerId,
      correlationId,
      cycleId,
      data: {
        capability: capabilityId,
        result: summarize(toolResult),
        durationMs,
        success: failure === undefined,
      },
    });

    if (failure !== undefined) {
      await this.appendTimeline({
        agentId,
        timestamp: await this.nowFor(instance),
        type: 'ERROR',
        environment: instance.env.mode,
        trackerId,
        correlationId,
        cycleId,
        data: {
          code: 'CAPABILITY_ERROR',
          capability: capabilityId,
          message: failure,
        },
      });
    }

    /*
     * An execution capability that succeeded opens a position, and that has to
     * be correlated exactly as a decision-opened one is — otherwise the order
     * and everything that happens to that position afterwards is invisible to
     * the timeline.
     */
    if (
      failure === undefined &&
      capability.category === 'execution' &&
      isSuccessfulExecution(toolResult) &&
      isRecord(toolResult) &&
      typeof toolResult.positionId === 'string'
    ) {
      await this.correlateOpenedPosition(
        cycle,
        toolResult.positionId,
        toolResult
      );
    }

    return {
      capability: capabilityId,
      input: sanitizeAuditValue(input),
      result: sanitizeAuditValue(toolResult),
      durationMs,
    };
  }

  /**
   * Instrument metadata offered by the current environment.
   * Environments that cannot describe their markets return undefined and
   * the policy layer falls back to its documented degraded path.
   */
  private async resolveInstruments(
    instance: AgentInstance,
  ): Promise<InstrumentMetadata[] | undefined> {
    if (!instance.env.getInstruments) {
      return undefined;
    }

    try {
      const instruments =
        await instance.env.getInstruments();

      return Array.isArray(instruments)
        ? instruments
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The market/event time for this agent, in milliseconds.
   *
   * Two clocks exist in this runtime and they are not interchangeable. This is
   * the *market* clock: simulated in a BACKTEST replay, wall-clock everywhere
   * else. Real elapsed time is measured with `Date.now()` at the point of
   * measurement and never derived from this — subtracting a simulated candle
   * time from a wall-clock start is how a backtest reported a duration of
   * minus sixty years.
   *
   * In BACKTEST this reads the environment's own clock when it has one. It used
   * to fetch a full market quote for every timestamp it wrote — five times a
   * cycle, once per tool call — purely to read a number the backtest
   * environment already knew.
   */
  private async nowFor(
    instance: AgentInstance
  ): Promise<number> {
    if (instance.env.mode !== 'BACKTEST') {
      return Date.now();
    }

    if (instance.env.now) {
      return instance.env.now();
    }

    return (
      await instance.env.getMarketQuote(
        this.observationSymbol(instance)
      )
    ).timestamp;
  }

  private async appendTimeline(
    event: Omit<AgentTimelineEvent, 'id'>
  ): Promise<void> {
    const eventEnvironment =
      event.environment ||
      this.instances.get(event.agentId)?.env.mode;

    try {
      const instance = this.instances.get(event.agentId);
      await this.timeline.append({
        ...event,
        goatId: event.goatId || instance?.goatId,
        deploymentId: event.deploymentId || instance?.deploymentId,
        environment: eventEnvironment,
        id:
          `agent-event:${event.agentId}:` +
          `${event.timestamp}:` +
          `${this.timelineSequence++}`,
        data: sanitizeAuditValue(event.data),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      eventBus.emit({
        type: 'AGENT_ERROR',
        data: {
          agentId: event.agentId,
          message:
            `Timeline append failed: ${message}`,
          timestamp: event.timestamp,
        },
      });
    }
  }

  async notifyAgentPosition(
    agentId: string,
    type:
      | 'POSITION_OPEN'
      | 'POSITION_UPDATE'
      | 'POSITION_CLOSE',
    position: Position,
    timestamp: number
  ): Promise<void> {
    if (type === 'POSITION_CLOSE') {
      /*
       * One close, one record.
       *
       * A close is already fully described by `recordPositionEvent`: it writes
       * the row and retires the correlation. Falling through afterwards
       * depended on that retirement — the second lookup found nothing — so a
       * close was recorded once by accident rather than by design, and any
       * change to the retirement would have silently doubled every close in
       * the log. The return makes the single write explicit.
       *
       * Note also that the bus already carries POSITION_CLOSE for
       * environment closes; this path is for a caller that knows about a close
       * the bus never saw, and it does not touch the bus itself.
       */
      await this.recordPositionEvent(position.id, 'CLOSED', {
        position,
        tradeId: undefined,
      });

      return;
    }

    const correlation =
      this.positionCorrelations.get(
        position.id
      );

    if (correlation) {
      await this.appendTimeline({
        agentId,
        timestamp,
        type: 'POSITION_UPDATE',
        environment:
          this.instances.get(agentId)?.env.mode,
        trackerId: correlation.trackerId,
        correlationId:
          correlation.correlationId,
        cycleId: correlation.cycleId,
        positionId: position.id,
        data: {
          status:
            type === 'POSITION_OPEN'
              ? 'OPENED'
              : 'UPDATED',
          symbol: position.symbol,
          volume: position.volume,
          currentPrice:
            position.currentPrice,
          stopLoss: position.stopLoss,
          takeProfit:
            position.takeProfit,
        },
      });
    }
  }

  private async recordPositionEvent(
    positionId: string,
    status: string,
    value: unknown
  ): Promise<void> {
    const correlation =
      this.positionCorrelations.get(
        positionId
      );

    if (!correlation) return;

    await this.appendTimeline({
      agentId: correlation.agentId,
      timestamp: Date.now(),
      type: 'POSITION_UPDATE',
      trackerId: correlation.trackerId,
      correlationId:
        correlation.correlationId,
      cycleId: correlation.cycleId,
      positionId,
      data: {
        status,
        value: sanitizeAuditValue(value),
      },
    });

    if (status === 'CLOSED') {
      this.positionCorrelations.delete(
        positionId
      );
    }
  }

  /**
   * Whether an execution capability is allowed to reach the environment.
   *
   * The one gate on the capability path, and the same gate the decision path uses
   * one layer up. It exists because an execution capability calls the environment
   * itself, so anything that skipped this handed the model the environment.
   *
   * What the capability *means* comes from `executionShapeFor`, which keeps that
   * knowledge beside the capability definitions instead of here; what is *permitted*
   * is decided from the account and the deployment, which is the only place that
   * information exists.
   */
  private async validateExecutionTool(
    instance: AgentInstance,
    observation: AgentObservation,
    capability: string,
    input: Record<string, unknown>
  ): Promise<AgentActionValidationResult> {
    const shape = executionShapeFor(capability);

    if (!shape) {
      return {
        valid: false,
        code: 'UNKNOWN_CAPABILITY',
        reason:
          'Unsupported execution capability.',
      };
    }

    if (shape.unsupported) {
      return {
        valid: false,
        code: 'INVALID_PARAMS',
        reason: `${capability} ${shape.unsupported}`,
      };
    }

    if (shape.decision === 'OPEN_POSITION') {
      const decision: AgentDecision = {
        type: 'OPEN_POSITION',
        symbol:
          typeof input.symbol === 'string'
            ? input.symbol
            : '',
        side:
          input.side === 'BUY'
            ? 'BUY'
            : 'SELL',
        volume:
          typeof input.volume === 'number'
            ? input.volume
            : NaN,
        stopLoss:
          typeof input.stopLoss ===
          'number'
            ? input.stopLoss
            : undefined,
        takeProfit:
          typeof input.takeProfit ===
          'number'
            ? input.takeProfit
            : undefined,
        reason:
          typeof input.comment ===
          'string'
            ? input.comment
            : 'Capability order request',
      };

      const capabilityInstruments =
        await this.resolveInstruments(instance);

      const validation =
        instance.validator.validate(
          decision,
          instance.agent.policy,
          observation,
          { instruments: capabilityInstruments }
        );

      if (!validation.valid) {
        return validation;
      }

      const systemRisk =
        riskManager.validateOrder(
          {
            symbol: decision.symbol,
            side: decision.side,
            volume: decision.volume,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
          },
          observation.positions,
          false,
          {
            instruments: capabilityInstruments
              ? lookupFrom(capabilityInstruments)
              : undefined,
            referencePrices:
              referencePricesFrom(observation),
          },
        );

      return systemRisk.valid
        ? validation
        : {
            valid: false,
            code: 'RISK_REJECTED',
            reason: systemRisk.reason,
          };
    }

    const positionId =
      typeof input.positionId ===
      'string'
        ? input.positionId
        : '';

    if (shape.decision === 'CLOSE_POSITION') {
      const position =
        observation.positions.find(
          (item) =>
            item.id === positionId
        );

      if (!position) {
        return {
          valid: false,
          code: 'INVALID_PARAMS',
          reason:
            `Position ${positionId || '(missing id)'} not found.`,
        };
      }

      const volumeField = shape.volumeField;
      if (
        shape.partial &&
        volumeField !== undefined &&
        (
          typeof input[volumeField] !==
            'number' ||
          !Number.isFinite(
            input[volumeField]
          ) ||
          (input[volumeField] as number) <= 0 ||
          (input[volumeField] as number) >
            position.volume
        )
      ) {
        return {
          valid: false,
          code: 'INVALID_PARAMS',
          reason:
            'Partial close volume must be positive and no greater than the open position volume.',
        };
      }

      return instance.validator.validate(
        {
          type: 'CLOSE_POSITION',
          positionId,
          reason:
            'Capability close request',
        },
        instance.agent.policy,
        observation
      );
    }

    /*
     * A modification. Which field it carries comes from the capability's own
     * shape, so a capability that moves the stop and one that moves the target
     * differ by one string rather than by two branches.
     */
    const invalidationField = shape.invalidationField;
    const changes =
      invalidationField === 'takeProfit'
        ? {
            takeProfit:
              typeof input.takeProfit ===
              'number'
                ? input.takeProfit
                : undefined,
          }
        : {
            stopLoss:
              typeof input.stopLoss ===
              'number'
                ? input.stopLoss
                : undefined,
          };

    return instance.validator.validate(
      {
        type: 'MODIFY_POSITION',
        positionId,
        changes,
        reason:
          'Capability modification request',
      },
      instance.agent.policy,
      observation
    );
  }

  /**
   * Evaluates an incoming event and wakes the
   * agent if the event is relevant.
   */
  async handleEvent(
    agentId: string,
    event: AgentWakeEvent
  ): Promise<boolean> {
    const instance =
      this.instances.get(agentId);

    if (
      !instance ||
      !instance.isRunning
    ) {
      return false;
    }

    const relevantEvents:
      AgentWakeEvent['type'][] = [
        'NEW_BAR',
        'PRICE_THRESHOLD',
        'POSITION_OPENED',
        'TRACKER_OBSERVED',
        'POSITION_APPROACHING_STOP',
        'POSITION_REACHED_PROFIT_TARGET',
        'SPREAD_CHANGED',
        'SESSION_CHANGED',
        'ORDER_FILLED',
        'ORDER_REJECTED',
        'RISK_STATE_CHANGED',
        'MANUAL_WAKE',
      ];

    if (
      !relevantEvents.includes(
        event.type
      )
    ) {
      return false;
    }

    const isMatchingSymbol =
      !event.symbol ||
      instance.agent.symbols.includes(
        event.symbol
      );

    if (!isMatchingSymbol) {
      return false;
    }

    await this.step(
      agentId,
      event
    );

    return true;
  }

  getAuditTrail(
    agentId?: string
  ): AgentAuditRecord[] {
    return agentId
      ? this.auditLog.filter(
          (a) => a.agentId === agentId
        )
      : [...this.auditLog];
  }

  clearAuditTrail(): void {
    this.auditLog = [];
  }
}

export const agentRuntime =
  new AgentRuntime(undefined, undefined, undefined, undefined, new PersistentAgentTimelineStore());


function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isAgentDecision(
  value: unknown
): value is AgentDecision {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string'
  ) {
    return false;
  }

  if (value.type === 'WAIT') {
    return (
      typeof value.reason ===
      'string'
    );
  }

  if (value.type === 'ANALYZE') {
    return (
      typeof value.capability ===
        'string' &&
      isRecord(value.input)
    );
  }

  if (
    value.type === 'OPEN_POSITION'
  ) {
    return (
      typeof value.symbol ===
        'string' &&
      (value.side === 'BUY' ||
        value.side === 'SELL') &&
      typeof value.volume ===
        'number' &&
      Number.isFinite(
        value.volume
      ) &&
      typeof value.reason ===
        'string'
    );
  }

  if (
    value.type ===
    'MODIFY_POSITION'
  ) {
    return (
      typeof value.positionId ===
        'string' &&
      isRecord(value.changes) &&
      typeof value.reason ===
        'string'
    );
  }

  if (
    value.type ===
    'CLOSE_POSITION'
  ) {
    return (
      typeof value.positionId ===
        'string' &&
      typeof value.reason ===
        'string'
    );
  }

  return false;
}

function isSuccessfulExecution(
  value: unknown
): boolean {
  return (
    isRecord(value) &&
    value.success === true
  );
}

function sanitizeAuditValue(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map(
      sanitizeAuditValue
    );
  }

  if (typeof value === 'string') {
    return value.replace(
      /(bearer\s+)[\w.-]+/gi,
      '$1[REDACTED]'
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(
      ([key, item]) => [
        key,
        /api.?key|secret|token|password|credential/i.test(
          key
        )
          ? '[REDACTED]'
          : sanitizeAuditValue(item),
      ]
    )
  );
}

function observationSnapshot(
  observation: AgentObservation
): unknown {
  return sanitizeAuditValue({
    timestamp:
      observation.timestamp,
    environment:
      observation.environment,
    market: {
      quotes:
        observation.market.quotes,
      spread:
        observation.market.spread,
      session:
        observation.market.session,
      recentBars:
        observation.market.recentBars?.slice(
          -50
        ),
    },
    account:
      observation.account,
    positions:
      observation.positions,
    orders:
      observation.orders,
  });
}

function summarize(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return {
      count: value.length,
    };
  }

  if (!isRecord(value)) {
    return value;
  }

  const summary: Record<
    string,
    unknown
  > = {};

  for (
    const [key, item] of Object.entries(
      value
    )
  ) {
    if (
      [
        'bars',
        'values',
        'positions',
        'orders',
      ].includes(key) &&
      Array.isArray(item)
    ) {
      summary[key] = {
        count: item.length,
      };
    } else if (
      !/api.?key|secret|token|password|credential/i.test(
        key
      )
    ) {
      summary[key] =
        sanitizeAuditValue(item);
    }
  }

  return summary;
}

/**
 * Latest observed price per symbol, taken from the agent observation.
 * Used by the deterministic risk layer to value exposure.
 */
function referencePricesFrom(
  observation: AgentObservation
): Record<string, number> {
  return observation.market.quotes.reduce<
    Record<string, number>
  >((prices, quote) => {
    const price =
      Number.isFinite(quote.ask) && quote.ask > 0
        ? quote.ask
        : quote.bid;

    if (Number.isFinite(price) && price > 0) {
      prices[quote.symbol] = price;
    }

    return prices;
  }, {});
}

/**
 * The tool history the model is shown.
 *
 * Two separate records of the same cycle, on purpose. The audit trail keeps
 * everything a capability returned, untruncated, because an audit that drops
 * what it could not fit is not an audit. The model's context keeps only what
 * it can use, because the failure mode of unbounded growth is a provider
 * refusing the request — which arrives as a model error and reads, from the
 * outside, exactly like a GOAT that has stopped thinking.
 *
 * The most recent entries win: what a model needs to decide its next step is
 * what it just did, not the first thing it did five calls ago.
 */
function modelToolHistory(
  toolHistory: Array<{
    capability: string;
    input: unknown;
    result: unknown;
  }>,
): Array<{
  capability: string;
  input: unknown;
  result: unknown;
}> {
  return toolHistory
    .slice(-MAX_MODEL_TOOL_HISTORY)
    .map((entry) => ({
      capability: entry.capability,
      input: boundModelValue(entry.input),
      result: boundModelValue(entry.result),
    }));
}

/**
 * One value, small enough to send.
 *
 * Truncates by content rather than by structure: replacing a large array with
 * a count (as the audit summary does) would hide the very thing the model
 * called the capability to see.
 */
function boundModelValue(value: unknown): unknown {
  let text: string;

  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    /*
     * Not serialisable — circular, most likely. The value is returned as it
     * is: the capability's own provider will describe it, and inventing a size
     * for something we cannot measure would be a guess dressed as a fact.
     */
    return value;
  }

  if (text.length <= MAX_MODEL_TOOL_RESULT_CHARS) {
    return value;
  }

  return {
    truncated: true,
    characters: text.length,
    notice: `This result was ${text.length} characters and was cut to ${MAX_MODEL_TOOL_RESULT_CHARS} before being sent to the model. The complete value is in the audit trail.`,
    preview: text.slice(0, MAX_MODEL_TOOL_RESULT_CHARS),
  };
}
