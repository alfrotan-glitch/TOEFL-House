/**
 * WP-12 — Workflow & automation executable authority.
 * ============================================================================
 * Locks the package-local truths introduced in WP-12:
 *   - workflow/automation/event routes are permission-governed
 *   - workflow and automation triggers come from the canonical event registry
 *   - event dispatch actually starts workflows and executes automations
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import workflowsRouter from '../../../routes/workflows.routes.js';
import automationsRouter from '../../../routes/automations.routes.js';
import eventsRouter from '../../../routes/events.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { eventBus } from '../../../core/events/event-bus.js';
import { registerEventHandlers } from '../../../core/events/handlers.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import { DOMAIN_EVENT_CATALOG } from '../../../core/events/event-registry.js';

const BRANCH = 'wp12_branch';
const OWNER = 'u_wp12_owner';
const GM = 'u_wp12_gm';
const FINANCE = 'u_wp12_finance';
const HOD = 'u_wp12_hod';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/automations', automationsRouter);
  app.use('/api/events', eventsRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'WP12 Branch', 'Kabul');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, fullName: 'WP12 Owner' });
  seedUser({ id: GM, role: 'general_manager', branchId: BRANCH, fullName: 'WP12 GM' });
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BRANCH, fullName: 'WP12 Finance' });
  seedUser({ id: HOD, role: 'head_of_department', branchId: BRANCH, fullName: 'WP12 HOD' });
});

beforeEach(() => {
  db.prepare('DELETE FROM workflow_history').run();
  db.prepare('DELETE FROM workflow_instances').run();
  db.prepare('DELETE FROM workflow_definitions').run();
  db.prepare('DELETE FROM event_handler_log').run();
  db.prepare('DELETE FROM domain_events').run();
  db.prepare('DELETE FROM event_subscriptions').run();
  db.prepare('DELETE FROM automations').run();
  db.prepare('DELETE FROM notifications').run();
  eventBus.clear();
  registerEventHandlers();
  eventBus.markHandlersReady();
});

describe('WP-12 package-local authority', () => {
  it('denies workflow surfaces to a role without Workflow.View but allows finance to read automations', async () => {
    const app = createApp();

    const hodRes = await supertest(app)
      .get('/api/automations')
      .set(bearerFor(HOD));
    expect(hodRes.status).toBe(403);

    const financeRes = await supertest(app)
      .get('/api/automations')
      .set(bearerFor(FINANCE));
    expect(financeRes.status).toBe(200);
    expect(Array.isArray(financeRes.body)).toBe(true);
  });

  it('requires owner-only Automation.Edit for automation mutation', async () => {
    const app = createApp();

    const managerDenied = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(GM))
      .send({
        name: 'Manager should not create this',
        trigger: 'payment.received',
        conditions: [{ field: 'remainingBalance', operator: 'gt', value: 0 }],
        actions: [{ type: 'notify', config: { title: 'Nope', message: 'Blocked.', severity: 'warning' } }],
      });
    expect(managerDenied.status).toBe(403);

    const created = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(OWNER))
      .send({
        name: 'Balance reminder',
        trigger: 'payment.received',
        conditions: [{ field: 'remainingBalance', operator: 'gt', value: 0 }],
        actions: [{ type: 'notify', config: { title: 'Balance reminder', message: 'Balance remains due.', severity: 'warning' } }],
      });
    expect(created.status).toBe(201);

    const financeDenied = await supertest(app)
      .patch(`/api/automations/${created.body.id}`)
      .set(bearerFor(FINANCE))
      .send({ isActive: false });
    expect(financeDenied.status).toBe(403);
  });

  it('accepts only canonical workflow and automation triggers', async () => {
    const app = createApp();

    const badWorkflow = await supertest(app)
      .post('/api/workflows/definitions')
      .set(bearerFor(OWNER))
      .send({
        name: 'Broken trigger workflow',
        trigger: 'payment.never_happened',
        steps: [{ role: 'general_manager', action: 'approve', label: 'Approve' }],
      });
    expect(badWorkflow.status).toBe(400);
    expect(String(badWorkflow.body.error)).toContain('Unknown workflow trigger');

    const badAutomation = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(OWNER))
      .send({
        name: 'Broken trigger automation',
        trigger: 'payment.never_happened',
        conditions: [],
        actions: [{ type: 'notify', config: { message: 'x' } }],
      });
    expect(badAutomation.status).toBe(400);
    expect(String(badAutomation.body.error)).toContain('Unknown automation trigger');
  });

  it('reports an unknown workflow step role instead of silently accepting it', async () => {
    const app = createApp();

    const res = await supertest(app)
      .post('/api/workflows/definitions')
      .set(bearerFor(OWNER))
      .send({
        name: 'Broken role workflow',
        trigger: 'manual',
        steps: [{ role: 'imaginary_role', action: 'approve', label: 'Approve' }],
      });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('imaginary_role');
  });

  it('routes event browsing through Event.View instead of role labels', async () => {
    const app = createApp();

    const gmRes = await supertest(app)
      .get('/api/events/types')
      .set(bearerFor(GM));
    expect(gmRes.status).toBe(200);
    expect(gmRes.body.count).toBe(DOMAIN_EVENT_CATALOG.length);
    expect(gmRes.body.types).toEqual(DOMAIN_EVENT_CATALOG);

    const financeRes = await supertest(app)
      .get('/api/events/types')
      .set(bearerFor(FINANCE));
    expect(financeRes.status).toBe(403);
  });

  it('dispatches an event and auto-starts every matching workflow in progress', async () => {
    db.prepare(
      `INSERT INTO workflow_definitions (id, name, trigger, steps, is_active)
       VALUES (?, ?, ?, ?, 1)`
    ).run(
      'wp12_wfd_expense',
      'Expense approval',
      'expense.requested',
      JSON.stringify([{ order: 1, role: 'general_manager', action: 'approve', label: 'Approve expense' }]),
    );

    const event = eventBus.createEvent(
      'expense.requested',
      'expense',
      'wp12_expense_1',
      { title: 'Projector repair', amount: 3000, requester: 'Ops', branchId: BRANCH },
      { operatorId: GM, branchId: BRANCH },
    );
    eventBus.persistEvent(event);
    const result = await eventBus.dispatch(event);

    expect(result.handlersFailed).toBe(0);

    const instance = db.prepare('SELECT * FROM workflow_instances WHERE entity_id = ?').get('wp12_expense_1') as any;
    expect(instance).toBeTruthy();
    expect(instance.definition_id).toBe('wp12_wfd_expense');
    expect(instance.status).toBe('in_progress');
    expect(instance.branch_id).toBe(BRANCH);

    const history = db.prepare('SELECT * FROM workflow_history WHERE instance_id = ? ORDER BY timestamp ASC').all(instance.id) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('start');
  });

  it('dispatches an event and executes matching automations with a handler log', async () => {
    const app = createApp();
    const created = await supertest(app)
      .post('/api/automations')
      .set(bearerFor(OWNER))
      .send({
        name: 'Outstanding balance alert',
        trigger: 'payment.received',
        conditions: [{ field: 'remainingBalance', operator: 'gt', value: 0 }],
        actions: [{ type: 'notify', config: { title: 'Outstanding balance alert', message: 'A student still has an outstanding balance.', severity: 'warning' } }],
      });
    expect(created.status).toBe(201);

    const event = eventBus.createEvent(
      'payment.received',
      'payment',
      'wp12_payment_1',
      { amount: 5000, studentName: 'Automation Student', remainingBalance: 250, branchId: BRANCH },
      { operatorId: GM, branchId: BRANCH },
    );
    eventBus.persistEvent(event);
    const result = await eventBus.dispatch(event);

    expect(result.handlersFailed).toBe(0);

    const notification = db.prepare('SELECT * FROM notifications WHERE title = ? ORDER BY date DESC, rowid DESC LIMIT 1').get('Outstanding balance alert') as any;
    expect(notification).toBeTruthy();
    expect(String(notification.message)).toContain('outstanding balance');
    expect(notification.branch_id).toBe(BRANCH);

    const log = db.prepare('SELECT * FROM event_handler_log WHERE event_id = ? AND handler = ?').get(event.id, `automation:${created.body.id}`) as any;
    expect(log).toBeTruthy();
    expect(log.success).toBe(1);
  });
});
