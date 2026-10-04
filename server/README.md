# The condition engine

This service reads market data, evaluates the conditions you wrote, and
decides **when the AI should be woken**. That is all it does.

It cannot place, size, approve, or cancel an order. It holds no
credentials, has no wallet, and signs nothing. When a condition becomes
true it emits an `AI_WAKE` event; what happens next belongs to the web
app, behind the existing policy, risk, and DEMO execution guard.

That boundary is the point. A component that can trade has no business
deciding when to think about trading, and one that decides when to think
has no business being able to trade.

## Quick start

```bash
bun run server:setup    # once: creates server/.venv and installs the engine
bun run server:start    # then, in a second terminal
```

The engine listens on `http://127.0.0.1:8099` by default. Open
<http://127.0.0.1:8099/docs> for the interactive API.

If the engine is not running, the condition preview says so and the GOAT is
simply not woken. It does not fall back to guessing.

## One condition language

There is exactly one, and its definition is
[`shared/condition_schema_v1.json`](../shared/condition_schema_v1.json).
The browser reads that file to validate what you build; this engine reads
it to decide what is true. Neither side has its own copy.

Three consequences worth knowing:

- **Adding an indicator means editing one file.** Add it to the schema, to
  `catalogue.py`, and to `indicators/engine.py`. A contract test fails
  until all three agree.
- **`THEN` is a closed enum.** The only value is `WAKE_AI`. There is no
  schema path that can express an order, and a test asserts the schema
  never grows vocabulary like `placeOrder` or `privateKey`.
- **An unknown version is a hard failure.** If the browser builds a tree
  the engine does not implement, the engine refuses it rather than
  best-effort parsing it.

### The three states

| State | Meaning | Wakes the AI? |
| --- | --- | --- |
| `TRUE` | Measured, and the condition holds | Only on a `FALSE → TRUE` edge |
| `FALSE` | Measured, and the condition does not hold | No |
| `UNKNOWN` | Could not be measured | No |

`UNKNOWN` is not a synonym for `FALSE`. Collapsing the two would let a
market that stopped updating, a market the venue will not trade, or an
indicator still warming up look like a market where your conditions are
simply not met. The distinction is enforced in the group operators:

- `AND`: any `FALSE` → `FALSE`; else any `UNKNOWN` → `UNKNOWN`; else `TRUE`
- `OR`: any `TRUE` → `TRUE`; else any `UNKNOWN` → `UNKNOWN`; else `FALSE`
- `NOT UNKNOWN` is `UNKNOWN`, never `TRUE`

## What the engine will and will not do

```bash
curl localhost:8099/health
```

```json
{
  "capabilities": {
    "evaluatesConditions": true,
    "emitsAiWake": true,
    "placesOrders": false,
    "signsTransactions": false,
    "holdsCredentials": false
  }
}
```

Setting `TRADINGV_LIVE_TRADING=true` does nothing. There is no code path
to enable, and a test asserts the engine reports `liveTradingEnabled:
false` even when the environment asks otherwise.

## API

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness, schema version, and the capability list above |
| `GET` | `/catalogue` | Every condition, indicator, and pattern, for the builder |
| `GET` | `/schema` | The committed schema, served verbatim |
| `GET` | `/timeframes` | Supported timeframes and the default |
| `GET` | `/instruments` | The markets the venue currently lists |
| `GET` | `/fixtures` | The saved market samples a draft can be tested against |
| `POST` | `/test` | Evaluate a draft tree against a **fixture**, never a live market |
| `POST` | `/evaluate` | Evaluate a tree against the engine's current cached data |
| `POST` | `/trackers` | Register a tracker, validated against the shared schema |
| `GET` | `/trackers/{id}/status` | Debounce state: last status, wake count, caps |
| `DELETE` | `/trackers/{id}` | Stop watching a tracker |
| `GET` | `/wakes` | Recent `AI_WAKE` events, oldest first |
| `POST` | `/wakes/{id}/ack` | Record that the app received a wake |
| `GET` | `/events` | The engine's own event timeline |
| `GET` | `/status` | What is being watched and how much has been computed |

`POST /test` is what the builder calls while you are editing. It reads a
committed fixture rather than a live market, so the same draft gives the
same answer today and in six months.

## How the polling works

One loop, not one per condition. Each tick the engine:

1. works out every `(market, timeframe)` the *enabled* trackers reference,
2. fetches each one **once** and shares it with every tracker on that
   market,
3. computes only the indicators those trees actually name, and
4. asks each tracker's edge detector whether this is a wake.

`GET /status` reports the difference. Two trackers on Gold 15m produce one
fetch and one indicator computation, not two of each.

A rate-limited edge is *not* queued. If a condition becomes true while the
cooldown is running, it stays true and no wake is delivered later: the
condition has not become true again, so delivering a wake then would be
reporting a moment that has already passed.

## Configuration

Every knob is an environment variable, documented in
[`.env.example`](../.env.example). The short version:

| Variable | Default | Notes |
| --- | --- | --- |
| `TRADINGV_ENGINE_HOST` | `127.0.0.1` | Keep it on localhost |
| `TRADINGV_ENGINE_PORT` | `8099` | |
| `TRADINGV_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `TRADINGV_POLL_INTERVAL` | `20` | Seconds between polls |
| `TRADINGV_HTTP_TIMEOUT` | `10` | A slow venue should read as `UNKNOWN` |
| `TRADINGV_HISTORY` | `1500` | Candles kept per market per timeframe |
| `TRADINGV_LIVE_TRADING` | — | Deliberately has no effect |

A test asserts that every setting the code reads is documented, so an
undocumented knob cannot creep in.

## Market data

Public Hyperliquid endpoints only, so there is no credential to
misconfigure and none to leak.

A market is `TRADEABLE` only when the venue quotes a price for it (the
book mid, or failing that the mark). An oracle-only market is listed but
not tradeable, and the oracle price is never promoted into an executable
price. A candle window is bounded by the requested count rather than
fetching from genesis, so a poll does not pull years of data it discards.

If the venue stops answering, the last good candles are kept and reported
as **stale** rather than as a flat market. A condition reading a stale
close is the most dangerous kind of wrong.

## Layout

```
server/
  pyproject.toml            Dependencies, and why each one is here
  tradingv_engine/
    __main__.py             `python -m tradingv_engine`
    api.py                  The HTTP boundary
    engine.py               The polling loop and the wake queue
    monitor.py              One tick: refresh, evaluate, detect edges
    store.py                Candle cache, indicator cache, context builder
    marketdata.py           Hyperliquid's public endpoints
    contract.py             Reads and enforces the shared schema
    evaluator.py            The three-state evaluator
    indicators/engine.py    Every indicator, one signature
    price_action.py         Candle and price-action measures
    patterns.py             Chart patterns
    math_expr.py            A bounded expression parser. No `eval`
    edge.py                 Edge detection, cooldown, wake caps
    catalogue.py            What the builder offers
    events.py               The engine's event vocabulary
  tests/                    330 tests, all offline
  tests/fixtures/           Committed OHLCV, shared with the browser suite
```

## Dependencies

| Package | Why |
| --- | --- |
| `numpy`, `pandas` | The time-series substrate. Mature, deterministic, no surprises. |
| `ta` | Standard technical analysis, BSD-3, pure Python. Every indicator with a textbook definition. |
| `fastapi`, `uvicorn` | A small, well-understood HTTP surface. |
| `jsonschema` | Validates the shared contract with the same file the browser reads. |

Deliberately excluded: `ta-lib` (needs a system C library and failed to
build here; `ta` covers the same ground), and `pandas-ta` (its API changed
between releases, which is not something to build a wake condition on).

## Tests

```bash
bun run test:engine        # 330 tests
bun run test:conditions    # cross-language parity with the browser
bun run test:pipeline      # wake → policy → risk → DEMO fill
bun run verify             # all of the above, plus the type check
```

Nothing in the suite reads the network, waits on a clock, or depends on
today's price. Every input is a committed fixture, so a failure is a real
behavioural change rather than a bad morning on the markets.

`bun run test:conditions` runs the Python engine over
`shared/condition_examples.json` and compares its answers to the expected
state for each example. **It reports a skip rather than a pass when no
Python interpreter is available**, because a parity check that quietly
stops running is worse than not having one.
