-- Teacher release hardening: payment idempotency, linked-account deactivation, and historical payroll indexes.
ALTER TABLE teacher_salary_ledger ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_idempotency
ON teacher_salary_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teacher_salary_due
ON teacher_salary_ledger(teacher_id, period_key, paid_at);
CREATE INDEX IF NOT EXISTS idx_teacher_history_branch
ON teacher_branch_history(teacher_id, effective_date, from_branch_id, to_branch_id);
