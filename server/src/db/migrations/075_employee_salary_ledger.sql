-- 075_employee_salary_ledger.sql
-- ---------------------------------------------------------------------------
-- Employee payroll integrity (teacher audit T-1).
--
-- THE DEFECT (reproduced live on a fresh database)
-- `POST /api/employees/:id/pay-salary` had no idempotency of any kind:
--     3 sequential identical partials  -> 3 payments, 3,000 AFN
--     6 concurrent identical partials  -> 6 payments, 6,000 AFN, budget -6,000
--     the same Idempotency-Key twice   -> 2 payments (header ignored entirely)
-- Each attempt wrote a raw `financial_transactions` expense row and debited the
-- branch budget. A double-click, a refresh, a second tab or a network retry
-- therefore paid a real salary again.
--
-- WHY THE EXISTING GUARD DID NOT PREVENT IT
-- The only guard was, for `payment_type = 'full'` alone:
--     SELECT id FROM financial_transactions
--      WHERE reference_id = ? AND category = 'salary'
--        AND description LIKE '%full salary%<monthName>%'
-- It matched on a GENERATED DESCRIPTION STRING, covered neither `partial` nor
-- `advance`, and is a check-then-act that concurrent requests all pass
-- together. It is replaced by a real key with a database-enforced index.
--
-- WHY A NEW TABLE RATHER THAN REUSING teacher_salary_ledger
-- `teacher_salary_ledger.teacher_id` is `NOT NULL REFERENCES teachers(id)`.
-- An employee id is not a teacher id, so an employee row is not merely
-- undesirable there, it is impossible without dropping that foreign key — and
-- the teacher payroll engine (core/payroll/class-payroll.ts sumPaidForPeriod /
-- hasFullPayForPeriod) SUMs that table to decide what a TEACHER is still owed.
-- Injecting employee rows would silently corrupt teacher payroll arithmetic.
-- This table therefore mirrors the proven teacher shape for the employee
-- domain instead of overloading it. Same columns, same semantics, same
-- idempotency contract — one established pattern, two disjoint populations.
--
-- WHAT THIS DOES NOT DO
-- It deliberately introduces NO cap semantics. Whether an employee's cumulative
-- payments for a period may exceed base_salary, and how advances interact with
-- that, is a business rule with no precedent anywhere in this codebase, its
-- tests or its data. Inventing one here could refuse a legitimate payment, so
-- the audit records it as an open business decision instead. This migration
-- closes ONLY the duplicate-payment defect and restores the canonical trail.
--
-- HISTORICAL DATA
-- Creates a new, initially empty table. It reads, rewrites and deletes nothing;
-- existing employee salary expenses in `financial_transactions` are untouched
-- and remain exactly as recorded.

CREATE TABLE IF NOT EXISTS employee_salary_ledger (
  id              TEXT PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_key      TEXT NOT NULL,
  period_label    TEXT NOT NULL,
  paid_amount     REAL NOT NULL DEFAULT 0,
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('full','partial','advance')),
  transaction_id  TEXT,
  notes           TEXT,
  branch_id       TEXT NOT NULL,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
  operator_name   TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','voided')),
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT
);

-- THE RACE ARBITER. The service-layer replay check is a fast path; under true
-- concurrency several requests pass it simultaneously and exactly one may win
-- this index. Mirrors uq_teacher_salary_idempotency (migration 044).
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_idempotency
  ON employee_salary_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Replaces the description-LIKE duplicate guard for full payments with a real
-- constraint. Voided rows are excluded so a corrected payment can be re-made,
-- exactly as migration 066 established for teachers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_full_period
  ON employee_salary_ledger(employee_id, period_key)
  WHERE payment_type = 'full' AND status = 'posted';

CREATE INDEX IF NOT EXISTS idx_employee_salary_period
  ON employee_salary_ledger(employee_id, period_key, paid_at);

CREATE INDEX IF NOT EXISTS idx_employee_salary_branch_period
  ON employee_salary_ledger(branch_id, period_key, paid_at);
