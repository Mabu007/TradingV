# Data Flow Architecture

How data moves through **TradingVibe**: Hyperliquid market data, order
execution, agent activity, and user-AI interaction.

---

## 1. Market Data Flow

```mermaid
sequenceDiagram
    autonumber
    participant HL as Hyperliquid / HIP-3
    participant MD as HyperliquidMarketDataAdapter
    participant Normal as normalizer
    participant Meta as InstrumentMetadata
    participant Bus as EventBus
    participant UI as Quotes Screen

    HL-->>MD: perpDexs + metaAndAssetCtxs (per namespace)
    MD->>Normal: classify / normalize / availability
    Normal-->>Meta: canonical InstrumentMetadata
    MD-->>MD: unique app symbols across namespaces
    Meta-->>UI: active trading universe (tradeable markets only)
    MD->>HL: subscribe l2Book
    loop Realtime book stream
        HL-->>MD: { coin, levels[0][0].px, levels[1][0].px }
        MD->>Normal: quoteFromBook(symbol, bid, ask)
        MD-->>UI: real bid / ask / spread / timestamp
        MD->>Bus: MARKET_QUOTE
        MD->>Adapter: demo adapter marks open positions to market
    end
```

Key properties:

* Prices come only from the provider. No synthetic quote exists anywhere in
  the production path.
* A market the provider lists without a book is `UNAVAILABLE`: kept in
  metadata, excluded from the active universe, and never priced.
* Bars come from `candleSnapshot` / the `candle` stream and are independent of
  the quote stream; a quote tick never mutates the current candle.

---

## 2. Order Execution Flow

```mermaid
sequenceDiagram
    autonumber
    participant Intent as UI ticket or Agent decision
    participant Policy as ActionValidator (policy)
    participant Risk as RiskManager (deterministic)
    participant Guard as Demo execution guard
    participant MD as Hyperliquid market data
    participant Env as HyperliquidDemoAdapter
    participant Bus as EventBus
    participant UI2 as Trades Screen

    Intent->>Policy: intent (symbol, side, volume, stopLoss)
    alt Agent intent
        Policy->>Policy: deterministic policy checks (symbol, stop, positions, risk)
    end
    Intent->>Guard: placeMarketOrder(...)
    Guard->>Guard: instrument metadata + size precision validation
    Guard->>MD: live quote
    MD-->>Guard: real bid / ask
    Guard->>Risk: validateOrder(order, positions, valuation context)
    alt Rejected
        Risk-->>Intent: { category, message } (e.g. EXPOSURE_LIMIT_EXCEEDED)
        Guard-->>UI2: order ticket keeps the reason visible
    else Approved
        Guard->>Env: fill (BUY -> ask, SELL -> bid)
        Env->>Env: value in account currency, store position, realize commission 0
        Env-->>Bus: ORDER, POSITION_OPEN
        Bus-->>UI2: projection of adapter state
    end
```

Safeguards:

1. **One execution guard.** Manual tickets, agent capabilities, and the
   runtime all reach the same adapter, so sizing and validation rules cannot
   diverge.
2. **Deterministic risk.** Policy and risk run in code, never in the model.
   An AI agent cannot bypass them, and a rejection is identical for manual and
   agent orders.
3. **Valued in the account currency.** Exposure, stop risk, and P&L are
   computed per instrument from its metadata, then summed. Quantities of
   unrelated instruments are never added together.
4. **Adapter owns execution state.** Positions, P&L, trades, and balance are
   produced once, in the adapter. The UI projects them.

---

## 3. Agent Runtime Flow

```mermaid
sequenceDiagram
    autonumber
    participant Trigger as TriggerEngine
    participant RT as AgentRuntime
    participant Obs as Observation builder
    participant Model as OpenRouter (BYO key)
    participant Validator as ActionValidator
    participant Risk as RiskManager
    participant Env as DemoEnvironment -> Demo adapter

    Trigger->>RT: wake (NEW_BAR, POSITION_OPEN, ...)
    RT->>Obs: quote, bars, account, positions, capabilities
    Obs->>RT: AgentObservation (real market data only)
    RT->>Model: thought + tool call / decision
    Model-->>RT: structured decision (proposal only)
    RT->>Validator: validate(decision, policy, observation, instruments)
    RT->>Risk: validateOrder(...)
    alt Approved
        RT->>Env: placeMarketOrder / modifyPosition / closePosition
        Env-->>RT: execution result (or structured rejection)
        RT->>Trigger: timeline events
    else Rejected
        RT-->>RT: record rejection + category in the timeline
    end
```

The runtime is environment-agnostic: DEMO, BACKTEST, and a future LIVE
environment all satisfy the same `ITradingEnvironment` contract, including the
optional `getInstruments()` metadata read. The agent never learns provider
details and never holds credentials.

---

## 4. Conversational AI Assistant Flow

```mermaid
sequenceDiagram
    autonumber
    participant User as Trader (mobile UI)
    participant UI as FloatingAIAssistant
    participant Provider as OpenRouterProvider
    participant API as OpenRouter

    User->>UI: "Why is my Gold position losing?"
    UI->>Provider: chat(messages, context)
    Provider->>API: HTTP POST /v1/chat/completions (BYO key)
    API-->>UI: explanation
    alt User requests an action
        UI-->>User: confirmation card
        User->>UI: confirm
        UI->>Env: deterministic execution path
    end
```

Safety policy:

* The AI explains and proposes; it never executes on its own.
* Every action goes through the same deterministic policy and risk gate as a
  manual order.
* The AI never receives keys, signing authority, or custody.
