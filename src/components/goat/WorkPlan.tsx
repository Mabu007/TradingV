import React from 'react';
import { Check, Loader2, Circle } from 'lucide-react';
import type { WorkStep } from '../../engine/goat/mission';

export interface WorkPlanProps {
  steps: WorkStep[];
  /** Compact list for a card; the full list for the command centre. */
  dense?: boolean;
  title?: string;
}

/**
 * What the GOAT intends to do, and how far along it is.
 *
 * Every row is derived from a record: a completed row means a thesis
 * exists, a plan exists, a risk verdict exists. There is no timer and no
 * animation behind this, so it cannot drift from the truth the way an
 * animated "thinking…" would — and a GOAT that has done nothing shows an
 * empty list rather than a convincing fake.
 */
export const WorkPlan: React.FC<WorkPlanProps> = ({ steps, dense = false, title }) => (
  <section
    className={`rounded-2xl border border-line bg-surface ${dense ? '' : ''}`}
    aria-label="GOAT work plan"
  >
    {title && (
      <header className="border-b border-line px-5 py-3.5">
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        <p className="mt-0.5 text-[10px] text-ink-3">
          Each step completes only when the GOAT has actually done it.
        </p>
      </header>
    )}

    <ol className={dense ? 'space-y-1.5 p-4' : 'divide-y divide-line/60'}>
      {steps.map((step) => (
        <li
          key={step.id}
          className={`flex items-start gap-3 ${dense ? 'px-0' : 'px-5 py-3'}`}
          aria-current={step.status === 'active' ? 'step' : undefined}
        >
          <span className="mt-0.5 shrink-0" aria-hidden="true">
            {step.status === 'done' ? (
              <Check className="h-3.5 w-3.5 text-pos" />
            ) : step.status === 'active' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            ) : (
              <Circle className="h-3 w-3 text-ink-4" />
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span
              className={`block text-[11px] leading-relaxed ${
                step.status === 'done'
                  ? 'text-ink-3'
                  : step.status === 'active'
                    ? 'font-semibold text-ink'
                    : 'text-ink-4'
              }`}
            >
              {step.status === 'active' ? `Now: ${step.label}` : step.label}
            </span>
            {step.detail && step.status !== 'pending' && (
              <span className="mt-0.5 block break-words text-[10px] leading-relaxed text-ink-4">
                {step.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  </section>
);
