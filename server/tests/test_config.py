"""Engine configuration and network-boundary tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from tradingv_engine.config import (
    VENUE_API_URLS,
    VENUE_ENVIRONMENTS,
    assert_local_only,
    is_loopback,
    load_config,
)

REPO_ROOT = Path(__file__).resolve().parents[2]




# --------------------------------------------------------------------------- #
# V0 audit #25: the engine's mutating endpoints are unauthenticated
#
# They are only safe while the process is unreachable from the network.
# The default bind is loopback, but a default is a convention, not a
# control: setting TRADINGV_ENGINE_HOST=0.0.0.0 -- one variable, in a
# docker-compose file, to reach the engine from another container --
# would serve unauthenticated tracker registration to the network.
#
# CORS does not help here. It constrains browsers, not curl, and not
# another host on the LAN.
# --------------------------------------------------------------------------- #


def test_the_default_bind_is_loopback():
    assert is_loopback(load_config().host), "the engine does not default to a loopback bind"


def test_loopback_binds_are_accepted():
    for host in ("127.0.0.1", "localhost", "::1", ""):
        assert_local_only(host)  # must not raise


def test_a_public_bind_is_refused():
    """The case the check exists for."""
    for host in ("0.0.0.0", "::", "192.168.1.10", "engine.internal"):
        with pytest.raises(RuntimeError) as raised:
            assert_local_only(host)
        message = str(raised.value)
        assert "TRADINGV_ENGINE_ALLOW_PUBLIC" in message, "the refusal does not say how to proceed"
        assert "authentication" in message or "authenticating" in message, "the refusal does not explain the risk"


def test_a_public_bind_still_needs_to_be_asked_for_by_name(monkeypatch):
    monkeypatch.delenv("TRADINGV_ENGINE_ALLOW_PUBLIC", raising=False)
    with pytest.raises(RuntimeError):
        assert_local_only("0.0.0.0")

    monkeypatch.setenv("TRADINGV_ENGINE_ALLOW_PUBLIC", "1")
    assert_local_only("0.0.0.0")  # opt-in, not a default


def test_the_refusal_happens_before_the_server_starts():
    """A refusal that ran after uvicorn bound the socket would be useless."""
    source = (REPO_ROOT / "server" / "tradingv_engine" / "__main__.py").read_text(encoding="utf-8")
    assert source.index("assert_local_only(config.host)") < source.index("uvicorn.run("), (
        "the engine binds its socket before checking the bind address"
    )


# --------------------------------------------------------------------------- #
# The venue environment
#
# Hyperliquid runs the same markets on two networks, one of which holds real
# value, and the two differ by a single hostname. The engine and the
# frontend both talk to it, so "which network is this process on" has to be
# one answer rather than a convention each side interprets for itself.
# --------------------------------------------------------------------------- #


def test_the_environment_table_has_one_host_per_environment():
    assert set(VENUE_API_URLS) == set(VENUE_ENVIRONMENTS), (
        "every environment has an endpoint and every endpoint an environment"
    )

    hosts = {url.split("/")[2] for url in VENUE_API_URLS.values()}
    assert len(hosts) == len(VENUE_ENVIRONMENTS), "the environments do not share a host"

    for environment, url in VENUE_API_URLS.items():
        assert url.startswith("https://"), f"{environment} uses https"
        assert url.endswith("/info"), f"{environment} uses the info endpoint"

    # The two hosts differ by a suffix, so the suffix is the thing to check.
    assert "testnet" not in VENUE_API_URLS["MAINNET"], "mainnet does not mention testnet"
    assert "hyperliquid.xyz" not in VENUE_API_URLS["TESTNET"], "testnet does not mention mainnet"


def test_an_unrecognised_environment_resolves_to_mainnet(monkeypatch):
    """A typo must not silently point the engine at the other network."""
    for value in ("", "  ", "staging", "hyperliquid", "tru"):
        monkeypatch.setenv("TRADINGV_NETWORK", value)
        assert load_config().environment == "MAINNET", f"{value!r} resolves to Mainnet"

    monkeypatch.delenv("TRADINGV_NETWORK", raising=False)
    assert load_config().environment == "MAINNET", "unset resolves to Mainnet"


def test_case_and_whitespace_are_tolerated(monkeypatch):
    for value in ("testnet", "TESTNET", "  Testnet  "):
        monkeypatch.setenv("TRADINGV_NETWORK", value)
        config = load_config()
        assert config.environment == "TESTNET", f"{value!r} is Testnet"
        assert config.testnet is True
        assert config.live is False


def test_the_resolved_endpoint_follows_the_environment(monkeypatch):
    monkeypatch.delenv("TRADINGV_HYPERLIQUID_API", raising=False)

    monkeypatch.setenv("TRADINGV_NETWORK", "MAINNET")
    mainnet = load_config()
    assert mainnet.resolved_api_url() == VENUE_API_URLS["MAINNET"]
    assert mainnet.live is True, "Mainnet holds real value"

    monkeypatch.setenv("TRADINGV_NETWORK", "TESTNET")
    testnet = load_config()
    assert testnet.resolved_api_url() == VENUE_API_URLS["TESTNET"]
    assert testnet.live is False


def test_an_override_that_contradicts_the_environment_is_refused(monkeypatch):
    """The failure this prevents: a process that reports one network and reads another."""
    monkeypatch.setenv("TRADINGV_NETWORK", "MAINNET")
    monkeypatch.setenv("TRADINGV_HYPERLIQUID_API", VENUE_API_URLS["TESTNET"])

    with pytest.raises(ValueError) as raised:
        load_config().resolved_api_url()

    message = str(raised.value)
    assert "MAINNET" in message, "the refusal names the declared environment"
    assert "TRADINGV_NETWORK" in message, "and says which variable to change"


def test_an_override_that_agrees_is_honoured(monkeypatch):
    monkeypatch.setenv("TRADINGV_NETWORK", "TESTNET")
    monkeypatch.setenv("TRADINGV_HYPERLIQUID_API", VENUE_API_URLS["TESTNET"])
    assert load_config().resolved_api_url() == VENUE_API_URLS["TESTNET"]


def test_the_engine_and_the_frontend_agree_on_the_hosts():
    """The two halves must not drift apart on the one thing that has to match."""
    frontend = (REPO_ROOT / "src" / "config" / "venue.ts").read_text(encoding="utf-8")
    for environment, url in VENUE_API_URLS.items():
        assert url in frontend, f"{environment} REST host is missing from src/config/venue.ts"

    assert "MAINNET" in frontend and "TESTNET" in frontend, (
        "the frontend uses the same environment names this engine does"
    )
