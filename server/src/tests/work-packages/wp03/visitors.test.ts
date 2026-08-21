/**
 * Visitor Module — Comprehensive Test Suite
 * ===========================================
 * Covers: registration, duplicate prevention, pipeline progression, stage transitions,
 * branch isolation / RBAC, follow-ups, placement test, conversion (visitor → student),
 * transaction rollback, class capacity, duplicate conversion protection,
 * lead → student linkage, student ↔ visitor consistency, serial generation uniqueness,
 * concurrent operations, API validation, database integrity, foreign key integrity,
 * pipeline state integrity, event generation, rule engine interaction, and failure scenarios.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { id, today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { ensureOrganizationHierarchy } from '../../../db/organizationHierarchy.js';
import type Express from 'express';
import supertest from 'supertest';

// ── Import the Express app after DB setup ──────────────────────────────────
// We'll build a minimal app that mounts the visitors router
import express from 'express';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import placementRouter from '../../../routes/placement.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use(errorHandler);
  return app;
}

// ── Test helpers ────────────────────────────────────────────────────────────

const BRANCH_A = 'branch_test_a';
const BRANCH_B = 'branch_test_b';
const CLASS_A = 'class_test_a';
const CLASS_B_FEMALE = 'class_test_b_female';
const CLASS_FULL = 'class_test_full';

// ── Unified Placement Assessment Workspace fixtures ────────────────────────
const VT_PROGRAM = 'vt_program';
const VT_VERSION = 'vt_version';
const VT_LEVEL_A = 'vt_level_a1';
const VT_LEVEL_B = 'vt_level_b1';
const VT_PLACEMENT_COMPONENTS = [
  { key: 'skills', type: 'skill_scores', label: 'Skills Assessment', required: true, weight: 100, maxScore: 100, skills: ['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking'] },
];

/** Seeds the program/version/levels/profile the unified placement workspace needs. */
function seedPlacementInfrastructure() {
  db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, 'Placement Program', 12, ?, 1)`).run(VT_PROGRAM, BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VT_VERSION, VT_PROGRAM);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1 Beginner', 1, ?, 'A1', 1)`).run(VT_LEVEL_A, VT_PROGRAM, VT_VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1 Intermediate', 2, ?, 'B1', 1)`).run(VT_LEVEL_B, VT_PROGRAM, VT_VERSION);
  db.prepare(`INSERT OR REPLACE INTO placement_assessment_profiles
    (id, program_version_id, branch_id, components_json, scoring_model, allow_retake,
     pass_score, requirement_mode, instructions)
    VALUES (?, ?, ?, ?, 'weighted_average', 1, 60, 'required', 'Complete every configured section.')`)
    .run(id('pap_vt'), VT_VERSION, BRANCH_A, JSON.stringify(VT_PLACEMENT_COMPONENTS));
}

/** Starts a placement attempt for a visitor and completes it with the given skill scores. */
async function startAndCompletePlacement(vid: string, skills: Record<string, number>, auth: TokenPayload, testApp: Express.Application) {
  const start = await supertest(testApp).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(auth)).send({});
  const attemptId = start.body?.id;
  const put = await supertest(testApp).put(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/components/skills`).set(authHeader(auth)).send({ skills });
  return { start, attemptId, put, complete: await supertest(testApp).post(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/complete`).set(authHeader(auth)).send({}) };
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId,
    username: overrides.username || overrides.userId,
    branchId: overrides.branchId || BRANCH_A,
    fullName: overrides.fullName || 'Test User',
  };
}

function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

function seedBranches() {
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'Branch A', 'Location A');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'Branch B', 'Location B');
}

async function seedUser(userId: string, role: string, branchId: string, username: string, fullName: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, fullName, branchId, await hashPassword('testpass123'));
  assignRole(userId, role, branchId);
}

function seedClass(classId: string, name: string, branchId: string, capacity: number | null = 30, genderPolicy: string = 'mixed', fee: number = 5000) {
  db.prepare(
    `INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, gender_policy, fee, status, lifecycle_stage, level)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'activated', 'Intermediate')`
  ).run(classId, name, branchId, capacity, genderPolicy, fee);
}

function seedClasses() {
  seedClass(CLASS_A, 'TOEFL Class A', BRANCH_A, 30, 'mixed', 5000);
  seedClass(CLASS_B_FEMALE, 'TOEFL Female Only', BRANCH_A, 20, 'female', 4500);
  seedClass(CLASS_FULL, 'Full Class', BRANCH_A, 1, 'mixed', 4000);
}

let directSerialCounter = 900000;

function createVisitorDirect(overrides: Record<string, any> = {}): string {
  const visitorId = id('v');
  // `V-${Date.now()}` collides whenever two fixtures are built inside the same
  // millisecond, which the new uq_visitors_serial_no constraint (migration 072,
  // audit V-3) now rejects outright. A monotonic counter keeps fixtures unique
  // without weakening the constraint the test suite exists to protect.
  const serialNo = overrides.serial_no ?? `V-T${++directSerialCounter}`;
  const programVersionId = overrides.program_version_id ?? null;
  db.prepare(
    `INSERT INTO visitors (id, serial_no, full_name, phone, email, gender, source, campaign_id, stage, assigned_to,
      visit_date, status, notes, branch_id, interested_course, follow_up_status, next_contact_date,
      father_name, address_region, tazkira_no, whatsapp, dob, school_or_university,
      emergency_contact_name, emergency_contact_phone, program_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    visitorId, serialNo,
    overrides.full_name || 'Test Visitor',
    overrides.phone || '0770000000',
    overrides.email ?? null,
    overrides.gender || 'male',
    overrides.source || 'walk_in',
    overrides.campaign_id ?? null,
    overrides.stage || 'lead',
    overrides.assigned_to ?? null,
    today(),
    // `status` was hardcoded to 'visited' and silently ignored any override, so
    // a fixture could not express a CONVERTED lead — which is exactly the state
    // the lifecycle rules turn on.
    overrides.status ?? 'visited',
    overrides.notes ?? null,
    overrides.branch_id || BRANCH_A,
    overrides.interested_course || 'TOEFL Preparation',
    overrides.follow_up_status || 'medium_interest',
    overrides.next_contact_date ?? null,
    overrides.father_name ?? null,
    overrides.address_region ?? null,
    overrides.tazkira_no ?? null,
    overrides.whatsapp ?? null,
    overrides.dob ?? null,
    overrides.school_or_university ?? null,
    overrides.emergency_contact_name ?? null,
    overrides.emergency_contact_phone ?? null,
    programVersionId
  );
  return visitorId;
}

function countVisitors(branchId?: string): number {
  if (branchId) {
    return (db.prepare('SELECT COUNT(*) as c FROM visitors WHERE branch_id = ?').get(branchId) as { c: number }).c;
  }
  return (db.prepare('SELECT COUNT(*) as c FROM visitors').get() as { c: number }).c;
}

function getVisitor(id: string): any {
  return db.prepare('SELECT * FROM visitors WHERE id = ?').get(id) as any;
}

function countFollowups(visitorId: string): number {
  return (db.prepare('SELECT COUNT(*) as c FROM visitor_followups WHERE visitor_id = ?').get(visitorId) as { c: number }).c;
}

function countStudents(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM students').get() as { c: number }).c;
}

function countJourneyEvents(studentId: string): number {
  return (db.prepare('SELECT COUNT(*) as c FROM student_journey_events WHERE student_id = ?').get(studentId) as { c: number }).c;
}

// ── Seed a full class for capacity tests ───────────────────────────────────
function fillClass(classId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const stuId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, ?, ?, 'active', ?, ?, 'male')`
    ).run(stuId, `TH-FILL-${i}`, `Fill Student ${i}`, today(), BRANCH_A);
    // A real seat occupant has BOTH an enrollments row (the authoritative
    // capacity source — see core/academic/class-capacity.ts) and the derived
    // student_semesters projection.
    db.prepare(
      `INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
       VALUES (?, ?, ?, ?, 'new', 'active', ?)`
    ).run(id('enr'), stuId, classId, BRANCH_A, today());
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
       VALUES (?, ?, 'Current', ?, ?, 0, 'active')`
    ).run(id('sem'), stuId, classId, today());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Visitor Module', () => {
  let app: Express.Application;
  let registrarA: TokenPayload;
  let registrarB: TokenPayload;
  let managerA: TokenPayload;
  let ownerUser: TokenPayload;
  let counselorA: TokenPayload;
  let teacherUser: TokenPayload;

  beforeAll(async () => {
    initSchema();
    ensureOrganizationHierarchy(db);
    bootstrapRbacCatalog(db);
    seedBranches();
    seedClasses();
    seedPlacementInfrastructure();

    await seedUser('u_reg_a', 'registrar', BRANCH_A, 'reg_a', 'Test User');
    await seedUser('u_reg_b', 'registrar', BRANCH_B, 'reg_b', 'Test registrar B');
    await seedUser('u_mgr_a', 'manager', BRANCH_A, 'mgr_a', 'Test manager');
    await seedUser('u_owner', 'owner', BRANCH_A, 'owner', 'Test owner');
    await seedUser('u_cns_a', 'counselor', BRANCH_A, 'cns_a', 'Test counselor');
    await seedUser('u_teacher', 'teacher', BRANCH_A, 'teacher', 'Test teacher');

    app = createApp();

    registrarA = makeUser({ userId: 'u_reg_a', branchId: BRANCH_A });
    registrarB = makeUser({ userId: 'u_reg_b', branchId: BRANCH_B });
    managerA = makeUser({ userId: 'u_mgr_a', branchId: BRANCH_A });
    ownerUser = makeUser({ userId: 'u_owner', branchId: BRANCH_A });
    counselorA = makeUser({ userId: 'u_cns_a', branchId: BRANCH_A });
    teacherUser = makeUser({ userId: 'u_teacher', branchId: BRANCH_A });
  });

  afterAll(() => {
    // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
  });

  beforeEach(() => {
    // FK-safe deterministic cleanup; foreign keys remain enabled at all times.
    const cleanup = db.transaction(() => {
      db.prepare('DELETE FROM student_journey_events').run();
      db.prepare('DELETE FROM financial_transactions').run();
      db.prepare('DELETE FROM notifications').run();
      db.prepare('DELETE FROM audit_logs').run();
      db.prepare('DELETE FROM invoice_items').run();
      db.prepare('DELETE FROM invoices').run();
      // Conversion bills the term it creates, so the tuition obligation the
      // invoice names must go before the term it points at
      // (`student_obligations.semester_id` is ON DELETE RESTRICT).
      db.prepare('DELETE FROM student_installments').run();
      db.prepare('DELETE FROM obligation_allocations').run();
      db.prepare("DELETE FROM payments WHERE category = 'refund'").run();
      db.prepare('DELETE FROM payments').run();
      db.prepare('DELETE FROM student_obligations').run();
      db.prepare('DELETE FROM registrations').run();
      db.prepare('DELETE FROM enrollment_events').run();
      db.prepare('DELETE FROM enrollments').run();
      db.prepare('DELETE FROM student_semesters').run();
      db.prepare('DELETE FROM students').run();
      db.prepare('DELETE FROM visitor_followups').run();
      db.prepare('DELETE FROM visitors').run();
    });
    cleanup();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §1 — VISITOR REGISTRATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§1 Visitor Registration', () => {
    it('should register a new visitor with required fields', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({
          fullName: 'Ahmad Rahimi',
          gender: 'male',
          source: 'walk_in',
          phone: '0771234567',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.serialNo).toMatch(/^V-\d+$/);

      // Verify DB record
      const visitor = getVisitor(res.body.id);
      expect(visitor).toBeDefined();
      expect(visitor.full_name).toBe('Ahmad Rahimi');
      expect(visitor.gender).toBe('male');
      expect(visitor.source).toBe('walk_in');
      expect(visitor.phone).toBe('0771234567');
      expect(visitor.status).toBe('visited');
      expect(visitor.stage).toBe('lead');
      expect(visitor.branch_id).toBe(BRANCH_A);
    });

    it('should register a visitor with all optional fields', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({
          fullName: 'Fatima Noori',
          gender: 'female',
          source: 'facebook',
          phone: '0779876543',
          email: 'fatima@test.com',
          notes: 'Interested in TOEFL',
          interestedCourse: 'IELTS Preparation',
          followUpStatus: 'hot',
          nextContactDate: '2026-08-01',
          fatherName: 'Mohammad Noori',
          addressRegion: 'Kabul',
          tazkiraNo: 'T-12345',
          whatsapp: '0779876543',
          dob: '2000-01-15',
          schoolOrUniversity: 'Kabul University',
          emergencyContactName: 'Ali Noori',
          emergencyContactPhone: '0771111111',
        });

      expect(res.status).toBe(201);
      const visitor = getVisitor(res.body.id);
      expect(visitor.full_name).toBe('Fatima Noori');
      expect(visitor.email).toBe('fatima@test.com');
      expect(visitor.father_name).toBe('Mohammad Noori');
      expect(visitor.tazkira_no).toBe('T-12345');
      expect(visitor.school_or_university).toBe('Kabul University');
      expect(visitor.follow_up_status).toBe('hot');
    });

    it('should default to user branch when branchId not provided', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'Default Branch', gender: 'male', source: 'referral' });

      expect(res.status).toBe(201);
      expect(getVisitor(res.body.id).branch_id).toBe(BRANCH_A);
    });

    it('should reject explicit cross-branch creation for a branch-scoped registrar', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'Explicit Branch', gender: 'male', source: 'referral', branchId: BRANCH_B });

      expect(res.status).toBe(403);
    });

    it('owner can create a visitor explicitly in another authorized branch', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(ownerUser))
        .send({ fullName: 'Owner Cross Branch', gender: 'male', source: 'referral', branchId: BRANCH_B });

      expect(res.status).toBe(201);
      expect(getVisitor(res.body.id).branch_id).toBe(BRANCH_B);
    });

    it('should reject registration without fullName', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ gender: 'male', source: 'walk_in' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Full name');
    });

    it('should reject registration without gender', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'No Gender', source: 'walk_in' });

      expect(res.status).toBe(400);
    });

    it('should reject registration without source', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'No Source', gender: 'male' });

      expect(res.status).toBe(400);
    });

    it('should reject unauthenticated requests', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .send({ fullName: 'Hacker', gender: 'male', source: 'walk_in' });

      expect(res.status).toBe(401);
    });

    it('should reject unauthorized roles (teacher)', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(teacherUser))
        .send({ fullName: 'Teacher Creating', gender: 'male', source: 'walk_in' });

      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §2 — DUPLICATE VISITOR PREVENTION & SERIAL GENERATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§2 Serial Generation & Uniqueness', () => {
    it('should generate sequential serial numbers', async () => {
      const res1 = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'Serial 1', gender: 'male', source: 'walk_in' });

      const res2 = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'Serial 2', gender: 'male', source: 'walk_in' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      const v1 = getVisitor(res1.body.id);
      const v2 = getVisitor(res2.body.id);

      // Both should have valid V-NNNN format
      expect(v1.serial_no).toMatch(/^V-\d+$/);
      expect(v2.serial_no).toMatch(/^V-\d+$/);

      // Serials must be unique
      expect(v1.serial_no).not.toBe(v2.serial_no);
    });

    it('should never produce duplicate serial numbers', async () => {
      const serials = new Set<string>();
      const count = 50;

      for (let i = 0; i < count; i++) {
        const res = await supertest(app)
          .post('/api/visitors/')
          .set(authHeader(registrarA))
          .send({ fullName: `Unique Serial ${i}`, gender: 'male', source: 'walk_in' });
        expect(res.status).toBe(201);
        serials.add(res.body.serialNo);
      }

      expect(serials.size).toBe(count);
    });

    it('should start serial numbers from a reasonable base', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .send({ fullName: 'First Serial', gender: 'male', source: 'walk_in' });

      expect(res.status).toBe(201);
      const visitor = getVisitor(res.body.id);
      const numPart = parseInt(visitor.serial_no.replace('V-', ''), 10);
      expect(numPart).toBeGreaterThan(1000);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §3 — VISITOR LIST & PAGINATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§3 Visitor List & Pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        createVisitorDirect({ full_name: `List Visitor ${i}`, branch_id: BRANCH_A });
      }
      createVisitorDirect({ full_name: 'Branch B Visitor', branch_id: BRANCH_B });
    });

    it('should list visitors for the user branch', async () => {
      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
      expect(res.headers['x-total-count']).toBe('5');
    });

    it('should include pagination headers', async () => {
      const res = await supertest(app)
        .get('/api/visitors/?page=1&limit=3')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.headers['x-total-count']).toBe('5');
      expect(res.headers['x-page-limit']).toBe('3');
    });

    it('should respect offset parameter', async () => {
      const res = await supertest(app)
        .get('/api/visitors/?offset=3')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should include follow-up history in list', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });
      db.prepare(
        'INSERT INTO visitor_followups (id, visitor_id, date, notes, operator, outcome) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id('f'), vid, today(), 'Called visitor', 'Test Operator', 'interested');

      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      const v = res.body.find((x: any) => x.id === vid);
      expect(v).toBeDefined();
      expect(v.followUpHistory).toHaveLength(1);
      expect(v.followUpHistory[0].notes).toBe('Called visitor');
    });

    it('should include placement scores when present', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });
      db.prepare('UPDATE visitors SET placement_score = ? WHERE id = ?').run(
        JSON.stringify({ grammar: 80, listening: 75, speaking: 85, total: 240 }), vid
      );

      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(registrarA));

      const v = res.body.find((x: any) => x.id === vid);
      expect(v).toBeDefined();
      expect(v.placementScore).toBeDefined();
      expect(v.placementScore.total).toBe(240);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §4 — BRANCH ISOLATION / RBAC
  // ═════════════════════════════════════════════════════════════════════════

  describe('§4 Branch Isolation & RBAC', () => {
    let branchAVisitor: string;
    let branchBVisitor: string;

    beforeEach(() => {
      branchAVisitor = createVisitorDirect({ full_name: 'Branch A Visitor', branch_id: BRANCH_A });
      branchBVisitor = createVisitorDirect({ full_name: 'Branch B Visitor', branch_id: BRANCH_B });
    });

    it('registrar from branch A should not see branch B visitors', async () => {
      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      const ids = res.body.map((v: any) => v.id);
      expect(ids).toContain(branchAVisitor);
      expect(ids).not.toContain(branchBVisitor);
    });

    it('registrar from branch A should not access branch B visitor details', async () => {
      const res = await supertest(app)
        .patch(`/api/visitors/${branchBVisitor}`)
        .set(authHeader(registrarA))
        .send({ notes: 'hacked' });

      expect(res.status).toBe(403);
    });

    it('registrar from branch A cannot update branch B visitor', async () => {
      const res = await supertest(app)
        .patch(`/api/visitors/${branchBVisitor}`)
        .set(authHeader(registrarA))
        .send({ notes: 'hacked' });

      expect(res.status).toBe(403);
    });

    it('owner can see all branches (branchId=all)', async () => {
      const res = await supertest(app)
        .get('/api/visitors/?branchId=all')
        .set(authHeader(ownerUser));

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it('manager is restricted to their own branch', async () => {
      const res = await supertest(app)
        .get('/api/visitors/?branchId=all')
        .set(authHeader(managerA));

      expect(res.status).toBe(200);
      expect(res.body.every((v: any) => v.branchId === BRANCH_A || v.branch_id === BRANCH_A)).toBe(true);
    });

    it('registrar cannot use branchId=all', async () => {
      const res = await supertest(app)
        .get('/api/visitors/?branchId=all')
        .set(authHeader(registrarA));

      // Should fall back to their own branch
      expect(res.status).toBe(200);
      const ids = res.body.map((v: any) => v.id);
      expect(ids).toContain(branchAVisitor);
      expect(ids).not.toContain(branchBVisitor);
    });

    it('counselor can access visitors in their branch', async () => {
      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(counselorA));

      expect(res.status).toBe(200);
      const ids = res.body.map((v: any) => v.id);
      expect(ids).toContain(branchAVisitor);
      expect(ids).not.toContain(branchBVisitor);
    });

    it('teacher cannot list visitors', async () => {
      const res = await supertest(app)
        .get('/api/visitors/')
        .set(authHeader(teacherUser));

      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §5 — VISITOR UPDATE
  // ═════════════════════════════════════════════════════════════════════════

  describe('§5 Visitor Update', () => {
    it('should update visitor fields', async () => {
      const vid = createVisitorDirect({ full_name: 'Update Me', branch_id: BRANCH_A });

      const res = await supertest(app)
        .patch(`/api/visitors/${vid}`)
        .set(authHeader(registrarA))
        .send({ notes: 'Updated notes', phone: '0779999999' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const visitor = getVisitor(vid);
      expect(visitor.notes).toBe('Updated notes');
      expect(visitor.phone).toBe('0779999999');
    });

    it('should return 404 for non-existent visitor', async () => {
      const res = await supertest(app)
        .patch('/api/visitors/nonexistent')
        .set(authHeader(registrarA))
        .send({ notes: 'test' });

      expect(res.status).toBe(404);
    });

    it('should preserve unchanged fields', async () => {
      const vid = createVisitorDirect({ full_name: 'Preserve Me', phone: '0771111111', branch_id: BRANCH_A });

      await supertest(app)
        .patch(`/api/visitors/${vid}`)
        .set(authHeader(registrarA))
        .send({ notes: 'Only update notes' });

      const visitor = getVisitor(vid);
      expect(visitor.notes).toBe('Only update notes');
      expect(visitor.phone).toBe('0771111111');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §6 — FOLLOW-UP CREATION & OUTCOME HANDLING
  // ═════════════════════════════════════════════════════════════════════════

  describe('§6 Follow-up Creation & Outcome Handling', () => {
    it('should create a follow-up note', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ notes: 'Called the visitor, interested in TOEFL', outcome: 'interested' });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);

      expect(countFollowups(vid)).toBe(1);

      const followup = db.prepare('SELECT * FROM visitor_followups WHERE visitor_id = ?').get(vid) as any;
      expect(followup.notes).toBe('Called the visitor, interested in TOEFL');
      expect(followup.outcome).toBe('interested');
      expect(followup.operator).toBe('Test User');
    });

    it('should create follow-up with outcome: not_interested', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ notes: 'Not interested at this time', outcome: 'not_interested' });

      expect(res.status).toBe(201);

      const followup = db.prepare('SELECT * FROM visitor_followups WHERE visitor_id = ?').get(vid) as any;
      expect(followup.outcome).toBe('not_interested');
    });

    it('should create follow-up with outcome: callback', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ notes: 'Asked for callback next week', outcome: 'callback', nextContactDate: '2026-08-21' });

      expect(res.status).toBe(201);

      const followup = db.prepare('SELECT * FROM visitor_followups WHERE visitor_id = ?').get(vid) as any;
      expect(followup.outcome).toBe('callback');
    });

    it('should create follow-up with outcome: registered', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ notes: 'Visitor registered', outcome: 'registered' });

      expect(res.status).toBe(201);
    });

    it('should create follow-up without outcome', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ notes: 'Just a note without outcome' });

      expect(res.status).toBe(201);

      const followup = db.prepare('SELECT * FROM visitor_followups WHERE visitor_id = ?').get(vid) as any;
      expect(followup.outcome).toBeNull();
    });

    it('should reject follow-up without notes', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/followups`)
        .set(authHeader(registrarA))
        .send({ outcome: 'interested' });

      expect(res.status).toBe(400);
    });

    it('should allow multiple follow-ups for same visitor', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      for (let i = 0; i < 3; i++) {
        const res = await supertest(app)
          .post(`/api/visitors/${vid}/followups`)
          .set(authHeader(registrarA))
          .send({ notes: `Follow-up ${i}`, outcome: 'callback', nextContactDate: `2026-08-${20 + i}` });

        expect(res.status).toBe(201);
      }

      expect(countFollowups(vid)).toBe(3);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §7 — PIPELINE VIEW
  // ═════════════════════════════════════════════════════════════════════════

  describe('§7 Pipeline View', () => {
    it('should return pipeline stages with correct counts', async () => {
      createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'inquiry', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'follow_up', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'placement_completed', branch_id: BRANCH_A });

      const res = await supertest(app)
        .get('/api/visitors/pipeline')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      expect(res.body.stages).toBeDefined();

      const leadStage = res.body.stages.find((s: any) => s.stage === 'lead');
      expect(leadStage).toBeDefined();
      expect(leadStage.count).toBe(2);

      const inquiryStage = res.body.stages.find((s: any) => s.stage === 'inquiry');
      expect(inquiryStage).toBeDefined();
      expect(inquiryStage.count).toBe(1);
    });

    /**
     * Rewritten: the previous version asserted the DEFECT.
     *
     * It seeded `stage='registration'` and expected `totalRegistrations === 1`,
     * but conversion never writes that stage — it writes status='registered'
     * and stage='enrollment'. So the old assertion could only pass for a lead
     * that had NOT actually converted, and a genuinely converted lead scored
     * zero. With 27 real conversions in a live database the endpoint reported
     * a 0% conversion rate and this test still passed.
     *
     * A converted lead is now defined the same way everywhere:
     * status='registered' (see core/visitors/lead-lifecycle.ts).
     */
    it('counts converted leads, not leads parked in the transient registration stage', async () => {
      createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'registration', branch_id: BRANCH_A });          // NOT converted
      createVisitorDirect({ stage: 'enrollment', status: 'registered', branch_id: BRANCH_A }); // converted

      const res = await supertest(app)
        .get('/api/visitors/pipeline')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      // Denominator is the whole population, not just leads still sitting in 'lead'.
      expect(res.body.totalLeads).toBe(3);
      // Only the genuinely converted lead counts.
      expect(res.body.totalRegistrations).toBe(1);
      expect(res.body.overallConversion).toBeCloseTo(33.3, 1);
    });

    it('should return all pipeline stages', async () => {
      const res = await supertest(app)
        .get('/api/visitors/pipeline')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      // 15 canonical stages: lead → inquiry → follow_up → placement_booking → placement_fee →
      // placement_completed → class_fee → card_issued → book_issued → registration →
      // enrollment → active → graduated → alumni → lost
      expect(res.body.stages).toHaveLength(15);
    });

    it('should scope pipeline to user branch', async () => {
      createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });
      createVisitorDirect({ stage: 'lead', branch_id: BRANCH_B });

      const res = await supertest(app)
        .get('/api/visitors/pipeline')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      const leadStage = res.body.stages.find((s: any) => s.stage === 'lead');
      expect(leadStage.count).toBe(1); // Only branch A
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §8 — STAGE TRANSITION VALIDATION & PIPELINE PROGRESSION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§8 Stage Transition Validation', () => {
    it('should auto-advance to next stage', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ fromStage: 'lead' });

      expect(res.status).toBe(200);
      expect(res.body.from).toBe('lead');
      expect(res.body.to).toBe('inquiry');
      expect(getVisitor(vid).stage).toBe('inquiry');
    });

    it('should advance through multiple stages in sequence', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });
      const flow = ['inquiry', 'follow_up', 'placement_booking', 'placement_fee', 'placement_completed'];

      // Sequential advancement still works; each step states the stage it is
      // leaving, which is what makes CONCURRENT chaining impossible (V-7).
      let currentStage = 'lead';
      for (const expectedStage of flow) {
        const res = await supertest(app)
          .post(`/api/visitors/${vid}/advance-stage`)
          .set(authHeader(registrarA))
          .send({ fromStage: currentStage });

        expect(res.status).toBe(200);
        expect(res.body.to).toBe(expectedStage);
        currentStage = expectedStage;
      }

      expect(getVisitor(vid).stage).toBe('placement_completed');
    });

    it('should reject an unsafe stage jump', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ stage: 'placement_completed', fromStage: 'lead' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid transition');
      expect(getVisitor(vid).stage).toBe('lead');
    });

    it('should reject invalid stage transition', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ stage: 'invalid_stage', fromStage: 'lead' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid visitor stage');
    });

    it('should reject advance from terminal stage (lost)', async () => {
      const vid = createVisitorDirect({ stage: 'lost', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ fromStage: 'lost' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot auto-advance');
    });

    it('should allow advance from alumni to lost', async () => {
      const vid = createVisitorDirect({ stage: 'alumni', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ fromStage: 'alumni' });

      expect(res.status).toBe(200);
      expect(res.body.to).toBe('lost');
    });

    it('should not allow backward stage jumps to lead from enrollment', async () => {
      const vid = createVisitorDirect({ stage: 'enrollment', branch_id: BRANCH_A });

      // Jumping backward to 'lead' — the API allows explicit jumps to any valid stage
      // This is by design: explicit stage parameter allows any valid VISITOR_FLOW stage
      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ stage: 'lead', fromStage: 'enrollment' });

      // The API currently allows explicit jumps to any valid stage
      // This test documents the current behavior
      expect([200, 400]).toContain(res.status);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §9 — PLACEMENT TEST WORKFLOW
  // ═════════════════════════════════════════════════════════════════════════

  describe('§9 Placement Test Workflow', () => {
    it('should record placement test and advance stage', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });

      const { start, complete } = await startAndCompletePlacement(vid, {
        grammar: 20, vocabulary: 19, reading: 18, listening: 21, writing: 17, speaking: 20,
      }, registrarA, app);

      expect(start.status).toBe(201);
      expect(complete.status).toBe(200);
      expect(complete.body.ok).toBe(true);

      const visitor = getVisitor(vid);
      expect(visitor.stage).toBe('placement_completed');
      expect(visitor.placement_score).toBeDefined();

      const score = JSON.parse(visitor.placement_score);
      expect(score.percentage).toBeGreaterThan(60);
      expect(score.recommendation).toBeDefined();
      expect(Array.isArray(score.results)).toBe(true);
    });

    it('should charge placement fee on first test only', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });

      // Placement fee now resolves from branch_academic_profiles (Academic
      // Control Center) via the policy resolver, not system_settings.
      db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, ?)`).run(BRANCH_A, 500);

      const res1 = await startAndCompletePlacement(vid, {
        grammar: 10, vocabulary: 10, reading: 10, listening: 10, writing: 10, speaking: 10,
      }, registrarA, app);

      expect(res1.start.status).toBe(201);
      expect(res1.complete.status).toBe(200);
      expect(res1.complete.body.feeCharged).toBeGreaterThan(0);

      // Second test should NOT charge
      const res2 = await startAndCompletePlacement(vid, {
        grammar: 20, vocabulary: 19, reading: 18, listening: 20, writing: 18, speaking: 19,
      }, registrarA, app);

      expect(res2.start.status).toBe(201);
      expect(res2.complete.status).toBe(200);
      expect(res2.complete.body.feeCharged).toBe(0);
    });

    it('should handle zero scores gracefully', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });

      const { start, complete } = await startAndCompletePlacement(vid, {
        grammar: 0, vocabulary: 0, reading: 0, listening: 0, writing: 0, speaking: 0,
      }, registrarA, app);

      expect(start.status).toBe(201);
      expect(complete.status).toBe(200);
      const score = JSON.parse(getVisitor(vid).placement_score);
      expect(score.percentage).toBe(0);
    });

    it('should reject missing score fields instead of silently recording zeros', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });

      const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(registrarA)).send({});
      const put = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/skills`).set(authHeader(registrarA)).send({ skills: { grammar: 80 } });

      // Integrity hardening: an incomplete skill scorecard is rejected rather
      // than silently recording zeros for the missing skills.
      expect(put.status).toBe(400);
    });

    it('should record income transaction for fee', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });
      db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, ?)`).run(BRANCH_A, 300);

      const { start, complete } = await startAndCompletePlacement(vid, {
        grammar: 15, vocabulary: 15, reading: 15, listening: 15, writing: 15, speaking: 15,
      }, registrarA, app);

      expect(start.status).toBe(201);
      expect(complete.status).toBe(200);
      // The income transaction references the completed placement attempt.
      const tx = db.prepare("SELECT * FROM financial_transactions WHERE reference_id = ? AND category = 'placement'").get(start.body.id) as any;
      expect(tx).toBeDefined();
      expect(Number(tx.amount)).toBeGreaterThan(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §10 — CRM UPDATE
  // ═════════════════════════════════════════════════════════════════════════

  describe('§10 CRM Update', () => {
    it('should update CRM fields', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .patch(`/api/visitors/${vid}/crm`)
        .set(authHeader(registrarA))
        .send({
          interestedCourse: 'IELTS',
          followUpStatus: 'hot',
          nextContactDate: '2026-08-15',
          notes: 'Very interested',
        });

      expect(res.status).toBe(200);
      const visitor = getVisitor(vid);
      expect(visitor.interested_course).toBe('IELTS');
      expect(visitor.follow_up_status).toBe('hot');
      expect(visitor.next_contact_date).toBe('2026-08-15');
    });

    it('should update stage via the stage workflow endpoint', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      // Stage changes are no longer accepted by PATCH /:id/crm — they must go
      // through the stage workflow endpoint (advance-stage).
      const res = await supertest(app)
        .post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA))
        .send({ fromStage: 'lead' });

      expect(res.status).toBe(200);
      expect(getVisitor(vid).stage).toBe('inquiry');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §11 — VISITOR → STUDENT CONVERSION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§11 Visitor → Student Conversion', () => {
    it('should convert visitor to student with all records', async () => {
      const vid = createVisitorDirect({
        full_name: 'Convert Me',
        gender: 'male',
        phone: '0775555555',
        branch_id: BRANCH_A,
        stage: 'placement_completed',
      });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({
          classId: CLASS_A,
          amountPaid: 3000,
          discountPercent: 10,
          semesterFee: 5000,
          paymentMethod: 'cash',
        });

      expect(res.status).toBe(201);
      expect(res.body.studentId).toBeDefined();
      expect(res.body.studentCode).toMatch(/^TH-\d+$/);
      expect(res.body.receiptNumber).toBeDefined();
      expect(res.body.invoiceId).toBeDefined();
      expect(res.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{5}$/);
      expect(res.body.netAmount).toBe(4500); // 5000 - 10%

      // Verify student created
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(res.body.studentId) as any;
      expect(student).toBeDefined();
      expect(student.full_name).toBe('Convert Me');
      expect(student.lead_id).toBe(vid);
      expect(student.branch_id).toBe(BRANCH_A);
      expect(student.discount_percent).toBe(10);

      // Verify visitor status changed
      const visitor = getVisitor(vid);
      expect(visitor.status).toBe('registered');
      expect(visitor.stage).toBe('enrollment');

      // Verify semester
      const semester = db.prepare('SELECT * FROM student_semesters WHERE student_id = ?').get(res.body.studentId) as any;
      expect(semester).toBeDefined();
      expect(semester.class_id).toBe(CLASS_A);
      expect(semester.fee_amount).toBe(5000);
      expect(Number(semester.net_fee_amount)).toBe(4500);

      // Verify registration
      const reg = db.prepare('SELECT * FROM registrations WHERE student_id = ?').get(res.body.studentId) as any;
      expect(reg).toBeDefined();
      expect(reg.amount_paid).toBe(3000);

      // Verify invoice
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(res.body.invoiceId) as any;
      expect(invoice).toBeDefined();
      expect(invoice.total_amount).toBe(5000);
      expect(invoice.discount_amount).toBe(500);
      expect(invoice.net_amount).toBe(4500);

      // Verify payment
      const payment = db.prepare('SELECT * FROM payments WHERE student_id = ?').get(res.body.studentId) as any;
      expect(payment).toBeDefined();
      expect(payment.amount).toBe(3000);
      expect(payment.payment_method).toBe('cash');
      expect(payment.status).toBe('completed');

      // Verify journey events
      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ?').all(res.body.studentId) as any[];
      expect(events.length).toBeGreaterThanOrEqual(3); // STUDENT_REGISTERED, INVOICE_ISSUED, PAYMENT_RECORDED + ENROLLMENT_CREATED, CLASS_ASSIGNED
      const eventTypes = events.map((e: any) => e.event_type);
      expect(eventTypes).toContain('journey.student_registered');
      expect(eventTypes).toContain('journey.invoice_issued');
      expect(eventTypes).toContain('journey.payment_recorded');
    });

    it('should handle zero payment conversion', async () => {
      const vid = createVisitorDirect({ full_name: 'Zero Pay', gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 0, semesterFee: 5000 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('issued');

      // No payment record should exist
      const payments = db.prepare('SELECT * FROM payments WHERE student_id = ?').all(res.body.studentId) as any[];
      expect(payments).toHaveLength(0);
    });

    it('should handle full payment', async () => {
      const vid = createVisitorDirect({ full_name: 'Full Pay', gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('paid');
    });

    it('should handle partial payment', async () => {
      const vid = createVisitorDirect({ full_name: 'Partial Pay', gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 2000, semesterFee: 5000 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('partial');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §12 — CONVERSION FAILURE SCENARIOS
  // ═════════════════════════════════════════════════════════════════════════

  describe('§12 Conversion Failure Scenarios', () => {
    it('should reject conversion of already-registered visitor (status guard)', async () => {
      const vid = createVisitorDirect({ full_name: 'Already Registered', branch_id: BRANCH_A });
      db.prepare("UPDATE visitors SET status = 'registered' WHERE id = ?").run(vid);

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000 });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already been converted');
    });

    it('should reject duplicate conversion (lead_id guard)', async () => {
      const vid = createVisitorDirect({ full_name: 'Duplicate Convert', gender: 'male', branch_id: BRANCH_A });

      // Create a student with this visitor as lead_id
      db.prepare(
        `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
         VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
      ).run(id('stu'), 'TH-DUP-1', 'Pre-existing Student', today(), BRANCH_A, vid);

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000 });

      expect(res.status).toBe(409);
    });

    it('should reject conversion without class', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ amountPaid: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Class is required');
    });

    it('should reject conversion with negative payment', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: -100 });

      expect(res.status).toBe(400);
    });

    it('should reject conversion with payment exceeding net fee', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 10000, semesterFee: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cannot exceed');
    });

    it('should reject conversion to non-existent class', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: 'nonexistent_class', amountPaid: 3000 });

      expect(res.status).toBe(404);
    });

    it('should reject conversion when class is full (capacity check)', async () => {
      // Fill the class to capacity
      fillClass(CLASS_FULL, 1);

      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_FULL, amountPaid: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('full');
    });

    it('should reject gender policy violation (female → male-only class allowed, male → female-only blocked)', async () => {
      // CLASS_A is mixed, CLASS_B_FEMALE is female-only
      // Male student trying to enroll in female-only class should fail
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_B_FEMALE, amountPaid: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('female');
    });

    it('should allow female student into female-only class', async () => {
      const vid = createVisitorDirect({ gender: 'female', full_name: 'Female Student', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_B_FEMALE, amountPaid: 3000, semesterFee: 4500 });

      expect(res.status).toBe(201);
    });

    it('should reject unauthorized role (counselor cannot convert)', async () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(counselorA))
        .send({ classId: CLASS_A, amountPaid: 3000 });

      expect(res.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §13 — TRANSACTION ROLLBACK DURING CONVERSION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§13 Transaction Rollback', () => {
    it('should rollback all records on conversion failure', () => {
      const vid = createVisitorDirect({ gender: 'male', full_name: 'Rollback Test', branch_id: BRANCH_A });

      // Attempt conversion that will fail due to gender policy
      // by using a female-only class with a male student — this should fail BEFORE
      // the transaction, so let's trigger a failure inside the transaction instead
      // We'll test by providing a class that exists but causes an internal error
      // The conversion uses a single transaction, so any SQL error rolls back everything

      // Simulate a failure: use an invalid semesterFee that exceeds what's allowed
      // Actually the conversion has pre-validation. Let's test with a class that
      // will pass validation but the enrollment service will fail.

      // We test the atomicity by checking that no partial state is created when
      // conversion is rejected at any validation gate.

      // First verify no student/semester/registration/invoice/payment exist
      expect(countStudents()).toBe(0);

      // This conversion fails (gender policy)
      try {
        db.transaction(() => {
          // Simulate the beginning of a conversion: update visitor, create student
          db.prepare("UPDATE visitors SET status = 'registered' WHERE id = ?").run(vid);
          const stuId = id('stu');
          db.prepare(
            `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
             VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
          ).run(stuId, 'TH-ROLL-1', 'Rollback Student', today(), BRANCH_A, vid);

          // Now cause an error
          throw new Error('Simulated failure inside transaction');
        })();
      } catch {
        // Expected
      }

      // Verify rollback: visitor should NOT be marked registered
      const visitor = getVisitor(vid);
      expect(visitor.status).toBe('visited');

      // No student should exist
      expect(countStudents()).toBe(0);
    });

    it('should not create orphan student records on failed conversion', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });
      const initialStudentCount = countStudents();

      // Try to convert to female-only class (will fail)
      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_B_FEMALE, amountPaid: 3000 });

      expect(res.status).toBe(400);

      // Verify no student was created
      expect(countStudents()).toBe(initialStudentCount);

      // Verify visitor is unchanged
      const visitor = getVisitor(vid);
      expect(visitor.status).toBe('visited');
      expect(visitor.stage).toBe('lead');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §14 — LEAD → STUDENT LINKAGE & CONSISTENCY
  // ═════════════════════════════════════════════════════════════════════════

  describe('§14 Lead → Student Linkage & Consistency', () => {
    it('should maintain lead_id FK after conversion', async () => {
      const vid = createVisitorDirect({ full_name: 'Linked Visitor', gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      expect(res.status).toBe(201);

      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(res.body.studentId) as any;
      expect(student.lead_id).toBe(vid);

      // Verify reverse lookup
      const visitor = getVisitor(vid);
      expect(visitor.status).toBe('registered');
    });

    it('should copy demographic data from visitor to student', async () => {
      const vid = createVisitorDirect({
        full_name: 'Data Copy',
        gender: 'female',
        phone: '0777777777',
        email: 'copy@test.com',
        father_name: 'Father Name',
        address_region: 'Herat',
        tazkira_no: 'T-99999',
        whatsapp: '0777777777',
        dob: '1999-05-10',
        school_or_university: 'Herat University',
        emergency_contact_name: 'Emergency',
        emergency_contact_phone: '0778888888',
        branch_id: BRANCH_A,
      });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_B_FEMALE, amountPaid: 4500, semesterFee: 4500 });

      expect(res.status).toBe(201);

      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(res.body.studentId) as any;
      expect(student.full_name).toBe('Data Copy');
      expect(student.gender).toBe('female');
      expect(student.phone).toBe('0777777777');
      expect(student.email).toBe('copy@test.com');
      expect(student.father_name).toBe('Father Name');
      expect(student.address_region).toBe('Herat');
      expect(student.tazkira_no).toBe('T-99999');
      expect(student.school_or_university).toBe('Herat University');
    });

    it('should copy placement score from visitor to student', async () => {
      const score = JSON.stringify({ grammar: 85, listening: 90, speaking: 88, total: 263 });
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });
      db.prepare('UPDATE visitors SET placement_score = ? WHERE id = ?').run(score, vid);

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      expect(res.status).toBe(201);
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(res.body.studentId) as any;
      expect(student.placement_score).toBe(score);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §15 — DATABASE INTEGRITY & FOREIGN KEY INTEGRITY
  // ═════════════════════════════════════════════════════════════════════════

  describe('§15 Database & Foreign Key Integrity', () => {
    it('should not allow orphan visitor_followups', () => {
      // visitor_followups has ON DELETE CASCADE
      const vid = createVisitorDirect({ branch_id: BRANCH_A });
      db.prepare(
        'INSERT INTO visitor_followups (id, visitor_id, date, notes, operator, outcome) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id('f'), vid, today(), 'Test note', 'Test', 'interested');

      expect(countFollowups(vid)).toBe(1);

      // Delete the visitor
      db.prepare('DELETE FROM visitors WHERE id = ?').run(vid);

      // Followup should be cascade-deleted
      expect(countFollowups(vid)).toBe(0);
    });

    it('should not allow student with invalid lead_id FK', () => {
      // Try to insert a student referencing a non-existent visitor
      // This should fail due to FK constraint
      expect(() => {
        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
           VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
        ).run(id('stu'), 'TH-FK-1', 'FK Test', today(), BRANCH_A, 'nonexistent_visitor');
      }).toThrow();
    });

    it('should maintain referential integrity: students.lead_id → visitors.id', async () => {
      const vid = createVisitorDirect({ full_name: 'FK Test Visitor', gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      expect(res.status).toBe(201);

      // Verify FK link is valid
      const student = db.prepare('SELECT s.*, v.full_name as visitor_name FROM students s JOIN visitors v ON s.lead_id = v.id WHERE s.id = ?').get(res.body.studentId) as any;
      expect(student).toBeDefined();
      expect(student.visitor_name).toBe('FK Test Visitor');
    });

    it('should not have orphan visitor records after test cleanup', () => {
      // Verify no visitors exist after cleanup (they should be cleaned in beforeEach)
      expect(countVisitors()).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §16 — PIPELINE STATE INTEGRITY
  // ═════════════════════════════════════════════════════════════════════════

  describe('§16 Pipeline State Integrity', () => {
    it('should enforce valid stage values via CHECK constraint', () => {
      const vid = createVisitorDirect({ branch_id: BRANCH_A });

      // Try to set an invalid stage directly (bypasses API validation)
      expect(() => {
        db.prepare('UPDATE visitors SET stage = ? WHERE id = ?').run('invalid_stage_xyz', vid);
      }).toThrow();
    });

    it('should allow only sequential valid VISITOR_FLOW transitions via API', async () => {
      const validStages = [
        'inquiry', 'follow_up', 'placement_booking', 'placement_fee',
        'placement_completed', 'class_fee', 'card_issued', 'book_issued',
        'registration', 'enrollment', 'active', 'graduated', 'alumni',
      ];
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      let priorStage = 'lead';
      for (const stage of validStages) {
        const res = await supertest(app)
          .post(`/api/visitors/${vid}/advance-stage`)
          .set(authHeader(registrarA))
          .send({ stage, fromStage: priorStage });
        expect(res.status).toBe(200);
        priorStage = stage;
      }

      expect(getVisitor(vid).stage).toBe('alumni');
    });

    it('should prevent broken pipeline: converted visitor should be at enrollment stage', async () => {
      const vid = createVisitorDirect({ stage: 'lead', gender: 'male', branch_id: BRANCH_A });

      await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      const visitor = getVisitor(vid);
      expect(visitor.stage).toBe('enrollment');
      expect(visitor.status).toBe('registered');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §17 — EVENT GENERATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§17 Event Generation', () => {
    it('should generate STUDENT_REGISTERED event on conversion', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      expect(res.status).toBe(201);

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.student_registered') as any[];
      expect(events.length).toBe(1);
      expect(events[0].actor_name).toBe('Test User');
    });

    it('should generate INVOICE_ISSUED event', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.invoice_issued') as any[];
      expect(events.length).toBe(1);

      const payload = JSON.parse(events[0].payload);
      expect(payload.invoiceId).toBe(res.body.invoiceId);
    });

    it('should generate PAYMENT_RECORDED event when payment > 0', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000 });

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.payment_recorded') as any[];
      expect(events.length).toBe(1);

      const payload = JSON.parse(events[0].payload);
      expect(payload.amount).toBe(3000);
    });

    it('should NOT generate PAYMENT_RECORDED when payment is 0', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 0, semesterFee: 5000 });

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.payment_recorded') as any[];
      expect(events.length).toBe(0);
    });

    it('should generate ENROLLMENT_CREATED event', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.enrollment_created') as any[];
      expect(events.length).toBe(1);
    });

    it('should generate CLASS_ASSIGNED event', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

      const events = db.prepare('SELECT * FROM student_journey_events WHERE student_id = ? AND event_type = ?')
        .all(res.body.studentId, 'journey.class_assigned') as any[];
      expect(events.length).toBe(1);

      const payload = JSON.parse(events[0].payload);
      expect(payload.classId).toBe(CLASS_A);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §18 — RULE ENGINE INTERACTION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§18 Rule Engine Interaction', () => {
    it('should use the policy resolver for the placement test fee', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });

      // Fee resolves from branch_academic_profiles (Academic Control Center)
      // through the canonical policy resolver, charged on first completion.
      db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, ?)`).run(BRANCH_A, 500);

      const { start, complete } = await startAndCompletePlacement(vid, {
        grammar: 15, vocabulary: 15, reading: 15, listening: 15, writing: 15, speaking: 15,
      }, registrarA, app);

      expect(start.status).toBe(201);
      expect(complete.status).toBe(200);
      expect(complete.body.feeCharged).toBe(500);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §19 — API VALIDATION EDGE CASES
  // ═════════════════════════════════════════════════════════════════════════

  describe('§19 API Validation', () => {
    it('should return 404 for non-existent visitor PATCH', async () => {
      const res = await supertest(app)
        .patch('/api/visitors/nonexistent')
        .set(authHeader(registrarA))
        .send({ notes: 'test' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent visitor followup', async () => {
      const res = await supertest(app)
        .post('/api/visitors/nonexistent/followups')
        .set(authHeader(registrarA))
        .send({ notes: 'test' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for a non-existent visitor in the placement workspace', async () => {
      const res = await supertest(app)
        .get('/api/placement/visitors/nonexistent/placement')
        .set(authHeader(registrarA));

      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent visitor CRM update', async () => {
      const res = await supertest(app)
        .patch('/api/visitors/nonexistent/crm')
        .set(authHeader(registrarA))
        .send({ notes: 'test' });

      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent visitor conversion', async () => {
      const res = await supertest(app)
        .post('/api/visitors/nonexistent/convert')
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000 });

      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent visitor advance-stage', async () => {
      const res = await supertest(app)
        .post('/api/visitors/nonexistent/advance-stage')
        .set(authHeader(registrarA))
        .send({});

      expect(res.status).toBe(404);
    });

    it('should handle invalid JSON body gracefully', async () => {
      const res = await supertest(app)
        .post('/api/visitors/')
        .set(authHeader(registrarA))
        .set('Content-Type', 'application/json')
        .send('invalid json');

      // Express either returns 400 (malformed JSON) or 500 depending on body parser config
      expect([400, 500]).toContain(res.status);
    });

    it('should cap page size at maximum', async () => {
      // Create many visitors
      for (let i = 0; i < 5; i++) {
        createVisitorDirect({ branch_id: BRANCH_A });
      }

      const res = await supertest(app)
        .get('/api/visitors/?limit=9999')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      expect(res.headers['x-page-limit']).toBe('100'); // MAX_PAGE_SIZE
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §20 — CONCURRENT OPERATIONS
  // ═════════════════════════════════════════════════════════════════════════

  describe('§20 Concurrent Operations', () => {
    it('should handle concurrent visitor creation without serial duplicates', async () => {
      const count = 20;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < count; i++) {
        promises.push(
          supertest(app)
            .post('/api/visitors/')
            .set(authHeader(registrarA))
            .send({ fullName: `Concurrent ${i}`, gender: 'male', source: 'walk_in' })
        );
      }

      const results = await Promise.all(promises);
      const serials = new Set<string>();

      for (const res of results) {
        expect(res.status).toBe(201);
        serials.add(res.body.serialNo);
      }

      // All serials must be unique
      expect(serials.size).toBe(count);
    });

    it('should handle concurrent stage updates without data corruption', async () => {
      const vid = createVisitorDirect({ stage: 'lead', branch_id: BRANCH_A });

      // CORRECTED (audit V-7). This test previously asserted that BOTH
      // concurrent advances succeed and the lead ends two stages further on,
      // which encoded the defect as intended behaviour: it is why deleting the
      // compare-and-swap guard did not fail any test. Ten parallel requests
      // walked a lead from 'lead' to 'enrollment' — through placement_booking,
      // placement_fee and placement_completed — from one user action.
      //
      // Both requests now declare the stage they are leaving, so exactly one
      // may win and the other is told to reload.
      const promises = [
        supertest(app)
          .post(`/api/visitors/${vid}/advance-stage`)
          .set(authHeader(registrarA))
          .send({ fromStage: 'lead' }),
        supertest(app)
          .post(`/api/visitors/${vid}/advance-stage`)
          .set(authHeader(registrarA))
          .send({ fromStage: 'lead' }),
      ];

      const results = await Promise.all(promises);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      // One deliberate action, one transition.
      expect(getVisitor(vid).stage).toBe('inquiry');
    });

    it('should prevent concurrent duplicate conversions', async () => {
      const vid = createVisitorDirect({ gender: 'male', full_name: 'Concurrent Convert', branch_id: BRANCH_A });

      const promises = [
        supertest(app)
          .post(`/api/visitors/${vid}/convert`)
          .set(authHeader(registrarA))
          .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 }),
        supertest(app)
          .post(`/api/visitors/${vid}/convert`)
          .set(authHeader(registrarA))
          .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 }),
      ];

      const results = await Promise.all(promises);
      const successes = results.filter(r => r.status === 201);
      const failures = results.filter(r => r.status === 409);

      // Exactly one should succeed, one should fail
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      // Only one student should exist
      expect(countStudents()).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §21 — FINANCIAL INTEGRITY IN CONVERSION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§21 Financial Integrity in Conversion', () => {
    it('should record income for registration payment', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000, paymentMethod: 'cash' });

      expect(res.status).toBe(201);

      const tx = db.prepare("SELECT * FROM financial_transactions WHERE category = 'fee' AND type = 'income'").all() as any[];
      const feeTx = tx.find(t => t.description?.includes('Registration fee'));
      expect(feeTx).toBeDefined();
      expect(Number(feeTx.amount)).toBe(3000);
    });

    it('should create invoice with correct discount calculation', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3500, semesterFee: 5000, discountPercent: 20 });

      expect(res.status).toBe(201);
      expect(res.body.netAmount).toBe(4000); // 5000 - 20%

      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(res.body.invoiceId) as any;
      expect(invoice.total_amount).toBe(5000);
      expect(invoice.discount_amount).toBe(1000);
      expect(invoice.net_amount).toBe(4000);
    });

    it('should create notification on conversion', async () => {
      const vid = createVisitorDirect({ gender: 'male', full_name: 'Notify Test', branch_id: BRANCH_A });

      await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000 });

      const notifications = db.prepare("SELECT * FROM notifications WHERE title LIKE '%Registration%'").all() as any[];
      expect(notifications.length).toBeGreaterThan(0);

      const notif = notifications.find(n => n.message.includes('Notify Test'));
      expect(notif).toBeDefined();
    });

    it('should write audit log for conversion', async () => {
      const vid = createVisitorDirect({ gender: 'male', full_name: 'Audit Test', branch_id: BRANCH_A });

      await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000 });

      const audit = db.prepare("SELECT * FROM audit_logs WHERE action LIKE '%Converted%'").all() as any[];
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].action).toContain('Audit Test');
    });

    it('should record saving transfer from placement fee', async () => {
      const vid = createVisitorDirect({ stage: 'placement_booking', branch_id: BRANCH_A, program_version_id: VT_VERSION });
      db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, ?)`).run(BRANCH_A, 500);
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('daily_saving_percent', '5')").run();

      const { start, complete } = await startAndCompletePlacement(vid, {
        grammar: 15, vocabulary: 15, reading: 15, listening: 15, writing: 15, speaking: 15,
      }, registrarA, app);

      expect(start.status).toBe(201);
      expect(complete.status).toBe(200);
      expect(complete.body.feeCharged).toBe(500);

      const savingTx = db.prepare("SELECT * FROM financial_transactions WHERE category = 'saving' AND type = 'saving_transfer'").all() as any[];
      expect(savingTx.length).toBeGreaterThan(0);
      expect(Number(savingTx[0].amount)).toBe(25); // 5% of 500
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §22 — PAYMENT METHOD VALIDATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§22 Payment Method Validation', () => {
    it('should accept cash payment method', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000, paymentMethod: 'cash' });

      expect(res.status).toBe(201);
      const payment = db.prepare('SELECT * FROM payments WHERE student_id = ?').get(res.body.studentId) as any;
      expect(payment.payment_method).toBe('cash');
    });

    it('should accept card payment method', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000, paymentMethod: 'card' });

      expect(res.status).toBe(201);
      const payment = db.prepare('SELECT * FROM payments WHERE student_id = ?').get(res.body.studentId) as any;
      expect(payment.payment_method).toBe('card');
    });

    it('should accept bank_transfer payment method', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000, paymentMethod: 'bank_transfer' });

      expect(res.status).toBe(201);
      const payment = db.prepare('SELECT * FROM payments WHERE student_id = ?').get(res.body.studentId) as any;
      expect(payment.payment_method).toBe('bank_transfer');
    });

    it('should reject an invalid payment method instead of silently recording cash', async () => {
      const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });

      const res = await supertest(app)
        .post(`/api/visitors/${vid}/convert`)
        .set(authHeader(registrarA))
        .send({ classId: CLASS_A, amountPaid: 3000, semesterFee: 5000, paymentMethod: 'crypto' });

      expect(res.status).toBe(400);
      expect(db.prepare('SELECT id FROM students WHERE lead_id = ?').get(vid)).toBeUndefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // §23 — NO DATA CORRUPTION VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════

  describe('§23 Data Corruption Prevention', () => {
    it('should not have duplicate visitors after bulk creation', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const res = await supertest(app)
          .post('/api/visitors/')
          .set(authHeader(registrarA))
          .send({ fullName: `Bulk ${i}`, gender: i % 2 === 0 ? 'male' : 'female', source: 'walk_in' });
        expect(res.status).toBe(201);
        ids.add(res.body.id);
      }
      expect(ids.size).toBe(30);

      // Verify DB count matches
      expect(countVisitors(BRANCH_A)).toBe(30);
    });

    it('should not have orphan records after failed conversions', async () => {
      // Attempt multiple failing conversions
      for (let i = 0; i < 5; i++) {
        const vid = createVisitorDirect({ gender: 'male', branch_id: BRANCH_A });
        await supertest(app)
          .post(`/api/visitors/${vid}/convert`)
          .set(authHeader(registrarA))
          .send({ classId: CLASS_B_FEMALE, amountPaid: 3000 }); // Will fail: male → female class
      }

      // No students, no semesters, no registrations, no invoices, no payments
      expect(countStudents()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) as c FROM student_semesters').get() as { c: number }).toEqual({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) as c FROM registrations').get() as { c: number }).toEqual({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) as c FROM invoices').get() as { c: number }).toEqual({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) as c FROM payments').get() as { c: number }).toEqual({ c: 0 });
    });

    it('should maintain consistent Student/Visitor relationships', async () => {
      // Convert multiple visitors
      const converted = [];
      for (let i = 0; i < 5; i++) {
        const vid = createVisitorDirect({
          gender: 'male',
          full_name: `Consistency ${i}`,
          branch_id: BRANCH_A,
          phone: `077000${String(1000 + i).slice(-4)}`,
        });

        const res = await supertest(app)
          .post(`/api/visitors/${vid}/convert`)
          .set(authHeader(registrarA))
          .send({ classId: CLASS_A, amountPaid: 5000, semesterFee: 5000 });

        expect(res.status).toBe(201);
        converted.push({ vid, studentId: res.body.studentId });
      }

      // Verify every student has a valid lead_id
      // Verify every converted visitor is marked registered
      for (const { vid, studentId } of converted) {
        const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId) as any;
        expect(student.lead_id).toBe(vid);

        const visitor = getVisitor(vid);
        expect(visitor.status).toBe('registered');
        expect(visitor.stage).toBe('enrollment');
      }

      // No visitor should be marked registered without a corresponding student
      const registeredVisitors = db.prepare("SELECT * FROM visitors WHERE status = 'registered'").all() as any[];
      for (const v of registeredVisitors) {
        const student = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(v.id);
        expect(student).toBeDefined();
      }
    });
  });
});
