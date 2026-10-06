/**
 * The agentic backtest.
 *
 * The GOAT runtime, running against a historical world.
 *
 * The shape of it:
 *
 *     SimulationClock          what time it is, and how fast
 *     SimulationEnvironment    the market, the account and the book
 *     BacktestSession          the replay: setup, bars, wakes, execution
 *     window.ts                choosing a window in history
 *     story.ts                 the run as a story, counted from the log
 *     history.ts               what the last few runs left behind
 *     summarisePerformance     the money
 *     summariseBehaviour       what the agent actually did
 *
 * All of them are reusable on their own, and the session is the only thing that
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
  REPLAY_HOLD_ON_WAKE_MS,
  REPLAY_HOLD_ON_ORDER_MS,
  REPLAY_HOLD_ON_FILL_MS,
  REPLAY_HOLD_ON_OUTCOME_MS,
  type BacktestRequest,
  type BacktestHistory,
  type BacktestSnapshot,
  type BacktestState,
  type BacktestCostModel,
  type BacktestStory,
  type DecisionReview,
} from './session';

export {
  HISTORICAL_PRESETS,
  windowForPreset,
  windowForPresetRequest,
  baseResolutionFor,
  describeWindow,
  latestClosedMinute,
  type HistoricalWindow,
  type HistoricalPreset,
} from './window';

export {
  deriveGoatState,
  isAnimatedState,
  deriveKeyMoments,
  deriveNearMisses,
  deriveVerdict,
  deriveBehaviourScore,
  momentTime,
  type GoatState,
  type KeyMoment,
  type MomentKind,
  type NearMiss,
  type BehaviourScore,
  type ScoreLine,
  type ScoreDimension,
} from './story';

export {
  replayHistory,
  recordReplaySummary,
  lastReplayFor,
  clearReplayHistory,
  type ReplaySummary,
} from './history';

export {
  summarisePerformance,
  summariseBehaviour,
  formatPrice,
  formatR,
  type BacktestReport,
  type BacktestPerformance,
  type BacktestBehaviour,
} from './results';