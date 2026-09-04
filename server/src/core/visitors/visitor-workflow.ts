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

type PlacementRequirement = ReturnType<typeof resolvePlacementRequirement>;

interface StudentRef {
  id: string;
  student_code: string;
  status: string;
}

interface AttemptRef {
  status: string;
  outcome: string | null;
  recommended_level_id: string | null;
  override_level_id: string | null;
}

interface EnrollmentRef {
  id: string;
  class_id: string | null;
  class_name: string | null;
  level_name: string | null;
}

/** Every domain fact the derivation reads, already fetched. */
interface VisitorFacts {
  followUps: number;
  student?: StudentRef;
  attempt?: AttemptRef;
  recommendedLevelName: string | null;
  requirement: PlacementRequirement;
  financial: WorkflowFinancialState;
  enrollment: WorkflowEnrollmentState;
  eligibility?: { eligible: boolean; code: string; reason: string };
}

function chunks<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(count: number): string {
  return `(${Array.from({ length: count }, () => '?').join(',')})`;
}

/**
 * Derive the complete front-desk state for one lead from fetched facts. All
 * inputs are the canonical rows; no fact is invented or carried from the
 * visitor `stage` annotation, which records history rather than operational
 * truth.
 */
function deriveVisitorWorkflow(visitor: VisitorWorkflowRow, facts: VisitorFacts): VisitorWorkflow {
  const blockers: WorkflowBlocker[] = [];
  const { followUps, student, attempt, requirement, financial, enrollment } = facts;
  const closed = (visitor.stage ?? 'lead') === 'lost' && visitor.status !== 'registered';
  const admitted = Boolean(student) && visitor.status === 'registered';

  const placementStatus = visitor.placement_status ?? 'not_started';
  const placementRequired = requirement.mode === 'required' || requirement.mode === 'optional';
  const placementSatisfied =
    !placementRequired || placementStatus === 'completed' || placementStatus === 'waived';
  const recommendedLevelId = attempt
    ? (attempt.override_level_id ?? attempt.recommended_level_id)
    : null;
  const recommendedLevelName = facts.recommendedLevelName;

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

  let conversionEligible = false;
  if (!admitted && !closed && facts.eligibility) {
    const eligibility = facts.eligibility;
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

/**
 * Load every fact the derivation needs for a whole population in grouped
 * queries, then derive each person's state. The one-person form below is this
 * same path with a single row — there is no second derivation.
 */
export function describeVisitorWorkflows(
  db: BetterSqlite3.Database,
  visitors: VisitorWorkflowRow[],
): VisitorWorkflow[] {
  if (visitors.length === 0) return [];
  const ids = visitors.map((visitor) => visitor.id);

  const followUps = new Map<string, number>();
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT visitor_id, COUNT(*) AS c FROM visitor_followups WHERE visitor_id IN ${placeholders(part.length)} GROUP BY visitor_id`)
      .all(...part) as Array<{ visitor_id: string; c: number }>;
    for (const row of rows) followUps.set(row.visitor_id, Number(row.c));
  }

  const studentsByLead = new Map<string, StudentRef>();
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT id, student_code, status, lead_id FROM students WHERE lead_id IN ${placeholders(part.length)}`)
      .all(...part) as Array<StudentRef & { lead_id: string }>;
    for (const row of rows) studentsByLead.set(row.lead_id, row);
  }

  const latestAttempt = new Map<string, AttemptRef & { completed_at: string | null; attempt_number: number | null }>();
  for (const part of chunks(ids)) {
    const rows = db
      .prepare(`SELECT visitor_id, status, outcome, recommended_level_id, override_level_id, completed_at, attempt_number
                  FROM placement_assessment_attempts
                 WHERE visitor_id IN ${placeholders(part.length)} AND status = 'completed'`)
      .all(...part) as Array<AttemptRef & { visitor_id: string; completed_at: string | null; attempt_number: number | null }>;
    for (const row of rows) {
      const current = latestAttempt.get(row.visitor_id);
      const rank = `${row.completed_at ?? ''}|${String(row.attempt_number ?? 0).padStart(10, '0')}`;
      const currentRank = current ? `${current.completed_at ?? ''}|${String(current.attempt_number ?? 0).padStart(10, '0')}` : '';
      if (!current || rank > currentRank) latestAttempt.set(row.visitor_id, row);
    }
  }

  const levelNames = new Map<string, string>();
  const referencedLevelIds = [...new Set([...latestAttempt.values()].flatMap((attempt) => [attempt.recommended_level_id, attempt.override_level_id]).filter((id): id is string => Boolean(id)))];
  for (const part of chunks(referencedLevelIds)) {
    const rows = db
      .prepare(`SELECT id, name FROM levels WHERE id IN ${placeholders(part.length)}`)
      .all(...part) as Array<{ id: string; name: string }>;
    for (const row of rows) levelNames.set(row.id, row.name);
  }

  const students = [...studentsByLead.values()];
  const latestEnrollment = new Map<string, EnrollmentRef & { student_id: string; started_at: string | null }>();
  for (const part of chunks(students.map((student) => student.id))) {
    const rows = db
      .prepare(`SELECT e.id, e.student_id, e.class_id, c.name AS class_name, c.level AS level_name, e.started_at
                  FROM enrollments e
                  LEFT JOIN classes c ON c.id = e.class_id
                 WHERE e.student_id IN ${placeholders(part.length)}
                   AND e.status IN (${ACTIVE_ENROLLMENT_STATUSES.map((status) => `'${status}'`).join(', ')})
                   AND e.enrollment_type != 'extra'`)
      .all(...part) as Array<EnrollmentRef & { student_id: string; started_at: string | null }>;
    for (const row of rows) {
      const current = latestEnrollment.get(row.student_id);
      if (!current || (row.started_at ?? '') >= (current.started_at ?? '')) latestEnrollment.set(row.student_id, row);
    }
  }

  const requirements = new Map<string, PlacementRequirement>();
  const requirementFor = (visitor: VisitorWorkflowRow): PlacementRequirement => {
    const key = `${visitor.program_version_id ?? ''}|${visitor.branch_id ?? ''}`;
    let requirement = requirements.get(key);
    if (!requirement) {
      requirement = resolvePlacementRequirement(visitor.program_version_id ?? null, visitor.branch_id ?? null, null);
      requirements.set(key, requirement);
    }
    return requirement;
  };

  const financialFor = (student: StudentRef): WorkflowFinancialState => {
    const summary = getStudentNonTuitionSummary(db, student.id, ADMISSION_FEE_PURPOSES);
    const registration = summary.nonTuitionBreakdown.find((row) => row.purpose === 'registration');
    const placementFee = summary.nonTuitionBreakdown.find((row) => row.purpose === 'placement');
    const registrationOutstanding = registration?.outstanding ?? 0;
    const placementOutstanding = placementFee?.outstanding ?? 0;
    const totalOutstanding = registrationOutstanding + placementOutstanding;
    return { registrationOutstanding, placementOutstanding, totalOutstanding, cleared: totalOutstanding <= 0 };
  };

  return visitors.map((visitor) => {
    const student = studentsByLead.get(visitor.id);
    const attempt = latestAttempt.get(visitor.id);
    const recommendedLevelId = attempt ? (attempt.override_level_id ?? attempt.recommended_level_id) : null;
    const closed = (visitor.stage ?? 'lead') === 'lost' && visitor.status !== 'registered';
    const admitted = Boolean(student) && visitor.status === 'registered';

    let eligibility: VisitorFacts['eligibility'];
    if (!admitted && !closed) {
      const result = evaluateConversionEligibilityForVisitor(db, visitor, null, visitor.branch_id ?? null, Boolean(student));
      eligibility = { eligible: result.eligible, code: result.code, reason: result.reason };
    }

    const facts: VisitorFacts = {
      followUps: followUps.get(visitor.id) ?? 0,
      student,
      attempt,
      recommendedLevelName: recommendedLevelId ? (levelNames.get(recommendedLevelId) ?? null) : null,
      requirement: requirementFor(visitor),
      financial: student ? financialFor(student) : clearedFinancial,
      enrollment: student
        ? ((): WorkflowEnrollmentState => {
            const row = latestEnrollment.get(student.id);
            return row
              ? { activeEnrollmentId: row.id, classId: row.class_id, className: row.class_name, levelName: row.level_name }
              : noEnrollment;
          })()
        : noEnrollment,
      eligibility,
    };
    return deriveVisitorWorkflow(visitor, facts);
  });
}

/** The one-person form of the batch derivation above. */
export function describeVisitorWorkflow(
  db: BetterSqlite3.Database,
  visitor: VisitorWorkflowRow,
): VisitorWorkflow {
  return describeVisitorWorkflows(db, [visitor])[0];
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
