/**
TOEFL House ERP — Discount Authorization Routes (CFG-1)
============================================================
The write path for discount exceptions above the ordinary ceiling.

A Rule Engine rule is a CALCULATION. An authorization is a DECISION, made by a
named approver, against verified eligibility, with a reason and an expiry.
Before this module existed a branch manager could mint an arbitrary discount by
creating an unconditional rule (reproduced live at 95%); the rule engine was
acting as the authorization boundary, which it must never be.

Approval authority per category is defined once, in `discount-authority.ts`
(APPROVER_ROLE), and enforced here so it cannot drift between the two:
  FIRST_DEGREE_RELATIVE, SPONSORSHIP  -> owner   (up to 100%)
  COURSE_AMBASSADOR, SECOND_DEGREE_RELATIVE, FAMILY_OF_FOUR_PLUS -> manager

@module routes/discount-authorizations.routes
@license Apache-2.0
*/
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authenticate, authorize, hasLegacyRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { db } from '../db/connection.js';
import {
  APPROVER_ROLE,
  CATEGORY_MAX,
  type DiscountCategory,
} from '../core/configuration/discount-authority.js';

export const discountAuthorizationsRouter = Router();
discountAuthorizationsRouter.use(authenticate);

type ExceptionCategory = Exclude<DiscountCategory, 'ORDINARY'>;
const CATEGORIES = Object.keys(APPROVER_ROLE) as ExceptionCategory[];

/** List a student's authorizations (audit surface). */
discountAuthorizationsRouter.get(
  '/student/:studentId',
  authorize('owner', 'manager', 'finance'),
  ah(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM student_discount_authorizations
          WHERE student_id = ? ORDER BY created_at DESC`,
      )
      .all(req.params.studentId);
    res.json(rows);
  }),
);

/**
 * Grant an exception. The category decides who may approve it — a manager
 * cannot grant themselves a 100% sponsorship, and no caller can grant more
 * than the category maximum.
 */
discountAuthorizationsRouter.post(
  '/',
  authorize('owner', 'manager'),
  ah(async (req, res) => {
    const user = req.user!;
    const body = req.body as Record<string, unknown>;
    const category = String(body.category ?? '') as ExceptionCategory;
    if (!CATEGORIES.includes(category)) {
      throw new HttpError(400, `Category must be one of: ${CATEGORIES.join(', ')}.`);
    }

    const student = db
      .prepare('SELECT id, branch_id FROM students WHERE id = ?')
      .get(String(body.studentId ?? '')) as { id: string; branch_id: string } | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');

    // Approval authority. The owner may approve anything; a manager may only
    // approve the categories the policy assigns to them.
    const isOwner = hasLegacyRole(req, 'owner');
    if (APPROVER_ROLE[category] === 'owner' && !isOwner) {
      throw new HttpError(403, `${category} requires owner approval.`);
    }
    // A manager may only act inside their own branch. An authorization written
    // against another branch would be an unusable (and misleading) record,
    // because the resolver rejects cross-branch grants.
    if (!isOwner && user.branchId && student.branch_id !== user.branchId) {
      throw new HttpError(403, 'You may only authorize discounts for your own branch.');
    }

    const requested = Number(body.requestedPercent ?? body.approvedPercent ?? 0);
    const approvedRaw = Number(body.approvedPercent ?? 0);
    if (!Number.isFinite(approvedRaw) || approvedRaw < 0) {
      throw new HttpError(400, 'Approved percent must be zero or greater.');
    }
    const max = CATEGORY_MAX[category];
    if (approvedRaw > max) {
      throw new HttpError(400, `${category} may not exceed ${max}%.`);
    }
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'A reason is required for a discount exception.');

    const authId = randomUUID();
    db.prepare(
      `INSERT INTO student_discount_authorizations
         (id, student_id, category, requested_percent, approved_percent, eligibility_ref,
          approved_by, approved_by_user_id, approved_at, reason, evidence_ref, status,
          effective_from, effective_to, branch_id, source)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?,'active',?,?,?,?)`,
    ).run(
      authId,
      student.id,
      category,
      Number.isFinite(requested) ? requested : null,
      approvedRaw,
      body.eligibilityRef ? String(body.eligibilityRef) : null,
      user.fullName ?? user.username ?? null,
      user.userId ?? null,
      reason,
      body.evidenceRef ? String(body.evidenceRef) : null,
      body.effectiveFrom ? String(body.effectiveFrom) : null,
      body.effectiveTo ? String(body.effectiveTo) : null,
      student.branch_id,
      'manual',
    );

    writeAudit(req, 'discount_authorization.grant', {
      newValue: `${category} ${approvedRaw}% for student ${student.id}`,
      branchId: student.branch_id,
    });
    res.status(201).json({ ok: true, id: authId, category, approvedPercent: approvedRaw });
  }),
);

/**
 * Revoke an authorization. Revocation is forward-looking: already issued
 * invoices keep the figure they were charged at, but no NEW charge may use it.
 */
discountAuthorizationsRouter.post(
  '/:id/revoke',
  authorize('owner', 'manager'),
  ah(async (req, res) => {
    const row = db
      .prepare('SELECT id, category, branch_id FROM student_discount_authorizations WHERE id = ?')
      .get(req.params.id) as { id: string; category: ExceptionCategory; branch_id: string } | undefined;
    if (!row) throw new HttpError(404, 'Authorization not found.');

    const isOwner = hasLegacyRole(req, 'owner');
    if (APPROVER_ROLE[row.category] === 'owner' && !isOwner) {
      throw new HttpError(403, `${row.category} may only be revoked by an owner.`);
    }
    if (!isOwner && req.user!.branchId && row.branch_id !== req.user!.branchId) {
      throw new HttpError(403, 'You may only revoke authorizations in your own branch.');
    }

    db.prepare(
      `UPDATE student_discount_authorizations
          SET status = 'revoked', updated_at = datetime('now') WHERE id = ?`,
    ).run(row.id);
    writeAudit(req, 'discount_authorization.revoke', { oldValue: row.id, branchId: row.branch_id });
    res.json({ ok: true });
  }),
);
