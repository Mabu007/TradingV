"""Configuration.

Every deployment knob is an environment variable. Nothing here is
hardcoded, and nothing here is a secret: the engine holds no signing
material, no API keys, and no private keys, because it never places an
order. It only decides when the AI should be woken.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# The only condition schema version this build understands.
SUPPORTED_SCHEMA_VERSIONS = (1,)

TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")

# Hyperliquid publishes candles for these intervals on its public API.
# The list is deliberately closed: a condition may only ask for a
# timeframe the venue actually serves.
SUPPORTED_TIMEFRAMES = TIMEFRAMES

#: Used when a condition leaf does not name a timeframe, and by the web
#: app when it needs a default chart interval.
DEFAULT_TIMEFRAME = "15m"

TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}

# How many candles a timeframe keeps in memory before the oldest are
# dropped. Sized so a 200-period EMA plus a 500-bar breakout has room.
DEFAULT_HISTORY = 1500


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# The two Hyperliquid environments and the only host each one is served
# from. This is the whole difference between them, so it lives in one table
# and nothing composes a hostname of its own.
#
# The values are uppercase to match the frontend's `src/config/venue.ts`.
# The two halves of this system must agree on which network they are on,
# and agreeing on a string is easier than agreeing on a convention.
VENUE_ENVIRONMENTS = ("MAINNET", "TESTNET")

VENUE_API_URLS = {
    "MAINNET": "https://api.hyperliquid.xyz/info",
    "TESTNET": "https://api.hyperliquid-testnet.xyz/info",
}


def _resolve_environment(raw: str | None) -> str:
    """Normalise a configured environment.

    Case and whitespace are tolerated, because the value's first home is a
    shell command line. Anything unrecognised resolves to MAINNET rather
    than a guess between the two: a typo must never silently point the
    engine at the network the operator did not choose.
    """
    normalized = (raw or "").strip().upper()
    return normalized if normalized in VENUE_ENVIRONMENTS else "MAINNET"


@dataclass(frozen=True)
class EngineConfig:
    """Resolved runtime configuration."""

    # Market data. Public Hyperliquid endpoints only.
    environment: str = field(
        default_factory=lambda: _resolve_environment(os.environ.get("TRADINGV_NETWORK"))
    )
    # An explicit override, honoured only when it agrees with the
    # environment. Kept because it is a deployment contract, and checked
    # because an override that disagrees with the declared environment is
    # how a process ends up reporting one network while reading another.
    api_url_override: str | None = field(
        default_factory=lambda: os.environ.get("TRADINGV_HYPERLIQUID_API") or None
    )
    request_timeout_s: float = field(default_factory=lambda: _env_float("TRADINGV_HTTP_TIMEOUT", 10.0))
    poll_interval_s: float = field(default_factory=lambda: _env_float("TRADINGV_POLL_INTERVAL", 20.0))

    # Candle retention.
    history: int = field(default_factory=lambda: _env_int("TRADINGV_HISTORY", DEFAULT_HISTORY))

    # HTTP surface.
    host: str = field(default_factory=lambda: os.environ.get("TRADINGV_ENGINE_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("TRADINGV_ENGINE_PORT", 8099))

    # Live trading is impossible in this engine. The flag exists so the
    # refusal is explicit in configuration as well as in code.
    live_trading_enabled: bool = field(
        default_factory=lambda: _env_bool("TRADINGV_LIVE_TRADING", False)
    )

    @property
    def testnet(self) -> bool:
        return self.environment == "TESTNET"

    @property
    def live(self) -> bool:
        """Whether this environment holds real value."""
        return self.environment == "MAINNET"

    def resolved_api_url(self) -> str:
        """The endpoint for the configured environment.

        A disagreement between the declared environment and an explicit URL
        override is an error rather than a preference. Preferring one would
        mean the process reports one network and reads another, and the
        discrepancy would only surface as a market that refuses to load.
        """
        expected = VENUE_API_URLS[self.environment]
        override = (self.api_url_override or "").strip()

        if override and override.rstrip("/") != expected.rstrip("/"):
            raise ValueError(
                f"TRADINGV_HYPERLIQUID_API={override!r} does not belong to "
                f"{self.environment} (expected {expected!r}). Set TRADINGV_NETWORK "
                f"to match, or remove the override."
            )

        return override or expected


def load_config() -> EngineConfig:
    return EngineConfig()


# --------------------------------------------------------------------------- #
# Network boundary
#
# The engine's mutating endpoints -- register a tracker, delete one,
# evaluate a tree -- have no authentication. That is acceptable while
# the process is only reachable from the machine it runs on, and unsafe
# the moment it is not: CORS does not stop curl, another host on the
# network, or anything that is not a browser.
#
# The default bind is loopback, so the safe case is the default case. The
# point of this check is that the unsafe case cannot happen by accident,
# which a default alone does not guarantee.
# --------------------------------------------------------------------------- #

#: Addresses that keep the engine on this machine.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", ""})

#: Wildcard binds, which are public regardless of the port.
WILDCARD_HOSTS = frozenset({"0.0.0.0", "::", "[::]"})


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def is_loopback(host: str) -> bool:
    return host.strip().lower() in LOOPBACK_HOSTS


def assert_local_only(host: str) -> None:
    """Refuse a non-loopback bind unless it was asked for by name.

    Raising here means the process never serves, rather than serving
    unauthenticated wake endpoints to the network and being discovered
    in review.
    """
    if is_loopback(host):
        return
    if _env_flag("TRADINGV_ENGINE_ALLOW_PUBLIC"):
        return
    raise RuntimeError(
        f"Refusing to bind {host!r}: the engine's mutating endpoints have no "
        "authentication and are only safe on this machine. Set "
        "TRADINGV_ENGINE_HOST=127.0.0.1, or, if a public bind is genuinely "
        "intended, set TRADINGV_ENGINE_ALLOW_PUBLIC=1 and put an "
        "authenticating proxy in front of it."
    )
