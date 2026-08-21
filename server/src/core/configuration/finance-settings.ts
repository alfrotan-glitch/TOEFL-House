/**
 * Finance operational settings — one validation authority for the three
 * numeric values that change how money behaves.
 *
 * `system_settings` is a key/value store, so nothing about it prevents two
 * endpoints from writing the same key under two different rules. Three
 * endpoints write these keys — the savings-rate control, the auto-approve
 * threshold control and the finance configuration form — and each rule they do
 * not share is a way for the stored value to become something no operator
 * chose:
 *
 *   * a rate accepted above 100 changes how much of every payment is swept;
 *   * a threshold silently rounded stores a figure nobody typed;
 *   * a value quietly skipped because it failed a check answers 200 while
 *     changing nothing, so the operator believes the new setting is in force.
 *
 * Each descriptor below owns the key, the human label and the parse. A writer
 * consumes a descriptor; it never re-states the rule.
 */
import { HttpError } from '../../middleware/errorHandler.js';
import { assertDayOffset, assertMoney } from '../../utils/money.js';

export interface FinanceSettingDescriptor {
  /** `system_settings` key. */
  key: string;
  /** Field name used by the API and the UI. */
  field: string;
  /** Parses operator input into the canonical stored value. Throws HttpError(400). */
  parse(value: unknown): number;
}

/**
 * The share of each operating payment swept into the branch savings account.
 *
 * A percentage, not money: fractional rates are legitimate (2.5%), so this is
 * not `assertMoney`. The bound is the definition of a percentage — a rate above
 * 100% would sweep more than the payment.
 */
function parsePercent(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new HttpError(400, 'Percentage must be a number between 0 and 100.');
  }
  return n;
}

export const FINANCE_SETTINGS: Record<'dailySavingPercent' | 'expenseAutoApproveThreshold' | 'invoiceDueDays', FinanceSettingDescriptor> = {
  dailySavingPercent: {
    key: 'daily_saving_percent',
    field: 'dailySavingPercent',
    parse: parsePercent,
  },
  expenseAutoApproveThreshold: {
    key: 'expense_auto_approve_threshold',
    field: 'expenseAutoApproveThreshold',
    // Money, so it obeys the money boundary: whole AFN, rejected rather than
    // rounded, because a threshold is compared against real expense amounts.
    parse: (value: unknown) => assertMoney(value, 'Auto-approve threshold'),
  },
  invoiceDueDays: {
    key: 'invoice_due_days',
    field: 'invoiceDueDays',
    parse: (value: unknown) => assertDayOffset(value, 'Invoice due days'),
  },
};

/** Every descriptor, for writers that accept a patch of several fields. */
export const FINANCE_SETTING_LIST: FinanceSettingDescriptor[] = Object.values(FINANCE_SETTINGS);
