/**
 * Theme.
 *
 * Two themes only, both designed rather than inverted:
 *
 *   dark  - the existing app shell, and the default
 *   light - a cool paper background with white surfaces and a deeper
 *           accent so contrast holds on white
 *
 * The choice is persisted locally and always wins over the OS
 * preference. The OS preference is only consulted for the very first
 * visit, when no explicit choice has been stored.
 *
 * The actual colours live in `src/index.css` as `--tv-*` custom
 * properties. This module only owns *which* set is active, so no colour
 * is duplicated between CSS and TypeScript.
 */

export type ThemeName = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'tradingvibe_theme';

export const THEMES: readonly ThemeName[] = ['dark', 'light'] as const;

export const DEFAULT_THEME: ThemeName = 'dark';

export function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'light';
}

/**
 * Resolve the initial theme.
 *
 * Order: stored choice -> OS preference -> dark default.
 *
 * `prefers-color-scheme` is read defensively because `matchMedia` is not
 * available in every environment the module may be imported from (tests,
 * server-side rendering).
 */
export function resolveInitialTheme(
  storage?: Pick<Storage, 'getItem'> | null,
  prefersDark?: boolean,
): ThemeName {
  const stored = readStoredTheme(storage);

  if (stored) return stored;

  return prefersDark === false ? 'light' : DEFAULT_THEME;
}

export function readStoredTheme(
  storage?: Pick<Storage, 'getItem'> | null,
): ThemeName | undefined {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeName(value) ? value : undefined;
  } catch {
    // Storage can be unavailable (private mode, disabled). Fall through.
    return undefined;
  }
}

export function writeStoredTheme(
  theme: ThemeName,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this session; persistence is best-effort.
  }
}

/** The attribute that drives every `--tv-*` token. */
export const THEME_ATTRIBUTE = 'data-theme';

export function applyThemeAttribute(
  theme: ThemeName,
  root?: { setAttribute(name: string, value: string): void },
): void {
  const target = root ?? globalThis.document?.documentElement;

  target?.setAttribute(THEME_ATTRIBUTE, theme);
}

export function prefersDarkColorScheme(): boolean | undefined {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return undefined;
  }
}
