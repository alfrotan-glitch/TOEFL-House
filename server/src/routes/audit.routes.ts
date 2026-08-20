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

/**
 * Reads honour the caller's RESOLVED branch scope, not their home branch.
 *
 * `users.branch_id` is an identity attribute and authorizes nothing (C-8);
 * `resolveBranchScope` is the authority, and 74 other route reads already use
 * it. Scoping on identity here meant an organization-scoped owner could not
 * reach another branch's notifications at all — including an expense awaiting
 * their own approval — while the default for everyone else was unchanged.
 *
 * The `user_id` clause is retained deliberately. Nothing writes that column
 * today, so it matches nothing; removing it would silently decide that
 * notifications are never user-targeted, which is exactly the question left
 * open as A-9.1.
 */
const stmtGetNotificationsScoped = db.prepare(
  `SELECT * FROM notifications
   WHERE (user_id = ? OR (user_id IS NULL AND (branch_id = ? OR branch_id IS NULL)))
   ORDER BY date DESC LIMIT 100`
);
const stmtGetNotificationsAllBranches = db.prepare(
  `SELECT * FROM notifications ORDER BY date DESC LIMIT 100`
);
const stmtGetNotificationById = db.prepare(
  'SELECT id, user_id, branch_id FROM notifications WHERE id = ?'
);
const stmtMarkNotificationRead = db.prepare(
  'UPDATE notifications SET read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
);
/**
 * Read state is SHARED per notification row: nothing writes `user_id`, so one
 * row serves everyone who can see it. Whether that is the intended model is
 * undecided (A-9.1) and this statement does not decide it — it is unchanged.
 * What changed is that the handler now reports how many rows it marked, so a
 * call that changes nothing can no longer present itself as a success.
 */
const stmtMarkAllUserNotificationsRead = db.prepare(
  'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
);

notificationsRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');

    const scope = resolveBranchScope(req);
    const rows = scope.isAll
      ? stmtGetNotificationsAllBranches.all()
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
      | { id: string; user_id: string | null; branch_id: string | null }
      | undefined;

    if (!existing) throw new HttpError(404, 'Notification not found.');

    // A notification belongs to a branch, and marking it read hides it from
    // everyone who can see it. So the branch is authorized through the same
    // helper every other cross-branch action uses. Without this the handler
    // let any authenticated principal suppress another branch's alert.
    if (existing.branch_id && !canAccessBranchResource(req, existing.branch_id)) {
      throw new HttpError(403, 'This notification belongs to a branch outside your authorized scope.');
    }
    if (existing.user_id && existing.user_id !== userId) {
      throw new HttpError(403, 'You do not have permission to modify this notification.');
    }

    stmtMarkNotificationRead.run(req.params.id, userId);
    res.json({ ok: true });
  })
);

notificationsRouter.post(
  '/read-all',
  denyPermissionless,
  ah(async (req, res) => {
    const userId = req.user?.userId;
    if (!userId) throw new HttpError(403, 'User context is missing.');

    // Reports the number of rows actually marked. The semantics are unchanged
    // and remain undecided (A-9.1): because nothing writes `user_id`, this
    // currently matches nothing and answers 0. That is the honest answer, and
    // it is now visible instead of being hidden behind a bare `{ ok: true }`.
    const result = stmtMarkAllUserNotificationsRead.run(userId);
    res.json({ ok: true, marked: result.changes });
  })
);

export default auditRouter;