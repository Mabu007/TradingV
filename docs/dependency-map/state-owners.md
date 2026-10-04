# State Owners

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Every state container, who initializes it, who writes it, who reads it, who resets it,
who persists it. Only state that exists in the repository is listed.

---

## 1. `App.tsx` React state

35 `useState` declarations. The App component is the single largest state owner in the
repository.

### 1.1 Navigation & view

| Variable | Declared | Init | Written by | Read by | Reset |
| --- | --- | --- | --- | --- | --- |
| `currentTab` | `App.tsx:168-169` | `'trades'` | `onTabChange` `:2107`; `onOpenMarket` `:2327`; `onOpenBots` `:2333`; `onOpenWalletSettings` `:2225`; AI `onSelectMarket` `:2684`; AI `onNavigate` `:2723` | render ternary chain `:2281/:2354/:2430/:2546`; `BottomNav` `:2102`; AI publish `:1854` | reload |
| `showProfileView` | `:282-283` | `false` | `BottomNav.onOpenProfile` `:2138`; `SettingsTab.onOpenProfile` `:2589`; AI `:2715` | ternary `:2240` | tab change `:2115`; back `:2242`; AI `:2715` |
| `showDocsView` | `:279-280` | `false` | `SettingsTab.onOpenDocs` `:2617` | ternary `:2257` | tab change `:2111`; back `:2270`; AI `:2721` |

**No navigation state is persisted.** Reload always returns to `currentTab === 'trades'`.

### 1.2 Market data

| Variable | Declared | Init | Written by | Read by |
| --- | --- | --- | --- | --- |
| `symbol` | `:171-172` | `''` | discovery effect `:443`; `QuotesTab.onSelectSymbol` `:2405`; `TradesTab.onOpenMarket` `:2323`; AI `onSelectMarket` `:2680` | effects #4 `:577`, #6 `:707`, #7 `:756`; `triggerTestContext` `:2049`; AI `:1856` |
| `instruments` | `:174-175` | `[]` | discovery effect `:426` | `subscribedInstrumentIds` `:596`; effect #5 `:605-610`; `discoveredSymbols` `:2063`; AI `:1916` |
| `timeframe` | `:177-178` | `'5m'` | `QuotesTab.onTimeframeChange` `:2397` | effects #4 `:577`, #7 `:756`; `TriggerBuilderPanel` `:2743`; AI `:1857` |
| `bars` | `:209-210` | `[]` | effect #4 `:536` (clear), `:546` (set), `:559` (clear on error); effect #7 `:724-749` | `QuotesTab.bars` `:2375`; `triggerTestContext` `:2034` |
| `quotes` | `:236-237` | `{}` | effect #5 `:614-617`; effect #6 `:680-683` | `QuotesTab.quotes` `:2371`; AI markets bid/ask `:1923-1924`; `triggerTestContext` `:2021` |
| `signals` | `:212-213` | `[]` | **never written** | `QuotesTab.signals` `:2383` |

### 1.3 Account & execution

| Variable | Declared | Init | Written by | Read by |
| --- | --- | --- | --- | --- |
| `balance` | `:194-195` | `0` | effect #8 `:804` | `equity` `:774`; `TradesTab` `:2289`; AI `:1861` |
| `margin` | `:203-204` | `0` | effect #8 `:805` | `TradesTab` `:2296`; AI `:1863` |
| `freeMargin` | `:206-207` | `0` | effect #8 `:806` | `TradesTab` `:2300`; AI `:1864`; `riskState` `:1883` |
| `positions` | `:218-219` | `[]` | effect #8 `:798` | `equity` `:778`; `TradesTab` `:2305`; `QuotesTab` `:2379`; `BottomNav` `:2121`; AI `:1887`; kill switch `:1771` |
| `trades` | `:221-222` | `[]` | effect #8 `POSITION_CLOSE` `:822-828` | `TradesTab` `:2309`; `HistoryTab` `:2553`; AI `:1869/1902`; `accountStats` `:2635` |
| `executionMode` | `:180-181` | `'DEMO'` | `handleModeSelect` `:1836` only | header/tabs/Settings; `triggerTestContext` `:2026`; AI `:1859` |
| `hyperliquidNetwork` | `:329-330` | `'mainnet'` | `HyperliquidSettingsModal.onSave` `:2803` | modal `:2799` |
| `isKillSwitchActive` | `:296-297` | `() => riskManager.isKillSwitchActive()` | `handleEmergencyKillSwitch` `:1758`; `KillSwitchModal` updater `:2879-2883` | `MobileHeader` `:2200`; `KillSwitchModal` `:2861`; `SettingsTab` `:2612`; AI `:1881, 1987` |
| `connectionStatus` | `:319-320` | `'CONNECTING'` | status subscription `:516` | `BottomNav` `:2143`; `MobileHeader` `:2189` |

### 1.4 Bots, strategies, triggers

| Variable | Declared | Init | Written by | Read by |
| --- | --- | --- | --- | --- |
| `bots` | `:253-254` | `[]` | `handleToggleBotStatus` `:979/1028/1050/1083`; `handleCreateBot` `:1245/1511/1524`; kill switch `:1796` | `BotsTab` `:2440`; `BottomNav` `:2125`; lookup `:955`; AI `:1875`; `accountStats` `:2629` |
| `botDefinitions` | `:256-257` | `[]` | `handleCreateBot` `:1261-1268`; `BotsTab.onSaveBotDefinition` `:2509-2519` | `BotsTab` `:2503`; AI bots/triggers slices `:1935, 1969` |
| `strategies` | `:244-245` | `SAMPLE_STRATEGIES` | **no setter** (destructured without one) | `BotsTab.strategies` `:2443` |
| `labTriggers` | `:352-353` | `[]` | `TriggerBuilderPanel.onSave` `:2768-2777`; `onDeleteLabTrigger` `:2492-2499` | `BotsTab` `:2475`; AI triggers slice `:1957` |
| `editingTrigger` | `:358-359` | `undefined` | `BotsTab.onOpenTriggerLab` `:2481` | `TriggerBuilderPanel.trigger` `:2735` |
| `showTriggerBuilder` | `:355-356` | `false` | `BotsTab.onOpenTriggerLab` `:2485`; AI `:2690, 2696` | `TriggerBuilderPanel.open` `:2731` |
| `backtestResult` | `:259-260` | `null` | **never written** | `BotsTab` `:2527` (always `null`) |
| `logs` | `:215-216` | `[]` | **never written** (6 `eventBus.emit LOG` sites have no listener) | `BottomPanel` (not rendered) |

### 1.5 Settings, modals, AI

| Variable | Declared | Init | Written by | Read by |
| --- | --- | --- | --- | --- |
| `openRouterConfig` | `:337-340` | `openRouterProvider.getConfig()` | `OpenRouterSettingsModal.onSave` `:2839-2841` | `hasOpenRouterKey()` `:374`; `SettingsTab` `:2623` |
| `showLiveConfirm` | `:267-268` | `false` | `handleModeSelect` `:1829` | `LiveConfirmModal` `:2904` |
| `showHyperliquidModal` | `:270-271` | `false` | `SettingsTab.onOpenHyperliquidSettings` `:2595` | `HyperliquidSettingsModal` `:2794` |
| `showAIModal` | `:273-274` | `false` | `requireOpenRouterKey()` `:390`; `SettingsTab` `:2601`; AI `:2674` | `OpenRouterSettingsModal` `:2826` |
| `showKillSwitchModal` | `:276-277` | `false` | `MobileHeader` `:2205`; `SettingsTab` `:2607` | `KillSwitchModal` `:2857`; closed `:1804` |
| `safetyNotice` | `:306-307` | `null` | `handleToggleBotStatus` catch `:1067`; kill switch `:1779` | banner `:2164`; dismiss `:2172` |
| `externalAIPrompt` | `:342-343` | `null` | 5 sites `:2217/2345/2421/2540/2564` | `FloatingAIAssistant` `:2660`; cleared `:2664` |
| `user` | `:314-315` | `null` | user effect `:491`; `ProfileView.onUserUpdated` `:2251` | `BottomNav` `:2132`; `SettingsTab` `:2584` |

### 1.6 Refs, memos, module-level

| Item | Location | Note |
| --- | --- | --- |
| `selectedBotIdRef` | `App.tsx:365` | `useRef<string \| undefined>(undefined)`; **never written**; read only for the AI publish `:1858` |
| `subscribedInstrumentIds` | `App.tsx:596-602` | `useMemo`; string-keyed deps so a tick does not resubscribe |
| `equity` | `App.tsx:763-778` | `balance + Σ unrealizedPnL`, rounded to 2 dp |
| `triggerTestContext` | `App.tsx:2014-2049` | `ConditionContext \| undefined`; `undefined` when `!symbol` |
| `discoveredSymbols` | `App.tsx:2063-2077` | `instruments.map(i => i.market)` |
| `triggerRegistry` | `App.tsx:99-101` | **module-level singleton** |
| `triggerEngine` | `App.tsx:103-107` | **module-level singleton** |
| `triggerEngineStarted` | `App.tsx:111` | `let` latch; guard for `ensureTriggerEngineStarted()` |

---

## 2. Engine state

| State | Owner | Written by | Read by | Reset |
| --- | --- | --- | --- | --- |
| `AgentRuntime.instances` | `runtime.ts:42` | `registerAgent` `:185` | `getAgent` `:200`, `listAgents` `:204` | never |
| `AgentRuntime.auditLog` | `runtime.ts:43` (cap 200 `:44`) | `unshift` `:1289` | `getAuditTrail` `:1766` | `clearAuditTrail` `:1776` |
| `AgentRuntime.activeCycles` | `runtime.ts:45` | `:405`, `:409` | `:399` | `finally` `:409-411` |
| `AgentRuntime.timelineSequence` | `runtime.ts:46` | `:1401` | timeline ids | never |
| `AgentRuntime.positionCorrelations` | `runtime.ts:48-51` | `:1050`, deleted `:1502` | `:1443`, `:1481` | delete on close |
| `instance.memory` | `ScopedAgentMemory` `memory/memory.ts` | `runtime.ts:1169-1210` | `observation.recentMemories` `runtime.ts:381` | per-agent, process lifetime |
| `AgentRuntime.allowedCapabilities` | `runtime.ts:31` | `registerAgent` `:136-140` | `:613`, `:809` | never |
| `TriggerRegistry.triggers/bySymbol/unscoped` | `registry.ts:15-17` | `register` `:33-39` | `candidates` `:85-86` | `unregister` `:52-62` |
| `TriggerEngine.evaluationStates` | `engine.ts:43` | `:209-211` | `:215` | `disposeAgent` `:348`; `dispose` `:32` |
| `TriggerEngine.lastFired` | `engine.ts:44` | `markFired` `:445-453` | `canFire` `:432,438` | clock-wind `:432-437` |
| `TriggerEngine.firingHistory` | `engine.ts:45` | `:448` | `canFire` `:439-442` | 60 s prune |
| `TriggerEngine.processedEvents` | `engine.ts:53` | `:200` | `:196-198` | `clear()` at >10 000 `:199` |
| `TriggerEngine.instrumentCache` | `engine.ts:54` | `:394-408` | `:410-429` | `disposeAgent` `:354-357` |
| `TriggerEngine.agentByPosition` | `engine.ts:51` | `processPositionEvent` `:360-367` | same | — |
| `TriggerEngine.domainEventSequence` | `engine.ts:55` | `inputFromDomainEvent` `engine.ts:487` | delivery ids | never |
| `RiskManager.limits` | `risk.ts:35` | `updateLimits` `:91-93`, `setKillSwitch` `:102-112` | `getLimits` `:68`, `validateOrder` `:149-200` | `DEFAULT_RISK_LIMITS` `:7-24` |
| `RiskManager.recentOrderTimestamps` | `risk.ts:36` | `:73-83`, `:187-193`, `:202` | same | 60 s prune |
| `RiskManager.currentDailyPnL` | `risk.ts:37` | `recordPnL` `:122-126` | `realisedToday` `:86`, `validateOrder` `:196` | `resetDailyLoss` `:128`; UTC rollover `:60-66` |
| `ActionValidator.recentOrderTimestamps` | `policy/validator.ts:38` | `:247-248` | `:73-83` | 60 s prune |
| `CapabilityRegistry.capabilities` | `capabilities/registry.ts:4` | `capabilities/index.ts:38` at import | `get` `:18`, `list` `:26`, `execute` `:34` | never |
| `SkillRegistry` (builtin skills) | `skills/registry.ts` | module import | `resolveCapabilities`, `compileInstructions` | never |
| `HyperliquidDemoAdapter` (positions, orders, trades, account) | `demo.ts` | `placeMarketOrder`, `closePosition`, `markToMarket` | `getPositions`, `getAccountState`, `getOrders`; `App` effect #8 | no reset exposed |
| `MarketDataService` (symbols + last prices) | `services/marketData.ts:31` | `setSymbols` `:35`, `updateLastPrice` `:65` | `getSymbol` `:40`, `findSymbol` `:50`, `getAllSymbols` `:54` | none |
| `appContextStore` | `aiContext/store.ts:134` | `publish` `:98` ← `App.tsx:1853` | 11 AI tools `tools.ts:32-161` | wholesale replace |
| `OpenRouterProvider.config` | `provider.ts` | `saveConfig` `:131` | `chat` `:150`, `getConfig` | `localStorage` reload |
| `UserService` profile | `services/userService.ts` | profile save | `getCurrentUser` `App.tsx:487` | `localStorage` |
| theme | `services/theme/theme.ts` | user choice | `resolveInitialTheme` `main.tsx:16` | `localStorage` |

---

## 3. Python state

| State | Owner | Written by | Read by | Reset |
| --- | --- | --- | --- | --- |
| `event_log` (2000 cap) | `events.py:107` | `record` `:68`, `emit` `:74` | `recent` `:82`, `for_bot` `:99`; `api.py:369` | never |
| `load_schema` memo | `contract.py:43` | first call | `schema_errors` `:54`; `api.py:242` | never |
| `_validator` memo | `contract.py:49` | first call | `schema_errors` `:66` | never |
| `ConditionEngine._queue` (200 cap) | `engine.py:87` | `_enqueue` `:237-246` | `pending_wakes` `:218` | `acknowledge_wake` `:221-235` |
| `ConditionEngine._sequence` | `engine.py:88` | `_enqueue` `:243` | wake id | never |
| `ConditionEngine._stopping` | `engine.py:90` | `start` `:251`, `stop` `:259` | `_loop` `:270`, sleep `:286` | `start` |
| `ConditionEngine._wake_listeners` | `engine.py:91` | `on_wake` `:214-216` | `_enqueue` `:244` | never |
| `ConditionEngine._fixture_contexts` | `engine.py:92` | `_load_fixture_contexts` `:346-409` | `fixture_context` `:181` | never |
| `MarketMonitor.store` (`CandleStore`) | `monitor.py:145` | `CandleStore.get` `store.py:87` | `entry_for` `store.py:100` | `seed` `store.py:90`; no eviction |
| `MarketMonitor.cache` (`IndicatorCache`) | `monitor.py:147` | `get_or_compute` `store.py:117-132` | `invalidate` `store.py:134-137` ← `monitor.py:272` | invalidate on every successful refresh |
| `MarketMonitor.triggers` | `monitor.py:148` | `register` `:172`, `replace` `:182` | `evaluate_all` `:282` | `unregister` `:178` |
| `MarketMonitor.detectors` | `monitor.py:149` | `register` `:175` | `_evaluate_trigger` `:324` | `unregister` `:180` |
| `MarketMonitor._instruments` | `monitor.py:150` | `load_instruments` `:167` | `instrument_json` `:213`; context builder | never |
| `MarketMonitor._account/_positions/_spread` | `monitor.py:151-153` | `set_account` `:192`, `set_positions` `:195`, `set_spread` `:198` | `account`/`positions`/`spread` properties `:201-211` | overwritten |
| `MarketMonitor.wakes` | `monitor.py:156` | on FIRED | `latest_wakes` `:481` | appended only |
| `EdgeState.last_status` | `edge.py:78` | `observe` `:190`, `:179-187` | `snapshot` `:253` | not updated on `UNKNOWN` |
| `EdgeState.last_fire_ms` / `fire_count` / `wakes` | `edge.py:82-84` | `observe` `:234-236` | `snapshot`, `wakes_last_hour` `:90` | `prune` `:86-88` (>24 h) |
| `CandleEntry` | `store.py:34-35` | `CandleStore.get` `store.py:83-86` | `entry_for` `:100`; staleness `:43-44` | superseded on next fetch; on fetch error the previous entry is kept (`store.py:78-81`) |
| `IndicatorCache` keys | `store.py` `_cache_key` `:143-147` | `get_or_compute` `:121-131` | — | `invalidate` `:134-137` |

---

## 4. Worker state

| State | Owner | Written by | Read by | Reset |
| --- | --- | --- | --- | --- |
| `WatcherObject` KV `watcher:state` | `durable-object.ts:37` | `save()` `:121` | `readStored()` `:212`; `ready()` `:95-98` | `Watcher.restore` `:98` |
| KV `watcher:terminal-wakes` | `durable-object.ts:38` | `save()` `:122` | `readStored()` `:214`; `restoreTerminal` `wake-queue.ts:215` | trimmed to `historyLimit` `wake-queue.ts:321-323` |
| KV `watcher:pending-wakes` | `durable-object.ts:39` | `save()` `:125` | `readStored()` `:215`; `ready()` `:99` | `resolve` `wake-queue.ts:249`; `expire` `:291` |
| `Watcher.state` (in memory) | `watcher.ts` | `tick` `:262-263, 290-292, 312, 324-344, 407-409`; `act` `:212-229` | `health` `:456-472`; `snapshot` `durable-object.ts:308` | rehydrated from KV on every `ready()` |
| `WakeQueue.pending` Map | `wake-queue.ts:116` | `enqueue` `:203` | `list` `:133`, `get` `:160`, `acknowledge` `:234` | `resolve` `:249`; `expire` `:291-301`; overflow drop `:183-201` |
| `WakeQueue.terminal` array | `wake-queue.ts` | `terminalise` `:318-320` | `history` `:156` | trimmed to `historyLimit` |
| `UserRegistryObject` KV `identities` | `index.ts:359` | `add` `:365-373` | `list` `:382`; `index.ts:225` | `remove` `:375-380` (no route calls it) |
| `MarketIndexObject` KV `identities` | `index.ts:464` | `add` `:470-475` | `list` `:477`; `watchersForMarket` `:210-214` | no `remove` exists |
| `RateLimitObject` KV `window` | `index.ts:397` | `take` `:406` (including on refusal) | `take` `:404` | window expiry `rate-limit.ts:88` |
| `WatcherObject.watcher` (in memory) | `durable-object.ts:70` | `ready()` `:98` | every RPC method | rehydrated on each `ready()` |

**Bounds (CONFIRMED)**
- `WakeQueue` defaults `maxAgeMs: 5 * 60_000`, `maxSize: 100`, `historyLimit: 200`
  (`wake-queue.ts:96-100`). Overridable only via `env.queueOptions`
  (`durable-object.ts:54`), which is not in `wrangler.toml`.
- `WAKE_TTL_MS = 60_000` (`durable-object.ts:40`) is declared and re-exported at
  `:318` but never read; the effective TTL is `maxAgeMs`.
- `ConditionEngine.WAKE_CAPACITY = 200` (`engine.py:69`).
- `EventLog(capacity=2000)` (`events.py:64-66`).
- `AuditLog` cap 200 (`runtime.ts:44`, enforced `:1291-1296`).
- `MAX_REMEMBERED_INPUT_IDS = 10_000` (`engine.ts:19`).
- `CONFIG_LIMITS.maxConditionsPerTree = 200` (`contract.ts:180`).

---

## 5. Persisted vs in-memory

| Store | Contents | Written by |
| --- | --- | --- |
| browser `localStorage` | theme, OpenRouter config, user profile | `theme.ts`, `provider.ts:131`, `userService.ts` |
| Cloudflare DO storage | 3 watcher keys + 3 identity/window keys | `durable-object.ts:121-125`, `index.ts:406, 365-373, 470-475` |
| Python process memory | candle store, indicator cache, trigger registry, edge states, wake deque, event log | see §3 |
| React state | 35 variables | see §1 |
| Module singletons | `eventBus`, `agentRuntime`, `riskManager`, `actionValidator`, `capabilityRegistry`, `appContextStore`, `marketDataService`, `openRouterProvider`, `hyperliquidDemoAdapter`, `hyperliquidMarketData` | see §2 |
| `sessionStorage` | **not used** | — |
| `IndexedDB` | **not used** | — |
| `document.cookie` | **not used in `src/`** | — |
| Relational database | **not present in any runtime** | — |
