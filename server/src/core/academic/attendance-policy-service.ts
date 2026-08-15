/**
 * core/academic/attendance-policy-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 2: Smart Attendance Engine (policy layer).
 *
 * Per ADR AM-08 (Phase 1 report): the Academic Policy Engine is not new
 * infrastructure — it's a thin, typed wrapper over the existing Rule Engine
 * (core/configuration/rule-engine.ts), which already supports an
 * 'attendance' category with branch scoping, versioning, and rollback.
 * A policy is just an unconditional 'attendance' rule with a `set_value`
 * action (see DEFAULT_POLICY below for the shape branches start with).
 *
 * This keeps every number here genuinely configurable per branch without
 * a code change — exactly the blueprint's "no academic rule should be
 * hardcoded" requirement — while still giving sane behavior out of the box
 * via the DEFAULT_POLICY fallback when no rule has been configured yet.
 * ============================================================================
 */
import type Database from 'better-sqlite3';
import { evaluateRules } from '../configuration/rule-engine.js';
import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';
import type { AttendanceStatus } from './lifecycle-engine.js';

export interface AttendancePolicy {
  /** Minutes after session start before a 'present' mark should become 'late'. */
  lateThresholdMinutes: number;
  /** Minutes late beyond which a 'late' mark is only worth half attendance credit. */
  halfAbsenceThresholdMinutes: number;
  /** Minimum attendance percentage typically required for promotion eligibility (read by the future Promotion Engine phase; exposed here since it's an attendance-owned number). */
  minAttendancePercentage: number;
  /** Consecutive fully-absent sessions (weight 0) that trigger an automatic enrollment drop. */
  maxConsecutiveAbsences: number;
}

/** Sane out-of-the-box defaults. Any branch can override any of these by
 *  configuring an 'attendance' category rule (see rules.routes.ts) with a
 *  set_value action targeting the matching key — no code change needed. */
const DEFAULT_POLICY: AttendancePolicy = {
  lateThresholdMinutes: ACADEMIC_DEFAULTS.lateThresholdMinutes,
  halfAbsenceThresholdMinutes: ACADEMIC_DEFAULTS.halfAbsenceThresholdMinutes,
  minAttendancePercentage: ACADEMIC_DEFAULTS.defaultMinAttendance,
  maxConsecutiveAbsences: ACADEMIC_DEFAULTS.maxConsecutiveAbsences,
};

export interface PolicyScope {
  programId?: string | null;
  levelId?: string | null;
  classId?: string | null;
}

export function getAttendancePolicy(branchId: string, scope?: PolicyScope): AttendancePolicy {
  const result = evaluateRules({ category: 'attendance', branchId, data: { ...scope } });
  const out = result.finalOutputs;
  return {
    lateThresholdMinutes: typeof out.lateThresholdMinutes === 'number' ? out.lateThresholdMinutes : DEFAULT_POLICY.lateThresholdMinutes,
    halfAbsenceThresholdMinutes: typeof out.halfAbsenceThresholdMinutes === 'number' ? out.halfAbsenceThresholdMinutes : DEFAULT_POLICY.halfAbsenceThresholdMinutes,
    minAttendancePercentage: typeof out.minAttendancePercentage === 'number' ? out.minAttendancePercentage : DEFAULT_POLICY.minAttendancePercentage,
    maxConsecutiveAbsences: typeof out.maxConsecutiveAbsences === 'number' ? out.maxConsecutiveAbsences : DEFAULT_POLICY.maxConsecutiveAbsences,
  };
}

/** Attendance-equivalent statuses that should count toward "attended" for
 *  rate calculations — the person was present in some form. Kept as one
 *  named export so every place that computes an attendance rate (session
 *  analytics, donor impact reporting) applies the identical definition. */
export const ATTENDED_EQUIVALENT_STATUSES: readonly AttendanceStatus[] = [
  'present', 'late', 'leave', 'online', 'hybrid', 'left_early',
];

/**
 * Credit weight (0, 0.5, or 1) this attendance mark is worth, applying the
 * half-absence rule: arriving late beyond halfAbsenceThresholdMinutes only
 * earns half credit even though the student did eventually attend.
 */
export function computeAttendanceWeight(status: AttendanceStatus, lateMinutes: number | null | undefined, policy: AttendancePolicy): 0 | 0.5 | 1 {
  if (!ATTENDED_EQUIVALENT_STATUSES.includes(status)) return 0; // absent, excused, medical_leave, sick, not_marked
  if (status === 'late' && typeof lateMinutes === 'number' && lateMinutes >= policy.halfAbsenceThresholdMinutes) return 0.5;
  return 1;
}

/** Auto-classifies an arrival as 'present' or 'late' from raw minutes-late
 *  input, per the configured late threshold. Callers that already know the
 *  status (most UIs) don't need this — it's for integrations that only
 *  capture a clock-in time. */
export function classifyArrival(lateMinutes: number, policy: AttendancePolicy): 'present' | 'late' {
  return lateMinutes >= policy.lateThresholdMinutes ? 'late' : 'present';
}

export interface ConsecutiveAbsenceCheck {
  consecutiveAbsences: number;
  threshold: number;
  shouldAutoDrop: boolean;
}

/**
 * Walks a student's most recent marked sessions for a class, most-recent
 * first, counting a leading streak of zero-weight marks (absent — not
 * excused/medical_leave, which are deliberately NOT absence-streak
 * material: an excused or medically-documented absence should never by
 * itself trigger an automatic drop). Stops at the first non-zero-weight or
 * not_marked entry.
 */
export function checkConsecutiveAbsences(db: Database.Database, studentId: string, classId: string, policy: AttendancePolicy): ConsecutiveAbsenceCheck {
  const rows = db
    .prepare(
      `SELECT r.attendance_status, r.attendance_weight
       FROM rosters r
       JOIN sessions s ON s.id = r.session_id
       WHERE r.student_id = ? AND s.class_id = ? AND r.attendance_status != 'not_marked'
       ORDER BY s.date DESC, s.start_time DESC
       LIMIT 20`,
    )
    .all(studentId, classId) as { attendance_status: AttendanceStatus; attendance_weight: number | null }[];

  let streak = 0;
  for (const row of rows) {
    // Only a hard, unexcused 'absent' extends the streak — excused and
    // medical_leave marks correctly interrupt it (per blueprint intent),
    // and so does anything with partial/full credit.
    if (row.attendance_status === 'absent') {
      streak += 1;
    } else {
      break;
    }
  }

  return { consecutiveAbsences: streak, threshold: policy.maxConsecutiveAbsences, shouldAutoDrop: streak >= policy.maxConsecutiveAbsences };
}
