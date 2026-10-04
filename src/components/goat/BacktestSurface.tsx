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
  BacktestSession,
  SIMULATION_SPEEDS,
  formatSimulatedDate,
  formatSimulatedTime,
  type BacktestSnapshot,
  type SimulationSpeed,
} from '../../engine/goat/backtest';
import { buildPlanView } from '../../engine/goat/planView';
import type { AgentEventView } from '../../engine/goat/agentEvents';
import { historicalMarketDataProvider } from '../../engine/backtester/historical';

import { AgentLog } from './AgentLog';
import { TradePlanPanel } from './TradePlanPanel';

/** How much history a replay covers by default: six hours of 1m bars. */
const DEFAULT_WINDOW_HOURS = 6;

export interface BacktestSurfaceProps {
  /** Markets the user can replay. The first is offered as the default. */
  markets: string[];
  /** Where history comes from. Injected so a demo or a test can supply its own. */
  loadBars?: (request: { market: string; start: number; end: number }) => Promise<Bar[]>;
  onExit: () => void;
}

/**
 * A window that has already happened, rounded to whole minutes.
 *
 * Rounded because the venue's candles are stamped on minute boundaries and a
 * window that starts at 10:43:27 asks for a quarter of a candle that does not
 * exist. The end is pulled back a minute for the same reason: the most recent
 * minute is still forming, and a replay that began inside it would be
 * replaying an unfinished candle.
 */
function defaultWindow(now = Date.now()): { start: number; end: number } {
  const minute = 60_000;
  const end = Math.floor(now / minute) * minute - minute;
  return { start: end - DEFAULT_WINDOW_HOURS * 60 * minute, end };
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

export const BacktestSurface: React.FC<BacktestSurfaceProps> = ({
  markets,
  loadBars,
  onExit,
}) => {
  const initial = useMemo(() => defaultWindow(), []);
  const [market, setMarket] = useState(markets[0] ?? 'EUR/USD');
  const [goal, setGoal] = useState(
    'Watch this market and form a hypothesis, then act when the evidence supports one.',
  );
  const [from, setFrom] = useState(toLocalInput(initial.start));
  const [to, setTo] = useState(toLocalInput(initial.end));
  const [speed, setSpeed] = useState<SimulationSpeed>(10);

  const [session, setSession] = useState<BacktestSession | undefined>();
  const [snapshot, setSnapshot] = useState<BacktestSnapshot | undefined>();
  const [entries, setEntries] = useState<AgentEventView[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

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
      const next = new BacktestSession({
        goal,
        market,
        timeframe: '15m',
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
      setSession(undefined);
    } finally {
      setBusy(false);
    }
  }, [busy, from, goal, loadBars, market, speed, to]);

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
                void session.stop('Stopped from the surface.').then(() => setSnapshot(session.snapshot()));
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

          <label className="mt-3 block">
            <span className="font-mono text-[9px] tracking-[0.18em] text-ink-4">GOAL</span>
            <input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              data-testid="backtest-goal"
              className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink outline-none focus:border-accent/50"
            />
          </label>

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
            {plan && <TradePlanPanel plan={plan} />}
            {snapshot?.message && (
              <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[11px] leading-relaxed text-ink-3">
                {snapshot.message}
              </p>
            )}
            {snapshot?.report && <ResultsPanel snapshot={snapshot} />}
          </div>

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