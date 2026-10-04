# Chain: Application Startup

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the browser loads `index.html` and executes the module script.

**Confidence:** CONFIRMED for every step (module-load order is deterministic under ESM).

---

```
index.html:17-18
   <div id="root"></div>
   <script type="module" src="/src/main.tsx"></script>
```

## Stage 1 — pre-paint theme

| | |
| --- | --- |
| **Input** | `localStorage` and `matchMedia('(prefers-color-scheme: dark)').matches` |
| **Action** | `applyThemeAttribute(resolveInitialTheme(localStorage, prefersDark))` — `src/main.tsx:14-25` |
| **Calls** | `resolveInitialTheme` — `src/services/theme/theme.ts` |
| **Output** | a `data-*`/`class` attribute written to `document.documentElement` before the first paint |
| **Mutation** | DOM attribute (not React state) |
| **Next** | `createRoot` |
| **Evidence** | `src/main.tsx:14-25`; `THEME_STORAGE_KEY` at `services/theme/theme.ts:21` |

Both browser globals are guarded: `typeof localStorage === 'undefined' ? null : localStorage`
(`main.tsx:16`) and a `try/catch` around `matchMedia` (`main.tsx:18-23`).

## Stage 2 — provider mounting

| | |
| --- | --- |
| **Input** | `#root` element |
| **Action** | `createRoot(document.getElementById('root')!).render(...)` — `src/main.tsx:27-42` |
| **Output** | the React tree |
| **Mutation** | React root created |

Provider order, outermost first:

```
StrictMode                       react
└─ ErrorBoundary                 src/components/layout/ErrorBoundary.tsx
   └─ ThemeProvider              src/services/theme/ThemeProvider.tsx
      └─ WalletProvider          src/services/wallet/WalletProvider.tsx
         └─ App                  src/App.tsx:2084
```

Both providers are conditionally *internally* rather than conditionally mounted:
`WalletProvider` renders a disconnected root instead of mounting Privy when no app id
is configured (`src/services/wallet/WalletProvider.tsx:35-37`).

## Stage 3 — module-level singleton construction

This happens at **import time of `App.tsx`**, before the first render body executes.

| Statement | Location | Creates |
| --- | --- | --- |
| `new TriggerRegistry(id => agentRuntime.getAgent(id))` | `src/App.tsx:99-101` | the single `TriggerRegistry` instance |
| `new TriggerEngine(triggerRegistry, agentRuntime, agentRuntime.getTimelineStore())` | `src/App.tsx:103-107` | the single `TriggerEngine` instance |
| `triggerEngine.setEnvironment('DEMO')` | `src/App.tsx:109` | sets `sourceEnvironment` — `engine.ts:139` |

`agentRuntime` itself is a module singleton created when
`src/engine/agents/runtime.ts` is imported — `runtime.ts:1781-1782`:

```ts
export const agentRuntime = new AgentRuntime(
  undefined, undefined, undefined, undefined,
  new PersistentAgentTimelineStore()
);
```

**Consequence (CONFIRMED)** — a module-load side effect registers two `eventBus`
listeners from the `AgentRuntime` constructor (`runtime.ts:60-77`) for `POSITION_UPDATE`
and `POSITION_CLOSE`. The unsubscribe closures returned by `eventBus.on` are not
captured, so there is no teardown path.

## Stage 4 — the nine mount effects

Effects run in declaration order after the first render.

| # | Line | Trigger | What it starts |
| --- | --- | --- | --- |
| 1 | `App.tsx:399-409` | mount (once) | `ensureTriggerEngineStarted()` → `triggerEngine.start()` → `eventBus.onAll` `engine.ts:78` |
| 2 | `App.tsx:416-477` | mount | `hyperliquidMarketData.getInstruments()` `:419`; on success `setInstruments` `:426` + `marketDataService.setSymbols` `:436` |
| 3 | `App.tsx:484-526` | mount | `userService.getCurrentUser()` `:487`; `onStatusChange` `:514`; `.connect()` `:520` |
| 4 | `App.tsx:533-577` | `[symbol, timeframe]` | `getBars(symbol, timeframe, 260)` `:541` |
| 5 | `App.tsx:604-650` | `[subscribedInstrumentIds]` | `subscribeQuote()` per instrument `:611` |
| 6 | `App.tsx:666-707` | `[symbol]` | `getQuote(symbol)` `:673` |
| 7 | `App.tsx:714-756` | `[symbol, timeframe]` | `subscribeBars()` `:720` |
| 8 | `App.tsx:793-842` | mount | `refreshFromAdapter()` `:794` + 3 `eventBus.on` subscriptions `:811, :815, :819` |
| 9 | `App.tsx:1852-2002` | 18 state deps | `appContextStore.publish(...)` `:1853` |

**Ordering dependency (CONFIRMED)** — effect #5 is gated on
`subscribedInstrumentIds` (`App.tsx:596-602`), a `useMemo` derived from `instruments`.
So the quote subscriptions are established only after effect #2 has resolved discovery.

**Cleanup contract**

| Effect | Cleanup | Location |
| --- | --- | --- |
| 1 | none — an empty closure with an explicit comment; the engine is module-level and deliberately not disposed | `App.tsx:402-408` |
| 2 | `cancelled = true` | `:475` |
| 3 | `cancelled = true` + `unsubscribeStatus()` | `:523-524` |
| 4 | `cancelled = true` | `:575` |
| 5 | `unsubscribers.forEach(u => u())`; **no cleanup registered when `instruments.length === 0`** (early return at `:605`) | `:645-648` |
| 6 | `cancelled = true` | `:705` |
| 7 | `unsubscribeBars()` | `:754` |
| 8 | `unsubscribers.forEach(u => u())` | `:837-840` |
| 9 | none | — |

## Stage 5 — view render

The `<main>` element is a first-match-wins ternary chain (`App.tsx:2234-2641`):

| Order | Condition | Renders | Line |
| --- | --- | --- | --- |
| 1 | `showProfileView` | `<ProfileView/>` | `:2240-2255` |
| 2 | `showDocsView` | `<DocsView/>` | `:2257-2279` |
| 3 | `currentTab === 'trades'` | `<TradesTab/>` | `:2281-2352` |
| 4 | `currentTab === 'quotes'` | `<QuotesTab/>` | `:2354-2428` |
| 5 | `currentTab === 'bots'` | `<BotsTab/>` | `:2430-2544` |
| 6 | `currentTab === 'history'` | `<HistoryTab/>` | `:2546-2571` |
| 7 | else | `<SettingsTab/>` | `:2573-2641` |

Always mounted alongside: `<BottomNav/>` `:2101`, `<MobileHeader/>` `:2180`,
`<FloatingAIAssistant/>` `:2650`, `<TriggerBuilderPanel/>` `:2729`, and four modals
(`:2793`, `:2825`, `:2856`, `:2903`) which self-gate on their `isOpen` prop.

## Initial state at the end of startup

| State | Value | Source |
| --- | --- | --- |
| `currentTab` | `'trades'` | `App.tsx:168-169` |
| `symbol` | `''` then the first discovered market | `:171-172`, `:443-452` |
| `instruments` | `[]` then the discovery result | `:174-175`, `:426` |
| `timeframe` | `'5m'` | `:177-178` |
| `executionMode` | `'DEMO'` | `:180-181` |
| `connectionStatus` | `'CONNECTING'` | `:319-320` |
| `balance` / `margin` / `freeMargin` | `0` until effect #8 mirrors the adapter | `:194-207`, `:804-806` |
| `positions` / `trades` / `bars` / `quotes` | empty | `:209-237` |
| `bots` / `botDefinitions` / `labTriggers` | empty | `:253-257`, `:352-353` |
| `strategies` | `SAMPLE_STRATEGIES` | `:244-245` |
| `isKillSwitchActive` | `riskManager.isKillSwitchActive()` at mount | `:296-297` |
| `openRouterConfig` | `openRouterProvider.getConfig()` (from `localStorage`) | `:337-340` |

## Exit points of this chain

- `hyperliquidMarketData` opens a WebSocket (`marketData.ts:180`) — the first
  long-lived external connection.
- Two HTTPS calls to Hyperliquid (discovery `:54`, candles `:213`).
- `appContextStore` now holds a snapshot, so the AI copilot's tools are answerable
  before the first user message.

## Failure paths

| Failure | Observable result | Evidence |
| --- | --- | --- |
| Discovery throws | `eventBus.emit({type:'LOG', …'market-discovery-error'})`; `instruments` stays `[]`; effect #5 never subscribes | `App.tsx:460-471`, `:605` |
| Bars fetch throws | `setBars([])` with an explicit "no synthetic fallback"; a `LOG` emit | `App.tsx:558-571` |
| Quote fetch throws | `LOG` emit only; `quotes` unchanged | `App.tsx:690` |
| A listener throws inside `emit` | caught and logged for typed listeners (`types/events.ts:49-53`); **not** caught on the `'*'` channel (`:60`), where `TriggerEngine`'s handler is registered | `types/events.ts:60` |
