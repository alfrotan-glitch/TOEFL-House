/**
 * Atomic receipt & student-code generators.
 * All use system_settings as an atomic counter — safe under concurrent access
 * because every call is a single SQL statement executed inside the caller's
 * db.transaction() (or the implicit autocommit transaction of better-sqlite3).
 *
 * CRITICAL: never use Math.random() for receipt numbers or student codes.
 * Math.random() produces collisions under concurrent requests.
 * 
 * WARNING FOR SETTINGS.TS: If you run Node.js in Cluster Mode (multi-process),
 * ensure `incrementNumberSetting` uses `UPDATE system_settings SET value = value + ? WHERE key = ? RETURNING value`
 * to prevent race conditions between different CPU cores.
 */
import { incrementNumberSetting } from './settings.js';

/**
 * Generates the next receipt number: R-XXXXXXXX
 * Uses an atomic counter in system_settings, guaranteed unique.
 */
export function nextReceiptNumber(): string {
  const seq = incrementNumberSetting('receipt_counter', 1, 0);
  const seqNum = Math.trunc(Number(seq) || 0);
  return `R-${String(seqNum).padStart(8, '0')}`;
}

/**
 * Generates the next student code: TH-NNNN
 * Uses an atomic counter in system_settings, guaranteed unique.
 */
export function nextStudentCode(): string {
  // Assuming default starts at 1000
  const seq = incrementNumberSetting('student_code_counter', 1, 1000);
  const seqNum = Math.trunc(Number(seq) || 1000);
  // in the DB doesn't break when numbers grow (e.g., TH-001000 vs TH-001001)
  return `TH-${String(seqNum).padStart(6, '0')}`;
}