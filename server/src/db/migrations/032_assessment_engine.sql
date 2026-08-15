-- ============================================================================
-- Migration 032 — Academic Module Refactor, Phase 3
-- Assessment Engine
-- ============================================================================
--
-- Expands class_assessments from a 5-type gradebook line-item (midterm/
-- final/assignment/attendance/participation) to the blueprint's generic
-- assessment model. 'attendance' and 'participation' are kept — they
-- predate the blueprint's own list but are real, presumably-in-use values;
-- removing them would be a breaking change for no blueprint-mandated
-- reason. 'placement_test' is deliberately NOT included here — see ADR
-- AM-15 in the Phase 3 report: a placement test happens before a student
-- is in any class, so it has no natural class_id and belongs to the
-- existing exams/placement_rules system, not this one.
--
-- The weighted-average scoring in complete-semester (classes.routes.ts) is
-- already type-agnostic — it only reads weight/max_score/score — so this
-- expansion carries zero risk to the existing Promotion calculation.
--
-- makeup_for_assessment_id is a self-reference, mirroring the
-- linked_session_id pattern from Phase 2's Session Engine exactly, for the
-- same reason: a 'makeup_exam' assessment needs to point back at what it's
-- making up for.
-- ============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS class_assessments_v2 (
  id                      TEXT PRIMARY KEY,
  class_id                TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type IN (
                            'midterm','final','assignment','attendance','participation',
                            'quiz','homework','speaking','listening','reading','writing',
                            'practice_test','makeup_exam'
                          )),
  weight                  REAL NOT NULL DEFAULT 0,
  max_score               REAL NOT NULL DEFAULT 100,
  passing_score           REAL,
  date                    TEXT,
  publish_date            TEXT,
  due_date                TEXT,
  visibility              TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','scheduled')),
  rubric                  TEXT,
  allows_makeup           INTEGER NOT NULL DEFAULT 0,
  makeup_for_assessment_id TEXT REFERENCES class_assessments(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO class_assessments_v2 (id, class_id, title, type, weight, max_score, date, created_at)
SELECT id, class_id, title, type, weight, max_score, date, created_at FROM class_assessments;

DROP TABLE class_assessments;
ALTER TABLE class_assessments_v2 RENAME TO class_assessments;

CREATE INDEX IF NOT EXISTS idx_assessments_class ON class_assessments(class_id);
CREATE INDEX IF NOT EXISTS idx_assessments_makeup_for ON class_assessments(makeup_for_assessment_id);

PRAGMA foreign_keys = ON;
