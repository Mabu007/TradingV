import React, { useRef } from 'react';
import './monacoConfig';
import Editor, { OnMount } from '@monaco-editor/react';
import { Play, RotateCcw, Sparkles, CheckCircle2, AlertTriangle, Layers, Maximize2, Minimize2, X } from 'lucide-react';
import { TRADING_CONTEXT_DTS } from './tradingContextDts';
import { Strategy, ExecutionMode } from '../../types/trading';

interface MonacoStrategyEditorProps {
  code: string;
  onChange: (value: string) => void;
  strategies: Strategy[];
  selectedStrategyId: string;
  onSelectStrategy: (id: string) => void;
  onRunStrategy: () => void;
  onRunBacktest: () => void;
  onAskAIAboutCode: () => void;
  executionMode: ExecutionMode;
  isRunning?: boolean;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}

export const MonacoStrategyEditor: React.FC<MonacoStrategyEditorProps> = ({
  code,
  onChange,
  strategies,
  selectedStrategyId,
  onSelectStrategy,
  onRunStrategy,
  onRunBacktest,
  onAskAIAboutCode,
  executionMode,
  isRunning = false,
  isMaximized = false,
  onToggleMaximize,
  onClose,
}) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    try {
      const ts = (monaco as any)?.languages?.typescript || (monaco as any)?.typescript;
      if (ts?.typescriptDefaults) {
        ts.typescriptDefaults.setCompilerOptions({
          target: ts.ScriptTarget?.ES2020 ?? 7,
          allowNonTextFiles: true,
          moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
          module: ts.ModuleKind?.CommonJS ?? 1,
          noEmit: true,
          typeRoots: ['node_modules/@types'],
          allowSyntheticDefaultImports: true,
        });

        ts.typescriptDefaults.addExtraLib(
          TRADING_CONTEXT_DTS,
          'ts:filename/tradingContext.d.ts'
        );
      }
    } catch (err) {
      console.warn('Monaco typescript declaration initialization bypassed:', err);
    }
  };

  const handleFormat = () => {
    if (editorRef.current) {
      editorRef.current.getAction('editor.action.formatDocument')?.run();
    }
  };

  const activeStrategy = strategies.find((s) => s.id === selectedStrategyId);

  return (
    <div className="flex flex-col h-full w-full bg-[#0a0f18] border-t border-[#1e293b]/70 select-none">
      {/* Editor Control Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d1422] border-b border-[#1e293b]/70 text-xs">
        {/* Left: Strategy Selector */}
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-slate-400" />
          <select
            value={selectedStrategyId}
            onChange={(e) => onSelectStrategy(e.target.value)}
            className="bg-[#131c2e] text-slate-200 border border-[#1e293b] rounded px-2 py-1 text-xs focus:outline-none focus:border-sky-500 font-medium"
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.symbol} {s.timeframe})
              </option>
            ))}
          </select>
          <span className="text-[11px] text-slate-400 font-mono hidden sm:inline">
            strategy.ts
          </span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAskAIAboutCode}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#1e293b]/80 hover:bg-[#334155] text-sky-300 text-xs font-medium transition-colors"
            title="Ask AI to review, explain, or optimize current code"
          >
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden md:inline">AI Review</span>
          </button>

          <button
            onClick={handleFormat}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
            title="Format Code"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onRunBacktest}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors shadow-sm"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Backtest</span>
          </button>

          <button
            onClick={onRunStrategy}
            disabled={isRunning}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold transition-colors ${
              executionMode === 'LIVE'
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isRunning ? 'Running...' : `Run (${executionMode})`}</span>
          </button>

          {onToggleMaximize && (
            <button
              onClick={onToggleMaximize}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors ml-1"
              title={isMaximized ? 'Restore View' : 'Maximize Editor'}
            >
              {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"
              title="Hide Editor (Focus Chart)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Monaco Editor Container */}
      <div className="flex-1 w-full relative">
        <Editor
          height="100%"
          language="typescript"
          value={code}
          theme="vs-dark"
          onChange={(val) => onChange(val || '')}
          onMount={handleEditorDidMount}
          options={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12.5,
            lineHeight: 19,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            lineNumbers: 'on',
            renderLineHighlight: 'all',
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            folding: true,
            bracketPairColorization: { enabled: true },
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
};
