# Theme & Design Tokens

TradingGOATs ships two designed themes. Dark is the default; light is a real
palette, not an inversion.

---

## 1. Rules

1. **No colour literals in components.** Every surface, border, and text
   colour comes from a token. `bun run test:theme` fails the build if a
   shell or view component reintroduces a `bg-[#...]` utility or the
   dark-only `text-slate-*` scale.
2. **One source of truth.** Colours live in `src/index.css` as `--tv-*`
   custom properties. TypeScript never restates a colour value.
3. **Two palettes, both complete.** Every token is defined in both blocks.
   A token missing from one palette would fall through to the other and
   read as a bug in light mode.

## 2. Tokens

| Token | Role |
| ----- | ---- |
| `--tv-bg`, `--tv-bg-alt` | page and alternate page background |
| `--tv-surface`, `--tv-surface-2`, `--tv-surface-3` | cards, elevated surfaces, inputs and hovers |
| `--tv-inset` | wells: chart, code, terminal, inputs |
| `--tv-header`, `--tv-sidebar`, `--tv-nav` | the three fixed chrome regions |
| `--tv-line`, `--tv-line-strong`, `--tv-line-soft` | borders, hairlines, the nesting rail |
| `--tv-ink`, `--tv-ink-2`, `--tv-ink-3`, `--tv-ink-4` | primary through muted text |
| `--tv-accent`, `--tv-accent-strong`, `--tv-accent-ink`, `--tv-accent-soft`, `--tv-accent-contrast` | the brand accent and its on-fill text |
| `--tv-pos`, `--tv-pos-soft` | profit, success, "on" state |
| `--tv-neg`, `--tv-neg-strong`, `--tv-neg-soft` | loss, danger, destructive |
| `--tv-warn`, `--tv-warn-soft` | warnings and advisories |
| `--tv-overlay` | modal and sheet scrims |
| `--tv-grid`, `--tv-scrollbar-*` | chart gridlines and scrollbars |

They reach Tailwind through an `@theme inline` block. `inline` matters: it
makes Tailwind emit `var(--tv-*)` inside each utility instead of copying
the value, which is what lets a theme switch restyle the running app.

## 3. Usage

```tsx
<div className="rounded-2xl border border-line bg-surface p-4 text-ink-2">
  <button className="bg-accent-strong text-accent-contrast">Save</button>
  <span className="text-pos">+12.40</span>
  <span className="text-warn">1 wake/min</span>
</div>
```

* Text on a saturated fill uses `text-accent-contrast`, never `text-ink`.
  `text-ink` is near-white in dark mode and near-black in light mode, so it
  would be unreadable on a filled button in light mode.
* Muted text uses `--tv-ink-3` / `--tv-ink-4`, which stay legible in both
  palettes.

## 4. Resolution and persistence

| Situation | Theme |
| --------- | ----- |
| A stored choice exists | that choice, always |
| No stored choice, OS prefers dark | dark |
| No stored choice, OS prefers light | light |
| No stored choice, OS preference unknown | dark |
| Storage unavailable | resolved, not persisted; the app still works |

`resolveInitialTheme(storage, prefersDark)` is a pure function and is
tested for each row above, including a throwing store.

While the user has made no explicit choice, the app follows live OS
changes. Once a choice is stored it is authoritative and the OS listener is
detached.

The attribute is applied in `main.tsx` before the first paint, so the shell
never flashes the wrong palette.

## 5. Canvas surfaces

The TradingView chart is drawn on a canvas and cannot use CSS classes. It
reads the same tokens through `readChartPalette()`
(`src/services/theme/chartTheme.ts`) and re-applies them in place on a theme
change, so pan, zoom, and loaded history survive the switch.

## 6. Files

| File | Role |
| ---- | ---- |
| `src/index.css` | the two palettes and the Tailwind bridge |
| `src/services/theme/theme.ts` | resolution, persistence, the `data-theme` attribute |
| `src/services/theme/ThemeProvider.tsx` | `ThemeProvider` and `useTheme` |
| `src/services/theme/chartTheme.ts` | canvas palette reader |
| `src/services/theme/tests.ts` | resolution, persistence, tokens, and the no-hardcoded-colour guard |
| `src/components/navigation/MobileHeader.tsx` | the compact toggle |
