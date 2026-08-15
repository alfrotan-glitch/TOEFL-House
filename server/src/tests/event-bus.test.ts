/**
Integration test: Event Bus handler registration and dispatch (Audit §4.1)
Verifies that handlers are registered and events are dispatched correctly.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { eventBus } from '../core/events/event-bus.js';
import { registerEventHandlers } from '../core/events/handlers.js';

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  registerEventHandlers();
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Event Bus Integration', () => {
  it('registers handlers at startup', () => {
    const handlers = eventBus.listHandlers();
    expect(handlers.length).toBeGreaterThan(0);
  });

  it('dispatches a student.registered event and creates a notification', async () => {
    const event = eventBus.createEvent(
      'student.registered',
      'student',
      's_test_event',
      { fullName: 'Event Test Student', studentCode: 'TH-EVT-001', branchId: 'b1' },
      { operatorId: 'u1', branchId: 'b1' }
    );
    eventBus.persistEvent(event);
    const result = await eventBus.dispatch(event);

    expect(result.handlersExecuted).toBeGreaterThan(0);
    expect(result.handlersFailed).toBe(0);

    // Verify notification was created
    const notification = db
      .prepare("SELECT * FROM notifications WHERE title = 'New Student Registered' ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(notification).toBeDefined();
    expect(notification.message).toContain('Event Test Student');
  });

  it('dispatches a payment.received event and creates a notification', async () => {
    const event = eventBus.createEvent(
      'payment.received',
      'payment',
      'pay_test_event',
      { amount: 5000, studentName: 'Payment Test Student', branchId: 'b1' },
      { operatorId: 'u1', branchId: 'b1' }
    );
    eventBus.persistEvent(event);
    const result = await eventBus.dispatch(event);

    expect(result.handlersExecuted).toBeGreaterThan(0);
    expect(result.handlersFailed).toBe(0);

    const notification = db
      .prepare("SELECT * FROM notifications WHERE title = 'Payment Received' ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(notification).toBeDefined();
    expect(notification.message).toContain('5,000');
  });

  it('triggers a workflow instance on expense.requested', async () => {
    // Seed a workflow definition for expense.requested
    db.prepare(
      `INSERT OR IGNORE INTO workflow_definitions (id, name, trigger, steps, is_active)
       VALUES ('wfd_test_expense', 'Test Expense Workflow', 'expense.requested', '[]', 1)`
    ).run();

    const event = eventBus.createEvent(
      'expense.requested',
      'expense',
      'exp_test_event',
      { title: 'Test Expense', amount: 3000, requester: 'Test User', branchId: 'b1' },
      { operatorId: 'u1', branchId: 'b1' }
    );
    eventBus.persistEvent(event);
    const result = await eventBus.dispatch(event);

    expect(result.handlersFailed).toBe(0);

    // Verify workflow instance was created
    const instance = db
      .prepare("SELECT * FROM workflow_instances WHERE entity_id = 'exp_test_event'")
      .get() as any;
    expect(instance).toBeDefined();
    expect(instance.status).toBe('pending');
  });
});