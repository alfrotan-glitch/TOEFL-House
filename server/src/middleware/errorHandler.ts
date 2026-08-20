import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '../core/observability/logger.js';
const log = createLogger('errorHandler');

/** Wraps an async route handler so thrown errors reach Express's error middleware instead of crashing the process. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Interface for safely typing SQLite errors
interface SqliteError extends Error {
  code?: string;
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  const error = err as SqliteError;
  const isProduction = process.env.NODE_ENV === 'production';

  // ── Handle SQLite Constraint Errors (Map to clean HTTP statuses) ──────────
  
  // Foreign Key constraint (e.g., deleting a parent record that has children)
  if (
    error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    error?.message?.includes('FOREIGN KEY constraint failed')
  ) {
    return res.status(409).json({
      error: 'This record is still referenced by other data and cannot be deleted.',
    });
  }

  // Unique constraint (e.g., duplicate email, phone, or student code)
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({
      error: 'A record with this unique information already exists.',
    });
  }

  // Check constraint (e.g., invalid enum value passed to database)
  if (error?.code === 'SQLITE_CONSTRAINT_CHECK') {
    return res.status(400).json({
      error: 'Invalid data provided. Please check your inputs.',
    });
  }

  // ── Handle JSON Body Parser Errors ───────────────────────────────────────
  if (error instanceof SyntaxError && 'status' in error && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON payload provided.' });
  }

  // ── Handle Custom HTTP & Generic Errors ──────────────────────────────────
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'An unknown error occurred.';

  if (status >= 500) {
    // Log the full stack trace for server-side debugging
    log.error('Unhandled error reached the error handler', err);
    
    // Security: In production, mask the internal error message to prevent info leakage
    return res.status(status).json({
      error: isProduction ? 'An internal server error occurred.' : message,
    });
  }

  // For 4xx client errors, it's safe to return the specific error message
  if (status >= 400) {
    return res.status(status).json({ error: message || 'Bad Request' });
  }

  // Fallback (should rarely be reached)
  res.status(500).json({ error: 'An internal server error occurred.' });
}