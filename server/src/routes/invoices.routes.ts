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
import { assertMoney } from '../utils/money.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate, authorize('owner', 'finance', 'manager', 'registrar'));

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
const stmtGetPaymentByIdempotency = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?');
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
  if (!user?.branchId || !user?.fullName || !user?.role) {
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
  authorize('manager', 'owner'),
  ah(async (req, res) => {
    const body = req.body as Record<string, number | undefined>;
    const map: Record<string, string> = {
      invoiceDueDays: 'invoice_due_days',
      expenseAutoApproveThreshold: 'expense_auto_approve_threshold',
      dailySavingPercent: 'daily_saving_percent',
    };
    for (const [jsKey, dbKey] of Object.entries(map)) {
      if (body[jsKey] != null && Number(body[jsKey]) >= 0) {
        setSetting(dbKey, String(Number(body[jsKey])));
      }
    }
    writeAudit(req, 'Updated finance configuration settings');
    res.json({ ok: true });
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
      const rawQuantity = Number(it.quantity ?? 1);
      const quantity = Number.isInteger(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
      const unitPrice = assertMoney(it.unitPrice, 'unitPrice');
      if (!it.description?.trim()) {
        throw new HttpError(400, 'Each item needs a description and a non-negative unit price.');
      }
      return { description: it.description.trim(), quantity, unitPrice, amount: assertMoney(quantity * unitPrice, 'invoice line amount') };
    });

    const totalAmount = assertMoney(normalized.reduce((sum, it) => sum + it.amount, 0), 'invoice total');
    const requestedDiscount = assertMoney(discountAmount, 'discount amount');
    const discount = Math.min(requestedDiscount, totalAmount);
    const netAmount = assertMoney(totalAmount - discount, 'invoice net amount');

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
  authorize('finance', 'manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const row = stmtGetPlainInvoiceById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Invoice not found.');
    requireInvoiceBranch(req, row);
    if (!['issued', 'partial', 'overdue'].includes(row.status)) {
      throw new HttpError(400, 'Only issued, partial, or overdue invoices can accept payment.');
    }

    const { amount, paymentMethod, notes } = req.body as { amount?: number; paymentMethod?: string; notes?: string };
    const idempotencyKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    if (idempotencyKey) {
      const existing = stmtGetPaymentByIdempotency.get(idempotencyKey) as any;
      if (existing) {
        const existingInvoice = stmtGetInvoiceById.get(row.id) as any;
        return res.status(200).json({ invoice: mapInvoice(existingInvoice, loadItems(row.id)), paymentId: existing.id, receiptNumber: existing.receipt_number, idempotentReplay: true });
      }
    }
    const VALID_METHODS = ['cash', 'card', 'bank_transfer'] as const;
    const resolvedMethod = VALID_METHODS.includes(paymentMethod as any) ? paymentMethod : 'cash';
    const payAmount = Number(amount);
    if (!(payAmount > 0)) throw new HttpError(400, 'Payment amount must be positive.');

    const payId = id('pay');
    const rc = nextReceiptNumber();
    const date = today();
    const student = stmtGetStudentById.get(row.student_id) as any;

    const tx = db.transaction(() => {
      const paidSoFar = Number((stmtGetInvoicePaymentsSum.get(row.id) as { s: number }).s || 0);
      const remaining = Number(row.net_amount) - paidSoFar;
      if (remaining <= 0) throw new HttpError(409, 'Invoice is already fully paid.');
      if (payAmount > remaining + 0.001) {
        throw new HttpError(400, `Amount exceeds remaining balance (${remaining} AFN).`);
      }

      stmtInsertPayment.run(
        payId, row.student_id, row.id, payAmount, date, resolvedMethod,
        notes || `Payment for invoice ${row.invoice_number || row.id}`, rc, row.branch_id, idempotencyKey || null
      );

      recordIncome({
        category: 'fee', amount: payAmount, date,
        description: `Invoice ${row.invoice_number || row.id} payment — ${student?.full_name || row.student_id}`,
        referenceId: row.id, paymentId: payId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: row.branch_id,
      });

      const newPaid = paidSoFar + payAmount;
      const newStatus = newPaid >= row.net_amount - 0.001 ? 'paid' : 'partial';
      stmtUpdateInvoiceStatus.run(newStatus, row.id);
    });
    tx();

    writeAudit(req, `Payment ${payAmount} AFN on invoice ${row.invoice_number || row.id}`);
    addNotification('Invoice payment recorded', `${payAmount} AFN received for invoice ${row.invoice_number || row.id}.`, 'success', row.branch_id);

    const updated = stmtGetInvoiceById.get(row.id) as any;
    res.status(201).json({ invoice: mapInvoice(updated, loadItems(row.id)), paymentId: payId, receiptNumber: rc });
  })
);

// ---------- Cancel ----------
invoicesRouter.post(
  '/:id/cancel',
  authorize('finance', 'manager'),
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