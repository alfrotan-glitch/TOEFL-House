/**
TOEFL House ERP — Event Bus Handler Registration
============================================================
Registers all domain event handlers at application startup.
*/
import { db } from '../../db/connection.js';
import { eventBus, DomainEvent } from './event-bus.js';
import { addNotification } from '../../utils/notifications.js';
import { id } from '../../utils/ids.js';
import { createLogger } from '../observability/logger.js';
import { processAutomationsForEvent } from './automation-engine.js';
const log = createLogger('handlers');

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtGetActiveWorkflowDefs = db.prepare(
  "SELECT * FROM workflow_definitions WHERE trigger = ? AND is_active = 1 ORDER BY created_at ASC"
);
const stmtInsertWorkflowInstance = db.prepare(
  `INSERT INTO workflow_instances (id, definition_id, entity_type, entity_id, current_step, status, branch_id, initiated_by, payload)
   VALUES (?, ?, ?, ?, 1, 'in_progress', ?, ?, ?)`
);
const stmtInsertWorkflowHistory = db.prepare(
  `INSERT INTO workflow_history (id, instance_id, step_order, actor, action, notes, timestamp)
   VALUES (?, ?, 0, 'system', 'start', 'Workflow auto-started by event', ?)`
);

// Helper interfaces for type safety (replaces `any`)
interface BaseEventPayload {
  branchId?: string;
  fullName?: string;
  studentName?: string;
  donorName?: string;
  amount?: number;
  studentCode?: string;
  classId?: string;
  date?: string;
  recordCount?: number;
  title?: string;
  requester?: string;
  period?: string;
  metricsCount?: number;
}

function inferEntityTypeFromEventType(eventType: string): string {
  const [aggregate] = eventType.split('.', 1);
  return aggregate === 'expense' ? 'expense_request' : aggregate;
}

/**
Registers all event handlers on the global eventBus singleton.
*/
export function registerEventHandlers(): void {
  // ── Notification Handlers ─────────────────────────────────────────────

  eventBus.on(
    'student.registered',
    async (event: DomainEvent) => {
      const { fullName, studentCode, branchId } = event.payload as BaseEventPayload;
      addNotification(
        'New Student Registered',
        `${fullName || 'A new student'} (${studentCode || event.aggregateId}) has been registered.`,
        'success',
        branchId || event.branchId
      );
    },
    'notify-student-registered',
    100,
    true
  );

  eventBus.on(
    'payment.received',
    async (event: DomainEvent) => {
      const { amount, studentName, branchId } = event.payload as BaseEventPayload;
      if (amount) {
        addNotification(
          'Payment Received',
          `A payment of ${Number(amount).toLocaleString()} AFN was received${studentName ? ` from ${studentName}` : ''}.`,
          'success',
          branchId || event.branchId
        );
      }
    },
    'notify-payment-received',
    100,
    true
  );

  eventBus.on(
    'donation.received',
    async (event: DomainEvent) => {
      const { amount, donorName, branchId } = event.payload as BaseEventPayload;
      if (amount) {
        addNotification(
          'Donation Received',
          `A donation of ${Number(amount).toLocaleString()} AFN was received${donorName ? ` from ${donorName}` : ''}.`,
          'success',
          branchId || event.branchId
        );
      }
    },
    'notify-donation-received',
    100,
    true
  );

  eventBus.on(
    'session.completed',
    async (event: DomainEvent) => {
      const { classId, date, branchId } = event.payload as BaseEventPayload;
      addNotification(
        'Session Completed',
        `A session${classId ? ` for class ${classId}` : ''} on ${date || 'today'} has been marked as completed.`,
        'info',
        branchId || event.branchId
      );
    },
    'notify-session-completed',
    100,
    true
  );

  eventBus.on(
    'attendance.marked',
    async (event: DomainEvent) => {
      const { recordCount, branchId } = event.payload as BaseEventPayload;
      if (recordCount) {
        addNotification(
          'Attendance Marked',
          `Attendance has been marked for ${recordCount} student(s).`,
          'info',
          branchId || event.branchId
        );
      }
    },
    'notify-attendance-marked',
    100,
    true
  );

  eventBus.on(
    'expense.requested',
    async (event: DomainEvent) => {
      const { title, amount, branchId } = event.payload as BaseEventPayload;
      addNotification(
        'Expense Request Pending',
        `Expense request "${title || 'Untitled'}" for ${Number(amount || 0).toLocaleString()} AFN is awaiting approval.`,
        'warning',
        branchId || event.branchId
      );
    },
    'notify-expense-requested',
    100,
    true
  );

  eventBus.on(
    'scholarship.awarded',
    async (event: DomainEvent) => {
      const { studentName, amount, branchId } = event.payload as BaseEventPayload;
      addNotification(
        'Scholarship Awarded',
        `${studentName || 'A student'} was awarded ${Number(amount || 0).toLocaleString()} AFN in scholarship funds.`,
        'success',
        branchId || event.branchId
      );
    },
    'notify-scholarship-awarded',
    100,
    true
  );

  eventBus.on(
    'impact.report_generated',
    async (event: DomainEvent) => {
      const { period, metricsCount, branchId } = event.payload as BaseEventPayload;
      addNotification(
        'Impact Report Generated',
        `An impact report for ${period || 'the current period'} was generated with ${metricsCount || 0} metrics.`,
        'info',
        branchId || event.branchId
      );
    },
    'notify-impact-report',
    100,
    true
  );

  // ── Workflow Trigger Handlers ─────────────────────────────────────────

  eventBus.on(
    '*',
    async (event: DomainEvent) => {
      const defs = stmtGetActiveWorkflowDefs.all(event.type) as Array<{ id: string }>;
      if (defs.length === 0) return;

      const payload = event.payload as BaseEventPayload;
      const entityType = inferEntityTypeFromEventType(event.type);
      const branchId = payload.branchId || event.branchId;
      const actor = event.operatorId || 'system';
      const startedAt = event.occurredAt;
      const startWorkflowTx = db.transaction(() => {
        for (const wfDef of defs) {
          const instanceId = id('wfi');
          stmtInsertWorkflowInstance.run(
            instanceId,
            wfDef.id,
            entityType,
            event.aggregateId,
            branchId,
            actor,
            JSON.stringify(event.payload),
          );
          stmtInsertWorkflowHistory.run(id('wfh'), instanceId, startedAt);
        }
      });
      startWorkflowTx();
    },
    'workflow-auto-start',
    50,
    true,
  );

  eventBus.on(
    '*',
    async (event: DomainEvent) => {
      processAutomationsForEvent(event);
    },
    'automation-engine',
    150,
    true,
  );

  // NOTE (audit F-A2): the former "analytics-event-logger" handler upserted a
  // per-type count into `pipeline_metrics` — a second, write-only authority
  // for a fact `GET /api/events/stats` already derives from the `domain_events`
  // outbox (LAW 1: one authority per fact). Table and handler are removed
  // together; event statistics remain queryable from the outbox.

  log.info(`[EventBus] Registered ${eventBus.listHandlers().length} event handlers.`);
}