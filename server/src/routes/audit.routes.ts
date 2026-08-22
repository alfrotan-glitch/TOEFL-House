import { Router } from 'express';
import { db } from '../db/connection.js';
import {
  authenticate,
  authorize,
  canAccessBranchResource,
  denyPermissionless,
  resolveBranchScope,
} from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';

export const auditRouter = Router();
auditRouter.use(authenticate);

// Only owner & manager can see the full audit trail.
auditRouter.get(
  '/',
  authorize('general_manager'), // authorize() implicitly allows 'owner' as well
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const operatorName = typeof req.query.operatorName === 'string' ? req.query.operatorName.trim() : '';
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : '';
    const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : '';
    const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!isAll) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (operatorName) { clauses.push('operator_name LIKE ?'); params.push(`%${operatorName.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); }
    if (action) { clauses.push('action LIKE ?'); params.push(`%${action.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); }
    if (dateFrom) { clauses.push('date >= ?'); params.push(dateFrom); }
    if (dateTo) { clauses.push('date <= ?'); params.push(dateTo); }

    const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${whereSql}`).get(...params) as { c: number };
    const rows = db.prepare(`SELECT * FROM audit_logs${whereSql} ORDER BY date DESC, time DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.setHeader('X-Total-Count', String(countRow.c));
    res.setHeader('X-Page-Limit', String(limit));
    res.setHeader('X-Page-Offset', String(offset));
    if (req.query.includeTotal === '1') {
      res.json({ rows, total: countRow.c });
      return;
    }
    res.json(rows);
  })
);

// ============================================================================
// Notifications Router
// ============================================================================
export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

/**
 * A notification is a branch-visible event. Read state belongs to the viewer
 * and is derived from a receipt; the event row itself is immutable when a user
 * reads it. The LEFT JOIN therefore projects the API's `read` field without
 * creating shared mutable state on `notifications`.
 */
const stmtGetNotificationsScoped = db.prepare(
  `SELECT n.*,
          CASE WHEN rr.notification_id IS NULL THEN 0 ELSE 1 END AS read
     FROM notifications n
     LEFT JOIN notification_read_receipts rr
       ON rr.notification_id = n.id AND rr.user_id = ?
    WHERE n.branch_id = ? OR n.branch_id IS NULL
    ORDER BY n.date DESC, n.rowid DESC
    LIMIT 100`
);
const stmtGetNotificationsAllBranches = db.prepare(
  `SELECT n.*,
          CASE WHEN rr.notification_id IS NULL THEN 0 ELSE 1 END AS read
     FROM notifications n
     LEFT JOIN notification_read_receipts rr
       ON rr.notification_id = n.id AND rr.user_id = ?
    ORDER BY n.date DESC, n.rowid DESC
    LIMIT 100`
);
const stmtGetNotificationById = db.prepare(
  'SELECT id, branch_id FROM notifications WHERE id = ?'
);
const stmtMarkNotificationRead = db.prepare(
  `INSERT OR IGNORE INTO notification_read_receipts (notification_id, user_id)
   VALUES (?, ?)`
);
const stmtMarkScopedNotificationsRead = db.prepare(
  `INSERT OR IGNORE INTO notification_read_receipts (notification_id, user_id)
   SELECT n.id, ?
     FROM notifications n
    WHERE n.branch_id = ? OR n.branch_id IS NULL`
);
const stmtMarkAllNotificationsRead = db.prepare(
  `INSERT OR IGNORE INTO notification_read_receipts (notification_id, user_id)
   SELECT n.id, ? FROM notifications n`
);

notificationsRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');

    const scope = resolveBranchScope(req, { defaultToAllAuthorized: true });
    const rows = scope.isAll
      ? stmtGetNotificationsAllBranches.all(userId)
      : stmtGetNotificationsScoped.all(userId, scope.branchId);
    res.json(rows);
  })
);

notificationsRouter.patch(
  '/:id/read',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');

    const existing = stmtGetNotificationById.get(req.params.id) as
      | { id: string; branch_id: string | null }
      | undefined;

    if (!existing) throw new HttpError(404, 'Notification not found.');
    if (existing.branch_id && !canAccessBranchResource(req, existing.branch_id)) {
      throw new HttpError(403, 'This notification belongs to a branch outside your authorized scope.');
    }

    const result = stmtMarkNotificationRead.run(req.params.id, userId);
    res.json({ ok: true, marked: result.changes });
  })
);

notificationsRouter.post(
  '/read-all',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');

    const scope = resolveBranchScope(req, { defaultToAllAuthorized: true });
    const result = scope.isAll
      ? stmtMarkAllNotificationsRead.run(userId)
      : stmtMarkScopedNotificationsRead.run(userId, scope.branchId);
    res.json({ ok: true, marked: result.changes });
  })
);

export default auditRouter;
