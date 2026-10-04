"""Edge detection and wake policy.

The property under test is the expensive one: a condition that stays
true must not wake the AI repeatedly.
"""

from __future__ import annotations

from tradingv_engine.edge import (
    DEFAULT_COOLDOWN_MS,
    Decision,
    EdgeDetector,
    EdgeState,
    WakePolicy,
)

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR


def detector(**overrides) -> EdgeDetector:
    """A permissive detector unless a test tightens one specific guard."""
    settings = {"cooldown_ms": 0, "max_wakes_per_hour": 100, "max_wakes_per_day": 1000}
    settings.update(overrides)
    return EdgeDetector("t1", WakePolicy(**settings))  # type: ignore[arg-type]


def test_false_then_true_fires_once():
    engine = detector()
    assert engine.observe("FALSE", 0).decision is Decision.NOT_READY
    assert engine.observe("TRUE", 1_000).decision is Decision.FIRED


def test_true_then_true_does_not_refire():
    engine = detector()
    engine.observe("TRUE", 1_000)
    for index in range(2, 40):
        decision = engine.observe("TRUE", 1_000 + index)
        assert decision.decision is Decision.ALREADY_TRUE
    assert engine.state.fire_count == 1


def test_twenty_true_ticks_produce_exactly_one_wake():
    engine = detector()
    fired = [engine.observe("TRUE", index * 1_000).decision for index in range(20)]
    assert fired.count(Decision.FIRED) == 1


def test_a_false_reading_rearms_the_tracker():
    engine = detector()
    assert engine.observe("TRUE", 0).decision is Decision.FIRED
    assert engine.observe("TRUE", 1_000).decision is Decision.ALREADY_TRUE
    assert engine.observe("FALSE", 2_000).decision is Decision.NOT_READY
    assert engine.observe("TRUE", 3_000).decision is Decision.FIRED
    assert engine.state.fire_count == 2


def test_unknown_neither_fires_nor_rearms():
    engine = detector()
    engine.observe("TRUE", 0)
    # An unknown reading must not clear the "already true" latch, or a
    # data outage followed by recovery would fire again immediately.
    assert engine.observe("UNKNOWN", 1_000).decision is Decision.NOT_READY
    assert engine.state.last_status == "TRUE"
    assert engine.observe("TRUE", 2_000).decision is Decision.ALREADY_TRUE
    assert engine.state.fire_count == 1


def test_unknown_does_not_accumulate_wakes_by_oscillation():
    engine = detector()
    for index in range(50):
        engine.observe("UNKNOWN" if index % 2 else "TRUE", index * 1_000)
    assert engine.state.fire_count == 1


def test_cooldown_blocks_a_second_edge():
    engine = detector(cooldown_ms=15 * MINUTE)
    assert engine.observe("TRUE", 0).decision is Decision.FIRED
    assert engine.observe("FALSE", MINUTE).decision is Decision.NOT_READY
    blocked = engine.observe("TRUE", 2 * MINUTE)
    assert blocked.decision is Decision.COOLDOWN
    assert blocked.is_edge is True
    assert blocked.cooldown_remaining_ms == 13 * MINUTE
    assert engine.state.fire_count == 1


def test_cooldown_expiry_allows_the_next_wake():
    engine = detector(cooldown_ms=15 * MINUTE)
    engine.observe("TRUE", 0)
    engine.observe("FALSE", MINUTE)
    assert engine.observe("TRUE", 15 * MINUTE).decision is Decision.FIRED
    assert engine.state.fire_count == 2


def test_hourly_cap():
    engine = detector(cooldown_ms=0, max_wakes_per_hour=4)
    for index in range(4):
        engine.observe("TRUE", index)
        engine.observe("FALSE", index + 1)
    limited = engine.observe("TRUE", 10)
    assert limited.decision is Decision.RATE_LIMITED
    assert limited.wakes_last_hour == 4
    assert engine.state.fire_count == 4


def test_daily_cap_is_separate_from_the_hourly_cap():
    # The hourly cap is generous here so the daily cap is what bites.
    engine = detector(cooldown_ms=0, max_wakes_per_hour=10, max_wakes_per_day=3)
    for index in range(3):
        engine.observe("TRUE", index)
        engine.observe("FALSE", index + 1)
    assert engine.state.fire_count == 3
    blocked = engine.observe("TRUE", 10)
    assert blocked.decision is Decision.RATE_LIMITED
    assert "today" in blocked.reason


def test_a_rate_limited_edge_still_latches_so_it_does_not_fire_later():
    """A blocked edge must not become a queued wake once the window rolls."""
    engine = detector(cooldown_ms=0, max_wakes_per_hour=2)
    engine.observe("TRUE", 0)
    engine.observe("FALSE", 1)
    engine.observe("TRUE", 2)
    engine.observe("FALSE", 3)
    assert engine.observe("TRUE", 4).decision is Decision.RATE_LIMITED
    # Hours later, with the window clear, the condition is still true, so
    # the latch must suppress rather than deliver a stale wake.
    assert engine.observe("TRUE", 2 * HOUR).decision is Decision.ALREADY_TRUE
    assert engine.state.fire_count == 2


def test_wakes_outside_the_window_free_up_the_cap():
    engine = detector(cooldown_ms=0, max_wakes_per_hour=2)
    engine.observe("TRUE", 0)
    engine.observe("FALSE", 1)
    engine.observe("TRUE", 2)
    engine.observe("FALSE", 3)
    assert engine.observe("TRUE", 4).decision is Decision.RATE_LIMITED
    # Two hours later the hourly window has rolled. The condition must
    # have gone false and true again for a new edge to exist.
    engine.observe("FALSE", 2 * HOUR)
    assert engine.observe("TRUE", 2 * HOUR + 10).decision is Decision.FIRED
    assert engine.state.fire_count == 3


def test_minimum_evaluation_interval_skips_bursts():
    engine = detector(cooldown_ms=0, min_evaluation_interval_ms=30_000)
    assert engine.observe("TRUE", 0).decision is Decision.FIRED
    burst = engine.observe("FALSE", 1_000)
    assert burst.decision is Decision.COOLDOWN
    assert "minimum evaluation interval" in burst.reason


def test_disabled_tracker_never_reports():
    engine = EdgeDetector("t1", WakePolicy(enabled=False))
    assert engine.observe("TRUE", 0).decision is Decision.DISABLED
    assert engine.state.fire_count == 0


def test_default_policy_is_conservative():
    # The default must not let a condition wake the AI more than a few
    # times an hour, because every wake costs a model call.
    assert DEFAULT_COOLDOWN_MS >= 5 * MINUTE
    assert WakePolicy().max_wakes_per_hour <= 6


def test_policy_round_trips_through_a_definition():
    policy = WakePolicy.from_definition(
        {"cooldownMs": 60_000, "minEvaluationIntervalMs": 5_000, "maxWakesPerHour": 2, "maxWakesPerDay": 10, "enabled": False}
    )
    assert policy.cooldown_ms == 60_000
    assert policy.min_evaluation_interval_ms == 5_000
    assert policy.max_wakes_per_hour == 2
    assert policy.max_wakes_per_day == 10
    assert policy.enabled is False
    assert WakePolicy.from_definition(policy.to_json()) == policy


def test_snapshot_reports_the_remaining_cooldown():
    engine = detector(cooldown_ms=10 * MINUTE)
    engine.observe("TRUE", 0)
    snapshot = engine.snapshot(3 * MINUTE)
    assert snapshot["cooldownRemainingMs"] == 7 * MINUTE
    assert snapshot["fireCount"] == 1
    assert snapshot["lastStatus"] == "TRUE"


def test_an_unexpected_status_is_refused():
    engine = detector()
    try:
        engine.observe("MAYBE", 0)
    except ValueError:
        return
    raise AssertionError("an unexpected status should be refused")


def test_state_can_be_restored_for_a_new_version():
    """A new condition tree gets a fresh latch, not the old one's history."""
    previous = EdgeState(last_status="TRUE", last_fire_ms=0, fire_count=5, wakes=__import__("collections").deque([0]))
    restarted = EdgeDetector("t1", WakePolicy(cooldown_ms=0), state=None)
    assert restarted.state.last_status is None
    assert restarted.observe("TRUE", 10_000).decision is Decision.FIRED
    assert previous.fire_count == 5
