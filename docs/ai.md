# AI Assistant Architecture

This document details the AI architecture, model provider integration, contextual intelligence, and action safety protocols in **TradingVibe**.

---

## 1. AI Provider Abstraction (`src/adapters/openrouter/`)

TradingVibe uses a provider-agnostic interface (`IAIProvider`), backed primarily by **OpenRouter**:

* **Bring-Your-Own-Key (BYO Key)**: Users can supply their personal OpenRouter API key in Settings.
* **Model Agnostic**: Supports leading reasoning and coding models:
  * `anthropic/claude-3.5-sonnet` (Default recommended)
  * `openai/gpt-4o`
  * `deepseek/deepseek-chat`
  * `google/gemini-2.0-flash-001`
  * `meta-llama/llama-3.3-70b-instruct`
* **Local Storage**: API keys are saved directly in browser `localStorage` and never transmitted to TradingVibe intermediary servers.

---

## 2. Contextual Awareness System (`src/types/aiContext.ts`)

Instead of dumping the entire application memory into every prompt, TradingVibe provides targeted, relevant context:

```ts
export interface AIContext {
  currentTab: "quotes" | "bots" | "trades" | "history" | "settings";
  selectedMarket?: string;
  selectedBotId?: string;
  selectedBotName?: string;
  selectedTradeId?: string;
  selectedPositionId?: string;
  accountBalance?: number;
  openPositionsCount?: number;
  activeBotsCount?: number;
}
```

### Context-Driven Responses:
* **On Quotes / Market Detail**: Ingests recent high, low, close, and timeframe to explain price action and technical levels.
* **On Trades**: Ingests unrealized P&L and open positions (instrument units) to evaluate risk exposure.
* **On Bots**: Ingests backtest metrics and strategy rules to identify performance bottlenecks.
* **On History**: Ingests exit reasons and commission costs to audit trade outcomes.

---

## 3. Safety Directives: Confirmation-Based Actions

```text
The AI must EXPLAIN and SUGGEST, never silently CONTROL.
```

### Execution Guardrail:
If a user writes:
> *"Close my open EURUSD trade."*

The AI **never** triggers an order execution in the background. Instead, it generates an actionable confirmation card:

```text
┌──────────────────────────────────────────────┐
│ ⚠ Action Confirmation Required               │
│                                              │
│ You have 1 open EURUSD position:             │
│ BUY 0.10 lots                                │
│ Current Unrealized P&L: +$8.21               │
│                                              │
│ [ Confirm & Close EURUSD Position ]          │
└──────────────────────────────────────────────┘
```

The position is closed **only** when the user physically taps the confirmation button.
