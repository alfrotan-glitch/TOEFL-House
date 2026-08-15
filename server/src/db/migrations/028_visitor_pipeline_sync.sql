-- 028 — Visitor pipeline indexes (idempotent, no operational/demo rows)
-- Stage values are part of the current schema; this migration only adds
-- indexes needed by the pipeline. It intentionally creates no demo/test data.
CREATE INDEX IF NOT EXISTS idx_visitors_campaign ON visitors(campaign_id);
CREATE INDEX IF NOT EXISTS idx_visitors_source   ON visitors(source);
