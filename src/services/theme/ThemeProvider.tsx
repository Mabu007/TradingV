import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  applyThemeAttribute,
  DEFAULT_THEME,
  prefersDarkColorScheme,
  readStoredTheme,
  resolveInitialTheme,
  writeStoredTheme,
  type ThemeName,
} from './theme';

interface ThemeContextValue {
  theme: ThemeName;
  setTheme(theme: ThemeName): void;
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Applies the theme to the document and owns the single place the theme
 * changes. Components read `useTheme()` and never touch
 * `document.documentElement` themselves.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() =>
    resolveInitialTheme(
      typeof localStorage === 'undefined' ? null : localStorage,
      prefersDarkColorScheme(),
    ),
  );

  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  /*
   * Follow the OS only while the user has expressed no preference. Once
   * a choice is stored it is authoritative.
   */
  useEffect(() => {
    if (readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage)) {
      return;
    }

    let media: MediaQueryList | undefined;

    try {
      media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    } catch {
      media = undefined;
    }

    if (!media?.addEventListener) return;

    const onChange = (event: MediaQueryListEvent) =>
      setThemeState(event.matches ? 'dark' : 'light');

    media.addEventListener('change', onChange);

    return () => media.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    writeStoredTheme(
      next,
      typeof localStorage === 'undefined' ? null : localStorage,
    );
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: ThemeName = current === 'dark' ? 'light' : 'dark';
      writeStoredTheme(
        next,
        typeof localStorage === 'undefined' ? null : localStorage,
      );
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/**
 * Theme access with a safe default so no component has to handle a
 * missing provider.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  return (
    context ?? {
      theme: DEFAULT_THEME,
      setTheme: () => undefined,
      toggleTheme: () => undefined,
    }
  );
}
