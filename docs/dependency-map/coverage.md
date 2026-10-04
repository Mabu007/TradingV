# Coverage Report

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

A **documentation** coverage report. It records what was mapped and what could not be
reliably mapped. It contains no quality assessment.

---

## 1. Files inspected

### Repository inventory

| Category | Count |
| --- | --- |
| TypeScript / TSX source files (`src/`) | 79 |
| TypeScript / TSX test & acceptance runners (in `src/`) | 21 |
| Python source files (`server/tradingv_engine/`) | 20 |
| Python test files (`server/tests/`) | 10 |
| Python test fixtures (JSON) | 6 |
| Cloudflare Worker source files (`watchers/src/`) | 9 |
| Worker test files (`watchers/test/`, `watchers/test-runtime/`) | 7 |
| Shared data files (`shared/`) | 2 |
| Root configuration / metadata | 9 |
| Worker configuration / metadata | 8 |
| Pre-existing documentation (`docs/`, excluding this directory) | 29 |
| **Total application-relevant files** | **~180** |

### Configuration and manifest files inspected

`package.json` · `bun.lock` · `tsconfig.json` · `vite.config.ts` · `index.html` ·
`metadata.json` · `.env.example` · `.gitignore` ·
`server/pyproject.toml` · `server/README.md` ·
`watchers/package.json` · `watchers/wrangler.toml` · `watchers/tsconfig.json` ·
`watchers/vitest.config.ts` · `watchers/vitest.runtime.config.ts` ·
`watchers/.dev.vars.example` (variable **names only**) · `watchers/README.md`

**Not inspected (deliberately)** — `bun.lock` (424 kB dependency-resolution noise,
already summarised from the manifests) · `watchers/package-lock.json` (4 034 lines) ·
`server/.pytest_cache/` · `__pycache__/` · `dist/` · `node_modules/` ·
`server/.venv/` · `watchers/.wrangler/` · `.ori/`

`.env` was **not** read. No secret value from any file is reproduced in this
documentation.

---

## 2. Mapped

| Metric | Count | Notes |
| --- | --- | --- |
| Logical modules | **17** | [module-map.md](module-map.md) |
| Module documents | **17** | [modules/](modules/) |
| Runtime chains | **14** | [runtime-chains.md](runtime-chains.md) + 14 documents in [chains/](chains/) |
| Chain documents | **14** | every chain has its own file |
| Classes mapped | **~40** | documented at symbol level with `file:line` |
| Interfaces / types mapped | **~70** | the load-bearing ones; see §5 |
| Functions / methods mapped | **~400** | every exported symbol of the engine, the adapters, the services, the Python package, and the worker |
| Entry points mapped | **~120** | [entry-points.md](entry-points.md) |
| HTTP routes mapped | **17** (Python) + **11** (worker) | full tables with line numbers |
| State containers mapped | **~50** | [state-owners.md](state-owners.md) |
| Events mapped | **22** (`eventBus`) + **15** (`EventType`) + **7** (`EventRejection`) | [event-flow.md](event-flow.md) |
| Registries / factories / DI seams mapped | **16** | [registries-and-factories.md](registries-and-factories.md) |
| External dependencies mapped | **13** npm + **7** Python + **5** worker dev + **~25** env var names + **8** network endpoints | [external-dependencies.md](external-dependencies.md) |
| Test files inspected | **38** | [modules/test-runners.md](modules/test-runners.md) |

---

## 3. Coverage by directory

| Directory | Files | Documented | Depth |
| --- | --- | --- | --- |
| `src/App.tsx` | 1 | 1 | **exhaustive** — all 35 `useState`, 9 `useEffect`, 4 `useMemo`, 1 `useRef`, all named handlers, all inline prop callbacks |
| `src/main.tsx` | 1 | 1 | exhaustive |
| `src/config/` | 1 | 1 | exhaustive — all 7 `VITE_*` readers + both declaration tables |
| `src/types/` | 6 | 6 | exhaustive — the full 22-member `TradingVibeEvent` union and the `EventBus` |
| `src/components/` | 30 | 30 | full component tree, all props, all callbacks; unmounted components identified |
| `src/services/` | 19 | 19 | full — every singleton, provider, and tool |
| `src/adapters/hyperliquid/` | 3 + 5 tests | 3 | full — endpoints, WebSocket handler, adapter internals |
| `src/adapters/openrouter/` | 2 | 2 | full |
| `src/adapters/marketData.ts` | 1 | 1 | the interface |
| `src/engine/agents/` | 36 (incl. 10 test runners) | 26 production | full at symbol level for `runtime.ts`, `botDefinition.ts`, `triggers/*`, `capabilities/*`, `environment/*`, `policy/*` |
| `src/engine/conditions/` | 4 | 4 | full — all 13 client methods mapped to Python routes |
| `src/engine/execution/` | 3 + 1 test | 3 | full |
| `src/engine/core/` | 6 | 4 | `credentials.ts`, `errors.ts`, `execution.ts`, `logger.ts`; the 2 test runners |
| `src/engine/backtester/` | 3 | 3 | full |
| `src/engine/indicators/` | 1 | 1 | full — all 7 indicator functions |
| `src/engine/sandbox/` | 1 | 1 | full (no production consumer) |
| `src/utils/` | 3 | 3 | full |
| `server/tradingv_engine/` | 20 | 20 | full — all routes, all 24 leaf kinds, all 27 indicators, all 14 patterns |
| `server/tests/` | 10 + 6 fixtures | 16 | full — which production symbol each exercises |
| `watchers/src/` | 9 | 9 | full — every route, all 4 DO classes, all state keys |
| `watchers/test/`, `test-runtime/` | 7 | 7 | full — which production symbol each exercises |
| `shared/` | 2 | 2 | structure and consumers; **not** the full 1 513-line schema body |
| `docs/` (pre-existing) | 29 | 0 | **not mapped** — out of scope; this pass documents code, not prose |

---

## 4. Could not be reliably mapped

| Item | Status | Reason |
| --- | --- | --- |
| The external market-feed producer that calls `POST /feed` | **DYNAMIC / UNCERTAIN** | No in-repo caller exists. `POST /feed` (`watchers/src/index.ts:147`) has no producer; `wrangler.toml` declares no queue producer. Identity and behaviour of the producer are outside this repository. |
| The external consumer that polls `GET /watchers/{id}/wakes` | **DYNAMIC / UNCERTAIN** | No in-repo caller. The worker performs no push delivery. |
| The LLM's decision content | **DYNAMIC / UNCERTAIN** | `agentModel.run` (`runtime.ts:522`) returns a model response. The gate order around it is CONFIRMED; the decision itself is not statically knowable. |
| Market data content | **DYNAMIC / UNCERTAIN** | Every venue response is external. Normalisation is CONFIRMED; the payload is not. |
| Which triggers are registered at runtime | **DYNAMIC / UNCERTAIN** | `TriggerRegistry.triggers` is populated by user/AI configuration. The registration *rules* are CONFIRMED; the *contents* are not. |
| Which capability the model chooses | **DYNAMIC / UNCERTAIN** | `capabilities.execute(id, …)` `registry.ts:34` — the id comes from the model response. |
| The 24 `condition_examples.json` expected results | **NOT ENUMERATED** | The examples file is 700 lines. The runner's comparison logic is mapped; the individual expected blocks are not reproduced. |
| `shared/condition_schema_v1.json` full body | **NOT ENUMERATED** | 1 513 lines. The file's role, its consumers, and the hand-copied bounds that diverge from it are documented; its full property tree is not reproduced. |
| `bun.lock` / `watchers/package-lock.json` | **NOT ENUMERATED** | Dependency resolution data. Package purposes were derived from the manifests and import sites. |
| Line-level emission sites inside `monitor.py` | **INFERRED** | The `EventLog` handle is passed at `monitor.py:143` and aliased at `engine.py:86`; individual `self.log.emit(...)` call sites were not enumerated line by line. |
| Two `eventBus` subscriptions' teardown | **CONFIRMED absent** | `AgentRuntime` `runtime.ts:60-77` discards the unsubscribe closures returned by `eventBus.on`. Verified by reading the constructor. |
| Whether `AIPanel` and `StrategyDiffModal` are reachable | **CONFIRMED unmounted** | Repo-wide grep for importers returns zero hits for both. |

---

## 5. Symbols deliberately not enumerated individually

| Group | Why | Where they are summarised instead |
| --- | --- | --- |
| The 27 Python indicators (`indicators/engine.py:80-491`) | Individually identical in shape; the delegation target and warmup are what matter | [modules/python-condition-engine.md](modules/python-condition-engine.md) |
| The 14 Python patterns (`patterns.py:56-71`) | Same reason | same |
| The 26 price-action measures (`price_action.py:19-46`) | Same reason | same |
| `CONDITION_CATALOGUE` (9 entries) and `_LEAF_HANDLERS` (24 entries) | Enumerated by name and count; the per-case bodies are mapped in the evaluator dispatch tables | [Call Graph](call-graph.md), [condition-parity.md](chains/condition-parity.md) |
| `spec_for` metadata (24 `ConditionSpec` tuples) | 340 lines of declarative metadata; the `indicators_required` mapping is the load-bearing part | `catalogue.py:87-428` referenced throughout |
| The 138 `it()` cases in `watchers/test/` | Mapped at the *file* level — which production symbol each file exercises | [modules/test-runners.md](modules/test-runners.md) |
| Individual JSX element trees inside each component | Mapped at the component/prop/handler level, which is the useful granularity | [modules/ui-views.md](modules/ui-views.md), [modules/ui-components.md](modules/ui-components.md) |

---

## 6. Notable structural facts surfaced by the mapping

Recorded because they affect navigation. No judgement is expressed.

1. **Three independent condition evaluators exist** — the in-browser
   `src/engine/agents/triggers/conditions.ts` (9 leaf kinds), the legacy browser
   `triggers/evaluator.ts` (18 trigger types), and the Python `evaluator.py` (24 leaf
   kinds). Only the shared JSON schema connects them.
2. **Three independent indicator implementations exist** — Python
   `indicators/engine.py` (27), browser `src/engine/indicators/index.ts` (7), and the
   capability-level recomputation in `capabilities/indicators.ts`.
3. **Two independent backtest engines exist** — `BacktestSimulator`
   (`backtester/simulator.ts`) and `BacktestEnvironment`
   (`environment/backtest.ts`). `runBotDefinitionBacktest` uses the latter;
   `BacktestSimulator` has no `src/` importer.
4. **The worker imports nothing from the rest of the repository** — asserted by
   `watchers/test/source-hygiene.test.ts`.
5. **Three `App` `useState` variables have no writer** — `signals` `:212-213`,
   `logs` `:215-216`, `backtestResult` `:259-260`.
6. **One `useRef` has no writer** — `selectedBotIdRef` `:365`, so `selectedBotId` in
   the AI context is always `undefined`.
7. **Nine components exist with no importer** — `AIPanel`, `BottomPanel`, `Sidebar`,
   `StrategyDiffModal`, `BacktestsView`, `BotsView`, `DeploymentsView`,
   `SkillsView`, `StrategiesView`.
8. **No router** — `currentTab` state + two overlay booleans + a ternary chain.
9. **No navigation persistence** — a reload always returns to `trades`.
10. **No `eventBus` subscription exists anywhere in `src/components/`**.

---

## 7. Confidence distribution

| Confidence | Where it applies |
| --- | --- |
| **CONFIRMED** | All import edges, all `file:line` call edges within a single process, all `eventBus` emit/listener pairs, all HTTP route definitions, all state-field write/read sites, all validation rule sets, all environment variable *names* |
| **INFERRED** | The external feed producer and wake consumer's identity; the `event_log` emission sites inside `monitor.py`; the network-switch → discovery interaction in `App.tsx:2802-2811` |
| **DYNAMIC / UNCERTAIN** | Model decisions, market payloads, the set of registered triggers at runtime, the capability id a model selects, the `INFERRED` items in §4 |

Every relationship in this documentation is either backed by a `file:line` reference
or explicitly marked. Where a line number was not practical, the file and symbol are
given instead.

---

## 8. What was not touched

Confirmed by `git status` after this pass — the only new files are under
`docs/dependency-map/`.

| Category | State |
| --- | --- |
| Application source (`src/`) | unchanged |
| Python source (`server/`) | unchanged |
| Worker source (`watchers/src/`) | unchanged |
| Shared data (`shared/`) | unchanged |
| Configuration (`tsconfig.json`, `vite.config.ts`, `wrangler.toml`, `pyproject.toml`, `vitest*.config.ts`, `.env.example`) | unchanged |
| Dependency manifests (`package.json`, `bun.lock`, `watchers/package.json`, `watchers/package-lock.json`) | unchanged |
| Tests | unchanged |
| Pre-existing documentation (`docs/*.md`) | unchanged |
| Dependencies | none installed, none removed |

**Note** — the working tree already contained uncommitted modifications to many files
before this documentation pass began (visible in `git status` at the start). Those
pre-existing modifications are not the work of this pass and were left untouched.
