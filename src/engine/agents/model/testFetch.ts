/**
 * A `fetch` that records what it was asked to send and answers with
 * whatever the test says.
 *
 * The point of stubbing here rather than the model is that the real
 * adapter has to build the real request. Every defect this file's tests
 * exist for lived between the prompt and the wire.
 */

export interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const calls: CapturedCall[] = [];
let realFetch: typeof globalThis.fetch | undefined;

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = (init?.headers ?? {}) as Record<string, string>;
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) record[key] = value;
  return record;
}

/**
 * Install the stub.
 *
 * `reply` is the assistant message content the fake API returns; pass
 * `status` to simulate a failure. A non-2xx status with an empty body is
 * the shape the provider classifies, so error paths are exercised through
 * the same code a real 401 would take.
 */
export function installFetchStub(
  reply: string,
  options: { status?: number } = {},
): void {
  restoreFetch();

  realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord(init),
      body: String(init?.body ?? ''),
    });

    const status = options.status ?? 200;

    if (status >= 400) {
      return new Response(JSON.stringify({ error: { message: 'stubbed failure', code: status } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'gen-stub',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: reply } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
}

/** Everything captured so far, newest last. */
export function capturedCalls(): CapturedCall[] {
  return calls.slice();
}

/** The most recent captured request, or undefined. */
export function lastCall(): CapturedCall | undefined {
  return calls[calls.length - 1];
}

/** Clear the record without uninstalling the stub. */
export function resetCallCapture(): CapturedCall[] {
  return calls.slice();
}

export function restoreFetch(): void {
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = undefined;
  }
  calls.length = 0;
}
