# TradingVibe

> **Discover → Trade → Automate**

TradingVibe is a mobile-first, AI-assisted trading and bot platform for
**Hyperliquid HIP-3** markets across **Forex, Commodities, and Indices**.
It combines live venue market data, a deterministic multi-asset execution
engine, a strategy sandbox with backtesting, and an AI agent runtime that can
propose and automate trades within hard risk boundaries.

---

## What TradingVibe is (and is not)

* **Is:** a browser-first trading and bot workspace for Hyperliquid HIP-3
  markets, with live quotes, an order ticket, positions, bots, and backtesting.
* **Is not:** a broker, a custodian, or a signal service. There is no wallet
  handling, no key storage, and no live order signing in this repository.
* **Multi-asset by design:** nothing in the execution, risk, P&L, or UI path
  assumes a 100,000-unit Forex lot or a pip.

---

## Architecture

```text
UI or agent intent
   → deterministic policy      (ActionValidator)
   → deterministic risk        (RiskManager + valuation model)
   → execution guard           (instrument metadata + size precision)
   → Hyperliquid DEMO adapter  (real bid/ask, simulated fill)
   → execution result          (order id, fill price, position, trade)
   → position / account state  (adapter is the single source of truth)
```

The AI **proposes**; deterministic code **decides**. An agent can never bypass
policy, risk, or the execution guard, and it never holds signing credentials.

See [docs/architecture.md](docs/architecture.md) and
[docs/data-flow.md](docs/data-flow.md).

---

## Environments

| Environment | Status | Market data | Orders | Fees |
| ----------- | ------ | ----------- | ------ | ---- |
| `BACKTEST` | Implemented | historical Hyperliquid candles | simulated | configurable simulation parameters |
| `DEMO` | Implemented | live Hyperliquid quotes | simulated fills against real bid/ask | not modelled (0, labelled in the UI) |
| `LIVE` | **Not implemented** | — | — | — |

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
bun run test:hyperliquid              # market data -> trigger -> agent, execution lifecycle
bun run test:hyperliquid:execution    # execution lifecycle against fixed quotes
bun run test:hyperliquid:discovery    # live discovery smoke test (needs network)
bun run build
```

---

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `VITE_HYPERLIQUID_NETWORK` | `mainnet` (default) or `testnet` |
| `OPENROUTER_API_KEY` | Optional. User-supplied key for the AI assistant |

No signing credentials are accepted, requested, or stored.

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [architecture.md](docs/architecture.md) | Layers, execution path, environments |
| [data-flow.md](docs/data-flow.md) | Market data, execution, agent, and AI flows |
| [market-data.md](docs/market-data.md) | Discovery, instrument model, availability policy |
| [environment.md](docs/environment.md) | Configuration |
| [components.md](docs/components.md) | UI surfaces |
| [bots.md](docs/bots.md) | Bot definitions and deployment |
| [security.md](docs/security.md) | Security boundaries |
