import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { assertMoney } from '../utils/money.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { getCatalogService } from '../core/academic/catalog-service.js';
import { resolveAuthorizedDiscount } from '../core/configuration/discount-authority.js';
import { partitionFeeSnapshot } from '../core/finance/invoicing.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { assertEnrollmentNotOnHold } from '../core/academic/academic-hold.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { assertStudentAccess } from '../core/rbac/abac.js';
import { hasPermissionForBranchWithActionScopes, isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { optionalText, requiredText, TEXT_LIMITS } from '../utils/textInput.js';
import { getStudentBalance } from '../utils/studentBalance.js';

export const journeyRouter = Router({ mergeParams: true });
journeyRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetStudentCore = db.prepare('SELECT id, full_name, branch_id, status, gender FROM students WHERE id = ?');
// This module does not write students.status. Lifecycle changes use their
// dedicated student and enrollment workflow authorities; this router appends
// notes only.

const engine = () => getJourneyEngine(db);

/** Safely extract user context required for mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for journey operation.');
  }
  return user;
}

function requireStudent(req: import('express').Request, studentId: string) {
  const row = stmtGetStudentCore.get(studentId) as any;
  if (!row) throw new HttpError(404, 'Student not found.');
  assertStudentAccess(req, studentId);
  return row;
}

function mayViewJourneyFinance(req: import('express').Request, branchId: string): boolean {
  return !!req.rbac && (
    isGlobalOwner(req.rbac)
    || hasPermissionForBranchWithActionScopes(
      db,
      req.rbac,
      branchId,
      ['Payment.View'],
      ['organization', 'campus', 'branch', 'department'],
    )
  );
}

/** Full chronological lifecycle timeline. */
journeyRouter.get(
  '/timeline',
  requirePermission('Student.View'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    res.json({
      studentId,
      timeline: engine().getTimeline(studentId, mayViewJourneyFinance(req, student.branch_id)),
    });
  })
);

/** Financial subset of the journey (ledger-style). */
journeyRouter.get(
  '/finance-timeline',
  requirePermission('Payment.View'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    if (!mayViewJourneyFinance(req, student.branch_id)) {
      throw new HttpError(403, 'Payment.View is not authorized for this student branch.');
    }
    res.json({
      studentId,
      timeline: engine().getFinancialTimeline(studentId),
    });
  })
);

/** Current lifecycle/enrollment state overlaid from canonical owning tables. */
journeyRouter.get(
  '/state',
  requirePermission('Student.View'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    requireStudent(req, studentId);
    res.json(engine().getCurrentState(studentId));
  })
);

/** Combined journey payload for UI drawers. */
journeyRouter.get(
  '/',
  requirePermission('Student.View'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    const j = engine();
    const mayViewFinance = mayViewJourneyFinance(req, student.branch_id);
    res.json({
      student: {
        id: student.id,
        fullName: student.full_name,
        status: student.status,
        branchId: student.branch_id,
      },
      state: j.getCurrentState(studentId),
      timeline: j.getTimeline(studentId, mayViewFinance),
      financialTimeline: mayViewFinance ? j.getFinancialTimeline(studentId) : [],
      ...(mayViewFinance ? { financeSummary: getStudentBalance(db, studentId, 'all') } : {}),
    });
  })
);

/**
 * Append an operator note to the journey.
 *
 * Status, placement, promotion and graduation facts have dedicated domain
 * writers. Accepting them here would recreate a shadow command path whose
 * payload is not backed by the owning workflow. This endpoint therefore owns
 * one capability only: a bounded, append-only note.
 */
journeyRouter.post(
  '/events',
  requirePermission('Student.Edit'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    const eventType = req.body?.eventType;
    if (eventType !== JourneyEventType.NOTE_ADDED) {
      throw new HttpError(400, 'Only journey.note_added may be appended manually.');
    }

    const rawPayload = req.body?.payload;
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      throw new HttpError(400, 'payload must be an object containing a note.');
    }
    const note = requiredText(rawPayload.note, 'Journey note', TEXT_LIMITS.notes);
    const enrollmentId = optionalText(req.body?.enrollmentId, 'Enrollment id', TEXT_LIMITS.short);
    if (enrollmentId) {
      const owner = db.prepare('SELECT student_id FROM enrollments WHERE id = ?').get(enrollmentId) as
        | { student_id: string }
        | undefined;
      if (!owner) throw new HttpError(404, 'Enrollment not found.');
      if (owner.student_id !== studentId) {
        throw new HttpError(409, 'Journey event enrollment belongs to another student.');
      }
    }

    let occurredAt: string | undefined;
    if (req.body?.occurredAt != null && req.body.occurredAt !== '') {
      const raw = requiredText(req.body.occurredAt, 'Occurred at', 40);
      const parsed = new Date(raw);
      if (!Number.isFinite(parsed.getTime())) {
        throw new HttpError(400, 'Occurred at must be a valid ISO date or timestamp.');
      }
      occurredAt = parsed.toISOString();
    }

    const item = engine().appendEvent({
      studentId,
      eventType,
      occurredAt,
      branchId: student.branch_id,
      enrollmentId,
      payload: { note },
      actorUserId: user.userId,
      actorName: user.fullName,
    });

    writeAudit(req, `Added journey note for student ${student.full_name}`);
    res.status(201).json(item);
  })
);

/** Create enrollment (new / repeat / partial_repeat / resume / jump). */
journeyRouter.post(
  '/enrollments',
  requirePermission('Class.Assign'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    
    const body = req.body ?? {};
    const programId = optionalText(body.programId, 'Program id', TEXT_LIMITS.short);
    const programName = optionalText(body.programName, 'Program name', TEXT_LIMITS.name);
    const semesterName = optionalText(body.semesterName, 'Semester name', TEXT_LIMITS.name);
    const levelCode = optionalText(body.levelCode, 'Level code', TEXT_LIMITS.short);
    const classId = optionalText(body.classId, 'Class id', TEXT_LIMITS.short);
    const programVersionId = optionalText(body.programVersionId, 'Program version id', TEXT_LIMITS.short);
    const levelId = optionalText(body.levelId, 'Level id', TEXT_LIMITS.short);
    const notes = optionalText(body.notes, 'Enrollment notes', TEXT_LIMITS.notes);
    const enrollmentType = (body.enrollmentType == null
      ? 'new'
      : requiredText(body.enrollmentType, 'Enrollment type', 30)) as
        'new' | 'repeat' | 'partial_repeat' | 'resume' | 'jump' | 'extra';
    if (!['new', 'repeat', 'partial_repeat', 'resume', 'jump', 'extra'].includes(enrollmentType)) {
      throw new HttpError(400, 'Invalid enrollment type.');
    }
    if (body.autoInvoice != null && typeof body.autoInvoice !== 'boolean') {
      throw new HttpError(400, 'autoInvoice must be a boolean.');
    }
    let skillsFocus: string[] | null = null;
    if (body.skillsFocus != null) {
      if (!Array.isArray(body.skillsFocus) || body.skillsFocus.length > 20) {
        throw new HttpError(400, 'Skills focus must be an array of at most 20 items.');
      }
      skillsFocus = body.skillsFocus.map((skill: unknown, index: number) =>
        requiredText(skill, `Skill ${index + 1}`, TEXT_LIMITS.short));
    }
    if (classId) assertClassGenderAllowsStudent(classId, student.gender);

    // ACADEMIC HOLD — the same debt gate the class and semester desks apply.
    // This surface previously had no hold check at all, so a student blocked
    // at either desk could enroll through the journey. Lifetime-scoped, with
    // the resume exception for re-opening a term the student already holds
    // (see core/academic/academic-hold.ts).
    assertEnrollmentNotOnHold(req, {
      studentId, branchId: student.branch_id, classId, semesterName,
    });
    const classLevel = classId
      ? db.prepare('SELECT level_id FROM classes WHERE id = ?').get(classId) as { level_id: string | null } | undefined
      : undefined;
    if (levelId && classLevel?.level_id && levelId !== classLevel.level_id) {
      throw new HttpError(400, 'Class and enrollment level must match.');
    }
    const effectiveLevelId = classLevel?.level_id ?? levelId ?? null;

    const { autoInvoice, discountAmount } = body;

    // JRN-1. This route accepted an absolute AFN discount and handed it to
    // EnrollmentService, whose only bound is `discount <= fee`. A registrar
    // could therefore waive 100% of tuition: reproduced live on a 10,000 AFN
    // class for a student with no authorization row — discountAmount 10000
    // returned 201 and wrote invoice 10000/10000/0. Every other tuition
    // discount path (students.routes manual create + new semester, visitors
    // conversion) resolves the ceiling through resolveAuthorizedDiscount, the
    // canonical CFG-1 authority; this one did not call it at all. The parity
    // control: the same registrar sending discountPercent 100 to
    // POST /students/manual is clamped to a stored 20.
    //
    // The requested amount is converted to a percent of the SAME fee snapshot
    // the service will price the invoice from — built here through the shared
    // catalog authority rather than recomputed — and bounded by whatever the
    // authority permits for this student, branch and category.
    //
    // Fail-closed rather than clamp: the caller stated an explicit AFN figure,
    // so silently substituting a smaller one would report success for a price
    // nobody authorised. The sibling money routes (book sale, invoice) also
    // reject an over-large discount instead of capping it. students.routes
    // clamps a *percent it derived itself* from the rule engine, which is a
    // different act — there the caller never named an amount.
    // THE DISCOUNT THE ENROLMENT ACTUALLY CARRIES. Two defects converged here:
    //
    // 1. A STANDING authorization was ignored: with no explicit discountAmount
    //    the route forwarded 0, so a student with an approved sponsorship or
    //    family grant paid full price on this surface while the desk surfaces
    //    (enroll-semester, manual create) applied the same grant — two prices
    //    for the same student, decided by which screen enrolled them.
    // 2. The explicit-amount ceiling was derived from the CATALOG snapshot,
    //    but the charge is priced from the CLASS fee when a class is named —
    //    the ceiling and the invoice could disagree.
    //
    // The basis is therefore the tuition this enrolment will actually charge
    // (class fee replacing the semester component, exactly as the service
    // prices it), the percent is resolved through the same CFG-1 authority the
    // desk uses, and an explicit AFN figure — when the caller insists on one —
    // must still fit inside that authority's ceiling.
    const resolvedLevelId = effectiveLevelId;
    const level = resolvedLevelId
      ? (db.prepare('SELECT program_version_id FROM levels WHERE id = ?').get(resolvedLevelId) as { program_version_id?: string } | undefined)
      : undefined;
    const snapshot = getCatalogService(db).buildFeeSnapshot({
      programVersionId: programVersionId || level?.program_version_id || null,
      levelId: resolvedLevelId,
      branchId: student.branch_id,
      enrollmentType: enrollmentType || 'new',
    });
    // The ceiling is a percentage of the TUITION, not of the whole snapshot.
    // A discount attaches to tuition only (owner decision on WP07-F18), so
    // basing the ceiling on a total that includes the registration fee would
    // authorise more discount than there is tuition to discount.
    const partitioned = partitionFeeSnapshot(snapshot.fees);
    const semesterComponent = partitioned.tuitionFees
      .filter((fee) => fee.feeType === 'semester')
      .reduce((total, fee) => total + (Number(fee.amount) || 0), 0);
    let tuitionBasis = partitioned.tuitionTotal;
    if (classId) {
      const classRow = db.prepare('SELECT fee FROM classes WHERE id = ?').get(classId) as { fee: number | null } | undefined;
      const classFee = Number(classRow?.fee ?? 0) || 0;
      tuitionBasis = classFee + (partitioned.tuitionTotal - semesterComponent);
    }
    const requestedDiscount = discountAmount != null ? assertMoney(discountAmount, 'discount amount') : 0;
    // THE CEILING probe asks "what is the most this student could ever be
    // granted" — for an unexceptional student that is the ORDINARY policy cap
    // (20%), which is a bound for on-request discounts, not an automatic grant.
    const ceiling = resolveAuthorizedDiscount(db, studentId, 100, { branchId: student.branch_id });
    const maxDiscount = Math.round((tuitionBasis * ceiling.percent) / 100);
    if (requestedDiscount > maxDiscount) {
      throw new HttpError(
        400,
        `Discount of ${requestedDiscount} AFN exceeds the authorized maximum of ${maxDiscount} AFN (${ceiling.percent}% of ${tuitionBasis} AFN tuition) for this student.`,
      );
    }
    // THE STANDING discount asks "what does this student already carry" — an
    // approved authorization row, or the stored policy percent the desk
    // surfaces resolve the same way. For a student with neither, this is 0 and
    // the enrolment prices at full fee unless the caller explicitly asks.
    const standing = resolveAuthorizedDiscount(db, studentId, Math.max(0, Number(student.discount_percent || 0)), { branchId: student.branch_id });
    const standingDiscount = Math.round((tuitionBasis * standing.percent) / 100);
    // No explicit figure: the standing authorization prices the enrolment, in
    // parity with the desk surfaces. Explicit figure: honoured as asked.
    const effectiveDiscount = requestedDiscount > 0 ? requestedDiscount : standingDiscount;
    
    const result = getEnrollmentService(db).enroll({
      studentId,
      branchId: student.branch_id,
      programId,
      programName,
      programVersionId: programVersionId || null,
      levelId: effectiveLevelId,
      semesterName,
      levelCode,
      classId,
      enrollmentType,
      skillsFocus,
      notes,
      actorUserId: user.userId,
      actorName: user.fullName,
      autoInvoice: autoInvoice !== false,
      discountAmount: effectiveDiscount,
      includeRegistrationFee: false,
    });

    writeAudit(req, `Enrollment ${result.enrollmentId} for student ${student.full_name}`);
    res.status(201).json(result);
  })
);

export default journeyRouter;