/**
TOEFL House ERP — Business Rules Routes (Rule Engine)
============================================================
REST endpoints exposing cross-cutting rules to the frontend. Domain-owned
policies such as fees, promotion, attendance, and academic configuration are
resolved by their owning domain services and are not exposed as generic rules.

Access control:
- owner: full access (create/update/deactivate/delete/rollback any rule)
- manager: may create/update rules scoped to their own branch
- finance, registrar, head_of_department: read-only + evaluate (needed to compute fees)
- everyone authenticated: may evaluate rules (read-only, needed by
  registrar/finance screens to compute the fee/discount for a form)

@module routes/rules.routes
@license Apache-2.0
*/
import { Router } from 'express';
import { authenticate, authorize, canAccessBranchResource, requestHasRole , requirePermission } from '../middleware/auth.js';
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
 * their domain services/catalogs even if their historical rows still exist in
 * rule_definitions for backward compatibility.
 */
const CATEGORIES: RuleCategory[] = RULE_CATEGORY_META.map((item) => item.id);

const DOMAIN_OWNED_RULE_CATEGORIES = new Set<RuleCategory>(['fee', 'promotion', 'attendance', 'academic']);

/** Safely extracts user context required for rule mutations/evaluations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName || !user?.role) {
    throw new HttpError(403, 'User context is missing for rule operation.');
  }
  return user;
}

function requireRuleBranchAccess(req: import('express').Request, branchId: string | null | undefined) {
  if (branchId && !canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Rule belongs to another branch.');
  }
}

function assertValidCategory(category: unknown): asserts category is RuleCategory {
  if (typeof category !== 'string' || !CATEGORIES.includes(category as RuleCategory)) {
    throw new HttpError(400, `Invalid rule category. Allowed values: ${CATEGORIES.join(', ')}`);
  }
}

function assertRuleManagementCategory(category: RuleCategory): void {
  if (DOMAIN_OWNED_RULE_CATEGORIES.has(category)) {
    throw new HttpError(409, `The ${category} policy is managed by its domain owner (Academic Control Center or the relevant domain service), not the generic Rule Engine.`);
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

/** GET /api/rules?category=fee — list all rules in a category (branch-scoped for the caller unless owner requests all). */
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
    assertValidCategory(category);
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
    res.json(getRuleVersions(req.params.id));
  })
);

// ============================================================================
// §2 — CREATE / UPDATE / DEACTIVATE / DELETE
// ============================================================================

/** POST /api/rules — create a new rule (owner or manager; manager rules are auto-scoped to their branch). */
rulesRouter.post(
  '/',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { name, description, category, conditions, actions, priority, isActive, scopeBranchId } = req.body;
    
    if (!name || typeof name !== 'string') throw new HttpError(400, 'Rule name is required.');
    assertValidCategory(category);
    assertRuleManagementCategory(category);
    if (!Array.isArray(conditions)) throw new HttpError(400, 'Rule conditions must be an array (may be empty).');
    if (!Array.isArray(actions) || actions.length === 0) throw new HttpError(400, 'Every rule must have at least one action.');

    // Managers may only scope rules to their own branch; owner may set global (null) or any branch.
    const resolvedScopeBranchId = requestHasRole(req, 'general_manager') ? user.branchId : (scopeBranchId ?? null);

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

    // Managers may only edit rules belonging to their own branch. Global rules
    // are organization-wide configuration and are owner-managed.
    if (requestHasRole(req, 'general_manager') && existing.scopeBranchId !== user.branchId) {
      throw new HttpError(403, 'You are not allowed to edit rules outside your branch.');
    }

    const { name, description, conditions, actions, priority, isActive, scopeBranchId } = req.body;
    if (conditions !== undefined && !Array.isArray(conditions)) {
      throw new HttpError(400, 'Rule conditions must be an array.');
    }
    if (actions !== undefined && (!Array.isArray(actions) || actions.length === 0)) {
      throw new HttpError(400, 'Every rule must have at least one action.');
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
        scopeBranchId: requestHasRole(req, 'general_manager') ? user.branchId : scopeBranchId,
      },
      user.fullName
    );
    writeAudit(req, `Updated rule: ${updated.name} (version ${updated.version})`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(updated) });
    res.json(updated);
  })
);

/** POST /api/rules/:id/rollback — revert a rule to a previous version (owner only). */
rulesRouter.post(
  '/:id/rollback',
  authorize('owner'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { version } = req.body;
    if (typeof version !== 'number') throw new HttpError(400, 'Version number is required.');
    
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    
    const restored = rollbackRule(req.params.id, version, user.fullName);
    writeAudit(req, `Rolled back rule "${existing.name}" to version ${version}`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(restored) });
    res.json(restored);
  })
);

/** PATCH /api/rules/:id/deactivate — soft-delete (owner or manager for their own branch's rules). */
rulesRouter.patch(
  '/:id/deactivate',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    if (requestHasRole(req, 'general_manager') && existing.scopeBranchId !== user.branchId) {
      throw new HttpError(403, 'You are not allowed to deactivate rules outside your branch.');
    }
    
    deactivateRule(req.params.id, user.fullName);
    writeAudit(req, `Deactivated rule: ${existing.name}`, { oldValue: ruleSnapshot(existing), newValue: ruleSnapshot(getRuleById(req.params.id)) });
    res.json({ ok: true });
  })
);

/** DELETE /api/rules/:id — permanent delete, owner only. */
rulesRouter.delete(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = getRuleById(req.params.id);
    if (!existing) throw new HttpError(404, 'Rule not found.');
    assertRuleManagementCategory(existing.category);
    deleteRule(req.params.id);
    writeAudit(req, `Permanently deleted rule: ${existing.name}`, { oldValue: ruleSnapshot(existing) });
    res.json({ ok: true });
  })
);

// ============================================================================
// §3 — EVALUATION (read-only, used by operational screens)
// ============================================================================

/**
POST /api/rules/evaluate
Body: { category, data, branchId?, dryRun? }

Evaluates all active rules in a category against the given context and
returns the merged outputs (e.g. { placementTestFee: 0, discountPercent: 15 }).
Any authenticated user may call this — it's how the registration/finance
forms compute the correct fee/discount to show before submitting.
*/
rulesRouter.post(
  '/evaluate',
  requirePermission('Rule.View'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { category, data, dryRun } = req.body;
    
    const branchId = (req.body.branchId as string) || user.branchId;
    // Security precedence: deny unauthorized branch access before revealing
    // domain ownership or validating the supplied rule payload.
    requireRuleBranchAccess(req, branchId);
    assertValidCategory(category);
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
      dryRun: !!dryRun,
    });
    
    // Return 200 with the result object regardless of isBlocked,
    // so the frontend form can display the block reason gracefully.
    res.json(result);
  })
);

export default rulesRouter;