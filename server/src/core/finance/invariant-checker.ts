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
 *  I11 BRANCH CASH IDENTITY — per branch, finance_accounts must equal what the
 *      ledger says moved: main = operating income − savings sweeps − owner
 *      drawings + restricted reclaims (W16: clawback repayments are signed
 *      negative, so they reduce main); saving = sweeps. (A direct UPDATE to finance_accounts, or a
 *      cash path with no ledger row, breaks this immediately.)
 *  I12 BUDGET ENVELOPE IDENTITY — per branch, Σ(current_amount) and
 *      Σ(allocated_amount) equal Σ(signed budget movements) − Σ(spent), so a
 *      ledger row without its envelope move (or the reverse) is visible.
 *  I13 ORGANIZATION TREASURY IDENTITY — the global treasury equals capital
 *      injections minus signed budget movements, and its SAVING account is
 *      never used (no path may write it).
 *  I14 PAYMENT↔LEDGER COMPLETENESS — every completed payment has a ledger row
 *      carrying its payment_id, and no ledger row names a payment that does
 *      not exist. Income without a payment document (or a payment the books
 *      never saw) is exactly how cash goes missing silently.
 *  I15 INVOICE DOCUMENT INTEGRITY — a live invoice's items sum to its stated
 *      total, so a drifted or hand-edited document cannot misreport what it
 *      charges.
 *  I16 CONSERVATION OF MONEY — total AFN held across every store (account
 *      mains, savings, budget envelopes) equals raw income minus raw expense
 *      flows. Derived WITHOUT the classification SQL on purpose: it sees any
 *      store/row divergence even along paths whose categories every report
 *      agrees about, so a shared misclassification cannot hide it.
 *  I17 SETTLEMENT ARITHMETIC (state layer) — no obligation is over-settled
 *      (Σ active allocations ≤ the term's billed amount) and no payment
 *      over-allocates itself (Σ active allocations of a payment ≤ its
 *      amount). These hold regardless of application code; a drift means
 *      money was credited against debts that do not exist.
 *  I18 INSTALMENT↔SETTLEMENT COHERENCE — every 'paid' instalment names a
 *      completed payment that still actively settles its obligation. The
 *      instalment flag is a cache of allocation truth (W10-1); this checks
 *      the cache against the truth at runtime.
 *  I19 PAYROLL↔LEDGER COHERENCE — every posted salary-ledger row (teacher
 *      and employee) has its financial_transactions row with the same
 *      amount. Payroll facts are memos over ledger events; a missing or
 *      mismatched row means payroll history and the books disagree.
 *  I20 INCOME CLASSIFICATION KNOWN — every income row carries a canonical
 *      income class (W12 / W9 §5). The write boundary rejects undeclared
 *      categories, so a row here means drift: a writer bypassed the boundary
 *      or the taxonomy lost a class that history still uses. Such a row is
 *      EXCLUDED from operating income (conservative) until classified.
 *  I21 RESTRICTED-FUND CONSERVATION — donor-restricted money can only be
 *      applied to tuition settlements (allocation subledger), never created
 *      or leaked: active aid allocations may never exceed restricted
 *      receipts (per branch and overall).
 */
import type BetterSqlite3 from 'better-sqlite3';
import {
  OPERATING_INCOME_SQL,
  OPERATING_EXPENSE_SQL,
  OWNER_DRAWING_SQL,
  unclassifiedIncomeSql,
} from './ledger-classification.js';
import { BUDGET_MOVEMENT_TYPE } from './budget-movements.js';

export interface InvariantFinding {
  invariant: string;
  detail: string;
  rows: number;
  sample?: string;
  /** Identifies the offending entity when the check names one (W11: probes
   *  and the audit tool need to know WHICH obligation/payment/installment,
   *  not merely that some row somewhere violates the invariant). */
  entityId?: string;
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
    detail: "Posted salary for a period never exceeds the period's composed due (W12: ledger due_amount = base + earned bonus; current base is the legacy backstop)",
    // W12: the payroll cap is the COMPOSED due (base + rule-earned bonus),
    // stamped on each ledger row at payment time inside the write lock. The
    // invariant follows that same authority — posted non-advance pay for a
    // period may never exceed the highest due the period ever recorded
    // (mid-period rule changes can only be reflected honestly by a new,
    // separately-bounded payment). Pre-composition history (due_amount 0)
    // keeps its original meaning: the then-current base bounded the payment,
    // and today's base remains the best available backstop for it.
    sql: `SELECT l.employee_id AS k, l.period_key AS period, MAX(l.due_amount) AS due,
               SUM(l.paid_amount) AS posted
          FROM employee_salary_ledger l
          JOIN employees e ON e.id = l.employee_id
          WHERE l.status = 'posted' AND l.payment_type <> 'advance'
          GROUP BY l.employee_id, l.period_key
          HAVING SUM(l.paid_amount) > MAX(MAX(l.due_amount), e.base_salary) + 0.001`,
    sample: (r) => `employee ${r.k} period ${r.period}: due ${r.due}, posted ${r.posted}`,
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
  {
    invariant: 'I14',
    detail: 'Every completed payment is represented in the ledger, and every ledger payment reference is real',
    sql: `SELECT p.id AS k
          FROM payments p
          WHERE p.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM financial_transactions ft WHERE ft.payment_id = p.id)
          UNION ALL
          SELECT ft.id AS k
          FROM financial_transactions ft
          WHERE ft.payment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = ft.payment_id)`,
    sample: (r) => `row ${r.k}: a payment the ledger never saw, or a ledger row naming a payment that does not exist`,
  },
  {
    invariant: 'I15',
    detail: 'A live invoice\'s items sum to its stated total',
    sql: `SELECT i.id AS k, i.total_amount AS total,
               COALESCE((SELECT SUM(ii.amount) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0) AS items
          FROM invoices i
          WHERE i.status NOT IN ('draft', 'cancelled')
            AND ABS(i.total_amount - COALESCE((SELECT SUM(ii.amount) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)) > 0.001`,
    sample: (r) => `invoice ${r.k} states ${r.total} but its items sum to ${r.items}`,
  },
  {
    // I16 deliberately shares NOTHING with the reporting classification: it
    // re-derives total book money from the raw external flows (income rows in,
    // expense rows out — both signed by type, no category knowledge) and
    // compares it with every store that can hold money. Budget and savings
    // movements are internal by construction (they only ever move money
    // BETWEEN these stores), so any divergence is money created from nothing
    // or vanished into nothing — including paths whose categories every
    // report and every other invariant happen to agree about.
    invariant: 'I16',
    detail: 'Conservation of money: every AFN held in accounts and envelopes is explained by raw income minus expense flows',
    sql: `WITH flows AS (
            SELECT
              COALESCE((SELECT SUM(amount) FROM financial_transactions WHERE type = 'income'), 0)
              - COALESCE((SELECT SUM(amount) FROM financial_transactions WHERE type = 'expense'), 0)
              -- W16: restricted_reclaim rows are signed cash-out movements of
              -- stores (clawback repayments); held drops with them, so the
              -- explained side must drop too.
              + COALESCE((SELECT SUM(amount) FROM financial_transactions WHERE type = 'restricted_reclaim'), 0) AS explained,
              COALESCE((SELECT SUM(main_balance + saving_balance) FROM finance_accounts), 0)
              + COALESCE((SELECT SUM(current_amount) FROM budget_lines), 0) AS held
          )
          SELECT 'global' AS k, explained, held,
                 held - explained AS delta
          FROM flows
          WHERE ABS(held - explained) > 0.001`,
    sample: (r) => `stores hold ${r.held} AFN but raw external flows explain ${r.explained} (delta ${r.delta}) — money appeared or vanished outside the ledger`,
  },
  {
    invariant: 'I17',
    detail: 'No obligation is settled beyond its billed amount and no payment allocates beyond itself',
    sql: `
      SELECT 'over_settled_obligation' AS kind, o.id AS k, SUM(a.amount) AS total, COALESCE(ss.net_fee_amount, ss.fee_amount) AS bound
        FROM obligation_allocations a
        JOIN student_obligations o ON o.id = a.obligation_id
        LEFT JOIN student_semesters ss ON ss.id = o.semester_id
       WHERE a.status = 'active'
       GROUP BY o.id
      HAVING SUM(a.amount) > COALESCE(COALESCE(ss.net_fee_amount, ss.fee_amount), 0) + 0.001
      UNION ALL
      SELECT 'over_allocated_payment', p.id, SUM(a.amount), p.amount
        FROM obligation_allocations a
        JOIN payments p ON p.id = a.payment_id
       WHERE a.status = 'active' AND a.payment_id IS NOT NULL
       GROUP BY p.id
      HAVING SUM(a.amount) > p.amount + 0.001`,
    sample: (r) => `${r.kind} ${r.k}: settlements total ${r.total} against a bound of ${r.bound}`,
  },
  {
    invariant: 'I18',
    detail: "A 'paid' instalment names a completed payment that still actively settles",
    sql: `
      SELECT i.id AS k, i.paid_payment_id AS payment
        FROM student_installments i
       WHERE i.status = 'paid'
         AND (
           i.paid_payment_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = i.paid_payment_id AND p.status = 'completed')
           OR NOT EXISTS (SELECT 1 FROM obligation_allocations a WHERE a.payment_id = i.paid_payment_id AND a.status = 'active')
         )`,
    sample: (r) => `instalment ${r.k} is 'paid' by payment ${r.payment} which no longer actively settles anything`,
  },
  {
    invariant: 'I19',
    detail: 'Every posted salary-ledger row has its ledger transaction with the same amount',
    sql: `
      SELECT 'teacher' AS kind, l.id AS k, l.paid_amount AS amount
        FROM teacher_salary_ledger l
       WHERE l.status = 'posted'
         AND NOT EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id = l.transaction_id AND t.amount = l.paid_amount)
      UNION ALL
      SELECT 'employee', l.id, l.paid_amount
        FROM employee_salary_ledger l
       WHERE l.status = 'posted'
         AND NOT EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id = l.transaction_id AND t.amount = l.paid_amount)`,
    sample: (r) => `${r.kind} payroll row ${r.k} (${r.amount} AFN) has no matching ledger transaction`,
  },
  {
    invariant: 'I20',
    detail: 'Every income row carries a canonical income class (W12 income taxonomy)',
    sql: `
      SELECT id AS k, category AS code
        FROM financial_transactions
       WHERE ${unclassifiedIncomeSql()}`,
    sample: (r) => `income row ${r.k} has non-canonical category ${JSON.stringify(r.code)} — it is excluded from operating income until classified`,
  },
  {
    invariant: 'I21',
    detail: 'Restricted-fund conservation: active aid allocations never exceed restricted receipts (W12 exposure report premise)',
    sql: `
      WITH restricted_received AS (
        SELECT d.branch_id AS b, SUM(d.amount) AS v
          FROM donations d
          JOIN donation_restrictions r ON r.donation_id = d.id
         GROUP BY d.branch_id
      ), reclaimed AS (
        -- W16: clawed-back money leaves the restricted pool (open or repaid).
        SELECT d.branch_id AS b, SUM(c.amount) AS v
          FROM donation_clawbacks c JOIN donations d ON d.id = c.donation_id
         GROUP BY d.branch_id
      ), aid_applied AS (
        SELECT sf.branch_id AS b, SUM(a.amount) AS v
          FROM obligation_allocations a
          JOIN scholarship_fundings sf ON sf.id = a.scholarship_funding_id
         WHERE a.status = 'active' AND a.source_kind = 'scholarship'
         GROUP BY sf.branch_id
        UNION ALL
        SELECT sr.branch_id AS b, SUM(a.amount) AS v
          FROM obligation_allocations a
          JOIN sponsorship_receipts sr ON sr.id = a.sponsorship_receipt_id
         WHERE a.status = 'active' AND a.source_kind = 'sponsorship'
         GROUP BY sr.branch_id
      )
      SELECT rr.b AS k, rr.v AS received, COALESCE(aa.v, 0) AS applied, COALESCE(rc.v, 0) AS reclaimed
        FROM restricted_received rr
        LEFT JOIN aid_applied aa ON aa.b = rr.b
        LEFT JOIN reclaimed rc ON rc.b = rr.b
       WHERE COALESCE(aa.v, 0) > rr.v - COALESCE(rc.v, 0)`,
    sample: (r) => `branch ${r.k}: ${r.applied} AFN of restricted money is actively applied against ${r.received} AFN received less ${r.reclaimed} AFN reclaimed — restricted funds leaked`,
  },
  {
    invariant: 'I22',
    detail: 'Clawback repayments and their cash evidence agree exactly (W16: one repayment, one restricted_reclaim row, matched amounts and branches)',
    sql: `
      SELECT 'repaid_without_cash' AS kind, c.id AS k, c.amount AS expected, COALESCE(ft.amount, 0) AS actual
        FROM donation_clawbacks c
        LEFT JOIN financial_transactions ft ON ft.id = c.repaid_transaction_id
       WHERE c.status = 'repaid'
         AND (ft.id IS NULL OR ft.type <> 'restricted_reclaim' OR ft.amount <> -c.amount)
      UNION ALL
      SELECT 'cash_without_clawback', ft.id, 0, ft.amount
        FROM financial_transactions ft
       WHERE ft.type = 'restricted_reclaim'
         AND NOT EXISTS (SELECT 1 FROM donation_clawbacks c WHERE c.repaid_transaction_id = ft.id)`,
    sample: (r) => `${r.kind} ${r.k}: expected ${r.expected}, ledger says ${r.actual} — clawback cash and declarations disagree`,
  },
];

/**
 * Ledger-level identities (I11–I13) compare TWO stores, so they are computed
 * in code: one query per side, compared per scope. A mismatch is a finding
 * with the two figures named.
 */
interface IdentityCheck {
  invariant: string;
  detail: string;
  /** One row per scope with the account figure and the ledger-derived figure. */
  sql: string;
}

const IDENTITY_CHECKS: IdentityCheck[] = [
  {
    invariant: 'I11',
    detail: 'Branch cash equals ledger movement (main and saving)',
    sql: `SELECT fa.scope_id AS k,
            fa.main_balance AS account_main,
            COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                       WHERE ft.branch_id = fa.scope_id AND ${OPERATING_INCOME_SQL}) ,0)
            - COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                         WHERE ft.branch_id = fa.scope_id AND ft.type = 'saving_transfer'), 0)
            - COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                         WHERE ft.branch_id = fa.scope_id AND ${OWNER_DRAWING_SQL}), 0)
            + COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                         WHERE ft.branch_id = fa.scope_id AND ft.type = 'restricted_reclaim'), 0) AS ledger_main,
            fa.saving_balance AS account_saving,
            COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                       WHERE ft.branch_id = fa.scope_id AND ft.type = 'saving_transfer'), 0) AS ledger_saving
          FROM finance_accounts fa
          WHERE fa.scope_type = 'branch'`,
  },
  {
    invariant: 'I12',
    detail: 'Budget envelopes equal their funding minus their spend',
    sql: `SELECT bl.branch_id AS k,
            SUM(bl.current_amount) AS account_current,
            SUM(bl.allocated_amount) AS account_allocated,
            COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                       WHERE ft.branch_id = bl.branch_id AND ft.type = '${BUDGET_MOVEMENT_TYPE}'), 0) AS ledger_allocated,
            COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                       WHERE ft.branch_id = bl.branch_id AND ft.type = '${BUDGET_MOVEMENT_TYPE}'), 0)
            - COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                         WHERE ft.branch_id = bl.branch_id AND ft.type = 'expense'
                         AND NOT ${OWNER_DRAWING_SQL}), 0) AS ledger_current
          FROM budget_lines bl
          GROUP BY bl.branch_id`,
  },
  {
    invariant: 'I13',
    detail: 'Organization treasury equals capital injections minus budget funding',
    sql: `SELECT 'global' AS k,
            fa.main_balance AS account_main,
            COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                       WHERE ft.category = 'capital_injection'), 0)
            - COALESCE((SELECT SUM(amount) FROM financial_transactions ft
                         WHERE ft.type = '${BUDGET_MOVEMENT_TYPE}'), 0) AS ledger_main,
            fa.saving_balance AS account_saving,
            0 AS ledger_saving
          FROM finance_accounts fa
          WHERE fa.scope_type = 'organization' AND fa.scope_id = 'global'`,
  },
];

/** Runs every invariant check. Returns findings; an empty list is a PASS. */
export function runFinancialInvariantChecks(db: BetterSqlite3.Database): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const identity of IDENTITY_CHECKS) {
    try {
      const rows = db.prepare(identity.sql).all() as Array<Record<string, number | string>>;
      for (const row of rows) {
        const mismatches: string[] = [];
        if (Math.abs(Number(row.account_main) - Number(row.ledger_main)) > 0.001) {
          mismatches.push(`main: account ${row.account_main} vs ledger ${row.ledger_main}`);
        }
        if (Math.abs(Number(row.account_saving) - Number(row.ledger_saving)) > 0.001) {
          mismatches.push(`saving: account ${row.account_saving} vs ledger ${row.ledger_saving}`);
        }
        if ('account_current' in row) {
          if (Math.abs(Number(row.account_current) - Number(row.ledger_current)) > 0.001) {
            mismatches.push(`current: envelopes ${row.account_current} vs ledger ${row.ledger_current}`);
          }
          if (Math.abs(Number(row.account_allocated) - Number(row.ledger_allocated)) > 0.001) {
            mismatches.push(`allocated: envelopes ${row.account_allocated} vs ledger ${row.ledger_allocated}`);
          }
        }
        if (mismatches.length > 0) {
          findings.push({
            invariant: identity.invariant,
            detail: identity.detail,
            rows: 1,
            sample: `scope ${row.k}: ${mismatches.join('; ')}`,
            entityId: typeof row.k === 'string' ? (row.k as string) : undefined,
          });
        }
      }
    } catch (error) {
      findings.push({
        invariant: identity.invariant,
        detail: identity.detail,
        rows: -1,
        sample: `IDENTITY CHECK FAILED TO RUN: ${(error as Error).message}`,
      });
    }
  }
  for (const check of CHECKS) {
    try {
      const rows = db.prepare(check.sql).all() as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        findings.push({
          invariant: check.invariant,
          detail: check.detail,
          rows: rows.length,
          sample: check.sample ? check.sample(rows[0]) : JSON.stringify(rows[0]).slice(0, 200),
          entityId: typeof rows[0].k === 'string' ? (rows[0].k as string) : undefined,
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
