/**
 * Financial idempotency helpers.
 * ============================================================================
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Money-writing endpoints accepted an OPTIONAL `Idempotency-Key`. When the
 * client omitted it (which most callers did), ten rapid clicks produced ten
 * payments and ten income rows — proven by attack: 10 concurrent requests
 * created 10 payments totalling 10,000 AFN from a single 1,000 AFN intent.
 *
 * Frontend `disabled={loading}` cannot fix this: it does not survive a page
 * refresh, a network retry, a second browser tab, or a direct API client.
 * The backend must therefore be authoritative.
 *
 * THE MODEL
 * ----------------------------------------------------------------------------
 * Two distinct concepts, deliberately kept separate:
 *
 *   1. REQUEST idempotency — "this is the same HTTP attempt, retried".
 *      Collapses retries into one result. Implemented by an explicit
 *      client key, or, when absent, by a server-derived fingerprint of the
 *      business intent inside a short time window.
 *
 *   2. BUSINESS-EVENT uniqueness — "this fee may only ever be charged once".
 *      Enforced separately by domain guards (card/diploma/placement/book).
 *      NOT handled here.
 *
 * The fingerprint window is what makes this safe for legitimate repeats: two
 * genuine identical installments paid minutes apart are different business
 * events and both must succeed. A double-click, a refresh, or a retry storm
 * happens within seconds. The window separates the two without blocking real
 * business activity.
 *
 * Uniqueness is enforced by the database (`uq_payments_idempotency`), not by
 * a read-then-write check, so concurrent requests cannot race past it.
 */
import { createHash } from 'node:crypto';

/**
 * Seconds during which an identical, un-keyed money request is treated as a
 * retry of the same intent rather than a new business event.
 *
 * Chosen to comfortably cover double-clicks, form resubmits, refreshes and
 * automatic network retries, while staying far below the time a human needs
 * to deliberately collect a second identical payment.
 */
export const IDEMPOTENCY_WINDOW_SECONDS = 90;

/** Reads an explicit client-supplied idempotency key, if any. */
export function readClientIdempotencyKey(req: {
  get(name: string): string | undefined;
  body?: unknown;
}): string {
  const header = req.get('Idempotency-Key');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  return String(header || fromBody || '').trim();
}

/**
 * Builds the effective idempotency key for a money-writing request.
 *
 * - An explicit client key always wins and is used verbatim, so a caller can
 *   deliberately mark two identical charges as distinct by sending two keys.
 * - Otherwise a fingerprint is derived from the business intent plus a coarse
 *   time bucket, so retries of the SAME intent collapse while a later,
 *   genuinely new charge falls into a different bucket and is allowed.
 *
 * Two overlapping buckets are returned for the derived case: a request landing
 * just after a bucket boundary must still match the immediately preceding
 * bucket, otherwise a double-click straddling the boundary would slip through.
 */
export function resolveIdempotency(
  req: { get(name: string): string | undefined; body?: unknown },
  intent: Record<string, string | number | null | undefined>,
  nowMs: number = Date.now(),
): { key: string; candidates: string[]; clientSupplied: boolean } {
  const clientKey = readClientIdempotencyKey(req);
  if (clientKey) return { key: clientKey, candidates: [clientKey], clientSupplied: true };

  const canonical = JSON.stringify(
    Object.keys(intent)
      .sort()
      .map((k) => [k, intent[k] ?? null]),
  );
  const windowMs = IDEMPOTENCY_WINDOW_SECONDS * 1000;
  const bucket = Math.floor(nowMs / windowMs);
  const make = (b: number) =>
    'auto:' + createHash('sha256').update(`${canonical}|${b}`).digest('hex').slice(0, 40);

  // Current bucket is the key we would write; the previous one is also checked
  // so a retry that crosses the boundary still matches the original.
  return { key: make(bucket), candidates: [make(bucket), make(bucket - 1)], clientSupplied: false };
}

/** True when a SQLite error is a violation of a UNIQUE constraint/index. */
export function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '');
  return /UNIQUE constraint failed/i.test(msg);
}
