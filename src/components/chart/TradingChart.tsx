import React, { useEffect, useRef, useState } from 'react';
import * as LightweightCharts from 'lightweight-charts';
import { Maximize2, Minimize2, Eye, EyeOff, Layers } from 'lucide-react';
import { Bar, Position, SignalEvent, Trade } from '../../types/trading';
import { calculateSMA } from '../../engine/indicators';

interface TradingChartProps {
  symbol: string;
  timeframe: string;
  bars: Bar[];
  positions: Position[];
  signals: SignalEvent[];
  trades?: Trade[];
  onBarClick?: (bar: Bar) => void;
  showIndicators?: boolean;
  onToggleIndicators?: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
}

export const TradingChart: React.FC<TradingChartProps> = ({
  symbol,
  timeframe,
  bars,
  positions,
  signals,
  trades = [],
  showIndicators = true,
  onToggleIndicators,
  isMaximized = false,
  onToggleMaximize,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const fastSmaSeriesRef = useRef<any>(null);
  const slowSmaSeriesRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);

  const [activeTooltip, setActiveTooltip] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up previous instance
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const { createChart, ColorType, LineStyle, CrosshairMode } = LightweightCharts as any;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType?.Solid || 'solid', color: '#090d14' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle?.Dotted || 1 },
        horzLines: { color: 'rgba(30, 41, 59, 0.45)', style: LineStyle?.Dotted || 1 },
      },
      crosshair: {
        mode: CrosshairMode?.Normal || 1,
        vertLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle?.Dashed || 2,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle?.Dashed || 2,
          labelBackgroundColor: '#1e293b',
        },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.15,
        },
      },
    });

    chartRef.current = chart;

    // In Lightweight Charts v4: chart.addCandlestickSeries
    // In Lightweight Charts v5: chart.addSeries(CandlestickSeries)
    let candleSeries: any;
    if (typeof chart.addCandlestickSeries === 'function') {
      candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
      });
    } else if (typeof chart.addSeries === 'function' && (LightweightCharts as any).CandlestickSeries) {
      candleSeries = chart.addSeries((LightweightCharts as any).CandlestickSeries, {
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
      });
    }
    candleSeriesRef.current = candleSeries;

    // Add Moving Average Overlays
    let fastSma: any;
    let slowSma: any;
    if (typeof chart.addLineSeries === 'function') {
      fastSma = chart.addLineSeries({
        color: '#38bdf8',
        lineWidth: 1.5,
        title: 'SMA 10',
        priceLineVisible: false,
      });
      slowSma = chart.addLineSeries({
        color: '#f59e0b',
        lineWidth: 1.5,
        title: 'SMA 30',
        priceLineVisible: false,
      });
    } else if (typeof chart.addSeries === 'function' && (LightweightCharts as any).LineSeries) {
      fastSma = chart.addSeries((LightweightCharts as any).LineSeries, {
        color: '#38bdf8',
        lineWidth: 1.5,
        title: 'SMA 10',
        priceLineVisible: false,
      });
      slowSma = chart.addSeries((LightweightCharts as any).LineSeries, {
        color: '#f59e0b',
        lineWidth: 1.5,
        title: 'SMA 30',
        priceLineVisible: false,
      });
    }
    fastSmaSeriesRef.current = fastSma;
    slowSmaSeriesRef.current = slowSma;

    // Crosshair tooltip tracker
    chart.subscribeCrosshairMove((param: any) => {
      if (!param || !param.time || !candleSeries) {
        setActiveTooltip(null);
        return;
      }
      const data = param.seriesData.get(candleSeries);
      if (data) {
        const dateStr = new Date((param.time as number) * 1000).toLocaleString();
        setActiveTooltip({
          time: dateStr,
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
        });
      }
    });

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        const width = chartContainerRef.current.clientWidth;
        const height = chartContainerRef.current.clientHeight;
        if (width > 0 && height > 0) {
          try {
            chartRef.current.applyOptions({ width, height });
          } catch {
            // Ignore benign resize errors
          }
        }
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        try {
          chartRef.current.remove();
        } catch {
          // Ignore
        }
        chartRef.current = null;
      }
    };
  }, []);

  // Update Data & Series
  useEffect(() => {
    if (!candleSeriesRef.current || bars.length === 0) return;

    // Format bars for Lightweight Charts (time in seconds, ascending sorted)
    const formattedCandles = bars
      .map((b) => ({
        time: b.time as any,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));

    candleSeriesRef.current.setData(formattedCandles);

    // Update SMA lines
    if (showIndicators && fastSmaSeriesRef.current && slowSmaSeriesRef.current) {
      const closes = formattedCandles.map((c) => c.close);
      const fastValues = calculateSMA(closes, 10);
      const slowValues = calculateSMA(closes, 30);

      const fastData = formattedCandles
        .map((c, i) => ({ time: c.time, value: fastValues[i] }))
        .filter((d) => !isNaN(d.value));

      const slowData = formattedCandles
        .map((c, i) => ({ time: c.time, value: slowValues[i] }))
        .filter((d) => !isNaN(d.value));

      fastSmaSeriesRef.current.setData(fastData);
      slowSmaSeriesRef.current.setData(slowData);
    }

    // Build Chart Markers (AI Signals + Bot Entry/Exit Trades)
    const markers: any[] = [];

    // AI Signals
    signals.forEach((sig) => {
      markers.push({
        time: sig.timestamp,
        position: sig.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: sig.side === 'BUY' ? '#10b981' : '#ef4444',
        shape: sig.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `▲ AI ${sig.side}`,
      });
    });

    // Trades
    trades.forEach((trd) => {
      markers.push({
        time: trd.entryTime,
        position: trd.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: '#38bdf8',
        shape: 'circle',
        text: `● ENTRY ${trd.side}`,
      });
      markers.push({
        time: trd.exitTime,
        position: trd.side === 'BUY' ? 'aboveBar' : 'belowBar',
        color: trd.pnl >= 0 ? '#10b981' : '#f43f5e',
        shape: 'square',
        text: `× EXIT ${trd.pnl >= 0 ? '+' : ''}$${trd.pnl}`,
      });
    });

    // Sort markers by timestamp ascending
    markers.sort((a, b) => a.time - b.time);

    // Deduplicate any exactly matching time
    const dedupedMarkers: any[] = [];
    const seenTimes = new Set<string>();
    markers.forEach((m) => {
      const key = `${m.time}_${m.text}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        dedupedMarkers.push(m);
      }
    });

    if (typeof candleSeriesRef.current.setMarkers === 'function') {
      candleSeriesRef.current.setMarkers(dedupedMarkers);
    }

    // Update Position Price Lines (Entry, SL, TP)
    // Clear old lines
    priceLinesRef.current.forEach((pl) => {
      try {
        candleSeriesRef.current.removePriceLine(pl);
      } catch {
        // Ignore
      }
    });
    priceLinesRef.current = [];

    const activePosition = positions.find((p) => p.symbol === symbol);
    if (activePosition && typeof candleSeriesRef.current.createPriceLine === 'function') {
      // Entry Line
      const entryLine = candleSeriesRef.current.createPriceLine({
        price: activePosition.entryPrice,
        color: activePosition.side === 'BUY' ? '#38bdf8' : '#fb923c',
        lineWidth: 1,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: `POS ${activePosition.side} @ ${activePosition.entryPrice}`,
      });
      priceLinesRef.current.push(entryLine);

      // Stop Loss Line
      if (activePosition.stopLoss) {
        const slLine = candleSeriesRef.current.createPriceLine({
          price: activePosition.stopLoss,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: `SL: ${activePosition.stopLoss}`,
        });
        priceLinesRef.current.push(slLine);
      }

      // Take Profit Line
      if (activePosition.takeProfit) {
        const tpLine = candleSeriesRef.current.createPriceLine({
          price: activePosition.takeProfit,
          color: '#10b981',
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: `TP: ${activePosition.takeProfit}`,
        });
        priceLinesRef.current.push(tpLine);
      }
    }

    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [bars, signals, trades, positions, symbol, showIndicators]);

  // Re-adjust dimensions and fit content when maximized state changes
  useEffect(() => {
    if (chartContainerRef.current && chartRef.current) {
      const width = chartContainerRef.current.clientWidth;
      const height = chartContainerRef.current.clientHeight;
      if (width > 0 && height > 0) {
        chartRef.current.applyOptions({ width, height });
        setTimeout(() => {
          chartRef.current?.timeScale().fitContent();
        }, 80);
      }
    }
  }, [isMaximized]);

  return (
    <div className="relative w-full h-full select-none bg-[#090d14] flex flex-col">
      {/* Chart Top Metadata Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1e293b]/70 bg-[#0c121e]/90 text-xs">
        <div className="flex items-center gap-3 font-mono">
          <span className="font-semibold text-white tracking-wide">{symbol}</span>
          <span className="text-slate-400">{timeframe}</span>
          {showIndicators && (
            <div className="hidden sm:flex items-center gap-3 text-[11px]">
              <span className="text-sky-400 flex items-center gap-1">
                <span className="w-2 h-0.5 bg-sky-400 inline-block"></span> SMA 10
              </span>
              <span className="text-amber-400 flex items-center gap-1">
                <span className="w-2 h-0.5 bg-amber-400 inline-block"></span> SMA 30
              </span>
            </div>
          )}
        </div>

        {/* OHLC Tooltip & Right Chart Controls */}
        <div className="flex items-center gap-3">
          {activeTooltip && (
            <div className="hidden md:flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-300">
              <span>O: <strong className="text-white">{activeTooltip.open.toFixed(5)}</strong></span>
              <span>H: <strong className="text-emerald-400">{activeTooltip.high.toFixed(5)}</strong></span>
              <span>L: <strong className="text-rose-400">{activeTooltip.low.toFixed(5)}</strong></span>
              <span>C: <strong className={activeTooltip.close >= activeTooltip.open ? 'text-emerald-400' : 'text-rose-400'}>{activeTooltip.close.toFixed(5)}</strong></span>
            </div>
          )}

          <div className="flex items-center gap-1 border-l border-[#1e293b]/60 pl-2">
            {onToggleIndicators && (
              <button
                onClick={onToggleIndicators}
                className={`p-1 rounded text-xs transition-colors flex items-center gap-1 ${
                  showIndicators
                    ? 'text-sky-400 bg-sky-950/40 hover:bg-sky-900/50'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1e293b]'
                }`}
                title={showIndicators ? 'Hide Technical Indicators' : 'Show Technical Indicators'}
              >
                {showIndicators ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                <span className="text-[11px] hidden lg:inline">SMA</span>
              </button>
            )}

            {onToggleMaximize && (
              <button
                onClick={onToggleMaximize}
                className={`p-1 rounded text-xs transition-colors flex items-center gap-1 font-medium ${
                  isMaximized
                    ? 'bg-sky-600 text-white hover:bg-sky-500'
                    : 'text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155]'
                }`}
                title={isMaximized ? 'Exit Fullscreen Chart' : 'Fullscreen Chart'}
              >
                {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                <span className="text-[11px] hidden sm:inline">
                  {isMaximized ? 'Restore View' : 'Fullscreen'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chart Canvas */}
      <div ref={chartContainerRef} className="flex-1 w-full h-full relative" />
    </div>
  );
};
