-- ============================================================================
-- 064 — Remove the abandoned `student_id_cards` table
-- ============================================================================
-- Evidence gathered in the 2026-08-16 audit:
--
--   * Zero references in the entire server and frontend source tree. The only
--     mentions were its own CREATE TABLE in schema.sql and migration 010.
--   * Zero rows, in a database that has issued ID cards.
--   * No other table has a foreign key pointing at it.
--   * Ten concurrent POST /students/:id/issue-card calls returned 201 each and
--     wrote NOTHING here — card state actually lives on `students.card_design`
--     and the fee is booked as a `card` payment.
--
-- It is an abandoned feature: a second, never-wired card model sitting beside
-- the real one. Keeping it invites a future developer to write to the wrong
-- place and split card state across two sources.
--
-- Safe by construction: dropping a table with no readers, no writers, no
-- referencing keys and no data cannot change behaviour. The card issuance
-- endpoint is covered by guarded-category-concurrency.test.ts, which asserts
-- the fee is booked at most once via `payments`.
-- ============================================================================

DROP INDEX IF EXISTS idx_id_cards_student;
DROP TABLE IF EXISTS student_id_cards;
