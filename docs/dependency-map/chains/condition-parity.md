# Chain: Condition Parity (TypeScript ↔ Python)

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** `bun run test:conditions`.

**Confidence:** CONFIRMED.

---

```
[1] package.json:20   "test:conditions": "bun src/engine/conditions/conditionParity.ts"
    ↓
[2] conditionParity.ts (533 lines) reads shared/condition_examples.json
    ↓ for each canonical tree
[3] ConditionEngineClient.test(tree, contextName)          engineClient.ts:243
    ├─ assertCanonical(tree)  (local schema check first)    engineClient.ts:177-179
    ↓ await this.request('POST', '/test', …)               engineClient.ts:243-251 → :144
    ↓
[4] server/tradingv_engine/api.py:307  test_condition
    ├─ 422 when no tree                                    api.py:316
    ├─ contract.validate_tree(tree)                        api.py:320 → contract.py:74
    ├─ engine.fixture_context(context)                     api.py:322 → engine.py:181
    │     → _load_fixture_contexts()                       engine.py:346-409
    │         reads server/tests/fixtures/{name}.json       engine.py:359
    └─ _evaluate(tree, context)                            api.py:398 → :396-404
          evaluate_tree(tree, context)                     evaluator.py:208
    ↓ response 200 { status, summary, conditions, explanation, textures }
    ↓
[5] conditionParity.ts compares the returned status and per-condition
    statuses against the expected block in the examples file
```

---

## Why this chain exists

There are **three independent implementations** of condition evaluation in the
repository, and one shared data contract.

| Implementation | Location | Leaf kinds | Indicators from |
| --- | --- | --- | --- |
| In-browser trigger engine | `src/engine/agents/triggers/conditions.ts` | **9** (`CONDITION_CATALOGUE` `:256-275`) | `src/engine/indicators/index.ts` — SMA, EMA, RSI, MACD, Bollinger, RMA, ATR |
| In-browser legacy evaluator | `src/engine/agents/triggers/evaluator.ts:55-75` | 18 trigger *types* (not leaf kinds) | same |
| Python engine | `server/tradingv_engine/evaluator.py:1058-1083` | **24** (`LEAF_KINDS` `:1088`) | `server/tradingv_engine/indicators/engine.py` — 27 indicators |
| Worker | `watchers/src/evaluator.ts` | **0** — it is an HTTP client only | n/a; it delegates to the Python engine |

`shared/condition_schema_v1.json` is the only thing all of them are expected to agree
on.

---

## What is actually shared

| Artefact | Consumed by | Consumed by the worker? |
| --- | --- | --- |
| `shared/condition_schema_v1.json` | `server/tradingv_engine/contract.py:34, 43` (path resolved from the repo root) | **no** — `conditionTree` is typed `unknown` (`watchers/src/contract.ts:159`) and only size-checked (`:204-211`) |
| `shared/condition_examples.json` | `src/engine/conditions/conditionParity.ts`; `server/tests/test_contract.py:25-26` | **no** |

The examples file's own `note` field names its consumers as
`server/tests/test_contract.py` and `src/engine/agents/triggers/conditionParity.ts` —
`watchers/` is not listed and does not import either file.

**Hand-copied bounds (CONFIRMED)**

| Field | `watchers/src/contract.ts:174-180` | `shared/condition_schema_v1.json` |
| --- | --- | --- |
| `cooldownMs` | `{ min: 0, max: 86_400_000 }` | `minimum 0, maximum 86400000` |
| `maxWakesPerHour` | `{ min: 1, max: 60 }` | `minimum 1, maximum 60` |
| `maxWakesPerDay` | `{ min: 1, max: 1_440 }` | `minimum 1, maximum 1440` |
| `minEvaluationIntervalMs` | `{ min: 1_000, max: 3_600_000 }` | `minimum 0, maximum 86400000` — **differs** |

Fields present in the shared schema and absent from `WatcherConfig`: `schemaVersion`,
`description`, `enabled`, `timeframe`, `then`, `requireTradeableMarket`.

---

## The two consumers' starting points

### TypeScript side — `ConditionEngineClient`

| Member | Line | Python route |
| --- | --- | --- |
| `health()` | `:189` | `GET /health` — `api.py:216` |
| `status()` | `:200` | `GET /status` — `api.py:389` |
| `catalogue()` | `:207` | `GET /catalogue` — `api.py:236` |
| `instruments(refresh)` | `:213` | `GET /instruments` — `api.py:253` |
| `evaluate(tree, market, nowMs?)` | `:228` | `POST /evaluate` — `api.py:343` |
| `test(tree, context = 'gold15mSpike')` | `:243` | `POST /test` — `api.py:306` |
| `fixtureContexts()` | `:252` | `GET /fixtures` — `api.py:329` |
| `registerTrigger(input)` | `:259` | `POST /triggers` — `api.py:275` |
| `unregisterTrigger(id)` | `:267` | `DELETE /triggers/{id}` — `api.py:284` |
| `triggerStatus(id)` | `:271` | `GET /triggers/{id}/status` — `api.py:290` |
| `wakes(limit = 20)` | `:277` | `GET /wakes` — `api.py:373` |
| `acknowledgeWake(wakeId)` | `:289` | `POST /wakes/{id}/ack` — `api.py:377` |
| `events(options)` | `:295` | `GET /events` — `api.py:360` |

Helpers: `conditionEngine(options?)` factory `:314`; `pendingWake(wakes, botId)` `:329`;
`buildCanonicalTree(root, overrides)` `:333`.

Transport: `this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)` — `:138`.
Timeout: `AbortController` + `setTimeout` — `:145-146`.
Default base: `DEFAULT_ENGINE_URL = 'http://127.0.0.1:8099'` — `:129`.

**Local-first validation** — `assertCanonical` (`:177-179`) runs
`validateConditionTree(tree)` before spending a round trip, so the builder can show the
problem next to the offending condition.

**422 handling** — `engineClient.ts:157-159`: a 422 whose `detail` contains
`"Not a canonical"` becomes a `ConditionContractError` carrying the problem list
rather than a flat string.

**Unreachable** — `:167-171` wraps any transport failure in
`ConditionEngineError` with the message
`"Could not reach the condition engine at {baseUrl}. Is it running?"`.

### Python side — `POST /test`

`TestConditionRequest` — `api.py:108-120`: `tree?`, `context` (default
`"gold15mFlat"`), `market` (default `"xyz:GOLD"`), `spread` (default `0.25`).

```
api.py:307  test_condition(request)
   ├─ 422 when request.tree is absent                 api.py:316
   ├─ contract.validate_tree(request.tree)            api.py:320 → ContractError → 422
   ├─ engine.fixture_context(request.context)         api.py:322
   │     KeyError → 404                                api.py:324-325
   └─ _evaluate(request.tree, context)                api.py:398
```

`ConditionEngine.fixture_context(name)` — `engine.py:181-195` returns a pre-built
`EvaluationContext` from `_load_fixture_contexts()` — `engine.py:346-409`:

| Element | Value | Line |
| --- | --- | --- |
| fixture path | `<package>/../tests/fixtures/{name}.json` | `engine.py:359` |
| spread | `0.25` | `engine.py:384` |
| account snapshot | hard-coded | `engine.py:393-405` |
| timestamp | `1_700_000_000_000` | `engine.py:407` |

Fixture files present: `eur_1h_flat.json`, `gold_15m_flat.json`,
`gold_15m_uptrend.json`, `gold_15m_downtrend.json`, `gold_15m_spike.json`,
`gold_15m_short.json`.

`GET /fixtures` — `api.py:329-340` — returns
`{name: engine.describe_fixture_context(name) ...}`.

---

## The response shape

```
EvaluateResult                                          api.py:132-137
   status      'TRUE' | 'FALSE' | 'UNKNOWN'
   summary     str
   conditions  [ ConditionResult.to_json(), … ]          evaluator.py:99-118
   explanation str                                        api.py:407-411 → evaluator.py:1096
   textures    [ {timeframe, indicator}, … ]              contract.py:126-173
```

`ConditionResult.to_json()` — `evaluator.py:99-118` — emits per-condition `status`,
`value`, `threshold`, `unit`, `reason`. `ConditionResult.flat()` — `:120-125` — walks
the tree.

`condition_textures(node)` — `contract.py:126-173` — is the compute plan: the sorted
set of `(timeframe, indicator)` pairs a tree needs. It emits a sentinel
`"__SERIES__"` pseudo-indicator for the 18 `_SERIES_KINDS` (`contract.py:102-123`),
resolves unknown timeframes to `DEFAULT_TIMEFRAME` (`:151`), and dedupes via
`setdefault` (`:152`).

The worker discards `explanation` and `textures` (`watchers/src/evaluator.ts:78`);
the TS client and the parity runner consume the whole object.

---

## The three-state contract

| Layer | Where the vocabulary lives |
| --- | --- |
| Shared schema | node-level evaluation is not encoded; the schema describes tree *shape* |
| Python | `Status(str)` enum `TRUE` / `FALSE` / `UNKNOWN` — `evaluator.py:51-54` |
| Browser trigger engine | `ConditionStatus = 'TRUE' \| 'FALSE' \| 'UNKNOWN' \| 'DISABLED'` — `conditions.ts:202` |
| Browser trigger engine (legacy) | returns `undefined` = did not fire — `evaluator.ts:113-121` |
| Worker | `WakeStatus` is a different vocabulary (`PENDING`/`ACKNOWLEDGED`/`EXECUTED`/`REJECTED`/`DISCARDED`, `wake-queue.ts:70`); the `TRUE/FALSE/UNKNOWN` value is normalised by `normalizeStatus` `evaluator.ts:160-166` |

**`DISABLED` is browser-only** — it propagates from a disabled leaf through
`evaluateNode` (`conditions.ts:691-693`, `:709-711`) and is not in the Python
`Status` enum.

`compare()` returns `None` (= `UNKNOWN`) when either side is `None`
(`evaluator.py:158-159`), when a value is non-finite (`:160-161`), or for
`CROSS_ABOVE` / `CROSS_BELOW` (`:176, :178`, deferred to `crosses` `:192-200`).
`EQ` / `NEQ` use `_approximately_equal` with tolerance
`max(1e-9, |right| * 1e-9)` (`:187-189`).

**UNKNOWN contagion** — `combine` in the browser evaluator at `conditions.ts:716-740`;
`_evaluate_group` in Python at `evaluator.py:235-309`.

---

## Observable consequence in the two live paths

| Path | Which evaluator runs | Node kinds it must handle |
| --- | --- | --- |
| Browser trigger engine (`TriggerEngine.process`) | `src/engine/agents/triggers/conditions.ts` in-browser | the 9 in `CONDITION_CATALOGUE` `:256-275` |
| Worker (`POST /feed`) | the Python engine, over HTTP | the 24 in `LEAF_KINDS` `evaluator.py:1088` |
| Bot-builder Trigger Card | the Python engine, over HTTP | same 24 |
| Trigger Lab preview | the browser evaluator, client-side, on every keystroke | the 9 |

**A tree is serialized once (`shared/condition_schema_v1.json` shape) and can be
evaluated by either implementation.** The parity runner is what keeps the two
implementations' answers aligned on the 20 canonical examples.

---

## Evidence of the separation

| Fact | Evidence |
| --- | --- |
| `conditions.ts` declares itself the legacy evaluator and names the Python engine as authoritative for builder previews | `src/engine/agents/triggers/conditions.ts:1-63` (comments at `:37-61`) |
| `botDefinition.ts` imports the *local* validator, not the engine | `botDefinition.ts:1034-1039` → `validateConditionTree` from `../conditions/contract` |
| The worker has no indicator code at all | the only non-relative import in `watchers/src` is `cloudflare:workers` (`index.ts:27`, `durable-object.ts:23`) |
| A test asserts the worker imports nothing from the rest of the repo | `watchers/test/source-hygiene.test.ts:21` resolves the repo root; 3 `it()` cases |
