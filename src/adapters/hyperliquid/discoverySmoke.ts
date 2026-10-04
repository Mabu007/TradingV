import { HyperliquidMarketDataAdapter } from './marketData';
import { AssetClass } from '../../types/instruments';

const classes: AssetClass[] = ['FOREX', 'COMMODITY', 'INDEX'];
const adapter = new HyperliquidMarketDataAdapter('MAINNET');
const instruments = await adapter.getInstruments(classes);

for (const assetClass of classes) {
  const group = instruments.filter((instrument) => instrument.assetClass === assetClass);
  if (group.length === 0) throw new Error(`Hyperliquid discovery returned no ${assetClass} instruments.`);
  for (const instrument of group) {
    const quote = await adapter.getQuote(instrument.symbol);
    if (quote.symbol !== instrument.symbol || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
      throw new Error(`Invalid normalized quote for ${instrument.providerSymbol}.`);
    }
    if (!instrument.providerMarketId || !instrument.providerDex || instrument.pricePrecision === undefined || instrument.sizePrecision === undefined) {
      throw new Error(`Incomplete metadata for ${instrument.providerSymbol}.`);
    }
  }
}

for (const assetClass of classes) {
  let verified = false;
  for (const instrument of instruments.filter((candidate) => candidate.assetClass === assetClass)) {
    try {
      const bars = await adapter.getBars(instrument.symbol, '5m', 2);
      if (bars.length === 2 && bars.every((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))) {
        verified = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!verified) throw new Error(`No ${assetClass} instrument returned two valid 5m bars.`);
}

console.log(JSON.stringify(instruments.map(({ symbol, assetClass, providerSymbol, providerMarketId, providerDex, market }) => ({
  symbol, assetClass, providerSymbol, providerMarketId, providerDex, price: market?.lastPrice,
})), null, 2));
