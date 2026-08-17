/**
 * Dashboard Summary Router — the authoritative KPI endpoint.
 *
 * One endpoint, one source of truth. The frontend renders these numbers and
 * derives none of them. See core/dashboard/dashboard-summary.ts for why
 * (audit findings D-1…D-5: metrics were counted from paginated pages, and the
 * client computed its own "today" in UTC while the server used local time).
 *
 * Scope is resolved with `resolveBranchScope`, the established convention: it
 * silently re-scopes a foreign `?branchId=` to the caller's own branch and only
 * grants organization-wide scope to a role that genuinely holds it. RBAC is
 * unchanged — `Dashboard.View` is the permission every dashboard-viewing role
 * already carries.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { ah } from '../middleware/errorHandler.js';
import { buildDashboardSummary } from '../core/dashboard/dashboard-summary.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/summary',
  requirePermission('Dashboard.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 7;
    res.json(buildDashboardSummary(db, { branchId, isAll }, { days }));
  })
);

export default dashboardRouter;
