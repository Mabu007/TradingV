/**
 * Navigation actions.
 *
 * The copilot may offer to move the user around the product. These are
 * **UI actions only** - there is no financial action in this file, and
 * nothing here can place, modify, or close a trade.
 *
 * The model returns an action as a fenced marker; `parseNavigationAction`
 * turns it into a typed object the UI renders as a button. Unparseable or
 * out-of-scope markers are dropped, so a hallucinated action can never
 * reach a handler.
 */

export type NavigationTarget =
  | 'TRADES'
  | 'GOATS'
  | 'QUOTES'
  | 'HISTORY'
  | 'SETTINGS'
  | 'CREATE_GOAT'
  | 'INSPECT_TRACKERS'
  | 'INSPECT_THESIS';

export interface NavigationAction {
  target: NavigationTarget;
  label: string;
}

const ACTIONS: Record<NavigationTarget, string> = {
  TRADES: 'Open Trades',
  GOATS: 'Open GOATs',
  QUOTES: 'Open Quotes',
  HISTORY: 'Open History',
  SETTINGS: 'Open Settings',
  CREATE_GOAT: 'Create GOAT',
  INSPECT_TRACKERS: 'Inspect Trackers',
  INSPECT_THESIS: 'Inspect Thesis',
};

export const NAVIGATION_ACTIONS = ACTIONS;

/**
 * Extract a navigation action from an assistant message.
 *
 * Accepts `[[action:OPEN_GOATS]]` and `[[action:OPEN_GOATS|Open GOATs]]`.
 * Returns undefined for anything else, including a marker naming a
 * target that is not in the allow-list.
 */
export function parseNavigationAction(
  message: string,
): NavigationAction | undefined {
  const match = message.match(/\[\[\s*action:\s*([A-Z_]+)\s*(?:\|\s*([^\]]+?)\s*)?\]\]/);

  if (!match) return undefined;

  const target = match[1] as NavigationTarget;

  if (!(target in ACTIONS)) return undefined;

  return { target, label: match[2]?.trim() || ACTIONS[target] };
}

/** Remove the marker so the chat bubble shows clean prose. */
export function stripNavigationAction(message: string): string {
  return message.replace(/\s*\[\[\s*action:[^\]]*\]\]/g, '').trim();
}
