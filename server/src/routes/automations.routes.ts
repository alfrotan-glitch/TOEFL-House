/**
 * TOEFL House ERP — Automation Routes (BC #13)
 * ============================================================
 *
 * REST endpoints for managing automation rules: declarative
 * trigger → condition → action pipelines that execute automatically
 * when domain events fire.
 *
 * Access control:
 *   - Workflow.View: read-only visibility
 *   - Automation.Edit: global automation mutation (owner-only by default role grants)
 *
 * @module routes/automations.routes
 * @version 2.0.0
 * @license Apache-2.0
 */

import { Router } from 'express';
import { db } from '../db/connection.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { createLogger } from '../core/observability/logger.js';
import {
  evaluateAutomation,
  validateAutomationActions,
  validateAutomationConditions,
} from '../core/events/automation-engine.js';
import { isDomainEventType, isEmittedEventType } from '../core/events/event-registry.js';
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
  requirePermission('Workflow.View'),
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
  requirePermission('Workflow.View'),
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
  requirePermission('Automation.Edit'),
  ah(async (req, res) => {
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rawTrigger = typeof req.body?.trigger === 'string' ? req.body.trigger.trim() : '';
    if (!rawName || !rawTrigger) {
      throw new HttpError(400, 'Automation name and trigger event are required.');
    }
    if (!isDomainEventType(rawTrigger)) {
      throw new HttpError(400, `Unknown automation trigger '${rawTrigger}'.`);
    }
    if (!isEmittedEventType(rawTrigger)) {
      throw new HttpError(
        400,
        `'${rawTrigger}' is reserved vocabulary: no writer in the system emits it, so this automation would never fire. Pick a trigger from the emitted types (GET /api/events/types shows which are emitted).`,
      );
    }

    let normalizedConditions;
    let normalizedActions;
    try {
      normalizedConditions = validateAutomationConditions(req.body?.conditions ?? []);
      normalizedActions = validateAutomationActions(req.body?.actions);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid automation definition.');
    }

    const newId = id('auto');
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      stmtInsertAutomation.run(
        newId,
        rawName,
        rawTrigger,
        JSON.stringify(normalizedConditions),
        JSON.stringify(normalizedActions),
        now,
        now,
      );
      stmtInsertSubscription.run(id('es'), rawTrigger, JSON.stringify({ automationId: newId }));
    });
    tx();

    addNotification(
      'Automation Created',
      `Automation "${rawName}" is now active and listening for "${rawTrigger}" events.`,
      'success',
      req.user?.branchId,
    );

    writeAudit(req, `Created automation: ${rawName} (trigger: ${rawTrigger})`);
    res.status(201).json({ id: newId });
  })
);

// ============================================================================
// §4 — UPDATE AUTOMATION
// ============================================================================

/** PATCH /api/automations/:id — update automation name, conditions, actions, or active status */
automationsRouter.patch(
  '/:id',
  requirePermission('Automation.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const { name, conditions, actions, isActive } = req.body;
    const now = new Date().toISOString();

    let normalizedConditions = existing.conditions;
    let normalizedActions = existing.actions;
    try {
      if (conditions !== undefined) normalizedConditions = JSON.stringify(validateAutomationConditions(conditions));
      if (actions !== undefined) normalizedActions = JSON.stringify(validateAutomationActions(actions));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid automation definition.');
    }

    stmtUpdateAutomation.run(
      typeof name === 'string' && name.trim() ? name.trim() : existing.name,
      normalizedConditions,
      normalizedActions,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      now,
      req.params.id,
    );

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
  requirePermission('Automation.Edit'),
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
  requirePermission('Automation.Edit'),
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
  requirePermission('Workflow.View'),
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
  requirePermission('Automation.Edit'),
  ah(async (req, res) => {
    const existing = stmtGetAutomationById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Automation not found.');

    const { samplePayload } = req.body;
    if (!samplePayload || typeof samplePayload !== 'object' || Array.isArray(samplePayload)) {
      throw new HttpError(400, 'A "samplePayload" object is required for testing.');
    }

    const conditions = validateAutomationConditions(JSON.parse(existing.conditions || '[]'));
    const actions = validateAutomationActions(JSON.parse(existing.actions || '[]'));
    const verdict = evaluateAutomation(conditions, samplePayload as Record<string, unknown>);

    res.json({
      automationId: existing.id,
      automationName: existing.name,
      trigger: existing.trigger,
      allConditionsMet: verdict.allConditionsMet,
      conditionResults: verdict.conditionResults,
      actionsThatWouldFire: verdict.allConditionsMet ? actions : [],
      verdict: verdict.allConditionsMet
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
      name: 'Low Attendance Alert',
      trigger: 'attendance.marked',
      conditions: [{ field: 'attendanceRate', operator: 'lt', value: 85 }],
      actions: [{ type: 'notify', config: { title: 'Attendance alert', severity: 'warning', message: 'Attendance has fallen below the configured threshold.' } }],
    },
    {
      name: 'High Exam Result Review',
      trigger: 'exam.result_recorded',
      conditions: [{ field: 'score', operator: 'gte', value: 90 }],
      actions: [{ type: 'notify', config: { title: 'High exam result', severity: 'info', message: 'A high exam score was recorded and may need follow-up action.' } }],
    },
    {
      name: 'Outstanding Balance Reminder',
      trigger: 'payment.received',
      conditions: [{ field: 'remainingBalance', operator: 'gt', value: 0 }],
      actions: [{ type: 'notify', config: { title: 'Outstanding balance', severity: 'info', message: 'A payment was received and the account still carries an outstanding balance.' } }],
    },
    {
      name: 'New Student Welcome Notification',
      trigger: 'student.registered',
      conditions: [],
      actions: [{ type: 'notify', config: { title: 'New student registered', severity: 'success', message: 'A new student has been registered in the system.' } }],
    },
    {
      name: 'Critical Stock Alert',
      trigger: 'book.sold',
      conditions: [{ field: 'remainingStock', operator: 'lte', value: 5 }],
      actions: [{ type: 'notify', config: { title: 'Critical stock alert', severity: 'warning', message: 'Book stock has fallen to critical levels. Restock recommended.' } }],
    },
  ] as const;

  const seedTx = db.transaction(() => {
    for (const auto of defaults) {
      const autoId = id('auto');
      const conditions = validateAutomationConditions(auto.conditions);
      const actions = validateAutomationActions(auto.actions);
      stmtInsertAutomation.run(
        autoId,
        auto.name,
        auto.trigger,
        JSON.stringify(conditions),
        JSON.stringify(actions),
        new Date().toISOString(),
        new Date().toISOString(),
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

export default automationsRouter;