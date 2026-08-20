/**
TOEFL House ERP — Workflow Routes (BC #13)
============================================================
REST endpoints for the Workflow Bounded Context: definitions,
instances, step approvals/rejections, cancellation, triggering,
and full audit history.
*/
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, requestHasRole, canAccessBranchResource } from '../middleware/auth.js';
import { ROLE_CODES, type RoleCode } from '../core/rbac/permission-catalog.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { eventBus } from '../core/events/event-bus.js';

export const workflowsRouter = Router();
workflowsRouter.use(authenticate);

// ── Type Definitions ───────────────────────────────────────────────────────
interface DefinitionRow {
  id: string; name: string; trigger: string; steps: string;
  is_active: number; created_at: string; updated_at: string;
}

interface InstanceRow {
  id: string; definition_id: string; entity_type: string; entity_id: string;
  current_step: number; status: string; branch_id: string; initiated_by: string;
  started_at: string; completed_at: string | null; payload: string;
}

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtGetAllDefinitions = db.prepare('SELECT * FROM workflow_definitions ORDER BY created_at DESC');
const stmtGetDefinitionById = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?');
const stmtInsertDefinition = db.prepare(
  `INSERT INTO workflow_definitions (id, name, trigger, steps, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`
);
const stmtUpdateDefinition = db.prepare(
  `UPDATE workflow_definitions SET name = ?, steps = ?, is_active = ?, updated_at = ? WHERE id = ?`
);

const stmtGetInstanceById = db.prepare('SELECT * FROM workflow_instances WHERE id = ?');
const stmtInsertInstance = db.prepare(
  `INSERT INTO workflow_instances (id, definition_id, entity_type, entity_id, current_step, status, branch_id, initiated_by, started_at, payload) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)`
);
const stmtUpdateInstanceStep = db.prepare(`UPDATE workflow_instances SET current_step = ?, status = 'in_progress' WHERE id = ?`);
const stmtUpdateInstanceStatus = db.prepare(`UPDATE workflow_instances SET status = ?, completed_at = ? WHERE id = ?`);

const stmtInsertHistory = db.prepare(
  `INSERT INTO workflow_history (id, instance_id, step_order, actor, action, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetHistoryByInstance = db.prepare('SELECT * FROM workflow_history WHERE instance_id = ? ORDER BY timestamp ASC');

const stmtGetPendingInstances = db.prepare(
  `SELECT wi.*, wd.name as definition_name, wd.steps as definition_steps 
   FROM workflow_instances wi 
   JOIN workflow_definitions wd ON wd.id = wi.definition_id 
   WHERE wi.branch_id = ? AND wi.status = 'in_progress' 
   ORDER BY wi.started_at ASC`
);

// Helper to safely parse JSON
/**
 * Workflow step roles are data, so they can name a role that does not exist —
 * a typo, or a definition written against an older vocabulary. Such a step can
 * never be satisfied by anyone, which would otherwise surface as an ordinary
 * "you are not allowed" 403 and send the operator hunting for a permission
 * problem that is really a broken definition. Say which it is.
 */
function assertKnownStepRole(role: string, stepOrder: number): RoleCode {
  if (!(ROLE_CODES as readonly string[]).includes(role)) {
    throw new HttpError(
      409,
      `Workflow step ${stepOrder} names role "${role}", which is not a role in this system. The workflow definition must be corrected.`,
    );
  }
  return role as RoleCode;
}

const parseSteps = (stepsJson: string): any[] => {
  try { return JSON.parse(stepsJson) || []; } 
  catch { return []; }
};

// Helper to enforce branch scope
const ENTITY_BRANCH_QUERIES: Record<string, string> = {
  student: 'SELECT branch_id AS branchId FROM students WHERE id = ?', visitor: 'SELECT branch_id AS branchId FROM visitors WHERE id = ?', class: 'SELECT branch_id AS branchId FROM classes WHERE id = ?',
  teacher: 'SELECT branch_id AS branchId FROM teachers WHERE id = ?', employee: 'SELECT branch_id AS branchId FROM employees WHERE id = ?', payment: 'SELECT branch_id AS branchId FROM payments WHERE id = ?',
  invoice: 'SELECT branch_id AS branchId FROM invoices WHERE id = ?', expense_request: 'SELECT branch_id AS branchId FROM expense_requests WHERE id = ?', book: 'SELECT branch_id AS branchId FROM books WHERE id = ?',
  book_sale: 'SELECT branch_id AS branchId FROM book_sales WHERE id = ?', exam: 'SELECT branch_id AS branchId FROM exams WHERE id = ?', enrollment: 'SELECT branch_id AS branchId FROM enrollments WHERE id = ?', campaign: 'SELECT branch_id AS branchId FROM campaigns WHERE id = ?'
};
function resolveEntityBranch(entityType: string, entityId: string): string {
  const sql = ENTITY_BRANCH_QUERIES[entityType.toLowerCase()];
  if (!sql) throw new HttpError(400, `Workflow entity type '${entityType}' is not allowed.`);
  const row = db.prepare(sql).get(entityId) as { branchId?: string } | undefined;
  if (!row?.branchId) throw new HttpError(404, `Workflow entity '${entityType}#${entityId}' was not found or has no branch ownership.`);
  return row.branchId;
}

function assertBranchAccess(req: import('express').Request, instanceBranchId: string) {
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && instanceBranchId !== branchId) {
    throw new HttpError(403, 'You do not have permission to access workflows from this branch.');
  }
}

// ============================================================================
// §1 — WORKFLOW DEFINITIONS
// ============================================================================

workflowsRouter.get('/definitions', requirePermission('Workflow.View'), ah(async (_req, res) => {
  const rows = stmtGetAllDefinitions.all() as DefinitionRow[];
  res.json(rows.map(r => ({
    id: r.id, name: r.name, trigger: r.trigger,
    steps: parseSteps(r.steps), isActive: !!r.is_active,
    createdAt: r.created_at, updatedAt: r.updated_at,
  })));
}));

workflowsRouter.get('/definitions/:id', requirePermission('Workflow.View'), ah(async (req, res) => {
  const row = stmtGetDefinitionById.get(req.params.id) as DefinitionRow | undefined;
  if (!row) throw new HttpError(404, 'Workflow definition not found.');
  res.json({
    id: row.id, name: row.name, trigger: row.trigger,
    steps: parseSteps(row.steps), isActive: !!row.is_active,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}));

workflowsRouter.post('/definitions', authorize('owner'), ah(async (req, res) => {
  const { name, trigger, steps } = req.body;
  if (!name || !trigger || !Array.isArray(steps) || steps.length === 0) {
    throw new HttpError(400, 'Name, trigger, and at least one step are required.');
  }
  const sanitizedSteps = steps.map((step: any, index: number) => {
    if (!step.role || !step.action) {
      throw new HttpError(400, `Step ${index + 1} must have a "role" and an "action".`);
    }
    if (!['approve', 'review', 'notify', 'execute'].includes(step.action)) {
      throw new HttpError(400, `Step ${index + 1} has an invalid action "${step.action}".`);
    }
    return { ...step, order: index + 1 }; // Force sequential order
  });

  const newId = id('wfd');
  const now = new Date().toISOString();
  stmtInsertDefinition.run(newId, name, trigger, JSON.stringify(sanitizedSteps), now, now);
  
  writeAudit(req, `Created workflow definition: ${name} (trigger: ${trigger})`);
  res.status(201).json({ id: newId });
}));

workflowsRouter.patch('/definitions/:id', authorize('owner'), ah(async (req, res) => {
  const existing = stmtGetDefinitionById.get(req.params.id) as DefinitionRow | undefined;
  if (!existing) throw new HttpError(404, 'Workflow definition not found.');
  
  const { name, steps, isActive } = req.body;
  const now = new Date().toISOString();
  
  stmtUpdateDefinition.run(
    name ?? existing.name,
    steps ? JSON.stringify(steps.map((s: any, i: number) => ({ ...s, order: i + 1 }))) : existing.steps,
    isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
    now,
    req.params.id
  );
  
  writeAudit(req, `Updated workflow definition: ${existing.name}`);
  res.json({ ok: true });
}));

// ============================================================================
// §2 — WORKFLOW INSTANCES
// ============================================================================

workflowsRouter.get('/instances', ah(async (req, res) => {
  const { status, entityType, entityId } = req.query as Record<string, string>;
  const { branchId, isAll } = resolveBranchScope(req);
  
  let sql = 'SELECT * FROM workflow_instances WHERE 1=1';
  const params: any[] = [];
  
  if (!isAll && branchId) {
    sql += ' AND branch_id = ?';
    params.push(branchId);
  }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (entityType) { sql += ' AND entity_type = ?'; params.push(entityType); }
  if (entityId) { sql += ' AND entity_id = ?'; params.push(entityId); }
  
  sql += ' ORDER BY started_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params) as InstanceRow[];
  
  res.json(rows.map(r => ({
    id: r.id, definitionId: r.definition_id, entityType: r.entity_type, entityId: r.entity_id,
    currentStep: r.current_step, status: r.status, branchId: r.branch_id,
    initiatedBy: r.initiated_by, startedAt: r.started_at, completedAt: r.completed_at,
    payload: JSON.parse(r.payload || '{}'),
  })));
}));

workflowsRouter.get('/instances/:id', ah(async (req, res) => {
  const row = stmtGetInstanceById.get(req.params.id) as InstanceRow | undefined;
  if (!row) throw new HttpError(404, 'Workflow instance not found.');
  assertBranchAccess(req, row.branch_id);

  const historyRows = stmtGetHistoryByInstance.all(req.params.id) as any[];
  const definition = stmtGetDefinitionById.get(row.definition_id) as DefinitionRow | undefined;
  
  res.json({
    id: row.id, definitionId: row.definition_id, definitionName: definition?.name || 'Unknown',
    entityType: row.entity_type, entityId: row.entity_id, currentStep: row.current_step,
    status: row.status, branchId: row.branch_id, initiatedBy: row.initiated_by,
    startedAt: row.started_at, completedAt: row.completed_at,
    payload: JSON.parse(row.payload || '{}'),
    steps: definition ? parseSteps(definition.steps) : [],
    history: historyRows.map(h => ({
      id: h.id, stepOrder: h.step_order, actor: h.actor, action: h.action, notes: h.notes, timestamp: h.timestamp,
    })),
  });
}));

// ============================================================================
// §3 — TRIGGER / START A WORKFLOW
// ============================================================================

workflowsRouter.post('/trigger', requirePermission('Workflow.Trigger'), authorize('owner', 'general_manager'), ah(async (req, res) => {
  const { definitionId, entityType, entityId, payload } = req.body;
  if (!definitionId || !entityType || !entityId) {
    throw new HttpError(400, 'definitionId, entityType, and entityId are required.');
  }
  
  const definition = stmtGetDefinitionById.get(definitionId) as DefinitionRow | undefined;
  if (!definition) throw new HttpError(404, 'Workflow definition not found.');
  if (!definition.is_active) throw new HttpError(409, 'This workflow definition is not active.');
  
  const steps = parseSteps(definition.steps);
  if (steps.length === 0) throw new HttpError(409, 'This workflow definition has no steps.');
  
  const newId = id('wfi');
  const now = new Date().toISOString();
  const entityBranchId = resolveEntityBranch(String(entityType), String(entityId));
  if (!canAccessBranchResource(req, entityBranchId)) throw new HttpError(403, 'The workflow entity belongs to a branch outside your authorized scope.');
  const firstStepOrder = steps[0].order || 1;
  const triggerTx = db.transaction(() => {
    stmtInsertInstance.run(
      newId, definitionId, entityType, entityId, firstStepOrder,
      entityBranchId, req.user!.fullName, now, JSON.stringify(payload || {})
    );
    stmtInsertHistory.run(
      id('wh'), newId, 0, req.user!.fullName, 'start',
      `Workflow triggered for ${entityType}#${entityId}`, now
    );
    return eventBus.emit(
    'workflow.started', 'workflow', newId,
    { definitionId, entityType, entityId, definitionName: definition.name },
    { operatorId: req.user!.userId, branchId: entityBranchId }
    );
  });
  const event = triggerTx();
  void eventBus.dispatch(event).catch(console.error);
  
  addNotification(
    'New Workflow Pending',
    `Workflow "${definition.name}" has been started for ${entityType}#${entityId}. Step 1 requires action from role: ${steps[0].role}.`,
    'info', req.user!.branchId
  );
  
  writeAudit(req, `Triggered workflow "${definition.name}" for ${entityType}#${entityId}`);
  res.status(201).json({ id: newId, currentStep: firstStepOrder, status: 'in_progress' });
}));

// ============================================================================
// §4 — APPROVE CURRENT STEP
// ============================================================================

workflowsRouter.post('/instances/:id/approve', requirePermission('Workflow.Approve'), ah(async (req, res) => {
  const instance = stmtGetInstanceById.get(req.params.id) as InstanceRow | undefined;
  if (!instance) throw new HttpError(404, 'Workflow instance not found.');
  assertBranchAccess(req, instance.branch_id);

  if (['approved', 'rejected', 'completed', 'cancelled'].includes(instance.status)) {
    throw new HttpError(409, `Workflow is already in terminal status "${instance.status}".`);
  }
  
  const definition = stmtGetDefinitionById.get(instance.definition_id) as DefinitionRow | undefined;
  if (!definition) throw new HttpError(404, 'Workflow definition not found.');
  
  const steps = parseSteps(definition.steps);
  const currentStepDef = steps.find(s => s.order === instance.current_step);
  if (!currentStepDef) throw new HttpError(409, `Step ${instance.current_step} not found in definition.`);
  
  const stepRole = assertKnownStepRole(String(currentStepDef.role), instance.current_step);
  if (!requestHasRole(req, stepRole) && !requestHasRole(req, 'owner') && !requestHasRole(req, 'general_manager')) {
    throw new HttpError(403, `Your authorized role set cannot approve workflow step ${instance.current_step}.`);
  }
  
  const { notes } = req.body;
  const now = new Date().toISOString();
  const nextStepOrder = instance.current_step + 1;
  const hasNextStep = steps.some(s => s.order === nextStepOrder);
  const approveTx = db.transaction(() => {
    let event;
    if (hasNextStep) {
      const cas = db.prepare(`UPDATE workflow_instances SET current_step = ?, status = 'in_progress' WHERE id = ? AND current_step = ? AND status = 'in_progress'`).run(nextStepOrder, instance.id, instance.current_step);
      if (cas.changes !== 1) throw new HttpError(409, 'Workflow state changed concurrently; please reload and try again.');
      stmtInsertHistory.run(id('wh'), instance.id, instance.current_step, req.user!.fullName, 'approve', notes || null, now);
      const nextStepDef = steps.find(s => s.order === nextStepOrder);
      event = eventBus.emit(
        'workflow.step_completed', 'workflow', instance.id,
        { definitionName: definition.name, completedStep: instance.current_step, nextStep: nextStepOrder, nextRole: nextStepDef?.role },
        { operatorId: req.user!.userId, branchId: instance.branch_id }
      );
    } else {
      const terminalStatus = currentStepDef.action === 'execute' ? 'completed' : 'approved';
      const cas = db.prepare(`UPDATE workflow_instances SET status = ?, completed_at = ? WHERE id = ? AND current_step = ? AND status = 'in_progress'`).run(terminalStatus, now, instance.id, instance.current_step);
      if (cas.changes !== 1) throw new HttpError(409, 'Workflow state changed concurrently; please reload and try again.');
      stmtInsertHistory.run(id('wh'), instance.id, instance.current_step, req.user!.fullName, 'approve', notes || null, now);
      event = eventBus.emit(
        'workflow.completed', 'workflow', instance.id,
        { definitionName: definition.name, finalStatus: terminalStatus },
        { operatorId: req.user!.userId, branchId: instance.branch_id }
      );
    }
    return event;
  });
  const event = approveTx();
  void eventBus.dispatch(event).catch(console.error);

  if (hasNextStep) {
    addNotification('Workflow Step Advanced', `Workflow "${definition.name}" advanced to step ${nextStepOrder}.`, 'info', instance.branch_id);
    writeAudit(req, `Approved step ${instance.current_step} of workflow "${definition.name}"`);
    res.json({ ok: true, currentStep: nextStepOrder, status: 'in_progress', isTerminal: false });
  } else {
    const terminalStatus = currentStepDef.action === 'execute' ? 'completed' : 'approved';
    addNotification('Workflow Completed', `Workflow "${definition.name}" has been ${terminalStatus}.`, 'success', instance.branch_id);
    writeAudit(req, `Approved final step of workflow "${definition.name}" — status: ${terminalStatus}`);
    res.json({ ok: true, currentStep: instance.current_step, status: terminalStatus, isTerminal: true });
  }
}));

// ============================================================================
// §5 — REJECT CURRENT STEP
// ============================================================================

workflowsRouter.post('/instances/:id/reject', requirePermission('Workflow.Reject'), ah(async (req, res) => {
  const instance = stmtGetInstanceById.get(req.params.id) as InstanceRow | undefined;
  if (!instance) throw new HttpError(404, 'Workflow instance not found.');
  assertBranchAccess(req, instance.branch_id);

  if (['approved', 'rejected', 'completed', 'cancelled'].includes(instance.status)) {
    throw new HttpError(409, `Workflow is already in terminal status "${instance.status}".`);
  }
  
  const definition = stmtGetDefinitionById.get(instance.definition_id) as DefinitionRow | undefined;
  if (!definition) throw new HttpError(404, 'Workflow definition not found.');
  
  const steps = parseSteps(definition.steps);
  const currentStepDef = steps.find(s => s.order === instance.current_step);
  const userRole = req.rbac?.primaryRole ?? 'none';

  if (currentStepDef
      && !requestHasRole(req, String(currentStepDef.role) as RoleCode)
      && !requestHasRole(req, 'owner')
      && !requestHasRole(req, 'general_manager')) {
    throw new HttpError(403, `Role "${userRole}" is not authorized to reject step ${instance.current_step}.`);
  }
  
  const { reason } = req.body;
  if (!reason) throw new HttpError(400, 'A rejection reason is required.');
  const now = new Date().toISOString();
  const rejectTx = db.transaction(() => {
    const cas = db.prepare(`UPDATE workflow_instances SET status = 'rejected', completed_at = ? WHERE id = ? AND current_step = ? AND status = 'in_progress'`).run(now, instance.id, instance.current_step);
    if (cas.changes !== 1) throw new HttpError(409, 'Workflow state changed concurrently; please reload and try again.');
    stmtInsertHistory.run(id('wh'), instance.id, instance.current_step, req.user!.fullName, 'reject', reason, now);
    return eventBus.emit(
    'workflow.rejected', 'workflow', instance.id,
    { definitionName: definition.name, rejectedAtStep: instance.current_step, reason },
    { operatorId: req.user!.userId, branchId: instance.branch_id }
    );
  });
  const event = rejectTx();
  void eventBus.dispatch(event).catch(console.error);
  
  addNotification('Workflow Rejected', `Workflow "${definition.name}" was rejected at step ${instance.current_step}.`, 'warning', instance.branch_id);
  writeAudit(req, `Rejected workflow "${definition.name}" at step ${instance.current_step}: ${reason}`);
  res.json({ ok: true, status: 'rejected', isTerminal: true });
}));

// ============================================================================
// §6 — CANCEL WORKFLOW
// ============================================================================

workflowsRouter.post('/instances/:id/cancel', requirePermission('Workflow.Cancel'), authorize('owner', 'general_manager'), ah(async (req, res) => {
  const instance = stmtGetInstanceById.get(req.params.id) as InstanceRow | undefined;
  if (!instance) throw new HttpError(404, 'Workflow instance not found.');
  assertBranchAccess(req, instance.branch_id);

  if (['approved', 'rejected', 'completed', 'cancelled'].includes(instance.status)) {
    throw new HttpError(409, `Workflow is already in terminal status "${instance.status}".`);
  }
  
  const { reason } = req.body;
  const now = new Date().toISOString();
  const cancelTx = db.transaction(() => {
    const cas = db.prepare(`UPDATE workflow_instances SET status = 'cancelled', completed_at = ? WHERE id = ? AND current_step = ? AND status = 'in_progress'`).run(now, instance.id, instance.current_step);
    if (cas.changes !== 1) throw new HttpError(409, 'Workflow state changed concurrently; please reload and try again.');
    stmtInsertHistory.run(id('wh'), instance.id, instance.current_step, req.user!.fullName, 'cancel', reason || 'Cancelled by manager', now);
  });
  cancelTx();

  const definition = stmtGetDefinitionById.get(instance.definition_id) as DefinitionRow | undefined;
  writeAudit(req, `Cancelled workflow "${definition?.name || 'Unknown'}" (${instance.entity_type}#${instance.entity_id})`);
  res.json({ ok: true, status: 'cancelled' });
}));

// ============================================================================
// §7 — INSTANCE HISTORY
// ============================================================================

workflowsRouter.get('/instances/:id/history', requirePermission('Workflow.View'), ah(async (req, res) => {
  const instance = stmtGetInstanceById.get(req.params.id) as InstanceRow | undefined;
  if (!instance) throw new HttpError(404, 'Workflow instance not found.');
  assertBranchAccess(req, instance.branch_id);

  const rows = stmtGetHistoryByInstance.all(req.params.id) as any[];
  res.json(rows.map(h => ({
    id: h.id, stepOrder: h.step_order, actor: h.actor, action: h.action, notes: h.notes, timestamp: h.timestamp,
  })));
}));

// ============================================================================
// §8 — PENDING ACTIONS FOR CURRENT USER
// ============================================================================

workflowsRouter.get('/pending', ah(async (req, res) => {
  const branchId = req.user!.branchId;
  
  if (!branchId) return res.json([]);
  
  const instances = stmtGetPendingInstances.all(branchId) as any[];
  
  // NOTE: Because steps are stored as JSON, we must filter in JS. 
  // Architectural recommendation: Add `current_step_role` as a column to workflow_instances.
  const pending = instances.filter((inst) => {
    const steps = parseSteps(inst.definition_steps);
    const currentStep = steps.find(s => s.order === inst.current_step);
    if (!currentStep) return false;
    // A listing must not fail because one definition is malformed, so an
    // unknown role simply matches nobody here; the approve endpoint is where
    // it is reported.
    const role = String(currentStep.role);
    const known = (ROLE_CODES as readonly string[]).includes(role);
    return (known && requestHasRole(req, role as RoleCode)) || requestHasRole(req, 'owner') || requestHasRole(req, 'general_manager');
  });
  
  res.json(pending.map((inst) => {
    const steps = parseSteps(inst.definition_steps);
    const currentStep = steps.find(s => s.order === inst.current_step);
    return {
      id: inst.id,
      definitionName: inst.definition_name,
      entityType: inst.entity_type,
      entityId: inst.entity_id,
      currentStep: inst.current_step,
      currentStepRole: currentStep?.role,
      currentStepAction: currentStep?.action,
      currentStepLabel: currentStep?.label || `Step ${inst.current_step}`,
      initiatedBy: inst.initiated_by,
      startedAt: inst.started_at,
      payload: JSON.parse(inst.payload || '{}'),
    };
  }));
}));

export default workflowsRouter;