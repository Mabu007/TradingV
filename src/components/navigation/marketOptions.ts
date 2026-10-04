/**
 * Market options for selection controls.
 *
 * Domain-neutral: this is the shape a picker needs, not a trading
 * concept. It used to live in a builder UI that no longer exists; the
 * helper is worth keeping, the screen around it was not.
 */

export interface BuilderMarket {
  id: string;
  label: string;
  group: string;
  tradeable: boolean;
  reason?: string;
}

const ASSET_CLASS_LABELS: Record<string, string> = {
  FOREX: 'Forex',
  COMMODITY: 'Commodities',
  INDEX: 'Indices',
  CRYPTO: 'Crypto',
};

export function marketsFromDiscovery(
  instruments: Array<{
    symbol: string;
    displayName?: string;
    assetClass: string;
    availability?: string;
    unavailableReason?: string;
  }>,
): BuilderMarket[] {
  return instruments
    .map((instrument) => ({
      id: instrument.symbol,
      label: instrument.displayName ?? instrument.symbol,
      group: ASSET_CLASS_LABELS[instrument.assetClass] ?? instrument.assetClass,
      tradeable: (instrument.availability ?? 'TRADEABLE') === 'TRADEABLE',
      reason: instrument.unavailableReason,
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/** Plain symbols, for controls that do not need grouping or availability. */
export function tradeableSymbols(
  instruments: Parameters<typeof marketsFromDiscovery>[0],
): string[] {
  return marketsFromDiscovery(instruments)
    .filter((market) => market.tradeable)
    .map((market) => market.id);
}
