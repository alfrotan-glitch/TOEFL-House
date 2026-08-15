-- ============================================================================
-- 004 — Invoices support + ensure financial settings default to 0 (no fake balances)
-- ============================================================================

-- Configurable invoice due window (days after issue)
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('invoice_due_days', '30');

-- If balances were never set, start at zero (do NOT invent demo numbers in code)
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('main_account_balance', '0');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('saving_balance', '0');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('daily_saving_percent', '5');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('expense_auto_approve_threshold', '5000');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('placement_test_fee', '0');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('diploma_fee', '0');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('card_issuance_fee', '0');

-- Optional notes / invoice number on invoices
-- SQLite ADD COLUMN is safe with IF NOT EXISTS via migration runner duplicate handling
ALTER TABLE invoices ADD COLUMN notes TEXT;
ALTER TABLE invoices ADD COLUMN invoice_number TEXT;
ALTER TABLE invoices ADD COLUMN issued_by TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch ON invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
