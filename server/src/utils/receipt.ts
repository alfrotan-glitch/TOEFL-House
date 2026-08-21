/**
 * Receipt numbers and student codes.
 *
 * Both are allocated from the one sequence authority
 * (`documentNumbers.allocateDocumentSequence`), so there is a single
 * implementation of "next number in this series" in the codebase. Never
 * generate either from `Math.random()`: random identifiers collide, and a
 * collision on a receipt number means two payments claim one proof.
 *
 * Receipt numbers are issued from a SINGLE global series, not per branch, which
 * is why `uq_payments_receipt_number` enforces global uniqueness at rest.
 */
import { allocateDocumentSequence, formatDocumentNumber } from './documentNumbers.js';

/** Series keys. Stated once, so a rename cannot silently restart a sequence. */
const RECEIPT_SERIES = 'receipt_counter';
const STUDENT_CODE_SERIES = 'student_code_counter';

/** The next receipt number: `R-00000001`. */
export function nextReceiptNumber(): string {
  return formatDocumentNumber('R', allocateDocumentSequence(RECEIPT_SERIES), 8);
}

/** The next student code: `TH-001001`. The series starts at 1001. */
export function nextStudentCode(): string {
  return formatDocumentNumber('TH', allocateDocumentSequence(STUDENT_CODE_SERIES, 1001), 6);
}
