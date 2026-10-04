/**
 * The GOAT domain.
 *
 * A `GoatDefinition` says what to accomplish, what it knows how to do,
 * and what it is allowed to risk. It does not say what to watch. The
 * observation plan is the agent's own output, constructed at runtime
 * through the Tracker SDK from whatever the agent decided it needed to
 * know, and retired with the thesis that produced it.
 *
 * That omission is the point, so the schema is written to make a
 * hand-authored observation plan impossible to express rather than
 * merely discouraged: there is no field for one, and an unknown field
 * is refused loudly instead of being ignored.
 */

import {
  AgentPolicy,
  ITradingEnvironment,
  TradingAgent,
  TradingEnvironmentMode,
} from '../agents/types';
import { skillRegistry, SkillRegistry } from '../agents/skills';
import { capabilityRegistry, CapabilityRegistry } from '../agents/capabilities';
import { DEFAULT_MODEL_ID } from '../../adapters/openrouter/catalogue';
import { GoatSkillRegistry } from './skills';
import {
  VENUE_ENVIRONMENTS,
  isVenueEnvironment,
  type VenueEnvironment,
} from '../../config/venue';

export const CURRENT_GOAT_SCHEMA_VERSION = 1;

/**
 * The complete set of fields a definition may carry.
 *
 * Maintained by hand and asserted by a test, because an allowlist that
 * drifts from the interface is worse than no allowlist: it would
 * quietly re-admit whatever it forgot to list.
 */
const GOAT_DEFINITION_FIELDS = new Set<keyof GoatDefinition>([
  'schemaVersion',
  'version',
  'source',
  'identity',
  'goal',
  'skills',
  'capabilities',
  'agentConfig',
  'riskPolicy',
  'createdAt',
  'updatedAt',
]);

/**
 * The model a GOAT definition names when it does not name one.
 *
 * Previously a hard-coded id that has since left OpenRouter's catalogue,
 * which meant every starter GOAT shipped pointing at a model that could
 * only ever answer 404. The value now comes from the adapter, which
 * reconciles it against the live catalogue — so a retired default is
 * replaced rather than requested.
 */
export const DEFAULT_AI_MODEL = DEFAULT_MODEL_ID;
export const DEFAULT_AI_PROVIDER = 'openrouter' as const;

/**
 * How much latitude the agent has.
 *
 * `advisory` proposes and never executes. `confirm` proposes and waits
 * for a human. `autonomous` may act within the deployment's execution
 * permissions. The mode narrows authority; it never widens it beyond
 * what the deployment granted.
 */
export type ReasoningMode = 'advisory' | 'confirm' | 'autonomous';

const REASONING_MODES: readonly ReasoningMode[] = ['advisory', 'confirm', 'autonomous'];

/**
 * What a GOAT is for, in the user's words.
 *
 * Deliberately free of method. A goal that names an indicator, a level
 * or a time window is a specification, and a specification is what the
 * user used to have to write before this architecture existed.
 */
export interface GoatGoal {
  /** The user's own words. Never rewritten by the agent. */
  statement: string;
  /**
   * Markets the goal is about.
   *
   * Empty means "not yet scoped", not "any market". A GOAT is deployed
   * to a market; the goal merely states whether the user had one in
   * mind, and the agent is free to disagree during investigation.
   */
  symbols: string[];
  /**
   * Markets the user explicitly excluded.
   *
   * Honoured even when the agent's reasoning would prefer one, because
   * a constraint the user wrote down is a constraint the user owns.
   */
  excludedSymbols: string[];
}

/**
 * A reference to a skill, plus the version it was resolved at.
 *
 * The version is what makes a historical decision auditable: a GOAT
 * that changed its mind is only explicable if the thinking behind the
 * earlier mind is still recoverable.
 */
export interface GoatSkillReference {
  id: string;
  version: number;
}

export interface GoatCapabilities {
  readMarketData: boolean;
  readHistoricalData: boolean;
  readAccount: boolean;
  readPositions: boolean;
  manageTrackers: boolean;
  manageThesis: boolean;
  proposeTrades: boolean;
  /**
   * Whether this GOAT may ever reach execution at all.
   *
   * Narrowed further by the deployment. Having `requestExecution` on a
   * reusable definition is meaningless on its own, and is deliberately
   * not sufficient to place an order.
   */
  requestExecution: boolean;
}

export interface RiskPolicy {
  /** Fraction of account equity allocated to risk per trade. */
  riskPerTrade: number;
  /** Optional absolute daily loss limit, in account currency. */
  maxDailyLoss?: number;
  /** Maximum drawdown before the GOAT stops proposing. */
  maxDrawdown?: number;
  /** Maximum simultaneous open positions. */
  maxPositions: number;
  /** Maximum total exposure, in account currency. */
  maxExposure: number;
  /** Minimum delay between eligible actions, in milliseconds. */
  cooldownMs: number;
  /**
   * Ceiling on concurrent active theses.
   *
   * An agent that can hold unlimited hypotheses can hold unlimited
   * trackers, and an agent that can hold unlimited trackers can keep
   * itself permanently awake. The ceiling is what stops that.
   */
  maxActiveTheses: number;
  /** Ceiling on concurrent active trackers. */
  maxActiveTrackers: number;
  /** Ceiling on agent wakeups per hour, across all theses. */
  maxWakeupsPerHour: number;
  /** Ceiling on tool calls per agentic cycle. */
  maxToolCallsPerCycle: number;
}

export interface AgentConfig {
  provider: typeof DEFAULT_AI_PROVIDER;
  model: string;
  reasoningMode: ReasoningMode;
  /** Below this the GOAT proposes nothing. Advisory, never a sizing input. */
  confidenceThreshold: number;
  /** Guidance appended to the agent's instructions, in the user's words. */
  decisionPolicy: string;
  /**
   * Hard ceiling on reasoning iterations per agentic cycle.
   *
   * Without it, a model that keeps requesting tools runs until it
   * happens to stop, and the cost of that is billed per call.
   */
  maxIterations: number;
}

/**
 * A GOAT: an objective, the skills to pursue it, and the authority it
 * operates under.
 *
 * Note what is absent. There is no tracker list, no indicator set, no
 * timeframe, no entry or exit rule, and no market. Every one of those
 * is either the agent's decision or the deployment's configuration.
 */
export interface GoatDefinition {
  schemaVersion: number;
  /**
   * Monotonic content version.
   *
   * A backtest references a specific version, and a version bump is
   * what marks a change to goal, skills, agent config or risk as
   * something a later run will not silently inherit.
   */
  version: number;
  source: GoatSource;

  identity: {
    id: string;
    name: string;
    description: string;
  };

  goal: GoatGoal;
  skills: GoatSkillReference[];

  /**
   * The agentic tool groups this GOAT may use.
   *
   * Granted to the agent, then intersected at runtime with the
   * capabilities its active skills contribute. Neither alone is
   * sufficient, which is why a definition cannot widen itself.
   */
  capabilities: GoatCapabilities;

  agentConfig: AgentConfig;
  riskPolicy: RiskPolicy;

  createdAt: number;
  updatedAt: number;
}

export type GoatSource = 'starter' | 'user' | 'cloned';

/**
 * Where a GOAT operates.
 *
 * A GOAT is created without a market. Deploying it to one is the act
 * that gives it something to investigate, and the deployment is where
 * execution authority lives.
 */
export interface GoatDeployment {
  id: string;
  goatId: string;
  /** The specific definition version this deployment was made against. */
  goatVersion: number;

  marketId: string;
  accountId: string;

  /**
   * Execution mode.
   *
   * `SHADOW` is first-class and not a synonym for paper: it runs on
   * real market data, produces real decisions, and executes nothing. It
   * is the mode a GOAT should be tried in before it is trusted with
   * anything.
   */
  mode: GoatDeploymentMode;

  /**
   * The venue environment this deployment is bound to.
   *
   * Recorded rather than assumed, because a deployment is a thing that
   * persists and a client's venue is a thing that can change underneath it.
   * Reading the environment off whatever adapter happens to be connected at
   * the moment of action means the answer to "which network was this
   * decided on?" depends on when you ask.
   *
   * Optional so deployments written before this field existed still load;
   * absent means unrecorded, not Testnet.
   */
  venueEnvironment?: VenueEnvironment;

  execution: ExecutionPermissions;

  /** Overrides layered on the definition's risk policy. */
  riskOverrides?: Partial<RiskPolicy>;

  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
}

export type GoatDeploymentMode = 'SHADOW' | 'PAPER' | 'DEMO' | 'LIVE';

const DEPLOYMENT_MODES: readonly GoatDeploymentMode[] = ['SHADOW', 'PAPER', 'DEMO', 'LIVE'];

export type DeploymentStatus = 'active' | 'paused' | 'stopped' | 'error';

/**
 * What this deployment is allowed to do to an account.
 *
 * Explicit and separate from the agent's reasoning. Producing a
 * decision never implies any of these; they are what decide whether a
 * decision may become an order.
 */
export interface ExecutionPermissions {
  canProposeTrades: boolean;
  /**
   * Whether proposals may be executed at all.
   *
   * A GOAT with a full tool set and no trading permission can research
   * indefinitely and act on nothing, which is a legitimate and useful
   * thing to want.
   */
  canExecute: boolean;
  allowedOrderTypes: Array<'MARKET' | 'LIMIT' | 'STOP'>;
  /** Hard cap on orders per day, independent of the risk policy. */
  maxOrdersPerDay?: number;
}

export class GoatValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid GOAT definition: ${problems.join('; ')}`);
    this.name = 'GoatValidationError';
    this.problems = problems;
  }
}

export interface GoatValidationDeps {
  skills?: SkillRegistry | GoatSkillRegistry;
  capabilities?: CapabilityRegistry;
}

/**
 * Validate a GOAT definition.
 *
 * Deterministic and total: every problem is reported, not just the
 * first, because a definition being fixed by hand is exactly the
 * friction this architecture exists to remove and a single error at a
 * time makes that worse.
 */
export function validateGoatDefinition(
  definition: unknown,
  deps: GoatValidationDeps = {},
): GoatDefinition {
  const problems: string[] = [];
  if (!isRecord(definition)) {
    throw new GoatValidationError(['definition must be an object']);
  }
  const d = definition as Partial<GoatDefinition>;

  /*
   * Unknown fields are refused, not ignored.
   *
   * Ignoring them would make a hand-authored observation plan a silent
   * no-op rather than a failure: someone could add a `trackers` array
   * back, watch validation pass, and conclude it worked. Naming the
   * offending field is the whole point — the check exists to make the
   * regression loud.
   */
  const unknownFields = Object.keys(definition).filter(
    (key) => !GOAT_DEFINITION_FIELDS.has(key as keyof GoatDefinition),
  );
  if (unknownFields.length > 0) {
    problems.push(
      `unknown field(s): ${unknownFields.join(', ')}. A GOAT definition states a goal, skills, capabilities, agent config and risk — it has no observation plan.`,
    );
  }

  if (typeof d.schemaVersion !== 'number' || !Number.isInteger(d.schemaVersion)) {
    problems.push('schemaVersion must be an integer');
  } else if (d.schemaVersion > CURRENT_GOAT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion ${d.schemaVersion} is newer than the supported version ${CURRENT_GOAT_SCHEMA_VERSION}`,
    );
  }
  if (!Number.isInteger(d.version) || (d.version as number) < 1) {
    problems.push('version must be a positive integer');
  }
  if (d.source !== 'starter' && d.source !== 'user' && d.source !== 'cloned') {
    problems.push('source must be starter, user or cloned');
  }

  if (!isRecord(d.identity) || typeof d.identity.id !== 'string' || !d.identity.id) {
    problems.push('identity.id is required');
  }
  if (!isRecord(d.identity) || typeof d.identity.name !== 'string' || !d.identity.name) {
    problems.push('identity.name is required');
  }

  if (!isRecord(d.goal) || typeof d.goal.statement !== 'string' || !d.goal.statement.trim()) {
    problems.push('goal.statement is required');
  } else if (isMethodInStatement(d.goal.statement)) {
    /*
     * The one place the goal is inspected rather than trusted.
     *
     * A goal naming a specific indicator, level or alert is a
     * specification the user is being asked to write, which is the
     * workflow being replaced. It is a warning rather than a hard
     * refusal, because "buy EURUSD when RSI drops below 30" is a
     * perfectly reasonable thing to want and the agent can absolutely
     * pursue it — the user just has to know they could have said what
     * they wanted instead of how to detect it.
     */
    problems.push(
      'goal.statement names a specific method (indicator, level or alert). State the outcome you want and let the GOAT work out how to detect it.',
    );
  }
  if (isRecord(d.goal) && !Array.isArray(d.goal.symbols)) {
    problems.push('goal.symbols must be an array');
  }
  if (isRecord(d.goal) && !Array.isArray(d.goal.excludedSymbols)) {
    problems.push('goal.excludedSymbols must be an array');
  }

  const skills = deps.skills ?? skillRegistry;
  if (!Array.isArray(d.skills) || d.skills.length === 0) {
    problems.push('at least one skill is required');
  } else {
    const seen = new Set<string>();
    for (const reference of d.skills) {
      if (!isRecord(reference) || typeof reference.id !== 'string') {
        problems.push('each skill must be an object with an id');
        continue;
      }
      if (seen.has(reference.id)) problems.push(`skill "${reference.id}" is listed twice`);
      seen.add(reference.id);
      if (!Number.isInteger(reference.version) || (reference.version as number) < 1) {
        problems.push(`skill "${reference.id}" needs a positive integer version`);
      }
      const skill = skills.get(reference.id);
      if (!skill) {
        problems.push(`skill "${reference.id}" is not registered`);
      } else if (!skill.enabled) {
        problems.push(`skill "${reference.id}" is disabled`);
      }
    }
  }

  if (!isRecord(d.capabilities)) {
    problems.push('capabilities is required');
  } else {
    for (const [key, value] of Object.entries(d.capabilities)) {
      if (typeof value !== 'boolean') problems.push(`capabilities.${key} must be a boolean`);
    }
  }

  if (!isRecord(d.agentConfig)) {
    problems.push('agentConfig is required');
  } else {
    if (d.agentConfig.provider !== 'openrouter') {
      problems.push('agentConfig.provider must be openrouter');
    }
    if (typeof d.agentConfig.model !== 'string' || !d.agentConfig.model) {
      problems.push('agentConfig.model is required');
    }
    if (!REASONING_MODES.includes(d.agentConfig.reasoningMode)) {
      problems.push(`agentConfig.reasoningMode must be one of ${REASONING_MODES.join(', ')}`);
    }
    if (
      typeof d.agentConfig.confidenceThreshold !== 'number' ||
      d.agentConfig.confidenceThreshold < 0 ||
      d.agentConfig.confidenceThreshold > 1
    ) {
      problems.push('agentConfig.confidenceThreshold must be within [0, 1]');
    }
    if (typeof d.agentConfig.decisionPolicy !== 'string') {
      problems.push('agentConfig.decisionPolicy must be a string');
    }
    if (!Number.isInteger(d.agentConfig.maxIterations) || d.agentConfig.maxIterations < 1) {
      problems.push('agentConfig.maxIterations must be a positive integer');
    }
  }

  problems.push(...validateRiskPolicy(d.riskPolicy));

  if (!Number.isFinite(d.createdAt) || !Number.isFinite(d.updatedAt)) {
    problems.push('createdAt and updatedAt must be finite timestamps');
  }

  if (problems.length > 0) throw new GoatValidationError(problems);
  return cloneGoatDefinition(d as GoatDefinition);
}

function validateRiskPolicy(risk: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(risk)) return ['riskPolicy is required'];
  const r = risk as Partial<RiskPolicy>;

  if (typeof r.riskPerTrade !== 'number' || r.riskPerTrade <= 0 || r.riskPerTrade > 1) {
    problems.push('riskPolicy.riskPerTrade must be within (0, 1]');
  }
  if (r.maxDailyLoss !== undefined && (!Number.isFinite(r.maxDailyLoss) || r.maxDailyLoss <= 0)) {
    problems.push('riskPolicy.maxDailyLoss must be a positive number when set');
  }
  if (r.maxDrawdown !== undefined && (typeof r.maxDrawdown !== 'number' || r.maxDrawdown <= 0 || r.maxDrawdown > 1)) {
    problems.push('riskPolicy.maxDrawdown must be within (0, 1] when set');
  }
  if (!Number.isInteger(r.maxPositions) || (r.maxPositions as number) < 1) {
    problems.push('riskPolicy.maxPositions must be a positive integer');
  }
  if (typeof r.maxExposure !== 'number' || r.maxExposure <= 0) {
    problems.push('riskPolicy.maxExposure must be a positive number');
  }
  if (!Number.isFinite(r.cooldownMs) || (r.cooldownMs as number) < 0) {
    problems.push('riskPolicy.cooldownMs must be a non-negative number');
  }
  for (const key of ['maxActiveTheses', 'maxActiveTrackers', 'maxWakeupsPerHour', 'maxToolCallsPerCycle'] as const) {
    if (!Number.isInteger(r[key]) || (r[key] as number) < 1) {
      problems.push(`riskPolicy.${key} must be a positive integer`);
    }
  }
  return problems;
}

/**
 * Terms that mean the user wrote a specification rather than a goal.
 *
 * A heuristic, not a rule, and it is reported as a problem rather than
 * thrown away, so the user sees their own words and can decide.
 */
function isMethodInStatement(statement: string): boolean {
  const text = statement.toLowerCase();
  const methodTerms = [
    /\bwhen\s+(rsi|ema|sma|macd|atr|adx)\b/,
    /\b(rsi|ema|sma|macd|atr|adx)\s*(cross|above|below|greater|less)\b/,
    /\bwhen\s+price\s+(is\s+)?(above|below|crosses)\b/,
    /\b(alert|notify|notification)\b/,
    /\bcondition\s+(when|is)\b/,
  ];
  return methodTerms.some((pattern) => pattern.test(text));
}

export function validateGoatDeployment(
  deployment: unknown,
  definition?: GoatDefinition,
): GoatDeployment {
  const problems: string[] = [];
  if (!isRecord(deployment)) throw new GoatValidationError(['deployment must be an object']);
  const d = deployment as Partial<GoatDeployment>;

  if (typeof d.id !== 'string' || !d.id) problems.push('deployment.id is required');
  if (typeof d.goatId !== 'string' || !d.goatId) problems.push('deployment.goatId is required');
  if (!Number.isInteger(d.goatVersion) || (d.goatVersion as number) < 1) {
    problems.push('deployment.goatVersion must be a positive integer');
  }
  if (typeof d.marketId !== 'string' || !d.marketId) {
    problems.push('deployment.marketId is required — a GOAT is deployed to a market');
  }
  if (typeof d.accountId !== 'string' || !d.accountId) problems.push('deployment.accountId is required');
  if (!DEPLOYMENT_MODES.includes(d.mode as GoatDeploymentMode)) {
    problems.push(`deployment.mode must be one of ${DEPLOYMENT_MODES.join(', ')}`);
  }
  if (d.venueEnvironment !== undefined && !isVenueEnvironment(d.venueEnvironment)) {
    problems.push(`deployment.venueEnvironment must be one of ${VENUE_ENVIRONMENTS.join(', ')}`);
  }
  /*
   * A LIVE deployment is refused rather than accepted and ignored.
   *
   * `LIVE` used to be a mode this application accepted, which set
   * `canExecute: true` on a deployment that had no signing path behind it:
   * a label promising something the product cannot do. Refusing it here
   * means the day a signing service exists, this line has to be removed
   * deliberately — with its tests — instead of LIVE quietly becoming real
   * because someone built the other half.
   */
  if ((d.mode as GoatDeploymentMode) === 'LIVE') {
    problems.push(
      'deployment.mode cannot be LIVE: there is no order-signing service, so a LIVE deployment would be a promise this application cannot keep. Use SHADOW to run on real data and execute nothing, or DEMO to trade simulated fills.',
    );
  }

  if (!isRecord(d.execution)) {
    problems.push('deployment.execution is required');
  } else {
    if (typeof d.execution.canProposeTrades !== 'boolean') {
      problems.push('execution.canProposeTrades must be a boolean');
    }
    if (typeof d.execution.canExecute !== 'boolean') {
      problems.push('execution.canExecute must be a boolean');
    }
    if (!Array.isArray(d.execution.allowedOrderTypes) || d.execution.allowedOrderTypes.length === 0) {
      problems.push('execution.allowedOrderTypes must be a non-empty array');
    } else {
      for (const type of d.execution.allowedOrderTypes) {
        if (!['MARKET', 'LIMIT', 'STOP'].includes(type)) {
          problems.push(`execution.allowedOrderTypes contains an unknown order type: ${String(type)}`);
        }
      }
    }
    if (d.execution.maxOrdersPerDay !== undefined && !Number.isInteger(d.execution.maxOrdersPerDay)) {
      problems.push('execution.maxOrdersPerDay must be an integer when set');
    }
  }

  /*
   * A GOAT that can propose but not execute is normal. A GOAT that
   * cannot propose but can execute is not a thing: it would be an
   * account with a reason to trade but no way to reach the decision.
   */
  if (isRecord(d.execution) && d.execution.canExecute === true && d.execution.canProposeTrades === false) {
    problems.push('a deployment cannot execute without being able to propose');
  }

  /*
   * Nothing may be granted to a deployment that its definition did not
   * already allow. Otherwise a definition could be authored as harmless
   * and a deployment could make it dangerous, which puts the real
   * authority in the place nobody reviews.
   */
  if (definition && isRecord(d.execution)) {
    if (d.execution.canProposeTrades === true && definition.capabilities.proposeTrades === false) {
      problems.push('deployment cannot propose trades: the GOAT definition does not permit it');
    }
    if (d.execution.canExecute === true && definition.capabilities.requestExecution === false) {
      problems.push('deployment cannot execute: the GOAT definition does not request execution');
    }
  }

  if (d.status !== 'active' && d.status !== 'paused' && d.status !== 'stopped' && d.status !== 'error') {
    problems.push('deployment.status must be active, paused, stopped or error');
  }
  if (!Number.isFinite(d.createdAt) || !Number.isFinite(d.updatedAt)) {
    problems.push('deployment timestamps must be finite');
  }

  if (problems.length > 0) throw new GoatValidationError(problems);
  return structuredClone(d as GoatDeployment);
}

export function createGoatDeployment(
  input: Omit<GoatDeployment, 'id' | 'status' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    status?: DeploymentStatus;
    createdAt: number;
  },
): GoatDeployment {
  const deployment: GoatDeployment = {
    ...input,
    id: input.id ?? `dep_${input.createdAt.toString(36)}_${input.goatId}`,
    status: input.status ?? 'active',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return validateGoatDeployment(deployment);
}

export function cloneGoatDefinition(definition: GoatDefinition): GoatDefinition {
  return structuredClone(definition);
}

/**
 * Move a definition to the current schema.
 *
 * A migration exists so stored definitions survive a schema change, not
 * so an old shape keeps working. There is no compatibility mode: an
 * unmigratable definition is refused rather than coerced, because a
 * definition silently reinterpreted is a GOAT that quietly stopped
 * doing what the user asked.
 */
export function migrateGoatDefinition(value: unknown): GoatDefinition {
  if (!isRecord(value)) throw new GoatValidationError(['definition must be an object']);
  const raw = value.schemaVersion as number;
  if (!Number.isInteger(raw)) {
    throw new GoatValidationError(['definition has no schemaVersion and cannot be migrated']);
  }
  if (raw > CURRENT_GOAT_SCHEMA_VERSION) {
    throw new GoatValidationError([
      `definition schemaVersion ${String(raw)} is newer than supported ${CURRENT_GOAT_SCHEMA_VERSION}`,
    ]);
  }
  return validateGoatDefinition(value);
}

export interface CompileGoatOptions {
  marketSymbol: string;
  deployment: GoatDeployment;
  definition: GoatDefinition;
  env: ITradingEnvironment;
  skills?: GoatSkillRegistry;
  capabilities?: CapabilityRegistry;
}

/**
 * Build the runtime agent that executes a GOAT.
 *
 * The agent is the *executor* of a goal, not the goal itself, and it is
 * given no observation plan. Its capabilities are the intersection of
 * what the definition asks for, what the active skills grant, and what
 * is actually registered — an intersection, so this function can only
 * ever narrow authority.
 *
 * The agent has no timeframe. Which timeframes it watches is decided
 * per tracker, from whatever the investigation needs, rather than fixed
 * once at creation.
 */
export function compileGoatDefinition(options: CompileGoatOptions): TradingAgent {
  const { definition, deployment, marketSymbol } = options;
  const runtimeSkills = options.skills;
  const capabilities = options.capabilities ?? capabilityRegistry;

  const skillCapabilities = runtimeSkills
    ? runtimeSkills.resolveCapabilities(definition.skills.map((s) => s.id))
    : skillRegistry.resolveCapabilities(definition.skills.map((s) => s.id));

  const requested = requestedCapabilities(definition);

  const agentCapabilities = requested.filter(
    (id) => skillCapabilities.includes(id) && capabilities.has(id),
  );

  const risk = applyRiskOverrides(definition.riskPolicy, deployment.riskOverrides);

  const policy: AgentPolicy = {
    maxRiskPerTrade: risk.riskPerTrade,
    maxDailyLoss: risk.maxDailyLoss,
    maxDrawdown: risk.maxDrawdown,
    maxOpenPositions: risk.maxPositions,
    maxExposure: risk.maxExposure,
    maxOrdersPerMinute: 10,
    allowedSymbols: [marketSymbol],
    /*
     * Permission, not autonomy.
     *
     * `allowTrading` answers one question: is this deployment allowed
     * to reach execution at all? It is the AND of the deployment's
     * grant, the definition's request, and a mode that can execute. The
     * reasoning mode is deliberately absent.
     *
     * It was a real defect to gate permission on a reasoning hint. The
     * interface would say "automation on" while every order came back
     * TRADING_DISABLED, because the hint defaulted to advisory and was
     * hidden behind an advanced toggle. So a hint that reads as
     * advice must not be able to revoke or grant permission.
     *
     * Autonomy is enforced separately, in the agentic loop: a GOAT
     * below `autonomous` may reach the same permission and still
     * declines to act on its own. Two gates, neither able to impersonate
     * the other.
     *
     * SHADOW and PAPER are excluded explicitly rather than by omission.
     * A shadow deployment runs on real data and produces real
     * decisions, so every other gate passes for it and the mode itself
     * is the only thing between a research GOAT and the order path.
     */
    allowTrading:
      deployment.mode !== 'SHADOW' &&
      deployment.mode !== 'PAPER' &&
      deployment.execution.canExecute &&
      definition.capabilities.requestExecution,
  };

  return {
    id: `${definition.identity.id}:${deployment.id}`,
    name: definition.identity.name,
    description: definition.identity.description,
    instructions: buildInstructions(definition, deployment),
    skills: definition.skills.map((s) => s.id),
    capabilities: agentCapabilities,
    policy,
    preferredEnvironment: deploymentModeToEnvironment(deployment.mode),
    symbols: [marketSymbol],
    // No timeframe. The agent picks per tracker.
    timeframe: undefined,
    enabled: deployment.status === 'active',
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    ai: { provider: definition.agentConfig.provider, model: definition.agentConfig.model },
  };
}

/** The capability ids a definition's tool groups correspond to. */
function requestedCapabilities(definition: GoatDefinition): string[] {
  const requested: string[] = [];
  if (definition.capabilities.readMarketData) {
    requested.push('market.getQuote', 'market.getBars', 'market.getSpread', 'market.getSession');
  }
  if (definition.capabilities.readHistoricalData) {
    requested.push('market.getBars', 'indicators.sma', 'indicators.ema', 'indicators.rsi', 'indicators.atr');
  }
  if (definition.capabilities.readAccount) {
    requested.push('account.getBalance', 'account.getEquity', 'account.getMargin', 'account.getExposure');
  }
  if (definition.capabilities.readPositions) {
    requested.push('account.getPositions', 'account.getOrders');
  }
  if (definition.capabilities.manageTrackers) {
    requested.push(
      'trackers.create',
      'trackers.update',
      'trackers.pause',
      'trackers.resume',
      'trackers.cancel',
      'trackers.inspect',
    );
  }
  if (definition.capabilities.manageThesis) {
    requested.push('thesis.read', 'thesis.update', 'evidence.read');
  }
  if (definition.capabilities.proposeTrades) {
    requested.push('trades.proposeIdea', 'risk.calculateRisk', 'risk.checkTrade');
  }
  if (definition.capabilities.requestExecution) {
    requested.push('orders.market', 'orders.limit');
  }
  return requested;
}

function applyRiskOverrides(
  risk: RiskPolicy,
  overrides?: Partial<RiskPolicy>,
): RiskPolicy {
  if (!overrides) return { ...risk };
  return { ...risk, ...overrides };
}

export function deploymentModeToEnvironment(mode: GoatDeploymentMode): TradingEnvironmentMode {
  switch (mode) {
    case 'SHADOW':
    case 'PAPER':
      return 'BACKTEST';
    case 'DEMO':
      return 'DEMO';
    case 'LIVE':
      return 'LIVE';
    default:
      return 'DEMO';
  }
}

function buildInstructions(definition: GoatDefinition, deployment: GoatDeployment): string {
  return [
    `Goal: ${definition.goal.statement}`,
    '',
    'You do not poll the market. You deploy trackers, then stop. A tracker',
    'waking you is a fact, not a signal, and you decide what it means for',
    'the thesis every time.',
    '',
    'Before proposing anything, state the condition under which your',
    'hypothesis is wrong. If you cannot, you do not have a hypothesis yet.',
    '',
    `Reasoning mode: ${definition.agentConfig.reasoningMode}.`,
    definition.agentConfig.decisionPolicy,
    deployment.execution.canExecute
      ? 'You may propose trades. Every proposal is validated before execution.'
      : 'You may research and propose. This deployment cannot execute anything.',
  ]
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
