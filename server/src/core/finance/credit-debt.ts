/**
 * Credit/debt subsystem — WAVE 20 (W16 owner-directed standard semantics).
 * ============================================================================
 * PAYABLES · A credit purchase creates a LIABILITY at receipt — never income,
 * never an expense until settled in cash (the system's cash-basis P&L is
 * preserved: the expense exists when the settlement pays, through the normal
 * budget authority, and links back to the payable). A supplier return reverses
 * the payable while it is open (no cash), or raises a refund receivable when
 * the invoice was already settled; the refund lands later as P&L-neutral
 * 'supplier_refund' cash-in — never income.
 *
 * LOANS · Principal-only liabilities. Proceeds credit the ORGANIZATION
 * treasury through the P&L-neutral 'loan_proceeds' type (never income, never
 * capital — D-11's taxonomy untouched); principal repayment debits it through
 * 'loan_repayment'. Interest has NO surface: a rate is owner policy (D-182).
 * Lender identity is a recorded fact, not a policy choice.
 *
 * What is deliberately ABSENT (owner policy, D-182/D-190): payment terms and
 * due dates (aging-by-terms), interest recognition, write-off authority (P16),
 * and any approval threshold — every writer sits behind the existing
 * Expense.Approve control permission, the established W16 convention.
 */
import type Database from 'better-sqlite3';
import { id, today } from '../../utils/ids.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { incrementMainBalance, decrementMainBalanceIfSufficient } from '../../utils/financeAccounts.js';
import { assertMoney } from '../../utils/money.js';

type Db = Database.Database;

// ── Payables ────────────────────────────────────────────────────────────────

export interface PayablePosition {
  invoiceId: string;
  amount: number;
  settled: number;
  /** Returns that reduced the debt while it was open (no cash moved). */
  payableReduced: number;
  /** Returns awaiting a supplier refund (cash already out). */
  refundDue: number;
  refundReceived: number;
  /** Debt still open: amount − settled − payableReduced. */
  outstanding: number;
}

export function getPayablePosition(database: Db, invoiceId: string): PayablePosition {
  const invoice = database.prepare('SELECT id, amount, status FROM supplier_invoices WHERE id = ?').get(invoiceId) as
    | { id: string; amount: number; status: string }
    | undefined;
  if (!invoice) throw new HttpError(404, 'Supplier invoice not found.');
  const settled = Number((database.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_invoice_payments WHERE supplier_invoice_id = ?',
  ).get(invoiceId) as { t: number }).t) || 0;
  const payableReduced = Number((database.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_returns WHERE supplier_invoice_id = ? AND kind = 'payable_reduction'`,
  ).get(invoiceId) as { t: number }).t) || 0;
  const refundDue = Number((database.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_returns WHERE supplier_invoice_id = ? AND kind = 'refund_due' AND status = 'effectuated'`,
  ).get(invoiceId) as { t: number }).t) || 0;
  const refundReceived = Number((database.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_returns WHERE supplier_invoice_id = ? AND kind = 'refund_due' AND status = 'refunded'`,
  ).get(invoiceId) as { t: number }).t) || 0;
  return {
    invoiceId,
    amount: Number(invoice.amount),
    settled,
    payableReduced,
    refundDue,
    refundReceived,
    outstanding: Math.max(0, Number(invoice.amount) - settled - payableReduced),
  };
}

/** Registers the settlement linkage (the expense row is written by the caller through the budget authority). */
export function recordSupplierInvoicePayment(database: Db, command: {
  invoiceId: string; amount: number; transactionId: string; paidBy: string; paidOn?: string;
}): { paymentId: string; position: PayablePosition } {
  if (!database.inTransaction) throw new Error('recordSupplierInvoicePayment() must run inside a transaction.');
  const amount = assertMoney(command.amount, 'settlement amount');
  if (amount <= 0) throw new HttpError(400, 'A settlement amount must be greater than zero.');
  const position = getPayablePosition(database, command.invoiceId);
  if (amount > position.outstanding) {
    throw new HttpError(409, `Settlement exceeds the outstanding payable (${position.outstanding} AFN remains of ${position.amount}).`);
  }
  const expenseRow = database.prepare(
    `SELECT type, amount FROM financial_transactions WHERE id = ?`,
  ).get(command.transactionId) as { type: string; amount: number } | undefined;
  if (!expenseRow || expenseRow.type !== 'expense' || Number(expenseRow.amount) !== amount) {
    throw new HttpError(409, 'A settlement must link to the expense row that paid it, for the same amount.');
  }
  const paymentId = id('sip');
  database.prepare(
    `INSERT INTO supplier_invoice_payments (id, supplier_invoice_id, amount, transaction_id, paid_on, paid_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, command.invoiceId, amount, command.transactionId, command.paidOn ?? today(), command.paidBy);
  const after = getPayablePosition(database, command.invoiceId);
  if (after.outstanding === 0) {
    database.prepare(`UPDATE supplier_invoices SET status = 'settled' WHERE id = ? AND status = 'open'`).run(command.invoiceId);
  }
  return { paymentId, position: getPayablePosition(database, command.invoiceId) };
}

/** A return against a payable: reduce the open debt, or raise a refund receivable. */
export function recordSupplierReturn(database: Db, command: {
  invoiceId: string; amount: number; reason: string; declaredBy: string; declaredOn?: string;
}): { returnId: string; kind: 'payable_reduction' | 'refund_due'; position: PayablePosition } {
  if (!database.inTransaction) throw new Error('recordSupplierReturn() must run inside a transaction.');
  const amount = assertMoney(command.amount, 'return amount');
  if (amount <= 0) throw new HttpError(400, 'A return amount must be greater than zero.');
  if (String(command.reason ?? '').trim().length < 8) throw new HttpError(400, 'A return reason of at least 8 characters is required.');
  const position = getPayablePosition(database, command.invoiceId);
  // Goods worth `amount` leave; the money truth depends on whether the invoice
  // was already paid in cash. V1 refuses MIXED returns (part debt reduction,
  // part refund) — the operator records them as two events, so one row always
  // means one economic thing:
  //   · debt still open and amount ≤ outstanding  → the debt shrinks (no cash);
  //   · fully settled and amount ≤ refundable     → a refund receivable arises.
  const refundable = Math.max(0, position.settled - position.refundDue - position.refundReceived);
  let kind: 'payable_reduction' | 'refund_due';
  if (position.outstanding > 0) {
    if (amount > position.outstanding) {
      throw new HttpError(409, `This return exceeds the outstanding payable (${position.outstanding} AFN). Record a payable reduction for the open debt and — only after settlement — a refund return for the rest.`);
    }
    kind = 'payable_reduction';
  } else {
    if (amount > refundable) {
      throw new HttpError(409, `The refund cannot exceed what was settled in cash and not yet refunded (${refundable} AFN).`);
    }
    kind = 'refund_due';
  }
  const returnId = id('sret');
  database.prepare(
    `INSERT INTO supplier_returns (id, supplier_invoice_id, amount, reason, kind, declared_on, declared_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(returnId, command.invoiceId, amount, command.reason.trim(), kind, command.declaredOn ?? today(), command.declaredBy);
  return { returnId, kind, position: getPayablePosition(database, command.invoiceId) };
}

/** The supplier's refund lands: P&L-neutral cash-in, never income. */
export function receiveSupplierRefund(database: Db, command: {
  returnId: string; receivedBy: string; receivedOn?: string;
}): { transactionId: string } {
  if (!database.inTransaction) throw new Error('receiveSupplierRefund() must run inside a transaction.');
  const ret = database.prepare(
    `SELECT r.id, r.amount, r.status, r.kind, i.branch_id
       FROM supplier_returns r JOIN supplier_invoices i ON i.id = r.supplier_invoice_id
      WHERE r.id = ?`,
  ).get(command.returnId) as { id: string; amount: number; status: string; kind: string; branch_id: string } | undefined;
  if (!ret) throw new HttpError(404, 'Supplier return not found.');
  if (ret.kind !== 'refund_due') throw new HttpError(409, 'Only a refund-due return can receive a refund.');
  if (ret.status === 'refunded') throw new HttpError(409, 'This refund has already been received.');

  incrementMainBalance('branch', ret.branch_id, Number(ret.amount));
  const transactionId = id('tx');
  database.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
     VALUES (?, 'supplier_refund', 'supplier_refund', ?, ?, ?, ?, ?, ?)`,
  ).run(transactionId, Number(ret.amount), command.receivedOn ?? today(),
    `Supplier refund received (return ${ret.id})`, ret.id, command.receivedBy, ret.branch_id);
  const updated = database.prepare(
    `UPDATE supplier_returns SET status = 'refunded', refund_transaction_id = ? WHERE id = ? AND status = 'effectuated'`,
  ).run(transactionId, command.returnId);
  if (updated.changes !== 1) throw new HttpError(409, 'This refund has already been received.');
  return { transactionId };
}

// ── Loans (principal-only) ──────────────────────────────────────────────────

export interface LoanPosition {
  loanId: string;
  lenderName: string;
  principal: number;
  repaid: number;
  outstanding: number;
  status: 'open' | 'repaid';
}

export function getLoanPosition(database: Db, loanId: string): LoanPosition {
  const loan = database.prepare('SELECT id, lender_name, principal, status FROM loans WHERE id = ?').get(loanId) as
    | { id: string; lender_name: string; principal: number; status: 'open' | 'repaid' }
    | undefined;
  if (!loan) throw new HttpError(404, 'Loan not found.');
  const repaid = Number((database.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM loan_repayments WHERE loan_id = ?',
  ).get(loanId) as { t: number }).t) || 0;
  return {
    loanId: loan.id,
    lenderName: loan.lender_name,
    principal: Number(loan.principal),
    repaid,
    outstanding: Math.max(0, Number(loan.principal) - repaid),
    status: loan.status,
  };
}

/** Loan proceeds: cash into the organization treasury, P&L-neutral — never income, never capital. */
export function recordLoan(database: Db, command: {
  lenderName: string; principal: number; purpose?: string | null; receivedOn?: string; operatorBranchId: string; operatorName: string;
}): { loanId: string; transactionId: string } {
  if (!database.inTransaction) throw new Error('recordLoan() must run inside a transaction.');
  const principal = assertMoney(command.principal, 'loan principal');
  if (principal <= 0) throw new HttpError(400, 'A loan principal must be greater than zero.');
  const lender = String(command.lenderName ?? '').trim();
  if (lender.length < 3) throw new HttpError(400, 'A lender name of at least 3 characters is required.');

  incrementMainBalance('organization', 'global', principal);
  const transactionId = id('tx');
  database.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
     VALUES (?, 'loan_proceeds', 'loan_principal', ?, ?, ?, ?, ?)`,
  ).run(transactionId, principal, command.receivedOn ?? today(),
    `Loan proceeds received from ${lender}`, command.operatorName, command.operatorBranchId);

  const loanId = id('loan');
  database.prepare(
    `INSERT INTO loans (id, lender_name, principal, purpose, received_on, proceeds_transaction_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(loanId, lender, principal, command.purpose?.trim() || null, command.receivedOn ?? today(), transactionId, command.operatorName);
  return { loanId, transactionId };
}

/** Principal repayment: cash out of the treasury, P&L-neutral; never interest (a rate is owner policy). */
export function recordLoanRepayment(database: Db, command: {
  loanId: string; amount: number; paidBy: string; paidOn?: string;
}): { repaymentId: string; transactionId: string; position: LoanPosition } {
  if (!database.inTransaction) throw new Error('recordLoanRepayment() must run inside a transaction.');
  const amount = assertMoney(command.amount, 'repayment amount');
  if (amount <= 0) throw new HttpError(400, 'A repayment amount must be greater than zero.');
  const position = getLoanPosition(database, command.loanId);
  if (position.status === 'repaid' || position.outstanding === 0) {
    throw new HttpError(409, 'This loan is already fully repaid.');
  }
  if (amount > position.outstanding) {
    throw new HttpError(409, `Repayment exceeds the outstanding principal (${position.outstanding} AFN remains of ${position.principal}).`);
  }
  const loan = database.prepare('SELECT lender_name FROM loans WHERE id = ?').get(command.loanId) as { lender_name: string };
  const debited = decrementMainBalanceIfSufficient('organization', 'global', amount);
  if (!debited) throw new HttpError(409, `Insufficient organization treasury balance to repay ${amount} AFN.`);

  const proceeds = database.prepare('SELECT branch_id FROM financial_transactions WHERE id = (SELECT proceeds_transaction_id FROM loans WHERE id = ?)').get(command.loanId) as { branch_id: string };
  const transactionId = id('tx');
  database.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
     VALUES (?, 'loan_repayment', 'loan_principal', ?, ?, ?, ?, ?, ?)`,
  ).run(transactionId, -amount, command.paidOn ?? today(),
    `Loan principal repaid to ${loan.lender_name}`, command.loanId, command.paidBy, proceeds.branch_id);

  const repaymentId = id('lrep');
  database.prepare(
    `INSERT INTO loan_repayments (id, loan_id, amount, transaction_id, paid_on, paid_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(repaymentId, command.loanId, amount, transactionId, command.paidOn ?? today(), command.paidBy);
  const after = getLoanPosition(database, command.loanId);
  if (after.outstanding === 0) {
    database.prepare(`UPDATE loans SET status = 'repaid', repaid_on = ? WHERE id = ? AND status = 'open'`)
      .run(command.paidOn ?? today(), command.loanId);
  }
  return { repaymentId, transactionId, position: getLoanPosition(database, command.loanId) };
}
