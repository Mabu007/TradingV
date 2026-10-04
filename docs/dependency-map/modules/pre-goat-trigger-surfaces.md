# Module 4 — Trigger Surfaces

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Location:** `src/components/triggers/`

**Purpose:** the condition-tree builder, the live trigger tester, and the server-backed
trigger card. This is the only place in `src/components/` that imports engine code.

---

## Contains

| File | Lines | Export | Rendered by |
| --- | --- | --- | --- |
| `TriggerBuilderPanel.tsx` | 329 | `TriggerBuilderPanel` | `App.tsx:2729` (always mounted; self-gates on `open` at `:104`) |
| `TriggerBuilder.tsx` | 1262 | `TriggerBuilder` | `TriggerBuilderPanel.tsx:237-247` |
| `TriggerCard.tsx` | 431 | `TriggerCard` | `BotBuilderModal.tsx:316` |

---

## `TriggerBuilderPanel` — the shell

Self-gates: returns `null` when `open` is false — `TriggerBuilderPanel.tsx:104`.

**Props from `App`**

| Prop | App line |
| --- | --- |
| `open={showTriggerBuilder}` | `:2731` |
| `trigger={editingTrigger}` | `:2735` |
| `defaultSymbol={symbol \|\| undefined}` | `:2739` |
| `defaultTimeframe={timeframe}` | `:2743` |
| `markets={discoveredSymbols.map(...)}` | `:2746-2755` |
| `context={triggerTestContext}` | `:2757` |
| `onSave` → `setLabTriggers(upsert by id)` | `:2759-2778` |
| `onClose` → `setShowTriggerBuilder(false)` | `:2779-2783` |

The panel resets its form on open — `TriggerBuilderPanel.tsx:88-99` — and passes
`context` down to `TriggerBuilder` at `:240`.

---

## `TriggerBuilder` — the live evaluator

**Evaluation happens on every change, client-side, with no network call.**

```
validateConditionTree(root)                              TriggerBuilder.tsx:90
   └ problems rendered at :322-334
liveResult = evaluateConditionTree(root, context)        TriggerBuilder.tsx:96
   └ verdict rendered at :347-363
      "WOULD FIRE" / "WOULD NOT FIRE" / "CANNOT MEASURE"
```

`context` is the `triggerTestContext` memo from `App.tsx:2014-2049`, built from
`symbol`, `instruments`, `quotes`, `bars`, `positions`, `timeframe`, `executionMode`
and `undefined` when `!symbol` (`:2049`).

**Imports** — the only component file that imports engine code:
`src/engine/agents/triggers/evaluator.ts` (`evaluateTrigger`) and/or
`src/engine/agents/triggers/conditions.ts` (`evaluateConditionTree`,
`validateConditionTree`, `summariseTree`, `describe`), plus
`src/engine/indicators/index.ts` and `src/engine/agents/triggers/proximity.ts`
transitively through those.

**Save path**

```
handleSave                                                TriggerBuilder.tsx:106
   └─ build a BotTrigger                                  :111-126
   └─ props.onSave(next)                                  :128
        → App.setLabTriggers(upsert by id)                App.tsx:2768-2777
   └─ props.onClose()                                     :129
```

**Observable consequence (CONFIRMED)** — lab triggers saved here are **drafts**. They
reach `App.labTriggers` and the AI context (`App.tsx:1957-1968`) but are **never
registered with `triggerRegistry`**. Only `BotDefinition.triggers[]` reach the runtime
(`App.tsx:1192`).

---

## `TriggerCard` — the server-backed path

Rendered only inside `BotBuilderModal` (`BotBuilderModal.tsx:316`), i.e. only inside
the bot-creation wizard.

```
conditionEngine()                                         TriggerCard.tsx:108
   → src/engine/conditions/engineClient.ts:314
      base DEFAULT_ENGINE_URL = 'http://127.0.0.1:8099'   engineClient.ts:129
   ├─ client.health()            → GET  /health           TriggerCard.tsx:116
   ├─ client.fixtureContexts()   → GET  /fixtures         TriggerCard.tsx:121
   ├─ client.instruments()       → GET  /instruments      TriggerCard.tsx:121
   └─ client.test(tree, context) → POST /test             TriggerCard.tsx:135
```

This is the **only** place in the running UI that reaches the Python engine.

---

## Depends on

| Module | How |
| --- | --- |
| App Shell | props and callbacks |
| Condition Engine Client | `TriggerCard` → `conditionEngine()` |
| Trigger Engine | `TriggerBuilder` → the in-browser evaluator and indicators |
| UI Views | rendered by `BotBuilderModal` (`TriggerCard`) |
| Bot Definitions | `TriggerBuilderPanel` builds a `BotTrigger` (`TriggerBuilder.tsx:111-126`) |

## Used by

`App` (`TriggerBuilderPanel` `App.tsx:2729`) and `BotBuilderModal`
(`TriggerCard` `BotBuilderModal.tsx:316`).

---

## Reads

`App.quotes`, `App.bars`, `App.positions`, `App.instruments`, `App.timeframe`,
`App.executionMode` (via the `triggerTestContext` memo) ·
`App.labTriggers` (via `editingTrigger`) ·
the local form state.

## Writes

| Target | Line |
| --- | --- |
| `App.labTriggers` (upsert) | `App.tsx:2768-2777` |
| `App.showTriggerBuilder = false` | `App.tsx:2780` |
| `App.editingTrigger` | `App.tsx:2481` |
| Python engine trigger registration | via `TriggerCard` → `ConditionEngineClient.registerTrigger` `engineClient.ts:259` |

## Mutates

Local form state only in `TriggerBuilder` / `TriggerBuilderPanel`:
the condition tree being edited, the selected leaf, the timeframe, and the market.

## Emits

None. No `eventBus` use in `src/components/`.

## Subscribes to

Nothing. There is no `eventBus` subscription anywhere in `src/components/`
(repo-wide grep).

## External dependencies

- **None** for `TriggerBuilder` / `TriggerBuilderPanel` — all evaluation is in-browser.
- HTTP to `http://127.0.0.1:8099` for `TriggerCard` via
  `ConditionEngineClient` — `engineClient.ts:148` (`doFetch` `:138`).

## Entry points

`TriggerBuilderPanel` `App.tsx:2729` · `TriggerBuilder` `TriggerBuilderPanel.tsx:237`
· `TriggerCard` `BotBuilderModal.tsx:316`.

## Exit points

- `onSave` → `App.setLabTriggers` (drafts only).
- `TriggerCard` → the Python engine's `GET /health`, `GET /fixtures`,
  `GET /instruments`, `POST /test`, and `POST /triggers`.

---

## Notable observations (factual)

- **Two different evaluators sit behind the same UI concept.** The Trigger Lab uses
  the in-browser evaluator (`src/engine/agents/triggers/conditions.ts`, 9 leaf kinds);
  the bot-builder Trigger Card uses the Python engine over HTTP (24 leaf kinds). The
  shared contract is `shared/condition_schema_v1.json`, not code.
- **The Trigger Lab has no network dependency** — it evaluates against the same
  `bars` / `quotes` / `positions` the chart already holds.
- **The `CANNOT MEASURE` verdict** (`TriggerBuilder.tsx:347-363`) reflects the
  three-state model: an unmeasurable condition is not the same as `FALSE`.
- `TriggerCard`'s server calls fail with a `ConditionEngineError` whose message is
  `"Could not reach the condition engine at {baseUrl}. Is it running?"`
  (`engineClient.ts:167-171`) when the Python service is not running.
