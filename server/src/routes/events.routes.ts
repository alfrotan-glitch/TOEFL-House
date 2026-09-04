/**
 * TOEFL House ERP — Event Routes (BC #14)
 * ============================================================
 *
 * REST endpoints for the Event Bounded Context: browsing the domain
 * event stream, replaying events for debugging, managing event
 * subscriptions, and viewing event handler execution logs.
 *
 * Access control:
 *   - Event.View: stream, chain, statistics, handler logs and type registry
 *   - Event.Manage: replay, flush and subscription mutation
 *
 * @module routes/events.routes
 * @version 2.0.0
 * @license Apache-2.0
 */

import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, canAccessBranchResource, requirePermission } from '../middleware/auth.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { eventBus } from '../core/events/event-bus.js';
import { DOMAIN_EVENT_CATALOG, isDomainEventType, isEmittedEventType, type DomainEventType } from '../core/events/event-registry.js';

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
  requirePermission('Event.View'),
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
  requirePermission('Event.View'),
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
  requirePermission('Event.View'),
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
  requirePermission('Event.Manage'),
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
  requirePermission('Event.Manage'),
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
  requirePermission('Event.Manage'),
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
  requirePermission('Event.Manage'),
  ah(async (req, res) => {
    const rawEventType = typeof req.body?.eventType === 'string' ? req.body.eventType.trim() : '';
    const handler = typeof req.body?.handler === 'string' ? req.body.handler.trim() : '';
    if (!rawEventType || !handler) throw new HttpError(400, 'eventType and handler are required.');
    if (!isDomainEventType(rawEventType)) throw new HttpError(400, `Unknown event type '${rawEventType}'.`);

    const validHandlers = ['workflow', 'automation', 'notification', 'webhook'];
    if (!validHandlers.includes(handler)) {
      throw new HttpError(400, `Invalid handler. Must be one of: ${validHandlers.join(', ')}`);
    }
    const newId = id('es');
    stmtInsertSubscription.run(newId, rawEventType, handler, JSON.stringify(req.body?.config || {}));


    writeAudit(req, `Created event subscription: ${handler} → ${rawEventType}`);
    res.status(201).json({ id: newId });
  })
);

eventsRouter.patch(
  '/subscriptions/:id',
  requirePermission('Event.Manage'),
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
  requirePermission('Event.Manage'),
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
  requirePermission('Event.View'),
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
  requirePermission('Event.Manage'),
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
  requirePermission('Event.View'),
  ah(async (_req, res) => {
    // `emitted` separates real events from reserved vocabulary, so trigger
    // pickers built on this endpoint cannot offer a type that never fires.
    res.json({
      count: DOMAIN_EVENT_CATALOG.length,
      types: DOMAIN_EVENT_CATALOG.map((entry) => ({ ...entry, emitted: isEmittedEventType(entry.type) })),
    });
  })
);

export default eventsRouter;