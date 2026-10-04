"""TradingVibe market engine.

Deterministic market monitoring, indicator computation, and condition
evaluation. This package decides *when the AI should be woken*. It never
decides whether a trade is allowed and it never sends one.

The division of labour is the whole design:

* **This package** reads public market data, evaluates the condition trees
  in ``shared/condition_schema_v1.json``, and emits structured
  ``AI_WAKE`` events. It holds no credentials and has no execution path.
* **The web app** receives a wake, runs the existing policy, risk and DEMO
  execution guard, and lets the AI propose an action. Live trading is not
  available.

Nothing here imports a signing library, and a test asserts that.
"""

__version__ = "1.0.0"

__all__ = [
    "ConditionEngine",
    "EdgeDetector",
    "EngineConfig",
    "EvaluationContext",
    "MarketMonitor",
    "TrackerSpec",
    "WakeEvent",
    "WakePolicy",
    "__version__",
    "evaluate_tree",
    "load_config",
    "load_schema",
    "validate_tree",
]


def __getattr__(name: str):
    """
    Lazy re-exports.

    Importing the package must stay cheap: ``python -m tradingv_engine
    --print-schema`` and the test suite both import it, and neither needs
    numpy loaded to read a JSON file.
    """
    if name in {"ConditionEngine"}:
        from .engine import ConditionEngine

        return ConditionEngine
    if name in {"MarketMonitor", "TrackerSpec", "WakeEvent"}:
        from . import monitor

        return getattr(monitor, name)
    if name in {"EvaluationContext", "evaluate_tree", "explain"}:
        from . import evaluator

        return getattr(evaluator, name)
    if name in {"EdgeDetector", "WakePolicy"}:
        from . import edge

        return getattr(edge, name)
    if name in {"EngineConfig", "load_config"}:
        from . import config

        return getattr(config, name)
    if name in {"validate_tree", "load_schema", "ContractError"}:
        from . import contract

        return getattr(contract, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
