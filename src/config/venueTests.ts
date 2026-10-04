/**
 * Tests for the canonical venue environment and the market-data lifecycle.
 *
 * Two claims are being defended here, and both are claims about failure
 * that is invisible when it happens:
 *
 *  1. One table decides where requests go, and the two environments can
 *     never be confused — including by a typo in that table.
 *  2. A feed that has gone quiet, or that replays an old candle, cannot
 *     present itself as live and current.
 */

import {
  ENDPOINT_KEYS_FOR_TEST,
  VENUE_ENVIRONMENTS,
  assertSameVenue,
  configuredVenue,
  describeVenue,
  isVenueEnvironment,
  parseVenueEnvironment,
  venueEndpoints,
  venueFor,
  type VenueEnvironment,
} from './venue';
import { eventBus } from '../types/events';
import {
  HyperliquidMarketDataAdapter,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STALE_AFTER_MS,
} from '../adapters/hyperliquid/marketData';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Waits without depending on a runtime-specific sleep. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** --- The venue table ------------------------------------------------------------ */

function runVenueTableTest(): void {
  assert(
    VENUE_ENVIRONMENTS.length === 2,
    'the venue knows exactly two environments',
  );

  for (const environment of VENUE_ENVIRONMENTS) {
    const endpoints = venueEndpoints(environment);
    for (const key of ENDPOINT_KEYS_FOR_TEST) {
      assert(
        typeof endpoints[key] === 'string' && endpoints[key].length > 0,
        `${environment} has a ${key}`,
      );
    }
    assert(
      endpoints.restInfoUrl.startsWith('https://'),
      `${environment} uses https for REST`,
    );
    assert(
      endpoints.websocketUrl.startsWith('wss://'),
      `${environment} uses an encrypted WebSocket`,
    );
  }

  /*
   * The REST host and the WebSocket host are two separate strings, so a
   * copy-paste that updates one and not the other is possible. This is
   * the check that catches it: a single environment must never point at
   * two different hosts.
   */
  for (const environment of VENUE_ENVIRONMENTS) {
    const endpoints = venueEndpoints(environment);
    const restHost = new URL(endpoints.restInfoUrl).host;
    const socketHost = new URL(endpoints.websocketUrl).host;
    assert(
      restHost === socketHost,
      `${environment} REST and WebSocket resolve to the same host (${restHost} vs ${socketHost})`,
    );
    assert(
      restHost === endpoints.host,
      `${environment} reports the host it actually uses`,
    );
  }

  // And the environments must not share a host, in either direction.
  const [testnet, mainnet] = VENUE_ENVIRONMENTS;
  assert(
    venueEndpoints(testnet).host !== venueEndpoints(mainnet).host,
    'the two environments are distinct hosts',
  );
  /*
   * The two hosts share a stem, so the only thing separating them is a
   * suffix. That makes a copy-paste that keeps the stem and drops or
   * swaps the suffix the realistic mistake, and it is the one that would
   * point Testnet at Mainnet.
   */
  assert(
    !venueEndpoints(testnet).host.includes('hyperliquid.xyz'),
    'the testnet host does not mention the mainnet host',
  );
  assert(
    !venueEndpoints(mainnet).host.includes('testnet'),
    'the mainnet host does not mention testnet',
  );

  // An unknown environment is a thrown error, never a default.
  let threw = false;
  try {
    venueEndpoints('STAGING' as VenueEnvironment);
  } catch {
    threw = true;
  }
  assert(threw, 'an unrecognised environment throws instead of falling back');
}

/** --- Parsing and liveness -------------------------------------------------------- */

function runVenueParsingTest(): void {
  assert(isVenueEnvironment('MAINNET'), 'MAINNET is an environment');
  assert(isVenueEnvironment('TESTNET'), 'TESTNET is an environment');
  assert(!isVenueEnvironment('mainnet'), 'a lowercase value is not accepted silently');
  assert(!isVenueEnvironment('DEMO'), 'DEMO is not an environment');
  assert(!isVenueEnvironment(undefined), 'undefined is not an environment');

  // Case and whitespace from an env file are tolerated at the boundary.
  assert(parseVenueEnvironment('TESTNET') === 'TESTNET', 'an exact value parses');
  assert(parseVenueEnvironment('testnet') === 'TESTNET', 'a lowercase value is upper-cased');
  assert(parseVenueEnvironment('  mainnet ') === 'MAINNET', 'surrounding whitespace is ignored');

  // Anything unrecognised resolves to Mainnet, and says so.
  assert(parseVenueEnvironment(undefined) === 'MAINNET', 'unset resolves to Mainnet');
  assert(parseVenueEnvironment('nonsense') === 'MAINNET', 'an unknown value resolves to Mainnet');

  assert(venueFor('MAINNET').isLive === true, 'Mainnet is live');
  assert(venueFor('TESTNET').isLive === false, 'Testnet is not live');
  assert(
    configuredVenue().isLive === true,
    'the default venue is live and reported as such',
  );

  assert(
    describeVenue('TESTNET').includes('no real value'),
    'the testnet description says plainly that no value is at stake',
  );
  assert(
    describeVenue('MAINNET').includes('real value'),
    'the mainnet description says plainly that value is at stake',
  );
}

/** --- Refusing to act across environments ---------------------------------------- */

function runVenueMismatchTest(): void {
  assertSameVenue('TESTNET', 'TESTNET', 'test');

  let message = '';
  try {
    assertSameVenue('TESTNET', 'MAINNET', 'deploying BTC-1h');
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message.length > 0, 'a mismatch throws');
  assert(
    message.includes('TESTNET') && message.includes('MAINNET'),
    'the refusal names both environments, so the cause is diagnosable',
  );
  assert(
    message.includes('deploying BTC-1h'),
    'the refusal names what was being attempted',
  );
  assert(
    !message.includes('undefined'),
    'the refusal contains no unfilled values',
  );
}

/** --- A websocket that the test drives by hand ----------------------------------- */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(message: string): void {
    this.sent.push(message);
  }

  sent: string[] = [];

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

/**
 * Installs a fake WebSocket for the duration of an async body.
 *
 * Awaited, and that is the whole point: an unawaited version restores the
 * real `WebSocket` at the first `await` inside the body, so the code under
 * test resumes against a global that has already changed underneath it.
 * Every failure that version produces looks like a defect in the code
 * under test rather than in the harness.
 */
async function withFakeWebSocket(body: () => Promise<void>): Promise<void> {
  const original = (globalThis as Record<string, unknown>).WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  try {
    await body();
  } finally {
    (globalThis as Record<string, unknown>).WebSocket = original;
  }
}

/** --- Reconnect ------------------------------------------------------------------ */

async function runReconnectTest(): Promise<void> {
  assert(
    RECONNECT_MAX_MS >= RECONNECT_BASE_MS,
    'the backoff ceiling is not below its floor',
  );
  assert(
    RECONNECT_MAX_MS < 60_000,
    'the backoff ceiling stays inside a range a user can wait through',
  );

  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');
    const statuses: string[] = [];
    adapter.onStatusChange((status) => statuses.push(status));

    const connecting = adapter.connect();
    assert(
      FakeWebSocket.instances.length === 1,
      'the first connect opens exactly one socket',
    );
    FakeWebSocket.instances[0].open();
    await connecting;
    assert(
      statuses.includes('CONNECTED'),
      'opening the socket reports CONNECTED',
    );

    // The venue drops the connection without being asked to.
    FakeWebSocket.instances[0].close();
    assert(
      statuses.includes('RECONNECTING'),
      'an unexpected close schedules a reconnect rather than going quiet',
    );
    assert(
      !statuses.includes('DISCONNECTED'),
      'an unexpected close is not reported as a deliberate disconnect',
    );

    await wait(RECONNECT_BASE_MS + 400);
    const socketsAfterDrop: number = FakeWebSocket.instances.length;
    assert(socketsAfterDrop === 2, 'the reconnect opens a new socket');

    // A deliberate disconnect must not be retried.
    await adapter.disconnect();
    const countAfterDisconnect = FakeWebSocket.instances.length;
    await wait(RECONNECT_BASE_MS + 400);
    assert(
      FakeWebSocket.instances.length === countAfterDisconnect,
      'a deliberate disconnect is not retried',
    );
    assert(
      statuses[statuses.length - 1] === 'DISCONNECTED',
      'a deliberate disconnect reports DISCONNECTED',
    );
  });
}

/** --- Subscriptions survive a reconnect ------------------------------------------ */

async function runResubscribeTest(): Promise<void> {
  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');

    // Subscribe before the socket opens, which is the case a reconnect
    // has to remember.
    const unsubscribeQuote = adapter.subscribeQuote('BTC', () => undefined);
    const unsubscribeBars = adapter.subscribeBars('BTC', '1m', () => undefined);
    const first = adapter.connect();
    FakeWebSocket.instances[0].open();
    await first;

    const sentBeforeDrop: number = FakeWebSocket.instances[0].sent.length;
    assert(sentBeforeDrop === 2, 'both subscriptions are sent once the socket is open');

    // The venue drops the connection without being asked to.
    FakeWebSocket.instances[0].close();
    await wait(RECONNECT_BASE_MS + 400);
    const second = FakeWebSocket.instances[1];
    assert(second !== undefined, 'a new socket was opened for the reconnect');
    second.open();

    const sentAfterReconnect: number = second.sent.length;
    assert(
      sentAfterReconnect === sentBeforeDrop,
      `a reconnecting socket replays every subscription (sent ${sentAfterReconnect})`,
    );
    assert(
      second.sent.every((message) => JSON.parse(message).method === 'subscribe'),
      'the replayed messages are subscriptions and nothing else',
    );

    unsubscribeQuote();
    unsubscribeBars();
    await adapter.disconnect();
  });
}

/** --- Staleness ------------------------------------------------------------------- */

async function runStaleTest(): Promise<void> {
  assert(
    STALE_AFTER_MS > 0,
    'the staleness window is a real duration',
  );
  assert(
    STALE_AFTER_MS < 5 * 60_000,
    'the staleness window is short enough to be worth reporting',
  );

  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');
    const statuses: string[] = [];
    adapter.onStatusChange((status) => statuses.push(status));

    const connecting = adapter.connect();
    FakeWebSocket.instances[0].open();
    await connecting;

    assert(
      adapter.getConnectionState().isConnected === true,
      'a fresh socket reports connected',
    );
    assert(
      adapter.getConnectionState().isStale === false,
      'a fresh socket is not stale',
    );

    // Move the silence clock past the window without waiting for it.
    (adapter as unknown as { lastMessageAt?: number }).lastMessageAt =
      Date.now() - STALE_AFTER_MS - 1;

    const state = adapter.getConnectionState();
    assert(
      state.isStale === true,
      'a silent socket is reported stale',
    );
    assert(
      state.isConnected === true,
      'staleness does not pretend the socket is closed',
    );
    assert(
      (state.silenceMs ?? 0) > STALE_AFTER_MS,
      'the state reports how long the venue has been silent',
    );
    assert(
      state.environment === 'TESTNET',
      'the state names the environment the client is bound to',
    );
    assert(
      state.venue === 'api.hyperliquid-testnet.xyz',
      'the state names the host requests are going to',
    );

    // A message clears it.
    FakeWebSocket.instances[0].deliver({
      channel: 'candle',
      data: { t: 1700000000000, s: 'BTC', i: '1m', o: '1', c: '2', h: '3', l: '0.5', v: '10', n: 1, T: 1700000060000 },
    });
    assert(
      adapter.getConnectionState().isStale === false,
      'a message from the venue clears staleness',
    );

    await adapter.disconnect();
    assert(
      adapter.getConnectionState().isConnected === false,
      'a disconnected client does not report connected',
    );
    assert(
      adapter.getConnectionState().lastMessageAt === undefined,
      'a disconnected client reports no last message rather than a stale one',
    );
  });
}

/** --- Out-of-order and duplicate candles ------------------------------------------ */

function runOrderingTest(): void {
  const adapter = new HyperliquidMarketDataAdapter('TESTNET');

  const candle = (n: number, T: number) => ({
    t: T - 60_000,
    s: 'BTC',
    i: '1m',
    o: '100',
    c: '101',
    h: '102',
    l: '99',
    v: '10',
    n,
    T,
  });

  const barTimes: number[] = [];
  const unsubscribe = eventBus.on('BAR_UPDATE', (event) => {
    if (event.bar && typeof event.bar.time === 'number') barTimes.push(event.bar.time);
  });

  adapter.ingestCandleFixture(candle(10, 1_700_000_060_000) as never);
  adapter.ingestCandleFixture(candle(10, 1_700_000_060_000) as never); // duplicate
  adapter.ingestCandleFixture(candle(9, 1_700_000_000_000) as never); // older
  adapter.ingestCandleFixture(candle(11, 1_700_000_120_000) as never); // newer

  assert(
    barTimes.length === 2,
    `a duplicate and an out-of-order candle are dropped (saw ${barTimes.length})`,
  );
  assert(
    barTimes[0] < barTimes[1],
    'the accepted candles are in ascending order',
  );

  unsubscribe();

  // A malformed message produces nothing at all.
  const before = barTimes.length;
  adapter.ingestCandleFixture({ s: 42 } as never);
  adapter.ingestCandleFixture({ s: 'BTC' } as never);
  assert(
    barTimes.length === before,
    'a malformed candle produces no event rather than a plausible one',
  );
}

/** --- Switching environment ------------------------------------------------------ */

async function runEnvironmentSwitchTest(): Promise<void> {
  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');

    const connecting = adapter.connect();
    FakeWebSocket.instances[0].open();
    await connecting;

    const bound: string = adapter.environment;
    assert(bound === 'TESTNET', 'the adapter reports the environment it is bound to');
    assert(
      adapter.venueConfig.restInfoUrl.includes('hyperliquid-testnet'),
      'a testnet client resolves the testnet REST host',
    );

    await adapter.setEnvironment('MAINNET');

    const rebound: string = adapter.environment;
    assert(rebound === 'MAINNET', 'the adapter follows the environment change');
    assert(
      adapter.venueConfig.restInfoUrl.includes('api.hyperliquid.xyz'),
      'a mainnet client resolves the mainnet REST host',
    );
    assert(
      !adapter.venueConfig.restInfoUrl.includes('testnet'),
      'no testnet host survives an environment change',
    );
    const oldSocketClosed: boolean = FakeWebSocket.instances[0].closed;
    assert(oldSocketClosed, 'the old socket is closed when the environment changes');

    // Changing to the environment already in use is a no-op.
    await adapter.setEnvironment('MAINNET');
    const socketCount: number = FakeWebSocket.instances.length;
    assert(socketCount === 1, 'setting the same environment opens no new socket');
  });
}

/**
 * A deliberate disconnect during a handshake.
 *
 * The failure this defends against is the awkward one: the user closes
 * the connection, the socket that was still opening finishes opening
 * anyway, and the app is left showing a live feed nobody asked for — plus
 * an error, five seconds later, for a connection that was already gone.
 */
async function runDisconnectDuringHandshakeTest(): Promise<void> {
  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');
    const statuses: string[] = [];
    adapter.onStatusChange((status) => statuses.push(status));

    // Start a handshake and walk away before it finishes.
    const inFlight = adapter.connect();
    await adapter.disconnect();
    FakeWebSocket.instances[0].open();
    await inFlight;

    assert(
      adapter.getConnectionState().isConnected === false,
      'a socket that opens after a deliberate disconnect does not count as connected',
    );
    assert(
      !statuses.includes('ERROR'),
      `no error is reported for a connection the user closed (saw ${statuses.join(', ')})`,
    );
    assert(
      statuses.filter((status) => status === 'DISCONNECTED').length === 1,
      'a deliberate disconnect reports itself exactly once',
    );

    // And the socket the user opened must not deliver into the adapter.
    const bars: unknown[] = [];
    adapter.subscribeBars('BTC', '1m', (bar) => bars.push(bar));
    FakeWebSocket.instances[0].deliver({
      channel: 'candle',
      data: { t: 1700000000000, s: 'BTC', i: '1m', o: '1', c: '2', h: '3', l: '0.5', v: '10', n: 1, T: 1700000060000 },
    });
    assert(
      bars.length === 0,
      'a superseded socket cannot deliver bars into a disconnected client',
    );
    assert(
      adapter.getConnectionState().lastMessageAt === undefined,
      'a superseded socket cannot restart the silence clock',
    );

    await adapter.disconnect();
  });
}

/**
 * A deliberate disconnect must not be undone by a reconnect that was
 * already scheduled when the user asked to close.
 */
async function runDisconnectDuringBackoffTest(): Promise<void> {
  await withFakeWebSocket(async () => {
    const adapter = new HyperliquidMarketDataAdapter('TESTNET');

    const connecting = adapter.connect();
    FakeWebSocket.instances[0].open();
    await connecting;

    // Drop into the backoff window, then close deliberately.
    FakeWebSocket.instances[0].close();
    assert(
      adapter.getConnectionState().reconnectAttempts === 1,
      'the drop scheduled a retry',
    );
    await adapter.disconnect();

    await wait(RECONNECT_BASE_MS + 400);
    assert(
      FakeWebSocket.instances.length === 1,
      'a reconnect that was already scheduled does not fire after a deliberate disconnect',
    );
  });
}

if (import.meta.main) {
  runVenueTableTest();
  runVenueParsingTest();
  runVenueMismatchTest();
  await runReconnectTest();
  await runResubscribeTest();
  await runStaleTest();
  runOrderingTest();
  await runEnvironmentSwitchTest();
  await runDisconnectDuringHandshakeTest();
  await runDisconnectDuringBackoffTest();
  console.log('Venue environment, feed lifecycle, and ordering tests passed.');
}