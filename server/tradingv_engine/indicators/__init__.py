"""Indicator computations.

One registry, one signature: every indicator takes a :class:`Series` and
returns a :class:`ComputedSeries` with an explicit validity. An indicator
that cannot be computed says so rather than returning a plausible number,
because a silently wrong value in a condition engine is worse than a loud
failure - the user would build a bot on top of it.
"""

from .engine import INDICATORS, compute, required_history

__all__ = ["INDICATORS", "compute", "required_history"]
