/**
 * Thin fetch wrapper around the TOEFL House ERP backend API.
 * - Injects the Bearer token automatically.
 * - Converts snake_case DB fields returned by some endpoints into camelCase
 *   so every frontend component can keep using the same field names it always has.
 * - Normalizes SQLite's 0/1 integers into real booleans for known boolean fields.
 * - Throws a normal Error with the server's (Persian) message on failure, so existing
 *   try/catch + toast patterns in the UI keep working unmodified.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Authentication is carried by an HttpOnly, SameSite cookie. Tokens are never persisted in browser storage.
export function getToken(): string | null { return null; }
export function setToken(_token: string | null): void { /* compatibility no-op */ }

/** Fired when the server rejects the current token (expired/invalid) so the app can log the user out. */
type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;
export function onUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListener = listener;
}

const BOOLEAN_FIELDS = new Set([
  'read', 'isChapter', 'examFeePaid', 'certificateIssued', 'isActive', 'mustChangePassword', 'autoApproved',
]);

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const camelKey = toCamel(k);
      let normalizedValue = normalize(v);
      if (BOOLEAN_FIELDS.has(camelKey) && typeof normalizedValue === 'number') {
        normalizedValue = normalizedValue === 1;
      }
      out[camelKey] = normalizedValue;
    }
    return out;
  }
  return value;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string | undefined>; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const url = new URL(API_BASE + path, API_BASE.startsWith('http') ? undefined : window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const token = getToken();
  const controller = options.signal ? null : new AbortController();
  const timeout = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => controller?.abort(), options.timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: options.method || 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal ?? controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && unauthorizedListener) unauthorizedListener();
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `Unexpected server error (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return normalize(data) as T;
}

export const api = {
  get: <T = unknown>(path: string, query?: Record<string, string | undefined>) => apiFetch<T>(path, { query }),
  post: <T = unknown>(path: string, body?: unknown, query?: Record<string, string | undefined>, headers?: Record<string, string>) =>
    apiFetch<T>(path, { method: 'POST', body, query, headers }),
  put: <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T = unknown>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};