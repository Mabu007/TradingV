# Data Flow

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

How the significant objects travel, are transformed, and are consumed. Objects that
do not exist in this repository are not described.

Cross-cutting conventions: `Created by` / `Modified by` / `Read by` / `Passed to` /
`Returned from` / `Persisted by` / `Displayed by` / `Destroyed by`.

---

## 1. `Quote` — live bid/ask

```
Hyperliquid l2Book / allMids  ──fetch──▶ adapters/hyperliquid/marketData.ts:195
   ↓ normalizer.quoteFromBook(...)        normalizer.ts
   ↓ Quote { symbol, bid, ask, spread, timestamp, … }   types/trading.ts
   ↓
   ├─▶ App.setQuotes(prev => ({...prev, [sym]: quote}))     App.tsx:614
   │      → QuotesTab.quotes                                  App.tsx:2371
   │      → TradeOrderModal (entry price: ask for BUY, bid for SELL)  TradeOrderModal.tsx:91-101
   │      → AI context markets[].bid/ask                      App.tsx:1923-1924
   │
   ├─▶ marketDataService.updateLastPrice(sym, (bid+ask)/2)   App.tsx:624
   │      → MarketDataService internal last price            services/marketData.ts:65
   │
   ├─▶ hyperliquidDemoAdapter.markToMarket(quote)            App.tsx:637
   │      → open positions' unrealizedPnL (mutated)
   │
   └─▶ env.getMarketQuote(symbol)                            runtime.ts:287
          → DemoEnvironment → demo.ts:12 → marketData.ts:192
          → AgentObservation.market.quote                     runtime.ts:363
          → LLM prompt (openRouter provider.ts:163)
          → market.getQuote capability                         capabilities/market.ts:26
```

| Field | Value |
| --- | --- |
| Created by | `HyperliquidMarketDataAdapter.getQuote()` `marketData.ts:192`; also `subscribeQuote` callback `marketData.ts:223` |
| Modified by | never in place — `App` replaces the map entry (`App.tsx:614`) |
| Read by | `QuotesTab`, `TradeOrderModal`, `TradingChart`, `DemoEnvironment`, `market.getQuote` capability, `AI_CONTEXT_TOOLS` |
| Passed to | `placeMarketOrder` (as the fill price), `markToMarket`, agent observation |
| Returned from | `getQuote()`, `subscribeQuote` callbacks, `getMarketQuote()` |
| Persisted by | nothing |
| Displayed by | `QuotesTab` rows, order ticket, AI context |
| Destroyed by | React re-render / map replacement |

---

## 2. `Bar` — OHLCV candle

```
Hyperliquid candleSnapshot
   ├─ historical ─fetch─▶ marketData.getBars(sym, tf, 260)        App.tsx:541
   │                        → getBarsInRange                     marketData.ts:213
   │                        ↓ fromHyperliquidCandle(raw)         normalizer.ts:31
   │                        ↓ Bar[]
   │                        ↓ setBars(historicalBars)            App.tsx:546
   │
   └─ realtime ─ws──▶ subscribeBars callback                      App.tsx:720
                        ↓ fromHyperliquidCandle
                        ↓ App.bars (upsert by bar.time, cap 260)  App.tsx:724-749
                        ↓
                        ├─▶ TradingChart                          QuotesTab.tsx:328
                        ├─▶ triggerTestContext (memo)             App.tsx:2034
                        └─▶ TriggerBuilder live preview           TriggerBuilder.tsx:96
   ↓
   ↓ separately
   └─▶ env.getMarketBars(sym, tf, 15)                            runtime.ts:289
         → AgentObservation.market.recentBars                    runtime.ts:363
         → calculateTriggerIndicators(...)                       evaluator.ts:144
         → market.getBars capability (cap 300)                   capabilities/market.ts:65
         → structure.* capabilities                              capabilities/structure.ts
   ↓
   └─▶ historicalMarketDataProvider.getBars({start,end})         App.tsx:1585
         → runBotDefinitionBacktest({bars})                      App.tsx:1651
         → BacktestEnvironment.bars                              environment/backtest.ts:56
```

---

## 3. `InstrumentMetadata` / `TradingInstrument`

**Path A — browser (live):**

```
Hyperliquid perpDexs + metaAndAssetCtxs
   ↓ marketData.ts:94 getInstruments()
   ↓ normalizer.classifyAsset / instrumentMetadata / marketAvailability / tradingInstrument
   ↓ TradingInstrument[]        types/instruments.ts
   ↓
App.instruments                 App.tsx:174 (set at :426)
   ├─▶ subscribedsInstrumentIds memo → quote-subscription effect   App.tsx:596, :604
   ├─▶ discoveredSymbols memo → QuotesTab.symbols                 App.tsx:2063, :2366
   ├─▶ marketsFromDiscovery → BotsTab.markets                     App.tsx:2437
   ├─▶ TriggerBuilderPanel.markets                                 App.tsx:2746
   ├─▶ AI context markets[]                                        App.tsx:1916
   └─▶ marketDataService.setSymbols(markets)                       App.tsx:436
   ↓
DemoEnvironment.getInstruments()   environment/demo.ts:26
   ↓ resolveInstruments(instance)  runtime.ts:886 → :1352
   ↓ ActionValidator context        policy/validator.ts:29
   ↓ riskManager context (instruments)  risk.ts:27
   ↓ market.getSpread pipSize branch  capabilities/market.ts:129
```

**Path B — Python (server):**

```
Hyperliquid /info  {type:'perpDexs'} then {type:'metaAndAssetCtxs', dex}   marketdata.py:155,175
   ↓ load_instruments()                       marketdata.py:153-239
   ↓ Instrument(side, availability, decimals, pipSize, …)   marketdata.py:75
   ↓ availability from midPx / markPx > 0      marketdata.py:204-212
   ↓
   ├─▶ API GET /instruments                   api.py:253-267
   │      → ConditionEngineClient.instruments()   engineClient.ts:213
   └─▶ MonitorContextBuilder.for_symbol (tradeable gate)   store.py:194-195
```

**Note (CONFIRMED)** — the browser normalizer and the Python `marketdata.py` derive
availability from the same price fields (`midPx` then `markPx`) but are separate
implementations. The Python side never reads `oraclePx` (`marketdata.py:204-206`).

---

## 4. `Position`

```
Created by:  HyperliquidDemoAdapter.placeMarketOrder()          demo.ts:442
             BacktestEnvironment.placeMarketOrder()              environment/backtest.ts:282
             demo.ts:441(quote) → new position, pushed to positions
             backtest.ts:294 position id `sim_pos_<barIndex>_<n>`
   ↓
eventBus.emit({type:'POSITION_OPEN', data: position})            demo.ts
   ↓
   ├─▶ App.setPositions(...)                        App.tsx:798   (via effect #8)
   │      → TradesTab.positions                      App.tsx:2305
   │      → BottomNav.openPositionsCount             App.tsx:2121
   │      → QuotesTab.positions overlay              App.tsx:2379
   │      → equity memo (balance + Σ unrealizedPnL)  App.tsx:763
   │      → KillSwitchModal.openPositionsCount       App.tsx:2866
   │      → AI context positions[]                   App.tsx:1887
   │
   ├─▶ agentRuntime.recordPositionEvent(id,'UPDATED'|'CLOSED')   runtime.ts:60-77
   │      → timeline records
   │
   ├─▶ TriggerEngine.inputFromDomainEvent → process()   engine.ts:369-378
   │      → position triggers: POSITION_OPEN / POSITION_UPDATE / POSITION_CLOSE
   │      → STOP_APPROACHING / TARGET_APPROACHING proximity triggers  evaluator.ts:310
   │      → positionCorrelations / agentByPosition maps    engine.ts:51, :1050
   │
   └─▶ AI tools getOpenPositions()                  services/aiContext/tools.ts:61

Modified by:  markToMarket(quote)                demo.ts  (unrealizedPnL)
              BacktestEnvironment.evaluateOpenPositions(bar)  environment/backtest.ts:126-188
              env.modifyPosition(positionId, changes)          runtime.ts:1107
   ↓
eventBus.emit({type:'POSITION_UPDATE', data: position})

Destroyed by: hyperliquidDemoAdapter.closePosition()   demo.ts
              BacktestEnvironment.closePosition()      environment/backtest.ts:332
   ↓
eventBus.emit({type:'POSITION_CLOSE', data:{position, trade}})
   ↓ App.trades unshift                          App.tsx:822-828
   ↓ TriggerEngine position close triggers       engine.ts:369
   ↓ AgentRuntime.recordPositionEvent('CLOSED')  runtime.ts:71
   ↓ positionCorrelations.delete(positionId)     runtime.ts:1502
```

| Field | Value |
| --- | --- |
| Read by | `equity` memo `App.tsx:763`; policy `validator.ts:144-186`; risk `risk.ts:163`; `account.getPositions` `capabilities/account.ts:67` |
| Passed to | `riskManager.validateOrder(openPositions)` `runtime.ts:906`; `aggregateExposure` `valuation.ts:346` |
| Persisted by | nothing (in-memory only) |
| Displayed by | `TradesTab`, `PositionDetailModal`, `QuotesTab` overlay, `FloatingAIAssistant` |
| Destroyed by | close, or the emergency kill switch loop `App.tsx:1771` |

---

## 5. `Trade` (closed)

```
Created by:  demo adapter on close         demo.ts
             BacktestEnvironment.closePosition  environment/backtest.ts:154-169
   ↓
eventBus.emit({type:'POSITION_CLOSE', data:{position, trade}})
   ↓
App.trades.unshift(trade) (dedup by id)         App.tsx:822-828
   ↓
   ├─▶ TradesTab.trades                          App.tsx:2309
   ├─▶ HistoryTab.trades                         App.tsx:2553
   ├─▶ QuotesTab.trades                          App.tsx:2387
   ├─▶ accountStats.tradesCount (memo)           App.tsx:2635
   └─▶ AI context trades[] + recentTrades()      App.tsx:1869, tools.ts:65
   ↓
riskManager.recordPnL(...)  ← realised P&L feeds the daily-loss budget   risk.ts:122
```

---

## 6. `BotDefinition`

```
Sources (4):
  1. user/AI quick-build  compileQuickBuild(prompt)   botDefinition.ts:831
  2. builder wizard        BotBuilderModal generate/save  BotBuilderModal.tsx:147,159
  3. explorer templates    EXPLORER_BOTS (24)         explorer.ts:24-33
  4. clone                 cloneBotDefinition(definition)  botDefinition.ts:661
   ↓ every source funnels through
migrateBotDefinition(input)  botDefinition.ts:416    (coerce to schema, then validate :476)
   ↓
validateBotDefinition(def)    botDefinition.ts:239
   ├─ validateIdentity / validateIntent / validateSkills / validateCapabilities
   ├─ validateTriggers  (empty array → 'Add at least one trigger to wake the bot.' :341)
   ├─ validateRisk / validateExecution / validateAI
   ↓
   ├─▶ App.setBotDefinitions([...])                  App.tsx:1261
   │      → BotsTab.botDefinitions                   App.tsx:2503
   │      → AI context bots[].triggers               App.tsx:1935
   │      → compileBotDefinition → TradingAgent     botDefinition.ts:721
   │          → agentRuntime.registerBot             runtime.ts:190
   │          → triggerRegistry.registerBotTriggers  registry.ts:42
   │
   ├─▶ runBotDefinitionBacktest(definition, …)       backtest.ts:139
   │      → BacktestEnvironment
   │      → replayAgentBacktest(runtime, agentId)    backtest.ts:377
   │
   └─▶ compileBotDefinition(definition, deployment, runtimeSymbol, env)  botDefinition.ts:721
          → TradingAgent {
              id: `${botId}:${deployment.id}`       botDefinition.ts:778
              capabilities: capabilityIds(caps)      :794-796
              enabled: deployment.status === 'active' :809-810
              allowedSymbols: [runtimeSymbol]        :756
              allowTrading = caps.orders && caps.automation  :773-774
            }
   ↓
AgentRuntime.registerAgent(agent, env)   runtime.ts:84
   → deep-frozen (:88-110), skill-resolved (:122-140),
     secret-key scan (:142-152), ScopedAgentMemory (:157),
     instances.set(agent.id, instance) (:185)
```

| Field | Value |
| --- | --- |
| Modified by | `migrateBotDefinition` (normalization only), `cloneBotDefinition` |
| Read by | `validateBotDefinition`, `compileBotDefinition`, `capabilityIds`, `registerBotTriggers` |
| Persisted by | nothing — React state + module singletons only |
| Displayed by | `BotsTab` list, `BotBuilderModal` review step, `TriggerLabCard` |
| Destroyed by | reload; no delete path for definitions exists in `App.tsx` |

---

## 7. `BotTrigger` / `ConditionTree`

```
Sources (3):
  1. Trigger Lab draft   TriggerBuilder.handleSave    TriggerBuilder.tsx:106-126
       → App.setLabTriggers(upsert)                   App.tsx:2768
  2. Bot definition trigger  BotDefinition.triggers[]  botDefinition.ts:180
       → triggerRegistry.registerBotTriggers          registry.ts:42
  3. Python engine /legacy server trigger  POST /triggers  api.py:276
   ↓
ConditionTree (canonical form: { schemaVersion, then, root })
   ↓
Three independent consumers:
  A. In-browser trigger engine
       triggerRegistry.register(trigger)              registry.ts:23
         → validateDefinition (incl. conditionTree must be a GROUP with children)  :157-162
       TriggerEngine.process → evaluateTrigger        engine.ts:215
         → conditionTreeOf(trigger)                   evaluator.ts:85
         → evaluateConditionTreeTrigger               evaluator.ts:101
             → evaluateConditionTree                  conditions.ts:755
                 → evaluateNode / evaluateLeaf        conditions.ts:689, :388
                 → calculateRSI/ATR/EMA/SMA/MACD      engine/indicators/index.ts
         → edge-triggered latch                        evaluator.ts:113-121
  B. Python engine (watchers fleet, and the legacy client)
       shared/condition_schema_v1.json validation     contract.py:74
       evaluate_tree → 24 leaf kinds                  evaluator.py:208
  C. Trigger Lab live preview (client-side, on every keystroke)
       validateConditionTree(root)                    TriggerBuilder.tsx:90
       evaluateConditionTree(root, context)           TriggerBuilder.tsx:96
   ↓
   ├─▶ App.triggers[] AI context slice               App.tsx:1957-1968
   └─▶ read-only AI tool getTriggers()               tools.ts:124
```

**Note (CONFIRMED)** — lab triggers saved into `App.labTriggers` are **drafts**: they
are published to the AI context (`App.tsx:1957`) but never registered with
`triggerRegistry`. Only `BotDefinition.triggers[]` reach the runtime.

---

## 8. `AgentObservation`

```
AgentRuntime.observe(agentId)                    runtime.ts:264
   ↓ symbol = symbols[0] || 'EURUSD'              runtime.ts:271
   ↓ policy boundary check (every symbol must be in policy.allowedSymbols)  :273-285
   ├─ env.getMarketQuote(symbol)                  runtime.ts:287
   ├─ env.getMarketBars(symbol, timeframe, 15)    runtime.ts:289-293
   │    + bar sanity (all OHLC + time finite)     :295-305
   ├─ quote sanity (bid>0, ask>=bid, finite)      :307-317
   ├─ env.getAccountState()                       runtime.ts:319
   ├─ env.getPositions()                          runtime.ts:320
   ├─ env.getOrders()                             runtime.ts:321
   ├─ account finiteness check                    :323-334
   └─ capabilities.execute('market.getSession')   runtime.ts:338-361  (if allowed)
   ↓
AgentObservation { timestamp, environment, market{quotes,quote,recentBars,spread,session},
                   account, positions, orders, availableCapabilities, availableSkills,
                   recentMemories }               runtime.ts:363-381
   ↓
   ├─▶ timeline OBSERVATION (trimmed to last 50 bars)  runtime.ts:480-488 / :1922
   ├─▶ agentModel.run({agent, observation, instructions, skillsInstructions,
   │                    toolHistory, capabilitySchemas, iteration, wakeReason})  :522-548
   │     → openRouterProvider.chat                 provider.ts:150
   │     → fetch(openrouter)                       provider.ts:194
   └─▶ ActionValidator.validate(decision, policy, observation)  runtime.ts:894
         → referencePrice(observation, symbol)     policy/validator.ts:14
```

Clock note (CONFIRMED): `nowFor(instance)` (`runtime.ts:1371-1382`) returns the
backtest bar timestamp when `env.mode === 'BACKTEST'`, else `Date.now()`. The
observation timestamp therefore differs per environment.

---

## 9. `AgentDecision` — the LLM output

```
openRouter response text
   ↓ agentModel parses the JSON envelope
   ↓ isAgentDecision(decision) guard                 runtime.ts:1794
   ↓ branches:
   │   { toolCall: { capabilityId, input } }         runtime.ts:589-785
   │       → permission check against allowedCapabilities  :613-624
   │       → (execution category) validateExecutionTool      :633
   │       → capabilities.execute(capId, input, ctx)         :702
   │       → toolHistory.push(sanitised)                    :736
   │       → loop continues (max 5 iterations)               :497
   │
   │   { action: 'OPEN_POSITION' | 'MODIFY_POSITION' | 'CLOSE_POSITION'
   │   | 'ANALYZE' | 'WAIT', …, confidence, reason }         runtime.ts:790-874
   ↓
finalDecision                                    runtime.ts:870-871
   ↓
resolveInstruments(instance)                      runtime.ts:886
   ↓
ActionValidator.validate(decision, policy, observation, {instruments})   runtime.ts:894
   ↓ AgentActionValidationResult { valid, code, reason }    policy/validator.ts:40
   ↓
   ├─ invalid → RISK_CHECK timeline REJECTED → no execution   runtime.ts:957-963
   └─ valid && code === 'APPROVED'                             runtime.ts:970
       ↓
RiskManager.validateOrder(order, positions, recordAcceptedOrder=false, ctx)  runtime.ts:906
   ↓
   ├─ invalid → validation overridden to RISK_REJECTED        runtime.ts:925-931
   └─ valid
       ↓
env.placeMarketOrder / env.modifyPosition / env.closePosition   runtime.ts:979, :1107, :1116
   ↓
instance.memory: lastDecision, decisionHistory.append, lastDecisionTimestamp,
                lastWakeEvent, lastCycleAt, lastActionResult   runtime.ts:1169-1210
   ↓
auditLog.unshift(AgentAuditRecord)                 runtime.ts:1289
   ↓
timeline DECISION                                  runtime.ts:1298
```

| Field | Value |
| --- | --- |
| Created by | the LLM, parsed in `agents/model/openrouter.ts` |
| Modified by | never in place |
| Read by | `ActionValidator`, `RiskManager`, memory, audit, timeline |
| Passed to | `env.placeMarketOrder({...})` `runtime.ts:979` |
| Persisted by | none (memory + audit only) |
| Displayed by | `BotsTab` activity poll via `handleGetBotActivity` `App.tsx:1719` |
| Destroyed by | `ScopedAgentMemory` is per-agent and process-lifetime |

---

## 10. `AgentWakeEvent`

```
Trigger source                                   TriggerEngine.process
   ↓ evaluateTrigger returns a reason              engine.ts:215
   ↓ canFire passes (cooldown + per-minute cap)    engine.ts:218 → canFire :431
   ↓
AgentTriggerEvent { triggerId, triggerType, marketSnapshot, input,
                   data:{triggerId, triggerType, reason, sourceEventId,
                         correlationId} }          engine.ts:222-238
   ↓ marketSnapshot built by safeSnapshot()          engine.ts:513-525
   ↓   last 50 bars + calculateTriggerIndicators()   engine.ts:222, evaluator.ts:144
   ↓ correlationId precedence:                      engine.ts:69
   ↓   1) `${agentId}:trade:${tradeId}`   (AGENT_ORDER_FILLED input)
   ↓   2) `${agentId}:position:${positionId}`
   ↓   3) `${agentId}:${triggerId}:${timestamp}`
   ↓
delivery.wake(event)                               engine.ts:252
   ↓ wakeType(triggerType) maps the 18 trigger types to 13 wake types  engine.ts:466-482
   ↓ AgentWakeEvent { type, timestamp, symbol, data }                   runtime.ts:232-238
   ↓
AgentRuntime.handleEvent(agentId, event)          runtime.ts:1710
   ├ 12-type allow-list check                      runtime.ts:1724-1738
   └ symbol must be in agent.symbols               runtime.ts:1748-1756
   ↓ step(agentId, event)                          runtime.ts:389
```

---

## 11. `EvaluateResult` (Python → worker)

```
watchers/src/evaluator.ts:66
   POST {ENGINE_URL}/evaluate
   body: { tree: WatcherConfig.conditionTree, market: MarketEvent.market, nowMs }
   ↓
server/tradingv_engine/api.py:344  evaluate_live
   ├ contract.validate_tree(request.tree)          api.py:348 → 422 on failure
   ├ engine.triggers_for_market(request.market)    api.py:351
   │    (404 if no registered trigger watches that market)
   └ _evaluate(tree, context)                      api.py:396-404
        ├ evaluate_tree(tree, context)             evaluator.py:208
        ├ ConditionResult.to_json() per condition  evaluator.py:99
        ├ explanation = _explain(tree)             api.py:407-411 → evaluator.py:1096
        └ textures = condition_textures(tree)      contract.py:126
   ↓ response 200
{ status: 'TRUE'|'FALSE'|'UNKNOWN',
  summary, conditions: [...], explanation, textures }    api.py:132-137
   ↓
watchers/src/evaluator.ts:78-89
   ├ normalizeStatus(response.status)              evaluator.ts:160-166
   │   (anything not TRUE/FALSE/UNKNOWN → UNKNOWN)
   └ builds EvaluationOutcome { evaluationId, status, summary,
                               durationMs, conditions }
   ↓
Watcher.tick uses status for the latch             watcher.ts:342-344
```

**Note (CONFIRMED)** — the worker reads only `status`, `summary` and `conditions`
(`evaluator.ts:78`). `explanation` and `textures` are discarded at the client boundary.

**Failure path** — non-2xx, abort, or timeout:
`HttpConditionEvaluator.fail(config, event, error)` `evaluator.ts:102-117` returns a
synchronous `UNKNOWN` with `durationMs: 0`, distinguishing timeout/abort from
unreachable via `/abort|timeout/i` (`evaluator.ts:105`). `Watcher.tick` increments
`consecutiveEvaluationFailures` and sets `lastError` (`watcher.ts:324-329`) but
deliberately leaves `lastConditionStatus` untouched (`watcher.ts:315-323`), so the
latch is preserved across an outage.

---

## 12. `Wake` (worker → external agent)

```
buildWake({ watcherId, botId, deploymentId, marketEventId, evaluationId,
            configVersion, conditions, context, nowMs })   wake-queue.ts:328-355
   ↓ id = wakeIdFor(watcherId, marketEventId, configVersion)  ids.ts:67
   ↓   → `wk_` + 13-char digest
   ↓ context = { market, price, timeframe }         watcher.ts:402
   ↓ reason  = "for the AI. Never an order."        wake-queue.ts:75
   ↓
WakeQueue.enqueue(wake, now)                        wake-queue.ts:171-205
   ├ duplicate already pending  → { accepted:false, reason:'DUPLICATE' }        :172-174
   ├ duplicate already terminal → { accepted:false, reason:'DUPLICATE' }        :175-177
   ├ over maxSize (100) → drop oldest, terminalise it as QUEUE_FULL             :183-201
   └ pending.set(wake.id, wake)                     :203
   ↓
WatcherObject.save()  (only if the change snapshot differs)   durable-object.ts:249
   ↓ pending wakes → KV 'watcher:pending-wakes'               :125
   ↓
External consumer:  GET /watchers/{id}/wakes                  index.ts:316
   POST /watchers/{id}/wakes:claim  → claimWakes(limit=10)    :321 → durable-object.ts:277
        └ acknowledgeWake(id) then save()                     :281-282
   POST /watchers/{id}/wakes:resolve → resolveWake(id, outcome)  :327 → durable-object.ts:286
        └ queue.resolve(...) → terminalise                     wake-queue.ts:242, :316
   ↓
terminal wakes → KV 'watcher:terminal-wakes'                  :122
```

Downstream contract for a real executor: `idempotencyKeyFor(wakeId, attempt)` →
`tv-<wakeId>-a<attempt>` (`ids.ts:79-81`). No production call site exists in
`watchers/src`; it is asserted only by tests
(`watchers/test/watcher.test.ts:119-124`, `watchers/test/adversarial.test.ts:317-323`).

---

## 13. `AppContextState` (App → AI)

```
App effect #9 (App.tsx:1852-2002)
   deps: currentTab, symbol, timeframe, executionMode, balance, equity, margin,
         freeMargin, positions, trades, instruments, quotes, bots, botDefinitions,
         labTriggers, isKillSwitchActive, walletState        App.tsx:1998-2001
   ↓ builds a sanitised snapshot:
   { currentTab, currentView, selectedMarket, selectedTimeframe, selectedBotId,
     executionMode, account{...riskState}, positions[], trades[], markets[],
     bots[], triggers[], riskLimits{...riskManager.getLimits()},
     wallet{...walletState, liveExecutionEnabled:false} }    App.tsx:1853-1996
   ↓
appContextStore.publish(snapshot)                   store.ts:98
   ↓ (module singleton, no listener notification)
getCurrentAppContext() / getAccountState() / getOpenPositions() / getRecentTrades()
getAvailableMarkets() / getMarketQuote() / getBots() / getBot() / getTriggers()
getRiskState() / getWalletState() / getFullContext()    tools.ts:32-165
   ↓
FloatingAIAssistant.gatherContext(selectSlices(text))   FloatingAIAssistant.tsx:152-169
   ↓
buildContextPrefix(...)                              prompt.ts
   ↓ prepended to the user message
openRouterProvider.chat(...)                          provider.ts:150
```

**Direction is strictly one-way.** The AI tools hold no reference to React state and
write nothing. AI-initiated navigation reaches App only through props callbacks
(`onNavigate`, `onSelectMarket`, `onInspectTrigger`, `onTestTrigger`,
`onClosePosition`) at `App.tsx:2656-2726`.

`selectedBotId` is read from `selectedBotIdRef` (`App.tsx:1858`), a `useRef` at
`App.tsx:365` that has **no writer** in the codebase — so it is always `undefined`
(CONFIRMED by grep for `.current` assignment).

---

## 14. Execution-mode data

```
App.executionMode: 'BACKTEST' | 'DEMO' | 'LIVE'   App.tsx:180-181 (init 'DEMO')
   ↓ MobileHeader.onToggleMode = handleModeSelect   App.tsx:2185
handleModeSelect(mode)                              App.tsx:1822
   ├ mode === 'LIVE' → setShowLiveConfirm(true)     App.tsx:1829
   │    LiveConfirmModal.isOpen                     App.tsx:2904
   │    → onClose only (App.tsx:2908) — no path to set 'LIVE'
   └ otherwise → setExecutionMode(mode)             App.tsx:1836
   ↓ read by
   ├─ MobileHeader / TradesTab / BotsTab / SettingsTab   (display)
   ├─ triggerTestContext.state.environment               App.tsx:2026
   ├─ AI context executionMode + wallet.liveExecutionEnabled:false  App.tsx:1859, :1996
   └─ (not read by the engine — engine environments are
       chosen at registerAgent time, App.tsx:1182)
```

**CONFIRMED**: `executionMode` in App state is a UI-level label. The actual
environment an agent runs in is fixed by the `ITradingEnvironment` instance passed to
`registerAgent` (`runtime.ts:84-87`) and the engine filter
`agent.env.mode === input.environment` (`engine.ts:82, :121, :203, :285`).
`createLiveEnvironment()` throws (`environment/live.ts:3-5`) and
`registerAgent` rejects `mode === 'LIVE'` (`runtime.ts:112-116`).

---

## 15. `WatcherState` (worker)

```
POST /watchers body { botId, deploymentId, config }        index.ts:234-237
   ↓ validateWatcherConfig(config)                          index.ts:239 → contract.ts:188
   ↓ userId comes from the bearer token, never the body     index.ts:247
   ↓ identity = { userId, botId, deploymentId }              index.ts:248
   ↓ watcherId = watcherIdFor(identity)  → `w_` + 13 chars  ids.ts:49
   ↓
WatcherObject.deploy({identity, config, expectedWatcherId}) durable-object.ts:140
   ↓ Watcher.create(...) / restore(...) / updateConfig()   durable-object.ts:169-186
   ↓ applyAction('deploy') → nextStatus transition          contract.ts:126 → :100
   ↓ save()                                                  durable-object.ts:208
   ↓
REGISTRY.add(identity)          index.ts:259   → KV 'identities'  UserRegistryObject
MARKET_INDEX.add(identity)     index.ts:261   → KV 'identities'  MarketIndexObject (key 'market:'+market)
   ↓
later: POST /feed  →  watchersForMarket(env, market)  index.ts:210
   → MARKET_INDEX.list()  →  identity  →  watcherIdFor()  →  DO id  index.ts:211-214
   ↓
WatcherObject.ready()  re-reads KV 'watcher:state'  durable-object.ts:92-110
   → Watcher.restore(state)                              watcher.ts:191
   → WakeQueue.restoreTerminal(restore)                  wake-queue.ts:215-224
```

Config limits applied at write time (`contract.ts:174-180`): `configVersion` positive
integer, non-empty `name`, non-empty `market`, `conditionTree` present with ≤200 nodes,
and range checks on the four numeric fields. `updateConfig` bumps `configVersion`
(`durable-object.ts:184`), which changes `evaluationIdFor`/`wakeIdFor` inputs
(`ids.ts:54, :67`) and terminalises older pending wakes as `CONFIG_CHANGED`
(`wake-queue.ts:261-271`).
