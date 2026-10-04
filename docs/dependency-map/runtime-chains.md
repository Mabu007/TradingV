# Runtime Chains

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Summary of the end-to-end execution flows that can be reconstructed from the code.
The nine highest-value chains have individual documents under [`chains/`](chains/).

Each summary below follows the shape:

```
Trigger → 1. function (file:line) → 2. function (file:line) → … → state → consumer
```

---

## Chain index

| # | Chain | Category | Document |
| --- | --- | --- | --- |
| 1 | Application startup | Startup | [chains/application-startup.md](chains/application-startup.md) |
| 2 | Instrument discovery | Market data | [chains/instrument-discovery.md](chains/instrument-discovery.md) |
| 3 | Realtime quote → UI | Realtime | [chains/realtime-quote-to-ui.md](chains/realtime-quote-to-ui.md) |
| 4 | Manual order placement | Create entity | [chains/manual-order-placement.md](chains/manual-order-placement.md) |
| 5 | Position close | Update / delete | [chains/position-close.md](chains/position-close.md) |
| 6 | Trigger fire → agent wake | Trigger evaluation | [chains/pre-goat-trigger-to-agent-wake.md](chains/pre-goat-trigger-to-agent-wake.md) |
| 7 | Agent decision → order | Agent execution | [chains/agent-decision-to-order.md](chains/agent-decision-to-order.md) |
| 8 | Bot creation & deployment | Create entity | [chains/bot-creation-and-deployment.md](chains/bot-creation-and-deployment.md) |
| 9 | Bot backtest | Background | [chains/bot-backtest.md](chains/bot-backtest.md) |
| 10 | Kill switch flatten-all | Risk | [chains/kill-switch-flatten.md](chains/kill-switch-flatten.md) |
| 11 | AI copilot chat | User interaction | [chains/ai-copilot-chat.md](chains/ai-copilot-chat.md) |
| 12 | Python engine tick | Background | [chains/python-engine-tick.md](chains/python-engine-tick.md) |
| 13 | Watcher feed → wake | Realtime | [chains/watcher-feed-to-wake.md](chains/watcher-feed-to-wake.md) |
| 14 | Condition parity (TS ↔ Python) | Cross-process | [chains/condition-parity.md](chains/condition-parity.md) |

---

## 1. Application startup

```
index.html:18  <script type="module" src="/src/main.tsx">
   ↓
src/main.tsx:14  applyThemeAttribute(resolveInitialTheme(localStorage, matchMedia))
   ↓
src/main.tsx:27  createRoot(#root).render(<StrictMode><ErrorBoundary><ThemeProvider>
                                                     <WalletProvider><App/></…>)
   ↓
src/App.tsx:99-111  module init — new TriggerRegistry, new TriggerEngine,
                     triggerEngine.setEnvironment('DEMO')
   ↓
src/App.tsx:399  effect #1 → ensureTriggerEngineStarted() → triggerEngine.start()
                     └ eventBus.onAll(...)                      engine.ts:78
   ↓
src/App.tsx:416  effect #2 → hyperliquidMarketData.getInstruments()  →  external fetch
src/App.tsx:484  effect #3 → userService.getCurrentUser() + onStatusChange + connect()
   ↓
state: eventBus listeners; triggerEngine; agentRuntime.instances; App.instruments
   ↓
consumers: every component re-renders off App state
```

→ full document: [chains/application-startup.md](chains/application-startup.md)

---

## 2. Instrument discovery

```
App effect #2 (App.tsx:416)
   ↓
hyperliquidMarketData.getInstruments(['FOREX','COMMODITY','INDEX'])   marketData.ts:94
   ↓ await fetch POST https://api.hyperliquid.xyz/info  {type:'perpDexs'} then
   │        {type:'metaAndAssetCtxs', dex} per dex                     marketData.ts:54
   ↓ normalizer.classifyAsset / instrumentMetadata / marketAvailability / tradingInstrument
   ↓ returns TradingInstrument[]
   ↓
setInstruments(...)                       App.tsx:426
marketDataService.setSymbols(markets)     App.tsx:436
setSymbol(first or kept)                  App.tsx:443-452
   ↓
4 downstream effects: quote subscriptions (:604), QuotesTab markets (:2366),
                     BotsTab markets (:2437), AI context markets (:1916)
```

→ full document: [chains/instrument-discovery.md](chains/instrument-discovery.md)

---

## 3. Realtime quote → UI

```
Hyperliquid WS message                      marketData.ts:184
   ↓ handleMessage → normalizer.quoteFromBook
   ↓ eventBus.emit({type:'MARKET_QUOTE', data: quote})
   ├──▶ App effect #5 callback             App.tsx:611-643
   │       setQuotes(...)                    :614
   │       marketDataService.updateLastPrice :624
   │       hyperliquidDemoAdapter.markToMarket(quote)  :637  → position P&L mutates
   │
   └──▶ TriggerEngine MARKET_QUOTE branch  engine.ts:80-110
           for each running DEMO agent matching the symbol
           build TriggerInput               :102-105
           process(input)                   :106
             evaluateTrigger                :215
             canFire                        :218
             delivery.wake                  :252 → AgentRuntime.handleEvent
```

→ full document: [chains/realtime-quote-to-ui.md](chains/realtime-quote-to-ui.md)

---

## 4. Manual order placement

```
"Place BUY/SELL Order"                     TradeOrderModal.tsx:249
   ↓ onExecuteOrder(...)                    :258
App.handleExecuteOrder                      App.tsx:849
   ↓ await
hyperliquidDemoAdapter.placeMarketOrder     demo.ts:442
   ├ getInstrument                          demo.ts:457
   ├ validateOrderSize                      utils/orderSize.ts:92
   ├ await marketData.getQuote → fetch      marketData.ts:192, :195
   ├ riskManager.validateOrder              execution/risk.ts:139
   │    └ aggregateExposure                 execution/valuation.ts:346
   ├ riskManager.isKillSwitchActive         risk.ts:81
   ├ balance -= commission; positions.push
   └ eventBus.emit(ORDER); eventBus.emit(POSITION_OPEN)
   ↓
App effect #8 → refreshFromAdapter()        App.tsx:794-808
   ↓ setPositions :798 / setBalance,setMargin,setFreeMargin :804-806
   ↓
state: demo adapter positions/account + App.positions/balance
   ↓
consumers: TradesTab :2305, BottomNav count :2121, equity memo :763, AI :1887
```

→ full document: [chains/manual-order-placement.md](chains/manual-order-placement.md)

---

## 5. Position close

```
close button / kill switch / AI confirm
   ↓
App.handleClosePosition                     App.tsx:916
   ↓ await
hyperliquidDemoAdapter.closePosition(id)
   ├ kill-switch gate
   ├ realised P&L → riskManager.recordPnL  risk.ts:122
   ├ positions.remove; trades.unshift
   └ eventBus.emit({type:'POSITION_CLOSE', data:{position, trade}})
   ↓
App effect #8 listener                      App.tsx:819
   ↓ trades.unshift (dedup by id) :822-828
   ↓ refreshFromAdapter() :834
   ↓
AgentRuntime.recordPositionEvent('CLOSED')  runtime.ts:71-77  → timeline
TriggerEngine.process → POSITION_CLOSE triggers  engine.ts:369-378
   ↓
state: App.trades, App.positions, account mirror, agent timeline,
       AgentRuntime.positionCorrelations.delete  runtime.ts:1502
   ↓
consumers: HistoryTab :2553, TradesTab :2309, accountStats :2635, AI trades[] :1869
```

→ full document: [chains/position-close.md](chains/position-close.md)

---

## 6. Trigger fire → agent wake

```
eventBus: MARKET_QUOTE | BAR_UPDATE | AGENT_ORDER_FILLED
   ↓
TriggerEngine.onAll handler                 engine.ts:78
   ↓ MARKET_QUOTE: iterate runtime.listAgents()  engine.ts:80-110
   ↓   match env.mode === 'DEMO' + symbol        :82
   ↓   build agent-scoped delivery id            :102-105
   ↓   process(input)                            :106
   ↓
TriggerEngine.process                         engine.ts:178
   ├ registry.candidates(symbol)                :188
   ├ dedup via processedEvents                  :196-201
   ├ agent gates: enabled / isRunning / env     :203
   ├ type↔input compatibility                    :206-208
   ├ evaluateTrigger(trigger, input, state)     :215 → evaluator.ts:38
   │    (conditionTree takes precedence          :49-53
   │     else an 18-case switch                  :55-75)
   ├ canFire: cooldown + per-minute cap         :218 → :431-443
   ├ markFired                                  :220 → :445-453
   ├ build AgentTriggerEvent + marketSnapshot   :222-238
   └ await delivery.wake(event)                 :252
   ↓
AgentRuntime.handleEvent                      runtime.ts:1710
   ├ registered + isRunning                    :1717-1722
   ├ 12-type wake allow-list                   :1724-1738
   └ symbol in agent.symbols                   :1748-1756
   ↓ await step()
   ↓
state: TriggerEngine.evaluationStates / lastFired / firingHistory / inFlightTriggers
   ↓
consumers: AgentRuntime → the agent cycle (chain 7)
```

→ full document: [chains/pre-goat-trigger-to-agent-wake.md](chains/pre-goat-trigger-to-agent-wake.md)

---

## 7. Agent decision → order

```
AgentRuntime.step                             runtime.ts:389
   ↓
runStep                                        runtime.ts:414
   ├ observe                                   :264  → env.getMarketQuote :287
   │                                          → env.getMarketBars :289
   │                                          → env.getAccountState :319
   │                                          → env.getPositions :320
   │                                          → env.getOrders :321
   ├ loop (max 5)                              :497-877
   │   ↓ await agentModel.run                 :522 → openRouterProvider.chat
   │   │                                       provider.ts:150 → fetch :194
   │   ├ tool call: capabilities.execute      :703 → registry.ts:34
   │   │            (execution category re-observes :628-631 and
   │   │             pre-validates :633 → :1508)
   │   └ decision: finalDecision              :870-871
   ├ instance.validator.validate              :894 → policy/validator.ts:40
   ├ riskManager.validateOrder (OPEN_POSITION):906 → risk.ts:139
   ├ RISK_CHECK timeline                      :934-963
   ├ if APPROVED:
   │   env.placeMarketOrder                   :979 → environment/demo.ts:42 → demo.ts:442
   │   eventBus.emit(AGENT_ORDER_SUBMITTED)   :988
   │   eventBus.emit(AGENT_ORDER_FILLED)      :1079
   │   positionCorrelations.set                :1050
   ├ memory writes                            :1169-1210
   ├ auditLog.unshift (cap 200)               :1289
   └ timeline DECISION                        :1298
   ↓
state: memory, auditLog, timeline, positions (via the adapter), App account mirror
   ↓
consumers: App effect #8; TriggerEngine ORDER_FILLED triggers; AI context
```

→ full document: [chains/agent-decision-to-order.md](chains/agent-decision-to-order.md)

---

## 8. Bot creation & deployment

```
BotBuilderModal Deploy step                   BotBuilderModal.tsx:183
   ↓ onDeploy(definition, deployment)
BotsTab.onDeploy → App.handleCreateBot        BotsTab.tsx:699 / App.tsx:1116
   ├ requireOpenRouterKey                      App.tsx:1129
   ├ createDeployment                          botDefinition.ts:685
   ├ new DemoEnvironment                       App.tsx:1182
   ├ agentRuntime.registerBot                  App.tsx:1185
   │    → compileBotDefinition                 botDefinition.ts:721
   │        → migrateBotDefinition             :416 → validateBotDefinition :239
   │        → build TradingAgent               :777-822
   │    → registerAgent                        runtime.ts:84 (freeze :88, skills :122,
   │                                            capability intersection :136,
   │                                            secret scan :142, instances.set :185)
   ├ triggerRegistry.registerBotTriggers       registry.ts:42 → register :23
   ├ ensureTriggerEngineStarted                App.tsx:1198
   └ agentRuntime.start(agentId)               App.tsx:1200
   ↓
setBots / setBotDefinitions                    App.tsx:1245, :1261
   ↓
state: agentRuntime.instances, TriggerRegistry maps, App.bots, App.botDefinitions
   ↓
consumers: BotsTab :2440/:2503, BottomNav running count :2124, AI context :1875/:1935
```

→ full document: [chains/bot-creation-and-deployment.md](chains/bot-creation-and-deployment.md)

---

## 9. Bot backtest

```
"Run backtest" → runTest()                    BotBuilderModal.tsx:190
   ↓ onBacktest(definition, market, tf, balance, start, end, onProgress)  :196
App.handleRunBotBacktest                       App.tsx:1555
   ↓ await historicalMarketDataProvider.getBars(...)  :1585
   │      → hyperliquidMarketData.getBarsInRange       marketData.ts:213
   │      → fetch candleSnapshot                       marketData.ts:213+
   ↓ (empty ⇒ throw :1598)
   ↓ createDeployment({mode:'paper'})          :1609
   ↓ marketDataService.getSymbol               :1636
   ↓ await runBotDefinitionBacktest({...})     :1651 → backtest.ts:139
         BacktestEnvironment                   environment/backtest.ts:50
         per bar: setBarIndex/advanceBar       :111, :117
                   evaluateOpenPositions      :126-188 (SL/TP, P&L, Trade)
                   replayAgentBacktest        :377 → runtime.step per bar
         onProgress callback                   App.tsx:1710
         finalize()                            :275
   ↓
state: BacktestEnvironment (balance, equity, positions, closedTrades, equityCurve)
   ↓
result: BotBacktestResult → BotBuilderModal.setTestResult  BotBuilderModal.tsx:126
   ↓
NOT stored in App: App.backtestResult (App.tsx:259) has no writer
```

→ full document: [chains/bot-backtest.md](chains/bot-backtest.md)

---

## 10. Kill switch flatten-all

```
KillSwitchModal "Engage"                      KillSwitchModal.tsx:94
   ↓ onToggleKillSwitch → App.tsx:2869
setIsKillSwitchActive(prev => { riskManager.setKillSwitch(next); return next })
   ↓ riskManager.limits.killSwitchActive = true    risk.ts:102
   ↓ eventBus.emit(STATUS_CHANGE)                  risk.ts:110
   ↓ every subsequent placeMarketOrder is rejected  demo.ts gate

KillSwitchModal "Close All Positions"          KillSwitchModal.tsx:77
   ↓ onFlattenAllPositions → App.handleEmergencyKillSwitch  App.tsx:1740
   ├ riskManager.setKillSwitch(true)              :1751
   ├ positions.forEach(close)                     :1771  (fire-and-forget promises)
   ├ bots.forEach(agentRuntime.stop)              :1784
   ├ setBots(all → 'STOPPED')                     :1796
   └ setShowKillSwitchModal(false)                :1804
   ↓
state: riskManager.limits, App.positions (via the adapter), App.bots, App.isKillSwitchActive
   ↓
consumers: MobileHeader :2200, SettingsTab :2612, AI riskState :1881
```

→ full document: [chains/kill-switch-flatten.md](chains/kill-switch-flatten.md)

---

## 11. AI copilot chat

```
sparkle / onAskAI                              App.tsx:2210, 2338, 2414, 2530, 2557
   ↓ requireOpenRouterKey()                     App.tsx:385
   ├ no key → setShowAIModal(true); abort
   └ key → setExternalAIPrompt(prompt)          App.tsx:2217
   ↓
FloatingAIAssistant effect                     FloatingAIAssistant.tsx:118-127
   ↓ send(prompt)                               :227
   ├ gatherContext(selectSlices(text))          :152-169
   │    → 11 read-only tools → appContextStore  aiContext/tools.ts:32-161
   │      ← snapshot published by App.tsx:1853
   ├ hasProviderKey === false → short-circuit   :254
   ↓ await openRouterProvider.chat              provider.ts:150 → fetch :194
   ↓ parseNavigationAction(text)                :307
   ↓
user taps the rendered action button → handleAction  :337
   ├ onSelectMarket      → App.tsx:2679
   ├ onNavigate          → App.tsx:2701
   ├ onInspectTrigger    → App.tsx:2689
   ├ onTestTrigger       → App.tsx:2695
   └ onClosePosition     → App.handleClosePosition  App.tsx:916
```

→ full document: [chains/ai-copilot-chat.md](chains/ai-copilot-chat.md)

---

## 12. Python engine tick

```
ConditionEngine.start()                        engine.py:250
   ↓ asyncio.create_task(self._loop())         :253
ConditionEngine._loop()                        :268
   ↓ while not self._stopping.is_set()
   ↓ await asyncio.to_thread(self.tick_once)   :279   ← thread boundary
ConditionEngine.tick_once                      :298
   ↓ MarketMonitor.tick                        monitor.py:319
      ├ refresh()                              monitor.py:254
      │    └ CandleStore.get → _fetch → HyperliquidMarketData.candles
      │        → urllib POST                  marketdata.py:137-149
      │    └ cache.invalidate on success      monitor.py:272
      └ evaluate_all()                        monitor.py:282
           └ per trigger: MonitorContextBuilder.for_symbol  store.py:168
           └ evaluate_tree                     evaluator.py:208
                └ 24 leaf kinds                evaluator.py:1058
                     └ indicator_module.compute  indicators/engine.py:515
           └ EdgeDetector.observe              edge.py:134
                ↓ cooldown / hourly / daily / latch   edge.py:150-232
                ↓ Decision.FIRED
ConditionEngine._enqueue → deque append (cap 200)   engine.py:237
   ↓
await asyncio.wait_for(self._stopping.wait(), timeout=interval)   engine.py:286
   ↑ interval = max(min(poll_interval, minEvalInterval/1000), 1.0)  engine.py:289
```

→ full document: [chains/python-engine-tick.md](chains/python-engine-tick.md)

---

## 13. Watcher feed → wake

```
POST /feed  (X-Feed-Token)                     watchers/src/index.ts:147
   ├ consumeRate(env,'feed','feed')            index.ts:106
   ├ constantTimeEquals                        index.ts:155
   └ group events by market                    index.ts:177-183
   ↓ per market → watchersForMarket            index.ts:210
   ↓   MARKET_INDEX.list()                     index.ts:211
   ↓   identity → watcherIdFor                 ids.ts:49
   ↓ per event
   ↓ await stub.onMarketEvent(event)           index.ts:193
   ↓
WatcherObject.onMarketEvent                    durable-object.ts:242
   ├ ready()                                   :92
   ├ before = [status, lastConditionStatus, lastWakeAt, lastMarketDataAt]  :245
   ↓ watcher.tick(event, evaluator, now)       watcher.ts:261
   │   ├ queue.expire                          wake-queue.ts:291
   │   ├ shouldProcessEvent                    contract.ts:303
   │   ├ minEvaluationIntervalMs gate          watcher.ts:294
   │   ↓ await evaluator.evaluate             evaluator.ts:60
   │   │   ↓ fetch {ENGINE_URL}/evaluate      evaluator.ts:66
   │   │      → server/tradingv_engine/api.py:344
   │   ├ latch / cap / cooldown                watcher.ts:342-390
   │   └ queue.enqueue(buildWake(...))         wake-queue.ts:171
   └ if before !== after → save()              durable-object.ts:249
   ↓ 3 × ctx.storage.put                       durable-object.ts:121-125
   ↓
external agent: GET /watchers/{id}/wakes       index.ts:316
                POST …/wakes:claim             index.ts:321 → durable-object.ts:277
                POST …/wakes:resolve           index.ts:327 → durable-object.ts:286
```

→ full document: [chains/watcher-feed-to-wake.md](chains/watcher-feed-to-wake.md)

---

## 14. Condition parity (TS ↔ Python)

```
bun run test:conditions                         package.json:20
   ↓
conditionParity.ts reads shared/condition_examples.json
   ↓ for each canonical tree
ConditionEngineClient.test(tree, contextName)   engineClient.ts:243
   ├ assertCanonical (local schema check)       engineClient.ts:177
   ↓ await fetch POST {ENGINE_URL}/test        engineClient.ts:148
      → server/tradingv_engine/api.py:307
          contract.validate_tree                contract.py:74
          engine.fixture_context(name)          engine.py:181
              → server/tests/fixtures/{name}.json
          evaluate_tree                         evaluator.py:208
   ↓ compare status + per-condition statuses against the expected block
   ↓
same examples, Python side: server/tests/test_conditions.py
```

→ full document: [chains/condition-parity.md](chains/condition-parity.md)

---

## Chains that do not exist in this repository

Recorded so the absence is not mistaken for an omission.

| Expected chain | Status | Evidence |
| --- | --- | --- |
| Live order signing | **NOT PRESENT** | no signing code in `src/adapters/hyperliquid/`; `createLiveEnvironment()` throws `environment/live.ts:3-5`; `registerAgent` rejects LIVE `runtime.ts:112-116`; `HYPERLIQUID_PRIVATE_KEY` is declared server-only `config/env.ts:144-147` and read nowhere |
| Server-side order placement | **NOT PRESENT** | `marketdata.py:117` is a public `/info` reader only; `__main__.py:71-78` warns when `live_trading_enabled` |
| Database persistence | **NOT PRESENT** | no DB package in any manifest; no connection string in any config |
| Authentication (user sessions) | **NOT PRESENT** in the browser path | `userService` reads a `localStorage` profile; Privy supplies a wallet identity but no server-side session |
| Push delivery of wakes to an agent | **NOT PRESENT** | the worker exposes only pull endpoints; `wrangler.toml` declares no queue producer |
| Cron-driven market polling in the worker | **NOT PRESENT** | no `scheduled` export; no `[triggers]` in `wrangler.toml`; the market feed is push-only via `POST /feed` |
