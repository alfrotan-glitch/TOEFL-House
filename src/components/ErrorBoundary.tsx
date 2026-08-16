/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Enterprise Error Boundary 1.0.0
 *
 * Catches rendering errors in the React tree and shows a graceful fallback UI
 * instead of crashing the entire application. In development mode, displays
 * full stack traces for debugging. In production, shows a user-friendly
 * message with an Event ID that users can report to support.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 * Or with custom fallback:
 *   <ErrorBoundary fallback={<MyCustomError />}>
 *     <RiskyComponent />
 *   </ErrorBoundary>
 */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home, Copy, CheckCircle2, Bug, Shield } from 'lucide-react';
import { BRAND_NAME } from '../config/branding';

// ============================================================================
// Types
// ============================================================================

interface Props {
  children: ReactNode;
  /** Optional custom fallback UI. If not provided, the default branded UI is shown. */
  fallback?: ReactNode;
  /** Optional callback when an error is caught (e.g., send to Sentry/LogRocket) */
  onError?: (error: Error, errorInfo: ErrorInfo, eventId: string) => void;
  /** When any of these values change, the boundary resets automatically */
  resetKeys?: Array<unknown>;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  eventId: string;
  copied: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a short, human-friendly event ID for support tickets */
function generateEventId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TH-${ts}-${rand}`;
}

const isDev = import.meta.env.DEV;

/** Safely report the error to the backend (best-effort, never throws) */
async function reportErrorToServer(
  error: Error,
  errorInfo: ErrorInfo,
  eventId: string
): Promise<void> {
  try {
    await fetch('/api/errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Silently ignore — we don't want error reporting to cause more errors
  }
}

// ============================================================================
// Default Fallback UI
// ============================================================================

function DefaultFallback({
  error,
  errorInfo,
  eventId,
  copied,
  onRetry,
  onReload,
  onCopy,
}: {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  eventId: string;
  copied: boolean;
  onRetry: () => void;
  onReload: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      className="min-h-screen w-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-rose-50/30 to-slate-100 p-4"
      dir="ltr"
    >
      <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-l from-rose-600 via-rose-500 to-red-500 px-8 py-6 text-white">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center border border-white/30">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold">Unexpected system error</h1>
              <p className="text-rose-100 text-sm mt-0.5">
                The technical team will be notified of this issue.
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-8 space-y-5">
          {/* Event ID Card */}
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-amber-900 font-bold">
                Incident tracking code
              </p>
              <div className="flex items-center gap-2 mt-1.5">
                <code className="font-mono text-xs bg-white px-3 py-1.5 rounded-lg border border-amber-200 text-amber-900 font-bold tracking-wider">
                  {eventId}
                </code>
                <button
                  onClick={onCopy}
                  className="flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-lg transition-colors cursor-pointer"
                  title="Copy tracking code"
                >
                  {copied ? (
                    <>
                      <CheckCircle2 className="w-3 h-3" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      Copy
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-amber-700 mt-2 leading-relaxed">
                Please share this code with technical support along with a description of the issue.
              </p>
            </div>
          </div>

          {/* Error Message */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
            <p className="text-xs text-slate-500 font-bold mb-1">Error message</p>
            <p className="text-sm text-slate-800 font-semibold">
              {error?.message || 'An unknown error occurred.'}
            </p>
          </div>

          {/* Dev-only: Stack Trace */}
          {isDev && error && (
            <div className="bg-slate-900 text-slate-100 rounded-2xl p-4 overflow-hidden">
              <div className="flex items-center gap-2 mb-2">
                <Bug className="w-4 h-4 text-emerald-400" />
                <p className="text-xs font-bold text-emerald-400">
                  DEVELOPMENT MODE — Stack Trace
                </p>
              </div>
              <pre className="text-[10px] font-mono text-slate-300 overflow-x-auto max-h-48 overflow-y-auto leading-relaxed whitespace-pre-wrap break-all">
                {error.stack}
                {errorInfo?.componentStack && (
                  <>
                    {'\n\n--- Component Stack ---\n'}
                    {errorInfo.componentStack}
                  </>
                )}
              </pre>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={onRetry}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer shadow-sm"
            >
              <RefreshCw className="w-4 h-4" />
              Try again
            </button>
            <button
              onClick={onReload}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors cursor-pointer border border-slate-200"
            >
              <Home className="w-4 h-4" />
              Reload page
            </button>
          </div>

          {/* Footer */}
          <p className="text-[10px] text-slate-400 text-center pt-2 border-t border-slate-100">
            {BRAND_NAME} ERP · 1.0.0 · {new Date().toLocaleDateString('en-US')}
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Error Boundary Class Component
// ============================================================================

export class ErrorBoundary extends Component<Props, State> {
  private prevResetKeys: Array<unknown> = [];

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      eventId: '',
      copied: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render shows the fallback UI
    return {
      hasError: true,
      error,
      eventId: generateEventId(),
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Call user-provided onError callback
    if (this.props.onError) {
      try {
        this.props.onError(error, errorInfo, this.state.eventId);
      } catch {
        // Never let the error handler itself throw
      }
    }

    // Report to server (best-effort)
    reportErrorToServer(error, errorInfo, this.state.eventId);

    // Log to console in development
    if (isDev) {
      console.error(
        '%c[ErrorBoundary] Captured error',
        'color: #ef4444; font-weight: bold;',
        {
          eventId: this.state.eventId,
          error,
          componentStack: errorInfo.componentStack,
        }
      );
    }
  }

  componentDidUpdate(_prevProps: Props): void {
    // Auto-reset when resetKeys change (useful for route changes, etc.)
    const { resetKeys } = this.props;
    if (!resetKeys) return;

    const prevKeys = this.prevResetKeys;
    this.prevResetKeys = resetKeys;

    if (
      this.state.hasError &&
      prevKeys.length > 0 &&
      resetKeys.length === prevKeys.length &&
      resetKeys.some((val, idx) => val !== prevKeys[idx])
    ) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      eventId: '',
      copied: false,
    });
  };

  handleRetry = (): void => {
    this.reset();
  };

  handleReload = (): void => {
    window.location.reload();
  };

  handleCopy = async (): Promise<void> => {
    const { eventId, error, errorInfo } = this.state;
    const report = [
      `Event ID: ${eventId}`,
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `Message: ${error?.message || 'N/A'}`,
      `Stack: ${error?.stack || 'N/A'}`,
      `Component Stack: ${errorInfo?.componentStack || 'N/A'}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = report;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // If a custom fallback is provided, use it
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Otherwise, render the default branded fallback
      return (
        <DefaultFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          eventId={this.state.eventId}
          copied={this.state.copied}
          onRetry={this.handleRetry}
          onReload={this.handleReload}
          onCopy={this.handleCopy}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;