# Module 12 — Condition Engine Client

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/engine/conditions/{contract,tree,engineClient,conditionParity}.ts`

**Purpose:** (a) validate a condition tree against the shared schema locally, before
spending a round trip; (b) provide a typed HTTP client for the Python engine's routes.
The live trigger engine does **not** use this module — it evaluates in-browser.

---

## Contains

| File | Lines | Key exports |
| --- | --- | --- |
| `contract.ts` | 310 | `validateConditionTree`, the leaf/group shape validators, the `ConditionTree` type |
| `tree.ts` | 377 | tree construction and traversal helpers |
| `engineClient.ts` | 335 | `ConditionEngineClient` `:131`, `conditionEngine()` `:314`, `DEFAULT_ENGINE_URL` `:129`, `ConditionStatus` `:21`, `ConditionContractError` `:49`, `ConditionEngineError` `:60`, `pendingWake` `:329`, `buildCanonicalTree` `:333` |
| `conditionParity.ts` | 533 | the `test:conditions` runner |

---

## `ConditionEngineClient` — `engineClient.ts:131`

| Member | Line | Python route |
| --- | --- | --- |
| `DEFAULT_ENGINE_URL` | `:129` | `http://127.0.0.1:8099` |
| `constructor(options)` | `:132-143` | `baseUrl` from `options.baseUrl ?? DEFAULT_ENGINE_URL` `:137`; `doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)` `:138` |
| `request<T>(path, init)` | `:144-172` | — |
| `assertCanonical(tree)` | `:177-179` | local validation before the round trip |
| `health()` | `:189` | `GET /health` — `api.py:216` |
| `status()` | `:200` | `GET /status` — `api.py:389` |
| `catalogue()` | `:207` | `GET /catalogue` — `api.py:236` |
| `instruments(refresh = false)` | `:213` | `GET /instruments` — `api.py:253` |
| `evaluate(tree, market, nowMs?)` | `:228` | `POST /evaluate` — `api.py:343` |
| `test(tree, context = 'gold15mSpike')` | `:243` | `POST /test` — `api.py:306` |
| `fixtureContexts()` | `:252` | `GET /fixtures` — `api.py:329` |
| `registerTrigger(input)` | `:259` | `POST /triggers` — `api.py:275` |
| `unregisterTrigger(triggerId)` | `:267` | `DELETE /triggers/{id}` — `api.py:284` |
| `triggerStatus(triggerId)` | `:271` | `GET /triggers/{id}/status` — `api.py:290` |
| `wakes(limit = 20)` | `:277` | `GET /wakes` — `api.py:373` |
| `acknowledgeWake(wakeId)` | `:289` | `POST /wakes/{id}/ack` — `api.py:377` |
| `events(options)` | `:295` | `GET /events` — `api.py:360` |
| `conditionEngine(options?)` factory | `:314-327` | |
| `pendingWake(wakes, botId)` | `:329` | pure helper |
| `buildCanonicalTree(root, overrides)` | `:333` | wraps a bare root into `{ schemaVersion, then, root }` |

**Types** — `ConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN'` `:21` ·
`ConditionLeafResult` `:23` · `EvaluationResult` `:36` · `ConditionErrorDetail` `:44` ·
`WakeEvent` `:70` · `EngineInstrument` `:96` · `EngineStatus` `:111` ·
`ConditionEngineClientOptions` `:122`.

**Transport behaviour**

- `AbortController` + `setTimeout(this.timeoutMs)` `:145-146`; `clearTimeout` in a
  `finally` `:171`.
- `Content-Type: application/json` `:151`.
- A `422` whose `detail` contains `"Not a canonical"` becomes a
  `ConditionContractError` carrying the problem list `:157-159`; any other non-2xx
  becomes a `ConditionEngineError` `:160-161`.
- A transport failure is wrapped as
  `"Could not reach the condition engine at {baseUrl}. Is it running?"` `:167-171`.

---

## Local contract validation

`validateConditionTree(tree)` — `contract.ts` — is imported by
`engineClient.assertCanonical` (`:177-179`) and by
`botDefinition.validateBotTrigger` (`botDefinition.ts:1034-1039`).

**Observable intent (from the code comments)** — the client validates first "so the
builder can show the problem next to the condition while the user is still typing";
the engine validates again (`api.py:320` → `contract.py:74`).

The validator is a **local implementation**, not a JSON-Schema read of
`shared/condition_schema_v1.json` — the browser does not import that file at
runtime. (`conditionParity.ts` reads `condition_examples.json`, and the parity run is
what keeps the local validator and the Python validator aligned.)

---

## `conditionParity.ts` — the TS half of the contract check

`package.json:20` → `bun src/engine/conditions/conditionParity.ts` (533 lines).

```
reads shared/condition_examples.json
   ↓ per canonical tree
ConditionEngineClient.test(tree, contextName)     engineClient.ts:243
   ├─ assertCanonical(tree)                        engineClient.ts:177
   ↓ await this.request('POST', '/test')           engineClient.ts:148
      → server/tradingv_engine/api.py:307
   ↓ compares the returned status and per-condition statuses
      against the expected block
```

The Python half is `server/tests/test_conditions.py` plus
`server/tests/test_contract.py`, running the same examples through `evaluate_tree`
directly.

Full detail in [chains/condition-parity.md](../chains/condition-parity.md).

---

## Depends on

| Module | How |
| --- | --- |
| Trigger Engine | `contract.ts` is imported by `botDefinition.ts:1034-1039` and `conditionParity.ts` |
| Bot Definitions | the reverse — `botDefinition.ts` imports `validateConditionTree` from here |
| `shared/` | `conditionParity.ts` reads `condition_examples.json` |
| Services & App State | `localStorage` is not used; only `fetch` and `AbortController` |

## Used by

| Consumer | Line |
| --- | --- |
| `components/triggers/TriggerCard.tsx` | `:108` `conditionEngine()`; `:116` `health()`; `:121` `fixtureContexts()` / `instruments()`; `:135` `test()` |
| `conditionParity.ts` | the whole runner |
| `core/securityTests.ts` (test-only) | — |

**Note** — `TriggerCard` is rendered only by `BotBuilderModal`
(`BotBuilderModal.tsx:316`), so this module is reached only from the bot-creation
wizard. The live trigger path uses the in-browser evaluator instead.

## Reads

`shared/condition_examples.json` · the engine's JSON responses · the `fetch`
implementation (injectable via `options.fetch` `:138`).

## Writes

Nothing local. `registerTrigger` `:259` and `unregisterTrigger` `:267` write to the
Python engine, not to browser state.

## Mutates

None. The client is stateless.

## Emits

None.

## Subscribes to

Nothing.

## External dependencies

| Boundary | Line | Kind |
| --- | --- | --- |
| `http://127.0.0.1:8099` (default base) | `:129`, `:137` | HTTP |
| `fetch` | `:138`, `:148` | platform API |
| `AbortController` / `setTimeout` | `:145-146` | platform API |
| filesystem read of `shared/condition_examples.json` | `conditionParity.ts` | `bun` runtime |

**No secret is read or sent.** The client carries no API key, no token, and no
credential. `core/securityTests.ts` asserts this.

## Entry points

`conditionEngine()` `engineClient.ts:314` · `new ConditionEngineClient(options)`
`:132` · `validateConditionTree` `contract.ts` · `buildCanonicalTree` `:333` ·
`pendingWake` `:329`.

## Exit points

`fetch` to `http://127.0.0.1:8099` — the only network boundary in this module.

---

## Notable observations (factual)

- **This module is not on the live trigger path.** `TriggerEngine.process` uses
  `src/engine/agents/triggers/conditions.ts`; the client is used only by the
  bot-builder Trigger Card and the parity runner.
- **The base URL is not configurable from the environment through
  `src/config/env.ts`.** `VITE_TRADINGV_ENGINE_URL` is documented in `.env.example`
  but has no reader in `src/config/env.ts`; the default is hard-coded at
  `engineClient.ts:129` and overridable only through `ConditionEngineClientOptions`.
- **13 client methods map 1:1 onto Python routes**; the two Python routes with no
  client method are `GET /schema` and `GET /timeframes` (`api.py:240, 244`).
- **A 422 is treated as a contract failure, not a transport failure** — the special
  case at `:157-159` distinguishes "the tree is malformed" from "the engine is down".
