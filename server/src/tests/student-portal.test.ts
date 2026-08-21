/**
 * WP-03 residual: whole-database student search pagination, filtering, and
 * branch isolation. Portal identity and credentials live in WP-02 suites.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'portal_branch';
const CAMPUS = 'portal_campus';
const OTHER_BRANCH = 'portal_branch_2';
const OTHER_CAMPUS = 'portal_campus_2';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
let ownerToken: string;

let studentPhoneSequence = 0;
function seedStudent(studentId: string, branchId: string, fullName: string, studentCode: string) {
  // uq_students_phone is a UNIQUE index: every test student needs a distinct phone.
  studentPhoneSequence += 1;
  const phone = `0700${String(studentPhoneSequence).padStart(6, '0')}`;
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
  ).run(studentId, studentCode, fullName, today(), branchId, phone);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);

  // Campuses + branches (branch -> campus binding is what account creation resolves).
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run(CAMPUS, FIXED_ORG_ID, 'Portal Campus', 'PORTAL-C');
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run(OTHER_CAMPUS, FIXED_ORG_ID, 'Other Campus', 'PORTAL-C2');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH, 'Portal Branch', 'Loc', CAMPUS);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(OTHER_BRANCH, 'Portal Branch 2', 'Loc 2', OTHER_CAMPUS);

  // Owner account (must_change_password = 0 so no quarantine).
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, session_version )
     VALUES (?, 'portal_owner', 'Portal Owner', ?, ?, 1, 0, 1)`
  ).run('u_portal_owner', BRANCH, await hashPassword('owner-pass-12345'));
  assignRole('u_portal_owner', 'owner', BRANCH);

  ownerToken = signToken({ userId: 'u_portal_owner', username: 'portal_owner', branchId: BRANCH, fullName: 'Portal Owner', sessionVersion: 1 });

  seedStudent('stu_portal_1', BRANCH, 'Ali Ahmad Portal', 'TH-P-001001');
  seedStudent('stu_portal_2', BRANCH, 'Maryam Karimi Portal', 'TH-P-001002');
  seedStudent('stu_portal_other', OTHER_BRANCH, 'Zahra Other Branch', 'TH-P-002001');

  app = createApp();
});

// Portal identity, credential, and self-scope assertions moved to the WP-02
// package suites. This residual suite owns only the WP-03 search contract.

describe('Whole-DB student search — paginated { rows, total }', () => {
  // Scale simulation: 40 students in the branch + 1 elsewhere.
  beforeAll(() => {
    for (let i = 0; i < 40; i++) {
      const sid = `stu_search_${i}`;
      if (!db.prepare('SELECT id FROM students WHERE id = ?').get(sid)) {
        seedStudent(sid, BRANCH, `Search Student Number ${i}`, `TH-S-${String(1000 + i)}`);
      }
    }
  });

  it('scopes to the caller branch by default (branch isolation preserved)', async () => {
    const res = await supertest(app).get('/api/students/search?limit=100').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // 2 portal students + 40 bulk in BRANCH; the OTHER_BRANCH student is excluded.
    expect(res.body.total).toBe(42);
  });

  it('whole-DB scope (branchId=all) returns { rows, total } honoring limit/offset', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&limit=10&offset=5').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(43); // 3 portal + 40 bulk across both branches
    expect(res.body.rows.length).toBe(10);
  });

  it('q matches across name/code fields with LIKE escaping', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&q=TH-S-10').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(40); // TH-S-1000 … TH-S-1039 all contain 'TH-S-10'
    expect(res.body.rows.every((r: { studentCode: string }) => r.studentCode.includes('TH-S-10'))).toBe(true);
  });

  it('pages through the full result set without duplication', async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 50; offset += 10) {
      const res = await supertest(app).get(`/api/students/search?branchId=all&limit=10&offset=${offset}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(43);
  });

  it('status filter narrows the result set', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&status=active').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(43);
    expect(res.body.rows.every((r: { status: string }) => r.status === 'active')).toBe(true);
  });
});
