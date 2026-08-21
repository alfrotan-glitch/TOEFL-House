/**
 * Document numbering — THE single sequence authority.
 * ============================================================================
 * Every human-facing document in this system carries a number that must be
 * unique and gap-free within its own series: receipts, student codes, invoices,
 * donation receipts, certificates. Before this module owned all of them, three
 * files each implemented "read the counter, add one, pad it", which is three
 * places for one rule to drift — and drift here is not cosmetic, because two
 * documents sharing a number make the audit trail ambiguous.
 *
 * The counter itself lives in `system_settings` and is incremented by a single
 * atomic UPSERT, so concurrent requests cannot be handed the same number. The
 * database backs that up: `uq_payments_receipt_number` and
 * `uq_invoices_branch_invoice_number` refuse a duplicate at rest, because an
 * application-only guarantee is not a guarantee (LAW 3).
 *
 * A series is identified by its `system_settings` KEY. The keys are stated
 * explicitly by each caller below rather than derived, so a change of series
 * naming can never silently restart a live sequence at 1.
 */
import { incrementNumberSetting } from './settings.js';

/**
 * Allocates the next number in the series held under `key`.
 *
 * @param start the value the series takes on its first allocation.
 */
export function allocateDocumentSequence(key: string, start = 1): number {
  if (!key) throw new Error('Document numbering requires a series key.');
  const next = Math.trunc(Number(incrementNumberSetting(key, 1, start - 1)) || start);
  return next;
}

/** Formats a series number as `PREFIX-NNNN…`. */
export function formatDocumentNumber(prefix: string, value: number, width: number): string {
  return `${prefix}-${String(value).padStart(width, '0')}`;
}

/**
 * A number scoped to an owner (branch) and a calendar year, e.g. `DON-2026-000001`.
 *
 * The rendered string carries the year but not the scope, so uniqueness is
 * scoped to the owner exactly as the counter is.
 */
export function nextScopedDocumentNumber(kind: string, scopeId: string, prefix: string, year = new Date().getFullYear(), width = 6): string {
  if (!kind || !scopeId || !prefix) throw new Error('Document numbering requires kind, scope and prefix.');
  const seq = allocateDocumentSequence(`document_sequence:${kind}:${scopeId}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(width, '0')}`;
}
