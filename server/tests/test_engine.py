"""Condition engine tests.

The engine is exercised with fixture candles, an injected clock, and an
injected market-data function. Nothing here touches the network or sleeps,
so every assertion is about behaviour rather than timing luck.

The scenarios are the ones a user actually experiences: a condition that
becomes true, a condition that stays true, a market that stops updating, a
market that is not tradeable, a tracker that is switched off, and the
difference between waking the AI and trading.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import fixture_series
from tradingv_engine import contract
from tradingv_engine.config import EngineConfig
from tradingv_engine.engine import ConditionEngine
from tradingv_engine.events import EventLog, EventType
from tradingv_engine.marketdata import Instrument
from tradingv_engine.monitor import MarketMonitor, TrackerSpec

#: Committed fixtures, used where the exact numbers do not matter.
FLAT = fixture_series("gold_15m_flat")
SPIKE = fixture_series("gold_15m_spike")

#: The moment the fake clock starts, in epoch milliseconds.
T0 = 1_700_000_000_000
MINUTE = 60_000


def ramp(price: float, bars: int = 60):
    """
    A flat market at a price the test chooses.

    Two committed fixtures cannot be used to build a FALSE -> TRUE edge on
    demand, because their relative prices are a property of the data rather
    than of the test. A flat series at a known price makes the threshold in
    each test readable: below it is FALSE, above it is TRUE.
    """
    from conftest import make_series

    # Realistic bar timestamps: a series whose last bar is at epoch zero
    # reads as stale, which is correct behaviour but the wrong subject for
    # a test about edge detection.
    times = [T0 - (bars - 1 - index) * 900_000 for index in range(bars)]
    return make_series([price] * bars, volumes=[1000.0] * bars, times=times)


LOW = ramp(100.0)
HIGH = ramp(200.0)

#: What discovery returns. One market the venue quotes, one it does not.
GOLD = Instrument(
    symbol="Gold",
    provider_symbol="xyz:GOLD",
    asset_class="COMMODITY",
    display_name="Gold Perpetual",
    dex="xyz",
    availability="TRADEABLE",
    price_precision=2,
    size_precision=2,
    tick_size=0.01,
)
HALTED = Instrument(
    symbol="Gold",
    provider_symbol="xyz:GOLD",
    asset_class="COMMODITY",
    display_name="Gold Perpetual",
    dex="xyz",
    availability="UNAVAILABLE",
    unavailable_reason="The venue is not publishing a quoted price for this market.",
    price_precision=2,
)

class FakeClock:
    """A clock the test moves by hand, so nothing has to sleep."""

    def __init__(self, now: int = T0) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now

    def advance(self, ms: int) -> int:
        self.now += ms
        return self.now


class FakeMarketData:
    """Serves committed fixtures, and can be told to fail."""

    def __init__(self, series: dict[tuple[str, str], object] | None = None) -> None:
        self.series = series or {}
        self.fail = False
        self.calls: list[tuple[str, str]] = []

    def load_instruments(self) -> list[Instrument]:
        return [HALTED] if self.fail else [GOLD]

    def candles(self, symbol: str, timeframe: str, limit: int = 500):
        self.calls.append((symbol, timeframe))
        if self.fail:
            from tradingv_engine.marketdata import MarketDataError

            raise MarketDataError(f"No candles returned for {symbol} {timeframe}.")
        return self.series[(symbol, timeframe)]


def tree(
    root: dict,
    market: str = "xyz:GOLD",
    timeframe: str = "15m",
    **overrides,
) -> dict:
    body = {
        "schemaVersion": 1,
        "name": "Test tracker",
        "market": market,
        "timeframe": timeframe,
        "then": "WAKE_AI",
        "root": root,
    }
    body.update(overrides)
    contract.validate_tree(body)
    return body


def price_above(level: float, timeframe: str = "15m", **tree_fields) -> dict:
    """A one-condition tracker. `tree_fields` are tracker-level knobs."""
    return tree(
        {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [
                {
                    "id": "c1",
                    "kind": "PRICE_LEVEL",
                    "timeframe": timeframe,
                    "direction": "ABOVE",
                    "level": level,
                }
            ],
        },
        **tree_fields,
    )


def rsi_under(value: float, timeframe: str = "15m") -> dict:
    return tree(
        {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [
                {
                    "id": "c1",
                    "kind": "INDICATOR_THRESHOLD",
                    "timeframe": timeframe,
                    "indicator": "RSI",
                    "period": 14,
                    "operator": "LT",
                    "value": value,
                }
            ],
        },
        timeframe=timeframe,
    )


def build(market_data: FakeMarketData | None = None, log: EventLog | None = None) -> ConditionEngine:
    data = market_data or FakeMarketData()
    clock = FakeClock()
    engine = ConditionEngine(
        config=EngineConfig(poll_interval_s=1.0),
        market_data=data,
        log=log or EventLog(),
        clock=clock,
    )
    engine.set_clock(clock)
    engine.monitor.store.set_clock(clock)
    # The engine discovers the market universe at startup, so a build that
    # skips it is not a state the engine is ever actually in. The
    # synchronous monitor path is used here so the fixture never needs a
    # running event loop.
    engine.monitor.load_instruments()
    engine.set_account(
        {
            "equity": 10000.0,
            "balance": 10000.0,
            "freeMargin": 9000.0,
            "marginUsed": 1000.0,
            "dailyPnL": -50.0,
            "exposure": 20000.0,
            "maxExposureNotional": 250000.0,
            "drawdownPercent": 1.2,
            "killSwitchActive": False,
            "riskState": "NORMAL",
            "ordersLastMinute": 1,
        }
    )
    return engine


def seed(
    engine: ConditionEngine,
    series: object,
    symbol: str = "xyz:GOLD",
    timeframe: str = "15m",
    last_bar_ms: int | None = None,
) -> None:
    """
    Point the fake venue at a fixture.

    The monitor refetches every cycle, so writing into the store directly
    would be overwritten on the next tick. The fixture goes into the
    market-data source instead, which is what a real venue would answer.
    """
    engine.monitor.market_data.series[(symbol, timeframe)] = series
    engine.monitor.store.seed(symbol, timeframe, series)
    if last_bar_ms is not None:
        engine.monitor.store.entry_for(symbol, timeframe).last_bar_time_ms = last_bar_ms


def register(engine: ConditionEngine, definition: dict, tracker_id: str = "t1", goat_id: str = "b1") -> TrackerSpec:
    return engine.register({"id": tracker_id, "goatId": goat_id, "name": "Test tracker", "definition": definition})


def statuses(engine: ConditionEngine, event_type: EventType) -> list[str]:
    return [event.data.get("overall") for event in engine.log.recent(types=[event_type])]


# --------------------------------------------------------------------------- #
# Registration and the contract boundary
# --------------------------------------------------------------------------- #


def test_a_registered_tracker_must_satisfy_the_shared_schema():
    engine = build()
    with pytest.raises(contract.ContractError):
        register(engine, {"schemaVersion": 1, "then": "WAKE_AI", "root": {"id": "g", "kind": "MADE_UP"}})


def test_a_registered_tracker_must_name_a_market():
    engine = build()
    orphan = tree(
        {
            "id": "g1",
            "kind": "GROUP",
            "operator": "AND",
            "children": [{"id": "c1", "kind": "PRICE_LEVEL", "timeframe": "15m", "direction": "ABOVE", "level": 1.0}],
        },
        market="",
    )
    register(engine, orphan)
    # A tracker with no market has nothing to watch, so it is registered but
    # never scheduled.
    assert engine.trackers["t1"].market == ""
    assert engine.monitor.required_series() == []


def test_unregister_removes_the_tracker_and_its_detector():
    engine = build()
    register(engine, price_above(150.0, cooldownMs=0))
    assert engine.unregister("t1") is True
    assert "t1" not in engine.trackers
    assert "t1" not in engine.monitor.detectors
    assert engine.unregister("t1") is False


def test_a_replacement_version_gets_a_clean_debounce_state():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))
    engine.tick_once(T0)
    detector = engine.monitor.detectors["t1"]
    assert detector.state.fire_count == 1

    register(engine, price_above(150.0, cooldownMs=0), tracker_id="t1")
    assert engine.monitor.detectors["t1"].state.fire_count == 0


# --------------------------------------------------------------------------- #
# One loop, not one per condition
# --------------------------------------------------------------------------- #


def test_two_trackers_on_one_market_share_a_single_fetch():
    engine = build()
    seed(engine, FLAT)
    register(engine, price_above(150.0, cooldownMs=0), tracker_id="t1")
    register(engine, rsi_under(99.0), tracker_id="t2")

    assert engine.monitor.required_series() == [("xyz:GOLD", "15m")]
    engine.tick_once(T0)
    assert engine.monitor.store.fetch_count == 1, "one series, one fetch, two trackers"


def test_only_the_series_a_tracker_names_are_polled():
    engine = build()
    seed(engine, FLAT)
    register(engine, rsi_under(99.0, timeframe="1h"))
    assert engine.monitor.required_series() == [("xyz:GOLD", "1h")]


def test_a_disabled_tracker_is_not_polled():
    engine = build()
    seed(engine, FLAT)
    register(engine, price_above(150.0, enabled=False))
    assert engine.monitor.required_series() == []


# --------------------------------------------------------------------------- #
# Waking the AI
# --------------------------------------------------------------------------- #


def test_a_false_to_true_edge_wakes_the_ai_once():
    engine = build()
    seed(engine, LOW)
    register(engine, price_above(150.0, cooldownMs=0))

    # First cycle: the market is below the level, so there is no edge.
    assert engine.tick_once(T0) == []
    # The market moves above the level.
    seed(engine, HIGH)
    assert len(engine.tick_once(T0 + MINUTE)) == 1


def test_a_condition_that_stays_true_does_not_wake_repeatedly():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))

    engine.tick_once(T0)
    for step in range(1, 10):
        assert engine.tick_once(T0 + step * MINUTE) == [], "still true, so no new edge"
    assert engine.monitor.detectors["t1"].state.fire_count == 1


def test_a_wake_carries_the_evidence_but_no_order():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))
    [queued] = engine.tick_once(T0)

    payload = queued.to_json()
    assert payload["type"] == "AI_WAKE"
    assert payload["environment"] == "DEMO"
    assert payload["conditions"]["overall"] == "TRUE"
    # The wake tells the AI what is true. It does not tell it what to buy.
    serialised = repr(payload)
    for forbidden in ("orderSize", "side", "leverage", "price_target", "signature", "privateKey"):
        assert forbidden not in serialised
    assert payload["context"]["price"] == pytest.approx(float(HIGH.close[-1]))


def test_the_wake_context_carries_market_evidence():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))
    [queued] = engine.tick_once(T0)

    context = queued.event.context
    assert context["recentCandles"], "the AI needs candles to reason about"
    assert context["price"] is not None
    assert context["account"]["equity"] == 10000.0
    assert "signingKey" not in repr(context)


def test_a_wake_must_be_acknowledged_before_it_counts_as_handled():
    engine = build()
    seed(engine, SPIKE)
    register(engine, price_above(150.0, cooldownMs=0))
    [queued] = engine.tick_once(T0)

    assert [item["wakeId"] for item in engine.pending_wakes()] == [queued.id]
    assert engine.acknowledge_wake(queued.id) is True
    assert engine.pending_wakes() == []
    # Acknowledging twice is not an error, it is a no-op.
    assert engine.acknowledge_wake(queued.id) is False
    assert engine.acknowledge_wake("nope") is False


def test_the_queue_is_bounded():
    engine = build()
    for index in range(ConditionEngine.WAKE_CAPACITY + 25):
        engine._enqueue(_synthetic_wake(index))
    assert len(engine._queue) == ConditionEngine.WAKE_CAPACITY
    # The newest wake is the one that survives.
    assert engine.pending_wakes()[-1]["wakeId"] == f"wake_{ConditionEngine.WAKE_CAPACITY + 24 + 1:06d}"


def test_a_wake_listener_cannot_break_the_monitor():
    engine = build()

    def explode(_queued) -> None:
        raise RuntimeError("the app is down")

    engine.on_wake(explode)
    seed(engine, SPIKE)
    register(engine, price_above(150.0, cooldownMs=0))
    # A failing consumer must not stop the engine from recording the wake.
    assert len(engine.tick_once(T0)) == 1


def _with_last_bar(series, last_bar_ms: int):
    """The same candles, with the newest bar moved into the past."""
    times = series.times.copy()
    times[-1] = last_bar_ms
    from tradingv_engine.series import Series

    return Series(
        symbol=series.symbol,
        timeframe=series.timeframe,
        open=series.open,
        high=series.high,
        low=series.low,
        close=series.close,
        volume=series.volume,
        times=times,
    )


def _synthetic_wake(index: int):
    from tradingv_engine.monitor import WakeEvent

    return WakeEvent(goat_id=f"b{index}", tracker_id=f"t{index}")


# --------------------------------------------------------------------------- #
# UNKNOWN is a real answer
# --------------------------------------------------------------------------- #


def test_a_market_with_no_data_never_wakes_the_ai():
    engine = build(FakeMarketData({}))
    register(engine, price_above(150.0, cooldownMs=0))

    assert engine.tick_once(T0) == []
    unknown = engine.log.recent(types=[EventType.TRACKER_UNKNOWN])
    assert unknown, "an unevaluable condition must be reported, not silently dropped"
    assert "UNKNOWN" in unknown[0].data["reason"] or unknown[0].data["reason"]


def test_a_halted_market_never_wakes_the_ai_even_with_candles():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))
    # The venue lists the market but is not quoting it.
    engine.monitor._instruments = {"xyz:GOLD": HALTED}

    assert engine.tick_once(T0) == []
    assert engine.monitor.store.fetch_count == 0, "an untradeable market should not be polled"


def test_stale_candles_report_unknown_rather_than_a_stale_price():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))

    assert len(engine.tick_once(T0)) == 1
    # The venue now answers, but the newest bar it returns is over an hour
    # old. A condition must not read that stale close as if it were live.
    stale = _with_last_bar(HIGH, T0 - 60 * MINUTE)
    engine.monitor.market_data.series[("xyz:GOLD", "15m")] = stale
    engine.monitor.store.seed("xyz:GOLD", "15m", stale)

    assert engine.tick_once(T0 + 2 * MINUTE) == []


def test_a_warmup_shortfall_is_unknown_not_false():
    engine = build()
    seed(engine, fixture_series("gold_15m_short"))
    register(engine, rsi_under(99.0))
    assert engine.tick_once(T0) == []


# --------------------------------------------------------------------------- #
# Cooldown and rate limits
# --------------------------------------------------------------------------- #


def test_a_cooldown_suppresses_a_repeat_edge():
    engine = build()
    register(engine, price_above(150.0, cooldownMs=30 * MINUTE))

    for cycle in range(4):
        seed(engine, HIGH)
        engine.tick_once(T0 + cycle * 2 * MINUTE)
        # Drop the condition, then raise it again to create a new edge.
        seed(engine, LOW)
        engine.tick_once(T0 + cycle * 2 * MINUTE + MINUTE)

    assert engine.monitor.detectors["t1"].state.fire_count == 1, "cooldown is measured in real time"


def test_a_daily_cap_bounds_wakes():
    engine = build()
    register(engine, price_above(150.0, cooldownMs=0, maxWakesPerHour=60, maxWakesPerDay=2))

    fired = 0
    for cycle in range(6):
        seed(engine, HIGH)
        fired += len(engine.tick_once(T0 + cycle * 2 * MINUTE))
        seed(engine, LOW)
        engine.tick_once(T0 + cycle * 2 * MINUTE + MINUTE)

    assert fired == 2


def test_the_loop_runs_at_the_fastest_tracker_not_the_slowest():
    """One loop, paced by whichever tracker needs the most attention."""
    engine = build()
    register(engine, price_above(150.0, cooldownMs=0, minEvaluationIntervalMs=15 * MINUTE))
    # A tracker that asked for 15-minute spacing does not slow the loop
    # down for every other tracker; its own detector suppresses the extra
    # reads, which is cheaper than a timer per tracker.
    assert engine._effective_interval_s() == pytest.approx(1.0)

    slow = engine.monitor.detectors["t1"]
    assert slow.observe("TRUE", T0).decision.value == "FIRED"
    assert slow.observe("FALSE", T0 + MINUTE).decision.value == "COOLDOWN"
    assert slow.observe("FALSE", T0 + 20 * MINUTE).decision.value == "NOT_READY"


# --------------------------------------------------------------------------- #
# The engine never trades
# --------------------------------------------------------------------------- #


def test_live_trading_is_off_even_if_the_environment_asks_for_it(monkeypatch):
    monkeypatch.setenv("TRADINGV_LIVE_TRADING", "true")
    engine = ConditionEngine(config=EngineConfig(live_trading_enabled=True))
    assert engine.status()["liveTradingEnabled"] is False


def test_the_engine_holds_no_credentials():
    from tradingv_engine import api, engine as engine_module

    for module in (engine_module, api):
        source = (module.__file__ or "").replace(".pyc", ".py")
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
        for forbidden in ("privateKey", "private_key", "apiKey", "api_key", "signTransaction", "wallet_adapter"):
            assert forbidden not in text, f"{module.__name__} must not mention {forbidden}"


def test_status_reports_no_execution_capability():
    engine = build()
    payload = engine.status()
    assert payload["liveTradingEnabled"] is False
    assert payload["schemaVersion"] == 1


# --------------------------------------------------------------------------- #
# The continuous loop
# --------------------------------------------------------------------------- #


def test_the_loop_ticks_and_stops():
    engine = build()
    seed(engine, HIGH)
    register(engine, price_above(150.0, cooldownMs=0))

    async def run() -> None:
        await engine.start()
        for _ in range(200):
            if engine.monitor.detectors["t1"].state.fire_count:
                break
            await asyncio.sleep(0.01)
        await engine.stop()

    asyncio.run(run())
    assert engine.monitor.detectors["t1"].state.fire_count == 1
    assert engine.running is False


def test_starting_twice_does_not_start_two_loops():
    engine = build()

    async def run() -> None:
        await engine.start()
        first = engine._task
        await engine.start()
        assert engine._task is first
        await engine.stop()

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# Fixture-backed testing, which is what the builder UI calls
# --------------------------------------------------------------------------- #


def test_a_draft_tree_can_be_tested_against_a_fixture():
    engine = build()
    result = engine.fixture_context("gold15mSpike")
    assert result.price == pytest.approx(float(SPIKE.close[-1]))
    assert set(result.series) == {"15m"}


def test_an_unknown_fixture_is_a_clear_error():
    engine = build()
    with pytest.raises(KeyError) as error:
        engine.fixture_context("does-not-exist")
    assert "Available" in str(error.value)


def test_every_shared_context_is_loadable():
    engine = build()
    for name in ("gold15mFlat", "gold15mDowntrend", "gold15mShort", "gold15mUptrend", "gold15mSpike", "gold15mAndEur1h"):
        assert engine.fixture_context(name) is not None


# --------------------------------------------------------------------------- #
# Compute planning
# --------------------------------------------------------------------------- #


def test_a_tracker_schedules_exactly_what_its_tree_needs():
    textures = contract.condition_textures(rsi_under(30.0, timeframe="1h"))
    assert {(item["timeframe"], item["indicator"]) for item in textures} == {("1h", "RSI"), ("1h", "__SERIES__")}


def test_the_monitor_reports_what_it_is_actually_watching():
    engine = build()
    seed(engine, FLAT)
    register(engine, rsi_under(99.0))
    engine.tick_once(T0)

    status = engine.status()
    assert status["requiredSeries"] == [{"symbol": "xyz:GOLD", "timeframe": "15m"}]
    assert status["trackedSeries"] == [{"symbol": "xyz:GOLD", "timeframe": "15m"}]
    assert status["fetchCount"] == 1
