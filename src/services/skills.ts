import { AISkill } from '../types/trading';

export const DEFAULT_AI_SKILLS: AISkill[] = [
  {
    id: 'trend-following',
    name: 'Trend Following',
    description: 'Rules for identifying directional momentum, EMA trend filters, and higher timeframe alignments.',
    category: 'Strategy',
    enabled: true,
    instructions:
      'Always confirm trend direction using a higher timeframe EMA (e.g. 50 or 200 EMA). Never take counter-trend signals unless a major reversal divergence is confirmed.',
    examples: ['50/200 EMA Golden Cross', 'Supertrend Trend Rider'],
  },
  {
    id: 'mean-reversion',
    name: 'Mean Reversion',
    description: 'Statistical boundaries using Bollinger Bands, RSI extremes, and z-score oscillation to fade overextended moves.',
    category: 'Strategy',
    enabled: true,
    instructions:
      'Enter when price touches or pierces outer Bollinger Bands while RSI shows extreme conditions (< 30 or > 70). Exit targeting the 20-period moving average middle band.',
    examples: ['Bollinger Band Fade', 'RSI Extreme Reversion'],
  },
  {
    id: 'breakout-trading',
    name: 'Breakout Trading',
    description: 'Detecting range expansions, Donchian channels, and London open volatility expansions.',
    category: 'Strategy',
    enabled: true,
    instructions:
      'Establish a consolidation high and low over the lookback window. Enter in the direction of the break with stop loss placed at the mid-range or opposite boundary.',
    examples: ['London Session Breakout', '20-bar Donchian Break'],
  },
  {
    id: 'market-structure',
    name: 'Market Structure',
    description: 'Tracking Higher Highs, Higher Lows, Lower Lows, and Breaks of Structure (BOS / CHoCH).',
    category: 'Strategy',
    enabled: true,
    instructions:
      'Identify swing highs and swing lows using local fractal pivot points. Confirm trend continuation only when a previous swing high is broken by candle close.',
    examples: ['Fractal Swing Structure', 'Break of Structure (BOS)'],
  },
  {
    id: 'candlestick-patterns',
    name: 'Candlestick Patterns',
    description: 'Recognizing bullish/bearish engulfing candles, pin bars, inside bars, and hammer formations.',
    category: 'Indicator',
    enabled: true,
    instructions:
      'Check for pin-bar wicks that are at least 2.5x the body size at key support/resistance levels. Require confirmation on the subsequent bar.',
    examples: ['Pin Bar Rejection', 'Engulfing Momentum'],
  },
  {
    id: 'moving-averages',
    name: 'Moving Averages',
    description: 'Mathematical smoothing with SMA and EMA crossovers, ribbons, and slope momentum.',
    category: 'Indicator',
    enabled: true,
    instructions:
      'Pair a fast moving average (e.g. 10 or 20) with a slow moving average (e.g. 30 or 50). Only trigger on the initial crossover bar to prevent repeated entries.',
    examples: ['SMA 10/30 Crossover', 'Triple EMA Ribbon'],
  },
  {
    id: 'rsi',
    name: 'RSI (Relative Strength Index)',
    description: 'Wilders 14-period momentum oscillator, divergence identification, and center-line 50 trend confirmation.',
    category: 'Indicator',
    enabled: true,
    instructions:
      'Use the 50 level as a trend filter: only permit long trades when RSI > 50, and only short trades when RSI < 50. Use 70 and 30 for overbought/oversold boundaries.',
    examples: ['RSI Center-Line Filter', 'RSI Divergence'],
  },
  {
    id: 'position-sizing',
    name: 'Position Sizing',
    description: 'Calculating volume based on fixed account risk percentage (e.g. 1% risk per trade).',
    category: 'Risk',
    enabled: true,
    instructions:
      'Size every position in the instrument\'s own units: volume = (equity * riskPercent) / (entry - stop). Use pips only for a pip-quoted Forex pair. Never risk more than 1.5% of total equity on any single trade.',
    examples: ['Fixed 1% Risk Sizer', 'Volatility-adjusted Sizing'],
  },
  {
    id: 'risk-management',
    name: 'Risk Management',
    description: 'Strict Take-Profit, Stop-Loss, Trailing Stops, and Breakeven triggers.',
    category: 'Risk',
    enabled: true,
    instructions:
      'Ensure every trade carries a mandatory stop loss before sending the order. Minimum risk-to-reward ratio must be 1:1.5.',
    examples: ['ATR Dynamic Stop Loss', 'Breakeven Trailing'],
  },
  {
    id: 'backtesting',
    name: 'Backtesting Rigor',
    description: 'Techniques to prevent overfitting, curve-fitting, look-ahead bias, and unrealistic fill assumptions.',
    category: 'Strategy',
    enabled: true,
    instructions:
      'Account for real spread and slippage on every simulated execution. Do not use future bar values in current bar signal evaluation.',
    examples: ['Non-Repainting Logic', 'Spread & Slippage Buffer'],
  },
  {
    id: 'london-session',
    name: 'London Session',
    description: 'Trading the high-liquidity London open (08:00–16:30 UTC), Asian range sweeps, and breakout continuation.',
    category: 'Session',
    enabled: true,
    instructions:
      'Monitor the high and low of the Asian session (00:00–07:00 UTC). Look for a liquidity run beyond the Asian high/low followed by reversal or continuation into London.',
    examples: ['London Open Breakout', 'Asian Range Sweep'],
  },
  {
    id: 'new-york-session',
    name: 'New York Session',
    description: 'Capitalizing on US market opening volatility (13:00–21:00 UTC) and London/NY session overlap.',
    category: 'Session',
    enabled: true,
    instructions:
      'Focus trades during the 13:00 to 17:00 UTC window where European and American liquidity overlaps for maximum momentum and tightest spreads.',
    examples: ['NY Open Expansion', 'London Close Reversal'],
  },
];
