"""Indicator engine.

Every indicator returns a :class:`ComputedSeries` that states its
warmup and its validity, so a caller never has to guess whether a number
came from real data or from padding.

Standard indicators delegate to the ``ta`` library rather than being
reimplemented, because they have canonical textbook definitions and a
hand-rolled version would only add a chance to disagree with every other
tool in the industry. Derived series that ``ta`` does not provide as a
single call - Bollinger width, historical volatility, the rolling
percentage distance from a moving average - are computed here from
canonical building blocks.

Determinism: no randomness, no wall-clock, no I/O. The same input array
always produces the same output array.
"""

from __future__ import annotations

import math

import numpy as np
import ta

from ..config import TIMEFRAME_SECONDS
from ..series import ComputedSeries, Series, Validity


def _invalid(name: str, timeframe: str, validity: Validity, reason: str, size: int = 0) -> ComputedSeries:
    return ComputedSeries(
        name=name,
        timeframe=timeframe,
        values=np.full(size, np.nan, dtype=float),
        validity=validity,
        reason=reason,
    )


def _ok(name: str, timeframe: str, values: np.ndarray, warmup: int) -> ComputedSeries:
    return ComputedSeries(name=name, timeframe=timeframe, values=np.asarray(values, dtype=float), validity=Validity.OK, warmup=warmup)


def _check_period(series: Series, name: str, *periods: object) -> ComputedSeries | None:
    """Reject a malformed period rather than emitting an all-NaN series."""
    for period in periods:
        if period is None:
            continue
        if not isinstance(period, int) or isinstance(period, bool) or period < 1 or period > 1000:
            return _invalid(
                name,
                series.timeframe,
                Validity.INVALID_INPUT,
                f"Period must be a whole number between 1 and 1000, got {period!r}.",
                len(series),
            )
    return None


def _guard(series: Series, name: str, warmup: int) -> ComputedSeries | None:
    """Return an error result when the series cannot support ``name``."""
    if warmup < 1:
        return _invalid(name, series.timeframe, Validity.INVALID_INPUT, f"Invalid warmup {warmup!r}.", len(series))
    validity = series.validate_for(warmup)
    if validity is Validity.OK:
        return None
    reasons = {
        Validity.INSUFFICIENT_DATA: f"Not enough {series.timeframe} candles to calculate {name}. Need at least {warmup}, have {len(series)}.",
        Validity.INVALID_INPUT: f"{series.timeframe} candles contain non-finite values, so {name} cannot be calculated.",
        Validity.UNSUPPORTED: f"Timeframe {series.timeframe} is not supported.",
        Validity.MARKET_UNAVAILABLE: f"{series.symbol} is not publishing candles, so {name} cannot be calculated.",
    }
    return _invalid(name, series.timeframe, validity, reasons[validity], len(series))


# --------------------------------------------------------------------------- #
# Trend
# --------------------------------------------------------------------------- #

def sma(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"SMA({period})", period)
    if bad:
        return bad
    bad = _check_period(series, f"SMA({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"SMA({period})", period)
    if guard:
        return guard
    values = pd_series(series.close).rolling(window=period, min_periods=period).mean().to_numpy()
    return _ok(f"SMA({period})", series.timeframe, values, period - 1)


def ema(series: Series, period: int = 20) -> ComputedSeries:
    bad = _check_period(series, f"EMA({period})", period)
    if bad:
        return bad
    bad = _check_period(series, f"EMA({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"EMA({period})", period)
    if guard:
        return guard
    indicator = ta.trend.EMAIndicator(close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"EMA({period})", series.timeframe, indicator.ema_indicator().to_numpy(), period - 1)


def wma(series: Series, period: int = 20) -> ComputedSeries:
    bad = _check_period(series, f"WMA({period})", period)
    if bad:
        return bad
    bad = _check_period(series, f"WMA({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"WMA({period})", period)
    if guard:
        return guard
    weights = np.arange(1, period + 1, dtype=float)
    values = (
        pd_series(series.close).rolling(window=period, min_periods=period).apply(lambda w: float(np.dot(w, weights) / weights.sum()), raw=True).to_numpy()
    )
    return _ok(f"WMA({period})", series.timeframe, values, period - 1)


def vwap(series: Series) -> ComputedSeries:
    """
    Rolling VWAP over ``period`` bars.

    Session-anchored VWAP is meaningless for 24/7 crypto-style perps that
    have no session open, so this is a rolling window and is documented
    as such rather than pretending to be the exchange's daily VWAP.
    """
    period = 20
    bad = _check_period(series, "VWAP(20)", period)
    if bad:
        return bad
    guard = _guard(series, "VWAP(20)", period)
    if guard:
        return guard
    if not series.has_volume:
        return _invalid("VWAP(20)", series.timeframe, Validity.INSUFFICIENT_DATA, "No volume is available for this market, so VWAP cannot be calculated.", len(series))
    typical = (series.high + series.low + series.close) / 3.0
    frame = pd_series(typical).to_frame("tp")
    frame["vol"] = pd_series(series.volume)  # type: ignore[arg-type]
    cumulative = frame["tp"] * frame["vol"]
    values = (
        cumulative.rolling(window=period, min_periods=period).sum()
        / frame["vol"].rolling(window=period, min_periods=period).sum()
    ).to_numpy()
    return _ok("VWAP(20)", series.timeframe, values, period - 1)


def macd(series: Series, fast: int = 12, slow: int = 26, signal: int = 9) -> ComputedSeries:
    if fast >= slow:
        return _invalid("MACD", series.timeframe, Validity.INVALID_INPUT, "MACD needs a fast period below its slow period.", len(series))
    bad = _check_period(series, "MACD", fast, slow, signal)
    if bad:
        return bad
    bad = _check_period(series, "MACD", )
    if bad:
        return bad
    guard = _guard(series, "MACD", slow + signal)
    if guard:
        return guard
    indicator = ta.trend.MACD(close=pd_series(series.close), window_slow=slow, window_fast=fast, window_sign=signal, fillna=False)
    frame = indicator.macd()
    name = f"MACD({fast},{slow},{signal})"
    return ComputedSeries(
        name=name,
        timeframe=series.timeframe,
        values=frame.to_numpy(),
        validity=Validity.OK,
        warmup=slow + signal - 2,
        extras={
            "macd": frame.to_numpy(),
            "signal": indicator.macd_signal().to_numpy(),
            "histogram": indicator.macd_diff().to_numpy(),
        },
    )


def adx(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"ADX({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"ADX({period})", period * 2)
    if guard:
        return guard
    indicator = ta.trend.ADXIndicator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"ADX({period})", series.timeframe, _mask_warmup(indicator.adx().to_numpy(), period * 2 - 2), period * 2 - 2)


def plus_di(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"+DI({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"+DI({period})", period * 2)
    if guard:
        return guard
    indicator = ta.trend.ADXIndicator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"+DI({period})", series.timeframe, _mask_warmup(indicator.adx_pos().to_numpy(), period * 2 - 2), period * 2 - 2)


def minus_di(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"-DI({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"-DI({period})", period * 2)
    if guard:
        return guard
    indicator = ta.trend.ADXIndicator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"-DI({period})", series.timeframe, _mask_warmup(indicator.adx_neg().to_numpy(), period * 2 - 2), period * 2 - 2)


def psar(series: Series, step: float = 0.02, max_step: float = 0.2) -> ComputedSeries:
    bad = _check_period(series, "PSAR", )
    if bad:
        return bad
    guard = _guard(series, "PSAR", 3)
    if guard:
        return guard
    indicator = ta.trend.PSARIndicator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), step=step, max_step=max_step, fillna=False)
    return _ok("PSAR", series.timeframe, indicator.psar().to_numpy(), 1)


# --------------------------------------------------------------------------- #
# Momentum
# --------------------------------------------------------------------------- #

def rsi(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"RSI({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"RSI({period})", period + 1)
    if guard:
        return guard
    indicator = ta.momentum.RSIIndicator(close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"RSI({period})", series.timeframe, indicator.rsi().to_numpy(), period)


def stochastic(series: Series, period: int = 14, smooth: int = 3) -> ComputedSeries:
    bad = _check_period(series, f"Stochastic({period},{smooth})", period, smooth)
    if bad:
        return bad
    guard = _guard(series, f"Stochastic({period},{smooth})", period + smooth)
    if guard:
        return guard
    indicator = ta.momentum.StochasticOscillator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), window=period, smooth_window=smooth, fillna=False)
    values = indicator.stoch().to_numpy()
    result = _ok(f"Stochastic({period},{smooth})", series.timeframe, values, period + smooth - 1)
    return ComputedSeries(
        name=result.name,
        timeframe=result.timeframe,
        values=result.values,
        validity=result.validity,
        warmup=result.warmup,
        extras={"k": values, "d": indicator.stoch_signal().to_numpy()},
    )


def williams_r(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"Williams %R({period})", period)
    if bad:
        return bad
    bad = _check_period(series, f"Williams %R({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"Williams %R({period})", period)
    if guard:
        return guard
    indicator = ta.momentum.WilliamsRIndicator(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), lbp=period, fillna=False)
    return _ok(f"Williams %R({period})", series.timeframe, indicator.williams_r().to_numpy(), period - 1)


def roc(series: Series, period: int = 12) -> ComputedSeries:
    bad = _check_period(series, f"ROC({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"ROC({period})", period + 1)
    if guard:
        return guard
    indicator = ta.momentum.ROCIndicator(close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"ROC({period})", series.timeframe, indicator.roc().to_numpy(), period)


def momentum(series: Series, period: int = 10) -> ComputedSeries:
    bad = _check_period(series, f"Momentum({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"Momentum({period})", period + 1)
    if guard:
        return guard
    values = series.close - pd_series(series.close).shift(period).to_numpy()
    return _ok(f"Momentum({period})", series.timeframe, np.asarray(values, dtype=float), period)


# --------------------------------------------------------------------------- #
# Volatility
# --------------------------------------------------------------------------- #

def _mask_warmup(values: np.ndarray, warmup: int) -> np.ndarray:
    """Blank the samples an indicator could not have computed yet.

    The ``ta`` library seeds some indicators with ``np.zeros`` rather
    than NaN, so ATR, ADX and the directional indexes report a real
    ``0.0`` for every bar before their first genuine sample. ``0.0`` is
    not a neutral placeholder here: it is a value a condition can
    legitimately compare against, so ``ATR(14) > 0.5`` would read
    FALSE during warmup and ``ATR(14) < 2`` would read TRUE.

    The evaluator's minimum-length guard currently makes those samples
    unreachable, so this changes no live result. It removes the
    landmine: a fabricated zero is indistinguishable from a real one
    to every present and future consumer of ``values``.
    """
    masked = np.asarray(values, dtype=float).copy()
    if warmup > 0:
        masked[: max(warmup - 1, 0)] = np.nan
    return masked


def atr(series: Series, period: int = 14) -> ComputedSeries:
    bad = _check_period(series, f"ATR({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"ATR({period})", period + 1)
    if guard:
        return guard
    indicator = ta.volatility.AverageTrueRange(high=pd_series(series.high), low=pd_series(series.low), close=pd_series(series.close), window=period, fillna=False)
    return _ok(f"ATR({period})", series.timeframe, _mask_warmup(indicator.average_true_range().to_numpy(), period), period)


def bollinger(series: Series, period: int = 20, deviations: float = 2.0) -> ComputedSeries:
    bad = _check_period(series, f"Bollinger({period},{deviations})", period)
    if bad:
        return bad
    guard = _guard(series, f"Bollinger({period},{deviations})", period)
    if guard:
        return guard
    indicator = ta.volatility.BollingerBands(close=pd_series(series.close), window=period, window_dev=deviations, fillna=False)
    upper = indicator.bollinger_hband().to_numpy()
    middle = indicator.bollinger_mavg().to_numpy()
    lower = indicator.bollinger_lband().to_numpy()
    return ComputedSeries(
        name=f"Bollinger({period},{deviations})",
        timeframe=series.timeframe,
        values=middle,
        validity=Validity.OK,
        warmup=period - 1,
        extras={"upper": upper, "middle": middle, "lower": lower},
    )


def bollinger_width(series: Series, period: int = 20, deviations: float = 2.0) -> ComputedSeries:
    bands = bollinger(series, period, deviations)
    if not bands.ok:
        return _invalid(f"BollingerWidth({period},{deviations})", series.timeframe, bands.validity, bands.reason, len(series))
    middle = bands.extras["middle"]
    with np.errstate(divide="ignore", invalid="ignore"):
        values = np.where(middle != 0, (bands.extras["upper"] - bands.extras["lower"]) / np.abs(middle), np.nan)
    return _ok(f"BollingerWidth({period},{deviations})", series.timeframe, values, bands.warmup)


def stddev(series: Series, period: int = 20) -> ComputedSeries:
    bad = _check_period(series, f"StdDev({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"StdDev({period})", period)
    if guard:
        return guard
    values = pd_series(series.close).rolling(window=period, min_periods=period).std(ddof=0).to_numpy()
    return _ok(f"StdDev({period})", series.timeframe, values, period - 1)


def historical_volatility(series: Series, period: int = 20, periods_per_year: int | None = None) -> ComputedSeries:
    """
    Annualised standard deviation of log returns.

    Annualisation uses the timeframe's own bar count, so a 15m and a 1d
    series are comparable without the caller passing a constant.
    """
    bad = _check_period(series, f"HistoricalVolatility({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"HistoricalVolatility({period})", period + 1)
    if guard:
        return guard
    bars_per_year = periods_per_year if periods_per_year else (365 * 24 * 3600) // TIMEFRAME_SECONDS[series.timeframe]
    log_returns = np.diff(np.log(series.close), prepend=np.nan)
    rolling = pd_series(log_returns).rolling(window=period, min_periods=period).std(ddof=0).to_numpy()
    values = rolling * math.sqrt(bars_per_year) * 100.0
    return _ok(f"HistoricalVolatility({period})", series.timeframe, values, period)


# --------------------------------------------------------------------------- #
# Volume
# --------------------------------------------------------------------------- #

def volume_sma(series: Series, period: int = 20) -> ComputedSeries:
    bad = _check_period(series, f"VolumeSMA({period})", period)
    if bad:
        return bad
    if not series.has_volume:
        return _invalid(f"VolumeSMA({period})", series.timeframe, Validity.INSUFFICIENT_DATA, "This market does not provide volume.", len(series))
    bad = _check_period(series, f"VolumeSMA({period})", period)
    if bad:
        return bad
    bad = _check_period(series, f"VolumeSMA({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"VolumeSMA({period})", period)
    if guard:
        return guard
    values = pd_series(series.volume).rolling(window=period, min_periods=period).mean().to_numpy()  # type: ignore[arg-type]
    return _ok(f"VolumeSMA({period})", series.timeframe, values, period - 1)


def volume_change(series: Series, period: int = 1) -> ComputedSeries:
    bad = _check_period(series, f"VolumeChange({period})", period)
    if bad:
        return bad
    if not series.has_volume:
        return _invalid(f"VolumeChange({period})", series.timeframe, Validity.INSUFFICIENT_DATA, "This market does not provide volume.", len(series))
    bad = _check_period(series, f"VolumeChange({period})", period)
    if bad:
        return bad
    guard = _guard(series, f"VolumeChange({period})", period + 1)
    if guard:
        return guard
    previous = pd_series(series.volume).shift(period).to_numpy()  # type: ignore[arg-type]
    with np.errstate(divide="ignore", invalid="ignore"):
        values = np.where(previous != 0, (series.volume - previous) / np.abs(previous) * 100.0, np.nan)
    return _ok(f"VolumeChange({period})", series.timeframe, values, period)


def obv(series: Series) -> ComputedSeries:
    if not series.has_volume:
        return _invalid("OBV", series.timeframe, Validity.INSUFFICIENT_DATA, "This market does not provide volume.", len(series))
    bad = _check_period(series, "OBV", )
    if bad:
        return bad
    guard = _guard(series, "OBV", 2)
    if guard:
        return guard
    direction = np.sign(np.diff(series.close, prepend=series.close[0]))
    values = np.cumsum(direction * series.volume)  # type: ignore[operator]
    return _ok("OBV", series.timeframe, values, 1)


def volume_ratio(series: Series, period: int = 20) -> ComputedSeries:
    """Current volume divided by its own average. 1.0 means unremarkable."""
    average = volume_sma(series, period)
    if not average.ok:
        return _invalid(f"VolumeRatio({period})", series.timeframe, average.validity, average.reason, len(series))
    with np.errstate(divide="ignore", invalid="ignore"):
        values = np.where(average.values != 0, series.volume / average.values, np.nan)  # type: ignore[operator]
    return _ok(f"VolumeRatio({period})", series.timeframe, values, average.warmup)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #

INDICATORS = {
    "SMA": sma,
    "EMA": ema,
    "WMA": wma,
    "VWAP": vwap,
    "MACD": macd,
    "ADX": adx,
    "PLUS_DI": plus_di,
    "MINUS_DI": minus_di,
    "PSAR": psar,
    "RSI": rsi,
    "STOCHASTIC": stochastic,
    "STOCHASTIC_K": stochastic,
    "WILLIAMS_R": williams_r,
    "ROC": roc,
    "MOMENTUM": momentum,
    "ATR": atr,
    "BOLLINGER": bollinger,
    "BOLLINGER_UPPER": lambda s, **k: _bollinger_side(s, "upper", **k),
    "BOLLINGER_MIDDLE": lambda s, **k: _bollinger_side(s, "middle", **k),
    "BOLLINGER_LOWER": lambda s, **k: _bollinger_side(s, "lower", **k),
    "BOLLINGER_WIDTH": bollinger_width,
    "STDDEV": stddev,
    "HISTORICAL_VOLATILITY": historical_volatility,
    "VOLUME_SMA": volume_sma,
    "VOLUME_CHANGE": volume_change,
    "OBV": obv,
    "VOLUME_RATIO": volume_ratio,
}


def _bollinger_side(series: Series, side: str, period: int = 20, deviations: float = 2.0) -> ComputedSeries:
    bands = bollinger(series, period, deviations)
    if not bands.ok:
        return _invalid(bands.name, series.timeframe, bands.validity, bands.reason, len(series))
    return ComputedSeries(
        name=f"Bollinger{side.capitalize()}({period},{deviations})",
        timeframe=series.timeframe,
        values=bands.extras[side],
        validity=Validity.OK,
        warmup=bands.warmup,
    )


def pd_series(values):
    """Small helper so the import stays local to this module."""
    import pandas as pd

    return pd.Series(values)


def compute(series: Series, indicator: str, **params) -> ComputedSeries:
    """Compute one indicator by catalogue name.

    Unknown indicators raise rather than returning a plausible-looking
    number, because a silent wrong value in a condition engine is worse
    than a loud failure.
    """
    function = INDICATORS.get(indicator)
    if function is None:
        raise KeyError(f"Unknown indicator: {indicator}")
    cleaned = {key: value for key, value in params.items() if value is not None}
    return function(series, **cleaned)


#: Canonical warmup per indicator, used to size history requirements.
WARMUP = {
    "SMA": lambda p: p,
    "EMA": lambda p: p * 3,
    "WMA": lambda p: p,
    "VWAP": lambda p: p,
    "MACD": lambda p: (p[1] if isinstance(p, tuple) else 26) + (p[2] if isinstance(p, tuple) else 9),
    "ADX": lambda p: p * 2,
    "PLUS_DI": lambda p: p * 2,
    "MINUS_DI": lambda p: p * 2,
    "PSAR": lambda p: 3,
    "RSI": lambda p: p + 1,
    "STOCHASTIC": lambda p: (p[0] if isinstance(p, tuple) else 14) + (p[1] if isinstance(p, tuple) else 3),
    "STOCHASTIC_K": lambda p: (p[0] if isinstance(p, tuple) else 14) + (p[1] if isinstance(p, tuple) else 3),
    "WILLIAMS_R": lambda p: p,
    "ROC": lambda p: p + 1,
    "MOMENTUM": lambda p: p + 1,
    "ATR": lambda p: p + 1,
    "BOLLINGER": lambda p: p,
    "BOLLINGER_UPPER": lambda p: p,
    "BOLLINGER_MIDDLE": lambda p: p,
    "BOLLINGER_LOWER": lambda p: p,
    "BOLLINGER_WIDTH": lambda p: p,
    "STDDEV": lambda p: p,
    "HISTORICAL_VOLATILITY": lambda p: p + 1,
    "VOLUME_SMA": lambda p: p,
    "VOLUME_CHANGE": lambda p: p + 1,
    "OBV": lambda p: 2,
    "VOLUME_RATIO": lambda p: p,
}


def required_history(indicator: str, params: dict) -> int:
    rule = WARMUP.get(indicator)
    if rule is None:
        return 1
    try:
        return int(rule(params))
    except Exception:  # pragma: no cover - defensive
        return 1
