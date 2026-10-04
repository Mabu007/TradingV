# Environment Configuration

Every environment variable used by **TradingGOATs** is documented in
`.env.example` at the repository root. Copy it to `.env` and fill in what you
need:

```bash
cp .env.example .env
```

`.env` is git-ignored. Only `.env.example` is committed, and it contains
placeholders only.

---

## 1. The `VITE_` rule

Vite inlines any variable prefixed with `VITE_` into the browser bundle.

**Anything in a `VITE_` variable is client-visible.** Never put any of these in
one:

* a private key
* a wallet seed phrase or mnemonic
* a signing secret
* a Hyperliquid API wallet secret
* a Privy server secret, auth secret, or verification key
* an API secret that is meant to stay server-side

`src/config/env.ts` is the single place in the codebase that reads a
client-visible variable, and it only ever reads `VITE_`-prefixed names.

---

## 2. Public frontend variables

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `VITE_PRIVY_APP_ID` | **Yes** | Privy application id. Obtained from the [Privy dashboard](https://dashboard.privy.io). Without it the app runs with a permanently disconnected wallet. |
| `VITE_PRIVY_CLIENT_ID` | No | Privy app client id, when the dashboard issues one. |
| `VITE_PRIVY_LOGIN_METHODS` | No | Comma-separated login methods to show, e.g. `email,wallet`. Empty means "whatever the dashboard allows". |
| `VITE_PRIVY_API_URL` | No | Privy API URL override. Development and testing only. |
| `VITE_HYPERLIQUID_NETWORK` | No | Hyperliquid network for discovery, quotes, and candles: `mainnet` (default) or `testnet`. |
| `VITE_APP_URL` | No | Public base URL of the deployed app, for self-referential links. |
| `VITE_OPENROUTER_API_KEY` | No | Build-time OpenRouter key. **Public.** Prefer each user entering their own key in Settings. |

The Privy application id identifies the application; it is not a secret. It
ships in the bundle by design.

---

## 3. Server-only variables

Not read by the frontend build. Documented in `.env.example` as commented-out
entries so the future signing boundary has a defined home. They belong in a
backend service or a secret manager, never in this repository.

| Variable | Purpose |
| -------- | ------- |
| `PRIVY_SECRET_KEY` | Privy server API secret for privileged Privy API calls. |
| `PRIVY_VERIFICATION_KEY` | Verifies a Privy access-token JWT server-side. |
| `PRIVY_AUTH_SECRET` | Mints and verifies Privy JWTs server-side. |
| `HYPERLIQUID_API_WALLET` | Address of the server-side Hyperliquid agent wallet. |
| `HYPERLIQUID_PRIVATE_KEY` | Agent wallet private key. Never reaches the browser or an agent. |
| `HYPERLIQUID_WALLET_SECRET` | Encrypts the stored agent wallet at rest. |
| `OPENROUTER_API_KEY` | Server-side OpenRouter key for trusted backend calls. |

---

## 4. Venue and execution notes

Market data comes from Hyperliquid's public REST and WebSocket endpoints and
requires **no credentials**. The legacy non-prefixed `APP_URL` convention is
still read at build time where the bundler provides it, but `VITE_APP_URL` is
the variable to set.

LIVE execution is not implemented. Demo fills, demo P&L, and demo margin are
produced by the Hyperliquid DEMO adapter. Connecting a Privy wallet gives the
user an identity; it does not enable live trading, and no code path can sign
or send a real order.

---

## 5. Security guidelines

* Never commit `.env` with real credentials; commit only `.env.example` with
  placeholders.
* `.gitignore` excludes `.env` and every `.env.*` variant, and re-admits only
  `.env.example`.
* `bun run test:wallet` fails the build if `.env.example` drops a required
  variable, assigns a real value, or loses the `VITE_` safety warning.
* Secrets are never logged, never printed, and never copied into source.

## The condition engine

The Python condition engine reads public market data and decides when to
wake the AI. It holds no credentials, so every variable it uses is
operational rather than secret.

| Variable | Default | Notes |
| --- | --- | --- |
| `TRADINGV_ENGINE_HOST` | `127.0.0.1` | Keep it on localhost. It is a local service, not a public API. |
| `TRADINGV_ENGINE_PORT` | `8099` | |
| `TRADINGV_NETWORK` | `mainnet` | `mainnet` or `testnet`. |
| `TRADINGV_HYPERLIQUID_API` | `https://api.hyperliquid.xyz/info` | Public endpoint. |
| `TRADINGV_POLL_INTERVAL` | `20` | Seconds between market polls. |
| `TRADINGV_HTTP_TIMEOUT` | `10` | A slow venue should read as `UNKNOWN`, not as a condition that is not met. |
| `TRADINGV_HISTORY` | `1500` | Candles retained per market per timeframe. |
| `TRADINGV_LIVE_TRADING` | — | Deliberately has no effect. |

The browser reaches the engine through `VITE_TRADINGV_ENGINE_URL`. That
value is safe to ship: it is an address, not a capability. What the engine
*can* do is not the browser's business, because what it can do is measure.

Setting `TRADINGV_LIVE_TRADING` is called out in `.env.example` and is
deliberately **not** given a value there. The engine has no execution code
path to enable, and a test asserts both that the flag is explained and that
it is never presented as a setting you can turn on.

A test also asserts the inverse rule mechanically: no `VITE_`-prefixed
variable may have a name suggesting a secret. Every `VITE_` value is
inlined into the bundle and shipped to every visitor.
