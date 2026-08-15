-- ============================================================================
-- 003 — Operational Expenses (قبض، خرید، تعمیرات، پرداخت مستقیم)
-- ============================================================================
-- Extends expense_requests with operational metadata and seeds missing
-- budget lines common to Afghan language institutes (water, gas,
-- maintenance, purchases, cleaning, transport, miscellaneous).
-- ============================================================================

-- Metadata on expense requests
ALTER TABLE expense_requests ADD COLUMN expense_kind TEXT DEFAULT 'other';
ALTER TABLE expense_requests ADD COLUMN bill_period TEXT;
ALTER TABLE expense_requests ADD COLUMN payment_method TEXT DEFAULT 'cash';
ALTER TABLE expense_requests ADD COLUMN notes TEXT;
ALTER TABLE expense_requests ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0;

-- Seed missing operational budget lines for every existing branch
-- (INSERT OR IGNORE keeps this idempotent on re-run via PK)
INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b11_' || id, 'Water', 0, 0, 'Droplets', 'fixed', 0, 'water', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b12_' || id, 'Gas', 0, 0, 'Flame', 'fixed', 0, 'gas', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b13_' || id, 'Maintenance & Repairs', 0, 0, 'Wrench', 'variable', 0, 'maintenance', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b14_' || id, 'General Purchases', 0, 0, 'ShoppingCart', 'variable', 0, 'purchases', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b15_' || id, 'Cleaning & Hygiene', 0, 0, 'Sparkles', 'fixed', 0, 'cleaning', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b16_' || id, 'Transport', 0, 0, 'Car', 'variable', 0, 'transport', id FROM branches;

INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
SELECT 'b17_' || id, 'Miscellaneous', 0, 0, 'MoreHorizontal', 'variable', 0, 'misc', id FROM branches;

-- Default auto-approve threshold for operational expenses (AFN)
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('expense_auto_approve_threshold', '5000');
