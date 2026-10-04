# Watchers

Cloudflare Durable Objects that decide **when** a bot should be woken.
They do not evaluate conditions (the Python engine does) and they
cannot trade.

```bash
bun run watcher:dev        # local, Miniflare
bun run watcher:test       # 99 tests, no Cloudflare runtime needed
bun run watcher:test:runtime   # Durable Object + Worker integration
bun run watcher:deploy
```

## What one object is

One object per `(userId, botId, deploymentId)`. The id is derived from
exactly that triple:

```ts
watcherIdFor({ userId, botId, deploymentId })  // 'w_1s2318mi6idam'
```

Deliberately **not** derived from the bot's condition tree, its name, or
its market. A watcher whose id changed when the user edited a condition
would silently become a second watcher, while the first kept waking on
a configuration nobody could see. Editing a bot updates the
configuration in place and bumps `configVersion`.

That also makes `POST /watchers` idempotent: a retried deploy updates
one watcher rather than creating a second, which is the failure that
produces duplicate wakes and duplicate orders.

## What is in the state

```
identity, watcherId, status, config (+ configVersion)
lastHeartbeatAt, lastMarketDataAt, lastEvaluationAt
lastSuccessfulEvaluationAt, lastWakeAt, lastConfigChangeAt
lastSequence, lastTimestamp          # ordering
lastConditionStatus                  # the latch
lastError, consecutiveEvaluationFailures
fireTimestamps                       # capped to one day
```

Pending wakes and terminal wakes are persisted separately. **Pending
wakes are persisted**, because a pending wake is a request to act:
losing one on a restart would silently drop a market event that
legitimately woke the bot, and the user would never find out.

Market history is deliberately **not** here. It belongs to the
condition engine; persisting candles in object storage would be slow,
expensive, and a second source of truth.

## The tick

```
market event
  -> accepted?       fresh, in order, right market, running
  -> due?            minEvaluationIntervalMs
  -> engine says?    TRUE / FALSE / UNKNOWN
  -> edge?           FALSE -> TRUE, not latched, not capped
  -> wake enqueued
```

Everything that would produce a wake from a non-edge, a duplicate, an
`UNKNOWN`, or a running cap is dropped here with a named reason, rather
than downstream where it would be a duplicate trade.

## Lifecycle

```
CREATED -> DEPLOYING -> RUNNING <-> PAUSED
                        |  ^
                     STOPPING
                        |
                     STOPPED -> (retry) -> DEPLOYING
any running state -> ERROR -> (retry) -> DEPLOYING
```

The table is explicit rather than derived, because "can I go from here
to there" is a product question. `start` during `STOPPING` **cancels**
the stop, because the alternative meant that pressing start after stop
left the watcher stopped and it took three presses to get it running.

## Health

A watcher that is alive and a watcher that is working are different
states, and conflating them is how a bot silently stops.

| State | Meaning |
| --- | --- |
| `HEALTHY` | Running, evaluating, receiving data |
| `STARTING` | Not old enough to be a problem |
| `STARVED` | Alive, no market data |
| `DEGRADED` | Alive, evaluations failing |
| `ERROR` | An error is outstanding |
| `STOPPED` | Not running |

`GET /watchers/{id}/health` returns the state, a summary, and the age
of each timestamp, so the UI can render "2.4s ago" without inventing
its own vocabulary.

## Security

Both tokens fail closed: no `AUTH_TOKEN` means no traffic, no
`MARKET_FEED_TOKEN` means `/feed` is closed. The market feed has its
own secret rather than a user token, because it is service-to-service
and routing it through the user path would let a user impersonate a
price feed.

Ownership is checked on every watcher route. A foreign watcher returns
404, not 403, because a 403 confirms the id exists.

## Testing

`npm test` (99 tests) runs with no Cloudflare runtime, because the
decision logic in `watcher.ts`, `wake-queue.ts`, `contract.ts` and
`health.ts` imports no Cloudflare types. That covers the parts that
actually break: duplicate delivery, a stale latch, a queue under
pressure, a restart, an edited configuration, and an unreachable
engine.

`npm run test:runtime` covers the plumbing — identity, storage,
routing, authorisation — inside real Miniflare. It is a **separate
command**: a suite that cannot start must report that it could not
start, never pass quietly.
