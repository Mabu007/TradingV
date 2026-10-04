# Chain: Watcher Feed → Wake

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** an external market-feed producer sends `POST /feed`.

**Confidence:** CONFIRMED for the worker's code. The identity of the external producer
and the wake consumer is **INFERRED** — neither exists in this repository.

---

```
[0] external producer  →  POST /feed  +  X-Feed-Token
    (no in-repo caller — INFERRED from the route having no in-repo producer)
```

## Stage 1 — the HTTP edge

```
default.fetch(request, env, ctx)                          watchers/src/index.ts:79
   └─ route(request, env)                                 index.ts:88
      ├─ OPTIONS *                     → 204 + CORS headers, no rate-limit spend   :93
      ├─ GET  /health                  → { ok, service, now }, unauthenticated   :95-97
      ├─ POST /feed                    → consumeRate then handleFeed             :102-110
      ├─ GET  /watchers                → bucket 'read'                           :118-120
      ├─ POST /watchers                → bucket 'lifecycle'                      :121-123
      ├─ GET  /watchers/{id}[/action]   → bucket 'read'                           :125-138
      └─ any other method/path         → 404                                     :140
```

**Route regex** — `index.ts:125`:
`/^\/watchers\/([A-Za-z0-9_]+)(?:\/(\w+))?$/`

**Observable consequence (CONFIRMED)** — the branches for
`POST /watchers/{id}/wakes:claim` (`index.ts:321-325`) and
`POST /watchers/{id}/wakes:resolve` (`index.ts:327-334`) contain a colon, which is
matched by neither `[A-Za-z0-9_]+` nor `\w+`. Those requests fall through to the 404
at `index.ts:140`. The underlying DO methods `claimWakes` / `resolveWake` remain
callable directly as RPC (`durable-object.ts:277`, `:286`).

**Authentication** — the bearer token yields a `userId`; ownership is checked with
`isOwnedBy(identity, userId)` (`contract.ts:53-55`) at `index.ts:301`.
`GET /health` and `POST /feed` are the unauthenticated paths.

**CORS** — `ALLOWED_ORIGINS` from `wrangler.toml:25`; headers applied per response.

## Stage 2 — feed handling

```
handleFeed(request, env)                                  index.ts:147-200
   ├─ method guard                                        index.ts:148
   ├─ env.MARKET_FEED_TOKEN absent → 503 FEED_DISABLED     index.ts:150-154
   ├─ constantTimeEquals(request.headers 'X-Feed-Token',
   │                      env.MARKET_FEED_TOKEN)           index.ts:155-158  → impl :501-508
   ├─ body: { events: MarketEvent[] }                     index.ts:160-163
   ├─ cap 1000 events → 413                                index.ts:164-166
   ├─ group by event.market into Map<string, MarketEvent[]>   index.ts:177-183
   │     (events with a non-string `market` or `marketEventId`
   │      are silently skipped, index.ts:177-183)
   └─ for each market:                                     index.ts:187-197
        watchersForMarket(env, market)                     index.ts:188 → :210-214
          env.MARKET_INDEX.idFromName('market:' + market) index.ts:211
          → index.list()                                  index.ts:464 → :477
          → for each identity: watcherIdFor(identity)     index.ts:213 → ids.ts:49
        for each event × each watcher:
          env.WATCHERS.get(env.WATCHERS.idFromName(watcherId))   index.ts:190
          ↓ await stub.onMarketEvent(event)               index.ts:193
   ↓ response { accepted, results }                       index.ts:199
```

**Fan-out is one RPC per (event, watcher) pair** (`index.ts:193`), sequential within
the loop.

## Stage 3 — the Durable Object

```
WatcherObject.onMarketEvent(event)                        durable-object.ts:242-257
   ├─ ready()                                             durable-object.ts:243 → :92-110
   │     ctx.blockConcurrencyWhile(…)                     :95
   │     read the three KV keys                           :98 → :211-217
   │     if nothing stored → failUninitialised() (throws)  :103-108, :112-116
   │     Watcher.restore(storedState)                     :98 → watcher.ts:191
   │        ├ WakeQueue.restoreTerminal(terminalWakes)    wake-queue.ts:215-224
   │        └ WakeQueue.restorePending(pendingWakes)      wake-queue.ts:146-153
   ├─ now = env.now?.() ?? Date.now()                     durable-object.ts:244 → :77-79
   ├─ before = [status, lastConditionStatus, lastWakeAt, lastMarketDataAt]   :245
   ↓ watcher.tick(event, this.evaluator(), now)           :247 → watcher.ts:261
   ├─ after = same four fields                           :248
   └─ if (before !== after) this.save()                  :249
         3 × ctx.storage.put                              :121, :122, :125
   ↓ return { outcome, reason?, wakeId?, health }         :251-256
```

**Conditional persistence (CONFIRMED)** — a no-op tick performs zero storage writes.

## Stage 4 — `Watcher.tick`

`watchers/src/watcher.ts:261-421`

| Step | Line | Action | Mutation |
| --- | --- | --- | --- |
| 1 | `:262-263` | heartbeat + update timestamps | `lastHeartbeatAt`, `updatedAt` |
| 2 | `:268` | `pruneFireTimestamps(nowMs)` — keep stamps within 86 400 000 ms (`:501-506`) | `fireTimestamps` |
| 3 | `:270` | `queue.expire(nowMs)` → `expired` (`:291-301`) | terminal outcomes `STALE` |
| 4 | `:273-278` | `shouldProcessEvent(event, {market, status, lastSequence, lastTimestamp}, nowMs)` — `contract.ts:303-351` | none |
| 5 | `:280-287` | a rejection returns `SKIPPED` with the named reason | none |
| 6 | `:290-292` | `lastMarketDataAt = nowMs`; `lastSequence` when `event.sequence !== undefined`; `lastTimestamp` | 3 fields |
| 7 | `:294-301` | `minEvaluationIntervalMs` gate → `SKIPPED / EVALUATION_INTERVAL` | none |
| 8 | `:303` | `evaluationId = evaluationIdFor(id, event.marketEventId, config.configVersion)` — `ids.ts:54` | none |
| 9 | `:307` | `await evaluator.evaluate(config, event)` | — |
| 10 | `:308-310` | on throw → `evaluator.fail(...)` | — |
| 11 | `:312` | `lastEvaluationAt = nowMs` | 1 field |
| 12 | `:314-336` | `UNKNOWN` branch: `consecutiveEvaluationFailures += 1` `:324`; `lastError = { message, category:'CONDITION_ERROR', at }` `:325-329`; `lastConditionStatus` **deliberately untouched** (comment `:315-323`) | 2 fields |
| 13 | `:338-340` | definite branch: `lastSuccessfulEvaluationAt = nowMs`; `consecutiveEvaluationFailures = 0`; `lastError = null` | 3 fields |
| 14 | `:342-344` | latch: read `previous`, compute `current`, write `lastConditionStatus = current` | 1 field |
| 15 | `:346-353` | `current !== 'TRUE'` → `EVALUATED` | — |
| 16 | `:356-363` | `previous === 'TRUE'` (no edge) → `EVALUATED` | — |
| 17 | `:365-380` | `capBreached(nowMs)` (`:486-492`; hourly 3 600 000 ms vs `maxWakesPerHour`, daily 86 400 000 ms vs `maxWakesPerDay`) → `EVALUATED` with the latch left TRUE | — |
| 18 | `:382-390` | `cooldownRemaining(nowMs)` (`:494-499`; `cooldownMs - (now - lastWakeAt)`) → `EVALUATED` | — |
| 19 | `:392-404` | `buildWake({ … })` — `wake-queue.ts:328-355` | none |
| 20 | `:406` | `this.queue.enqueue(wake, nowMs)` — `wake-queue.ts:171-205` | `queue.pending`, possibly `queue.terminal` |
| 21 | `:407-409` | `fireTimestamps.push(nowMs)`; re-prune; `lastWakeAt = nowMs` | 2 fields |
| 22 | `:411-418` | if not accepted → `EVALUATED` | — |
| 23 | `:420` | else → `WOKEN` | — |

## Stage 5 — the evaluation call

```
HttpConditionEvaluator.evaluate(config, event)            watchers/src/evaluator.ts:60-94
   ├─ AbortController + setTimeout(timeoutMs = 8_000)      evaluator.ts:62-63
   └─ await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({
          tree:   config.conditionTree,
          market: event.market,
          nowMs:  this.now()
        }) })                                             evaluator.ts:66-71
        ↓
        server/tradingv_engine/api.py:344  evaluate_live
          ├ contract.validate_tree(request.tree)          api.py:348 → 422 on failure
          ├ engine.triggers_for_market(request.market)    api.py:351-355
          │    (404 when no registered trigger watches that market)
          └ _evaluate(tree, context)                      api.py:396-404
               evaluate_tree                              evaluator.py:208
               ConditionResult.to_json() per condition   evaluator.py:99-118
               explanation = explain(node)               evaluator.py:1096-1199
               textures   = condition_textures(tree)     contract.py:126-173
        ↓ response 200  { status, summary, conditions, explanation, textures }
   ├─ non-2xx → safeText(response).slice(0,300) then throw   evaluator.ts:74-76
   ├─ normalizeStatus(response.status)                      evaluator.ts:79 → :160-166
   │     (anything not TRUE|FALSE|UNKNOWN → UNKNOWN)
   └─ EvaluationOutcome { evaluationId: evaluationIdFor('pending', …),
                          status, summary, durationMs, conditions }   evaluator.ts:82-89
   finally clearTimeout(timer)                              evaluator.ts:91-93
```

**The worker reads only `status`, `summary` and `conditions`** (`evaluator.ts:78`);
`explanation` and `textures` are discarded at the client boundary.

**Failure translation** — `HttpConditionEvaluator.fail(config, event, error)`
`evaluators.ts:102-117` returns a *synchronous* `UNKNOWN` with `durationMs: 0`,
distinguishing timeout/abort from unreachable via `/abort|timeout/i` (`:105`).

`HttpConditionEvaluator` is constructed in `WatcherObject.evaluator()`
(`durable-object.ts:81-83`) from `env.ENGINE_URL`, or from `env.evaluator` when the
test seam is set.

## Stage 6 — wake persistence

```
buildWake({ watcherId, botId, deploymentId, marketEventId, evaluationId,
            configVersion, conditions, context, nowMs })   wake-queue.ts:328-355
   ├─ id = wakeIdFor(watcherId, marketEventId, configVersion)   ids.ts:67
   │     → `wk_` + 13-char digest
   ├─ status = 'PENDING'; createdAt = nowMs
   ├─ reason  = "for the AI. Never an order."              wake-queue.ts:75-76
   └─ context = { market, price, timeframe }               watcher.ts:402
   ↓
WakeQueue.enqueue(wake, nowMs)                             wake-queue.ts:171-205
   ├─ duplicate already pending  → { accepted:false, reason:'DUPLICATE' }    :172-174
   ├─ duplicate already terminal → { accepted:false, reason:'DUPLICATE' }    :175-177
   ├─ over maxSize (100) → drop the oldest, terminalise as QUEUE_FULL        :183-201
   └─ this.pending.set(wake.id, wake)                                     :203
   ↓
WatcherObject.save()  (only if the change snapshot differs)  durable-object.ts:249
   pending wakes  → KV 'watcher:pending-wakes'              durable-object.ts:125
   terminal wakes → KV 'watcher:terminal-wakes'             durable-object.ts:122
```

Because the wake id is a pure function of
`(watcherId, marketEventId, configVersion)` (`ids.ts:67`), dedup is deterministic
across retries and DO restarts.

## Stage 7 — the external consumer

```
GET  /watchers/{id}/wakes        → pendingWakes()          index.ts:316 → durable-object.ts:261
POST /watchers/{id}/wakes:claim  → claimWakes(limit=10)    index.ts:321 → durable-object.ts:277-284
                                     ├─ pendingWakes()                         :278
                                     ├─ acknowledgeWake(id) per wake           :281
                                     └─ save()                                 :282
POST /watchers/{id}/wakes:resolve → resolveWake(id, outcome) index.ts:327 → durable-object.ts:286-291
                                     ├─ watcher.resolveWake(id, outcome)       :288 → watcher.ts:443-447
                                     └─ save()                                 :289
```

**Both POST routes are unreachable through the current regex** (`index.ts:125`) — see
Stage 1.

`acknowledge(id, nowMs)` — `wake-queue.ts:234-239` — sets `acknowledgedAt` and **leaves
the wake in `pending`** (at-least-once delivery). `resolve(id, outcome, nowMs)` —
`wake-queue.ts:242-252` — deletes from `pending` and terminalises; it is idempotent
(`:245-248`).

`terminalise` — `wake-queue.ts:316-324` — keeps `EXECUTED` / `ACKNOWLEDGED` /
`REJECTED`; every other outcome becomes `DISCARDED` (`:317`). Trims to `historyLimit`.

**No retry, no backoff, no DLQ.** The terminal history is the retained dead-letter log.

Downstream contract for a real executor: `idempotencyKeyFor(wakeId, attempt)` →
`tv-<wakeId>-a<attempt>` (`ids.ts:79-81`). **No production call site** — asserted only
by `watchers/test/watcher.test.ts:119-124` and
`watchers/test/adversarial.test.ts:317-323`.

## Health reporting

`GET /watchers/{id}/health` — `index.ts:312-314` → `WatcherObject.health()`
`durable-object.ts:295-306`:

```
assessHealth(input)                                       health.ts:98-171
   input assembled by Watcher.health                      watcher.ts:456-472
   checks, first match wins:
     stopped states                                        health.ts:108-119
     lastError present → ERROR                            health.ts:121-128
     heartbeat null or younger than graceMs → STARTING    health.ts:130-133
     consecutiveEvaluationFailures >= 3 → DEGRADED        health.ts:135-142
     lastMarketDataAt null or older than 60 s → STARVED   health.ts:144-154
     lastEvaluationAt null or older than 120 s → DEGRADED health.ts:156-163
     otherwise → HEALTHY                                  health.ts:165-170
   enriched with watcherId, status, configVersion,
   pendingWakes, staleAcknowledgements                    durable-object.ts:300-304
```

`staleAcknowledged(nowMs, olderThanMs = 30_000)` — `wake-queue.ts:310-314` — flags
acknowledged-but-unresolved wakes; surfaced by `Watcher.staleAcknowledgements`
`watcher.ts:450-452`.

## Async boundaries

| Boundary | Line | Kind |
| --- | --- | --- |
| DO RPC `onMarketEvent` | `index.ts:193` | `await`, one per (event, watcher) |
| `fetch` to the Python engine | `evaluator.ts:66` | `await` with an 8 s `AbortController` |
| `ctx.blockConcurrencyWhile` | `durable-object.ts:95` | DO initialisation barrier |
| `ctx.storage.get/put` | `durable-object.ts:121-125, 212-215` | synchronous KV |

## Exit points

- `Wake` records in DO storage.
- HTTP responses only. The worker performs **no** push delivery, declares no queue
  producer, and exports no `scheduled` handler.
