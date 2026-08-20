/**
 * Client-side payment display helpers.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ----------------------------------------------------------------------------
 * It does not compute tuition balances, and deliberately exports no
 * `computeStudentBalance`. Re-deriving "how much has this student paid" in the
 * browser from the loaded `payments` array creates a second source of financial
 * truth, and it disagrees with the server:
 *
 *   - the payments array is ONE PAGE, so any student whose payments fell
 *     outside the page appeared to owe their full fee, and
 *   - the client summed ALL semesters while the server's roster endpoint
 *     summed only ACTIVE ones, so completing a semester made the roster and
 *     the profile drawer report debts 20,000 AFN apart for the same student.
 *
 * Tuition figures now come exclusively from the server, which sums every
 * payment in SQL (server/src/utils/studentBalance.ts):
 *
 *   GET /api/students/:id     -> `balance.lifetime` and `balance.current`
 *   GET /api/payments/balances -> one authoritative row per student
 *
 * Anything that needs a balance reads one of those. Do not reintroduce a
 * client-side computation here.
 */
import { Payment } from '../types';

/**
 * True when a payment row represents money handed back to the student.
 * Presentation only — decides whether the row renders as a credit ("−") or a
 * debit ("+"). Refunds are stored signed-negative by the server.
 */
export function isRefundPayment(pay: Pick<Payment, 'category' | 'status' | 'amount'>): boolean {
  return pay.category === 'refund' || pay.status === 'refunded' || Number(pay.amount ?? 0) < 0;
}
