/**
 * Automation/workflow liveness (audit F-A2).
 * ============================================================================
 * The bus mechanics were tested in isolation with hand-fed events, which hid
 * the fact that the core domains published NOTHING: 4 of the 5 seeded
 * automations referenced triggers with no runtime emitter, and the workflow
 * auto-start trigger (`expense.requested`) had none either. These tests pin
 * the FULL chain — real route → emitted event → handler/automation side
 * effect — for every seeded trigger, so a removed emitter fails a test
 * instead of silently switching a advertised control off.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';

import { invoicesRouter } from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { registerEventHandlers } from '../core/events/handlers.js';
import { eventBus } from '../core/events/event-bus.js';
import { seedDefaultAutomations } from '../routes/automations.routes.js';
import { assignRole } from './support/identity.js';

const BRANCH = 'autolv_branch';
const CLASS_ID = 'autolv_class';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}

const user = (): TokenPayload => ({
  userId: 'u_autolv', username: 'autolv', branchId: BRANCH, fullName: 'Autolv Mgr',
});
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

let app: express.Express;
let seq = 0;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  registerEventHandlers();
  seedDefaultAutomations();
  eventBus.markHandlersReady();

  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Autolv Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run('u_autolv', 'autolv', 'Autolv Mgr', BRANCH, await hashPassword('x'));
  assignRole('u_autolv', 'manager', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,lifecycle_stage,schedule_time,fee,capacity)
     VALUES (?,?,'A1',?,'active','in_progress','08:00',5000,30)`,
  ).run(CLASS_ID, 'Autolv Class', BRANCH);
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('autolv_registration_fee', ?, 'registration', 'Registration fee', 0, 1, 1)
  `).run(BRANCH);

  app = createApp();
});

const notifications = () =>
  db.prepare('SELECT title, message FROM notifications WHERE branch_id = ? ORDER BY rowid DESC').all(BRANCH) as Array<{ title: string; message: string }>;

describe('automation liveness — every seeded trigger has a working emitter chain', () => {
  it('student.registered: registering a student fires the welcome automation and handler notification', async () => {
    seq += 1;
    const before = notifications().length;
    const res = await supertest(app).post('/api/students/manual').set(auth()).send({
      fullName: `Autolv Student ${seq}`, phone: `0799${String(300000 + seq).slice(-6)}`, gender: 'male', branchId: BRANCH,
    });
    expect(res.status).toBe(201);

    // Give the fire-and-forget dispatch a beat, then require the chain.
    await new Promise((r) => setTimeout(r, 150));
    const rows = notifications();
    expect(rows.length).toBeGreaterThan(before);
    expect(rows.some((n) => n.title === 'New Student Registered')).toBe(true);
    expect(rows.some((n) => n.title === 'New student registered')).toBe(true); // seeded automation action
    const persisted = db.prepare(`SELECT COUNT(*) c FROM domain_events WHERE type='student.registered'`).get() as { c: number };
    expect(persisted.c).toBeGreaterThan(0);
  });

  it('payment.received: a partial tuition payment fires the outstanding-balance automation with the real remaining balance', async () => {
    seq += 1;
    const reg = await supertest(app).post('/api/students/manual').set(auth()).send({
      fullName: `Autolv Payer ${seq}`, phone: `0799${String(400000 + seq).slice(-6)}`, gender: 'male', branchId: BRANCH,
    });
    expect(reg.status).toBe(201);
    const sid = reg.body.id as string;

    const enroll = await supertest(app).post(`/api/students/${sid}/enroll-semester`).set(auth())
      .send({ semesterName: 'Liveness Term', classId: CLASS_ID, amountPaidNow: 2000 });
    expect(enroll.status).toBe(201);

    await new Promise((r) => setTimeout(r, 150));
    const rows = notifications();
    // Handler notification for the enrollment cash leg…
    expect(rows.some((n) => n.title === 'Payment Received' && /2,000/.test(n.message))).toBe(true);
    // …and the automation, which fires because remainingBalance (3000) > 0.
    expect(rows.some((n) => n.title === 'Outstanding balance')).toBe(true);

    const semesterId = db.prepare(`SELECT id FROM student_semesters WHERE student_id = ? AND semester_name='Liveness Term'`).get(sid) as { id: string };
    const pay = await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .send({ amount: 3000, category: 'fee', paymentMethod: 'cash', semesterId: semesterId.id });
    expect(pay.status).toBe(201);
    await new Promise((r) => setTimeout(r, 150));
    // Debt cleared: the automation must NOT fire for the settling payment,
    // but the handler notification must.
    const after = notifications();
    expect(after.some((n) => n.title === 'Payment Received' && /3,000/.test(n.message))).toBe(true);
    const outstandingAfter = after.filter((n) => n.title === 'Outstanding balance').length;
    await new Promise((r) => setTimeout(r, 100));
    expect(notifications().filter((n) => n.title === 'Outstanding balance').length).toBe(outstandingAfter);
  });

  it('dispatched events are recorded in the handler log, and pipeline_metrics is gone', () => {
    const logs = db.prepare(`SELECT COUNT(*) c FROM event_handler_log`).get() as { c: number };
    expect(logs.c).toBeGreaterThan(0);
    // The write-only analytics materialization was removed with its handler
    // (LAW 1: /api/events/stats derives the same fact from domain_events).
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE name='pipeline_metrics'`).get();
    expect(table).toBeUndefined();
  });
});
