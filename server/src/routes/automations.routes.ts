/**
 * TOEFL House ERP — Automation Routes (BC #13)
 * ============================================================
 *
 * REST endpoints for managing automation rules: declarative
 * trigger → condition → action pipelines that execute automatically
 * when domain events fire.
 *
 * Access control:
 *   - owner, manager: full CRUD + toggle + execution log
 *   - head_of_department: read-only (view active automations)
 *
 * @module routes/automations.routes
 * @version 2.0.0
 * @license Apache-2.0
 */

import { Router } from 'express';
import { db } from '../db/connection.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { createLogger } from '../core/observability/logger.js';
const log = createLogger('automations');

export const automationsRouter = Router();
automationsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllAutomations = db.prepare('SELECT * FROM automations ORDER BY created_at DESC');
const stmtGetAutomationById = db.prepare('SELECT * FROM automations WHERE id = ?');
const stmtGetAutomationStats = db.prepare(
  `SELECT
     COUNT(*) as totalExecutions,
     SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulExecutions,
     SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedExecutions,
     AVG(duration_ms) as avgDurationMs,
     MAX(executed_at) as lastExecutedAt
   FROM event_handler_log
   WHERE handler = ?`
);
const stmtInsertAutomation = db.prepare(
  `INSERT INTO automations (id, name, trigger, conditions, actions, is_active, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
);
const stmtInsertSubscription = db.prepare(
  `INSERT INTO event_subscriptions (id, event_type, handler, config, is_active)
   VALUES (?, ?, 'automation', ?, 1)`
);
const stmtUpdateAutomation = db.prepare(
  `UPDATE automations SET name = ?, conditions = ?, actions = ?, is_active = ?, updated_at = ? WHERE id = ?`
);
const stmtUpdateSubscriptionActive = db.prepare(
  `UPDATE event_subscriptions SET is_active = ? WHERE handler = 'automation' AND json_extract(config, '$.automationId') = ?`
);
const stmtToggleAutomation = db.prepare(
  'UPDATE automations SET is_active = ?, updated_at = ? WHERE id = ?'
);
const stmtDeleteSubscription = db.prepare(
  `DELETE FROM event_subscriptions WHERE handler = 'automation' AND json_extract(config, '$.automationId') = ?`
);
const stmtDeleteAutomation = db.prepare('DELETE FROM automations WHERE id = ?');
const stmtGetExecutionLogs = db.prepare(
  `SELECT ehl.*, de.type as event_type, de.aggregate_type, de.aggregate_id, de.occurred_at
   FROM event_handler_log ehl
   LEFT JOIN domain_events de ON de.id = ehl.event_id
   WHERE ehl.handler = ?
   ORDER BY ehl.executed_at DESC
   LIMIT ?`
);

// ============================================================================
// §1 — LIST AUTOMATIONS
// ============================================================================

/** GET /api/automations — list all automations, optionally filtered by trigger or active status */
automationsRouter.get(
  '/',
  authorize('owner', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const { trigger, isActive } = req.query as Record<string, string>;

    // Fetch all and filter in JS (automations table is small, avoids dynamic SQL preparation)
    let rows = stmtGetAllAutomations.all() as any[];

    if (trigger) {
      rows = rows.filter((r) => r.trigger === trigger);
    }

    if (isActive !== undefined) {
      const activeBool = isActive === 'true' ? 1 : 0;
      rows = rows.filter((r) => r.is_active === activeBool);
    }

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        trigger: r.trigger,
        conditions: JSON.parse(r.conditions || '[]'),
        actions: JSON.parse(r.actions || '[]'),
        isActive: !!r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    );
  })
);

// ============================================================================
// §2 — GET SINGLE AUTOMATION
// ============================================================================

/** GET /api/automations/:id — single automation with execution stats */
automationsRouter.get(
  '/:id',
  authorize('owner', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const row = stmtGetAutomationById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Automation not found.');

    const stats = stmtGetAutomationStats.get(`automation:${row.id}`) as any;

    res.json({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      conditions: JSON.parse(row.conditions || '[]'),
      actions: JSON.parse(row.actions || '[]'),
      isActive: !!row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stats: {
        totalExecutions: stats.totalExecutions || 0,
        successfulExecutions: stats.successfulExecutions || 0,
        failedExecutions: stats.failedExecutions || 0,
        avgDurationMs: stats.avgDurationMs ? Math.round(stats.avgDurationMs * 100) / 100 : 0,
        lastExecutedAt: stats.lastExecutedAt || null,
      },
    });
  })
);

// ============================================================================
// §3 — CREATE AUTOMATION
// ============================================================================

/** POST /api/automations — create a new automation rule (owner/manager only) */
automationsRouter.post(
  '/',
  authorize('owner'),
  ah(async (req, res) => {
    const { name, trigger, conditions, actions } = req.body;

    if (!name || !trigger) {
      throw new HttpError(400, 'Automation name and trigger event are required.');
    }
    if (!Array.isArray(conditions)) {
      throw new HttpError(400, 'Conditions must be an array of rule conditions.');
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new HttpError(400, 'At least one action is required.');
    }

    // Validate condition structure
    const validOperators = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'contains'];
    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      if (!cond.field || !cond.operator) {
        throw new HttpError(400, `Condition ${i + 1} must have "field" and "operator".`);
      }
      if (!validOperators.includes(cond.operator)) {
        throw new HttpError(400, `Condition ${i + 1} has invalid operator "${cond.operator}".`);
      }
    }

    // Validate action structure
    const validActionTypes = ['notify', 'create_entity', 'update_entity', 'transition', 'webhook'];
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      if (!act.type || !validActionTypes.includes(act.type)) {
        throw new HttpError(400, `Action ${i + 1} has invalid type "${act.type}".`);
      }
      if (!act.config || typeof act.config !== 'object') {
        throw new HttpError(400, `Action ${i + 1} must have a "config" object.`);
      }
    }

    const newId = id('auto');
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      stmtInsertAutomation.run(
        newId, name, trigger, JSON.stringify(conditions), JSON.stringify(actions), now, now
      );
      // Register the automation as an event subscription
      stmtInsertSubscription.run(
        id('es'), trigger, JSON.stringify({ automationId: newId })
      );
    });
    tx();

    addNotification(
      'Automation Created',
      `Automation "${name}" is now active and listening for "${trigger}" events.`,
      'success',
      req.user?.branchId
    );

    writeAudit(req, `Created automation: ${name} (trigger: ${trigger})`);
    res.status(201).json({ id: newId });
  })
);

// ============================================================================
// §4 — UPDATE AUTOMATION
// ============================================================================

/** PATCH /api/automations/:id — update automation name, conditions, actions, or active status */
automationsRouter.patch(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const { name, conditions, actions, isActive } = req.body;
    const now = new Date().toISOString();

    if (conditions !== undefined && !Array.isArray(conditions)) {
      throw new HttpError(400, 'Conditions must be an array.');
    }
    if (actions !== undefined && (!Array.isArray(actions) || actions.length === 0)) {
      throw new HttpError(400, 'At least one action is required.');
    }

    stmtUpdateAutomation.run(
      name ?? existing.name,
      conditions !== undefined ? JSON.stringify(conditions) : existing.conditions,
      actions !== undefined ? JSON.stringify(actions) : existing.actions,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      now,
      req.params.id
    );

    // Sync the event subscription active state securely
    if (isActive !== undefined) {
      stmtUpdateSubscriptionActive.run(isActive ? 1 : 0, req.params.id);
    }

    writeAudit(req, `Updated automation: ${existing.name}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §5 — TOGGLE AUTOMATION ACTIVE STATE
// ============================================================================

/** POST /api/automations/:id/toggle — quick toggle active/inactive */
automationsRouter.post(
  '/:id/toggle',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const newState = existing.is_active ? 0 : 1;
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      stmtToggleAutomation.run(newState, now, req.params.id);
      stmtUpdateSubscriptionActive.run(newState, req.params.id);
    });
    tx();

    const stateLabel = newState ? 'activated' : 'deactivated';

    addNotification(
      `Automation ${stateLabel}`,
      `Automation "${existing.name}" has been ${stateLabel}.`,
      newState ? 'success' : 'info',
      req.user?.branchId
    );

    writeAudit(req, `${stateLabel} automation: ${existing.name}`);
    res.json({ ok: true, isActive: !!newState });
  })
);

// ============================================================================
// §6 — DELETE AUTOMATION
// ============================================================================

/** DELETE /api/automations/:id — permanently delete an automation (owner only) */
automationsRouter.delete(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const tx = db.transaction(() => {
      stmtDeleteSubscription.run(req.params.id);
      stmtDeleteAutomation.run(req.params.id);
    });
    tx();

    writeAudit(req, `Deleted automation: ${existing.name}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §7 — EXECUTION LOG
// ============================================================================

/** GET /api/automations/:id/executions — recent execution history for an automation */
automationsRouter.get(
  '/:id/executions',
  authorize('owner', 'general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    // Was `Math.min(Number(limit) || 50, 200)`: a negative value is truthy and
    // survives the min, producing `LIMIT -1` — unbounded in SQLite.
    const { limit } = parsePaginationShared(req as { query: Record<string, unknown> }, { defaultPageSize: 50, maxPageSize: 200 });
    const rows = stmtGetExecutionLogs.all(`automation:${req.params.id}`, limit) as any[];

    res.json(
      rows.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        eventType: r.event_type,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        eventOccurredAt: r.occurred_at,
        success: !!r.success,
        durationMs: r.duration_ms,
        error: r.error,
        executedAt: r.executed_at,
      }))
    );
  })
);

// ============================================================================
// §8 — TEST / DRY-RUN AUTOMATION
// ============================================================================

automationsRouter.post(
  '/:id/test',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const { samplePayload } = req.body;
    if (!samplePayload || typeof samplePayload !== 'object') {
      throw new HttpError(400, 'A "samplePayload" object is required for testing.');
    }

    const conditions = JSON.parse(existing.conditions || '[]');
    const actions = JSON.parse(existing.actions || '[]');

    const conditionResults = conditions.map((cond: any, idx: number) => {
      const fieldValue = resolveFieldPath(cond.field, samplePayload);
      const matched = evaluateTestCondition(cond, fieldValue);
      return {
        index: idx + 1, field: cond.field, operator: cond.operator,
        expectedValue: cond.value, actualValue: fieldValue, matched,
      };
    });

    const allConditionsMet = conditionResults.every((r: any) => r.matched);

    res.json({
      automationId: existing.id, automationName: existing.name, trigger: existing.trigger,
      allConditionsMet, conditionResults,
      actionsThatWouldFire: allConditionsMet ? actions : [],
      verdict: allConditionsMet
        ? 'All conditions met — actions WOULD execute.'
        : 'Conditions NOT met — no actions would execute.',
    });
  })
);

// ============================================================================
// §9 — SEED DEFAULT AUTOMATIONS
// ============================================================================

export function seedDefaultAutomations(): void {
  const stmtCount = db.prepare('SELECT COUNT(*) as c FROM automations');
  const existing = stmtCount.get() as { c: number };
  if (existing.c > 0) return;

  const defaults = [
    {
      name: 'Low Attendance Parent Alert', trigger: 'attendance.marked',
      conditions: [{ field: 'attendanceRate', operator: 'lt', value: 85 }],
      actions: [{ type: 'notify', config: { channel: 'sms', template: 'parent_attendance_warning', message: 'Student attendance has fallen below the 85% threshold.' } }],
    },
    {
      name: 'Auto-Promote on Exam Pass', trigger: 'exam.result_recorded',
      conditions: [{ field: 'score', operator: 'gte', value: 90 }],
      actions: [
        { type: 'transition', config: { targetStatus: 'promoted' } },
        { type: 'notify', config: { channel: 'internal', message: 'Student auto-promoted after satisfying the configured promotion policy.' } },
      ],
    },
    {
      name: 'Overdue Installment Reminder', trigger: 'payment.received',
      conditions: [{ field: 'remainingBalance', operator: 'gt', value: 0 }],
      actions: [{ type: 'notify', config: { channel: 'internal', template: 'installment_reminder', message: 'Installment payment received. Outstanding balance updated.' } }],
    },
    {
      name: 'New Student Welcome Notification', trigger: 'student.registered',
      conditions: [],
      actions: [{ type: 'notify', config: { channel: 'internal', template: 'welcome_student', message: 'A new student has been registered in the system.' } }],
    },
    {
      name: 'Critical Stock Alert', trigger: 'book.sold',
      conditions: [{ field: 'remainingStock', operator: 'lte', value: 5 }],
      actions: [{ type: 'notify', config: { channel: 'internal', template: 'low_stock_alert', message: 'Book stock has fallen to critical levels. Restock recommended.' } }],
    },
  ];

  const seedTx = db.transaction(() => {
    for (const auto of defaults) {
      const autoId = id('auto');
      stmtInsertAutomation.run(
        autoId, auto.name, auto.trigger, JSON.stringify(auto.conditions), JSON.stringify(auto.actions),
        new Date().toISOString(), new Date().toISOString()
      );
      stmtInsertSubscription.run(id('es'), auto.trigger, JSON.stringify({ automationId: autoId }));
    }
  });

  try {
    seedTx();
    log.info('✅ Seeded default automations.');
  } catch (error) {
    log.error('❌ Failed to seed default automations:', error);
  }
}

// ============================================================================
// §10 — INTERNAL HELPERS
// ============================================================================

function resolveFieldPath(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.');
  let current: unknown = data;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function evaluateTestCondition(cond: any, fieldValue: unknown): boolean {
  const { operator, value } = cond;

  switch (operator) {
    case 'eq': return fieldValue === value;
    case 'neq': return fieldValue !== value;
    case 'gt': return Number(fieldValue) > Number(value);
    case 'lt': return Number(fieldValue) < Number(value);
    case 'gte': return Number(fieldValue) >= Number(value);
    case 'lte': return Number(fieldValue) <= Number(value);
    case 'in': return Array.isArray(value) && value.includes(fieldValue);
    case 'contains':
      return typeof fieldValue === 'string' && typeof value === 'string' && fieldValue.includes(value);
    default: return false;
  }
}

export default automationsRouter;