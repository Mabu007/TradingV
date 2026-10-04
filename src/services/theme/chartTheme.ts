/**
 * Chart palette.
 *
 * The chart is drawn on a canvas by a third-party library, so it cannot
 * use Tailwind classes. It reads the same `--tv-*` tokens as the rest of
 * the product through `getComputedStyle`, which keeps one source of truth
 * for colour.
 *
 * Values are read live, so switching `data-theme` and calling
 * `readChartPalette()` again is all that is needed to re-theme the chart.
 */

export interface ChartPalette {
  background: string;
  text: string;
  grid: string;
  line: string;
  lineStrong: string;
  pos: string;
  neg: string;
  accent: string;
  warn: string;
}

const FALLBACK: ChartPalette = {
  background: '#090d14',
  text: '#94a3b8',
  grid: 'rgba(30, 41, 59, 0.45)',
  line: '#1e293b',
  lineStrong: '#334155',
  pos: '#10b981',
  neg: '#ef4444',
  accent: '#38bdf8',
  warn: '#f59e0b',
};

const TOKENS: Record<keyof ChartPalette, string> = {
  background: '--tv-bg-alt',
  text: '--tv-ink-3',
  grid: '--tv-grid',
  line: '--tv-line',
  lineStrong: '--tv-line-strong',
  pos: '--tv-pos',
  neg: '--tv-neg-strong',
  accent: '--tv-accent',
  warn: '--tv-warn',
};

export function readChartPalette(
  element?: {
    ownerDocument?: Document | null;
    defaultView?: (Window & typeof globalThis) | null;
  },
): ChartPalette {
  const view =
    element?.ownerDocument?.defaultView ??
    (typeof window === 'undefined' ? undefined : window);

  if (!view?.getComputedStyle) return { ...FALLBACK };

  const styles = view.getComputedStyle(
    (element?.ownerDocument ?? document).documentElement,
  );

  const palette = { ...FALLBACK };

  for (const key of Object.keys(TOKENS) as Array<keyof ChartPalette>) {
    const value = styles.getPropertyValue(TOKENS[key]).trim();
    if (value) palette[key] = value;
  }

  return palette;
}
