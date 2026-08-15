-- Teacher grand audit hardening: deterministic payroll basis, assignment integrity,
-- and operational indexes. Existing data is preserved.
CREATE INDEX IF NOT EXISTS idx_teacher_compensation_effective
ON teacher_compensation_history(teacher_id, effective_from, created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_evaluations_period
ON teacher_evaluations(teacher_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_branch_history_effective
ON teacher_branch_history(teacher_id, effective_date, created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_overlap
ON class_teacher_skills(teacher_id, class_id, start_date, end_date, assignment_type);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_period
ON sessions(teacher_id, date, status, branch_id);
