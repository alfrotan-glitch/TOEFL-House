/**
 * Teacher Contract × SKILL Forensic Audit — Regression Suite
 * ============================================================================
 * CORE BUSINESS RULE UNDER TEST
 * ----------------------------------------------------------------------------
 *   SKILL  ≠  CONTRACT TYPE
 *
 *   A Skill (row in `class_teacher_skills`) is the record of a teacher's
 *   actual teaching workload in a class. The contract type (`teachers.
 *   salary_type`) decides only HOW that teacher is PAID.
 *
 *   Therefore ALL FIVE contract types must be able to RECORD Skills.
 *   A fixed-contract teacher must never lose, skip, hide, or become
 *   ineligible for Skills.
 *
 * THE FIVE CONTRACT TYPES (discovered from the live migrated schema —
 * `teachers.salary_type` CHECK constraint, migration 029):
 *
 *   1. fixed        — fixed monthly salary; Skills recorded, do NOT add pay
 *   2. per_skill    — salary = Σ Skill rates
 *   3. per_session  — salary = completed sessions × session rate
 *   4. hybrid       — salary = fixed base + Σ Skill rates
 *   5. per_level    — salary = Σ level/skill-specific rates
 *
 * This suite is the executable proof for Phases 4, 5, 6, 7, 10, 11, 12, 13
 * and 16 of the Teacher subsystem forensic audit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { classTeacherSkillsRouter } from '../routes/skills.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  computeTeacherDueAmount,
  CONTRACT_TYPES,
  type TeacherSalaryModel,
} from '../core/payroll/class-payroll.js';

const BRANCH = 'tskill_branch';
const OTHER_BRANCH = 'tskill_branch_other';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/class-teacher-skills', classTeacherSkillsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(o: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: o.userId,
    username: o.username || o.userId,
    role: o.role || 'manager',
    branchId: o.branchId || BRANCH,
    fullName: o.fullName || 'Skill Audit User',
  };
}
function auth(u: TokenPayload) {
  return { Authorization: `Bearer ${signToken(u)}` };
}

let app: express.Express;
let manager: TokenPayload;
let otherManager: TokenPayload;
let registrar: TokenPayload;

/** The five contract types, discovered from the live schema, not assumed. */
const FIVE_CONTRACTS: TeacherSalaryModel[] = ['fixed', 'per_skill', 'per_session', 'hybrid', 'per_level'];

/** Creates a teacher directly (bypassing HTTP) for payroll-maths tests. */
function seedTeacher(id: string, salaryType: string, baseSalary: number, defaultSkillRate = 0, branch = BRANCH) {
  db.prepare(
    `INSERT OR REPLACE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate)
     VALUES (?, ?, ?, ?, 100, 'active', ?, '2026-01-01', ?)`
  ).run(id, `Teacher ${id}`, baseSalary, salaryType, branch, defaultSkillRate);
  db.prepare(
    `INSERT OR REPLACE INTO teacher_compensation_history (id, teacher_id, effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason)
     VALUES (?, ?, '2026-01-01', ?, ?, NULL, ?, 'seed')`
  ).run(`tch_${id}`, id, baseSalary, salaryType, defaultSkillRate);
  return db.prepare('SELECT * FROM teachers WHERE id = ?').get(id) as any;
}

function seedClass(id: string, level = 'A1', branch = BRANCH) {
  db.prepare(
    `INSERT OR REPLACE INTO classes (id, name, level, branch_id, status, lifecycle_stage, start_date, end_date)
     VALUES (?, ?, ?, ?, 'active', 'in_progress', '2026-01-01', '2026-12-31')`
  ).run(id, `Class ${id}`, level, branch);
  return id;
}

function seedSkill(id: string, name: string) {
  db.prepare('INSERT OR IGNORE INTO skills (id, name) VALUES (?, ?)').run(id, name);
  return id;
}

/** Records a Skill (workload assignment) directly in the source-of-truth table. */
function recordSkillRow(rowId: string, classId: string, teacherId: string, skillId: string, rate: number, branch = BRANCH) {
  db.prepare(
    `INSERT OR REPLACE INTO class_teacher_skills (id, class_id, teacher_id, skill_id, monthly_rate, branch_id, assignment_type)
     VALUES (?, ?, ?, ?, ?, ?, 'primary')`
  ).run(rowId, classId, teacherId, skillId, rate, branch);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Skill Branch', 'Loc');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(OTHER_BRANCH, 'Other Branch', 'Loc2');
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`
  ).run('u_skill_mgr', 'skill_mgr', 'Skill Mgr', BRANCH, pw);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`
  ).run('u_skill_mgr2', 'skill_mgr2', 'Other Mgr', OTHER_BRANCH, pw);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'registrar', ?, ?, 1, 0)`
  ).run('u_skill_reg', 'skill_reg', 'Skill Registrar', BRANCH, pw);
  syncLegacyUserRoles(db);
  manager = makeUser({ userId: 'u_skill_mgr', role: 'manager', branchId: BRANCH });
  otherManager = makeUser({ userId: 'u_skill_mgr2', role: 'manager', branchId: OTHER_BRANCH });
  registrar = makeUser({ userId: 'u_skill_reg', role: 'registrar', branchId: BRANCH });
  app = createApp();

  seedSkill('sk_read', 'Reading');
  seedSkill('sk_write', 'Writing');
  seedSkill('sk_listen', 'Listening');
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 2 — THE FIVE CONTRACT TYPES ARE DISCOVERED, NOT ASSUMED
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 2 — contract type discovery', () => {
  it('the live schema accepts EXACTLY the five discovered contract types', () => {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES ('disc_b','Disc','L')`).run();
    for (const st of FIVE_CONTRACTS) {
      expect(() =>
        db
          .prepare(
            `INSERT OR REPLACE INTO teachers (id,full_name,base_salary,salary_type,performance_score,status,branch_id,joined_date)
             VALUES (?,?,1000,?,0,'active','disc_b','2026-01-01')`
          )
          .run(`disc_${st}`, `D ${st}`, st)
      ).not.toThrow();
    }
    // Anything outside the five is rejected by the database itself.
    expect(() =>
      db
        .prepare(
          `INSERT INTO teachers (id,full_name,base_salary,salary_type,performance_score,status,branch_id,joined_date)
           VALUES ('disc_bad','Bad',1000,'not_a_contract',0,'active','disc_b','2026-01-01')`
        )
        .run()
    ).toThrow();
  });

  it('the application salary-type allowlist matches the database CHECK exactly', async () => {
    // Frontend/backend/database must agree on the contract vocabulary.
    expect([...CONTRACT_TYPES].sort()).toEqual([...FIVE_CONTRACTS].sort());

    // Every one of the five must be creatable through the HTTP API.
    for (const st of FIVE_CONTRACTS) {
      const res = await supertest(app)
        .post('/api/teachers')
        .set(auth(manager))
        .send({
          fullName: `API ${st}`,
          baseSalary: 30000,
          salaryType: st,
          defaultSkillRate: 1000,
          branchId: BRANCH,
          contractType: st === 'per_session' ? 'per_session' : 'monthly',
        });
      expect(res.status, `salaryType=${st} must be accepted by the API: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.salaryType).toBe(st);
    }
  });

  it('rejects a salary type that the database cannot store (no silent 500)', async () => {
    const res = await supertest(app)
      .post('/api/teachers')
      .set(auth(manager))
      .send({ fullName: 'Legacy Hybrid', baseSalary: 1000, salaryType: 'hybrid_skill', branchId: BRANCH });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 4 / 16 — ALL FIVE CONTRACT TYPES CAN RECORD SKILLS
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 4 — Skill recording is independent of contract type', () => {
  it.each(FIVE_CONTRACTS)('a %s-contract teacher CAN record a Skill', async (salaryType) => {
    const tid = `sk_rec_${salaryType}`;
    const cid = seedClass(`cls_rec_${salaryType}`);
    seedTeacher(tid, salaryType, 30000, 1000);

    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(manager))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 1000 });

    expect(
      res.status,
      `contract type "${salaryType}" must never block Skill recording (got ${res.status}: ${JSON.stringify(res.body)})`
    ).toBe(201);

    const stored = db
      .prepare('SELECT * FROM class_teacher_skills WHERE class_id = ? AND teacher_id = ?')
      .get(cid, tid) as any;
    expect(stored).toBeTruthy();
    expect(stored.skill_id).toBe('sk_read');
  });

  it('a fixed teacher records a Skill with rate 0 (workload without extra pay)', async () => {
    const tid = 'sk_fixed_zero';
    const cid = seedClass('cls_fixed_zero');
    seedTeacher(tid, 'fixed', 30000, 0);
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(manager))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = db.prepare('SELECT monthly_rate FROM class_teacher_skills WHERE id = ?').get(res.body.id) as any;
    expect(Number(row.monthly_rate)).toBe(0);
  });

  it('a Skill mutation is audit-logged', async () => {
    const tid = 'sk_audit_t';
    const cid = seedClass('cls_audit');
    seedTeacher(tid, 'fixed', 30000, 0);
    await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(manager))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_write', monthlyRate: 0 });
    const log = db
      .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE ?`)
      .get(`%${cid}%`) as { c: number };
    expect(log.c).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 5 / 9 — PAYROLL: SKILLS MUST NOT SILENTLY BECOME MONEY
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 6/9 — compensation rule per contract type', () => {
  it('FIXED: 30,000 salary + 15 Skills stays 30,000 (no multiplication)', () => {
    const tid = 'pay_fixed';
    seedTeacher(tid, 'fixed', 30000, 1000);
    const cid = seedClass('cls_pay_fixed');
    for (let i = 0; i < 15; i++) {
      // 15 distinct Skill records across 15 classes = real workload.
      const c = seedClass(`cls_pay_fixed_${i}`);
      recordSkillRow(`cts_fixed_${i}`, c, tid, 'sk_read', 1000);
    }
    void cid;
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');

    expect(r.model).toBe('fixed');
    expect(r.due).toBe(30000); // NOT 30000 + 15*1000
    expect(r.skillsTotal).toBe(0); // Skills contribute no money on a fixed contract
    // …but the workload is still visible.
    expect(r.skillCount).toBe(15);
  });

  it.each([0, 1, 15, 20])('FIXED with %i Skills always pays exactly the fixed salary', (n) => {
    const tid = `pay_fixed_n${n}`;
    seedTeacher(tid, 'fixed', 30000, 1000);
    for (let i = 0; i < n; i++) {
      const c = seedClass(`cls_fx_${n}_${i}`);
      recordSkillRow(`cts_fx_${n}_${i}`, c, tid, 'sk_read', 1000);
    }
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');
    expect(r.due).toBe(30000);
    expect(r.skillCount).toBe(n);
  });

  it.each([0, 1, 15, 20])('PER_SKILL with %i Skills pays Σ skill rates', (n) => {
    const tid = `pay_ps_n${n}`;
    seedTeacher(tid, 'per_skill', 0, 1000);
    for (let i = 0; i < n; i++) {
      const c = seedClass(`cls_ps_${n}_${i}`);
      recordSkillRow(`cts_ps_${n}_${i}`, c, tid, 'sk_read', 1000);
    }
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');
    expect(r.due).toBe(n * 1000);
    expect(r.skillsTotal).toBe(n * 1000);
    expect(r.skillCount).toBe(n);
  });

  it.each([0, 1, 15, 20])('HYBRID with %i Skills pays fixed base PLUS Σ skill rates, separately visible', (n) => {
    const tid = `pay_hy_n${n}`;
    seedTeacher(tid, 'hybrid', 30000, 1000);
    for (let i = 0; i < n; i++) {
      const c = seedClass(`cls_hy_${n}_${i}`);
      recordSkillRow(`cts_hy_${n}_${i}`, c, tid, 'sk_read', 1000);
    }
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');
    expect(r.model).toBe('hybrid');
    expect(r.base).toBe(30000); // fixed component
    expect(r.skillsTotal).toBe(n * 1000); // skill component
    expect(r.due).toBe(30000 + n * 1000);
  });

  it('PER_LEVEL uses the configured level/skill rate', () => {
    const tid = 'pay_pl';
    seedTeacher(tid, 'per_level', 0, 0);
    const c = seedClass('cls_pl', 'B1');
    recordSkillRow('cts_pl', c, tid, 'sk_write', 0);
    db.prepare(
      `INSERT OR REPLACE INTO teacher_level_skill_rates (id, teacher_id, level_code, skill_id, rate_per_skill, branch_id)
       VALUES ('tlr_pl', ?, 'B1', 'sk_write', 2500, ?)`
    ).run(tid, BRANCH);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');
    expect(r.due).toBe(2500);
    expect(r.skillCount).toBe(1);
  });

  it('PER_SESSION pays per completed session and still reports Skill workload', () => {
    const tid = 'pay_pses';
    seedTeacher(tid, 'per_session', 0, 500);
    const c = seedClass('cls_pses');
    recordSkillRow('cts_pses', c, tid, 'sk_read', 0);
    db.prepare(
      `INSERT OR REPLACE INTO sessions (id,class_id,date,start_time,end_time,status,session_type,teacher_id,branch_id,skill_id)
       VALUES ('ses_p1',?,'2026-03-04','09:00','10:00','completed','regular',?,?,'sk_read'),
              ('ses_p2',?,'2026-03-11','09:00','10:00','completed','regular',?,?,'sk_read')`
    ).run(c, tid, BRANCH, c, tid, BRANCH);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const r = computeTeacherDueAmount(db, teacher, '2026-03');
    expect(r.due).toBe(1000); // 2 sessions × 500
    expect(r.skillCount).toBe(1); // workload still recorded and visible
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 10 — REPORTING: SKILLS ARE NEVER HIDDEN BY CONTRACT TYPE
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 10 — reporting surfaces Skills for every contract type', () => {
  it.each(FIVE_CONTRACTS)('computed-salary reports the Skill count for a %s teacher', async (salaryType) => {
    const tid = `rep_${salaryType}`;
    seedTeacher(tid, salaryType, 30000, 1000);
    const c = seedClass(`cls_rep_${salaryType}`);
    recordSkillRow(`cts_rep_${salaryType}`, c, tid, 'sk_read', 1000);

    const res = await supertest(app).get(`/api/teachers/${tid}/computed-salary?month=2026-03`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.skillCount, `Skills must be visible for ${salaryType}`).toBe(1);
    expect(res.body.model).toBe(salaryType);
    // Fixed component and skill component are separately identifiable.
    expect(res.body).toHaveProperty('base');
    expect(res.body).toHaveProperty('skillsTotal');
  });

  it('a fixed teacher report separates fixed salary from Skill workload', async () => {
    const tid = 'rep_sep';
    seedTeacher(tid, 'fixed', 30000, 0);
    for (let i = 0; i < 3; i++) {
      const c = seedClass(`cls_rep_sep_${i}`);
      recordSkillRow(`cts_rep_sep_${i}`, c, tid, 'sk_read', 0);
    }
    const res = await supertest(app).get(`/api/teachers/${tid}/computed-salary?month=2026-03`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.due).toBe(30000);
    expect(res.body.skillsTotal).toBe(0);
    expect(res.body.skillCount).toBe(3); // workload visible, pay unaffected
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 7 — TARGET SKILLS (workload target, must not change fixed salary)
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 7 — configurable monthly Skill target', () => {
  it('exposes target / actual / shortfall / excess without altering pay', async () => {
    const tid = 'target_t';
    seedTeacher(tid, 'fixed', 30000, 0);
    // Target is configuration data, not a hard-coded 30,000 → 15 rule.
    db.prepare('UPDATE teachers SET target_skills_per_month = 15 WHERE id = ?').run(tid);
    for (let i = 0; i < 12; i++) {
      const c = seedClass(`cls_tg_${i}`);
      recordSkillRow(`cts_tg_${i}`, c, tid, 'sk_read', 0);
    }
    const res = await supertest(app).get(`/api/teachers/${tid}/computed-salary?month=2026-03`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.targetSkills).toBe(15);
    expect(res.body.skillCount).toBe(12);
    expect(res.body.shortfall).toBe(3);
    expect(res.body.excess).toBe(0);
    expect(res.body.due).toBe(30000); // shortfall must NOT dock a fixed salary
  });

  it('reports excess when actual Skills exceed the target', async () => {
    const tid = 'target_x';
    seedTeacher(tid, 'fixed', 30000, 0);
    db.prepare('UPDATE teachers SET target_skills_per_month = 10 WHERE id = ?').run(tid);
    for (let i = 0; i < 13; i++) {
      const c = seedClass(`cls_tx_${i}`);
      recordSkillRow(`cts_tx_${i}`, c, tid, 'sk_read', 0);
    }
    const res = await supertest(app).get(`/api/teachers/${tid}/computed-salary?month=2026-03`).set(auth(manager));
    expect(res.body.shortfall).toBe(0);
    expect(res.body.excess).toBe(3);
    expect(res.body.due).toBe(30000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 11 — SECURITY / RBAC / BRANCH ISOLATION
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 11 — Skill security', () => {
  it('a registrar cannot create a Skill', async () => {
    const tid = 'sec_t';
    const cid = seedClass('cls_sec');
    seedTeacher(tid, 'fixed', 30000, 0);
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(registrar))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 0 });
    expect(res.status).toBe(403);
  });

  it('a Skill cannot cross branches', async () => {
    const tid = 'sec_cross_t';
    const cid = seedClass('cls_sec_cross');
    seedTeacher(tid, 'fixed', 30000, 0);
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(otherManager))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 0 });
    expect(res.status).toBe(403);
  });

  it('an inactive teacher cannot receive a new Skill', async () => {
    const tid = 'sec_inactive';
    const cid = seedClass('cls_sec_inactive');
    seedTeacher(tid, 'fixed', 30000, 0);
    db.prepare(`UPDATE teachers SET status = 'inactive' WHERE id = ?`).run(tid);
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set(auth(manager))
      .send({ classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 0 });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 13 — DUPLICATION / CONCURRENCY
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 13 — duplicate protection', () => {
  it('the same teaching activity cannot generate two Skills (double-click)', async () => {
    const tid = 'dup_t';
    const cid = seedClass('cls_dup');
    seedTeacher(tid, 'per_skill', 0, 1000);
    const body = { classId: cid, teacherId: tid, skillId: 'sk_read', monthlyRate: 1000 };
    const first = await supertest(app).post('/api/class-teacher-skills').set(auth(manager)).send(body);
    const second = await supertest(app).post('/api/class-teacher-skills').set(auth(manager)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM class_teacher_skills WHERE class_id = ? AND teacher_id = ? AND skill_id = ?')
      .get(cid, tid, 'sk_read') as { c: number };
    expect(count.c).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 12 — PERIOD CORRECTNESS AND HISTORY IMMUTABILITY
// ══════════════════════════════════════════════════════════════════════════
describe('Phase 12 — historical integrity', () => {
  it('changing the contract type in a later month does NOT delete historical Skills', async () => {
    const tid = 'hist_t';
    const cid = seedClass('cls_hist');
    seedTeacher(tid, 'per_skill', 0, 1000);
    recordSkillRow('cts_hist', cid, tid, 'sk_read', 1000);

    const before = db.prepare('SELECT COUNT(*) AS c FROM class_teacher_skills WHERE teacher_id = ?').get(tid) as { c: number };

    const res = await supertest(app)
      .put(`/api/teachers/${tid}`)
      .set(auth(manager))
      .send({ salaryType: 'fixed', baseSalary: 30000, effectiveFrom: '2026-09-01', compensationReason: 'switch to fixed' });
    expect(res.status).toBe(200);

    const after = db.prepare('SELECT COUNT(*) AS c FROM class_teacher_skills WHERE teacher_id = ?').get(tid) as { c: number };
    expect(after.c).toBe(before.c); // Skills survive a contract change
  });

  it('payroll for an earlier period uses the contract in force THEN, not the current one', () => {
    const tid = 'hist_period';
    seedTeacher(tid, 'per_skill', 0, 1000); // effective 2026-01-01
    const c = seedClass('cls_hist_period');
    recordSkillRow('cts_hist_period', c, tid, 'sk_read', 1000);
    // A later switch to fixed, effective September.
    db.prepare(
      `INSERT OR REPLACE INTO teacher_compensation_history (id, teacher_id, effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason)
       VALUES ('tch_hist_period_2', ?, '2026-09-01', 30000, 'fixed', NULL, 0, 'switch')`
    ).run(tid);
    db.prepare(`UPDATE teachers SET salary_type='fixed', base_salary=30000 WHERE id = ?`).run(tid);

    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    const august = computeTeacherDueAmount(db, teacher, '2026-08');
    const september = computeTeacherDueAmount(db, teacher, '2026-09');

    expect(august.model).toBe('per_skill'); // history respected
    expect(august.due).toBe(1000);
    expect(september.model).toBe('fixed');
    expect(september.due).toBe(30000);
  });

  it('a Skill recorded for August does not leak into July payroll', () => {
    const tid = 'period_t';
    seedTeacher(tid, 'per_skill', 0, 1000);
    const c = seedClass('cls_period');
    db.prepare(
      `INSERT OR REPLACE INTO class_teacher_skills (id, class_id, teacher_id, skill_id, monthly_rate, branch_id, assignment_type, start_date)
       VALUES ('cts_period', ?, ?, 'sk_read', 1000, ?, 'primary', '2026-08-01')`
    ).run(c, tid, BRANCH);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tid) as any;
    expect(computeTeacherDueAmount(db, teacher, '2026-07').due).toBe(0);
    expect(computeTeacherDueAmount(db, teacher, '2026-08').due).toBe(1000);
  });
});
