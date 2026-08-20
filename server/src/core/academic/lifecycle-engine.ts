/**
 * core/academic/lifecycle-engine.ts
 * ============================================================================
 * Academic Module Refactor — Phase 1
 *
 * Generic, reusable guarded state-machine primitive shared by the Academic
 * Module's lifecycle engines. Centralizing transition-graph validation here
 * gives every engine (Class, Enrollment today; Grade Lock and Certificate in
 * later phases) the same auditable "reject invalid transitions" guarantee
 * instead of ad-hoc if/else checks scattered across routes.
 *
 * Nothing here talks to the database — it is pure transition-graph logic,
 * intentionally kept dependency-free so it is trivial to unit test.
 * ============================================================================
 */
import { HttpError } from '../../middleware/errorHandler.js';

/**
 * Throws HttpError(409) if `to` is not reachable from `from` per `transitions`.
 * Same-state calls (from === to) are NOT auto-allowed here — each engine's
 * transition table must explicitly list any self-transition it wants to permit,
 * keeping the guard's behavior fully visible in one place (the table itself).
 */
export function assertTransition<S extends string>(
  entityLabel: string,
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): void {
  const allowed = transitions[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HttpError(
      409,
      `Invalid ${entityLabel} transition: '${from}' → '${to}'. ` +
        (allowed.length
          ? `Allowed from '${from}': ${allowed.join(', ')}.`
          : `'${from}' is a terminal state — no further transitions are allowed.`),
    );
  }
}

// ============================================================================
// Class Lifecycle Engine
// ============================================================================
// Draft → Scheduled → Enrollment Open → Enrollment Closed → Activated →
// In Progress → Suspended → Grading → Completed → Archived / Cancelled
//
// Not strictly linear: enrollment-open/closed can be skipped or reopened,
// suspension can happen from Activated or In Progress and resume back to
// In Progress, and Grading can return to In Progress for correction before
// being finalized. Cancellation is allowed from any pre-grading state but
// not after grading has begun (grades already exist and must go through
// Completed → Archived instead of vanishing).

export const CLASS_STAGES = [
  'draft',
  'scheduled',
  'enrollment_open',
  'enrollment_closed',
  'activated',
  'in_progress',
  'suspended',
  'grading',
  'completed',
  'archived',
  'cancelled',
] as const;
export type ClassStage = (typeof CLASS_STAGES)[number];

export const CLASS_TRANSITIONS: Readonly<Record<ClassStage, readonly ClassStage[]>> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['enrollment_open', 'activated', 'cancelled'],
  enrollment_open: ['enrollment_closed', 'cancelled'],
  enrollment_closed: ['enrollment_open', 'activated', 'cancelled'],
  activated: ['in_progress', 'suspended', 'cancelled'],
  in_progress: ['suspended', 'grading', 'cancelled'],
  suspended: ['in_progress', 'activated', 'cancelled'],
  grading: ['in_progress', 'completed'],
  completed: ['archived'],
  archived: [],
  cancelled: [],
};

export type CoarseClassStatus = 'draft' | 'active' | 'completed' | 'cancelled';

/**
 * `classes.status` (the 4-value enum the frontend and most of the backend read
 * via `status === 'active'`) is a DERIVED, coarse projection of
 * `lifecycle_stage`. This is the single source of truth for
 * that mapping — every write site (ClassLifecycleService, classes.routes.ts,
 * class-generation-engine.ts) must go through this function rather than
 * writing `status` independently, or the two columns will drift.
 */
export function deriveCoarseClassStatus(stage: ClassStage): CoarseClassStatus {
  if (stage === 'draft') return 'draft';
  if (stage === 'cancelled') return 'cancelled';
  if (stage === 'completed' || stage === 'archived') return 'completed';
  return 'active';
}

export function assertClassTransition(from: ClassStage, to: ClassStage): void {
  assertTransition('class', CLASS_TRANSITIONS, from, to);
}

/** Stages at/after which the class has been officially activated — the
 *  point the blueprint ties to gating attendance, homework, exams, academic
 *  KPIs, and teaching-related financial calculations. */
const POST_ACTIVATION_STAGES: readonly ClassStage[] = [
  'activated',
  'in_progress',
  'suspended',
  'grading',
  'completed',
  'archived',
];

export function isPostActivation(stage: ClassStage): boolean {
  return POST_ACTIVATION_STAGES.includes(stage);
}

// ============================================================================
// Enrollment Lifecycle Engine
// ============================================================================
// Pending → Reserved → Confirmed → Active → {Frozen ⇄ Active} → terminal
// (Transferred / Dropped / Withdrawn / Completed → Graduated, or Retake /
// Conditional Pass looping back into Active).
//
// `paused` and `suspended` are kept as permanent, fully-supported aliases of
// `frozen` — the existing suspend()/resume() API continues to write exactly
// what it always has. New code should prefer freeze()/unfreeze().

export const ENROLLMENT_STATUSES = [
  'pending',
  'reserved',
  'confirmed',
  'active',
  'frozen',
  'paused',
  'suspended',
  'transferred',
  'dropped',
  'withdrawn',
  'completed',
  'graduated',
  'retake',
  'conditional_pass',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ENROLLMENT_TRANSITIONS: Readonly<Record<EnrollmentStatus, readonly EnrollmentStatus[]>> = {
  pending: ['reserved', 'confirmed', 'active', 'dropped'],
  reserved: ['confirmed', 'active', 'dropped'],
  confirmed: ['active', 'dropped'],
  active: [
    'frozen', 'paused', 'suspended',
    'transferred', 'dropped', 'withdrawn',
    'completed', 'retake', 'conditional_pass',
  ],
  frozen: ['active', 'dropped', 'withdrawn'],
  paused: ['active', 'dropped', 'withdrawn'],
  suspended: ['active', 'dropped', 'withdrawn'],
  transferred: [],
  dropped: [],
  withdrawn: [],
  completed: ['graduated', 'retake'],
  graduated: [],
  retake: ['active', 'dropped'],
  conditional_pass: ['active', 'completed', 'retake', 'dropped'],
};

export function assertEnrollmentTransition(from: EnrollmentStatus, to: EnrollmentStatus): void {
  assertTransition('enrollment', ENROLLMENT_TRANSITIONS, from, to);
}

/** Statuses that keep an enrollment "on hold" (not actively attending, not
 *  yet a terminal outcome) — the target of the Enrollment Lifecycle
 *  requirement to distinguish freezes from drops/withdrawals. */
export const HOLD_STATUSES: readonly EnrollmentStatus[] = ['frozen', 'paused', 'suspended'];

export const TERMINAL_ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  'transferred', 'dropped', 'withdrawn', 'graduated',
];

// ============================================================================
// Smart Attendance Engine (Phase 2)
// ============================================================================
// Attendance has no state machine (a mark isn't "transitioned" from one
// status to another the way a class or enrollment is — it's simply
// re-recorded), so this is a plain type, not a transition table. It lives
// here anyway so every engine's vocabulary is defined in one module.
// 'sick' and 'leave' are permanent aliases of 'medical_leave' and 'excused'
// respectively, kept for the pre-Phase-2 API shape.

export const ATTENDANCE_STATUSES = [
  'present', 'late', 'absent', 'excused', 'medical_leave', 'sick', 'leave',
  'online', 'hybrid', 'left_early', 'not_marked',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

// ============================================================================
// Session Engine (Phase 2)
// ============================================================================

export const SESSION_TYPES = ['regular', 'makeup', 'substitute', 'online', 'hybrid', 'rescheduled'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

// ============================================================================
// Grade Lock Workflow (Phase 7)
// ============================================================================
// Draft → Submitted → Reviewed → Approved → Published → Locked.
// Applies per-assessment (class_assessments.lock_status), not per
// individual student_grades row — the whole assessment's grades move
// through review together. unlock() is a deliberately separate, more
// heavily-gated path back from Locked (see grade-lock-service.ts) rather
// than a normal forward transition, matching "Locked grades cannot be
// modified without authorized administrative action."

export const GRADE_LOCK_STAGES = ['draft', 'submitted', 'reviewed', 'approved', 'published', 'locked'] as const;
export type GradeLockStage = (typeof GRADE_LOCK_STAGES)[number];

export const GRADE_LOCK_TRANSITIONS: Readonly<Record<GradeLockStage, readonly GradeLockStage[]>> = {
  draft: ['submitted'],
  submitted: ['reviewed', 'draft'],
  reviewed: ['approved', 'draft'],
  approved: ['published', 'draft'],
  published: ['locked'],
  locked: [], // unlock() is a separate, explicitly-privileged path — not a normal transition
};

export function assertGradeLockTransition(from: GradeLockStage, to: GradeLockStage): void {
  assertTransition('grade lock', GRADE_LOCK_TRANSITIONS, from, to);
}

/** Stages at which a teacher (not a manager) may edit grades — everything
 *  past Draft requires at least manager-tier involvement, matching
 *  "Teachers may edit only Draft grades." */
export function isTeacherEditableStage(stage: GradeLockStage): boolean {
  return stage === 'draft';
}
