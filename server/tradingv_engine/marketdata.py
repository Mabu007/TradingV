"""Hyperliquid market data.

Reads the venue's **public** endpoints. There is no signing in this
module, no API wallet, and no order capability, because the engine never
places an order.

The market identity is the same one the web app uses: the provider
symbol with its HIP-3 namespace, the asset class, and the canonical
instrument metadata. A market that is unavailable upstream stays
unavailable here. An oracle or mark price is never promoted into an
executable price.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from .config import EngineConfig
from .series import Series

import numpy as np

#: The canonical asset classification, mirroring the TypeScript
#: normalizer. Duplicated deliberately rather than imported from a
#: JavaScript module: the engine has to run without a Node runtime, and
#: the two are covered by a shared-fixture contract test.
FOREX_ASSETS = {"EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD", "KRW", "MXN", "ZAR", "SGD", "HKD"}
COMMODITY_ASSETS = {
    "GOLD", "SILVER", "CL", "BRENTOIL", "WTI", "USOIL", "OIL", "COPPER", "NATGAS", "GAS",
    "URANIUM", "ALUMINIUM", "PLATINUM", "PALLADIUM", "CORN", "WHEAT", "TTF",
}
INDEX_ASSETS = {
    "SP500", "USA500", "US500", "USA100", "USTECH", "NASDAQ", "DOW", "DJI", "JP225", "KR200",
    "DAX", "FTSE", "NIFTY", "IBOV", "VIX", "DXY", "SMALL2000",
}

INTERVAL_MAP = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
}

#: Milliseconds per supported timeframe, used to bound the candle window.
INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def classify(provider_symbol: str) -> str | None:
    asset = provider_symbol.split(":")[-1].upper()
    if asset in FOREX_ASSETS:
        return "FOREX"
    if asset in COMMODITY_ASSETS:
        return "COMMODITY"
    if asset in INDEX_ASSETS:
        return "INDEX"
    return None


@dataclass(frozen=True)
class Instrument:
    """Canonical instrument metadata, as discovered."""

    symbol: str
    provider_symbol: str
    asset_class: str
    display_name: str
    dex: str
    availability: str
    unavailable_reason: str = ""
    price_precision: int | None = None
    size_precision: int | None = None
    max_leverage: float | None = None
    tick_size: float | None = None
    pip_size: float | None = None

    @property
    def tradeable(self) -> bool:
        return self.availability == "TRADEABLE"

    def to_json(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "providerSymbol": self.provider_symbol,
            "assetClass": self.asset_class,
            "displayName": self.display_name,
            "dex": self.dex,
            "availability": self.availability,
            "unavailableReason": self.unavailable_reason,
            "pricePrecision": self.price_precision,
            "sizePrecision": self.size_precision,
            "maxLeverage": self.max_leverage,
            "tickSize": self.tick_size,
            "pipSize": self.pip_size,
        }


class MarketDataError(RuntimeError):
    """The venue could not be read."""


class HyperliquidMarketData:
    """
    Thin client over the venue's public ``/info`` endpoint.

    Injectable transport so the whole engine can be tested offline with a
    fixture function instead of the network.
    """

    def __init__(
        self,
        config: EngineConfig | None = None,
        transport: Callable[[dict], dict] | None = None,
    ) -> None:
        self.config = config or EngineConfig()
        self._transport = transport or self._http_post
        self._instruments: list[Instrument] = []
        self._loaded_at = 0.0

    # ---------------------------------------------------------------- HTTP

    def _http_post(self, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.config.resolved_api_url(),
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.request_timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
            raise MarketDataError(f"Hyperliquid request failed: {error}") from error

    # --------------------------------------------------------- instruments

    def load_instruments(self) -> list[Instrument]:
        """Discover the tradable universe. Only public metadata is read."""
        dexes = self._transport({"type": "perpDexs"})
        # `perpDexs` is a positional list whose first element is `null` --
        # the default perps entry carries no name -- and the deployed
        # namespaces follow as objects. Reading `.get` off every element
        # crashed discovery outright, which surfaced in the browser as a
        # failed market list and, because the resulting 500 carried no
        # CORS headers, as a CORS error with nothing to act on.
        #
        # The shape is the venue's, not ours, so it is filtered rather
        # than assumed: anything without a usable name is skipped.
        names = [
            entry["name"]
            for entry in (dexes if isinstance(dexes, list) else [])
            if isinstance(entry, dict) and isinstance(entry.get("name"), str) and entry["name"]
        ]

        instruments: list[Instrument] = []

        for dex in names:
            try:
                context = self._transport({"type": "metaAndAssetCtxs", "dex": dex})
            except MarketDataError:
                continue

            if not isinstance(context, list) or not context:
                continue

            meta = context[0] or {}
            contexts = context[1] if len(context) > 1 else []

            universe = meta.get("universe") or []
            for index, entry in enumerate(universe):
                name = entry.get("name")
                if not name:
                    continue
                provider_symbol = f"{dex}:{name}"
                asset_class = classify(provider_symbol)
                if asset_class is None:
                    continue

                ctx = contexts[index] if index < len(contexts) else {}
                if not isinstance(ctx, dict):
                    ctx = {}

                # Tradeability requires a price the venue actually quotes a
                # market with: the mid of the book, or the mark price. An
                # oracle-only market has no book behind it, so it is listed
                # but not tradeable. The oracle price is never promoted
                # into an executable price, here or anywhere else.
                quoted = _as_float(ctx.get("midPx"))
                if quoted is None:
                    quoted = _as_float(ctx.get("markPx"))

                availability = "TRADEABLE" if quoted is not None and quoted > 0 else "UNAVAILABLE"
                reason = "" if availability == "TRADEABLE" else (
                    "The venue lists this market but publishes no quoted price for it, "
                    "so it cannot be quoted or traded."
                )

                size_decimals = entry.get("szDecimals")
                # Precision is a formatting fact, so any published price
                # is enough to read the tick size, quoted or not.
                price_decimals = _price_decimals_from_tick(str(entry.get("tickSz", "")))
                max_leverage = _as_float(ctx.get("maxLeverage"))

                instruments.append(
                    Instrument(
                        symbol=_label(provider_symbol, asset_class),
                        provider_symbol=provider_symbol,
                        asset_class=asset_class,
                        display_name=f"{_label(provider_symbol, asset_class)} Perpetual",
                        dex=dex,
                        availability=availability,
                        unavailable_reason=reason,
                        price_precision=price_decimals,
                        size_precision=size_decimals,
                        max_leverage=max_leverage,
                        tick_size=10 ** -price_decimals if price_decimals else None,
                        pip_size=_pip_size(provider_symbol, asset_class),
                    )
                )

        self._instruments = instruments
        self._loaded_at = time.time()
        return instruments

    @property
    def instruments(self) -> list[Instrument]:
        return list(self._instruments)

    def instrument(self, provider_symbol: str) -> Instrument | None:
        wanted = provider_symbol.upper()
        for instrument in self._instruments:
            if instrument.provider_symbol.upper() == wanted:
                return instrument
        return None

    def tradeable_symbols(self) -> list[str]:
        return [item.provider_symbol for item in self._instruments if item.tradeable]

    # -------------------------------------------------------------- candles

    def candles(self, provider_symbol: str, timeframe: str, limit: int = 500) -> Series:
        """
        Fetch closed candles for one market and timeframe.

        A venue failure is a :class:`MarketDataError`; it is never turned
        into an empty-but-valid series, because that would let a market
        silently look flat instead of unavailable.
        """
        interval = INTERVAL_MAP.get(timeframe)
        if interval is None:
            raise MarketDataError(f"Timeframe {timeframe!r} is not served by the venue.")

        # A bounded window, not `startTime: 0`. Asking for everything since
        # genesis would pull years of candles on every poll for a value
        # that is thrown away by `tail` below.
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - INTERVAL_MS[timeframe] * limit

        response = self._transport(
            {
                "type": "candleSnapshot",
                "req": {
                    "coin": provider_symbol,
                    "interval": interval,
                    "startTime": start_ms,
                    "endTime": end_ms,
                },
            }
        )

        rows = [row for row in (response or []) if isinstance(row, dict)]
        if not rows:
            raise MarketDataError(f"No candles returned for {provider_symbol} {timeframe}.")

        rows.sort(key=lambda row: int(row.get("t", 0)))

        times = np.array([int(row["t"]) for row in rows], dtype=np.int64)
        opens = np.array([_as_float(row.get("o")) or 0.0 for row in rows], dtype=float)
        highs = np.array([_as_float(row.get("h")) or 0.0 for row in rows], dtype=float)
        lows = np.array([_as_float(row.get("l")) or 0.0 for row in rows], dtype=float)
        closes = np.array([_as_float(row.get("c")) or 0.0 for row in rows], dtype=float)
        volumes = np.array([_as_float(row.get("v")) or 0.0 for row in rows], dtype=float)

        return Series(
            symbol=provider_symbol,
            timeframe=timeframe,
            open=opens,
            high=highs,
            low=lows,
            close=closes,
            volume=volumes,
            times=times,
        ).tail(limit)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def _price_decimals_from_tick(tick: str) -> int | None:
    if not tick or "." not in tick:
        return None
    return len(tick.split(".", 1)[1].rstrip("0")) or None


def _pip_size(provider_symbol: str, asset_class: str) -> float | None:
    """Pip size exists only for Forex pairs whose quote currency is known."""
    if asset_class != "FOREX":
        return None
    return 0.01 if provider_symbol.split(":")[-1].upper() == "JPY" else 0.0001


def _label(provider_symbol: str, asset_class: str) -> str:
    asset = provider_symbol.split(":")[-1].upper()
    if asset_class == "FOREX":
        return {"EUR": "EUR/USD", "GBP": "GBP/USD", "JPY": "USD/JPY", "AUD": "AUD/USD", "NZD": "NZD/USD", "CAD": "USD/CAD", "CHF": "USD/CHF", "KRW": "USD/KRW"}.get(asset, asset)
    if asset_class == "COMMODITY":
        return {"GOLD": "Gold", "SILVER": "Silver", "CL": "WTI", "BRENTOIL": "Brent Crude Oil", "COPPER": "Copper", "NATGAS": "Natural Gas", "PLATINUM": "Platinum", "PALLADIUM": "Palladium"}.get(asset, asset)
    return {"SP500": "S&P 500", "USA500": "S&P 500", "US500": "US 500", "USTECH": "US Tech 100", "JP225": "Japan 225", "KR200": "Korea 200", "SMALL2000": "Small 2000"}.get(asset, asset)
