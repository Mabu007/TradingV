# User Experience & Design Philosophy

This document outlines the UX philosophy, information architecture, and component design patterns that define **TradingVibe**.

---

## 1. Core Philosophy: Mobile-Native & Progressive Disclosure

Traditional algorithmic trading software suffers from "terminal density": hundreds of microscopic buttons, cluttered charts, and deep configuration trees designed exclusively for multi-monitor workstations.

**TradingVibe flips this paradigm**:
1. **Mobile is the Primary Platform**: Designed from the outset for viewport sizes like 390×844, 375×812, and 412×915.
2. **Desktop is a Spacious Adaptation**: Desktop is not a separate application; it is simply a larger, breathing version of the mobile experience.
3. **Complexity Belongs Underneath the Interface**: The everyday user can browse markets, check live trades, inspect charts, talk to AI, and create bots in plain English without ever encountering TypeScript or broker protocol codes.
4. **Progressive Disclosure**: Advanced capabilities (Monaco code editor, execution logs, backtest parameters) are revealed only when the user deliberately opens them.

---

## 2. Primary Navigation

The application navigation is strictly bounded to **five primary destinations**:

```text
Quotes ── Bots ── [ TRADES ] ── History ── Settings
```

No secondary top-level menus, side hamburger drawers, or competing destinations exist on mobile.

### Mobile Bottom Bar & The Trades Centerpiece
* **The Centerpiece**: The **Trades** tab is situated at the physical center of the navigation bar.
* **Visual Weight**: It possesses approximately **2× the visual size and weight** of surrounding navigation items.
* **Elevation**: On mobile, it slightly rises above the navigation plane (`-mt-4`), encased in a vibrant gradient pill (`from-sky-500 to-indigo-600`) with a subtle glow when active.
* **Ergonomics**: Placed directly within thumb reach for single-handed mobile usage.

```text
┌────────────────────────────────────────────┐
│                  CONTENT                   │
│                                            │
│                                            │
├────────────────────────────────────────────┤
│                                            │
│ Quotes    Bots      ◉ TRADES    History  Settings
│                      ╰────╯                 │
└────────────────────────────────────────────┘
```

---

## 3. Desktop Navigation & Profile Area

On tablet and desktop viewports (`md:` breakpoint / 768px+):
* The fixed bottom navigation automatically shifts into a **sleek left sidebar (w-64)**.
* **Brand Header**: Fixed at the top with the TradingVibe logo and environment indicator.
* **Sidebar Items**: The exact same 5 destinations are listed in identical hierarchy.
* **Desktop Profile Area**: Anchored at the **bottom of the sidebar**, featuring:
  * Circular avatar with user initial
  * Username (`Gift`)
  * Email (`gtebogo75@gmail.com`)
  * Entire card is clickable to open the Profile management screen.

---

## 4. Screen Hierarchy & Default Landing Screen

### Default Landing Screen: Trades (`trades`)
When the user opens the application, they land immediately on **Trades**.
* **Why**: The user's primary question is *"What is happening with my capital right now?"*
* **Hierarchy**:
  1. **Account Summary Hero Card**: Net Equity, Balance, Margin Used (demo estimate), Available, Today's P&L pill, and venue connection status.
  2. **Open Positions List**: Clear cards showing symbol, direction (BUY/SELL), volume in lots, entry vs current price, and unrealized P&L in dollar and percent. Includes bot attribution tags.
  3. **Recent Activity**: Quick audit of today's closed transactions.

### Quotes Screen (`quotes`)
* **Purpose**: Market discovery.
* **Hierarchy**:
  1. Search bar with instant filtering and favorite stars (`★`).
  2. Clean, high-touch rows (minimum 64px height) displaying symbol, spread, real-time bid, ask, and 24h change.
  3. **Market Detail View**: Opens smoothly when a quote is tapped, presenting a TradingView Lightweight candlestick chart, timeframe pills, overlay toggles, and a prominent **[Trade]** action button.

### Bots Screen (`bots`)
* **Purpose**: "What bots do I have, and what can I create?"
* **Hierarchy**:
  1. Top `[+ Create Bot]` button triggering a conversational plain-English builder.
  2. **My Bots**: Status badges (`● RUNNING`, `○ STOPPED`, `◐ TESTING`, `⚠ ERROR`), today's P&L, position counts, and quick Start/Stop toggles.
  3. **Explore Bots**: Curated strategy blueprints (Trend Following, Breakouts, Mean Reversion) with plain-language summaries and zero misleading rankings.
  4. **Progressive Disclosure**: Within a Bot's detail view, the `Advanced → Code` tab is where Monaco Editor is lazy-loaded on demand.

### History Screen (`history`)
* **Purpose**: Performance review and trade auditing.
* **Hierarchy**:
  1. Time grouping: Today, Yesterday, Earlier This Month.
  2. Filter chips: All, Manual, Bots, Profitable, Losses.
  3. One-click **[Download CSV]** for external analysis in Excel or Python.
  4. Tap trade to view execution timestamps, commissions, and exit reasons.

### Settings Screen (`settings`)
* **Purpose**: Profile, broker connectivity, risk safeguards, and AI keys.
* **Hierarchy**:
  1. User Profile card (tap to open Profile Screen).
  2. Hyperliquid network settings (mainnet / testnet).
  3. OpenRouter AI provider configuration (BYO key).
  4. Emergency Kill Switch and drawdown guards.
  5. Developer documentation link.

---

## 5. Floating AI Assistant & Interaction Rules

* **Floating Button**: Persistent circular button positioned above the bottom bar on the bottom-right, equipped with a subtle breathing pulse.
* **Mobile Bottom Sheet**: Tapping slides up a 3/4 viewport sheet (not a full-page navigation), keeping the user in their active context.
* **Contextual Intelligence**: Reads `AIContext` (`currentTab`, `selectedMarket`, `selectedBotId`, `selectedTradeId`).
* **Safety Rule (Explain, Don't Blindly Execute)**: If the user prompts "Close my EURUSD trade", the AI never fires live orders invisibly. Instead, it generates a confirmation card with trade specifics and an explicit **[Close Position]** button for the user to confirm.
