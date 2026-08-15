-- High-assurance security/integrity hardening.
UPDATE users SET role = 'manager' WHERE role = 'staff';
UPDATE users SET role = 'donor_manager' WHERE role = 'partner';
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1);
CREATE INDEX IF NOT EXISTS idx_users_session_version ON users(id, session_version);
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_guard BEFORE INSERT ON enrollments WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NULL OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'enrollment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_guard_update BEFORE UPDATE OF student_id, class_id, branch_id ON enrollments WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NULL OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'enrollment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_guard BEFORE INSERT ON invoices WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'invoice branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_guard_update BEFORE UPDATE OF student_id, branch_id ON invoices WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'invoice branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_guard BEFORE INSERT ON payments WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.branch_id) OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'payment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_guard_update BEFORE UPDATE OF student_id, invoice_id, book_id, branch_id ON payments WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.branch_id) OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'payment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_guard BEFORE INSERT ON book_sales WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'book sale branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_guard_update BEFORE UPDATE OF book_id, student_id, branch_id ON book_sales WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'book sale branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_branch_guard BEFORE INSERT ON class_waitlist WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'waitlist branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_branch_guard_update BEFORE UPDATE OF class_id, student_id, branch_id ON class_waitlist WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'waitlist branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_student BEFORE INSERT ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND student_id = NEW.student_id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'student already has an active waitlist entry'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_student_update BEFORE UPDATE OF class_id, student_id, status ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND student_id = NEW.student_id AND id <> NEW.id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'student already has an active waitlist entry'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_position BEFORE INSERT ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND position = NEW.position AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'waitlist position already exists'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_position_update BEFORE UPDATE OF class_id, position, status ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND position = NEW.position AND id <> NEW.id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'waitlist position already exists'); END;
CREATE TRIGGER IF NOT EXISTS trg_workflow_entity_branch_update BEFORE UPDATE OF branch_id ON workflow_instances WHEN NEW.branch_id <> OLD.branch_id BEGIN SELECT RAISE(ABORT, 'workflow branch is immutable'); END;
CREATE INDEX IF NOT EXISTS idx_workflow_instances_branch_status ON workflow_instances(branch_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_workflow_history_instance_time ON workflow_history(instance_id, timestamp);


-- Exactly one primary identity role per user; secondary roles remain unrestricted.
CREATE TRIGGER IF NOT EXISTS trg_user_roles_single_primary_insert
BEFORE INSERT ON user_roles
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND is_primary = 1)
BEGIN
  SELECT RAISE(ABORT, 'user may have only one primary role');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_roles_single_primary_update
BEFORE UPDATE OF is_primary, user_id ON user_roles
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND is_primary = 1 AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'user may have only one primary role');
END;

-- Monetary values in the legacy REAL schema are restricted to two decimal places.
CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_insert
BEFORE INSERT ON payments
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'payment amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_update
BEFORE UPDATE OF amount ON payments
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'payment amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_insert
BEFORE INSERT ON financial_transactions
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_update
BEFORE UPDATE OF amount ON financial_transactions
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_money_scale_insert
BEFORE INSERT ON invoices
WHEN ABS(NEW.total_amount - ROUND(NEW.total_amount, 2)) > 0.0000001
  OR ABS(NEW.discount_amount - ROUND(NEW.discount_amount, 2)) > 0.0000001
  OR ABS(NEW.net_amount - ROUND(NEW.net_amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'invoice monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_items_money_scale_insert
BEFORE INSERT ON invoice_items
WHEN ABS(NEW.unit_price - ROUND(NEW.unit_price, 2)) > 0.0000001
  OR ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'invoice item monetary values must have at most two decimal places'); END;


CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_insert
BEFORE INSERT ON book_sales
WHEN ABS(NEW.total_amount - ROUND(NEW.total_amount, 2)) > 0.0000001
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_update
BEFORE UPDATE OF total_amount, discount_amount, net_amount ON book_sales
WHEN ABS(NEW.total_amount - ROUND(NEW.total_amount, 2)) > 0.0000001
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_expense_request_money_scale_insert
BEFORE INSERT ON expense_requests
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'expense amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_insert
BEFORE INSERT ON finance_accounts
WHEN ABS(NEW.main_balance - ROUND(NEW.main_balance, 2)) > 0.0000001
  OR ABS(NEW.saving_balance - ROUND(NEW.saving_balance, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'finance account balances must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_update
BEFORE UPDATE OF main_balance, saving_balance ON finance_accounts
WHEN ABS(NEW.main_balance - ROUND(NEW.main_balance, 2)) > 0.0000001
  OR ABS(NEW.saving_balance - ROUND(NEW.saving_balance, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'finance account balances must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_teacher_salary_money_scale_insert
BEFORE INSERT ON teacher_salary_ledger
WHEN ABS(NEW.due_amount - ROUND(NEW.due_amount, 2)) > 0.0000001
  OR ABS(NEW.paid_amount - ROUND(NEW.paid_amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'teacher salary monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_donations_money_scale_insert
BEFORE INSERT ON donations
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'donation amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_money_scale_insert
BEFORE INSERT ON scholarship_awards
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'scholarship amount must have at most two decimal places'); END;
