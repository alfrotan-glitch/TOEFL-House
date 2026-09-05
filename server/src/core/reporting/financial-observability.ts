/**
 * Financial observability — WAVE 15.
 * ============================================================================
 * Two READ-ONLY derived views, each a projection of existing canonical
 * authorities. This module composes authorities; it never becomes one:
 *
 *   · Receivables aging — the SAME receivable facts `/reports/overview`
 *     computes (WP07-F18b: tuition from `student_semesters` ⋈ payments ⋈
 *     active aid; non-tuition from open invoices ⋈ payments), decomposed to
 *     per-debt-item grain and bucketed by Jalali age. No new write surface,
 *     no status changes, no write-off semantics (P16 remains the owner's).
 *
 *   · Daily cash-activity statement — the DIGITAL expected movement of one
 *     branch's stores for one calendar date, reconstructed from the same
 *     identities invariants I16/I17 certify (branch main = branch-cash income
 *     − savings movement − owner drawings; branch saving = Σ saving_transfer).
 *     It is a statement of what the LEDGER says, full stop. It is NOT a
 *     physical count of a drawer: physical-cash control is gated on the
 *     Wave-14 D-CC owner decisions and is deliberately absent here.
 *
 * Registered in docs/registries/metrics.md as the specialized authority for
 * these two views (the impact-reporting precedent: row-level data a point
 * metric cannot carry). Route surfaces live in reports.routes.ts; this file
 * owns every number they serve.
 */
import type Database from 'better-sqlite3';
import {
  TUITION_NET_SQL,
  TUITION_PAYMENT_SQL,
  AID_SOURCE_KINDS_SQL,
  getBranchOutstanding,
  getBranchNonTuitionOutstanding,
} from '../../utils/studentBalance.js';
import { BRANCH_CASH_INCOME_SQL, OWNER_DRAWING_SQL, CAPITAL_INJECTION_CATEGORY } from '../finance/ledger-classification.js';
import { gregorianToJalali } from '../../utils/jalali.js';
import { today } from '../../utils/ids.js';

// ── Aging ──────────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  { key: 'current', label: 'Current', minMonths: 0, maxMonths: 0 },
  { key: '1-3m', label: '1–3 months', minMonths: 1, maxMonths: 3 },
  { key: '4-6m', label: '4–6 months', minMonths: 4, maxMonths: 6 },
  { key: '7-12m', label: '7–12 months', minMonths: 7, maxMonths: 12 },
  { key: '12m+', label: 'Over 12 months', minMonths: 13, maxMonths: Number.MAX_SAFE_INTEGER },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key'];

export interface AgingRow {
  kind: 'tuition' | 'invoice';
  studentId: string;
  studentName: string;
  branchId: string;
  /** semester_name for tuition; invoice number for non-tuition. */
  reference: string;
  originatedOn: string;
  dueDate: string | null;
  ageMonths: number;
  bucket: AgingBucketKey;
  billed: number;
  settled: number;
  outstanding: number;
}

export interface ReceivablesAgingResult {
  asOf: string;
  scope: 'organization' | 'branch';
  branchId: string | null;
  buckets: Array<{ key: AgingBucketKey; label: string; itemCount: number; tuition: number; nonTuition: number; total: number }>;
  rows: AgingRow[];
  totals: { tuition: number; nonTuition: number; total: number; itemCount: number };
  /**
   * Reconciliation to the aggregate receivable authority. The overview
   * receivable nets PER STUDENT (one overpaid term can offset a sibling term);
   * aging floors PER DEBT ITEM, which is the only truthful grain for "how old
   * is this money". Both figures are shown; neither is silently preferred.
   */
  crossFoot: {
    perItemTuition: number;
    perStudentNettedTuition: number;
    nonTuition: number;
    /** Completed tuition-category payments this branch's terms could not be
     *  attributed to by the payments.semester column. Production tuition
     *  writers always set it; a nonzero value is a data-integrity signal, not
     *  a number to be allocated by guesswork. */
    unattributedTuitionPayments: number;
  };
}

/** Whole Jalali months elapsed from `fromIso` to `asOfIso` (floor). */
export function jalaliMonthsElapsed(fromIso: string, asOfIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = asOfIso.split('-').map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  const from = gregorianToJalali(fy, fm, fd);
  const to = gregorianToJalali(ty, tm, td);
  const months = (to.jy - from.jy) * 12 + (to.jm - from.jm);
  return td < fd ? months - 1 : months;
}

export function bucketForAge(ageMonths: number): AgingBucketKey {
  for (const b of AGING_BUCKETS) if (ageMonths >= b.minMonths && ageMonths <= b.maxMonths) return b.key;
  return '12m+';
}

// TUITION_NET_SQL is written over bare column names (the aggregate authority
// sums it unqualified). Qualifying each column mechanically — still ONE
// primitive, no restated semantics.
const TUITION_NET_QUALIFIED_SQL = TUITION_NET_SQL
  .replace(/net_fee_amount/g, 'sem.net_fee_amount')
  .replace(/fee_amount/g, 'sem.fee_amount');

interface TuitionAgingFact {
  sem_id: string; student_id: string; student_name: string; branch_id: string;
  semester_name: string; enroll_date: string; billed: number; paid: number; aid: number;
}

interface InvoiceAgingFact {
  invoice_id: string; number: string | null; student_id: string | null; student_name: string | null;
  branch_id: string; issue_date: string; due_date: string | null; net_amount: number; paid: number;
}

export function getReceivablesAging(db: Database.Database, opts: { branchId: string | null; asOf: string }): ReceivablesAgingResult {
  const branchScope = opts.branchId ? 'AND st.branch_id = ?' : '';
  const params = opts.branchId ? [opts.branchId] : [];

  // Tuition facts — the exact row set and expressions the aggregate authority
  // (getBranchOutstanding) reads: every semester it prices, the same
  // TUITION_NET_SQL, the same completed-tuition-payment rule, the same active
  // aid instruments. Decomposed per term; payments attach by the payments
  // semester column, aid by the term's own obligation (uq_obligation_tuition_
  // semester makes that 1:1 when the row exists).
  const tuitionFacts = db.prepare(
    `SELECT sem.id AS sem_id, sem.student_id, st.full_name AS student_name, st.branch_id,
            sem.semester_name, sem.enroll_date,
            ${TUITION_NET_QUALIFIED_SQL} AS billed,
            COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.student_id = sem.student_id AND p.status = 'completed'
                 AND p.semester = sem.semester_name
                 AND ${TUITION_PAYMENT_SQL.replace(/\bpayments\./g, 'p.').replace(/FROM payments t/g, 'FROM payments t')}
            ), 0) AS paid,
            COALESCE((
              SELECT SUM(a.amount) FROM obligation_allocations a
               JOIN student_obligations o ON o.id = a.obligation_id
              WHERE o.semester_id = sem.id
                AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'
            ), 0) AS aid
       FROM student_semesters sem
       JOIN students st ON st.id = sem.student_id
      WHERE 1=1 ${branchScope}`,
  ).all(...params) as TuitionAgingFact[];

  // Non-tuition facts — identical grain and filters to
  // getBranchNonTuitionOutstanding (open invoices, completed payments, floored
  // per invoice), so the two cross-foot EXACTLY.
  const invoiceScope = opts.branchId ? 'AND i.branch_id = ?' : '';
  const invoiceParams = opts.branchId ? [opts.branchId] : [];
  const invoiceFacts = db.prepare(
    `SELECT i.id AS invoice_id, i.invoice_number AS number, i.student_id, st.full_name AS student_name,
            i.branch_id, i.issue_date, i.due_date, i.net_amount,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.invoice_id = i.id AND p.status = 'completed'), 0) AS paid
       FROM invoices i
       LEFT JOIN students st ON st.id = i.student_id
      WHERE i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue') ${invoiceScope}`,
  ).all(...invoiceParams) as InvoiceAgingFact[];

  const rows: AgingRow[] = [];
  for (const f of tuitionFacts) {
    const outstanding = Math.max(0, Number(f.billed) - Number(f.paid) - Number(f.aid));
    if (outstanding <= 0) continue;
    const ageMonths = Math.max(0, jalaliMonthsElapsed(f.enroll_date.slice(0, 10), opts.asOf));
    rows.push({
      kind: 'tuition', studentId: f.student_id, studentName: f.student_name, branchId: f.branch_id,
      reference: f.semester_name, originatedOn: f.enroll_date.slice(0, 10), dueDate: null,
      ageMonths, bucket: bucketForAge(ageMonths),
      billed: Number(f.billed), settled: Number(f.paid) + Number(f.aid), outstanding,
    });
  }
  for (const f of invoiceFacts) {
    const outstanding = Math.max(0, Number(f.net_amount) - Number(f.paid));
    if (outstanding <= 0) continue;
    const ageMonths = Math.max(0, jalaliMonthsElapsed(f.issue_date.slice(0, 10), opts.asOf));
    rows.push({
      kind: 'invoice', studentId: f.student_id ?? '', studentName: f.student_name ?? '(no student)', branchId: f.branch_id,
      reference: f.number ?? f.invoice_id, originatedOn: f.issue_date.slice(0, 10), dueDate: f.due_date ? f.due_date.slice(0, 10) : null,
      ageMonths, bucket: bucketForAge(ageMonths),
      billed: Number(f.net_amount), settled: Number(f.paid), outstanding,
    });
  }
  rows.sort((a, b) => b.outstanding - a.outstanding || a.ageMonths - b.ageMonths);

  const buckets = AGING_BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.bucket === b.key);
    const tuition = inBucket.filter((r) => r.kind === 'tuition').reduce((s, r) => s + r.outstanding, 0);
    const nonTuition = inBucket.filter((r) => r.kind === 'invoice').reduce((s, r) => s + r.outstanding, 0);
    return { key: b.key, label: b.label, itemCount: inBucket.length, tuition, nonTuition, total: tuition + nonTuition };
  });

  // Unattributed completed tuition payments: money the aggregate authority
  // counts per student that no term of THIS scope claims by semester column.
  // Surfaced, never allocated by guesswork.
  const pAliased = TUITION_PAYMENT_SQL.replace(/\bpayments\./g, 'p.');
  const unattributed = Number((db.prepare(
    `SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p
       WHERE p.status = 'completed' AND ${pAliased}
         AND p.semester IS NULL
         AND ${opts.branchId ? 'p.branch_id = ? AND ' : ''}EXISTS (
           SELECT 1 FROM student_semesters sem WHERE sem.student_id = p.student_id
         )`,
  ).get(...(opts.branchId ? [opts.branchId] : [])) as { v: number }).v) || 0;

  return {
    asOf: opts.asOf,
    scope: opts.branchId ? 'branch' : 'organization',
    branchId: opts.branchId,
    buckets,
    rows,
    totals: {
      tuition: rows.filter((r) => r.kind === 'tuition').reduce((s, r) => s + r.outstanding, 0),
      nonTuition: rows.filter((r) => r.kind === 'invoice').reduce((s, r) => s + r.outstanding, 0),
      total: rows.reduce((s, r) => s + r.outstanding, 0),
      itemCount: rows.length,
    },
    crossFoot: {
      perItemTuition: rows.filter((r) => r.kind === 'tuition').reduce((s, r) => s + r.outstanding, 0),
      perStudentNettedTuition: getBranchOutstanding(db, opts.branchId),
      nonTuition: getBranchNonTuitionOutstanding(db, opts.branchId),
      unattributedTuitionPayments: unattributed,
    },
  };
}

// ── Daily cash activity ────────────────────────────────────────────────────

export interface DailyCashActivityStatement {
  basis: 'digital-expected';
  note: string;
  date: string;
  branchId: string;
  opening: { main: number; saving: number };
  movements: {
    /** Signed sums of branch-cash income by canonical class (refunds appear as negative). */
    incomeByCategory: Array<{ category: string; amount: number }>;
    incomeTotal: number;
    refundsTotal: number;
    /** Sweep to saving (positive) or reclaim from saving (negative). */
    savingMovement: number;
    ownerDrawings: number;
    /** Clawback repayments to funders (signed cash-out, P&L-neutral). */
    restrictedReclaims: number;
  };
  closing: { main: number; saving: number };
  /** Equity injections stamped with this branch on this date. They credit the
   *  ORGANIZATION treasury, not branch cash, and are excluded from the math —
   *  shown so the exclusion is visible rather than silent. */
  memoEquityInjectionsThisBranch: Array<{ transactionId: string; amount: number; description: string }>;
}

/**
 * Branch stores for one date, reconstructed forward from today by the I16/I17
 * identities (which the invariant checker certifies): every main/saving delta
 * a branch store can carry is income (non-equity, signed), the savings
 * movement, or an owner drawing. Nothing else writes these accounts.
 */
export function getDailyCashActivity(db: Database.Database, opts: { branchId: string; date: string }): DailyCashActivityStatement {
  const { branchId, date } = opts;

  const sumSince = (sql: string, fromDate: string): number =>
    Number((db.prepare(`${sql} AND date >= ?`).get(branchId, fromDate) as { v: number }).v) || 0;

  const cashIncomeSince = sumSince(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${BRANCH_CASH_INCOME_SQL} AND branch_id = ?`,
    date,
  );
  const savingSince = sumSince(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='saving_transfer' AND branch_id = ?`,
    date,
  );
  const drawingsSince = sumSince(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OWNER_DRAWING_SQL} AND branch_id = ?`,
    date,
  );
  const reclaimsSince = sumSince(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='restricted_reclaim' AND branch_id = ?`,
    date,
  );

  const acct = db.prepare(`SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id=?`)
    .get(branchId) as { main_balance: number; saving_balance: number } | undefined;
  const mainNow = Number(acct?.main_balance ?? 0);
  const savingNow = Number(acct?.saving_balance ?? 0);

  const openingMain = mainNow - (cashIncomeSince - savingSince - drawingsSince + reclaimsSince);
  const openingSaving = savingNow - savingSince;

  const incomeRows = db.prepare(
    `SELECT category, SUM(amount) AS total FROM financial_transactions
      WHERE ${BRANCH_CASH_INCOME_SQL} AND branch_id = ? AND date = ? GROUP BY category ORDER BY category`,
  ).all(branchId, date) as Array<{ category: string; total: number }>;
  const savingMovement = Number((db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='saving_transfer' AND branch_id = ? AND date = ?`,
  ).get(branchId, date) as { v: number }).v) || 0;
  const drawings = Number((db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OWNER_DRAWING_SQL} AND branch_id = ? AND date = ?`,
  ).get(branchId, date) as { v: number }).v) || 0;
  const reclaims = Number((db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='restricted_reclaim' AND branch_id = ? AND date = ?`,
  ).get(branchId, date) as { v: number }).v) || 0;

  const incomeTotal = incomeRows.reduce((s, r) => s + Number(r.total), 0);
  const refundsTotal = incomeRows.reduce((s, r) => s + Math.min(0, Number(r.total)), 0);
  const equityMemo = db.prepare(
    `SELECT id AS transactionId, amount, description FROM financial_transactions
      WHERE type='income' AND category='${CAPITAL_INJECTION_CATEGORY}' AND branch_id = ? AND date = ?`,
  ).all(branchId, date) as Array<{ transactionId: string; amount: number; description: string }>;

  const dayMainDelta = incomeTotal - savingMovement - drawings + reclaims;
  return {
    basis: 'digital-expected',
    note: 'Digital expected cash per the ledger (I16/I17 identities). This is NOT a physical count; physical-cash control awaits the Wave-14 D-CC owner decisions.',
    date, branchId,
    opening: { main: openingMain, saving: openingSaving },
    movements: {
      incomeByCategory: incomeRows.map((r) => ({ category: r.category, amount: Number(r.total) })),
      incomeTotal, refundsTotal, savingMovement, ownerDrawings: drawings, restrictedReclaims: reclaims,
    },
    closing: { main: openingMain + dayMainDelta, saving: openingSaving + savingMovement },
    memoEquityInjectionsThisBranch: equityMemo,
  };
}

/** Canonical server today, exported for route defaults. */
export function canonicalToday(): string {
  return today();
}
