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
 *   TUITION PAID  = SUM(amount) over completed payments whose category is
 *                   'fee', 'installment' or 'refund'.
 *                   Refunds are stored SIGNED (negative), so including them
 *                   subtracts. Omitting them credits the student with money
 *                   that was handed back.
 *                   Non-tuition categories (book, card, exam, diploma,
 *                   placement, chapter, other) are excluded — they are real
 *                   income but they do not pay down tuition.
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

/** Payment categories that pay down tuition. Refund is signed-negative. */
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Derive the balance from already-computed totals. Pure — safe to unit test. */
export function deriveBalance(tuitionDue: number, tuitionPaid: number): StudentBalance {
  const due = round2(Number(tuitionDue) || 0);
  const paid = round2(Number(tuitionPaid) || 0);
  return {
    tuitionDue: due,
    tuitionPaid: paid,
    outstanding: round2(Math.max(0, due - paid)),
    creditBalance: round2(Math.max(0, paid - due)),
    paidPercentage: due > 0 ? Math.min(100, Math.max(0, Math.round((paid / due) * 100))) : 100,
  };
}

const CATEGORY_SQL = TUITION_PAYMENT_CATEGORIES.map((c) => `'${c}'`).join(',');

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
       WHERE student_id = ? AND status = 'completed' AND category IN (${CATEGORY_SQL})`,
    )
    .get(studentId) as { total: number };

  return deriveBalance(due.total, paid.total);
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
           WHERE status = 'completed' AND category IN (${CATEGORY_SQL})
           GROUP BY student_id
         ) paid ON paid.student_id = st.id
         ${branchFilter}
         ORDER BY st.registration_date DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{ student_id: string; tuition_due: number; tuition_paid: number }>;

  return rows.map((r) => ({ studentId: r.student_id, ...deriveBalance(r.tuition_due, r.tuition_paid) }));
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
         WHERE status = 'completed' AND category IN (${CATEGORY_SQL})
         GROUP BY student_id
       ) paid ON paid.student_id = sem.student_id`,
    )
    .get(branchId) as { outstanding: number };
  return round2(row.outstanding);
}
