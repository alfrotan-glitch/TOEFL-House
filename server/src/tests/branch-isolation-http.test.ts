/**
 * HTTP Integration Test: Branch Isolation at API Level
 * =================================================================
 * Proves CRIT-05, CRIT-06, CRIT-07 are enforced at the HTTP layer,
 * not just in unit-level middleware tests.
 *
 * Test Matrix:
 *   1. Student Detail — Branch A registrar accessing Branch B student → 403
 *   2. Student Update — Branch A registrar updating Branch B student → 403
 *   3. Invoice Detail — Branch A finance accessing Branch B invoice → 403
 *   4. Invoice Issue  — Branch A finance issuing Branch B invoice → 403
 *   5. Invoice Pay    — Branch A finance paying Branch B invoice → 403
 *   6. Invoice Cancel — Branch A finance cancelling Branch B invoice → 403
 *   7. Student List — Branch A registrar does NOT see Branch B students
 *   8. Invoice List — Branch A finance does NOT see Branch B invoices
 *   9. Owner — CAN cross branches; branch-scoped manager is denied; campus-scoped manager is limited to its campus
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import express from 'express';
import supertest from 'supertest';
import { studentsRouter } from '../routes/students.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';

// ── Constants ────────────────────────────────────────────────────────────────
const BRANCH_A = 'iso_branch_a';
const BRANCH_B = 'iso_branch_b';
const BRANCH_C = 'iso_branch_c';

// ── Helper: build a minimal Express app mounting students + invoices routers ──
function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}

// ── Helper: create a token payload ────────────────────────────────────────────
function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId,
    username: overrides.username || overrides.userId,
    role: overrides.role || 'registrar',
    branchId: overrides.branchId || BRANCH_A,
    fullName: overrides.fullName || 'Test User',
  };
}

function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

// ── Seed data helpers ────────────────────────────────────────────────────────
function seedBranches() {
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run('iso_campus_a', FIXED_ORG_ID, 'ISO Campus A', 'ISO-A');
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run('iso_campus_b', FIXED_ORG_ID, 'ISO Campus B', 'ISO-B');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_A, 'ISO Branch A', 'Loc A', 'iso_campus_a');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_B, 'ISO Branch B', 'Loc B', 'iso_campus_b');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_C, 'ISO Branch C', 'Loc C', 'iso_campus_a');
  db.prepare('UPDATE branches SET campus_id = ? WHERE id = ?').run('iso_campus_a', BRANCH_A);
  db.prepare('UPDATE branches SET campus_id = ? WHERE id = ?').run('iso_campus_b', BRANCH_B);
}

/**
 * Seed a user row in the `users` table so that authenticate() middleware
 * can look it up and build RBAC context. Without this, requirePermission()
 * returns 403 because req.rbac is undefined.
 */
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, role, branchId, await hashPassword('testpass123'));
}

function seedStudent(studentId: string, branchId: string, name: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-ISO-${studentId.slice(-4)}`, name, today(), branchId);
}

function seedInvoice(invoiceId: string, studentId: string, branchId: string, status = 'issued') {
  db.prepare(
    `INSERT OR IGNORE INTO invoices
      (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
     VALUES (?, ?, 5000, 0, 5000, ?, ?, ?, ?, ?)`
  ).run(invoiceId, studentId, status, today(), today(), branchId, `INV-2026-00001`);
}

// ── Test Suite ───────────────────────────────────────────────────────────────
describe('Branch Isolation — HTTP Integration (CRIT-05, CRIT-06, CRIT-07)', () => {
  let app: any;

  // Users
  let registrarA: TokenPayload;
  let registrarB: TokenPayload;
  let financeA: TokenPayload;
  let financeB: TokenPayload;
  let ownerUser: TokenPayload;
  let managerA: TokenPayload;
  let campusManager: TokenPayload;

  // Seeded entity IDs
  const STUDENT_A = 'iso_stu_a';
  const STUDENT_B = 'iso_stu_b';
  const INVOICE_A = 'iso_inv_a';
  const INVOICE_B = 'iso_inv_b';
  const INVOICE_C = 'iso_inv_c';

  beforeAll(async () => {
    initSchema();
    ensureOrganizationHierarchy(db);

    // Bootstrap RBAC catalog so roles/permissions tables are populated,
    // then seed user rows so authenticate() can build RBAC context.
    bootstrapRbacCatalog(db);
    seedBranches();

    // Seed users in the `users` table — required for RBAC context
    await seedUser('u_iso_reg_a', 'registrar', BRANCH_A, 'reg_a');
    await seedUser('u_iso_reg_b', 'registrar', BRANCH_B, 'reg_b');
    await seedUser('u_iso_fin_a', 'finance',   BRANCH_A, 'fin_a');
    await seedUser('u_iso_fin_b', 'finance',   BRANCH_B, 'fin_b');
    await seedUser('u_iso_owner',  'owner',    BRANCH_A, 'owner');
    await seedUser('u_iso_mgr_a',  'manager',   BRANCH_A, 'mgr_a');
    await seedUser('u_iso_mgr_campus', 'manager', BRANCH_A, 'mgr_campus');

    // Sync legacy roles → user_roles table
    syncLegacyUserRoles(db);
    const managerRole = db.prepare('SELECT id FROM roles WHERE code = ?').get('general_manager') as { id: string };
    db.prepare('UPDATE user_roles SET scope_type = ?, scope_id = ? WHERE user_id = ? AND role_id = ?').run('campus', 'iso_campus_a', 'u_iso_mgr_campus', managerRole.id);

    // Seed test entities
    seedStudent(STUDENT_A, BRANCH_A, 'Student in Branch A');
    seedStudent(STUDENT_B, BRANCH_B, 'Student in Branch B');
    seedInvoice(INVOICE_A, STUDENT_A, BRANCH_A, 'issued');
    seedInvoice(INVOICE_B, STUDENT_B, BRANCH_B, 'issued');
    const studentC = 'iso_stu_c';
    seedStudent(studentC, BRANCH_C, 'Student in Branch C');
    seedInvoice(INVOICE_C, studentC, BRANCH_C, 'issued');

    app = createApp();

    registrarA  = makeUser({ userId: 'u_iso_reg_a', role: 'registrar', branchId: BRANCH_A });
    registrarB  = makeUser({ userId: 'u_iso_reg_b', role: 'registrar', branchId: BRANCH_B });
    financeA    = makeUser({ userId: 'u_iso_fin_a', role: 'finance',   branchId: BRANCH_A });
    financeB    = makeUser({ userId: 'u_iso_fin_b', role: 'finance',   branchId: BRANCH_B });
    ownerUser   = makeUser({ userId: 'u_iso_owner',  role: 'owner',    branchId: BRANCH_A });
    managerA    = makeUser({ userId: 'u_iso_mgr_a',  role: 'manager',   branchId: BRANCH_A });
    campusManager = makeUser({ userId: 'u_iso_mgr_campus', role: 'manager', branchId: BRANCH_A });
  });

  afterAll(() => {
    // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CRIT-05: Student branch isolation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('CRIT-05: Student Branch Isolation', () => {
    it('Branch A registrar GET /api/students/:id for Branch B student → 403', async () => {
      const res = await supertest(app)
        .get(`/api/students/${STUDENT_B}`)
        .set(authHeader(registrarA));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/another branch/i);
    });

    it('Branch A registrar cannot update Branch B student (PATCH route — CRIT-09 fixed)', async () => {
      // Phase 2 (CRIT-09): PATCH /:id now calls requireStudent() for branch isolation.
      const res = await supertest(app)
        .patch(`/api/students/${STUDENT_B}`)
        .set(authHeader(registrarA))
        .send({ phone: '000000000' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/another branch/i);
    });

    it('Branch A registrar list does NOT include Branch B students', async () => {
      const res = await supertest(app)
        .get('/api/students/')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((s) => s.id);
      expect(ids).toContain(STUDENT_A);
      expect(ids).not.toContain(STUDENT_B);
    });

    it('Branch B registrar list does NOT include Branch A students', async () => {
      const res = await supertest(app)
        .get('/api/students/')
        .set(authHeader(registrarB));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((s) => s.id);
      expect(ids).toContain(STUDENT_B);
      expect(ids).not.toContain(STUDENT_A);
    });

    it('Owner CAN access Branch B student (positive control)', async () => {
      const res = await supertest(app)
        .get(`/api/students/${STUDENT_B}`)
        .set(authHeader(ownerUser));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(STUDENT_B);
    });

    it('Branch A manager cannot access Branch B student (branch-scoped manager is denied)', async () => {
      const res = await supertest(app)
        .get(`/api/students/${STUDENT_B}`)
        .set(authHeader(managerA));

      expect(res.status).toBe(403);
    });

    it('Campus-scoped manager can access a student in a branch within the assigned campus', async () => {
      const res = await supertest(app)
        .get(`/api/students/${'iso_stu_c'}`)
        .set(authHeader(campusManager));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('iso_stu_c');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CRIT-06: Invoice branch isolation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('CRIT-06: Invoice Branch Isolation', () => {
    it('Branch A finance GET /api/invoices/:id for Branch B invoice → 403', async () => {
      const res = await supertest(app)
        .get(`/api/invoices/${INVOICE_B}`)
        .set(authHeader(financeA));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/another branch/i);
    });

    it('Branch A finance POST /api/invoices/:id/issue for Branch B invoice → 403', async () => {
      const res = await supertest(app)
        .post(`/api/invoices/${INVOICE_B}/issue`)
        .set(authHeader(financeA));

      expect(res.status).toBe(403);
    });

    it('Branch A finance POST /api/invoices/:id/pay for Branch B invoice → 403', async () => {
      const res = await supertest(app)
        .post(`/api/invoices/${INVOICE_B}/pay`)
        .set(authHeader(financeA))
        .send({ amount: 1000, paymentMethod: 'cash' });

      expect(res.status).toBe(403);
    });

    it('Branch A finance POST /api/invoices/:id/cancel for Branch B invoice → 403', async () => {
      const res = await supertest(app)
        .post(`/api/invoices/${INVOICE_B}/cancel`)
        .set(authHeader(financeA));

      expect(res.status).toBe(403);
    });

    it('Branch A finance list does NOT include Branch B invoices', async () => {
      const res = await supertest(app)
        .get('/api/invoices/')
        .set(authHeader(financeA));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((inv) => inv.id);
      expect(ids).toContain(INVOICE_A);
      expect(ids).not.toContain(INVOICE_B);
    });

    it('Owner CAN access Branch B invoice (positive control)', async () => {
      const res = await supertest(app)
        .get(`/api/invoices/${INVOICE_B}`)
        .set(authHeader(ownerUser));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(INVOICE_B);
    });

    it('Branch A manager cannot access Branch B invoice without broader scope', async () => {
      const res = await supertest(app)
        .get(`/api/invoices/${INVOICE_B}`)
        .set(authHeader(managerA));

      expect(res.status).toBe(403);
    });

    it('Campus-scoped manager can access a branch in the assigned campus', async () => {
      const res = await supertest(app)
        .get(`/api/invoices/${INVOICE_C}`)
        .set(authHeader(campusManager));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(INVOICE_C);
    });

    it('Campus-scoped manager cannot access a branch outside the assigned campus', async () => {
      const res = await supertest(app)
        .get(`/api/invoices/${INVOICE_B}`)
        .set(authHeader(campusManager));

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CRIT-07: Combined cross-context isolation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('CRIT-07: Cross-Context Branch Isolation', () => {
    it('Branch A registrar cannot pay Branch B invoice (registrar blocked by role check)', async () => {
      const res = await supertest(app)
        .post(`/api/invoices/${INVOICE_B}/pay`)
        .set(authHeader(registrarA))
        .send({ amount: 1000, paymentMethod: 'cash' });

      // /pay endpoint requires authorize('finance', 'manager') — registrar is rejected
      expect(res.status).toBe(403);
    });

    it('Branch B finance cannot access Branch A student', async () => {
      const res = await supertest(app)
        .get(`/api/students/${STUDENT_A}`)
        .set(authHeader(financeB));

      // finance role has Student.View via RBAC, but branch check blocks it
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/another branch/i);
    });

    it('Branch A registrar CAN list invoices (registrar is in invoices authorize list)', async () => {
      // invoicesRouter has authorize('finance', 'manager', 'registrar') at top level
      const res = await supertest(app)
        .get('/api/invoices/')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      // But registrar should only see Branch A invoices
      const ids = (res.body as any[]).map((inv) => inv.id);
      expect(ids).toContain(INVOICE_A);
      expect(ids).not.toContain(INVOICE_B);
    });

    it('Owner can list all students across branches (branchId=all)', async () => {
      const res = await supertest(app)
        .get('/api/students/?branchId=all')
        .set(authHeader(ownerUser));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((s) => s.id);
      expect(ids).toContain(STUDENT_A);
      expect(ids).toContain(STUDENT_B);
    });

    it('Owner can list all invoices across branches (branchId=all)', async () => {
      const res = await supertest(app)
        .get('/api/invoices/?branchId=all')
        .set(authHeader(ownerUser));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((inv) => inv.id);
      expect(ids).toContain(INVOICE_A);
      expect(ids).toContain(INVOICE_B);
    });

    it('Registrar cannot request branchId=all (forced to own branch)', async () => {
      const res = await supertest(app)
        .get('/api/students/?branchId=all')
        .set(authHeader(registrarA));

      expect(res.status).toBe(200);
      const ids = (res.body as any[]).map((s) => s.id);
      // Should only see Branch A students — resolveBranchScope forces registrar to own branch
      expect(ids).toContain(STUDENT_A);
      expect(ids).not.toContain(STUDENT_B);
    });
  });
});
