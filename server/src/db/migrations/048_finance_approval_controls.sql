-- 048 — Finance approval controls: requester/approver identity and separation of duties.
ALTER TABLE expense_requests ADD COLUMN requester_user_id TEXT;
ALTER TABLE expense_requests ADD COLUMN approved_by_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_expense_req_requester_user ON expense_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_expense_req_approver_user ON expense_requests(approved_by_user_id);
