# Module 14 — AI Copilot

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/services/aiContext/`,
`src/adapters/openrouter/{provider,types}.ts`,
`src/components/ai/{FloatingAIAssistant,AIPanel}.tsx`

**Purpose:** let the in-app copilot read a sanitised projection of what the app
already knows, and explain it. The AI has no write path into application state, no
adapter access, and no engine access.

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `aiContext/store.ts` | 136 | `AppContextState` `:60-97`, `AppContextStore.publish` `:98`, `appContextStore` `:134` |
| `aiContext/tools.ts` | 179 | 12 read functions + `AI_CONTEXT_TOOLS` `:167-178` |
| `aiContext/prompt.ts` | 326 | `buildContextPrefix`, system-prompt assembly |
| `aiContext/navigation.ts` | — | `NavigationTarget` types, `parseNavigationAction` |
| `aiContext/types.ts` | 247 | the context slice types |
| `aiContext/index.ts` | — | the barrel |
| `aiContext/tests.ts` | 472 | the AI-context test runner |
| `openrouter/provider.ts` | 290 | `OpenRouterProvider` `:96`, `openRouterProvider` `:291`, `STORAGE_KEY` `:3`, `POPULAR_MODELS` `:5`, `DEFAULT_AI_CONFIG` `:32` |
| `openrouter/types.ts` | — | `IAgentProvider`, `AIProviderConfig` |
| `ai/FloatingAIAssistant.tsx` | 579 | `FloatingAIAssistant` |
| `ai/AIPanel.tsx` | 308 | `AIPanel` — **not rendered** (no importer) |

---

## The one-way store

```
App effect #9                                       App.tsx:1852-2002
   deps (App.tsx:1998-2001): currentTab, symbol, timeframe, executionMode,
        balance, equity, margin, freeMargin, positions, trades, instruments,
        quotes, bots, botDefinitions, labTriggers, isKillSwitchActive, walletState
   ↓
appContextStore.publish({ … })                       App.tsx:1853-1996
   {
     currentTab, currentView, selectedMarket, selectedTimeframe, selectedBotId,
     executionMode,
     account { …, riskState },
     positions[], trades[], markets[], bots[], triggers[],
     riskLimits { …, ...riskManager.getLimits() },        App.tsx:1986
     wallet   { …walletState, liveExecutionEnabled: false } App.tsx:1996
   }
   ↓  store.ts:98  (patch merge)
getCurrentAppContext() / getAccountState() / …  tools.ts:32-165
   ↓
FloatingAIAssistant.gatherContext(selectSlices(text))  FloatingAIAssistant.tsx:152-169
   ↓
buildContextPrefix(...)                              prompt.ts
   ↓ prepended to the user message
openRouterProvider.chat(...)                          provider.ts:150
```

`AppContextStore.publish` — `store.ts:98` — is a **patch merge** with **no
subscription mechanism**: the AI tools read the current snapshot synchronously when
called.

---

## The 12 read functions — `aiContext/tools.ts`

| Function | Line | Reads |
| --- | --- | --- |
| `getCurrentAppContext()` | `:32-55` | page, tab, selected market/bot, environment |
| `getAccountState()` | `:57-59` | balance, equity, margin, P&L, risk state |
| `getOpenPositions()` | `:61-63` | open positions and their levels |
| `getRecentTrades(limit = 20)` | `:65-74` | closed trades and realised P&L |
| `getAvailableMarkets(filter?)` | `:76-99` | discovered instruments and availability |
| `getMarketQuote(symbol)` | `:101-111` | one market: bid, ask, precision, size limits |
| `getBots()` | `:113-115` | bot list, status, market, risk profile |
| `getBot(botId)` | `:117-122` | one bot in detail |
| `getTriggers(botId?)` | `:124-130` | trigger definitions and recent fires |
| `getRiskState()` | `:132-155` | deterministic risk limits and current state |
| `getWalletState()` | `:157-160` | wallet connection state (never credentials) |
| `getFullContext()` | `:162-165` | the whole projection |

`guard<T>(value, name)` `:27-30` wraps a tool body.

`AI_CONTEXT_TOOLS` — `:167-178` — is the manifest of names and what each reads.

**Every function reads `appContextStore` only.** None calls an adapter, an engine, the
wallet SDK, or the network. None writes.

---

## `OpenRouterProvider` — `adapters/openrouter/provider.ts`

| Element | Line |
| --- | --- |
| `STORAGE_KEY = 'tradingvibe_openrouter_config'` | `:3` |
| `POPULAR_MODELS` | `:5` |
| `DEFAULT_AI_CONFIG` | `:32` |
| `class OpenRouterProvider implements IAIProvider` | `:96` |
| config load from `localStorage` | `:105` |
| config save to `localStorage` | `:131` |
| `chat(messages, …)` | `:150` |
| `callOpenRouter(...)` | `:163` |
| `await fetch(...)` | `:194` |
| `export const openRouterProvider` | `:291` |

**Two consumers share this one provider**

| Consumer | Line |
| --- | --- |
| The agent runtime | `agents/model/openrouter.ts:6` → `openRouterProvider.chat` |
| The copilot UI | `FloatingAIAssistant.tsx:272`, `:308` |
| Settings modal | `App.tsx:337-340` (`getConfig`), `:2840` (`saveConfig`) |

---

## `FloatingAIAssistant` — `components/ai/FloatingAIAssistant.tsx`

**Props from `App`**

| Prop | App line |
| --- | --- |
| `openPositions={positions}` | `:2652` |
| `onClosePosition={handleClosePosition}` | `:2656` |
| `externalPrompt={externalAIPrompt}` | `:2660` |
| `onClearExternalPrompt` → `setExternalAIPrompt(null)` | `:2663-2667` |
| `hasProviderKey={hasOpenRouterKey()}` | `:2670` |
| `onOpenProviderSettings` → `setShowAIModal(true)` | `:2673-2677` |
| `onSelectMarket` → `setSymbol` + `setCurrentTab('quotes')` | `:2679-2687` |
| `onInspectTrigger` → `setShowTriggerBuilder(true)` | `:2689-2693` |
| `onTestTrigger` → `setShowTriggerBuilder(true)` | `:2695-2699` |
| `onNavigate` → `tabForNavigation()` + `setCurrentTab` | `:2701-2726` |

**Flow**

```
effect on [externalPrompt]                            :118-127
   ├─ setIsOpen(true)
   ├─ void send(externalPrompt)
   └─ onClearExternalPrompt()

send(prompt)                                          :227
   ├─ setMessages / setIsLoading
   ├─ detect a close request → setActionableTrade     :247
   ├─ hasProviderKey === false → short-circuit         :254
   ├─ buildContextPrefix(gatherContext(selectSlices(text)))  :269
   │    selectSlices — keyword match over slices      :136-150
   │    gatherContext — calls the 12 read tools       :152-169
   ↓ await openRouterProvider.chat(...)               :272
parseNavigationAction(text)                           :307
   ├─ render the message + optional action button     :310-318
   └─ setProviderModel(openRouterProvider.getConfig().model)  :308
   ↓ user taps the action button
handleAction                                          :337
   ├─ onSelectMarket / runNavigation / onInspectTrigger / onTestTrigger
   └─ "Confirm and close {symbol}" → onClosePosition  :463-481
```

`void send(...)` is not awaited and the prompt is cleared immediately after
(`App.tsx:2664`), so each `externalPrompt` is consumed once.

---

## Depends on

| Module | How |
| --- | --- |
| App Shell | props and callbacks; `appContextStore.publish` `App.tsx:1853` |
| Services & App State | `appContextStore`; the theme and wallet providers feed the published snapshot |
| Agent Runtime | the **reverse**: `agents/model/openrouter.ts` consumes the same provider |
| Types | `types/aiContext.ts` (`MainTab` `:1`, `RiskState`) |

## Used by

| Consumer | Line |
| --- | --- |
| `App` | `App.tsx:1853` (publish), `:2650` (render), `:337-340` / `:2840` (config), `:2217` / `:2345` / `:2421` / `:2540` / `:2564` (prompts) |
| `AgentRuntime` (via the model) | `runtime.ts:57` default `agentModel` |
| `SettingsTab` / `OpenRouterSettingsModal` | `App.tsx:2622`, `:2830` |
| `AIPanel` | unmounted; its `onPreviewDiff` (`AIPanel.tsx:26`) would be `StrategyDiffModal`'s only consumer |
| Test runner (test-only) | `services/aiContext/tests.ts` (472 lines) |

## Reads

| Source | Line |
| --- | --- |
| `appContextStore` (all 12 tools) | `tools.ts:32-165` |
| `localStorage` OpenRouter config | `provider.ts:105` |
| `openRouter` HTTP response | `provider.ts:194` |
| `props.openPositions` | `FloatingAIAssistant.tsx` |

## Writes

| Target | Line |
| --- | --- |
| `appContextStore` | `App.tsx:1853` — **the only writer** |
| `localStorage` OpenRouter config | `provider.ts:131` |
| `FloatingAIAssistant` local state | `messages`, `isLoading`, `isOpen`, `actionableTrade`, `providerModel` — `:118-127, 227, 247, 308` |
| `App` state **only via props callbacks the user triggers** | `App.tsx:2656-2726` |

## Mutates

- `App.currentTab` / `App.symbol` via `onSelectMarket` / `onNavigate` — but only when
  the user taps a rendered button (`FloatingAIAssistant.tsx:337`).
- `App.showTriggerBuilder` via `onInspectTrigger` / `onTestTrigger`.
- `App.externalAIPrompt` is cleared by `onClearExternalPrompt` `App.tsx:2664`.
- **No AI tool mutates any store.** The direction App → store → tools is one-way.

## Emits

None. No `eventBus` use in `src/services/aiContext/` or `src/components/ai/`.

## Subscribes to

None. There is no `eventBus` subscription and no `localStorage` `storage` event
listener; the assistant reads the store on demand.

## External dependencies

| Boundary | Line | Kind |
| --- | --- | --- |
| `https://openrouter.ai/api/v1/chat/completions` | `provider.ts:194` | `await fetch` POST — the only AI egress |
| `localStorage` | `provider.ts:105, 131` | persistence of the user-supplied key |
| `VITE_OPENROUTER_API_KEY` | `config/env.ts:71` | optional build-time key (name only) |

**No secret value is recorded here.** The user-supplied key is stored under
`tradingvibe_openrouter_config` in the user's own browser.

## Entry points

`appContextStore.publish` `store.ts:98` · the 12 tools `tools.ts:32-165` ·
`buildContextPrefix` `prompt.ts` · `parseNavigationAction` `navigation.ts` ·
`openRouterProvider.chat` `provider.ts:150` · `FloatingAIAssistant` `App.tsx:2650` ·
`openRouterProvider.saveConfig` via `App.tsx:2840`.

## Exit points

- `fetch` to OpenRouter (`provider.ts:194`) — used by both the copilot and the agent
  runtime.
- `localStorage` writes.
- React callbacks the user must tap.

---

## Enforced boundaries (as implemented)

| Boundary | Evidence |
| --- | --- |
| The AI cannot place an order | no tool calls `placeMarketOrder`; `tools.ts:32-165` reads `appContextStore` only |
| The AI cannot change a risk limit | `riskManager.getLimits()` `App.tsx:1986` is a read; `updateLimits` `risk.ts:91` has no caller outside the risk module |
| The AI cannot see credentials | `getWalletState()` returns connection state only `tools.ts:157-160`; `liveExecutionEnabled` is hard-coded `false` `App.tsx:1996` |
| The AI cannot reach the provider | the tools are pure functions over the published snapshot; no `useWallet()` call exists in `tools.ts` |
| Every order still passes the gates | the only route from a copilot action to trading is a user tap on `onClosePosition` → `App.handleClosePosition` `App.tsx:916` → adapter → `RiskManager` |
| The agent path is separately gated | `runtime.ts:894` policy → `:906` risk → `:979` environment |

---

## Notable observations (factual)

- **`selectedBotId` is always `undefined`** — it comes from `selectedBotIdRef`
  (`App.tsx:365`), a `useRef` with no writer, read once at `App.tsx:1858`.
  Consequently `getBot(botId)` and `getBots()[0].id`-style lookups that depend on the
  selected bot have nothing to resolve against.
- **`appContextStore` has no subscription mechanism** — the tools read it
  synchronously; a `publish` during an in-flight `gatherContext` is not observed
  until the next read.
- **`AIPanel` (308 lines) and `StrategyDiffModal` are both unmounted**, so the
  "preview a diff the AI suggested" surface does not exist in the running app.
- The AI's only path to change anything is a rendered button the user presses
  (`handleAction` `FloatingAIAssistant.tsx:337`).
