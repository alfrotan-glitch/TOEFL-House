/**
 * Student balance — ONE canonical student receivable authority.
 * ============================================================================
 * Tuition remains the semester/obligation-backed authority. Non-tuition money
 * remains the invoice-backed authority. This module composes them into ONE
 * student position so registration and placement invoices participate in the
 * same balance truth as tuition without turning invoices into a second tuition
 * engine.
 */
import type { Database } from 'better-sqlite3';

/**
 * Payment categories that can affect tuition: the two tuition charges, plus
 * refunds — which count only when the payment they reverse is itself a tuition
 * charge. `TUITION_PAYMENT_SQL` below is the executable form of that rule.
 */
export const TUITION_PAYMENT_CATEGORIES = ['fee', 'installment', 'refund'] as const;

export type BalanceScope = 'all' | 'active';
export type NonTuitionPurpose = 'registration' | 'placement' | 'books' | 'exam' | 'other';

export interface StudentNonTuitionBalanceRow {
  purpose: NonTuitionPurpose;
  due: number;
  paid: number;
  outstanding: number;
  openInvoices: number;
}

export interface StudentBalance {
  /** Total tuition charged, post-discount, for the semesters in scope. */
  tuitionDue: number;
  /** Tuition discharged by memo write-off (W21): never paid, never owed again. */
  tuitionDischarged: number;
  /** Net tuition paid: fee + installment + refund (refunds are negative). */
  tuitionPaid: number;
  /** Tuition outstanding only. Preserved as the tuition authority. */
  outstanding: number;
  /** Tuition credit only. */
  creditBalance: number;
  /** 0-100 for tuition only, clamped. 100 when nothing was ever charged. */
  paidPercentage: number;
  /** Invoice-backed charges that are not tuition. */
  nonTuitionDue: number;
  nonTuitionPaid: number;
  nonTuitionOutstanding: number;
  /** Whole student receivable position. */
  totalDue: number;
  totalPaid: number;
  totalOutstanding: number;
  totalCreditBalance: number;
  /** Open non-draft, non-cancelled non-tuition invoices still carrying debt. */
  openInvoices: number;
  /** Per-purpose non-tuition rollup, e.g. registration vs placement. */
  nonTuitionBreakdown: StudentNonTuitionBalanceRow[];
}

export interface StudentNonTuitionSummary {
  nonTuitionDue: number;
  nonTuitionPaid: number;
  nonTuitionOutstanding: number;
  openInvoices: number;
  nonTuitionBreakdown: StudentNonTuitionBalanceRow[];
}

/**
 * Derive the TUITION position from already-computed totals. Pure — unit safe.
 * A memo discharge (W21) retires the remainder without being a payment, so it
 * is counted SEPARATELY from tuitionPaid — reporting a discharged term as
 * "paid" would be a misstatement.
 */
function deriveTuitionPosition(tuitionDue: number, tuitionPaid: number, tuitionDischarged = 0) {
  const due = Number(tuitionDue) || 0;
  const paid = Number(tuitionPaid) || 0;
  const discharged = Number(tuitionDischarged) || 0;
  return {
    tuitionDue: due,
    tuitionPaid: paid,
    tuitionDischarged: discharged,
    outstanding: Math.max(0, due - paid - discharged),
    creditBalance: Math.max(0, paid - due),
    paidPercentage: due > 0 ? Math.min(100, Math.max(0, Math.round((paid / due) * 100))) : 100,
  };
}

/** Backwards-safe export name retained for callers/tests that derive tuition only. */
export function deriveBalance(tuitionDue: number, tuitionPaid: number): StudentBalance {
  return composeStudentBalance(tuitionDue, tuitionPaid, {
    nonTuitionDue: 0,
    nonTuitionPaid: 0,
    nonTuitionOutstanding: 0,
    openInvoices: 0,
    nonTuitionBreakdown: [],
  });
}

function composeStudentBalance(
  tuitionDue: number,
  tuitionPaid: number,
  nonTuition: StudentNonTuitionSummary,
  tuitionDischarged = 0,
): StudentBalance {
  const tuition = deriveTuitionPosition(tuitionDue, tuitionPaid, tuitionDischarged);
  const nonTuitionDue = Number(nonTuition.nonTuitionDue) || 0;
  const nonTuitionPaid = Number(nonTuition.nonTuitionPaid) || 0;
  const nonTuitionOutstanding = Number(nonTuition.nonTuitionOutstanding) || 0;
  const totalDue = tuition.tuitionDue + nonTuitionDue;
  const totalPaid = tuition.tuitionPaid + nonTuitionPaid;
  return {
    ...tuition,
    nonTuitionDue,
    nonTuitionPaid,
    nonTuitionOutstanding,
    totalDue,
    totalPaid,
    totalOutstanding: tuition.outstanding + nonTuitionOutstanding,
    totalCreditBalance: Math.max(0, totalPaid - totalDue),
    openInvoices: Number(nonTuition.openInvoices) || 0,
    nonTuitionBreakdown: nonTuition.nonTuitionBreakdown,
  };
}

/**
 * The net amount a semester bills. `net_fee_amount` is post-discount; the gross
 * figure overstates a discounted student's debt. Exported so the obligation
 * authority reads the same expression instead of restating it (§13, LAW 1).
 */
export const TUITION_NET_SQL = 'COALESCE(net_fee_amount, fee_amount)';

/** Charge categories that pay down tuition. */
const TUITION_CHARGE_SQL = `'fee','installment'`;

/**
 * A payment counts towards TUITION when it is a tuition charge, or a refund of
 * one. `refunds_payment_id` is the attribution: it is NOT NULL on every refund
 * (enforced by `trg_payments_refund_attribution_*`) and NULL on every charge.
 */
// Exported (W15) so the receivables-aging view reuses the exact attribution
// rule instead of restating it — one rule, two readers (LAW 1).
export const TUITION_PAYMENT_SQL = `(
  category IN (${TUITION_CHARGE_SQL})
  OR (category = 'refund' AND (
        SELECT t.category FROM payments t WHERE t.id = payments.refunds_payment_id
      ) IN (${TUITION_CHARGE_SQL}))
)`;

/**
 * SQL fragment: the instruments that settle tuition without moving cash.
 */
export const AID_SOURCE_KINDS_SQL = `('scholarship','sponsorship')`;

/**
 * W21: active MEMO discharges — write_off allocations. Kept deliberately OUT
 * of AID_SOURCE_KINDS_SQL: aid is donor money with capacity semantics; a
 * discharge settles nothing and touches no fund. Every tuition-outstanding
 * derivation subtracts this term alongside payments and aid.
 */
export const WRITE_OFF_ALLOCATION_SQL = `a.source_kind = 'write_off' AND a.status = 'active'`;

/**
 * An ACTIVE cash allocation: the source-kind/status pairing every "settled in
 * cash" reader applies.
 */
export const CASH_ALLOCATION_SQL = "a.source_kind = 'payment' AND a.status = 'active'";

/** Aid money applied to any of this student's tuition obligations. */
function studentScholarshipSettled(db: Database, studentId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
        WHERE o.student_id = ? AND o.kind = 'tuition'
          AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'`,
    )
    .get(studentId) as { total: number };
  return Number(row.total) || 0;
}

export const NON_TUITION_KIND_SQL = `COALESCE(i.charge_kind, CASE WHEN i.purpose IN ('books','exam') THEN i.purpose ELSE 'other' END)`;

function mapPurpose(value: string): NonTuitionPurpose {
  if (value === 'registration' || value === 'placement' || value === 'books' || value === 'exam') return value;
  return 'other';
}

function emptyNonTuitionSummary(): StudentNonTuitionSummary {
  return {
    nonTuitionDue: 0,
    nonTuitionPaid: 0,
    nonTuitionOutstanding: 0,
    openInvoices: 0,
    nonTuitionBreakdown: [],
  };
}

/**
 * Invoice-backed, non-tuition receivables for one student.
 *
 * Tuition is deliberately excluded: tuition debt is semester/obligation truth,
 * and counting invoices here would reintroduce the very duplicate authority the
 * tuition settlement work removed.
 */
export function getStudentNonTuitionSummary(
  db: Database,
  studentId: string,
  purposes?: readonly string[],
): StudentNonTuitionSummary {
  const filter = purposes && purposes.length > 0
    ? `AND ${NON_TUITION_KIND_SQL} IN (${purposes.map(() => '?').join(',')})`
    : `AND i.purpose <> 'tuition'`;
  const rows = db.prepare(
    `SELECT ${NON_TUITION_KIND_SQL} AS purpose,
            COALESCE(SUM(i.net_amount), 0) AS due,
            COALESCE(SUM(COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.invoice_id = i.id AND p.status = 'completed'
            ), 0)), 0) AS paid,
            COALESCE(SUM(MAX(0, i.net_amount - COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.invoice_id = i.id AND p.status = 'completed'
            ), 0))), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue')
              AND MAX(0, i.net_amount - COALESCE((
                SELECT SUM(p.amount) FROM payments p
                 WHERE p.invoice_id = i.id AND p.status = 'completed'
              ), 0)) > 0
            THEN 1 ELSE 0 END), 0) AS open_invoices
       FROM invoices i
      WHERE i.student_id = ?
        AND i.status NOT IN ('draft', 'cancelled')
        ${filter}
      GROUP BY ${NON_TUITION_KIND_SQL}
      ORDER BY ${NON_TUITION_KIND_SQL}`,
  ).all(studentId, ...(purposes ?? [])) as Array<{
    purpose: string;
    due: number;
    paid: number;
    outstanding: number;
    open_invoices: number;
  }>;

  const nonTuitionBreakdown = rows.map((row) => ({
    purpose: mapPurpose(String(row.purpose)),
    due: Number(row.due) || 0,
    paid: Number(row.paid) || 0,
    outstanding: Number(row.outstanding) || 0,
    openInvoices: Number(row.open_invoices) || 0,
  }));
  return {
    nonTuitionDue: nonTuitionBreakdown.reduce((sum, row) => sum + row.due, 0),
    nonTuitionPaid: nonTuitionBreakdown.reduce((sum, row) => sum + row.paid, 0),
    nonTuitionOutstanding: nonTuitionBreakdown.reduce((sum, row) => sum + row.outstanding, 0),
    openInvoices: nonTuitionBreakdown.reduce((sum, row) => sum + row.openInvoices, 0),
    nonTuitionBreakdown,
  };
}

function getStudentNonTuitionSummariesByIds(
  db: Database,
  studentIds: readonly string[],
): Map<string, StudentNonTuitionSummary> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  const out = new Map<string, StudentNonTuitionSummary>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT i.student_id AS student_id,
            ${NON_TUITION_KIND_SQL} AS purpose,
            COALESCE(SUM(i.net_amount), 0) AS due,
            COALESCE(SUM(COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.invoice_id = i.id AND p.status = 'completed'
            ), 0)), 0) AS paid,
            COALESCE(SUM(MAX(0, i.net_amount - COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.invoice_id = i.id AND p.status = 'completed'
            ), 0))), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue')
              AND MAX(0, i.net_amount - COALESCE((
                SELECT SUM(p.amount) FROM payments p
                 WHERE p.invoice_id = i.id AND p.status = 'completed'
              ), 0)) > 0
            THEN 1 ELSE 0 END), 0) AS open_invoices
       FROM invoices i
      WHERE i.student_id IN (SELECT value FROM json_each(?))
        AND i.status NOT IN ('draft', 'cancelled')
        AND i.purpose <> 'tuition'
      GROUP BY i.student_id, ${NON_TUITION_KIND_SQL}`,
  ).all(JSON.stringify(ids)) as Array<{
    student_id: string;
    purpose: string;
    due: number;
    paid: number;
    outstanding: number;
    open_invoices: number;
  }>;

  for (const row of rows) {
    const current = out.get(row.student_id) ?? emptyNonTuitionSummary();
    const mapped: StudentNonTuitionBalanceRow = {
      purpose: mapPurpose(String(row.purpose)),
      due: Number(row.due) || 0,
      paid: Number(row.paid) || 0,
      outstanding: Number(row.outstanding) || 0,
      openInvoices: Number(row.open_invoices) || 0,
    };
    current.nonTuitionBreakdown = [...current.nonTuitionBreakdown, mapped];
    current.nonTuitionDue += mapped.due;
    current.nonTuitionPaid += mapped.paid;
    current.nonTuitionOutstanding += mapped.outstanding;
    current.openInvoices += mapped.openInvoices;
    out.set(row.student_id, current);
  }
  return out;
}

/** Authoritative single-student balance, read straight from the database. */
export function getStudentBalance(db: Database, studentId: string, scope: BalanceScope = 'all'): StudentBalance {
  const semesterFilter = scope === 'active' ? `AND status = 'active'` : '';
  const due = db
    .prepare(
      `SELECT COALESCE(SUM(${TUITION_NET_SQL}), 0) AS total
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

  const tuitionPaid = Number(paid.total) + studentScholarshipSettled(db, studentId);
  const discharged = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
        WHERE o.student_id = ? AND ${WRITE_OFF_ALLOCATION_SQL}`,
    )
    .get(studentId) as { total: number };
  return composeStudentBalance(due.total, tuitionPaid, getStudentNonTuitionSummary(db, studentId), Number(discharged.total) || 0);
}

/** One roster row: a student id plus their authoritative balance. */
export interface StudentBalanceRow extends StudentBalance {
  studentId: string;
}

/**
 * Balances for a page of the roster, in one query, then enriched with the same
 * non-tuition receivable truth used by the single-student reader.
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
              COALESCE(paid.total, 0) + COALESCE(aid.total, 0) AS tuition_paid
         FROM students st
         LEFT JOIN (
           SELECT student_id, SUM(${TUITION_NET_SQL}) AS total
           FROM student_semesters ${semesterFilter} GROUP BY student_id
         ) sem ON sem.student_id = st.id
         LEFT JOIN (
           SELECT student_id, SUM(amount) AS total
           FROM payments
           WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
           GROUP BY student_id
         ) paid ON paid.student_id = st.id
         LEFT JOIN (
           SELECT o.student_id AS student_id, SUM(a.amount) AS total
           FROM obligation_allocations a
           JOIN student_obligations o ON o.id = a.obligation_id
           WHERE o.kind = 'tuition' AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'
           GROUP BY o.student_id
         ) aid ON aid.student_id = st.id
         LEFT JOIN (
           SELECT o.student_id AS student_id, SUM(a.amount) AS total
           FROM obligation_allocations a
           JOIN student_obligations o ON o.id = a.obligation_id
           WHERE ${WRITE_OFF_ALLOCATION_SQL}
           GROUP BY o.student_id
         ) written_off ON written_off.student_id = st.id
         ${branchFilter}
         ORDER BY st.registration_date DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{ student_id: string; tuition_due: number; tuition_paid: number; written_off_total: number | null }>;

  const nonTuitionByStudent = getStudentNonTuitionSummariesByIds(db, rows.map((row) => row.student_id));
  return rows.map((row) => ({
    studentId: row.student_id,
    ...composeStudentBalance(row.tuition_due, row.tuition_paid, nonTuitionByStudent.get(row.student_id) ?? emptyNonTuitionSummary(), Number(row.written_off_total) || 0),
  }));
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
            COALESCE(paid.total, 0) + COALESCE(aid.total, 0) AS tuition_paid
       FROM students st
       LEFT JOIN (
         SELECT student_id, SUM(${TUITION_NET_SQL}) AS total
         FROM student_semesters ${semesterFilter} GROUP BY student_id
       ) sem ON sem.student_id = st.id
       LEFT JOIN (
         SELECT student_id, SUM(amount) AS total
         FROM payments
         WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
         GROUP BY student_id
       ) paid ON paid.student_id = st.id
       LEFT JOIN (
         SELECT o.student_id AS student_id, SUM(a.amount) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
         WHERE o.kind = 'tuition' AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'
         GROUP BY o.student_id
       ) aid ON aid.student_id = st.id
       LEFT JOIN (
         SELECT o.student_id AS student_id, SUM(a.amount) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
         WHERE ${WRITE_OFF_ALLOCATION_SQL}
         GROUP BY o.student_id
       ) written_off ON written_off.student_id = st.id
      WHERE st.id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(ids)) as Array<{ student_id: string; tuition_due: number; tuition_paid: number; written_off_total: number | null }>;
  const nonTuitionByStudent = getStudentNonTuitionSummariesByIds(db, ids);
  return rows.map((row) => ({
    studentId: row.student_id,
    ...composeStudentBalance(row.tuition_due, row.tuition_paid, nonTuitionByStudent.get(row.student_id) ?? emptyNonTuitionSummary(), Number(row.written_off_total) || 0),
  }));
}

/**
 * Outstanding tuition for one branch, or for the whole organization.
 */
export function getBranchOutstanding(db: Database, branchId: string | null): number {
  const scope = branchId ? 'AND st.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(MAX(0, sem.total - COALESCE(paid.total, 0) - COALESCE(aid.total, 0) - COALESCE(written_off.total, 0))), 0) AS outstanding
       FROM (
         SELECT student_id, SUM(${TUITION_NET_SQL}) AS total
         FROM student_semesters GROUP BY student_id
       ) sem
       JOIN students st ON st.id = sem.student_id ${scope}
       LEFT JOIN (
         SELECT student_id, SUM(amount) AS total
         FROM payments
         WHERE status = 'completed' AND ${TUITION_PAYMENT_SQL}
         GROUP BY student_id
       ) paid ON paid.student_id = sem.student_id
       LEFT JOIN (
         SELECT o.student_id, SUM(a.amount) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
         WHERE a.status = 'active' AND a.source_kind IN ${AID_SOURCE_KINDS_SQL}
         GROUP BY o.student_id
       ) aid ON aid.student_id = sem.student_id
       LEFT JOIN (
         SELECT o.student_id, SUM(a.amount) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
         WHERE ${WRITE_OFF_ALLOCATION_SQL}
         GROUP BY o.student_id
       ) written_off ON written_off.student_id = sem.student_id`,
    )
    .get(...params) as { outstanding: number };
  return Number(row.outstanding) || 0;
}

/** Outstanding NON-tuition receivables for one branch, or the whole organization. */
export function getBranchNonTuitionOutstanding(db: Database, branchId: string | null): number {
  const row = (branchId
    ? db.prepare(
      `SELECT COALESCE(SUM(MAX(0, i.net_amount - COALESCE((
          SELECT SUM(p.amount) FROM payments p
           WHERE p.invoice_id = i.id AND p.status = 'completed'
        ), 0))), 0) AS remaining
         FROM invoices i
        WHERE i.branch_id = ? AND i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue')`
    ).get(branchId)
    : db.prepare(
      `SELECT COALESCE(SUM(MAX(0, i.net_amount - COALESCE((
          SELECT SUM(p.amount) FROM payments p
           WHERE p.invoice_id = i.id AND p.status = 'completed'
        ), 0))), 0) AS remaining
         FROM invoices i
        WHERE i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue')`
    ).get()) as { remaining: number };
  return Number(row.remaining) || 0;
}
