"""``python -m tradingv_engine`` starts the condition engine.

The engine reads market data, evaluates condition trees, and emits
``AI_WAKE`` events over HTTP. It has no execution capability: there is no
code path from a condition being true to an order being placed, and no way
to configure one.
"""

from __future__ import annotations

import argparse
import contextlib
import sys

from .config import assert_local_only, load_config
from .contract import ContractError, load_schema


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tradingv_engine",
        description="Run the TradingVibe condition engine. It wakes the AI; it never trades.",
    )
    parser.add_argument("--host", help="Bind address. Defaults to TRADINGV_ENGINE_HOST.")
    parser.add_argument("--port", type=int, help="Port. Defaults to TRADINGV_ENGINE_PORT.")
    parser.add_argument("--poll-interval", type=float, help="Seconds between market polls.")
    parser.add_argument(
        "--print-schema",
        action="store_true",
        help="Print the committed condition schema and exit. Reads no network.",
    )
    parser.add_argument(
        "--list-events",
        action="store_true",
        help="Print the engine's event vocabulary and exit. Reads no network.",
    )
    args = parser.parse_args(argv)

    if args.print_schema:
        import json

        print(json.dumps(load_schema(), indent=2))
        return 0

    if args.list_events:
        from .events import EventType

        for member in EventType:
            print(f"{member.value}\t{member.__doc__ or ''}".rstrip())
        return 0

    config = load_config()
    # Command line flags win over the environment, so a run can be pointed
    # at a different port without editing a file.
    if args.host:
        config = _replace(config, host=args.host)
    if args.port:
        config = _replace(config, port=args.port)
    if args.poll_interval:
        config = _replace(config, poll_interval_s=args.poll_interval)

    try:
        assert_local_only(config.host)
    except RuntimeError as error:
        # Refuse to serve at all. An engine reachable from the network
        # with unauthenticated wake endpoints is worse than an engine
        # that will not start.
        print(str(error), file=sys.stderr)
        return 2

    if config.live_trading_enabled:
        # The flag is accepted so the refusal is explicit rather than
        # surprising, but it does not turn anything on.
        print(
            "TRADINGV_LIVE_TRADING is set, and it is ignored: this engine "
            "has no execution capability to enable.",
            file=sys.stderr,
        )

    try:
        from .api import create_app
    except ImportError as error:  # pragma: no cover - install-time problem
        print(f"The HTTP surface needs fastapi and uvicorn: {error}", file=sys.stderr)
        return 2

    import uvicorn

    app = create_app(config=config)
    with contextlib.suppress(KeyboardInterrupt):
        uvicorn.run(app, host=config.host, port=config.port, log_level="info")
    return 0


def _replace(config, **changes):
    from dataclasses import replace

    return replace(config, **changes)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
