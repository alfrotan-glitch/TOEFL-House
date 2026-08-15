-- 049 — Runtime integrity hardening: branch invariants, audit failure capture, stock guard.
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_integrity_insert
BEFORE INSERT ON enrollments
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
   OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Enrollment branch does not match student/class branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_integrity_update
BEFORE UPDATE OF student_id, class_id, branch_id ON enrollments
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
   OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Enrollment branch does not match student/class branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_integrity_insert
BEFORE INSERT ON invoices
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Invoice branch does not match student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_integrity_update
BEFORE UPDATE OF student_id, branch_id ON invoices
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Invoice branch does not match student branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_insert
BEFORE INSERT ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
  OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Payment branch does not match related resource branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_update
BEFORE UPDATE OF student_id, invoice_id, book_id, branch_id ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
  OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Payment branch does not match related resource branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_integrity_insert
BEFORE INSERT ON book_sales
WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Book sale branch does not match book/student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_integrity_update
BEFORE UPDATE OF book_id, student_id, branch_id ON book_sales
WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Book sale branch does not match book/student branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_exam_results_branch_integrity_insert
BEFORE INSERT ON exam_results
WHEN (SELECT branch_id FROM exams WHERE id = NEW.exam_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
   OR (NEW.visitor_id IS NOT NULL AND (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Exam result branch does not match candidate/exam branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_exam_results_branch_integrity_update
BEFORE UPDATE OF exam_id, student_id, visitor_id, branch_id ON exam_results
WHEN (SELECT branch_id FROM exams WHERE id = NEW.exam_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
   OR (NEW.visitor_id IS NOT NULL AND (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Exam result branch does not match candidate/exam branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_branch_integrity_insert
BEFORE INSERT ON scholarship_awards
WHEN (SELECT branch_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT NEW.branch_id
   OR (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Scholarship award branch does not match scholarship/student branch'); END;

CREATE TABLE IF NOT EXISTS audit_failures (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  request_id TEXT,
  operator_id TEXT,
  branch_id TEXT,
  action TEXT NOT NULL,
  error TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_failures_time ON audit_failures(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_failures_branch ON audit_failures(branch_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_books_stock_nonnegative_insert
BEFORE INSERT ON books
WHEN NEW.stock < 0
BEGIN SELECT RAISE(ABORT, 'Book stock cannot be negative'); END;

CREATE TRIGGER IF NOT EXISTS trg_books_stock_nonnegative_update
BEFORE UPDATE OF stock ON books
WHEN NEW.stock < 0
BEGIN SELECT RAISE(ABORT, 'Book stock cannot be negative'); END;
