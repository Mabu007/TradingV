# Module 13 — Services & App State

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/services/{marketData,strategies,userService}.ts`,
`src/services/{theme,wallet}/`, `src/utils/`, `src/config/env.ts`,
`src/types/`

**Purpose:** the application-scoped singletons, the two React providers
(`ThemeProvider`, `WalletProvider`), the localStorage-backed services, the pure sizing
utilities, the public-environment reader, and the shared type/event definitions.

---

## Contains

### Services
| File | Lines | Key exports |
| --- | --- | --- |
| `services/marketData.ts` | — | `SUPPORTED_SYMBOLS` `:14`, `timeframeToSeconds` `:16`, `MarketDataService` `:29`, `marketDataService` `:79` |
| `services/strategies.ts` | 194 | `SAMPLE_STRATEGIES` |
| `services/userService.ts` | — | `STORAGE_KEY = 'tradingvibe_user_profile'` `:25`, `getCurrentUser`, profile save |
| `services/theme/index.ts` | — | the barrel |
| `services/theme/theme.ts` | — | `THEME_STORAGE_KEY = 'tradingvibe_theme'` `:21`, `resolveInitialTheme`, `applyThemeAttribute` |
| `services/theme/ThemeProvider.tsx` | — | `ThemeProvider`, `useTheme` |
| `services/theme/chartTheme.ts` | — | chart colour mapping for `TradingChart` |
| `services/wallet/index.ts` | — | the barrel |
| `services/wallet/WalletProvider.tsx` | — | `WalletProvider` `:35-37`, `WalletContext` `:51`, `ConnectedWalletBridge` `:102-140`, `mapWalletState` `:88-100` |
| `services/wallet/privyConfig.ts` | — | `privySetup` |
| `services/wallet/types.ts` | — | the `WalletService` interface |
| `services/wallet/testRunner.ts` | 4 | the `test:wallet` entry |

### Utils
| File | Lines | Key exports |
| --- | --- | --- |
| `utils/orderSize.ts` | 202 | `lotsToInstrumentUnits`, `snapOrderSize`, `validateOrderSize` `:92` |
| `utils/positionSize.ts` | — | position sizing helpers |
| `utils/csvExport.ts` | — | CSV serialisation for history export |

### Config
| File | Lines | Key exports |
| --- | --- | --- |
| `config/env.ts` | 156 | `readPublicEnv` `:15-19`, `privyAppId` `:22-24`, `privyClientId` `:27-29`, `privyApiUrl` `:32-34`, `privyLoginMethods` `:37-39`, `hyperliquidNetwork` `:43-47`, `appUrl` `:57-62`, `openRouterApiKey` `:70-72`, `PUBLIC_ENVIRONMENT_VARIABLES` `:78-118`, `SERVER_ONLY_ENVIRONMENT_VARIABLES` `:124-156` |

### Types
| File | Lines | Key exports |
| --- | --- | --- |
| `types/events.ts` | 75 | `TradingVibeEvent` (22 members) `:3-25`, `EventListener` `:27`, `EventBus` `:29-73`, `eventBus` `:75` |
| `types/trading.ts` | 327 | `Quote`, `Bar`, `Position`, `Trade`, `OrderResult`, `SignalEvent`, `LogEntry`, `Timeframe`, `ExecutionMode` |
| `types/instruments.ts` | — | `InstrumentMetadata`, `MarketSymbol`, `TradingInstrument`, `AssetClass` |
| `types/quotes.ts` | — | `NormalizedQuote` |
| `types/aiContext.ts` | — | `MainTab` `:1`, `RiskState` |
| `types/raw-imports.d.ts` | — | ambient declarations for non-TS assets |

---

## `EventBus` — `types/events.ts:29-73`

| Member | Line |
| --- | --- |
| `private listeners: Map<string, Set<(event: any) => void>>` | `:30` |
| `on(type, listener): () => void` | `:32-43` |
| `emit(event): void` | `:45-62` |
| `onAll(listener): () => void` | `:64-72` |
| `eventBus` | `:75` |

**Behaviour**
- `on` returns an unsubscribe closure `:40-42`; `onAll` the same `:69-71`.
- Typed listeners run inside `try/catch` `:48-53`; **wildcard `'*'` listeners do
  not** `:60`.
- A missing key is a silent no-op in `emit` `:47`.

**22 event types** — `types/events.ts:3-25`: `AGENT_STARTED`, `AGENT_STOPPED`,
`AGENT_OBSERVED`, `AGENT_REASONING`, `AGENT_TOOL_REQUESTED`, `AGENT_TOOL_RESULT`,
`AGENT_DECISION`, `AGENT_ACTION_APPROVED`, `AGENT_ACTION_REJECTED`,
`AGENT_ORDER_SUBMITTED`, `AGENT_ORDER_FILLED`, `AGENT_ERROR`, `MARKET_QUOTE`,
`BAR_UPDATE`, `SIGNAL`, `ORDER`, `POSITION_OPEN`, `POSITION_UPDATE`, `POSITION_CLOSE`,
`LOG`, `RISK_VIOLATION`, `STATUS_CHANGE`.

**Producers** — `adapters/hyperliquid/marketData.ts:1`, `adapters/hyperliquid/demo.ts:1`,
`engine/agents/runtime.ts`, `engine/agents/triggers/engine.ts`,
`engine/execution/risk.ts`, `App.tsx`.

**Subscribers** — `App.tsx:516, 813, 817, 821`; `TriggerEngine` `engine.ts:78`
(`onAll`); `AgentRuntime` `runtime.ts:60, 71` (constructor, **no teardown captured**).

---

## `marketDataService` — `services/marketData.ts:79`

| Member | Line | Written by | Read by |
| --- | --- | --- | --- |
| `setSymbols(symbols)` | `:35` | `App.tsx:436` | — |
| `getSymbol(symbol)` | `:40` | — | `App.tsx:1636` (backtest pip/lot lookup) |
| `findSymbol(symbol)` | `:50` | — | — |
| `getAllSymbols()` | `:54` | — | — |
| `updateLastPrice(symbol, lastPrice)` | `:65` | `App.tsx:624` (every quote tick) | — |
| `timeframeToSeconds(tf)` | `:16` | — | — |

`SUPPORTED_SYMBOLS` `:14` is an empty array — the symbol set comes from discovery,
not from a static list.

---

## `ThemeProvider` / theme

| Element | Location |
| --- | --- |
| Pre-paint application | `main.tsx:14-25` → `applyThemeAttribute(resolveInitialTheme(localStorage, prefersDark))` |
| `THEME_STORAGE_KEY = 'tradingvibe_theme'` | `services/theme/theme.ts:21` |
| `resolveInitialTheme(storage, prefersDark)` | called `main.tsx:16` |
| `applyThemeAttribute(theme)` | `main.tsx:14` — writes a DOM attribute on `document.documentElement` |
| `ThemeProvider` | `main.tsx:30` |
| `chartTheme` | `services/theme/chartTheme.ts` → `TradingChart` |

**Resolution order (from the code):** an explicit stored choice wins over the OS
preference; the OS preference is read from
`matchMedia('(prefers-color-scheme: dark)').matches` `main.tsx:19`.

---

## `WalletProvider` / wallet

`WalletProvider` is mounted once at the root — `main.tsx:36` — and renders a
disconnected root instead of mounting Privy when no application id is configured
(`WalletProvider.tsx:35-37`).

```
WalletContext                             WalletProvider.tsx:51
ConnectedWalletBridge                     WalletProvider.tsx:102-140
   ├─ mapWalletState(...)                 WalletProvider.tsx:88-100
   ├─ service.connect()   → privy.connectOrCreateWallet()      :109
   ├─ service.disconnect()→ primary.disconnect() + privy.logout()  :119-120
   └─ connecting / error state            :108, 110-112, 113
```

Consumers use `useWallet()` — `MobileHeader.tsx:56`, `WalletCard.tsx:18`. No other
module imports the Privy SDK (repo-wide grep).

**Isolation (CONFIRMED)** — the AI context's `getWalletState()`
(`services/aiContext/tools.ts:157-160`) reads only the published projection, and
`App.tsx:1996` hard-codes `liveExecutionEnabled: false`. The wallet does not change
the trading mode; `handleModeSelect` (`App.tsx:1822-1839`) is the only writer of
`executionMode`, and `WalletCard.tsx:99-103` states this explicitly in the UI.

---

## `userService`

`STORAGE_KEY = 'tradingvibe_user_profile'` `:25` · `getCurrentUser()` read at
`App.tsx:487` · written by `ProfileView.handleSave` `ProfileView.tsx:46` →
`App.setUser` `App.tsx:2248-2254`.

---

## `config/env.ts`

The single place a client-visible environment value is read. `readPublicEnv(key)`
`:15-19` only ever touches `import.meta.env` and trims, returning `undefined` for
an empty string.

| Variable | Function | Line | Read by |
| --- | --- | --- | --- |
| `VITE_PRIVY_APP_ID` | `privyAppId()` | `:22-24` | `privyConfig.ts` |
| `VITE_PRIVY_CLIENT_ID` | `privyClientId()` | `:27-29` | `privyConfig.ts` |
| `VITE_PRIVY_API_URL` | `privyApiUrl()` | `:32-34` | `privyConfig.ts` |
| `VITE_PRIVY_LOGIN_METHODS` | `privyLoginMethods()` | `:37-39` | `privyConfig.ts` |
| `VITE_HYPERLIQUID_NETWORK` | `hyperliquidNetwork()` | `:43-47` | `adapters/hyperliquid/marketData.ts:4` |
| `VITE_APP_URL` | `appUrl()` | `:57-62` | self-referential links |
| `VITE_OPENROUTER_API_KEY` | `openRouterApiKey()` | `:70-72` | `adapters/openrouter` |

`SERVER_ONLY_ENVIRONMENT_VARIABLES` `:124-156` names seven variables that must never
carry a `VITE_` prefix. **No value is read for any of them anywhere in `src/`.**

`VITE_TRADINGV_ENGINE_URL` is documented in `.env.example` but has **no reader** in
`config/env.ts`; the engine base URL is hard-coded at
`engine/conditions/engineClient.ts:129`.

---

## Utils

| Function | Location | Consumer |
| --- | --- | --- |
| `validateOrderSize` | `utils/orderSize.ts:92` | `adapters/hyperliquid/demo.ts:22`; `TradeOrderModal.tsx:123` |
| `lotsToInstrumentUnits` | `utils/orderSize.ts` | `TradeOrderModal.tsx:109-121` |
| `snapOrderSize` | `utils/orderSize.ts` | `TradeOrderModal.tsx:109-121` |
| position sizing | `utils/positionSize.ts` | `capabilities/risk.ts:13-200`; the backtest path |
| CSV serialisation | `utils/csvExport.ts` | `HistoryTab` export |

All are pure functions — no state, no I/O.

---

## Depends on

`types/events.ts` and `types/*` are the base layer: nearly every module imports from
them. `config/env.ts` depends on nothing. `services/marketData.ts` depends on
`types/instruments.ts`. `WalletProvider` depends on `@privy-io/react-auth` and
`config/env.ts`.

## Used by

| Consumer | Line |
| --- | --- |
| `eventBus` | 6 production files (see [Reverse Deps §1](../reverse-dependencies.md)) |
| `marketDataService` | `App.tsx:436, 624, 1636`; `capabilities/instruments.ts`; `agents/backtest.ts` |
| `ThemeProvider` | `main.tsx:30`; `TradingChart` (via `chartTheme`) |
| `WalletProvider` | `main.tsx:36`; `MobileHeader`; `WalletCard` |
| `userService` | `App.tsx:487`; `ProfileView` |
| `config/env.ts` | `privyConfig.ts`; `adapters/hyperliquid/marketData.ts:4` |
| `utils/orderSize.ts` | `adapters/hyperliquid/demo.ts:22`; `TradeOrderModal.tsx:123` |
| `types/*` | nearly every module |

## Reads

`localStorage` (`tradingvibe_theme`, `tradingvibe_user_profile`) ·
`import.meta.env` (`VITE_*`) · `matchMedia('(prefers-color-scheme: dark)')` ·
`document.documentElement` · the Privy SDK state.

## Writes

| Target | Line |
| --- | --- |
| `localStorage` theme | `services/theme/theme.ts` (`THEME_STORAGE_KEY` `:21`) |
| `localStorage` profile | `services/userService.ts:25` |
| `eventBus.listeners` | `types/events.ts:37, 39, 66, 68` |
| `MarketDataService` symbols + last prices | `services/marketData.ts:35, 65` |
| `document.documentElement` attribute | `applyThemeAttribute` — `main.tsx:14` |
| `WalletContext` value | `WalletProvider.tsx:102-140` |

## Mutates

See [State Owners §2](../state-owners.md).

## Emits

`eventBus` is an emitter only by virtue of the modules that call `emit` on it; the
`EventBus` class itself only dispatches.

## Subscribes to

`EventBus.on` / `onAll` registrations from `App`, `TriggerEngine`, `AgentRuntime`.

## External dependencies

| Package / API | Where | Purpose |
| --- | --- | --- |
| `@privy-io/react-auth` | `WalletProvider.tsx` only | wallet identity |
| `localStorage` | `theme.ts`, `userService.ts`, `provider.ts` | persistence |
| `matchMedia` | `main.tsx:19` | initial theme |
| `document` | `main.tsx:27`, `theme.ts` | mount point, theme attribute |
| `structuredClone` | — | used by other modules, not here |
| `VITE_*` env vars | `config/env.ts:22-72` | names only, no values |

## Entry points

`eventBus` `types/events.ts:75` · `marketDataService` `services/marketData.ts:79` ·
`userService.getCurrentUser` · `ThemeProvider` `main.tsx:30` · `WalletProvider`
`main.tsx:36` · `resolveInitialTheme` / `applyThemeAttribute` `main.tsx:14-25` ·
`validateOrderSize` `utils/orderSize.ts:92` · `readPublicEnv` `config/env.ts:15`.

## Exit points

- `eventBus.emit` — dispatched to the registered listeners.
- `localStorage` writes.
- DOM attribute writes for the theme.
- HTTP to Hyperliquid, driven by `hyperliquidNetwork()`.

---

## Notable observations (factual)

- **`eventBus` is the only pub/sub primitive**; there is no `EventTarget`, no
  `BroadcastChannel`, and no external state library.
- **`SERVER_ONLY_ENVIRONMENT_VARIABLES` (`config/env.ts:124-156`) is a declaration
  only** — no reader exists for any of the seven names in `src/`.
- **`VITE_TRADINGV_ENGINE_URL` has no reader** despite being in `.env.example`.
- **Two `eventBus` subscriptions in `AgentRuntime` have no teardown**
  (`runtime.ts:60-77`).
- **`App.logs` is never written** although six `LOG` emissions exist — the intended
  consumer `BottomPanel` is not rendered.
- `MarketDataService` has no reset method; `setSymbols` is the only way to change the
  symbol set.
