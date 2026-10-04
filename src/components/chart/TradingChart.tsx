import React, { useEffect, useRef, useState } from 'react';
import * as LightweightCharts from 'lightweight-charts';
import { Maximize2, Minimize2, Eye, EyeOff, Layers } from 'lucide-react';
import { Bar, Position, SignalEvent, Trade } from '../../types/trading';
import { calculateSMA } from '../../engine/indicators';
import { readChartPalette } from '../../services/theme/chartTheme';
import { useTheme } from '../../services/theme';

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
  const { theme: themeName } = useTheme();
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

    // One palette, read from the same CSS tokens as the rest of the UI, so
    // the chart is themed rather than hardcoded.
    const palette = readChartPalette(chartContainerRef.current ?? undefined);

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType?.Solid || 'solid', color: palette.background },
        textColor: palette.text,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: palette.grid, style: LineStyle?.Dotted || 1 },
        horzLines: { color: palette.grid, style: LineStyle?.Dotted || 1 },
      },
      crosshair: {
        mode: CrosshairMode?.Normal || 1,
        vertLine: {
          color: palette.lineStrong,
          width: 1,
          style: LineStyle?.Dashed || 2,
          labelBackgroundColor: palette.line,
        },
        horzLine: {
          color: palette.lineStrong,
          width: 1,
          style: LineStyle?.Dashed || 2,
          labelBackgroundColor: palette.line,
        },
      },
      timeScale: {
        borderColor: palette.line,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: palette.line,
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
        upColor: palette.pos,
        downColor: palette.neg,
        borderUpColor: palette.pos,
        borderDownColor: palette.neg,
        wickUpColor: palette.pos,
        wickDownColor: palette.neg,
      });
    } else if (typeof chart.addSeries === 'function' && (LightweightCharts as any).CandlestickSeries) {
      candleSeries = chart.addSeries((LightweightCharts as any).CandlestickSeries, {
        upColor: palette.pos,
        downColor: palette.neg,
        borderUpColor: palette.pos,
        borderDownColor: palette.neg,
        wickUpColor: palette.pos,
        wickDownColor: palette.neg,
      });
    }
    candleSeriesRef.current = candleSeries;

    // Add Moving Average Overlays
    let fastSma: any;
    let slowSma: any;
    if (typeof chart.addLineSeries === 'function') {
      fastSma = chart.addLineSeries({
        color: palette.accent,
        lineWidth: 1.5,
        title: 'SMA 10',
        priceLineVisible: false,
      });
      slowSma = chart.addLineSeries({
        color: palette.warn,
        lineWidth: 1.5,
        title: 'SMA 30',
        priceLineVisible: false,
      });
    } else if (typeof chart.addSeries === 'function' && (LightweightCharts as any).LineSeries) {
      fastSma = chart.addSeries((LightweightCharts as any).LineSeries, {
        color: palette.accent,
        lineWidth: 1.5,
        title: 'SMA 10',
        priceLineVisible: false,
      });
      slowSma = chart.addSeries((LightweightCharts as any).LineSeries, {
        color: palette.warn,
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

    // Build Chart Markers (AI signals + GOAT entry/exit trades)
    const markers: any[] = [];

    // AI Signals
    signals.forEach((sig) => {
      markers.push({
        time: sig.timestamp,
        position: sig.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: sig.side === 'BUY' ? readChartPalette(chartContainerRef.current ?? undefined).pos : readChartPalette(chartContainerRef.current ?? undefined).neg,
        shape: sig.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `▲ AI ${sig.side}`,
      });
    });

    // Trades
    trades.forEach((trd) => {
      markers.push({
        time: trd.entryTime,
        position: trd.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: readChartPalette(chartContainerRef.current ?? undefined).accent,
        shape: 'circle',
        text: `● ENTRY ${trd.side}`,
      });
      markers.push({
        time: trd.exitTime,
        position: trd.side === 'BUY' ? 'aboveBar' : 'belowBar',
        color: trd.pnl >= 0 ? readChartPalette(chartContainerRef.current ?? undefined).pos : readChartPalette(chartContainerRef.current ?? undefined).neg,
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
        color: activePosition.side === 'BUY' ? readChartPalette(chartContainerRef.current ?? undefined).accent : readChartPalette(chartContainerRef.current ?? undefined).warn,
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
          color: readChartPalette(chartContainerRef.current ?? undefined).neg,
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
          color: readChartPalette(chartContainerRef.current ?? undefined).pos,
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
  }, [isMaximized, themeName]);

  /*
   * A canvas chart cannot inherit CSS. When the theme changes we re-apply
   * the palette in place instead of recreating the series, so the user's
   * pan/zoom and loaded history survive the switch.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const palette = readChartPalette(chartContainerRef.current ?? undefined);

    try {
      chart.applyOptions?.({
        layout: { background: { type: 'solid', color: palette.background }, textColor: palette.text },
        grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
        timeScale: { borderColor: palette.line },
        rightPriceScale: { borderColor: palette.line },
      });
      candleSeriesRef.current?.applyOptions?.({
        upColor: palette.pos, downColor: palette.neg,
        borderUpColor: palette.pos, borderDownColor: palette.neg,
        wickUpColor: palette.pos, wickDownColor: palette.neg,
      });
      fastSmaSeriesRef.current?.applyOptions?.({ color: palette.accent });
      slowSmaSeriesRef.current?.applyOptions?.({ color: palette.warn });
    } catch {
      // A missing optional method must never break the chart.
    }
  }, [themeName]);

  return (
    <div className="relative w-full h-full select-none bg-bg-alt flex flex-col">
      {/* Chart Top Metadata Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line/70 bg-surface/90 text-xs">
        <div className="flex items-center gap-3 font-mono">
          <span className="font-semibold text-ink tracking-wide">{symbol}</span>
          <span className="text-ink-3">{timeframe}</span>
          {showIndicators && (
            <div className="hidden sm:flex items-center gap-3 text-[11px]">
              <span className="text-accent flex items-center gap-1">
                <span className="w-2 h-0.5 bg-accent inline-block"></span> SMA 10
              </span>
              <span className="text-warn flex items-center gap-1">
                <span className="w-2 h-0.5 bg-warn inline-block"></span> SMA 30
              </span>
            </div>
          )}
        </div>

        {/* OHLC Tooltip & Right Chart Controls */}
        <div className="flex items-center gap-3">
          {activeTooltip && (
            <div className="hidden md:flex items-center gap-3 font-mono text-[11px] tabular-nums text-ink-2">
              <span>O: <strong className="text-ink">{activeTooltip.open.toFixed(5)}</strong></span>
              <span>H: <strong className="text-pos">{activeTooltip.high.toFixed(5)}</strong></span>
              <span>L: <strong className="text-neg">{activeTooltip.low.toFixed(5)}</strong></span>
              <span>C: <strong className={activeTooltip.close >= activeTooltip.open ? 'text-pos' : 'text-neg'}>{activeTooltip.close.toFixed(5)}</strong></span>
            </div>
          )}

          <div className="flex items-center gap-1 border-l border-line/60 pl-2">
            {onToggleIndicators && (
              <button
                onClick={onToggleIndicators}
                className={`p-1 rounded text-xs transition-colors flex items-center gap-1 ${
                  showIndicators
                    ? 'text-accent bg-accent-soft/40 hover:bg-accent-soft/50'
                    : 'text-ink-3 hover:text-ink-2 hover:bg-surface-3'
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
                    ? 'bg-accent-strong text-accent-contrast hover:bg-accent'
                    : 'text-ink-2 hover:text-ink bg-surface-3 hover:bg-line-strong'
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
