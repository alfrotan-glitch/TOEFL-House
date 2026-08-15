/**
 * Teacher Skill × Contract-Type forensic regression matrix.
 * ============================================================================
 * Core rule: SKILL ≠ CONTRACT TYPE. All five contract types
 * (fixed | per_skill | per_session | hybrid | per_level) can record skills;
 * contract type only determines how payroll uses them.
 *
 * Matrix coverage:
 *   Contract | Skill Creation | Skill Reporting | Payroll | Fixed Component | Skill Component
 *   fixed    | TEST           | TEST             | TEST    | TEST             | TEST (0)
 *   per_skill| TEST           | TEST             | TEST    | —                | TEST
 *   per_session| TEST         | TEST             | TEST    | —                | TEST (sessions)
 *   hybrid   | TEST           | TEST             | TEST    | TEST             | TEST
 *   per_level| TEST           | TEST             | TEST    | —                | TEST (level rate)
 *
 * Plus: fixed+0/1/target/excess, per_skill+0/1/target/excess, hybrid+0/1/
 * target/excess, period correctness, branch isolation, RBAC, duplication,
 * report endpoint, salary-type API round-trip.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { classTeacherSkillsRouter, skillsRouter } from '../routes/skills.routes.js';
import teachersRouter from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { computeTeacherDueAmount, toPeriodKey } from '../core/payroll/class-payroll.js';

const BRANCH = 'tsc_branch';
const BRANCH_B = 'tsc_branch_b';
const PROGRAM = 'tsc_program';
const VERSION = 'tsc_version';
const LEVEL = 'tsc_level';
const MANAGER = 'tsc_manager';
const MANAGER_B = 'tsc_manager_b';
const REGISTRAR = 'tsc_registrar';

const FIVE_TYPES = ['fixed', 'per_skill', 'per_session', 'hybrid', 'per_level'];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/class-teacher-skills', classTeacherSkillsRouter);
  app.use(errorHandler);
  return app;
}
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

describe('Teacher skill × contract-type forensic matrix', () => {
  let app: express.Express;
  let manager: TokenPayload;
  let managerB: TokenPayload;
  let registrar: TokenPayload;
  const classes = new Map<string, string>(); // teacherId -> classId

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'T A', 'T');
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH_B, 'T B', 'T');
    for (const [u, role, b] of [[MANAGER, 'manager', BRANCH], [MANAGER_B, 'manager', BRANCH_B], [REGISTRAR, 'registrar', BRANCH]] as const) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(u, u, `User ${u}`, role, b, await hashPassword('testpass123'));
    }
    syncLegacyUserRoles(db);
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`).run(PROGRAM, 'T P', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 1, ?, 'B1', 1)`).run(LEVEL, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO skills (id, name) VALUES ('tsc_skill', 'Grammar')`).run();
    db.prepare(`INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, cost_type, is_marketing, branch_id, purpose) VALUES ('tsc_bl', 'Teacher Salaries', 5000000, 5000000, 'variable', 0, ?, 'teacher_salary')`).run(BRANCH);
    manager = { userId: MANAGER, username: MANAGER, role: 'manager', branchId: BRANCH, fullName: 'M' };
    managerB = { userId: MANAGER_B, username: MANAGER_B, role: 'manager', branchId: BRANCH_B, fullName: 'MB' };
    registrar = { userId: REGISTRAR, username: REGISTRAR, role: 'registrar', branchId: BRANCH, fullName: 'R' };
    app = createApp();
  });

  function seedTeacher(id: string, salaryType: string, base = 30000, rate = 0, target: number | null = null) {
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate, target_skills_per_month) VALUES (?, ?, ?, ?, 100, 'active', ?, ?, ?, ?)`)
      .run(id, `Teacher ${id}`, base, salaryType, BRANCH, today(), rate, target);
  }

  function seedClassFor(teacherId: string, classId: string) {
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, program_id, level_id, level, status, teacher_id, start_date, end_date, capacity, gender_policy, lifecycle_stage) VALUES (?, ?, ?, ?, ?, 'B1', 'active', ?, ?, ?, 20, 'mixed', 'activated')`)
      .run(classId, `Class ${classId}`, BRANCH, PROGRAM, LEVEL, teacherId, today(), null);
    classes.set(teacherId, classId);
  }

  async function assignSkill(teacherId: string, classId: string, rate: number, type = 'primary') {
    return supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId, skillId: 'tsc_skill', monthlyRate: rate, assignmentType: type,
    });
  }
  /** Assign N skills to a teacher using one class per skill (respects the
   *  max-3-distinct-skills-per-class cap and the UNIQUE assignment constraint). */
  async function assignSkillsN(teacherId: string, n: number, rate: number) {
    for (let i = 0; i < n; i++) {
      const cls = `tsc_ncls_${teacherId}_${i}`;
      db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, program_id, level_id, level, status, teacher_id, start_date, end_date, capacity, gender_policy, lifecycle_stage) VALUES (?, ?, ?, ?, ?, 'B1', 'active', ?, ?, ?, 20, 'mixed', 'activated')`)
        .run(cls, `C ${cls}`, BRANCH, PROGRAM, LEVEL, teacherId, today(), null);
      const res = await assignSkill(teacherId, cls, rate);
      expect(res.status).toBe(201);
    }
  }

  // ── All five contract types can record skills (core rule) ────────────────
  it('ALL FIVE contract types can be created via the API and can receive skills', async () => {
    for (const type of FIVE_TYPES) {
      const create = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
        fullName: `T-${type}`, phone: `0700000${FIVE_TYPES.indexOf(type)}`, baseSalary: 30000, salaryType: type,
        branchId: BRANCH, joinedDate: today(), defaultSkillRate: 1500, targetSkillsPerMonth: 15,
      });
      expect(create.status).toBe(201);
      expect(create.body.salaryType).toBe(type);
      expect(create.body.targetSkillsPerMonth).toBe(15);
      const teacherId = create.body.id;
      seedClassFor(teacherId, `tsc_cls_${type}`);
      const assign = await assignSkill(teacherId, `tsc_cls_${type}`, type === 'fixed' ? 0 : 1500);
      if (assign.status !== 201) console.log(`[EVIDENCE-${type}]`, assign.status, JSON.stringify(assign.body));
      expect(assign.status).toBe(201); // Skill recording is contract-type-independent
      // computed-salary reports the skill + workload target
      const cs = await supertest(app).get(`/api/teachers/${teacherId}/computed-salary`).set(authHeader(manager));
      expect(cs.status).toBe(200);
      expect(cs.body.skillCount).toBeGreaterThanOrEqual(1);
      expect(cs.body.targetSkills).toBe(15);
      expect(cs.body.contractType).toBe(type);
    }
  });

  // ── E/F: Fixed + 0/1/15/20 skills — salary stays fixed, skills counted ──
  it('fixed + 0/1/15/20 skills: due stays 30,000; skills are workload only', async () => {
    for (const [n, expectedDue] of [[0, 30000], [1, 30000], [15, 30000], [20, 30000]] as const) {
      const id = `tsc_fixed_${n}`;
      seedTeacher(id, 'fixed', 30000, 0, 15);
      seedClassFor(id, `tsc_fcls_${n}`);
      await assignSkillsN(id, n, 0);
      const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
      const due = computeTeacherDueAmount(db, teacher);
      expect(due.model).toBe('fixed');
      expect(due.due).toBe(expectedDue);
      expect(due.skillsTotal).toBe(0);
      expect(due.base).toBe(30000);
      const count = (db.prepare(`SELECT COUNT(*) c FROM class_teacher_skills WHERE teacher_id=?`).get(id) as any).c;
      expect(count).toBe(n);
    }
  });

  // ── G: per_skill + 0/1/15/20 skills — salary = count × rate ─────────────
  it('per_skill + 0/1/15/20 skills: due = skills × rate', async () => {
    for (const [n, expectedDue] of [[0, 0], [1, 1500], [15, 22500], [20, 30000]] as const) {
      const id = `tsc_psk_${n}`;
      seedTeacher(id, 'per_skill', 0, 1500, 15);
      seedClassFor(id, `tsc_pcls_${n}`);
      await assignSkillsN(id, n, 1500);
      const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
      const due = computeTeacherDueAmount(db, teacher);
      expect(due.model).toBe('per_skill');
      expect(due.due).toBe(expectedDue);
      expect(due.base).toBe(0);
      expect(due.skillsTotal).toBe(expectedDue);
    }
  });

  // ── H: hybrid + 0/1/15/20 — due = base + skills × rate ──────────────────
  it('hybrid + 0/1/15/20 skills: due = base + skills × rate (components separate)', async () => {
    for (const [n, expectedSkill] of [[0, 0], [1, 1500], [15, 22500], [20, 30000]] as const) {
      const id = `tsc_hyb_${n}`;
      seedTeacher(id, 'hybrid', 20000, 1500, 15);
      seedClassFor(id, `tsc_hcls_${n}`);
      await assignSkillsN(id, n, 1500);
      const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
      const due = computeTeacherDueAmount(db, teacher);
      expect(due.model).toBe('hybrid');
      expect(due.base).toBe(20000);                 // fixed component
      expect(due.skillsTotal).toBe(expectedSkill);  // skill component
      expect(due.due).toBe(20000 + expectedSkill);  // never double-counted
    }
  });

  // ── per_session: sessions drive pay; skills still recordable ─────────────
  it('per_session teacher: skills recorded; pay = completed sessions × rate', async () => {
    const id = 'tsc_psess';
    seedTeacher(id, 'per_session', 30000, 1000);
    seedClassFor(id, 'tsc_scls');
    const assign = await assignSkill(id, 'tsc_scls', 1000);
    expect(assign.status).toBe(201);
    // Two completed sessions this month.
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, topic, status, teacher_id, skill_id, branch_id) VALUES (?, ?, ?, '08:00', '08:45', 't', 'completed', ?, 'tsc_skill', ?)`)
      .run('tsc_s1', 'tsc_scls', today(), id, BRANCH);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, topic, status, teacher_id, skill_id, branch_id) VALUES (?, ?, ?, '09:00', '09:45', 't', 'completed', ?, 'tsc_skill', ?)`)
      .run('tsc_s2', 'tsc_scls', today(), id, BRANCH);
    const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
    const due = computeTeacherDueAmount(db, teacher, today().slice(0, 7));
    expect(due.model).toBe('per_session');
    expect(due.due).toBe(2 * 1000);
  });

  // ── per_level: level-specific rate used ───────────────────────────────────
  it('per_level teacher: level rate from teacher_level_skill_rates wins', async () => {
    const id = 'tsc_plvl';
    seedTeacher(id, 'per_level', 0, 1000);
    db.prepare(`INSERT OR IGNORE INTO teacher_level_skill_rates (id, teacher_id, level_code, skill_id, rate_per_skill, branch_id) VALUES ('tsc_plvl_rate', ?, 'B1', 'tsc_skill', 2500, ?)`).run(id, BRANCH);
    seedClassFor(id, 'tsc_lcls');
    const assign = await assignSkill(id, 'tsc_lcls', 1000);
    expect(assign.status).toBe(201);
    const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
    const due = computeTeacherDueAmount(db, teacher);
    expect(due.model).toBe('per_level');
    expect(due.skillsTotal).toBe(2500); // level rate, not default rate
    expect((due.breakdown[0] as any)?.baseRate).toBe(2500);
  });

  // ── Legacy alias normalization ────────────────────────────────────────────
  it('legacy hybrid_skill/hybrid_level create requests are normalized to hybrid', async () => {
    for (const legacy of ['hybrid_skill', 'hybrid_level']) {
      const res = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
        fullName: `Legacy ${legacy}`, phone: `0700000${legacy.length}`, baseSalary: 25000, salaryType: legacy,
        branchId: BRANCH, joinedDate: today(), defaultSkillRate: 1200,
      });
      expect(res.status).toBe(201);
      expect(res.body.salaryType).toBe('hybrid');
    }
  });

  // ── Duplicate protection ──────────────────────────────────────────────────
  it('duplicate skill assignment for the same class+teacher+skill is rejected', async () => {
    const id = 'tsc_dup';
    seedTeacher(id, 'per_skill', 0, 1500);
    seedClassFor(id, 'tsc_dcls');
    expect((await assignSkill(id, 'tsc_dcls', 1500)).status).toBe(201);
    const second = await assignSkill(id, 'tsc_dcls', 1500);
    expect(second.status).toBe(409);
  });

  // ── Branch isolation + RBAC ───────────────────────────────────────────────
  it('cross-branch skill assignment rejected; registrar cannot create skills', async () => {
    const id = 'tsc_xb';
    seedTeacher(id, 'per_skill', 0, 1500);
    seedClassFor(id, 'tsc_xcls');
    const crossBranch = await supertest(app).post('/api/class-teacher-skills').set(authHeader(managerB)).send({
      classId: 'tsc_xcls', teacherId: id, skillId: 'tsc_skill', monthlyRate: 1500,
    });
    expect(crossBranch.status).toBe(403);
    const registrarWrite = await supertest(app).post('/api/class-teacher-skills').set(authHeader(registrar)).send({
      classId: 'tsc_xcls', teacherId: id, skillId: 'tsc_skill', monthlyRate: 1500,
    });
    expect(registrarWrite.status).toBe(403);
    // Manager (own branch) succeeds.
    expect((await assignSkill(id, 'tsc_xcls', 1500)).status).toBe(201);
  });

  // ── Payroll idempotency + no double pay ───────────────────────────────────
  it('pay-salary is idempotent and fixed salary is not doubled by skills', async () => {
    const id = 'tsc_pay';
    seedTeacher(id, 'fixed', 30000, 0);
    seedClassFor(id, 'tsc_paycls');
    await assignSkill(id, 'tsc_paycls', 0); // fixed teacher records a skill
    const period = today().slice(0, 7);
    const pay1 = await supertest(app).post(`/api/teachers/${id}/pay-salary`).set(authHeader(manager)).send({ monthName: period, paymentType: 'full' });
    expect(pay1.status).toBe(201);
    expect(pay1.body.due).toBe(30000); // skills never added to fixed salary
    const pay2 = await supertest(app).post(`/api/teachers/${id}/pay-salary`).set(authHeader(manager)).send({ monthName: period, paymentType: 'full' });
    expect(pay2.status).toBe(409); // nothing remains payable
    const ledger = (db.prepare(`SELECT COUNT(*) c FROM teacher_salary_ledger WHERE teacher_id=? AND period_key=?`).get(id, period) as any).c;
    expect(ledger).toBe(1); // no duplicate financial transaction
  });

  // ── Period correctness ────────────────────────────────────────────────────
  it('skills are period-correct: assignment dates bound the month they count in', async () => {
    const id = 'tsc_period';
    seedTeacher(id, 'per_skill', 0, 1500);
    // Class active since 2024-01-01 so payroll can see it in 2024-01.
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, program_id, level_id, level, status, teacher_id, start_date, end_date, capacity, gender_policy, lifecycle_stage) VALUES ('tsc_percls', 'Period Class', ?, ?, ?, 'B1', 'active', ?, '2024-01-01', NULL, 20, 'mixed', 'activated')`)
      .run(BRANCH, PROGRAM, LEVEL, id);
    // Skill active only in a past month (2024-01).
    const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId: 'tsc_percls', teacherId: id, skillId: 'tsc_skill', monthlyRate: 1500,
      startDate: '2024-01-01', endDate: '2024-01-31',
    });
    expect(res.status).toBe(201);
    const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id=?`).get(id) as any;
    const jan2024 = computeTeacherDueAmount(db, teacher, '2024-01');
    expect(jan2024.skillsTotal).toBe(1500);
    const jul2025 = computeTeacherDueAmount(db, teacher, '2025-07');
    expect(jul2025.skillsTotal).toBe(0); // not counted in months outside the range
    const report = await supertest(app).get('/api/teachers/skills-report?month=2024-01').set(authHeader(manager));
    expect(report.status).toBe(200);
    const row = report.body.rows.find((r: any) => r.teacherId === id);
    expect(row?.actualSkills).toBe(1);
  });

  // ── Skills workload report: target / actual / shortfall / excess ──────────
  it('skills-report distinguishes contract type, fixed salary, target, actual, shortfall, excess, payroll', async () => {
    const id = 'tsc_report';
    seedTeacher(id, 'fixed', 30000, 0, 15);
    seedClassFor(id, 'tsc_rcls');
    await assignSkillsN(id, 15, 0);
    const report = await supertest(app).get(`/api/teachers/skills-report?month=${today().slice(0, 7)}`).set(authHeader(manager));
    expect(report.status).toBe(200);
    const row = report.body.rows.find((r: any) => r.teacherId === id);
    expect(row?.contractType).toBe('fixed');
    expect(row?.fixedSalary).toBe(30000);
    expect(row?.targetSkills).toBe(15);
    expect(row?.actualSkills).toBe(15);
    expect(row?.shortfall).toBe(0);
    expect(row?.excess).toBe(0);
    expect(row?.skillEarnings).toBe(0);          // fixed: skills are not pay
    expect(row?.fixedComponent).toBe(30000);
    expect(row?.totalPayroll).toBe(30000);
    // Missing month param → 400.
    const noMonth = await supertest(app).get('/api/teachers/skills-report').set(authHeader(manager));
    expect(noMonth.status).toBe(400);
  });

  it('toPeriodKey and salary-type five-value contract hold', () => {
    expect(toPeriodKey('2025-08')).toBe('2025-08');
    expect(toPeriodKey('August 2025')).toBe('2025-08');
    const check = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='teachers'`).get() as any).sql;
    expect(check).toMatch(/'fixed','per_skill','per_session','hybrid','per_level'/);
    expect(check).not.toMatch(/hybrid_skill|hybrid_level/);
  });
});
