# Security Model & Risk Safeguards

This document specifies the security architecture, execution sandboxing, data protection policies, and financial risk controls in **TradingVibe**.

---

## 1. Security Status Summary

| Security Layer | Status | Description |
|---|---|---|
| **Strategy Code Sandboxing** | `Implemented` | Function scope isolation; blocked access to DOM, storage, and network fetch. |
| **Emergency Kill Switch** | `Implemented` | One-touch halt: closes all open positions and shuts down all active bots. |
| **Daily Drawdown Guard** | `Implemented` | Pre-trade risk manager halts trading if equity drops 5% in 24 hours. |
| **Max Order Throttling** | `Implemented` | Limits order size (50k units) and frequency (max 20 orders/min) to prevent runaway loops. |
| **Live Trading Confirmation** | `Reserved` | High-friction typed-consent modal; no live mode exists, so it cannot be reached. |
| **Position Close Confirmation** | `Implemented` | Two-step deliberate confirmation on mobile position sheet prevents accidental closures. |
| **AI Action Guardrails** | `Implemented` | AI can only explain and suggest actions; user must explicitly tap confirmation buttons. |
| **BYO API Key Isolation** | `Implemented` | Keys are stored locally in the browser (`localStorage`) and sent directly to OpenRouter. |
| **Venue authentication** | `Not implemented` | TradingVibe holds no venue credentials; live execution does not exist. |
| **Firebase User Auth** | `Planned` | Role-based authentication and secure cloud persistence. |

---

## 2. Strategy Sandboxing & Execution Isolation

Because TradingVibe allows executing arbitrary JavaScript/TypeScript algorithms, sandboxing is critical to prevent malicious scripts from hijacking sessions or stealing broker tokens:

```mermaid
graph TD
    Strategy[strategy.ts User Code] --> Sandbox[Restricted Function Scope]
    
    subgraph Allowed Interfaces
        Sandbox --> Ctx_Market[ctx.market.quote / bars]
        Sandbox --> Ctx_Math[ctx.indicators (Pure Math)]
        Sandbox --> Ctx_Orders[ctx.orders (Validated by Risk Manager)]
    end

    subgraph Denied Globals (Blocked / Undefined)
        Sandbox -.->|BLOCKED| DOM[window, document]
        Sandbox -.->|BLOCKED| Net[fetch, XMLHttpRequest, WebSocket]
        Sandbox -.->|BLOCKED| Storage[localStorage, sessionStorage, indexedDB]
        Sandbox -.->|BLOCKED| Eval[eval, Function constructor]
    end
```

---

## 3. Financial Risk Management (`src/engine/execution/risk.ts`)

TradingVibe's execution engine routes every order through deterministic pre-trade validation before the execution adapter acts:

1. **Max Order Volume**: Rejects any individual order exceeding 50,000 units (0.50 lots) in retail mode.
2. **Max Open Positions**: Caps total simultaneous positions at 5 to protect account margin.
3. **Daily Drawdown Limit**: If equity declines by more than 5.0% within a rolling 24-hour window, the system automatically engages the Emergency Kill Switch.
4. **Order Throttling**: Limits bot orders to a maximum of 20 operations per minute to prevent runaway recursion or infinite loops from spamming the broker.

---

## 4. Emergency Kill Switch (`KillSwitchModal.tsx`)

Accessible instantaneously from:
1. The top header alert octagon icon (`AlertOctagon`).
2. Settings → Risk Management & Safeguards.

### When Triggered:
* Immediately closes all open market positions at current bid/ask prices.
* Transitions all running bots to `STOPPED` status.
* Emits a critical `RISK_VIOLATION` event to the system log.
* Halts further order submissions until explicitly acknowledged and reset by the trader.
