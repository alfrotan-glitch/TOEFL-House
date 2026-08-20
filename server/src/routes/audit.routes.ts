import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, denyPermissionless, resolveBranchScope } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';

export const auditRouter = Router();
auditRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
// Filters + pagination are bound parameters only; the LIMIT is applied in SQL.
const stmtCountAuditLogs = db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE 1=1');
const stmtCountAuditLogsByBranch = db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE branch_id = ?');
const stmtGetAuditLogsPage = db.prepare('SELECT * FROM audit_logs ORDER BY date DESC, time DESC, rowid DESC LIMIT ? OFFSET ?');
const stmtGetAuditLogsPageByBranch = db.prepare('SELECT * FROM audit_logs WHERE branch_id = ? ORDER BY date DESC, time DESC, rowid DESC LIMIT ? OFFSET ?');

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

const stmtGetNotifications = db.prepare(
  `SELECT * FROM notifications 
   WHERE (user_id = ? OR (user_id IS NULL AND (branch_id = ? OR branch_id IS NULL))) 
   ORDER BY date DESC LIMIT 100`
);
const stmtGetNotificationById = db.prepare('SELECT * FROM notifications WHERE id = ?');
const stmtMarkNotificationRead = db.prepare(
  'UPDATE notifications SET read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
);
// Do not touch global (user_id IS NULL) notifications, as it affects all users.
const stmtMarkAllUserNotificationsRead = db.prepare(
  'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
);

notificationsRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    const branchId = req.user?.branchId;
    if (!userId || !branchId) throw new HttpError(403, 'User context is missing.');
    
    // Fetch notifications specifically for this user, or global branch/org notifications
    const rows = stmtGetNotifications.all(userId, branchId);
    res.json(rows);
  })
);

notificationsRouter.patch(
  '/:id/read',
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');
    
    const existing = stmtGetNotificationById.get(req.params.id) as 
      | { id: string; user_id: string | null } 
      | undefined;
      
    if (!existing) throw new HttpError(404, 'Notification not found.');
    if (existing.user_id && existing.user_id !== userId) {
      throw new HttpError(403, 'You do not have permission to modify this notification.');
    }
    
    stmtMarkNotificationRead.run(req.params.id, userId);
    res.json({ ok: true });
  })
);

notificationsRouter.post(
  '/read-all',
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');
    // Global notifications (user_id IS NULL) are left untouched to avoid clearing them for everyone else.
    stmtMarkAllUserNotificationsRead.run(userId);
    res.json({ ok: true });
  })
);

export default auditRouter;