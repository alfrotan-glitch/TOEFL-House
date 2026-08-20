import { db } from '../db/connection.js';
import { id, today } from './ids.js';

/**
 * Must stay in lockstep with the `notifications.type` CHECK constraint in
 * schema.sql: CHECK (type IN ('info','warning','critical','success')).
 *
 * Adding a member the CHECK does not list — 'alert', for instance — makes
 * TypeScript green-light a value that fails at runtime. Because the insert
 * happens AFTER the caller's own state change has committed, the CHECK
 * violation then surfaces as a misleading 400 on an operation that actually
 * succeeded (finance finding F-4).
 */
export type NotificationType = 'info' | 'warning' | 'critical' | 'success';

// ── Performance: Compile statement only once at module load ────────────────
const stmtInsertNotification = db.prepare(
  `INSERT INTO notifications (id, title, message, date, type, branch_id)
   VALUES (?, ?, ?, ?, ?, ?)`
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
