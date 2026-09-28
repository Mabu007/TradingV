import React, { useState } from 'react';
import { BookOpen, Shield, Code, Server, Cpu, BarChart2 } from 'lucide-react';

export const DocsView: React.FC = () => {
  const [activeDoc, setActiveDoc] = useState<'sdk' | 'arch' | 'backtest' | 'hyperliquid' | 'security'>('sdk');

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#090d14] text-slate-200">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">TradingVibe Developer Documentation</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Specifications for the TypeScript Strategy SDK, Sandboxed Runtime, and Hyperliquid integration
            </p>
          </div>
        </div>

        {/* Doc Nav Tabs */}
        <div className="flex items-center gap-1.5 border-b border-[#1e293b] pb-2 text-xs">
          <button
            onClick={() => setActiveDoc('sdk')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
              activeDoc === 'sdk' ? 'bg-[#1e293b] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code className="w-3.5 h-3.5 text-sky-400" />
            <span>Strategy SDK</span>
          </button>

          <button
            onClick={() => setActiveDoc('arch')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
              activeDoc === 'arch' ? 'bg-[#1e293b] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            <span>Architecture</span>
          </button>

          <button
            onClick={() => setActiveDoc('backtest')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
              activeDoc === 'backtest' ? 'bg-[#1e293b] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Backtesting</span>
          </button>

          <button
            onClick={() => setActiveDoc('hyperliquid')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
              activeDoc === 'hyperliquid' ? 'bg-[#1e293b] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Server className="w-3.5 h-3.5 text-amber-400" />
            <span>Hyperliquid Adapter</span>
          </button>

          <button
            onClick={() => setActiveDoc('security')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
              activeDoc === 'security' ? 'bg-[#1e293b] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5 text-rose-400" />
            <span>Security & Sandbox</span>
          </button>
        </div>

        {/* Doc Content */}
        <div className="bg-[#0c121e] border border-[#1e293b] rounded-lg p-6 text-xs text-slate-300 space-y-4 font-sans leading-relaxed">
          {activeDoc === 'sdk' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-white font-mono">Controlled Trading SDK</h2>
              <p>
                TradingVibe strategies are written as asynchronous TypeScript functions that accept a single
                controlled argument: <code className="text-sky-300 font-mono">ctx: TradingContext</code>.
              </p>

              <div className="bg-[#111927] p-3 rounded border border-[#1e293b] font-mono text-[11px] space-y-1 text-slate-200">
                <div className="text-slate-400">// 1. Market Data</div>
                 <div>const quote = await ctx.market.quote("EUR/USD");</div>
                 <div>const bars = await ctx.market.bars({`{`} symbol: "EUR/USD", timeframe: "5m", limit: 100 {`}`});</div>
                <div className="text-slate-400 mt-2">// 2. Technical Indicators</div>
                <div>const fast = ctx.indicators.sma(closes, 10);</div>
                <div>const slow = ctx.indicators.sma(closes, 30);</div>
                <div>const rsi = ctx.indicators.rsi(closes, 14);</div>
                <div className="text-slate-400 mt-2">// 3. Orders & Execution</div>
                 <div>await ctx.orders.market({`{`} symbol: "EUR/USD", side: "BUY", volume: 10000, stopLoss, takeProfit {`}`});</div>
                <div>await ctx.orders.closePosition(positionId);</div>
                <div className="text-slate-400 mt-2">// 4. Account State & Signals</div>
                 <div>const positions = ctx.account.positions("EUR/USD");</div>
                 <div>ctx.signal({`{`} symbol: "EUR/USD", side: "BUY", timestamp, price, title, reason {`}`});</div>
                <div>ctx.log("Signal generated successfully");</div>
              </div>
            </div>
          )}

          {activeDoc === 'arch' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-white font-mono">Core System Architecture</h2>
              <p>
                TradingVibe strictly separates strategy authoring from the execution layer:
              </p>
              <pre className="bg-[#111927] p-3 rounded border border-[#1e293b] font-mono text-[11px] text-sky-300 overflow-x-auto">
{`Monaco Editor (strategy.ts)
           │
     JS/TS Sandbox (Isolated Context)
           │
TradingVibe Execution Engine
           │
   External Risk Layer (Safe Limits & Kill Switch)
           │
   Environment Adapter
     ├── BACKTEST (Deterministic Simulator)
      ├── DEMO (Hyperliquid Testnet data + simulated execution)
      └── LIVE (reserved for a server-side signer)`}
              </pre>
            </div>
          )}

          {activeDoc === 'backtest' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-white font-mono">Step-by-Step Backtest Engine</h2>
              <p>
                The Backtester iterates through historical bar series chronologically without future lookahead bias:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Warm-up history buffer allows indicators (e.g. 50-period SMA) to populate before orders fire.</li>
                <li>Every market order models real ask/bid spreads and configurable average slippage. These are simulation assumptions, not live venue fees.</li>
                <li>Stop-Loss and Take-Profit limits are evaluated on every subsequent candle's High/Low wick range.</li>
                <li>Metrics generated include Net P&L, Win Rate, Profit Factor, Sharpe Ratio, and Drawdown curve.</li>
              </ul>
            </div>
          )}

          {activeDoc === 'hyperliquid' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-white font-mono">Hyperliquid Adapter Integration</h2>
              <p>
                Hyperliquid public REST and WebSocket interfaces provide perpetual-market quotes and candles.
                TradingVibe uses the <code className="text-sky-300 font-mono">HyperliquidMarketDataAdapter</code> layer to
                normalize provider messages into standard Quote, Bar, OrderResult, and Position objects.
              </p>
              <p>
                Demo execution is simulated locally. Private signing is intentionally not implemented in the browser.
              </p>
            </div>
          )}

          {activeDoc === 'security' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold text-white font-mono">Security Model & Sandboxing</h2>
              <p>
                User strategy code is treated as untrusted code. Strategy functions execute inside a sandboxed scope
                where dangerous global objects (<code className="text-rose-400 font-mono">fetch, WebSocket, window, document, localStorage, navigator</code>)
                are shadowed and inaccessible.
              </p>
              <p>
                Strategy code cannot initiate arbitrary HTTP requests or access client credentials. All orders
                pass through the TradingVibe Risk Layer, where exposure is measured in the account currency across every asset class, with mandatory stop losses and the emergency Kill Switch.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
