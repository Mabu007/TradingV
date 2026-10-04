# External Dependencies

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

Everything the application reaches outside its own source: npm packages, Python
packages, network endpoints, environment variables, and platform APIs.

**No secret values appear in this document.** Environment variables are referenced by
name only.

---

## 1. npm packages — root (`package.json`)

### Runtime dependencies

| Package | Version | Used by | Purpose | Important imported symbols |
| --- | --- | --- | --- | --- |
| `react` | `^19.0.1` | every `.tsx` | UI runtime | `StrictMode`, `useState`, `useEffect`, `useMemo`, `useRef`, `createContext`, `useContext` |
| `react-dom` | `^19.0.1` | `src/main.tsx:2` | React DOM renderer | `createRoot` |
| `@monaco-editor/react` | `^4.7.0` | `components/editor/MonacoStrategyEditor.tsx` | code editor for strategies | `Editor`, `loader` |
| `lightweight-charts` | `^5.2.1` | `components/chart/TradingChart.tsx` | candlestick chart | `createChart`, `addCandlestickSeries`, series/timeframe APIs |
| `lucide-react` | `^0.546.0` | many components | icon set | icon components |
| `motion` | `^12.23.24` | UI animation | animation primitives | — |
| `@privy-io/react-auth` | `^3.46.0` | `services/wallet/WalletProvider.tsx` **only** | wallet + auth infrastructure | `PrivyProvider`, `usePrivy`, `useWallets` |
| `@google/genai` | `^2.4.0` | declared; grep shows no import in `src/` | Gemini SDK | — |
| `dotenv` | `^17.2.3` | declared; not imported in `src/` | env loading | — |
| `@tailwindcss/vite` | `^4.3.3` | `vite.config.ts:1` | Tailwind v4 Vite plugin | `tailwindcss()` |
| `@vitejs/plugin-react` | `^6.1.1` | `vite.config.ts:2` | React refresh / JSX | `react()` |
| `vite` | `^8.3.0` | `vite.config.ts:4`, `package.json` scripts | build + dev server | `defineConfig` |

### Dev dependencies

| Package | Version | Purpose |
| --- | --- | --- |
| `typescript` | `^7.0.2` | `tsc --noEmit` (`lint` script) |
| `@types/node`, `@types/react`, `@types/react-dom` | `^22.14.0` / `^19.3.0` | ambient types |
| `tailwindcss` | `^4.3.3` | utility CSS |
| `autoprefixer` | `^10.4.21` | vendor prefixes |
| `esbuild` | `^0.25.0` | bundler (via Vite) |
| `tsx` | `^4.21.0` | TS execution helper |

### Package manager

`bun.lock` present; scripts use `bun`. `packageManager` is not pinned in
`package.json`.

**Observed (CONFIRMED)** — `@google/genai` and `dotenv` are declared as runtime
dependencies but no import of either exists anywhere in `src/`
(repo-wide grep for `@google/genai` and `dotenv` returns no source import).

---

## 2. Python packages — `server/pyproject.toml`

| Package | Purpose | Used by |
| --- | --- | --- |
| `fastapi` | HTTP framework | `api.py:24` — `FastAPI`, `HTTPException`, `Query`, `Request`, `Response` |
| `uvicorn` | ASGI server | `__main__.py:86`, `api.py:424` |
| `pydantic` | request/response models | `api.py:26` — `BaseModel`, `Field`; `model_config` aliasing at `:89, :105, :129` |
| `numpy` | array math throughout | `series.py:20`, `indicators/engine.py:23`, `evaluator.py:41`, `patterns.py:50`, `price_action.py:14`, `marketdata.py:26` |
| `pandas` | rolling windows, DataFrames | `indicators/engine.py:510` (local import), `price_action.py:229, 235, 241, 247` (local), `series.py:21` |
| `ta` | technical-analysis library | `indicators/engine.py:24` — `ta.trend.{EMA,MACD,ADX,PSAR}`, `ta.momentum.{RSI,StochasticOscillator,WilliamsR,ROC}`, `ta.volatility.{AverageTrueRange,BollingerBands}` |
| `jsonschema` | schema validation | `contract.py:27` — `Draft202012Validator` |

Transitive (present in `server/.venv`, not directly imported):
`starlette`, `pydantic_core`, `httptools`, `uvloop`, `watchfiles`, `websockets`,
`python-dotenv`, `typing_extensions`, `anyio`, `idna`, `sniffio`, `certifi`,
`click`, `h11`.

Test-only: `pytest` 8.4.2, `pytest` plugins.

**Network egress is stdlib-only** — `urllib.request` (`marketdata.py:19`). No
`requests`, `httpx`, or `aiohttp` is imported.

---

## 3. Worker — `watchers/package.json`

**No runtime dependencies at all.** Dev dependencies only:

| Package | Version | Purpose |
| --- | --- | --- |
| `wrangler` | `^3.99.0` | dev / deploy CLI |
| `vitest` | `^3.2.7` | test runner |
| `@cloudflare/vitest-pool-workers` | `^0.8.19` | `workerd` test pool |
| `@cloudflare/workers-types` | `^4.20250109.0` | ambient Worker types |
| `typescript` | `^5.7.2` | `tsc --noEmit` |

The only non-relative import in `watchers/src` is `cloudflare:workers`
(`index.ts:27`, `durable-object.ts:23`).

---

## 4. Network endpoints

### From the browser (`src/`)

| Endpoint | Method | Where | Purpose |
| --- | --- | --- | --- |
| `https://api.hyperliquid.xyz/info` | POST | `marketData.ts:54-55` | instrument discovery, candles, order book |
| `https://api.hyperliquid-testnet.xyz/info` | POST | `marketData.ts:55, 75, 82` | testnet equivalent, selected by `hyperliquidNetwork()` |
| `wss://api.hyperliquid.xyz/ws` | WSS | `marketData.ts:75, 82, 180` | realtime quotes + bars |
| `wss://api.hyperliquid-testnet.xyz/ws` | WSS | same | testnet equivalent |
| `https://openrouter.ai/api/v1/chat/completions` | POST | `openrouter/provider.ts:194` | agent reasoning + AI copilot chat |
| `http://127.0.0.1:8099/*` | GET/POST/DELETE | `engineClient.ts:137` (base from `:129`) | Python condition engine |

Network selection: `hyperliquidNetwork()` reads `VITE_HYPERLIQUID_NETWORK`
(`config/env.ts:43-47`); `App.tsx:2802-2811` can switch it at runtime via
`hyperliquidMarketData.setNetwork`.

### From the Python engine

| Endpoint | Method | Where | Purpose |
| --- | --- | --- | --- |
| `https://api.hyperliquid.xyz/info` | POST | `marketdata.py:140` via `config.resolved_api_url()` | `{type:'perpDexs'}`, `{type:'metaAndAssetCtxs'}`, `{type:'candleSnapshot'}` |
| `https://api.hyperliquid-testnet.xyz/info` | POST | `config.py:104-107` | when `network == 'testnet'` |

Bind address: `127.0.0.1:8099` by default (`config.py:89-90`). Non-loopback binds are
refused unless `TRADINGV_ENGINE_ALLOW_PUBLIC` is set (`config.py:153`, enforced at
`__main__.py:63` → `config.py:144-161`).

### From the worker

| Endpoint | Method | Where | Purpose |
| --- | --- | --- | --- |
| `{ENGINE_URL}/evaluate` | POST | `watchers/src/evaluator.ts:66` | condition evaluation; `ENGINE_URL = http://127.0.0.1:8099` (`wrangler.toml:23`) |

Timeout: 8 000 ms via `AbortController` (`evaluator.ts:44, :62-63`).

### Ingested (not egress)

| Endpoint | Where | Authentication |
| --- | --- | --- |
| `POST /feed` | `watchers/src/index.ts:147` | `X-Feed-Token` header, constant-time compare at `:155-158` (`constantTimeEquals` `:501-508`) |
| All other worker routes | `index.ts:88-141` | `Authorization` bearer token → `userId` (`index.ts:301`, `isOwnedBy` `contract.ts:53-55`) |

### Not present (verified absent)

- No Hyperliquid **private** / exchange / signing endpoint. The DEMO adapter
  (`src/adapters/hyperliquid/demo.ts`) has no network write path.
- No analytics, telemetry, error-reporting, or logging endpoint from `src/`.
- No database connection string in any of the three runtimes. Persistence is
  `localStorage` (browser) and Durable Object KV (worker); the Python engine is
  entirely in-memory.

---

## 5. Environment variables

### Browser-visible — `src/config/env.ts`

All read through `readPublicEnv()` (`env.ts:15-19`), which only ever touches
`import.meta.env`. Read functions:

| Variable | Read by | Function | Required |
| --- | --- | --- | --- |
| `VITE_PRIVY_APP_ID` | `services/wallet/privyConfig.ts` | `privyAppId()` `env.ts:22-24` | yes |
| `VITE_PRIVY_CLIENT_ID` | `privyConfig.ts` | `privyClientId()` `env.ts:27-29` | no |
| `VITE_PRIVY_API_URL` | `privyConfig.ts` | `privyApiUrl()` `env.ts:32-34` | no |
| `VITE_PRIVY_LOGIN_METHODS` | `privyConfig.ts` | `privyLoginMethods()` `env.ts:37-39` | no |
| `VITE_HYPERLIQUID_NETWORK` | `adapters/hyperliquid/marketData.ts:4` | `hyperliquidNetwork()` `env.ts:43-47` | no (defaults `mainnet`) |
| `VITE_APP_URL` | self-referential links | `appUrl()` `env.ts:57-62` | no |
| `VITE_OPENROUTER_API_KEY` | `adapters/openrouter` | `openRouterApiKey()` `env.ts:70-72` | no (prefer a key entered in Settings) |
| `VITE_TRADINGV_ENGINE_URL` | declared in `.env.example`; not read by `src/config/env.ts` | — | — |

The declared inventory is `PUBLIC_ENVIRONMENT_VARIABLES` (`env.ts:78-118`), used by
the configuration test to keep `.env.example` honest.

### Server-only names (must never carry a `VITE_` prefix)

Declared at `env.ts:124-156` and documented in `.env.example`. **Names only, no
values are recorded here.**

| Name | Declared purpose | Read anywhere in `src/`? |
| --- | --- | --- |
| `PRIVY_SECRET_KEY` | `env.ts:129-131` | no |
| `PRIVY_VERIFICATION_KEY` | `env.ts:132-135` | no |
| `PRIVY_AUTH_SECRET` | `env.ts:136-139` | no |
| `HYPERLIQUID_API_WALLET` | `env.ts:140-143` | no |
| `HYPERLIQUID_PRIVATE_KEY` | `env.ts:144-147` | no |
| `HYPERLIQUID_WALLET_SECRET` | `env.ts:148-151` | no |
| `OPENROUTER_API_KEY` | `env.ts:152-155` | no |

### Python engine — `server/tradingv_engine/config.py`

Read at `EngineConfig` construction (`config.py:70-108`), which happens inside
`load_config()` (`config.py:111-112`).

| Variable | Field | Default | Line |
| --- | --- | --- | --- |
| `TRADINGV_NETWORK` | `network` | `mainnet` | `config.py:75` |
| `TRADINGV_HYPERLIQUID_API` | `api_url` | `https://api.hyperliquid.xyz/info` | `config.py:76-81` |
| `TRADINGV_HTTP_TIMEOUT` | `request_timeout_s` | `10.0` | `config.py:82` |
| `TRADINGV_POLL_INTERVAL` | `poll_interval_s` | `20.0` | `config.py:83` |
| `TRADINGV_HISTORY` | `history` | `1500` | `config.py:86` |
| `TRADINGV_ENGINE_HOST` | `host` | `127.0.0.1` | `config.py:89` |
| `TRADINGV_ENGINE_PORT` | `port` | `8099` | `config.py:90` |
| `TRADINGV_LIVE_TRADING` | `live_trading_enabled` | `False` | `config.py:94-96` |
| `TRADINGV_HYPERLIQUID_API_TESTNET` | `resolved_api_url()` (call time, testnet only) | `https://api.hyperliquid-testnet.xyz/info` | `config.py:104-107` |
| `TRADINGV_ENGINE_ALLOW_PUBLIC` | `assert_local_only` | unset | `config.py:153` |
| `TRADINGV_ALLOWED_ORIGINS` | CORS allow-list (`api.py:50`) | `http://localhost:3000,http://127.0.0.1:3000` | `api.py:42, :50-51` |

### Worker — `watchers/wrangler.toml` and `Env`

| Name | Kind | Declared at | Default / note |
| --- | --- | --- | --- |
| `ENGINE_URL` | var (plain) | `wrangler.toml:23` | `http://127.0.0.1:8099` |
| `ALLOWED_ORIGINS` | var (plain) | `wrangler.toml:25` | `http://localhost:3000` |
| `AUTH_TOKEN` | **secret** | `wrangler.toml:14`; `Env` `index.ts:69` | optional on the type; without it all non-feed traffic is refused |
| `MARKET_FEED_TOKEN` | **secret** | `wrangler.toml:15`; `Env` `index.ts:60` | optional on the type; without it `POST /feed` returns 503 `FEED_DISABLED` |
| `DISABLE_HMR` | env | `vite.config.ts:17, 19` | toggles HMR and file watching |

Durable Object bindings (`wrangler.toml:31-47`): `WATCHERS`, `REGISTRY`,
`MARKET_INDEX`, `RATE_LIMITS`. `wrangler.toml:49-51` — migration tag `v1`,
`new_classes` = all four.

Test seams on `Env` (not in `wrangler.toml`, so production never uses them):
`now?` (`durable-object.ts:52`), `evaluator?` (`:53`), `queueOptions?` (`:54`),
`healthThresholds?` (`:55`).

### Non-secret user-persisted browser values

| Key | Written | Read |
| --- | --- | --- |
| `tradingvibe_theme` | `services/theme/theme.ts` (`THEME_STORAGE_KEY` `:21`) | `main.tsx:16`, `ThemeProvider` |
| `tradingvibe_openrouter_config` | `openrouter/provider.ts:131` | `provider.ts:105` |
| `tradingvibe_user_profile` | `services/userService.ts:25` | `App.tsx:487` |

---

## 6. Platform and browser APIs

| API | Where | Purpose |
| --- | --- | --- |
| `WebSocket` | `adapters/hyperliquid/marketData.ts:180` | Hyperliquid realtime feed |
| `fetch` | `marketData.ts:54, 195, 213`; `provider.ts:194`; `engineClient.ts:148` (`doFetch`) | HTTP |
| `AbortController` | `engineClient.ts:145`; `evaluator.ts:62` | request timeouts |
| `setTimeout` | `engineClient.ts:145`; `evaluator.ts:63` | request timeouts |
| `localStorage` | `provider.ts:105, 131`; `userService.ts`; `theme.ts`; `main.tsx:16` | persistence |
| `matchMedia('(prefers-color-scheme: dark)')` | `main.tsx:19` | initial theme |
| `document.documentElement` (attribute write) | `services/theme/theme.ts` `applyThemeAttribute` | pre-paint theme |
| `document.getElementById('root')` | `main.tsx:27` | React mount |
| `structuredClone` | `botDefinition.ts:662`; `triggers/registry.ts:183` | deep copy of definitions/triggers |
| `Intl.DateTimeFormat` | `triggers/registry.ts:192-194` | timezone validation for `SCHEDULED` triggers |
| `crypto`/`TextEncoder` | not used in app code | — |
| `new Function` | `sandbox/sandboxEnv.ts:71` | strategy sandbox (test-only consumer) |
| `URL.createObjectURL` / Worker blob | `sandbox/sandboxEnv.ts:81` `createWorkerBlobScript` | strategy sandbox (test-only consumer) |
| `asyncio.create_task` | `engine.py:253` | poll loop |
| `asyncio.to_thread` | `engine.py:279` | off-loop tick |
| `asyncio.wait_for` | `engine.py:286` | interruptible sleep |
| `asyncio.Event` | `engine.py:90, 251, 259` | stop signal |
| `urllib.request.urlopen` | `marketdata.py:146` | only egress mechanism in Python |
| `functools.lru_cache` | `contract.py:43, 49` | schema/validator memoization |
| `ctx.blockConcurrencyWhile` | `durable-object.ts:95` | DO state initialisation |
| `ctx.storage.get/put` | `durable-object.ts:121-125, 212-215` | DO persistence |
| `DurableObjectNamespace.idFromName` | `index.ts:221, 250, 261, 427, 106`; `durable-object.ts:145` | deterministic DO addressing |
| `globalThis.fetch.bind(globalThis)` | `evaluator.ts:56-57`; `engineClient.ts:138` | explicit binding (commented) |

---

## 7. Data-file dependencies (non-code)

| File | Read by | Mechanism |
| --- | --- | --- |
| `shared/condition_schema_v1.json` | `server/tradingv_engine/contract.py:34, 43` | `lru_cache`d `load_schema()` |
| `shared/condition_examples.json` | `src/engine/conditions/conditionParity.ts`; `server/tests/test_contract.py` | JSON read |
| `server/tests/fixtures/*.json` (6 files) | `engine.py:346-409` `_load_fixture_contexts()` | path `server/tests/fixtures/{name}.json`; served by `GET /fixtures` `api.py:329` |
| `index.html` | Vite | `#root` element, module script tag |
| `src/index.css` | `src/main.tsx:8` | Tailwind import |
| `metadata.json` | tooling metadata | not imported by any source file |

---

## 8. External dependency graph

```mermaid
flowchart TD
    APP["Browser app<br/>src/"]

    APP -->|fetch POST| HL["Hyperliquid /info<br/>mainnet + testnet"]
    APP -->|WebSocket| HLWS["Hyperliquid /ws<br/>mainnet + testnet"]
    APP -->|fetch POST| OR["OpenRouter<br/>/chat/completions"]
    APP -->|SDK| PRIVY["Privy<br/>@privy-io/react-auth"]
    APP -->|fetch| ENG["Python engine<br/>127.0.0.1:8099"]

    ENG -->|urllib POST| HL
    ENG -->|reads| SCHEMA["shared/<br/>condition_schema_v1.json"]
    ENG -->|reads| FIX["server/tests/fixtures/"]

    WORKER["Worker<br/>watchers/"]
    WORKER -->|fetch POST| ENG
    WORKER -->|DO KV| DOKV["Durable Object storage"]
    WORKER -->|RPC| DOG["4 Durable Object classes"]

    EXT["External market-feed producer<br/>(not in this repo)"] -->|POST /feed + X-Feed-Token| WORKER
    WORKER -->|pull: GET /watchers/:id/wakes| AGENT["External wake consumer<br/>(not in this repo)"]

    APP -.->|condEngine()| SCHEMA
```

`INFERRED`: the feed producer and the wake consumer are outside this repository.
`POST /feed` and `GET /watchers/{id}/wakes` have no in-repo producer or consumer, and
`wrangler.toml` declares no queue producers or consumers.
