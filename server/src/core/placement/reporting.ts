/**
 * Placement Reporting — operational placement activity, actual-activity-only.
 * Rows come exclusively from real placement events (attempts, visitors whose
 * placement status changed in the period, exemptions/overrides). No
 * zero-value rows are synthesized.
 */
import { db } from '../../db/connection.js';

export interface PlacementReportFilters {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  branchId?: string | null;
}

export function placementActivityReport(f: PlacementReportFilters) {
  const from = `${f.from} 00:00:00`;
  const to = `${f.to} 23:59:59`;
  const branchClause = f.branchId ? 'AND branch_id = ?' : '';
  const branchArg: unknown[] = f.branchId ? [f.branchId] : [];

  // Attempts actually started in the period, by final status.
  const byAttemptStatus = (db.prepare(`
    SELECT status, COUNT(*) AS c,
           ROUND(AVG(CASE WHEN status='completed' THEN percentage END),1) AS avg_pct
    FROM placement_assessment_attempts
    WHERE started_at >= ? AND started_at <= ? ${branchClause}
    GROUP BY status
  `).all(from, to, ...branchArg) as Array<{ status: string; c: number; avg_pct: number | null }>);

  // Visitors whose placement status transitioned in the period (completed/exempt/expired...).
  const byVisitorStatus = (db.prepare(`
    SELECT placement_status AS status, placement_requirement_mode AS mode, COUNT(*) AS c
    FROM visitors
    WHERE placement_status_at >= ? AND placement_status_at <= ? ${branchClause}
    GROUP BY placement_status, placement_requirement_mode
  `).all(from, to, ...branchArg) as Array<{ status: string; mode: string | null; c: number }>);

  // Requirement-mode distribution among visitors active in the period.
  const byRequirementMode = (db.prepare(`
    SELECT COALESCE(placement_requirement_mode, 'unknown') AS mode, COUNT(*) AS c
    FROM visitors
    WHERE visit_date >= ? AND visit_date <= ? ${branchClause}
    GROUP BY mode
  `).all(f.from, f.to, ...branchArg) as Array<{ mode: string; c: number }>);

  // Completed attempts broken down by program / level / gender / branch.
  const byProgramLevel = (db.prepare(`
    SELECT p.name AS program, pv.version_label AS version, COALESCE(l.code,'Unassigned') AS level_code, v.gender AS gender, a.branch_id AS branch_id, COUNT(*) AS c, ROUND(AVG(a.percentage),1) AS avg_pct
    FROM placement_assessment_attempts a
    JOIN program_versions pv ON pv.id = a.program_version_id
    JOIN programs p ON p.id = pv.program_id
    JOIN visitors v ON v.id = a.visitor_id
    LEFT JOIN levels l ON l.id = a.recommended_level_id
    WHERE a.status='completed' AND a.started_at >= ? AND a.started_at <= ? ${branchClause}
    GROUP BY p.id, pv.id, l.id, v.gender, a.branch_id
  `).all(from, to, ...branchArg) as Array<{ program: string; version: string; level_code: string; gender: string; branch_id: string; c: number; avg_pct: number | null }>);

  // Content components: per-skill / per-test / per-test-version scoring.
  const bySkillTest = (db.prepare(`
    SELECT r.component_type AS component_type, r.component_key AS component_key,
           COALESCE(t.title, r.label) AS test_title, COALESCE(t.version, 0) AS test_version,
           COUNT(*) AS c, ROUND(AVG(r.score),1) AS avg_score
    FROM placement_assessment_results r
    JOIN placement_assessment_attempts a ON a.id = r.attempt_id
    LEFT JOIN placement_tests t ON t.id = JSON_EXTRACT(r.payload_json, '$.testId')
    WHERE r.status='completed' AND a.started_at >= ? AND a.started_at <= ? ${branchClause}
    GROUP BY r.component_type, r.component_key, t.id, t.version
  `).all(from, to, ...branchArg) as Array<{ component_type: string; component_key: string; test_title: string; test_version: number; c: number; avg_score: number | null }>);

  // Audited placement mutations in the period (policy/content/override/exemption).
  const auditEvents = (db.prepare(`
    SELECT action, COUNT(*) AS c FROM audit_logs
    WHERE date >= ? AND date <= ?
      AND (action LIKE '%placement%' OR action LIKE '%Placement%' OR action LIKE '%test-bank%')
    GROUP BY action ORDER BY c DESC
  `).all(f.from, f.to) as Array<{ action: string; c: number }>);

  return {
    period: { from: f.from, to: f.to, branchId: f.branchId ?? null },
    byAttemptStatus,
    byVisitorStatus,
    byRequirementMode,
    byProgramLevel,
    bySkillTest,
    auditEvents,
  };
}
