# Chain: Python Engine Tick

> **Historical snapshot.** Generated against the pre-GOAT application, in
> which hand-authored *triggers* were part of a bot definition. That
> architecture is gone; the current one is described in
> [architecture.md](../architecture.md) and [trackers.md](../trackers.md).
> Trigger and bot symbol names below are kept verbatim for that reason.

**Trigger:** the `asyncio` poll loop started by the FastAPI startup hook.

**Confidence:** CONFIRMED.

---

```
[0] python -m tradingv_engine                        package.json:23
    └─ tradingv_engine.__main__:main()               __main__.py:19
```

## Stage 0 — startup

| Step | Line | Action |
| --- | --- | --- |
| `load_config()` | `__main__.py:52` | `config.py:111-112` → builds `EngineConfig` from env |
| CLI overrides | `__main__.py:55-60` | `--host`, `--port`, `--poll-interval` via `dataclasses.replace` (`_replace` `:94-97`) |
| `--print-schema` / `--list-events` | `__main__.py:43`, `:50` | early return |
| `assert_local_only(config.host)` | `__main__.py:63` | `config.py:144-161`; a non-loopback bind raises `RuntimeError` → `return 2` at `__main__.py:69` |
| live-trading warning | `__main__.py:71-78` | warns when `live_trading_enabled` |
| import `create_app` | `__main__.py:81` | `ImportError` → `return 2` at `:84` |
| `uvicorn.run(app, host, port, log_level="info")` | `__main__.py:90` | |

FastAPI lifespan:

```
@app.on_event("startup")   →  await engine.start()      api.py:206-208
@app.on_event("shutdown")  →  await engine.stop()       api.py:210-212
app.state.engine = engine                              api.py:165
app.state.config = resolved                            api.py:166
```

CORS middleware — `api.py:168-202`; `OPTIONS` short-circuits with 204
(`api.py:172-174`); the error boundary is a bare `except Exception` with a
`uuid.uuid4().hex[:12]` correlation id (`api.py:175-199`).

## Stage 1 — the loop

```
ConditionEngine.start()                                  engine.py:250-256
   └─ self._stopping.clear()                             engine.py:251
   └─ self._task = asyncio.create_task(self._loop())     engine.py:253
   ↓
ConditionEngine._loop()                                  engine.py:268-287
   while not self._stopping.is_set():
       ↓ await asyncio.to_thread(self.tick_once)        engine.py:279   ← THREAD BOUNDARY
       ↓ await asyncio.wait_for(self._stopping.wait(),
                                 timeout=interval)       engine.py:286-287
       ↑ interval = _effective_interval_s()              engine.py:289-296
         = max( min(config.poll_interval_s,
                     min(trigger.minEvaluationIntervalMs)/1000), 1.0 )
```

`tick_once(now_ms=None)` — `engine.py:298-307`:

```
ConditionEngine.tick_once(now_ms)
   ↓ MarketMonitor.tick(now_ms)                          monitor.py:319-322
   ↓ map WakeEvent → QueuedWake for each fired trigger   engine.py:298-307
   ↓ return list[QueuedWake]
   ↓ ConditionEngine._enqueue(wake) for each              engine.py:237-246
       append to self._queue (deque, cap WAKE_CAPACITY=200)   engine.py:69, :244
       self._sequence += 1  → wake id                     engine.py:88, :243
       for listener in self._wake_listeners: listener(qw) engine.py:244
   ↓ as a side effect, appends to self._queue
```

`ConditionEngine.stop()` — `engine.py:258-266` — sets `_stopping` (`:259`), cancels
the task (`:260-262`), and awaits it.

## Stage 2 — refresh

```
MarketMonitor.refresh()                                  monitor.py:254-280
   ├─ required_series()  → sorted(set of (market, timeframe)
   │    across all enabled triggers)                     monitor.py:235-250
   ├─ for each (symbol, timeframe):
   │    CandleStore.get(symbol, timeframe, refresh=True) monitor.py:262 → store.py:69
   │       ├─ try self._fetch(symbol, timeframe)         store.py:77
   │       │    └─ MarketMonitor._fetch                  monitor.py:160-161
   │       │         └─ HyperliquidMarketData.candles(symbol, timeframe,
   │       │                                            limit=config.history)
   │       │                                            marketdata.py:257-309
   │       │              ↓ _transport({...})           marketdata.py:275-285
   │       │              ↓ self._http_post             marketdata.py:137-149
   │       │                 urllib.request.urlopen(config.resolved_api_url())
   │       │                 POST {type:'candleSnapshot',
   │       │                       req:{coin, interval, startTime, endTime}}
   │       │                                          marketdata.py:146, 276-285
   │       ├─ on success: build CandleEntry(series, fetched_at_ms=clock(),
   │       │     last_bar_time_ms=int(series.times[-1]) or now)
   │       │     self._entries[(symbol,timeframe)] = entry      store.py:83-87
   │       │     entry.fetch_count += 1                        store.py:84
   │       └─ on exception: return the PREVIOUS entry unchanged  store.py:78-81
   └─ self.cache.invalidate(...) on any success          monitor.py:272
```

**Deduplication (CONFIRMED)** — `required_series()` returns a `sorted(set(...))`
(`monitor.py:235-250`), so N triggers on one market produce one fetch.

**Feed staleness policy (CONFIRMED)** — a fetch failure silently keeps the previous
entry (`store.py:78-81`); the entry's age is then evaluated by
`CandleEntry.is_stale` (`store.py:43-44`, default 10 minutes `:31`).

`HyperliquidMarketData` raises `MarketDataError` for `URLError`, `TimeoutError`,
`JSONDecodeError`, `OSError` (`marketdata.py:148-149`) and for an empty candle set
(`marketdata.py:288-289`).

## Stage 3 — context construction

```
MarketMonitor.evaluate_all(now_ms)                       monitor.py:282-317
   ↓ for each registered trigger:
   │   MonitorContextBuilder.for_symbol(
   │       symbol, trigger.timeframes(), now_ms,
   │       require_tradeable=trigger_requiring_tradeable(...))   store.py:168-240
   │     ├─ for each timeframe: store.entry_for(sym, tf)      store.py:179
   │     │     skip missing                                store.py:180-181
   │     │     stale entries are collected and DROPPED      store.py:182-184
   │     ├─ price = float(series_map['15m'].close[-1])      store.py:188-192
   │     │     (or the first available; accepted only if > 0)
   │     ├─ tradeable = instrument is not None and
   │     │     instrument['availability'] == 'TRADEABLE'   store.py:194-195
   │     ├─ if require_tradeable and not tradeable:
   │     │     return a context with series={}, price=None, spread=None,
   │     │            event_type=None, unavailable_reason  store.py:197-219
   │     ├─ spread     = None if stale else self.spread     store.py:226
   │     ├─ event_type = None if stale else self.event_type store.py:231
   │     └─ unavailable_reason set only when EVERY requested
   │        timeframe went stale                            store.py:235-239
   └─ EvaluationContext(symbol, series=series_map, price, spread, instrument,
                         account, positions, timestamp, event_type,
                         unavailable_reason)                store.py:222-240
         fields declared evaluator.py:57-82
```

## Stage 4 — evaluation

```
_evaluate_trigger(trigger, context, moment)              monitor.py:324-411
   ↓
evaluate_tree(tree, context)                             evaluator.py:208-210
   ↓ evaluate_node(node, context)                         evaluator.py:213-232
      ↓ if kind == 'GROUP':  _evaluate_group              evaluator.py:235-309
      │     AND / OR / NOT with UNKNOWN contagion
      ↓ else: _LEAF_HANDLERS[kind](node, context)          evaluator.py:1058-1083
            24 leaf kinds, LEAF_KINDS                       evaluator.py:1088
```

| Handler family | Lines | Notable calls |
| --- | --- | --- |
| price: `PRICE_LEVEL`, `PRICE_CROSS`, `SPREAD` | `:331-378` | `_series` `:321` |
| indicators: `INDICATOR_THRESHOLD`, `INDICATOR_COMPARE`, `MOMENTUM_BAND`, `TREND_DIRECTION`, `ADX_STRENGTH`, `VOLATILITY`, `VOLATILITY_COMPARE`, `VOLUME` | `:404-656` | `indicator_module.compute(...)` at `:421, 487, 552, 574, 600-608, 627-628, 644-648` |
| patterns / structure: `PRICE_ACTION`, `CONSECUTIVE`, `STRUCTURE`, `PATTERN`, `BREAKOUT` | `:659-759` | `price_action_module.compute`; `pattern_module.evaluate` |
| expressions: `MATH_EXPR` | `:820-836` | `math_expr` parse + evaluate; `zoneinfo.ZoneInfo` `:845` |
| clock: `TIME`, `SESSION` | `:839-894` | `datetime`, `ZoneInfo` |
| account state: `PROXIMITY`, `POSITION`, `ACCOUNT`, `RISK`, `EVENT` | `:904-1055` | reads `context.positions` / `context.account` |

**Three-state model (CONFIRMED)** — `Status` enum `TRUE` / `FALSE` / `UNKNOWN`
(`evaluator.py:51-54`). `compare()` returns `None` (= UNKNOWN) when either side is
`None` (`:158-159`), when a value is non-finite (`:160-161`), or for the cross
operators (`:176, :178`).

**Indicator caching note (CONFIRMED)** — every handler calls
`indicator_module.compute(...)` directly rather than going through the
`IndicatorCache`; the cache is only invalidated wholesale by
`monitor.py:272`.

`explain(node)` — `evaluator.py:1096-1199` — produces the human string exposed at
`api.py:407-411`; `condition_textures(node)` — `contract.py:126-173` — produces the
compute plan `{timeframe, indicator}` list.

## Stage 5 — the edge detector

```
EdgeDetector.observe(status, now_ms)                     edge.py:134-245
   guard order:
   ├─ validate status ('TRUE'|'FALSE'|'UNKNOWN') → ValueError   edge.py:140-141
   ├─ EdgeState.prune(now_ms)  (drop wakes older than 24 h)      edge.py:143 → :86-88
   ├─ disabled → Decision.DISABLED                                edge.py:145-146
   ├─ min-interval (cooldown) → Decision.COOLDOWN                 edge.py:150-163
   ├─ state.last_evaluation_ms = now_ms                           edge.py:165
   ├─ UNKNOWN → Decision.NOT_READY   (last_status NOT touched)    edge.py:167-177
   ├─ FALSE  → state.last_status = FALSE                          edge.py:179-187
   ├─ was_true = (state.last_status == 'TRUE')                    edge.py:189
   │  state.last_status = TRUE                                    edge.py:190
   ├─ was_true → Decision.ALREADY_TRUE                            edge.py:192-199
   ├─ cooldown remaining → Decision.COOLDOWN                      edge.py:202-212
   ├─ hourly cap  → Decision.RATE_LIMITED                         edge.py:214-222
   ├─ daily cap   → Decision.RATE_LIMITED                         edge.py:224-232
   └─ commit: last_fire_ms = now_ms                               edge.py:234
              fire_count += 1                                     edge.py:235
              wakes.append(now_ms)                                edge.py:236
              → Decision.FIRED                                    edge.py:238-245
```

Defaults (`WakePolicy.from_definition`, `edge.py:53-61`):
`cooldownMs` 900 000 ms (`DEFAULT_COOLDOWN_MS` `:28`),
`minEvaluationIntervalMs` 0 (`DEFAULT_MIN_INTERVAL_MS` `:29`),
`maxWakesPerHour` 4 (`:30`), `maxWakesPerDay` 24 (`:31`).

`Decision` — 6 members: `FIRED`, `ALREADY_TRUE`, `COOLDOWN`, `RATE_LIMITED`,
`NOT_READY`, `DISABLED` — `edge.py:34-40`.

On `FIRED`, `_evaluate_trigger` appends a `WakeEvent` to `self.wakes`
(`monitor.py:156`) and emits into the shared `EventLog` via `self.log`
(`monitor.py:143`).

## Stage 6 — outputs

| Output | Where |
| --- | --- |
| `list[QueuedWake]` from `tick_once` | `engine.py:298-307` |
| `_enqueue` → `self._queue` (deque, cap 200) | `engine.py:237-246` |
| wake-id counter | `engine.py:88`, `:243` |
| `EventLog` entries | `events.py:74-80` |
| `monitor.wakes` list | `monitor.py:156` |
| indicator cache invalidation | `monitor.py:272` → `store.py:134-137` |
| candle store entries | `store.py:87` |

## Async boundaries

| Boundary | Line | Kind |
| --- | --- | --- |
| `asyncio.create_task` | `engine.py:253` | task creation |
| `asyncio.to_thread` | `engine.py:279` | thread hop — the tick runs off the event loop |
| `asyncio.wait_for` on `Event.wait()` | `engine.py:286-287` | interruptible sleep |
| `urllib.request.urlopen` | `marketdata.py:146` | blocking network inside the worker thread |
| `await engine.start()/stop()` | `api.py:208, 212` | lifespan |

## Exit points

- HTTP responses on the 17 routes — `api.py:216-389`.
- `EventLog` → `GET /events` — `api.py:360-370`.
- `pending_wakes()` → `GET /wakes` — `api.py:373-375`.
- `on_wake(listener)` callbacks — `engine.py:214-216`, `:244`.
- The only network egress is `urllib` to the Hyperliquid `/info` endpoint
  (`marketdata.py:137-149`).
