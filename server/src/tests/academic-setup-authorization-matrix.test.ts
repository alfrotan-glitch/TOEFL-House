/**
 * Academic Setup — authorization matrix (locked).
 * ============================================================================
 * Academic Setup spans TWO authorization authorities, and that split is real
 * rather than accidental:
 *
 *   • `academic.routes.ts`  — legacy `authorize('owner','manager')` role gates.
 *     Terms, slots, rooms, programs, levels, level fees and the placement
 *     profile live here.
 *   • `catalog.routes.ts`   — modern `requirePermission(...)` permission gates.
 *     Program versions, subjects, modules, promotion/placement rules and class
 *     generation live here.
 *
 * The permission catalog grants `AcademicSetup.Edit` to the OWNER ONLY, so a
 * General Manager can administer the academic calendar and curriculum but
 * cannot create a program version. Widening that is a business decision, not a
 * bug fix, so this suite PINS the observed matrix instead of changing it. If
 * someone later grants `AcademicSetup.Edit` to another position, these tests
 * fail loudly and force the decision to be explicit.
 *
 * It also locks the one genuine defect that was fixed: `academicRouter` had
 * reads with no permission gate at all, so a permissionless principal — the
 * `student` portal position, whose role deliberately carries `permissions: {}`
 * — could read the whole branch's academic configuration.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import academicRouter from '../routes/academic.routes.js';
import { catalogRouter } from '../routes/catalog.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'asa_branch';
const PROGRAM = 'asa_program';
const VERSION = 'asa_version';

/** userId -> legacy role carried in the token. */
const ACTORS: Record<string, string> = {
  asa_owner: 'owner',
  asa_manager: 'manager',
  asa_hod: 'head_of_department',
  asa_registrar: 'registrar',
  asa_teacher: 'teacher',
  asa_student: 'student',
};

let app: express.Express;

function tokenFor(userId: string) {
  return signToken({
    userId,
    username: userId,
    role: ACTORS[userId],
    branchId: BRANCH,
    fullName: userId,
    sessionVersion: 1,
  } as unknown as TokenPayload);
}

function auth(userId: string) {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

/** 403 = denied by an authorization gate. Anything else means the gate passed. */
async function statusOf(userId: string, verb: 'get' | 'post' | 'put', path: string, body?: unknown) {
  const req = (supertest(app) as any)[verb](path).set(auth(userId));
  const res = await (body === undefined ? req : req.send(body));
  return res.status as number;
}

const deniedFor = (status: number) => status === 403;

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, BRANCH, 'loc');
  for (const [userId, role] of Object.entries(ACTORS)) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, is_active, session_version, must_change_password)
       VALUES (?, ?, 'x', ?, ?, ?, 1, 1, 0)`
    ).run(userId, userId, userId, role, BRANCH);
  }
  bootstrapRbacCatalog(db);
  syncLegacyUserRoles(db);

  db.prepare('INSERT OR IGNORE INTO programs (id, name, branch_id) VALUES (?, ?, ?)').run(PROGRAM, 'Prog', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status)
     VALUES (?, ?, 'v1', 1, 'published')`
  ).run(VERSION, PROGRAM);
  db.prepare(
    'INSERT OR IGNORE INTO academic_terms (id, branch_id, year, code, name) VALUES (?, ?, 2026, ?, ?)'
  ).run('asa_term', BRANCH, 'FALL', 'Fall');

  const instance = express();
  instance.use(express.json());
  instance.use('/api/academic', academicRouter);
  instance.use('/api/catalog', catalogRouter);
  instance.use(errorHandler);
  app = instance;
});

describe('Academic Setup — permissionless principals cannot read configuration', () => {
  const READ_PATHS = [
    '/api/academic/terms',
    '/api/academic/rooms',
    '/api/academic/time-slots',
    '/api/academic/level-fees',
    '/api/academic/branch-config',
    '/api/academic/programs',
    '/api/academic/levels',
  ];

  // The `student` position ships `permissions: {}` precisely so it can never
  // reach branch-wide data. Before the fix every one of these returned 200.
  it.each(READ_PATHS)('student is denied %s', async (path) => {
    expect(await statusOf('asa_student', 'get', path)).toBe(403);
  });

  // The guard must reject ONLY permissionless principals: every staff position
  // that legitimately reads academic configuration must be unaffected.
  it.each(['asa_owner', 'asa_manager', 'asa_hod', 'asa_registrar', 'asa_teacher'])(
    '%s can still read academic configuration',
    async (userId) => {
      for (const path of ['/api/academic/terms', '/api/academic/rooms', '/api/academic/branch-config']) {
        expect(await statusOf(userId, 'get', path)).toBe(200);
      }
    }
  );
});

describe('Academic Setup — role-gated authority (academic.routes)', () => {
  const WRITES: [string, 'post' | 'put', string, unknown][] = [
    ['terms', 'post', '/api/academic/terms', { year: 2031, code: 'AUTHZ', name: 'Authz' }],
    ['time slots', 'post', '/api/academic/time-slots', { code: 'AZ1', label: 'Az', startTime: '08:00', endTime: '09:00' }],
    ['rooms', 'post', '/api/academic/rooms', { code: 'AZR', name: 'Room', capacity: 10 }],
    ['programs', 'post', '/api/academic/programs', { name: 'Authz Program' }],
    ['levels', 'post', '/api/academic/levels', { programId: PROGRAM, name: 'Authz Level', order: 1 }],
  ];

  it.each(WRITES)('owner may write %s', async (_label, verb, path, body) => {
    expect(deniedFor(await statusOf('asa_owner', verb, path, body))).toBe(false);
  });

  it.each(WRITES)('general manager may write %s', async (_label, verb, path, body) => {
    expect(deniedFor(await statusOf('asa_manager', verb, path, body))).toBe(false);
  });

  it.each(WRITES)('head of department may NOT write %s', async (_label, verb, path, body) => {
    expect(await statusOf('asa_hod', verb, path, body)).toBe(403);
  });

  it.each(WRITES)('registrar may NOT write %s', async (_label, verb, path, body) => {
    expect(await statusOf('asa_registrar', verb, path, body)).toBe(403);
  });

  it.each(WRITES)('teacher may NOT write %s', async (_label, verb, path, body) => {
    expect(await statusOf('asa_teacher', verb, path, body)).toBe(403);
  });

  it('deleting a program is owner-only', async () => {
    expect(await statusOf('asa_manager', 'post', '/api/academic/programs', { name: 'D' })).not.toBe(403);
    const res = await supertest(app).delete(`/api/academic/programs/${PROGRAM}`).set(auth('asa_manager'));
    expect(res.status).toBe(403);
  });
});

describe('Academic Setup — permission-gated authority (catalog.routes)', () => {
  const placementProfileBody = {
    enabled: true,
    requirementMode: 'required',
    maxScore: 100,
    passScore: 60,
    components: [{ key: 'g', type: 'custom_score', label: 'G', weight: 100, maxScore: 100 }],
  };

  // The documented asymmetry: the SAME panel lets a General Manager save a
  // placement policy (role-gated) but refuses a program version
  // (permission-gated, owner-only). Pinned so it cannot drift silently.
  it('general manager MAY configure the placement policy (role-gated route)', async () => {
    const status = await statusOf(
      'asa_manager', 'put', `/api/academic/program-versions/${VERSION}/placement-profile`, placementProfileBody
    );
    expect(deniedFor(status)).toBe(false);
  });

  it('general manager may NOT create a program version (AcademicSetup.Edit is owner-only)', async () => {
    expect(
      await statusOf('asa_manager', 'post', '/api/catalog/program-versions', { programId: PROGRAM, versionLabel: 'v-gm' })
    ).toBe(403);
  });

  it('owner may create a program version', async () => {
    const status = await statusOf('asa_owner', 'post', '/api/catalog/program-versions', {
      programId: PROGRAM,
      versionLabel: 'v-owner',
    });
    expect(deniedFor(status)).toBe(false);
  });

  it.each(['asa_hod', 'asa_registrar', 'asa_teacher', 'asa_student'])(
    '%s may not create a program version',
    async (userId) => {
      expect(
        await statusOf(userId, 'post', '/api/catalog/program-versions', { programId: PROGRAM, versionLabel: 'v-x' })
      ).toBe(403);
    }
  );

  // Class generation is reachable via `Class.Create` OR `AcademicSetup.Edit`
  // (requirePermission is OR), which is why a General Manager passes here but
  // not on program versions.
  it('general manager may reach class generation via Class.Create', async () => {
    const status = await statusOf('asa_manager', 'post', '/api/catalog/class-generation/preview', {
      programVersionId: VERSION,
    });
    expect(deniedFor(status)).toBe(false);
  });

  it.each(['asa_hod', 'asa_registrar', 'asa_teacher'])('%s may not reach class generation', async (userId) => {
    expect(
      await statusOf(userId, 'post', '/api/catalog/class-generation/preview', { programVersionId: VERSION })
    ).toBe(403);
  });
});

describe('Academic Setup — the permission catalog matches the enforced matrix', () => {
  function rolesHolding(code: string): string[] {
    return (
      db
        .prepare(
          `SELECT r.code FROM role_permissions rp
             JOIN permissions p ON p.id = rp.permission_id
             JOIN roles r ON r.id = rp.role_id
            WHERE p.code = ? ORDER BY r.code`
        )
        .all(code) as { code: string }[]
    ).map((r) => r.code);
  }

  it('AcademicSetup.Edit is owner-only (widening it is an explicit owner decision)', () => {
    expect(rolesHolding('AcademicSetup.Edit')).toEqual(['owner']);
  });

  it('AcademicSetup.View is held by the owner and the general manager', () => {
    expect(rolesHolding('AcademicSetup.View')).toEqual(['general_manager', 'owner']);
  });

  it('the student position holds no permissions at all', () => {
    const codes = (
      db
        .prepare(
          `SELECT p.code FROM role_permissions rp
             JOIN permissions p ON p.id = rp.permission_id
             JOIN roles r ON r.id = rp.role_id
            WHERE r.code = 'student'`
        )
        .all() as { code: string }[]
    ).map((r) => r.code);
    expect(codes).toEqual([]);
  });
});
