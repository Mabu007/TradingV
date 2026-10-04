# GOAT — Goal-Oriented Agentic Trader

> **The user defines the goal. GOAT determines how to pursue it.**

GOAT is an agentic trading research and decision system. The user states
an objective; the agent investigates, forms hypotheses, decides what
evidence would confirm or refute them, deploys deterministic trackers,
and sleeps until something it asked for happens.

The user is not asked to configure indicators, conditions, trackers or
watchers. Those are implementation details, and the agent determines
them.

---

## 1. The loop

```text
USER
  │
  ├── GOAL
  └── SKILLS (optional)
        │
        ▼
      GOAT agent
        │
        ▼
   INVESTIGATION
        │
        ▼
     THESIS ── what is the current hypothesis
        │
        ▼
 OBSERVATION PLAN ── what evidence would confirm or refute it
        │
        ▼
    TRACKERS ── deployed, deterministic, cheap
        │
        ▼
 TRACKER RUNTIME ── shared market data, shared indicators
        │
        ▼
    DORMANCY ── the agent stops. It does not poll.
        │
        ▼
   TRACKER EVENT ── something relevant happened
        │
        ▼
   WAKE GOAT
        │
        ▼
 RE-EVALUATION
        ├── thesis valid ──→ update thesis, keep watching
        └── thesis invalid ──→ revise or abandon, cancel trackers
```

The dormancy is the load-bearing property. The agent reasons twice in
its life — once when the goal is created, once per tracker event — and
does nothing in between. `GoatLoop` has no polling loop anywhere in it.

---

## 2. The five core objects

| Object | What it is | What it is not |
| --- | --- | --- |
| **Goal** | The user's objective, in their words | An implementation plan |
| **Thesis** | A revisable hypothesis about the market | A position, or a confidence score to trade on |
| **Tracker** | A deterministic monitor GOAT deployed | Something a user configures |
| **Evidence** | A timestamped, sourced observation for or against a thesis | A fact that is true |
| **TradeIdea** | A structured proposal with an explicit invalidation | An order, or permission to place one |

The distinctions that matter:

```text
GOAL  = what the user wants
SKILL = how GOAT should approach it
TOOL  = what GOAT can do
TRACKER = what GOAT deployed to observe
THESIS = what GOAT is currently testing
```

A **skill** shapes reasoning. A **tool** is an operation. A **tracker**
is what the runtime watches. A **thesis** is the hypothesis under test.
They are separate types, kept separate in the code.

---

## 3. Invalidation is a first-class concept

A GOAT must answer *"what must happen for my hypothesis to be wrong?"*
before it can price anything.

`Thesis.invalidation` is that answer. `TradeIdea.invalidationLevel` is
that answer expressed as a price, derived from the thesis rather than
from a position-sizing rule. The runtime checks it: a skill can declare
`REQUIRE_INVALIDATION_BEFORE_TRADE`, and the loop refuses to construct
an idea without one.

A stop that is merely a risk parameter is not this. A stop that is
"beyond the swing that would break my structure" is.

---

## 4. Architecture

```text
src/engine/goat/
  types.ts          domain model: Goal, Thesis, Evidence, Tracker,
                    TrackerEvent, TradeIdea, WakeRequest, AgentPlan
  store.ts          in-memory + persistent (localStorage) stores
  trackerRuntime.ts the runtime: lifecycle, expiry, events, ceilings
  trackerSdk.ts     the constrained, permissioned agent-facing API
  skills.ts         skill packages, phases, machine-checked constraints
  builtinSkills.ts  market-structure, momentum, risk, breakout
  loop.ts           the loop: thesis lifecycle, wakes, plan application
  orchestrator.ts   wiring onto the existing agent and tracker runtime
  tests.ts          58 tests
```

### What was reused, and what was added

This was an architecture transformation, not a rewrite. The existing
engine already had most of the infrastructure, and the important part
of the work was recognising it:

| Needed | Already existed | What was added |
| --- | --- | --- |
| Tracker Runtime | `agents/trackers` — `TrackerRegistry`, `TrackerRuntime` | Thesis ownership, lifecycle, expiry, ceilings, the event envelope |
| Deterministic evaluation | `evaluateTracker` (17 tracker kinds) | Nothing — it *is* the implementation |
| Tools | `CapabilityRegistry` (31 capabilities) | The 6 tracker capabilities, bound to a runtime |
| Execution boundary | `ActionValidator`, `riskManager` | Nothing — still the only path to an order |
| Backtest parity | `BacktestEnvironment`, replay pipeline | Nothing — the same evaluation runs on both |
| Audit history | `AgentTimelineStore` | Goals, theses, evidence and ideas got stores too |
| Event system | `eventBus` | Reused; no competing bus |

What did **not** exist and had to be built: Goal, Thesis, Evidence,
TradeIdea, a tracker lifecycle, an agent-authored observation plan, and
skills that participate throughout the loop.

---

## 5. The Tracker SDK

GOAT never touches the tracker registry directly. It goes through the
SDK, which enforces before anything is registered:

- the agent holds the capability it is exercising
- the target thesis belongs to that agent
- the target tracker belongs to one of the agent's theses
- the spec passes the runtime's validation
- the ceilings have room

Every refusal is an error with a code, not a silent no-op, so the agent
learns why it could not do what it asked.

```ts
sdk.create(thesisId, {
  purpose: 'Watch for momentum recovery on 15m',
  type: 'INDICATOR_CROSS',
  config: {
    indicatorKey: 'rsi14',
    indicator: { type: 'RSI', period: 14 },
    level: 50,
    direction: 'ABOVE',
  },
  priority: 60,
});
```

Capabilities: `trackers.create`, `.update`, `.pause`, `.resume`,
`.cancel`, `.inspect`. They are granted through skills and are
observation-only — none of them places, sizes, approves or cancels an
order.

---

## 6. Trackers are facts, not signals

```ts
interface TrackerEvent {
  eventType: 'PRICE_REACHED_LEVEL' | 'INDICATOR_CROSSED' | ...;
  reason: string;
  observedValues?: Record<string, number | string>;
  severity: 'INFO' | 'NOTABLE' | 'SIGNIFICANT' | 'DECISIVE';
}
```

There is deliberately no `side` and no `action`. A tracker firing means
*something relevant to the current hypothesis happened*. Interpreting it
is the agent's job, and it happens on every wake, not once at
registration.

A test asserts this: serialising an event must not produce a `side`, an
`action`, or a `BUY`/`SELL` direction.

---

## 7. Skills

A skill is a self-contained package that shapes **how** GOAT approaches
a problem, and it participates in every phase of the loop rather than
being a system prompt appended once:

```ts
interface SkillPackage {
  instructions: string;
  phases?: Partial<Record<SkillPhase, string>>;  // 7 phases
  requiredCapabilities?: string[];
  grants?: string[];                              // observation authority
  constraints?: SkillConstraint[];                // machine-checked
  evaluators?: AgentCapability[];                 // specialised tools
}
```

Phases: `GOAL_INTERPRETATION`, `INVESTIGATION`, `THESIS_FORMATION`,
`TRACKER_PLANNING`, `EVENT_INTERPRETATION`, `THESIS_REVISION`,
`TRADE_CONSTRUCTION`.

Constraints are enforced, not requested:

| Constraint | Effect |
| --- | --- |
| `REQUIRE_INVALIDATION_BEFORE_TRADE` | No trade idea without an invalidation level |
| `REQUIRE_EVIDENCE_BEFORE_ACTIONABLE` | Thesis needs N supporting items first |
| `MAX_TRACKERS` / `MAX_THESES` | Ceilings; the strictest wins on conflict |
| `FORBID_ORDER_TYPE` | That order type cannot be proposed |
| `REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION` | Declared to the agent |

A constraint the runtime cannot check is a preference. Only the kinds
the runtime actually enforces are modelled.

Skills cannot bypass the runtime. A skill grants capability ids the
registry already knows; it cannot reach the database, the network, or
execution. A missing or disabled skill throws rather than being
silently ignored — a user who believes their risk discipline is in
force should never be wrong about that.

---

## 8. Reasoning is separated from execution

```text
Reasoning    produces a TradeIdea.  Needs no execution permission.
Execution    converts an idea into an order.
             Passes through ActionValidator and riskManager.
```

`GoatLoop` has no path to `placeMarketOrder`. Every GOAT agent is
registered with `allowTrading: false` by default, because pursuing a goal
for months should not require the authority to trade it.

An idea completing a thesis does not place an order. A test asserts
that a thesis which is not `ACTIONABLE` produces no idea at all, and
that nothing is stored when it is refused.

---

## 9. Backtest and live share the evaluation

```text
Live quotes   ─┐
               ├─→ TrackerRuntime ─→ same evaluation ─→ TrackerEvent
Historical bars ┘
```

The runtime evaluates tracker definitions; it does not know which
environment produced the input. A test drives the same tracker with
`DEMO` and `BACKTEST` events and asserts identical event type, severity
and observation. The agent/thesis/tracker logic does not branch on
environment — only the market and execution adapters do.

---

## 10. Resource efficiency

Trackers do not each get a market data connection. They share the
existing engine's single event subscription, its per-agent fan-out and
its cached instrument metadata. The hundredth tracker costs a
comparison, not a connection.

Ceilings are enforced per thesis, per agent and globally, so a
misbehaving agent cannot spawn trackers without limit. Event history is
bounded per tracker, and evidence is bounded globally, because those are
the two stores that grow without limit in normal operation.

---

## 11. Creation and deployment

A GOAT is a goal and some skills. That is the whole of it:

```text
CREATE A GOAT
      ↓
GOAL      [ free text, as much or as little as you like ]
      ↓
SKILLS    [ attach existing · or write a new one in place ]
      ↓
Create GOAT
```

No market. No timeframe. No indicators, conditions, trackers, entry or
exit rules. The observation plan is the agent's own output.

Two things follow from a GOAT not being bound to a market.

**It is reusable.** The same goal can be pointed at any market, and the
goal, its theses, its evidence and its skills are all kept across the
move. Redeploying retires the trackers that were watching the old
market, with a reason, rather than leaving them watching it.

**The market is chosen after the user has read the agent's reading of
their goal.** Asking someone to pick EURUSD before they have seen what
the GOAT made of their sentence is asking for a decision they are not
ready to make, and it is why creation is one field.

```text
Deploy this GOAT
      ↓
Market (one list, display names only)
      ↓
Deploy in SHADOW
```

The deploy panel asks for one thing. Timeframe, mode, account and
permissions are not questions for the user at this point: the mode is
`SHADOW` because a GOAT should be tried before it is trusted with
anything, and the rest is the GOAT's work rather than configuration.

`SHADOW` is a first-class mode, not a synonym for paper: real market data,
real decisions, nothing executed.

### Deploying starts the loop

Recording a deployment is configuration, not work. A GOAT with no thesis
and no trackers has nothing that can wake it, so deploying is followed by
the loop's real first step:

```text
deployGoat()          register the executor, record the deployment
      ↓
investigateGoal()     read the goal, form a hypothesis with a stated
                      invalidation, deploy the observation plan
      ↓
GoatLoop.investigate() create the thesis, then deploy trackers through
                      the Tracker SDK — permission-checked, capped,
                      deduplicated like every other tracker
      ↓
TrackerRuntime        deterministic evaluation, no reasoning while waiting
```

Three properties this keeps:

* **Nothing is fabricated.** The thesis and its trackers come from the
  model. If the model returns nothing usable, the pass reports why and
  creates no thesis. A GOAT that formed nothing shows an empty activity
  feed rather than a convincing lie.
* **Starting twice does not start twice.** `investigateGoal` is
  single-flight per agent, and `resumeUnstartedGoats()` runs once at
  startup for deployments that were never started — and for deployments
  whose thesis survived a reload while its observation plan did not,
  which is a reload's whole effect on runtime state.
* **The runtime state is reported, not decorated.** `investigateGoal`
  returns what happened, including refusals: which proposed trackers were
  discarded, and why the GOAT has nothing to wake it.

### What the user sees: mission, work plan, trade plan

The runtime's state is projected into one read model, `GoatMission`, and
everything on screen is derived from it. No second source of truth, and no
value on screen that the runtime did not write.

```text
GoatMission
   stage          DRAFT → INVESTIGATING → MONITORING → UNDEPLOYED
   runtime        RUNNING · STOPPED · UNDEPLOYED · ERROR
   activity       what it is doing right now, in one sentence
   workPlan       understand → inspect → thesis → evidence
                  → monitor → plan → risk → execute
   thesis         the current hypothesis and its invalidation
   trackers       what it deployed to watch, and its state
   tradePlan      the trade idea it produced, and its status
   evidence       what supports it and what contradicts it
   steering       what the operator told it
```

A step is `done` only when the record that proves it exists. "Understand
your objective" completes when the goal is saved; "Form a thesis" when a
thesis is; "Build trade plan" when a trade idea is. A GOAT that has been
deployed but has no model has genuinely done nothing beyond being pointed
at a market, and the plan says so.

`ERROR` is a real state, not an edge case: a deployment with no executor
is a GOAT that looks deployed and cannot act, and hiding that is worse
than showing it. A missing model, an unreachable venue and a refused
capability each surface as themselves.

### The trade plan is a status, not a price

`TradeIdea` carries a lifecycle — `PROPOSED`, `RISK_CHECK`, `READY`,
`EXECUTING`, `MANAGING`, `CLOSED`, `INVALIDATED`, `WAITING` — and the
status is the safety property, not a label on a chart. A plan in `SHADOW`
records `execution.canExecute: false` and never advances past
`RISK_CHECK`; a plan whose risk check fails records why instead of
disappearing.

### Stop, play and steer

```text
stop()    cancels trackers with a reason, releases the executor, and
          RETAINS the deployment record
play()    reactivates that same record, rebuilds the executor from it, and
          restores the observation plan only if it is actually missing
steer()   records an operator note; the next reasoning step reads it
```

Retaining the deployment on stop is not tidiness. `currentFor()` returns
only active deployments, so a stopped GOAT whose record was retired comes
back with no deployment at all — and a command centre with no deployment
can only offer "Deploy", which tells the user a GOAT that ran all morning
was never set up and invites a second deployment for a GOAT that already
has one. The mission therefore reads the last deployment when there is no
active one, and `liveMissions()` filters on `runtime === 'RUNNING'` so a
stopped GOAT is never listed as live.

### The Explorer is a shortcut, not a second product

"Use this GOAT" calls `createGoatFromStarter()`, which delegates to
`createGoat()` with the starter's own goal and skill ids. What lands is an
ordinary GOAT: the same review screen, the same deploy panel, editable
like any other. All four shipped starters are covered by the same
end-to-end test, through the same functions the UI calls.

### Writing a skill

A skill is a markdown document the user writes, in the app:

```markdown
---
id: patience
name: Patience
description: Sit on your hands when structure is unclear.
---

Unclear structure is a reason to do nothing.

## THESIS_FORMATION

Do not form a thesis inside a range.

## Constraints

- REQUIRE_EVIDENCE_BEFORE_ACTIONABLE: 2
- MAX_TRACKERS: 8
```

A `## <PHASE>` section is guidance for that phase of the loop;
`## Constraints` is the part the runtime can actually enforce. A typo
in a constraint is refused with the line it came from rather than
dropped, because a dropped constraint is a rule the user believes is in
force and is not. `parseSkillMarkdown` and `toSkillMarkdown` are
inverses, so editing a skill never quietly weakens it.

`src/engine/goat/skillStore.ts` keeps the document, not the parsed
skill, so a skill can be exported, imported and re-read by a better
parser later without a migration.

### Starter GOATs

`src/engine/goat/starterGoats.ts` ships Trend Scout, Breakout Hunter,
Momentum GOAT, Mean Reversion, Session Hunter, Structure Scout and
Conservative Trader. Each is a real `GoatDefinition` — same validation,
same agentic loop, same Tracker SDK, same risk boundary. None carries an
observation plan, and none ships with execution authority; that is
granted per deployment by a human.

Trackers are inspectable — purpose, owner thesis, data requirements,
last evaluation, expiry, fire count — but read-only. An editable tracker
is a configuration surface, and a configuration surface is the thing
this architecture replaced.

## 11b. The schema has nowhere to put a tracker

`GoatDefinition` has no `trackers` field, and `validateGoatDefinition`
refuses unknown fields outright.

Refusing rather than ignoring is the load-bearing part. Ignoring extras
would make re-introducing the bot architecture a silent no-op: someone
could add a `trackers` array back, watch validation pass, and conclude
it worked. A test asserts that a definition carrying a smuggled
a `trackers` array is *rejected*.

---

## 12. What is deliberately not built

- **No confidence-to-size mapping.** Confidence is advisory and clamped;
  sizing comes from account equity and the invalidation level.
- **No self-modifying execution.** A GOAT can construct ideas; it
  cannot place orders without an explicit grant it does not get by
  default.
- **No live execution environment.** `createLiveEnvironment()` still
  throws, and `registerAgent` still refuses a LIVE agent.
- **No thesis auto-promotion to actionable.** The skill constraints
  gate it and the runtime checks them.
- **No skill-provided network or database access.** Not modelled,
  because the capability boundary has no such capability to name.

---

## 13. Tests

```bash
bun run test:agents    # includes 112 GOAT tests
```

Coverage:

- **Tracker Runtime** — creation, ownership, firing, pause/resume,
  cancel (terminal and retained), expiry, update-preserves-history,
  per-thesis ceilings, unknown-thesis and unknown-tracker rejection,
  data requirements, and that an event carries no direction.
- **Thesis lifecycle** — every legal transition, illegal transitions
  refused, terminal states, revision counting, invalidation revision.
- **Agent loop** — confirm, weaken, invalidate, revise; multi-thesis
  isolation; duplicate-wake refusal; vanished-thesis cancellation.
- **Skills** — loading, validation, unknown-capability rejection,
  unknown-phase rejection, duplicate ids, disabled silence, per-phase
  participation, conflict resolution, evidence gating.
- **Permissions** — ungranted capability, foreign thesis, foreign
  tracker, skills unable to widen authority, live grant re-checking.
- **Integration** — goal → thesis → tracker → event → wake → thesis
  update; a wake deploying a *new* tracker; a wake retiring one;
  invalid plans refused and reported; identical behaviour in backtest
  and live; a vague goal blocked rather than guessed at; no fabricated
  interpretation when the model is unavailable; user words preserved
  verbatim beside the agent's reading.

The whole loop runs with a deterministic stub model and a hand-fed
tracker event. No network, no API key, no trading.
