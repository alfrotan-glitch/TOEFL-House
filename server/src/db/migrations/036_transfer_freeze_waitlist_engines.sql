-- ============================================================================
-- Migration 036 — Academic Module Refactor, Phase 9
-- Transfer / Freeze / Waitlist Engines
-- ============================================================================
--
-- Freeze and Transfer *state* already existed on `enrollments` since Phase 1
-- (lifecycle-engine.ts's ENROLLMENT_TRANSITIONS; EnrollmentService.freeze()/
-- unfreeze()/transfer()) and Phase 6 configured their policy caps
-- (getFreezePolicy/getTransferPolicy in academic-policy-service.ts). What was
-- missing was the workflow layer the blueprint asks for: *why* a freeze or
-- transfer happened, *for how long*, and — for transfers below the
-- auto-approve threshold — *who signed off*. These three tables are that
-- workflow layer. They do not replace or duplicate the state machine; every
-- row here wraps a call into the existing freeze()/unfreeze()/transfer()
-- methods, which continue to own the actual `enrollments.status` transition
-- and its enrollment_events audit entry exactly as before.
--
-- enrollment_freezes — one row per freeze period. Policy caps
-- (maxFreezeDurationDays, maxFreezesPerEnrollment) are enforced at the
-- application layer (enrollment.routes.ts) before the row is inserted, so a
-- request that fails either cap is rejected outright rather than persisted
-- in some intermediate state. There is deliberately no 'pending' /
-- 'rejected' status here — see the Phase 9 report (AM-43) for why freeze
-- requests are policy-gated and auto-approved rather than manually queued,
-- unlike transfers below.
--
-- enrollment_transfer_requests — one row per transfer request.
-- TransferPolicy.minDaysBeforeAutoApprove is a genuine approval-timing
-- gate (unlike Freeze's policy, which is just caps): a request from a
-- long-enough-enrolled student executes immediately and is stored
-- 'approved'; a newer enrollment's request is stored 'pending' and waits
-- for an explicit approve()/reject() call. new_enrollment_id is populated
-- once (and only once) the underlying transfer() has actually executed.
--
-- class_waitlist — genuinely new; no Phase 6 policy getter exists for it.
-- position is assigned FIFO at join time. Deliberately no manual
-- promote-on-drop trigger this phase (see AM-46 in the report) — offer()
-- is an explicit staff action, matching the manual conversion pattern
-- already used for visitor→student conversion (visitors.routes.ts).
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrollment_freezes (
  id                TEXT PRIMARY KEY,
  enrollment_id     TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  branch_id         TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  reason            TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  planned_end_date  TEXT NOT NULL,
  actual_end_date   TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  requested_by      TEXT,
  approved_by       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_efz_enrollment ON enrollment_freezes(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_efz_status ON enrollment_freezes(status);

CREATE TABLE IF NOT EXISTS enrollment_transfer_requests (
  id                TEXT PRIMARY KEY,
  enrollment_id     TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_class_id     TEXT REFERENCES classes(id) ON DELETE SET NULL,
  to_class_id       TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  branch_id         TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  new_enrollment_id TEXT REFERENCES enrollments(id) ON DELETE SET NULL,
  requested_by      TEXT,
  approved_by       TEXT,
  decision_notes    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_etr_enrollment ON enrollment_transfer_requests(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_etr_status ON enrollment_transfer_requests(status);

CREATE TABLE IF NOT EXISTS class_waitlist (
  id            TEXT PRIMARY KEY,
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  position      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','converted','expired','cancelled')),
  notes         TEXT,
  offered_at    TEXT,
  responded_at  TEXT,
  requested_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wl_class ON class_waitlist(class_id);
CREATE INDEX IF NOT EXISTS idx_wl_student ON class_waitlist(student_id);
CREATE INDEX IF NOT EXISTS idx_wl_status ON class_waitlist(status);
