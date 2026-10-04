/**
 * The trade plan.
 *
 * The GOAT's strategic state, in one column, answering four questions in the
 * order a person asks them: what does it think, what is it waiting to prove,
 * what would change its mind, and what would it do if that held.
 *
 * Structure is spacing, rules and type — not a stack of cards. Each section is
 * a block of text on one surface, because the plan is a single thought and
 * dividing it into panels makes it read as five separate facts.
 *
 * Everything shown is derived from records the runtime wrote. In particular
 * the conditional-execution block is intent, never permission: when the
 * deployment is SHADOW this component says so, in as many words, directly
 * beneath the levels it would have used.
 */

import type { PlanView, PlanCriterion } from '../../engine/goat/planView';

const STATUS_TONE: Record<PlanView['status'], string> = {
  BUILDING: 'text-ink-3',
  RESEARCHING: 'text-accent-ink',
  VALIDATING: 'text-accent-ink',
  WAITING: 'text-ink-3',
  READY: 'text-pos',
  EXECUTED: 'text-pos',
  INVALIDATED: 'text-neg',
  REPLACED: 'text-ink-3',
  NONE: 'text-ink-4',
};

export interface TradePlanPanelProps {
  plan: PlanView;
  /**
   * Why there is nothing to read yet, when there is nothing to read yet.
   *
   * "No plan yet" is an absence, and an absence is not an explanation. A GOAT
   * that is reading the market, or blocked on the model, or waiting for a
   * resolution it does not have yet, is doing something specific — and saying
   * so is the difference between a panel that looks broken and one that looks
   * like an agent at work.
   */
  formingNote?: string;
  className?: string;
}

export const TradePlanPanel: React.FC<TradePlanPanelProps> = ({
  plan,
  formingNote,
  className = '',
}) => {
  if (!plan.exists) {
    return (
      <section
        className={`rounded-2xl border border-line bg-surface px-5 py-4 ${className}`}
        aria-label="Trade plan"
      >
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-[10px] tracking-[0.18em] text-ink-3">TRADE PLAN</h2>
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-accent-ink"
            data-testid="plan-status"
            data-status="BUILDING"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-goat-pulse-dim" aria-hidden="true" />
            FORMING
          </span>
        </header>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-2" data-testid="plan-forming">
          {formingNote ??
            'The plan appears here the moment this GOAT has something to believe — what it thinks may happen, what would confirm it, and what it would do.'}
        </p>
      </section>
    );
  }

  return (
    <section
      className={`rounded-2xl border border-line bg-surface px-5 py-4 ${className}`}
      aria-label="Trade plan"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[10px] tracking-[0.18em] text-ink-3">TRADE PLAN</h2>
        <span
          className={`inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] ${STATUS_TONE[plan.status]}`}
          data-testid="plan-status"
          data-status={plan.status}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              plan.status === 'READY' || plan.status === 'EXECUTED'
                ? 'bg-pos'
                : plan.status === 'INVALIDATED'
                  ? 'bg-neg'
                  : plan.status === 'NONE'
                    ? 'bg-ink-4/70'
                    : 'bg-accent'
            } ${plan.status === 'RESEARCHING' || plan.status === 'VALIDATING' ? 'animate-goat-pulse-dim' : ''}`}
            aria-hidden="true"
          />
          {plan.statusLabel.toUpperCase()}
        </span>
      </header>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {plan.market && <span className="font-mono text-[13px] text-ink">{plan.market}</span>}
        {plan.direction && (
          <span className="font-mono text-[10px] tracking-[0.12em] text-ink-3">
            {plan.direction.toUpperCase()}
          </span>
        )}
      </div>

      {/*
        The sentence first, and it is the point of the panel. A person should
        be able to read what this GOAT intends to do and under what conditions
        in one pass, before any of the supporting detail.
      */}
      {plan.objective && (
        <p
          className="mt-2.5 text-[13px] leading-relaxed text-ink"
          data-testid="plan-objective"
        >
          {plan.objective}
        </p>
      )}

      {plan.idea && plan.objective !== plan.idea && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{plan.idea}</p>
      )}

      {/*
        What it is still waiting for, in the plan's own words.
        Shown only while something is outstanding, because "validating" with no
        list of conditions is a status word where the reader wanted a reason.
      */}
      {plan.awaiting && plan.awaiting.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3" data-testid="plan-awaiting">
          Waiting on{' '}
          {plan.awaiting.length === 1
            ? plan.awaiting[0]
            : `${plan.awaiting.slice(0, -1).join(', ')} and ${plan.awaiting[plan.awaiting.length - 1]}`}
          .
        </p>
      )}

      {plan.research.length > 0 && (
        <>
          <Rule label="RESEARCH" />
          <ul className="space-y-1.5">
            {plan.research.map((criterion) => (
              <Criterion key={criterion.label} criterion={criterion} />
            ))}
          </ul>
        </>
      )}

      {plan.validation.total > 0 && (
        <>
          <Rule label="VALIDATION" />
          <p
            className="font-mono text-[11px] text-ink-2"
            data-testid="plan-validation"
          >
            {plan.validation.confirmed} / {plan.validation.total} confirmed
            {plan.validation.contradicted > 0 && (
              <span className="text-neg"> · {plan.validation.contradicted} contradicted</span>
            )}
          </p>
          {/* The bar is decoration over a real ratio, and is marked as such. */}
          <div
            className="mt-2 flex gap-0.5"
            role="img"
            aria-label={`${plan.validation.confirmed} of ${plan.validation.total} conditions confirmed`}
          >
            {plan.research.map((criterion) => (
              <span
                key={criterion.label}
                className={`h-0.5 flex-1 rounded-full ${
                  criterion.state === 'confirmed'
                    ? 'bg-pos'
                    : criterion.state === 'contradicted'
                      ? 'bg-neg'
                      : 'bg-line-strong'
                }`}
              />
            ))}
          </div>
        </>
      )}

      {plan.invalidation && (
        <>
          <Rule label="INVALIDATION" />
          <p className="text-[11.5px] leading-relaxed text-ink-3">{plan.invalidation}</p>
        </>
      )}

      {plan.conditional && (
        <>
          <Rule label="IF VALIDATED" />
          <div className="space-y-1">
            <p className="font-mono text-[11px] text-ink-2" data-testid="plan-intent">
              {plan.conditional.action}
            </p>
            {plan.conditional.entry && <Level label="Entry" value={plan.conditional.entry} />}
            {plan.conditional.invalidation && (
              <Level label="Invalidation" value={plan.conditional.invalidation} />
            )}
            {plan.conditional.target && <Level label="Target" value={plan.conditional.target} />}
          </div>
          {/*
           * The permission note sits directly under the levels it qualifies.
           * A reader who sees "BUY / entry 1.1710" must not have to scroll to
           * discover that nothing will be sent.
           */}
          {plan.executionNote && (
            <p className="mt-2 text-[10.5px] leading-relaxed text-warn" data-testid="plan-permission">
              {plan.executionNote}
            </p>
          )}
        </>
      )}

      {plan.watching.length > 0 && (
        <>
          <Rule label="WATCHING" />
          <ul className="space-y-1">
            {plan.watching.map((tracker) => (
              <li key={tracker.id} className="flex items-start gap-2 text-[11px] leading-5 text-ink-3">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-pos/60" aria-hidden="true" />
                <span className="min-w-0 break-words">{tracker.purpose}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        What the GOAT's own skills still require and have not got.
        Six of the ten skills declare `REQUIRE_HIGHER_TIMEFRAME_CONFIRMATION`,
        so without this a reader would assume a GOAT was reasoning on one
        timeframe when its configuration says otherwise. The GOAT itself is
        told the same list, so this is the user's window onto it rather than a
        second, separate account.
      */}
      {plan.outstandingConstraints.length > 0 && (
        <>
          <Rule label="STILL REQUIRED" />
          <ul className="space-y-1" data-testid="plan-constraints">
            {plan.outstandingConstraints.map((constraint) => (
              <li key={constraint} className="flex items-start gap-2 text-[11px] leading-5 text-warn/90">
                <span className="mt-[3px] shrink-0 font-mono text-[10px] text-warn/60" aria-hidden="true">
                  ○
                </span>
                <span className="min-w-0 break-words">{constraint}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-4 border-t border-line/60 pt-2.5 text-[10px] text-ink-4">
        {plan.evidenceCount} {plan.evidenceCount === 1 ? 'piece' : 'pieces'} of evidence recorded
        {plan.watching.length > 0 && ` · ${plan.watching.length} conditions active`}
      </p>
    </section>
  );
};

const Rule: React.FC<{ label: string }> = ({ label }) => (
  <div className="mt-4 flex items-center gap-2">
    <h3 className="font-mono text-[9px] tracking-[0.18em] text-ink-4">{label}</h3>
    <span className="h-px flex-1 bg-line/70" aria-hidden="true" />
  </div>
);

const Criterion: React.FC<{ criterion: PlanCriterion }> = ({ criterion }) => {
  const confirmed = criterion.state === 'confirmed';
  const contradicted = criterion.state === 'contradicted';
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-px font-mono text-[11px] leading-5 ${
          confirmed ? 'text-pos' : contradicted ? 'text-neg' : 'text-ink-4'
        }`}
        aria-hidden="true"
      >
        {confirmed ? '✓' : contradicted ? '✕' : '◌'}
      </span>
      <span
        className={`text-[11px] leading-5 ${
          confirmed ? 'text-ink-2' : contradicted ? 'text-neg/90' : 'text-ink-4'
        }`}
      >
        {criterion.label}
        <span className="sr-only">
          {' '}
          {confirmed ? 'confirmed' : contradicted ? 'contradicted' : 'not yet confirmed'}
        </span>
      </span>
    </li>
  );
};

const Level: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <p className="flex items-baseline gap-2 font-mono text-[11px]">
    <span className="w-24 shrink-0 text-ink-4">{label}</span>
    <span className="text-ink-2">{value}</span>
  </p>
);