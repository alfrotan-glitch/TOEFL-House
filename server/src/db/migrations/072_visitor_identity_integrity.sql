-- 072 — Visitor identity integrity: serial numbers and national ID
--
-- WHY
-- ---
-- Two audit findings (V-2, V-3) share one root cause: the `visitors` table had
-- no uniqueness of any kind. It carried indexes on branch, status, stage,
-- campaign and source — all query accelerators — and not one identity
-- constraint. Application-level checks are advisory; only the database is
-- authoritative when two requests race.
--
-- V-3 — serial_no
--   Allocation was `SELECT MAX(serial)+1` inside a transaction. That holds for
--   a single process. Reproduced with two connections: both read V-1031, both
--   inserts were accepted, and a duplicate human-facing lead reference was
--   persisted permanently with nothing in the application ever noticing.
--   The route now allocates from the same atomic `system_settings` counter that
--   already issues receipt and student codes; this index is the backstop that
--   makes the invariant true regardless of how a future caller allocates.
--
-- V-2 — tazkira_no (national ID)
--   No duplicate prevention existed at all: five leads were created with an
--   identical name, phone AND national ID. The institutional policy is already
--   settled for students — `uq_students_tazkira_no` is GLOBAL (not per-branch)
--   and excludes NULL and empty string. Visitors adopt the same rule, because a
--   person is the same person in either table.
--
-- PRE-EXISTING VIOLATIONS
-- -----------------------
-- A `CREATE UNIQUE INDEX` fails outright if the table already violates it, so a
-- migration that ignored existing data would abort on any real deployment.
-- Duplicates are NOT deleted — a lead is a person a counselor spoke to, and
-- deleting one silently destroys that history and any follow-ups attached to it.
--
-- Instead, each duplicate beyond the FIRST (oldest by created_at, then rowid)
-- has its identity field released and the original value preserved in `notes`,
-- so the record, its follow-ups and its audit trail all survive intact and an
-- operator can reconcile them by hand. The oldest row keeps the value because
-- it is the one other records are most likely to reference.

-- ── serial_no: release collisions, keeping the earliest holder ──────────────
UPDATE visitors
   SET notes = COALESCE(notes || ' | ', '') ||
               'Duplicate serial released by migration 072 (was ' || serial_no || ').',
       serial_no = NULL
 WHERE serial_no IS NOT NULL
   AND rowid NOT IN (
     SELECT MIN(rowid) FROM visitors WHERE serial_no IS NOT NULL GROUP BY serial_no
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_visitors_serial_no
  ON visitors(serial_no) WHERE serial_no IS NOT NULL;

-- ── tazkira_no: normalise, then release collisions ──────────────────────────
-- Normalise first so that ' TZK-1 ' and 'TZK-1' are recognised as the same
-- identity rather than slipping past the index as distinct strings.
UPDATE visitors
   SET tazkira_no = TRIM(tazkira_no)
 WHERE tazkira_no IS NOT NULL AND tazkira_no <> TRIM(tazkira_no);

UPDATE visitors
   SET tazkira_no = NULL
 WHERE COALESCE(TRIM(tazkira_no), '') = '' AND tazkira_no IS NOT NULL;

UPDATE visitors
   SET notes = COALESCE(notes || ' | ', '') ||
               'Duplicate national ID released by migration 072 (was ' || tazkira_no || ').',
       tazkira_no = NULL
 WHERE COALESCE(tazkira_no, '') <> ''
   AND rowid NOT IN (
     SELECT MIN(rowid) FROM visitors WHERE COALESCE(tazkira_no, '') <> '' GROUP BY tazkira_no
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_visitors_tazkira_no
  ON visitors(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != '';

-- ── seed the atomic serial counter above the current maximum ────────────────
-- The route allocates with `incrementNumberSetting('visitor_serial_counter', …)`,
-- the same mechanism behind receipt and student codes. Seeding it here prevents
-- the first post-migration allocation from colliding with historical serials.
INSERT INTO system_settings (key, value)
SELECT 'visitor_serial_counter',
       CAST(COALESCE(MAX(CAST(SUBSTR(serial_no, 3) AS INTEGER)), 1000) AS TEXT)
  FROM visitors
 WHERE serial_no LIKE 'V-%'
   AND SUBSTR(serial_no, 3) GLOB '[0-9]*'
ON CONFLICT(key) DO UPDATE SET value = MAX(
  CAST(system_settings.value AS INTEGER),
  CAST(excluded.value AS INTEGER)
);
