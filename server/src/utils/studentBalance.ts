/**
 * Student tuition balance — THE single authoritative definition.
 * ============================================================================
 * Before this module, five different places each re-derived "how much has this
 * student paid" with a different rule, and they disagreed:
 *
 *   StudentProfileDrawer  fee+installment+refund over ALL semesters
 *   StudentsView (list)   fee+installment+refund over ACTIVE semesters only
 *   StudentPortalView     fee+installment      over ACTIVE semesters (no refund!)
 *   bos dashboard         fee+installment      over ALL semesters (no refund!)
 *   checkAcademicHold     fee+installment+refund over ACTIVE semesters
 *
 * The same student could be shown 11,000 / 11,000 / 13,000 paid and a debt of
 * 2,000 / 2,000 / 0 depending on which screen you opened, and the dashboard
 * silently understated debt for every student who had ever been refunded.
 *
 * The rules, fixed once, here:
 *
 *   TUITION DUE   = SUM(COALESCE(net_fee_amount, fee_amount)) over the
 *                   semesters in scope. net_fee_amount is post-discount; the
 *                   gross amount overstates the debt of a discounted student.
 *
 *   TUITION PAID  = SUM(amount) over completed payments that are either a
 *                   'fee'/'installment' charge, or a refund THAT REVERSES ONE.
 *                   Refunds are stored SIGNED (negative), so including them
 *                   subtracts. Omitting them credits the student with money
 *                   that was handed back.
 *                   Non-tuition categories (book, card, exam, diploma,
 *                   placement, chapter, other) are excluded — they are real
 *                   income but they do not pay down tuition, and neither do
 *                   the refunds that reverse them. Counting every refund
 *                   against tuition made a refunded exam fee re-open tuition
 *                   debt the student did not owe (owner decision D-113:
 *                   `payments.refunds_payment_id` names what a refund
 *                   reverses).
 *
 *   OUTSTANDING   = MAX(0, due - paid). Never negative: an over-refunded or
 *                   over-paid student is a credit balance, reported separately
 *                   rather than as a negative debt.
 *
 * Scope: 'all' counts every semester (lifetime position, used on the profile);
 * 'active' counts only currently-active semesters (what the student owes right
 * now, used for enrollment holds and the roster list). Both are legitimate
 * questions — they just have to be asked explicitly instead of by accident.
 */
import type { Database } from 'better-sqlite3';

/**
 * Payment categories that can affect tuition: the two tuition charges, plus
 * refunds — which count only when the payment they reverse is itself a tuition
 * charge. `TUITION_PAYMENT_SQL` below is the executable form of that rule.
 */
export const TUITION_PAYMENT_CATEGORIES = ['fee', 'installment', 'refund'] as const;

export type BalanceScope = 'all' | 'active';

export interface StudentBalance {
  /** Total tuition charged, post-discount, for the semesters in scope. */
  tuitionDue: number;
  /** Net tuition paid: fee + installment + refund (refunds are negative). */
  tuitionPaid: number;
  /** MAX(0, due - paid). */
  outstanding: number;
  /** MAX(0, paid - due) — money held beyond what was charged. */
  creditBalance: number;
  /** 0-100, clamped. 100 when nothing was ever charged. */
  paidPercentage: number;
}

/** Derive the balance from already-computed totals. Pure — safe to unit test. */
export function deriveBalance(tuitionDue: number, tuitionPaid: number): StudentBalance {
  // Whole AFN (D-12/D-22): every stored money column is an INTEGER, so these
  // sums are already canonical and re-rounding them here would be a second
  // rounding authority.
  const due = Number(tuitionDue) || 0;
  const paid = Number(tuitionPaid) || 0;
  return {
    tuitionDue: due,
    tuitionPaid: paid,
    outstanding: Math.max(0, due - paid),
    creditBalance: Math.max(0, paid - due),
    paidPercentage: due > 0 ? Math.min(100, Math.max(0, Math.round((paid / due) * 100))) : 100,
  };
}

/** Charge categories that pay down tuition. */
const TUITION_CHARGE_SQL = `'fee','installment'`;

/**
 * A payment counts towards TUITION when it is a tuition charge, or a refund of
 * one. `refunds_payment_id` is the attribution: it is NOT NULL on every refund
 * (enforced by `trg_payments_refund_attribution_*`) and NULL on every charge.
 */
const TUITION_PAYMENT_SQL = `(
  category IN (${TUITION_CHARGE_SQL})
  OR (category = 'refund' AND (
        SELECT t.category FROM payments t WHERE t.id = payments.refunds_payment_id
      ) IN (${TUITION_CHARGE_SQL}))
)`;


/** Authoritative single-student balance, read straight from the database. */
export function getStudentBalance(db: Database, studentId: string, scope: BalanceScope = 'all'): StudentBalance {
  const semesterFilter = scope === 'active' ? `AND status = 'active'` : '';
  const due = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(net_fee_amount, fee_amount)), 0) AS total
       FROM student_semesters WHERE student_id = ? ${semesterFilter}`,
    )
    .get(studentId) as { total: number };

  const paid = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE student_id = ? AND status = 'completed' AND ${TUITION_PAYMENT_SQL}`,
    )
    .get(studentId) as { total: number };

  return deriveBalance(due.total, paid.total);
}

/**
 * Tuition settled against ONE semester.
 *
 * The semester is the filter, for both charges and refunds: a refund carries
 * the semester of the payment it reverses (owner decision D-114), and a refund
 * of a non-tuition charge carries none. Every caller must come here rather than
 * filter payments itself — a rule that counts refunds without checking their
 * semester inflates one term's debt with another term's refund, and the payment
 * desk then collects against a term that is already settled.
 */
export function getSemesterTuitionPaid(db: Database, studentId: string, semesterName: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM payments
        WHERE student_id = ? AND semester = ? AND status = 'completed'
          AND category IN ('fee','installment','refund')`,
    )
    .get(studentId, semesterName) as { paid: number };
  return Number(row.paid) || 0;
}

/** One roster row: a student id plus their authoritative balance. */
export interface StudentBalanceRow extends StudentBalance {
  studentId: string;
}

/**
 * Balances for a page of the roster, in one query.
 *
 * The roster endpoint calls this rather than inlining its own copy of the SQL.
 * A second copy diverges silently: summing only `status = 'active'` semesters
 * while getStudentBalance('all') sums every semester makes the list and the
 * profile disagree the moment a semester completes. Both scopes are legitimate
 * questions, but they must come from ONE definition — this one.
 *
 * `scope` matches getStudentBalance exactly, so a row here always equals
 * getStudentBalance(db, id, scope) for the same student.
 */
export function getStudentBalancesPage(
  db: Database,
  opts: { branchId: string | null; scope?: BalanceScope; limit: number; offset: number },
): StudentBalanceRow[] {
  const { branchId, scope = 'all', limit, offset } = opts;
  const semesterFilter = scope === 'active' ? `WHERE status = 'active'` : '';
  const branchFilter = branchId ? 'WHERE st.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];

  const rows = db
    .prepare(
      `SELECT st.id AS student_id,
              COALESCE(sem.total, 0) AS tuition_due,
              COALESCE(paid.total, 0) AS tuition_paid
         FROM students st
         LEFT JOIN (
           SELECT student_id, SUM(COALESCE(net_fee_amount, fee_amount)) AS total
           FROM student_semesters ${semesterFilter} GROUP BY student_id
         ) sem ON sem.student_id = st.id
         LEFT JOIN (
           SELECT student_id, SUM(amount) AS total
           FROM payments
           WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
           GROUP BY student_id
         ) paid ON paid.student_id = st.id
         ${branchFilter}
         ORDER BY st.registration_date DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{ student_id: string; tuition_due: number; tuition_paid: number }>;

  return rows.map((r) => ({ studentId: r.student_id, ...deriveBalance(r.tuition_due, r.tuition_paid) }));
}

/** Authoritative balances for an explicit, already-authorized student set. */
export function getStudentBalancesByIds(
  db: Database,
  studentIds: readonly string[],
  scope: BalanceScope = 'all',
): StudentBalanceRow[] {
  const ids = [...new Set(studentIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const semesterFilter = scope === 'active' ? `WHERE status = 'active'` : '';
  const rows = db.prepare(
    `SELECT st.id AS student_id,
            COALESCE(sem.total, 0) AS tuition_due,
            COALESCE(paid.total, 0) AS tuition_paid
       FROM students st
       LEFT JOIN (
         SELECT student_id, SUM(COALESCE(net_fee_amount, fee_amount)) AS total
         FROM student_semesters ${semesterFilter} GROUP BY student_id
       ) sem ON sem.student_id = st.id
       LEFT JOIN (
         SELECT student_id, SUM(amount) AS total
         FROM payments
         WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
         GROUP BY student_id
       ) paid ON paid.student_id = st.id
      WHERE st.id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(ids)) as Array<{ student_id: string; tuition_due: number; tuition_paid: number }>;
  return rows.map((row) => ({
    studentId: row.student_id,
    ...deriveBalance(row.tuition_due, row.tuition_paid),
  }));
}

/**
 * Branch-wide outstanding tuition — the dashboard figure.
 * Sums per-student outstanding (each floored at zero) so one student's credit
 * balance cannot mask another student's debt.
 */
export function getBranchOutstanding(db: Database, branchId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(MAX(0, sem.total - COALESCE(paid.total, 0))), 0) AS outstanding
       FROM (
         SELECT student_id, SUM(COALESCE(net_fee_amount, fee_amount)) AS total
         FROM student_semesters GROUP BY student_id
       ) sem
       JOIN students st ON st.id = sem.student_id AND st.branch_id = ?
       LEFT JOIN (
         SELECT student_id, SUM(amount) AS total
         FROM payments
         WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
         GROUP BY student_id
       ) paid ON paid.student_id = sem.student_id`,
    )
    .get(branchId) as { outstanding: number };
  return Number(row.outstanding) || 0;
}
