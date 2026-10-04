# Registries, Factories, Providers and Other Indirect-Dependency Mechanisms

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

These mechanisms create relationships that a simple import graph hides. Each is
documented with what it registers, what it creates, what it resolves, who consumes it,
and its lifecycle.

---

## 1. `EventBus` — string-keyed pub/sub

| | |
| --- | --- |
| Mechanism | `EventBus` |
| Location | `src/types/events.ts:29-73`; instance `eventBus` `:75` |
| Registers | `on(type, listener)` `:32-43` — keyed by a string literal from the 22-member union `:3-25`; `onAll(listener)` `:64-72` — registers on the wildcard `'*'` key |
| Creates | nothing (listeners only) |
| Resolves | at `emit()` `:46` — `listeners.get(event.type)`; then `listeners.get('*')` `:58` |
| Consumers | `App` (5 subscriptions), `TriggerEngine` (`engine.ts:78`), `AgentRuntime` (`runtime.ts:60, 71`) |
| Producers | `marketData` adapter, `demo` adapter, `AgentRuntime`, `RiskManager`, `App`, `TriggerEngine` |
| Lifecycle | `on`/`onAll` return unsubscribe closures `:40-42`, `:69-71`. No global reset. Listeners registered via constructor subscriptions in `AgentRuntime` have **no captured teardown** |

**Hidden dependency** — an `emit` of a type with no matching `on` is a silent no-op.
Six event types are emitted or typed with no consumer; see
[Event Flow §7](event-flow.md).

**Wildcard asymmetry (CONFIRMED)** — typed listeners run inside `try/catch`
(`:48-53`); wildcard listeners do not (`:60`).

---

## 2. `CapabilityRegistry` — dotted-id tool registry

| | |
| --- | --- |
| Mechanism | `CapabilityRegistry` |
| Location | `src/engine/agents/capabilities/registry.ts:3-53`; instance `capabilityRegistry` `:91` |
| Registers | `register(capability)` `:6-16` — requires a non-empty id, rejects duplicates `:8`, requires `execute` `:9` and object schemas `:10` |
| Creates | nothing; stores a re-typed wrapper `:11-15` |
| Resolves | `get(id)` `:18-20`; `list()` `:26-28`; `listByCategory(category)` `:30-32`; `execute(id, input, context)` `:34-52` |
| Consumers | `AgentRuntime.runStep` (`runtime.ts:703, 830, 343`); `botDefinition.validateCapabilities` (`:308-338`); `SkillRegistry` capability resolution (`runtime.ts:136-140`) |
| Producers | `initializeDefaultCapabilities(registry)` `capabilities/index.ts:18-35`, invoked **at module load** `:38` |
| Lifecycle | permanent for the process; no unregister |

**Validates on every execution** — `validateCapabilityInput` `:59-89` (rejects unknown
fields `:64-65`, checks `required` `:69`, types `:72-80`, `enum` `:81`, `minimum` `:82-84`,
`maximum` `:85-87`) and `validateCapabilityScope` `:93-96` (a string `symbol` in the input
must be in `context.symbols`).

**The 31 registered capabilities** — id namespace is the dotted string.

| Namespace | Count | File | Category | Mutating? |
| --- | --- | --- | --- | --- |
| `market.*` | 4 | `capabilities/market.ts` | market | no |
| `indicators.*` | 4 | `capabilities/indicators.ts` | indicators | no |
| `structure.*` | 4 | `capabilities/structure.ts` | structure | no |
| `account.*` | 6 | `capabilities/account.ts` | account | no |
| `risk.*` | 6 | `capabilities/risk.ts` | risk | no (verdict only) |
| `orders.*` / `positions.*` | 7 | `capabilities/execution.ts` | **execution** | **yes** |

**Why `category === 'execution'` is a mechanism, not a label** — the runtime branches
on it twice:
1. re-observe before running (`runtime.ts:628-631`)
2. pre-validate through `validateExecutionTool` (`runtime.ts:633-641` → `:1508-1704`)

`validateExecutionTool` synthesises an `AgentDecision` from the tool input and runs the
policy + risk gates (`runtime.ts:1515-1579`), and hard-refuses `orders.limit` and
`orders.cancel` (`:1686-1696`).

**Indirect dependency** — the same dotted ids appear in
`botDefinition.capabilityIds` (`botDefinition.ts:952-982`) and in the skill
definitions (`skills/builtins.ts`). A capability rename must be applied in three places.

---

## 3. `SkillRegistry`

| | |
| --- | --- |
| Mechanism | `SkillRegistry` |
| Location | `src/engine/agents/skills/registry.ts`; builtins `skills/builtins.ts` |
| Registers | builtin skills at module import (imported through the `./skills` barrel) |
| Resolves | `resolveCapabilities(skills)` (used at `runtime.ts:122-124`); `compileInstructions(skills)` (`runtime.ts:154-155`) |
| Consumers | `AgentRuntime.registerAgent`; `validateBotDefinition.validateSkills` (`botDefinition.ts:282-306`, rejects unknown ids and `enabled: false` at `:297-305`) |
| Lifecycle | permanent; no unregister |

**Import-order dependency (CONFIRMED)** — `botDefinition.ts:3-13` imports
`SkillRegistry, skillRegistry` from the **barrel** `./skills` so that the builtin
registration side effect runs before validation. The comment at `botDefinition.ts:3-13`
states validation would otherwise reject every bot in a fresh module graph.

---

## 4. `TriggerRegistry` — trigger registry with a symbol index

| | |
| --- | --- |
| Mechanism | `TriggerRegistry` (instance created in `App.tsx:99-101`, not a module singleton) |
| Location | `src/engine/agents/triggers/registry.ts:14-99` |
| Registers | `register(trigger)` `:23-40`; `registerBotTriggers(definition, agentId, runtimeSymbol)` `:42-50` |
| Creates | a `structuredClone` of the trigger `cloneTrigger` `:182-184`, stored at `:33` |
| Resolves | `candidates(symbol?)` `:83-87` = `unscoped ∪ bySymbol.get(symbol)`; `get` `:64-67`; `list` `:69-71`; `listForAgent` `:73-75`; `countForAgent` `:77-81` |
| Consumers | `TriggerEngine.process` (hot path, `engine.ts:188`); `App` |
| Lifecycle | `unregister(id)` `:52-62`; `enable`/`disable`/`setEnabled` `:89-98` |

**Registration gate order** (`registry.ts:23-40`) — a trigger only enters the registry
if all of these pass:

1. `validateDefinition(trigger)` `:24`
2. owner is a registered, enabled, non-LIVE agent `:25-26`
3. `trigger.symbol` ∈ agent.symbols ∩ `policy.allowedSymbols` `:27-28`
4. an unscoped trigger requires the owner to have symbols `:29`
5. `trigger.timeframe` ∈ `1m|5m|15m|30m|1h|4h|1d` `:30` and equals `agent.timeframe` when set
6. id is not already present `:31`
7. the agent has fewer than 100 triggers `:32`

**Note (CONFIRMED)** — `CUSTOM` trigger type is always refused
(`registry.ts:163`).

---

## 5. `ActionValidator` — injected policy object

| | |
| --- | --- |
| Mechanism | default-argument DI + per-agent clone |
| Location | `policy/validator.ts:37-280`; instance `actionValidator` `:282` |
| Created by | default constructor arg at `runtime.ts:56` |
| Cloned per agent | `runtime.ts:159-162` (only when the shared singleton was used) |
| Resolves | 18 ordered checks returning `AgentActionValidationResult { valid, code, reason }` |
| Codes | `APPROVED`, `POLICY_VIOLATION`, `RISK_REJECTED`, `INVALID_PARAMS`, `UNKNOWN_CAPABILITY`, `DISALLOWED_SYMBOL`, `DISALLOWED_SESSION`, `TRADING_DISABLED`, `RATE_LIMITED` |
| Consumers | `AgentRuntime.runStep` `:894`; `validateExecutionTool` `:1549` |
| Mutable state | `recentOrderTimestamps` `:38` |

The `RISK_REJECTED` code is produced by the **runtime**, not the validator:
`runtime.ts:925-931` overrides an approved validation when the deterministic risk
gate rejects.

---

## 6. `ITradingEnvironment` — strategy-shaped injection

| | |
| --- | --- |
| Mechanism | interface + constructor injection, resolved at `registerAgent` time |
| Interface | `src/engine/agents/types.ts:91-128` |
| Implementations | `DemoEnvironment` `environment/demo.ts:8-68`; `BacktestEnvironment` `environment/backtest.ts:50-375`; `createLiveEnvironment()` `environment/live.ts:3-5` (**throws**) |
| Barrel | `environment/index.ts:1-3` |
| Selection | **not** a runtime branch — the instance is an argument to `registerAgent(agent, env)` `runtime.ts:84-87` and is stored on `AgentInstance.env` `:31` |
| Consumers | every capability via `CapabilityContext.env`; `AgentRuntime.observe`; `AgentRuntime.runStep` execution; `TriggerEngine` agent filter (`engine.ts:82, 121, 203, 285`) |
| Rejected at registration | `env.mode === 'LIVE'` → throw `runtime.ts:112-116` |

**Clock switch (DYNAMIC / INFERRED on intent, CONFIRMED on code)** —
`nowFor(instance)` `runtime.ts:1371-1382` returns the backtest bar timestamp when
`env.mode === 'BACKTEST'`, else `Date.now()`. Duration measurement branches on the
same flag (`runtime.ts:727-734`).

**App wiring** — `new DemoEnvironment()` at `App.tsx:1182`, passed to
`registerBot` at `App.tsx:1185`. `App.executionMode` is **not** what selects the
environment.

---

## 7. `WakeQueue` — a queue in name only

| | |
| --- | --- |
| Mechanism | in-heap `Map<string, Wake>` + terminal array, persisted by the caller |
| Location | `watchers/src/wake-queue.ts:115-325` |
| Registers | nothing |
| Creates | `Wake` records via `buildWake` `:328-355`; ids via `wakeIdFor` `ids.ts:67` |
| Resolves | `get(id)` `:160-162`; `list()` `:133-135`; `history(limit)` `:156-158`; `size` `:124-126`; `capacity` `:128-130` (never called) |
| Enqueues | `enqueue(wake, nowMs)` `:171-205` |
| Acknowledges | `acknowledge(id, nowMs)` `:234-239` — sets `acknowledgedAt`, **leaves the wake in `pending`** (at-least-once) |
| Resolves a wake | `resolve(id, outcome, nowMs)` `:242-252` — deletes from pending and terminalises |
| Expires | `expire(nowMs)` `:291-301` → terminal outcome `STALE` |
| Terminalises | `terminalise` `:316-324` — `EXECUTED`/`ACKNOWLEDGED`/`REJECTED` keep their status; every other outcome becomes `DISCARDED` `:317` |
| Overflow | over `maxSize` the **oldest is dropped** and terminalised `QUEUE_FULL` `:183-201` |
| Superseded config | `CONFIG_CHANGED` `:261-271` |
| Watcher stopped | `WATCHER_STOPPED` `:274-282` |
| Lifecycle | `restorePending` `:146-153` and `restoreTerminal` `:215-224` from DO storage on `ready()` |

**This is not a Cloudflare Queues binding.** There is no queue name, no producer, no
consumer, no `MessageBatch`, no `ack()`/`retry()`, and no DLQ.
`wrangler.toml` declares no `[[queues.producers]]`, no `[[queues.consumers]]`, and no
`dead_letter_queue`; `watchers/src/index.ts` exports no `queue()` handler.

**Terminal history acts as the retained dead-letter log** and is persisted on every
`save()` (`durable-object.ts:122`).

---

## 8. Rate limiting — a two-level mechanism

| | |
| --- | --- |
| Mechanism | pure function + a per-caller Durable Object |
| Pure function | `consume(state, bucket, now, limits)` `rate-limit.ts:77-117` — fixed window; does **not** mutate its input (asserted at `test/rate-limit.test.ts:128-133`) |
| Storage | `RateLimitObject.take(bucket, now)` `index.ts:403-408` — `storage.get` `:404` → `consume` `:405` → `storage.put` `:406` |
| Keying | per caller: `` `user:${userId}` `` `index.ts:454`; feed is keyed by the literal `'feed'` `index.ts:106` |
| Buckets | `read` 300/min, `lifecycle` 30/min, `evaluate` 120/min, `feed` 240/min — `rate-limit.ts:23-43`; window `RATE_WINDOW_MS = 60_000` `:46` |
| Selection | GET → `read`; `action === 'evaluate'` → `evaluate`; else `lifecycle` — `index.ts:133-135` |
| Wiring | `consumeRate` `index.ts:416-429`; `rateLimited` `:431-442`; `limited` `:445-460` |
| Fails open | `consumeRate` returns `allowed: true` when `env.RATE_LIMITS` is missing (`index.ts:425`, commented `:418-424`) |
| Preflight | `OPTIONS` bypasses the limiter entirely (`index.ts:453`; `isPreflight` `rate-limit.ts:125-127`) |

**Counter saturation (CONFIRMED)** — `rate-limit.ts:99-101`: a refused request still
increments while `used <= limit`, so the counter caps at `limit + 1` and a retry loop
cannot inflate it further.

---

## 9. `UserRegistryObject` / `MarketIndexObject` — fan-out indexes

| | |
| --- | --- |
| Mechanism | two Durable Object indexes over `WatcherIdentity` |
| `UserRegistryObject` | `index.ts:358-385`; DO id `idFromName('user:' + userId)` `:221, :259`; key `identities` `:359`; `add` `:365-373`, `remove` `:375-380`, `list` `:382-384` |
| `MarketIndexObject` | `index.ts:463-480`; DO id `idFromName('market:' + market)` `:211, :261`; key `identities` `:464`; `add` `:470-475`, `list` `:477-479` |
| Consumers | `listWatchers` `index.ts:225`; `deployWatcher` `:259-261`; `watchersForMarket` `:210-214` |
| Lifecycle | append-only; `UserRegistryObject.remove` has no route caller; `MarketIndexObject` has no `remove` at all |

**These indexes are what make `POST /feed` scale by market**: without
`MarketIndexObject`, the feed handler would have to enumerate every watcher.

---

## 10. `Watcher` lifecycle state machine — a transition table

| | |
| --- | --- |
| Mechanism | a static transition table + `applyAction` |
| Location | `watchers/src/contract.ts:90-98` (table), `:100-131` (helpers) |
| States | `CREATED`, `DEPLOYING`, `RUNNING`, `PAUSED`, `STOPPING`, `STOPPED`, `ERROR` — `contract.ts:61-68` |
| Actions | `deploy`, `start`, `pause`, `resume`, `stop`, `fail`, `retry` — `contract.ts:70` |
| Table | `CREATED: {deploy→DEPLOYING, stop→STOPPED, fail→ERROR}`; `DEPLOYING: {start→RUNNING, fail→ERROR, stop→STOPPING}`; `RUNNING: {pause→PAUSED, stop→STOPPING, fail→ERROR}`; `PAUSED: {resume→RUNNING, stop→STOPPING, fail→ERROR}`; `STOPPING: {start→RUNNING, stop→STOPPED, fail→ERROR}`; `STOPPED: {deploy→DEPLOYING, retry→DEPLOYING, start→RUNNING}`; `ERROR: {retry→DEPLOYING, stop→STOPPING}` |
| Resolves | `nextStatus(from, action)` `:100-102`; `canTransition` `:104-106`; `allowedActions` `:108-110`; `applyAction` `:126-131` |
| Idempotent no-ops | `start@RUNNING`, `pause@PAUSED`, `resume@RUNNING`, `stop@STOPPED`, `deploy@{DEPLOYING,RUNNING}` — `isIdempotentNoOp` `:133-147` |
| Throws | `InvalidTransitionError` `:112-117`, carrying `from` and `action` |
| Consumers | `WatcherObject.deploy` `durable-object.ts:180`; `WatcherObject.act` `:222` |

---

## 11. `shouldProcessEvent` — an acceptance rule table

| | |
| --- | --- |
| Mechanism | ordered predicate returning a named rejection |
| Location | `watchers/src/contract.ts:303-351` |
| Rejection vocabulary | `EventRejection` `contract.ts:278-285` — 7 values |
| Consumed by | `Watcher.tick` `watcher.ts:273-278`; a rejection returns `SKIPPED` with the reason `watcher.ts:280-287` |
| Observable effect | the reason is surfaced in the `POST /feed` response `results[]` `index.ts:194, :199` |

Order: `PAUSED` → `NOT_RUNNING` → `WRONG_MARKET` → `DUPLICATE` (empty id) →
`STALE` (non-finite timestamp) → `FUTURE_TIMESTAMP` (skew > 5 000 ms `:323-328`) →
`DUPLICATE`/`OUT_OF_ORDER` (sequence) → `DUPLICATE`/`OUT_OF_ORDER` (timestamp).

**Two separate dedup mechanisms** (CONFIRMED): `processedEvents` in the browser engine
(`engine.ts:196-201`, bounded at 10 000) and `lastSequence`/`lastTimestamp` on the
watcher state (`contract.ts:330-347`).

---

## 12. `assessHealth` — an ordered check ladder

| | |
| --- | --- |
| Mechanism | first-match-wins ladder returning a `HealthState` |
| Location | `watchers/src/health.ts:98-171` |
| States | `STARTING`, `HEALTHY`, `STARVED`, `DEGRADED`, `ERROR`, `STOPPED` — `health.ts:17-29` |
| Thresholds | `DEFAULT_HEALTH_THRESHOLDS` `health.ts:66-71` — `marketDataStaleMs: 60_000`, `evaluationStaleMs: 120_000`, `degradedAfterFailures: 3`, `graceMs: 15_000`; overridable via `env.healthThresholds` `durable-object.ts:55` |
| Input | `Watcher.health` `watcher.ts:456-472` |
| Output | `HealthReport` `health.ts:73-88`, enriched by `WatcherObject.health()` `durable-object.ts:300-304` with `watcherId`, `status`, `configVersion`, `pendingWakes`, `staleAcknowledgements` |
| Consumers | `GET /watchers/{id}/health` `index.ts:312-314`; `snapshot` `:296` |

Check order: stopped states `:108-119` → `lastError` `:121-128` → heartbeat grace
`:130-133` → consecutive failures `:135-142` → market-data staleness `:144-154` →
evaluation staleness `:156-163` → `HEALTHY` `:165-170`.

**Note (CONFIRMED)** — `lastSuccessfulEvaluationAt` and `lastConfigChangeAt` are passed
into the input (`watcher.ts:463, 467`) but are not read by `assessHealth`.

---

## 13. `digest` — id derivation (FNV-1a)

| | |
| --- | --- |
| Mechanism | non-cryptographic hash used as the basis for every id |
| Location | `watchers/src/ids.ts:24-36`; avalanche `mix` `:38-46` |
| Constants | `FNV_OFFSET = 0x811c9dc5`, `FNV_PRIME = 0x01000193` — `ids.ts:14-15` |
| Output | 13 characters (`base36(hash).padStart(7,'0') + base36(second).padStart(6,'0')`) `ids.ts:34-35` |
| Derives | `watcherIdFor` → `w_…` `:49-51`; `evaluationIdFor` → `ev_…` `:54-56`; `wakeIdFor` → `wk_…` `:67-69`; `idempotencyKeyFor` → `tv-…` `:79-81` |
| Consumers | `index.ts:225, 250, 213`; `watcher.ts:303, 483`; `wake-queue.ts:342, 347`; `evaluator.ts:82, 106, 144, 153` |
| Duplicated definition | `watcherIdFor` exists twice with byte-identical bodies — `ids.ts:49-51` and `contract.ts:41-43`. `watcher.ts:26` and `index.ts:40` import the contract copy; `durable-object.ts:31` imports the ids copy |

Because every wake and evaluation id is a pure function of
`(watcherId, marketEventId, configVersion)`, wake dedup is deterministic across
retries and across DO restarts.

---

## 14. `ConditionEngineClient` — an HTTP service proxy

| | |
| --- | --- |
| Mechanism | typed proxy over the Python engine's HTTP surface |
| Location | `src/engine/conditions/engineClient.ts:131`; factory `conditionEngine()` `:314` |
| Base URL | `DEFAULT_ENGINE_URL = 'http://127.0.0.1:8099'` `:129` |
| Methods | `health` `:189`, `status` `:200`, `catalogue` `:207`, `instruments` `:213`, `evaluate` `:228`, `test` `:243`, `fixtureContexts` `:252`, `registerTrigger` `:259`, `unregisterTrigger` `:267`, `triggerStatus` `:271`, `wakes` `:277`, `acknowledgeWake` `:289`, `events` `:295` |
| Transport seam | `options.fetch` → `this.doFetch` `:133, :138` |
| Timeout | `AbortController` + `setTimeout` `:145-146` |
| Contract handling | `assertCanonical` `:177-179` validates locally before spending a round trip; a 422 whose detail includes `"Not a canonical"` becomes a `ConditionContractError` `:157-159` |
| Consumers | `components/triggers/TriggerCard.tsx:108`; `conditionParity.ts` (test-only) |

---

## 15. Container-injected resolvers

| Mechanism | Location | What it hides |
| --- | --- | --- |
| `TriggerAgentResolver` | `triggers/registry.ts:5`; closure at `App.tsx:100` | `TriggerRegistry` → `agentRuntime.getAgent` — the registry never imports the runtime |
| `TriggerDelivery` | `triggers/engine.ts:48`; built in the constructor `:64-73` | the engine's wake path; the closure captures the runtime at `engine.ts:57` |
| `AgentModel` (`IAgentModel`) | `runtime.ts:57` default `agentModel`; impl `agents/model/openrouter.ts` | the LLM provider behind the agent loop |
| `MarketDataProvider` interface | `src/adapters/marketData.ts`; impl `HyperliquidMarketDataAdapter` `marketData.ts:34` | the venue behind discovery/quotes/bars |
| `ConditionEvaluator` interface | `watchers/src/watcher.ts`; impls `HttpConditionEvaluator` `evaluator.ts:36` and `ScriptedEvaluator` `evaluator.ts:126` | the Python engine behind trigger evaluation; the scripted double exists for tests |
| `AgentTimelineStore` | `runtime.ts:58` default `InMemoryAgentTimelineStore`; the `agentRuntime` singleton uses `PersistentAgentTimelineStore` `runtime.ts:1782` | the activity log backend |
| `HyperliquidTransport` | `marketData.ts:25` | the HTTP call inside the market-data adapter |
| `clock` parameter | `engine.ts:57`; `monitor.py:134`; `store.py:65` (`set_clock`) | wall-clock time in trigger, monitor, and store code paths |
| `fetch` option | `engineClient.ts:138`; `evaluator.ts:56-57` | the network in both condition-engine clients |

---

## 16. Mechanisms deliberately absent

| Not present | Verified by |
| --- | --- |
| Cloudflare Queues producer/consumer | no `[[queues.*]]` in `wrangler.toml`; no `queue()` export in `index.ts` |
| Cron / `scheduled` handler | no `[triggers]` in `wrangler.toml`; no `scheduled` in `watchers/src` |
| Kafka / Redis / SQL / NoSQL client | no such package in any of the three manifests; no connection string in any config |
| Service locator / IoC container | none; the only DI is constructor default arguments and closures |
| Plugin loader / dynamic `import()` | no `import(` in `src/`, `server/`, or `watchers/src` |
| `require()` | not used (all ESM) |
| Route-table reflection | routing is a `switch`/ternary chain in `App.tsx:2240-2573` and `if` chains in `watchers/src/index.ts:88-141` and `server/tradingv_engine/api.py:216-389` |
| Web-worker thread pool | only `sandboxEnv.createWorkerBlobScript` `sandbox/sandboxEnv.ts:81`, which has no production consumer |
