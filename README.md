# TradingGOATs — Goal-Oriented Agentic Trader

> **The user defines the goal. GOAT determines how to pursue it.**

GOAT is a mobile-first, agentic trading research and decision platform for
**Hyperliquid HIP-3** markets across **Forex, Commodities, and Indices**.
It combines live venue market data, a deterministic multi-asset execution
engine, a strategy sandbox with backtesting, and an agentic loop that turns
a stated objective into hypotheses, evidence, and trade ideas within hard
risk boundaries.

You do not configure indicators, conditions or trackers. You write a goal
and press one button:

> "Find a potential long opportunity if the current bearish move begins
> reversing."

GOAT reads it, tells you what it understood, and you choose the market it
runs on. From there it forms a thesis, deploys trackers to wait for the
specific evidence it needs, sleeps, wakes when something relevant happens,
and either strengthens the thesis, revises it, or abandons it. The same
GOAT can be moved to another market at any time.

Optionally, attach skills — or write your own, in markdown, in the app. A
skill is steering prose that shapes how the GOAT thinks, plus the limits
you want enforced rather than suggested.

See [docs/goat.md](./docs/goat.md) for the full architecture.

---

## What TradingGOATs is (and is not)

* **Is:** a browser-first agentic trading workspace for Hyperliquid HIP-3
  markets, with live quotes, an order ticket, positions, goal-driven agents,
  and backtesting.
* **Is not:** a broker, a custodian, or a signal service. Privy provides
  authentication and a wallet *identity*; TradingGOATs never holds a key, never
  signs an order, and has no live execution path.
* **Multi-asset by design:** nothing in the execution, risk, P&L, or UI path
  assumes a 100,000-unit Forex lot or a pip.

---

## Architecture

```text
UI or agent intent
   → deterministic policy      (ActionValidator)
   → deterministic risk        (RiskManager + valuation model)
   → execution guard           (instrument metadata + size precision)
   → signing boundary          (NOT IMPLEMENTED)
   → Hyperliquid DEMO adapter  (real bid/ask, simulated fill)
   → execution result          (order id, fill price, position, trade)
   → position / account state  (adapter is the single source of truth)
```

The AI **proposes**; deterministic code **decides**. An agent can never bypass
policy, risk, or the execution guard, and it never holds signing credentials.
A tracker is a wake mechanism: it decides whether a GOAT is worth waking, not
whether an order is allowed.

See [docs/architecture.md](docs/architecture.md) and
[docs/data-flow.md](docs/data-flow.md).

---

## TradingGOATs AI

The in-app copilot reads the application - account, positions, trades,
markets, GOATs, trackers, risk, and wallet connection - through narrow
read-only tools, then explains what is happening and offers a button to
take you to the right screen.

It cannot trade. It cannot change a risk limit, it cannot enable live
trading, and it never sees a private key, seed phrase, or signing secret.
Every order still goes through the deterministic policy, risk, and
execution guard. See [docs/ai-copilot.md](docs/ai-copilot.md).

## Condition preview

Trackers are designed as condition trees:

```text
IF  Gold price crosses above 2,500
AND RSI(14) is at or below 35
AND timeframe is 15m
THEN  wake the AI
```

Groups nest with `AND` / `OR` / `NOT`. A tracker reports once when its
conditions become true and then stays quiet, with configurable cooldown and
rate caps, because every wake costs a model call. `THEN` is always *wake
the GOAT* - never *place a trade*. The preview can evaluate a condition
tree against live market data and show which conditions currently hold. See
[docs/trackers.md](docs/trackers.md).

## Theme

Dark and light are two designed palettes behind semantic design tokens.
Dark is the default, the choice is remembered, and an explicit choice wins
over the OS preference. No component hardcodes a colour. See
[docs/theme.md](docs/theme.md).

## Environments

| Environment | Status | Market data | Orders | Fees |
| ----------- | ------ | ----------- | ------ | ---- |
| `BACKTEST` | Implemented | historical Hyperliquid candles | simulated | configurable simulation parameters |
| `DEMO` | Implemented | live Hyperliquid quotes | simulated fills against real bid/ask | not modelled (0, labelled in the UI) |
| `LIVE` | **Not implemented** | — | — | — |

`LIVE` cannot be set. Selecting it opens a notice, not a confirmation.

---

## Wallet & authentication

TradingGOATs uses [Privy](https://www.privy.io) for wallet and authentication
infrastructure. The provider is mounted once at the application root and
exposed through an application-level `WalletService` interface, so the rest of
the app never touches the SDK directly.

The connected wallet is the user's identity. It is **not** an execution
permission: it does not change the trading mode, does not place orders, and
does not sign them. AI agents have no wallet capability and cannot sign,
read keys, or reach the provider.

Live order signing is intentionally deferred. It needs a server-side
Hyperliquid agent signer that does not exist yet; the browser implementation is
not presented as production-ready. See
[docs/authentication.md](docs/authentication.md).

---

## Markets

* **Forex** — `xyz:EUR`, `xyz:GBP`, `xyz:JPY`
* **Commodities** — `xyz:GOLD`, `xyz:SILVER`, `xyz:CL`, `xyz:BRENTOIL`, `xyz:COPPER`, `xyz:NATGAS`, `xyz:PLATINUM`, `xyz:PALLADIUM`
* **Indices** — `xyz:SP500`, `xyz:JP225`, `xyz:KR200`, `mkts:US500`, `mkts:USTECH`, `mkts:SMALL2000`

Instruments are discovered from Hyperliquid metadata into one canonical
`InstrumentMetadata` model. A market that the venue lists without a book is
kept as metadata but excluded from the trading universe; no price is invented.

Orders, positions, and P&L are always expressed in **instrument units**. Forex
lots are only a way of typing a size in the order ticket.

---

## Getting started

```bash
bun install
bun run dev        # http://localhost:3000
```

### Validation

```bash
bun run lint                          # TypeScript, zero errors
bun run test:agents                   # agent runtime, policy, bot definitions
bun run test:execution                # valuation, exposure, leverage, order sizing
bun run test:hyperliquid              # market data -> tracker -> GOAT wake, execution lifecycle
bun run test:hyperliquid:execution    # execution lifecycle against fixed quotes
bun run test:hyperliquid:discovery:policy  # availability policy (TRADEABLE vs UNAVAILABLE)
bun run test:hyperliquid:discovery    # live discovery smoke test (needs network)
bun run test:wallet                   # Privy wiring, wallet abstraction, env, security
bun run test:theme                    # theme resolution/persistence, AI context, navigation
bun run build
```

---

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `VITE_PRIVY_APP_ID` | Privy application id. Required for wallet sign-in |
| `VITE_HYPERLIQUID_NETWORK` | `mainnet` (default) or `testnet` |
| `VITE_OPENROUTER_API_KEY` | Optional. User-supplied key for the AI assistant |

`.env.example` documents every variable, splitting browser-visible `VITE_*`
values from server-only secrets. Anything prefixed `VITE_` is inlined into the
browser bundle, so no private key, seed phrase, or signing secret may ever use
that prefix. See [docs/environment.md](docs/environment.md).

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [architecture.md](docs/architecture.md) | Layers, execution path, environments, scrolling model |
| [theme.md](docs/theme.md) | Design tokens, dark/light palettes, theme resolution |
| [ai-copilot.md](docs/ai-copilot.md) | TradingGOATs AI: context tools, navigation actions, limits |
| [data-flow.md](docs/data-flow.md) | Market data, execution, agent, and AI flows |
| [market-data.md](docs/market-data.md) | Discovery, instrument model, availability policy |
| [environment.md](docs/environment.md) | Configuration |
| [authentication.md](docs/authentication.md) | Privy, the wallet interface, AI isolation, the signing boundary |
| [components.md](docs/components.md) | UI surfaces |
| [bots.md](docs/bots.md) | Bot definitions and deployment |
| [security.md](docs/security.md) | Security boundaries |
