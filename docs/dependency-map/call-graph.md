# Call Graph

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Forward direction: `CALLER → FUNCTION → CALLEE`, with `file:line` evidence.
Async boundaries are marked `await`; a `→` (not `↓`) means control returns before the
callee finishes.

Reverse direction (who calls what) is in
[Reverse Dependencies](reverse-dependencies.md) and per-symbol in the module documents.

---

## 1. Application Startup

```
index.html:18   <script type="module" src="/src/main.tsx">
   ↓
src/main.tsx:14  applyThemeAttribute(resolveInitialTheme(localStorage, matchMedia))
   ↓ calls
src/services/theme/theme.ts   resolveInitialTheme()  → 'dark' | 'light'
   ↓
src/main.tsx:27  createRoot(document.getElementById('root')).render(...)
   ↓ renders
StrictMode
   └ ErrorBoundary            src/components/layout/ErrorBoundary.tsx
       └ ThemeProvider        src/services/theme/ThemeProvider.tsx
           └ WalletProvider  src/services/wallet/WalletProvider.tsx
               └ App          src/App.tsx:2084
   ↓
src/App.tsx:99   module init:  new TriggerRegistry(id => agentRuntime.getAgent(id))
src/App.tsx:103  module init:  new TriggerEngine(triggerRegistry, agentRuntime, timeline)
src/App.tsx:109  module init:  triggerEngine.setEnvironment('DEMO')
   ↓
src/App.tsx:399  useEffect([]) → ensureTriggerEngineStarted()
   ↓ calls  src/App.tsx:150
triggerEngine.start()          src/engine/agents/triggers/engine.ts:76
   ↓ registers
eventBus.onAll(...)            engine.ts:78
```

**Evidence** — `src/main.tsx:27-42`, `src/App.tsx:99-111`, `engine.ts:76-78`.

---

## 2. Instrument Discovery

```
src/App.tsx:399  useEffect([])   [effect #2, line 416]
   ↓ calls  src/App.tsx:419
hyperliquidMarketData.getInstruments(['FOREX','COMMODITY','INDEX'])
        src/adapters/hyperliquid/marketData.ts:94
   ↓ await fetch(https://api.hyperliquid.xyz/info)      marketData.ts:54
   ↓ parses perpDexs → metaAndAssetCtxs per dex
   ↓ maps via normalizer.ts  classifyAsset / instrumentMetadata /
   │                        marketAvailability / tradingInstrument
   ↓ returns  TradingInstrument[]
   ↓
src/App.tsx:426  setInstruments(discovered)
src/App.tsx:436  marketDataService.setSymbols(markets)      services/marketData.ts:35
src/App.tsx:443  keeps current `symbol` if still present, else selects the first
```

**Downstream** — `instruments` change triggers:
- `subscribedInstrumentIds` memo (`App.tsx:596`) → quote-subscription effect (`:604`)
- `discoveredSymbols` memo (`App.tsx:2063`) → `QuotesTab.symbols` (`:2366`)
- `marketsFromDiscovery(instruments)` (`:2437`) → `BotsTab.markets`
- AI context `markets[]` publish (`:1916`)

---

## 3. Realtime Quote → UI

```
Hyperliquid WebSocket  wss://api.hyperliquid.xyz/ws        marketData.ts:180
   ↓ socket.onmessage = (message) => this.handleMessage(message.data)   marketData.ts:184
handleMessage()
   ↓ normalizer.ts  quoteFromBook / fromHyperliquidCandle
   ↓ eventBus.emit({ type:'MARKET_QUOTE', data: quote })     marketData.ts (quote path)
   ↓ eventBus.emit({ type:'BAR_UPDATE', symbol, timeframe, bar, isClosed })
   ↓
   ├──────────────────────────────────────────────────────────────┐
   ↓                                                              ↓
App effect #5 (App.tsx:604) subscribes quote            TriggerEngine listener (engine.ts:80)
   ↓ cb App.tsx:611-643                               ↓ for each running DEMO agent matching symbol
   ↓ setQuotes(prev => ({...prev, [sym]: quote}))      ↓ build TriggerInput (engine.ts:102-105)
   ↓ marketDataService.updateLastPrice(sym, mid)        ↓ this.process(input)  engine.ts:106
   ↓ hyperliquidDemoAdapter.markToMarket(quote)               ↓ evaluateTrigger(...)  engine.ts:215
   ↓                                                      ↓ canFire(...)            engine.ts:218
   ↓                                                      ↓ delivery.wake(event)    engine.ts:252
   ↓                                                      ↓
   ↓ re-render: QuotesTab.quotes → TradeOrderModal / TradingChart
   ↓           AI context markets[].bid/ask  App.tsx:1923-1924
   ↓
App effect #7 (App.tsx:714) subscribes bars
   ↓ cb App.tsx:724-749  upsert by bar.time, cap .slice(-260)
   ↓ setBars
```

**Evidence** — `App.tsx:604-650`, `App.tsx:714-756`, `marketData.ts:180-184`,
`engine.ts:80-110`, `engine.ts:252`.

---

## 4. Manual Order Placement

```
User taps "Place BUY/SELL Order"
   ↓
TradeOrderModal.handleExecute                    components/modals/TradeOrderModal.tsx:249
   ↓ props.onExecuteOrder({symbol, side, volume, stopLoss, takeProfit})   :258
App.handleExecuteOrder                           src/App.tsx:849
   ↓ await
hyperliquidDemoAdapter.placeMarketOrder(params)  adapters/hyperliquid/demo.ts:442
   ↓
   ├ getInstrument(symbol)                       demo.ts:457 → marketData.ts:398
   ├ validateOrderSize(...)                      utils/orderSize.ts:92
   ├ marketData.getQuote(symbol)                 marketData.ts:192  (await fetch l2Book :195)
   │     ↑   BUY fills at quote.ask  /  SELL fills at quote.bid
   ├ riskManager.validateOrder(...)              engine/execution/risk.ts:139
   │     └ aggregateExposure(...)                engine/execution/valuation.ts:346
   ├ riskManager.isKillSwitchActive()            risk.ts:81
   ├ account.balance -= commission               demo.ts (account mutation)
   ├ positions.push(newPosition)                 demo.ts
   └ eventBus.emit({type:'ORDER'})               demo.ts
   ↓         eventBus.emit({type:'POSITION_OPEN', data: position})   demo.ts
   ↓
   ├ App.handleExecuteOrder returns {success, message?, category?}   App.tsx:901-908
   │     └ on failure: eventBus.emit({type:'LOG', ...'order-rejected'})  App.tsx:884
   │
   ↓ eventBus listener
App effect #8 (App.tsx:793)  refreshFromAdapter()  :794-808
   ↓
   setPositions(...)          :798
   setBalance/setMargin/setFreeMargin  :804-806
   ↓ re-render → TradesTab.positions, BottomNav.openPositionsCount,
                equity memo (App.tsx:763), AI context
```

**Async boundary** — `placeMarketOrder` is `await`ed; `getQuote` is an HTTP round trip
to Hyperliquid per order.

---

## 5. Position Close

```
User taps close  (TradesTab → PositionDetailModal, or kill switch, or AI confirm)
   ↓
App.handleClosePosition                          src/App.tsx:916
   ↓ await
hyperliquidDemoAdapter.closePosition(positionId)  adapters/hyperliquid/demo.ts
   ├ riskManager.isKillSwitchActive() gate
   ├ computes realised P&L, appends to trades
   ├ removes from positions
   └ eventBus.emit({type:'POSITION_CLOSE', data:{position, trade}})   demo.ts
   ↓
App effect #8 listener at App.tsx:819
   ↓ trades.unshift(event.data.trade)   (dedup by trade id)   App.tsx:822-828
   ↓ refreshFromAdapter()               :834
   ↓ setPositions / setBalance / setMargin / setFreeMargin
   ↓
AgentRuntime (constructor subscription, runtime.ts:60-77)
   ↓ eventBus.on('POSITION_CLOSE') → recordPositionEvent(id,'CLOSED',{position, tradeId})
TriggerEngine (eventBus.onAll, engine.ts:78) → inputFromDomainEvent → process()  engine.ts:113
```

---

## 6. Trigger Fire → Agent Wake

```
eventBus emits MARKET_QUOTE | BAR_UPDATE | ORDER/AGENT_ORDER_FILLED
   ↓
TriggerEngine.start's onAll handler             triggers/engine.ts:78
   ↓ MARKET_QUOTE branch: iterate runtime.listAgents()          engine.ts:80-110
   ↓   for each agent with env.mode === 'DEMO' and symbol match:
   ↓     build quoteEvent with delivery id `quote:${symbol}:${ts}:${agentId}`  :102-105
   ↓   this.process(input)                     engine.ts:106
   ↓
TriggerEngine.process(input)                   engine.ts:178
   ├ CUSTOM trigger refused                     :179-182
   ├ input validation (env, timestamp, symbol, not LIVE)        :183-186
   ├ deliveryKey = `${environment}:${input.id}`                 :187
   ├ registry.candidates(symbol) → filter + sort by priority    :188-193
   ├ per-trigger dedup via processedEvents                      :196-201
   ├ agent gates: enabled, isRunning, env.mode match           :203
   ├ type/input-type compatibility gates                        :206-208
   ├ evaluation state created for `${env}:${triggerId}`          :209-211
   ├ bars truncated to last 1000                                :214
   ├ reason = evaluateTrigger(trigger, input, state)            :215  → evaluator.ts:38
   ├ if (!reason || !canFire(...) || inFlight) continue         :218
   ├ markFired(trigger, ts)                                    :220  → engine.ts:445
   ├ build AgentTriggerEvent (marketSnapshot from indicators)    :222-238
   ├ timeline.append(TRIGGER)                                   :241
   ↓ await
this.delivery.wake(triggerEvent)                engine.ts:252
   ↓   (delivery built in constructor, engine.ts:64-73)
AgentRuntime.handleEvent(agentId, event)        runtime.ts:1710
   ├ require registered + isRunning              :1717-1722
   ├ wake-type allow-list (12 types)             :1724-1738
   ├ symbol must be in agent.symbols             :1748-1756
   ↓ await
AgentRuntime.step(agentId, event)               runtime.ts:389
```

**Evaluation branches inside `evaluateTrigger`** (`evaluator.ts:38-78`):
a `conditionTree` on the trigger takes precedence over the single trigger type
(`evaluator.ts:49-53`); otherwise a switch over 18 types at `evaluator.ts:55-75`.

---

## 7. Agent Decision → Order

```
AgentRuntime.step                                runtime.ts:389
   ↓ (re-entrancy guard activeCycles.add)         :405
AgentRuntime.runStep                             runtime.ts:414
   ↓
   ├ observe(agentId)                             runtime.ts:264  (:445)
   │    env.getMarketQuote(symbol)                :287
   │    env.getMarketBars(symbol, timeframe, 15)  :289
   │    env.getAccountState()                     :319
   │    env.getPositions()                        :320
   │    env.getOrders()                           :321
   │    capabilities.execute('market.getSession') :343   (only if allowed)
   │
   ├ timeline.append(OBSERVATION)                 runtime.ts:480
   │
   ├ LOOP (maxIterations = 5)                     runtime.ts:497,508
   │    ↓ await  this.model.run({...})            runtime.ts:522
   │    agentModel.run                            agents/model/openrouter.ts:6
   │      └ openRouterProvider.chat               adapters/openrouter/provider.ts:150
   │           ↓ await fetch(https://openrouter.ai/...)   provider.ts:194
   │    │
   │    ├─ tool-call branch                       runtime.ts:589-785
   │    │    capabilities.get(capId)              :626
   │    │    if category === 'execution': re-observe        :628-631
   │    │    validateExecutionTool(instance, …)             :633  → :1508
   │    │        instance.validator.validate(...)  policy/validator.ts:40
   │    │        riskManager.validateOrder(...)   execution/risk.ts:139
   │    │    ↓ await capabilities.execute(capId, input, ctx)  capabilities/registry.ts:34
   │    │        validateCapabilityInput          registry.ts:59
   │    │        validateCapabilityScope          registry.ts:93
   │    │        capability.execute(input, ctx)   e.g. capabilities/execution.ts:26
   │    │           └ env.placeMarketOrder(...)   environment/demo.ts:42
   │    │    toolHistory.push + AGENT_TOOL_RESULT emit  :736-751
   │    │    continue
   │    │
   │    └─ decision branch                        runtime.ts:790-874
   │         isAgentDecision guard                :791
   │         ANALYZE → run a capability, continue :809-867
   │         otherwise finalDecision = decision; break  :870-873
   │
   ├ resolveInstruments(instance)                 runtime.ts:886
   ├ instance.validator.validate(decision, policy, observation)  :894 → policy/validator.ts:40
   ├ riskManager.validateOrder(order, positions, false, ctx)     :906 → execution/risk.ts:139
   ├ timeline.append(RISK_CHECK)                  runtime.ts:934
   │
   ├ EXECUTION (only if validation.code === 'APPROVED')  runtime.ts:970
   │    OPEN_POSITION:
   │      ↓ await instance.env.placeMarketOrder({...})  runtime.ts:979
   │        environment/demo.ts:42 → adapters/hyperliquid/demo.ts:442
   │      eventBus.emit(AGENT_ORDER_SUBMITTED)     runtime.ts:988
   │      eventBus.emit(AGENT_ORDER_FILLED)        runtime.ts:1079
   │      positionCorrelations.set(positionId, …)   runtime.ts:1050
   │    MODIFY_POSITION → env.modifyPosition      runtime.ts:1107
   │    CLOSE_POSITION  → env.closePosition       runtime.ts:1116
   │
   ├ memory writes (lastDecision, decisionHistory, lastCycleAt, …)  runtime.ts:1169-1210
   ├ auditLog.unshift (cap 200)                   runtime.ts:1289-1296
   ├ timeline.append(DECISION)                    runtime.ts:1298
   └ return finalDecision                         runtime.ts:1344
```

**Gate order is observable and fixed** (CONFIRMED):
`policy` (`runtime.ts:894`) → `risk` (`runtime.ts:906`) → `environment`/adapter
(`runtime.ts:979`). There is no path from the model to the adapter that skips either
gate.

---

## 8. Bot Creation & Deployment

```
BotBuilderModal 'Deploy' step                     components/views/BotBuilderModal.tsx:183
   ↓ onDeploy(definition, deployment)
BotsTab.onDeploy                                 BotsTab.tsx:699-702
   ↓ onCreateBot({name, symbol, timeframe, strategyCode, definition, deployment})
App.handleCreateBot                              App.tsx:1116
   ├ requireOpenRouterKey()                      App.tsx:1129
   ├ createDeployment(...)                       botDefinition.ts:685
   ├ new DemoEnvironment()                       App.tsx:1182
   ├ agentRuntime.registerBot(definition, deployment, symbol, demoEnv)   App.tsx:1185
   │     ↓ runtime.ts:190 → compileBotDefinition(...)  botDefinition.ts:721
   │     ↓   → migrateBotDefinition  :416  → validateBotDefinition  :239
   │     ↓   → builds TradingAgent   :777-822
   │     ↓ runtime.ts:84 registerAgent
   │     ↓   deep-freeze :88, reject LIVE :112, resolve skills :122,
   │     ↓   intersect capabilities :136, reject secret-shaped fields :142,
   │     ↓   ScopedAgentMemory :157, instances.set(agentId, instance) :185
   ├ triggerRegistry.registerBotTriggers(definition, agentId, symbol)   App.tsx:1192
   │     ↓ registry.ts:42 → registry.register(trigger) per trigger  :23
   │         validateDefinition :101, owner checks :25-30, dedupe :31,
   │         100-per-agent cap :32, cloneTrigger :33, index by symbol :37
   ├ ensureTriggerEngineStarted()                App.tsx:1198
   └ agentRuntime.start(agentId)                 App.tsx:1200 → runtime.ts:208
   ↓
setBots([newBot, ...prev])                       App.tsx:1245
setBotDefinitions([definition, ...prev])         App.tsx:1261
```

There is a second, **legacy** branch in the same handler (`App.tsx:1281-1547`) that
constructs a `TradingAgent` literal inline, registers a default `NEW_BAR` trigger, and
starts. Both branches are reachable depending on whether `botData.definition` is
present.

---

## 9. Bot Backtest

```
BotBuilderModal 'Run backtest'                   BotBuilderModal.tsx:227
   ↓ runTest()                                   BotBuilderModal.tsx:190
   ↓ onBacktest(definition, market, tf, balance, start, end, setTestProgress)  :196
App.handleRunBotBacktest                         App.tsx:1555
   ├ requireOpenRouterKey() (throws)             App.tsx:1570
   ├ await historicalMarketDataProvider.getBars({marketId, timeframe, start, end})  :1585
   │     engine/backtester/historical.ts:40-42 → hyperliquidMarketData.getBarsInRange()
   │     → fetch candleSnapshot                marketData.ts:213
   ├ if (bars.length === 0) throw                App.tsx:1594
   ├ createDeployment({mode:'paper', …})         App.tsx:1609
   ├ marketDataService.getSymbol(marketId)       App.tsx:1636 (throws if unknown :1640)
   ↓ await runBotDefinitionBacktest({...})       App.tsx:1651
        agents/backtest.ts:139
        ↓ constructs BacktestEnvironment         agents/environment/backtest.ts:50
        ↓   state: balance, equity, maxEquitySeen, currentBarIndex, bars,
        ↓          positions Map, closedTrades, spreadPrice, slippagePrice,
        ↓          commissionPerLot, lotSize, leverage, pricePrecision
        ↓ per-bar loop:
        ↓   BacktestEnvironment.setBarIndex / advanceBar   backtest.ts:111,117
        ↓     └ evaluateOpenPositions(bar)  SL/TP checks, P&L, Trade push  :126-188
        ↓   replayAgentBacktest(runtime, agentId, env)  backtest.ts:377
        ↓     └ runtime.step(agentId, wakeEvent) per bar   runtime.ts:389
        ↓   onProgress(...) callback
        ↓ finalize() closes all, records equity  backtest.ts:275
   ↓ returns BotBacktestResult
   ↓ BotBuilderModal setTestResult(...)          BotBuilderModal.tsx:126
```

**Note (CONFIRMED)** — `App.backtestResult` (`App.tsx:259`) is never written, so
`BotsTab.backtestResult` (`App.tsx:2527`) is always `null`. The result lives in
`BotBuilderModal` local state.

---

## 10. Kill Switch → Flatten All

```
KillSwitchModal 'Engage'                         KillSwitchModal.tsx:94
   ↓ onToggleKillSwitch
App inline handler                               App.tsx:2869-2885
   setIsKillSwitchActive(prev => { riskManager.setKillSwitch(next); return next })
   ↓
riskManager.setKillSwitch(true)                  engine/execution/risk.ts:102
   ↓ mutates riskManager.limits
   ↓ eventBus.emit({type:'STATUS_CHANGE'})       risk.ts:110

KillSwitchModal 'Close All Positions'            KillSwitchModal.tsx:77
   ↓ onFlattenAllPositions
App.handleEmergencyKillSwitch                    App.tsx:1740
   ├ riskManager.setKillSwitch(true)             App.tsx:1751
   ├ setIsKillSwitchActive(riskManager.isKillSwitchActive())   App.tsx:1758
   ├ positions.forEach(p => handleClosePosition(p.id))        App.tsx:1771
   │     ↓ await hyperliquidDemoAdapter.closePosition(id)
   ├ bots.forEach(b => agentRuntime.stop(b.agentId))           App.tsx:1784
   ├ setBots(all → status 'STOPPED')             App.tsx:1796
   └ setShowKillSwitchModal(false)               App.tsx:1804
```

**Note (CONFIRMED)** — the `killSwitchActive` flag is also re-gated inside
`HyperliquidDemoAdapter.placeMarketOrder` (`demo.ts`), so after engagement every
subsequent order is rejected before the adapter reaches the risk validator.

---

## 11. AI Copilot Chat

```
User taps sparkle / onAskAI
   ↓ App handler requires a key
requireOpenRouterKey()                           App.tsx:385-392
   ├ no key → setShowAIModal(true) and abort
   └ key present → setExternalAIPrompt(prompt)  App.tsx:2217/2345/2421/2540/2564
   ↓
FloatingAIAssistant useEffect([externalPrompt])   FloatingAIAssistant.tsx:118-127
   ↓ setIsOpen(true); void send(externalPrompt); onClearExternalPrompt()
   ↓
FloatingAIAssistant.send(prompt)                 FloatingAIAssistant.tsx:227
   ├ buildContextPrefix(gatherContext(selectSlices(text)))   :269
   │    selectSlices — keyword match over available slices   :136-150
   │    gatherContext — calls the read-only AI tools          :152-169
   │        getCurrentAppContext / getAccountState / getOpenPositions /
   │        getRecentTrades / getAvailableMarkets / getMarketQuote /
   │        getBots / getBot / getTriggers / getRiskState / getWalletState
   │        services/aiContext/tools.ts:32-161
   │        ↑ all read appContextStore.state  (store.ts:134)
   ├ hasProviderKey === false → short-circuit    :254
   ↓ await openRouterProvider.chat(...)
       adapters/openrouter/provider.ts:150 → callOpenRouter :163 → fetch :194
   ↓ parse response
parseNavigationAction(text)                     FloatingAIAssistant.tsx:307
   ↓ if action present, render a button
handleAction                                    FloatingAIAssistant.tsx:337
   ├ onSelectMarket(next) → App.setSymbol + setCurrentTab('quotes')   App.tsx:2679
   ├ runNavigation(target)  → App.onNavigate → tabForNavigation()    App.tsx:2701
   ├ onInspectTrigger()     → setShowTriggerBuilder(true)           App.tsx:2689
   └ onTestTrigger()        → setShowTriggerBuilder(true)           App.tsx:2695

Position close via AI:
FloatingAIAssistant 'Confirm and close'          FloatingAIAssistant.tsx:463-481
   ↓ onClosePosition(actionableTrade.id)
App.handleClosePosition                          App.tsx:916
```

The AI path reaches the order/position machinery **only** through a user tapping a
rendered button. There is no direct `App → adapter` edge from AI code.

---

## 12. Python Engine Tick

```
server/tradingv_engine/__main__.py:19  main()
   ↓ load_config()                       __main__.py:52 → config.py:111
   ↓ assert_local_only(config.host)     __main__.py:63 → config.py:144
   ↓ uvicorn.run(app, host, port)       __main__.py:90  (app from create_app, :81)
   ↓ FastAPI startup hook
api.py:206  @app.on_event("startup") → await engine.start()   api.py:208
   ↓
ConditionEngine.start()                  engine.py:250
   ↓ asyncio.create_task(self._loop())    engine.py:253
ConditionEngine._loop()                  engine.py:268
   ↓ while not self._stopping.is_set()
   ↓ await asyncio.to_thread(self.tick_once)      engine.py:279   ← thread boundary
ConditionEngine.tick_once(now)           engine.py:298
   ↓ MarketMonitor.tick(now)             monitor.py:319
      ↓ refresh()                        monitor.py:254
      │    ↓ required_series()          monitor.py:235
      │    ↓ CandleStore.get(sym, tf, refresh=True)   store.py:69
      │         ↓ MarketMonitor._fetch monitor.py:160
      │            ↓ HyperliquidMarketData.candles   marketdata.py:257
      │               ↓ _transport(...)  marketdata.py:275
      │                  ↓ _http_post → urllib.request.urlopen   marketdata.py:137-149
      │    ↓ cache.invalidate(...) on success      monitor.py:272
      ↓ evaluate_all(now)                monitor.py:282
           ↓ per trigger: MonitorContextBuilder.for_symbol  store.py:168
           ↓ evaluate_tree(tree, context)     evaluator.py:208
           │    ↓ evaluate_node               evaluator.py:213
           │    ↓ _evaluate_group (AND/OR/NOT) evaluator.py:235
           │    ↓ _LEAF_HANDLERS dispatch (24 kinds)  evaluator.py:1058
           │        ↓ indicator_module.compute(...)  indicators/engine.py:515
           ↓ EdgeDetector.observe(status, now)  edge.py:134
                ↓ cooldown / hourly cap / daily cap / latch   edge.py:150-232
                ↓ returns Decision.FIRED | ALREADY_TRUE | COOLDOWN | RATE_LIMITED
                  | NOT_READY | DISABLED
                ↓ on FIRED:
                ↓   event_log.emit(TRIGGER_FIRED)      monitor.py (via self.log)
                ↓   WakeEvent appended to monitor.wakes monitor.py:156
ConditionEngine.tick_once maps WakeEvent → QueuedWake   engine.py:298-307
   ↓ _enqueue → deque append (cap 200)  engine.py:237
   ↓ return list of QueuedWake
_loop sleeps:  await asyncio.wait_for(self._stopping.wait(), timeout=interval)  engine.py:286
   ↑ interval = _effective_interval_s() = max(min(poll_interval, minEvalInterval/1000), 1.0)  engine.py:289
```

---

## 13. Watcher Feed → Wake

```
External producer  →  POST /feed            (no in-repo caller — INFERRED)
   ↓
watchers/src/index.ts:79  default.fetch(request, env, ctx)
   ↓ route(request, env)                    index.ts:88
   ↓ consumeRate(env, 'feed', 'feed')       index.ts:106 → rate-limit.ts:77 → RateLimitObject.take index.ts:403
   ↓ handleFeed(request, env)               index.ts:147
   ├ MARKET_FEED_TOKEN absent → 503         index.ts:150
   ├ constantTimeEquals(X-Feed-Token, …)    index.ts:155
   ├ body { events: MarketEvent[] }, cap 1000  index.ts:160-166
   └ group events by market                 index.ts:177-183
   ↓ per market
watchersForMarket(env, market)              index.ts:210
   ↓ MARKET_INDEX.idFromName('market:'+market) → index.list()   index.ts:211
   ↓ per identity → watcherIdFor(identity)  ids.ts:49
   ↓ per event per watcher
   ↓ await stub.onMarketEvent(event)        index.ts:193
   ↓
WatcherObject.onMarketEvent(event)          durable-object.ts:242
   ├ ready()                                durable-object.ts:92
   ├ snapshot before = [status, lastConditionStatus, lastWakeAt, lastMarketDataAt]  :245
   ↓ watcher.tick(event, evaluator(), now)  watcher.ts:261
   │    ├ mutate lastHeartbeatAt/updatedAt  watcher.ts:262
   │    ├ pruneFireTimestamps(now)          watcher.ts:268
   │    ├ queue.expire(now) → expired[]     wake-queue.ts:291
   │    ├ shouldProcessEvent(event, state, now)   contract.ts:303
   │    │    reject → SKIPPED with a named reason (DUPLICATE/STALE/OUT_OF_ORDER/
   │    │            WRONG_MARKET/FUTURE_TIMESTAMP/PAUSED/NOT_RUNNING)  :313-315
   │    ├ record lastMarketDataAt / lastSequence / lastTimestamp   :290-292
   │    ├ minEvaluationIntervalMs gate      watcher.ts:294
   │    ├ evaluationId = evaluationIdFor(...) ids.ts:54            :303
   │    ↓ await evaluator.evaluate(config, event)   evaluator.ts:60
   │    │    ↓ await fetch(`${baseUrl}/evaluate`, {tree, market, nowMs})  evaluator.ts:66
   │    │       └ → server/tradingv_engine/api.py:344 evaluate_live
   │    │    ↓ normalizeStatus(→ TRUE|FALSE|UNKNOWN)   evaluator.ts:160
   │    ├ lastEvaluationAt = now            :312
   │    ├ UNKNOWN branch: consecutiveEvaluationFailures += 1; lastError set;
   │    │   lastConditionStatus deliberately untouched   :314-336
   │    ├ definite branch: reset failures   :338-340
   │    ├ latch: previous vs current lastConditionStatus  :342-344
   │    ├ capBreached(now) / cooldownRemaining(now)      :365,:382
   │    └ buildWake(...) → queue.enqueue(wake, now)       :392,:406
   ├ snapshot after
   └ if (before !== after) save()           durable-object.ts:249
         ↓ 3 × ctx.storage.put              durable-object.ts:121-125
   ↓ response { accepted, results }
   ↓
External agent pulls GET /watchers/{id}/wakes   index.ts:316
   ↓ pendingWakes()  → durable-object.ts:261
   ↓ POST /watchers/{id}/wakes:claim → claimWakes  durable-object.ts:277
   │    └ acknowledgeWake each, then save()  durable-object.ts:282
   ↓ POST /watchers/{id}/wakes:resolve → resolveWake  durable-object.ts:286
        └ queue.resolve(id, outcome, now) → terminalise   wake-queue.ts:242,316
```

**Note (CONFIRMED)** — the route regex at `index.ts:125` is
`/^\/watchers\/([A-Za-z0-9_]+)(?:\/(\w+))?$/`. The action segment `\w+` does not match
`wakes:claim` / `wakes:resolve` (they contain `:`), so those two HTTP branches fall
through to the 404 at `index.ts:140`. The DO RPC methods remain callable directly.

---

## 14. Condition Parity Check (TS ↔ Python)

```
package.json:20  test:conditions → bun src/engine/conditions/conditionParity.ts
   ↓
reads shared/condition_examples.json
   ↓ for each canonical tree
ConditionEngineClient.test(tree, contextName)   engineClient.ts:243
   ↓ assertCanonical(tree) first (local schema check)   engineClient.ts:177
   ↓ HTTP POST {ENGINE_URL}/test             engineClient.ts:144
      → server/tradingv_engine/api.py:307 test_condition
          ↓ contract.validate_tree(tree)     contract.py:74
          ↓ engine.fixture_context(name)     engine.py:181
              → _load_fixture_contexts()     engine.py:346
                  → server/tests/fixtures/{name}.json
          ↓ evaluate_tree(tree, context)     evaluator.py:208
   ↓ compares status + per-condition statuses against the expected block
```

The Python side has its own parity path: `server/tests/test_conditions.py` runs the
same examples through `evaluate_tree` directly.

---

## Async Boundary Index

| Boundary | Location | Kind |
| --- | --- | --- |
| Hyperliquid REST | `marketData.ts:54,195,213`; `marketdata.py:146` | `await fetch` / `urllib.urlopen` |
| Hyperliquid WebSocket | `marketData.ts:180-184` | `new WebSocket` + `onmessage` callback |
| OpenRouter | `provider.ts:194` | `await fetch` |
| Python engine client | `engineClient.ts:148` | `await doFetch` with `AbortController` timeout |
| Worker → engine | `evaluator.ts:66` | `await fetch` with 8 s `AbortController` |
| Python poll loop | `engine.py:279,286` | `asyncio.to_thread` + `asyncio.wait_for` |
| FastAPI lifecycle | `api.py:208,212` | `await engine.start()/stop()` |
| Backtest progress | `App.tsx:1710` → `BotBuilderModal.tsx:128` | callback |
| Provider config save | `provider.ts:131` | synchronous `localStorage.setItem` |
| Theme apply | `theme.ts` (module init) | synchronous `document` attribute write |
