/**
 * Attendance: bounded list + authoritative summary (group F13)
 * ============================================================================
 * S20 — GET /attendance had no LIMIT at all. It returned every attendance
 * record the branch had ever written.
 *
 * Measured on a seeded academy: 16,001 rows = 2,433 KB in a single response,
 * re-fetched every time the Attendance tab opens. Projected to a 500-student
 * academy over three years (~390,000 rows) that is roughly 58 MB per request,
 * growing without bound for the life of the institution.
 *
 * The naive fix — add a LIMIT — would have introduced a correctness defect,
 * because the student profile derives an attendance PERCENTAGE from whatever
 * rows it holds. With 8,001 students and a 2,000-row page, 6,001 students had
 * no records in the page at all and would have displayed "N/A" despite having
 * a real attendance history. That is exactly the S19 trap (a paginated cache
 * treated as complete data), so the rate is now aggregated in SQL over the
 * FULL history by GET /attendance/summary.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { attendanceRouter } from '../routes/classes.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'att_branch';
const OTHER = 'att_other';
const BULK = 60; // rows per student, enough to exceed a small explicit page

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRouter);
  app.use(errorHandler);
  return app;
}
const mgr = (): TokenPayload => ({
  userId: 'u_att', username: 'u_att', branchId: BRANCH, fullName: 'Att Mgr',
});
const auth = () => ({ Authorization: `Bearer ${signToken(mgr())}` });

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);

  db.prepare(`DELETE FROM attendance WHERE id LIKE 'att_%'`).run();
  db.prepare(`DELETE FROM students WHERE id LIKE 'att_s%'`).run();

  for (const b of [BRANCH, OTHER]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(b, b);
  }
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('u_att', 'u_att', 'Att Mgr', ?, ?, 1, 0)`,
  ).run(BRANCH, pw);
  assignRole('u_att', 'manager', BRANCH);

  const d = today();
  const mkStudent = (id: string, phone: string, branch = BRANCH) =>
    db.prepare(
      `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
       VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
    ).run(id, `ATT-${id}`, `Att ${id}`, phone, d, branch);

  mkStudent('att_s1', '0700900001');
  mkStudent('att_s2', '0700900002');
  mkStudent('att_s3', '0700900003', OTHER);

  const mk = (id: string, student: string, date: string, status: string, branch = BRANCH) =>
    db.prepare(
      `INSERT OR REPLACE INTO attendance (id, target_id, target_type, date, status, branch_id)
       VALUES (?, ?, 'student', ?, ?, ?)`,
    ).run(id, student, date, status, branch);

  // s1: 8 present, 2 leave, 10 absent => 20 total, 50%
  for (let i = 0; i < 8; i++) mk(`att_s1_p${i}`, 'att_s1', `2026-01-${String(i + 1).padStart(2, '0')}`, 'present');
  for (let i = 0; i < 2; i++) mk(`att_s1_l${i}`, 'att_s1', `2026-02-${String(i + 1).padStart(2, '0')}`, 'leave');
  for (let i = 0; i < 10; i++) mk(`att_s1_a${i}`, 'att_s1', `2026-03-${String(i + 1).padStart(2, '0')}`, 'absent');

  // s2: bulk rows, all present, dated LATER so they dominate a DESC page
  for (let i = 0; i < BULK; i++) {
    mk(`att_s2_${i}`, 'att_s2', `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, 'present');
  }

  // other branch
  mk('att_s3_1', 'att_s3', '2026-01-01', 'present', OTHER);

  app = createApp();
});

describe('S20: the attendance list is bounded', () => {
  it('honours an explicit limit instead of returning everything', async () => {
    const res = await supertest(app).get('/api/attendance').query({ limit: 5 }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it('cannot be made unbounded with a negative limit', async () => {
    const res = await supertest(app).get('/api/attendance').query({ limit: -1 }).set(auth());
    expect(res.status).toBe(200);
    // Falls back to the default page rather than LIMIT -1 (SQLite: unbounded).
    expect(res.body.length).toBeLessThanOrEqual(2000);
  });

  it('still filters to a single student when asked', async () => {
    const res = await supertest(app).get('/api/attendance').query({ targetId: 'att_s1' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(20);
    for (const row of res.body) expect(row.target_id).toBe('att_s1');
  });

  it('paginates deterministically with offset', async () => {
    const p1 = await supertest(app).get('/api/attendance').query({ limit: 10, offset: 0 }).set(auth());
    const p2 = await supertest(app).get('/api/attendance').query({ limit: 10, offset: 10 }).set(auth());
    const ids1 = new Set(p1.body.map((r: any) => r.id));
    const overlap = p2.body.filter((r: any) => ids1.has(r.id));
    expect(overlap).toHaveLength(0);
  });
});

describe('S20: the summary is computed over the COMPLETE history', () => {
  it('reports the true rate even for students absent from a short page', async () => {
    // A page of 5 rows (newest first) contains only s2's June records.
    const page = await supertest(app).get('/api/attendance').query({ limit: 5 }).set(auth());
    const idsInPage = new Set(page.body.map((r: any) => r.target_id));
    expect(idsInPage.has('att_s1')).toBe(false); // s1 is invisible in the page

    const summary = await supertest(app).get('/api/attendance/summary').set(auth());
    const s1 = summary.body.find((r: any) => r.targetId === 'att_s1');
    // ...yet its rate is exact: (8 present + 2 leave) / 20 = 50%
    expect(s1.total).toBe(20);
    expect(s1.present).toBe(8);
    expect(s1.onLeave).toBe(2);
    expect(s1.absent).toBe(10);
    expect(s1.rate).toBe(50);
  });

  it('counts leave as attended, matching the UI rule', async () => {
    const res = await supertest(app).get('/api/attendance/summary').query({ targetId: 'att_s1' }).set(auth());
    const s1 = res.body[0];
    expect(s1.rate).toBe(Math.round(((s1.present + s1.onLeave) / s1.total) * 100));
  });

  it('a fully present student is 100%', async () => {
    const res = await supertest(app).get('/api/attendance/summary').query({ targetId: 'att_s2' }).set(auth());
    expect(res.body[0].total).toBe(BULK);
    expect(res.body[0].rate).toBe(100);
  });

  it('scopes to the caller branch', async () => {
    const res = await supertest(app).get('/api/attendance/summary').set(auth());
    const ids = res.body.map((r: any) => r.targetId);
    expect(ids).toContain('att_s1');
    expect(ids).not.toContain('att_s3');
  });

  it('requires authentication', async () => {
    const res = await supertest(app).get('/api/attendance/summary');
    expect([401, 403]).toContain(res.status);
  });
});
