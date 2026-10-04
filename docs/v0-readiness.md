# V0 readiness report

2026-09-29. Against `bun run verify`, the full Bun suite, the Python
suite, the watcher suite, `lint`, and `build`.

---

## GREEN — proven working

| Area | Evidence |
| --- | --- |
| **Condition contract** | One schema, `shared/condition_schema_v1.json`, read by both sides. The browser derives its vocabularies from it. 37 parity tests run the real Python engine and compare states. |
| **Three-state evaluation** | `TRUE` / `FALSE` / `UNKNOWN` with `UNKNOWN` distinct from `FALSE` in every group operator. 366 Python tests. A group whose conditions are all disabled reports `UNKNOWN`, so a half-built bot is inert rather than armed. |
| **Execution idempotency** | `idempotencyKeyFor(wakeId, attempt)` is stable across retries and differs for a new trade. Required at the boundary, no default. |
| **Duplicate suppression** | A wake id is derived from `(watcher, marketEvent, configVersion)`, so redelivery and restart replay cannot wake twice. Tested at 20× redelivery and across 5 restarts. |
| **Watcher lifecycle** | An explicit table, validated, with no dead ends. A fresh watcher stuck in `CREATED` was found in the first pass; a watcher stranded in `STOPPING` was found in this one — `isIdempotentNoOp` short-circuited the real `STOPPING --stop--> STOPPED` edge, and the "drain" the code comment relied on does not exist anywhere. Both fixed, both verified against real Miniflare. |
| **Watcher health** | `HEALTHY` / `STARVED` / `DEGRADED` / `ERROR` / `STARTING` / `STOPPED`, derived from timestamps. An alive-but-starved watcher is not reported healthy. |
| **Durable Object runtime** | Verified against real Miniflare: deploy → `DEPLOYING` → start → `RUNNING` → market event routed → evaluated → health reported. Idempotent redeploy. |
| **Authorisation** | Ownership checked before every read and write. A foreign watcher returns 404 byte-identical to a missing one. |
| **Secret containment** | 36 tests. Redaction happens before the record leaves the logger, so no custom sink can receive raw data. |
| **LIVE isolation** | `runPipeline` refuses anything but `DEMO`. The `ExecutionAdapter` has `readonly mode` and no setter. `TRADINGV_LIVE_TRADING` is documented as inert and has no value to set. |
| **DEMO end to end** | wake → policy → risk → DEMO fill → position → history, plus exposure, kill-switch, untradeable-market, LIVE, HOLD, and incomplete-proposal rejections. All offline, all deterministic. |
| **UI** | Drove the real app in headless Chrome: Bots → Create Bot → Manual Build → condition card → Test this, with the engine answering. Both themes render from tokens (dark `rgb(7,11,19)`, light `rgb(244,246,251)`), 390px has no horizontal overflow, and 0 console errors / 0 uncaught exceptions. |
| **ATR** | Wilder's RMA, alpha = 1/period, matching the engine. The browser computed an **EMA** of true range (alpha = 2/(period+1)) — same seed, ~6% divergence after it. Fixed, with a hand-written reference and a test that fails if it is ever an EMA again. |
| **24h statistics** | `change24h` is computed against the venue's own `prevDayPx`. It was a hard-coded `0`, and `high24h`/`low24h` echoed the current price, so "24h High" always equalled the live price. Now `NaN` when there is no range, which the UI renders as unavailable. |
| **Daily-loss limit** | The gate reads a realised, UTC-day-scoped figure. It read a field **nothing ever wrote**, so the check was `0 <= -maxDailyLoss` and could not fire at any loss. Wired to the one point where the adapter realises P&L. |
| **Rate limiting** | Per-caller budgets per route class, in a Durable Object so the read-modify-write is serialised. Verified live: 30 lifecycle calls, then `429` with `Retry-After: 58`. |
| **Engine trust boundary** | A non-loopback bind is refused at startup unless `TRADINGV_ENGINE_ALLOW_PUBLIC` is set by name. A default is a convention; this is a control. |

## YELLOW — working, needs operational attention

| Item | Why it is yellow |
| --- | --- |
| **One shared `AUTH_TOKEN`** | Not multi-user authentication. Every caller is the same user because there is only one user. Honest, but it must not be described as auth. |
| **No secret manager** | `InMemoryCredentialStore.durable()` is `false` and secrets are lost on restart. The interface is right; the backing store is not production. |
| **Engine mutating endpoints unauthenticated** | Still open, and that is the correct V0 trade: the blast radius is wake frequency, not money. The boundary is now *enforced* rather than assumed — a non-loopback bind refuses to start. |
| **Two live condition evaluators** | The builder previews through the Python engine, which is the authority; the agent runtime decides wakes with the legacy browser evaluator. Their vocabularies differ, so they cannot silently disagree about a shared condition. This is now documented at the top of `conditions.ts` instead of being reported as an unqualified risk. |
| **Browser condition evaluator** | `src/engine/agents/trackers/conditions.ts` is a second implementation of a subset of the language, still used by the agent tracker path. The largest remaining duplication. |
| **Load and soak** | Measured, not asserted. 100 bots × 5 markets × 5,000 events = 100,000 ticks in ~3.4s (p50 0.007ms, p95 0.040ms, p99 0.093ms), heap 13MB → 27MB, peak queue depth 31 of a 100 cap, 12,000 wakes emitted and 12,000 correctly expired unclaimed. A 20× latency margin absorbs a noisy machine. This is a local synthetic run and says nothing about production capacity. |
| **First content at ~16s** | The app mounts an empty root for about 16 seconds while boot work finishes, so a slow first load shows a blank page. No error, no spinner. |
| **Worker runtime tests do not run here** | `npm run test:runtime` exists and is correct, but this environment's `workerd` lacks `node:vm`, so the pool cannot start. It is a **separate command from `npm test`** precisely so a missing runtime is reported as a missing runtime and never as a green suite. |
| **Starter condition text** | The starter is now **disabled** rather than replaced, because any level specific enough to be worth saving implies a view about when to trade, and the user has not expressed one. A disabled-only group reports `UNKNOWN`, so it cannot fire. The card renders it struck through with its toggle off — verified in the browser. The sentence still reads "price at or above 0", which is a weak placeholder. |
| **AI provider is user-supplied** | No key, the assistant falls back to algorithmic advice. Not a security issue; worth knowing. |

## RED — prevents real-money execution

**One item, and it is large.**

> **No exchange is connected, and the path to one has not been built or
> tested.**

Everything below it exists and is tested; the thing above it does not.
Specifically, before real orders:

1. **A real exchange adapter implementing `ExecutionAdapter`.** The
   interface is defined and the demo adapter satisfies the semantics;
   no venue adapter exists, so the interface has never been proven
   against a real API's quirks.
2. **A real secret store.** See YELLOW. `durable() === false` must block
   a LIVE deployment, and nothing enforces that yet.
3. **Real authentication.** One shared token cannot support two users.
4. **Reconciliation tested against a real exchange.** `reconcile()` and
   `UNKNOWN` are modelled and unit-tested against a fake. The
   lost-response case — the one that produces duplicate orders — has
   never been observed from a real venue.
5. **Soak and load evidence at production scale.** There is now a local
   synthetic run (see YELLOW) that shows the decision path is not the
   bottleneck. It is one machine, one process, and no Durable Object
   latency, so it does not substitute for a load test against the
   platform.
6. **A third-party security review.** The review in `docs/security.md`
   is a competent internal pass, not an assessment.

---

## Test matrix — exact counts

Everything below was executed in this run.

| Suite | Command | Result |
| --- | --- | --- |
| Audit regressions | `bun run test:audit` | **80 passed, 0 failed** |
| Condition parity | `bun run test:conditions` | **37 passed, 0 failed, 0 skipped** |
| Python engine | `server/.venv/bin/python -m pytest server` | **366 passed** |
| Pipeline acceptance | `bun run test:pipeline` | **13 passed, 0 failed** |
| Security boundary | `bun run test:security` | **36 passed, 0 failed** |
| Watcher logic, adversarial, rate limit, concurrency, soak, hygiene | `bun run watcher:test` | **138 passed (138)** |
| Type check | `bun run lint` | clean |
| Watcher type check | `bun run watcher:typecheck` | clean |
| Build | `bun run build` | built in 51.85s |
| Durable Object integration | `bun run watcher:test:runtime` | **NOT RUN** — `workerd` in this environment fails to import `node:vm`, so the pool cannot start. Not converted into a pass. The equivalent flow was verified by hand against real Miniflare: deploy → `DEPLOYING` → start → `RUNNING` → stop → `STOPPING` → stop → `STOPPED` → start → `RUNNING` → pause/resume → retry, plus feed routing, health, ownership (404) and the rate limiter. |
| Live discovery | `bun run test:hyperliquid:discovery` | not run (requires network) |

**Total: 550 automated assertions passing, 0 failing, 1 suite
unrunnable and reported as such.**

The Durable Object integration tests are written
(`watchers/test-runtime/worker.test.ts`, 21 cases) and are excluded from
`npm test` by design. A green `npm test` therefore means "the decision
logic is proven", and `npm run test:runtime` means "the plumbing is
proven". They are not the same claim, and collapsing them would be the
false-green this project is trying to avoid.

---

## Production API-key readiness

```
SAFE TO BEGIN REAL API INTEGRATION:   YES
SAFE TO EXECUTE REAL ORDERS:          NO
```

These are different questions and the answers are different.

**Begin real API integration — yes.** The boundary exists and is
enforced:

- `ExecutionAdapter` is the only thing that can talk to a venue, and it
  has no mode setter.
- `idempotencyKey` is required at the boundary. The lost-response case
  is modelled with a distinct `UNKNOWN` outcome and a `reconcile()`
  path.
- The browser is structurally incapable of holding a secret:
  `CredentialStatusReport` has no field for one, `assertNoSecrets()`
  runs on serialisation, and redaction happens before a log record
  leaves the logger.
- A credential belongs to one user, and asking for someone else's
  returns the same answer as asking for one that does not exist.
- LIVE is refused in code, not by configuration.

Writing the first real adapter is a contained piece of work against a
defined interface, and the tests that matter — idempotency, timeout,
reconciliation, credential ownership — already exist and run against a
fake that can be swapped for the real venue.

**Execute real orders — no.** Four things stand between here and there,
and all four are RED: no real adapter, no real secret store, no real
authentication, and no observed lost-response behaviour from a real
exchange. Building the adapter is necessary and not sufficient; the
system has to be run against a real venue and watched before it is
trusted with money.

---

## Additions in this pass

| Finding | Outcome |
| --- | --- |
| **Discovery crashed on the venue's real response** | `perpDexs` returns a list whose **first element is `null`**. Discovery called `.get` on every element, so `AttributeError`, and every market list failed. Found only by driving the browser. Fixed; 55 tradeable markets now load. |
| **A 500 carried no CORS headers** | Starlette's server-error middleware sits outside the CORS middleware, so a failed route lost its headers and the browser reported a bare CORS failure. Now a 500 is returned *with* CORS headers and a correlation id, and the traceback is logged. The allowlist is still enforced on the error path. |
| **A watcher could never finish stopping** | `isIdempotentNoOp` treated `STOPPING --stop--> STOPPED` as a repeat and short-circuited a real transition, so a stopped bot reported "stopping" forever. The comment claimed a drain would complete it; no such drain exists. Fixed, verified against real Miniflare. Two existing tests had encoded the dead state and were corrected. |
| **One malformed cache entry destroyed the whole history** | `void super.append(...)` inside a `try`: the rejection happened in a promise, so the `try` never saw it. An unhandled rejection *and* a failed constructor. Found because fixing a test helper accidentally made a previously-unreached test run. |
| **`recentInputIds` grew without bound** | Written once per tracker per market event, never evicted, while `processedEvents` was capped. Bounded the same way. |
| **`TrackerRuntime.dispose()` threw** | "Method not implemented", so a started runtime could not be detached and kept consuming events. Implemented as a real teardown. |
| **Deployment ids could collide** | `Date.now()` alone. A collision does not merely lose a row: the id is one third of the watcher's Durable Object identity, so two deployments would merge into one object. Now carries a monotonic counter. |
| **`signOut` only logged** | A mock with no session and no caller, but a log line that reads as a completed sign-out. Now throws rather than pretending. |
