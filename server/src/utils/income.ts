import { assertMoney } from './money.js';
import { HttpError } from '../middleware/errorHandler.js';
import { db } from '../db/connection.js';
import { id, today } from './ids.js';
import { getNumberSetting } from './settings.js';
import {
  decrementMainBalanceIfSufficient, decrementSavingBalanceIfSufficient,
  getFinanceAccount, incrementMainBalance, incrementSavingBalance,
} from './financeAccounts.js';

/** Money is stored to 2dp; keep intermediate arithmetic on the same grid. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
    // A reversal must be able to undo what the original income did.
    //
    // Positive income does TWO things: it credits main, then immediately
    // sweeps `daily_saving_percent` of it into savings. Debiting only main on
    // the way back therefore cannot cover the full amount — after a 200 AFN
    // payment with a 5% sweep, main holds 190 and a legitimate 200 AFN refund
    // failed outright. The money was not missing, it was in the savings
    // account, one row away.
    //
    // So: take what main can cover, and reclaim the remainder from the savings
    // the sweep created. Savings is a destination for operating income, not a
    // ring-fenced fund, and this only ever pulls back money the sweep itself
    // put there.
    const owed = Math.abs(normalizedAmount);
    if (!decrementMainBalanceIfSufficient('branch', params.branchId, owed)) {
      const { mainBalance, savingBalance } = getFinanceAccount('branch', params.branchId);
      const fromSaving = round2(owed - mainBalance);
      if (mainBalance < 0 || fromSaving > savingBalance) {
        throw new HttpError(
          409,
          `Insufficient branch funds for this reversal/refund. Available: ${round2(mainBalance + savingBalance)} AFN, required: ${owed} AFN.`,
        );
      }
      if (mainBalance > 0 && !decrementMainBalanceIfSufficient('branch', params.branchId, mainBalance)) {
        throw new HttpError(409, 'Branch operating balance changed during this reversal. Please retry.');
      }
      if (!decrementSavingBalanceIfSufficient('branch', params.branchId, fromSaving)) {
        throw new HttpError(409, 'Insufficient branch savings for this reversal/refund.');
      }
      // The sweep that moved this money into savings is itself reversed, so the
      // saving_transfer ledger nets to what was actually retained.
      stmtInsertSavingTx.run(
        id('tx_saving'),
        -fromSaving,
        date,
        `Savings reclaimed to fund reversal: ${params.description}`,
        'Real-time Saving Engine',
        params.operatorRole ?? null,
        params.branchId,
      );
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
      throw new HttpError(409, 'Insufficient branch cash for the automatic savings transfer.');
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