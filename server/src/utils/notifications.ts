import { db } from '../db/connection.js';
import { id, today } from './ids.js';

export type NotificationType = 'alert' | 'info' | 'success' | 'warning';

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