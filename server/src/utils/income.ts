import { assertMoney } from './money.js';
import { db } from '../db/connection.js';
import { id, today } from './ids.js';
import { getNumberSetting } from './settings.js';
import { decrementMainBalanceIfSufficient, incrementMainBalance, incrementSavingBalance } from './financeAccounts.js';

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtInsertIncomeTx = db.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, amount, date, description, reference_id, payment_id, operator_name, operator_role, branch_id)
   VALUES (?, 'income', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const stmtInsertSavingTx = db.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, amount, date, description, operator_name, operator_role, branch_id)
   VALUES (?, 'saving_transfer', 'saving', ?, ?, ?, ?, ?, ?)`
);

interface RecordIncomeParams {
  category: string;
  amount: number;
  date?: string;
  description: string;
  referenceId?: string | null;
  paymentId?: string | null;
  operatorName: string;
  /** Position held at write time (identity role code) — preserved for traceability. */
  operatorRole?: string | null;
  branchId: string;
}

/**
Records an income transaction AND immediately skims the configured saving
percentage into the saving account.

CRITICAL: This function MUST be called from within a db.transaction().
*/
export function recordIncome(params: RecordIncomeParams): { savingAmount: number } {
  // PHASE 3 SAFETY: Verify we are inside a transaction.
  if (!db.inTransaction) {
    throw new Error(
      'recordIncome() called outside a transaction. ' +
      'Wrap the caller in db.transaction() to ensure atomicity.'
    );
  }
  const normalizedAmount = assertMoney(params.amount, 'income amount', { allowNegative: true });
  if (normalizedAmount === 0) {
    throw new Error('Income amount cannot be zero.');
  }

  const date = params.date || today();

  stmtInsertIncomeTx.run(
    id('tx'),
    params.category,
    normalizedAmount,
    date,
    params.description,
    params.referenceId ?? null,
    params.paymentId ?? null,
    params.operatorName,
    params.operatorRole ?? null,
    params.branchId
  );

  if (normalizedAmount < 0) {
    if (!decrementMainBalanceIfSufficient('branch', params.branchId, Math.abs(normalizedAmount))) {
      throw new Error('Insufficient branch operating cash for this reversal/refund.');
    }
  } else {
    incrementMainBalance('branch', params.branchId, normalizedAmount);
  }
  const rawPercent = getNumberSetting('daily_saving_percent', 5);
  const percent = Math.max(0, Math.min(100, rawPercent || 0));
  // Savings are only created from positive operating income. Refunds/reversals
  // are contra-revenue and must never trigger another savings transfer.
  const savingAmount = normalizedAmount > 0 ? assertMoney((normalizedAmount * percent) / 100, 'saving amount') : 0;

  if (savingAmount > 0) {
    if (!decrementMainBalanceIfSufficient('branch', params.branchId, savingAmount)) {
      throw new Error('Insufficient branch cash for automatic savings transfer.');
    }
    incrementSavingBalance('branch', params.branchId, savingAmount);

    stmtInsertSavingTx.run(
      id('tx_saving'),
      savingAmount,
      date,
      `Automatic savings transfer (${percent}% of transaction: ${params.description})`,
      'Real-time Saving Engine',
      params.operatorRole ?? null,
      params.branchId
    );
  }

  return { savingAmount };
}