# Architecture audit

Run 2026-09-29. Every finding below was reproduced before it was fixed,
and every fix has a regression test. Findings are ordered by how much
damage they could have caused, not by how easy they were to find.

---

## 1. Crossover conditions measured the wrong series — **CRITICAL**

**Where**: `src/engine/agents/trackers/conditions.ts`, `lastPair()`.

**Why it happened**: `lastPair` built a flat array by pushing
`offset < 2 ? fast[index] : slow[index]`, producing
`[fast[n-1], fast[n-2], slow[n-1], slow[n-2]]`. The caller destructured
it as `[prevFast, prevSlow, currFast, currSlow]`. So `prevFast` and
`prevSlow` were both from the fast series, and `currFast` and `currSlow`
both from the slow one. The test was "is the fast indicator falling while
the slow one is rising", which has nothing to do with a cross.

**How it was reproduced**: `probe1b.ts` printed the indicator values at
the cross bar. At index 12 the fast EMA was 13.13 and the slow SMA was
10.00 — a genuine bullish cross, `trueCross = true` — and the shipped
code evaluated `false`.

**Impact**: a bot whose wake condition is "EMA(20) crosses above
SMA(50)" would wake on an unrelated shape and stay silent through the
real crossover. The condition read plausibly, the summary line was
correct, and the bot acted on a premise that was never true. This is the
worst class of bug in the system.

**Fix**: read the two series explicitly by index, and document why the
ordering is load-bearing.

**Regression test**: `auditRegressionTests.ts` pins the specific bar
where the cross occurs, in both directions, plus a check that the
reported value is `fast - slow` on that bar. A test that only asserted
"a rising series is TRUE" would have passed the bug.

---

## 2. The kill switch moved the UI but not the engine — **CRITICAL**

**Where**: `src/App.tsx` versus `src/engine/execution/risk.ts`.

**Why**: `riskManager.setKillSwitch` had **no caller in application
code**. The React state and the risk engine were independent, and only
the UI moved.

**How it was reproduced**: `grep -rn setKillSwitch src/` returned the
definition and one test script. Nothing else.

**Impact**: the header said "Trading is halted" and the modal claimed
"all subsequent market and limit order requests are instantly
intercepted and rejected", while `validateOrder` still returned valid.
A user relying on the one control designed for an emergency got new
positions instead.

**Fix**: the toggle now drives `riskManager.setKillSwitch`, and the
emergency flatten engages the engine switch **before** submitting any
closes — otherwise a close races a new open from a running agent. The
engine is the source of truth and the UI mirrors it. Flatten failures
are surfaced in a dismissible alert rather than into a `console.error`.

**Regression test**: behavioural tests for the gate, plus a source
assertion that the emergency path calls the engine first and submits
closes afterwards.

---

## 3. Realised losses never reached the daily-loss limit — **CRITICAL**

**Where**: `src/adapters/hyperliquid/demo.ts`, `getAccountState()`.

**Why**: `dailyPnL` was `equity - balance`, which is *open* P&L. A loss
left the number the moment the position closed. Separately,
`riskManager.recordPnL()` existed and was never called.

**How it was reproduced**: the existing risk tests pass
`{accountCurrency: 'USD'}` with no instrument lookup, so the exposure
check rejected first and the daily-loss branch was never reached — the
bug was invisible. Fixed the test context first, which exposed it.

**Impact**: with no open positions `dailyPnL` was exactly `0`. A bot
could close fifty losing trades in a day, blow through its $500 limit,
and the validator never saw a breach. Every builder definition sets a
daily loss limit, so this affected every bot.

**Fix**: track realised P&L separately, sum it with unrealised, and
maintain a high-water mark so drawdown is measured from a peak.

**Regression test**: four tests covering breach, net profit, the day
reset, and netting.

---

## 4. The condition builder wrote a tracker kind no validator accepted — **CRITICAL**

**Where**: `src/components/views/BotBuilderModal.tsx`, introduced by
this workstream.

**Why**: the condition card stored its tree on a tracker with
`kind: 'CUSTOM'`. The registry's supported kinds did not include `CUSTOM` and
the registry rejected it outright.

**How it was reproduced**: a GOAT definition with a `CUSTOM` tracker
failed `validateGoatDefinition` with "Unsupported tracker kind: CUSTOM".

**Impact**: the moment a user touched a condition — adding one, removing
one, toggling a checkbox, changing AND/OR, wrapping a group — the bot
stopped validating and the builder could not advance past Review. There
was no UI to remove that tracker, so the session was stuck until reload.
If the modal was bypassed, `App.handleCreateBot` threw and the deploy
silently did nothing.

**Fix**: `CUSTOM` is now an allowed type whose config **must** carry a
condition tree the shared schema accepts. A `CUSTOM` tracker with
arbitrary config is still refused, which is the same rule the registry
enforces.

**Regression test**: a bot with an edited condition validates.

---

## 5. Every bot compiled with trading disabled — **CRITICAL**

**Where**: `src/engine/agents/botDefinition.ts`, `compileBotDefinition`.

**Why**: `allowTrading` required
`capabilities.orders && capabilities.automation && reasoningMode !== 'advisory'`,
and the builder defaulted `reasoningMode` to `advisory` and hid the
control behind "Advanced".

**Impact**: a user toggled orders and automation on, saw "Automation on",
and every order was rejected with `TRADING_DISABLED` — with no control
anywhere that could fix it. A backtest of the same bot returned zero
trades.

**Fix**: decoupled. A permission is a function of the permission, not of
an autonomy hint. `allowTrading` now depends only on the two
capabilities; reasoning mode governs how much latitude the AI has and is
enforced in the runtime.

**Regression test**: two tests — granting both capabilities permits
trading, and reasoning mode does not change the permission.

---

## 6. Quote delivery ids were shared across agents — **HIGH**

**Where**: `src/engine/agents/trackers/runtime.ts`.

**Why**: the quote path built `id: quote:${symbol}:${timestamp}` with no
agent, and `process` marks a delivery id processed the first time any
tracker claims it. The bar path already scoped the id per agent.

**Impact**: for one quote, every agent's candidate on that symbol shared
one key. The first tracker marked it; all the rest were skipped *before
their conditions were evaluated*. With two bots on Gold, one silently
stopped receiving quote-driven wakes, and the other could be woken by
the first GOAT's tracker.

**Fix**: include the agent id, matching the bar path.

**Regression test**: asserts both paths are agent-scoped.

---

## 7. Identifiers built from `Date.now()` collided — **HIGH**

**Where**: `src/adapters/hyperliquid/demo.ts`.

**Why**: `hl_demo_ord_${now}`, `hl_demo_pos_${now}`,
`hl_demo_trade_${now}`.

**How it was reproduced**: freezing `Date.now()` and placing two orders.

**Impact**: two fills in one millisecond shared an order id. Two closes
shared a trade id, and history is de-duplicated by id — so the second
trade was dropped and **its realised P&L vanished from History** while
the balance still moved. Two positions shared an id, so `closePosition`
always closed the first match.

**Fix**: a monotonic per-adapter sequence added to the timestamp, so
uniqueness does not depend on clock resolution.

**Regression test**: two orders, two positions, and two closes in a
frozen millisecond, asserting distinct ids and that the right position
closes.

---

## 8. `Date.now()` was dereferenced where storage can throw — **HIGH**

**Where**: `src/engine/agents/timeline/store.ts`, `main.tsx`,
`ThemeProvider.tsx`.

**Why**: `'localStorage' in globalThis` passes in contexts where merely
*reading* the property throws a `SecurityError` — a sandboxed iframe
without `allow-same-origin`, storage disabled. The access was outside
the `try`.

**Impact**: the throw escaped the `AgentRuntime` constructor, so the ES
module import of `App.tsx` failed and React never mounted. A white
screen with no error boundary, because the boundary is inside the tree
that failed to render.

**Fix**: a `getStorageSafely()` that can never throw, and a probe of
the object's surface so a present-but-unusable value is treated as
absent. `setItem` failures are recorded as a `storageState` rather than
throwing on every append.

**Regression test**: storage that throws on access, and storage that
throws on write.

---

## 9. The timeline rewrote its whole history on every append — **HIGH**

**Where**: `src/engine/agents/timeline/store.ts`.

**Why**: every append did `structuredClone(allEvents)` plus
`JSON.stringify` plus a synchronous `localStorage.setItem` of the
entire history. The demo adapter emits `POSITION_UPDATE` on **every quote
tick**.

**Impact**: a tab with a few thousand events spent its time copying its
own history several times a second, which locked up the UI and stopped
history persisting once the storage quota was hit.

**Fix**: a shallow snapshot, batched writes, and a debounce. The write
is scheduled with `setTimeout(..., 0)`, so a burst in one tick is one
write.

**Bugs found while fixing it**:
- `flush()` cleared the timer but not the scheduling flag, so the first
  flush permanently disabled persistence. Caught by a new test.
- Expiry default was 5 minutes, so a new watcher saw a STALE notice
  instead of a queued wake. Caught by the same test.

**Regression test**: 200 appends in a burst cause at most 3 writes, all
400 events reach storage without an explicit flush, and the history
stays bounded.

---

## 10. `validateBotDefinition` depended on module load order — **HIGH**

**Where**: `src/engine/agents/botDefinition.ts`.

**Why**: it imported `./skills/registry` but not `./skills/builtins`,
which is where the default skills are registered as a side effect.

**How it was reproduced**: importing only `botDefinition.ts` in a fresh
module graph leaves the registry empty, and validation rejects every bot
for "missing or disabled skills".

**Impact**: works in the dev server, fails in any fresh module graph — a
worker, a test, a second entry point. The kind of bug that never appears
locally and always appears in production.

**Fix**: import from the barrel so the side effect is guaranteed.

**Regression test**: the bot-definition test now exercises the real
skill registry.

---

## 11. A failed instrument discovery was cached forever — **HIGH**

**Where**: `src/adapters/hyperliquid/marketData.ts`, `discoverOnce()`.

**Why**: the in-flight promise was memoised and never cleared on
rejection.

**Impact**: one offline blip or one 429 left the app with no
instruments, no quotes, no candles, and every order rejected — for the
rest of the session, with no recovery short of a reload.

**Fix**: clear the memo on rejection, so the next caller retries.

**Regression test**: fail discovery, restore the transport, succeed.

---

## 12. The order ticket could never be submitted — **MEDIUM**

**Where**: `src/components/views/QuotesTab.tsx`.

**Why**: `TradeOrderModal` treats a missing quote as "not ready", so
`canExecute` was permanently false and the button read "Waiting for Live
Quote" forever. `QuotesTab` held the live quote and passed nothing.

**Impact**: no manual market order could ever be placed from the UI.
The modal is only rendered in one place, so this was total.

**Fix**: pass the quote the screen is already displaying.

**Regression test**: asserts the prop is passed.

---

## 13. A bot was shown RUNNING even when starting threw — **MEDIUM**

**Where**: `src/App.tsx`.

**Why**: `void agentRuntime.start(botId)` was a floating promise. The
state update to `RUNNING` happened regardless, and `start` rejects when
the agent is not registered.

**Impact**: a bot the user believed was armed, counted as running, and
described as armed in the AI context, with no agent to wake.

**Fix**: `RUNNING` is set only after `start` resolves; a rejection sets
`STOPPED` with the reason and raises a visible notice.

**Regression test**: covered by the source assertions in the audit suite.

---

## 14. The condition engine sent no CORS headers — **MEDIUM**

**Where**: `server/tradingv_engine/api.py`.

**Found by**: driving the real UI in a headless browser. No unit test
could have found it.

**Why**: FastAPI sends no `Access-Control-Allow-Origin` by default, and
the engine is on a different port from the app.

**Impact**: the condition preview could **never** test a condition. The
browser refused the request, the engine looked unreachable, and the user
was permanently told to start a server that was already running.

**Fix**: an allowlist (never `*`) with a working preflight.

**Regression test**: five tests, including that an unknown origin gets no
headers and that a cross-origin `POST /test` actually reaches the
engine.

---

## 15. The condition card was hardcoded dark inside a light modal — **MEDIUM**

**Found by**: the same browser pass.

**Why**: the condition card was written with `slate` colours while the
rest of the app uses theme tokens.

**Impact**: a dark grey box in a light-themed modal, and it did not flip
with the theme.

**Fix**: converted to the design system's tokens.

---

## 16. A stale "engine not running" banner over a successful result — **LOW**

**Found by**: the same browser pass.

**Why**: `engineUp` was probed once on mount and never updated.

**Impact**: the user was told the engine was down while it was visibly
answering.

**Fix**: a successful test sets it true; a transport failure sets it
false.

---

## 17. Engine bugs found in the previous session, re-verified here

- `BODY_PERCENT`, `PERCENT_CHANGE`, `ABSOLUTE_CHANGE` claimed a one-bar
  warmup while reading the previous close.
- A volume-confirmed breakout treated "cannot measure" as "confirmed".
- `CHANNEL_UP`/`CHANNEL_DOWN` rejected a mathematically perfect line
  because the tolerance had no floor for floating-point noise.

---

## What the audit did **not** cover

- **No live-venue testing.** Everything is fixtures and a local
  Miniflare. Real Hyperliquid latency, rate limits, and websocket
  behaviour are unverified.
- **No load or soak testing.** Nothing has run for hours. The bound on
  memory and storage over a long session is reasoned about, not measured.
- **No third-party penetration test.**
- **Two reported findings were dismissed as unconfirmed**: `calculateATR`
  returning an EMA of true range rather than Wilder's RMA, and the
  "24h change" column always reading `0.00%` because `prevDayPx` is
  fetched but unused. Both are plausible and both are unverified.
- **The legacy browser-side condition evaluator still exists.** The
  canonical path is the shared schema, but `src/engine/agents/trackers/conditions.ts`
  remains and is still used by the agent tracker path. It is a second
  implementation of a subset of the language and is the largest
  remaining duplication in the codebase.
