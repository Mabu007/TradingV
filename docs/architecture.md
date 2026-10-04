# Architecture & System Design

**GOAT — Goal-Oriented Agentic Trader**, an agentic trading research
and decision platform for **Hyperliquid HIP-3** markets: **Forex,
Commodities, and Indices**.

The user states a **goal**. GOAT investigates, forms a **thesis**,
deploys **trackers** to wait for specific evidence, sleeps, wakes on a
tracker event, re-evaluates, and constructs a **trade idea** only when a
thesis becomes actionable. See [goat.md](./goat.md) for the agentic
loop in full.

There is exactly one trading-agent architecture. The previous bot system
— bot definitions, bot builder, explorer templates, hand-authored
tracker lists — has been deleted rather than deprecated. See
[goat.md](./goat.md).

---

## 1. High-Level Architectural Diagram

```mermaid
graph TD
    subgraph Presentation [Presentation (mobile-first)]
        UI_Wallet[Wallet (Privy identity)]
        UI_Trades[Trades]
        UI_Quotes[Quotes & Chart]
        UI_GOAT[GOAT: Goal, Thesis, Watching, Evidence]
        UI_GOATS[GOATs list + deploy]
        UI_History[History & CSV]
        UI_AI[Floating AI Assistant]
    end

    subgraph Core [GOAT core]
        Goat[GOAT Orchestrator<br/>Goal -> Thesis -> Plan]
        Trackers[Tracker Runtime<br/>lifecycle, expiry, events]
        SDK[Tracker SDK<br/>permissioned]
        AgentRuntime[Agent Runtime -> Skills -> Capabilities]
        Valuation[Valuation model (P&L, risk, exposure, margin)]
        Risk[RiskManager (deterministic)]
        Policy[ActionValidator (deterministic policy)]
        Meta[InstrumentMetadata model]
        OrderSize[Order sizing rules]
    end

    subgraph Environments [Execution environments]
        Env_Demo[HyperliquidDemoAdapter]
        Env_Backtest[BacktestEnvironment / Simulator]
        Env_Live[Live environment: NOT IMPLEMENTED]
    end

    subgraph Adapters [Providers]
        HL[HyperliquidMarketDataAdapter]
        OR[OpenRouter AI provider (BYO key)]
    end

    subgraph External [External]
        Ext_HL[Hyperliquid REST + WebSocket]
        Ext_OR[OpenRouter LLM API]
    end

    UI_Wallet --> Identity[Privy (authentication only)]
    UI_Trades --> Env_Demo
    UI_Quotes --> HL
    UI_GOAT --> Goat
    Goat --> SDK
    SDK --> Trackers
    Goat --> AgentRuntime
    Trackers --> AgentRuntime
    UI_Bots --> AgentRuntime
    UI_History --> Env_Demo
    UI_AI --> OR

    AgentRuntime --> Policy --> Risk
    AgentRuntime --> Env_Demo
    AgentRuntime --> Env_Backtest
    AgentRuntime -.->|BLOCKED: no wallet access| Identity
    Risk --> Valuation
    Risk --> Meta
    Valuation --> Meta
    Env_Demo --> OrderSize
    Env_Demo --> Valuation
    Env_Demo --> HL
    HL --> Ext_HL
    OR --> Ext_OR
```

---

## 2. Execution path

```text
UI or agent intent
      -> deterministic policy      (ActionValidator)
      -> deterministic risk        (RiskManager + valuation model)
      -> execution guard           (instrument metadata + size precision)
      -> signing boundary          (NOT IMPLEMENTED)
      -> Hyperliquid DEMO adapter  (real quote, simulated fill)
      -> execution result          (order id, fill price, position, trade)
      -> position / account state  (adapter is the single source of truth)
```

The signing boundary is where a server-side Hyperliquid signer would sit. It
does not exist yet, so the only reachable path ends at the DEMO adapter.

Rules that hold for this path:

* **Instrument units everywhere.** `volume` is always provider units. Forex
  lots are a ticket-level representation.
* **Valued in the account currency.** Stop risk, exposure, margin, and P&L use
  `price distance x quantity x contract multiplier x quote->account`, with each
  factor taken from instrument metadata and the live quote. Where a factor
  cannot be established, the value is reported unavailable and the order is
  blocked rather than approximated.
* **No invented metadata.** Contract multiplier, minimum size, tick size, fees,
  and FX rates are never invented.
* **Deterministic risk.** The AI proposes intent; it cannot approve, resize, or
  bypass a risk decision.
* **A wake is not a trade.** A cheap deterministic tracker decides only whether
  an agent is worth waking. The agent then investigates and may decide to do
  nothing. Policy, risk, and the guard still run before anything executes.

---

## 2b. The agentic loop (GOAT)

```text
Goal -> Investigation -> Thesis -> Observation plan -> Trackers
     -> DORMANCY -> Tracker event -> Wake -> Re-evaluation
     -> Update thesis + Trackers -> DORMANCY
```

Invariants that hold on this path:

* **The agent does not poll.** It reasons when a goal is created and when
  a tracker fires. There is no polling loop in `GoatLoop`.
* **A tracker event is a fact, not a signal.** It carries no `side` and
  no `action`; the agent interprets it on every wake.
* **GOAT authors its own observation plan.** The user configures no
  indicators, conditions or trackers.
* **Trackers share infrastructure.** One market subscription, shared
  indicator state, per-thesis and per-agent ceilings.
* **A tracker event never becomes an order.** A wake produces a plan;
  an actionable thesis may produce a `TradeIdea`; only a `TradeIdea`
  that a user acts on reaches the policy and risk gates.
* **Skills participate in every phase**, and their constraints are
  machine-checked rather than requested.
* **Invalidation precedes entry.** A thesis states what would make it
  wrong before any price is chosen.

Full detail, including what was reused versus added, is in
[goat.md](./goat.md).

---

## 3. Environments

| Environment | Status | Market data | Orders | Fees |
| ----------- | ------ | ----------- | ------ | ---- |
| `BACKTEST` | Implemented | historical bars | simulated by the backtest engine | user-configured simulation parameters |
| `DEMO` | Implemented | live Hyperliquid quotes and candles | simulated fills against real bid/ask | **not modelled** (recorded as 0 and labelled as such) |
| `LIVE` | **Not implemented** | — | — | — |

There is no live signing, custody, or real-money execution path in this
repository. `LIVE` cannot be set: selecting it opens a notice rather than a
confirmation, and the only writer of the execution mode never assigns it.

A connected Privy wallet is an identity, not an execution permission. It does
not change the environment, does not place orders, and does not sign them.
Agents have no wallet capability and cannot reach the provider.

Demo margin is a projection based on the leverage the venue publishes per
market. It is not live clearing, maintenance margin, or liquidation state, and
the UI labels it as a demo estimate rather than showing a margin-call figure.

---

## 4. Layers

### Presentation (`src/components/`)
Mobile-first navigation, quotes/chart, order ticket, position and trade views,
bots workspace, and the contextual AI assistant. Components project state from
the execution adapter; they never compute execution economics themselves.

### Core engine (`src/engine/`)
* `execution/valuation.ts` — one valuation model for P&L, risk, exposure, and margin.
* `execution/risk.ts` — deterministic order gate with structured rejections.
* `execution/errors.ts` — rejection categories and user-safe messages.
* `agents/` — environment-agnostic runtime, skills, capabilities, policy, trackers, timeline.
* `backtester/` — historical simulation with explicit, user-configured cost parameters.

### Services (`src/services/`)
* `wallet/` — the Privy root provider, the application-level `WalletService`
  interface, and the wallet/environment/security tests. The only module other
  code imports for wallet access.
* `marketData.ts` — registry of discovered instruments. No price synthesis API.
* `userService.ts` — local profile abstraction, separate from the wallet.

### Configuration (`src/config/`)
* `env.ts` — the single reader of client-visible (`VITE_*`) configuration, plus
  the declared list of public and server-only variables.

### Adapters (`src/adapters/`)
* `hyperliquid/` — discovery, quotes, candles, and the DEMO execution adapter.
* `openrouter/` — AI provider (user-supplied key; no key is bundled).

---

## 5. Directory structure

```text
src/
├── adapters/
│   ├── hyperliquid/        # discovery, l2Book quotes, candles, DEMO execution adapter
│   └── openrouter/         # AI provider & model catalog
├── components/
│   ├── ai/ chart/ editor/ goat/ layout/ modals/ navigation/ terminal/ views/
├── engine/
│   ├── agents/             # runtime, capabilities, skills, policy, trackers, timeline
│   ├── backtester/         # historical simulation
│   ├── execution/          # valuation, risk, order sizing rules, tests
│   ├── indicators/         # SMA, EMA, RSI, MACD, Bollinger, ATR
│   └── sandbox/            # strategy sandbox
├── services/
│   ├── marketData.ts       # registry of discovered instruments (no price synthesis)
│   ├── strategies.ts       # sample strategy templates
│   ├── userService.ts      # user profile abstraction
│   ├── wallet/             # Privy provider, WalletService interface, wallet tests
│   ├── theme/              # design tokens, ThemeProvider, chart palette, theme tests
│   └── aiContext/          # read-only AI application context + navigation actions
├── config/
│   └── env.ts              # the only reader of client-visible (VITE_*) config
├── types/
│   ├── instruments.ts      # canonical InstrumentMetadata + availability
│   ├── trading.ts          # domain models
│   ├── events.ts           # normalized event bus
│   └── quotes.ts           # normalized quote and connection status
└── utils/
    ├── orderSize.ts        # shared order sizing / validation rules
    ├── positionSize.ts     # user-facing size labels
    └── csvExport.ts        # RFC 4180 CSV export
```

---

## 6. User-facing layers added in the product/UX pass

| Layer | Location | Notes |
| ----- | -------- | ----- |
| Theme | `src/services/theme/`, `src/index.css` | Two designed palettes behind `--tv-*` tokens. Dark is the default; the choice is persisted and beats the OS preference. |
| Wallet header action | `src/components/navigation/MobileHeader.tsx` | `Connect Wallet` / short address, driven by `useWallet()`. |
| AI application context | `src/services/aiContext/` | A read-only, secret-filtered projection of app state with narrow reader tools. |
| Tracker condition trees | `shared/condition_schema_v1.json` | The one condition language. Read by the browser for validation and by the Python engine for evaluation. |
| Condition engine | `server/tradingv_engine/` | Reads public market data and decides *when* to wake the AI. No execution capability. |
| Tracker evaluation | `src/engine/agents/trackers/` | Registry, runtime, evaluator and condition trees. Decides only whether a GOAT is worth waking. |

### The measure/act split

TradingGOATs is explicit about which half does what, because the boundary
is the safety property:

| | Decides | Cannot |
| --- | --- | --- |
| **Condition engine** (Python) | When the AI should be woken | Place, size, approve, or cancel an order. Holds no credentials. |
| **Web app** (TypeScript) | What to do about a wake | Measure a condition, so there is no second answer to disagree with |

A wake is a request to *think*. It carries the reason, the conditions, the
current price, and recent candles — and no side, no size, no leverage, no
signature. Turning it into a trade runs the existing policy, risk, and DEMO
execution guard, in that order, in `src/engine/agents/pipelineAcceptance.ts`
that path is proven offline in both directions: a risk-approved wake
produces a filled position and a timeline entry, and a rejected one leaves
no order, no position, and no history entry.

### Scrolling model

The **document** is the only vertical scroll region. The shell, sidebar,
and `<main>` never set a height constraint or `overflow: hidden`; the
sidebar and header are `sticky`. Views therefore grow to their content and
the page scrolls at the viewport edge instead of inside a nested box. The
only element allowed to own a scrollbar is the desktop sidebar, so a short
window can still reach every nav item.

### Theme tokens

Colours are declared once, in `src/index.css`, as `--tv-*` custom
properties, and bridged into Tailwind through an `@theme inline` block.
Components use semantic utilities (`bg-surface`, `text-ink`, `border-line`,
`text-pos`, `text-warn`, `text-neg`, `bg-accent-strong`, `text-accent-contrast`)
and never a literal hex. `bun run test:theme` fails if a shell or view
component regresses to a hardcoded colour.
