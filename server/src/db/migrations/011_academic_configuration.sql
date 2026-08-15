-- Academic Configuration Engine (data-driven programs, levels, fees, slots, rooms)
-- Clear seeded demo academic catalog so production starts empty.

DELETE FROM levels WHERE id IN ('lvl1','lvl2','lvl3','lvl4','lvl5');
DELETE FROM programs WHERE id IN ('prog1','prog2','prog3');
-- Demo classes if any leftover seed ids
DELETE FROM class_teacher_skills WHERE class_id LIKE 'cls%';
DELETE FROM sessions WHERE class_id LIKE 'cls%';
DELETE FROM classes WHERE id LIKE 'cls%';

-- Program catalog enhancements (global academic structure)
ALTER TABLE programs ADD COLUMN code TEXT;
ALTER TABLE programs ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE programs ADD COLUMN organization_id TEXT;

-- Level academic attributes
ALTER TABLE levels ADD COLUMN code TEXT;
ALTER TABLE levels ADD COLUMN duration_months INTEGER NOT NULL DEFAULT 1;
ALTER TABLE levels ADD COLUMN default_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE levels ADD COLUMN pass_mark REAL NOT NULL DEFAULT 70;
ALTER TABLE levels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

-- Branch-specific tuition override for a level
CREATE TABLE IF NOT EXISTS level_branch_fees (
  id          TEXT PRIMARY KEY,
  level_id    TEXT NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  fee         REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'AFN',
  effective_from TEXT,
  effective_to   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(level_id, branch_id)
);

-- Branch time slots (no hard-coded morning/evening)
CREATE TABLE IF NOT EXISTS time_slots (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch_id, code)
);

-- Branch rooms
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch_id, code)
);

-- Academic terms / calendar (branch-scoped)
CREATE TABLE IF NOT EXISTS academic_terms (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch_id, year, code)
);

-- Link operational classes to configuration entities
ALTER TABLE classes ADD COLUMN room_id TEXT REFERENCES rooms(id);
ALTER TABLE classes ADD COLUMN time_slot_id TEXT REFERENCES time_slots(id);
ALTER TABLE classes ADD COLUMN academic_term_id TEXT REFERENCES academic_terms(id);

CREATE INDEX IF NOT EXISTS idx_time_slots_branch ON time_slots(branch_id, is_active);
CREATE INDEX IF NOT EXISTS idx_rooms_branch ON rooms(branch_id, is_active);
CREATE INDEX IF NOT EXISTS idx_level_fees_branch ON level_branch_fees(branch_id, level_id);
CREATE INDEX IF NOT EXISTS idx_academic_terms_branch ON academic_terms(branch_id, year);
