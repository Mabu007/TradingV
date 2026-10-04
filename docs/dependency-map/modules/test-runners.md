# Module 17 — Test & Acceptance Runners

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** in-tree `*Tests.ts` / `tests.ts` / `testRunner.ts` under `src/`,
`server/tests/`, `watchers/test/`, `watchers/test-runtime/`

**Purpose:** executable specifications of the application's behaviour. These are
**not** runtime code — nothing in `src/App.tsx`, the engine, the Python service, or
the worker imports them for behaviour. Every relationship in this module is
**test-only** unless explicitly marked otherwise.

---

## TypeScript runners (executable via `bun`)

| Script (`package.json`) | File | LOC | Exercises |
| --- | --- | --- | --- |
| `test:agents` `:12` | `src/engine/agents/test-runner/run.ts` | 19 | the agents suite; imports `tests`, `activityTests`, `backtestTests`, `botDefinitionTests` |
| `test:hyperliquid` `:13` | `src/adapters/hyperliquid/tests.ts` | 270 | `marketData` → `trigger` → `agent` pipeline |
| `test:hyperliquid:execution` `:16` | `src/adapters/hyperliquid/executionTests.ts` | 858 | the `demo.ts` execution lifecycle against fixed quotes |
| `test:hyperliquid:discovery:policy` `:17` | `src/adapters/hyperliquid/discoveryTests.ts` | 171 | the availability policy (`TRADEABLE` vs `UNAVAILABLE`) |
| `test:hyperliquid:discovery` `:14` | `src/adapters/hyperliquid/discoverySmoke.ts` | 40 | live discovery — **requires network** |
| `test:execution` `:15` | `src/engine/execution/tests.ts` | 503 | `RiskManager`, `aggregateExposure`, `leverageRequirement`, `marginForPosition` |
| `test:wallet` `:18` | `src/services/wallet/testRunner.ts` | 4 | Privy wiring, the wallet abstraction, env, security — delegates to `wallet/tests.ts` (366) |
| `test:theme` `:19` | `src/services/theme/testRunner.ts` | 6 | theme resolution and persistence, AI context, navigation — delegates to `theme/tests.ts` (236) |
| `test:conditions` `:20` | `src/engine/conditions/conditionParity.ts` | 533 | `ConditionEngineClient` against `shared/condition_examples.json` — **requires the Python engine running** |
| `test:pipeline` `:25` | `src/engine/agents/pipelineAcceptance.ts` | 625 | the `AgentRuntime` end-to-end, `registerBot`, `compileBotDefinition` |
| `test:audit` `:26` | `src/engine/agents/triggers/auditRegressionTests.ts` | 2149 | `TriggerEngine.process`, `canFire`, `markFired`, `safeSnapshot`, every latch state, `redactMessage` |
| `test:security` `:32` | `src/engine/core/testRunner.ts` | 6 | delegates to `core/securityTests.ts` (506) — `assertNoSecrets`, `InMemoryCredentialStore`, `sandboxEnv`, the engine client's secret scan |
| `lint` `:11` | `tsc --noEmit` | — | type checking only |

**Imported by the runners but not wired to a script**

| File | LOC | Exercises |
| --- | --- | --- |
| `src/engine/agents/tests.ts` | 316 | `registerAgent`, `ActionValidator`, `CapabilityRegistry` |
| `src/engine/agents/activityTests.ts` | 58 | `AgentRuntime.recordPositionEvent`, the timeline |
| `src/engine/agents/backtestTests.ts` | 52 | `runBotDefinitionBacktest`, `BacktestEnvironment` |
| `src/engine/agents/botDefinitionTests.ts` | 79 | `migrateBotDefinition`, `validateBotDefinition`, `cloneBotDefinition` |
| `src/engine/agents/triggers/tests.ts` | 392 | `TriggerRegistry.register`, `validateDefinition`, `candidates`, the transition table |
| `src/engine/agents/triggers/conditionTests.ts` | 480 | `evaluateConditionTree`, `evaluateLeaf`, `summariseTree`, `validateConditionTree` |
| `src/engine/backtester/historicalTests.ts` | 20 | `HyperliquidHistoricalMarketDataProvider.getBars` |
| `src/services/wallet/tests.ts` | 366 | the wallet abstraction and env handling |
| `src/services/theme/tests.ts` | 236 | theme, AI context, navigation |
| `src/services/aiContext/tests.ts` | 472 | `appContextStore`, the 12 tools, navigation parsing, prompt building |

`verify` (`package.json:24`) chains: `lint` → `test:audit` → `test:conditions` →
`test:engine` → `test:pipeline` → `test:security` → `cd watchers && npm run typecheck`
→ `npm test`.

---

## Python tests

`server/tests/` — 10 files, invoked by `test:engine` (`package.json:21`,
`server/.venv/bin/python -m pytest server`).

| File | Lines | Exercises |
| --- | --- | --- |
| `conftest.py` | 94 | fixtures; imports `series.Series` `:16` |
| `test_api.py` | 414 | the 17 HTTP routes; asserts `/openapi.json` at `:251`; imports `marketdata` `:345, 362` |
| `test_conditions.py` | 933 | `evaluator.evaluate_tree`; the 24 leaf kinds; imports `contract`, `catalogue`, `indicators`, `evaluator` |
| `test_config.py` | 63 | `EngineConfig`, `load_config`, `assert_local_only` |
| `test_contract.py` | 510 | `contract.validate_tree`, `load_schema`, `condition_textures`; imports `contract` `:25-26` |
| `test_edge.py` | 204 | `EdgeDetector.observe`, `WakePolicy`, `Decision`, `EdgeState` |
| `test_engine.py` | 641 | `ConditionEngine`, `MarketMonitor`, `EventLog`, `ConditionEngineClient` shape |
| `test_indicators.py` | 459 | the 27 indicators, warmups, and `Validity` transitions |
| `test_math_expr.py` | 216 | the parser, the AST node limit, the allow-lists |
| `test_patterns.py` | 302 | the 14 patterns |

Fixtures (6 JSON files): `eur_1h_flat.json`, `gold_15m_flat.json`,
`gold_15m_uptrend.json`, `gold_15m_downtrend.json`, `gold_15m_spike.json`,
`gold_15m_short.json`. These are read in **production code** by
`ConditionEngine._load_fixture_contexts` (`engine.py:346-409`) and served by
`GET /fixtures` (`api.py:329-340`) — the only test data on a production path.

---

## Worker tests

`watcher:test` (`package.json:28`) → `cd watchers && vitest run` (`watchers/test/`).
`watcher:test:runtime` (`:29`) → `vitest run --config vitest.runtime.config.ts`
(`watchers/test-runtime/`, `workerd` pool).

| File | Lines | `it()` | Exercises |
| --- | --- | --- | --- |
| `test/watcher.test.ts` | 812 | 67 | `Watcher` lifecycle, `tick`, latch, cooldown, caps, `buildWake`, `idempotencyKeyFor` `:119-124` |
| `test/adversarial.test.ts` | 463 | 32 | rejection paths, overflow, expiry, `idempotencyKeyFor` `:317-323, 454` |
| `test/concurrency.test.ts` | 361 | 16 | concurrent DO calls |
| `test/rate-limit.test.ts` | 175 | 16 | `consume` purity `:128-133`, saturation |
| `test/soak.test.ts` | 247 | 4 | volume behaviour |
| `test/source-hygiene.test.ts` | 85 | 3 | **asserts the worker imports nothing from `shared/` or `src/engine/`**; resolves the repo root at `:21` |
| `test-runtime/worker.test.ts` | 293 | 26 | the deployed worker end-to-end under `workerd`, using `watchers/.dev.vars` |

`watchers/tsconfig.json:15` includes `src/**/*.ts` and `test/**/*.ts` but **excludes
`test-runtime/**/*.ts`** from type checking.

---

## Reads (production symbols under test)

| Runner | Reads |
| --- | --- |
| `agents/tests.ts`, `pipelineAcceptance.ts` | `AgentRuntime`, `ActionValidator`, `CapabilityRegistry`, `registerBot`, `compileBotDefinition` |
| `triggers/auditRegressionTests.ts` | `TriggerEngine.process`, `canFire`, `markFired`, `safeSnapshot`, `redactMessage`, every `TriggerEvaluationState` field |
| `triggers/tests.ts` | `TriggerRegistry.register`, `validateDefinition`, `candidates`, `unscoped` |
| `triggers/conditionTests.ts` | `evaluateConditionTree`, `evaluateLeaf`, `summariseTree`, `validateConditionTree` |
| `execution/tests.ts` | `RiskManager.validateOrder`, `aggregateExposure`, `leverageRequirement`, `marginForPosition` |
| `core/securityTests.ts` | `assertNoSecrets`, `InMemoryCredentialStore`, `prepareStrategyFunction`, `ConditionEngineClient` |
| `adapters/hyperliquid/*Tests.ts` | `hyperliquidMarketData`, `hyperliquidDemoAdapter`, `normalizer`, `riskManager` |
| `services/*/tests.ts` | `appContextStore`, the 12 tools, `resolveInitialTheme`, the `WalletService` abstraction |
| `server/tests/*` | `evaluator`, `indicators`, `patterns`, `contract`, `api`, `edge`, `config`, `math_expr`, `engine` |
| `watchers/test/*` | `Watcher`, `WatcherObject`, `contract`, `wake-queue`, `rate-limit`, `ids`, `health` |

## Writes

Test-local state only, with three exceptions:

| Runner | Writes |
| --- | --- |
| `watchers/test-runtime/worker.test.ts` | DO storage (via the `workerd` pool) |
| `server/tests/test_api.py` | the `ConditionEngine` in-memory registries via the HTTP routes |
| `conditionParity.ts` | nothing — it POSTs to a running Python engine, which does mutate its in-memory trigger registry through `registerTrigger` if the runner registers anything |

**No test mutates application source, configuration, or dependency files.**

## Emits

Test runners may emit `eventBus` events as a side effect of exercising the engine
(e.g. `pipelineAcceptance.ts` drives real `step()` cycles, which emit `AGENT_*`). These
are consumed only by the `TriggerEngine` under test.

## Subscribes to

Test runners subscribe to `eventBus` when asserting on emissions (e.g.
`auditRegressionTests.ts`). All subscriptions are removed at the end of each case.

## Entry points

30 `package.json` scripts (`package.json:6-33`) · `pytest server` ·
`cd watchers && vitest run` · `cd watchers && vitest run --config vitest.runtime.config.ts` ·
`tsc --noEmit`.

## Exit points

Process exit codes. Three runners require external state:
`test:hyperliquid:discovery` needs network; `test:conditions` needs the Python engine
on `127.0.0.1:8099`; `watcher:test:runtime` needs `watchers/.dev.vars`.

---

## Notable observations (factual)

- **Test data on a production path** — `server/tests/fixtures/*.json` is read by
  `ConditionEngine._load_fixture_contexts` (`engine.py:359`) and exposed through
  `GET /fixtures` (`api.py:329`).
- **`source-hygiene.test.ts` is a dependency-*absence* test** — it asserts that
  `watchers/` does not import from `shared/` or `src/engine/`.
- **`watchers/README.md` claims 99 tests; `watchers/test/` contains 138 `it()` and
  `test-runtime/` 26.**
- **`test-runtime/` is excluded from type checking** — `watchers/tsconfig.json:15`.
- `watchers/vitest.config.ts:18-19` uses `environment: 'node'` with no Cloudflare
  pool; only `vitest.runtime.config.ts:13-21` uses `defineWorkersConfig`.
- `test:hyperliquid:discovery` is the only runner that performs live network I/O.
- The 21 TypeScript runners total roughly 7 300 lines — comparable in size to
  `src/engine/agents/runtime.ts` alone.
