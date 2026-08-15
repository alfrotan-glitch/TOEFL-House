-- 047 — Finance account scoping and payment idempotency.
CREATE TABLE IF NOT EXISTS finance_accounts (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization','branch')),
  scope_id TEXT NOT NULL,
  main_balance REAL NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
  saving_balance REAL NOT NULL DEFAULT 0 CHECK (saving_balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_finance_accounts_scope ON finance_accounts(scope_type, scope_id);

INSERT OR IGNORE INTO finance_accounts (id, scope_type, scope_id, main_balance, saving_balance)
VALUES ('org:global', 'organization', 'global',
  COALESCE((SELECT CAST(value AS REAL) FROM system_settings WHERE key = 'main_account_balance'), 0),
  COALESCE((SELECT CAST(value AS REAL) FROM system_settings WHERE key = 'saving_balance'), 0));

INSERT OR IGNORE INTO finance_accounts (id, scope_type, scope_id)
SELECT 'branch:' || id, 'branch', id FROM branches;

ALTER TABLE payments ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency
ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_number_per_branch
ON invoices(branch_id, invoice_number) WHERE invoice_number IS NOT NULL;
