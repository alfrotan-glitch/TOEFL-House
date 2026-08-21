/**
 * core/academic/attendance-query.ts
 * ============================================================================
 * Canonical read surface for student attendance facts (WP-06, D-94).
 *
 * Student attendance has exactly two authorities:
 *
 *   - session marks: `rosters` (attendance_status, attendance_weight,
 *     late_minutes, marked_at) joined to their `sessions` row; and
 *   - day-level marks: `attendance` rows with target_type = 'student'.
 *
 * Session marks are NEVER mirrored into `attendance` — the mirror is gone,
 * and every consumer that reports student attendance reads it through the
 * expressions exported here, so the two authorities cannot be recombined
 * differently by a second module.
 *
 * Teacher attendance lives only in `attendance` (target_type = 'teacher').
 * It is a staff record, not a student attendance fact, and is deliberately
 * absent from these expressions so it can never pollute student metrics.
 * ============================================================================
 */

/**
 * One row per student attendance fact: session marks (source `rosters` joined
 * to `sessions`) UNION ALL day-level student marks. A fact exists only when a
 * mark was actually recorded — `not_marked` roster placeholders are the
 * absence of a mark and are excluded. Columns:
 *
 *   date       ISO date of the fact
 *   target_id  student id
 *   status     attendance status (the full session vocabulary for session
 *              marks; the day-level vocabulary for day-level marks)
 *   class_id   class the fact belongs to (session class, or the day-level
 *              record's optional class)
 *   session_id session id for session marks, NULL for day-level marks
 *   branch_id  branch the fact belongs to
 *   teacher_id the session's assigned teacher for session marks, NULL for
 *              day-level marks
 *
 * Marks on a session that is later cancelled remain facts — a meeting that was
 * held and marked is history regardless of how its session row was closed, and
 * this preserves exactly the fact set the removed mirror exposed. Class
 * attendance analytics keep their own completed-sessions-only contract.
 *
 * The outer WHERE in a consumer applies to the compound result; SQLite pushes
 * qualifying predicates into each branch of the UNION ALL, so a date/branch
 * filter still uses idx_sessions_date / idx_rosters_student / the attendance
 * indexes.
 */
export const STUDENT_ATTENDANCE_UNION = `
  SELECT s.date AS date, r.student_id AS target_id, r.attendance_status AS status,
         s.class_id AS class_id, s.id AS session_id, s.branch_id AS branch_id,
         s.teacher_id AS teacher_id
  FROM rosters r JOIN sessions s ON s.id = r.session_id
  WHERE r.attendance_status != 'not_marked'
  UNION ALL
  SELECT a.date, a.target_id, a.status, a.class_id, NULL, a.branch_id, NULL
  FROM attendance a WHERE a.target_type = 'student'
`;

/**
 * The unified attendance-list surface: the student union above plus teacher
 * attendance rows, sharing one column shape and carrying each source row's id
 * so list consumers can key rows. `teacher_id` is the teacher's id for teacher
 * rows, the session's teacher for session rows, and NULL for day-level
 * student rows.
 */
export const ATTENDANCE_LIST_UNION = `
  SELECT r.id AS id, s.date AS date, r.student_id AS target_id, 'student' AS target_type,
         r.attendance_status AS status, s.class_id AS class_id,
         s.id AS session_id, s.branch_id AS branch_id, s.teacher_id AS teacher_id
  FROM rosters r JOIN sessions s ON s.id = r.session_id
  WHERE r.attendance_status != 'not_marked'
  UNION ALL
  SELECT id, date, target_id, target_type, status, class_id, NULL, branch_id, NULL
  FROM attendance
`;
