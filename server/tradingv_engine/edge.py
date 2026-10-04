"""Edge detection and wake policy.

Distinguishing "the condition is true" from "the condition just became
true" is the whole point of this module. A condition that stays true for
twenty candles must wake the AI once, not twenty times, because every
wake costs a model call.

Three independent guards, in order:

1. **Edge detection.** The tracker reports on a ``FALSE -> TRUE``
   transition. ``TRUE -> TRUE`` is silent. The tree re-arms once it
   stops being true, so the next crossing fires again.
2. **Cooldown.** No wake within ``cooldownMs`` of the previous one.
3. **Wake caps.** At most ``maxWakesPerHour`` and ``maxWakesPerDay``.

An ``UNKNOWN`` result is not an edge: it neither fires nor re-arms. A
condition that cannot be measured must not be able to accumulate wakes by
oscillating through UNKNOWN.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Deque

DEFAULT_COOLDOWN_MS = 900_000  # 15 minutes
DEFAULT_MIN_INTERVAL_MS = 0
DEFAULT_MAX_WAKES_PER_HOUR = 4
DEFAULT_MAX_WAKES_PER_DAY = 24


class Decision(str, Enum):
    FIRED = "FIRED"
    ALREADY_TRUE = "ALREADY_TRUE"
    COOLDOWN = "COOLDOWN"
    RATE_LIMITED = "RATE_LIMITED"
    NOT_READY = "NOT_READY"
    DISABLED = "DISABLED"


@dataclass
class WakePolicy:
    """How often a tracker is allowed to wake the AI."""

    cooldown_ms: int = DEFAULT_COOLDOWN_MS
    min_evaluation_interval_ms: int = DEFAULT_MIN_INTERVAL_MS
    max_wakes_per_hour: int = DEFAULT_MAX_WAKES_PER_HOUR
    max_wakes_per_day: int = DEFAULT_MAX_WAKES_PER_DAY
    enabled: bool = True

    @classmethod
    def from_definition(cls, definition: dict[str, Any]) -> "WakePolicy":
        return cls(
            cooldown_ms=int(definition.get("cooldownMs", DEFAULT_COOLDOWN_MS)),
            min_evaluation_interval_ms=int(definition.get("minEvaluationIntervalMs", DEFAULT_MIN_INTERVAL_MS)),
            max_wakes_per_hour=int(definition.get("maxWakesPerHour", DEFAULT_MAX_WAKES_PER_HOUR)),
            max_wakes_per_day=int(definition.get("maxWakesPerDay", DEFAULT_MAX_WAKES_PER_DAY)),
            enabled=bool(definition.get("enabled", True)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "cooldownMs": self.cooldown_ms,
            "minEvaluationIntervalMs": self.min_evaluation_interval_ms,
            "maxWakesPerHour": self.max_wakes_per_hour,
            "maxWakesPerDay": self.max_wakes_per_day,
            "enabled": self.enabled,
        }


@dataclass
class EdgeState:
    """Per-tracker state the debounce needs."""

    #: Last observed root status. ``None`` means "never evaluated".
    last_status: str | None = None
    #: ``None`` means "never evaluated". Zero is a real timestamp.
    last_evaluation_ms: int | None = None
    #: ``None`` means "never fired". Zero is a real timestamp.
    last_fire_ms: int | None = None
    fire_count: int = 0
    wakes: Deque[int] = field(default_factory=deque)

    def prune(self, now_ms: int) -> None:
        while self.wakes and now_ms - self.wakes[0] > 86_400_000:
            self.wakes.popleft()

    def wakes_last_hour(self, now_ms: int) -> int:
        return sum(1 for stamp in self.wakes if now_ms - stamp <= 3_600_000)

    def wakes_today(self, now_ms: int) -> int:
        return sum(1 for stamp in self.wakes if now_ms - stamp <= 86_400_000)


@dataclass
class WakeDecision:
    decision: Decision
    status: str
    reason: str
    cooldown_remaining_ms: int = 0
    wakes_last_hour: int = 0
    wakes_today: int = 0
    #: True only when this call is the FALSE -> TRUE transition.
    is_edge: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "decision": self.decision.value,
            "status": self.status,
            "reason": self.reason,
            "cooldownRemainingMs": self.cooldown_remaining_ms,
            "wakesLastHour": self.wakes_last_hour,
            "wakesToday": self.wakes_today,
            "isEdge": self.is_edge,
        }


class EdgeDetector:
    """
    Debounce and rate limiting for one tracker.

    One instance per tracker. The engine holds a dict of them, keyed by
    tracker id, so an engine restart resets debounce state but the runtime
    never needs a per-condition loop.
    """

    def __init__(self, tracker_id: str, policy: WakePolicy, state: EdgeState | None = None) -> None:
        self.tracker_id = tracker_id
        self.policy = policy
        self.state = state or EdgeState()

    def observe(self, status: str, now_ms: int) -> WakeDecision:
        """
        Record an evaluation and decide whether it should wake the AI.

        ``status`` must be ``TRUE``, ``FALSE``, or ``UNKNOWN``.
        """
        if status not in {"TRUE", "FALSE", "UNKNOWN"}:
            raise ValueError(f"Unexpected status {status!r}")

        self.state.prune(now_ms)

        if not self.policy.enabled:
            return WakeDecision(Decision.DISABLED, status, "This tracker is disabled.")

        # A minimum evaluation interval keeps a burst of updates from
        # being treated as many opportunities.
        if (
            self.policy.min_evaluation_interval_ms > 0
            and self.state.last_evaluation_ms is not None
            and now_ms - self.state.last_evaluation_ms < self.policy.min_evaluation_interval_ms
        ):
            remaining = self.policy.min_evaluation_interval_ms - (now_ms - self.state.last_evaluation_ms)
            return WakeDecision(
                Decision.COOLDOWN,
                status,
                "Evaluated again before the minimum evaluation interval elapsed.",
                cooldown_remaining_ms=remaining,
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
            )

        self.state.last_evaluation_ms = now_ms

        if status == "UNKNOWN":
            # Deliberately does not update `last_status`: an unknown
            # reading must not re-arm a tracker that was already true,
            # nor suppress the next genuine edge.
            return WakeDecision(
                Decision.NOT_READY,
                status,
                "Conditions could not be evaluated, so the AI was not woken.",
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
            )

        if status == "FALSE":
            self.state.last_status = "FALSE"
            return WakeDecision(
                Decision.NOT_READY,
                status,
                "Conditions are not met.",
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
            )

        was_true = self.state.last_status == "TRUE"
        self.state.last_status = "TRUE"

        if was_true:
            return WakeDecision(
                Decision.ALREADY_TRUE,
                status,
                "Conditions are still true from an earlier wake; not waking again.",
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
            )

        # A genuine FALSE -> TRUE edge. Now apply the cost guards.
        remaining = self._cooldown_remaining(now_ms)
        if remaining > 0:
            return WakeDecision(
                Decision.COOLDOWN,
                status,
                "Conditions just became true, but the cooldown has not elapsed.",
                cooldown_remaining_ms=remaining,
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
                is_edge=True,
            )

        if self.state.wakes_last_hour(now_ms) >= self.policy.max_wakes_per_hour:
            return WakeDecision(
                Decision.RATE_LIMITED,
                status,
                f"Conditions just became true, but this tracker already woke the AI {self.state.wakes_last_hour(now_ms)} times in the last hour.",
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
                is_edge=True,
            )

        if self.state.wakes_today(now_ms) >= self.policy.max_wakes_per_day:
            return WakeDecision(
                Decision.RATE_LIMITED,
                status,
                f"Conditions just became true, but this tracker already woke the AI {self.state.wakes_today(now_ms)} times today.",
                wakes_last_hour=self.state.wakes_last_hour(now_ms),
                wakes_today=self.state.wakes_today(now_ms),
                is_edge=True,
            )

        self.state.last_fire_ms = now_ms
        self.state.fire_count += 1
        self.state.wakes.append(now_ms)

        return WakeDecision(
            Decision.FIRED,
            status,
            "Conditions just became true.",
            wakes_last_hour=self.state.wakes_last_hour(now_ms),
            wakes_today=self.state.wakes_today(now_ms),
            is_edge=True,
        )

    def _cooldown_remaining(self, now_ms: int) -> int:
        """Milliseconds until the next wake is permitted."""
        if self.state.last_fire_ms is None:
            return 0
        return max(0, self.state.last_fire_ms + self.policy.cooldown_ms - now_ms)

    def snapshot(self, now_ms: int) -> dict[str, Any]:
        return {
            "trackerId": self.tracker_id,
            "lastStatus": self.state.last_status,
            "lastEvaluationMs": self.state.last_evaluation_ms,
            "lastFireMs": self.state.last_fire_ms,
            "fireCount": self.state.fire_count,
            "cooldownRemainingMs": self._cooldown_remaining(now_ms),
            "wakesLastHour": self.state.wakes_last_hour(now_ms),
            "wakesToday": self.state.wakes_today(now_ms),
            "policy": self.policy.to_json(),
        }
