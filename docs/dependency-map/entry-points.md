# Entry Points

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Every place execution enters the system, what triggers it, and where it goes next.

---

## 1. Browser application

| Entry point | File | Symbol | Trigger |
| --- | --- | --- | --- |
| HTML script tag | `index.html:18` | `<script type="module" src="/src/main.tsx">` | page load |
| Pre-paint theme | `src/main.tsx:14-25` | `applyThemeAttribute(resolveInitialTheme(...))` | module import |
| React mount | `src/main.tsx:27` | `createRoot(document.getElementById('root')!).render(...)` | script execution |
| App component | `src/App.tsx:2084` | `App()` | React render |
| Module init | `src/App.tsx:99-111` | `new TriggerRegistry(...)`, `new TriggerEngine(...)`, `setEnvironment('DEMO')` | module import (before first render) |
| Effect #1 — engine start | `src/App.tsx:399-409` | `useEffect([])` → `ensureTriggerEngineStarted()` (`App.tsx:150-157`) | mount, latched by module `triggerEngineStarted` |
| Effect #2 — discovery | `src/App.tsx:416-477` | `useEffect([])` → `hyperliquidMarketData.getInstruments()` `:419` | mount |
| Effect #3 — user + connect | `src/App.tsx:484-526` | `useEffect([])` → `userService.getCurrentUser()` `:487`, `hyperliquidMarketData.onStatusChange()` `:514`, `.connect()` `:520` | mount |
| Effect #4 — historical bars | `src/App.tsx:533-577` | `useEffect([symbol, timeframe])` → `getBars(symbol, timeframe, 260)` `:541` | mount + symbol/timeframe change |
| Effect #5 — quote subscriptions | `src/App.tsx:604-650` | `useEffect([subscribedInstrumentIds])` → `subscribeQuote()` ×N `:611` | instruments discovered |
| Effect #6 — initial quote | `src/App.tsx:666-707` | `useEffect([symbol])` → `getQuote(symbol)` `:673` | symbol change |
| Effect #7 — bar subscriptions | `src/App.tsx:714-756` | `useEffect([symbol, timeframe])` → `subscribeBars()` `:720` | symbol/timeframe change |
| Effect #8 — execution mirror | `src/App.tsx:793-842` | `useEffect([])` → `refreshFromAdapter()` `:794` + three `eventBus.on` `:811/:815/:819` | mount |
| Effect #9 — AI context publish | `src/App.tsx:1852-2002` | `useEffect([…18 deps])` → `appContextStore.publish()` `:1853` | any of 18 state changes |

### Vite dev server

| Entry point | File | Symbol | Trigger |
| --- | --- | --- | --- |
| Dev server | `vite.config.ts:14-20` | `server.hmr` / `server.watch` (gated on `DISABLE_HMR`) | `bun run dev` (`package.json:7`) → `vite --port=3000 --host=0.0.0.0` |
| Alias `@` → repo root | `vite.config.ts:10-12` | `resolve.alias` | every import resolution |

---

## 2. User-interaction entry points (handler → chain)

| User action | Handler | File:line | Chain |
| --- | --- | --- | --- |
| Tap a bottom-nav tab | inline `onTabChange` | `App.tsx:2106-2118` | `setCurrentTab` + clear overlays |
| Tap "Connect Wallet" | `walletService.connect()` | `MobileHeader.tsx:181` | → `WalletProvider.tsx:109` `privy.connectOrCreateWallet()` |
| Tap disconnect | `service.disconnect()` | `WalletCard.tsx:72` | → `WalletProvider.tsx:119-120` |
| Select a market | `onSelectSymbol` | `App.tsx:2402-2408` | `setSymbol` |
| Change timeframe | `onTimeframeChange` | `App.tsx:2394-2400` | `setTimeframe` → effects #4, #7 |
| Open the order ticket | (QuotesTab local) | `QuotesTab.tsx:488-504` | `setShowOrderModal(true)` |
| **Place an order** | `handleExecuteOrder` | `App.tsx:849-909` | → `demo.ts:442` → risk → fill → `POSITION_OPEN` |
| **Close a position** | `handleClosePosition` | `App.tsx:916-943` | → `demo.ts.closePosition` → `POSITION_CLOSE` |
| Toggle execution mode | `handleModeSelect` | `App.tsx:1822-1839` | `LIVE` → notice modal; else `setExecutionMode` |
| Open kill switch | `onOpenKillSwitch` | `App.tsx:2204-2208` | `setShowKillSwitchModal(true)` |
| Engage kill switch | `onToggleKillSwitch` | `App.tsx:2869-2885` | `riskManager.setKillSwitch` inside a state updater |
| **Flatten all** | `handleEmergencyKillSwitch` | `App.tsx:1740-1807` | close every position + stop every bot |
| Start/stop a bot | `handleToggleBotStatus` | `App.tsx:951-1109` | `agentRuntime.start/stop` |
| **Create a bot** | `handleCreateBot` | `App.tsx:1116-1548` | `registerBot` + `registerBotTriggers` + `start` |
| **Run a backtest** | `handleRunBotBacktest` | `App.tsx:1555-1712` | fetch bars → `runBotDefinitionBacktest` |
| Poll bot activity | `handleGetBotActivity` | `App.tsx:1719-1733` | `timelineStore.getByBot(botId, {limit:100})` |
| Open the trigger lab | `onOpenTriggerLab` | `App.tsx:2478-2488` | `setEditingTrigger` + `setShowTriggerBuilder(true)` |
| **Save a trigger** | `TriggerBuilderPanel.onSave` | `App.tsx:2759-2778` | `setLabTriggers(upsert)` |
| Test a trigger | (in-panel) | `TriggerBuilder.tsx:96` | `evaluateConditionTree(root, context)` on every change |
| Save Hyperliquid network | `onSave` | `App.tsx:2802-2811` | `setHyperliquidNetwork` + `hyperliquidMarketData.setNetwork` |
| Save OpenRouter key | `onSave` | `App.tsx:2834-2842` | `openRouterProvider.saveConfig` → `localStorage` |
| **Ask the AI** | 5 inline `onAskAI`/`onOpenAI` | `App.tsx:2210, 2338, 2414, 2530, 2557` | `setExternalAIPrompt` → `FloatingAIAssistant.send` |
| Follow an AI action | `handleAction` | `FloatingAIAssistant.tsx:337` | `onSelectMarket` / `onNavigate` / `onInspectTrigger` / `onTestTrigger` |
| Open profile / docs | `onOpenProfile` / `onOpenDocs` | `App.tsx:2137, 2588, 2616` | overlay flags |
| Save the profile | `ProfileView.handleSave` | `ProfileView.tsx:46` | `onUserUpdated(u)` → `setUser` |

---

## 3. Engine entry points (callable from outside their module)

| Entry point | File:line | Signature | Called by |
| --- | --- | --- | --- |
| `AgentRuntime.registerAgent` | `runtime.ts:84` | `(agent, env)` | `registerBot` `runtime.ts:197`; `registerConservativeEurusdDemoAgent` `builtins/register.ts:5-10` |
| `AgentRuntime.registerBot` | `runtime.ts:190` | `(definition, deployment, runtimeSymbol, env)` | `App.tsx:1185` |
| `AgentRuntime.start` | `runtime.ts:208` | `(agentId)` | `App.tsx:1025, 1200, 1519` |
| `AgentRuntime.stop` | `runtime.ts:236` | `(agentId)` | `App.tsx:975, 1784` |
| `AgentRuntime.step` | `runtime.ts:389` | `(agentId, event?)` | `handleEvent` `runtime.ts:1758`; `replayAgentBacktest` `environment/backtest.ts:377` |
| `AgentRuntime.handleEvent` | `runtime.ts:1710` | `(agentId, event)` | `TriggerEngine.delivery.wake` `engine.ts:71` |
| `AgentRuntime.observe` | `runtime.ts:264` | `(agentId)` | `runStep` `runtime.ts:445`; `notifyAgentPosition` `runtime.ts:1315` |
| `TriggerRegistry.register` | `registry.ts:23` | `(trigger)` | `registerBotTriggers` `:42`; `App.tsx:1462` (legacy) |
| `TriggerRegistry.unregister` | `registry.ts:52` | `(triggerId)` | no in-`src` caller |
| `TriggerRegistry.candidates` | `registry.ts:83` | `(symbol?)` | `TriggerEngine.process` `engine.ts:188` |
| `TriggerEngine.start` | `engine.ts:76` | `()` | `App.tsx:155` |
| `TriggerEngine.process` | `engine.ts:178` | `(input)` | `engine.ts:106, 116, 155, 260, 311, 366, 377, 383` |
| `TriggerEngine.ingest` | `engine.ts:141` | `(event, environment)` | no in-`src` caller |
| `CapabilityRegistry.execute` | `capabilities/registry.ts:34` | `(id, input, ctx)` | `runtime.ts:703, 830, 343` |
| `RiskManager.validateOrder` | `execution/risk.ts:139` | `(order, positions, recordAcceptedOrder?, ctx?)` | `runtime.ts:906, 1561`; `demo.ts:515` |
| `RiskManager.setKillSwitch` | `execution/risk.ts:102` | `(active)` | `App.tsx:1751, 2881` |
| `ActionValidator.validate` | `policy/validator.ts:40` | `(decision, policy, observation, ctx?)` | `runtime.ts:894, 1549` |
| `HyperliquidMarketDataAdapter.getInstruments` | `marketData.ts:94` | `(assetClasses?)` | `App.tsx:419` |
| `HyperliquidMarketDataAdapter.getBars` | `marketData.ts:205` | `(symbol, timeframe, count)` | `App.tsx:541`; `historical.ts:40` |
| `HyperliquidDemoAdapter.placeMarketOrder` | `demo.ts:442` | `(params)` | `App.tsx:871`; `DemoEnvironment.placeMarketOrder` `environment/demo.ts:42` |
| `HyperliquidDemoAdapter.closePosition` | `demo.ts` | `(positionId)` | `App.tsx:926`; `environment/demo.ts:65` |
| `marketDataService.setSymbols` | `services/marketData.ts:35` | `(symbols)` | `App.tsx:436` |
| `marketDataService.updateLastPrice` | `services/marketData.ts:65` | `(symbol, price)` | `App.tsx:624` |
| `appContextStore.publish` | `aiContext/store.ts:98` | `(patch)` | `App.tsx:1853` |
| `openRouterProvider.chat` | `openrouter/provider.ts:150` | `(messages, …)` | `agentModel.run`; `FloatingAIAssistant.tsx:272` |
| `runBotDefinitionBacktest` | `agents/backtest.ts:139` | `(options)` | `App.tsx:1651` |
| `createDeployment` | `botDefinition.ts:685` | `(input, now?)` | `App.tsx:1154, 1609`; `BotBuilderModal.tsx:182` |
| `compileBotDefinition` | `botDefinition.ts:721` | `(definition, deployment, runtimeSymbol, env)` | `runtime.ts:196` |
| `validateBotDefinition` | `botDefinition.ts:239` | `(definition, skills?, caps?)` | `BotBuilderModal.tsx:136`; `botDefinition.ts:476, 674, 941` |
| `prepareStrategyFunction` | `sandbox/sandboxEnv.ts:31` | `(code)` | no in-`src` caller (used by tests) |
| `conditionEngine()` factory | `conditions/engineClient.ts:314` | `(options?)` | `TriggerCard.tsx:108` |

---

## 4. Python entry points

| Entry point | File:line | Symbol | Trigger |
| --- | --- | --- | --- |
| Console script / module | `__main__.py:19` | `main(argv=None)` | `python -m tradingv_engine` / `server:start` (`package.json:23`) |
| App factory | `api.py:145` | `create_app(engine=None, config=None)` | `__main__.py:81`; `api.py:419` |
| uvicorn run | `__main__.py:90` | `uvicorn.run(app, host, port, log_level="info")` | after config validation |
| Alternate uvicorn run | `api.py:424` | `main()` in `api.py` (marked `# pragma: no cover`) | `python -m tradingv_engine.api` |
| FastAPI startup | `api.py:206-208` | `_startup()` → `await engine.start()` | ASGI lifespan |
| FastAPI shutdown | `api.py:210-212` | `_shutdown()` → `await engine.stop()` | ASGI lifespan |
| Poll loop | `engine.py:268` | `ConditionEngine._loop()` | `asyncio.create_task` in `start()` `engine.py:253` |
| Tick | `engine.py:298` | `ConditionEngine.tick_once(now_ms?)` | `_loop` `engine.py:279` (thread boundary) |
| HTTP router | `api.py:216-389` | 17 route handlers | inbound HTTP |

### CLI flags — `__main__.py:24-36`

| Flag | Effect | Line |
| --- | --- | --- |
| `--host` | overrides `config.host` | `:24`, applied `:56` |
| `--port` | overrides `config.port` | `:25`, applied `:58` |
| `--poll-interval` | overrides `config.poll_interval_s` | `:26`, applied `:60` |
| `--print-schema` | prints the schema JSON and returns 0 | `:27-31`, `:43` |
| `--list-events` | prints `EventType` members and returns 0 | `:32-36`, `:50` |

### HTTP routes — `server/tradingv_engine/api.py`

| # | Method | Path | Decorator | Handler | Request |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | `/health` | `:216` | `:217` | — |
| 2 | GET | `/catalogue` | `:236` | `:237` | — |
| 3 | GET | `/schema` | `:240` | `:241` | — |
| 4 | GET | `/timeframes` | `:244` | `:245` | — |
| 5 | GET | `/instruments` | `:253` | `:254` | `?refresh: bool` |
| 6 | GET | `/triggers` | `:269` | `:270` | — |
| 7 | POST | `/triggers` | `:275` | `:276` | `RegisterTriggerRequest` `:81` |
| 8 | DELETE | `/triggers/{trigger_id}` | `:284` | `:285` | path param |
| 9 | GET | `/triggers/{id}/status` | `:290` | `:291` | path param |
| 10 | POST | `/triggers/{id}/evaluate` | `:299` | `:300` | path param + `now_ms` query |
| 11 | POST | `/test` | `:306` | `:307` | `TestConditionRequest` `:108` |
| 12 | GET | `/fixtures` | `:329` | `:330` | — |
| 13 | POST | `/evaluate` | `:343` | `:344` | `LiveEvaluateRequest` `:122` |
| 14 | GET | `/events` | `:360` | `:361` | `limit`, `botId`, `triggerId` |
| 15 | GET | `/wakes` | `:373` | `:374` | `limit` |
| 16 | POST | `/wakes/{wake_id}/ack` | `:377` | `:378` | path param |
| 17 | GET | `/status` | `:389` | `:390` | — |

Plus framework-generated `GET /docs`, `GET /redoc`, `GET /openapi.json`.

The two routes actually called by another in-repo process are **`POST /evaluate`**
(`watchers/src/evaluator.ts:66`) and `POST /test` + `GET /health` + `GET /fixtures` +
`GET /instruments` (`src/components/triggers/TriggerCard.tsx:116, 121, 135`).

---

## 5. Worker entry points

| Entry point | File:line | Symbol | Trigger |
| --- | --- | --- | --- |
| Worker fetch | `watchers/src/index.ts:79` | `default.fetch(request, env, ctx)` | inbound HTTP |
| Route dispatch | `index.ts:88` | `route(request, env)` | called from `fetch` |
| `GET /health` | `index.ts:95-97` | inline | liveness probe, unauthenticated |
| `POST /feed` | `index.ts:102-110` → `handleFeed` `:147` | `handleFeed(request, env)` | external producer |
| `GET /watchers` | `index.ts:118-120` → `listWatchers` `:220` | `listWatchers` | authed, bucket `read` |
| `POST /watchers` | `index.ts:121-123` → `deployWatcher` `:233` | `deployWatcher` | authed, bucket `lifecycle` |
| `GET /watchers/{id}` | `index.ts:125-138` → `handleWatcherRoute` `:307` | | authed, bucket `read` |
| `GET /watchers/{id}/health` | `index.ts:312-314` | | bucket `read` |
| `GET /watchers/{id}/wakes` | `index.ts:316-319` | | bucket `read` |
| `POST /watchers/{id}/wakes:claim` | `index.ts:321-325` | | bucket `lifecycle` (see route-regex note) |
| `POST /watchers/{id}/wakes:resolve` | `index.ts:327-334` | | bucket `lifecycle` (see route-regex note) |
| `POST /watchers/{id}/{action}` | `index.ts:336-342` | | `start`/`pause`/`resume`/`stop`/`retry`/`deploy` |
| `WatcherObject.deploy` | `durable-object.ts:140` | DO RPC | `index.ts:252` |
| `WatcherObject.act` | `durable-object.ts:221` | DO RPC | `index.ts:337` |
| `WatcherObject.onMarketEvent` | `durable-object.ts:242` | DO RPC | `index.ts:193` |
| `WatcherObject.claimWakes` | `durable-object.ts:277` | DO RPC | `index.ts:323` |
| `WatcherObject.resolveWake` | `durable-object.ts:286` | DO RPC | `index.ts:332` |
| `WatcherObject.health` | `durable-object.ts:295` | DO RPC | `index.ts:226, 313` |
| `WatcherObject.snapshot` | `durable-object.ts:308` | DO RPC | `index.ts:296` |
| `RateLimitObject.take` | `index.ts:403` | DO RPC | `consumeRate` `index.ts:418` |
| `UserRegistryObject.add/list` | `index.ts:365, 382` | DO RPC | `index.ts:259, 225` |
| `MarketIndexObject.add/list` | `index.ts:470, 477` | DO RPC | `index.ts:261, 211` |

**No `scheduled` handler, no cron trigger, no `queue()` consumer** exists in the worker
(CONFIRMED by grep and by the absence of a `[triggers]` table in `wrangler.toml`).

---

## 6. Test and acceptance entry points

All are `bun`-run scripts from `package.json` (or `pytest` / `vitest`).

| Script | Command | File | LOC |
| --- | --- | --- | --- |
| `lint` | `tsc --noEmit` | — | — |
| `test:agents` | `bun src/engine/agents/test-runner/run.ts` | `test-runner/run.ts` | 19 |
| `test:hyperliquid` | `bun src/adapters/hyperliquid/tests.ts` | `adapters/hyperliquid/tests.ts` | 270 |
| `test:hyperliquid:execution` | `bun src/adapters/hyperliquid/executionTests.ts` | `executionTests.ts` | 858 |
| `test:hyperliquid:discovery` | `bun src/adapters/hyperliquid/discoverySmoke.ts` | `discoverySmoke.ts` | 40 (needs network) |
| `test:hyperliquid:discovery:policy` | `bun src/adapters/hyperliquid/discoveryTests.ts` | `discoveryTests.ts` | 171 |
| `test:execution` | `bun src/engine/execution/tests.ts` | `engine/execution/tests.ts` | 503 |
| `test:wallet` | `bun src/services/wallet/testRunner.ts` | `services/wallet/testRunner.ts` | 4 |
| `test:theme` | `bun src/services/theme/testRunner.ts` | `services/theme/testRunner.ts` | 6 |
| `test:conditions` | `bun src/engine/conditions/conditionParity.ts` | `conditionParity.ts` | 533 |
| `test:engine` | `pytest server` | `server/tests/test_*.py` | 10 files |
| `test:pipeline` | `bun src/engine/agents/pipelineAcceptance.ts` | `pipelineAcceptance.ts` | 625 |
| `test:audit` | `bun src/engine/agents/triggers/auditRegressionTests.ts` | `auditRegressionTests.ts` | 2149 |
| `test:security` | `bun src/engine/core/testRunner.ts` | `core/testRunner.ts` (→ `securityTests.ts`) | 6 / 506 |
| `watcher:typecheck` | `cd watchers && tsc --noEmit` | — | — |
| `watcher:test` | `cd watchers && vitest run` | `watchers/test/*.test.ts` | 6 files, 138 `it()` |
| `watcher:test:runtime` | `vitest run --config vitest.runtime.config.ts` | `watchers/test-runtime/worker.test.ts` | 293 |
| `verify` | lint + audit + conditions + engine + pipeline + security + watcher typecheck + watcher test | `package.json:24` | — |

Additional in-tree suites not wired to a script (imported by the runners above):
`agents/tests.ts` (316), `agents/activityTests.ts` (58), `agents/backtestTests.ts` (52),
`agents/botDefinitionTests.ts` (79), `agents/triggers/tests.ts` (392),
`agents/triggers/conditionTests.ts` (480), `backtester/historicalTests.ts` (20),
`services/wallet/tests.ts` (366), `services/theme/tests.ts` (236),
`services/aiContext/tests.ts` (472).

---

## 7. Exit points

Where results leave the system.

| Exit | Where | Goes to |
| --- | --- | --- |
| Orders/positions/trades | `eventBus` `POSITION_*` + `App` state | the browser UI only — no external order endpoint exists |
| Chat completions | `provider.ts:194` `fetch` | OpenRouter; the model text is rendered in `FloatingAIAssistant` |
| Market data | `marketData.ts:54, 195, 213` | Hyperliquid (requests only) |
| Condition evaluation | `api.py:343` `POST /evaluate` | `watchers/src/evaluator.ts:78` |
| Condition evaluation (browser) | `engineClient.ts:148` | `http://127.0.0.1:8099` (from `TriggerCard`) |
| Engine HTTP responses | `api.py:216-389` | any caller |
| Wakes | DO KV `watcher:pending-wakes` | external agent via `GET /watchers/{id}/wakes` |
| Market feed ingest | `index.ts:147` | external producer |
| Persisted user data | `provider.ts:131`, `userService.ts:25`, `theme.ts` | browser `localStorage` |
| Agent audit + timeline | `AgentRuntime.auditLog`, timeline store | read back by `handleGetBotActivity` `App.tsx:1719` |
| Event log | `api.py:360` `GET /events` | `ConditionEngineClient.events()` `engineClient.ts:295` |
