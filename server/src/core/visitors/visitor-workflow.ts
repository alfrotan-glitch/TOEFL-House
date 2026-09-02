/**
 * Reception workflow state — the single read model for the front desk.
 *
 * A lead's operational position (follow-up, admission, placement, fees,
 * enrollment) is not a stored column: it is the consequence of real domain
 * facts — the linked student record, the placement policy and attempt rows,
 * the registration/placement receivables, and the enrollment rows. Every
 * surface that needs to answer "where is this person?" (profile workspace,
 * pipeline board, dashboards) reads it here instead of re-deriving it from
 * unrelated fields.
 *
 * The model is read-only. Nothing in this module writes, and no gate is
 * enforced here: the conversion route, placement attempt routes and
 * EnrollmentService remain the authorities. This module only describes.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { resolvePlacementRequirement } from '../placement/policy-engine.js';
import { evaluateConversionEligibilityForVisitor } from './conversion-eligibility.js';
import { getStudentNonTuitionSummary } from '../../utils/studentBalance.js';
import { ACTIVE_ENROLLMENT_STATUSES } from '../academic/class-capacity.js';

export const RECEPTION_STAGES = [
  'lead',
  'follow_up',
  'admission',
  'placement',
  'financial_clearance',
  'enrollment',
  'enrolled',
] as const;

export type ReceptionStage = (typeof RECEPTION_STAGES)[number];

export type ReceptionAction =
  | 'log_follow_up'
  | 'admit'
  | 'start_placement'
  | 'settle_admission_fees'
  | 'enroll'
  | 'view_enrollment';

export interface WorkflowBlocker {
  code: string;
  reason: string;
  /** The role that can clear this blocker, when it is not the current desk. */
  ownerRole?: string;
}

export interface WorkflowPlacementState {
  required: boolean;
  status: string;
  satisfied: boolean;
  attemptStatus: string | null;
  recommendedLevelId: string | null;
  recommendedLevelName: string | null;
  policyDecision: string;
}

export interface WorkflowFinancialState {
  registrationOutstanding: number;
  placementOutstanding: number;
  totalOutstanding: number;
  cleared: boolean;
}

export interface WorkflowEnrollmentState {
  activeEnrollmentId: string | null;
  classId: string | null;
  className: string | null;
  levelName: string | null;
}

export interface VisitorWorkflow {
  stage: ReceptionStage;
  /** True when the lead is closed (lost) — terminal, shown separately. */
  closed: boolean;
  nextAction: ReceptionAction;
  /** One-sentence explanation of why this is the next action. */
  nextActionReason: string;
  blockers: WorkflowBlocker[];
  admission: {
    admitted: boolean;
    studentId: string | null;
    studentCode: string | null;
    studentStatus: string | null;
  };
  placement: WorkflowPlacementState;
  financial: WorkflowFinancialState;
  enrollment: WorkflowEnrollmentState;
}

export interface VisitorWorkflowRow {
  id: string;
  status?: string | null;
  stage?: string | null;
  program_version_id?: string | null;
  placement_status?: string | null;
  branch_id?: string | null;
}

const ADMISSION_FEE_PURPOSES = ['registration', 'placement'] as const;

const stmtStudentByLeadId = (db: BetterSqlite3.Database) =>
  db.prepare('SELECT id, student_code, status FROM students WHERE lead_id = ? LIMIT 1');

const stmtCompletedAttempt = (db: BetterSqlite3.Database) =>
  db.prepare(
    `SELECT status, outcome, recommended_level_id, override_level_id
       FROM placement_assessment_attempts
      WHERE visitor_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, attempt_number DESC
      LIMIT 1`,
  );

const stmtLevelName = (db: BetterSqlite3.Database) =>
  db.prepare('SELECT name FROM levels WHERE id = ?');

const stmtActiveEnrollment = (db: BetterSqlite3.Database) =>
  db.prepare(
    `SELECT e.id, e.class_id, c.name AS class_name, c.level AS level_name
       FROM enrollments e
       LEFT JOIN classes c ON c.id = e.class_id
      WHERE e.student_id = ? AND e.status IN (${ACTIVE_ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(', ')})
        AND e.enrollment_type != 'extra'
      ORDER BY e.started_at DESC
      LIMIT 1`,
  );

const stmtFollowUpCount = (db: BetterSqlite3.Database) =>
  db.prepare('SELECT COUNT(*) AS c FROM visitor_followups WHERE visitor_id = ?');

const noPlacement: WorkflowPlacementState = {
  required: false,
  status: 'not_started',
  satisfied: true,
  attemptStatus: null,
  recommendedLevelId: null,
  recommendedLevelName: null,
  policyDecision: 'NOT_REQUIRED',
};

const clearedFinancial: WorkflowFinancialState = {
  registrationOutstanding: 0,
  placementOutstanding: 0,
  totalOutstanding: 0,
  cleared: true,
};

const noEnrollment: WorkflowEnrollmentState = {
  activeEnrollmentId: null,
  classId: null,
  className: null,
  levelName: null,
};

/**
 * Derive the complete front-desk state for one lead. All inputs are the
 * canonical rows; no fact is invented or carried from the visitor `stage`
 * annotation, which records history rather than operational truth.
 */
export function describeVisitorWorkflow(
  db: BetterSqlite3.Database,
  visitor: VisitorWorkflowRow,
): VisitorWorkflow {
  const blockers: WorkflowBlocker[] = [];
  const followUps = Number((stmtFollowUpCount(db).get(visitor.id) as { c: number }).c);
  const closed = (visitor.stage ?? 'lead') === 'lost' && visitor.status !== 'registered';

  const student = stmtStudentByLeadId(db).get(visitor.id) as
    | { id: string; student_code: string; status: string }
    | undefined;
  const admitted = Boolean(student) && visitor.status === 'registered';

  const requirement = resolvePlacementRequirement(
    visitor.program_version_id ?? null,
    visitor.branch_id ?? null,
    null,
  );
  const placementStatus = visitor.placement_status ?? 'not_started';
  const attempt = stmtCompletedAttempt(db).get(visitor.id) as
    | { status: string; outcome: string | null; recommended_level_id: string | null; override_level_id: string | null }
    | undefined;
  const placementRequired = requirement.mode === 'required' || requirement.mode === 'optional';
  const placementSatisfied =
    !placementRequired || placementStatus === 'completed' || placementStatus === 'waived';
  const recommendedLevelId = attempt
    ? (attempt.override_level_id ?? attempt.recommended_level_id)
    : null;
  const recommendedLevelName = recommendedLevelId
    ? ((stmtLevelName(db).get(recommendedLevelId) as { name: string } | undefined)?.name ?? null)
    : null;

  const placement: WorkflowPlacementState = placementRequired
    ? {
        required: true,
        status: placementStatus,
        satisfied: placementSatisfied,
        attemptStatus: attempt?.status ?? null,
        recommendedLevelId,
        recommendedLevelName,
        policyDecision: requirement.decision ?? 'REQUIRED',
      }
    : { ...noPlacement, status: placementStatus };

  if (requirement.decision === 'CONFIGURATION_ERROR') {
    blockers.push({
      code: 'placement_policy_unconfigured',
      reason:
        'Placement policy exists for this program but does not apply to this branch. An administrator must finish the placement setup before admission can proceed.',
      ownerRole: 'administrator',
    });
  }

  const financial: WorkflowFinancialState = clearedFinancial;
  let enrollment = noEnrollment;
  if (student) {
    const summary = getStudentNonTuitionSummary(db, student.id, ADMISSION_FEE_PURPOSES);
    const registration = summary.nonTuitionBreakdown.find((row) => row.purpose === 'registration');
    const placementFee = summary.nonTuitionBreakdown.find((row) => row.purpose === 'placement');
    financial.registrationOutstanding = registration?.outstanding ?? 0;
    financial.placementOutstanding = placementFee?.outstanding ?? 0;
    financial.totalOutstanding = financial.registrationOutstanding + financial.placementOutstanding;
    financial.cleared = financial.totalOutstanding <= 0;

    const row = stmtActiveEnrollment(db).get(student.id) as
      | { id: string; class_id: string | null; class_name: string | null; level_name: string | null }
      | undefined;
    if (row) {
      enrollment = {
        activeEnrollmentId: row.id,
        classId: row.class_id,
        className: row.class_name,
        levelName: row.level_name,
      };
    }
  }

  let conversionEligible = false;
  if (!admitted && !closed) {
    const eligibility = evaluateConversionEligibilityForVisitor(
      db,
      visitor,
      null,
      visitor.branch_id ?? null,
    );
    // Placement that is merely pending is not an admission blocker: the
    // assessment is sequenced after admission by the conversion contract.
    conversionEligible = eligibility.eligible || eligibility.code === 'placement_required';
    if (!eligibility.eligible && !conversionEligible) {
      blockers.push({ code: eligibility.code, reason: eligibility.reason });
    }
  }

  let stage: ReceptionStage;
  let nextAction: ReceptionAction;
  let nextActionReason: string;

  if (admitted) {
    if (!placementSatisfied) {
      stage = 'placement';
      nextAction = 'start_placement';
      nextActionReason =
        placementStatus === 'in_progress'
          ? 'A placement assessment is in progress — finish or restart it to record the recommended level.'
          : 'This program requires a placement assessment before enrollment.';
    } else if (!financial.cleared) {
      stage = 'financial_clearance';
      nextAction = 'settle_admission_fees';
      nextActionReason = `Registration and placement fees must be settled before enrollment (${financial.totalOutstanding} AFN outstanding).`;
      blockers.push({
        code: 'admission_fees_outstanding',
        reason: `Outstanding admission fees: ${financial.totalOutstanding} AFN.`,
        ownerRole: 'finance_manager',
      });
    } else if (enrollment.activeEnrollmentId) {
      stage = 'enrolled';
      nextAction = 'view_enrollment';
      nextActionReason = 'Enrolled — the seat and class assignment are active.';
    } else {
      stage = 'enrollment';
      nextAction = 'enroll';
      nextActionReason = recommendedLevelName
        ? `Placement cleared — enroll in a class at ${recommendedLevelName} or below.`
        : 'Placement and fees are clear — enroll in a class to activate the student.';
    }
  } else if (closed) {
    stage = followUps > 0 ? 'follow_up' : 'lead';
    nextAction = 'log_follow_up';
    nextActionReason = 'This lead is closed. Reopen it before working it again.';
    blockers.push({ code: 'lead_lost', reason: 'This lead is closed (lost).' });
  } else if (conversionEligible && blockers.length === 0 && followUps > 0) {
    stage = 'admission';
    nextAction = 'admit';
    nextActionReason = 'Ready to admit: this creates the student record and the admission invoices.';
  } else if (followUps > 0) {
    stage = 'follow_up';
    nextAction = 'log_follow_up';
    nextActionReason = blockers.some((b) => b.code === 'placement_required')
      ? 'A placement assessment is required for this program — it runs right after admission.'
      : 'Keep nurturing: log the next contact and outcome.';
  } else {
    stage = 'lead';
    nextAction = 'log_follow_up';
    nextActionReason = 'New lead — log the first contact and gauge interest.';
  }

  if (!placementSatisfied && !admitted) {
    blockers.push({
      code: 'placement_required',
      reason: 'Placement is required for this program; the assessment starts after admission.',
    });
  }
  if (stage === 'admission' || stage === 'placement') {
    const index = blockers.findIndex((blocker) => blocker.code === 'placement_required');
    if (index >= 0) blockers.splice(index, 1);
  }

  return {
    stage,
    closed,
    nextAction,
    nextActionReason,
    blockers: dedupeBlockers(blockers),
    admission: {
      admitted,
      studentId: student?.id ?? null,
      studentCode: student?.student_code ?? null,
      studentStatus: student?.status ?? null,
    },
    placement,
    financial,
    enrollment,
  };
}

function dedupeBlockers(blockers: WorkflowBlocker[]): WorkflowBlocker[] {
  const seen = new Set<string>();
  const unique: WorkflowBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.code)) continue;
    seen.add(blocker.code);
    unique.push(blocker);
  }
  return unique;
}

/** Compact projection for list rows and pipeline aggregation. */
export interface VisitorWorkflowSummary {
  stage: ReceptionStage;
  closed: boolean;
  nextAction: ReceptionAction;
  blockers: Array<{ code: string; reason: string }>;
}

export function summarizeVisitorWorkflow(
  db: BetterSqlite3.Database,
  visitor: VisitorWorkflowRow,
): VisitorWorkflowSummary {
  const workflow = describeVisitorWorkflow(db, visitor);
  return {
    stage: workflow.stage,
    closed: workflow.closed,
    nextAction: workflow.nextAction,
    blockers: workflow.blockers.map(({ code, reason }) => ({ code, reason })),
  };
}
