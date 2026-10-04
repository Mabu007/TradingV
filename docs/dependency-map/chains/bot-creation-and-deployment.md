# Chain: Bot Creation & Deployment

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the user completes the `BotBuilderModal` wizard and taps deploy.

**Confidence:** CONFIRMED.

---

```
[1] BotBuilderModal 'Deploy' step                          BotBuilderModal.tsx:183
    └─ createDeployment()                                  BotBuilderModal.tsx:182
    └─ onDeploy(definition, deployment)                    BotBuilderModal.tsx:183
       └─ onClose()                                        BotBuilderModal.tsx:184
```

The wizard is a 5-stage state machine — `stage` at `BotBuilderModal.tsx:114`:
`'method' → 'build' → 'review' → 'test' → 'deploy'`
(render switch at `:216-220`).

```
[2] BotsTab.onDeploy(def, deployment)                       BotsTab.tsx:699-702
    └─ onCreateBot({ name, symbol: deployment.marketId, timeframe,
                    strategyCode, definition, deployment })  BotsTab.tsx:701
       ↓
[3] App.handleCreateBot(botData)                            App.tsx:1116-1548
```

## Stage 0 — building the definition

Before deployment, the definition is produced and validated:

| Step | Location |
| --- | --- |
| quick-build from a prompt | `compileQuickBuild(prompt)` — `botDefinition.ts:831-947`; called at `BotBuilderModal.tsx:147` |
| or manual composition | the wizard's form |
| validate before saving | `validateBotDefinition(definition)` — `botDefinition.ts:239`; called at `BotBuilderModal.tsx:136` |
| save as a draft | `onSave(definition)` — `BotBuilderModal.tsx:159` → `BotsTab.onSaveBotDefinition` `BotsTab.tsx:698` → `App.setBotDefinitions` `App.tsx:2509-2519` |

`compileQuickBuild` derives: a slug from the first 1–3 words of the prompt
(`botDefinition.ts:844-848`); fixed capabilities with `orders:false, automation:false`
(`:892-898`); one `NEW_BAR` 15m trigger (`:900-911`); `riskPerTrade` 0.005 when the
prompt contains "conservative", else 0.01 (`:913-923`); then validates before returning
(`:941`).

## Stage 1 — the key gate

| | |
| --- | --- |
| **Action** | `requireOpenRouterKey()` — `App.tsx:1129-1134` |
| **Behaviour** | if the OpenRouter key is missing, `setShowAIModal(true)` and return without deploying — `App.tsx:390` |
| **Why** | the agent loop calls a model on every wake |

## Stage 2 — the canonical (definition) path

```
[4] createDeployment(...)                                  App.tsx:1154
      → botDefinition.ts:685-712
        requires non-empty id/botId/marketId/accountId, a valid mode and status,
        stamps createdAt/updatedAt
[5] new DemoEnvironment()                                  App.tsx:1182
      → environment/demo.ts:8-68   (delegates entirely to hyperliquidDemoAdapter)
[6] agentRuntime.registerBot(definition, deployment, symbol, demoEnv)   App.tsx:1185
[7] triggerRegistry.registerBotTriggers(definition, agentId, symbol)     App.tsx:1192
[8] ensureTriggerEngineStarted()                           App.tsx:1198
[9] agentRuntime.start(agent.id)                           App.tsx:1200
```

### Stage 6 in detail — `registerBot` → `compileBotDefinition` → `registerAgent`

```
agentRuntime.registerBot(definition, deployment, runtimeSymbol, env)   runtime.ts:190-198
   └─ compileBotDefinition(definition, deployment, runtimeSymbol, env)  botDefinition.ts:721-823
        ├─ migrateBotDefinition(definition)                 botDefinition.ts:416-479
        │     (coerces to schema v2, then validates at :476)
        ├─ validateBotDefinition(definition)                botDefinition.ts:239-252
        │     validateIdentity      :254
        │     validateIntent        :268
        │     validateSkills        :282
        │     validateCapabilities  :308
        │     validateTriggers      :340
        │     validateRisk          :352
        │     validateExecution     :372
        │     validateAI            :391
        ├─ require a non-empty runtimeSymbol                botDefinition.ts:736-740
        ├─ flatten the four skill groups                    botDefinition.ts:742-744
        ├─ build AgentPolicy                                 botDefinition.ts:746-775
        │     maxRiskPerTrade  = risk.riskPerTrade
        │     maxDailyLoss     = risk.maxDailyLoss
        │     maxOpenPositions = risk.maxPositions
        │     maxExposure      = risk.maxExposure
        │     maxOrdersPerMinute = 60                       (hard-coded, :753)
        │     allowedSymbols   = [runtimeSymbol]             (:756)
        │     allowTrading     = caps.orders && caps.automation  (:773-774)
        └─ build TradingAgent                               botDefinition.ts:777-822
              id             = `${botId}:${deployment.id}`  :778
              instructions   = intent fields + decisionPolicy joined  :784-790
              capabilities   = capabilityIds(caps)          :794-796
              timeframe      = the first trigger's timeframe, if any  :804-807
              enabled        = deployment.status === 'active'  :809-810
              ai             = { provider, model }          :815-818
              botId / deploymentId                          :820-821
   ↓
agentRuntime.registerAgent(agent, env)                      runtime.ts:84-188
   ├─ deep-freeze the agent and its arrays/policy           runtime.ts:88-110
   ├─ env.mode === 'LIVE' → throw                           runtime.ts:112-116
   ├─ !agent.enabled → throw                                runtime.ts:118-120
   ├─ skills.resolveCapabilities(agent.skills)              runtime.ts:122-124
   ├─ unknown/disabled skill → throw                        runtime.ts:126-134
   ├─ allowedCapabilities = agentCaps ∩ skillCaps ∩ registeredCaps  runtime.ts:136-140
   ├─ reject any field matching
   │    /secret|token|password|api.?key|credential/i        runtime.ts:142-152
   ├─ skillsInstructions = skills.compileInstructions(...)   runtime.ts:154-155
   ├─ memory = new ScopedAgentMemory()                      runtime.ts:157
   ├─ per-agent ActionValidator clone when the singleton was used  runtime.ts:159-162
   ├─ duplicate capability-id check                         runtime.ts:176-183
   └─ this.instances.set(agent.id, instance)                runtime.ts:185
```

`capabilityIds(capabilities)` — `botDefinition.ts:952-982` maps the eight boolean
toggles to dotted capability ids:

| Toggle | Capability ids | Line |
| --- | --- | --- |
| `marketData` | `market.getQuote`, `market.getBars`, `market.getSpread`, `market.getSession` | `:957-964` |
| `accountData` | `account.getEquity` | `:966-968` |
| `positions` | `account.getPositions` | `:970-972` |
| `orders && automation` | `orders.market` | `:974-979` |

### Stage 7 in detail — trigger registration

```
triggerRegistry.registerBotTriggers(definition, agentId, runtimeSymbol)   registry.ts:42-50
   └─ per trigger: register({ ...trigger, agentId, symbol: runtimeSymbol })   registry.ts:23-40
        ├─ validateDefinition(trigger)                      registry.ts:24  → :101-164
        ├─ owner is registered + enabled + not LIVE         registry.ts:25-26
        ├─ symbol ∈ agent.symbols ∩ policy.allowedSymbols   registry.ts:27-28
        ├─ timeframe ∈ 1m|5m|15m|30m|1h|4h|1d and
        │   === agent.timeframe when the agent has one       registry.ts:30
        ├─ id not already registered                        registry.ts:31
        ├─ agent has < 100 triggers                         registry.ts:32
        └─ store structuredClone(trigger); index by symbol
           or into `unscoped`                              registry.ts:33-39
```

`validateBotTrigger` — `botDefinition.ts:984-1041` additionally requires: a non-blank
id, boolean `enabled`, a plain-object `config`, a type in
`SUPPORTED_TRIGGER_TYPES` (`botDefinition.ts:60-87`, 18 entries), non-negative finite
`cooldownMs`, and for `CUSTOM` a `config.conditionTree` that passes
`validateConditionTree` from `src/engine/conditions/contract` (`botDefinition.ts:1034-1039`).

Note: the registry's own `validateDefinition` refuses `CUSTOM` outright
(`registry.ts:163`), so a validated `CUSTOM` trigger in a definition is rejected at
registration time.

## Stage 3 — the legacy (non-definition) path

`App.tsx:1281-1547` is reachable when `botData.definition` is absent. It constructs a
`TradingAgent` literal inline (`App.tsx:1285-1408`), registers it
(`agentRuntime.registerAgent` `App.tsx:1415`), builds a default `NEW_BAR` `AgentTrigger`
(`App.tsx:1425-1460`), registers it (`App.tsx:1462`), ensures the engine is started
(`App.tsx:1517`), and starts the agent (`App.tsx:1519`).

Both branches live in the same handler; the branch condition is the presence of
`botData.definition` (`App.tsx:1150`).

## Stage 4 — state writes

| Write | Line | Result |
| --- | --- | --- |
| `setBots([newBot, ...prev])` | `App.tsx:1245` (definition path) | the new bot's status is `'RUNNING'` |
| `setBotDefinitions([definition, ...prev])` | `App.tsx:1261` | the canonical definition is stored |
| `setBots(...)` | `App.tsx:1511` (legacy) | status `'STOPPED'` |
| `setBots(...)` | `App.tsx:1524` (legacy) | then flipped to `'RUNNING'` |

**Error handling (CONFIRMED)** — both branches log to `console.error` only
(`App.tsx:1271`, `:1543`); no `safetyNotice` is set on a creation failure.

## State summary

| State | Writer | Reset |
| --- | --- | --- |
| `AgentRuntime.instances` | `runtime.ts:185` | never |
| `TriggerRegistry.triggers` / `bySymbol` / `unscoped` | `registry.ts:33-39` | `unregister` `:52-62` |
| `App.bots` | `App.tsx:1245/1511/1524` | reload |
| `App.botDefinitions` | `App.tsx:1261`, `:2509` | reload |
| `instance.memory` | `runtime.ts:157` | process lifetime |
| `instance.allowedCapabilities` | `runtime.ts:136-140` | never |
| `TriggerEngine.evaluationStates` | created lazily on the first evaluation | `disposeAgent` |

## Turning the bot back off

`handleToggleBotStatus` — `App.tsx:951-1109`:
agent path `agentRuntime.stop(botId)` `App.tsx:975` / `agentRuntime.start(agentId)`
`App.tsx:1025`; `setSafetyNotice` on a start failure `App.tsx:1067`;
`ensureTriggerEngineStarted()` `App.tsx:1014`. The legacy path only flips a local status
field (`App.tsx:1083-1108`).

## Exit points

- The agent can subsequently place a DEMO order — see
  [agent-decision-to-order.md](agent-decision-to-order.md).
- `eventBus` `AGENT_STARTED` — `runtime.ts:217-223` — reaches `TriggerEngine.onAll`.
