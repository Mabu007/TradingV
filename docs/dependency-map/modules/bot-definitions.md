# Module 9 — Bot Definitions

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/botDefinition.ts` (1139 lines),
`src/engine/agents/builtins/{register,conservativeEurusd}.ts`,
`src/engine/agents/explorer.ts`

**Purpose:** the canonical bot schema (version 2), its migration, validation, cloning,
quick-build, deployment record, and compilation into a runtime `TradingAgent`. This is
the contract between the bot-creation UI and the agent runtime.

---

## Contains

### `botDefinition.ts`

| Symbol | Line |
| --- | --- |
| `CURRENT_BOT_SCHEMA_VERSION = 2` | `:30` |
| `DEFAULT_AI_MODEL` | `:32` |
| `DEFAULT_AI_PROVIDER = 'openrouter'` | `:33` |
| `DEFAULT_AI_CONFIG` | `:35-42` (reasoningMode `'advisory'`, threshold 0.7) |
| `ReasoningMode` | `:44-48` — `'autonomous' \| 'confirm' \| 'advisory' \| 'strict'` |
| `BotDeploymentMode` | `:50` — `'paper' \| 'demo' \| 'live'` |
| `DeploymentStatus` | `:52-56` — `'active' \| 'paused' \| 'stopped' \| 'error'` |
| `BotSource` | `:58` — `'explorer' \| 'user' \| 'cloned'` |
| `SUPPORTED_TRIGGER_TYPES` | `:60-87` — **18** entries |
| `SKILL_GROUPS` | `:89-94` — `marketAnalysis`, `indicators`, `patterns`, `context` |
| `REASONING_MODES` / `DEPLOYMENT_MODES` / `DEPLOYMENT_STATUSES` | `:96-101` / `:103-107` / `:109-114` |
| `ORDER_TYPES` | `:116` |
| `BotIntent` … `QuickBuildResult` | `:118-231` |
| `validateBotDefinition` | `:239-252` |
| `validateIdentity` / `validateIntent` / `validateSkills` / `validateCapabilities` / `validateTriggers` / `validateRisk` / `validateExecution` / `validateAI` | `:254` / `:268` / `:282` / `:308` / `:340` / `:352` / `:372` / `:391` |
| `validateBotTrigger` | `:984-1041` |
| `migrateBotDefinition` | `:416-479` |
| `migrateIntent` … `migrateAI` | `:481-528` / `:530-546` / `:548-565` / `:567-587` / `:589-603` / `:605-618` / `:620-649` |
| `cloneBotDefinition` | `:661-677` |
| `createDeployment` | `:685-712` |
| `compileBotDefinition` | `:721-823` |
| `compileQuickBuild` | `:831-947` |
| `capabilityIds` | `:952-982` |

### `builtins/`
- `conservativeEurusd.ts:3-70` — `CONSERVATIVE_EURUSD_AGENT`, id `agent-conservative-eurusd`,
  6 skills, 21 capabilities, 1 % risk / $500 daily / 5 % drawdown / 1 position /
  50 000 exposure / 6 orders-per-minute, `allowedSymbols: ['EURUSD']`,
  sessions LONDON/NEW_YORK/OVERLAP, `allowTrading: true`,
  `preferredEnvironment: 'DEMO'`, `timeframe: '5m'`, fixed timestamps `1700000000000`.
- `register.ts:5-10` — `registerConservativeEurusdDemoAgent(runtime, environment = new DemoEnvironment())`.

### `explorer.ts`
`EXPLORER_BOTS` (24) `:24-33` · `getExplorerBot` `:37` · all validated at module load
(`:35`).

---

## `BotDefinition` shape — `:187-208`

```
schemaVersion, source, sourceBotId?,
identity { id, name, description },
intent   { objective, longBias, shortBias, guidance[] },
skills   { marketAnalysis[], indicators[], patterns[], context[] },
capabilities { marketData, accountData, positions, orders, automation },
triggers  [ BotTrigger ],
risk      { riskPerTrade, maxExposure, maxDailyLoss, maxPositions, cooldown },
execution { orderType, executionRules[], slippage },
ai        { provider, model, reasoningMode, confidenceThreshold, decisionPolicy },
createdAt, updatedAt
```

The header comment at `:17-28` states: asset-agnostic; the market is selected by
`Deployment`; API credentials never belong here; triggers wake, never execute.

`BotTrigger` — `:180-185` — is `Omit<AgentTrigger, 'agentId' | 'symbol'> & { symbol?: never }`:
a bot definition carries no market.

---

## `validateBotDefinition` — `:239-252`

Runs in order: `validateIdentity` `:244` → `validateIntent` `:245` →
`validateSkills` `:246` → `validateCapabilities` `:247` → `validateTriggers` `:248` →
`validateRisk` `:249` → `validateExecution` `:250` → `validateAI` `:251`.

| Validator | Lines | Rejects |
| --- | --- | --- |
| `validateIdentity` | `:254-266` | non-object; `schemaVersion !== 2`; bad `source`; missing/blank identity → `'BotDefinition identity is required.'` |
| `validateIntent` | `:268-280` | missing/blank `objective`/`longBias`/`shortBias`; `guidance` not a non-empty-string array |
| `validateSkills` | `:282-306` | a group that is not a string array; a skill id absent from the registry or `enabled === false` (`:297-305`) |
| `validateCapabilities` | `:308-338` | non-boolean flags; `orders && !automation` → `'Order capability requires automation permission.'` (`:323-330`); `accountData` while `!capabilities.has('account.getEquity')` (`:332-337`) |
| `validateTriggers` | `:340-350` | an empty array → `'Add at least one trigger to wake the bot.'` (`:341`); then `validateBotTrigger` per trigger |
| `validateRisk` | `:352-370` | non-finite/non-positive `riskPerTrade`, `maxExposure`, `maxDailyLoss`; non-integer or `< 1` `maxPositions`; negative/non-finite `cooldown` |
| `validateExecution` | `:372-389` | `orderType` not in `ORDER_TYPES`; `executionRules` not a string array; negative/non-finite `slippage` |
| `validateAI` | `:391-406` | `provider !== 'openrouter'`; blank `model`; `reasoningMode` not in the list; `confidenceThreshold` outside [0,1]; blank `decisionPolicy` |

`validateBotTrigger` — `:984-1041`: blank id; non-boolean `enabled`; missing type;
`config` not a plain object `:991`; type outside `SUPPORTED_TRIGGER_TYPES` `:998-1006`;
negative/non-finite `cooldownMs` `:1008-1018`; `CUSTOM` without a
`config.conditionTree` `:1029-1033` or whose tree fails
`validateConditionTree` from `../conditions/contract` `:1034-1039`.

**Import-order dependency (CONFIRMED)** — `botDefinition.ts:3-13` imports
`SkillRegistry, skillRegistry` from the **barrel** `./skills` so the builtin skill
registration side effect runs before validation. The comment at `:3-13` states
validation would otherwise reject every bot in a fresh module graph.

---

## `migrateBotDefinition` — `:416-479`

Coerces any input into the canonical schema, then validates (`:476`).

| Sub-migrator | Line | Defaults applied |
| --- | --- | --- |
| `migrateIntent` | `:481-528` | |
| `migrateSkills` | `:530-546` | `['market-observation']`, `['technical-analysis']`, `[]`, `['risk-management']` |
| `migrateCapabilities` | `:548-565` | `orders: false, automation: false` |
| `migrateTriggers` | `:567-587` | one `NEW_BAR` 15m trigger |
| `migrateRisk` | `:589-603` | 0.01 / 500 / 1 / 50000 / 900000 |
| `migrateExecution` | `:605-618` | |
| `migrateAI` | `:620-649` | `DEFAULT_AI_CONFIG` `:35-42` |

`cloneBotDefinition(definition, id = bot-<ts>)` — `:661-677`: `structuredClone` `:662`,
a new identity, `source: 'cloned'`, `sourceBotId` = the original id, fresh timestamps,
then re-validates `:674`.

---

## `createDeployment` — `:685-712`

Requires non-empty `id` / `botId` / `marketId` / `accountId`; validates `mode` against
`DEPLOYMENT_MODES` and `status` against `DEPLOYMENT_STATUSES`; stamps `createdAt` /
`updatedAt`.

Called from `App.tsx:1154` (demo deploy), `App.tsx:1609` (`mode: 'paper'` backtest),
and `BotBuilderModal.tsx:182`.

---

## `compileBotDefinition` — `:721-823`

```
migrate (732) → validate (734) → require a non-empty runtimeSymbol (736-740)
  → flatten the four skill groups (742-744)
  → build AgentPolicy (746-775)
  → return TradingAgent (777-822)
```

**`AgentPolicy`** — `:746-775`

| Field | Source | Line |
| --- | --- | --- |
| `maxRiskPerTrade` | `risk.riskPerTrade` | |
| `maxDailyLoss` | `risk.maxDailyLoss` | |
| `maxOpenPositions` | `risk.maxPositions` | |
| `maxExposure` | `risk.maxExposure` | |
| `maxOrdersPerMinute` | **hard-coded 60** | `:753` |
| `allowedSymbols` | `[runtimeSymbol]` | `:756` |
| `allowTrading` | `capabilities.orders && capabilities.automation` | `:773-774` |

**`TradingAgent`** — `:777-822`

| Field | Value | Line |
| --- | --- | --- |
| `id` | `` `${botId}:${deployment.id}` `` | `:778` |
| `instructions` | intent fields + `decisionPolicy`, joined | `:784-790` |
| `capabilities` | `capabilityIds(caps)` | `:794-796` |
| `timeframe` | the first trigger's timeframe, if any | `:804-807` |
| `enabled` | `deployment.status === 'active'` | `:809-810` |
| `ai` | `{ provider, model }` | `:815-818` |
| `botId` / `deploymentId` | from the definition and deployment | `:820-821` |

---

## `compileQuickBuild(prompt, now)` — `:831-947`

| Output | Rule | Line |
| --- | --- | --- |
| id / name slug | the first 1–3 words of the prompt | `:844-848` |
| capabilities | fixed, `orders: false, automation: false` | `:892-898` |
| triggers | one `NEW_BAR` 15m | `:900-911` |
| `riskPerTrade` | 0.005 when the prompt contains "conservative", else 0.01 | `:913-923` |
| validation | runs before returning | `:941` |

Called from `BotBuilderModal.tsx:147`.

---

## `capabilityIds(capabilities)` — `:952-982`

| Toggle | Capability ids | Line |
| --- | --- | --- |
| `marketData` | `market.getQuote`, `market.getBars`, `market.getSpread`, `market.getSession` | `:957-964` |
| `accountData` | `account.getEquity` | `:966-968` |
| `positions` | `account.getPositions` | `:970-972` |
| `orders && automation` | `orders.market` | `:974-979` |

The same dotted strings appear in `capabilities/registry.ts` and `skills/builtins.ts` —
a rename must be applied in all three places.

---

## Where a definition comes from and goes

**Created by (4 sources)**
1. `compileQuickBuild(prompt)` — `botDefinition.ts:831` ← `BotBuilderModal.tsx:147`
2. the wizard form — `BotBuilderModal.tsx:159`
3. `EXPLORER_BOTS` (24 templates) — `explorer.ts:24-33`
4. `cloneBotDefinition` — `botDefinition.ts:661` ← `BotsTab.tsx:25-26`

**Passes through** `migrateBotDefinition` `:416` → `validateBotDefinition` `:239`.

**Sent to**
- `App.setBotDefinitions` — `App.tsx:1261`, `:2509-2519` → `BotsTab.botDefinitions`
  `App.tsx:2503` and the AI context `App.tsx:1935`, `:1969`
- `compileBotDefinition` → `TradingAgent` → `agentRuntime.registerBot` `runtime.ts:190`
- `TriggerRegistry.registerBotTriggers` — `registry.ts:42`
- `runBotDefinitionBacktest` — `backtest.ts:139`

**Persisted by** — nothing. React state plus the runtime's in-memory maps.

---

## Depends on

| Module | How |
| --- | --- |
| Agent Runtime | `compileBotDefinition` returns a `TradingAgent` for `registerAgent` |
| Trigger Engine | `SUPPORTED_TRIGGER_TYPES` `:60-87`; `validateBotTrigger` `:984-1041` |
| Capabilities | `capabilityIds` `:952-982`; `validateCapabilities` `:308-338` |
| Conditions (contract) | `validateConditionTree` — `botDefinition.ts:1034-1039` |
| Skills | `SkillRegistry, skillRegistry` from the barrel — `botDefinition.ts:3-13` |
| Environments | `compileBotDefinition` takes an `ITradingEnvironment` `:721` |

## Used by

| Consumer | Line |
| --- | --- |
| `AgentRuntime.registerBot` | `runtime.ts:196` |
| `BotBuilderModal` | `:136` (validate), `:147` (quick build), `:159` (save), `:182-184` (deploy) |
| `BotsTab` | `:25-26` (clone), `:698` (save), `:701` (deploy) |
| `App` | `:1154`, `:1200`, `:1609`, `:1651` |
| `runBotDefinitionBacktest` | `backtest.ts:139` |
| `registerConservativeEurusdDemoAgent` | `builtins/register.ts:5-10` |
| Test runners (test-only) | `botDefinitionTests.ts`, `pipelineAcceptance.ts` |

## Reads

`skillRegistry` (built-in skills) · `capabilityRegistry` (via `validateCapabilities`
and `capabilityIds`) · the `Deployment` record · `riskManager` indirectly via
`AgentPolicy`.

## Writes

None on shared state. It is a pure transformation module.

## Mutates

None. `cloneBotDefinition` uses `structuredClone` rather than mutating in place
(`:662`).

## Emits

None.

## Subscribes to

None.

## External dependencies

None. No network, no storage, no I/O.

## Entry points

`validateBotDefinition` `:239` · `migrateBotDefinition` `:416` ·
`cloneBotDefinition` `:661` · `createDeployment` `:685` ·
`compileBotDefinition` `:721` · `compileQuickBuild` `:831` ·
`capabilityIds` `:952` · `getExplorerBot` `explorer.ts:37` ·
`registerConservativeEurusdDemoAgent` `builtins/register.ts:5`.

## Exit points

A `TradingAgent` for `AgentRuntime.registerAgent`, or a `BotTrigger[]` for
`TriggerRegistry.registerBotTriggers`.

---

## Notable observations (factual)

- **`maxOrdersPerMinute` is hard-coded to 60** in `compileBotDefinition`
  (`botDefinition.ts:753`), independent of `BotRisk`.
- **`SUPPORTED_TRIGGER_TYPES` has 18 entries** (`:60-87`) — the same 18 as
  `TriggerType` (`triggers/types.ts:4-9`) and `SUPPORTED_TYPES`
  (`triggers/registry.ts:7-12`).
- **`CUSTOM` passes definition validation but is refused at registration** —
  `validateBotTrigger` accepts a `CUSTOM` trigger with a valid tree
  (`:1029-1039`), while `TriggerRegistry.validateDefinition` refuses `CUSTOM`
  outright (`registry.ts:163`).
- **The explorer templates are validated at module load** — `explorer.ts:35`.
- The builtin's timestamps are fixed at `1700000000000`
  (`conservativeEurusd.ts`), so its `enabled` state does not vary with wall time.
