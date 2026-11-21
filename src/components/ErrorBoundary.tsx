import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  errorMessage: string;
  parsedInfo: {
    error?: string;
    operationType?: string;
    path?: string | null;
    authInfo?: { email?: string | null; userId?: string | null };
  } | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '', parsedInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    let parsedInfo: State['parsedInfo'] = null;
    try {
      const candidate = JSON.parse(error.message);
      if (candidate && typeof candidate === 'object' && 'operationType' in candidate) {
        parsedInfo = candidate;
      }
    } catch {
      parsedInfo = null;
    }

    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected application error occurred.',
      parsedInfo,
    };
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { parsedInfo, errorMessage } = this.state;

    return (
      <div className="min-h-screen bg-[#0B1120] text-[#F1F5F9] flex items-center justify-center p-6">
        <div className="w-full max-w-xl bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-100">
                {parsedInfo ? 'Firestore Security Rule Rejection' : 'Application Recovery Required'}
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                {parsedInfo
                  ? 'A database operation was denied by Smart Vote security rules.'
                  : 'An unexpected runtime error interrupted this console view.'}
              </p>
            </div>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 space-y-1.5 overflow-x-auto">
            {parsedInfo ? (
              <>
                <div>
                  <span className="text-slate-500">Operation: </span>
                  <span className="text-sky-400">{parsedInfo.operationType}</span>
                </div>
                <div>
                  <span className="text-slate-500">Path: </span>
                  <span className="text-amber-300">{parsedInfo.path || 'unknown'}</span>
                </div>
                <div>
                  <span className="text-slate-500">Reason: </span>
                  <span className="text-red-300">{parsedInfo.error}</span>
                </div>
              </>
            ) : (
              <div className="text-red-300 break-words">{errorMessage}</div>
            )}
          </div>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium text-sm transition-colors cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            Reload Console
          </button>
        </div>
      </div>
    );
  }
}
