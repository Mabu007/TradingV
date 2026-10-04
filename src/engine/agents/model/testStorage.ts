/**
 * A localStorage the provider can read its configuration from.
 *
 * `OpenRouterProvider` keeps its configuration in browser storage and
 * nowhere else, so a test that does not provide one sees a provider with no
 * key and concludes the model is unreachable. The key written here is a
 * shape, not a credential: it is never sent anywhere, because `fetch` is
 * stubbed for the whole run.
 */

export function installLocalStorage(): () => void {
  const values = new Map<string, string>();

  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  };

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  values.set(
    'tradingvibe_openrouter_config',
    JSON.stringify({ apiKey: 'sk-or-v1-testkeytestkeytestkey', model: 'openrouter/free' }),
  );

  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as Record<string, unknown>).localStorage;
  };
}
