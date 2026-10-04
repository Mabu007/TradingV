# Module 7 — Capabilities

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/agents/capabilities/`

**Purpose:** the 31 named tools an agent may call. 24 are read-only measurements;
7 are in the `execution` category and can place, modify, or close positions. All
execution goes through `env`, so a capability never touches an adapter directly.

---

## Contains

| File | Lines | Exports |
| --- | --- | --- |
| `registry.ts` | 96 | `CapabilityRegistry`, `capabilityRegistry` |
| `index.ts` | 38 | the six capability arrays, `initializeDefaultCapabilities` |
| `market.ts` | 237 | `MARKET_CAPABILITIES` — 4 |
| `indicators.ts` | 209 | `INDICATOR_CAPABILITIES` — 4, `validatePrices` |
| `structure.ts` | 289 | `STRUCTURE_CAPABILITIES` — 4, `validateStructureBars` |
| `account.ts` | 201 | `ACCOUNT_CAPABILITIES` — 6 |
| `risk.ts` | 586 | `RISK_CAPABILITIES` — 6 |
| `execution.ts` | 211 | `EXECUTION_CAPABILITIES` — 7 |
| `instruments.ts` | — | helpers: `resolveInstrument`, `resolveInstruments`, `pipSizeFor`, `lotSizeFor` (not a capability) |

---

## The registry

`CapabilityRegistry` — `registry.ts:3-53`; singleton `capabilityRegistry` `:91`.

| Member | Line | Behaviour |
| --- | --- | --- |
| `register(capability)` | `:6-16` | requires a non-empty id `:7`, rejects duplicates `:8`, requires `execute` `:9`, requires object `inputSchema`/`outputSchema` `:10`; stores a re-typed wrapper `:11-15` |
| `get(id)` | `:18-20` | |
| `has(id)` | `:22-24` | |
| `list()` | `:26-28` | |
| `listByCategory(category)` | `:30-32` | |
| `execute(id, input, context)` | `:34-52` | unknown id throws `:40-42` → `validateCapabilityInput` `:45` → `validateCapabilityScope` `:46` → `capability.execute` `:47`; all failures wrapped as `Capability execution failed [<id>]: <msg>` `:48-51` |
| `validateCapabilityInput(id, schema, value)` | `:59-89` | input must be a JSON object `:60-62`; **unknown fields rejected** `:64-65`; `required` `:69`; types `:72-80`; `enum` `:81`; `minimum` `:82-84`; `maximum` `:85-87` |
| `validateCapabilityScope(id, value, context)` | `:93-96` | a string `symbol` in the input must be in `context.symbols` |

**Population** — `initializeDefaultCapabilities(registry = capabilityRegistry)`
`index.ts:18-35`, invoked **at module load** `index.ts:38`. Each capability is
registered only if not already present (`:28-32`).

**Namespacing** — the dotted id string *is* the namespace:
`market.*`, `indicators.*`, `structure.*`, `account.*`, `risk.*`, `orders.*`,
`positions.*`. The same strings appear in `botDefinition.capabilityIds`
(`botDefinition.ts:952-982`) and in `skills/builtins.ts`.

---

## The 31 capabilities

### `market.*` — read-only, 4

| Id | Line | Behaviour |
| --- | --- | --- |
| `market.getQuote` | `:4-36` | `env.getMarketQuote` `:26`; symbol scope check `:25` |
| `market.getBars` | `:38-73` | `env.getMarketBars` `:65`; `count` capped at 300 `:64` |
| `market.getSpread` | `:75-159` | quote-derived; `spreadPips` only when the instrument declares `pipSize` `:129-131`; `spreadBps` `:138-139`; `isNormal`/`thresholdConfigured` `:155-156` |
| `market.getSession` | `:161-230` | pure clock logic; in `BACKTEST` reads the current bar time `:177-180`; sessions `WEEKEND_CLOSE` `:186`, `OVERLAP` `:196`, `LONDON` `:205`, `NEW_YORK` `:214`, `ASIAN` `:223` |

### `indicators.*` — read-only, 4

| Id | Line | Behaviour |
| --- | --- | --- |
| `indicators.sma` | `:5-48` | fetches `period + 30` bars when values are not supplied; scope check `:31` |
| `indicators.ema` | `:50-93` | `period + 30`; scope check `:76` |
| `indicators.rsi` | `:95-144` | OVERBOUGHT ≥ 70 / OVERSOLD ≤ 30 at `:133-135`; scope check `:122` |
| `indicators.atr` | `:146-198` | `latestPips` only when `pipSize` exists `:185-187`, `:191-194`; scope check `:172` |

`validatePrices` — `:207-209`.

### `structure.*` — read-only, 4

| Id | Line | Behaviour |
| --- | --- | --- |
| `structure.swingHighs` | `:4-54` | |
| `structure.swingLows` | `:56-106` | |
| `structure.supportResistance` | `:108-167` | top-3 resistance/support `:152-159` |
| `structure.breakout` | `:169-276` | pip buffer honoured only with metadata `pipSize` `:217-224` |

`validateStructureBars` — `:285-289`.

### `account.*` — read-only, 6

| Id | Line |
| --- | --- |
| `account.getBalance` | `:4-18` |
| `account.getEquity` | `:20-40` |
| `account.getMargin` | `:42-65` |
| `account.getPositions` | `:67-105` |
| `account.getOrders` | `:107-124` |
| `account.getExposure` | `:126-192` — lot total only when every open instrument is lot-sized `:167-181` |

### `risk.*` — read-only (measurement and verdict), 6

| Id | Line | Behaviour |
| --- | --- | --- |
| `risk.calculatePositionSize` | `:13-200` | |
| `risk.calculateRisk` | `:202-268` | |
| `risk.calculateExposure` | `:270-370` | |
| `risk.checkTrade` | `:372-524` | **verdict only**; gates at `:450-516` — it does not place anything |
| `risk.getDailyLoss` | `:526-552` | |
| `risk.getDrawdown` | `:554-577` | |

### `execution.*` — **mutating**, 7

| Id | Line | Effect |
| --- | --- | --- |
| `orders.market` | `:3-35` | `env.placeMarketOrder` `:26`; schema `volume` `minimum: 1` `:11-18` |
| `orders.limit` | `:37-62` | `env.placeLimitOrder` `:60`; soft-fails if unsupported `:59` |
| `orders.cancel` | `:64-82` | `env.cancelOrder` `:80` |
| `positions.modifyStopLoss` | `:84-113` | `env.modifyPosition` `:103` |
| `positions.modifyTakeProfit` | `:115-144` | `env.modifyPosition` `:134` |
| `positions.close` | `:146-172` | `env.closePosition` `:164` |
| `positions.partialClose` | `:174-201` | `env.closePosition(id, volumeToClose)` `:193` |

---

## Read-only vs mutating

| Group | Count | Can place / close? |
| --- | --- | --- |
| `market.*` | 4 | no |
| `indicators.*` | 4 | no |
| `structure.*` | 4 | no |
| `account.*` | 6 | no |
| `risk.*` | 6 | no — verdict only |
| `orders.*` / `positions.*` | 7 | **`orders.market`, `positions.close`, `positions.partialClose` do**; `modify*` mutate open positions; `orders.limit`/`orders.cancel` touch the resting book |

**`category === 'execution'` is load-bearing** — `AgentRuntime` branches on it twice:
re-observe before running (`runtime.ts:628-631`) and pre-validate through
`validateExecutionTool` (`runtime.ts:633-641` → `:1508-1704`), which hard-refuses
`orders.limit` and `orders.cancel` (`runtime.ts:1686-1696`).

---

## `CapabilityContext`

`src/engine/agents/types.ts:61-69`:
`{ agentId, environment, env, symbol?, timeframe?, policy, symbols }`

`env: ITradingEnvironment` (`types.ts:91-128`) is the only route from a capability to
the trading world. The environment has no reference back to the capability, so the
dependency is one-directional.

---

## Depends on

| Module | How |
| --- | --- |
| Environments | `context.env.*` in every `execute` |
| Policy & Risk | `valuation` helpers, instrument metadata; `risk.*` reads env account data |
| Indicators | `capabilities/indicators.ts` recomputes from bars |
| Services & State | `eventBus` (indirectly, through the environment's adapter) |
| Agent Runtime | nothing imports a capability; the runtime imports the registry |

## Used by

| Consumer | Line |
| --- | --- |
| `AgentRuntime.execute` | `runtime.ts:703`, `:830` |
| `AgentRuntime.observe` (`market.getSession`) | `runtime.ts:343` |
| `botDefinition.validateCapabilities` | `botDefinition.ts:308-338` |
| `botDefinition.capabilityIds` | `botDefinition.ts:952-982` |
| `SkillRegistry` capability resolution | `runtime.ts:136-140` |
| `BotBuilderModal` (capability display) | — |
| Test runners (test-only) | `agents/tests.ts`, `pipelineAcceptance.ts`, `activityTests.ts` |

## Reads

`context.env` (quote, bars, account, positions, orders, instruments) ·
`context.policy` · `context.symbols` · `context.timeframe` ·
`context.environment` (for the `BACKTEST` session path, `market.ts:177-180`).

## Writes

- `capabilityRegistry.capabilities` — `index.ts:38` at import, then never.
- Through `env`: the environment and, behind it, the adapter's positions / orders /
  account. This happens **only** for the 7 `execution` capabilities.

## Mutates

`capabilities/registry.ts:4` (the map, once) ·
`execution.ts:26, 60, 80, 103, 134, 164, 193` (via `env`).

## Emits

None directly. `AgentRuntime` emits `AGENT_TOOL_REQUESTED` (`runtime.ts:674`) and
`AGENT_TOOL_RESULT` (`runtime.ts:743`) around every execution.

## Subscribes to

Nothing.

## External dependencies

Indirect, through `ITradingEnvironment` → the demo adapter → Hyperliquid REST. The
`market.getSession` capability is pure clock logic and performs no I/O.

## Entry points

`CapabilityRegistry.execute` `registry.ts:34` ·
`CapabilityRegistry.get` `:18` · `capabilityRegistry` `:91` ·
`initializeDefaultCapabilities` `index.ts:18` · `resolveInstrument` `instruments.ts:10`
· `resolveInstruments` `instruments.ts:32`.

## Exit points

`env.placeMarketOrder` / `placeLimitOrder` / `cancelOrder` / `modifyPosition` /
`closePosition` for the 7 execution capabilities. Everything else terminates in a
returned value that becomes `toolHistory` (`runtime.ts:736-741`).

---

## Indirect-dependency notes

1. **A capability rename touches three places** — `capabilities/*.ts`,
   `botDefinition.capabilityIds` (`botDefinition.ts:952-982`), and
   `skills/builtins.ts`.
2. **A new capability in the `execution` category is automatically gated** — the
   runtime's `category === 'execution'` branch applies without any change to the
   capability itself. A new id in that category that is not handled by
   `validateExecutionTool` returns `UNKNOWN_CAPABILITY`
   (`runtime.ts:1698-1703`).
3. **`validateCapabilityInput` rejects unknown fields** (`registry.ts:64-65`), so a
   model that invents an extra key gets an error rather than a silent pass-through.
4. **`instruments.ts` is a helper module, not a capability** — it exports
   `resolveInstrument` `:10`, `resolveInstruments` `:32`, `pipSizeFor` `:47`,
   `lotSizeFor` `:58`; none are registered with the registry.
