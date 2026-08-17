-- ============================================================================
-- 070 — Placement Exam integrity: authoritative outcome, atomic retake guard,
--       and configurable retake/billing policy
-- ============================================================================
-- WHY
-- ---
-- The forensic audit (docs/PLACEMENT_AUDIT_2026-08-17.md) confirmed three
-- defects that all share one root cause: placement rules were *computed* but
-- never *enforced*, and lifecycle rules were checked only at attempt creation
-- with a read-then-write pattern that concurrency defeats.
--
--   P-1  The decision engine produced `unmetRequirements` (component minScore
--        failures) and `belowPass`, and every caller discarded them. A
--        candidate scoring 10% under a policy demanding 60% overall and 50%
--        per component completed placement and enrolled as a student.
--
--   P-2  `allow_retake = 0` was enforced by counting *completed* attempts
--        before inserting a new one. Opening several attempts before
--        completing any bypassed it entirely; 8 parallel creations produced 8
--        open attempts. UNIQUE(visitor_id, attempt_number) protected the
--        numbering, not the invariant.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. `placement_assessment_attempts.outcome` — the authoritative, persisted
--    pass/fail verdict for a finished sitting. NULL while the attempt is still
--    open, so existing rows stay valid. Conversion reads this column instead of
--    trusting the denormalised `visitors.placement_score` JSON.
--
-- 2. `uq_placement_open_attempt` — a partial UNIQUE index allowing at most one
--    OPEN (in_progress/paused) attempt per visitor. This makes the retake
--    invariant atomic in the database, so parallel requests, retries, duplicate
--    submissions and multiple tabs cannot defeat it. An application-level
--    count-then-insert cannot provide this guarantee.
--
-- 3. Configurable retake + billing policy on placement_assessment_profiles.
--    Every default below reproduces the CURRENT behaviour exactly, so this
--    migration changes no existing institution's fee or retake semantics:
--      max_attempts           NULL = unlimited (today: unlimited)
--      first_attempt_billable 1    = the first completed sitting is billed
--      retake_billable        0    = retakes are free
--      retake_fee_amount      NULL = fall back to the branch placement fee
--
-- SAFETY
-- ------
-- ALTER TABLE ADD COLUMN and CREATE INDEX only: no table rebuild, so no
-- indexes or triggers are silently dropped (the failure mode migration 068 had
-- to repair). Step 3 below reconciles any pre-existing duplicate open attempts
-- BEFORE the unique index is created, otherwise index creation would fail on a
-- database that already contains the P-2 corruption. The newest open attempt
-- per visitor is kept; older ones are cancelled and audit-marked in `notes`.
-- ============================================================================

-- 1. Authoritative outcome of a finished sitting.
ALTER TABLE placement_assessment_attempts ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('passed', 'failed'));

-- 2. Configurable retake + billing policy (defaults preserve today's behaviour).
ALTER TABLE placement_assessment_profiles ADD COLUMN max_attempts INTEGER;
ALTER TABLE placement_assessment_profiles ADD COLUMN first_attempt_billable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE placement_assessment_profiles ADD COLUMN retake_billable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE placement_assessment_profiles ADD COLUMN retake_fee_amount REAL;

-- 3. Backfill `outcome` for attempts that already finished, so historical rows
--    carry a truthful verdict instead of NULL. A finished attempt is treated as
--    passed when its recorded percentage met the pass score captured in its own
--    immutable policy snapshot, or when a level was recommended/overridden and
--    no percentage was recorded (explicit level assessment). This mirrors the
--    runtime rule in core/placement/decision-engine.ts (evaluateOutcome) for
--    the overall-score dimension. Per-component minimum scores are NOT
--    re-derived here: the historical result rows are authoritative and
--    re-scoring them retroactively could rewrite a real academic record.
UPDATE placement_assessment_attempts
SET outcome = CASE
  WHEN percentage IS NOT NULL
       AND percentage >= COALESCE(
         CAST(json_extract(snapshot_json, '$.profile.passScore') AS REAL), 60)
    THEN 'passed'
  WHEN percentage IS NULL
       AND COALESCE(override_level_id, recommended_level_id) IS NOT NULL
    THEN 'passed'
  ELSE 'failed'
END
WHERE status = 'completed' AND outcome IS NULL;

-- 4. Reconcile pre-existing duplicate OPEN attempts so the unique index can be
--    created. Keep the most recently started open attempt per visitor; cancel
--    the rest. Ordering is deterministic: started_at, then rowid as tiebreak.
UPDATE placement_assessment_attempts
SET status = 'cancelled',
    notes = TRIM(COALESCE(notes, '') || ' [migration 070: superseded duplicate open attempt cancelled]'),
    updated_at = datetime('now')
WHERE status IN ('in_progress', 'paused')
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY visitor_id
               ORDER BY started_at DESC, rowid DESC
             ) AS rn
      FROM placement_assessment_attempts
      WHERE status IN ('in_progress', 'paused')
    )
    WHERE rn = 1
  );

-- 5. Point every visitor whose current attempt was just cancelled at the
--    surviving open attempt, so `current_placement_attempt_id` never dangles on
--    a cancelled row.
UPDATE visitors
SET current_placement_attempt_id = (
  SELECT a.id FROM placement_assessment_attempts a
  WHERE a.visitor_id = visitors.id AND a.status IN ('in_progress', 'paused')
  ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1
)
WHERE current_placement_attempt_id IN (
  SELECT id FROM placement_assessment_attempts WHERE status = 'cancelled'
);

-- 6. THE invariant: at most one open placement attempt per visitor, enforced by
--    the database so no concurrent path can bypass it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_open_attempt
  ON placement_assessment_attempts(visitor_id)
  WHERE status IN ('in_progress', 'paused');

-- 7. Conversion and reporting both filter attempts by visitor + outcome.
CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor_outcome
  ON placement_assessment_attempts(visitor_id, status, outcome);
