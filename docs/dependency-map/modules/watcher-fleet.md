# Module 16 — Watcher Fleet

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `watchers/src/` (9 modules, 2 663 LOC)

**Purpose:** a durable, per-deployment watcher. Market events arrive via an
authenticated `POST /feed`, fan out by market index to matching watcher Durable
Objects, and each watcher asks the Python engine whether its condition tree is
currently true. A true edge produces a `Wake` that an external agent pulls over HTTP.
No candle history is stored in the worker.

**Zero runtime dependencies** — the only non-relative import in `watchers/src` is
`cloudflare:workers` (`index.ts:27`, `durable-object.ts:23`).

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `index.ts` | 536 | `default` `ExportedHandler` `:78-86`, `Env` `:45-71`, `UserRegistryObject` `:358`, `RateLimitObject` `:396`, `MarketIndexObject` `:463`, plus the router and the three DO index classes |
| `durable-object.ts` | 319 | `WatcherObject` `:69-312`, `WatcherEnv` `:43-56`, `WAKE_TTL_MS` `:40`, `EvaluationOutcome` `:319`, `configsEqual` `:314-316` |
| `watcher.ts` | 516 | `Watcher`, `WatcherState` `:41-64`, `WakeStatus`, `ConditionEvaluator` interface, `TickOutcome` |
| `evaluator.ts` | 174 | `HttpConditionEvaluator` `:36`, `ScriptedEvaluator` `:126`, `normalizeStatus` `:160-166`, `safeText` `:168-174` |
| `contract.ts` | 351 | `WatcherIdentity` `:35-39`, `watcherIdFor` `:41-43`, `isOwnedBy` `:53-55`, `TRANSITIONS` `:90-98`, `nextStatus` `:100-102`, `applyAction` `:126-131`, `validateWatcherConfig` `:188-218`, `shouldProcessEvent` `:303-351`, `MarketEvent` `:263-276`, `EventRejection` `:278-285` |
| `wake-queue.ts` | 355 | `Wake` `:61-80`, `WakeQueue` `:115-325`, `buildWake` `:328-355`, `DEFAULTS` `:96-100` |
| `rate-limit.ts` | 127 | `consume` `:77-117`, `RATE_LIMITS` `:23-43`, `RATE_WINDOW_MS` `:46`, `emptyRateLimitState` `:67-69`, `isPreflight` `:125-127` |
| `health.ts` | 198 | `assessHealth` `:98-171`, `HealthReport` `:73-88`, `DEFAULT_HEALTH_THRESHOLDS` `:66-71`, `ageOf` `:173-178`, `describeAge` `:181-188`, `HEALTH_LABELS` `:191-198` |
| `ids.ts` | 87 | `digest` `:24-36`, `mix` `:38-46`, `watcherIdFor` `:49-51`, `evaluationIdFor` `:54-56`, `wakeIdFor` `:67-69`, `idempotencyKeyFor` `:79-81`, `randomId` `:84-87` |

Tests: `watchers/test/` (6 files, 138 `it()`) and `watchers/test-runtime/` (1 file, 26 `it()`).

---

## Entry points

`default.fetch` `index.ts:79` — **only** `fetch`; no `scheduled`, no `queue()`.

Routes dispatched by `route()` `index.ts:88-141`:

| Method + path | Line | Bucket | Handler |
| --- | --- | --- | --- |
| `OPTIONS *` | `:93` | none (204) | inline |
| `GET /health` | `:95-97` | none, unauthenticated | inline |
| `POST /feed` | `:102-110` | `feed` | `handleFeed` `:147-200` |
| `GET /watchers` | `:118-120` | `read` | `listWatchers` `:220-231` |
| `POST /watchers` | `:121-123` | `lifecycle` | `deployWatcher` `:233-275` |
| `GET /watchers/{id}` | `:125-138` | `read` | `handleWatcherRoute` `:307-310` |
| `GET /watchers/{id}/health` | `:312-314` | `read` | `WatcherObject.health` |
| `GET /watchers/{id}/wakes` | `:316-319` | `read` | `pendingWakes` |
| `POST /watchers/{id}/wakes:claim` | `:321-325` | `lifecycle` | `claimWakes` |
| `POST /watchers/{id}/wakes:resolve` | `:327-334` | `lifecycle` | `resolveWake` |
| `POST /watchers/{id}/{start\|pause\|resume\|stop\|retry\|deploy}` | `:336-342` | `lifecycle` | `WatcherObject.act` |
| anything else | `:140` | — | 404 |

**Route-regex observation (CONFIRMED)** — `index.ts:125` is
`/^\/watchers\/([A-Za-z0-9_]+)(?:\/(\w+))?$/`. The action group `\w+` does not match
`wakes:claim` or `wakes:resolve` (they contain `:`), so both fall through to the 404
at `index.ts:140`. The DO RPC methods remain callable directly.

**Config** — `wrangler.toml`: name `tradingvibe-watchers` `:8`, main `src/index.ts` `:9`,
compatibility date `2024-12-01` `:10`, `nodejs_compat` `:11`.
Vars: `ENGINE_URL = http://127.0.0.1:8099` `:23`, `ALLOWED_ORIGINS = http://localhost:3000` `:25`.
Secrets (names only): `AUTH_TOKEN` `:14`, `MARKET_FEED_TOKEN` `:15`.
Bindings `:31-47`: `WATCHERS`→`WatcherObject`, `REGISTRY`→`UserRegistryObject`,
`MARKET_INDEX`→`MarketIndexObject`, `RATE_LIMITS`→`RateLimitObject`.
Migration tag `v1`, `new_classes` = all four `:49-51`. Observability enabled `:53-55`.
**No `[triggers]` (no cron). No KV namespaces. No queue producers or consumers.**

---

## Durable Objects

| Binding | Class | File:line | DO id | Storage key |
| --- | --- | --- | --- | --- |
| `WATCHERS` | `WatcherObject` | `durable-object.ts:69-312` | `idFromName(watcherIdFor(identity))` `:145` | `watcher:state` `:37`, `watcher:terminal-wakes` `:38`, `watcher:pending-wakes` `:39` |
| `REGISTRY` | `UserRegistryObject` | `index.ts:358-385` | `idFromName('user:' + userId)` `:221, :259` | `identities` `:359` |
| `MARKET_INDEX` | `MarketIndexObject` | `index.ts:463-480` | `idFromName('market:' + market)` `:211, :261` | `identities` `:464` |
| `RATE_LIMITS` | `RateLimitObject` | `index.ts:396-409` | `idFromName('feed')` `:106` or `` idFromName(`user:${userId}`) `` `:454` | `window` `:397` |

**`WatcherObject` methods** — `deploy` `:140-209`, `act` `:221-230`,
`onMarketEvent` `:242-257`, `pendingWakes` `:261-263`, `wakeHistory` `:265-267`,
`claimWakes` `:277-284`, `resolveWake` `:286-291`, `health` `:295-306`,
`snapshot` `:308-311`. Private: `now` `:77-79`, `evaluator` `:81-83`, `ready` `:92-110`,
`failUninitialised` `:112-116`, `save` `:118-126`, `readStored` `:211-217`.

**No `fetch`, no `alarm`, no `scheduled` on the DO.** `ready()` uses
`ctx.blockConcurrencyWhile` `:95` to re-read state on every call, which is what makes
the object rehydration-tolerant.

**Conditional persistence** — `onMarketEvent` snapshots
`[status, lastConditionStatus, lastWakeAt, lastMarketDataAt]` before `:245` and after
`:248`, and calls `save()` only when they differ `:249`.

---

## Data flow

Full step detail in [chains/watcher-feed-to-wake.md](../chains/watcher-feed-to-wake.md).

```
POST /feed  →  consumeRate  →  constantTimeEquals  →  group by market
   ↓ MarketIndexObject.list()
   ↓ per (event, watcher)  →  await stub.onMarketEvent(event)
WatcherObject.onMarketEvent  →  ready()  →  Watcher.tick
   ↓ queue.expire / shouldProcessEvent / minEvaluationIntervalMs gate
   ↓ await HttpConditionEvaluator.evaluate  →  fetch {ENGINE_URL}/evaluate
   ↓ latch / capBreached / cooldownRemaining
   ↓ buildWake → queue.enqueue
   ↓ save() (conditionally)
   ↓
external agent pulls GET /watchers/{id}/wakes
```

---

## State

| State | Written at | Read at | Reset |
| --- | --- | --- | --- |
| `watcher:state` | `save()` `durable-object.ts:121` | `readStored()` `:212`; `ready()` `:95-98` | `Watcher.restore` `:98` |
| `watcher:terminal-wakes` | `save()` `:122` | `readStored()` `:214`; `restoreTerminal` `wake-queue.ts:215` | trimmed to `historyLimit` `:321-323` |
| `watcher:pending-wakes` | `save()` `:125` | `readStored()` `:215`; `ready()` `:99` | `resolve` `wake-queue.ts:249`; `expire` `:291` |
| `Watcher.state` in memory | `watcher.ts:262-263, 290-292, 312, 324-344, 407-409`; `act` `:212-229` | `health` `:456-472`; `snapshot` `durable-object.ts:308` | rehydrated from KV |
| `WakeQueue.pending` | `enqueue` `wake-queue.ts:203` | `list` `:133`, `get` `:160`, `acknowledge` `:234` | `resolve` `:249`; `expire` `:291`; overflow `:183-201` |
| `WakeQueue.terminal` | `terminalise` `:318-320` | `history` `:156` | trimmed to `historyLimit` |
| `UserRegistryObject` `identities` | `add` `index.ts:365-373` | `list` `:382`; `:225` | `remove` `:375-380` (no route caller) |
| `MarketIndexObject` `identities` | `add` `index.ts:470-475` | `list` `:477`; `watchersForMarket` `:210-214` | no `remove` exists |
| `RateLimitObject` `window` | `take` `index.ts:406` (every call, incl. refusals) | `take` `:404` | window expiry `rate-limit.ts:88` |

**Bounds** — `WakeQueue` defaults `maxAgeMs: 5*60_000`, `maxSize: 100`,
`historyLimit: 200` (`wake-queue.ts:96-100`), overridable only via `env.queueOptions`
(`durable-object.ts:54`), which is not in `wrangler.toml`.
`WAKE_TTL_MS = 60_000` (`durable-object.ts:40`) is declared and re-exported `:318` but
**never read**; the effective TTL is `maxAgeMs`.
`MAX_CONDITIONS_PER_TREE = 200` (`contract.ts:180`).

---

## Events

**The worker has no emitter and no subscriber.** It is request → DO → response.

| Direction | Mechanism | Evidence |
| --- | --- | --- |
| producer → worker | `POST /feed` with `{ events: MarketEvent[] }`, cap 1000 | `index.ts:147-166` |
| worker → DO | RPC `onMarketEvent` per event | `index.ts:193` |
| worker → Python engine | `POST {ENGINE_URL}/evaluate` per event | `evaluator.ts:66` |
| DO → agent | **pull only** — `GET /watchers/{id}/wakes`, `POST …/wakes:claim` | `index.ts:316, 321` |
| agent → DO | `POST …/wakes:resolve` | `index.ts:327` |

`EventRejection` — 7 values `contract.ts:278-285` — is a per-event **return value**,
not an emitted event: `Watcher.tick` returns `{ outcome: 'SKIPPED', reason }`
(`watcher.ts:280-287`) and it surfaces in the `POST /feed` response `results[]`
(`index.ts:194, :199`).

`shouldProcessEvent` order (`contract.ts:303-351`): `PAUSED` `:309` →
`NOT_RUNNING` `:310-312` → `WRONG_MARKET` `:313-315` → `DUPLICATE` (empty id) `:316-318`
→ `STALE` (non-finite timestamp) `:319-321` → `FUTURE_TIMESTAMP` (skew > 5 000 ms) `:323-328`
→ `DUPLICATE`/`OUT_OF_ORDER` (sequence) `:330-337` → `DUPLICATE`/`OUT_OF_ORDER`
(timestamp) `:342-347`.

---

## External dependencies

| Boundary | Line | Kind |
| --- | --- | --- |
| `fetch({ENGINE_URL}/evaluate)` | `evaluator.ts:66` | `await fetch`, 8 000 ms `AbortController` `:44, 62-63` |
| `ENGINE_URL` | `wrangler.toml:23` | plain var |
| `ALLOWED_ORIGINS` | `wrangler.toml:25` | plain var |
| `AUTH_TOKEN` | `wrangler.toml:14` | secret — bearer auth for all non-feed routes |
| `MARKET_FEED_TOKEN` | `wrangler.toml:15` | secret — `X-Feed-Token` header |
| `ctx.storage.get/put` | `durable-object.ts:121-125, 212-215` | DO KV |
| `ctx.blockConcurrencyWhile` | `durable-object.ts:95` | init barrier |
| `DurableObjectNamespace.idFromName` | `index.ts:221, 250, 261, 427, 106`; `durable-object.ts:145` | deterministic addressing |
| `cloudflare:workers` | `index.ts:27`, `durable-object.ts:23` | `DurableObject` base class |

Test seams on `Env` (not in `wrangler.toml`, so production never uses them):
`now?` `durable-object.ts:52`, `evaluator?` `:53`, `queueOptions?` `:54`,
`healthThresholds?` `:55`.

---

## Depends on

`server/tradingv_engine/` — **inbound only** (HTTP at `evaluator.ts:66`).
It does **not** import `shared/condition_schema_v1.json` or anything from `src/`.

## Used by

An external market-feed producer (`POST /feed`) and an external wake consumer
(`GET /watchers/{id}/wakes`) — **neither exists in this repository (INFERRED from the
absence of any in-repo caller)**.

## Reads

| Source | Line |
| --- | --- |
| `request.headers` `X-Feed-Token` / `Authorization` | `index.ts:155, 301` |
| `env.ENGINE_URL`, `env.WATCHERS`, `env.REGISTRY`, `env.MARKET_INDEX`, `env.RATE_LIMITS` | `evaluator.ts:43`, `index.ts:190, 211, 221, 427` |
| DO storage | `durable-object.ts:212-215`; `index.ts:404` |
| the engine's `/evaluate` response | `evaluator.ts:78-89` |

## Writes

DO storage (`durable-object.ts:121-125`, `index.ts:406, 365-373, 470-475`) ·
in-memory `Watcher.state` (`watcher.ts:262-409`) · `WakeQueue.pending` /
`.terminal` (`wake-queue.ts:203, 318-320`).

## Emits

None. No `emit`, no `queue.send`, no `ctx.waitUntil` broadcast.

## Subscribes to

None in the pub/sub sense. `ready()` rehydrates from DO storage on every RPC.

## Entry points

`default.fetch` `index.ts:79` · `handleFeed` `:147` · `deployWatcher` `:233` ·
`listWatchers` `:220` · `WatcherObject.deploy` `durable-object.ts:140` ·
`.act` `:221` · `.onMarketEvent` `:242` · `.claimWakes` `:277` · `.resolveWake` `:286`
· `.health` `:295` · `.snapshot` `:308` · `RateLimitObject.take` `index.ts:403`.

## Exit points

- `Wake` records in DO storage, pulled over HTTP.
- HTTP responses only. **No push delivery, no queue producer, no cron.**

---

## Notable observations (factual)

- **`WatcherIdFor` is defined twice with byte-identical bodies** — `ids.ts:49-51` and
  `contract.ts:41-43`. `watcher.ts:26` and `index.ts:40` import the contract copy;
  `durable-object.ts:31` imports the ids copy.
- **`consumeRate` fails open** when `env.RATE_LIMITS` is missing — `index.ts:425`
  (commented `:418-424`).
- **Wildcard listeners are irrelevant here**, but the rate-limit counter saturates at
  `limit + 1` so a retry loop cannot inflate it — `rate-limit.ts:99-101`.
- **`UserRegistryObject.remove` has no route caller**; `MarketIndexObject` has no
  `remove` at all.
- **`HEALTH_LABELS`** `health.ts:191-198` is exported and never consumed inside
  `watchers/src` or the tests.
- **`WatcherObject.initialised`** `durable-object.ts:71` is declared and never read
  or written elsewhere.
- **Unused symbols** — `WAKE_TTL_MS` `:40/:318`; `WakeQueue.capacity` `wake-queue.ts:128-130`;
  `HttpEvaluatorOptions` `evaluator.ts:20-26`; `randomId` `ids.ts:84-87`;
  `idempotencyKeyFor` `ids.ts:79-81` (tests only).
- **`watchers/test/source-hygiene.test.ts`** asserts the worker imports nothing from
  `shared/` or `src/engine/` — a dependency-*absence* test.
- **`watchers/README.md` claims "99 tests"; `watchers/test/` contains 138 `it()`**
  and `test-runtime/` a further 26.
