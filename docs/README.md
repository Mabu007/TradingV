# TradingVibe — Developer Documentation

Welcome to the **TradingVibe** developer documentation. This documentation is written for software engineers maintaining, auditing, and extending the TradingVibe mobile-first trading and AI bot platform.

---

## 1. Product Overview

**TradingVibe** is a simple, approachable mobile-first trading platform that happens to let users build, backtest, and automate powerful trading bots without requiring deep coding knowledge upfront.

* **Primary Platform**: Mobile web (390×844, 375×812, 412×915 responsive touch-first design).
* **Desktop Platform**: Progressive expansion of the mobile architecture into a spacious left sidebar layout.
* **Core Trading Infrastructure**:
  * Live market data from **Hyperliquid** (REST + WebSocket), including HIP-3 namespaces for Forex, commodities, and indices.
  * Isolated JavaScript/TypeScript strategy execution engine.
  * In-browser historical backtesting simulator with tick-accurate spreads, commissions, and CSV export.
  * High-performance canvas charting via **TradingView Lightweight Charts**.
  * Context-aware **OpenRouter AI** assistant with conversational bot creation and strategy auditing.

---

## 2. Subsystem Implementation Status

| Subsystem | Status | Description |
|---|---|---|
| **Mobile-First UX** | `Implemented` | 5 fixed bottom tabs with Trades centerpiece, touch cards, bottom sheets |
| **Desktop Sidebar** | `Implemented` | Responsive left sidebar with clickable profile area at bottom |
| **Trades Screen** | `Implemented` | Account equity, open positions, P&L, position detail sheet with confirmation |
| **Quotes Screen** | `Implemented` | Real-time bid/ask list, search, favorites, Lightweight Charts detail |
| **Bots Screen** | `Implemented` | "My Bots" lifecycle, conversational AI builder, explore blueprints, backtester |
| **History Screen** | `Implemented` | Time-grouped trade audit, performance metrics, RFC 4180 CSV export |
| **Settings Screen** | `Implemented` | Profile management, broker accounts, AI keys, Emergency Kill Switch |
| **User Service** | `Implemented (Mock)` | `UserService` interface with local persistence; ready for Firebase Auth |
| **Hyperliquid Connection** | `Implemented` | REST + WebSocket with connection state machine |
| **Hyperliquid Market Data** | `Implemented` | HIP-3 discovery, `l2Book` quotes, candle streams, normalized `Quote` model |
| **Instrument Metadata** | `Implemented` | One canonical `InstrumentMetadata` model with availability policy |
| **DEMO Execution** | `Implemented` | Simulated fills against real venue bid/ask; fees not modelled |
| **LIVE Execution** | `Not implemented` | No signing, custody, or real-money path exists |
| **Strategy Runtime** | `Implemented` | Sandboxed runner with `TradingContext` API (`market`, `indicators`, `orders`) |
| **Backtester** | `Implemented` | Event-driven simulation across 300+ candles with slippage, spread, and CSV |
| **AI Assistant** | `Implemented` | Context-aware bottom sheet with BYO OpenRouter key support and action guards |
| **Firebase Auth** | `Planned` | Plug-and-play replacement for `MockUserService` |

---

## 3. Documentation Index

1. [Architecture & System Design](./architecture.md) — High-level layers, folder structure, and service boundaries.
2. [UX & Design Philosophy](./ux.md) — Mobile-first principles, touch targets, and progressive disclosure.
3. [Navigation & Routing](./navigation.md) — Bottom navigation, centerpiece Trades, and desktop sidebar.
4. [Data Flow](./data-flow.md) — Real-time quotes, order execution, and AI prompt lifecycles.
5. [Market Data Layer](./market-data.md) — Discovery, the instrument model, availability policy, quotes, and bars.
7. [Authentication & User Management](./authentication.md) — `UserService` contracts and Firebase roadmap.
8. [Strategy Runtime & Sandbox](./strategy-runtime.md) — TypeScript execution environment and SDK boundaries.
9. [Backtesting Engine](./backtesting.md) — Simulator mechanics, metrics, and CSV reporting.
10. [Bot Automation & Blueprints](./bots.md) — Bot lifecycle, state transitions, and explore templates.
11. [AI Assistant Architecture](./ai.md) — OpenRouter integration, context system, and action safety.
12. [State Management](./state-management.md) — Store hierarchy, tick updates, and reactivity.
13. [Component Inventory](./components.md) — Component catalog and responsibilities.
14. [Development & Workflow](./development.md) — Local setup, npm commands, and linting.
15. [Environment Configuration](./environment.md) — `.env.example` reference and credentials management.
16. [Security & Risk Safeguards](./security.md) — Sandboxing, kill switch, and live execution safeguards.
17. [Trading Agent Runtime](./agent-runtime.md) — Agent lifecycle, model boundary, policy, risk and environments.
18. [Agent Skills](./agent-skills.md) — Composable skill definitions and registration.
19. [Agent Capabilities](./agent-capabilities.md) — Safe tool registry and supported capability surface.
20. [Agent Triggers](./agent-triggers.md) — Deterministic market/event trigger filtering and wake lifecycle.
21. [Agent Timeline](./agent-timeline.md) — Auditable timeline events and correlation store.
