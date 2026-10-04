# Reverse Dependencies

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

"Who depends on this?" — for every important module and symbol. Relationship kinds
are distinguished:

| Kind | Meaning |
| --- | --- |
| `direct` | a literal import in the source file |
| `indirect` | reachable through a call chain, not an import |
| `runtime caller` | actually invoked at runtime in a live path |
| `test-only` | only a test file references it |

---

## 1. Browser singletons

### `eventBus` — `src/types/events.ts:75`

```
Imported by (direct):
  src/adapters/hyperliquid/marketData.ts:1        emits
  src/adapters/hyperliquid/demo.ts:1              emits
  src/engine/agents/runtime.ts:60, 71             subscribes
  src/engine/agents/triggers/engine.ts:78         subscribes (onAll)
  src/engine/execution/risk.ts                    emits (STATUS_CHANGE, RISK_VIOLATION)
  src/App.tsx:813, 817, 821, 516                  subscribes

Reached indirectly by:
  src/components/**            via App state re-render (they never import it)
  src/services/aiContext/**    via the App publish effect

Runtime callers of listeners registered on it:
  App effects #3, #5, #7, #8
  TriggerEngine (every market and agent event)
  AgentRuntime (position events → timeline)

If this changes: everything above re-renders or re-evaluates. There is no
substitute event primitive in the repository.
```

### `agentRuntime` — `src/engine/agents/runtime.ts:1781`

```
Imported by (direct):
  src/App.tsx                     start / stop / registerBot / getTimelineStore
  src/engine/agents/test-runner/run.ts            (test-only)
  src/engine/agents/pipelineAcceptance.ts         (test-only)
  src/engine/agents/activityTests.ts              (test-only)
  src/engine/agents/backtestTests.ts              (test-only)
  src/engine/agents/tests.ts                      (test-only)
  src/engine/agents/triggers/auditRegressionTests.ts  (test-only)
  src/engine/agents/triggers/tests.ts             (test-only)
  src/engine/agents/triggers/conditionTests.ts    (test-only)
  src/engine/backtester/…                          via runBotDefinitionBacktest → backtest.ts

Reached indirectly by:
  TriggerEngine (constructor-injected resolver + delivery)  engine.ts:57-73
  Builtin registration helper                                builtins/register.ts:5-10
  App's AI context publish                                     App.tsx:1723
```

### `riskManager` — `src/engine/execution/risk.ts:288`

```
Imported by (direct):
  src/adapters/hyperliquid/demo.ts:16          order + close + mark paths
  src/engine/agents/runtime.ts                 :906, :1561
  src/engine/agents/policy/validator.ts        uses aggregateExposure, not the instance
  src/engine/agents/capabilities/risk.ts       verdict-only reads
  src/App.tsx                                  :1751, :1758, :2881, :1986 (getLimits)
  src/engine/execution/tests.ts               (test-only)
  src/engine/core/securityTests.ts            (test-only)

Read by (indirect): the AI context `riskLimits` and `riskState` slices (App.tsx:1881, 1986)

Rejects: every order attempt, whether from the UI or an agent.
```

### `TriggerRegistry` / `TriggerEngine` — instances created in `App.tsx:99-107`

```
Import of the class:
  src/App.tsx:99-101 (TriggerRegistry), :103-107 (TriggerEngine)
  src/engine/agents/triggers/index.ts          barrel
  test runners (test-only)

Registry instance is a dependency of:
  TriggerEngine (constructor arg)   engine.ts:57
  agentRuntime resolver closure      App.tsx:100  (id => agentRuntime.getAgent(id))

Engine instance is a dependency of:
  App (the only owner)              App.tsx:109, :155
  nothing else — it is not exported
```

### `capabilityRegistry` — `src/engine/agents/capabilities/registry.ts:91`

```
Imported by (direct):
  src/engine/agents/runtime.ts:54          default constructor arg
  src/engine/agents/botDefinition.ts:239   validateCapabilities default
  src/engine/agents/skills/registry.ts     skill→capability resolution
  src/engine/agents/capabilities/index.ts:18  initializeDefaultCapabilities
  src/components/views/BotBuilderModal.tsx (capability display)
  src/engine/agents/pipelineAcceptance.ts, activityTests.ts, tests.ts (test-only)

Filled by: capabilities/index.ts:38 (module-load side effect) via initializeDefaultCapabilities
```

### `actionValidator` — `src/engine/agents/policy/validator.ts:282`

```
Imported by (direct):
  src/engine/agents/runtime.ts:56   default constructor arg
  src/engine/agents/index.ts        barrel
  src/engine/core/securityTests.ts, agents/tests.ts (test-only)
```

### `marketDataService` — `src/services/marketData.ts:79`

```
Imported by (direct):
  src/App.tsx:436 (setSymbols), :624 (updateLastPrice), :1636 (getSymbol)
  src/engine/agents/capabilities/instruments.ts
  src/engine/agents/backtest.ts      (pip/lot lookup for a marketId)
```

### `appContextStore` — `src/services/aiContext/store.ts:134`

```
Written by:  src/App.tsx:1853   (the only publisher)
Read by:     src/services/aiContext/tools.ts:32-165   (11 functions)
Consumed by: src/components/ai/FloatingAIAssistant.tsx:152-169
             src/services/aiContext/prompt.ts
             src/services/aiContext/tests.ts (test-only)
```

### `openRouterProvider` — `src/adapters/openrouter/provider.ts:291`

```
Imported by (direct):
  src/engine/agents/model/openrouter.ts        the agent model
  src/App.tsx:337-340 (getConfig), :2840 (saveConfig), :375 (config read)
  src/components/ai/FloatingAIAssistant.tsx:272, :308
  src/components/layout/OpenRouterSettingsModal.tsx
  src/services/aiContext/tests.ts, src/adapters/openrouter (test-only)
```

### `hyperliquidMarketData` — `src/adapters/hyperliquid/marketData.ts:481`

```
Imported by (direct):
  src/App.tsx:76                       discovery, quotes, bars, status, connect, setNetwork
  src/adapters/hyperliquid/demo.ts:24  the DEMO adapter's price source
  src/engine/agents/environment/demo.ts:10
  src/engine/backtester/historical.ts:40-42
  src/adapters/hyperliquid/tests.ts, executionTests.ts, discoveryTests.ts (test-only)
```

### `hyperliquidDemoAdapter` — `src/adapters/hyperliquid/demo.ts`

```
Imported by (direct):
  src/App.tsx                          placeMarketOrder :871, closePosition :926,
                                       getPositions :796, getAccountState :802,
                                       markToMarket :637
  src/engine/agents/environment/demo.ts:10   adapter field
  src/adapters/hyperliquid/executionTests.ts (test-only)

Holds the application's only position/order/trade state.
```

---

## 2. Reverse call graph for key functions

### `TriggerRegistry.evaluate` / `TriggerRegistry.candidates`

```
Function:      TriggerRegistry.candidates(symbol?)   registry.ts:83
Called by:     TriggerEngine.process                  engine.ts:188   (runtime caller)
Returns:       AgentTrigger[]  — union of `unscoped` and `bySymbol.get(symbol)`   :85-86
Depends on:    bySymbol map :16, unscoped set :17
```

### `TriggerEngine.process`

```
Function:   TriggerEngine.process(input)             engine.ts:178
Called by:  TriggerEngine.start's MARKET_QUOTE branch  engine.ts:106   (runtime)
            dispatchMarketInput                        engine.ts:116
            tickScheduled                              engine.ts:311
            processPositionEvent                       engine.ts:366
            processTradingEvent                        engine.ts:377
            processOrderFill                          engine.ts:383
Calls:      registry.candidates                       :188
            evaluateTrigger                            :215
            canFire / markFired                        :218, :220
            calculateTriggerIndicators                 :222
            safeSnapshot                               :222
            timeline.append                            :241
            this.delivery.wake                         :252
Mutates:    evaluationStates, lastFired, firingHistory, inFlightTriggers, processedEvents
Returns:    AgentTriggerEvent[]  (fired events)
```

### `AgentRuntime.step`

```
Function:   AgentRuntime.step(agentId, event?)        runtime.ts:389
Called by:  AgentRuntime.handleEvent                   runtime.ts:1758  (runtime)
            replayAgentBacktest                        environment/backtest.ts:377
Guards:     activeCycles re-entrancy                   :399-403
Calls:      runStep                                    :408
Returns:    finalDecision (AgentDecision)              :1344
Mutates:    instance.memory, auditLog, timelineSequence, positionCorrelations
```

### `AgentRuntime.runStep` — internal, called only from `step`

```
Calls (in order):
  observe                       :445
  timeline.append(OBSERVATION)  :480
  this.model.run                :522    (loop, max 5 iterations :497)
  capabilities.get / execute   :626, :703, :830
  validateExecutionTool         :633 → :1508
  resolveInstruments            :886
  instance.validator.validate   :894
  riskManager.validateOrder     :906
  env.placeMarketOrder / modifyPosition / closePosition   :979, :1107, :1116
  auditLog.unshift              :1289
  timeline.append(DECISION)     :1298
```

### `RiskManager.validateOrder`

```
Function:   RiskManager.validateOrder(order, positions, recordAcceptedOrder = true, ctx?)   risk.ts:139
Called by:
  AgentRuntime.runStep (system risk gate)              runtime.ts:906   (runtime, recordAcceptedOrder=false)
  AgentRuntime.validateExecutionTool (tool pre-check)  runtime.ts:1561  (runtime, false)
  HyperliquidDemoAdapter (adapter gate)                demo.ts:515      (runtime, default true)
  execution/tests.ts, core/securityTests.ts            (test-only)
Calls:      validateExposure → aggregateExposure        :171 → valuation.ts:346
            notifyViolation                             :276
Mutates:    recentOrderTimestamps (only when recordAcceptedOrder is true)   :202
Returns:    { valid, reason?, code? }
```

### `ActionValidator.validate`

```
Function:   ActionValidator.validate(decision, policy, observation, ctx = {})   policy/validator.ts:40
Called by:
  AgentRuntime.runStep (final decision)                runtime.ts:894   (runtime)
  AgentRuntime.validateExecutionTool (orders.market)   runtime.ts:1549  (runtime)
  agents/tests.ts, core/securityTests.ts               (test-only)
Calls:      referencePrice                             :14
            aggregateExposure                           :154-186
            riskToStop                                  :220-244
Mutates:    recentOrderTimestamps (on APPROVED)        :247-248
Returns:    AgentActionValidationResult { valid, code, reason }
```

### `evaluateTrigger` — `triggers/evaluator.ts:38`

```
Function:   evaluateTrigger(trigger, input, state)     evaluator.ts:38
Called by:  TriggerEngine.process                       engine.ts:215   (the only runtime caller)
Calls:      conditionTreeOf                             evaluator.ts:85
            evaluateConditionTreeTrigger (if a tree)    evaluator.ts:101
            18-case switch                              evaluator.ts:55-75
              evaluateNewBar / evaluatePriceThreshold / evaluatePriceCross /
              evaluateIndicatorCross / evaluateBreakout / evaluateSpread /
              evaluateVolatility / evaluatePositionUpdate / evaluatePositionProximity /
              evaluateSession / evaluateScheduled / evaluateCustom
            calculateTriggerIndicators                   evaluator.ts:144
            evaluateProximity                           proximity.ts:91
            evaluateConditionTree                       conditions.ts:755
Mutates:    state.lastBar / conditionTrees / proximity / sessionStarts / sessionEnds /
            lastSchedule  (written back at evaluator.ts:76)
Returns:    string | undefined   (a reason = "fired"; undefined = did not fire)
```

### `evaluate_tree` (Python) — `evaluator.py:208`

```
Function:   evaluate_tree(tree, context)                evaluator.py:208-210
Called by:  MarketMonitor._evaluate_trigger              monitor.py (per trigger)
            api._evaluate                                 api.py:398
Calls:      evaluate_node                                 evaluator.py:213
              _evaluate_group (AND/OR/NOT)               evaluator.py:235
              _LEAF_HANDLERS dispatch (24 kinds)          evaluator.py:1058
                indicator_module.compute                  indicators/engine.py:515
                pattern_module.evaluate                   patterns.py:137
                price_action_module.compute               price_action.py:111
                math_expr (parse + evaluate)              math_expr.py
Returns:    ConditionResult
```

### `ConditionEngine._loop` (Python) — `engine.py:268`

```
Started by: ConditionEngine.start()   engine.py:253   (asyncio.create_task)
Calls:      asyncio.to_thread(self.tick_once)          :279
            asyncio.wait_for(self._stopping.wait(), timeout=interval)  :286
Stops on:   ConditionEngine.stop()  → _stopping.set()  engine.py:259
```

### `Watcher.tick` — `watchers/src/watcher.ts:261`

```
Function:   Watcher.tick(event, evaluator, nowMs)        watcher.ts:261
Called by:  WatcherObject.onMarketEvent                   durable-object.ts:247   (the only runtime caller)
Calls:      pruneFireTimestamps                          watcher.ts:268
            queue.expire                                 wake-queue.ts:291
            shouldProcessEvent                           contract.ts:303
            evaluationIdFor                              ids.ts:54
            evaluator.evaluate  (await)                  evaluator.ts:60
            evaluator.fail (on throw)                    evaluator.ts:102
            capBreached / cooldownRemaining              watcher.ts:486, :494
            buildWake                                    wake-queue.ts:328
            queue.enqueue                                wake-queue.ts:171
Mutates:    lastHeartbeatAt, updatedAt, lastMarketDataAt, lastSequence, lastTimestamp,
            lastEvaluationAt, consecutiveEvaluationFailures, lastError,
            lastSuccessfulEvaluationAt, lastConditionStatus, fireTimestamps, lastWakeAt
Returns:    { outcome: 'WOKEN'|'EVALUATED'|'SKIPPED', reason?, wakeId?, … }
```

---

## 3. Who depends on what — module level

| Target | Direct dependents | Indirect / runtime | Test-only |
| --- | --- | --- | --- |
| `src/types/events.ts` | `adapters/hyperliquid/marketData`, `adapters/hyperliquid/demo`, `engine/agents/runtime`, `engine/agents/triggers/engine`, `engine/execution/risk`, `App` | every UI surface via re-render | — |
| `src/types/trading.ts` | nearly every module | — | — |
| `src/engine/agents/runtime.ts` | `App`, `triggers/engine` (via DI), `backtester` (via `backtest.ts`) | `TriggerEngine` → `handleEvent` → `step` | 9 test runners |
| `src/engine/agents/triggers/engine.ts` | `App` only (instance owner) | — | 3 test runners |
| `src/engine/agents/triggers/registry.ts` | `App` (instance owner), `triggers/index` barrel | `TriggerEngine.process` | 3 test runners |
| `src/engine/agents/capabilities/*` | `runtime`, `botDefinition`, `skills/registry` | every `capabilities.execute` call | 2 test runners |
| `src/engine/agents/policy/validator.ts` | `runtime` (default arg) | `runtime.runStep`, `validateExecutionTool` | 2 test runners |
| `src/engine/execution/risk.ts` | `demo.ts`, `runtime.ts`, `App.tsx`, `capabilities/risk.ts` | every order | 2 test runners |
| `src/engine/execution/valuation.ts` | `risk.ts`, `policy/validator.ts`, `demo.ts`, `utils/*` | every exposure/size computation | 2 test runners |
| `src/engine/indicators/index.ts` | `triggers/evaluator.ts:1`, `capabilities/indicators.ts`, `triggers/conditions.ts` | trigger evaluation, indicator capabilities | — |
| `src/engine/conditions/contract.ts` | `botDefinition.ts` (CUSTOM trigger validation), `engineClient.ts` | bot validation, the parity runner | `conditionParity.ts` |
| `src/engine/conditions/engineClient.ts` | `components/triggers/TriggerCard.tsx` | only via the bot-builder trigger card | `conditionParity.ts`, `core/securityTests.ts` |
| `src/adapters/hyperliquid/marketData.ts` | `App`, `demo.ts`, `environment/demo.ts`, `backtester/historical.ts` | discovery, quotes, bars, order pricing | 4 test files |
| `src/adapters/hyperliquid/demo.ts` | `App`, `environment/demo.ts` | every order/close/mark | 1 test file |
| `src/adapters/openrouter/provider.ts` | `agents/model/openrouter.ts`, `App`, `FloatingAIAssistant`, `OpenRouterSettingsModal` | every LLM call | 1 test file |
| `src/services/aiContext/*` | `App` (publish), `FloatingAIAssistant` (read tools) | every AI turn | 1 test file |
| `src/services/wallet/*` | `main.tsx` (provider), `MobileHeader`, `WalletCard` | connect/disconnect | 1 test file |
| `src/services/theme/*` | `main.tsx`, `TradingChart` (`chartTheme`) | theme change | 1 test file |
| `src/utils/orderSize.ts` | `demo.ts:22` | every order sizing | `execution/tests.ts` |
| `src/engine/sandbox/sandboxEnv.ts` | nothing in production | — | `core/securityTests.ts` |
| `src/engine/core/credentials.ts` | nothing imports `credentialStore` | — | `core/securityTests.ts` |
| `src/engine/core/logger.ts` | `core/testRunner.ts`, `securityTests.ts` | — | test-only |
| `server/tradingv_engine/*` | `api.py`, `engine.py`, `monitor.py` internally | HTTP + the poll loop | 10 pytest files |
| `shared/condition_schema_v1.json` | `contract.py:34` | every validate_tree | `test_contract.py` |
| `shared/condition_examples.json` | `engine.py:38` (fixture path is separate), parity runner | `conditionParity.ts` | `test_contract.py` |
| `watchers/src/watcher.ts` | `durable-object.ts` | every DO call | 4 test files |
| `watchers/src/wake-queue.ts` | `watcher.ts`, `durable-object.ts` | every tick | 4 test files |
| `watchers/src/contract.ts` | `index.ts`, `watcher.ts` | config validation, event acceptance, transitions | 3 test files |
| `watchers/src/ids.ts` | `evaluator.ts`, `wake-queue.ts`, `index.ts`, `durable-object.ts` | every id | 2 test files |
| `watchers/src/rate-limit.ts` | `index.ts` | every non-OPTIONS request | 1 test file |
| `watchers/src/health.ts` | `watcher.ts` | every health report | 2 test files |

---

## 4. Indirect dependents (blast radius)

| If this changes | Directly affected | Indirectly affected |
| --- | --- | --- |
| `EventBus.emit` semantics | all 22 event types | every UI re-render, the trigger engine, agent timeline, position accounting |
| `AgentRuntime.runStep` gate order | policy, risk, execution | every agent order, the audit trail, the timeline, AI context |
| `riskManager` limits | `DEFAULT_RISK_LIMITS` `risk.ts:7-24` | every order from the UI and from agents; the AI `riskState` slice |
| `TriggerEngine.canFire` (cooldown/caps) | trigger firing rate | model-call cost, agent wake volume, timeline volume |
| `HyperliquidDemoAdapter` internals | position/trade shape | `TradesTab`, `HistoryTab`, `equity` memo, `riskManager.recordPnL`, AI `trades[]` |
| `shared/condition_schema_v1.json` | Python `contract.py:74` validate | all 24 leaf kinds, the worker config, `conditionParity`, `test_contract.py` |
| `watchers/src/evaluator.ts` response parsing | `status/summary/conditions` only | the wake latch in `Watcher.tick`, `consecutiveEvaluationFailures` |
| `Watcher.tick` cooldown/cap logic | fire rate | the whole wake queue, DO storage writes |
| `CapabilityRegistry.register` | the 31 capabilities | agent permission set, `botDefinition.capabilityIds`, skill resolution |
| `appContextStore` publish shape | AI tools | every AI answer quality; nothing else |

---

## 5. Test-only dependencies (explicitly labelled)

These relationships exist **only** in test files and are not production dependencies.

| Test | Production symbol under test |
| --- | --- |
| `src/engine/agents/triggers/auditRegressionTests.ts` (2149) | `TriggerEngine.process`, `canFire`, `markFired`, `safeSnapshot`, latch states, `redactMessage` |
| `src/engine/agents/triggers/tests.ts` (392) | `TriggerRegistry.register`, `validateDefinition`, `candidates`, transitions |
| `src/engine/agents/triggers/conditionTests.ts` (480) | `evaluateConditionTree`, `evaluateLeaf`, `summariseTree`, `validateConditionTree` |
| `src/engine/agents/pipelineAcceptance.ts` (625) | `AgentRuntime` end-to-end, `registerBot`, `compileBotDefinition` |
| `src/engine/agents/activityTests.ts` (58) | `AgentRuntime.recordPositionEvent`, timeline |
| `src/engine/agents/backtestTests.ts` (52) | `runBotDefinitionBacktest`, `BacktestEnvironment` |
| `src/engine/agents/botDefinitionTests.ts` (79) | `migrateBotDefinition`, `validateBotDefinition`, `cloneBotDefinition` |
| `src/engine/agents/tests.ts` (316) | `registerAgent`, `ActionValidator`, `CapabilityRegistry` |
| `src/engine/conditions/conditionParity.ts` (533) | `ConditionEngineClient` + `shared/condition_examples.json` |
| `src/engine/core/securityTests.ts` (506) | `assertNoSecrets`, `InMemoryCredentialStore`, `sandboxEnv`, `engineClient` secret scan |
| `src/engine/execution/tests.ts` (503) | `RiskManager`, `aggregateExposure`, `leverageRequirement`, `marginForPosition` |
| `src/engine/backtester/historicalTests.ts` (20) | `HyperliquidHistoricalMarketDataProvider.getBars` |
| `src/adapters/hyperliquid/tests.ts` (270) | `marketData` → `trigger` → `agent` pipeline |
| `src/adapters/hyperliquid/executionTests.ts` (858) | `demo.ts` execution lifecycle against fixed quotes |
| `src/adapters/hyperliquid/discoveryTests.ts` (171) | availability policy (`TRADEABLE` vs `UNAVAILABLE`) |
| `src/adapters/hyperliquid/discoverySmoke.ts` (40) | live discovery (network) |
| `src/services/wallet/tests.ts` (366) | `WalletService` abstraction, env handling, security |
| `src/services/theme/tests.ts` (236) | theme resolution/persistence, AI context, navigation |
| `src/services/aiContext/tests.ts` (472) | `appContextStore`, the 11 tools, navigation parsing, prompt building |
| `server/tests/test_*.py` (10 files) | `evaluator`, `indicators`, `patterns`, `contract`, `api`, `edge`, `config`, `math_expr`, `engine` |
| `watchers/test/*.test.ts` (6 files, 138 `it()`) | `Watcher`, `WatcherObject`, `contract`, `wake-queue`, `rate-limit`, `ids`, `health` |
| `watchers/test-runtime/worker.test.ts` (293, 26 `it()`) | the deployed worker end-to-end under `workerd` |
| `watchers/test/source-hygiene.test.ts` (85) | asserts the worker does **not** import `shared/` or `src/engine/` — a dependency-*absence* test |
