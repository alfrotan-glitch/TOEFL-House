/**
 * THE logger.
 * ============================================================================
 * Fifty-three `console.*` calls across fourteen runtime modules produced output
 * with no level, no consistent shape and no way to filter it: boot progress,
 * recoverable warnings and genuine failures all arrived on the same stream,
 * decorated with emoji, interleaved with test output. That is not
 * diagnosability — it is noise that happens to contain evidence.
 *
 * Logs are therefore emitted through one function that gives every line a
 * level, a source and a machine-readable shape:
 *
 *   · PRODUCTION emits one JSON object per line, so a log shipper can parse,
 *     filter and alert on it without regex archaeology.
 *   · DEVELOPMENT emits a compact human line, because a developer reads it
 *     directly.
 *   · TESTS emit nothing below `error`, so a passing suite is silent and a
 *     real failure is visible instead of buried under boot chatter.
 *
 * REDACTION. Log calls carry structured context, and context objects grow. A
 * field named like a credential is replaced with '[redacted]' before output —
 * a log line is the easiest place to leak a secret by accident, and the
 * hardest place to notice it afterwards.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Context keys whose values are never printed. */
const SENSITIVE_KEY = /pass(word)?|secret|token|jwt|authorization|cookie|hash|credential|apikey|api_key/i;

export type LogContext = Record<string, unknown>;

function activeLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  if (configured && configured in LEVEL_ORDER) return configured;
  // A passing test run should be silent; a failing one should still say why.
  if (process.env.NODE_ENV === 'test') return 'error';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/**
 * Replaces credential-shaped values, recursively.
 *
 * Depth-limited: a context object is a log line, not a graph to traverse, and
 * an accidental cycle must not hang the process that is trying to report a
 * problem.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Errors are logged by shape, never as a raw object that serialises to {}. */
function describeError(err: unknown): LogContext {
  if (err instanceof Error) {
    return {
      // Deliberately NOT `message`: that key belongs to the log line, and
      // spreading an error's own message over it silently replaced what the
      // caller was trying to say with what the exception said.
      error: err.name,
      errorMessage: err.message,
      // Stacks are diagnostic, not for the operator; production keeps them out
      // of the line and out of any log aggregator's index.
      ...(process.env.NODE_ENV === 'production' ? {} : { stack: err.stack }),
    };
  }
  return { error: 'NonError', errorMessage: String(err) };
}

function emit(level: LogLevel, source: string, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;

  const safeContext = context ? (redact(context) as LogContext) : undefined;

  if (process.env.NODE_ENV === 'production') {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      source,
      message,
      ...(safeContext ?? {}),
    });
    // One stream per severity so an operator can separate them at the shell.
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
    return;
  }

  const suffix = safeContext && Object.keys(safeContext).length ? ` ${JSON.stringify(safeContext)}` : '';
  const line = `${level.toUpperCase().padEnd(5)} [${source}] ${message}${suffix}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  /** `warn` accepts a caught value too: a recoverable failure is still a failure. */
  warn(message: string, err?: unknown, context?: LogContext): void;
  /** `error` accepts the thrown value directly; it is described, not dumped. */
  error(message: string, err?: unknown, context?: LogContext): void;
}

/**
 * A logger bound to a source, so every line says where it came from without
 * the caller repeating a prefix string it can misspell.
 */
export function createLogger(source: string): Logger {
  return {
    debug: (message, context) => emit('debug', source, message, context),
    info: (message, context) => emit('info', source, message, context),
    warn: (message, err, context) =>
      emit('warn', source, message, { ...(err === undefined ? {} : describeError(err)), ...(context ?? {}) }),
    error: (message, err, context) =>
      emit('error', source, message, { ...(err === undefined ? {} : describeError(err)), ...(context ?? {}) }),
  };
}
