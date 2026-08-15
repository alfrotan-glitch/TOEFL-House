-- Payroll correction capability without destructive deletion.
ALTER TABLE teacher_salary_ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','voided'));
ALTER TABLE teacher_salary_ledger ADD COLUMN voided_at TEXT;
ALTER TABLE teacher_salary_ledger ADD COLUMN voided_by TEXT;
ALTER TABLE teacher_salary_ledger ADD COLUMN void_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_teacher_salary_status ON teacher_salary_ledger(teacher_id, period_key, status);
