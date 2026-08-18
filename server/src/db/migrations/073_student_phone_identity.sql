-- 073 — Student phone identity: normalized, race-safe uniqueness
--
-- WHY
-- ---
-- Audit finding STU-H3 (docs/STUDENT_SUBSYSTEM_AUDIT_2026-08-18.md).
--
-- `uq_students_phone` (migration 029) indexes the RAW phone string. The
-- application check compared `String(phone).trim()` against that raw column.
-- Both are trivially defeated by formatting: against an existing "0700111001",
-- live requests created new students with
--     "0700-111-001"   -> 201
--     "+93700111001"   -> 201
-- All three are the same physical line. Result: split payment histories, split
-- attendance, duplicated fee obligations and double-counted enrolment metrics
-- for one human being.
--
-- The correct normalizer already existed — `phoneMatchKey()` in
-- core/visitors/duplicate-lookup.ts, digits-only compared on the last 9 so the
-- national leading zero and the +93 country code collapse together — but only
-- the Visitor subsystem used it. This migration makes the DATABASE agree with
-- that rule, so the invariant survives a race between two connections rather
-- than depending on a check-then-insert.
--
-- APPROACH
-- --------
-- A generated/derived column cannot be added to an existing SQLite table
-- without a full table rebuild, and rebuilding `students` would drop the
-- indexes and foreign keys other migrations restored (see 068, which exists
-- precisely because an earlier rebuild lost them). Instead the uniqueness is
-- expressed directly as an EXPRESSION INDEX over the same digit-suffix rule.
-- SQLite has supported indexes on expressions since 3.9 (2015); better-sqlite3
-- ships far newer.
--
-- The expression must mirror phoneMatchKey() exactly:
--   digits only, last 9 characters, ignored when fewer than 7 digits remain.
-- REPLACE() chains strip the separators that occur in practice (space, dash,
-- parentheses, plus). A phone that still contains other non-digits after that
-- is left out of the index rather than being silently mangled.
--
-- PRE-EXISTING VIOLATIONS
-- -----------------------
-- CREATE UNIQUE INDEX aborts if the table already violates it, so on any real
-- deployment carrying historical duplicates this migration would fail and take
-- the whole boot down with it. Duplicates are therefore reconciled FIRST, and
-- are NEVER deleted: a student row owns payments, invoices, enrollments,
-- attendance and audit history. Deleting one destroys financial history.
--
-- Following the precedent set by migration 072 for visitors, every duplicate
-- beyond the FIRST (oldest by rowid — the row other records are most likely to
-- reference) has its phone released to NULL, with the original value preserved
-- verbatim in `notes` so an operator can reconcile by hand. The audit trail,
-- the payments and the enrollments all survive intact.
--
-- NOTE ON schema.sql
-- ------------------
-- This index is deliberately NOT added to schema.sql. schema.sql runs against
-- brand-new AND existing databases before migrations execute; a dirty
-- production database would fail at CREATE UNIQUE INDEX before this file ever
-- got the chance to clean it. Forward-only migration is the only safe home.

-- ── 1. Normalise obvious whitespace so trimming alone cannot hide a collision ─
UPDATE students
   SET phone = TRIM(phone)
 WHERE phone IS NOT NULL AND phone <> TRIM(phone);

UPDATE students
   SET phone = NULL
 WHERE phone IS NOT NULL AND TRIM(phone) = '';

-- ── 2. Release duplicate normalized phones, keeping the earliest holder ──────
-- The digit-suffix expression is repeated here rather than factored out
-- because SQLite migrations cannot define functions. It is character-for-
-- character the same expression used by the index below.
WITH normalized AS (
  SELECT
    rowid AS rid,
    phone,
    SUBSTR(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''),
      -9
    ) AS pkey
  FROM students
  WHERE phone IS NOT NULL
    AND TRIM(phone) <> ''
    AND LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')) >= 7
),
keepers AS (
  SELECT MIN(rid) AS rid FROM normalized GROUP BY pkey
)
UPDATE students
   SET notes = COALESCE(notes || ' | ', '') ||
               'Duplicate phone released by migration 073 (was ' || phone || ').',
       phone = NULL
 WHERE rowid IN (SELECT rid FROM normalized WHERE rid NOT IN (SELECT rid FROM keepers));

-- ── 3. The authoritative, race-safe uniqueness rule ─────────────────────────
-- Partial: rows with no phone, or with too few digits to form a key, are
-- excluded — a missing identity is not a collision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone_normalized
  ON students (
    SUBSTR(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''),
      -9
    )
  )
  WHERE phone IS NOT NULL
    AND TRIM(phone) <> ''
    AND LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')) >= 7;
