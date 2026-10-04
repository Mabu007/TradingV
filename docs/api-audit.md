# API audit

Every HTTP surface in TradingGOATs, what it requires, and what it can
change. Audited 2026-09.

Two surfaces exist: the Python condition engine (local, unauthenticated
by design because it holds no credentials) and the Cloudflare watcher
Worker (authenticated, because it can start and stop bots).

---

## 1. Condition engine — `http://127.0.0.1:8099`

The engine reads public market data and decides *when* to wake the AI. It
holds no credential, signs nothing, and has no execution path. That is
why it is unauthenticated: an unauthenticated service that can only
read public prices and write to its own memory has nothing worth
stealing. Binding it to `127.0.0.1` is part of that reasoning, and
`TRADINGV_ENGINE_HOST` should not be set to a public interface.

| Method | Path | Auth | Mutates trading state? | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | No | No | Reports `placesOrders: false`, `holdsCredentials: false`. |
| GET | `/catalogue` | No | No | Condition vocabulary for the builder. |
| GET | `/schema` | No | No | The committed schema, verbatim. |
| GET | `/timeframes` | No | No | Supported timeframes. |
| GET | `/instruments` | No | No | What the venue lists. `?refresh=true` re-discovers. |
| GET | `/fixtures` | No | No | The samples a draft can be tested against. |
| POST | `/test` | No | No | Evaluates a **fixture**, never a live market. |
| POST | `/evaluate` | No | No | Evaluates cached data for a watched market. |
| POST | `/trackers` | No | **Yes** | Registers a tracker. See below. |
| GET | `/trackers` | No | No | Lists registered trackers and their trees. |
| DELETE | `/trackers/{id}` | No | **Yes** | Stops a tracker being watched. |
| GET | `/trackers/{id}/status` | No | No | Debounce state, caps, last status. |
| POST | `/trackers/{id}/evaluate` | No | No | Re-evaluates without waiting for a tick. |
| GET | `/wakes` | No | No | Recent `AI_WAKE` events. |
| POST | `/wakes/{id}/ack` | No | No | Records delivery. The app is never told what it decided. |
| GET | `/events` | No | No | The engine's own timeline. |
| GET | `/status` | No | No | What is being watched. |

### Findings

**The mutating endpoints are unauthenticated.** `POST /trackers` and
`DELETE /trackers/{id}` can change what the engine watches. On loopback
this is acceptable, and the engine cannot trade, so the worst case is
"someone makes a bot wake more often than the user intended". Before
this is exposed on any network, these two endpoints need
authentication. **This is a YELLOW item, not a RED one**, precisely
because the blast radius is wake frequency rather than money.

**No rate limiting.** There is no limit on requests. The engine is
loopback-only and each request is cheap, so this is acceptable for V0
and must not be.

**`/trackers` returns the full condition tree.** The tree is
market data the user wrote, not a secret, so this is fine. It is called
out so nobody later adds a credential field to a tracker config and
exposes it here.

---

## 2. Watcher Worker — Cloudflare

Authenticated, because it starts and stops bots. Two tokens:

| Secret | Purpose | If unset |
| --- | --- | --- |
| `AUTH_TOKEN` | User API requests | **All traffic refused** (fails closed) |
| `MARKET_FEED_TOKEN` | Price feed | **`/feed` returns 503** (fails closed) |

| Method | Path | Auth | Mutates | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | No | No | Liveness. Deliberately unauthenticated. |
| POST | `/feed` | Feed token | **Yes** | Routes market events to watchers. |
| GET | `/watchers` | User | No | The caller's watchers, with health. |
| POST | `/watchers` | User | **Yes** | Deploy or update. Idempotent on the identity. |
| GET | `/watchers/{id}` | User + owner | No | Full state. |
| GET | `/watchers/{id}/health` | User + owner | No | Health with ages. |
| POST | `/watchers/{id}/start` | User + owner | **Yes** | Idempotent. |
| POST | `/watchers/{id}/pause` | User + owner | **Yes** | Discards pending wakes. |
| POST | `/watchers/{id}/resume` | User + owner | **Yes** | |
| POST | `/watchers/{id}/stop` | User + owner | **Yes** | Discards pending wakes. |
| POST | `/watchers/{id}/retry` | User + owner | **Yes** | From `ERROR` or `STOPPED` only. |
| GET | `/watchers/{id}/wakes` | User + owner | No | Pending wakes. |
| POST | `/watchers/{id}/wakes:claim` | User + owner | **Yes** | Acknowledges for delivery. |
| POST | `/watchers/{id}/wakes:resolve` | User + owner | **Yes** | Records the outcome. |

### Authorisation

Every watcher route checks that the watcher's own `identity.userId`
matches the authenticated user **before** any read or write. The
durable object id is a digest, so knowing it is not proof of ownership.

A watcher belonging to someone else returns **404, not 403**: a 403
confirms the id exists, which is an enumeration oracle. There is a test
asserting the two responses are byte-identical.

### CORS

An allowlist from `ALLOWED_ORIGINS`, never `*`. A wildcard would let any
site make authenticated requests on a user's behalf, because the browser
sends the token. A disallowed `Origin` simply gets no CORS headers, so
the browser blocks it.

### Idempotency

`POST /watchers` is idempotent on `(userId, botId, deploymentId)`, and
the Durable Object id is derived from exactly that triple. A retried
deploy updates one watcher rather than creating a second — which is the
failure that produces duplicate wakes and duplicate orders.

---

## 3. No administrative surface

No endpoint exposes: secrets, raw credentials, another user's data,
arbitrary SQL, a shell, a file path, or a deployment mutation for a
market the caller does not own. There is no endpoint that places,
cancels, or sizes an order, in either service.

## 4. Deliberately absent

| Not present | Why |
| --- | --- |
| Order placement | Execution is not in V0. When added, it is a separate authenticated service, not an endpoint on either of these. |
| Credential storage on the engine | The engine cannot trade, so it has nothing to authenticate with. |
| Webhooks | Nothing in V0 sends anything to a third party. |
| Batch endpoints | A `POST /trackers:batch` would be a way to exceed rate limits; add one only with a batch-specific limit. |
