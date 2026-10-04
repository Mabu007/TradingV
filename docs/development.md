# Development & Workflow Guide

This document provides developer instructions for running, debugging, testing, and building **TradingGOATs**.

---

## 1. Prerequisites

* **Node.js**: v18.0.0 or higher (v20+ recommended).
* **npm**: v9.0.0 or higher.
* Modern web browser with WebSocket and HTML5 Canvas support.

---

## 2. Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Then populate what you need. Full reference in
[environment.md](./environment.md).

* `VITE_PRIVY_APP_ID` (required for wallet sign-in): from the
  [Privy dashboard](https://dashboard.privy.io).
* `VITE_HYPERLIQUID_NETWORK`: `mainnet` (default) or `testnet`.
* `VITE_OPENROUTER_API_KEY`: optional build-time AI key. Public; prefer each
  user entering their own key in Settings.

Never put a private key, seed phrase, or signing secret in a `VITE_` variable:
Vite inlines those into the browser bundle.

### 3. Start Development Server
```bash
npm run dev
```
The application will launch on `http://localhost:3000/`.

---

## 3. Available NPM Scripts

| Command | Action |
|---|---|
| `npm run dev` | Starts Vite development server on port 3000 with hot reload. |
| `npm run build` | Compiles TypeScript and builds production bundles into `dist/`. |
| `npm run lint` | Runs `tsc --noEmit` to validate all TypeScript types and imports. |
| `npm run preview` | Previews the production build locally. |
| `npm run test:agents` | Agent runtime, policy, GOAT definitions, trackers, timelines. |
| `npm run test:execution` | Valuation, exposure, leverage, order sizing. |
| `npm run test:hyperliquid` | Market data → tracker → GOAT wake, execution lifecycle. |
| `npm run test:hyperliquid:execution` | Execution lifecycle against fixed quotes. |
| `npm run test:hyperliquid:discovery:policy` | Availability policy: TRADEABLE vs UNAVAILABLE. |
| `npm run test:hyperliquid:discovery` | Live discovery smoke test. Requires network. |
| `npm run test:wallet` | Privy setup, wallet interface, `.env.example`, `.gitignore`, AI/wallet isolation. |
| `npm run test:theme` | Theme resolution and persistence, design-token coverage, AI application context, navigation actions. |
| `npm run test:conditions` | The canonical condition contract in the browser, and live parity against the Python engine. |
| `npm run test:engine` | The Python condition engine: indicators, patterns, three-state evaluation, edge policy, HTTP surface. |
| `npm run test:pipeline` | Offline acceptance: wake → policy → risk → DEMO fill, and the rejections that must leave no position. |
| `npm run server:setup` | Creates `server/.venv` and installs the condition engine. Run once. |
| `npm run server:start` | Runs the condition engine. Needs a second terminal. |
| `npm run test:audit` | Regression tests for every bug found in the V0 architecture audit. |
| `npm run test:security` | Credential boundary, redaction, authorisation, LIVE isolation. |
| `npm run watcher:test` | The watcher logic, with no Cloudflare runtime required. |
| `npm run watcher:test:runtime` | Durable Object and Worker integration. Needs the Cloudflare runtime. |
| `npm run verify` | `lint` + audit + conditions + engine + pipeline + security + watcher typecheck and tests. Run this before pushing. |

### The watcher tier

The Cloudflare Durable Object watchers have their own toolchain:

```bash
bun run watcher:dev            # local Miniflare, no account needed
bun run watcher:test           # 99 tests, no Cloudflare runtime required
bun run watcher:test:runtime   # Durable Object + Worker integration
bun run watcher:typecheck
```

`watcher:test` and `watcher:test:runtime` are separate on purpose. The
first runs with no Cloudflare runtime, because the decision logic does
not need one. The second needs it. Merging them would mean a runtime
that cannot start is reported as a pass.

Both `AUTH_TOKEN` and `MARKET_FEED_TOKEN` are required and the service
fails closed without them. Copy `watchers/.dev.vars.example` to
`watchers/.dev.vars` and generate fresh values for local work.

### The condition engine

The condition preview needs a local Python service to measure conditions.
Set it up once, then run it alongside the dev server:

```bash
npm run server:setup
npm run server:start     # terminal 2
npm run dev              # terminal 1
```

Without it the builder says the engine is offline and the bot is not
woken. It does not guess, and it does not silently treat an unreachable
condition as satisfied. See [server/README.md](../server/README.md) for
the API, the configuration, and why the engine is not allowed to trade.

---

## 4. Execution Environments

| Environment | Status | Behaviour |
|---|---|---|
| `BACKTEST` | Implemented | Historical Hyperliquid candles, simulated fills, user-configured cost parameters |
| `DEMO` | Implemented | Live Hyperliquid quotes, simulated fills against real bid/ask, fees not modelled |
| `LIVE` | **Not implemented** | Selecting it opens a notice. No signing, no real orders |

A connected Privy wallet is an **identity**, not an execution permission. It
does not change the environment and does not enable live trading.

### OpenRouter AI
* Active when a valid API key is saved in Settings → AI Provider.
* If no key is provided, the assistant offers helpful built-in algorithmic
  trading advice.

---

## 5. Testing & Verification Checklist

Before pushing changes:
1. Run `npm run verify`. It covers the type check, the condition contract,
   cross-language parity with the Python engine, the engine's own tests,
   and the offline wake-to-fill acceptance test. If the engine has not been
   set up, `test:conditions` **reports a skip rather than a pass** — set it
   up before trusting a green run.
2. Run the remaining suites: `test:agents`, `test:execution`,
   `test:hyperliquid`, `test:hyperliquid:execution`,
   `test:hyperliquid:discovery:policy`, `test:wallet`, and `test:theme`.
3. Run `npm run build` to verify production bundling.
4. Test in mobile emulation mode (Chrome DevTools: iPhone 14 Pro / 393×852).
5. Verify that Trades is the central highlighted action in the bottom bar.
6. Verify that clicking the desktop profile area opens `ProfileView.tsx`.
7. In the bot builder, confirm the market list came from discovery: it
   should match the Markets view, and a market the venue lists without
   quoting should appear greyed out rather than selectable.
