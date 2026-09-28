import React from 'react';
import './monacoConfig';
import { DiffEditor } from '@monaco-editor/react';
import { Check, X, Sparkles } from 'lucide-react';

interface StrategyDiffModalProps {
  isOpen: boolean;
  originalCode: string;
  modifiedCode: string;
  explanation?: string;
  onApply: () => void;
  onDiscard: () => void;
}

export const StrategyDiffModal: React.FC<StrategyDiffModalProps> = ({
  isOpen,
  originalCode,
  modifiedCode,
  explanation,
  onApply,
  onDiscard,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-5xl h-[85vh] bg-[#0c121e] border border-[#1e293b] rounded-lg shadow-2xl flex flex-col overflow-hidden animate-in fade-in duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#0f172a] border-b border-[#1e293b]">
          <div className="flex items-center gap-2.5">
            <div className="p-1 rounded bg-sky-500/10 text-sky-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">AI Strategy Review & Code Diff</h3>
              <p className="text-xs text-slate-400">Compare original strategy with AI recommendations</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onDiscard}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-slate-300 hover:text-white bg-[#1e293b] hover:bg-[#334155] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              <span>Discard</span>
            </button>
            <button
              onClick={onApply}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Apply to Editor</span>
            </button>
          </div>
        </div>

        {/* Explanation Banner */}
        {explanation && (
          <div className="px-4 py-2 bg-sky-950/30 border-b border-sky-800/30 text-xs text-sky-200">
            {explanation}
          </div>
        )}

        {/* Diff View */}
        <div className="flex-1 w-full relative">
          <DiffEditor
            height="100%"
            language="typescript"
            original={originalCode}
            modified={modifiedCode}
            theme="vs-dark"
            options={{
              readOnly: true,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              lineHeight: 18,
              minimap: { enabled: false },
              renderSideBySide: true,
              automaticLayout: true,
            }}
          />
        </div>
      </div>
    </div>
  );
};
