-- 039 — Operational integrity hardening
-- Prevent duplicate invoice numbers within a branch while allowing draft invoices without a number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_branch_invoice_number
  ON invoices(branch_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Fast lookup for overdue follow-ups and daily work queues.
CREATE INDEX IF NOT EXISTS idx_visitors_branch_next_contact
  ON visitors(branch_id, next_contact_date, stage);

CREATE INDEX IF NOT EXISTS idx_invoices_branch_due_status
  ON invoices(branch_id, due_date, status);

CREATE INDEX IF NOT EXISTS idx_enrollments_student_status
  ON enrollments(student_id, status);
