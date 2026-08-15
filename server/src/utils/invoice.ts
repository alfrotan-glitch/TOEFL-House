import { incrementNumberSetting } from './settings.js';

/**
 * Canonical invoice numbering for all issued invoices.
 * Sequence is scoped by branch and calendar year.
 */
export function nextInvoiceNumber(branchId: string, year = new Date().getFullYear()): string {
  if (!branchId) throw new Error('Branch is required for invoice numbering.');
  const key = `invoice_sequence:${branchId}:${year}`;
  const seq = Math.trunc(Number(incrementNumberSetting(key, 1, 0)) || 1);
  return `INV-${year}-${String(seq).padStart(5, '0')}`;
}
