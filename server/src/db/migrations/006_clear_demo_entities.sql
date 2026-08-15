-- Clear demo CRM / academic / funding rows so the app starts from real data only.
-- Identity (users, branches, partners) and budget catalog are kept.

DELETE FROM scholarship_awards;
DELETE FROM sponsorship_agreements;
DELETE FROM scholarships;
DELETE FROM donations;
DELETE FROM funding_campaigns;
DELETE FROM donors;
DELETE FROM impact_reports;
DELETE FROM impact_metrics;
DELETE FROM exam_results;
DELETE FROM exams;
DELETE FROM attendance;
DELETE FROM sessions;
DELETE FROM class_teacher_skills;
DELETE FROM student_semesters;
DELETE FROM payments WHERE id LIKE 'pay%' OR student_id IN (SELECT id FROM students);
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM students;
DELETE FROM visitors;
DELETE FROM classes;
DELETE FROM book_sales;
DELETE FROM books;
DELETE FROM pipeline_metrics;
DELETE FROM notifications;
DELETE FROM audit_logs;
DELETE FROM financial_transactions;
DELETE FROM expense_requests;

UPDATE budget_lines SET current_amount = 0, allocated_amount = 0;
UPDATE system_settings SET value = '0' WHERE key IN ('main_account_balance', 'saving_balance');
