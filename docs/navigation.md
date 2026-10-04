# Navigation & Routing Architecture

This document specifies the routing and state-driven navigation model in **TradingGOATs**.

---

## 1. Navigation Paradigm

TradingGOATs uses a **state-driven client-side navigation model** optimized for single-page mobile applications. This avoids slow full-page browser reloads, preserves WebSocket streaming connections without re-handshaking, and guarantees lightning-fast transition animations.

```mermaid
graph TD
    Root[TradingGOATs App Shell]

    subgraph Primary Destinations [Primary Tabs (5)]
        Tab_Trades[Trades (Default Landing)]
        Tab_Quotes[Quotes]
        Tab_Bots[Bots]
        Tab_History[History]
        Tab_Settings[Settings]
    end

    subgraph Deep Views & Overlays [Contextual Sub-Screens]
        View_MarketDetail[Market Detail & Chart (symbol)]
        View_BotDetail[Bot Detail & Backtester (botId)]
        View_BotCode[Monaco Strategy Editor (strategy.ts)]
        View_Profile[User Profile Management]
        View_Docs[Developer Documentation]
        Sheet_Position[Position Detail Bottom Sheet]
        Sheet_TradeDetail[History Trade Detail Modal]
        Sheet_AI[Floating AI Assistant Sheet]
        Modal_Order[Quick Market Order Modal]
    end

    Root --> Tab_Trades
    Root --> Tab_Quotes
    Root --> Tab_Bots
    Root --> Tab_History
    Root --> Tab_Settings

    Tab_Trades --> Sheet_Position
    Tab_Quotes --> View_MarketDetail
    View_MarketDetail --> Modal_Order
    Tab_Bots --> View_BotDetail
    View_BotDetail --> View_BotCode
    Tab_History --> Sheet_TradeDetail
    Tab_Settings --> View_Profile
    Tab_Settings --> View_Docs

    Root -.-> Sheet_AI
```

---

## 2. Primary Destinations

### 1. `trades` (Default Landing Screen)
* **Trigger**: App initialization or tapping the elevated **Trades** centerpiece button in the bottom navigation.
* **Component**: `src/components/views/TradesTab.tsx`
* **Sub-views**:
  * Tap an open position: opens `PositionDetailModal` (bottom sheet with two-step close confirmation).
  * Tap "+ New Trade": redirects to `quotes` tab.
  * Tap "Browse Bots": redirects to `bots` tab.

### 2. `quotes` (Market Discovery)
* **Trigger**: Tapping **Quotes** in the bottom bar or desktop sidebar.
* **Component**: `src/components/views/QuotesTab.tsx`
* **Sub-views**:
  * Tap any quote row: sets `selectedMarket` and renders **Market Detail View** with TradingView Lightweight Candlestick Chart, timeframe pills, overlay toggles, and bid/ask bar.
  * Tap **[Trade]** on Market Detail: opens `TradeOrderModal` with BUY/SELL, size (lots for Forex, units otherwise), and SL/TP.
  * Tap `< Quotes`: returns to the quotes list.

### 3. `bots` (Trading Bots & Automation)
* **Trigger**: Tapping **Bots** in navigation.
* **Component**: `src/components/views/BotsTab.tsx`
* **Sub-views**:
  * Tap **[+ Create Bot]**: opens conversational plain-English builder modal.
  * Tap any bot card: opens **Bot Detail View** with sub-tabs:
    * `overview`: Strategy description, risk limits, performance summary.
    * `backtest`: Simulation controls (balance, risk) and results grid with CSV export and AI findings.
    * `trades`: Executed bot transactions.
    * `logs`: Execution event stream.
    * `advanced`: Loads Monaco Editor (`MonacoStrategyEditor.tsx`) on demand for direct TypeScript strategy editing.
  * Tap `< Bots`: returns to the bot catalog.

### 4. `history` (Trade Audit Log)
* **Trigger**: Tapping **History** in navigation.
* **Component**: `src/components/views/HistoryTab.tsx`
* **Sub-views**:
  * Filter pills: `All`, `Manual`, `Bots`, `Profitable`, `Losses`.
  * Tap trade card: opens trade execution audit modal.
  * Tap **[Download CSV]**: downloads RFC 4180 CSV file formatted for Excel or Python pandas.

### 5. `settings` (Accounts & Safeguards)
* **Trigger**: Tapping **Settings** in navigation.
* **Component**: `src/components/views/SettingsTab.tsx`
* **Sub-views**:
  * Tap Profile Card: opens `ProfileView.tsx`.
  * Tap Hyperliquid: opens `HyperliquidSettingsModal.tsx` (network selection).
  * Tap AI Settings: opens `OpenRouterSettingsModal.tsx`.
  * Tap Emergency Kill Switch: opens `KillSwitchModal.tsx`.
  * Tap Developer Documentation: renders `DocsView.tsx`.

---

## 3. Dedicated Sub-Screens

### User Profile Screen (`showProfileView: true`)
* **Triggered by**:
  1. Desktop sidebar bottom profile area (clicking username/email).
  2. Mobile top header avatar shortcut.
  3. Settings tab profile card.
* **Component**: `src/components/views/ProfileView.tsx`
* **Capabilities**: View/edit username and email, view tier and account stats, save changes locally via `UserService`. Includes a `← Back` button to restore the previous view.

### Developer Documentation View (`showDocsView: true`)
* **Triggered by**: Settings → Developer Documentation.
* **Component**: `src/components/views/DocsView.tsx`
* **Capabilities**: Full in-app reading of architecture, market data, and strategy runtime docs.
