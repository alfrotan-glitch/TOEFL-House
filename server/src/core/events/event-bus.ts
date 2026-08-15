/**
TOEFL House ERP — Domain Event Bus
============================================================
The central nervous system of the entire architecture. Every state
transition in any Bounded Context publishes a Domain Event here.
Subscribers (workflows, automations, notifications, analytics) react
asynchronously without the publisher knowing or caring who listens.

Design Principles:
- Fire-and-Forget Publishing: Publishers never block on subscribers.
- Handler Isolation: A failing handler never crashes the bus or
  prevents other handlers from executing.
- Persistent Outbox: Every event is written to the `domain_events`
  table inside the same DB transaction as the state change, guaranteeing
  at-least-once delivery even if the process crashes mid-publish.
- Correlation & Causation: Every event carries a correlationId (the
  user-facing operation) and a causationId (the event that triggered it),
  enabling full causal tracing across Pipeline stages.
- Idempotent Handlers: Handlers receive a unique eventId and are
  expected to be idempotent; the bus tracks processed event-handler
  pairs to suppress duplicate delivery on replay.
- Replay Support: Events can be replayed from the persistent store for
  debugging, migration, or rebuilding read models.

@module core/events/event-bus
@version 2.0.0
@license Apache-2.0
*/
import { db } from '../../db/connection.js';
import { randomUUID } from 'node:crypto';

// ============================================================================
// §1 — TYPE DEFINITIONS
// ============================================================================

/**
Canonical event type registry. Every event in the system MUST use one
of these names. Adding a new event type requires adding it here first.

Naming convention: <aggregate>.<past-tense-verb>
e.g. "student.registered", "payment.received", "exam.result_recorded"
*/
export type DomainEventType =
  // ── CRM / Lead Pipeline ──
  | 'lead.created'
  | 'lead.followed_up'
  | 'lead.placement_scheduled'
  | 'lead.placement_completed'
  | 'lead.converted'
  | 'lead.lost'
  // ── Student ──
  | 'student.registered'
  | 'student.enrolled'
  | 'student.status_changed'
  | 'student.card_issued'
  | 'student.graduated'
  // ── Academic / Session ──
  | 'class.created'
  | 'class.updated'
  | 'class.lifecycle_changed'
  | 'class.activated'
  | 'session.scheduled'
  | 'session.completed'
  | 'session.cancelled'
  | 'attendance.marked'
  // ── Assessment ──
  | 'exam.created'
  | 'exam.result_recorded'
  | 'exam.certificate_issued'
  // ── Teacher / HR ──
  | 'teacher.created'
  | 'teacher.updated'
  | 'teacher.skill_assigned'
  | 'teacher.salary_paid'
  | 'employee.created'
  | 'employee.salary_paid'
  // ── Finance ──
  | 'payment.received'
  | 'payment.refunded'
  | 'invoice.created'
  | 'invoice.paid'
  | 'budget.charged'
  | 'budget.month_end_settled'
  | 'expense.requested'
  | 'expense.approved'
  | 'expense.rejected'
  | 'saving.transferred'
  | 'profit.withdrawn'
  // ── Inventory ──
  | 'book.added'
  | 'book.restocked'
  | 'book.sold'
  | 'book.sale_refunded'
  // ── Funding / Donation ──
  | 'donor.created'
  | 'donation.received'
  | 'campaign.created'
  | 'scholarship.awarded'
  | 'sponsorship.created'
  // ── Impact ──
  | 'impact.report_generated'
  // ── Workflow / Automation ──
  | 'workflow.started'
  | 'workflow.step_completed'
  | 'workflow.completed'
  | 'workflow.rejected'
  | 'automation.triggered'
  // ── System ──
  | 'user.created'
  | 'user.password_changed'
  | 'branch.created'
  | 'settings.updated';

/** The aggregate (entity) that emitted the event. */
export type AggregateType =
  | 'lead' | 'student' | 'class' | 'session' | 'exam'
  | 'teacher' | 'employee' | 'payment' | 'invoice'
  | 'budget' | 'expense' | 'book' | 'donor' | 'donation'
  | 'campaign' | 'scholarship' | 'sponsorship' | 'impact'
  | 'workflow' | 'automation' | 'user' | 'branch' | 'settings';

/** A fully-formed domain event ready for publishing. */
export interface DomainEvent {
  id: string;
  type: DomainEventType;
  aggregateType: AggregateType;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  operatorId: string | null;
  branchId: string;
  correlationId: string;
  causationId: string | null;
  schemaVersion: number;
}

/** Options when publishing an event. */
export interface PublishOptions {
  correlationId?: string;
  causationId?: string | null;
  operatorId?: string | null;
  branchId?: string;
  schemaVersion?: number;
}

/** A synchronous event handler function. */
export type EventHandler = (event: DomainEvent) => void | Promise<void>;

/** Registration record for a handler. */
interface HandlerRegistration {
  eventType: DomainEventType | '*';
  handler: EventHandler;
  name: string;
  priority: number;
  optional: boolean;
}

/** Result of processing a single handler. */
interface HandlerResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** Result of publishing a single event. */
export interface PublishResult {
  eventId: string;
  handlersExecuted: number;
  handlersFailed: number;
  results: HandlerResult[];
  totalDurationMs: number;
}

// ============================================================================
// §2 — SCHEMA INITIALIZATION
// ============================================================================

export function initEventBusSchema(): void {
  // Intentionally empty — schema.sql is the single source of truth.
}

// ============================================================================
// §3 — EVENT BUS CLASS
// ============================================================================

class EventBus {
  private handlers: HandlerRegistration[] = [];
  private handlersReady = false;
  private recoveryInProgress = false;
  private recoveryTimer: NodeJS.Timeout | null = null;

  // ── Performance: Class-level Prepared Statements ───────────────────────
  private readonly stmtInsertEvent: any;
  private readonly stmtGetUnpublished: any;
  private readonly stmtMarkPublished: any;
  private readonly stmtGetProcessedHandlers: any;
  private readonly stmtInsertHandlerLog: any;
  private readonly stmtGetAggregateEvents: any;
  private readonly stmtGetCorrelationChain: any;
  private readonly stmtGetRecentEvents: any;
  private readonly stmtGetEventCounts: any;

  constructor() {
    this.stmtInsertEvent = db.prepare(
      `INSERT INTO domain_events (id, type, aggregate_type, aggregate_id, payload, occurred_at, operator_id, branch_id, correlation_id, causation_id, schema_version, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    this.stmtGetUnpublished = db.prepare(
      `SELECT * FROM domain_events WHERE published = 0 ORDER BY occurred_at ASC LIMIT 500`
    );
    this.stmtMarkPublished = db.prepare(`UPDATE domain_events SET published = 1 WHERE id = ?`);
    this.stmtGetProcessedHandlers = db.prepare(
      `SELECT handler FROM event_handler_log WHERE event_id = ? AND success = 1`
    );
    this.stmtInsertHandlerLog = db.prepare(
      `INSERT INTO event_handler_log (id, event_id, handler, success, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, handler) DO UPDATE SET success = excluded.success, duration_ms = excluded.duration_ms, error = excluded.error, executed_at = datetime('now')`
    );
    this.stmtGetAggregateEvents = db.prepare(
      `SELECT * FROM domain_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY occurred_at ASC`
    );
    this.stmtGetCorrelationChain = db.prepare(
      `SELECT * FROM domain_events WHERE correlation_id = ? ORDER BY occurred_at ASC`
    );
    this.stmtGetRecentEvents = db.prepare(
      `SELECT * FROM domain_events WHERE 1=1 ORDER BY occurred_at DESC LIMIT ?`
    );
    this.stmtGetEventCounts = db.prepare(
      `SELECT type, COUNT(*) as count FROM domain_events WHERE occurred_at BETWEEN ? AND ? GROUP BY type ORDER BY count DESC`
    );
  }

  // ------------------------------------------------------------------
  // §3.1 — Handler Registration
  // ------------------------------------------------------------------

  on(
    eventType: DomainEventType | '*',
    handler: EventHandler,
    name: string,
    priority: number = 100,
    optional: boolean = false,
  ): void {
    const exists = this.handlers.some(
      (h) => h.eventType === eventType && h.name === name,
    );
    if (exists) {
      console.warn(`[EventBus] Handler "${name}" already registered for "${eventType}". Skipping.`);
      return;
    }

    this.handlers.push({ eventType, handler, name, priority, optional });
    this.handlers.sort((a, b) => a.priority - b.priority);
  }

  startRecovery(intervalMs = 30000): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => {
      void this.flushUnpublished().catch((error) => {
        console.error('[EventBus] Background recovery failed:', error);
      });
    }, intervalMs);
    this.recoveryTimer.unref();
  }

  stopRecovery(): void {
    if (!this.recoveryTimer) return;
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  off(eventType: DomainEventType | '*', name: string): void {
    this.handlers = this.handlers.filter(
      (h) => !(h.eventType === eventType && h.name === name),
    );
  }

  clear(): void {
    this.handlers = [];
    this.handlersReady = false;
  }

  markHandlersReady(): void {
    this.handlersReady = true;
  }

  listHandlers(eventType?: DomainEventType): string[] {
    return this.handlers
      .filter((h) => !eventType || h.eventType === eventType || h.eventType === '*')
      .map((h) => `${h.name} [${h.eventType}] (priority: ${h.priority})`);
  }

  // ------------------------------------------------------------------
  // §3.2 — Event Creation & Persistence
  // ------------------------------------------------------------------

  createEvent(
    type: DomainEventType,
    aggregateType: AggregateType,
    aggregateId: string,
    payload: Record<string, unknown>,
    options: PublishOptions = {},
  ): DomainEvent {
    return {
      id: `evt_${randomUUID()}`,
      type,
      aggregateType,
      aggregateId,
      payload,
      occurredAt: new Date().toISOString(),
      operatorId: options.operatorId ?? null,
      branchId: options.branchId ?? 'global',
      correlationId: options.correlationId ?? `corr_${randomUUID()}`,
      causationId: options.causationId ?? null,
      schemaVersion: options.schemaVersion ?? 1,
    };
  }

  persistEvent(event: DomainEvent): void {
    this.stmtInsertEvent.run(
      event.id,
      event.type,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
      event.occurredAt,
      event.operatorId,
      event.branchId,
      event.correlationId,
      event.causationId,
      event.schemaVersion,
    );
  }

  emit(
    type: DomainEventType,
    aggregateType: AggregateType,
    aggregateId: string,
    payload: Record<string, unknown>,
    options: PublishOptions = {},
  ): DomainEvent {
    const event = this.createEvent(type, aggregateType, aggregateId, payload, options);
    this.persistEvent(event);
    return event;
  }

  // ------------------------------------------------------------------
  // §3.3 — Event Dispatch (Handler Execution)
  // ------------------------------------------------------------------

  async dispatch(event: DomainEvent): Promise<PublishResult> {
    const startTime = performance.now();

    const matchingHandlers = this.handlers.filter(
      (h) => h.eventType === event.type || h.eventType === '*',
    );

    if (matchingHandlers.length === 0) {
      // Before startup registration completes, leave the event pending. This
      // closes the historical startup-loss window. After handlers are known to
      // be ready, an event with no subscribers is safely considered consumed.
      if (!this.handlersReady) {
        return { eventId: event.id, handlersExecuted: 0, handlersFailed: 1, results: [{ name: 'event-bus-not-ready', success: false, durationMs: 0, error: 'Handlers are not ready.' }], totalDurationMs: 0 };
      }
      this.stmtMarkPublished.run(event.id);
      return { eventId: event.id, handlersExecuted: 0, handlersFailed: 0, results: [], totalDurationMs: 0 };
    }

    const processedRows = this.stmtGetProcessedHandlers.all(event.id) as { handler: string }[];
    const processedSet = new Set(processedRows.map(r => r.handler));

    const handlersToRun = matchingHandlers.filter(h => !processedSet.has(h.name));

    const results: HandlerResult[] = [];
    let handlersFailed = 0;

    // Priority is a semantic contract: run lower numbers first so dependent
    // handlers cannot race ahead of prerequisite handlers.
    for (const registration of handlersToRun.sort((a, b) => a.priority - b.priority)) {
      const handlerStart = performance.now();
      let success = true;
      let error: string | undefined;

      try {
        await registration.handler(event);
      } catch (err) {
        success = false;
        handlersFailed++;
        error = err instanceof Error ? err.message : String(err);
        if (!registration.optional) {
          console.error(`[EventBus] Handler "${registration.name}" failed for ${event.id}:`, error);
        }
      }

      const durationMs = Math.round((performance.now() - handlerStart) * 100) / 100;
      results.push({ name: registration.name, success, durationMs, error });
    }

    const hasRequiredFailure = results.some((res) => {
      const registration = matchingHandlers.find((handler) => handler.name === res.name);
      return !res.success && !registration?.optional;
    });

    const logTx = db.transaction(() => {
      for (const res of results) {
        this.stmtInsertHandlerLog.run(
          `ehl_${event.id}_${res.name}`, event.id, res.name,
          res.success ? 1 : 0, res.durationMs, res.error ?? null
        );
      }
      if (!hasRequiredFailure) {
        this.stmtMarkPublished.run(event.id);
      }
    });
    logTx();

    return {
      eventId: event.id,
      handlersExecuted: handlersToRun.length,
      handlersFailed,
      results,
      totalDurationMs: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }

  async flushUnpublished(): Promise<number> {
    if (this.recoveryInProgress) return 0;
    this.recoveryInProgress = true;
    try {
      const unpublished = this.stmtGetUnpublished.all() as any[];
    let totalFlushed = 0;

    for (const row of unpublished) {
      const event = this.rowToEvent(row);
      await this.dispatch(event);
      totalFlushed++;
    }

      if (totalFlushed > 0) {
        console.log(`[EventBus] Recovered ${totalFlushed} unpublished event(s).`);
      }
      return totalFlushed;
    } finally {
      this.recoveryInProgress = false;
    }
  }

  // ------------------------------------------------------------------
  // §3.4 — Event Replay & Querying
  // ------------------------------------------------------------------

  async replayAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<DomainEvent[]> {
    const rows = this.stmtGetAggregateEvents.all(aggregateType, aggregateId) as any[];
    const events = rows.map(this.rowToEvent);
    for (const event of events) {
      await this.dispatch(event);
    }
    return events;
  }

  getCorrelationChain(correlationId: string): DomainEvent[] {
    return (this.stmtGetCorrelationChain.all(correlationId) as any[]).map(this.rowToEvent);
  }

  getRecentEvents(
    limit: number = 50,
    eventType?: DomainEventType,
    branchId?: string,
  ): DomainEvent[] {
    let sql = 'SELECT * FROM domain_events WHERE 1=1';
    const params: unknown[] = [];
    if (eventType) { sql += ' AND type = ?'; params.push(eventType); }
    if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
    sql += ' ORDER BY occurred_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(this.rowToEvent);
  }

  getEventCounts(
    from: string,
    to: string,
    branchId?: string,
  ): Array<{ type: string; count: number }> {
    let sql = `SELECT type, COUNT(*) as count FROM domain_events WHERE occurred_at BETWEEN ? AND ?`;
    const params: unknown[] = [from, to];
    if (branchId) {
      sql += ' AND branch_id = ?';
      params.push(branchId);
    }
    sql += ' GROUP BY type ORDER BY count DESC';
    return db.prepare(sql).all(...params) as Array<{ type: string; count: number }>;
  }

  // ------------------------------------------------------------------
  // §3.5 — Internal Helpers
  // ------------------------------------------------------------------

  private rowToEvent(row: any): DomainEvent {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { /* ignore */ }
    
    return {
      id: row.id,
      type: row.type as DomainEventType,
      aggregateType: row.aggregate_type as AggregateType,
      aggregateId: row.aggregate_id,
      payload,
      occurredAt: row.occurred_at,
      operatorId: row.operator_id,
      branchId: row.branch_id,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      schemaVersion: row.schema_version,
    };
  }
}

// ============================================================================
// §4 — SINGLETON EXPORT
// ============================================================================

export const eventBus = new EventBus();

// ============================================================================
// §5 — CONVENIENCE HELPERS
// ============================================================================

export function createChildEvent(
  parent: DomainEvent,
  type: DomainEventType,
  aggregateType: AggregateType,
  aggregateId: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return eventBus.createEvent(type, aggregateType, aggregateId, payload, {
    correlationId: parent.correlationId,
    causationId: parent.id,
    operatorId: parent.operatorId,
    branchId: parent.branchId,
  });
}

export async function initializeEventBus(): Promise<void> {
  initEventBusSchema();
  eventBus.markHandlersReady();
  await eventBus.flushUnpublished();
  eventBus.startRecovery();
  console.log('[EventBus] Initialized. Handlers registered:', eventBus.listHandlers().length);
}