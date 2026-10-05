/**
 * The backtest surface.
 *
 * A GOAT running inside a historical world, in the same room as a live one.
 *
 * The design decision that matters here is that this is not a setup wizard with
 * a results page at the end. Pressing START puts the user straight into the
 * agentic workspace — the same Trade Plan and the same Agent Log the live
 * surfaces render — and everything that happens afterwards is the GOAT's. The
 * only things that are different are the ones that would otherwise be
 * indistinguishable from live trading: a persistent BACKTEST badge, the
 * historical clock, and the word "simulated" on every execution line.
 *
 * What is deliberately absent: a candle chart, a strategy form, an equity curve,
 * a scrubber, a playback console. None of them are what the question is about.
 * The question is "what would my GOAT have done", and the answer is in the log.
 *
 * The results panel exists, but it is deliberately small and it is the *last*
 * thing on the screen, because a backtest that replaces the agent experience
 * with a dashboard has thrown away the only reason to watch one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';

import type { Bar } from '../../types/trading';
import {
  backtestKeyFor,
  backtestManager,
  createManagedBacktest,
} from '../../engine/goat/backtest/manager';
import {
  BacktestSession,
  SIMULATION_SPEEDS,
  formatSimulatedDate,
  formatSimulatedTime,
  type BacktestHistory,
  type BacktestSnapshot,
  type SimulationSpeed,
} from '../../engine/goat/backtest';
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

/** How much history a replay covers by default: six hours of 1m bars. */
const DEFAULT_WINDOW_HOURS = 6;

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

/** How long the replay covers by default when started from a GOAT: two days. */
const DEFAULT_SEED_WINDOW_HOURS = 48;

/** Resolution presets offered as one click, rather than a picker to configure. */
const TIMEFRAME_PRESETS: Array<{ id: string; label: string; timeframes: Timeframe[] }> = [
  { id: 'declared', label: 'THE GOAT OWN', timeframes: [] },
  { id: 'scalp', label: 'SCALP 1m·5m', timeframes: ['1m', '5m'] },
  { id: 'intraday', label: '5m·15m·1h', timeframes: ['5m', '15m', '1h'] },
  { id: 'swing', label: '15m·1h·4h', timeframes: ['15m', '1h', '4h'] },
  { id: 'position', label: '4h·1d', timeframes: ['4h', '1d'] },
];

/**
 * A window that has already happened, rounded to whole minutes.
 *
 * Rounded because the venue's candles are stamped on minute boundaries and a
 * window that starts at 10:43:27 asks for a quarter of a candle that does not
 * exist. The end is pulled back a minute for the same reason: the most recent
 * minute is still forming, and a replay that began inside it would be
 * replaying an unfinished candle.
 */
function defaultWindow(now = Date.now(), hours = DEFAULT_WINDOW_HOURS): { start: number; end: number } {
  const minute = 60_000;
  const end = Math.floor(now / minute) * minute - minute;
  return { start: end - hours * 60 * minute, end };
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
  /*
   * Defaults from the GOAT, not from the form.
   *
   * A replay started from a GOAT's page inherits that GOAT's market, objective,
   * name and working resolutions, and offers only the three things that genuinely
   * cannot be inherited: the historical window, the speed, and — when the user
   * wants to override it — the resolutions. Everything else about it is the GOAT.
   */
  const seedTimeframes = seed?.timeframes ?? [];
  const initial = useMemo(() => {
    if (!seed) return defaultWindow();
    // A longer default for a GOAT that trades on a coarser resolution: replaying
    // six hours of 4h bars is three candles.
    const hours = seedTimeframes.some((timeframe) => ['1h', '4h', '1d'].includes(timeframe))
      ? DEFAULT_WINDOW_HOURS * 24
      : DEFAULT_WINDOW_HOURS;
    return defaultWindow(Date.now(), hours);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.goalId]);

  const [market, setMarket] = useState(seed?.market ?? markets[0] ?? 'EUR/USD');
  const [goal, setGoal] = useState(seed?.goal ?? 'Watch this market and act when the evidence supports one.');
  const [name, setName] = useState(seed?.name ?? '');
  const [from, setFrom] = useState(toLocalInput(initial.start));
  const [to, setTo] = useState(toLocalInput(initial.end));
  const [speed, setSpeed] = useState<SimulationSpeed>(10);
  const [preset, setPreset] = useState('declared');
  const [history, setHistory] = useState<BacktestHistory | undefined>();

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
  const [entries, setEntries] = useState<AgentEventView[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /*
   * Re-attach to whatever is running for this GOAT, whenever the key changes.
   *
   * Mounting late is the case this exists for: returning to a replay already in
   * progress shows that run, not an empty screen. The subscription reports the
   * current session immediately, so a run that finished while nobody was looking
   * is still there to read.
   */
  useEffect(() => {
    setSession(backtestManager.get(key));
    return backtestManager.subscribe(key, (next) => {
      setSession(next);
      setSnapshot(next?.snapshot());
    });
  }, [key]);

  /*
   * The clock ticks a few times a second, and only so the simulated time stays
   * legible while the replay runs. It is not a data poll: the session owns the
   * replay, and this interval only re-reads what the session already knows.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!session) return;
      setSnapshot(session.snapshot());
      syncLog();
    }, 500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /*
   * The log, read the same way the live workspace reads it and pushed the same
   * way.
   *
   * Two paths, because a replay has a moment the live screen does not: it starts
   * before the GOAT exists, so there is nothing to subscribe to yet. The state
   * subscription covers the run, and the activity subscription covers the
   * reasoning as soon as a goal is there — after which every event the runtime
   * writes appears as it is written, which is what makes this feel like
   * watching a GOAT rather than reading about one.
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
    syncLog();

    const goalId = session.snapshot().goalId;
    const unsubscribeState = session.subscribe(() => {
      setSnapshot(session.snapshot());
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
    try {
      const startAt = fromLocalInput(from);
      const endAt = fromLocalInput(to);
      if (!startAt || !endAt || endAt <= startAt) {
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
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(seed ? { skillIds: seed.skillIds } : {}),
        start: startAt,
        end: endAt,
        speed,
        loadBars:
          loadBars ??
          (async (request) => (await historicalMarketDataProvider.getBars({
            marketId: request.market,
            timeframe: '1m',
            start: Math.floor(request.start / 1000),
            end: Math.floor(request.end / 1000),
          })).bars),
        costModel: { initialBalance: 10_000, spreadPrice: 0.001, pipSize: 0.01 },
      });
      setSession(next);
      setHistory(next.history());
      /*
       * Into the workspace immediately, and only then start.
       *
       * The session writes its own progress as it loads and deploys, so the user
       * watches the same progressive story a live deployment tells instead of a
       * spinner on a separate page.
       */
      await next.start();
      await next.play();
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
  }, [busy, from, goal, key, loadBars, market, name, preset, seed, speed, to]);

  const mission = snapshot?.mission;
  const plan = useMemo(() => (mission ? buildPlanView(mission) : undefined), [mission]);
  const waitingForModel = Boolean(
    session?.goat?.pendingModelRequest(snapshot?.agentId ?? ''),
  );
  const running = snapshot?.state === 'RUNNING';

  return (
    <div className="space-y-4" data-testid="backtest-surface">
      {/*
        The badge is not decoration and it is not dismissible. Every screen in a
        replay carries it, because the one unacceptable outcome is a user
        believing they were watching live trading.
      */}
      <header className="rounded-2xl border border-accent/40 bg-accent-soft/20 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft/40 px-2.5 py-1 font-mono text-[10px] tracking-[0.16em] text-accent-ink"
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
            <span className="font-mono text-[13px] text-ink">{session?.market ?? market}</span>
            {(seed?.name || name) && (
              <span className="truncate text-[11px] text-ink-3" data-testid="backtest-goat-name">
                {seed?.name || name}
              </span>
            )}
          </div>

          {session && (
            <div
              className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-ink-2"
              data-testid="backtest-clock"
            >
              <span>{formatSimulatedDate(snapshot?.now ?? session.simulatedClock.now())}</span>
              <span data-testid="backtest-time">
                {formatSimulatedTime(snapshot?.now ?? session.simulatedClock.now())}
              </span>
              <span className="text-ink-4">{session.simulatedClock.speedLabel}</span>
              <span
                className="hidden text-ink-4 sm:inline"
                data-testid="backtest-resolutions"
              >
                {session.timeframes.summary}
              </span>
            </div>
          )}
        </div>

        <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
          Historical simulation. Every price, fill and result below is replayed data — nothing here
          reaches a venue, and no order is ever sent.
        </p>

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
                  void session.play().then(() => setSnapshot(session.snapshot()));
                }}
                icon={<Play className="h-3 w-3" />}
                testId="backtest-start"
                disabled={snapshot?.state === 'COMPLETED' || snapshot?.state === 'STOPPED'}
              >
                {snapshot?.state === 'READY' ? 'START' : 'RESUME'}
              </BacktestControl>
            )}
            <BacktestControl
              onClick={() => {
                  void backtestManager.stop(key, 'Stopped from the surface.').then(() => setSnapshot(session.snapshot()));
                }}
              icon={<Square className="h-3 w-3" />}
              testId="backtest-stop"
              disabled={snapshot?.state === 'STOPPED'}
            >
              STOP
            </BacktestControl>
            <BacktestControl
              onClick={() => {
                void session.restart().then(() => session.play()).then(() => setSnapshot(session.snapshot()));
              }}
              icon={<RotateCcw className="h-3 w-3" />}
              testId="backtest-restart"
            >
              RESTART
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

            <span className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[10px] text-ink-4">
                {snapshot?.simulatedMinutes ?? 0} simulated minutes ·{' '}
                {Math.round((snapshot?.progress ?? 0) * 100)}% replayed
              </span>
              {/*
                Leaving a running replay stops it first. Navigating away from a
                live timer would be a leak; navigating away from a simulation
                would be worse, because the next one would start a second clock
                and the user would have two historical worlds open at once.
              */}
              <button
                type="button"
                onClick={() => {
                  if (running) session.pause();
                  onExit();
                }}
                data-testid="backtest-exit"
                className="font-mono text-[10px] text-ink-4 transition-colors hover:text-ink-2"
              >
                LEAVE
              </button>
            </span>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-2xl border border-neg/40 bg-neg/[0.06] px-4 py-3">
          <p className="text-[11px] leading-relaxed text-neg">{error}</p>
        </div>
      )}

      {/*
        The configuration is a strip, not a page.
      */}
      {!session && (
        <section className="rounded-2xl border border-line bg-surface px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
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

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">FROM</span>
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  data-testid="backtest-from"
                  className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
                />
              </label>
              <label className="block">
                <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">TO</span>
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  data-testid="backtest-to"
                  className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
                />
              </label>
            </div>
          </div>

          {/*
            Timeframes, as presets rather than a picker.

            The question a user has is "replay this GOAT the way it is" or
            "replay it the way a scalper would", and a list of seven checkboxes
            answers neither. The presets are the common sets; the GOAT's own
            working set is the first of them and the default, because overriding
            it should be a deliberate act.
          */}
          <div className="mt-3">
            <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">TIMEFRAMES</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {TIMEFRAME_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPreset(option.id)}
                  data-testid={`backtest-preset-${option.id}`}
                  data-active={preset === option.id}
                  className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-colors ${
                    preset === option.id
                      ? 'border-accent/50 bg-accent-soft/40 text-accent-ink'
                      : 'border-line text-ink-3 hover:border-accent/40'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-4" data-testid="backtest-timeframe-plan">
              {describePlan(preset, seed)}
            </p>
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
              {seed.skillIds.length > 0 ? ` · ${seed.skillIds.length} skills` : ''}
              {seed.environment ? ` · ${seed.environment}` : ''}. Its objective, skills and market
              are the GOAT&apos;s own; only the historical window and the speed are yours.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-3">
            <p className="text-[10.5px] leading-relaxed text-ink-4">
              The GOAT gets its own world, reads one minute at a time, and never sees a candle that
              has not closed. Every tick it arms is evaluated here; every wake it takes happens in
              simulated time.
            </p>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy}
              data-testid="backtest-run"
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-4 py-2 text-[11px] font-bold text-accent-contrast transition-colors disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
              START BACKTEST
            </button>
          </div>
        </section>
      )}

      {/*
        The workspace, unchanged from the live one: the plan on the left, the
        log on the right. The only difference is what the log's timestamps say,
        and that is the point of the feature.
      */}
      {session && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
          <div className="space-y-4 lg:sticky lg:top-4">
            {plan && (
              <TradePlanPanel
                plan={plan}
                formingNote={mission?.activity.headline}
              />
            )}

            {/*
              The clock is holding for the GOAT.

              The replay deliberately does not advance the market while a request
              is outstanding — an agent reasoning about 10:43 must not be handed
              10:44 — so the clock pausing is the mechanism, not a fault. Saying so
              is the difference between a replay that looks stuck and one that
              looks like it is waiting for its agent.
            */}
            {snapshot?.agentBusy && (
              <p
                className="rounded-2xl border border-accent/30 bg-accent-soft/20 px-4 py-3 text-[11px] leading-relaxed text-accent-ink"
                data-testid="backtest-agent-busy"
              >
                The replay is holding while this GOAT decides. Historical time does not move during
                a decision, so nothing it reasons about can be from the future.
              </p>
            )}

            {/*
              What the source could give, against what was asked for.
              Rendered whenever the two differ, which is the only time it is
              interesting: a replay that quietly used a different period than the
              one requested would otherwise be reporting results about a window
              nobody chose.
            */}
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
            {snapshot?.report && <ResultsPanel snapshot={snapshot} />}
          </div>

          {/*
            Where the replay is in the trade loop.

            Shown above the log because it is the question a reader has first —
            "is it researching, waiting on a price, or holding a position" — and
            answering it with the generic replay state said only that the clock was
            running. A replay that is waiting for a limit order to fill is not the
            same as one that has nothing to do, and they now read differently.
          */}
          {snapshot?.tradePhase && (
            <div className="flex items-baseline justify-between gap-3 px-1 pt-1">
              <span
                className="font-mono text-[10px] tracking-[0.18em] text-ink-3"
                data-testid="backtest-trade-phase"
              >
                {snapshot.tradePhase}
              </span>
              {(snapshot.trades?.length ?? 0) > 0 && (
                <span className="font-mono text-[10px] text-ink-4">
                  {snapshot.trades!.filter((trade) => trade.status === 'PENDING').length} waiting ·{' '}
                  {snapshot.trades!.filter((trade) => trade.status === 'RUNNING').length} open
                </span>
              )}
            </div>
          )}

          {/*
            The trades, above the activity log.

            Two views of the same replay because they answer different questions:
            the trade list is "what did it make and why", the activity log is "what
            has it been doing". A reader following a position wants the first; a
            reader wondering why nothing is happening wants the second.
          */}
          <TradeLog
            trades={snapshot?.trades ?? []}
            statistics={snapshot?.tradeStats}
            unitLabel={unitFor(snapshot?.symbol)}
            /*
             * Reuses the existing GOAT conversation rather than opening a second
             * chat: the assistant already has the market and the wallet in view, and
             * a trade-review-only panel would have neither. The prompt carries the
             * trade's own numbers, so the answer is about this trade rather than
             * about trading in general.
             */
            onAnalyseTrade={(trade) => onAskAI?.(tradeAnalysisPrompt(trade).prompt)}
            className="mb-3"
          />

          <AgentLog
            entries={entries}
            live={running}
            /*
             * Events arrive just as fast in a replay, and this word is a claim
             * rather than a mood. Saying LIVE over a January clock would be the
             * one piece of copy in the product capable of making someone think
             * money was involved.
             */
            liveLabel="REPLAY"
            watching={(mission?.activeTrackerCount ?? 0) > 0}
            waitingForModel={waitingForModel}
            now={Date.now()}
            className="h-[26rem] lg:h-[calc(100dvh-19rem)] lg:min-h-[30rem]"
          />
        </div>
      )}

    </div>
  );
};

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
 * The results, small and last.
 *
 * Two columns: what it earned, and what it did. The second is the one that
 * cannot be reconstructed from a P&L number — how many hypotheses it formed, how
 * often the risk layer stopped it, how long it spent waiting — and it is why a
 * backtest here is worth watching rather than only worth running.
 */
const ResultsPanel: React.FC<{ snapshot: BacktestSnapshot }> = ({ snapshot }) => {
  const report = snapshot.report;
  if (!report) return null;
  const netR = report.performance.netR;
  return (
    <section
      className="rounded-2xl border border-line bg-surface px-5 py-4"
      aria-label="Backtest results"
      data-testid="backtest-results"
    >
      <h2 className="font-mono text-[10px] tracking-[0.18em] text-ink-3">
        BACKTEST {report.outcome === 'COMPLETED' ? 'COMPLETE' : 'STOPPED'}
      </h2>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Metric label="TRADES" value={String(report.performance.trades)} />
        <Metric
          label="WINS / LOSSES"
          value={`${report.performance.wins} / ${report.performance.losses}`}
        />
        <Metric
          label="NET"
          value={`${report.performance.netPnl >= 0 ? '+' : ''}${report.performance.netPnl.toFixed(2)}`}
          tone={report.performance.netPnl >= 0 ? 'positive' : 'negative'}
        />
        <Metric
          label="NET R"
          value={netR === undefined ? '—' : `${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R`}
          tone={netR === undefined ? 'neutral' : netR >= 0 ? 'positive' : 'negative'}
        />
        <Metric label="MAX DRAWDOWN" value={report.performance.maxDrawdown.toFixed(2)} />
        <Metric label="SIMULATED MINUTES" value={String(report.behaviour.simulatedMinutes)} />
      </dl>

      {/*
        Behaviour, not a second P&L table. Every figure is counted from the log
        the runtime wrote, so this panel cannot claim the agent did something it
        did not do.
      */}
      <div className="mt-4 border-t border-line/60 pt-3">
        <p className="font-mono text-[9px] tracking-[0.18em] text-ink-4">HOW IT BEHAVED</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Metric label="HYPOTHESES" value={String(report.behaviour.hypothesesFormed)} />
          <Metric label="REVISED" value={String(report.behaviour.hypothesesRevised)} />
          <Metric label="INVALIDATED" value={String(report.behaviour.hypothesesInvalidated)} />
          <Metric label="WATCHES FIRED" value={`${report.behaviour.trackersFired}/${report.behaviour.trackersCreated}`} />
          <Metric label="PLANS WRITTEN" value={String(report.behaviour.plansCreated)} />
          <Metric label="BLOCKED BY RISK" value={String(report.behaviour.plansRejectedByRisk)} />
          <Metric label="WAKES" value={String(report.behaviour.wakes)} />
          <Metric label="TIMES WAITING" value={String(report.behaviour.waits)} />
          <Metric label="MODEL CALLS" value={String(report.behaviour.modelCalls)} />
          <Metric label="MODEL LATENCY" value={`${(report.behaviour.modelLatencyMs / 1000).toFixed(1)}s`} />
        </dl>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-ink-4">
        Every figure above is counted from the agent log on the right. To understand why a trade
        happened — or why it did not — read the log; that is the record of what the GOAT actually
        did.
      </p>
    </section>
  );
};

const Metric: React.FC<{
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative';
}> = ({ label, value, tone = 'neutral' }) => (
  <div className="flex items-baseline justify-between gap-2">
    <dt className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">{label}</dt>
    <dd
      className={`font-mono text-[12px] tabular-nums ${
        tone === 'positive' ? 'text-pos' : tone === 'negative' ? 'text-neg' : 'text-ink'
      }`}
    >
      {value}
    </dd>
  </div>
);