# State Management Architecture

This document defines state ownership, reactive stores, and real-time update boundaries in **TradingVibe**.

---

## 1. State Ownership Map

To prevent state synchronization bugs and race conditions, each slice of state has a **single authoritative owner**:

| State Domain | Primary Owner | Secondary Consumers | Reactivity Mechanism |
|---|---|---|---|
| **Account & Equity** | `App.tsx` (`balance`, `equity`, `positions`) | `TradesTab`, `SettingsTab`, `BottomNav` | React state + Tick recalculation |
| **Open Positions** | `App.tsx` (`positions`) | `TradesTab`, `PositionDetailModal`, Chart | `eventBus` (`POSITION_OPEN`, `CLOSE`) |
| **Realtime Quotes** | `hyperliquidMarketData` subscription map | `QuotesTab`, `TradingChart`, execution adapter | Selective listener callbacks |
| **Bot Automation** | `App.tsx` (`bots`, `strategies`) | `BotsTab`, `BottomNav` | React state + status transitions |
| **Trade History** | `App.tsx` (`trades`) | `HistoryTab`, `TradesTab` | React state + CSV export generator |
| **User Profile** | `UserService` (`MockUserService`) | `ProfileView`, `BottomNav`, `SettingsTab` | Async Service API + `localStorage` |
| **Hyperliquid Connection** | `hyperliquidMarketData` (`connected`) | `MobileHeader`, `BottomNav` | `onStatusChange` listener callbacks |
| **AI Context & Chat** | `FloatingAIAssistant` (`messages`) | AI Bottom Sheet | React state + `AIContext` tracker |
| **UI Active Tab** | `App.tsx` (`currentTab`) | `BottomNav`, View Router | React state (`MainTab`) |

---

## 2. Real-Time Tick Performance (Avoiding App-Wide Re-Renders)

A classic flaw in trading web apps is re-rendering the entire React component tree on every single incoming price tick (which can arrive 20–50 times per second during high volatility).

### Optimization Strategy:
1. **Local Quote Listeners**: `hyperliquidMarketData` maintains a `Map<string, Set<QuoteListener>>`. Only components actively rendering a specific symbol (e.g. the EURUSD row or chart) receive tick updates.
2. **Chart Canvas Isolation**: `TradingChart.tsx` runs inside an isolated HTML5 canvas managed by Lightweight Charts; it updates bar series data directly without triggering React virtual DOM reconciliations.
3. **Throttled P&L Updates**: Account equity updates are memoized via `useMemo` based on active positions and balances.
