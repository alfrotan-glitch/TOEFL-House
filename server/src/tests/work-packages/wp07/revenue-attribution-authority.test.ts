/**
 * WP-07 · Revenue is attributed to the class that earned it (WP07-F22).
 * ============================================================================
 * `stmtRevenueByClass` and `stmtRevenueByTimeSlot` did not know which term a
 * payment settled. They GUESSED it:
 *
 *     JOIN student_semesters ss ON ss.id = (
 *       SELECT s2.id FROM student_semesters s2
 *        WHERE s2.student_id = p.student_id
 *          AND (p.semester IS NULL OR s2.semester_name = p.semester)
 *        ORDER BY (s2.status = 'active') DESC, s2.enroll_date DESC
 *        LIMIT 1)
 *
 * Two properties of that rule are wrong, and both misstate real money:
 *
 *   A term NAME is not unique over time (`uq_student_semester_active` scopes
 *   uniqueness to ACTIVE terms), so a student repeating a term has two terms
 *   under one name and `ORDER BY (status='active') DESC` hands the money to
 *   whichever is open now — not the one that was paid.
 *
 *   A payment with no semester recorded is attributed to the student's most
 *   recent active term regardless of what it actually paid.
 *
 * E1b made the answer knowable: a tuition payment names the obligation it
 * settles, and the obligation names the term, which names the class.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import bosRouter from '../../../routes/bos.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/bos', bosRouter);
app.use('/api/students', studentsRouter);
app.use(errorHandler);

const TERM = 'Term One';
let key: string;
let branch: string;
let studentId: string;
let classA: string;
let classB: string;
let semA: string;
let semB: string;
let owner: { Authorization: string };
let seq = 0;

const seedClass = (id: string, name: string, slot: string) =>
  db.prepare(
    `INSERT INTO classes (id, name, level, capacity, fee, branch_id, status, lifecycle_stage, schedule_time)
     VALUES (?, ?, 'L1', 30, 10000, ?, 'active', 'enrollment_open', ?)`,
  ).run(id, name, branch, slot);

const revenueByClass = () =>
  supertest(app).get('/api/bos/revenue-by-class?timeframe=year').set(owner);

const revenueByTimeSlot = () =>
  supertest(app).get('/api/bos/revenue-by-timeslot?timeframe=year').set(owner);

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7v_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);

  classA = `${key}_ca`;
  classB = `${key}_cb`;
  seedClass(classA, 'Morning Class', '08:00');
  seedClass(classB, 'Evening Class', '18:00');

  studentId = `${key}_s`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Repeat Student', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-V${(seq += 1)}-${key.slice(-6)}`, today(), branch, `0788${String(100000 + seq).slice(-6)}`);

  // The SAME term name, twice: the first completed in the morning class, the
  // second currently running in the evening class. This is exactly what
  // `uq_student_semester_active` permits.
  semA = `${key}_sa`;
  semB = `${key}_sb`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, ?, 10000, 10000, 'completed')`,
  ).run(semA, studentId, TERM, classA, today());
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, ?, 10000, 10000, 'active')`,
  ).run(semB, studentId, TERM, classB, today());

  seedUser({ id: `${key}_own`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_own`);
});

describe('WP-07 · WP07-F22 — revenue lands on the class that earned it', () => {
  it('money paid for a repeated term is not handed to the class running now', async () => {
    // The student pays off the COMPLETED morning term.
    await supertest(app)
      .post(`/api/students/${studentId}/payments`)
      .set(owner)
      .send({ category: 'fee', amount: 10000, semesterId: semA })
      .expect(201);

    const byClass = await revenueByClass().expect(200);
    const rows = byClass.body as Array<{ name: string; revenue: number }>;
    const morning = rows.find((r) => r.name === 'Morning Class');
    const evening = rows.find((r) => r.name === 'Evening Class');

    expect(morning?.revenue).toBe(10000);
    expect(evening?.revenue ?? 0).toBe(0);
  });

  it('the time-slot report follows the same attribution', async () => {
    await supertest(app)
      .post(`/api/students/${studentId}/payments`)
      .set(owner)
      .send({ category: 'fee', amount: 10000, semesterId: semA })
      .expect(201);

    const rows = (await revenueByTimeSlot().expect(200)).body as Array<{ slot: string; revenue: number }>;
    expect(rows.find((r) => r.slot === '08:00')?.revenue).toBe(10000);
    expect(rows.find((r) => r.slot === '18:00')?.revenue ?? 0).toBe(0);
  });

  it('two terms paid separately are reported separately', async () => {
    await supertest(app).post(`/api/students/${studentId}/payments`).set(owner)
      .send({ category: 'fee', amount: 4000, semesterId: semA }).expect(201);
    await supertest(app).post(`/api/students/${studentId}/payments`).set(owner)
      .send({ category: 'fee', amount: 6000, semesterId: semB }).expect(201);

    const rows = (await revenueByClass().expect(200)).body as Array<{ name: string; revenue: number }>;
    expect(rows.find((r) => r.name === 'Morning Class')?.revenue).toBe(4000);
    expect(rows.find((r) => r.name === 'Evening Class')?.revenue).toBe(6000);
  });

  it('a refunded amount stops being reported as revenue for that class', async () => {
    await supertest(app).post(`/api/students/${studentId}/payments`).set(owner)
      .send({ category: 'fee', amount: 10000, semesterId: semA }).expect(201);
    const paymentId = (db.prepare(`SELECT id FROM payments WHERE student_id = ? AND category = 'fee'`).get(studentId) as { id: string }).id;

    await supertest(app).post(`/api/students/${studentId}/refund`).set(owner)
      .send({ amount: 4000, paymentId, reason: 'partial withdrawal from the morning term' }).expect(201);

    const rows = (await revenueByClass().expect(200)).body as Array<{ name: string; revenue: number }>;
    expect(rows.find((r) => r.name === 'Morning Class')?.revenue).toBe(6000);
  });

  it('a non-tuition charge is never reported as class revenue', async () => {
    await supertest(app).post(`/api/students/${studentId}/payments`).set(owner)
      .send({ category: 'other', amount: 5000, notes: 'ad-hoc non-tuition charge' }).expect(201);

    const rows = (await revenueByClass().expect(200)).body as Array<{ name: string; revenue: number }>;
    expect(rows.reduce((sum, r) => sum + r.revenue, 0)).toBe(0);
  });
});
