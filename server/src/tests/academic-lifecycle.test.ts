/**
 * Academic Module Refactor — Phase 1: Class & Enrollment Lifecycle Engines
 * ============================================================================
 * HTTP integration tests (mirroring the app/RBAC-bootstrap pattern used in
 * branch-isolation-http.test.ts) plus direct unit tests of the pure
 * lifecycle-engine.ts transition graph.
 *
 * The first test is a regression test for the confirmed critical bug this
 * refactor fixes: POST /api/classes previously threw
 * "SqliteError: CHECK constraint failed: classes" on every call.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import enrollmentRouter from '../routes/enrollment.routes.js';
import studentsRouter from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import {
  assertClassTransition,
  assertEnrollmentTransition,
  deriveCoarseClassStatus,
  CLASS_TRANSITIONS,
  CLASS_STAGES,
} from '../core/academic/lifecycle-engine.js';

const BRANCH = 'lc_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId,
    username: overrides.username || overrides.userId,
    branchId: overrides.branchId || BRANCH,
    fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, branchId, await hashPassword('testpass123'));
  assignRole(userId, role, branchId);
}
function seedStudent(studentId: string, branchId: string, name: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-LC-${studentId.slice(-4)}`, name, today(), branchId);
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'LC Branch', 'Loc');
  await seedUser('u_lc_owner', 'owner', BRANCH, 'lc_owner');

  owner = makeUser({ userId: 'u_lc_owner', branchId: BRANCH });
  app = createApp();
});

async function createClass(overrides: Record<string, unknown> = {}) {
  const res = await supertest(app)
    .post('/api/classes')
    .set(authHeader(owner))
    .send({ name: 'Lifecycle Test Class', level: 'A1', branchId: BRANCH, capacity: 10, ...overrides });
  return res;
}

describe('Class Lifecycle Engine — HTTP integration', () => {
  it('CRIT-FIX: POST /api/classes succeeds (previously threw "CHECK constraint failed: classes")', async () => {
    const res = await createClass();
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    // New classes default to lifecycle_stage='scheduled', which projects to
    // legacy status='active' — every existing status==='active' filter
    // (frontend + offerings.routes.ts + sessions.routes.ts) keeps working.
    expect(res.body.lifecycleStage).toBe('scheduled');
    expect(res.body.status).toBe('active');
  });

  it('asDraft:true creates a Draft-stage class with legacy status "draft"', async () => {
    const res = await createClass({ asDraft: true, name: 'Draft Class' });
    expect(res.status).toBe(201);
    expect(res.body.lifecycleStage).toBe('draft');
    expect(res.body.status).toBe('draft');
  });

  it('walks the full happy-path lifecycle: scheduled → enrollment_open → enrollment_closed → activated → in_progress → suspended → in_progress → grading → completed → archived', async () => {
    const created = await createClass({ name: 'Full Lifecycle Class' });
    const classId = created.body.id;

    const step = async (path: string, expectStage: string, expectStatus: string) => {
      const res = await supertest(app).post(`/api/classes/${classId}${path}`).set(authHeader(owner)).send({});
      expect(res.status, `POST ${path} should succeed`).toBe(200);
      expect(res.body.class.lifecycleStage).toBe(expectStage);
      expect(res.body.class.status).toBe(expectStatus);
      return res;
    };

    await step('/open-enrollment', 'enrollment_open', 'active');
    await step('/close-enrollment', 'enrollment_closed', 'active');
    const activated = await step('/activate', 'activated', 'active');
    expect(activated.body.class.activationDate).toBeTruthy();
    // The lifecycle engine refuses start-teaching until at least one teaching
    // session is scheduled (business rule), so schedule one first.
    db.prepare(`INSERT INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '09:00', '10:00', 'scheduled', 'regular', ?)`)
      .run(`${classId}-teaching-session`, classId, today(), BRANCH);
    await step('/start-teaching', 'in_progress', 'active');
    await step('/suspend', 'suspended', 'active');
    await step('/resume', 'in_progress', 'active');
    await step('/start-grading', 'grading', 'active');
    await step('/complete', 'completed', 'completed');
    await step('/archive', 'archived', 'completed');
  });

  it('rejects an invalid transition with 409 (archived class cannot be activated)', async () => {
    const created = await createClass({ name: 'To Be Archived' });
    const classId = created.body.id;
    // The lifecycle engine refuses start-teaching until at least one teaching
    // session is scheduled (business rule), so schedule one first.
    db.prepare(`INSERT INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '09:00', '10:00', 'scheduled', 'regular', ?)`)
      .run(`${classId}-teaching-session`, classId, today(), BRANCH);
    // Fast-track: scheduled -> activated -> in_progress -> grading -> completed -> archived
    for (const path of ['/activate', '/start-teaching', '/start-grading', '/complete', '/archive']) {
      const r = await supertest(app).post(`/api/classes/${classId}${path}`).set(authHeader(owner)).send({});
      expect(r.status).toBe(200);
    }
    const res = await supertest(app).post(`/api/classes/${classId}/activate`).set(authHeader(owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error || res.body.message).toMatch(/Invalid class transition/i);
  });

  it('cancel records a cancellation_reason and projects legacy status "cancelled"', async () => {
    const created = await createClass({ name: 'To Be Cancelled' });
    const classId = created.body.id;
    const res = await supertest(app)
      .post(`/api/classes/${classId}/cancel`)
      .set(authHeader(owner))
      .send({ reason: 'Insufficient enrollment' });
    expect(res.status).toBe(200);
    expect(res.body.class.lifecycleStage).toBe('cancelled');
    expect(res.body.class.status).toBe('cancelled');
    expect(res.body.class.cancellationReason).toBe('Insufficient enrollment');
  });

  it('GET /:id/lifecycle reports the real allowed next stages, not "everything but current"', async () => {
    const created = await createClass({ name: 'Lifecycle Query Class' });
    const res = await supertest(app).get(`/api/classes/${created.body.id}/lifecycle`).set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('scheduled');
    expect(res.body.allowedNextStages.sort()).toEqual(['activated', 'cancelled', 'enrollment_open'].sort());
  });
});

describe('Enrollment Lifecycle Engine', () => {
  it("transfer() marks the outgoing enrollment 'transferred', not overloaded 'completed'", async () => {
    const svc = getEnrollmentService(db);
    const studentId = 'lc_stu_transfer';
    seedStudent(studentId, BRANCH, 'Transfer Test Student');
    const classA = (await createClass({ name: 'Transfer Source Class' })).body.id;
    const classB = (await createClass({ name: 'Transfer Target Class' })).body.id;

    const enrolled = svc.enroll({ studentId, branchId: BRANCH, classId: classA, enrollmentType: 'new', startedAt: today() });
    const before = svc.getById(enrolled.enrollmentId);
    expect(before.status).toBe('active');

    svc.transfer({ studentId, toClassId: classB });

    const after = svc.getById(enrolled.enrollmentId);
    expect(after.status).toBe('transferred'); // NOT 'completed'
    expect(after.ended_at).toBeTruthy();

    const newEnrollment = db.prepare("SELECT * FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'").get(studentId, classB) as any;
    expect(newEnrollment).toBeTruthy();
  });

  it('freeze() sets hold_reason and status=frozen; unfreeze() clears it and returns to active', async () => {
    const svc = getEnrollmentService(db);
    const studentId = 'lc_stu_freeze';
    seedStudent(studentId, BRANCH, 'Freeze Test Student');
    const classId = (await createClass({ name: 'Freeze Test Class' })).body.id;

    const enrolled = svc.enroll({ studentId, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });
    svc.freeze(enrolled.enrollmentId, { reason: 'Medical leave' });

    let row = svc.getById(enrolled.enrollmentId);
    expect(row.status).toBe('frozen');
    expect(row.hold_reason).toBe('Medical leave');

    svc.unfreeze(enrolled.enrollmentId);
    row = svc.getById(enrolled.enrollmentId);
    expect(row.status).toBe('active');
    expect(row.hold_reason).toBeNull();
  });

  it('rejects an invalid enrollment transition (graduated is terminal)', async () => {
    const svc = getEnrollmentService(db);
    const studentId = 'lc_stu_terminal';
    seedStudent(studentId, BRANCH, 'Terminal Test Student');
    const classId = (await createClass({ name: 'Terminal Test Class' })).body.id;
    const enrolled = svc.enroll({ studentId, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    svc.complete(enrolled.enrollmentId);
    svc.graduate(enrolled.enrollmentId);

    expect(() => svc.activate(enrolled.enrollmentId)).toThrowError(/Invalid enrollment transition/i);
  });

  it('markConditionalPass allows a subsequent retake', async () => {
    const svc = getEnrollmentService(db);
    const studentId = 'lc_stu_condpass';
    seedStudent(studentId, BRANCH, 'Conditional Pass Student');
    const classId = (await createClass({ name: 'Conditional Pass Class' })).body.id;
    const enrolled = svc.enroll({ studentId, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    svc.markConditionalPass(enrolled.enrollmentId, { reason: 'Borderline score' });
    let row = svc.getById(enrolled.enrollmentId);
    expect(row.status).toBe('conditional_pass');

    svc.markRetake(enrolled.enrollmentId);
    row = svc.getById(enrolled.enrollmentId);
    expect(row.status).toBe('retake');
  });
});

describe('lifecycle-engine.ts — pure unit tests', () => {
  it('deriveCoarseClassStatus maps every stage to a valid legacy value', () => {
    const expected: Record<string, string> = {
      draft: 'draft',
      scheduled: 'active',
      enrollment_open: 'active',
      enrollment_closed: 'active',
      activated: 'active',
      in_progress: 'active',
      suspended: 'active',
      grading: 'active',
      completed: 'completed',
      archived: 'completed',
      cancelled: 'cancelled',
    };
    for (const stage of CLASS_STAGES) {
      expect(deriveCoarseClassStatus(stage)).toBe(expected[stage]);
    }
  });

  it('assertClassTransition throws for every non-listed transition and allows every listed one', () => {
    for (const from of CLASS_STAGES) {
      for (const to of CLASS_STAGES) {
        const allowed = CLASS_TRANSITIONS[from].includes(to);
        if (allowed) {
          expect(() => assertClassTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertClassTransition(from, to)).toThrow();
        }
      }
    }
  });

  it('assertEnrollmentTransition allows pending -> active directly (skipping reserve/confirm)', () => {
    expect(() => assertEnrollmentTransition('pending', 'active')).not.toThrow();
  });

  it('assertEnrollmentTransition rejects dropped -> active (terminal state)', () => {
    expect(() => assertEnrollmentTransition('dropped', 'active')).toThrow(/Invalid enrollment transition/i);
  });
});
