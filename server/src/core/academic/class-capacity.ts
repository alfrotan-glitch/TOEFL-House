/**
 * core/academic/class-capacity.ts
 * ============================================================================
 * The single authoritative rule for how many students currently occupy a
 * class's seats.
 *
 * Historical inconsistency: several code paths counted capacity from
 * `enrollments` (classes list/merge, EnrollmentService, students extra-enroll)
 * while the visitor-conversion and waitlist paths counted from
 * `student_semesters`. Those two tables can disagree (an enrollment can exist
 * without a semester row and vice versa), so the same class could be
 * simultaneously "full" and "open" depending on the entry point.
 *
 * Authority: a student occupies a seat iff they have an `enrollments` row in
 * status active/confirmed/pending for the class. `student_semesters` is a
 * derived attendance/gradebook projection — it is written by the enrollment
 * lifecycle (EnrollmentService) and never read for capacity.
 * ============================================================================
 */
import type Database from 'better-sqlite3';

export const ACTIVE_ENROLLMENT_STATUSES = ['active', 'confirmed', 'pending'] as const;

const COUNT_ACTIVE_IN_CLASS = `SELECT COUNT(DISTINCT student_id) AS c FROM enrollments WHERE class_id = ? AND status IN ('active','confirmed','pending')`;

export function countActiveStudentsInClass(db: Database.Database, classId: string): number {
  const row = db.prepare(COUNT_ACTIVE_IN_CLASS).get(classId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}
