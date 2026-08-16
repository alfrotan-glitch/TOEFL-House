/**
 * Student tuition balance — the single frontend definition.
 * ============================================================================
 * Mirrors server/src/utils/studentBalance.ts. Three components each had their
 * own arithmetic and disagreed about the same student:
 *
 *   StudentProfileDrawer  fee+installment+refund over ALL semesters
 *   StudentsView (list)   fee+installment+refund over ACTIVE semesters
 *   StudentPortalView     fee+installment      over ACTIVE semesters
 *
 * A student who paid 10,000 + 3,000 and was refunded 2,000 against 13,000 of
 * tuition was shown 11,000 paid / 2,000 owed on staff screens but 13,000 paid
 * / 0 owed in their own portal — the portal silently forgave a real debt.
 *
 * Rules (identical to the server):
 *   - Tuition paid counts categories fee, installment and refund. Refunds are
 *     stored SIGNED (negative), so including them subtracts.
 *   - Non-tuition categories (book, card, exam, diploma, placement, chapter,
 *     other) are real income but do not pay down tuition.
 *   - Outstanding is floored at zero; surplus is reported as creditBalance.
 */
import type { Payment, Semester } from '../types';

/** Payment categories that pay down tuition. 'refund' is signed-negative. */
export const TUITION_PAYMENT_CATEGORIES = ['fee', 'installment', 'refund'] as const;

export type BalanceScope = 'all' | 'active';

export interface StudentBalance {
  tuitionDue: number;
  tuitionPaid: number;
  outstanding: number;
  creditBalance: number;
  paidPercentage: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isTuitionPayment(category: string | undefined | null): boolean {
  return (TUITION_PAYMENT_CATEGORIES as readonly string[]).includes(String(category ?? ''));
}

/** True when a payment row represents money handed back to the student. */
export function isRefundPayment(pay: Pick<Payment, 'category' | 'status' | 'amount'>): boolean {
  return pay.category === 'refund' || pay.status === 'refunded' || Number(pay.amount ?? 0) < 0;
}

/**
 * Authoritative balance for one student.
 * `payments` may be the whole list; it is filtered by student id here.
 */
export function computeStudentBalance(
  studentId: string,
  semesters: Semester[] | undefined,
  payments: Payment[] | undefined,
  scope: BalanceScope = 'all',
): StudentBalance {
  const inScope = (semesters ?? []).filter((s) => (scope === 'active' ? s.status === 'active' : true));
  const tuitionDue = round2(
    inScope.reduce((acc, s) => acc + (Number(s.netFeeAmount ?? s.feeAmount) || 0), 0),
  );

  const tuitionPaid = round2(
    (payments ?? [])
      .filter((p) => p.studentId === studentId && isTuitionPayment(p.category) && p.status !== 'failed' && p.status !== 'pending')
      .reduce((acc, p) => acc + (Number(p.amount) || 0), 0),
  );

  return {
    tuitionDue,
    tuitionPaid,
    outstanding: round2(Math.max(0, tuitionDue - tuitionPaid)),
    creditBalance: round2(Math.max(0, tuitionPaid - tuitionDue)),
    paidPercentage: tuitionDue > 0 ? Math.min(100, Math.max(0, Math.round((tuitionPaid / tuitionDue) * 100))) : 100,
  };
}
