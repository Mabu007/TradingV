/**
 * The replay surface.
 *
 * "Send this GOAT into history and watch what it would have done."
 *
 * ## The shape of it
 *
 * Not a wizard with a results page. Pressing START puts the reader inside the GOAT
 * workspace immediately — the same Trade Plan, the same Agent Log, the same
 * vocabulary the live surfaces use — with the historical clock as the loudest thing
 * on the screen and a state word that says what the agent is doing rather than what
 * the transport is doing.
 *
 * The three things that must never be wrong, because a reader cannot check them:
 *
 *   1. Nothing here is live. The BACKTEST badge is permanent, every execution line
 *      says simulated, and the clock is labelled as a time machine.
 *   2. The GOAT never saw the future. It has not here either: it reads the same
 *      closed-candle boundary the live GOAT reads, and the replay holds historical
 *      time while it thinks.
 *   3. A replay cannot reach a venue. Not "is unlikely to" — the simulated book has
 *      no route to one.
 *
 * ## What was deliberately left out
 *
 * No candle chart, no strategy builder, no equity curve, no scrubber. The question
 * is not "what did the market do", and a chart answers it better than this product
 * should. It is "what would my GOAT have done about it", and the answer is the log,
 * the plan and the trade list.
 *
 * ## Loading is a story, not a spinner
 *
 * The first thing the reader sees after START is the workspace with a state that
 * says what is happening — building the world, deploying, then investigating — and
 * every one of those phases is a real phase with a real amount of work behind it.
 * A backtest that spends eight seconds on a spinner has told the reader nothing for
 * eight seconds, which is the same as telling them it has hung.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
  Zap,
} from 'lucide-react';

import type { Bar } from '../../types/trading';
import {
  backtestKeyFor,
  backtestManager,
  createManagedBacktest,
} from '../../engine/goat/backtest/manager';
import {
  BacktestSession,
  DEFAULT_BACKTEST_WARMUP_MINUTES,
  HISTORICAL_PRESETS,
  SIMULATION_SPEEDS,
  describeWindow,
  formatSimulatedDate,
  formatSimulatedTime,
  momentTime,
  windowForPresetRequest,
  type BacktestHistory,
  type BacktestSnapshot,
  type BacktestStory,
  type DecisionReview,
  type HistoricalPreset,
  type KeyMoment,
  type ReplaySummary,
  type SimulationSpeed,
} from '../../engine/goat/backtest';
import {
  replayHistory,
} from '../../engine/goat/backtest/history';
import {
  SUPPORTED_TIMEFRAMES,
  resolveTimeframePlan,
  type Timeframe,
} from '../../engine/goat/timeframes';
import type { GoatMission } from '../../engine/goat/mission';
import { buildPlanView } from '../../engine/goat/planView';
import type { AgentEventView } from '../../engine/goat/agentEvents';
import { historicalMarketDataProvider } from '../../engine/backtester/historical';

import { AgentLog } from './AgentLog';
import { TradeLog } from './TradeLog';
import { tradeAnalysisPrompt } from './tradeAnalysis';
import { TradePlanPanel } from './TradePlanPanel';

/** Resolution presets offered as one click, rather than a picker to configure. */
const TIMEFRAME_PRESETS: Array<{ id: string; label: string; timeframes: Timeframe[] }> = [
  { id: 'declared', label: 'THE GOAT OWN', timeframes: [] },
  { id: 'scalp', label: 'SCALP 1m·5m', timeframes: ['1m', '5m'] },
  { id: 'intraday', label: '5m·15m·1h', timeframes: ['5m', '15m', '1h'] },
  { id: 'swing', label: '15m·1h·4h', timeframes: ['15m', '1h', '4h'] },
  { id: 'position', label: '4h·1d', timeframes: ['4h', '1d'] },
];

/** The period offered first when nothing else is known. */
const DEFAULT_PRESET = 'week';

/**
 * One sentence saying what the replay will read.
 *
 * The roles are in it because "1m, 5m" and "1m entry timing, 5m setup" are
 * different claims, and a user choosing between a scalp preset and a swing
 * preset needs to know which one they are getting before they press start.
 */
function describePlan(preset: string, seed: GoatMission | undefined): string {
  const workingSet = TIMEFRAME_PRESETS.find((option) => option.id === preset)?.timeframes ?? [];
  const declared = workingSet.length > 0 ? workingSet : (seed?.timeframes ?? []);
  const plan = resolveTimeframePlan({
    declared,
    ...(seed?.timeframe ? { setup: seed.timeframe } : {}),
  });
  const source =
    workingSet.length > 0
      ? 'you chose these'
      : declared.length > 0
        ? 'this GOAT declared these'
        : 'nothing was declared, so the GOAT chooses';
  return `${plan.summary}. ${source[0].toUpperCase()}${source.slice(1)}. Available: ${SUPPORTED_TIMEFRAMES.join(', ')}.`;
}

export interface BacktestSurfaceProps {
  /** Markets the user can replay. The first is offered as the default. */
  markets: string[];
  /**
   * The GOAT being replayed.
   *
   * Present when the replay was started from a GOAT's own page, which is the
   * normal way in. Everything the GOAT is — its objective, its skills, its
   * market, the resolutions it works across — is inherited rather than asked
   * for again, because a user pressing "backtest this GOAT" is answering one
   * question about one GOAT and should not be handed a form.
   */
  seed?: GoatMission;
  /** Where history comes from. Injected so a demo or a test can supply its own. */
  loadBars?: (request: { market: string; start: number; end: number }) => Promise<Bar[]>;
  onExit: () => void;
  /**
   * Hand a prompt to the existing GOAT conversation.
   *
   * Optional so the surface still works where no assistant is mounted — a demo, or
   * a test that only cares about the replay. The "AI ANALYSE TRADE" action simply
   * does not appear without it, rather than appearing and failing.
   */
  onAskAI?: (prompt: string) => void;
}

/** `datetime-local` wants a local wall-clock string, not an epoch. */
function toLocalInput(instant: number): string {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The price unit for a market, when it has a recognisable one.
 *
 * Deliberately not a hardcoded "pips": a pip is a foreign-exchange unit, and
 * calling a crypto move in pips would be reporting the wrong quantity rather than
 * the right one badly. Markets this does not recognise report in the account's own
 * currency instead.
 */
function unitFor(symbol: string | undefined): string | undefined {
  if (!symbol) return undefined;
  return /(USD\/JPY|EUR\/USD|GBP\/USD|AUD\/USD|USD\/CHF|USD\/CAD|NZD\/USD)/i.test(symbol)
    ? 'pips'
    : undefined;
}

export const BacktestSurface: React.FC<BacktestSurfaceProps> = ({
  markets,
  seed,
  loadBars,
  onExit,
  onAskAI,
}) => {
  const [market, setMarket] = useState(seed?.market ?? markets[0] ?? 'EUR/USD');
  const [goal, setGoal] = useState(seed?.goal ?? 'Watch this market and act when the evidence supports one.');
  const [name, setName] = useState(seed?.name ?? '');
  const [speed, setSpeed] = useState<SimulationSpeed>(10);
  const [preset, setPreset] = useState('declared');
  const [period, setPeriod] = useState<string>(DEFAULT_PRESET);
  const [customStart, setCustomStart] = useState(() => Date.now() - 7 * 86_400_000);
  const [customEnd, setCustomEnd] = useState(() => Date.now() - 60_000);
  const [history, setHistory] = useState<BacktestHistory | undefined>();
  const [pastRuns, setPastRuns] = useState<ReplaySummary[]>(() => replayHistory());
  const [focusMoment, setFocusMoment] = useState<string | undefined>();
  const [openReview, setOpenReview] = useState<string | undefined>();

  const selectedPreset: HistoricalPreset | undefined =
    HISTORICAL_PRESETS.find((option) => option.id === period);

  /*
   * The window, and the resolution it is fetched at, are one decision. A preset
   * answers both; a custom range answers the window and lets the same rule pick the
   * resolution from its length, so nobody ever ends up asking a browser to hold
   * six months of one-minute candles.
   */
  const resolvedWindow = useMemo(() => {
    if (selectedPreset) {
      return windowForPresetRequest(selectedPreset, {
        warmupMinutes: DEFAULT_BACKTEST_WARMUP_MINUTES,
      });
    }
    const start = customStart;
    const end = customEnd;
    const spanDays = Math.max(1, (end - start) / 86_400_000);
    const base = spanDays <= 30
      ? { baseTimeframe: '1m' as Timeframe, reason: 'Read at 1m — the finest resolution this venue serves.' }
      : { baseTimeframe: '5m' as Timeframe, reason: 'Read at 5m: this window is long enough that one-minute candles would be thousands of bars in a browser.' };
    return {
      start,
      end,
      baseTimeframe: base.baseTimeframe,
      baseReason: base.reason,
      warmupStart: start - DEFAULT_BACKTEST_WARMUP_MINUTES * 60_000,
    };
  }, [selectedPreset, customStart, customEnd]);

  /*
   * The session is not this component's. It is filed with the application-level
   * manager under a key derived from the GOAT, so leaving this screen detaches
   * the view without touching the run — which is the whole difference between a
   * replay you can navigate away from and one that either dies on you or keeps
   * ticking where nothing can reach it.
   */
  const key = useMemo(() => backtestKeyFor(seed?.goalId), [seed?.goalId]);
  const [session, setSession] = useState<BacktestSession | undefined>(() => backtestManager.get(key));
  const [snapshot, setSnapshot] = useState<BacktestSnapshot | undefined>(
    () => backtestManager.get(key)?.snapshot(),
  );
  const [story, setStory] = useState<BacktestStory | undefined>(() => backtestManager.get(key)?.story());
  const [entries, setEntries] = useState<AgentEventView[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /*
   * Re-attach to whatever is running for this GOAT, whenever the key changes.
   *
   * Mounting late is the case this exists for: returning to a replay already in
   * progress shows that run, not an empty screen.
   */
  useEffect(() => {
    setSession(backtestManager.get(key));
    return backtestManager.subscribe(key, (next) => {
      setSession(next);
      setSnapshot(next?.snapshot());
      setStory(next?.story());
    });
  }, [key]);

  /*
   * A refresh the surface owns. The session emits after every step, but a replay
   * that is holding for the model emits nothing while it waits — and a clock that
   * stops updating during exactly the moment the reader is watching is the one
   * place this surface must not be lazy.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!session) return;
      setSnapshot(session.snapshot());
      setStory(session.story());
      syncLog();
      setPastRuns(replayHistory());
    }, 500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /*
   * The log, read the same way the live workspace reads it and pushed the same way.
   *
   * Two paths, because a replay has a moment the live screen does not: it starts
   * before the GOAT exists, so there is nothing to subscribe to yet.
   */
  const syncLog = useCallback(() => {
    if (!session) return;
    setEntries((current) => {
      const next = session.agentLog();
      const lastCurrent = current[current.length - 1]?.id;
      const lastNext = next[next.length - 1]?.id;
      return current.length === next.length && lastCurrent === lastNext ? current : next;
    });
  }, [session]);

  useEffect(() => {
    if (!session) return;
    setSnapshot(session.snapshot());
    setStory(session.story());
    syncLog();

    const goalId = session.snapshot().goalId;
    const unsubscribeState = session.subscribe(() => {
      setSnapshot(session.snapshot());
      setStory(session.story());
      syncLog();
    });
    const unsubscribeActivity =
      goalId && session.goat
        ? session.goat.observeActivity(goalId, syncLog)
        : () => undefined;

    return () => {
      unsubscribeState();
      unsubscribeActivity();
    };
  }, [session, syncLog]);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setFocusMoment(undefined);
    setOpenReview(undefined);
    try {
      if (resolvedWindow.end <= resolvedWindow.start) {
        throw new Error('Choose a historical window that ends after it starts.');
      }
      const workingSet = TIMEFRAME_PRESETS.find((option) => option.id === preset)?.timeframes ?? [];
      const plan = resolveTimeframePlan({
        declared: workingSet.length > 0 ? workingSet : (seed?.timeframes ?? []),
        ...(seed?.timeframe ? { setup: seed.timeframe } : {}),
      });

      const next = createManagedBacktest(key, {
        goal,
        market,
        timeframe: plan.setup,
        timeframes: plan.reads.map((read) => read.timeframe),
        baseTimeframe: resolvedWindow.baseTimeframe,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(seed ? { skillIds: seed.skillIds } : {}),
        start: resolvedWindow.start,
        end: resolvedWindow.end,
        speed,
        warmupMinutes: DEFAULT_BACKTEST_WARMUP_MINUTES,
        loadBars:
          loadBars ??
          (async (request) => {
            const loaded = await historicalMarketDataProvider.getBars({
              marketId: request.market,
              timeframe: resolvedWindow.baseTimeframe,
              start: Math.floor(request.start / 1000),
              end: Math.floor(request.end / 1000),
            });
            return loaded.bars;
          }),
        costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
      });
      setSession(next);
      /*
       * Into the workspace immediately.
       *
       * The session writes its own progress as it loads and deploys, so the reader
       * watches a GOAT being put into a historical world rather than a spinner on
       * a separate page.
       */
      await next.start();
      await next.play();
      setSnapshot(next.snapshot());
      setStory(next.story());
      setHistory(next.history());
      setPastRuns(replayHistory());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // A replay that failed to load is taken out of the registry as well as
      // the screen: clearing the view alone would leave a session nobody can
      // start, pause or stop behind the manager.
      await backtestManager.dispose(key, 'Failed to start.');
      setSession(undefined);
    } finally {
      setBusy(false);
    }
  }, [busy, goal, key, loadBars, market, name, preset, resolvedWindow, seed, speed]);

  const mission = snapshot?.mission;
  const plan = useMemo(() => (mission ? buildPlanView(mission) : undefined), [mission]);
  const waitingForModel = Boolean(
    session?.goat?.pendingModelRequest(snapshot?.agentId ?? ''),
  );
  const running = snapshot?.state === 'RUNNING';
  const finished = snapshot?.state === 'COMPLETED' || snapshot?.state === 'STOPPED';
  const account = session?.account();
  const now = snapshot?.now ?? session?.simulatedClock.now() ?? Date.now();

  const review: DecisionReview | undefined = useMemo(
    () => (openReview ? session?.decisionReview(openReview) : undefined),
    [openReview, session, snapshot?.state, snapshot?.trades?.length],
  );

  return (
    <div className="space-y-3 sm:space-y-4" data-testid="backtest-surface">
      {/*
        The badge is not decoration and it is not dismissible. Every screen in a
        replay carries it, because the one unacceptable outcome is a reader
        believing they were watching live trading.
      */}
      <header className="rounded-2xl border border-accent/40 bg-accent-soft/20 px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft/40 px-2.5 py-1 font-mono text-[10px] tracking-[0.16em] text-accent-ink"
              data-testid="backtest-badge"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full bg-accent ${
                  running ? 'animate-goat-pulse-fast' : ''
                }`}
                aria-hidden="true"
              />
              BACKTEST
            </span>
            <span className="truncate font-mono text-[13px] text-ink">{session?.market ?? market}</span>
            {(seed?.name || name) && (
              <span className="hidden truncate text-[11px] text-ink-3 sm:inline" data-testid="backtest-goat-name">
                {seed?.name || name}
              </span>
            )}
          </div>

          {session && (
            <span className="font-mono text-[10px] tracking-[0.14em] text-ink-4" data-testid="backtest-window">
              {describeWindow(resolvedWindow.start, resolvedWindow.end)} · {session.simulation.resolution} HISTORY
            </span>
          )}
        </div>

        {/*
          The clock is the hero, because it is what makes this a time machine
          rather than a chart with a play button. Large, monospaced, and explicitly
          dated: "15:17:02" on its own is a clock, "OCT 04 · 15:17:02" is history.
        */}
        {session && (
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2" data-testid="backtest-clock">
            <div className="min-w-0">
              <p className="font-mono text-[10px] tracking-[0.2em] text-ink-4">REPLAY · SIMULATED TIME</p>
              <p className="mt-0.5 font-mono text-2xl leading-none tabular-nums text-ink sm:text-3xl">
                {formatSimulatedDate(now)}
                <span className="mx-2 text-ink-4">·</span>
                <span data-testid="backtest-time">{formatSimulatedTime(now)}</span>
              </p>
            </div>
            <div className="flex items-baseline gap-3 font-mono text-[11px] tabular-nums text-ink-3">
              <span className="text-ink-2" data-testid="backtest-speed-label">{session.simulatedClock.speedLabel}</span>
              {snapshot?.price !== undefined && <span>{snapshot.price}</span>}
              <span className="text-ink-4">
                {snapshot?.simulatedMinutes ?? 0}m · {Math.round((snapshot?.progress ?? 0) * 100)}%
              </span>
            </div>
          </div>
        )}

        {/*
          The state word. One line, in the words a reader uses, and the only thing
          on this screen that pulses while the replay runs.
        */}
        {story && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/60 pt-3">
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] ${
                story.state === 'TARGET HIT'
                  ? 'text-pos'
                  : story.state === 'STOP HIT' || story.state === 'THESIS INVALIDATED'
                    ? 'text-neg'
                    : 'text-accent-ink'
              }`}
              data-testid="backtest-goat-state"
            >
              {story.state === 'WOKEN' && <Zap className="h-3 w-3" aria-hidden="true" />}
              {story.state}
            </span>
            {snapshot?.tradePhase && (
              <span className="font-mono text-[10px] text-ink-4" data-testid="backtest-trade-phase">
                {snapshot.tradePhase}
              </span>
            )}
            {story.animated && running && (
              <span className="h-1.5 w-1.5 animate-goat-pulse-fast rounded-full bg-accent" aria-hidden="true" />
            )}
            {snapshot?.agentBusy && (
              <span className="font-mono text-[10px] text-ink-3" data-testid="backtest-agent-busy">
                Holding historical time while this GOAT decides — nothing it reasons about is from the future.
              </span>
            )}
          </div>
        )}

        {session && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
            {running ? (
              <BacktestControl
                onClick={() => {
                  session.pause();
                  setSnapshot(session.snapshot());
                }}
                icon={<Pause className="h-3 w-3" />}
                testId="backtest-pause"
              >
                PAUSE
              </BacktestControl>
            ) : (
              <BacktestControl
                onClick={() => {
                  void session.play().then(() => {
                    setSnapshot(session.snapshot());
                    setStory(session.story());
                  });
                }}
                icon={<Play className="h-3 w-3" />}
                testId="backtest-start"
                disabled={finished}
              >
                {snapshot?.state === 'READY' ? 'START' : 'RESUME'}
              </BacktestControl>
            )}
            <BacktestControl
              onClick={() => {
                void backtestManager
                  .stop(key, 'Stopped from the surface.')
                  .then(() => {
                    setSnapshot(session.snapshot());
                    setStory(session.story());
                    setPastRuns(replayHistory());
                  });
              }}
              icon={<Square className="h-3 w-3" />}
              testId="backtest-stop"
              disabled={snapshot?.state === 'STOPPED'}
            >
              STOP
            </BacktestControl>
            <BacktestControl
              onClick={() => {
                setFocusMoment(undefined);
                void session
                  .restart()
                  .then(() => session.play())
                  .then(() => {
                    setSnapshot(session.snapshot());
                    setStory(session.story());
                  });
              }}
              icon={<RotateCcw className="h-3 w-3" />}
              testId="backtest-restart"
            >
              RUN AGAIN
            </BacktestControl>

            <label className="ml-1 inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-4">
              SPEED
              <select
                value={session.simulatedClock.speed}
                onChange={(event) => {
                  session.setSpeed(Number(event.target.value) as SimulationSpeed);
                  setSnapshot(session.snapshot());
                }}
                data-testid="backtest-speed"
                className="rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[10px] text-ink-2 outline-none focus:border-accent/50"
              >
                {SIMULATION_SPEEDS.map((option) => (
                  <option key={option} value={option}>
                    {option}x
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => {
                if (running) session.pause();
                onExit();
              }}
              data-testid="backtest-exit"
              className="ml-auto font-mono text-[10px] text-ink-4 transition-colors hover:text-ink-2"
            >
              LEAVE
            </button>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-2xl border border-neg/40 bg-neg/[0.06] px-4 py-3">
          <p className="text-[11px] leading-relaxed text-neg">{error}</p>
        </div>
      )}

      {/*
        The setup strip. Shown only when there is nothing running — once a replay
        exists, the reader's next question is what the GOAT is doing, and the answer
        is the workspace below.
      */}
      {!session && (
        <section className="rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5">
          {/*
            When in history. Three taps for the periods people actually replay, and
            a custom range for the ones they do not. The window is shown as a
            sentence rather than as two timestamps, because that is what the reader
            is choosing.
          */}
          <div>
            <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">WHEN IN HISTORY</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {HISTORICAL_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPeriod(option.id)}
                  data-testid={`backtest-period-${option.id}`}
                  data-active={period === option.id}
                  className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-colors ${
                    period === option.id
                      ? 'border-accent/50 bg-accent-soft/40 text-accent-ink'
                      : 'border-line text-ink-3 hover:border-accent/40'
                  }`}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPeriod('custom')}
                data-testid="backtest-period-custom"
                data-active={period === 'custom'}
                className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-colors ${
                  period === 'custom'
                    ? 'border-accent/50 bg-accent-soft/40 text-accent-ink'
                    : 'border-line text-ink-3 hover:border-accent/40'
                }`}
              >
                CUSTOM
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-4" data-testid="backtest-window-note">
              {selectedPreset
                ? `${selectedPreset.hint} ${describeWindow(resolvedWindow.start, resolvedWindow.end)}. ${resolvedWindow.baseReason}`
                : `Custom range. ${resolvedWindow.baseReason}`}
            </p>
          </div>

          {period === 'custom' && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">FROM</span>
                <input
                  type="datetime-local"
                  value={toLocalInput(customStart)}
                  onChange={(event) => setCustomStart(fromLocalInput(event.target.value))}
                  data-testid="backtest-from"
                  className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
                />
              </label>
              <label className="block">
                <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">TO</span>
                <input
                  type="datetime-local"
                  value={toLocalInput(customEnd)}
                  onChange={(event) => setCustomEnd(fromLocalInput(event.target.value))}
                  data-testid="backtest-to"
                  className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
                />
              </label>
            </div>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">MARKET</span>
              <select
                value={market}
                onChange={(event) => setMarket(event.target.value)}
                data-testid="backtest-market"
                className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent/50"
              >
                {markets.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">TIMEFRAMES</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {TIMEFRAME_PRESETS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setPreset(option.id)}
                    data-testid={`backtest-preset-${option.id}`}
                    data-active={preset === option.id}
                    className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                      preset === option.id
                        ? 'border-accent/50 bg-accent-soft/40 text-accent-ink'
                        : 'border-line text-ink-3 hover:border-accent/40'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4" data-testid="backtest-timeframe-plan">
                {describePlan(preset, seed)}
              </p>
            </div>
          </div>

          <label className="mt-3 block">
            <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">
              OBJECTIVE {seed ? '· INHERITED FROM THIS GOAT' : ''}
            </span>
            <input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              data-testid="backtest-goal"
              className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink outline-none focus:border-accent/50"
            />
          </label>

          {seed && (
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-4" data-testid="backtest-inherited">
              Replaying <span className="text-ink-2">{seed.name || 'this GOAT'}</span>
              {seed.skillIds.length > 0 ? ` · ${seed.skillIds.length} skills` : ''}. Its objective, skills
              and market are the GOAT&apos;s own; you choose when in history to send it, and how fast to watch.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-3">
            <p className="max-w-sm text-[10.5px] leading-relaxed text-ink-4">
              The GOAT gets its own historical world, reads closed candles only, and never sees a candle
              that has not finished. Everything it does here is simulated.
            </p>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy}
              data-testid="backtest-run"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-4 py-2 text-[11px] font-bold text-accent-contrast transition-colors disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
              SEND INTO HISTORY
            </button>
          </div>
        </section>
      )}

      {session && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start lg:gap-4">
          {/*
            Mobile order is the argument: what the GOAT is doing, what it decided,
            then the detail. Everything a reader needs in one screen, with no
            horizontal scrolling — the moments list is the only thing that scrolls
            on its own, and it scrolls vertically.
          */}
          <div className="order-1 space-y-3 lg:order-none lg:sticky lg:top-4">
            {account && (
              <section className="rounded-2xl border border-line bg-surface px-4 py-3">
                <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">SIMULATED ACCOUNT</p>
                <dl className="mt-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                  <Metric label="EQUITY" value={account.equity.toFixed(2)} />
                  <Metric label="OPEN" value={String(account.openPositions)} />
                  <Metric label="DRAWDOWN" value={`${account.drawdownPercent.toFixed(2)}%`} />
                </dl>
              </section>
            )}

            {plan && <TradePlanPanel plan={plan} formingNote={mission?.activity.headline} />}

            {history?.note && (
              <p
                className="rounded-2xl border border-warn/40 bg-warn/[0.06] px-4 py-3 text-[11px] leading-relaxed text-warn"
                data-testid="backtest-history-note"
              >
                {history.note}
              </p>
            )}

            {snapshot?.message && (
              <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[11px] leading-relaxed text-ink-3">
                {snapshot.message}
              </p>
            )}

            {story && story.moments.length > 0 && (
              <KeyMoments
                moments={story.moments.slice(-14)}
                onFocus={(moment) => setFocusMoment(moment.eventId)}
                focusId={focusMoment}
              />
            )}

            {snapshot?.report && (
              <ResultsPanel
                snapshot={snapshot}
                story={story}
                onRerun={() => {
                  setFocusMoment(undefined);
                  void session.restart().then(() => session.play()).then(() => {
                    setSnapshot(session.snapshot());
                    setStory(session.story());
                  });
                }}
              />
            )}

            {pastRuns.length > 1 && <ReplayHistory runs={pastRuns} />}
          </div>

          <div className="order-2 min-w-0 lg:order-none">
            <TradeLog
              trades={snapshot?.trades ?? []}
              statistics={snapshot?.tradeStats}
              unitLabel={unitFor(snapshot?.symbol)}
              onAnalyseTrade={(trade) => onAskAI?.(tradeAnalysisPrompt(trade).prompt)}
              className="mb-3"
            />

            {/*
              The decision, replayed.

              What the GOAT knew, what it decided, what the risk layer said, and what
              the simulation did about it — all of it read from the record that was
              written at the time. This is the most educational thing a backtest can
              show, and it is worth a row of its own rather than a footnote.
            */}
            {(snapshot?.trades?.length ?? 0) > 0 && (
              <section className="mb-3 rounded-2xl border border-line bg-surface px-4 py-3">
                <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">REPLAY A DECISION</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(snapshot?.trades ?? []).map((trade) => (
                    <button
                      key={trade.id}
                      type="button"
                      onClick={() => setOpenReview(openReview === trade.planId ? undefined : trade.planId)}
                      data-testid={`backtest-review-${trade.planId}`}
                      data-active={openReview === trade.planId}
                      className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                        openReview === trade.planId
                          ? 'border-accent/50 bg-accent-soft/40 text-accent-ink'
                          : 'border-line text-ink-3 hover:border-accent/40'
                      }`}
                    >
                      {trade.side} {trade.proposedEntry}
                    </button>
                  ))}
                </div>
                {review && <DecisionReviewPanel review={review} />}
              </section>
            )}

            <AgentLog
              entries={entries}
              live={running}
              liveLabel="REPLAY"
              watching={(mission?.activeTrackerCount ?? 0) > 0}
              waitingForModel={waitingForModel}
              now={Date.now()}
              {...(focusMoment ? { focusEntryId: focusMoment } : {})}
              className="h-[24rem] lg:h-[calc(100dvh-19rem)] lg:min-h-[30rem]"
            />
          </div>
        </div>
      )}
    </div>
  );
};

/** `RISK/TRADE` is the agent's own policy, and there is no second place to read it. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">{label}</dt>
      <dd className="font-mono text-[12px] tabular-nums text-ink">{value}</dd>
    </div>
  );
}

interface BacktestControlProps {
  onClick: () => void;
  children: React.ReactNode;
  icon: React.ReactNode;
  disabled?: boolean;
  testId: string;
}

const BacktestControl: React.FC<BacktestControlProps> = ({
  onClick, children, icon, disabled, testId,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-testid={testId}
    className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] text-ink-3 transition-colors hover:border-accent/40 hover:text-ink-2 disabled:opacity-40"
  >
    {icon}
    {children}
  </button>
);

/**
 * The moments worth stopping for.
 *
 * Derived from the same events the log renders, so it can never claim something the
 * log does not contain — and each row points at its line, because a list of moments
 * a reader cannot follow is a summary rather than a way in. Tapping one highlights
 * it in the log below.
 */
const KeyMoments: React.FC<{
  moments: KeyMoment[];
  onFocus: (moment: KeyMoment) => void;
  focusId?: string;
}> = ({ moments, onFocus, focusId }) => (
  <section className="rounded-2xl border border-line bg-surface px-4 py-3" data-testid="backtest-moments">
    <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">KEY MOMENTS</p>
    <ol className="mt-1.5 space-y-1">
      {moments.map((moment, index) => (
        <li key={`${moment.at}-${index}`}>
          <button
            type="button"
            onClick={() => onFocus(moment)}
            disabled={!moment.eventId}
            data-focused={focusId === moment.eventId ? 'true' : undefined}
            className={`flex w-full items-baseline gap-2 rounded-lg px-1.5 py-1 text-left transition-colors ${
              moment.eventId ? 'hover:bg-surface-2/60' : ''
            } ${focusId === moment.eventId ? 'bg-accent-soft/25' : ''}`}
          >
            <time className="shrink-0 font-mono text-[10px] tabular-nums text-ink-4">{momentTime(moment.at)}</time>
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[11px] ${
                  moment.kind === 'NEAR_MISS'
                    ? 'text-warn'
                    : moment.kind === 'TARGET'
                      ? 'text-pos'
                      : moment.kind === 'STOP' || moment.kind === 'INVALIDATION'
                        ? 'text-neg'
                        : 'text-ink-2'
                }`}
              >
                {moment.headline}
              </span>
              {moment.detail && (
                <span className="block truncate font-mono text-[9.5px] text-ink-4">{moment.detail}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  </section>
);

/** One trade, at the moment it was decided. Recorded inputs only. */
const DecisionReviewPanel: React.FC<{ review: DecisionReview }> = ({ review }) => (
  <div className="mt-2.5 space-y-2.5 border-t border-line/60 pt-2.5" data-testid="backtest-decision-review">
    <section>
      <p className="font-mono text-[9px] tracking-[0.16em] text-ink-4">WHAT THE GOAT KNEW</p>
      <ul className="mt-1 space-y-0.5 text-[10.5px] leading-relaxed text-ink-3">
        {review.knew.thesis && <li>Thesis: {review.knew.thesis}</li>}
        {review.knew.invalidation && <li>Invalidated by: {review.knew.invalidation}</li>}
        {review.knew.resolutions && review.knew.resolutions.length > 0 && (
          <li>Read: {review.knew.resolutions.join(' · ')}</li>
        )}
        <li>
          Account: {review.knew.account.equity !== undefined ? `${review.knew.account.equity.toFixed(2)} equity` : 'unknown'}
          {review.knew.account.openPositions > 0 ? ` · ${review.knew.account.openPositions} open` : ' · nothing open'}
        </li>
      </ul>
    </section>
    <section>
      <p className="font-mono text-[9px] tracking-[0.16em] text-ink-4">DECISION</p>
      <p className="mt-0.5 font-mono text-[12px] text-ink">
        {review.decision.side}
        {review.decision.entry !== undefined ? ` ${review.decision.entry}` : ''}
      </p>
      <ul className="mt-0.5 space-y-0.5 text-[10.5px] leading-relaxed text-ink-3">
        {review.decision.stopLoss !== undefined && <li>Stop {review.decision.stopLoss}</li>}
        {review.decision.takeProfit !== undefined && <li>Target {review.decision.takeProfit}</li>}
        {review.decision.reason && <li>{review.decision.reason}</li>}
      </ul>
    </section>
    {review.risk.verdict && (
      <section>
        <p className="font-mono text-[9px] tracking-[0.16em] text-ink-4">RISK</p>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">
          {review.risk.verdict}
          {review.risk.reason ? ` — ${review.risk.reason}` : ''}
        </p>
      </section>
    )}
    {review.outcome.pnl !== undefined && (
      <section>
        <p className="font-mono text-[9px] tracking-[0.16em] text-ink-4">WHAT HAPPENED</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink">
          {review.outcome.pnl >= 0 ? '+' : ''}
          {review.outcome.pnl.toFixed(2)} simulated
        </p>
      </section>
    )}
  </div>
);

/**
 * The results, and what they say.
 *
 * The money first, because it is what a reader came for. Then the behaviour, which
 * is the part no P&L number can reconstruct, and then a verdict written entirely
 * from counted events. Nothing here is estimated: every figure is counted from the
 * log the runtime wrote and the book the simulation held.
 */
const ResultsPanel: React.FC<{
  snapshot: BacktestSnapshot;
  story?: BacktestStory;
  onRerun: () => void;
}> = ({ snapshot, story, onRerun }) => {
  const report = snapshot.report;
  if (!report) return null;
  const netR = report.performance.netR;
  return (
    <section
      className="rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5"
      aria-label="Backtest results"
      data-testid="backtest-results"
    >
      <h2 className="font-mono text-[10px] tracking-[0.18em] text-ink-3">
        YOUR GOAT FINISHED · {report.outcome === 'COMPLETED' ? 'REPLAY COMPLETE' : 'STOPPED'}
      </h2>

      <p className="mt-1 font-mono text-2xl tabular-nums text-ink">
        {netR === undefined ? report.performance.netPnl.toFixed(2) : `${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R`}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Metric label="TRADES" value={String(report.performance.trades)} />
        <Metric
          label="WINS / LOSSES"
          value={`${report.performance.wins} / ${report.performance.losses}`}
        />
        <Metric
          label="NET"
          value={`${report.performance.netPnl >= 0 ? '+' : ''}${report.performance.netPnl.toFixed(2)}`}
        />
        <Metric label="MAX DRAWDOWN" value={`${report.performance.maxDrawdownPercent.toFixed(1)}%`} />
        <Metric label="THESES" value={`${report.behaviour.hypothesesFormed} formed`} />
        <Metric label="WATCHES" value={`${report.behaviour.trackersFired}/${report.behaviour.trackersCreated} fired`} />
        <Metric label="MODEL CALLS" value={String(report.behaviour.modelCalls)} />
        <Metric label="SIMULATED" value={`${report.behaviour.simulatedMinutes}m`} />
      </dl>

      {/*
        The score is shown with its working out. A number on a screen labelled
        "how your GOAT behaves" that cannot be checked is a vibe with a decimal
        point, so every dimension carries the counting that produced it, and a
        dimension the log cannot support is shown as a dash rather than invented.
      */}
      {story && (
        <div className="mt-4 border-t border-line/60 pt-3">
          <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">
            BEHAVIOUR{story.score.overall !== undefined ? ` · ${story.score.overall}/100` : ''}
          </p>
          <dl className="mt-1.5 space-y-1">
            {story.score.lines.map((line) => (
              <div key={line.dimension}>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">{line.dimension}</dt>
                  <dd className="font-mono text-[11px] tabular-nums text-ink-2">
                    {line.score === undefined ? '—' : line.score}
                  </dd>
                </div>
                <p className="text-[9.5px] leading-relaxed text-ink-4">{line.basis}</p>
              </div>
            ))}
          </dl>
        </div>
      )}

      {story?.verdict && (
        <div className="mt-4 border-t border-line/60 pt-3" data-testid="backtest-verdict">
          <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">THE VERDICT</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{story.verdict.summary}</p>
          <ul className="mt-1.5 space-y-0.5 text-[10.5px] leading-relaxed text-ink-4">
            {story.verdict.observations.map((observation) => (
              <li key={observation}>{observation}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-ink-4">
        Historical performance does not predict future performance. Everything above is a replay of a
        market that already happened, on a simulated book, and none of it was sent anywhere.
      </p>

      {/*
        Rerunning is the point of the feature. One button for the same window, and
        the period buttons above for the other question — "what about last month?"
      */}
      <button
        type="button"
        onClick={onRerun}
        data-testid="backtest-rerun"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-[11px] font-bold text-accent-contrast"
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
        RUN SAME GOAT, SAME WINDOW
      </button>
    </section>
  );
};

/**
 * Recent runs, kept lightweight.
 *
 * Four lines, in the order a reader compares them: what was replayed, over what
 * window, and what it came to. This is the difference between a backtester and a
 * laboratory — the previous run is the reason to run the next one — so it is
 * deliberately not a dashboard.
 */
const ReplayHistory: React.FC<{ runs: ReplaySummary[] }> = ({ runs }) => (
  <section className="rounded-2xl border border-line bg-surface px-4 py-3" data-testid="backtest-replay-history">
    <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">RECENT REPLAYS</p>
    <ul className="mt-1.5 space-y-1">
      {runs.slice(0, 4).map((run) => (
        <li key={`${run.market}-${run.start}-${run.goal}`} className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[10.5px] text-ink-3">
            {run.market} · {describeWindow(run.start, run.end)}
          </span>
          <span
            className={`shrink-0 font-mono text-[11px] tabular-nums ${
              (run.performance.netR ?? 0) >= 0 ? 'text-pos' : 'text-neg'
            }`}
          >
            {run.performance.netR === undefined
              ? run.performance.netPnl.toFixed(2)
              : `${run.performance.netR >= 0 ? '+' : ''}${run.performance.netR.toFixed(1)}R`}
            <span className="ml-1 text-ink-4">{run.performance.trades}t</span>
          </span>
        </li>
      ))}
    </ul>
  </section>
);
