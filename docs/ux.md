# User Experience & Design Philosophy

This document outlines the UX philosophy, information architecture, and component design patterns that define **TradingGOATs**.

---

## 1. Core Philosophy: Mobile-Native & Progressive Disclosure

Traditional algorithmic trading software suffers from "terminal density": hundreds of microscopic buttons, cluttered charts, and deep configuration trees designed exclusively for multi-monitor workstations.

**TradingGOATs flips this paradigm**:
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
* **Brand Header**: Fixed at the top with the TradingGOATs logo and environment indicator.
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

### GOATs Screen (`goat`)
* **Purpose**: "What do I want a GOAT to do, and what is it already doing?"
* **Live GOATs first.** A GOAT that is running right now is the answer to
  the question the user came with, so it is at the top of the screen and
  behind the `MY GOATs · EXPLORE GOATs` segmented control. Explore is a
  tab, not a permanently open section: four starter cards sitting above
  the user's own GOATs made their own GOATs look like leftovers.
* **Hierarchy**:
  1. **Live GOATs** — running GOATs, newest first: name, what it is
     working on, its work-plan step, its market and mode, and a count of
     what it is watching.
  2. **Create a GOAT** — name and description optional, one free-text
     goal, optional skills that can be written in place, and the four
     starters as examples beneath the form.
  3. **My GOATs** — every goal created here, with `[Edit] [Deploy]
     [Delete]`, where Delete archives rather than destroying so the goal,
     its theses and its evidence survive.
* **Progressive flow, always reversible**: compose → review → deploy →
  command centre, with `← All GOATs` on every step and the selected GOAT
  still there on return.
* **Deploying asks for one thing: the market.** Display names only, no
  provider symbols, no timeframe. Everything else is the GOAT's work.
* **The command centre is one screen in the order the product works**:
  what it is doing now → work plan → thesis → trackers → trade plan →
  activity. Every value is read from a record the runtime wrote; an idle
  GOAT shows an empty section with an explanation, not an animation. The
  three controls that exist are `[Stop]`, `[Play]` and `[Steer]`: stop
  keeps everything and retains the deployment, play restores that same
  deployment rather than creating a new one, and steer sends a note the
  next reasoning step reads.
* **Real state only**: theses, trackers, events, evidence, trade plans and
  the activity feed are the runtime's own records, and a steering note
  appears in the same feed so "did it hear me?" has an answer.

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

## 5. AI Assistant & Interaction Rules

* **One entry point**: the sparkles button in the header, at every screen
  size. It opens the assistant; it does not open a settings dialog or fire
  a canned question, and it is not duplicated as a floating button
  covering content on a phone.
* **Two layouts, deliberately different**:
  * **Desktop** — a side panel beside the application, 400px wide,
    capped in height so it never runs off the top or bottom of the
    viewport. Header, model selector and composer stay put; only the
    messages scroll.
  * **Mobile** — the whole screen, sticky header, scrollable messages,
    sticky composer with touch-sized targets.
* **Empty state**: an introduction plus five starter questions. They are
  questions, not claims: nothing pretends to know the market.
* **Model**: a searchable picker over OpenRouter's live catalogue, on its
  own row under the header so the model's name is readable. Changing it
  keeps the conversation; the next message uses the new model.
* **Keyboard**: Enter sends, Shift+Enter starts a new line.
* **One request at a time**: the composer is disabled while a request is
  in flight, guarded by a ref as well as by state so a double-click
  cannot send twice. Closing the panel mid-request is safe.
* **Errors**: each failure says what it was — rejected key, exhausted
  credits, rate limit, retired model, unreachable OpenRouter — and offers
  the one action that fixes it. The model is never changed silently.
* **Contextual intelligence**: reads the sanitised app context
  (`currentTab`, `selectedMarket`, GOATs, trackers, risk, wallet) and
  offers navigation targets. It never receives keys, seed phrases or
  signing secrets.
* **Safety rule (explain, don't blindly execute)**: asking it to close a
  trade produces a confirmation card with the specifics and an explicit
  confirm button. It cannot place, modify or close anything by itself, and
  it cannot enable live trading.
