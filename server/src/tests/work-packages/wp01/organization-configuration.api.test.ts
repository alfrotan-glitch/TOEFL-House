import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import { branchesRouter, partnersRouter } from '../../../routes/branches.routes.js';
import { academicRouter } from '../../../routes/academic.routes.js';
import { catalogRouter } from '../../../routes/catalog.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const CAMPUS = 'wp01_api_campus';
const BRANCH_A = 'wp01_api_branch_a';
const BRANCH_B = 'wp01_api_branch_b';
const PROGRAM_A = 'wp01_api_program_a';
const PROGRAM_B = 'wp01_api_program_b';
const VERSION_A = 'wp01_api_version_a';
const VERSION_B = 'wp01_api_version_b';
const LEVEL_A = 'wp01_api_level_a';
const LEVEL_B = 'wp01_api_level_b';
const SUBJECT_A = 'wp01_api_subject_a';
const TERM_A = 'wp01_api_term_a';
const OWNER = 'wp01_api_owner';
const MANAGER_A = 'wp01_api_manager_a';
const CAMPUS_MANAGER = 'wp01_api_campus_manager';

const PROFILE_FEE_FIELDS = ['placementTestFee', 'registrationFee', 'cardFee', 'diplomaFee'] as const;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/branches', branchesRouter);
  app.use('/api/partners', partnersRouter);
  app.use('/api/academic', academicRouter);
  app.use('/api/catalog', catalogRouter);
  app.use(errorHandler);
  return app;
}

let http: ReturnType<typeof supertest>;
let provisionedBranchId = '';
const as = (userId: string) => bearerFor(userId);

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(
    `INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active)
     VALUES (?, 'org_toefl_house', 'WP-01 API Campus', 'WP01-API', 1)`,
  ).run(CAMPUS);
  for (const id of [BRANCH_A, BRANCH_B]) {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, campus_id, name, code, location, is_active)
       VALUES (?, ?, ?, ?, 'Kabul', 1)`,
    ).run(id, CAMPUS, id, `CODE-${id}`);
  }
  for (const [program, version, level, branch] of [
    [PROGRAM_A, VERSION_A, LEVEL_A, BRANCH_A],
    [PROGRAM_B, VERSION_B, LEVEL_B, BRANCH_B],
  ]) {
    db.prepare('INSERT OR IGNORE INTO programs (id, name, branch_id) VALUES (?, ?, ?)').run(program, program, branch);
    db.prepare(
      `INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status)
       VALUES (?, ?, 'v1', 1, 'draft')`,
    ).run(version, program);
    db.prepare(
      `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, "order", default_fee)
       VALUES (?, ?, ?, ?, 1, 1000)`,
    ).run(level, program, version, level);
  }
  db.prepare(
    `INSERT OR IGNORE INTO subjects
       (id, program_version_id, level_id, code, name)
     VALUES (?, ?, ?, 'WP01-SUBJECT', 'WP-01 Subject')`,
  ).run(SUBJECT_A, VERSION_A, LEVEL_A);
  db.prepare(
    `INSERT OR IGNORE INTO academic_terms
       (id, branch_id, year, code, name, start_date, end_date)
     VALUES (?, ?, 2031, 'WP01', 'Original term', '2031-01-01', '2031-03-31')`,
  ).run(TERM_A, BRANCH_A);

  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH_A });
  seedUser({ id: MANAGER_A, role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: CAMPUS_MANAGER, role: 'general_manager', branchId: BRANCH_A, scopeType: 'campus', scopeId: CAMPUS });

  for (const [id, table, branch] of [
    ['wp01_api_promo_branch', 'promotion_rules', BRANCH_A],
    ['wp01_api_promo_global', 'promotion_rules', null],
    ['wp01_api_place_branch', 'placement_rules', BRANCH_A],
    ['wp01_api_place_global', 'placement_rules', null],
  ] as const) {
    if (table === 'promotion_rules') {
      db.prepare(
        `INSERT OR REPLACE INTO promotion_rules
           (id, program_version_id, name, min_score, min_attendance_pct, branch_id)
         VALUES (?, ?, ?, 60, 75, ?)`,
      ).run(id, VERSION_A, id, branch);
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO placement_rules
           (id, program_version_id, name, min_score, max_score, branch_id)
         VALUES (?, ?, ?, 0, 20, ?)`,
      ).run(id, VERSION_A, id, branch);
    }
  }

  http = supertest(makeApp());
});

describe('WP-01 branch provisioning is all-or-nothing', () => {
  it('rolls back the branch when its finance account cannot be provisioned', async () => {
    db.exec(`CREATE TEMP TRIGGER wp01_abort_branch_account BEFORE INSERT ON finance_accounts
             WHEN NEW.scope_type = 'branch' AND
                  EXISTS (SELECT 1 FROM branches WHERE id = NEW.scope_id AND code = 'WP01-ROLLBACK')
             BEGIN SELECT RAISE(ABORT, 'account failed'); END;`);
    try {
      const response = await http.post('/api/branches').set(as(CAMPUS_MANAGER)).send({
        name: 'Must Roll Back', code: 'WP01-ROLLBACK', campusId: CAMPUS, address: 'Kabul',
      });
      expect(response.status).toBe(500);
      expect(db.prepare("SELECT id FROM branches WHERE code = 'WP01-ROLLBACK'").get()).toBeUndefined();
    } finally {
      db.exec('DROP TRIGGER wp01_abort_branch_account');
    }
  });

  it('provisions a successful branch with its account and two payroll envelopes', async () => {
    const response = await http.post('/api/branches').set(as(CAMPUS_MANAGER)).send({
      name: 'Operational Branch', code: 'WP01-LIVE', campusId: CAMPUS, address: 'Kabul',
    });
    expect(response.status).toBe(201);
    provisionedBranchId = response.body.id;
    expect(db.prepare("SELECT id FROM finance_accounts WHERE scope_type = 'branch' AND scope_id = ?").get(provisionedBranchId)).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND payroll_target IS NOT NULL').get(provisionedBranchId) as { c: number }).c).toBe(2);
  });

  it('blocks deletion of branch cash but removes empty provisioning with the branch', async () => {
    db.prepare("UPDATE finance_accounts SET main_balance = 1 WHERE scope_type = 'branch' AND scope_id = ?")
      .run(provisionedBranchId);
    const blocked = await http.delete(`/api/branches/${provisionedBranchId}?permanent=true`).set(as(OWNER));
    expect(blocked.status).toBe(409);
    expect(db.prepare('SELECT id FROM branches WHERE id = ?').get(provisionedBranchId)).toBeTruthy();

    db.prepare("UPDATE finance_accounts SET main_balance = 0, saving_balance = 1 WHERE scope_type = 'branch' AND scope_id = ?")
      .run(provisionedBranchId);
    const savingBlocked = await http.delete(`/api/branches/${provisionedBranchId}?permanent=true`).set(as(OWNER));
    expect(savingBlocked.status).toBe(409);

    db.prepare("UPDATE finance_accounts SET saving_balance = 0 WHERE scope_type = 'branch' AND scope_id = ?")
      .run(provisionedBranchId);
    db.prepare('UPDATE budget_lines SET current_amount = 1 WHERE branch_id = ?').run(provisionedBranchId);
    const envelopeBlocked = await http.delete(`/api/branches/${provisionedBranchId}?permanent=true`).set(as(OWNER));
    expect(envelopeBlocked.status).toBe(409);

    db.prepare('UPDATE budget_lines SET current_amount = 0 WHERE branch_id = ?').run(provisionedBranchId);
    const removed = await http.delete(`/api/branches/${provisionedBranchId}?permanent=true`).set(as(OWNER));
    expect(removed.status).toBe(200);
    expect(db.prepare('SELECT id FROM branches WHERE id = ?').get(provisionedBranchId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM finance_accounts WHERE scope_type = 'branch' AND scope_id = ?").get(provisionedBranchId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM budget_lines WHERE branch_id = ?').get(provisionedBranchId)).toBeUndefined();
  });
});

describe('WP-01 academic configuration contracts', () => {
  it('returns only selected-branch programs and levels in branch-config', async () => {
    const response = await http.get(`/api/academic/branch-config?branchId=${BRANCH_A}`).set(as(CAMPUS_MANAGER));
    expect(response.status).toBe(200);
    expect(response.body.programs.map((row: any) => row.id)).toContain(PROGRAM_A);
    expect(response.body.programs.map((row: any) => row.id)).not.toContain(PROGRAM_B);
    expect(response.body.levels.map((row: any) => row.id)).toContain(LEVEL_A);
    expect(response.body.levels.map((row: any) => row.id)).not.toContain(LEVEL_B);
  });

  it('rejects an all-branches selector for the singular branch-config snapshot', async () => {
    const response = await http.get('/api/academic/branch-config?branchId=all').set(as(OWNER));
    expect(response.status).toBe(400);
  });

  it('preserves stored term dates when an edit form sends empty date strings', async () => {
    const response = await http.put(`/api/academic/terms/${TERM_A}`).set(as(MANAGER_A)).send({
      name: 'Renamed term', startDate: '', endDate: '',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'Renamed term', startDate: '2031-01-01', endDate: '2031-03-31',
    });
  });

  it.each([
    [{ startDate: '2031-04-01', endDate: '2031-03-01' }, 'reversed'],
    [{ startDate: 'not-a-date' }, 'malformed'],
  ])('rejects %s term dates without changing persisted dates', async (payload, _label) => {
    const response = await http.put(`/api/academic/terms/${TERM_A}`).set(as(MANAGER_A)).send(payload);
    expect(response.status).toBe(400);
    expect(db.prepare('SELECT start_date, end_date FROM academic_terms WHERE id = ?').get(TERM_A))
      .toEqual({ start_date: '2031-01-01', end_date: '2031-03-31' });
  });

  it.each([
    ['negative number', -1],
    ['fractional AFN', 0.001],
    ['unsafe magnitude', 1e20],
    ['non-numeric text', 'abc'],
    ['empty text', ''],
    ['whitespace text', '   '],
    ['boolean true', true],
    ['boolean false', false],
    ['empty array', []],
    ['numeric array', [1]],
    ['object', {}],
    ['hex text', '0x10'],
    ['exponent text', '1e3'],
  ] as const)('rejects every invalid authoritative profile fee shape: %s', async (_label, fee) => {
    for (const field of PROFILE_FEE_FIELDS) {
      const before = db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?').get(BRANCH_A);
      const response = await http.put(`/api/catalog/branch-profile/${BRANCH_A}`).set(as(OWNER))
        .send({ [field]: fee });
      expect(response.status, field).toBe(400);
      expect(db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?').get(BRANCH_A)).toEqual(before);
    }
  });

  it('supports partial branch-profile updates without erasing prior values', async () => {
    const first = await http.put(`/api/catalog/branch-profile/${BRANCH_A}`).set(as(OWNER)).send({
      registrationFee: 1500, defaultPassMark: 70,
    });
    expect(first.status).toBe(200);
    const second = await http.put(`/api/catalog/branch-profile/${BRANCH_A}`).set(as(OWNER)).send({ notes: 'kept' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ registration_fee: 1500, default_pass_mark: 70, notes: 'kept' });
  });

  it('rejects a default program version from another branch', async () => {
    const response = await http.put(`/api/catalog/branch-profile/${BRANCH_A}`).set(as(OWNER))
      .send({ defaultProgramVersionId: VERSION_B });
    expect(response.status).toBe(400);
  });

  it('changing current fee configuration never rewrites historical money', async () => {
    db.prepare(
      `INSERT OR REPLACE INTO financial_transactions
         (id, type, category, amount, date, description, branch_id)
       VALUES ('wp01_api_historical_money', 'income', 'fee', 4321, '2031-01-01', 'Historical', ?)`,
    ).run(BRANCH_A);
    const before = db.prepare("SELECT amount, description FROM financial_transactions WHERE id = 'wp01_api_historical_money'").get();
    const response = await http.put(`/api/catalog/branch-profile/${BRANCH_A}`).set(as(OWNER))
      .send({ registrationFee: 2500 });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT amount, description FROM financial_transactions WHERE id = 'wp01_api_historical_money'").get()).toEqual(before);
  });

  it('fails closed when legacy fee-rule storage contains non-canonical money', async () => {
    db.prepare(
      `INSERT INTO fee_rules
         (id, program_version_id, level_id, branch_id, fee_type, name, amount)
       VALUES ('wp01_api_corrupt_fee_rule', ?, ?, ?, 'registration', 'Corrupt fee', 0.5)`,
    ).run(VERSION_A, LEVEL_A, BRANCH_A);
    try {
      const response = await http.post('/api/catalog/fees/snapshot').set(as(OWNER)).send({
        programVersionId: VERSION_A, levelId: LEVEL_A, branchId: BRANCH_A,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/stored registration fee|whole number/i);
    } finally {
      db.prepare("DELETE FROM fee_rules WHERE id = 'wp01_api_corrupt_fee_rule'").run();
    }
  });
});

describe('WP-01 catalog scalar boundaries fail as client errors', () => {
  it.each([
    ['version description', 'post', '/api/catalog/program-versions', {
      programId: PROGRAM_A, versionLabel: 'Invalid description', description: { nested: true },
    }],
    ['subject hours', 'post', '/api/catalog/subjects', {
      programVersionId: VERSION_A, levelId: LEVEL_A, code: 'BAD-HOURS', name: 'Bad hours', hours: 1.5,
    }],
    ['module assessment type', 'post', '/api/catalog/modules', {
      subjectId: SUBJECT_A, code: 'BAD-ASSESSMENT', name: 'Bad assessment', assessmentType: { nested: true },
    }],
    ['promotion boolean', 'post', '/api/catalog/promotion-rules', {
      programVersionId: VERSION_A, name: 'Bad Boolean', requireAllSubjects: 'false',
    }],
    ['placement sort order', 'post', '/api/catalog/placement-rules', {
      programVersionId: VERSION_A, name: 'Bad Sort', minScore: 21, maxScore: 40, sortOrder: 1.5,
    }],
    ['promotion evaluation score', 'post', '/api/catalog/promotion/evaluate', {
      programVersionId: VERSION_A, fromLevelId: LEVEL_A, score: true, attendancePct: 90, branchId: BRANCH_A,
    }],
    ['branch profile notes', 'put', `/api/catalog/branch-profile/${BRANCH_A}`, {
      notes: { nested: true },
    }],
  ] as const)('rejects malformed %s input', async (_label, method, path, payload) => {
    const response = await (http as any)[method](path).set(as(OWNER)).send(payload);
    expect(response.status).toBe(400);
  });
});

describe('WP-01 catalog evaluation relationships and deletion controls', () => {
  it.each([
    ['/api/catalog/placement/recommend', { programVersionId: VERSION_B, totalScore: 10, branchId: BRANCH_A }],
    ['/api/catalog/promotion/evaluate', { programVersionId: VERSION_B, fromLevelId: LEVEL_B, score: 80, attendancePct: 90, branchId: BRANCH_A }],
    ['/api/catalog/fees/snapshot', { programVersionId: VERSION_B, levelId: LEVEL_B, branchId: BRANCH_A }],
  ])('rejects cross-branch relationship input at %s', async (path, payload) => {
    const response = await http.post(path).set(as(MANAGER_A)).send(payload);
    expect(response.status).toBe(403);
  });

  it.each([
    ['promotion-rules', 'wp01_api_promo_branch'],
    ['placement-rules', 'wp01_api_place_branch'],
  ])('lets a scoped manager delete an authorized branch %s record', async (route, id) => {
    expect((await http.delete(`/api/catalog/${route}/${id}`).set(as(MANAGER_A))).status).toBe(200);
  });

  it.each([
    ['promotion-rules', 'wp01_api_promo_global'],
    ['placement-rules', 'wp01_api_place_global'],
  ])('protects global %s deletion from scoped users and permits the global owner', async (route, id) => {
    expect((await http.delete(`/api/catalog/${route}/${id}`).set(as(MANAGER_A))).status).toBe(403);
    expect((await http.delete(`/api/catalog/${route}/${id}`).set(as(OWNER))).status).toBe(200);
  });
});

describe('WP-01 partner API validation mirrors the database authority', () => {
  it.each([
    [{ fullName: '  ', sharePercent: 1 }, 'blank name'],
    [{ fullName: 'Invalid', sharePercent: -1 }, 'negative share'],
    [{ fullName: 'Invalid', sharePercent: 101 }, 'oversized share'],
    [{ fullName: 'Invalid', sharePercent: 'not-a-number' }, 'non-numeric share'],
  ])('rejects %s', async (payload, _label) => {
    expect((await http.post('/api/partners').set(as(OWNER)).send(payload)).status).toBe(400);
  });
});
