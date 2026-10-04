import { Strategy } from '../types/trading';

export const SAMPLE_STRATEGIES: Strategy[] = [
  {
    id: 'ma-crossover-rsi',
    name: 'MA Crossover + RSI Filter',
    description: '10/30 SMA trend crossover with RSI 14 momentum filter and 1:2 risk-reward brackets.',
    symbol: 'EUR/USD',
    timeframe: '5m',
    category: 'Trend',
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now(),
    code: `import { TradingContext } from './types';

/**
 * TradingGOATs Moving Average Crossover with RSI Momentum Filter
 * Executes on EUR/USD 5m candles.
 */
export default async function strategy(ctx: TradingContext) {
  const symbol = "EUR/USD";
  const bars = await ctx.market.bars({ symbol, timeframe: "5m", limit: 120 });
  
  // Guard against insufficient warm-up history
  if (bars.length < 50) return;

  const closes = bars.map(b => b.close);
  const fast = ctx.indicators.sma(closes, 10);
  const slow = ctx.indicators.sma(closes, 30);
  const rsi = ctx.indicators.rsi(closes, 14);

  const fastNow = fast.at(-1)!;
  const fastPrev = fast.at(-2)!;
  const slowNow = slow.at(-1)!;
  const slowPrev = slow.at(-2)!;
  const rsiNow = rsi.at(-1)!;
  const currentBar = bars.at(-1)!;

  const positions = ctx.account.positions(symbol);

  // Bullish Condition: Fast crosses above Slow and RSI > 52
  const isGoldenCross = fastPrev <= slowPrev && fastNow > slowNow;
  if (isGoldenCross && rsiNow > 52 && positions.length === 0) {
    const sl = Number((currentBar.close - 0.0025).toFixed(5)); // 25 pips SL
    const tp = Number((currentBar.close + 0.0050).toFixed(5)); // 50 pips TP

    ctx.signal({
      symbol,
      side: "BUY",
      timestamp: currentBar.time,
      price: currentBar.close,
      title: "Bullish SMA Cross + RSI",
      reason: \`SMA 10 crossed above SMA 30. RSI at \${rsiNow.toFixed(1)}\`,
      confidence: 0.84
    });

    ctx.log(\`Bullish signal triggered @ \${currentBar.close} | RSI: \${rsiNow.toFixed(1)}\`);
    await ctx.orders.market({
      symbol,
      side: "BUY",
      volume: 10000,
      stopLoss: sl,
      takeProfit: tp
    });
  }

  // Bearish Condition: Fast crosses below Slow and RSI < 48
  const isDeathCross = fastPrev >= slowPrev && fastNow < slowNow;
  if (isDeathCross && rsiNow < 48 && positions.length === 0) {
    const sl = Number((currentBar.close + 0.0025).toFixed(5)); // 25 pips SL
    const tp = Number((currentBar.close - 0.0050).toFixed(5)); // 50 pips TP

    ctx.signal({
      symbol,
      side: "SELL",
      timestamp: currentBar.time,
      price: currentBar.close,
      title: "Bearish SMA Cross + RSI",
      reason: \`SMA 10 crossed below SMA 30. RSI at \${rsiNow.toFixed(1)}\`,
      confidence: 0.81
    });

    ctx.log(\`Bearish signal triggered @ \${currentBar.close} | RSI: \${rsiNow.toFixed(1)}\`);
    await ctx.orders.market({
      symbol,
      side: "SELL",
      volume: 10000,
      stopLoss: sl,
      takeProfit: tp
    });
  }
}
`,
  },
  {
    id: 'london-breakout',
    name: 'London Breakout Engine',
    description: 'High-momentum Donchian channel expansion system targeting range volatility expansions.',
    symbol: 'GBP/USD',
    timeframe: '15m',
    category: 'Breakout',
    createdAt: Date.now() - 86400000 * 5,
    updatedAt: Date.now() - 86400000,
    code: `import { TradingContext } from './types';

export default async function strategy(ctx: TradingContext) {
  const symbol = "GBP/USD";
  const bars = await ctx.market.bars({ symbol, timeframe: "15m", limit: 60 });
  if (bars.length < 30) return;

  const lookback = 20;
  const recentBars = bars.slice(-lookback - 1, -1);
  const highestHigh = Math.max(...recentBars.map(b => b.high));
  const lowestLow = Math.min(...recentBars.map(b => b.low));
  
  const currentBar = bars.at(-1)!;
  const positions = ctx.account.positions(symbol);

  if (currentBar.close > highestHigh && positions.length === 0) {
    const sl = lowestLow;
    const risk = currentBar.close - sl;
    const tp = Number((currentBar.close + risk * 1.6).toFixed(5));

    ctx.signal({
      symbol,
      side: "BUY",
      timestamp: currentBar.time,
      price: currentBar.close,
      title: "London Breakout BUY",
      reason: \`Breakout above 20-bar high \${highestHigh.toFixed(5)}\`,
      confidence: 0.87
    });

    await ctx.orders.market({
      symbol,
      side: "BUY",
      volume: 15000,
      stopLoss: sl,
      takeProfit: tp
    });
  }
}
`,
  },
  {
    id: 'mean-reversion-rsi',
    name: 'Mean Reversion Bollinger + RSI',
    description: 'Statistical mean reversion fading price extremes outside Bollinger Bands with oversold/overbought RSI.',
    symbol: 'EUR/USD',
    timeframe: '15m',
    category: 'Mean Reversion',
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now(),
    code: `import { TradingContext } from './types';

export default async function strategy(ctx: TradingContext) {
  const symbol = "EUR/USD";
  const bars = await ctx.market.bars({ symbol, timeframe: "15m", limit: 100 });
  if (bars.length < 35) return;

  const closes = bars.map(b => b.close);
  const bb = ctx.indicators.bollingerBands(closes, 20, 2);
  const rsi = ctx.indicators.rsi(closes, 14);

  const currentBar = bars.at(-1)!;
  const lowerBand = bb.lower.at(-1)!;
  const upperBand = bb.upper.at(-1)!;
  const midBand = bb.middle.at(-1)!;
  const rsiNow = rsi.at(-1)!;
  const positions = ctx.account.positions(symbol);

  // Long: price pierced below lower band and RSI < 32
  if (currentBar.low < lowerBand && rsiNow < 32 && positions.length === 0) {
    ctx.signal({
      symbol,
      side: "BUY",
      timestamp: currentBar.time,
      price: currentBar.close,
      title: "Mean Reversion BUY",
      reason: \`Pierced lower BB with oversold RSI \${rsiNow.toFixed(1)}\`,
      confidence: 0.79
    });

    await ctx.orders.market({
      symbol,
      side: "BUY",
      volume: 10000,
      stopLoss: Number((currentBar.close - 0.0020).toFixed(5)),
      takeProfit: Number(midBand.toFixed(5))
    });
  }
}
`,
  },
];
