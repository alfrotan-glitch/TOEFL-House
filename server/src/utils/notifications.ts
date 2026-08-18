import { db } from '../db/connection.js';
import { id, today } from './ids.js';

/**
 * Must stay in lockstep with the `notifications.type` CHECK constraint in
 * schema.sql: CHECK (type IN ('info','warning','critical','success')).
 *
 * This type previously also allowed 'alert', which the database has never
 * accepted. TypeScript therefore green-lit a value that failed at runtime, and
 * because the insert happens AFTER the caller's own state change has committed,
 * the CHECK violation surfaced as a misleading 400 on an operation that had
 * actually succeeded (finance finding F-4).
 */
export type NotificationType = 'info' | 'warning' | 'critical' | 'success';

// ── Performance: Compile statement only once at module load ────────────────
const stmtInsertNotification = db.prepare(
  `INSERT INTO notifications (id, title, message, date, read, type, branch_id) 
   VALUES (?, ?, ?, ?, 0, ?, ?)`
);

/**
 * Adds a notification to the database.
 * @returns The ID of the newly created notification.
 */
export function addNotification(
  title: string,
  message: string,
  type: NotificationType,
  branchId?: string | null
): string {
  const notificationId = id('n');
  
  stmtInsertNotification.run(
    notificationId,
    title,
    message,
    today(),
    type,
    branchId ?? null
  );
  return notificationId;
}