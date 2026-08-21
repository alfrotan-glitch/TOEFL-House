/**
 * Canonical invoice numbering.
 *
 * The series is scoped by branch and calendar year, and
 * `uq_invoices_branch_invoice_number` enforces that scope at rest: two branches
 * may legitimately both hold `INV-2026-00001`, one branch may not.
 *
 * The counter comes from the single sequence authority in `documentNumbers`.
 */
import { allocateDocumentSequence } from './documentNumbers.js';

export function nextInvoiceNumber(branchId: string, year = new Date().getFullYear()): string {
  if (!branchId) throw new Error('Branch is required for invoice numbering.');
  const seq = allocateDocumentSequence(`invoice_sequence:${branchId}:${year}`);
  return `INV-${year}-${String(seq).padStart(5, '0')}`;
}
