# AI Assistant Architecture

This document details the AI architecture, model provider integration, contextual intelligence, and action safety protocols in **TradingGOATs**.

---

## 1. AI Provider Abstraction (`src/adapters/openrouter/`)

TradingGOATs uses a provider-agnostic interface (`IAIProvider`), backed by **OpenRouter**:

* **Bring-Your-Own-Key (BYO Key)**: Users supply their personal OpenRouter API key in Settings.
* **Local Storage**: API keys are saved directly in browser `localStorage` and never transmitted to TradingGOATs intermediary servers.

### Endpoints

One base, one path builder, one normaliser — in `endpoints.ts`:

| Call | URL |
| ---- | --- |
| Chat | `POST https://openrouter.ai/api/v1/chat/completions` |
| Catalogue | `GET  https://openrouter.ai/api/v1/models` |

`openRouterUrl()` collapses a duplicated `/api/v1` or a base that already
carries the path, so the two shapes that produced a 404 cannot be written.

### Model discovery

Models are **fetched, not listed**. `catalogue.ts` calls
`GET /api/v1/models`, keeps text-in/text-out models, normalises each one
(name, provider, context, pricing, tool/JSON/reasoning/vision support) and
caches the result for six hours in memory and in `localStorage`.

* The picker shows the human name and hides the routing id.
* Filters (Free, Tool calling, Reasoning, Long context) are only offered
  where the metadata supports them.
* `FALLBACK_MODELS` is a small built-in list used **only** when the
  catalogue cannot be fetched, so a network failure cannot make the app
  unusable. It is not a second model picker.
* A catalogue failure is reported to the UI; it never silently pretends to
  be a live list.

### Default and recovery

* The shipped default (`DEFAULT_MODEL_ID`) is free, text-capable, and
  supports tools and structured output, because that is the request format
  the GOAT runtime sends.
* A persisted model that has left the catalogue is **reported**, never
  changed behind the user's back. `reconcileModel()` runs at startup and
  only replaces the selection when the stored id is genuinely gone, and it
  says so.
* A model that has answered once is remembered as `lastWorkingModel`.
* "Test this model" sends one cheap completion, because appearance in a
  catalogue does not mean a particular key can use it.

### Error classification

`errors.ts` classifies the response instead of calling everything a model
problem. The response body is read only as a signal — a fixed list of
phrases — and never surfaced, because a provider error page can echo the
credential back.

| Code | Cause | What the user is told |
| ---- | ----- | --------------------- |
| `KEY_REQUIRED` | no key configured | connect an OpenRouter key |
| `INVALID_KEY` | 401 | the key was rejected |
| `UNAUTHORIZED` | 403 | the key may not use this model |
| `OUT_OF_CREDITS` | 402 | the account cannot pay for it |
| `RATE_LIMITED` | 429 | this model is temporarily rate-limited |
| `MODEL_NOT_FOUND` | 404 naming the model | the model is unavailable |
| `MODEL_UNAVAILABLE` | 404/503, no provider | no provider, or privacy settings filter them |
| `ENDPOINT_NOT_FOUND` | 404 with nothing model-shaped | a bug in this build, not the key |
| `BAD_REQUEST` | 400/422 | the request was rejected |
| `PROVIDER_ERROR` | 5xx | OpenRouter or its provider |
| `NETWORK_ERROR` | transport failure | could not reach OpenRouter |
| `EMPTY_RESPONSE` | 200 with no usable content | the model returned nothing |
| `UNKNOWN` | unidentifiable | try again |

The `ENDPOINT_NOT_FOUND` case exists because an unknown path and an unknown
model answer with the same status. Telling someone their key is wrong
because a URL was mistyped sends them to fix the wrong thing.

---

## 2. Contextual Awareness System (`src/types/aiContext.ts`)

Instead of dumping the entire application memory into every prompt, TradingGOATs provides targeted, relevant context:

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

### GOAT reads (`src/services/aiContext/goatTools.ts`)

The assistant can answer questions about GOATs from the same records the
command centre renders, and a live quote for the market a question names.

```text
"what is my GOAT doing?"          → stage, runtime, work plan, what it watches
"why hasn't it produced a plan?" → the actual reason, in the runtime's words
"what is its thesis?"             → the hypothesis and its invalidation
"what is it watching?"            → its active trackers
"what happened while I was away?" → the runtime's own activity records
"what's happening with GOLD?"    → a live quote for that market
```

Routing is deterministic (`classifyGoatIntent`), not model-decided, so a
question cannot be answered from a record the assistant happened to be
shown. Two rules make the answers trustworthy:

* **Name a reason, or admit there is not one.** "Why hasn't it traded?"
  distinguishes not-deployed, stopped, no-thesis, no-supporting-evidence,
  thesis-not-actionable, and nothing-has-fired. Inventing a plausible
  reason is the most misleading answer this product could give.
* **Say so when it cannot see.** With no GOAT context provider registered
  the assistant says the feature is unavailable, rather than describing
  an empty system as though the user had no GOATs.

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

The same rule covers GOAT control. "Stop that GOAT", "start it again" and
"tell it to wait for the London session" produce a confirmation card that
names the GOAT and the effect; the assistant never stops, resumes or
steers one because a sentence asked it to.
