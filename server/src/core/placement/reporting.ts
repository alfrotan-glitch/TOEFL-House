/** Branch-scoped, parameterized placement activity reporting. */
import { db } from '../../db/connection.js';

export interface PlacementReportFilters {
  /** null is accepted only after the route resolves an authorized all-branch scope. */
  branchId: string | null;
  from: string | null;
  to: string | null;
  programVersionId: string | null;
}

export interface PlacementReportRow {
  programVersionId: string;
  programName: string;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  expired: number;
  averagePercentage: number | null;
}

export interface PlacementReport {
  filters: PlacementReportFilters;
  summary: {
    total: number;
    completed: number;
    passed: number;
    failed: number;
    expired: number;
    averagePercentage: number | null;
  };
  byProgram: PlacementReportRow[];
  activity: any[];
}

export function placementActivityReport(filters: PlacementReportFilters): PlacementReport {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.branchId) { clauses.push('a.branch_id = ?'); params.push(filters.branchId); }
  if (filters.from) { clauses.push('date(a.started_at) >= date(?)'); params.push(filters.from); }
  if (filters.to) { clauses.push('date(a.started_at) <= date(?)'); params.push(filters.to); }
  if (filters.programVersionId) { clauses.push('a.program_version_id = ?'); params.push(filters.programVersionId); }
  const where = clauses.length > 0 ? clauses.join(' AND ') : '1=1';

  const rows = db.prepare(`
    SELECT a.program_version_id AS programVersionId,
           p.name AS programName,
           COUNT(*) AS total,
           SUM(CASE WHEN a.status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN a.status='completed' AND a.outcome='passed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN a.status='completed' AND a.outcome='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN a.status='expired' THEN 1 ELSE 0 END) AS expired,
           AVG(CASE WHEN a.status='completed' THEN a.percentage END) AS averagePercentage
    FROM placement_assessment_attempts a
    JOIN program_versions pv ON pv.id = a.program_version_id
    JOIN programs p ON p.id = pv.program_id
    WHERE ${where}
    GROUP BY a.program_version_id, p.name
    ORDER BY p.name
  `).all(...params) as any[];

  const activity = db.prepare(`
    SELECT a.id, a.visitor_id, v.full_name AS visitor_name, a.program_version_id,
           p.name AS program_name, a.attempt_number, a.status, a.outcome,
           a.percentage, a.started_at, a.completed_at
    FROM placement_assessment_attempts a
    JOIN visitors v ON v.id = a.visitor_id
    JOIN program_versions pv ON pv.id = a.program_version_id
    JOIN programs p ON p.id = pv.program_id
    WHERE ${where}
    ORDER BY a.started_at DESC, a.id DESC
    LIMIT 500
  `).all(...params) as any[];

  const byProgram: PlacementReportRow[] = rows.map((row) => ({
    programVersionId: String(row.programVersionId),
    programName: String(row.programName),
    total: Number(row.total),
    completed: Number(row.completed),
    passed: Number(row.passed),
    failed: Number(row.failed),
    expired: Number(row.expired),
    averagePercentage: row.averagePercentage == null ? null : Math.round(Number(row.averagePercentage) * 100) / 100,
  }));
  const weightedAverageNumerator = rows.reduce((sum, row) => sum + Number(row.averagePercentage ?? 0) * Number(row.completed), 0);
  const completed = byProgram.reduce((sum, row) => sum + row.completed, 0);
  return {
    filters,
    summary: {
      total: byProgram.reduce((sum, row) => sum + row.total, 0),
      completed,
      passed: byProgram.reduce((sum, row) => sum + row.passed, 0),
      failed: byProgram.reduce((sum, row) => sum + row.failed, 0),
      expired: byProgram.reduce((sum, row) => sum + row.expired, 0),
      averagePercentage: completed > 0 ? Math.round((weightedAverageNumerator / completed) * 100) / 100 : null,
    },
    byProgram,
    activity,
  };
}
