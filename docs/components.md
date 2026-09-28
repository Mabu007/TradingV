# Component Inventory & Responsibilities

This document catalogues the primary user interface components across **TradingVibe**.

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
  * TradingVibe logo and brand wordmark.
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
* **Role**: Application settings, integrations, and safeguard controls.
* **Key Features**:
  * User profile card linking to `ProfileView.tsx`.
  * Hyperliquid network settings (mainnet / testnet) and connection status.
  * OpenRouter AI configuration (model selector & BYO API key).
  * Emergency Kill Switch and daily drawdown limit toggles.

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
| `LiveConfirmModal` | `src/components/layout/LiveConfirmModal.tsx` | High-friction confirmation modal reserved for a future live mode; no live execution exists today. |
| `HyperliquidSettingsModal` | `src/components/layout/HyperliquidSettingsModal.tsx` | Hyperliquid network selection and connection status. |
| `OpenRouterSettingsModal` | `src/components/layout/OpenRouterSettingsModal.tsx` | BYO OpenRouter API key and model selection modal. |

---

## 4. Chart & Editor Components

* **`TradingChart.tsx` (`src/components/chart/`)**: High-performance canvas chart powered by TradingView Lightweight Charts. Renders candlesticks, SMA overlays, position price lines, and signal markers.
* **`MonacoStrategyEditor.tsx` (`src/components/editor/`)**: Sandboxed Monaco TypeScript IDE with syntax highlighting, autocomplete, and compiler error reporting. Lazy-loaded on demand inside `BotsTab.tsx`.
