import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('TradingGOATs caught a runtime error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-bg-bg-alt text-ink-2 p-6 text-center">
          <div className="p-3 rounded-full bg-rose-950/70 border border-rose-800/50 text-rose-400 mb-4">
            <AlertOctagon className="w-8 h-8" />
          </div>
          <h1 className="text-lg font-bold text-white mb-2">TradingGOATs Runtime Intercept</h1>
          <p className="text-xs text-ink-3 max-w-md mb-4 font-mono">
            {this.state.error?.message || 'An unexpected execution issue was prevented.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="flex items-center gap-2 px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reload IDE Workspace</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
