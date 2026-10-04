# Security review

Audited 2026-09. Scope: authentication, authorisation, secret handling,
input validation, CORS, and the specific ways this system could place
an order twice.

The short version: **no secret is stored anywhere a browser or a log can
read it, and no code path reaches LIVE.** The parts that are not yet
solved are named below rather than described as handled.

The one exception is deliberate and is the user's own key: TradingGOATs
does not hold an OpenRouter credential at all. The user pastes theirs into
their own browser and it goes from their browser to `openrouter.ai`.
What this document covers for that path is containment — the key does not
travel anywhere else, and no provider response is treated as the model's
own words. See §3.

---

## 1. The credential boundary

The rule: **a secret is never a value the browser can hold.** Not in a
response body, not in bot configuration, not in Durable Object state,
not in a log line, not in a URL.

The browser is told two things and two things only:

```
Credential: Hyperliquid account
Status:     Connected
Last verified: 2 minutes ago
```

`CredentialStatusReport` (`src/engine/core/credentials.ts`) is the only
shape that crosses the wire, and it has no field a secret could go in.
`assertNoSecrets()` runs on every value that is about to be serialised
and refuses anything with a secret-shaped key, a PEM block, or a
`0x`-prefixed 32-byte string. There is a test that forces an `apiKey`
into that shape and asserts the guard rejects it — a guard that is never
exercised is a guard that does not work.

`getCredentialForExecution()` is the only method that returns a secret,
and it is the only place allowed to. Every read is recorded, so "was
this key ever used?" is answerable after the fact.

### Ownership

A credential is scoped to `(userId, provider, label)`. Asking for
someone else's credential returns exactly the same message as asking for
one that does not exist, because a different message is an enumeration
oracle. Both are covered by tests.

### Rotation and invalidation

- A new or rotated secret is `UNVERIFIED`, never inheriting the previous
  key's verification. An unproven key must not trade on the strength of
  its predecessor.
- A credential the venue rejects is `INVALID` and its secret is cleared,
  so a rejected key does not sit in memory waiting to be tried again.
- Storing copies the secret, so a caller mutating its own object
  afterwards cannot change what the adapter later signs with.

---

## 2. What V0 does **not** have

Stated plainly, because a secret store that claims to be safe when it is
not is worse than none.

**`InMemoryCredentialStore` is not durable.** `durable()` returns
`false`, and a LIVE deployment must refuse to start on it. Secrets are
lost on restart. This is the correct V0 choice: the safest thing that
works without infrastructure.

**There is no real identity provider.** `AUTH_TOKEN` is one shared
secret standing in for one, and `X-User-Id` is taken from a header
under the assumption that a gateway verified it. Every caller is
therefore the same user. That is honest — there is only one user — but
it is **not** multi-user authentication, and it must not be described as
such.

### Required for production

| Need | Options | Note |
| --- | --- | --- |
| Per-user identity | An auth gateway issuing signed, expiring claims | The Worker verifies the claim, not a shared token. |
| Secret storage | Workers Secrets (per-worker, not per-user) or an external vault — AWS Secrets Manager, Infisical, GCP Secret Manager | **No in-process encryption scheme is provided.** A key in the same process as the data protects nothing, and shipping one would teach reviewers to trust a boundary that does not exist. |
| Key rotation | Provider-side rotation plus re-verification | Already modelled: a rotated key returns to `UNVERIFIED`. |

---

## 3. Execution safety

### Idempotency

Every order request must carry an `idempotencyKey`, derived from the
wake and the attempt number. It is **required at the boundary**, not
optional, because a retry after a lost response is how one intent
becomes two orders. The interface has no default, so no implementation
can skip it.

`HyperliquidDemoAdapter` implements this rather than assuming it. The
key is checked *before validation*, so a retry of a submission that was
already refused returns that same refusal instead of being re-measured
against a price that has since moved — otherwise the answer to "did my
order go through?" would depend on when it was asked. The outcome is
recorded under the key, including rejections, and a repeat returns the
recorded answer tagged `duplicate: true` so a caller can tell "already
done" from "done now". A key reused for different order content is
refused rather than answered with the earlier order, because reporting
success for something that was never sent is the one failure this must
not have. Tests: `testSubmissionIdempotency` in
`src/adapters/hyperliquid/executionTests.ts`.

`OrderResult` has an `UNKNOWN` outcome with `safeToRetry` alongside it.
`UNKNOWN` means *the venue may or may not have accepted this*, and the
correct response is to reconcile by idempotency key, not to resubmit.
An adapter that maps a timeout to `REJECTED` is a bug, and `reconcile()`
exists on the interface so the correct action is available.

### LIVE

- `runPipeline` takes the environment as a parameter and refuses
  anything but `DEMO`. No environment variable, build flag, or
  `NODE_ENV` reaches it.
- The `ExecutionAdapter` interface has `readonly mode`. There is no
  `setMode`, `enableLive`, or `activateLive` — a one-line way to reach
  LIVE from anywhere holding a reference. A test greps for those names.
- `TRADINGV_LIVE_TRADING` is documented in `.env.example` as having no
  effect, and is deliberately **not** given a value there. A test
  asserts both.
- A GOAT deployment in `LIVE` mode is **refused**, at both
  `validateGoatDeployment` and `deployGoat`, and the refusal names what to
  do instead. `LIVE` used to be an accepted mode that quietly set
  `canExecute: true` on a deployment with no signing path behind it: a
  label promising something the product cannot do, and the failure is
  silent because everything looks configured. Refusing it means the day a
  signing service exists, the line has to be removed deliberately, with
  its tests, instead of LIVE becoming real because someone built the other
  half. `DEMO` and `PAPER` remain available; neither claims to touch real
  value.

### The venue environment

Hyperliquid runs the same markets on two networks, one of which holds
real value, and the two differ by a single hostname. So the environment
is **one decision in one module**: `src/config/venue.ts` resolves it,
holds the endpoint table, and every adapter derives its URLs from the
resolved value. No caller can pass a base URL, so there is no way to
send a Mainnet request to a Testnet client.

- An unrecognised `VITE_HYPERLIQUID_NETWORK` resolves to `MAINNET`, not
  to a guess between the two. A typo must never silently point a
  deployment at the network the user did not choose. Case and whitespace
  are tolerated, because a lowercase value in a `.env` file should not be
  a support ticket.
- `assertSameVenue(expected, actual, context)` is what a deployment calls
  before it may act, and throws rather than warning. A stale client
  cannot send a Testnet order into a Mainnet session.
- `GoatDeployment.venueEnvironment` records the environment the
  deployment was made against. Read at the moment of action instead, the
  answer to "which network was this decided on?" would depend on when you
  ask.
- Switching environment drops the socket, the subscriptions, the discovery
  memo, the cached series and quotes, and the candle sequence memories
  together. Nothing crosses over, because a client that came back from a
  network switch carrying candles from the venue it left is a chart with
  two environments on it.

### A feed that has gone quiet

A websocket can be open and receiving nothing, and a UI that only
distinguishes connected from disconnected will keep showing a
last-known price as though it were live. So `STALE` is a state rather
than an absence, `getConnectionState()` reports it with the silence
duration and the host it is talking to, and a message from the venue
clears it.

Two related failures are handled because a socket is not an ordered
stream: candles that are not newer than the last accepted one for their
market and timeframe are dropped rather than normalised into a bar
update, and a deliberate disconnect during a handshake invalidates the
attempt in flight — otherwise the socket finishes opening after the user
closed it, and reports an error five seconds later for a connection that
was already gone. `connectionEpoch` is what makes "this attempt is over"
checkable rather than a hope about ordering.

### Provider output never becomes model output

The OpenRouter key is the user's own and is sent from their own browser
straight to `openrouter.ai`. That is the design; the job is narrow and
absolute — the key goes to OpenRouter and nowhere else.

- The credential travels only in the `Authorization` header, never in the
  request body where it could be logged. A test asserts both halves.
- Provider error text never enters `AIResponse.content`. `content` is
  what the agent runtime treats as the model's words: it is reasoned over
  and written to the timeline, so a provider page echoed in there is
  indistinguishable from the model having said it. Failures are returned
  in a structured `error` whose message was written for a person.
- A non-`2xx` response has its body read and discarded. A provider error
  page can echo the credential that was sent to it, and there is no
  version of surfacing it that is safe.
- The thrown error is logged as a redacted one-line summary, never as the
  object. `console.error(error)` in a browser is enough to put a provider
  payload into a console users paste into issue reports.
- Persisted configuration is validated field by field. A blind spread of
  `localStorage` puts an object where a string belongs, and a truthy
  object reads as a perfectly good key.
- `hasApiKey()` checks shape, not length. "Has a key" is the question the
  whole interface turns on; a key that is present but wrong should be
  reported as wrong before a request is made, not discovered as a 401.

Tests: `src/adapters/openrouter/tests.ts`, including a provider that
reflects the credential back — the worst case, and entirely within a
provider's rights to do.

### Policy and risk

The kill switch was found to be wired to the React state but not to
`riskManager`, so the header said "Trading is halted" while orders kept
filling. Both now move together, and the emergency flatten engages the
engine switch **before** submitting any closes, so a close cannot race a
new open. Tests assert the ordering in the source.

---

## 4. Input validation

| Surface | Validation |
| --- | --- |
| Condition trees | The committed JSON Schema, `additionalProperties: false`, on both sides. A tree is validated in the browser, again at the Worker, and again by the engine. |
| Watcher config | Ranges enforced and *reported*, not clamped: an out-of-range value gets a 422 listing the problem. |
| Market events | Rejected unless fresh, in order, for the right market, and from a running watcher. Each rejection has a named reason. |
| Order requests | Idempotency key, positive finite volume, and a limit price for a limit order. |
| Feed batches | Capped at 1000 events per request. |

**Prototype pollution**: condition trees are validated against a schema
with `additionalProperties: false` before any property is read, and
every traversal is over an explicit allowlist. No `Object.assign` of
request bodies.

**Path traversal**: no endpoint accepts a filesystem path.

**SSRF**: the engine reads a fixed, configured Hyperliquid endpoint. The
caller cannot supply a URL.

---

## 5. Logging

Redaction happens in `Logger.write`, **before** the record reaches any
sink. Redacting in the sink means every other sink — a custom one, a
file appender, an aggregator — receives the raw value. Centralising it
only works if it happens first; that bug was found and fixed during this
audit.

Redacted: PEM blocks, `0x`-prefixed 32-byte keys, labelled secrets
however they are spelled, and `Bearer`/`Basic` headers. The bearer rule
runs before the labelled rule, because the labelled rule would otherwise
match `Authorization:` and consume only the `Bearer` scheme, leaving the
token behind.

Error causes are serialised as a **category only**, never a message. A
cause chain can carry a response body, and a response body can carry a
credential echo.

Not logged: secrets, private keys, authentication tokens, full credential
objects, or order sizes with a position reference.

---

## 6. CORS and transport

- An allowlist, never `*`. A wildcard origin plus a bearer token in the
  browser is any site acting as the user.
- `Cache-Control: no-store` on health and pending wakes. A cached health
  response would show a watcher as running after it stopped.
- Constant-time comparison for both tokens, so a mismatch does not leak
  by timing.

---

## 7. Rate limiting

| Level | Limit | Rationale |
| --- | --- | --- |
| Wake, per watcher | 60/hour, 1440/day, contract-enforced | One broken bot cannot flood the pipeline. |
| Evaluation, per watcher | 1s floor | Below this a watcher re-evaluates on every market event. |
| Config size | 200 condition nodes | Bounds the compute a single bot can demand. |
| Wake queue | 100 slots, 5-minute expiry | A consumer that falls behind is bounded, not unbounded. |
| Feed batch | 1000 events | |
| Endpoint | **None** | Loopback-only engine; the Worker relies on Cloudflare edge limits. **Not implemented at the application layer.** |

---

## 8. Open items

| Item | Severity | Note |
| --- | --- | --- |
| Engine mutating endpoints unauthenticated | YELLOW | Loopback only, blast radius is wake frequency. Authenticate before exposing. |
| `AUTH_TOKEN` is a single shared secret | YELLOW | Not multi-user auth. Needs a real IdP before more than one user. |
| No secret manager | YELLOW | `InMemoryCredentialStore` is not durable. Needs a real vault. |
| No application-layer rate limiting | YELLOW | Edge limits only. |
| No CSRF token | GREEN | The API is bearer-token authenticated with no cookie, so CSRF does not apply. |
| Secrets in DO state | GREEN | Verified by test: the watcher state machine contains no reference to credential material. |
| No order-signing service | YELLOW | The reason LIVE is refused rather than merely disabled. Adding one means removing the refusal deliberately, with its tests. |
| OpenRouter key in `localStorage` | GREEN | BYO key held in the user's own browser by design; no proxy, no server copy. Shape-validated, and `clearApiKey()` removes it from disk. |
| Deployments without a recorded venue | GREEN | `venueEnvironment` is optional so pre-existing deployments still load. Absent means unrecorded, and is checked rather than assumed to be Testnet. |
