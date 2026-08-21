/**
 * Budget-line movement authority — THE only way money enters or leaves a
 * budget envelope other than by being spent.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A budget line is the third store of money in this system, after branch cash
 * (`finance_accounts` scoped to a branch) and the organization treasury
 * (`finance_accounts` scoped to the organization). Three flows move money into
 * or out of a line without spending it:
 *
 *   allocation     treasury → line          (fund the envelope)
 *   return         line → treasury          (month-end, unused money goes back)
 *   transfer       line → line, same branch (month-end, reassign the remainder)
 *
 * All three write through this module so that one convention governs what a
 * budget ledger row means. Left to themselves they diverge in ways that money
 * cannot survive: an allocation and a return both written as a POSITIVE
 * `budget_charge` make `SUM(budget_charge)` — which the reconciler reads as the
 * money placed in budget lines — grow when money leaves them; a line-to-line
 * transfer written as a `saving_transfer` credits a savings account that was
 * never involved. `server/src/tests/work-packages/wp07/` pins both.
 *
 * THE CONVENTION, fixed once, here
 * --------------------------------
 * A budget movement is ONE row, `type = 'budget_charge'`, whose amount is
 * SIGNED: positive moves money INTO the line, negative moves it OUT.
 * `reference_id` is always the line that moved, and `branch_id` is always the
 * branch that OWNS the line — never the operator's branch, because the money
 * belongs to the line's branch no matter who pressed the button.
 *
 * A transfer is therefore exactly two movements (−X out of the source, +X into
 * the target) which sum to zero, and `saving_transfer` is left to mean what its
 * name says: a movement of the branch SAVINGS account, written only by
 * `recordIncome`.
 *
 * The invariant this preserves, per branch:
 *
 *     SUM(budget_lines.current_amount)
 *       = SUM(budget_charge) − SUM(expense paid from a budget line)
 *
 * and, per line:
 *
 *     allocated_amount = SUM(budget_charge for that line)
 *     current_amount   = allocated_amount − (spend from that line)
 *
 * `allocated_amount` therefore tracks the money actually placed in the line
 * rather than the money ever placed in it, which is what makes budget
 * utilization (`used = allocated − current`) mean "spent". While a return left
 * `allocated_amount` untouched, a line that was funded and then returned unspent
 * reported 100% utilization on the finance dashboard.
 */
import { db } from '../../db/connection.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertMoney } from '../../utils/money.js';
import { id } from '../../utils/ids.js';

/** `financial_transactions.type` used by every budget movement. */
export const BUDGET_MOVEMENT_TYPE = 'budget_charge';

export type BudgetMovementKind = 'allocation' | 'return' | 'transfer_out' | 'transfer_in';

/** The readable label written to `financial_transactions.category`. */
export const BUDGET_MOVEMENT_CATEGORY: Record<BudgetMovementKind, string> = {
  allocation: 'budget_allocation',
  return: 'budget_return',
  transfer_out: 'budget_transfer_out',
  transfer_in: 'budget_transfer_in',
};

/** The direction each kind is allowed to move money, so a caller cannot mislabel one. */
const KIND_DIRECTION: Record<BudgetMovementKind, 'in' | 'out'> = {
  allocation: 'in',
  return: 'out',
  transfer_out: 'out',
  transfer_in: 'in',
};

/** The minimum shape of a budget line this writer needs. */
export interface BudgetLineRef {
  id: string;
  name: string;
  branch_id: string;
}

const stmtCredit = db.prepare(
  `UPDATE budget_lines
      SET current_amount = current_amount + ?, allocated_amount = allocated_amount + ?
    WHERE id = ?`,
);

// Guarded in the UPDATE itself, so two concurrent returns cannot both succeed.
const stmtDebit = db.prepare(
  `UPDATE budget_lines
      SET current_amount = current_amount - ?, allocated_amount = allocated_amount - ?
    WHERE id = ? AND current_amount >= ? AND allocated_amount >= ?`,
);

const stmtInsertMovement = db.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, finance_category_id, amount, date, description, reference_id, operator_name, operator_role, branch_id)
   VALUES (?, '${BUDGET_MOVEMENT_TYPE}', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
);

export interface BudgetMovementParams {
  line: BudgetLineRef;
  kind: BudgetMovementKind;
  /** Magnitude in whole AFN. The direction comes from `kind`, never from a sign here. */
  amount: number;
  date: string;
  description: string;
  operatorName: string;
  /** Position held at write time, preserved for traceability. */
  operatorRole?: string | null;
}

/**
 * Moves money into or out of a budget line and records the matching ledger row.
 *
 * The line update and the ledger row are written together so neither can exist
 * without the other. Must run inside a transaction: a caller that moves the
 * treasury or a second line has to commit or roll back with this write.
 */
export function postBudgetMovement(params: BudgetMovementParams): void {
  if (!db.inTransaction) {
    throw new Error('postBudgetMovement() called outside a transaction. Wrap the caller in db.transaction().');
  }
  const magnitude = assertMoney(params.amount, 'budget movement amount');
  if (magnitude === 0) throw new HttpError(400, 'A budget movement must be greater than zero.');

  const direction = KIND_DIRECTION[params.kind];
  const signedAmount = direction === 'out' ? -magnitude : magnitude;

  const result = direction === 'out'
    ? stmtDebit.run(magnitude, magnitude, params.line.id, magnitude, magnitude)
    : stmtCredit.run(magnitude, magnitude, params.line.id);
  if (result.changes !== 1) {
    throw new HttpError(409, `Insufficient budget on "${params.line.name}" or the balance changed. Please retry.`);
  }

  stmtInsertMovement.run(
    id('tx'),
    BUDGET_MOVEMENT_CATEGORY[params.kind],
    signedAmount,
    params.date,
    params.description,
    params.line.id,
    params.operatorName,
    params.operatorRole ?? null,
    params.line.branch_id,
  );
}
