/**
 * The agentic backtest.
 *
 * The GOAT runtime, running against a historical world.
 *
 * The shape of it:
 *
 *     SimulationClock          what time it is, and how fast
 *     SimulationEnvironment    the market, the account and the book
 *     BacktestSession          the replay: setup, ticks, wakes, execution
 *     summarisePerformance     the money
 *     summariseBehaviour       what the agent actually did
 *
 * All four are reusable on their own, and the session is the only thing that
 * knows the order they happen in.
 */

export {
  SimulationClock,
  DEFAULT_SIMULATION_SPEED,
  SIMULATION_SPEEDS,
  SIMULATION_STEP_MS,
  isSimulationSpeed,
  formatSimulatedDate,
  formatSimulatedTime,
  type SimulationSpeed,
} from './clock';

export {
  SimulationEnvironment,
  SIMULATION_BASE_TIMEFRAME,
  timeframeSeconds,
  latestAtOrBefore,
  validateDataset,
  type SimulationMarketConfig,
  type SimulationFact,
} from './simulationEnvironment';

export {
  BacktestSession,
  DEFAULT_BACKTEST_WARMUP_MINUTES,
  BACKTEST_WAKE_TIMEOUT_MS,
  type BacktestRequest,
  type BacktestHistory,
  type BacktestSnapshot,
  type BacktestState,
  type BacktestCostModel,
} from './session';

export {
  summarisePerformance,
  summariseBehaviour,
  formatPrice,
  formatR,
  type BacktestReport,
  type BacktestPerformance,
  type BacktestBehaviour,
} from './results';