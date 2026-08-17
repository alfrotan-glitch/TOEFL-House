/**
 * Exam enrolment — visitor eligibility, through the real route.
 * ============================================================================
 * `POST /exams/:id/enroll` guarded visitor eligibility with:
 *
 *   if (visitor.status && !['new','lead','inquiry','follow_up','placement',
 *                           'placement_completed','enrollment'].includes(visitor.status))
 *       throw 409 'Visitor is not eligible for exam enrollment.'
 *
 * That tests the `status` column against STAGE vocabulary. `visitors.status`
 * only ever holds 'visited' or 'registered' (conversion is its only production
 * writer), and neither appears in the list — so the condition was true for
 * EVERY visitor and exam enrolment was refused 100% of the time. Verified
 * live against a running server: both a 'visited' and a 'registered' visitor
 * received 409.
 *
 * The existing exam suite could not catch it. It exercises the UNIQUE indexes
 * by INSERTing into `exam_results` directly, never calling the route, and its
 * fixture seeds `status='new'` — a value production never writes and which
 * happens to be in the broken allow-list. A test that bypasses the handler
 * cannot test the handler.
 *
 * These tests drive the real HTTP route with realistic status values.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { examsRouter } from '../routes/exams.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'exv_a';
const BRANCH_B = 'exv_b';
let registrar: TokenPayload;
let app: express.Express;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;
function seedVisitor(o: { status?: string; stage?: string | null; branch?: string } = {}): string {
  const id = `exv_v${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO visitors (id, serial_no, full_name, gender, phone, source, status, stage, visit_date, branch_id)
     VALUES (?,?,?,'male',?,'walk_in',?,?,?,?)`
  ).run(
    id, `EXV-${seq}`, `Exam Candidate ${seq}`, `07007${String(seq).padStart(5, '0')}`,
    o.status ?? 'visited',
    o.stage === undefined ? 'lead' : o.stage,
    today(), o.branch ?? BRANCH
  );
  return id;
}

let examId: string;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'EXV A', 'T')`).run(BRANCH);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'EXV B', 'T')`).run(BRANCH_B);
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
              VALUES ('exv_reg','exv_reg',?,'Registrar','registrar',?,0)`).run(pwd, BRANCH);
  syncLegacyUserRoles(db);
  registrar = { userId: 'exv_reg', username: 'exv_reg', role: 'registrar', branchId: BRANCH, fullName: 'Registrar' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/exams', examsRouter);
  app.use(errorHandler);

  const res = await supertest(app).post('/api/exams').set(authHeader(registrar))
    .send({ title: 'Eligibility Exam', date: '2026-09-01', fee: 500, type: 'placement' });
  expect(res.status).toBe(201);
  examId = res.body.id;
});

beforeEach(() => {
  db.prepare(`DELETE FROM exam_results WHERE branch_id IN (?, ?)`).run(BRANCH, BRANCH_B);
  db.prepare(`DELETE FROM visitors WHERE id LIKE 'exv_v%'`).run();
});

describe('a live lead can be enrolled in an exam', () => {
  it('accepts an ordinary open lead (status=visited)', async () => {
    const v = seedVisitor({ status: 'visited', stage: 'lead' });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    // Before the fix this was 409 for every visitor in the system.
    expect(res.status).toBe(201);
  });

  it('accepts a converted lead (status=registered)', async () => {
    const v = seedVisitor({ status: 'registered', stage: 'enrollment' });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(201);
  });

  it('accepts a lead mid-placement workflow', async () => {
    const v = seedVisitor({ status: 'visited', stage: 'placement_booking' });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(201);
  });

  it('accepts a lead whose stage is NULL', async () => {
    const v = seedVisitor({ status: 'visited', stage: null });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(201);
  });
});

describe('a closed-lost lead is refused', () => {
  it('refuses stage=lost, which is what the guard was always meant to catch', async () => {
    const v = seedVisitor({ status: 'visited', stage: 'lost' });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/closed \(lost\)/i);
  });

  /**
   * Precedence check: conversion outranks a stale stage annotation, exactly as
   * `leadLifecycleBucket` defines it. A won lead is not "lost" because someone
   * moved its stage.
   */
  it('still accepts a converted lead even if its stage says lost', async () => {
    const v = seedVisitor({ status: 'registered', stage: 'lost' });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(201);
  });
});

describe('the surrounding guards still hold', () => {
  it('refuses a visitor from another branch', async () => {
    const v = seedVisitor({ branch: BRANCH_B });
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(res.status).toBe(403);
  });

  it('404s an unknown visitor', async () => {
    const res = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: 'exv_nope' });
    expect(res.status).toBe(404);
  });

  it('refuses a duplicate enrolment of the same visitor', async () => {
    const v = seedVisitor();
    const first = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(first.status).toBe(201);
    const second = await supertest(app).post(`/api/exams/${examId}/enroll`)
      .set(authHeader(registrar)).send({ visitorId: v });
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/already enrolled/i);
  });
});
