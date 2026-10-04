/**
 * Confirmation for an irreversible act.
 *
 * Deleting a GOAT stops it and removes it from the list, and there is no undo:
 * nothing in the system ever writes `ABANDONED` back. So the action gets a
 * real modal rather than an inline button swap — an inline swap is easy to
 * mis-tap on a phone, and the one surface that matters most (the GOAT's own
 * workspace) previously had no confirmation at all.
 *
 * Built on the patterns already in this codebase's modal set rather than on
 * `window.confirm`, which cannot be styled, cannot say what is being kept,
 * and renders differently on every platform.
 *
 * Accessibility, because a destructive dialog that cannot be dismissed with
 * the keyboard is a trap:
 *
 *   - `role="dialog"` + `aria-modal`, labelled by its own heading
 *   - Escape cancels, and so does the backdrop — never confirms
 *   - focus moves to Cancel on open, so a stray Enter cannot delete
 *   - focus is held inside the dialog while it is open
 *   - the destructive action is the visually distinct one, and is never the
 *     default
 */

import { useCallback, useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmDestructiveProps {
  open: boolean;
  title: string;
  /** What will happen, in plain words. */
  body: string;
  /** What is *not* destroyed, when there is something worth keeping. */
  keptNote?: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDestructive: React.FC<ConfirmDestructiveProps> = ({
  open,
  title,
  body,
  keptNote,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy,
  onConfirm,
  onCancel,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Focus starts on Cancel, so the destructive action is never one stray
  // Enter away.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      // Focus goes back where it came from, so deleting and cancelling do not
      // leave a keyboard user stranded at the top of the document.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Escape always cancels. It must never confirm.
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      // Hold focus inside: tabbing out of a destructive dialog and into the
      // page behind it is how these get dismissed by accident.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 backdrop-blur-[2px] sm:items-center"
      onMouseDown={(event) => {
        // Backdrop dismisses as a cancel. Deliberately not the confirm: a
        // mis-aimed click outside must never delete anything.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-destructive-title"
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-2xl border border-neg/35 bg-surface px-5 py-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neg/40 text-neg"
            aria-hidden="true"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="confirm-destructive-title"
              className="text-[13px] font-semibold leading-5 text-ink"
            >
              {title}
            </h2>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">{body}</p>
            {keptNote && (
              <p className="mt-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-3">
                {keptNote}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line px-3.5 py-2 font-mono text-[11px] text-ink-2 transition-colors hover:border-ink-3/50 hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-neg-strong px-3.5 py-2 font-mono text-[11px] font-semibold text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};