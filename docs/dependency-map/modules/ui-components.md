# Module 2 — UI Components (non-view)

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/components/{navigation,layout,chart,modals,terminal,editor}/`

**Purpose:** reusable presentational components, navigation chrome, modals, and the
chart / order-ticket / code-editor surfaces. Components receive data and callbacks as
props from `App`; none of them import an engine, an adapter, or a service — with two
exceptions noted below.

---

## Contains

| File | Lines | Export | Rendered by |
| --- | --- | --- | --- |
| `navigation/BottomNav.tsx` | 230 | `BottomNav` | `App.tsx:2101` (always) |
| `navigation/MobileHeader.tsx` | 213 | `MobileHeader` | `App.tsx:2180` (always) |
| `layout/ErrorBoundary.tsx` | — | `ErrorBoundary` | `main.tsx:29` |
| `layout/Sidebar.tsx` | — | `Sidebar` | **not rendered** (no importer) |
| `layout/HyperliquidSettingsModal.tsx` | — | `HyperliquidSettingsModal` | `App.tsx:2793` |
| `layout/KillSwitchModal.tsx` | — | `KillSwitchModal` | `App.tsx:2856` |
| `layout/LiveConfirmModal.tsx` | — | `LiveConfirmModal` | `App.tsx:2903` |
| `layout/OpenRouterSettingsModal.tsx` | — | `OpenRouterSettingsModal` | `App.tsx:2825` |
| `chart/TradingChart.tsx` | 470 | `TradingChart` | `QuotesTab.tsx:328-347` (market detail only) |
| `modals/TradeOrderModal.tsx` | 684 | `TradeOrderModal` | `QuotesTab.tsx:519-525` |
| `modals/PositionDetailModal.tsx` | 217 | `PositionDetailModal` | `TradesTab.tsx:313-324` |
| `terminal/BottomPanel.tsx` | 655 | `BottomPanel` | **not rendered** (no importer) |
| `editor/MonacoStrategyEditor.tsx` | 187 | `MonacoStrategyEditor` | `BotsTab.tsx:464-478` (only when `activeBotTab === 'advanced'`) |
| `editor/monacoConfig.ts` | — | Monaco setup | imported by the editor |
| `editor/StrategyDiffModal.tsx` | — | `StrategyDiffModal` | **not rendered** (no importer) |
| `editor/tradingContextDts.ts` | — | `TRADING_CONTEXT_DTS` | `MonacoStrategyEditor.tsx:42-67` |

**Four components exist with no importer** (verified by repo-wide grep):
`Sidebar`, `BottomPanel`, `StrategyDiffModal`, and (in module 14) `AIPanel`.

---

## Depends on

| Module | How |
| --- | --- |
| App Shell | props only — data down, callbacks up |
| UI Views | `TradingChart` ← `QuotesTab`; `TradeOrderModal` ← `QuotesTab`; `PositionDetailModal` ← `TradesTab`; `MonacoStrategyEditor` ← `BotsTab` |
| Services & App State | `TradingChart` → `chartTheme` (`services/theme/chartTheme.ts`); `MobileHeader` → `useWallet()` |
| External packages | `lightweight-charts` (TradingChart), `@monaco-editor/react` + `loader` (MonacoStrategyEditor), `lucide-react` (icons), `motion` (animation) |

**No engine, adapter, or service imports** — except two:
`TradeOrderModal.tsx:91-123` derives the entry price and calls `validateOrderSize`
(`utils/orderSize.ts:92`) and `lotsToInstrumentUnits` / `snapOrderSize`;
`MonacoStrategyEditor` loads `TRADING_CONTEXT_DTS` from `editor/tradingContextDts.ts`.

## Used by

`App` (nav chrome and the four top-level modals) and the views (chart, ticket, position
modal, editor). `PositionDetailModal` is also indirectly used by `HistoryTab` via the
same `onAskAI` pattern.

---

## Key state and handlers

### `BottomNav` — `navigation/BottomNav.tsx`

| Prop | From App | Line |
| --- | --- | --- |
| `activeTab` | `currentTab` | `App.tsx:2102` |
| `onTabChange` | inline setter | `App.tsx:2106-2118` |
| `openPositionsCount` | `positions.length` | `App.tsx:2120` |
| `runningBotsCount` | `bots.filter(RUNNING).length` | `App.tsx:2124` |
| `user` | `user ?? undefined` | `App.tsx:2132` |
| `onOpenProfile` | inline setter | `App.tsx:2137-2141` |
| `connectionStatus` | `connectionStatus` | `App.tsx:2143` |

Tab buttons fire at `BottomNav.tsx:117` (trades, the centrepiece) and `:158` (the rest).

### `MobileHeader` — `navigation/MobileHeader.tsx`

| Prop | From App | Line |
| --- | --- | --- |
| `executionMode` | `executionMode` | `App.tsx:2181` |
| `onToggleMode` | `handleModeSelect` | `App.tsx:2185` |
| `connectionStatus` | `connectionStatus` | `App.tsx:2189` |
| `isKillSwitchActive` | `isKillSwitchActive` | `App.tsx:2200` |
| `onOpenKillSwitch` | inline setter | `App.tsx:2204-2208` |
| `onOpenAI` | `requireOpenRouterKey` + `setExternalAIPrompt` | `App.tsx:2210-2220` |
| `onOpenWalletSettings` | inline setters | `App.tsx:2222-2226` |

Wallet connect: `walletService.connect()` at `MobileHeader.tsx:181`, button disabled
when `!wallet.configured` `:182`. Reads `useWallet()` `:56`.

### `TradingChart` — `chart/TradingChart.tsx`

Wraps `lightweight-charts`. Receives `bars`, `signals`, `quotes`, `symbol`,
`timeframe`. Consumes `chartTheme` from `services/theme/chartTheme.ts`.
Rendered only on the Quotes market-detail screen — `QuotesTab.tsx:328-347`.

### `TradeOrderModal` — `modals/TradeOrderModal.tsx`

Self-gates on `isOpen` (returns `null` at `:311`).

| Step | Line |
| --- | --- |
| `entryPrice = side === 'BUY' ? quote.ask : quote.bid` | `:91-101` |
| `volumeUnits` via `lotsToInstrumentUnits` / `snapOrderSize` | `:109-121` |
| `sizeCheck = validateOrderSize(...)` | `:123` |
| `stopLoss` state | `:170` |
| `takeProfit` state | `:183` |
| `canExecute` gate | `:209` |
| `handleExecute` → `onExecuteOrder({...})` | `:249`, `:258-264` |
| close on success | `:267` |
| `submitError` on rejection | `:271`, rendered `:667-680` |

### `PositionDetailModal` — `modals/PositionDetailModal.tsx`

Self-gates on `position == null` (`:32`). `onClosePosition` fires at `:45`.
"Ask AI to analyze this trade" builds the prompt at `:179-186`, which
`TradesTab.tsx:317-323` turns into `onAskAI`.

### `MonacoStrategyEditor` — `editor/MonacoStrategyEditor.tsx`

Mounts TypeScript defaults plus the `TRADING_CONTEXT_DTS` extra lib at `:42-67`.
`handleFormat` runs `editor.action.formatDocument` `:69-73`. `onChange` →
`props.onChange(val || '')` `:165`. `MonacoStrategyEditor` is conditionally mounted
(`BotsTab.tsx:464`), which is what makes the editor load lazily.

### The four top-level modals

| Modal | Self-gate | Save path |
| --- | --- | --- |
| `HyperliquidSettingsModal` | `:6` | `onSave(network)` → `App.tsx:2802-2811` → `setHyperliquidNetwork` + `hyperliquidMarketData.setNetwork` |
| `OpenRouterSettingsModal` | `:31` | `handleSubmit` `:42` → `App.tsx:2834-2842` → `openRouterProvider.saveConfig` |
| `KillSwitchModal` | `:21` | `onToggleKillSwitch` `:94` → `App.tsx:2869-2885`; "Close All" `:77` → `handleEmergencyKillSwitch` |
| `LiveConfirmModal` | `:26` | `onClose` only → `App.tsx:2908`; **no path to set `LIVE`** |

---

## Reads

Props only, plus `useWallet()` in `MobileHeader` and `WalletCard`, `chartTheme` in
`TradingChart`, and `localStorage` in none (theme is applied by the provider).

## Writes

Props callbacks only. The exceptions that touch state outside React:
`OpenRouterSettingsModal` → `openRouterProvider.saveConfig` (`localStorage` write,
`provider.ts:131`) via `App.tsx:2840`.

## Mutates

No component in this module mutates shared state directly. Every mutation goes
through an `App`-provided callback or through the `WalletContext` provider.

## Emits

None.

## Subscribes to

`useWallet()` — `MobileHeader.tsx:56`, `WalletCard.tsx:18` (module 13's provider).
`useTheme()` where chart colours are needed.

## External dependencies

`lightweight-charts` · `@monaco-editor/react` · `lucide-react` · `motion` ·
browser `document`/`localStorage` (via the theme provider).

## Entry points

`ErrorBoundary` (`main.tsx:29`) · `BottomNav` (`App.tsx:2101`) ·
`MobileHeader` (`App.tsx:2180`) · the four modals (`App.tsx:2793/2825/2856/2903`).

## Exit points

Callbacks into `App` state setters — the only way these components influence
application state.

---

## Notable observations (factual)

- `BottomPanel` (655 lines) accepts `logs` and `backtestResult` props. `App.logs`
  (`App.tsx:215-216`) and `App.backtestResult` (`App.tsx:259-260`) both have **no
  writer**, so the component would receive empty values even if it were mounted.
- `Sidebar.tsx:13-21` declares its own `MainView` type, which is disjoint from
  `MainTab` (`src/types/aiContext.ts:1`) used by `App`.
- `StrategyDiffModal`'s only would-be consumer is `AIPanel.onPreviewDiff`
  (`AIPanel.tsx:26`), and `AIPanel` is itself unmounted.
- `LiveConfirmModal` provides no confirmation path — `App.handleModeSelect` only ever
  sets `showLiveConfirm` (`App.tsx:1829`) and the modal's only callback is
  `onClose` (`App.tsx:2908`).
