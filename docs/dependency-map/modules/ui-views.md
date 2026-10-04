# Module 3 — UI Views

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/components/views/`

**Purpose:** the five tab screens plus two overlay views and the bot builder wizard.
Views own their own local navigation and form state; cross-screen data comes from
`App` as props and changes flow back through callbacks.

---

## Contains

| File | Lines | Export | Rendered by | Notes |
| --- | --- | --- | --- | --- |
| `TradesTab.tsx` | 327 | `TradesTab` | `App.tsx:2281-2352` | the default tab |
| `QuotesTab.tsx` | 711 | `QuotesTab` | `App.tsx:2354-2428` | owns a list↔detail sub-screen |
| `BotsTab.tsx` | 726 | `BotsTab` | `App.tsx:2430-2544` | owns bot selection + sub-tabs; contains `BotWorkspace` `:711` |
| `HistoryTab.tsx` | 334 | `HistoryTab` | `App.tsx:2546-2571` | |
| `SettingsTab.tsx` | 334 | `SettingsTab` | `App.tsx:2573-2641` | the `else` branch of the view ternary |
| `ProfileView.tsx` | 192 | `ProfileView` | `App.tsx:2241-2255` | overlay; wins over every tab |
| `DocsView.tsx` | — | `DocsView` | `App.tsx:2277` | overlay; `React.FC` with no props |
| `BotBuilderModal.tsx` | 392 | `BotBuilderModal` | `BotsTab.tsx:693` | 5-stage wizard |
| `WalletCard.tsx` | — | `WalletCard` | `SettingsTab.tsx:155` | |
| `BacktestsView.tsx` | 298 | `BacktestsView` | — | **no importer** |
| `BotsView.tsx` | — | `BotsView` | — | **no importer** |
| `DeploymentsView.tsx` | — | `DeploymentsView` | — | **no importer** |
| `SkillsView.tsx` | 240 | `SkillsView` | — | **no importer** |
| `StrategiesView.tsx` | 216 | `StrategiesView` | — | **no importer** |

---

## View dispatch

`App` holds `currentTab` (`MainTab = 'quotes' | 'bots' | 'trades' | 'history' | 'settings'`,
`src/types/aiContext.ts:1`) plus two overlay booleans. The `<main>` element is a
first-match-wins ternary chain — `App.tsx:2234-2641`:

| Order | Condition | Renders | Line |
| --- | --- | --- | --- |
| 1 | `showProfileView` | `ProfileView` | `:2240-2255` |
| 2 | `showDocsView` | `DocsView` | `:2257-2279` |
| 3 | `currentTab === 'trades'` | `TradesTab` | `:2281-2352` |
| 4 | `currentTab === 'quotes'` | `QuotesTab` | `:2354-2428` |
| 5 | `currentTab === 'bots'` | `BotsTab` | `:2430-2544` |
| 6 | `currentTab === 'history'` | `HistoryTab` | `:2546-2571` |
| 7 | else | `SettingsTab` | `:2573-2641` |

**Navigation is not persisted** — a reload returns to `currentTab === 'trades'`.

---

## Child view state (not in `App`)

| Component | State | Line | Purpose |
| --- | --- | --- | --- |
| `QuotesTab` | `selectedMarket` | `QuotesTab.tsx:58` | list ↔ detail; switches at `:216` / `:533` |
| `BotsTab` | `selectedBot` | `BotsTab.tsx:87` | early return `:153` |
| `BotsTab` | `selectedExplorer` | `BotsTab.tsx:91` | early return `:158` |
| `BotsTab` | `selectedDefinition` | `BotsTab.tsx:92` | early return `:163` |
| `BotsTab` | `activeBotTab` | `BotsTab.tsx` | detail sub-tab; `'advanced'` gates the Monaco mount `:464` |
| `BotsTab` | `activeStrategyCode` | `BotsTab.tsx:97` | Monaco content |
| `BotsTab` | `showCreateModal` | `BotsTab.tsx:498` | opens `BotBuilderModal` |
| `BotBuilderModal` | `stage` | `BotBuilderModal.tsx:114` | `'method' \| 'build' \| 'review' \| 'test' \| 'deploy'`; render switch `:216-220` |
| `BotBuilderModal` | `testResult` / `testProgress` | `BotBuilderModal.tsx:126, 128` | backtest output |
| `DocsView` | `activeDoc` | `DocsView.tsx:5` | |

---

## Props received from `App`

| View | Props (App line) |
| --- | --- |
| `TradesTab` | `balance` `:2289` · `equity` `:2292` · `margin` `:2296` · `freeMargin` `:2300` · `positions` `:2305` · `trades` `:2309` · `executionMode` `:2312` · `onClosePosition` `:2317` · `onOpenMarket` `:2320` · `onOpenBots` `:2332` · `onAskAI` `:2338` |
| `QuotesTab` | `symbols={discoveredSymbols}` `:2366` · `quotes` `:2371` · `bars` `:2375` · `positions` `:2379` · `signals` `:2383` · `trades` `:2387` · `currentTimeframe` `:2390` · `onTimeframeChange` `:2394` · `onSelectSymbol` `:2402` · `onExecuteOrder` `:2411` · `onAskAI` `:2414` |
| `BotsTab` | `markets` `:2437` · `bots` `:2440` · `strategies` `:2444` · `executionMode` `:2447` · `onToggleBotStatus` `:2452` · `onCreateBot` `:2456` · `onRunBacktest` `:2467` (stub) · `onBacktestBot` `:2471` · `labTriggers` `:2475` · `onOpenTriggerLab` `:2478` · `onDeleteLabTrigger` `:2489` · `botDefinitions` `:2503` · `onSaveBotDefinition` `:2506` · `onGetBotActivity` `:2523` · `backtestResult` `:2527` · `onOpenAIWithPrompt` `:2530` |
| `HistoryTab` | `trades` `:2553` · `onAskAI` `:2557` |
| `SettingsTab` | `executionMode` `:2580` · `user` `:2584` · `onOpenProfile` `:2588` · `onOpenHyperliquidSettings` `:2594` · `onOpenAISettings` `:2600` · `onOpenKillSwitchModal` `:2606` · `isKillSwitchActive` `:2612` · `onOpenDocs` `:2616` · `openRouterConfig` `:2622` · `accountStats` `:2626-2639` |
| `ProfileView` | `onBack` `:2242` · `onUserUpdated` `:2248` |
| `DocsView` | none |

---

## Callbacks into `App`

| Callback | Fired by | App setter | Line |
| --- | --- | --- | --- |
| `onOpenMarket` | `TradesTab` "New Trade" / "Explore Quotes" | `setSymbol` + `setCurrentTab('quotes')` | `TradesTab.tsx:169` → `App.tsx:2320-2330` |
| `onOpenBots` | `TradesTab` | `setCurrentTab('bots')` | `TradesTab.tsx:169` → `App.tsx:2332-2336` |
| `onSelectSymbol` | `QuotesTab` market row `QuotesTab.tsx:606-609` | `setSymbol` | `App.tsx:2402-2408` |
| `onTimeframeChange` | `QuotesTab` | `setTimeframe` | `App.tsx:2394-2400` |
| `onExecuteOrder` | `TradeOrderModal` `TradeOrderModal.tsx:258` | `handleExecuteOrder` | `App.tsx:2411` |
| `onClosePosition` | `PositionDetailModal` `TradesTab.tsx:316` | `handleClosePosition` | `App.tsx:2317` |
| `onToggleBotStatus` | `BotsTab` start/stop `:191, :580` | `handleToggleBotStatus` | `App.tsx:2452` |
| `onCreateBot` | `BotBuilderModal.onDeploy` `BotBuilderModal.tsx:183` | `handleCreateBot` | `BotsTab.tsx:701` → `App.tsx:2456` |
| `onBacktestBot` | `BotBuilderModal.runTest` `:196` | `handleRunBotBacktest` | `BotsTab.tsx:697` → `App.tsx:2471` |
| `onRunBacktest` | `BotsTab.handleExecuteBacktest` `:146-151` | **stub** `async () => null` | `App.tsx:2467` |
| `onSaveBotDefinition` | `BotBuilderModal.onSave` `:159` | `setBotDefinitions(upsert by id)` | `BotsTab.tsx:698` → `App.tsx:2506-2520` |
| `onGetBotActivity` | `BotWorkspace` 5 s poll `BotsTab.tsx:717-718` | `handleGetBotActivity` | `App.tsx:2523` |
| `onOpenTriggerLab` | `TriggerLabCard` `TriggerLabCard.tsx:40, 52, 102` | `setEditingTrigger` + `setShowTriggerBuilder(true)` | `BotsTab.tsx:671` → `App.tsx:2478-2488` |
| `onDeleteLabTrigger` | `TriggerLabCard` delete `:111` | `setLabTriggers(filter)` | `BotsTab.tsx:672` → `App.tsx:2489-2500` |
| `onAskAI` (×4) | position modal, trade modal, market, bot | `requireOpenRouterKey` + `setExternalAIPrompt` | `App.tsx:2338, 2414, 2530, 2557` |
| `onUserUpdated` | `ProfileView.handleSave` `ProfileView.tsx:46` | `setUser` | `App.tsx:2248-2254` |
| `onOpenHyperliquidSettings` / `onOpenAISettings` / `onOpenKillSwitchModal` / `onOpenDocs` / `onOpenProfile` | `SettingsTab` rows | the four/five overlay setters | `App.tsx:2588-2620` |

---

## The `BotBuilderModal` wizard

```
stage machine                                    BotBuilderModal.tsx:114
  'method'  :216   pick a build method
  'build'   :217   compileQuickBuild(prompt)    :147   or compose manually
  'review'  :218   validateBotDefinition(def)   :136
  'test'    :219   runTest()                    :190
                 └─ onBacktest(def, market, tf, balance, start, end, setTestProgress)  :196
                 └─ setTestResult(result)       :126
  'deploy'  :220   createDeployment()           :182
                 └─ onDeploy(def, deployment)   :183
                 └─ onClose()                   :184
```

`marketsFromDiscovery(instruments)` `BotBuilderModal.tsx:96-108` builds its market list
from the same instrument set as `QuotesTab`.
`BotBuilderModal` also renders `TriggerCard` at `:316` — the only place the
`ConditionEngineClient` is reached from the UI.

---

## Depends on

| Module | How |
| --- | --- |
| App Shell | props and callbacks |
| UI Components | `TradingChart`, `TradeOrderModal`, `PositionDetailModal`, `MonacoStrategyEditor`, `WalletCard` |
| Trigger Surfaces | `TriggerLabCard` (`components/bots/TriggerLabCard.tsx`) |
| Bot Definitions | `validateBotDefinition`, `compileQuickBuild` — `BotBuilderModal.tsx:136, 147` |
| Condition Engine Client | `TriggerCard` inside `BotBuilderModal` — `BotBuilderModal.tsx:316` |
| Services & App State | `useWallet()` in `WalletCard.tsx:18` |
| Engine (indirect) | `onBacktestBot` → `App.handleRunBotBacktest` → `runBotDefinitionBacktest` |

## Used by

`App` only. `BotBuilderModal` is used by `BotsTab`; `WalletCard` by `SettingsTab`.

---

## Reads

Props from `App` · their own local state · `useWallet()` (`WalletCard.tsx:18`) ·
`TriggerCard`'s `conditionEngine()` HTTP client (`TriggerCard.tsx:108`).

## Writes

Their own local state only. Every cross-screen write goes through an `App` callback.
The one external write in this module is `TriggerCard` → the Python engine over HTTP.

## Mutates

| Component | State |
| --- | --- |
| `QuotesTab` | `selectedMarket` `:58`, `showOrderModal` `:65` |
| `BotsTab` | `selectedBot` `:87`, `selectedExplorer` `:91`, `selectedDefinition` `:92`, `activeStrategyCode` `:97`, `showCreateModal` `:498` |
| `BotBuilderModal` | `stage` `:114`, `testResult` `:126`, `testProgress` `:128` |
| `DocsView` | `activeDoc` `:5` |
| `ProfileView` | the form fields feeding `onUserUpdated` |

## Emits

None directly. `BotBuilderModal.onDeploy` and `onBacktest` are the outbound events.

## Subscribes to

`useWallet()` in `WalletCard`. Nothing else — no `eventBus` subscription exists in
`src/components/`.

## External dependencies

`lucide-react` icons · `lightweight-charts` (via `TradingChart`) ·
`@monaco-editor/react` (via `MonacoStrategyEditor`) · HTTP to
`http://127.0.0.1:8099` (via `TriggerCard` → `ConditionEngineClient`).

## Entry points

`TradesTab` `App.tsx:2281` · `QuotesTab` `:2354` · `BotsTab` `:2430` ·
`HistoryTab` `:2546` · `SettingsTab` `:2573` · `ProfileView` `:2241` ·
`DocsView` `:2257` · `BotBuilderModal` `BotsTab.tsx:693`.

## Exit points

`App` state setters via props, plus `userService` (via `ProfileView.handleSave`
`ProfileView.tsx:46`) and the Python engine (via `TriggerCard`).

---

## Notable observations (factual)

- `BotsTab.backtestResult` (`App.tsx:2527`) is always `null`, so the "Backtest Results"
  panel at `BotsTab.tsx:343` never renders. Backtest output lives in
  `BotBuilderModal` local state instead.
- `BotsTab.onRunBacktest` is wired to a stub that returns `null` (`App.tsx:2467`).
- `TradesTab` hardcodes `'EUR/USD'` for "New Trade" and "Explore Quotes"
  (`TradesTab.tsx:142, 163`).
- `BotsTab` polls bot activity every 5 s from `BotWorkspace` (`BotsTab.tsx:717-718`).
- Five view components (`BacktestsView`, `BotsView`, `DeploymentsView`, `SkillsView`,
  `StrategiesView`) have no importer.
