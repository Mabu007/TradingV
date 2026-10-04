"""Shared fixtures.

All mathematical tests run against fixed, committed OHLCV input. No
test in this suite reads the network or depends on wall-clock time, so a
failure is always a real change in behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from tradingv_engine.series import Series

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED = REPO_ROOT / "shared"


def make_series(
    closes: list[float],
    timeframe: str = "15m",
    symbol: str = "xyz:GOLD",
    highs: list[float] | None = None,
    lows: list[float] | None = None,
    opens: list[float] | None = None,
    volumes: list[float] | None = None,
    times: list[int] | None = None,
) -> Series:
    close = np.asarray(closes, dtype=float)
    size = close.size
    return Series(
        symbol=symbol,
        timeframe=timeframe,
        open=np.asarray(opens if opens is not None else close, dtype=float),
        high=np.asarray(highs if highs is not None else close + 1.0, dtype=float),
        low=np.asarray(lows if lows is not None else close - 1.0, dtype=float),
        close=close,
        volume=None if volumes is None else np.asarray(volumes, dtype=float),
        times=np.asarray(times if times is not None else list(range(1, size + 1)), dtype=np.int64),
    )


def fixture_series(name: str) -> Series:
    """Load a committed OHLCV fixture from ``server/tests/fixtures``."""
    path = REPO_ROOT / "server" / "tests" / "fixtures" / f"{name}.json"
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return Series(
        symbol=payload["symbol"],
        timeframe=payload["timeframe"],
        open=np.asarray(payload["open"], dtype=float),
        high=np.asarray(payload["high"], dtype=float),
        low=np.asarray(payload["low"], dtype=float),
        close=np.asarray(payload["close"], dtype=float),
        volume=np.asarray(payload["volume"], dtype=float) if payload.get("volume") else None,
        times=np.asarray(payload.get("times", list(range(1, len(payload["close"]) + 1))), dtype=np.int64),
    )


def shared_examples() -> list[dict]:
    """Canonical condition trees, read by both the Python and TS suites."""
    with (SHARED / "condition_examples.json").open(encoding="utf-8") as handle:
        return json.load(handle)["examples"]


def shared_contexts() -> dict[str, dict]:
    """The named evaluation contexts declared in the shared example file."""
    with (SHARED / "condition_examples.json").open(encoding="utf-8") as handle:
        return json.load(handle)["contexts"]


def load_fixture_context() -> dict[str, EvaluationContext]:
    """Build the evaluation context for every shared context name.

    Delegates to the engine so the contexts the tests use and the contexts
    ``/test`` serves are built by the same code, from the same committed
    fixtures, in the same order.
    """
    from tradingv_engine.engine import _load_fixture_contexts

    return _load_fixture_contexts()


@pytest.fixture()
def examples() -> list[dict]:
    return shared_examples()


@pytest.fixture()
def contexts() -> dict:
    return load_fixture_context()
