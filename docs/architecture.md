# Architecture & System Design

Layered architecture of **TradingVibe**, an AI-assisted trading and bot
platform for **Hyperliquid HIP-3** markets: **Forex, Commodities, and
Indices**.

---

## 1. High-Level Architectural Diagram

```mermaid
graph TD
    subgraph Presentation [Presentation (mobile-first)]
        UI_Trades[Trades]
        UI_Quotes[Quotes & Chart]
        UI_Bots[Bots & Builder]
        UI_History[History & CSV]
        UI_AI[Floating AI Assistant]
    end

    subgraph Core [TradingVibe core]
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

    UI_Trades --> Env_Demo
    UI_Quotes --> HL
    UI_Bots --> AgentRuntime
    UI_History --> Env_Demo
    UI_AI --> OR

    AgentRuntime --> Policy --> Risk
    AgentRuntime --> Env_Demo
    AgentRuntime --> Env_Backtest
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
      -> Hyperliquid DEMO adapter  (real quote, simulated fill)
      -> execution result          (order id, fill price, position, trade)
      -> position / account state  (adapter is the single source of truth)
```

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

---

## 3. Environments

| Environment | Status | Market data | Orders | Fees |
| ----------- | ------ | ----------- | ------ | ---- |
| `BACKTEST` | Implemented | historical bars | simulated by the backtest engine | user-configured simulation parameters |
| `DEMO` | Implemented | live Hyperliquid quotes and candles | simulated fills against real bid/ask | **not modelled** (recorded as 0 and labelled as such) |
| `LIVE` | **Not implemented** | — | — | — |

There is no live signing, custody, or real-money execution path in this
repository, and no credentials are accepted anywhere.

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
* `agents/` — environment-agnostic runtime, skills, capabilities, policy, triggers, timeline.
* `backtester/` — historical simulation with explicit, user-configured cost parameters.

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
│   ├── ai/ chart/ editor/ layout/ modals/ navigation/ terminal/ views/
├── engine/
│   ├── agents/             # runtime, capabilities, skills, policy, triggers, timeline
│   ├── backtester/         # historical simulation
│   ├── execution/          # valuation, risk, order sizing rules, tests
│   ├── indicators/         # SMA, EMA, RSI, MACD, Bollinger, ATR
│   └── sandbox/            # strategy sandbox
├── services/
│   ├── marketData.ts       # registry of discovered instruments (no price synthesis)
│   ├── skills.ts           # strategy skill catalog
│   ├── strategies.ts       # sample strategy templates
│   └── userService.ts      # user profile abstraction
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
