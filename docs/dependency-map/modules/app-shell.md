# Module 1 — App Shell

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/main.tsx`, `src/App.tsx` (2918 lines), `index.html`

**Purpose:** the single React mount point and the sole owner of cross-cutting
application state. There is no router, no global state library, and no
`useReducer`; view switching is a `MainTab` state variable plus two boolean overlay
flags, and the App component holds 35 `useState` variables.

---

## Contains

### Files
- `index.html:17-18` — `#root` element and the module script tag
- `src/main.tsx` (42 lines) — pre-paint theme + `createRoot`
- `src/App.tsx` (2918 lines) — the App component

### Hook counts in `App.tsx`
`useState` **35** · `useRef` **1** · `useMemo` **4** · `useEffect` **9** ·
`useCallback` **0** · `useReducer` **0**

### Module-level (outside the component)

| Symbol | Line | What |
| --- | --- | --- |
| `triggerRegistry` | `App.tsx:99-101` | `new TriggerRegistry(id => agentRuntime.getAgent(id))` |
| `triggerEngine` | `App.tsx:103-107` | `new TriggerEngine(triggerRegistry, agentRuntime, agentRuntime.getTimelineStore())` |
| `triggerEngine.setEnvironment('DEMO')` | `App.tsx:109` | sets `sourceEnvironment` |
| `triggerEngineStarted` | `App.tsx:111` | `let` latch |
| `currentViewLabel(tab)` | `App.tsx:114-122` | tab → human label |
| `tabForNavigation(target)` | `App.tsx:130-142` | `NavigationTarget` → `MainTab` |
| `triggerName(trigger)` | `App.tsx:144-148` | `config.name` or a humanised type |
| `ensureTriggerEngineStarted()` | `App.tsx:150-157` | `triggerEngine.start()` once |

---

## Depends on

| Module | How |
| --- | --- |
| UI Components | imports + JSX (`BottomNav`, `MobileHeader`, modals) |
| UI Views | imports + JSX (`TradesTab`, `QuotesTab`, `BotsTab`, `HistoryTab`, `SettingsTab`, `ProfileView`, `DocsView`) |
| Trigger Surfaces | `TriggerBuilderPanel` `App.tsx:2729` |
| AI Copilot | `FloatingAIAssistant` `:2650` |
| Agent Runtime | `agentRuntime` — `App.tsx:975, 1025, 1185, 1200, 1519, 1723, 1784` |
| Trigger Engine | instantiates `TriggerRegistry` + `TriggerEngine` `:99-107` |
| Policy & Risk | `riskManager` — `:1751, 1758, 2881, 1986` |
| Hyperliquid Adapters | `hyperliquidMarketData` `:76`, `hyperliquidDemoAdapter`; `historicalMarketDataProvider` `:76` |
| Services & App State | `marketDataService`, `userService`, `openRouterProvider` |
| Environment | `DemoEnvironment` `:1182` |
| Bot Definitions | `createDeployment`, `runBotDefinitionBacktest` |
| Event bus | `src/types/events.ts` |

## Used by

- `index.html:18` (the script tag) — the only external consumer.
- `main.tsx:37` renders `<App />` inside the provider stack.

---

## Reads

| Source | Where |
| --- | --- |
| `eventBus` | `:516` (status), `:813, 817, 821` (position events) |
| `userService.getCurrentUser()` | `:487` |
| `openRouterProvider.getConfig()` | `:338` |
| `riskManager.isKillSwitchActive()` | `:297` |
| `riskManager.getLimits()` | `:1986` |
| `walletState` (context) | `:1990-1996` |
| Hyperliquid REST + WS | `:419, 541, 673, 720` |

## Writes

| Target | Line |
| --- | --- |
| 35 `useState` setters | see [State Owners §1](../state-owners.md#1-apptsx-react-state) |
| `agentRuntime.start/stop/registerBot` | `:975, 1025, 1185, 1200, 1519, 1784` |
| `triggerRegistry.registerBotTriggers/register` | `:1192, 1462` |
| `triggerEngine.start/setEnvironment` | `:109, 155` |
| `riskManager.setKillSwitch` | `:1751, 2881` |
| `hyperliquidMarketData.setSymbols/connect/setNetwork` | `:436, 520, 2808` |
| `hyperliquidDemoAdapter.placeMarketOrder/closePosition/markToMarket` | `:871, 926, 637` |
| `marketDataService.setSymbols/updateLastPrice` | `:436, 624` |
| `openRouterProvider.saveConfig` | `:2840` |
| `appContextStore.publish` | `:1853` |
| `eventBus.emit({type:'LOG'})` | `:460, 499, 560, 690, 884, 931` |

## Mutates

- `App.quotes` `:614, 680`; `App.bars` `:536, 546, 559, 724-749`;
  `App.instruments` `:426`; `App.positions` `:798`;
  `App.balance/margin/freeMargin` `:804-806`; `App.trades` `:822-828` — all listed in
  [State Owners §1](../state-owners.md#1-apptsx-react-state).
- `App.safetyNotice` `:1067, 1779`.

## Emits

`eventBus` `LOG` with ids `market-discovery-error` `:460`,
`user-load-error` `:499`, `bars-load-error` `:560`, `quote-load-error` `:690`,
`order-rejected:*` `:884`, `close-rejected:*` `:931`.

**No listener appends these to `App.logs`** — `App.tsx:215-216` has no writer, and
`BottomPanel` (the intended consumer) is not rendered by any component.

## Subscribes to

| Event / source | Line | Handler |
| --- | --- | --- |
| `hyperliquidMarketData.onStatusChange` | `:513-518` | `setConnectionStatus` |
| `subscribeQuote` callbacks | `:611-643` | `setQuotes`, `updateLastPrice`, `markToMarket` |
| `subscribeBars` callbacks | `:720-749` | `setBars` |
| `eventBus 'POSITION_OPEN'` | `:811` | `refreshFromAdapter` |
| `eventBus 'POSITION_UPDATE'` | `:815` | `refreshFromAdapter` |
| `eventBus 'POSITION_CLOSE'` | `:819` | `trades.unshift` + `refreshFromAdapter` |

## External dependencies

- `hyperliquidMarketData` → Hyperliquid REST + WSS.
- `openRouterProvider` → OpenRouter.
- `walletState` → Privy (indirectly, via `WalletProvider`).

## Entry points

`main.tsx:27` (mount) · `App.tsx:2084` (component) · `App.tsx:399-409` (effect #1) ·
`App.tsx:416-477` (effect #2) · `App.tsx:484-526` (effect #3) ·
`App.tsx:1852-2002` (effect #9).

## Exit points

- React re-render of every child component.
- `appContextStore.publish` `:1853` — the only outbound data flow to the AI layer.
- Every `eventBus` emission listed above.

---

## The component tree

```
main.tsx:27
└─ StrictMode
   └─ ErrorBoundary                        components/layout/ErrorBoundary.tsx
      └─ ThemeProvider                     services/theme/ThemeProvider.tsx
         └─ WalletProvider                 services/wallet/WalletProvider.tsx
            └─ App                         App.tsx:2084
               └─ div.flex.min-h-screen    App.tsx:2095
                  ├─ BottomNav             :2101-2146      (always)
                  ├─ div.flex.flex-col     :2153
                  │  ├─ safetyNotice div   :2164-2178      (conditional)
                  │  ├─ MobileHeader        :2180-2227      (always)
                  │  ├─ main               :2234
                  │  │  └ view ternary chain :2240-2641
                  │  │     ProfileView | DocsView | TradesTab | QuotesTab |
                  │  │     BotsTab | HistoryTab | SettingsTab
                  │  ├─ FloatingAIAssistant :2650-2727      (always)
                  │  └─ TriggerBuilderPanel :2729-2784      (mounted; self-gates on `open`)
                  ├─ HyperliquidSettingsModal :2793-2818    (mounted; self-gates on `isOpen`)
                  ├─ OpenRouterSettingsModal  :2825-2849    (mounted; self-gates on `isOpen`)
                  ├─ KillSwitchModal          :2856-2896    (mounted; self-gates on `isOpen`)
                  └─ LiveConfirmModal         :2903-2913    (mounted; self-gates on `isOpen`)
```

Self-gating modals return `null` internally:
`HyperliquidSettingsModal.tsx:6`, `KillSwitchModal.tsx:21`,
`LiveConfirmModal.tsx:26`, `OpenRouterSettingsModal.tsx:31`,
`TriggerBuilderPanel.tsx:104`, `TradeOrderModal.tsx:311`,
`PositionDetailModal.tsx:32`, `StrategyDiffModal.tsx:23`.

---

## Handlers

| Handler | Line | Calls | Sets |
| --- | --- | --- | --- |
| `hasOpenRouterKey` | `:372-376` | — | reads `openRouterConfig` |
| `requireOpenRouterKey` | `:385-392` | `hasOpenRouterKey` | `showAIModal` on failure |
| `handleExecuteOrder` | `:849-909` | `demo.placeMarketOrder` `:871` | none (mirror effect) |
| `handleClosePosition` | `:916-943` | `demo.closePosition` `:926` | none |
| `handleToggleBotStatus` | `:951-1109` | `agentRuntime.stop` `:975`, `agentRuntime.start` `:1025` | `bots` `:979/1028/1050/1083`, `safetyNotice` `:1067` |
| `handleCreateBot` | `:1116-1548` | `createDeployment` `:1154`, `registerBot` `:1185`, `registerBotTriggers` `:1192`, `start` `:1200` | `bots` `:1245/1511/1524`, `botDefinitions` `:1261` |
| `handleRunBotBacktest` | `:1555-1712` | `getBars` `:1585`, `createDeployment` `:1609`, `runBotDefinitionBacktest` `:1651` | none |
| `handleGetBotActivity` | `:1719-1733` | `timelineStore.getByBot` `:1725` | none |
| `handleEmergencyKillSwitch` | `:1740-1807` | `setKillSwitch` `:1751`, `handleClosePosition` `:1771`, `agentRuntime.stop` `:1784` | `isKillSwitchActive` `:1758`, `safetyNotice` `:1779`, `bots` `:1796`, `showKillSwitchModal` `:1804` |
| `handleModeSelect` | `:1822-1839` | — | `showLiveConfirm` `:1829` or `executionMode` `:1836` |

Plus ~30 inline JSX arrows that act as prop callbacks; the full table is in the
[Call Graph §4](../call-graph.md) and the module-level state table in
[State Owners §1](../state-owners.md).

---

## Notable observations (factual, not judgements)

- **No router.** `currentTab` is a state variable; there is no `history`/`pushState`
  usage and no routing package.
- **No navigation persistence.** A reload always returns to `currentTab === 'trades'`.
  The only `localStorage` values are theme, OpenRouter config, and user profile.
- **Three `useState` variables have no writer** — `signals` `:212-213`, `logs` `:215-216`,
  `backtestResult` `:259-260`.
- **One `useRef` has no writer** — `selectedBotIdRef` `:365`, read only at `:1858`.
- **`strategies` has no setter** — destructured at `:244-245` without one.
- **The engine write inside a state updater** — `App.tsx:2879-2883` calls
  `riskManager.setKillSwitch` inside the `setIsKillSwitchActive` updater.
- **Fire-and-forget in the flatten loop** — `App.tsx:1771-1777`; the
  `flattenFailures` array read at `:1779` is therefore still empty on the same tick.
- **`BotsTab.onRunBacktest` is a stub** — `App.tsx:2467` passes `async () => null`.
- **Components that exist but are never rendered** — `AIPanel`, `BottomPanel`,
  `Sidebar`, `StrategyDiffModal`, `BacktestsView`, `BotsView`, `DeploymentsView`,
  `SkillsView`, `StrategiesView` (verified by repo-wide grep for importers).
