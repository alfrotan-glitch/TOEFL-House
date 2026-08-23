import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, canAccessBranchResource, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { eventBus } from '../core/events/event-bus.js';
import { isUniqueViolation, resolveIdempotency } from '../utils/idempotency.js';
import {
  deriveImpactSnapshot,
  persistImpactSnapshot,
  type ImpactScopeKind,
} from '../core/impact/impact-reporting-service.js';

export const impactRouter = Router();
impactRouter.use(authenticate);

function userContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user.branchId || !user.fullName) {
    throw new HttpError(403, 'User context is missing for this impact operation.');
  }
  return { userId: user.userId, branchId: user.branchId, fullName: user.fullName };
}

function reportBranch(req: import('express').Request, body: Record<string, unknown>): string {
  const user = userContext(req);
  const branchId = typeof body.branchId === 'string' && body.branchId.trim() ? body.branchId.trim() : user.branchId;
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'You are not authorized for the selected branch.');
  return branchId;
}

function parseScope(body: Record<string, unknown>): { kind: ImpactScopeKind; id: string | null } {
  const kind = body.scopeKind === undefined ? 'branch' : body.scopeKind;
  if (kind !== 'branch' && kind !== 'donor' && kind !== 'campaign') {
    throw new HttpError(400, 'scopeKind must be branch, donor, or campaign.');
  }
  const suppliedId = body.scopeId;
  if (kind === 'branch') {
    if (suppliedId !== undefined && suppliedId !== null && suppliedId !== '') {
      throw new HttpError(400, 'A branch impact report cannot name scopeId.');
    }
    return { kind, id: null };
  }
  if (typeof suppliedId !== 'string' || !suppliedId.trim()) {
    throw new HttpError(400, 'A donor or campaign impact report requires scopeId.');
  }
  return { kind, id: suppliedId.trim() };
}

function mapReport(row: Record<string, unknown>) {
  let metrics: unknown[] = [];
  try {
    const parsed = JSON.parse(String(row.metrics ?? '[]'));
    if (Array.isArray(parsed)) metrics = parsed;
  } catch {
    throw new HttpError(500, 'Stored impact report snapshot is malformed.');
  }
  const scopeKind = String(row.scope_kind) as ImpactScopeKind;
  return {
    id: row.id,
    title: row.title,
    scopeKind,
    scopeId: scopeKind === 'donor' ? row.donor_id : scopeKind === 'campaign' ? row.campaign_id : null,
    period: row.period_key,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    generatedAt: row.generated_at,
    generatedBy: row.generated_by,
    narrative: row.narrative,
    branchId: row.branch_id,
    metrics,
  };
}

impactRouter.get('/reports', requirePermission('Impact.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const rows = (isAll
    ? db.prepare('SELECT * FROM impact_reports ORDER BY generated_at DESC, id DESC').all()
    : db.prepare('SELECT * FROM impact_reports WHERE branch_id = ? ORDER BY generated_at DESC, id DESC').all(branchId)) as Array<Record<string, unknown>>;
  res.json(rows.map(mapReport));
}));

impactRouter.post('/reports/generate', requirePermission('Impact.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = userContext(req);
  const branchId = reportBranch(req, body);
  const period = typeof body.period === 'string' ? body.period.trim() : '';
  if (!period) throw new HttpError(400, 'Impact report period is required.');
  const scope = parseScope(body);

  const { candidates } = resolveIdempotency(req, {
    route: 'impact-report', branchId, period, scopeKind: scope.kind, scopeId: scope.id, actorUserId: user.userId,
  });
  const findPrior = () => db.prepare(
    `SELECT * FROM impact_reports WHERE idempotency_key IN (${candidates.map(() => '?').join(',')}) LIMIT 1`,
  ).get(...candidates) as Record<string, unknown> | undefined;
  const prior = findPrior();
  if (prior) {
    if (prior.branch_id !== branchId || prior.period_key !== period || prior.scope_kind !== scope.kind
      || (scope.kind === 'donor' && prior.donor_id !== scope.id)
      || (scope.kind === 'campaign' && prior.campaign_id !== scope.id)) {
      throw new HttpError(409, 'This idempotency key belongs to a different impact report.');
    }
    return res.status(200).json({ ...mapReport(prior), idempotentReplay: true });
  }

  let report: ReturnType<typeof persistImpactSnapshot>;
  let event: ReturnType<typeof eventBus.emit> | undefined;
  try {
    db.transaction(() => {
      const snapshot = deriveImpactSnapshot(db, { scopeKind: scope.kind, scopeId: scope.id, branchId, period });
      report = persistImpactSnapshot(db, snapshot, user.userId, candidates[0]);
      event = eventBus.emit(
        'impact.report_generated',
        'impact',
        report.id,
        { period: report.period, scopeKind: report.scopeKind, scopeId: report.scopeId, metricsCount: report.metrics.length },
        { operatorId: user.userId, branchId },
      );
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = findPrior();
      if (winner) return res.status(200).json({ ...mapReport(winner), idempotentReplay: true });
    }
    throw error;
  }
  if (event) void eventBus.dispatch(event);
  writeAudit(req, `Generated impact report ${report!.id}`, {
    branchId,
    newValue: JSON.stringify({ period: report!.period, scopeKind: report!.scopeKind, scopeId: report!.scopeId }),
  });
  res.status(201).json(report!);
}));

impactRouter.get('/summary', requirePermission('Impact.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const reportCountRow = (isAll
    ? db.prepare('SELECT COUNT(*) AS value FROM impact_reports').get()
    : db.prepare('SELECT COUNT(*) AS value FROM impact_reports WHERE branch_id = ?').get(branchId)) as { value: number };
  const reports = Number(reportCountRow.value) || 0;
  res.json({ reports });
}));

export default impactRouter;
