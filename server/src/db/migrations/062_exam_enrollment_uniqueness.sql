-- 062_exam_enrollment_uniqueness.sql
-- ---------------------------------------------------------------------------
-- Business-event uniqueness for exam enrolment.
--
-- POST /exams/:id/enroll guarded against duplicates with an application-level
-- SELECT ("is this candidate already enrolled?") followed by an INSERT. Under a
-- barrier-synchronised 30-way race it held, but only because better-sqlite3
-- serialises calls in a single process: the guard is a check-then-act with no
-- atomic backstop. A second server process, a connection pool, or any future
-- move off better-sqlite3 would let two requests pass the SELECT together and
-- book the exam fee twice.
--
-- The invariant is a genuine business rule: one candidate may hold at most one
-- enrolment per exam. Enforce it where it cannot be raced.
--
-- Two partial indexes rather than one composite, because a row carries EITHER
-- a student_id OR a visitor_id (the other is NULL), and SQLite treats NULLs as
-- distinct in a unique index — a single index over both columns would not
-- constrain anything.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_results_student
  ON exam_results(exam_id, student_id)
  WHERE student_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_results_visitor
  ON exam_results(exam_id, visitor_id)
  WHERE visitor_id IS NOT NULL;
