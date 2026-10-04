# Chain: AI Copilot Chat

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the user taps the header sparkle, or an "Ask AI" button on a position,
trade, market, or bot.

**Confidence:** CONFIRMED for the control flow. The model's text is DYNAMIC.

---

## Stage 1 — the five entry points

| Entry | Handler | Line | Prompt set |
| --- | --- | --- | --- |
| Header sparkle | `MobileHeader.onOpenAI` | `App.tsx:2210-2220` | `'What is the current market overview?'` `:2217` |
| Position analysis | `TradesTab.onAskAI` ← `PositionDetailModal` `:179-186` | `App.tsx:2338-2351` | `'Analyze my trade on …'` `:2345` |
| Market analysis | `QuotesTab.onAskAI` | `App.tsx:2414-2427` | `'Provide technical analysis and key levels for …'` `:2421` |
| Bot analysis | `BotsTab.onOpenAIWithPrompt` (4 sites: `BotsTab.tsx:295, 419, 472`) | `App.tsx:2530-2543` | the caller's prompt `:2540` |
| Trade audit | `HistoryTab.onAskAI` | `App.tsx:2557-2570` | `'Audit this historical trade on …'` `:2564` |

All five share the same first step:

```
requireOpenRouterKey()                                     App.tsx:385-392
   ├─ hasOpenRouterKey()  (openRouterConfig.apiKey.trim().length > 10)   App.tsx:372-376
   ├─ false → setShowAIModal(true); return false            App.tsx:390
   └─ true  → return true                                   App.tsx:392
      ↓
setExternalAIPrompt(<prompt>)                               App.tsx:2217/2345/2421/2540/2564
```

## Stage 2 — the assistant opens itself

```
FloatingAIAssistant useEffect([externalPrompt])             FloatingAIAssistant.tsx:118-127
   ├─ setIsOpen(true)
   ├─ void send(externalPrompt)
   └─ onClearExternalPrompt?.()      → App.setExternalAIPrompt(null)   App.tsx:2664
```

Note: `void send(...)` is not awaited, and the prompt is cleared immediately after, so
the prompt is consumed once.

## Stage 3 — context gathering

```
send(prompt)                                               FloatingAIAssistant.tsx:227
   ├─ setMessages(...); setIsLoading(true)
   ├─ detect a close request → setActionableTrade(...)      :247
   ├─ if (hasProviderKey === false) → short-circuit         :254
   └─ buildContextPrefix(gatherContext(selectSlices(text)))  :269
```

`selectSlices(text)` — `FloatingAIAssistant.tsx:136-150` — keyword-matches the user's
text against available context slices.

`gatherContext` — `FloatingAIAssistant.tsx:152-169` — invokes the read-only tools.

### The 11 read-only tools — `src/services/aiContext/tools.ts`

| Tool | Line | Reads |
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

`AI_CONTEXT_TOOLS` — the manifest of these names and what each reads,
`tools.ts:167-178`.

**Every tool reads `appContextStore` only.** There is no tool that writes, and no tool
that calls an adapter, an engine, or the wallet SDK.

### How the store is populated

```
App effect #9                                             App.tsx:1852-2002
   deps (App.tsx:1998-2001): currentTab, symbol, timeframe, executionMode, balance,
        equity, margin, freeMargin, positions, trades, instruments, quotes, bots,
        botDefinitions, labTriggers, isKillSwitchActive, walletState
   ↓
appContextStore.publish({
   currentTab, currentView, selectedMarket, selectedTimeframe, selectedBotId,
   executionMode,
   account { …, riskState },
   positions[], trades[], markets[], bots[], triggers[],
   riskLimits { …, ...riskManager.getLimits() },
   wallet   { …walletState, liveExecutionEnabled: false }
})                                                        App.tsx:1853-1996
```

**Sanitisation (CONFIRMED)** — `publish` is a patch-merge
(`src/services/aiContext/store.ts:98`); the snapshot is explicitly read-only;
`wallet.liveExecutionEnabled` is hard-coded `false` (`App.tsx:1996`);
`selectedBotId` comes from `selectedBotIdRef` (`App.tsx:1858`), a `useRef` at
`App.tsx:365` with **no writer**, so it is always `undefined`.

`currentViewLabel(tab)` — `App.tsx:114-122` maps the tab to a human label
(quotes→Quotes, bots→Bots, trades→Trades, history→History, else Settings).

## Stage 4 — the model call

```
[4] await openRouterProvider.chat(...)                    FloatingAIAssistant.tsx:272
      adapters/openrouter/provider.ts:150
      └─ callOpenRouter(...)                              provider.ts:163
         └─ await fetch(https://openrouter.ai/...)        provider.ts:194
```

Config: `DEFAULT_AI_CONFIG` `provider.ts:32`; loaded from `localStorage`
(`STORAGE_KEY = 'tradingvibe_openrouter_config'`) at `provider.ts:105`, saved at
`provider.ts:131`. `POPULAR_MODELS` `provider.ts:5`.

The agent runtime uses the same provider through a different entry:
`agentModel.run` — `agents/model/openrouter.ts:6` → `openRouterProvider.chat`.

Sentinel handling for the assistant path: `FloatingAIAssistant.tsx:280`, `:293`.

## Stage 5 — response parsing and rendering

```
parseNavigationAction(text)                               FloatingAIAssistant.tsx:307
   ├─ message rendered                                       :310-318
   └─ setProviderModel(openRouterProvider.getConfig().model) :308
```

If the response contains a navigation action, a button is rendered. Tapping it runs
`handleAction` — `FloatingAIAssistant.tsx:337`:

| Action | Callback | App side |
| --- | --- | --- |
| `QUOTES` | `onSelectMarket(next)` | `setSymbol(next)` + `setCurrentTab('quotes')` — `App.tsx:2679-2687` |
| any `NavigationTarget` | `runNavigation(target)` → `onNavigate(target)` | `tabForNavigation(target)` then `setCurrentTab` — `App.tsx:2701-2726`; mapping at `App.tsx:130-142` |
| inspect a trigger | `onInspectTrigger()` | `setShowTriggerBuilder(true)` — `App.tsx:2689-2693` |
| test a trigger | `onTestTrigger()` | `setShowTriggerBuilder(true)` — `App.tsx:2695-2699` |

`NavigationTarget` values handled by `tabForNavigation` — `App.tsx:130-142`:
`TRADES`, `BOTS`, `CREATE_BOT`, `QUOTES`, `HISTORY`, `SETTINGS`, `INSPECT_TRIGGER`,
`TEST_TRIGGER`.

## Stage 6 — the one action that touches trading

```
"Confirm and close {symbol}"                              FloatingAIAssistant.tsx:463-481
   └─ onClosePosition(actionableTrade.id)                 FloatingAIAssistant.tsx:466
      └─ App.handleClosePosition                           App.tsx:916
         └─ hyperliquidDemoAdapter.closePosition           demo.ts
```

`actionableTrade` is set only when `send` detects a close request in the model response
(`FloatingAIAssistant.tsx:247`), and the button is a **user action** — the model cannot
invoke it.

## Security boundaries (as implemented)

| Boundary | Evidence |
| --- | --- |
| The AI can never place an order | no AI tool calls `placeMarketOrder`; `tools.ts:32-165` reads only `appContextStore` |
| The AI can never change a risk limit | `riskManager.getLimits()` is read-only at `App.tsx:1986`; `updateLimits` has no caller outside the risk module |
| The AI can never see credentials | `getWalletState()` returns connection state only — `tools.ts:157-160`; `liveExecutionEnabled` is hard-coded `false` |
| The AI reaches App only through callbacks | `App.tsx:2656-2726`; the store is one-way |
| Every order still passes policy + risk | `App.handleExecuteOrder` → adapter → `RiskManager`; agent orders → `ActionValidator` + `RiskManager` |

## State summary

| State | Writer | Reader |
| --- | --- | --- |
| `appContextStore` state | `App.tsx:1853` (only writer) | the 11 AI tools |
| `openRouterProvider.config` | `provider.ts:131` (`localStorage`) | `provider.ts:150`; `App.tsx:375` |
| `App.externalAIPrompt` | 5 sites; cleared at `App.tsx:2664` | `FloatingAIAssistant` effect `:118` |
| `App.showAIModal` | `App.tsx:390` | `OpenRouterSettingsModal` `:2826` |
| `FloatingAIAssistant.messages` / `isLoading` | `FloatingAIAssistant.tsx:227+` | render |
| `FloatingAIAssistant.actionableTrade` | `FloatingAIAssistant.tsx:247` | the confirm button `:463` |
| `App.currentTab` / `symbol` | via the navigation callbacks | the view ternary chain |

## Exit points

- `fetch` to OpenRouter — `provider.ts:194`. This is the only AI egress.
- Everything else terminates in a React callback the user must tap.
