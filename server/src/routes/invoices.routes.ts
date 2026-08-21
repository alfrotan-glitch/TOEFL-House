/**
 * TOEFL House ERP — Invoices API
 * All amounts and balances come from the database / system_settings.
 * No fabricated demo balances in application code.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { getNumberSetting, setSetting } from '../utils/settings.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { recordIncome } from '../utils/income.js';
import { nextReceiptNumber } from '../utils/receipt.js';
import { nextInvoiceNumber } from '../utils/invoice.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { assertMoney, assertComputedMoney } from '../utils/money.js';
import { FINANCE_SETTING_LIST } from '../core/configuration/finance-settings.js';
import { resolveIdempotency, isUniqueViolation } from '../utils/idempotency.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate, authorize('owner', 'finance_manager', 'general_manager', 'receptionist'));

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllInvoices = db.prepare(
  `SELECT i.*, s.full_name as student_name, s.student_code as student_code FROM invoices i LEFT JOIN students s ON s.id = i.student_id ORDER BY i.issue_date DESC, i.rowid DESC LIMIT 500`
);
const stmtGetInvoicesByBranch = db.prepare(
  `SELECT i.*, s.full_name as student_name, s.student_code as student_code FROM invoices i LEFT JOIN students s ON s.id = i.student_id WHERE i.branch_id = ? ORDER BY i.issue_date DESC, i.rowid DESC LIMIT 500`
);
const stmtGetInvoiceById = db.prepare(
  `SELECT i.*, s.full_name as student_name, s.student_code as student_code FROM invoices i LEFT JOIN students s ON s.id = i.student_id WHERE i.id = ?`
);
const stmtGetPlainInvoiceById = db.prepare('SELECT * FROM invoices WHERE id = ?');
const stmtInsertInvoice = db.prepare(
  `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, student_name, student_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtInsertInvoiceItem = db.prepare(
  `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtUpdateInvoiceIssue = db.prepare(
  `UPDATE invoices SET status = 'issued', invoice_number = ?, issue_date = ?, due_date = ?, issued_by = ? WHERE id = ?`
);
const stmtGetInvoicePaymentsSum = db.prepare(
  `SELECT COALESCE(SUM(amount), 0) as s FROM payments WHERE invoice_id = ? AND status = 'completed'`
);
const stmtInsertPayment = db.prepare(
  `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'fee', ?, ?, ?, ?)`
);
const stmtUpdateInvoiceStatus = db.prepare('UPDATE invoices SET status = ? WHERE id = ?');
const stmtCancelInvoice = db.prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`);
const stmtGetItemsByInvoice = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY rowid');
const stmtGetStudentById = db.prepare('SELECT * FROM students WHERE id = ?');

/** Safely extract user context required for mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.branchId || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for invoice operation.');
  }
  return user;
}


function mapInvoice(row: any, items: any[] = []) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name || undefined,
    studentCode: row.student_code || undefined,
    totalAmount: row.total_amount,
    discountAmount: row.discount_amount,
    netAmount: row.net_amount,
    status: (['issued','partial'].includes(row.status) && row.due_date && row.due_date < today()) ? 'overdue' : row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    branchId: row.branch_id,
    notes: row.notes || undefined,
    invoiceNumber: row.invoice_number || undefined,
    issuedBy: row.issued_by || undefined,
    createdAt: row.created_at,
    items: items.map((it) => ({
      id: it.id, description: it.description, quantity: it.quantity, unitPrice: it.unit_price, amount: it.amount,
    })),
  };
}

function loadItems(invoiceId: string) {
  return stmtGetItemsByInvoice.all(invoiceId);
}

/** Ensure invoice exists and belongs to the caller's branch scope. */
function requireInvoiceBranch(req: import('express').Request, invoice: any) {
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && invoice.branch_id && invoice.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const cross = !!invoice.branch_id && canAccessBranchResource(req, invoice.branch_id);
    if (!cross) throw new HttpError(403, 'Invoice belongs to another branch.');
  }
}

// ---------- List (with auto-overdue detection) ----------
invoicesRouter.get(
  '/',
  ah(async (req, res) => {
    const { status, studentId } = req.query as Record<string, string>;
    const { branchId, isAll } = resolveBranchScope(req);
    const todayStr = today();

    let rows = (isAll ? stmtGetAllInvoices.all() : stmtGetInvoicesByBranch.all(branchId)) as any[];

    if (status) rows = rows.filter(r => r.status === status);
    if (studentId) rows = rows.filter(r => r.student_id === studentId);

    res.json(rows.map((r) => mapInvoice(r, loadItems(r.id))));
  })
);

// ---------- Config: due days ----------
invoicesRouter.get(
  '/config/settings',
  ah(async (req, res) => {
    res.json({
      invoiceDueDays: getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays),
      expenseAutoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
      dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
      ...(req.user?.branchId ? (() => { const a = getFinanceAccount('branch', req.user.branchId); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })() : (() => { const a = getFinanceAccount('organization', 'global'); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })()),
    });
  })
);

invoicesRouter.put(
  '/config/settings',
  authorize('general_manager', 'owner'),
  ah(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    // One validation authority for all three keys
    // (`core/configuration/finance-settings`). Two rules had drifted here: the
    // savings rate was accepted with no upper bound, and a value that failed
    // the check was silently skipped while the response still said `ok`.
    const applied: Record<string, number> = {};
    for (const setting of FINANCE_SETTING_LIST) {
      const provided = body[setting.field];
      if (provided == null) continue;
      const parsed = setting.parse(provided);
      setSetting(setting.key, String(parsed));
      applied[setting.field] = parsed;
    }
    writeAudit(req, `Updated finance configuration settings: ${JSON.stringify(applied)}`);
    res.json({ ok: true, applied });
  })
);

// ---------- Detail ----------
invoicesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const row = stmtGetInvoiceById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Invoice not found.');
    requireInvoiceBranch(req, row);
    res.json(mapInvoice(row, loadItems(row.id)));
  })
);

// ---------- Create (draft or issued) ----------
invoicesRouter.post(
  '/',
  requirePermission('Invoice.Create'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { studentId, items, discountAmount = 0, notes, issue = false } = req.body as {
      studentId?: string;
      items?: { description: string; quantity?: number; unitPrice: number }[];
      discountAmount?: number;
      notes?: string;
      issue?: boolean;
    };

    if (!studentId) throw new HttpError(400, 'studentId is required.');
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'At least one invoice line item is required.');
    }

    const student = stmtGetStudentById.get(studentId) as any;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (!canAccessBranchResource(req, student.branch_id)) throw new HttpError(403, 'Student belongs to another branch.');
    if (student.status === 'suspended') throw new HttpError(409, 'Suspended students cannot receive new invoices.');

    const normalized = items.map((it) => {
      // An invalid quantity is REJECTED, not silently coerced to 1. The
      // fallback meant `quantity: -3` produced a real invoice line of
      // quantity 1 — a charge the operator never entered, on a financial
      // document, reported as success. Same silent-substitution class as the
      // capped payment and the capped discount.
      const rawQuantity = it.quantity === undefined || it.quantity === null ? 1 : Number(it.quantity);
      if (!Number.isInteger(rawQuantity) || rawQuantity <= 0) {
        throw new HttpError(400, 'Each item needs a whole quantity greater than zero.');
      }
      const quantity = rawQuantity;
      const unitPrice = assertMoney(it.unitPrice, 'unitPrice');
      if (!it.description?.trim()) {
        throw new HttpError(400, 'Each item needs a description and a non-negative unit price.');
      }
      return { description: it.description.trim(), quantity, unitPrice, amount: assertComputedMoney(quantity * unitPrice, 'invoice line amount') };
    });

    const totalAmount = assertMoney(normalized.reduce((sum, it) => sum + it.amount, 0), 'invoice total');
    // assertMoney refuses a fractional discount outright, so a figure the
    // operator never entered can never be substituted here.
    const requestedDiscount = assertMoney(discountAmount, 'discount amount');
    // A discount larger than the invoice is REJECTED, not capped. Capping
    // turned a mistyped 99999 on a 5,000 invoice into a silent 100% discount
    // (net 0) and reported success — wiping a real tuition obligation with no
    // trace that anything unusual happened. Same defect class as the tuition
    // overpayment: never quietly substitute a number the operator did not enter.
    if (requestedDiscount > totalAmount) {
      throw new HttpError(400, `Discount cannot exceed the invoice total of ${totalAmount} AFN.`);
    }
    const discount = requestedDiscount;
    const netAmount = assertComputedMoney(totalAmount - discount, 'invoice net amount');

    const dueDays = getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays);
    const issueDate = today();
    const due = new Date(issueDate);
    due.setDate(due.getDate() + dueDays);
    const dueDate = due.toISOString().slice(0, 10);

    const invoiceId = id('inv');
    const branchId = student.branch_id;
    const status = issue ? 'issued' : 'draft';
    const invoiceNumber = issue ? nextInvoiceNumber(branchId) : null;
    const issuedBy = issue ? user.fullName : null;

    const tx = db.transaction(() => {
      stmtInsertInvoice.run(
        invoiceId, studentId, totalAmount, discount, netAmount, status, issueDate, dueDate,
        branchId, notes || null, invoiceNumber, issuedBy, student.full_name, student.student_code
      );
      for (const it of normalized) {
        stmtInsertInvoiceItem.run(id('invit'), invoiceId, it.description, it.quantity, it.unitPrice, it.amount);
      }
    });
    tx();

    writeAudit(req, `${status === 'issued' ? 'Issued' : 'Created draft'} invoice ${invoiceNumber || invoiceId} for student ${student.full_name} net ${netAmount} AFN`);
    if (issue) {
      addNotification('Invoice issued', `Invoice ${invoiceNumber} for ${student.full_name}: ${netAmount} AFN due ${dueDate}.`, 'info', branchId);
    }

    const row = stmtGetInvoiceById.get(invoiceId) as any;
    res.status(201).json(mapInvoice(row, loadItems(invoiceId)));
  })
);

// ---------- Issue draft ----------
invoicesRouter.post(
  '/:id/issue',
  requirePermission('Invoice.Edit'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const row = stmtGetPlainInvoiceById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Invoice not found.');
    requireInvoiceBranch(req, row);
    if (row.status !== 'draft') throw new HttpError(400, 'Only draft invoices can be issued.');

    const invoiceNumber = nextInvoiceNumber(row.branch_id);
    const dueDays = getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays);
    const issueDate = today();
    const due = new Date(issueDate);
    due.setDate(due.getDate() + dueDays);
    const dueDate = due.toISOString().slice(0, 10);

    stmtUpdateInvoiceIssue.run(invoiceNumber, issueDate, dueDate, user.fullName, row.id);

    writeAudit(req, `Issued invoice ${invoiceNumber}`);
    addNotification('Invoice issued', `Invoice ${invoiceNumber} issued (${row.net_amount} AFN).`, 'info', row.branch_id);

    const updated = stmtGetInvoiceById.get(row.id) as any;
    res.json(mapInvoice(updated, loadItems(row.id)));
  })
);

// ---------- Record payment against invoice ----------
invoicesRouter.post(
  '/:id/pay',
  authorize('finance_manager', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const row = stmtGetPlainInvoiceById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Invoice not found.');
    requireInvoiceBranch(req, row);
    const { amount, paymentMethod, notes } = req.body as { amount?: number; paymentMethod?: string; notes?: string };
    const VALID_METHODS = ['cash', 'card', 'bank_transfer'] as const;
    // An unrecognised method is REFUSED, not replaced. Recording a cheque or a
    // mistyped `bank_transfr` as CASH states that money is in the drawer when
    // it is not, and `POST /api/students/:id/payments` — the other collection
    // path — already applies exactly this rule to the same field.
    if (paymentMethod != null && !VALID_METHODS.includes(paymentMethod as (typeof VALID_METHODS)[number])) {
      throw new HttpError(400, 'Invalid payment method.');
    }
    const resolvedMethod = paymentMethod ?? 'cash';
    // F-5: `Number()` is a coercion, not a parse, so values that are not
    // amounts became real invoice payments with real cash movement.
    // Reproduced live on a fresh database:
    //     true   -> 201, a 1 AFN payment (cash +0.95 after the savings sweep)
    //     [500]  -> 201, a 500 AFN payment
    //     '0x10' -> 201, a 16 AFN payment
    //     [[7]]  -> 201, a 7 AFN payment
    //     0.001  -> 500, leaking the two-decimal database trigger
    // `assertMoney` is the boundary this router already uses elsewhere; the
    // endpoint's own "> 0" rule then applies to the PARSED value, so 0.001
    // (which rounds to 0) is a clean 400 rather than a database error.
    // Any amount >= 0.01 behaves exactly as before.
    let payAmount: number;
    try { payAmount = assertMoney(amount, 'Payment amount'); }
    catch { throw new HttpError(400, 'Payment amount must be positive.'); }
    if (!(payAmount > 0)) throw new HttpError(400, 'Payment amount must be positive.');

    const date = today();

    // Duplicate protection, applied whether or not the CLIENT supplies a key.
    // Keyed-only, an unkeyed double-click or retry storm records one payment
    // and one income row per request. An explicit key still wins; otherwise a fingerprint
    // of the payment intent within a short window collapses retries. A genuinely
    // distinct later instalment (or one sent with its own key) still succeeds.
    const replayPayment = (existing: any) => {
      const existingInvoice = stmtGetInvoiceById.get(row.id) as any;
      return res.status(200).json({
        invoice: mapInvoice(existingInvoice, loadItems(row.id)),
        paymentId: existing.id,
        receiptNumber: existing.receipt_number,
        idempotentReplay: true,
      });
    };

    const { candidates: payIdemCandidates } = resolveIdempotency(req, {
      route: 'invoice-pay',
      invoiceId: row.id,
      studentId: row.student_id,
      amount: payAmount,
      date,
      method: resolvedMethod,
      actorUserId: user.userId ?? null,
    });
    // SCOPED TO THIS INVOICE. A client-supplied `Idempotency-Key` is caller-
    // controlled, so matching on the key alone lets a key already used by a
    // payment on another invoice answer 200 with `idempotentReplay: true` —
    // reporting a collection that never happened on this invoice, and handing
    // back another payment's receipt number.
    const findPriorPayment = () => db.prepare(
      `SELECT id, receipt_number FROM payments
        WHERE invoice_id = ? AND student_id = ?
          AND idempotency_key IN (${payIdemCandidates.map(() => '?').join(',')}) LIMIT 1`
    ).get(row.id, row.student_id, ...payIdemCandidates) as { id: string; receipt_number: string | null } | undefined;
    const priorPayment = findPriorPayment();
    if (priorPayment?.id) return replayPayment(priorPayment);
    const idempotencyKey = payIdemCandidates[0];

    // The state gate runs AFTER the replay check, deliberately. A retry of a
    // payment that has just settled the invoice finds it `paid`, and answering
    // "only issued, partial or overdue invoices can accept payment" would tell
    // the operator their collection failed when it succeeded.
    if (!['issued', 'partial', 'overdue'].includes(row.status)) {
      throw new HttpError(400, 'Only issued, partial, or overdue invoices can accept payment.');
    }

    const payId = id('pay');
    // Allocated only after the replay check so retries do not burn receipt numbers.
    const rc = nextReceiptNumber();
    const student = stmtGetStudentById.get(row.student_id) as any;

    let replayOf: { id: string; receipt_number: string | null } | undefined;
    const tx = db.transaction(() => {
      // The pre-check above can lose a race with a concurrent retry. Repeating
      // it inside the transaction makes the retry collapse into a replay
      // instead of failing the balance check the winner has just satisfied —
      // an operator whose click was retried would otherwise be told the
      // payment was rejected while it had in fact been taken.
      replayOf = findPriorPayment();
      if (replayOf) return;

      const paidSoFar = Number((stmtGetInvoicePaymentsSum.get(row.id) as { s: number }).s || 0);
      const remaining = Number(row.net_amount) - paidSoFar;
      if (remaining <= 0) throw new HttpError(409, 'Invoice is already fully paid.');
      // Whole AFN (D-12/D-22/D-104): exact comparison, no tolerance to hide a
      // one-afghani overpayment behind.
      if (payAmount > remaining) {
        throw new HttpError(400, `Amount exceeds remaining balance (${remaining} AFN).`);
      }

      stmtInsertPayment.run(
        payId, row.student_id, row.id, payAmount, date, resolvedMethod,
        notes || `Payment for invoice ${row.invoice_number || row.id}`, rc, row.branch_id, idempotencyKey || null
      );

      recordIncome({
        category: 'fee', amount: payAmount, date,
        description: `Invoice ${row.invoice_number || row.id} payment — ${student?.full_name || row.student_id}`,
        referenceId: row.id, paymentId: payId, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: row.branch_id,
      });

      const newPaid = paidSoFar + payAmount;
      const newStatus = newPaid >= Number(row.net_amount) ? 'paid' : 'partial';
      stmtUpdateInvoiceStatus.run(newStatus, row.id);
    });
    try {
      tx();
      if (replayOf) return replayPayment(replayOf);
    } catch (err) {
      // Two concurrent requests raced past the pre-check; the unique index on
      // payments.idempotency_key is the authoritative guard. Serve the winner —
      // but only when the winner is a payment on THIS invoice. The index is
      // global, so a key already spent on another invoice lands here too, and
      // replaying it would confirm a collection that never happened here.
      if (isUniqueViolation(err)) {
        const winner = findPriorPayment();
        if (winner?.id) return replayPayment(winner);
        throw new HttpError(409, 'This idempotency key has already been used for a different payment.');
      }
      throw err;
    }

    writeAudit(req, `Payment ${payAmount} AFN on invoice ${row.invoice_number || row.id}`);
    addNotification('Invoice payment recorded', `${payAmount} AFN received for invoice ${row.invoice_number || row.id}.`, 'success', row.branch_id);

    const updated = stmtGetInvoiceById.get(row.id) as any;
    res.status(201).json({ invoice: mapInvoice(updated, loadItems(row.id)), paymentId: payId, receiptNumber: rc });
  })
);

// ---------- Cancel ----------
invoicesRouter.post(
  '/:id/cancel',
  authorize('finance_manager', 'general_manager'),
  ah(async (req, res) => {
    const row = stmtGetPlainInvoiceById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Invoice not found.');
    requireInvoiceBranch(req, row);
    if (row.status === 'paid') throw new HttpError(400, 'Paid invoices cannot be cancelled.');
    if (row.status === 'cancelled') throw new HttpError(400, 'Invoice is already cancelled.');

    const paid = (stmtGetInvoicePaymentsSum.get(row.id) as { s: number }).s;
    if (paid > 0) throw new HttpError(400, 'Cannot cancel an invoice that already has payments. Refund first.');

    stmtCancelInvoice.run(row.id);
    writeAudit(req, `Cancelled invoice ${row.invoice_number || row.id}`);
    res.json({ ok: true, status: 'cancelled' });
  })
);

export default invoicesRouter;