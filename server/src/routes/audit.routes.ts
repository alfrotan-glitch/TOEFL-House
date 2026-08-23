import { Router } from 'express';
import { db } from '../db/connection.js';
import {
  authenticate,
  canAccessBranchResource,
  denyPermissionless,
  requirePermission,
  resolveBranchScope,
} from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { parsePagination } from '../utils/pagination.js';

export const auditRouter = Router();
auditRouter.use(authenticate);

interface AuditLogRow {
  id: string;
  operator_id: string | null;
  operator_name: string | null;
  operator_role: string | null;
  action: string;
  date: string;
  time: string;
  old_value: string | null;
  new_value: string | null;
  ip: string | null;
  device: string | null;
  branch_id: string | null;
}

interface AuditFailureRow {
  id: string;
  occurred_at: string;
  request_id: string | null;
  operator_id: string | null;
  branch_id: string | null;
  action: string;
  error: string;
  payload: string | null;
}

function escapeLikeTerm(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

function pagedResponse<T>(rows: T[], total: number, limit: number, offset: number, page: number) {
  return {
    rows,
    total,
    limit,
    offset,
    page,
    hasMore: offset + rows.length < total,
  };
}

// ============================================================================
// Audit log
// ============================================================================

auditRouter.get(
  '/',
  requirePermission('Audit.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const operatorName = typeof req.query.operatorName === 'string' ? req.query.operatorName.trim() : '';
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : '';
    const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : '';
    const { limit, offset, page } = parsePagination(req, { defaultPageSize: 200, maxPageSize: 2000 });

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!isAll) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (operatorName) { clauses.push("operator_name LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeTerm(operatorName)}%`); }
    if (action) { clauses.push("action LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeTerm(action)}%`); }
    if (dateFrom) { clauses.push('date >= ?'); params.push(dateFrom); }
    if (dateTo) { clauses.push('date <= ?'); params.push(dateTo); }

    const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${whereSql}`).get(...params) as { c: number };
    const rows = db.prepare(
      `SELECT * FROM audit_logs${whereSql} ORDER BY date DESC, time DESC, rowid DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as AuditLogRow[];

    res.setHeader('X-Total-Count', String(countRow.c));
    res.setHeader('X-Page-Limit', String(limit));
    res.setHeader('X-Page-Offset', String(offset));
    res.json(pagedResponse(rows, countRow.c, limit, offset, page));
  })
);

auditRouter.get(
  '/failures',
  requirePermission('Audit.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const error = typeof req.query.error === 'string' ? req.query.error.trim() : '';
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId.trim() : '';
    const dateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : '';
    const dateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : '';
    const { limit, offset, page } = parsePagination(req, { defaultPageSize: 100, maxPageSize: 1000 });

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!isAll) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (action) { clauses.push("action LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeTerm(action)}%`); }
    if (error) { clauses.push("error LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeTerm(error)}%`); }
    if (requestId) { clauses.push('request_id = ?'); params.push(requestId); }
    if (dateFrom) { clauses.push('date(occurred_at) >= ?'); params.push(dateFrom); }
    if (dateTo) { clauses.push('date(occurred_at) <= ?'); params.push(dateTo); }

    const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_failures${whereSql}`).get(...params) as { c: number };
    const rows = db.prepare(
      `SELECT * FROM audit_failures${whereSql} ORDER BY occurred_at DESC, rowid DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as AuditFailureRow[];

    res.setHeader('X-Total-Count', String(countRow.c));
    res.setHeader('X-Page-Limit', String(limit));
    res.setHeader('X-Page-Offset', String(offset));
    res.json(pagedResponse(rows, countRow.c, limit, offset, page));
  })
);

// ============================================================================
// Notifications
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
