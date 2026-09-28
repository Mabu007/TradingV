import { AgentPolicy, TradingAgent, TradingEnvironmentMode } from './types';
import { AgentTrigger, TriggerType } from './triggers/types';
import { SkillRegistry, skillRegistry } from './skills/registry';
import { CapabilityRegistry, capabilityRegistry } from './capabilities';

/**
 * BotDefinition
 * -------------
 * Canonical, reusable description of a TradingVibe AI trading bot.
 *
 * Important:
 * - Bots are asset-agnostic.
 * - Markets are selected through Deployment.
 * - AI configuration belongs to the bot.
 * - API credentials NEVER belong in BotDefinition.
 * - Triggers wake the agent; they do not directly execute trades.
 */

export const CURRENT_BOT_SCHEMA_VERSION = 2;

export const DEFAULT_AI_MODEL = 'inclusionai/ling-3.0-flash-fin:free';
export const DEFAULT_AI_PROVIDER = 'openrouter' as const;

export const DEFAULT_AI_CONFIG: BotAI = {
  provider: DEFAULT_AI_PROVIDER,
  model: DEFAULT_AI_MODEL,
  reasoningMode: 'advisory',
  confidenceThreshold: 0.7,
  decisionPolicy:
    'Investigate each trigger with available skills and WAIT when evidence is unclear.',
};

export type ReasoningMode =
  | 'autonomous'
  | 'confirm'
  | 'advisory'
  | 'strict';

export type BotDeploymentMode = 'paper' | 'demo' | 'live';

export type DeploymentStatus =
  | 'active'
  | 'paused'
  | 'stopped'
  | 'error';

export type BotSource = 'explorer' | 'user' | 'cloned';

const SUPPORTED_TRIGGER_TYPES: readonly TriggerType[] = [
  'NEW_BAR',
  'PRICE_CROSS',
  'PRICE_THRESHOLD',
  'INDICATOR_CROSS',
  'BREAKOUT',
  'RISK_STATE_CHANGED',
  'POSITION_OPEN',
  'POSITION_CLOSE',
  'SPREAD_CHANGE',
  'VOLATILITY_CHANGE',
  'POSITION_UPDATE',
  'ORDER_FILLED',
  'STOP_APPROACHING',
  'TARGET_APPROACHING',
  'SESSION_START',
  'SESSION_END',
  'SCHEDULED',
];

const SKILL_GROUPS: readonly (keyof BotSkills)[] = [
  'marketAnalysis',
  'indicators',
  'patterns',
  'context',
];

const REASONING_MODES: readonly ReasoningMode[] = [
  'autonomous',
  'confirm',
  'advisory',
  'strict',
];

const DEPLOYMENT_MODES: readonly BotDeploymentMode[] = [
  'paper',
  'demo',
  'live',
];

const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'active',
  'paused',
  'stopped',
  'error',
];

const ORDER_TYPES = ['market', 'limit', 'either'] as const;

export interface BotIntent {
  objective: string;
  longBias: string;
  shortBias: string;
  guidance: string[];
}

export interface BotSkills {
  marketAnalysis: string[];
  indicators: string[];
  patterns: string[];
  context: string[];
}

export interface BotCapabilities {
  marketData: boolean;
  accountData: boolean;
  orders: boolean;
  positions: boolean;
  automation: boolean;
}

export interface BotRisk {
  /** Fraction of account equity/balance allocated to risk per trade. */
  riskPerTrade: number;

  /** Optional absolute daily loss limit. */
  maxDailyLoss?: number;

  /** Maximum simultaneous open positions. */
  maxPositions: number;

  /** Maximum total exposure. */
  maxExposure: number;

  /** Minimum delay between eligible bot actions, in milliseconds. */
  cooldown: number;
}

export interface BotExecution {
  orderType: 'market' | 'limit' | 'either';

  /** Maximum tolerated slippage, expressed in the execution layer's units. */
  slippage?: number;

  /** Human-readable deterministic execution constraints. */
  executionRules: string[];
}

export interface BotAI {
  provider: 'openrouter';
  model: string;
  reasoningMode: ReasoningMode;
  confidenceThreshold: number;
  decisionPolicy: string;
}

/**
 * A bot trigger intentionally has no fixed symbol.
 *
 * The runtime resolves the deployed market into the adapter's runtime symbol.
 */
export type BotTrigger = Omit<
  AgentTrigger,
  'agentId' | 'symbol'
> & {
  symbol?: never;
};

export interface BotDefinition {
  schemaVersion: number;
  source: BotSource;
  sourceBotId?: string;

  identity: {
    id: string;
    name: string;
    description: string;
  };

  intent: BotIntent;
  skills: BotSkills;
  capabilities: BotCapabilities;
  triggers: BotTrigger[];
  risk: BotRisk;
  execution: BotExecution;
  ai: BotAI;

  createdAt: number;
  updatedAt: number;
}

/**
 * Deployment binds a reusable bot to a specific market/account/environment.
 *
 * This is deliberately separate from BotDefinition so one bot can be deployed
 * against multiple markets without cloning the strategy itself.
 */
export interface Deployment {
  id: string;
  botId: string;
  marketId: string;
  accountId: string;
  mode: BotDeploymentMode;
  riskOverrides?: Partial<BotRisk>;
  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface QuickBuildResult {
  definition: BotDefinition;
  source: string;
}

/**
 * Validate a complete BotDefinition.
 *
 * Validation is intentionally deterministic. Invalid bots should fail before
 * entering the runtime, backtester, or deployment pipeline.
 */
export function validateBotDefinition(
  definition: BotDefinition,
  skills: SkillRegistry = skillRegistry,
  capabilities: CapabilityRegistry = capabilityRegistry,
): void {
  validateIdentity(definition);
  validateIntent(definition);
  validateSkills(definition, skills);
  validateCapabilities(definition, capabilities);
  validateTriggers(definition.triggers);
  validateRisk(definition.risk);
  validateExecution(definition.execution);
  validateAI(definition.ai);
}

function validateIdentity(definition: BotDefinition): void {
  if (
    !definition ||
    definition.schemaVersion !== CURRENT_BOT_SCHEMA_VERSION ||
    !isBotSource(definition.source) ||
    !definition.identity ||
    !nonEmpty(definition.identity.id) ||
    !nonEmpty(definition.identity.name) ||
    !nonEmpty(definition.identity.description)
  ) {
    throw new Error('BotDefinition identity is required.');
  }
}

function validateIntent(definition: BotDefinition): void {
  const intent = definition.intent;

  if (
    !intent ||
    !nonEmpty(intent.objective) ||
    !nonEmpty(intent.longBias) ||
    !nonEmpty(intent.shortBias) ||
    !stringArray(intent.guidance)
  ) {
    throw new Error('BotDefinition intent is invalid.');
  }
}

function validateSkills(
  definition: BotDefinition,
  skills: SkillRegistry,
): void {
  if (
    !definition.skills ||
    SKILL_GROUPS.some((group) => !stringArray(definition.skills[group]))
  ) {
    throw new Error('BotDefinition skills are invalid.');
  }

  const skillIds = SKILL_GROUPS.flatMap(
    (group) => definition.skills[group],
  );

  const unknownSkills = skillIds.filter(
    (skillId) => !skills.get(skillId)?.enabled,
  );

  if (unknownSkills.length > 0) {
    throw new Error(
      `BotDefinition references missing or disabled skills: ${unknownSkills.join(', ')}.`,
    );
  }
}

function validateCapabilities(
  definition: BotDefinition,
  capabilities: CapabilityRegistry,
): void {
  const botCapabilities = definition.capabilities;

  if (
    !botCapabilities ||
    Object.values(botCapabilities).some(
      (value) => typeof value !== 'boolean',
    )
  ) {
    throw new Error('BotDefinition capabilities are invalid.');
  }

  if (
    botCapabilities.orders &&
    !botCapabilities.automation
  ) {
    throw new Error(
      'Order capability requires automation permission.',
    );
  }

  if (
    botCapabilities.accountData &&
    !capabilities.has('account.getEquity')
  ) {
    throw new Error('Account data capability is unavailable.');
  }
}

function validateTriggers(triggers: BotTrigger[]): void {
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error(
      'Add at least one trigger to wake the bot.',
    );
  }

  for (const trigger of triggers) {
    validateBotTrigger(trigger);
  }
}

function validateRisk(risk: BotRisk): void {
  if (
    !risk ||
    !finitePositive(risk.riskPerTrade) ||
    !finitePositive(risk.maxExposure) ||
    !Number.isInteger(risk.maxPositions) ||
    risk.maxPositions < 1 ||
    !Number.isFinite(risk.cooldown) ||
    risk.cooldown < 0 ||
    (
      risk.maxDailyLoss !== undefined &&
      !finitePositive(risk.maxDailyLoss)
    )
  ) {
    throw new Error(
      'BotDefinition risk configuration is invalid.',
    );
  }
}

function validateExecution(execution: BotExecution): void {
  if (
    !execution ||
    !ORDER_TYPES.includes(execution.orderType) ||
    !stringArray(execution.executionRules) ||
    (
      execution.slippage !== undefined &&
      (
        !Number.isFinite(execution.slippage) ||
        execution.slippage < 0
      )
    )
  ) {
    throw new Error(
      'BotDefinition execution configuration is invalid.',
    );
  }
}

function validateAI(ai: BotAI): void {
  if (
    !ai ||
    ai.provider !== DEFAULT_AI_PROVIDER ||
    !nonEmpty(ai.model) ||
    !REASONING_MODES.includes(ai.reasoningMode) ||
    !Number.isFinite(ai.confidenceThreshold) ||
    ai.confidenceThreshold < 0 ||
    ai.confidenceThreshold > 1 ||
    !nonEmpty(ai.decisionPolicy)
  ) {
    throw new Error(
      'BotDefinition AI configuration is invalid.',
    );
  }
}

/**
 * Convert legacy/unknown bot input into the current canonical schema.
 *
 * Migration is deliberately conservative:
 * - Preserve valid existing configuration.
 * - Supply safe defaults for missing fields.
 * - Never introduce a market/symbol into the BotDefinition.
 */
export function migrateBotDefinition(
  input: unknown,
  now = Date.now(),
): BotDefinition {
  const source = isRecord(input) ? input : {};
  const identity = isRecord(source.identity)
    ? source.identity
    : source;
  const ai = isRecord(source.ai)
    ? source.ai
    : {};

  const migrated: BotDefinition = {
    schemaVersion: CURRENT_BOT_SCHEMA_VERSION,

    source:
      source.source === 'explorer' ||
      source.source === 'cloned'
        ? source.source
        : 'user',

    sourceBotId:
      typeof source.sourceBotId === 'string'
        ? source.sourceBotId
        : undefined,

    identity: {
      id: stringOr(identity.id, `bot-${now}`),
      name: stringOr(identity.name, 'Trading Bot'),
      description: stringOr(
        identity.description,
        'Reusable AI trading agent.',
      ),
    },

    intent: migrateIntent(source),

    skills: migrateSkills(source),

    capabilities: migrateCapabilities(source),

    triggers: migrateTriggers(source, now),

    risk: migrateRisk(source),

    execution: migrateExecution(source),

    ai: migrateAI(ai),

    createdAt:
      typeof source.createdAt === 'number'
        ? source.createdAt
        : now,

    updatedAt:
      typeof source.updatedAt === 'number'
        ? source.updatedAt
        : now,
  };

  validateBotDefinition(migrated);

  return migrated;
}

function migrateIntent(
  source: Record<string, any>,
): BotIntent {
  if (isRecord(source.intent)) {
    return {
      objective: stringOr(
        source.intent.objective,
        stringOr(
          source.instructions,
          'Evaluate market opportunities in context.',
        ),
      ),

      longBias: stringOr(
        source.intent.longBias,
        'Prefer long opportunities when broader structure supports them.',
      ),

      shortBias: stringOr(
        source.intent.shortBias,
        'Prefer short opportunities when broader structure supports them.',
      ),

      guidance: stringArrayOr(
        source.intent.guidance,
        [
          'Use available context.',
          'Wait when conditions are unclear.',
        ],
      ),
    };
  }

  return {
    objective: stringOr(
      source.instructions,
      'Evaluate market opportunities in context.',
    ),
    longBias:
      'Prefer long opportunities when broader structure supports them.',
    shortBias:
      'Prefer short opportunities when broader structure supports them.',
    guidance: [
      'Use available context.',
      'Wait when conditions are unclear.',
    ],
  };
}

function migrateSkills(
  source: Record<string, any>,
): BotSkills {
  if (
    isRecord(source.skills) &&
    Array.isArray(source.skills.marketAnalysis)
  ) {
    return source.skills as BotSkills;
  }

  return {
    marketAnalysis: ['market-observation'],
    indicators: ['technical-analysis'],
    patterns: [],
    context: ['risk-management'],
  };
}

function migrateCapabilities(
  source: Record<string, any>,
): BotCapabilities {
  if (
    isRecord(source.capabilities) &&
    typeof source.capabilities.marketData === 'boolean'
  ) {
    return source.capabilities as BotCapabilities;
  }

  return {
    marketData: true,
    accountData: true,
    orders: false,
    positions: true,
    automation: false,
  };
}

function migrateTriggers(
  source: Record<string, any>,
  now: number,
): BotTrigger[] {
  if (Array.isArray(source.triggers)) {
    return source.triggers as BotTrigger[];
  }

  return [
    {
      id: `new-bar-${now}`,
      type: 'NEW_BAR',
      enabled: true,
      timeframe: '15m',
      config: {},
      cooldownMs: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function migrateRisk(
  source: Record<string, any>,
): BotRisk {
  if (isRecord(source.risk)) {
    return source.risk as BotRisk;
  }

  return {
    riskPerTrade: 0.01,
    maxDailyLoss: 500,
    maxPositions: 1,
    maxExposure: 50000,
    cooldown: 900000,
  };
}

function migrateExecution(
  source: Record<string, any>,
): BotExecution {
  if (isRecord(source.execution)) {
    return source.execution as BotExecution;
  }

  return {
    orderType: 'market',
    executionRules: [
      'Respect deterministic risk validation.',
    ],
  };
}

function migrateAI(
  ai: Record<string, any>,
): BotAI {
  const reasoningMode = String(ai.reasoningMode);

  return {
    provider: DEFAULT_AI_PROVIDER,

    model: stringOr(
      ai.model,
      DEFAULT_AI_MODEL,
    ),

    reasoningMode: REASONING_MODES.includes(
      reasoningMode as ReasoningMode,
    )
      ? reasoningMode as ReasoningMode
      : 'advisory',

    confidenceThreshold:
      typeof ai.confidenceThreshold === 'number'
        ? ai.confidenceThreshold
        : 0.7,

    decisionPolicy: stringOr(
      ai.decisionPolicy,
      DEFAULT_AI_CONFIG.decisionPolicy,
    ),
  };
}

/**
 * Clone an Explorer or existing user bot into an independent bot.
 *
 * The cloned bot receives:
 * - a new identity
 * - cloned source metadata
 * - fresh timestamps
 *
 * The original definition remains untouched.
 */
export function cloneBotDefinition(
  definition: BotDefinition,
  id = `bot-${Date.now()}`,
): BotDefinition {
  const clone = structuredClone(definition);
  const now = Date.now();

  clone.identity.id = id;
  clone.source = 'cloned';
  clone.sourceBotId = definition.identity.id;
  clone.createdAt = now;
  clone.updatedAt = now;

  validateBotDefinition(clone);

  return clone;
}

/**
 * Bind a reusable BotDefinition to a specific deployment.
 *
 * The adapter-resolved runtime symbol is supplied here rather than stored
 * inside the BotDefinition.
 */
export function createDeployment(
  input: Omit<Deployment, 'createdAt' | 'updatedAt'>,
  now = Date.now(),
): Deployment {
  if (
    !nonEmpty(input.id) ||
    !nonEmpty(input.botId) ||
    !nonEmpty(input.marketId) ||
    !nonEmpty(input.accountId)
  ) {
    throw new Error('Deployment identity is required.');
  }

  if (
    !DEPLOYMENT_MODES.includes(input.mode) ||
    !DEPLOYMENT_STATUSES.includes(input.status)
  ) {
    throw new Error(
      'Deployment mode or status is invalid.',
    );
  }

  return {
    ...input,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Compile a BotDefinition into the runtime TradingAgent.
 *
 * This function does NOT execute trades.
 * It translates the declarative bot configuration into the runtime policy,
 * capabilities, AI configuration, and deployment-specific symbol context.
 */
export function compileBotDefinition(
  definition: BotDefinition,
  deployment: Deployment,
  runtimeSymbol: string,
  environment: TradingEnvironmentMode =
    deployment.mode === 'live'
      ? 'LIVE'
      : deployment.mode === 'paper'
        ? 'BACKTEST'
        : 'DEMO',
): TradingAgent {
  const migrated = migrateBotDefinition(definition);

  validateBotDefinition(migrated);

  if (!nonEmpty(runtimeSymbol)) {
    throw new Error(
      'A deployment requires an adapter-resolved runtime symbol.',
    );
  }

  const skills = SKILL_GROUPS.flatMap(
    (group) => migrated.skills[group],
  );

  const policy: AgentPolicy = {
    maxRiskPerTrade: migrated.risk.riskPerTrade,
    maxDailyLoss: migrated.risk.maxDailyLoss,
    maxOpenPositions: migrated.risk.maxPositions,
    maxExposure: migrated.risk.maxExposure,

    // Runtime-level execution throttling.
    maxOrdersPerMinute: 60,

    // Deployment-specific market binding.
    allowedSymbols: [runtimeSymbol],

    allowTrading:
      migrated.capabilities.orders &&
      migrated.capabilities.automation &&
      migrated.ai.reasoningMode !== 'advisory',
  };

  return {
    id: `${migrated.identity.id}:${deployment.id}`,

    name: migrated.identity.name,

    description: migrated.identity.description,

    instructions: [
      migrated.intent.objective,
      migrated.intent.longBias,
      migrated.intent.shortBias,
      ...migrated.intent.guidance,
      `Decision policy: ${migrated.ai.decisionPolicy}`,
    ].join('\n'),

    skills,

    capabilities: capabilityIds(
      migrated.capabilities,
    ),

    policy,

    preferredEnvironment: environment,

    symbols: [runtimeSymbol],

    timeframe:
      migrated.triggers.find(
        (trigger) => trigger.timeframe,
      )?.timeframe,

    enabled:
      deployment.status === 'active',

    createdAt: migrated.createdAt,
    updatedAt: migrated.updatedAt,

    ai: {
      provider: migrated.ai.provider,
      model: migrated.ai.model,
    },

    botId: migrated.identity.id,
    deploymentId: deployment.id,
  };
}

/**
 * Lightweight deterministic Quick Build compiler.
 *
 * Natural-language input becomes a canonical BotDefinition which can then
 * be edited, backtested, and deployed through the normal bot pipeline.
 */
export function compileQuickBuild(
  prompt: string,
  now = Date.now(),
): QuickBuildResult {
  if (!nonEmpty(prompt)) {
    throw new Error(
      'Quick Build requires a description.',
    );
  }

  const trimmedPrompt = prompt.trim();
  const lower = trimmedPrompt.toLowerCase();

  const id = slug(
    lower.match(
      /[a-z0-9]+(?:\s+[a-z0-9]+){0,2}/,
    )?.[0] || 'ai-trading-bot',
  );

  const definition: BotDefinition = {
    schemaVersion: CURRENT_BOT_SCHEMA_VERSION,

    source: 'user',

    identity: {
      id: `${id}-${now}`,
      name: titleFromPrompt(trimmedPrompt),
      description: trimmedPrompt,
    },

    intent: {
      objective: trimmedPrompt,

      longBias:
        'Prefer long opportunities when market structure and momentum support continuation.',

      shortBias:
        'Prefer short opportunities when market structure and momentum support continuation.',

      guidance: [
        'Consider trend structure.',
        'Consider momentum and volatility.',
        'Evaluate setup quality in context.',
        'Avoid weak or choppy conditions.',
        'Do not trade merely because one indicator agrees.',
      ],
    },

    skills: {
      marketAnalysis: [
        'market-observation',
        'technical-analysis',
      ],
      indicators: [],
      patterns: [],
      context: [
        'risk-management',
        'position-sizing',
      ],
    },

    capabilities: {
      marketData: true,
      accountData: true,
      orders: false,
      positions: true,
      automation: false,
    },

    triggers: [
      {
        id: `${id}-bar`,
        type: 'NEW_BAR',
        enabled: true,
        timeframe: '15m',
        config: {},
        cooldownMs: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],

    risk: {
      riskPerTrade:
        lower.includes('conservative')
          ? 0.005
          : 0.01,

      maxDailyLoss: 500,
      maxPositions: 1,
      maxExposure: 50000,
      cooldown: 15 * 60 * 1000,
    },

    execution: {
      orderType: 'market',
      executionRules: [
        'Require a protective stop loss.',
        'Respect deterministic risk validation.',
      ],
    },

    ai: {
      ...DEFAULT_AI_CONFIG,
    },

    createdAt: now,
    updatedAt: now,
  };

  validateBotDefinition(definition);

  return {
    definition,
    source: trimmedPrompt,
  };
}

/**
 * Translate user-facing capability toggles into runtime capability IDs.
 */
function capabilityIds(
  capabilities: BotCapabilities,
): string[] {
  const ids: string[] = [];

  if (capabilities.marketData) {
    ids.push(
      'market.getQuote',
      'market.getBars',
      'market.getSpread',
      'market.getSession',
    );
  }

  if (capabilities.accountData) {
    ids.push('account.getEquity');
  }

  if (capabilities.positions) {
    ids.push('account.getPositions');
  }

  if (
    capabilities.orders &&
    capabilities.automation
  ) {
    ids.push('orders.market');
  }

  return ids;
}

function validateBotTrigger(
  trigger: BotTrigger,
): void {
  if (
    !nonEmpty(trigger.id) ||
    typeof trigger.enabled !== 'boolean' ||
    !trigger.type ||
    !isRecord(trigger.config)
  ) {
    throw new Error(
      'BotDefinition contains an invalid trigger.',
    );
  }

  if (
    !SUPPORTED_TRIGGER_TYPES.includes(
      trigger.type as TriggerType,
    )
  ) {
    throw new Error(
      `Unsupported bot trigger: ${trigger.type}`,
    );
  }

  if (
    trigger.cooldownMs !== undefined &&
    (
      !Number.isFinite(trigger.cooldownMs) ||
      trigger.cooldownMs < 0
    )
  ) {
    throw new Error(
      'Invalid bot trigger cooldown.',
    );
  }
}

function isBotSource(
  value: unknown,
): value is BotSource {
  return (
    value === 'explorer' ||
    value === 'user' ||
    value === 'cloned'
  );
}

function nonEmpty(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0
  );
}

function stringArray(
  value: unknown,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(nonEmpty)
  );
}

function finitePositive(
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  );
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    'ai-trading-bot'
  );
}

function titleFromPrompt(
  value: string,
): string {
  const text = value
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');

  return text.length
    ? `${text.charAt(0).toUpperCase()}${text.slice(1)}`
    : 'AI Trading Bot';
}

function isRecord(
  value: unknown,
): value is Record<string, any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringOr(
  value: unknown,
  fallback: string,
): string {
  return (
    typeof value === 'string' &&
    value.trim()
      ? value
      : fallback
  );
}

function stringArrayOr(
  value: unknown,
  fallback: string[],
): string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.trim(),
    )
      ? value
      : fallback
  );
}