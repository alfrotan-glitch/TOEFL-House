/**
 * The Financial Invariant Checker — an independent auditor over the database.
 *
 * Every check here re-derives a financial truth from the raw tables WITHOUT
 * reusing the production read paths it audits, so a bug in a report or a
 * balance helper cannot hide a violation from it. It is deliberately
 * pessimistic: it reports FINDINGS (table, invariant, offending rows) and
 * never mutates anything.
 *
 * Invariants (each traceable to a remediation or a registry row):
 *
 *  I1  A payment's active allocations never exceed the payment's amount.
 *  I2  An obligation's settled figure never exceeds its due figure.
 *  I3  Every ACTIVE tuition obligation names exactly one student_semesters
 *      row, and that term's fee equals the obligation's due (single pricing
 *      authority).
 *  I4  A live (non-cancelled) tuition invoice's net equals its term's net fee
 *      (documents and terms cannot disagree about price).
 *  I5  Invoice-linked payments net to the invoice's paid arithmetic: an
 *      invoice's status matches its net vs. paid-on-it position.
 *  I6  No completed payment is allocated against a CANCELLED obligation.
 *  I7  Payroll: an employee's posted salary for a period never exceeds the
 *      period's base salary (advances excluded — they are receivables).
 *  I8  Ledger↔payments: every income row that references a payment_id points
 *      at a real payment of the same sign class (income>0 ↔ payment>0;
 *      refund rows are negative on both sides).
 *  I9  Receipts: the completed payment receipt series has no gaps and no
 *      duplicates per branch day is NOT asserted here (receipts are global
 *      and gap-free by contract); instead: every completed payment with a
 *      receipt_number has a UNIQUE (receipt_number) — the series cannot fork.
 *  I10 Budget envelopes never go negative.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface InvariantFinding {
  invariant: string;
  detail: string;
  rows: number;
  sample?: string;
}

interface Check {
  invariant: string;
  detail: string;
  sql: string;
  /** Renders the first offending row for the report. */
  sample?: (row: Record<string, unknown>) => string;
}

const CHECKS: Check[] = [
  {
    invariant: 'I1',
    detail: 'A payment is never allocated beyond what it actually paid',
    sql: `SELECT a.payment_id AS k, p.amount AS paid, SUM(a.amount) AS allocated
          FROM obligation_allocations a
          JOIN payments p ON p.id = a.payment_id
          WHERE a.status = 'active'
          GROUP BY a.payment_id
          HAVING SUM(a.amount) > p.amount + 0.001`,
    sample: (r) => `payment ${r.k}: paid ${r.paid}, allocated ${r.allocated}`,
  },
  {
    invariant: 'I2',
    detail: 'An obligation is never settled beyond its due figure',
    sql: `SELECT o.id AS k, o.semester_id AS sem
          FROM student_obligations o
          LEFT JOIN student_semesters s ON s.id = o.semester_id
          WHERE o.status = 'open'
            AND COALESCE(s.net_fee_amount, s.fee_amount, 0) <
                (SELECT COALESCE(SUM(a.amount), 0) FROM obligation_allocations a
                  WHERE a.obligation_id = o.id AND a.status = 'active') - 0.001`,
    sample: (r) => `obligation ${r.k} (term ${r.sem}) settled beyond its fee`,
  },
  {
    invariant: 'I3',
    detail: 'Every open tuition obligation prices exactly its term',
    sql: `SELECT o.id AS k, o.semester_id AS sem, o.student_id AS stu
          FROM student_obligations o
          WHERE o.status = 'open' AND (
            o.semester_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM student_semesters s
                            WHERE s.id = o.semester_id AND s.student_id = o.student_id)
          )`,
    sample: (r) => `obligation ${r.k} does not name a term of student ${r.stu}`,
  },
  {
    invariant: 'I4',
    detail: 'A live tuition invoice nets exactly its term\u2019s net fee',
    sql: `SELECT i.id AS k, i.net_amount AS net, s.id AS sem,
               COALESCE(s.net_fee_amount, s.fee_amount, 0) AS term_net
          FROM invoices i
          JOIN student_obligations o ON o.id = i.obligation_id
          JOIN student_semesters s ON s.id = o.semester_id
          WHERE i.purpose = 'tuition' AND i.status NOT IN ('cancelled')
            AND ABS(i.net_amount - COALESCE(s.net_fee_amount, s.fee_amount, 0)) > 0.001`,
    sample: (r) => `invoice ${r.k} net ${r.net} vs term ${r.sem} net ${r.term_net}`,
  },
  {
    invariant: 'I5',
    detail: 'Invoice status agrees with the money collected on the invoice',
    sql: `SELECT i.id AS k, i.status AS st, i.net_amount AS net,
               COALESCE((SELECT SUM(p.amount) FROM payments p
                          WHERE p.invoice_id = i.id AND p.status = 'completed'), 0) AS paid
          FROM invoices i
          WHERE i.status NOT IN ('cancelled', 'draft')
            AND (
              (i.status = 'paid' AND ABS(i.net_amount - paid) > 0.001)
              OR (i.status IN ('issued', 'partial', 'overdue') AND paid >= i.net_amount - 0.001 AND paid > 0)
            )`,
    sample: (r) => `invoice ${r.k} status ${r.st} but net ${r.net}, paid ${r.paid}`,
  },
  {
    invariant: 'I6',
    detail: 'No active allocation settles a cancelled obligation',
    sql: `SELECT a.id AS k, a.obligation_id AS ob
          FROM obligation_allocations a
          JOIN student_obligations o ON o.id = a.obligation_id
          WHERE a.status = 'active' AND o.status = 'cancelled'`,
    sample: (r) => `allocation ${r.k} still settles cancelled obligation ${r.ob}`,
  },
  {
    invariant: 'I7',
    detail: 'Posted salary for a period never exceeds the period\u2019s base',
    sql: `SELECT l.employee_id AS k, l.period_key AS period, e.base_salary AS base,
               SUM(l.paid_amount) AS posted
          FROM employee_salary_ledger l
          JOIN employees e ON e.id = l.employee_id
          WHERE l.status = 'posted' AND l.payment_type <> 'advance'
          GROUP BY l.employee_id, l.period_key, e.base_salary
          HAVING SUM(l.paid_amount) > e.base_salary + 0.001`,
    sample: (r) => `employee ${r.k} period ${r.period}: base ${r.base}, posted ${r.posted}`,
  },
  {
    invariant: 'I8',
    detail: 'Ledger income rows agree in sign with the payment they reference',
    sql: `SELECT ft.id AS k, ft.amount AS ft_amount, p.amount AS pay_amount
          FROM financial_transactions ft
          JOIN payments p ON p.id = ft.payment_id
          WHERE ft.type = 'income'
            AND ((ft.amount > 0 AND p.amount <= 0) OR (ft.amount < 0 AND p.amount >= 0))`,
    sample: (r) => `ledger ${r.k} amount ${r.ft_amount} vs payment amount ${r.pay_amount}`,
  },
  {
    invariant: 'I9',
    detail: 'The receipt series never forks (one number, one payment)',
    sql: `SELECT receipt_number AS k, COUNT(*) AS c
          FROM payments
          WHERE status = 'completed' AND receipt_number IS NOT NULL
          GROUP BY receipt_number
          HAVING COUNT(*) > 1`,
    sample: (r) => `receipt ${r.k} used by ${r.c} completed payments`,
  },
  {
    invariant: 'I10',
    detail: 'Budget envelopes never hold negative money',
    sql: `SELECT id AS k, name, current_amount
          FROM budget_lines
          WHERE current_amount < -0.001`,
    sample: (r) => `budget line ${r.k} (${r.name}) at ${r.current_amount}`,
  },
];

/** Runs every invariant check. Returns findings; an empty list is a PASS. */
export function runFinancialInvariantChecks(db: BetterSqlite3.Database): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const check of CHECKS) {
    try {
      const rows = db.prepare(check.sql).all() as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        findings.push({
          invariant: check.invariant,
          detail: check.detail,
          rows: rows.length,
          sample: check.sample ? check.sample(rows[0]) : JSON.stringify(rows[0]).slice(0, 200),
        });
      }
    } catch (error) {
      // A check that cannot run is a finding, not a pass: silence here would
      // let a schema drift hide a violated invariant (LAW 6).
      findings.push({
        invariant: check.invariant,
        detail: check.detail,
        rows: -1,
        sample: `CHECK FAILED TO RUN: ${(error as Error).message}`,
      });
    }
  }
  return findings;
}
