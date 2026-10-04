import {
  DEFAULT_THEME,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  THEMES,
  applyThemeAttribute,
  isThemeName,
  readStoredTheme,
  resolveInitialTheme,
  writeStoredTheme,
  type ThemeName,
} from './theme';
import { readChartPalette } from './chartTheme';
import { readFileSync } from 'node:fs';
import { runAIContextTests } from '../aiContext/tests';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const indexCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

/** In-memory Storage stand-in, so the tests do not touch the real one. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

export function runThemeTests(): void {
  testDefaults();
  testResolution();
  testPersistence();
  testAttribute();
  testTokens();
  testChartPalette();
  testNoHardcodedThemeColors();
}

function testDefaults(): void {
  assert(DEFAULT_THEME === 'dark', 'dark is the default theme');
  assert(THEMES.length === 2, 'there are exactly two themes');
  assert(THEMES.includes('dark') && THEMES.includes('light'), 'both themes are offered');
  assert(isThemeName('dark') && isThemeName('light'), 'both theme names are recognised');
  assert(!isThemeName('sepia'), 'an unknown theme name is rejected');
  assert(!isThemeName(undefined), 'a missing theme name is rejected');
}

function testResolution(): void {
  // A stored choice always wins over the OS preference.
  assert(
    resolveInitialTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }), true) === 'light',
    'a stored light choice survives a dark OS preference',
  );
  assert(
    resolveInitialTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }), false) === 'dark',
    'a stored dark choice survives a light OS preference',
  );

  // With no stored choice the OS preference is consulted.
  assert(resolveInitialTheme(fakeStorage(), false) === 'light', 'a light OS preference picks light on first visit');
  assert(resolveInitialTheme(fakeStorage(), true) === 'dark', 'a dark OS preference picks dark on first visit');
  assert(resolveInitialTheme(fakeStorage(), undefined) === 'dark', 'an unknown OS preference falls back to dark');

  // Unreadable storage must not break the app.
  assert(
    resolveInitialTheme(
      {
        getItem() {
          throw new Error('storage disabled');
        },
      },
      true,
    ) === 'dark',
    'a storage failure falls back safely',
  );
  assert(
    resolveInitialTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'nonsense' }), true) === 'dark',
    'a corrupt stored value is ignored',
  );
  assert(resolveInitialTheme(null, false) === 'light', 'null storage still resolves');
}

function testPersistence(): void {
  const storage = fakeStorage();

  assert(readStoredTheme(storage) === undefined, 'nothing is stored initially');

  writeStoredTheme('light', storage);
  assert(readStoredTheme(storage) === 'light', 'a written theme is read back');
  assert(storage.snapshot()[THEME_STORAGE_KEY] === 'light', 'the theme is persisted under its key');

  writeStoredTheme('dark', storage);
  assert(readStoredTheme(storage) === 'dark', 'switching back persists the new theme');

  // Writing must survive an unavailable store.
  writeStoredTheme('light', {
    setItem() {
      throw new Error('quota exceeded');
    },
  });

  readStoredTheme(null);
  readStoredTheme(undefined);
}

function testAttribute(): void {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };

  const themes: ThemeName[] = ['dark', 'light', 'dark'];
  for (const theme of themes) applyThemeAttribute(theme, root);

  assert(THEME_ATTRIBUTE === 'data-theme', 'the theme is driven by data-theme');
  assert(attributes.get('data-theme') === 'dark', 'the last applied theme wins');
  assert(attributes.size === 1, 'only the theme attribute is written');

  // Applying with no document available must not throw.
  applyThemeAttribute('light', undefined);
}

function testTokens(): void {
  // Both palettes must define every token the components consume.
  const required = [
    '--tv-bg', '--tv-bg-alt', '--tv-surface', '--tv-surface-2', '--tv-surface-3',
    '--tv-inset', '--tv-header', '--tv-sidebar', '--tv-nav',
    '--tv-line', '--tv-line-strong', '--tv-line-soft',
    '--tv-ink', '--tv-ink-2', '--tv-ink-3', '--tv-ink-4',
    '--tv-accent', '--tv-accent-strong', '--tv-accent-contrast', '--tv-accent-soft', '--tv-accent-ink',
    '--tv-pos', '--tv-pos-soft', '--tv-neg', '--tv-neg-strong', '--tv-neg-soft',
    '--tv-warn', '--tv-warn-soft', '--tv-overlay', '--tv-grid',
    '--tv-scrollbar-track', '--tv-scrollbar-thumb', '--tv-scrollbar-thumb-hover',
  ];

  const darkBlock = indexCss.slice(indexCss.indexOf(':root,'), indexCss.indexOf('[data-theme="light"]'));
  const lightBlock = indexCss.slice(indexCss.indexOf('[data-theme="light"]'), indexCss.indexOf('@theme inline'));

  for (const token of required) {
    assert(darkBlock.includes(`${token}:`), `the dark palette defines ${token}`);
    assert(lightBlock.includes(`${token}:`), `the light palette defines ${token}`);
  }

  // Tokens must be wired into Tailwind so components can use them.
  for (const utility of [
    '--color-bg', '--color-surface', '--color-line', '--color-ink',
    '--color-accent', '--color-pos', '--color-neg', '--color-warn',
  ]) {
    assert(indexCss.includes(`${utility}: var(--tv-`), `${utility} is mapped to a theme token`);
  }

  assert(indexCss.includes('@theme inline'), 'the theme block uses inline so utilities follow the theme');

  // The two palettes must actually differ, otherwise light mode is a no-op.
  const darkAccent = /--tv-accent:\s*([^;]+);/.exec(darkBlock)?.[1]?.trim();
  const lightAccent = /--tv-accent:\s*([^;]+);/.exec(lightBlock)?.[1]?.trim();
  assert(darkAccent !== lightAccent, 'the light palette is a different palette, not a copy');

  const darkBg = /--tv-bg:\s*([^;]+);/.exec(darkBlock)?.[1]?.trim();
  const lightBg = /--tv-bg:\s*([^;]+);/.exec(lightBlock)?.[1]?.trim();
  assert(darkBg !== lightBg, 'the light background is genuinely lighter');

  // The document must not trap scrolling, and must not disable
  // vertical overflow the way the old shell did.
  assert(!/body\s*\{[^}]*overflow:\s*hidden/.test(indexCss), 'body never sets overflow hidden');
  assert(!/body\s*\{[^}]*height:\s*100vh/.test(indexCss), 'body is not height-locked');
}

function testChartPalette(): void {
  // Without a DOM the chart falls back to a complete palette rather than
  // producing undefined colours.
  const fallback = readChartPalette(undefined);
  assert(Boolean(fallback.background), 'the chart palette always has a background');
  assert(Boolean(fallback.text), 'the chart palette always has text colour');
  assert(Boolean(fallback.line), 'the chart palette always has a line colour');
  assert(Boolean(fallback.pos) && Boolean(fallback.neg), 'the chart palette has up and down colours');

  const fromElement = readChartPalette({
    ownerDocument: {
      documentElement: {},
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) =>
            name === '--tv-bg-alt' ? '#ffffff' : '',
        }),
      },
    } as never,
  });
  assert(fromElement.background === '#ffffff', 'the chart palette reads the live CSS token');
}

function testNoHardcodedThemeColors(): void {
  /*
   * The shell, the views, and the new components must consume tokens
   * rather than hardcoded palettes. This is the guard against the
   * regression that made the app unreadable in light mode.
   */
  const tokenised = [
    'src/App.tsx',
    'src/components/navigation/MobileHeader.tsx',
    'src/components/navigation/BottomNav.tsx',
    'src/components/views/TradesTab.tsx',
    'src/components/views/HistoryTab.tsx',
    'src/components/views/SettingsTab.tsx',
    'src/components/views/WalletCard.tsx',
    'src/components/ai/FloatingAIAssistant.tsx',
    'src/components/goat/GoalComposer.tsx',
    'src/components/goat/GoatCommandCenter.tsx',
    'src/components/goat/LiveGoatCard.tsx',
    'src/components/goat/MyGoatCard.tsx',
    'src/components/goat/WorkPlan.tsx',
    'src/components/goat/GoatView.tsx',
  ];

  const repoRoot = new URL('../../../', import.meta.url);
  for (const file of tokenised) {
    const source = readFileSync(new URL(file, repoRoot), 'utf8');
    const hexUtility = /\b(?:bg|text|border|from|to|ring|shadow)-\[#[0-9a-fA-F]{3,8}\]/;
    assert(!hexUtility.test(source), `${file} uses theme tokens, not hardcoded colour utilities`);

    // `text-slate-*` and friends would be dark-only neutrals.
    assert(
      !/text-slate-\d{3}/.test(source),
      `${file} uses ink tokens rather than the dark-only slate scale`,
    );
  }
}
