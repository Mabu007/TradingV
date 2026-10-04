#!/usr/bin/env python3
"""One-off migration: hardcoded neutrals -> TradingV design tokens.

Mechanical and idempotent. Kept in the repo so the token map is
discoverable; it is not part of the build.
"""
import re
import sys

# (regex, replacement) applied in order. Colour utilities only.
RULES = [
    # --- surfaces -------------------------------------------------------
    (r'bg-\[#070b13\]', 'bg-bg'),
    (r'bg-\[#080d16\]', 'bg-bg-alt'),
    (r'bg-\[#090d14\]', 'bg-bg-alt'),
    (r'bg-\[#0a101d\]', 'bg-surface-2'),
    (r'bg-\[#0a0f18\]', 'bg-surface-2'),
    (r'bg-\[#0b1220\]', 'bg-surface'),
    (r'bg-\[#0c121e\]', 'bg-surface'),
    (r'bg-\[#0c1322\]', 'bg-surface'),
    (r'bg-\[#0f172a\]', 'bg-surface-2'),
    (r'bg-\[#111927\]', 'bg-surface-3'),
    (r'bg-\[#121c2e\]', 'bg-surface-3'),
    (r'bg-\[#131c2e\]', 'bg-surface-3'),
    (r'bg-\[#131d2e\]', 'bg-surface-3'),
    (r'bg-\[#1a2538\]', 'bg-surface-3'),
    (r'bg-\[#080d16\]', 'bg-bg-alt'),
    (r'bg-\[#0e1728\]', 'bg-surface'),
    (r'bg-\[#0b0f17\]', 'bg-bg'),
    # --- insets / inputs ------------------------------------------------
    (r'bg-\[#05080f\]', 'bg-inset'),
    (r'bg-\[#080d16\]', 'bg-inset'),
    # --- borders --------------------------------------------------------
    (r'border-\[#1e293b\]', 'border-line'),
    (r'border-\[#334155\]', 'border-line-strong'),
    (r'border-slate-600', 'border-line-strong'),
    (r'border-slate-700', 'border-line-strong'),
    (r'border-white/10', 'border-line-strong/50'),
    # --- text -----------------------------------------------------------
    (r'text-white', 'text-ink'),
    (r'text-slate-200', 'text-ink-2'),
    (r'text-slate-300', 'text-ink-2'),
    (r'text-slate-400', 'text-ink-3'),
    (r'text-slate-500', 'text-ink-4'),
    # --- neutral slate surfaces ----------------------------------------
    (r'bg-slate-800', 'bg-surface-3'),
    (r'bg-slate-700', 'bg-line-strong'),
    (r'bg-slate-900', 'bg-inset'),
    (r'bg-slate-100', 'bg-surface-3'),
    (r'border-slate-800', 'border-line'),
    # --- accent ---------------------------------------------------------
    (r'text-sky-500', 'text-accent'),
    (r'text-sky-400', 'text-accent'),
    (r'text-sky-300', 'text-accent-ink'),
    (r'text-sky-200', 'text-accent-ink'),
    (r'text-sky-100', 'text-accent-ink'),
    (r'bg-sky-500/15', 'bg-accent-soft'),
    (r'bg-sky-500/10', 'bg-accent-soft'),
    (r'bg-sky-950/30', 'bg-accent-soft'),
    (r'bg-sky-950/20', 'bg-accent-soft'),
    (r'bg-sky-950', 'bg-accent-soft'),
    (r'bg-sky-900', 'bg-accent-soft'),
    (r'border-sky-800', 'border-accent/30'),
    (r'border-sky-700', 'border-accent/30'),
    (r'border-sky-500', 'border-accent'),
    (r'border-sky-400', 'border-accent'),
    (r'bg-sky-600', 'bg-accent-strong'),
    (r'bg-sky-500', 'bg-accent'),
    (r'bg-sky-400', 'bg-accent'),
    (r'ring-sky-500', 'ring-accent'),
    (r'shadow-sky-900', 'shadow-accent'),
    (r'shadow-sky-800', 'shadow-accent'),
    (r'from-sky-500', 'from-accent'),
    (r'to-indigo-600', 'to-accent-strong'),
    # --- semantic status ------------------------------------------------
    (r'text-emerald-400', 'text-pos'),
    (r'text-emerald-300', 'text-pos'),
    (r'text-emerald-200', 'text-pos'),
    (r'text-emerald-950', 'text-pos'),
    (r'bg-emerald-950', 'bg-pos-soft'),
    (r'bg-emerald-500/10', 'bg-pos-soft'),
    (r'bg-emerald-500/15', 'bg-pos-soft'),
    (r'border-emerald-500/20', 'border-pos/40'),
    (r'border-emerald-500/30', 'border-pos/40'),
    (r'border-emerald-800/40', 'border-pos/40'),
    (r'border-emerald-700/50', 'border-pos/40'),
    (r'text-rose-400', 'text-neg'),
    (r'text-rose-300', 'text-neg'),
    (r'text-rose-500', 'text-neg'),
    (r'text-rose-600', 'text-neg'),
    (r'bg-rose-950', 'bg-neg-soft'),
    (r'bg-rose-600', 'bg-neg-strong'),
    (r'bg-rose-500', 'bg-neg-strong'),
    (r'bg-rose-900', 'bg-neg-soft'),
    (r'bg-rose-500/10', 'bg-neg-soft'),
    (r'bg-rose-500/15', 'bg-neg-soft'),
    (r'border-rose-500', 'border-neg/50'),
    (r'border-rose-900', 'border-neg/40'),
    (r'border-rose-800', 'border-neg/40'),
    (r'border-rose-700', 'border-neg/40'),
    (r'text-amber-400', 'text-warn'),
    (r'text-amber-300', 'text-warn'),
    (r'text-amber-200', 'text-warn'),
    (r'bg-amber-950', 'bg-warn-soft'),
    (r'bg-amber-500/10', 'bg-warn-soft'),
    (r'border-amber-500/20', 'border-warn/40'),
    (r'border-amber-800/40', 'border-warn/40'),
    (r'text-indigo-300', 'text-accent-ink'),
    (r'text-indigo-200', 'text-accent-ink'),
    (r'bg-indigo-600', 'bg-accent-strong'),
    (r'bg-indigo-950/20', 'bg-accent-soft'),
    (r'border-indigo-800/50', 'border-accent/30'),
    (r'border-indigo-500', 'border-accent'),
    # --- overlays -------------------------------------------------------
    (r'bg-black/60', 'bg-overlay'),
    (r'bg-black/70', 'bg-overlay'),
    (r'bg-black/85', 'bg-overlay'),
    (r'bg-black/80', 'bg-overlay'),
]

COMPILED = [(re.compile(pattern), replacement) for pattern, replacement in RULES]


def migrate(text: str) -> str:
    for pattern, replacement in COMPILED:
        text = pattern.sub(replacement, text)
    return text


def main(paths: list[str]) -> int:
    changed = 0
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            original = handle.read()
        updated = migrate(original)
        if updated != original:
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write(updated)
            changed += 1
            print(f'migrated {path}')
    print(f'{changed} file(s) changed')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
