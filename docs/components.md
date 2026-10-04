# Component Inventory & Responsibilities

This document catalogues the primary user interface components across **TradingGOATs**.

---

## 1. Navigation Components (`src/components/navigation/`)

### `BottomNav.tsx`
* **Role**: Primary mobile bottom navigation bar and desktop responsive sidebar.
* **Key Features**:
  * Fixed bottom placement with safe-area insets.
  * **Trades Centerpiece**: 2× visual weight, elevated container, glowing active state.
  * Open position and running bot counter badges.
  * Desktop left sidebar expansion with brand header at the top and clickable Profile Area at the bottom.

### `MobileHeader.tsx`
* **Role**: Compact top bar providing essential system status at a glance.
* **Key Features**:
  * TradingGOATs logo and brand wordmark.
  * Demo/Live account toggle chip.
  * Real-time Hyperliquid connection status (`Connected`, `Connecting`, `Offline`).
  * Fast Emergency Kill Switch trigger button.
  * AI assistant quick shortcut.

---

## 2. Primary View Screens (`src/components/views/`)

### `TradesTab.tsx` (Default Landing Screen)
* **Role**: Primary home dashboard displaying active financial exposure.
* **Key Features**:
  * Account Summary Hero Card (Equity, Balance, Today's Realized + Unrealized P&L).
  * Open Positions List with live P&L, direction pills, and bot attribution badges.
  * Recent activity feed showing today's closed transactions.

### `QuotesTab.tsx`
* **Role**: Real-time market discovery and chart terminal.
* **Key Features**:
  * Real-time search filter and favorite stars (`★`).
  * High-touch quote rows (minimum 64px height) displaying symbol, spread, bid, ask, and 24h change.
  * Embedded **Market Detail View** with TradingView Lightweight Charts, timeframe pills (`1m` to `1d`), SMA overlay toggles, and **[Trade]** action button.

### `BotsTab.tsx`
* **Role**: Strategy management and automated bot execution.
* **Key Features**:
  * "My Bots" list with status indicators (`● RUNNING`, `○ STOPPED`, etc.).
  * Conversational "+ Create Bot" modal translating plain English into structured rules.
  * Explore Blueprints across Trend Following, Breakouts, and Mean Reversion.
  * Bot detail view with backtesting panel, CSV export, AI improvements, and lazy-loaded Monaco editor.

### `HistoryTab.tsx`
* **Role**: Completed trade audit log and reporting.
* **Key Features**:
  * Time-grouped transaction list (Today, Yesterday, Earlier This Month).
  * Filter pills (All, Manual, Bots, Profitable, Losses).
  * One-click **[Download CSV]** exporter.
  * Trade detail modal with commissions, entry/exit prices, and AI audit action.

### `SettingsTab.tsx`
* **Role**: Application settings, wallet, integrations, and safeguard controls.
* **Key Features**:
  * User profile card linking to `ProfileView.tsx`.
  * `WalletCard.tsx` — Privy wallet connection, address, and disconnect.
  * Hyperliquid network settings (mainnet / testnet) and connection status.
  * OpenRouter AI configuration (model selector & BYO API key).
  * Emergency Kill Switch and daily drawdown limit toggles.

### `GoalComposer.tsx`
* **File**: `src/components/goat/GoalComposer.tsx`
* **Role**: Creates a GOAT from a plain-English goal.
* **Key Features**:
  * One field, under a "CREATE A GOAT" heading: **GOAL**. Free text, as
    much or as little prose as the user wants.
  * **SKILLS** (optional): attach any enabled skill, or open an inline
    markdown editor and write a new one, which is validated as it is
    saved and attached to this GOAT on the spot.
  * No market, no timeframe, no indicator set, no threshold. Those are
    either the GOAT's decision or a deployment decision made after the
    user has read the agent's reading of their goal.
  * Three worked examples, and ⌘+Enter to submit.

### `GoatInspector.tsx`
* **File**: `src/components/goat/GoatInspector.tsx`
* **Role**: The read-only view of what the GOAT believes and what it is
  watching.
* **Key Features**:
  * Goal, the agent's interpretation of it, and the skills in play.
  * Theses with their state, confidence, required confirmation, and the
    level at which they are wrong.
  * Live trackers: purpose, market, timeframe, kind, observation count,
    last observation, expiry, and pause / resume / remove controls that go
    through the Tracker SDK rather than mutating state directly.
  * Tracker events, evidence (supporting and contradicting), and trade
    ideas.

### `GoatView.tsx`
* **File**: `src/components/goat/GoatView.tsx`
* **Role**: The GOAT screen: create a GOAT, deploy it, read it.
* **Key Features**:
  * Three states and no more: no GOAT, a GOAT not yet deployed, and a
    deployed GOAT.
  * A list of the user's GOATs, so a returning user picks one instead of
    rewriting a goal.
  * **Deploy panel**: market picker (from discovery), timeframe, and
    SHADOW. The mode is stated in the button rather than implied.
  * "Move to another market" and "Stop this GOAT", both through the
    orchestrator, so redeploying keeps the goal and its history.
  * Composes `GoalComposer` and `GoatInspector`.

### `WalletCard.tsx`
* **Role**: Minimal wallet connection surface.
* **Key Features**:
  * Not-connected / connected state with a shortened wallet address.
  * Connect and disconnect actions through the `useWallet()` hook.
  * States plainly that the wallet is an identity and does not change the
    trading mode.
  * No balance, no transaction status, and no live-execution claim.

### `ProfileView.tsx`
* **Role**: Dedicated user profile management screen.
* **Key Features**:
  * User avatar hero card with trader tier badge.
  * Editable username and email fields with instant validation and save feedback.
  * Account statistics (Connected accounts, Active bots, Total trades).

### `DocsView.tsx`
* **Role**: In-app developer documentation reader.

---

## 3. Modal Dialogs & Sheets

| Component | File Path | Responsibility |
|---|---|---|
| `PositionDetailModal` | `src/components/modals/PositionDetailModal.tsx` | Mobile bottom sheet showing trade details with deliberate two-step close confirmation. |
| `TradeOrderModal` | `src/components/modals/TradeOrderModal.tsx` | Order ticket: live bid/ask, BUY/SELL, size in instrument units (lots for Forex), SL/TP, and inline execution rejections. |
| `KillSwitchModal` | `src/components/layout/KillSwitchModal.tsx` | Emergency confirmation modal to immediately close all positions and halt all bots. |
| `LiveConfirmModal` | `src/components/layout/LiveConfirmModal.tsx` | States that LIVE trading is unavailable. There is no confirm-to-enable path and no code that sets LIVE. |
| `HyperliquidSettingsModal` | `src/components/layout/HyperliquidSettingsModal.tsx` | Hyperliquid network selection and connection status. |
| `OpenRouterSettingsModal` | `src/components/layout/OpenRouterSettingsModal.tsx` | BYO OpenRouter API key and model selection modal. |

---

## 4. Chart & Editor Components

* **`TradingChart.tsx` (`src/components/chart/`)**: High-performance canvas chart powered by TradingView Lightweight Charts. Renders candlesticks, SMA overlays, position price lines, and signal markers.
* **`MonacoStrategyEditor.tsx` (`src/components/editor/`)**: Sandboxed Monaco TypeScript IDE with syntax highlighting, autocomplete, and compiler error reporting. Lazy-loaded on demand inside `BotsTab.tsx`.
