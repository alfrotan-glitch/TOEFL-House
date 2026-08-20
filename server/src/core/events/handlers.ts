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
const log = createLogger('handlers');

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtGetActiveWorkflowDef = db.prepare(
  "SELECT * FROM workflow_definitions WHERE trigger = ? AND is_active = 1 LIMIT 1"
);
const stmtInsertWorkflowInstance = db.prepare(
  `INSERT INTO workflow_instances (id, definition_id, entity_type, entity_id, current_step, status, branch_id, initiated_by, payload)
   VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?)`
);
const stmtInsertWorkflowHistory = db.prepare(
  `INSERT INTO workflow_history (id, instance_id, step_order, actor, action, notes)
   VALUES (?, ?, 0, 'system', 'initiated', 'Workflow auto-started by event')`
);
const stmtUpsertPipelineMetric = db.prepare(
  `INSERT INTO pipeline_metrics (pipeline, stage, count, conversion_rate, average_time_in_stage, branch_id, computed_at)
   VALUES ('event_stream', ?, 1, 0, 0, ?, datetime('now'))
   ON CONFLICT(pipeline, stage, branch_id) DO UPDATE SET count = count + 1, computed_at = datetime('now')`
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
    'expense.requested',
    async (event: DomainEvent) => {
      const wfDef = stmtGetActiveWorkflowDef.get(event.type) as any;
      if (!wfDef) return;

      const { title, amount, requester, branchId } = event.payload as BaseEventPayload;
      const instanceId = id('wfi');
      const startWorkflowTx = db.transaction(() => {
        stmtInsertWorkflowInstance.run(
          instanceId,
          wfDef.id,
          'expense_request',
          event.aggregateId,
          branchId || event.branchId,
          event.operatorId,
          JSON.stringify({ title, amount, requester })
        );

        stmtInsertWorkflowHistory.run(
          id('wfh'), 
          instanceId
        );
      });
      
      startWorkflowTx();
    },
    'workflow-expense-requested',
    50,
    true
  );

  // ── Analytics / Pipeline Metrics Handler ──────────────────────────────

  eventBus.on(
    '*',
    async (event: DomainEvent) => {
      try {
        stmtUpsertPipelineMetric.run(event.type, event.branchId);
      } catch (err) {
        // Non-critical — analytics should never break event processing
        log.error('[EventBus] Analytics logging failed:', err);
      }
    },
    'analytics-event-logger',
    200,
    true
  );

  log.info(`[EventBus] Registered ${eventBus.listHandlers().length} event handlers.`);
}