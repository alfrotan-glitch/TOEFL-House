/**
 * Invoice purpose — THE authority for what an invoice bills and what its
 * payment settles (owner decision D-118).
 * ============================================================================
 * An invoice is a claim on a student. Until it says WHAT it claims, the money
 * that answers it cannot say what it settled, and the system has to guess. It
 * guessed one way for every invoice: `category = 'fee'`, tuition, always. That
 * single literal produced two opposite errors from one root (WP07-F17):
 *
 *   a 3,000 AFN textbooks invoice reduced a 10,000 AFN tuition debt to 7,000
 *   — receivable forgiven that nobody forgave; and
 *
 *   a 10,000 AFN tuition invoice, paid in full, settled no term at all, so the
 *   payment desk would take the same 10,000 AFN twice.
 *
 * ONE INVOICE BILLS ONE OBLIGATION
 * --------------------------------
 * `purpose` lives on the invoice, not on the line, so a document is homogeneous
 * by construction. A tuition invoice names exactly one obligation. The
 * alternative — obligations per line — forces a partial payment to be SPLIT
 * between them, and no rule for that split exists anywhere in this repository.
 * Inventing one would be inventing business policy (§61).
 *
 * WHAT A PURPOSE DECIDES
 * ----------------------
 * Exactly two things, both derived here and nowhere else:
 *
 *   1. the `payments.category` its collection is recorded under, and
 *   2. whether that collection settles a tuition term — and if so, which one.
 *
 * Non-tuition money carries no obligation, which is what keeps it out of the
 * obligation-keyed settlement authority and out of the student's tuition position.
 */
import type { Database } from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { ensureTuitionObligation, getObligationPosition } from './obligations.js';

export const INVOICE_PURPOSES = ['tuition', 'books', 'exam', 'other'] as const;
export type InvoicePurpose = (typeof INVOICE_PURPOSES)[number];

/**
 * Purpose → the category its payment is recorded under.
 *
 * `fee` is reachable from exactly one purpose. That is the whole point: it is
 * the category `studentBalance` counts as tuition, so nothing may fall into it
 * by default.
 */
const PURPOSE_PAYMENT_CATEGORY: Record<InvoicePurpose, string> = {
  tuition: 'fee',
  books: 'book',
  exam: 'exam',
  other: 'other',
};

const isPurpose = (value: unknown): value is InvoicePurpose =>
  typeof value === 'string' && (INVOICE_PURPOSES as readonly string[]).includes(value);

/**
 * The declared purpose, or a refusal.
 *
 * There is deliberately no default. A default is how every invoice became
 * tuition in the first place: the writer said nothing and the system decided
 * for it. An operator who does not say what they are billing is asked.
 */
export function assertInvoicePurpose(value: unknown): InvoicePurpose {
  if (value == null || value === '') {
    throw new HttpError(400, `An invoice must declare its purpose (${INVOICE_PURPOSES.join(', ')}).`);
  }
  if (!isPurpose(value)) {
    throw new HttpError(400, `Unrecognised invoice purpose. Use one of: ${INVOICE_PURPOSES.join(', ')}.`);
  }
  return value;
}

/**
 * The obligation an invoice bills, resolved from its purpose and the term it
 * names. Tuition must name a term; nothing else may.
 *
 * The obligation is created on first use through the settlement authority
 * (D-120), so an invoice and a scholarship applied to the same term point at
 * the same row rather than at two descriptions of one debt.
 */
export function resolveInvoiceObligation(
  db: Database,
  params: { studentId: string; purpose: InvoicePurpose; semesterId?: unknown },
): { obligationId: string | null; semesterName: string | null } {
  const semesterId = typeof params.semesterId === 'string' && params.semesterId.trim() ? params.semesterId.trim() : null;

  if (params.purpose !== 'tuition') {
    if (semesterId) {
      throw new HttpError(400, 'Only a tuition invoice bills a term; this purpose bills none.');
    }
    return { obligationId: null, semesterName: null };
  }

  if (!semesterId) {
    throw new HttpError(400, 'A tuition invoice must name the term it bills (semesterId).');
  }

  const owner = db.prepare('SELECT student_id FROM student_semesters WHERE id = ?').get(semesterId) as
    | { student_id: string }
    | undefined;
  if (!owner) throw new HttpError(404, 'Semester not found.');
  if (owner.student_id !== params.studentId) {
    throw new HttpError(400, 'That term belongs to another student.');
  }

  const obligation = ensureTuitionObligation(db, semesterId);
  if (obligation.status !== 'open') {
    throw new HttpError(409, 'That term is not open for billing.');
  }
  return { obligationId: obligation.id, semesterName: obligation.semesterName };
}

/**
 * A document that bills nothing identifiable may not take money.
 *
 * The extra-class path created invoices with no line items at all: a net amount
 * with no statement of what it was for. Refusing payment on one is the money
 * boundary's own guard, independent of every writer.
 */
export function assertInvoiceHasLines(db: Database, invoiceId: string): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM invoice_items WHERE invoice_id = ?').get(invoiceId) as { c: number };
  if (Number(row.c) <= 0) {
    throw new HttpError(409, 'This invoice has no line items and cannot accept payment.');
  }
}

/**
 * What is left of a term for a new tuition invoice to bill (WP07-F19).
 *
 * A term bills one amount, and every claim on it competes for that amount:
 * money already settled, and the unpaid remainder of the tuition invoices that
 * already stand against it. Without this, two 6,000 AFN tuition invoices on a
 * 10,000 AFN term were both payable and 12,000 AFN was collected for it — each
 * invoice was individually within its own balance, and nothing looked at the
 * term. This is D-125's instalment rule ("a plan may not promise more than the
 * term bills") applied to the other document that promises.
 *
 * A cancelled invoice claims nothing, so cancelling one returns its capacity.
 */
export function tuitionBillingCapacity(
  db: Database,
  obligationId: string,
  opts: { excludeInvoiceId?: string } = {},
): number {
  const position = getObligationPosition(db, obligationId);
  const claimed = db
    .prepare(
      `SELECT COALESCE(SUM(MAX(0, i.net_amount - COALESCE(
                (SELECT SUM(p.amount) FROM payments p
                  WHERE p.invoice_id = i.id AND p.status = 'completed'), 0))), 0) AS t
         FROM invoices i
        WHERE i.obligation_id = ? AND i.status <> 'cancelled' AND i.id IS NOT ?`,
    )
    .get(obligationId, opts.excludeInvoiceId ?? null) as { t: number };
  return position.obligation.netAmount - position.settled - (Number(claimed.t) || 0);
}

/** A tuition invoice may not bill more of a term than the term has left. */
export function assertTuitionInvoiceFits(
  db: Database,
  params: { obligationId: string; netAmount: number; excludeInvoiceId?: string },
): void {
  const capacity = tuitionBillingCapacity(db, params.obligationId, { excludeInvoiceId: params.excludeInvoiceId });
  if (params.netAmount > capacity) {
    throw new HttpError(
      400,
      capacity <= 0
        ? 'That term is already fully billed or settled.'
        : `That term has only ${capacity} AFN left to bill.`,
    );
  }
}

export type InvoiceChargeKind = 'registration' | 'placement' | 'books' | 'exam' | 'other';

export interface InvoiceAttribution {
  purpose: InvoicePurpose;
  chargeKind: InvoiceChargeKind;
  /** The `payments.category` this collection is recorded under. */
  category: string;
  /** The term this collection settles, or null when it settles no term. */
  semesterName: string | null;
  obligationId: string | null;
}

/**
 * How a payment against this invoice must be recorded.
 *
 * The term comes from the obligation the invoice names, never from the payer
 * and never from "the student's most recent active semester" — a guess that
 * settles whichever term happens to be open rather than the one that was
 * billed.
 */
function normalizeInvoiceChargeKind(invoice: { purpose: unknown; charge_kind?: unknown }): InvoiceChargeKind {
  if (typeof invoice.charge_kind === 'string' && ['registration', 'placement', 'books', 'exam', 'other'].includes(invoice.charge_kind)) {
    return invoice.charge_kind as InvoiceChargeKind;
  }
  const purpose = assertInvoicePurpose(invoice.purpose);
  if (purpose === 'books' || purpose === 'exam') return purpose;
  return 'other';
}

function chargeKindPaymentCategory(kind: InvoiceChargeKind): string {
  if (kind === 'books') return 'book';
  if (kind === 'exam') return 'exam';
  if (kind === 'placement') return 'placement';
  return 'other';
}

export function invoicePaymentAttribution(
  db: Database,
  invoice: { id: string; purpose: unknown; obligation_id: string | null; charge_kind?: unknown },
): InvoiceAttribution {
  const purpose = assertInvoicePurpose(invoice.purpose);
  if (purpose !== 'tuition') {
    const chargeKind = normalizeInvoiceChargeKind(invoice);
    return { purpose, chargeKind, category: chargeKindPaymentCategory(chargeKind), semesterName: null, obligationId: null };
  }
  if (!invoice.obligation_id) {
    throw new HttpError(409, 'This tuition invoice names no term and cannot accept payment.');
  }
  const row = db
    .prepare(
      `SELECT ss.semester_name FROM student_obligations o
         JOIN student_semesters ss ON ss.id = o.semester_id
        WHERE o.id = ?`,
    )
    .get(invoice.obligation_id) as { semester_name: string } | undefined;
  if (!row) throw new HttpError(409, 'The term this invoice bills no longer exists.');
  return {
    purpose,
    chargeKind: 'other',
    category: PURPOSE_PAYMENT_CATEGORY.tuition,
    semesterName: row.semester_name,
    obligationId: invoice.obligation_id,
  };
}

// ── Which academic fees are tuition (owner decision on WP07-F18) ───────────
//
// `fee_rules.fee_type` is academic configuration; whether a given type is
// TUITION is a money rule, so it lives here beside the purpose vocabulary
// rather than in the catalog. One declaration, read by the enrolment writer and
// by the discount ceiling, so the two can never disagree about what a discount
// attaches to.
//
// `semester` bills the term. `retake` bills a repeat of the term, which the
// owner ruled is tuition. `registration`, `placement`, `book`, `card`, `exam`,
// `diploma` and `other` are charges alongside tuition, not tuition.

export const TUITION_FEE_TYPES = ['semester', 'retake'] as const;

export const isTuitionFeeType = (feeType: unknown): boolean =>
  typeof feeType === 'string' && (TUITION_FEE_TYPES as readonly string[]).includes(feeType);

export interface SnapshotFee {
  feeType: string;
  name: string;
  amount: number;
}

export interface FeePartition {
  tuitionFees: SnapshotFee[];
  otherFees: SnapshotFee[];
  tuitionTotal: number;
  otherTotal: number;
}

/**
 * Splits a fee snapshot into the part that bills a term and the part that does
 * not.
 *
 * A discount attaches to the tuition part only, which is what visitor
 * conversion and manual registration already do — they compute
 * `netTuition = gross - gross * percent / 100` and never discount a
 * registration fee. Applying the same rule here removes an inconsistency
 * instead of introducing one.
 */
export function partitionFeeSnapshot(fees: readonly SnapshotFee[] | undefined): FeePartition {
  const tuitionFees: SnapshotFee[] = [];
  const otherFees: SnapshotFee[] = [];
  for (const fee of fees ?? []) {
    (isTuitionFeeType(fee.feeType) ? tuitionFees : otherFees).push(fee);
  }
  const sum = (rows: SnapshotFee[]) => rows.reduce((total, fee) => total + (Number(fee.amount) || 0), 0);
  return { tuitionFees, otherFees, tuitionTotal: sum(tuitionFees), otherTotal: sum(otherFees) };
}
