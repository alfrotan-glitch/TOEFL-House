/**
 * WAVE 21 · Write-offs and payroll withholding (owner-directed semantics,
 * 2026-09-05 — the numeric layer: rates, thresholds, materiality windows,
 * stays with the Owner and has NO surface here).
 * ============================================================================
 * Three capabilities, each moving money only where money actually moves:
 *
 *  · TUITION WRITE-OFF — unpaid tuition was never revenue, so discharging it
 *    is a MEMO event: one append-only `tuition_write_offs` row plus one
 *    source_kind='write_off' allocation (the memo settlement). No ledger row,
 *    no cash, no income, no expense. The obligation enters 'discharged'
 *    (final), its open invoices are marked 'written_off', and every balance
 *    derivation stops counting the discharged remainder. Re-instatement is an
 *    owner act — no route exists for it.
 *
 *  · EMPLOYEE-ADVANCE WRITE-OFF — the cash left at advance time (an
 *    envelope-backed 'salary_advance' expense fact). Writing the advance off
 *    moves no money: it appends an `advance_write_offs` event that pins the
 *    fact as uncollectible, so the operating-expense lens counts that SAME
 *    row as a staff cost while the non-expense lens stops counting it. The
 *    immutable ledger row itself is untouched.
 *
 *  · PAYROLL WITHHOLDING — wage payments book GROSS. A declaration states
 *    what was withheld at source from one posted wage fact; the cash stays in
 *    the branch drawer as a LIABILITY (never income, never a second expense).
 *    Remittance hands it to the authority through a signed-negative,
 *    P&L-neutral 'withholding_remittance' row at branch main — the same
 *    evidence pattern as clawback repayments.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { id, today } from '../../utils/ids.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { decrementMainBalanceIfSufficient } from '../../utils/financeAccounts.js';
import { assertMoney } from '../../utils/money.js';
import { getObligationPosition } from './obligations.js';

// ── Tuition write-off (memo discharge) ──────────────────────────────────────

export interface TuitionWriteOffResult {
  writeOffId: string;
  allocationId: string;
  amount: number;
  writtenOffInvoices: string[];
}

/** Discharges the obligation's remaining tuition as uncollectible — a memo. */
export function dischargeTuitionObligation(
  db: BetterSqlite3.Database,
  params: { obligationId: string; reason: string; declaredBy: string },
): TuitionWriteOffResult {
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A discharge reason of at least 8 characters is required.');

  const position = getObligationPosition(db, params.obligationId);
  if (position.obligation.status === 'discharged') {
    throw new HttpError(409, 'This obligation is already discharged; re-instatement is an owner act.');
  }
  if (position.obligation.status !== 'open') {
    throw new HttpError(409, 'Only an open obligation can be discharged.');
  }
  if (position.outstanding <= 0) {
    throw new HttpError(409, 'This obligation has no remaining outstanding tuition to discharge.');
  }

  const amount = position.outstanding;
  const allocationId = id('alloc');
  const writeOffId = id('two');
  const writtenOffInvoices: string[] = [];
  const run = db.transaction(() => {
    // The memo settlement: every balance derivation reads allocations, so the
    // discharged remainder stops counting everywhere through ONE authority.
    db.prepare(
      `INSERT INTO obligation_allocations
         (id, obligation_id, amount, source_kind, status, operator_name, date)
       VALUES (?, ?, ?, 'write_off', 'active', ?, ?)`,
    ).run(allocationId, params.obligationId, amount, params.declaredBy, today());

    db.prepare(
      `INSERT INTO tuition_write_offs (id, obligation_id, allocation_id, amount, reason, declared_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(writeOffId, params.obligationId, allocationId, amount, reason, params.declaredBy);

    // The demand documents for this debt stop demanding: open tuition invoices
    // of this obligation are marked written_off (they can no longer take a
    // payment — the pay path only accepts issued/partial/overdue).
    const invoices = db.prepare(
      `SELECT id FROM invoices WHERE obligation_id = ? AND purpose = 'tuition' AND status IN ('issued','partial','overdue')`,
    ).all(params.obligationId) as Array<{ id: string }>;
    for (const inv of invoices) {
      db.prepare(`UPDATE invoices SET status = 'written_off' WHERE id = ? AND status IN ('issued','partial','overdue')`).run(inv.id);
      writtenOffInvoices.push(inv.id);
    }

    // The guarded, final status flip. The discharge trigger demands the
    // write-off event exists; a concurrent second discharge dies here.
    const flipped = db.prepare(
      `UPDATE student_obligations SET status = 'discharged' WHERE id = ? AND status = 'open'`,
    ).run(params.obligationId);
    if (flipped.changes !== 1) throw new HttpError(409, 'This obligation is no longer open.');
  });
  run();
  return { writeOffId, allocationId, amount, writtenOffInvoices };
}

/** Register of memo discharges (newest first). */
export function listTuitionWriteOffs(db: BetterSqlite3.Database, branchId: string | null) {
  const scope = branchId ? 'WHERE o.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  return (db.prepare(
    `SELECT w.id, w.obligation_id, w.amount, w.reason, w.declared_by, w.created_at,
            o.student_id, o.branch_id, o.semester_id, s.full_name AS student_name,
            sem.semester_name
       FROM tuition_write_offs w
       JOIN student_obligations o ON o.id = w.obligation_id
       JOIN students s ON s.id = o.student_id
       JOIN student_semesters sem ON sem.id = o.semester_id
       ${scope}
      ORDER BY datetime(w.created_at) DESC, w.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, obligationId: r.obligation_id, amount: r.amount, reason: r.reason,
    declaredBy: r.declared_by, createdAt: r.created_at, studentId: r.student_id,
    studentName: r.student_name, branchId: r.branch_id, semesterName: r.semester_name,
  }));
}

// ── Employee-advance write-off (classification truth) ───────────────────────

/** Declares a salary-advance fact uncollectible: it becomes a staff cost. */
export function writeOffEmployeeAdvance(
  db: BetterSqlite3.Database,
  params: { transactionId: string; reason: string; declaredBy: string },
): { writeOffId: string } {
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A write-off reason of at least 8 characters is required.');

  const ft = db.prepare(
    `SELECT id, branch_id, amount FROM financial_transactions WHERE id = ? AND type = 'expense' AND category = 'salary_advance'`,
  ).get(params.transactionId) as { id: string; branch_id: string; amount: number } | undefined;
  if (!ft) throw new HttpError(404, 'Salary-advance expense fact not found.');
  const existing = db.prepare(`SELECT 1 FROM advance_write_offs WHERE transaction_id = ?`).get(params.transactionId);
  if (existing) throw new HttpError(409, 'This advance is already written off.');

  const writeOffId = id('awo');
  db.prepare(
    `INSERT INTO advance_write_offs (id, transaction_id, branch_id, employee_id, amount, reason, declared_by)
     SELECT ?, ?, ft.branch_id, ft.reference_id, ft.amount, ?, ?
       FROM financial_transactions ft WHERE ft.id = ?`,
  ).run(writeOffId, params.transactionId, reason, params.declaredBy, params.transactionId);
  return { writeOffId };
}

/** Register of advance write-offs (newest first). */
export function listAdvanceWriteOffs(db: BetterSqlite3.Database, branchId: string | null) {
  const scope = branchId ? 'WHERE w.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  return (db.prepare(
    `SELECT w.id, w.transaction_id, w.branch_id, w.employee_id, w.amount, w.reason, w.declared_by, w.created_at,
            ft.date AS advanced_on, ft.description
       FROM advance_write_offs w
       JOIN financial_transactions ft ON ft.id = w.transaction_id
       ${scope}
      ORDER BY datetime(w.created_at) DESC, w.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, transactionId: r.transaction_id, branchId: r.branch_id, employeeId: r.employee_id,
    amount: r.amount, reason: r.reason, declaredBy: r.declared_by, createdAt: r.created_at,
    advancedOn: r.advanced_on, description: r.description,
  }));
}

// ── Payroll withholding (liability until remittance) ────────────────────────

export interface WithholdingDeclarationInput {
  transactionId: string;
  amount: number;
  note?: string | null;
  declaredBy: string;
}

/** Declares what was withheld at source from one posted GROSS wage fact. */
export function declarePayrollWithholding(
  db: BetterSqlite3.Database,
  params: WithholdingDeclarationInput,
): { withholdingId: string } {
  let amount: number;
  try { amount = assertMoney(params.amount, 'withheld amount', {}); } catch {
    throw new HttpError(400, 'The withheld amount must be a whole-AFN positive value.');
  }
  if (amount <= 0) throw new HttpError(400, 'The withheld amount must be greater than zero.');

  const fact = db.prepare(
    `SELECT ft.id, ft.branch_id, ft.amount, ft.reference_id AS employee_id, ft.date,
           CASE WHEN EXISTS (SELECT 1 FROM teacher_salary_ledger l WHERE l.transaction_id = ft.id AND l.status = 'posted')
                THEN 'teacher' ELSE 'employee' END AS employee_kind,
           COALESCE((SELECT l.period_key FROM teacher_salary_ledger l WHERE l.transaction_id = ft.id AND l.status = 'posted' LIMIT 1),
                    (SELECT l.period_key FROM employee_salary_ledger l WHERE l.transaction_id = ft.id AND l.status = 'posted' LIMIT 1)) AS period_key,
           (SELECT e.full_name FROM employees e WHERE e.id = ft.reference_id) AS employee_name,
           (SELECT t.full_name FROM teachers t WHERE t.id = ft.reference_id) AS teacher_name
      FROM financial_transactions ft
     WHERE ft.id = ? AND ft.type = 'expense' AND ft.category = 'salary'`,
  ).get(params.transactionId) as
    | { id: string; branch_id: string; amount: number; employee_id: string; date: string
        ; employee_kind: 'teacher' | 'employee'; period_key: string | null
        ; employee_name: string | null; teacher_name: string | null }
    | undefined;
  if (!fact) throw new HttpError(404, 'Gross salary expense fact not found (withholding applies to wage payments, not advances).');
  if (!fact.period_key) throw new HttpError(409, 'No posted salary ledger fact backs that transaction.');
  if (amount > fact.amount) {
    throw new HttpError(400, `The withheld amount cannot exceed the gross wage of ${fact.amount} AFN.`);
  }
  const existing = db.prepare(`SELECT 1 FROM payroll_withholdings WHERE transaction_id = ?`).get(params.transactionId);
  if (existing) throw new HttpError(409, 'A withholding declaration already exists for that wage payment.');

  const withholdingId = id('wh');
  db.prepare(
    `INSERT INTO payroll_withholdings
       (id, branch_id, employee_kind, employee_id, employee_name, period_key, transaction_id, amount, note, declared_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(withholdingId, fact.branch_id, fact.employee_kind, fact.employee_id,
        fact.employee_kind === 'teacher' ? (fact.teacher_name ?? fact.employee_id) : (fact.employee_name ?? fact.employee_id),
        fact.period_key, params.transactionId, amount, params.note ?? null, params.declaredBy);
  return { withholdingId };
}

/** Hands the withheld cash to the authority — the liability leaves the drawer. */
export function remitPayrollWithholding(
  db: BetterSqlite3.Database,
  params: { withholdingId: string; remittedBy: string },
): { transactionId: string } {
  const run = db.transaction(() => {
    const row = db.prepare(
      `SELECT id, branch_id, amount, status FROM payroll_withholdings WHERE id = ?`,
    ).get(params.withholdingId) as { id: string; branch_id: string; amount: number; status: string } | undefined;
    if (!row) throw new HttpError(404, 'Withholding declaration not found.');
    if (row.status !== 'open') throw new HttpError(409, 'This withholding is already remitted.');

    // Cash leaves the branch drawer — P&L-neutral: the wage was expensed at
    // gross; this is the withheld part of it changing hands, nothing more.
    const debited = decrementMainBalanceIfSufficient('branch', row.branch_id, row.amount);
    if (!debited) throw new HttpError(409, 'Branch main cash is insufficient to remit this withholding.');
    const transactionId = id('tx');
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
       VALUES (?, 'withholding_remittance', 'withholding', ?, ?, ?, ?, ?, ?)`,
    ).run(transactionId, -row.amount, today(),
          `Withholding remitted for declaration ${row.id} (${row.amount} AFN)`,
          row.id, params.remittedBy, row.branch_id);

    const flipped = db.prepare(
      `UPDATE payroll_withholdings
          SET status = 'remitted', remitted_transaction_id = ?, remitted_at = datetime('now'), remitted_by = ?
        WHERE id = ? AND status = 'open'`,
    ).run(transactionId, params.remittedBy, params.withholdingId);
    if (flipped.changes !== 1) throw new HttpError(409, 'This withholding is no longer open.');
    return { transactionId };
  });
  return run();
}

/** Withholding register with open/remitted totals (the liability position). */
export function getWithholdingRegister(db: BetterSqlite3.Database, branchId: string | null) {
  const scope = branchId ? 'WHERE w.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  const rows = db.prepare(
    `SELECT w.id, w.branch_id, w.employee_kind, w.employee_id, w.employee_name, w.period_key,
            w.transaction_id, w.amount, w.status, w.note, w.declared_by, w.created_at,
            w.remitted_transaction_id, w.remitted_at, w.remitted_by,
            (SELECT ft.amount FROM financial_transactions ft WHERE ft.id = w.transaction_id) AS gross,
            (SELECT ft.date FROM financial_transactions ft WHERE ft.id = w.transaction_id) AS paid_on
       FROM payroll_withholdings w
       ${scope}
      ORDER BY datetime(w.created_at) DESC, w.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
  const open = rows.filter((r) => r.status === 'open');
  return {
    totals: {
      openLiability: open.reduce((s, r) => s + Number(r.amount), 0),
      remitted: rows.filter((r) => r.status === 'remitted').reduce((s, r) => s + Number(r.amount), 0),
      counts: { declarations: rows.length, open: open.length },
    },
    declarations: rows.map((r) => ({
      id: r.id, branchId: r.branch_id, employeeKind: r.employee_kind, employeeId: r.employee_id,
      employeeName: r.employee_name, periodKey: r.period_key, transactionId: r.transaction_id,
      gross: r.gross, withheld: r.amount, netPaid: Number(r.gross ?? 0) - Number(r.amount),
      status: r.status, note: r.note, declaredBy: r.declared_by, declaredAt: r.created_at,
      paidOn: r.paid_on, remittedTransactionId: r.remitted_transaction_id,
      remittedAt: r.remitted_at, remittedBy: r.remitted_by,
    })),
  };
}
