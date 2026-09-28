import {
  HyperliquidMarketDataAdapter,
  HyperliquidTransport,
} from './marketData';

/**
 * Discovery policy: a market the provider lists without a current price
 * must be discovered but never tradeable, never priced, and never
 * executable.
 *
 * The fixture reproduces the real response shape, including a
 * null-price market of the kind Hyperliquid publishes for unlisted
 * markets in a HIP-3 namespace.
 */

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

const xyzMeta = {
  universe: [
    { name: 'xyz:EUR', szDecimals: 1, maxLeverage: 50 },
    { name: 'xyz:GOLD', szDecimals: 4, maxLeverage: 25 },
  ],
};

const xyzContexts = [
  { midPx: '1.13745', markPx: '1.1374', oraclePx: '1.1369' },
  { midPx: '4143.15', markPx: '4143.1', oraclePx: '4140.3' },
];

const mktsMeta = {
  universe: [
    { name: 'mkts:GOLD', szDecimals: 4, maxLeverage: 25 },
    { name: 'mkts:US500', szDecimals: 3, maxLeverage: 25 },
  ],
};

const mktsContexts = [
  // Listed, but the provider publishes no price for it.
  { midPx: null, markPx: null, oraclePx: '4348.8' },
  { midPx: '767.085', markPx: '767.13', oraclePx: '767.13' },
];

function fixtureTransport(): HyperliquidTransport {
  return {
    async request(body: Record<string, unknown>) {
      if (body.type === 'perpDexs') {
        return [
          { name: 'xyz' },
          { name: 'mkts' },
        ];
      }

      if (body.type === 'metaAndAssetCtxs') {
        if (body.dex === 'xyz') return [xyzMeta, xyzContexts];
        if (body.dex === 'mkts') return [mktsMeta, mktsContexts];
        return [{ universe: [] }, []];
      }

      throw new Error(
        `Unexpected info request: ${String(body.type)}`,
      );
    },
  };
}

export async function runHyperliquidDiscoveryPolicyTest(): Promise<void> {
  const adapter = new HyperliquidMarketDataAdapter(
    'mainnet',
    fixtureTransport(),
  );

  const active = await adapter.getInstruments();
  const discovered = await adapter.getDiscoveredInstruments();

  const labels = active.map((instrument) => instrument.symbol);

  assert(
    labels.includes('EUR/USD') && labels.includes('Gold (xyz)'),
    'markets with a price stay in the active trading universe',
  );

  assert(
    labels.includes('US 500'),
    'a priced market in a second namespace stays active',
  );

  assert(
    !labels.some((label) => label.startsWith('Gold (mkts)')),
    'a market without a price is excluded from the active universe',
  );

  assert(
    active.length === 3,
    `the active universe contains only priced markets (got ${active.length})`,
  );

  assert(
    discovered.length === 4,
    `every listed market is still discovered (got ${discovered.length})`,
  );

  const unavailable = discovered.find(
    (instrument) =>
      instrument.providerSymbol.toLowerCase() === 'mkts:gold',
  );

  assert(
    unavailable?.availability === 'UNAVAILABLE',
    'the null-price market is marked unavailable',
  );

  assert(
    Boolean(unavailable?.unavailableReason),
    'an unavailable market explains itself',
  );

  assert(
    unavailable?.market === undefined,
    'an unavailable market carries no price snapshot',
  );

  /*
   * Both spellings must resolve to the same market so the two HIP-3
   * namespaces stay distinguishable.
   */
  assert(
    discovered.some(
      (instrument) => instrument.symbol === 'Gold (mkts)',
    ),
    'a colliding label is namespaced rather than merged',
  );

  assert(
    adapter.getInstrument('Gold (xyz)')?.providerSymbol === 'xyz:GOLD',
    'the priced Gold market still resolves for execution',
  );

  assert(
    adapter.getInstrument('Gold (mkts)') === undefined,
    'the unavailable market does not resolve for execution or risk',
  );

  const status = await adapter.getMarketStatus('Gold (mkts)');
  assert(
    status.availability === 'UNAVAILABLE',
    'the market status API reports it unavailable',
  );
  assert(
    Boolean(status.reason),
    'the market status API explains why',
  );

  assert(
    (await adapter.getMarketStatus('Gold (xyz)')).availability ===
      'TRADEABLE',
    'a priced market reports as tradeable',
  );

  console.log(
    'Hyperliquid discovery availability policy test passed.',
  );
}

if (import.meta.main) {
  await runHyperliquidDiscoveryPolicyTest();
}
