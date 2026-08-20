/**
 * TOEFL House ERP — Event Routes (BC #14)
 * ============================================================
 *
 * REST endpoints for the Event Bounded Context: browsing the domain
 * event stream, replaying events for debugging, managing event
 * subscriptions, and viewing event handler execution logs.
 *
 * Access control:
 *   - owner: full access (stream, replay, subscriptions, purge)
 *   - manager: read-only stream + handler logs
 *
 * @module routes/events.routes
 * @version 2.0.0
 * @license Apache-2.0
 */

import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, canAccessBranchResource } from '../middleware/auth.js';
import { hasRole, isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { eventBus } from '../core/events/event-bus.js';
import type { DomainEventType } from '../core/events/event-bus.js';

export const eventsRouter = Router();
eventsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllSubscriptions = db.prepare('SELECT * FROM event_subscriptions ORDER BY event_type, handler');
const stmtGetSubscriptionById = db.prepare('SELECT * FROM event_subscriptions WHERE id = ?');
const stmtInsertSubscription = db.prepare(
  `INSERT INTO event_subscriptions (id, event_type, handler, config, is_active) VALUES (?, ?, ?, ?, 1)`
);
const stmtUpdateSubscription = db.prepare(
  'UPDATE event_subscriptions SET is_active = ?, config = ? WHERE id = ?'
);
const stmtDeleteSubscription = db.prepare('DELETE FROM event_subscriptions WHERE id = ?');

const stmtCountTotalEventsAll = db.prepare(
  `SELECT COUNT(*) as totalEvents FROM domain_events WHERE occurred_at BETWEEN ? AND ?`
);
const stmtCountTotalEventsByBranch = db.prepare(
  `SELECT COUNT(*) as totalEvents FROM domain_events WHERE occurred_at BETWEEN ? AND ? AND branch_id = ?`
);
const stmtCountUnpublishedEvents = db.prepare(
  'SELECT COUNT(*) as unpublishedCount FROM domain_events WHERE published = 0'
);

// ============================================================================
// §1 — EVENT STREAM
// ============================================================================

eventsRouter.get(
  '/stream',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const {
      type, aggregateType, aggregateId, correlationId, branchId, limit,
    } = req.query as Record<string, string>;

    const userBranchId = req.user?.branchId;
    if (!userBranchId) throw new HttpError(403, 'User context is missing.');

    const effectiveBranchId = branchId || userBranchId;
    if (!(req.rbac && isGlobalOwner(req.rbac)) && !canAccessBranchResource(req, effectiveBranchId)) {
      throw new HttpError(403, 'Requested event branch is outside your access scope.');
    }
    const maxLimit = Math.min(Number(limit) || 50, 200);

    // Dynamic SQL is acceptable here because the filters are complex and table size is manageable.
    // All inputs are parameterized to prevent SQL injection.
    let sql = 'SELECT * FROM domain_events WHERE 1=1';
    const params: unknown[] = [];

    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (aggregateType) { sql += ' AND aggregate_type = ?'; params.push(aggregateType); }
    if (aggregateId) { sql += ' AND aggregate_id = ?'; params.push(aggregateId); }
    if (correlationId) { sql += ' AND correlation_id = ?'; params.push(correlationId); }

    // Owner can see all branches; others are scoped
    if (!(req.rbac && isGlobalOwner(req.rbac))) {
      sql += ' AND branch_id = ?';
      params.push(effectiveBranchId);
    } else if (branchId) {
      sql += ' AND branch_id = ?';
      params.push(branchId);
    }

    sql += ' ORDER BY occurred_at DESC LIMIT ?';
    params.push(maxLimit);

    const rows = db.prepare(sql).all(...params) as any[];

    res.json(
      rows.map((r) => ({
        id: r.id, type: r.type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
        payload: JSON.parse(r.payload || '{}'), occurredAt: r.occurred_at, operatorId: r.operator_id,
        branchId: r.branch_id, correlationId: r.correlation_id, causationId: r.causation_id,
        schemaVersion: r.schema_version, published: !!r.published,
      }))
    );
  })
);

// ============================================================================
// §2 — CORRELATION CHAIN (Causal Tracing)
// ============================================================================

eventsRouter.get(
  '/chain/:correlationId',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const chain = eventBus.getCorrelationChain(req.params.correlationId);
    if (chain.length === 0) throw new HttpError(404, 'No events found for this correlation ID.');
    if (!req.rbac || !isGlobalOwner(req.rbac)) {
      const foreign = chain.some((e) => !canAccessBranchResource(req, e.branchId));
      if (foreign) throw new HttpError(403, 'Event correlation chain contains events outside your access scope.');
    }

    const eventMap = new Map(chain.map((e) => [e.id, e]));
    const roots = chain.filter((e) => !e.causationId || !eventMap.has(e.causationId));

    res.json({
      correlationId: req.params.correlationId,
      totalEvents: chain.length,
      roots: roots.map((r) => r.id),
      events: chain,
    });
  })
);

// ============================================================================
// §3 — EVENT STATISTICS
// ============================================================================

eventsRouter.get(
  '/stats',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const { from, to, branchId } = req.query as Record<string, string>;

    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    const fromDate = from || defaultFrom.toISOString();
    const toDate = to || new Date().toISOString();
    
    const userBranchId = req.user?.branchId;
    if (!userBranchId) throw new HttpError(403, 'User context is missing.');

    const effectiveBranchId = branchId || userBranchId;
    if (!(req.rbac && isGlobalOwner(req.rbac)) && !canAccessBranchResource(req, effectiveBranchId)) {
      throw new HttpError(403, 'Requested event branch is outside your access scope.');
    }

    const counts = eventBus.getEventCounts(
      fromDate, toDate,
      !(req.rbac && isGlobalOwner(req.rbac)) ? effectiveBranchId : branchId
    );
    const totalEvents = !(req.rbac && isGlobalOwner(req.rbac))
      ? (stmtCountTotalEventsByBranch.get(fromDate, toDate, effectiveBranchId) as any).totalEvents
      : (stmtCountTotalEventsAll.get(fromDate, toDate) as any).totalEvents;

    const unpublishedCount = !(req.rbac && isGlobalOwner(req.rbac))
      ? (db.prepare('SELECT COUNT(*) as unpublishedCount FROM domain_events WHERE published = 0 AND branch_id = ?').get(effectiveBranchId) as any).unpublishedCount
      : (stmtCountUnpublishedEvents.get() as any).unpublishedCount;

    res.json({
      period: { from: fromDate, to: toDate },
      totalEvents,
      unpublishedCount,
      byType: counts,
    });
  })
);

// ============================================================================
// §4 — EVENT REPLAY (Debugging / Migration)
// ============================================================================

eventsRouter.post(
  '/replay',
  authorize('owner'),
  ah(async (req, res) => {
    const { aggregateType, aggregateId } = req.body;
    if (!aggregateType || !aggregateId) throw new HttpError(400, 'aggregateType and aggregateId are required.');

    const events = await eventBus.replayAggregate(aggregateType, aggregateId);
    writeAudit(req, `Replayed ${events.length} events for ${aggregateType}#${aggregateId}`);

    res.json({
      replayedCount: events.length,
      events: events.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt })),
    });
  })
);

eventsRouter.post(
  '/flush',
  authorize('owner'),
  ah(async (req, res) => {
    const count = await eventBus.flushUnpublished();
    writeAudit(req, `Manually flushed ${count} unpublished events`);
    res.json({ flushedCount: count });
  })
);

// ============================================================================
// §5 — EVENT SUBSCRIPTIONS
// ============================================================================

eventsRouter.get(
  '/subscriptions',
  authorize('owner'),
  ah(async (_req, res) => {
    const rows = stmtGetAllSubscriptions.all() as any[];
    res.json(
      rows.map((r) => ({
        id: r.id, eventType: r.event_type, handler: r.handler,
        config: JSON.parse(r.config || '{}'), isActive: !!r.is_active, createdAt: r.created_at,
      }))
    );
  })
);

eventsRouter.post(
  '/subscriptions',
  authorize('owner'),
  ah(async (req, res) => {
    const { eventType, handler, config } = req.body;
    if (!eventType || !handler) throw new HttpError(400, 'eventType and handler are required.');

    const validHandlers = ['workflow', 'automation', 'notification', 'webhook'];
    if (!validHandlers.includes(handler)) {
      throw new HttpError(400, `Invalid handler. Must be one of: ${validHandlers.join(', ')}`);
    }
    const newId = id('es');
    stmtInsertSubscription.run(newId, eventType, handler, JSON.stringify(config || {}));

    writeAudit(req, `Created event subscription: ${handler} → ${eventType}`);
    res.status(201).json({ id: newId });
  })
);

eventsRouter.patch(
  '/subscriptions/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetSubscriptionById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Subscription not found.');

    const { isActive, config } = req.body;
    stmtUpdateSubscription.run(
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      config !== undefined ? JSON.stringify(config) : existing.config,
      req.params.id
    );

    writeAudit(
      req,
      `Updated event subscription ${req.params.id}: ${isActive !== undefined ? (isActive ? 'activated' : 'deactivated') : 'config updated'}`
    );
    res.json({ ok: true });
  })
);

eventsRouter.delete(
  '/subscriptions/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetSubscriptionById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Subscription not found.');

    stmtDeleteSubscription.run(req.params.id);
    writeAudit(req, `Deleted event subscription: ${existing.handler} → ${existing.event_type}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §6 — HANDLER EXECUTION LOGS
// ============================================================================

eventsRouter.get(
  '/handler-logs',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const { eventId, handler, success, limit } = req.query as Record<string, string>;
    const maxLimit = Math.min(Number(limit) || 50, 200);

    let sql = `
      SELECT ehl.*, de.type as event_type, de.aggregate_type, de.aggregate_id, de.occurred_at
      FROM event_handler_log ehl
      LEFT JOIN domain_events de ON de.id = ehl.event_id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (eventId) { sql += ' AND ehl.event_id = ?'; params.push(eventId); }
    if (handler) { sql += ' AND ehl.handler LIKE ?'; params.push(`%${handler}%`); }
    if (success !== undefined) { sql += ' AND ehl.success = ?'; params.push(success === 'true' ? 1 : 0); }
    if (!req.rbac || !isGlobalOwner(req.rbac)) {
      sql += ' AND de.branch_id = ?';
      params.push(req.user?.branchId);
    }

    sql += ' ORDER BY ehl.executed_at DESC LIMIT ?';
    params.push(maxLimit);

    const rows = db.prepare(sql).all(...params) as any[];

    res.json(
      rows.map((r) => ({
        id: r.id, eventId: r.event_id, eventType: r.event_type, aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id, eventOccurredAt: r.occurred_at, handler: r.handler,
        success: !!r.success, durationMs: r.duration_ms, error: r.error, executedAt: r.executed_at,
      }))
    );
  })
);

// ============================================================================
// §7 — REGISTERED HANDLERS (Runtime Introspection)
// ============================================================================

eventsRouter.get(
  '/handlers',
  authorize('owner'),
  ah(async (req, res) => {
    const eventType = req.query.type as string | undefined;
    const handlers = eventBus.listHandlers(eventType as DomainEventType | undefined);
    res.json({ count: handlers.length, handlers });
  })
);

// ============================================================================
// §8 — EVENT TYPE REGISTRY
// ============================================================================

eventsRouter.get(
  '/types',
  authorize('owner', 'general_manager'),
  ah(async (_req, res) => {
    const types: { type: string; category: string; description: string }[] = [
      // CRM / Lead Pipeline
      { type: 'lead.created', category: 'crm', description: 'A new lead/visitor was created' },
      { type: 'lead.followed_up', category: 'crm', description: 'A follow-up was logged for a lead' },
      { type: 'lead.placement_scheduled', category: 'crm', description: 'Placement test scheduled' },
      { type: 'lead.placement_completed', category: 'crm', description: 'Placement test completed' },
      { type: 'lead.converted', category: 'crm', description: 'Lead converted to student' },
      { type: 'lead.lost', category: 'crm', description: 'Lead marked as lost' },
      // Student
      { type: 'student.registered', category: 'student', description: 'New student registered' },
      { type: 'student.enrolled', category: 'student', description: 'Student enrolled in a class' },
      { type: 'student.status_changed', category: 'student', description: 'Student status changed' },
      { type: 'student.card_issued', category: 'student', description: 'Smart ID card issued' },
      { type: 'student.graduated', category: 'student', description: 'Student graduated' },
      // Academic / Session
      { type: 'class.created', category: 'academic', description: 'New class created' },
      { type: 'class.updated', category: 'academic', description: 'Class details updated' },
      { type: 'session.scheduled', category: 'academic', description: 'Session scheduled' },
      { type: 'session.completed', category: 'academic', description: 'Session completed' },
      { type: 'session.cancelled', category: 'academic', description: 'Session cancelled' },
      { type: 'attendance.marked', category: 'academic', description: 'Attendance marked' },
      // Assessment
      { type: 'exam.created', category: 'assessment', description: 'New exam created' },
      { type: 'exam.result_recorded', category: 'assessment', description: 'Exam result recorded' },
      { type: 'exam.certificate_issued', category: 'assessment', description: 'Certificate issued' },
      // Teacher / HR
      { type: 'teacher.created', category: 'hr', description: 'New teacher added' },
      { type: 'teacher.updated', category: 'hr', description: 'Teacher details updated' },
      { type: 'teacher.skill_assigned', category: 'hr', description: 'Skill assigned to teacher' },
      { type: 'teacher.salary_paid', category: 'hr', description: 'Teacher salary paid' },
      { type: 'employee.created', category: 'hr', description: 'New employee added' },
      { type: 'employee.salary_paid', category: 'hr', description: 'Employee salary paid' },
      // Finance
      { type: 'payment.received', category: 'finance', description: 'Payment received' },
      { type: 'payment.refunded', category: 'finance', description: 'Payment refunded' },
      { type: 'invoice.created', category: 'finance', description: 'Invoice created' },
      { type: 'invoice.paid', category: 'finance', description: 'Invoice paid' },
      { type: 'budget.charged', category: 'finance', description: 'Budget line charged' },
      { type: 'budget.month_end_settled', category: 'finance', description: 'Month-end budget settled' },
      { type: 'expense.requested', category: 'finance', description: 'Expense request submitted' },
      { type: 'expense.approved', category: 'finance', description: 'Expense approved' },
      { type: 'expense.rejected', category: 'finance', description: 'Expense rejected' },
      { type: 'saving.transferred', category: 'finance', description: 'Saving transfer executed' },
      { type: 'profit.withdrawn', category: 'finance', description: 'Profit withdrawn' },
      // Inventory
      { type: 'book.added', category: 'inventory', description: 'Book added to inventory' },
      { type: 'book.restocked', category: 'inventory', description: 'Book restocked' },
      { type: 'book.sold', category: 'inventory', description: 'Book sold' },
      { type: 'book.sale_refunded', category: 'inventory', description: 'Book sale refunded' },
      // Funding / Donation
      { type: 'donor.created', category: 'funding', description: 'New donor registered' },
      { type: 'donation.received', category: 'funding', description: 'Donation received' },
      { type: 'campaign.created', category: 'funding', description: 'Funding campaign created' },
      { type: 'scholarship.awarded', category: 'funding', description: 'Scholarship awarded' },
      { type: 'sponsorship.created', category: 'funding', description: 'Sponsorship agreement created' },
      // Impact
      { type: 'impact.report_generated', category: 'impact', description: 'Impact report generated' },
      // Workflow / Automation
      { type: 'workflow.started', category: 'workflow', description: 'Workflow instance started' },
      { type: 'workflow.step_completed', category: 'workflow', description: 'Workflow step completed' },
      { type: 'workflow.completed', category: 'workflow', description: 'Workflow completed' },
      { type: 'workflow.rejected', category: 'workflow', description: 'Workflow rejected' },
      { type: 'automation.triggered', category: 'automation', description: 'Automation triggered' },
      // System
      { type: 'user.created', category: 'system', description: 'User account created' },
      { type: 'user.password_changed', category: 'system', description: 'Password changed' },
      { type: 'branch.created', category: 'system', description: 'Branch created' },
      { type: 'settings.updated', category: 'system', description: 'System settings updated' },
    ];

    res.json({ count: types.length, types });
  })
);

export default eventsRouter;