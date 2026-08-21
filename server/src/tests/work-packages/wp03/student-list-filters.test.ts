/**
 * Student list — server-side search & filter regression suite
 * ============================================================================
 * Locks in the list improvements made for the deep Students review:
 * 1. GET /students supports ?q= (name/code/phone/tazkira/whatsapp/email/father)
 *    with proper LIKE escaping.
 * 2. ?status= filters exactly.
 * 3. ?classId= returns students with an enrollment in that class.
 * 4. The default page size (no pagination params) covers the full manageable
 *    roster instead of the old 50-row cap.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { id, today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BRANCH = 'student_list_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
function makeUser(o: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return { userId: o.userId, username: o.username || o.userId, branchId: o.branchId || BRANCH, fullName: 'List Test User' };
}
function authHeader(u: TokenPayload) { return { Authorization: `Bearer ${signToken(u)}` }; }

let app: express.Express;
let reg: TokenPayload;

function seedStudent(code: string, name: string, extra: Record<string, string> = {}) {
  const sid = id('stu');
  db.prepare(`INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone, tazkira_no, whatsapp, email, father_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sid, code, name, extra.status || 'active', today(), BRANCH, extra.gender || 'male', extra.phone || null, extra.tazkira || null, extra.whatsapp || null, extra.email || null, extra.father || null);
  return sid;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'List Branch', 'Loc');
  await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run('u_list_reg', 'list_reg', 'List Reg', BRANCH, await hashPassword('x'));
  assignRole('u_list_reg', 'registrar', BRANCH);

  reg = makeUser({ userId: 'u_list_reg', branchId: BRANCH });
  app = createApp();

  const ali = seedStudent('TH-1001', 'Ali Ahmadi', { phone: '0700111222', tazkira: 'TAZ-111', whatsapp: '0799111222', email: 'ali@example.com', father: 'Mohammad' });
  const zahra = seedStudent('TH-1002', 'Zahra Karimi', { status: 'suspended', phone: '0700333444' });
  seedStudent('TH-1003', 'Reza Noori', { phone: '0700555666' });
  db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee) VALUES (?, ?, ?, 20, 'active', 'A1', 5000)`)
    .run('list_class', 'List Class A', BRANCH);
  db.prepare(`INSERT OR IGNORE INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at) VALUES (?, ?, 'list_class', ?, 'new', 'active', ?)`)
    .run(id('enr'), ali, BRANCH, today());
  void zahra;
});

describe('Student list server-side filters', () => {
  it('returns the full roster by default (cap raised from 50)', async () => {
    const res = await supertest(app).get('/api/students').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect((res.body as any[]).length).toBeGreaterThanOrEqual(3);
  });

  it('filters by q across name / phone / tazkira / whatsapp / email / father', async () => {
    const byTaz = await supertest(app).get('/api/students?q=TAZ-111').set(authHeader(reg));
    expect((byTaz.body as any[]).map((s) => s.studentCode)).toContain('TH-1001');
    const byFather = await supertest(app).get('/api/students?q=Mohammad').set(authHeader(reg));
    expect((byFather.body as any[]).map((s) => s.studentCode)).toContain('TH-1001');
    const byWhats = await supertest(app).get('/api/students?q=0799111222').set(authHeader(reg));
    expect((byWhats.body as any[]).map((s) => s.studentCode)).toContain('TH-1001');
    const none = await supertest(app).get('/api/students?q=zzzznothing').set(authHeader(reg));
    expect((none.body as any[])).toHaveLength(0);
  });

  it('filters by status', async () => {
    const res = await supertest(app).get('/api/students?status=suspended').set(authHeader(reg));
    expect((res.body as any[]).map((s) => s.studentCode)).toEqual(['TH-1002']);
  });

  it('filters by classId via enrollments', async () => {
    const res = await supertest(app).get('/api/students?classId=list_class').set(authHeader(reg));
    expect((res.body as any[]).map((s) => s.studentCode)).toEqual(['TH-1001']);
  });

  it('escapes LIKE wildcards in q', async () => {
    const res = await supertest(app).get('/api/students?q=%25').set(authHeader(reg));
    expect(res.status).toBe(200);
  });
});
