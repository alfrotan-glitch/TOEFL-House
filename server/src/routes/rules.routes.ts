/**
TOEFL House ERP — Business Rules Routes (Rule Engine)
============================================================
REST endpoints exposing cross-cutting rules to the frontend. Domain-owned
policies such as fees, promotion, attendance, and academic configuration are
resolved by their owning domain services and are not exposed as generic rules.

Access control:
- an organization-scoped Owner may manage global rules or any branch rule;
- a scoped Owner or General Manager may manage only rules in branches reached
  by live assignments (campus and multi-branch assignments are honored);
- the declared read roles may inspect authorized generic rules;
- evaluation requires Rule.View and an authorized branch. It may append matched
  rule logs unless dryRun is true.

@module routes/rules.routes
@license Apache-2.0
*/
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, canAccessBranchResource, requirePermission } from '../middleware/auth.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import {
  evaluateRules,
  createRule,
  updateRule,
  deactivateRule,
  deleteRule,
  getRulesByCategory,
  getRuleById,
  getRuleVersions,
  rollbackRule,
  validateRuleParts,
  RuleCategory,
} from '../core/configuration/rule-engine.js';

export const rulesRouter = Router();
rulesRouter.use(authenticate);

const RULE_CATEGORY_META: ReadonlyArray<{ id: RuleCategory; label: string; managementOwner: 'cross-cutting'; editable: true }> = [
  { id: 'discount', label: 'Discounts', managementOwner: 'cross-cutting', editable: true },
  { id: 'payroll', label: 'Payroll', managementOwner: 'cross-cutting', editable: true },
  { id: 'scholarship', label: 'Scholarships', managementOwner: 'cross-cutting', editable: true },
  { id: 'finance', label: 'Finance', managementOwner: 'cross-cutting', editable: true },
  { id: 'workflow', label: 'Workflows', managementOwner: 'cross-cutting', editable: true },
  { id: 'notification', label: 'Notifications', managementOwner: 'cross-cutting', editable: true },
];

/**
 * Generic Rule Engine ownership boundary. Domain-owned policies remain in
 * their domain services/catalogs; a `rule_definitions` row in one of those
 * categories is descriptive and is not the authority.
 */
const CATEGORIES: RuleCategory[] = RULE_CATEGORY_META.map((item) => item.id);
const ALL_RULE_CATEGORIES: RuleCategory[] = ['fee', 'discount', 'promotion', 'attendance', 'payroll', 'scholarship', 'workflow', 'notification', 'finance', 'academic'];

const DOMAIN_OWNED_RULE_CATEGORIES = new Set<RuleCategory>(['fee', 'promotion', 'attendance', 'academic']);

/** Safely extracts user context required for rule mutations/evaluations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for rule operation.');
  }
  return user;
}

function requireRuleBranchAccess(req: import('express').Request, branchId: string | null | undefined) {
  if (branchId && !canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Rule belongs to another branch.');
  }
}

function assertKnownCategory(category: unknown): asserts category is RuleCategory {
  if (typeof category !== 'string' || !ALL_RULE_CATEGORIES.includes(category as RuleCategory)) {
    throw new HttpError(400, `Invalid rule category. Allowed generic values: ${CATEGORIES.join(', ')}`);
  }
}

function assertRuleManagementCategory(category: RuleCategory): void {
  if (DOMAIN_OWNED_RULE_CATEGORIES.has(category)) {
    throw new HttpError(409, `The ${category} policy is managed by its domain owner (Academic Control Center or the relevant domain service), not the generic Rule Engine.`);
  }
  if (!CATEGORIES.includes(category)) {
    throw new HttpError(409, `The ${category} category has no generic management contract.`);
  }
}

function isOrganizationOwner(req: import('express').Request): boolean {
  return !!req.rbac && isGlobalOwner(req.rbac);
}

function assertExistingRuleBranch(branchId: string): void {
  const branch = db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new HttpError(400, 'Rule scope branch does not exist.');
}

function requireRuleMutationAccess(req: import('express').Request, branchId: string | null | undefined): void {
  if (isOrganizationOwner(req)) {
    if (branchId) assertExistingRuleBranch(branchId);
    return;
  }
  if (!branchId) throw new HttpError(403, 'Only an organization-scoped owner may mutate a global rule.');
  assertExistingRuleBranch(branchId);
  requireRuleBranchAccess(req, branchId);
}

function resolveCreateScope(req: import('express').Request, requested: unknown, fallbackBranchId: string): string | null {
  if (isOrganizationOwner(req)) {
    if (requested === undefined || requested === null || requested === '') return null;
    if (typeof requested !== 'string') throw new HttpError(400, 'Rule scope branch must be a branch id or null.');
    requireRuleMutationAccess(req, requested);
    return requested;
  }
  const branchId = requested === undefined || requested === null || requested === '' ? fallbackBranchId : requested;
  if (typeof branchId !== 'string') throw new HttpError(400, 'Rule scope branch must be a branch id.');
  requireRuleMutationAccess(req, branchId);
  return branchId;
}

function assertValidRuleParts(conditions: unknown, actions: unknown): void {
  try {
    validateRuleParts(conditions, actions);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid rule definition.');
  }
}

/**
 * The decision-bearing fields of a rule, for before/after audit capture.
 *
 * Rule changes were audited by NAME only ("Updated rule: Discount Cap 30%"),
 * with old_value and new_value both null. For configuration that governs money
 * — `rule_default_discount_cap` sets the institutional discount ceiling — that
 * is not an audit trail: it records that something changed, not what it
 * changed from or to, so an unauthorised or mistaken edit is untraceable.
 */
function ruleSnapshot(rule: unknown): string {
  const r = rule as Record<string, unknown> | null | undefined;
  if (!r) return JSON.stringify(null);
  return JSON.stringify({
    id: r.id,
    name: r.name,
    category: r.category,
    conditions: r.conditions,
    actions: r.actions,
    priority: r.priority,
    isActive: r.isActive,
    scopeBranchId: r.scopeBranchId,
    version: r.version,
  });
}

rulesRouter.get('/meta', authorize('owner', 'general_manager', 'finance_manager', 'receptionist', 'head_of_department'), ah(async (_req, res) => {
  res.json({ categories: RULE_CATEGORY_META });
}));

// ============================================================================
// §1 — LIST / READ
// ============================================================================

/** GET /api/rules?category=discount&branchId=... — list global fallback plus selected authorized-branch rules. */
rulesRouter.get(
  '/',
  authorize('owner', 'general_manager', 'finance_manager', 'receptionist', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const category = req.query.category;
    const branchId = (req.query.branchId as string) || user.branchId;
    // Security precedence: deny unauthorized branch access before revealing
    // category validity or domain ownership (same rule as POST /evaluate).
    requireRuleBranchAccess(req, branchId);
    assertKnownCategory(category);
    if (DOMAIN_OWNED_RULE_CATEGORIES.has(category)) {
      throw new HttpError(409, `The ${category} policy is domain-owned and is not exposed by the generic Rule Engine.`);
    }
    res.json(getRulesByCategory(category, branchId));
  })
);

/** GET /api/rules/:id — single rule with full detail. */
rulesRouter.get(
  '/:id',
  authorize('owner', 'general_manager', 'finance_manager', 'receptionist', 'head_of_department'),
  ah(async (req, res) => {
    const rule = getRuleById(req.params.id);
    if (!rule) throw new HttpError(404, 'Rule not found.');
    requireRuleBranchAccess(req, rule.scopeBranchId);
    assertRuleManagementCategory(rule.category);
    res.json(rule);
  })
);

/** GET /api/rules/:id/versions — full version history for rollback UI. */
rulesRouter.get(
  '/:id/versions',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const rule = getRuleById(req.params.id);
    if (!rule) throw new HttpError(404, 'Rule not found.');
    requireRuleBranchAccess(req, rule.scopeBranchId);
    assertRuleManagementCategory(rule.category);
    res.json(getRuleVersions(req.params.id));
  })
);

// ============================================================================
// §2 — CREATE / UPDATE / DEACTIVATE / DELETE
// ============================================================================

/** POST /api/rules — create a global rule as organization Owner, or an authorized branch rule as a scoped writer. */
rulesRouter.post(
  '/',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { name, description, category, conditions, actions, priority, isActive, scopeBranchId } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Rule name is required.');
    assertKnownCategory(category);
    assertRuleManagementCategory(category);
    assertValidRuleParts(conditions, actions);
    if (description !== undefined && typeof description !== 'string') {
      throw new HttpError(400, 'Rule description must be text.');
    }
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      throw new HttpError(400, 'Rule priority must be a finite number.');
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      throw new HttpError(400, 'Rule active state must be a boolean.');
    }

    const resolvedScopeBranchId = resolveCreateScope(req, scopeBranchId, user.branchId);

    const rule = createRule(
      {
        name,
        description: description || '',
        category,
        conditions,
        actions,
        priority: typeof priority === 'number' ? priority : 0,
        isActive: isActive !== undefined ? !!isActive : true,
        scopeBranchId: resolvedScopeBranchId,
        lastModifiedBy: user.fullName,
      },
      user.fullName
    );
    writeAudit(req, `Created new rule: ${rule.name} (category: ${rule.category})`, { newValue: ruleSnapshot(rule) });
    res.status(201).json(rule);
  })
);

/** PATCH /api/rules/:id — update a rule; creates a new version snapshot automatically. */
rulesRouter.patch(
  '/:id',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);

    requireRuleMutationAccess(req, existing.scopeBranchId);

    const { name, description, conditions, actions, priority, isActive, scopeBranchId } = req.body ?? {};
    const nextConditions = conditions ?? existing.conditions;
    const nextActions = actions ?? existing.actions;
    assertValidRuleParts(nextConditions, nextActions);
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      throw new HttpError(400, 'Rule name cannot be empty.');
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new HttpError(400, 'Rule description must be text.');
    }
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      throw new HttpError(400, 'Rule priority must be a finite number.');
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      throw new HttpError(400, 'Rule active state must be a boolean.');
    }

    let nextScope = existing.scopeBranchId;
    if (scopeBranchId !== undefined) {
      if (isOrganizationOwner(req)) {
        if (scopeBranchId !== null && typeof scopeBranchId !== 'string') {
          throw new HttpError(400, 'Rule scope branch must be a branch id or null.');
        }
        nextScope = scopeBranchId || null;
      } else {
        if (typeof scopeBranchId !== 'string' || !scopeBranchId) {
          throw new HttpError(403, 'Only an organization-scoped owner may make a rule global.');
        }
        nextScope = scopeBranchId;
      }
      requireRuleMutationAccess(req, nextScope);
    }

    const updated = updateRule(
      req.params.id,
      {
        name,
        description,
        conditions,
        actions,
        priority,
        isActive,
        scopeBranchId: nextScope,
      },
      user.fullName
    );
    writeAudit(req, `Updated rule: ${updated.name} (version ${updated.version})`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(updated) });
    res.json(updated);
  })
);

/** POST /api/rules/:id/rollback — an Owner reverts a version within that Owner assignment's effective scope. */
rulesRouter.post(
  '/:id/rollback',
  authorize('owner'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { version } = req.body ?? {};
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'A positive integer version number is required.');

    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    requireRuleMutationAccess(req, existing.scopeBranchId);
    if (!getRuleVersions(req.params.id).some((candidate) => candidate.version === version)) {
      throw new HttpError(404, `Rule version ${version} was not found.`);
    }

    const restored = rollbackRule(req.params.id, version, user.fullName);
    writeAudit(req, `Rolled back rule "${existing.name}" to version ${version}`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(restored) });
    res.json(restored);
  })
);

/** PATCH /api/rules/:id/deactivate — versioned soft-delete within the writer's effective assignment scope. */
rulesRouter.patch(
  '/:id/deactivate',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    requireRuleMutationAccess(req, existing.scopeBranchId);

    const deactivated = deactivateRule(req.params.id, user.fullName);
    writeAudit(req, `Deactivated rule: ${existing.name}`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(deactivated) });
    res.json({ ok: true });
  })
);

/** DELETE /api/rules/:id — an Owner permanently deletes only within that Owner assignment's effective scope. */
rulesRouter.delete(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    requireRuleMutationAccess(req, existing.scopeBranchId);
    deleteRule(req.params.id);
    writeAudit(req, `Permanently deleted rule: ${existing.name}`, { oldValue: ruleSnapshot(existing) });
    res.json({ ok: true });
  })
);

// ============================================================================
// §3 — EVALUATION (operational result plus matched-rule log unless dry-run)
// ============================================================================

/**
POST /api/rules/evaluate
Body: { category, data, branchId?, dryRun? }

Evaluates all active rules in a category against the given context and
returns the merged outputs (e.g. { placementTestFee: 0, discountPercent: 15 }).
A principal holding Rule.View may call this for an authorized branch. Domain-owned
categories remain unavailable through this generic adapter.
*/
rulesRouter.post(
  '/evaluate',
  requirePermission('Rule.View'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { category, data, dryRun, branchId: requestedBranchId } = req.body ?? {};
    if (requestedBranchId !== undefined &&
        (typeof requestedBranchId !== 'string' || !requestedBranchId)) {
      throw new HttpError(400, 'Evaluation branchId must be a branch id.');
    }
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      throw new HttpError(400, 'Evaluation dryRun must be a boolean.');
    }

    const branchId = requestedBranchId || user.branchId;
    // Security precedence: deny unauthorized branch access before revealing
    // domain ownership or validating the supplied rule payload.
    requireRuleBranchAccess(req, branchId);
    assertKnownCategory(category);
    if (DOMAIN_OWNED_RULE_CATEGORIES.has(category)) {
      throw new HttpError(409, `The ${category} policy is domain-owned and must be evaluated by its owning domain service.`);
    }
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      throw new HttpError(400, 'Evaluation data must be an object.');
    }
    const result = evaluateRules({
      category,
      branchId,
      data: data || {},
      dryRun: dryRun ?? false,
    });
    
    // Return 200 with the result object regardless of isBlocked,
    // so the frontend form can display the block reason gracefully.
    res.json(result);
  })
);

export default rulesRouter;