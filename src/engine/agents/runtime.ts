import {
  AgentActionValidationResult,
  AgentAuditRecord,
  AgentDecision,
  AgentObservation,
  AgentWakeEvent,
  ITradingEnvironment,
  TradingAgent,
} from './types';
import { capabilityRegistry, CapabilityRegistry } from './capabilities';
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
}

export class AgentRuntime {
  private instances: Map<string, AgentInstance> = new Map();
  private auditLog: AgentAuditRecord[] = [];
  private maxAuditEntries: number = 200;
  private activeCycles: Set<string> = new Set();
  private timelineSequence = 0;

  private readonly positionCorrelations = new Map<
    string,
    { agentId: string; trackerId?: string; correlationId: string }
  >();

  constructor(
    private capabilities: CapabilityRegistry = capabilityRegistry,
    private skills: SkillRegistry = skillRegistry,
    private validator: ActionValidator = actionValidator,
    private model: IAgentModel = agentModel,
    private timeline: AgentTimelineStore = new InMemoryAgentTimelineStore()
  ) {
    eventBus.on('POSITION_UPDATE', (event) => {
      void this.recordPositionEvent(
        event.data.id,
        'UPDATED',
        event.data
      );
    });

    eventBus.on('POSITION_CLOSE', (event) => {
      void this.recordPositionEvent(
        event.data.position.id,
        'CLOSED',
        {
          position: event.data.position,
          tradeId: event.data.trade.id,
        }
      );
    });
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
   * The tracker runtime keeps its own memory keyed by agent, so the
   * caller retires that too — otherwise a redeployed GOAT would inherit
   * the previous market's "already reported" state and stay silent.
   */
  unregisterAgent(agentId: string): boolean {
    const instance = this.instances.get(agentId);
    if (!instance) return false;
    instance.isRunning = false;
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

    instance.isRunning = false;

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
        message: `Trading Agent "${instance.agent.name}" STOPPED.`,
        timestamp: Date.now(),
      },
    });
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const instance = this.instances.get(agentId);

    if (!instance) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const symbol = instance.agent.symbols[0] || 'EURUSD';

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

    this.activeCycles.add(agentId);

    try {
      return await this.runStep(agentId, instance, event);
    } finally {
      this.activeCycles.delete(agentId);
    }
  }

  private async runStep(
    agentId: string,
    instance: AgentInstance,
    event?: AgentWakeEvent
  ): Promise<AgentDecision> {
    const wakeEvent: AgentWakeEvent =
      event || {
        type: 'MANUAL_WAKE',
        timestamp: Date.now(),
        symbol: instance.agent.symbols[0],
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
          toolHistory,
          capabilitySchemas: instance.allowedCapabilities.flatMap(
            (id) => {
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
            }
          ),
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

        if (!instance.allowedCapabilities.includes(capId)) {
          toolHistory.push({
            capability: capId,
            input: sanitizeAuditValue(input),
            result: {
              error: `Permission denied: Capability "${capId}" not assigned to agent skills.`,
            },
            durationMs: 0,
          });

          continue;
        }

        const capability = this.capabilities.get(capId);

        const toolObservation =
          capability?.category === 'execution'
            ? await this.observe(agentId)
            : observation;

        const executionPolicyResult =
          capability?.category === 'execution'
            ? await this.validateExecutionTool(
                instance,
                toolObservation,
                capId,
                input
              )
            : undefined;

        if (
          executionPolicyResult &&
          !executionPolicyResult.valid
        ) {
          toolHistory.push({
            capability: capId,
            input: sanitizeAuditValue(input),
            result: {
              status: 'REJECTED',
              reason: executionPolicyResult.reason,
            },
            durationMs: 0,
          });

          await this.appendTimeline({
            agentId,
            timestamp: await this.nowFor(instance),
            type: 'RISK_CHECK',
            environment: instance.env.mode,
            trackerId,
            correlationId,
            data: {
              status: 'REJECTED',
              reason: executionPolicyResult.reason,
              capability: capId,
            },
          });

          continue;
        }

        eventBus.emit({
          type: 'AGENT_TOOL_REQUESTED',
          data: {
            agentId,
            capability: capId,
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
          data: {
            capability: capId,
            input: summarize(input),
          },
        });

        const startMs = Date.now();

        let toolResult: unknown;

        try {
          toolResult =
            await this.capabilities.execute(
              capId,
              input,
              {
                agentId,
                environment: instance.env.mode,
                env: instance.env,
                symbol:
                  toolObservation.market.quote?.symbol ||
                  instance.agent.symbols[0],
                timeframe: instance.agent.timeframe,
                policy: instance.agent.policy,
                symbols: instance.agent.symbols,
              }
            );
        } catch (err: unknown) {
          toolResult = {
            error:
              err instanceof Error
                ? err.message
                : String(err),
          };
        }

        const durationMs =
          instance.env.mode === 'BACKTEST'
            ? Math.max(
                0,
                (await this.nowFor(instance)) -
                  startMs
              )
            : Date.now() - startMs;

        toolHistory.push({
          capability: capId,
          input: sanitizeAuditValue(input),
          result: sanitizeAuditValue(toolResult),
          durationMs,
        });

        eventBus.emit({
          type: 'AGENT_TOOL_RESULT',
          data: {
            agentId,
            capability: capId,
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
          data: {
            capability: capId,
            result: summarize(toolResult),
            durationMs,
            success: !isErrorResult(toolResult),
          },
        });

        if (isErrorResult(toolResult)) {
          await this.appendTimeline({
            agentId,
            timestamp: await this.nowFor(instance),
            type: 'ERROR',
            environment: instance.env.mode,
            trackerId,
            correlationId,
            data: {
              code: 'CAPABILITY_ERROR',
              capability: capId,
              message: toolResult.error,
            },
          });
        }

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

          if (
            !instance.allowedCapabilities.includes(
              capId
            ) ||
            !this.capabilities.has(capId)
          ) {
            toolHistory.push({
              capability: capId,
              input,
              result: {
                error:
                  'Capability is not allowed for this agent.',
              },
              durationMs: 0,
            });

            continue;
          }

          try {
            const result =
              await this.capabilities.execute(
                capId,
                input,
                {
                  agentId,
                  environment: instance.env.mode,
                  env: instance.env,
                  symbol:
                    observation.market.quote?.symbol ||
                    instance.agent.symbols[0],
                  timeframe:
                    instance.agent.timeframe,
                  policy: instance.agent.policy,
                  symbols: instance.agent.symbols,
                }
              );

            toolHistory.push({
              capability: capId,
              input: sanitizeAuditValue(input),
              result: sanitizeAuditValue(result),
              durationMs: 0,
            });
          } catch (error: unknown) {
            toolHistory.push({
              capability: capId,
              input: sanitizeAuditValue(input),
              result: {
                error:
                  error instanceof Error
                    ? error.message
                    : String(error),
              },
              durationMs: 0,
            });
          }

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
     * Execute only after all policy and risk checks pass.
     */
    if (
      validation.valid &&
      validation.code === 'APPROVED'
    ) {
      try {
        if (
          finalDecision.type === 'OPEN_POSITION'
        ) {
          executionResult =
            await instance.env.placeMarketOrder({
              symbol: finalDecision.symbol,
              side: finalDecision.side,
              volume: finalDecision.volume,
              stopLoss: finalDecision.stopLoss,
              takeProfit: finalDecision.takeProfit,
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

          const executionRecord =
            isRecord(executionResult)
              ? executionResult
              : {};

          await this.appendTimeline({
            agentId,
            timestamp:
              await this.nowFor(instance),
            type: 'ORDER',
            environment: instance.env.mode,
            trackerId,
            correlationId,
            orderId:
              typeof executionRecord.orderId ===
              'string'
                ? executionRecord.orderId
                : undefined,
            positionId:
              typeof executionRecord.positionId ===
              'string'
                ? executionRecord.positionId
                : undefined,
            data: {
              status:
                executionRecord.success === true
                  ? 'SUBMITTED'
                  : 'REJECTED',
              symbol: finalDecision.symbol,
              side: finalDecision.side,
              volume: finalDecision.volume,
              stopLoss: finalDecision.stopLoss,
              takeProfit: finalDecision.takeProfit,
              rejection:
                isRecord(executionRecord.rejection)
                  ? executionRecord.rejection
                  : undefined,
              result:
                sanitizeAuditValue(
                  executionResult
                ),
            },
          });

          if (
            isSuccessfulExecution(
              executionResult
            )
          ) {
            if (
              typeof executionRecord.positionId ===
              'string'
            ) {
              this.positionCorrelations.set(
                executionRecord.positionId,
                {
                  agentId,
                  trackerId,
                  correlationId,
                }
              );

              await this.appendTimeline({
                agentId,
                timestamp:
                  await this.nowFor(instance),
                type: 'POSITION_UPDATE',
                environment: instance.env.mode,
                trackerId,
                correlationId,
                positionId:
                  executionRecord.positionId,
                data: {
                  status: 'OPENED',
                  result:
                    sanitizeAuditValue(
                      executionResult
                    ),
                },
              });
            }

            eventBus.emit({
              type: 'AGENT_ORDER_FILLED',
              data: {
                agentId,
                result: executionResult,
                symbol:
                  finalDecision.type ===
                  'OPEN_POSITION'
                    ? finalDecision.symbol
                    : undefined,
                orderId:
                  typeof executionRecord.orderId ===
                  'string'
                    ? executionRecord.orderId
                    : undefined,
                positionId:
                  typeof executionRecord.positionId ===
                  'string'
                    ? executionRecord.positionId
                    : undefined,
                timestamp: Date.now(),
              },
            });
          }
        } else if (
          finalDecision.type ===
          'MODIFY_POSITION'
        ) {
          executionResult =
            await instance.env.modifyPosition(
              finalDecision.positionId,
              finalDecision.changes
            );
        } else if (
          finalDecision.type ===
          'CLOSE_POSITION'
        ) {
          executionResult =
            await instance.env.closePosition(
              finalDecision.positionId
            );
        }

        if (
          isRecord(executionResult) &&
          executionResult.success === false &&
          typeof executionResult.error === 'string'
        ) {
          cycleError =
            executionResult.error;
        }
      } catch (error: unknown) {
        cycleError =
          error instanceof Error
            ? error.message
            : String(error);

        executionResult = {
          success: false,
          error: cycleError,
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
          timestamp:
            await this.nowFor(instance),
          type: 'ERROR',
          environment: instance.env.mode,
          trackerId,
          correlationId,
          data: {
            code: 'EXECUTION_ERROR',
            message: cycleError,
          },
        });
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
        status: validation.valid
          ? 'APPROVED'
          : 'REJECTED',
        reason: validation.reason,
        executionResult:
          sanitizeAuditValue(
            executionResult
          ),
      }
    );

    /*
     * Record audit trail.
     */
    const auditRecord: AgentAuditRecord = {
      id: `audit_${Date.now()}_${this.auditLog.length}`,
      agentId,
      timestamp: Date.now(),
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

    if (finalDecision.type !== 'WAIT') {
      if (validation.valid) {
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
            reason: validation.reason,
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
      data: {
        decision:
          sanitizeAuditValue(finalDecision),
        reason: finalDecision.reason,
        skillsUsed:
          auditRecord.skillsUsed,
        validation,
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

  private async nowFor(
    instance: AgentInstance
  ): Promise<number> {
    return instance.env.mode === 'BACKTEST'
      ? (
          await instance.env.getMarketQuote(
            instance.agent.symbols[0] ||
              'EURUSD'
          )
        ).timestamp
      : Date.now();
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
      await this.recordPositionEvent(
        position.id,
        'CLOSED',
        {
          position,
          tradeId: undefined,
        }
      );
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

  private async validateExecutionTool(
    instance: AgentInstance,
    observation: AgentObservation,
    capability: string,
    input: Record<string, unknown>
  ): Promise<AgentActionValidationResult> {
    if (capability === 'orders.market') {
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

    if (
      capability === 'positions.close' ||
      capability === 'positions.partialClose'
    ) {
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

      if (
        capability ===
          'positions.partialClose' &&
        (
          typeof input.volumeToClose !==
            'number' ||
          !Number.isFinite(
            input.volumeToClose
          ) ||
          input.volumeToClose <= 0 ||
          input.volumeToClose >
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

    if (
      capability ===
        'positions.modifyStopLoss' ||
      capability ===
        'positions.modifyTakeProfit'
    ) {
      const changes =
        capability ===
        'positions.modifyStopLoss'
          ? {
              stopLoss:
                typeof input.stopLoss ===
                'number'
                  ? input.stopLoss
                  : undefined,
            }
          : {
              takeProfit:
                typeof input.takeProfit ===
                'number'
                  ? input.takeProfit
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

    if (
      capability === 'orders.limit' ||
      capability === 'orders.cancel'
    ) {
      return {
        valid: false,
        code: 'INVALID_PARAMS',
        reason:
          `${capability} is not supported by the configured environment execution contract.`,
      };
    }

    return {
      valid: false,
      code: 'UNKNOWN_CAPABILITY',
      reason:
        'Unsupported execution capability.',
    };
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

/*
 * Important: this is a TypeScript type guard,
 * not just a boolean helper. This allows callers
 * to safely access value.error after checking it.
 */
function isErrorResult(
  value: unknown
): value is { error: string } {
  return (
    isRecord(value) &&
    typeof value.error === 'string'
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
  observation: AgentObservation,
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
