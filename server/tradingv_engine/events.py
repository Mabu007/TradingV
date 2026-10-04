"""Structured engine events.

The engine emits a closed set of event types. They describe what the
*condition system* did. They never describe an order, a fill, or a
signature, because the engine does not do any of those.

The trading-side event vocabulary (``ORDER_SUBMITTED``, ``FILL``, ...) is
owned by the existing TypeScript event bus and the demo adapter, and is
not duplicated here.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class EventType(str, Enum):
    ENGINE_STARTED = "ENGINE_STARTED"
    ENGINE_STOPPED = "ENGINE_STOPPED"
    MARKET_DATA_UPDATED = "MARKET_DATA_UPDATED"
    MARKET_DATA_STALE = "MARKET_DATA_STALE"
    MARKET_DATA_UNAVAILABLE = "MARKET_DATA_UNAVAILABLE"
    CONDITION_EVALUATED = "CONDITION_EVALUATED"
    TRACKER_OBSERVED = "TRACKER_OBSERVED"
    TRACKER_SUPPRESSED = "TRACKER_SUPPRESSED"
    TRACKER_UNKNOWN = "TRACKER_UNKNOWN"
    AI_WAKE_REQUESTED = "AI_WAKE_REQUESTED"
    AI_UNAVAILABLE = "AI_UNAVAILABLE"
    GOAT_STARTED = "GOAT_STARTED"
    GOAT_STOPPED = "GOAT_STOPPED"
    GOAT_STATE_CHANGED = "GOAT_STATE_CHANGED"
    ERROR = "ERROR"


@dataclass
class EngineEvent:
    type: EventType
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))
    goat_id: str | None = None
    tracker_id: str | None = None
    symbol: str | None = None
    timeframe: str | None = None
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["type"] = self.type.value
        return {key: value for key, value in payload.items() if value not in (None, {}, "")}


class EventLog:
    """
    Bounded, in-memory event log.

    Deliberately not a database. The engine exposes recent events over
    HTTP for the UI; persistence belongs to the application, which already
    owns the goal, thesis and timeline stores.
    """

    def __init__(self, capacity: int = 2000) -> None:
        self._events: list[EngineEvent] = []
        self._capacity = capacity

    def record(self, event: EngineEvent) -> EngineEvent:
        self._events.append(event)
        if len(self._events) > self._capacity:
            del self._events[: len(self._events) - self._capacity]
        return event

    def emit(
        self,
        event_type: EventType,
        message: str = "",
        **fields: Any,
    ) -> EngineEvent:
        return self.record(EngineEvent(type=event_type, message=message, **fields))

    def recent(
        self,
        limit: int = 100,
        goat_id: str | None = None,
        tracker_id: str | None = None,
        types: list[EventType] | None = None,
    ) -> list[EngineEvent]:
        selected = self._events
        if goat_id:
            selected = [event for event in selected if event.goat_id == goat_id]
        if tracker_id:
            selected = [event for event in selected if event.tracker_id == tracker_id]
        if types:
            allowed = set(types)
            selected = [event for event in selected if event.type in allowed]
        return list(reversed(selected[-limit:]))

    def for_goat(self, goat_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return [event.to_json() for event in self.recent(limit=limit, goat_id=goat_id)]

    def __len__(self) -> int:
        return len(self._events)


#: The shared, in-process log the API reads from.
event_log = EventLog()
