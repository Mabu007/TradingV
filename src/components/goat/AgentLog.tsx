/**
 * The agent log.
 *
 * This is the surface the product is actually about. Not an activity feed, not
 * a notification list, not a debug console: the observable stream of a GOAT's
 * work, readable at a glance and worth leaving open for hours.
 *
 * Four rules govern everything here, and each one exists because the opposite
 * was tried and is wrong:
 *
 *   1. **It shows only what the runtime recorded.** Every line corresponds to a
 *      timeline event. There is no synthesised activity, no "thinking..." row,
 *      and when nothing has happened the log says so and stays quiet. A log
 *      that manufactures events is a log nobody can trust, and a trading agent
 *      is exactly the thing you cannot afford to mistrust.
 *   2. **No chain of thought.** It shows market data, observations, evidence,
 *      state transitions, verdicts and failures — never the model's private
 *      deliberation. What the reader gets is a detailed *work trail*.
 *   3. **Weight is real.** Most lines are quiet. A few are important. Two or
 *      three in a day are critical. That ratio is what makes a day scannable.
 *   4. **Never yank the reader.** If they have scrolled up to read something,
 *      new events do not drag them back to the bottom; a quiet counter offers
 *      to.
 *
 * And one thing this log must be able to say about itself: the difference
 * between *watching the market* and *waiting on the model*. Both are quiet, and
 * collapsing them into one "WATCHING" state is what made a healthy deployment
 * look abandoned. The header carries the difference, and it carries it only
 * when the runtime says a request is outstanding.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentEventView } from '../../engine/goat/agentEvents';
import { announcesItself } from '../../engine/goat/agentEvents';

/**
 * How many lines stay in the DOM.
 *
 * A day of a busy GOAT is thousands of events. Rendering them all is what
 * makes a log that is watched for hours eventually stutter, so the window is
 * capped and the rest stays reachable through the counter and the count. The
 * cap is deliberately generous: at forty lines the viewport never runs dry,
 * and the cost of a long log stops growing.
 */
const MAX_RENDERED = 40;

/** How long a newly arrived line holds its emphasis. */
const EMPHASIS_MS = 1_400;

/**
 * How close to the bottom still counts as "following the stream".
 *
 * Deliberately not zero. At zero, a one-pixel scroll or a momentum flick on
 * touch stops the log following, and the reader has to keep pressing a button
 * to see a live agent — which defeats the entire purpose.
 */
const FOLLOW_TOLERANCE_PX = 56;

export interface AgentLogProps {
  entries: AgentEventView[];
  /**
   * True while events are actually arriving.
   *
   * This is the difference the product cares about most: "no new event" means
   * the agent is watching, not that something is broken. So the indicator has
   * three states rather than two.
   */
  live: boolean;
  watching: boolean;
  /**
   * True while the GOAT is blocked on a model request.
   *
   * A separate state rather than a flavour of `live`, because the reader's
   * question changes with it: "is it working" versus "is it waiting on
   * something it cannot control". It is the one state that pulses here, and it
   * is the reason the log does not need to keep saying so.
   */
  waitingForModel?: boolean;
  /**
   * The word shown when events are arriving.
   *
   * Overridable because "LIVE" is a claim, not a mood. In a historical replay
   * events are arriving just as fast, and a log that says LIVE while the clock
   * says January is the one piece of copy that could make a user believe money
   * was involved.
   */
  liveLabel?: string;
  /** Wall clock, injected so the pulse and the copy are deterministic in tests. */
  now: number;
  /** Called when the reader asks to see an artefact a line points at. */
  onOpenArtifact?: (artifact: NonNullable<AgentEventView['artifact']>) => void;
  /**
   * Highlight and scroll to one entry.
   *
   * Added for the replay's key-moments list: a moment is a claim about a line in
   * this log, and a list of moments a reader cannot follow into the log is a
   * summary rather than a way in. Passing an id that is not in the rendered window
   * does nothing — the log only ever draws its tail, and scrolling to something it
   * is not showing would be a lie about what is on screen.
   */
  focusEntryId?: string;
  className?: string;
}

/** The dot colour for a line. Most lines are neutral on purpose. */
const DOT: Record<string, string> = {
  neutral: 'bg-ink-4/70',
  positive: 'bg-pos',
  negative: 'bg-neg',
  warning: 'bg-warn',
  info: 'bg-accent',
};

export const AgentLog: React.FC<AgentLogProps> = ({
  entries,
  live,
  watching,
  waitingForModel = false,
  liveLabel = 'LIVE',
  now,
  onOpenArtifact,
  focusEntryId,
  className = '',
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef(new Map<string, HTMLLIElement | null>());
  const [following, setFollowing] = useState(true);
  const [missed, setMissed] = useState(0);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());

  // Only the tail is ever rendered; the rest is counted, not drawn.
  const window_ = renderedWindow(entries.length);
  const visible = entries.slice(entries.length - window_.visible);
  const hiddenCount = window_.hidden;
  const newestId = visible.length > 0 ? visible[visible.length - 1].id : undefined;

  /*
   * A new event only announces itself if it is the newest one and it carries
   * weight. A line arriving while the reader is reading something else is
   * still recorded and still counted — it just does not perform.
   */
  useEffect(() => {
    if (!newestId) return;
    setFreshIds((current) => {
      if (current.has(newestId)) return current;
      return new Set([...current, newestId]);
    });
  }, [newestId]);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = window.setTimeout(() => {
      setFreshIds((current) => {
        const next = new Set(current);
        // Only the newest few need emphasis; holding all of them forever would
        // make a busy log permanently mid-animation.
        for (const id of [...next]) {
          if (next.size <= 3) break;
          next.delete(id);
        }
        return next;
      });
    }, EMPHASIS_MS);
    return () => window.clearTimeout(timer);
  }, [freshIds]);

  // While following, scroll on arrival. Layout effect so it lands in the same
  // frame as the paint and the reader never sees the log jump afterwards.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [newestId, following, visible.length]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const next = followState({
      distanceFromBottom: node.scrollHeight - node.scrollTop - node.clientHeight,
      missed,
    });
    setFollowing(next.following);
    setMissed(next.missed);
  }, [missed]);

  // Count what arrived while the reader was away, but only while away.
  useEffect(() => {
    if (following) return;
    setMissed((count) => Math.min(count + 1, 999));
  }, [entries.length, following]);

  /*
   * Follow a key moment into the log.
   *
   * Scrolling is the whole of it, and it only happens when the line is actually
   * rendered: the log draws its tail, so a moment pointing at something older than
   * the window is a moment the surface cannot take the reader to, and pretending
   * otherwise would be a worse small lie than a highlight that does not move.
   */
  useEffect(() => {
    if (!focusEntryId) return;
    const node = lineRefs.current.get(focusEntryId);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusEntryId, entries.length]);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setFollowing(true);
    setMissed(0);
  }, []);

  const state = waitingForModel ? 'MODEL' : live ? liveLabel : watching ? 'WATCHING' : 'QUIET';

  const headline = entries.length === 0
    ? 'Nothing recorded yet.'
    : waitingForModel
      ? 'Working on the Trade Plan — market context prepared and submitted'
      : live
        ? 'Events arriving'
        : watching
          ? 'Watching — no new qualifying event'
          : 'Quiet';

  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface ${className}`}
      aria-label="Agent log"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
        <h2 className="font-mono text-[10px] tracking-[0.18em] text-ink-3">AGENT LOG</h2>
        <span
          className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.14em]"
          data-testid="agent-log-state"
          data-state={state}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              waitingForModel
                ? 'bg-accent animate-goat-pulse-fast'
                : live
                  ? 'bg-pos animate-goat-pulse'
                  : watching
                    ? 'bg-pos/40 animate-goat-pulse-dim'
                    : 'bg-ink-4/70'
            }`}
            aria-hidden="true"
          />
          <span
            className={
              waitingForModel ? 'text-accent-ink' : live ? 'text-pos' : watching ? 'text-ink-3' : 'text-ink-4'
            }
          >
            {state}
          </span>
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-testid="agent-log-scroll"
          className="h-full overflow-y-auto overscroll-contain px-3 py-2 sm:px-4"
        >
          {entries.length === 0 ? (
            <p className="py-6 text-[11px] leading-relaxed text-ink-4">
              Nothing here yet. A GOAT records a line when it deploys, when it
              reads the market, when it forms a hypothesis, and every time a
              tracker it set fires. There is nothing to show because nothing
              has happened — not because it is broken.
            </p>
          ) : (
            <ol className="divide-y divide-line-soft/60">
              {visible.map((entry) => (
                <LogLine
                  key={entry.id}
                  entry={entry}
                  fresh={freshIds.has(entry.id)}
                  now={now}
                  onOpenArtifact={onOpenArtifact}
                  focused={focusEntryId === entry.id}
                  registerRef={(node) => {
                    if (node) lineRefs.current.set(entry.id, node);
                    else lineRefs.current.delete(entry.id);
                  }}
                />
              ))}
            </ol>
          )}
        </div>

        {!following && missed > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            data-testid="agent-log-jump"
            className="absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full border border-line-strong bg-surface-3/95 px-3 py-1 font-mono text-[10px] text-ink-2 shadow-lg backdrop-blur-xs transition-colors hover:text-ink"
          >
            ↓ {missed} new {missed === 1 ? 'event' : 'events'}
          </button>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line/70 px-4 py-2">
        <span className="truncate text-[10px] text-ink-4">{headline}</span>
        <span className="shrink-0 font-mono text-[10px] text-ink-4">
          {entries.length > 0 && `${entries.length} recorded`}
          {hiddenCount > 0 && ` · ${hiddenCount} older not shown`}
        </span>
      </footer>
    </section>
  );
};

interface LogLineProps {
  entry: AgentEventView;
  fresh: boolean;
  now: number;
  onOpenArtifact?: (artifact: NonNullable<AgentEventView['artifact']>) => void;
  /** Set when a key moment pointed the reader at this line. */
  focused?: boolean;
  registerRef?: (node: HTMLLIElement | null) => void;
}

/**
 * One entry.
 *
 * The previous version crammed every event onto a single 20-pixel row:
 * time, dot, label, headline and detail all competing in one line. It was
 * legible on a desktop monitor and unreadable on a phone, and it gave every
 * event the same visual weight, which is the opposite of what a log is for.
 *
 * So an entry is a block with room in it. The rhythm comes from generous
 * vertical space and a hairline between entries, not from type size — a
 * terminal that shouts is a terminal nobody can scan. Three weights, set by
 * the recorded type rather than by the renderer, so the hierarchy is a
 * property of the data:
 *
 *   normal      MARKET, OBSERVATION, TRACKER, WAIT — quiet, recessive
 *   important   EVIDENCE, PLAN, RESEARCH, STEER — the working narrative
 *   critical    INVALIDATION, EXECUTION, ERROR, RISK — stop and read this
 */
const LogLine: React.FC<LogLineProps> = ({ entry, fresh, now, onOpenArtifact, focused, registerRef }) => {
  const { style } = entry;
  const critical = style.weight === 'critical';
  const important = style.weight === 'important';
  const announces = announcesItself(style.weight);

  return (
    <li
      ref={registerRef}
      data-event-type={entry.type}
      data-weight={style.weight}
      data-focused={focused ? 'true' : undefined}
      className={[
        'group relative border-l-2 py-3 pl-3.5 pr-1 transition-colors',
        critical
          ? 'border-l-neg/60 bg-neg/[0.05]'
          : important
            ? 'border-l-accent/35'
            : 'border-l-line-soft hover:bg-surface-2/40',
        fresh && announces ? 'animate-log-enter' : '',
        focused ? 'bg-accent-soft/25 ring-1 ring-inset ring-accent/40' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <time
          className="font-mono text-[10px] leading-none tabular-nums text-ink-4"
          dateTime={new Date(entry.at).toISOString()}
        >
          {formatClock(entry.at, now)}
        </time>
        <span
          className={`inline-flex items-center gap-1.5 font-mono tracking-[0.12em] ${
            critical
              ? 'text-[10px] text-neg'
              : important
                ? 'text-[10px] text-accent-ink'
                : 'text-[9px] text-ink-4'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[style.tone] ?? DOT.neutral} ${
              fresh && critical ? 'animate-goat-pulse-fast' : ''
            }`}
            aria-hidden="true"
          />
          {style.label}
        </span>
      </div>

      {/*
        The headline on its own line, at a size the eye lands on. Body copy
        rather than a caption: it is the actual content, and the label above it
        is the classification.
      */}
      <p
        className={`mt-1.5 break-words ${
          critical
            ? 'text-[13px] font-medium leading-6 text-ink'
            : important
              ? 'text-[12.5px] leading-6 text-ink'
              : 'text-[12px] leading-[1.7] text-ink-2'
        }`}
      >
        {entry.headline}
      </p>

      {entry.detail && (
        <p className="mt-1 break-words font-mono text-[10.5px] leading-5 text-ink-3">
          {entry.detail}
        </p>
      )}

      {entry.artifact && onOpenArtifact && (
        <button
          type="button"
          onClick={() => onOpenArtifact(entry.artifact!)}
          className="mt-1.5 font-mono text-[10px] text-ink-4 underline decoration-ink-4/40 underline-offset-2 transition-colors hover:text-accent-ink"
        >
          {entry.artifact.label} →
        </button>
      )}
    </li>
  );
};

/**
 * Whether the log should keep following new events, and what it owes the
 * reader.
 *
 * Extracted because this is the one piece of the log with a rule rather than
 * a look, and a rule that can only be tested by generating enough events to
 * overflow the viewport is a rule that will not be tested. Pure, so it can
 * be.
 */
export function followState(input: {
  /** Distance from the bottom, in pixels. */
  distanceFromBottom: number;
  /** Events recorded while the reader was away. */
  missed: number;
}): { following: boolean; missed: number } {
  const atBottom = input.distanceFromBottom <= FOLLOW_TOLERANCE_PX;
  return {
    following: atBottom,
    // Reaching the bottom clears the backlog. Nothing is lost: the events are
    // still there, the reader simply is no longer behind.
    missed: atBottom ? 0 : input.missed,
  };
}

/**
 * How many events to render.
 *
 * A day of a busy GOAT is thousands of records; rendering them all is what
 * makes a log watched for hours eventually stutter. Capped, and the rest
 * stays reachable through the count in the footer.
 */
export function renderedWindow(total: number, cap = MAX_RENDERED): { visible: number; hidden: number } {
  return total > cap ? { visible: cap, hidden: total - cap } : { visible: total, hidden: 0 };
}

function formatClock(at: number, now: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  // A line from earlier today needs no date; one from yesterday does, or a
  // reader watching a daily narrative cannot tell where the day turned over.
  if (!isSameDay(at, now)) return `${date.getDate()}/${date.getMonth() + 1}`;
  return `${hh}:${mm}:${ss}`;
}

function isSameDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}