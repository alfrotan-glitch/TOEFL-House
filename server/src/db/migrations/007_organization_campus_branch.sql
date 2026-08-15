-- ============================================================================
-- 007 — Organization → Campus → Branch hierarchy
-- ============================================================================
-- Adds organizations and campuses tables, extends branches with campus
-- linkage and configurable fields. Seeds the fixed organization
-- "The TOEFL House", default Kabul Campus (KBL), and Main Branch
-- (TH-MB-001). Preserves existing branch id "1" for FK compatibility.
-- ============================================================================

-- Organization (fixed single root)
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campuses (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  code             TEXT NOT NULL UNIQUE,
  address          TEXT,
  postal_code      TEXT,
  phone            TEXT,
  email            TEXT,
  description      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Extend branches (SQLite ADD COLUMN is additive and safe if already present)
ALTER TABLE branches ADD COLUMN campus_id TEXT REFERENCES campuses(id);
ALTER TABLE branches ADD COLUMN code TEXT;
ALTER TABLE branches ADD COLUMN address TEXT;
ALTER TABLE branches ADD COLUMN postal_code TEXT;
ALTER TABLE branches ADD COLUMN phone TEXT;
ALTER TABLE branches ADD COLUMN email TEXT;
ALTER TABLE branches ADD COLUMN description TEXT;
ALTER TABLE branches ADD COLUMN created_at TEXT DEFAULT (datetime('now'));
ALTER TABLE branches ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));

CREATE INDEX IF NOT EXISTS idx_campuses_org        ON campuses(organization_id);
CREATE INDEX IF NOT EXISTS idx_campuses_active     ON campuses(is_active);
CREATE INDEX IF NOT EXISTS idx_branches_campus     ON branches(campus_id);
CREATE INDEX IF NOT EXISTS idx_branches_active     ON branches(is_active);
CREATE INDEX IF NOT EXISTS idx_branches_code       ON branches(code);

-- Seed fixed organization
INSERT OR IGNORE INTO organizations (id, name)
VALUES ('org_toefl_house', 'The TOEFL House');

-- Seed default Kabul Campus
INSERT OR IGNORE INTO campuses (
  id, organization_id, name, code, address, postal_code, phone, email, description, is_active
) VALUES (
  'campus_kbl',
  'org_toefl_house',
  'Kabul Campus',
  'KBL',
  'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan',
  '1016',
  NULL,
  NULL,
  'Primary campus of The TOEFL House in Kabul',
  1
);

-- Ensure Main Branch (id=1) matches required defaults; create if missing
INSERT OR IGNORE INTO branches (
  id, campus_id, name, code, location, address, postal_code, phone, email, description, is_active
) VALUES (
  '1',
  'campus_kbl',
  'Main Branch',
  'TH-MB-001',
  'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan',
  'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan',
  '1016',
  NULL,
  NULL,
  'Main operational branch under Kabul Campus',
  1
);

UPDATE branches SET
  campus_id   = COALESCE(campus_id, 'campus_kbl'),
  name        = CASE WHEN id = '1' THEN 'Main Branch' ELSE name END,
  code        = CASE WHEN id = '1' THEN 'TH-MB-001' ELSE COALESCE(code, 'TH-BR-' || id) END,
  address     = CASE
                  WHEN id = '1' THEN 'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan'
                  ELSE COALESCE(address, location)
                END,
  location    = CASE
                  WHEN id = '1' THEN 'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan'
                  ELSE location
                END,
  postal_code = CASE WHEN id = '1' THEN '1016' ELSE postal_code END,
  description = CASE
                  WHEN id = '1' THEN COALESCE(description, 'Main operational branch under Kabul Campus')
                  ELSE description
                END,
  is_active   = COALESCE(is_active, 1),
  updated_at  = datetime('now')
WHERE id = '1' OR campus_id IS NULL OR code IS NULL;

-- Unique index on branch code (after backfill)
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_code_unique ON branches(code) WHERE code IS NOT NULL;

-- Saving account for main branch if missing
INSERT OR IGNORE INTO saving_accounts (branch_id, balance) VALUES ('1', 0);
