/**
 * Teacher Skill / Contract-Type — closed-state regression.
 * ============================================================================
 * Originally reproduced the defects where contract type gated skill
 * recording. After the fixes these assertions guard the CLOSED state:
 *
 *  D1  Fixed-contract teachers CAN be assigned skills (no 409 gate).
 *  D3  The DB hybrid contract type is creatable via the API; legacy
 *      hybrid_skill/hybrid_level are normalized to hybrid.
 *  D4  Payroll for hybrid = base + skill component (never 0).
 *  D6  Fixed teacher with skills: salary stays fixed; skills counted.
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
import { computeTeacherDueAmount } from '../core/payroll/class-payroll.js';
import { readFileSync } from 'fs';

const BRANCH = 'tsk_branch';
const PROGRAM = 'tsk_program';
const VERSION = 'tsk_version';
const LEVEL = 'tsk_level';
const MANAGER = 'tsk_manager';

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

describe('Teacher skill/contract (closed-state regression)', () => {
  let app: express.Express;
  let manager: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'T Branch', 'T');
    db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`)
      .run(MANAGER, MANAGER, 'Manager', BRANCH, await hashPassword('testpass123'));
    syncLegacyUserRoles(db);
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`).run(PROGRAM, 'T Program', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 1, ?, 'B1', 1)`).run(LEVEL, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO skills (id, name) VALUES ('tsk_skill', 'Grammar')`).run();
    manager = { userId: MANAGER, username: MANAGER, role: 'manager', branchId: BRANCH, fullName: 'Manager' };
    app = createApp();
  });

  function seedClass(teacherId: string, classId: string) {
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, program_id, level_id, level, status, teacher_id, start_date, end_date, capacity, gender_policy, lifecycle_stage) VALUES (?, ?, ?, ?, ?, 'B1', 'active', ?, ?, ?, 20, 'mixed', 'activated')`)
      .run(classId, `C ${classId}`, BRANCH, PROGRAM, LEVEL, teacherId, today(), null);
  }

  it('CLOSED-D1: fixed teachers can be assigned skills; no fixed gate in the route', async () => {
    const src = readFileSync('src/routes/skills.routes.ts', 'utf8');
    expect(src).not.toMatch(/salary_type === 'fixed'/);
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate) VALUES ('tsk_fixed', 'Fixed', 30000, 'fixed', 100, 'active', ?, ?, 0)`).run(BRANCH, today());
    seedClass('tsk_fixed', 'tsk_fcls');
    const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId: 'tsk_fcls', teacherId: 'tsk_fixed', skillId: 'tsk_skill', monthlyRate: 0,
    });
    expect(res.status).toBe(201);
  });

  it('CLOSED-D3: hybrid is creatable; legacy aliases normalize to hybrid; five types in schema', async () => {
    const hybrid = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Hybrid T', phone: '0700000001', baseSalary: 20000, salaryType: 'hybrid', branchId: BRANCH, joinedDate: today(), defaultSkillRate: 1500,
    });
    expect(hybrid.status).toBe(201);
    expect(hybrid.body.salaryType).toBe('hybrid');
    const legacy = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Legacy T', phone: '0700000002', baseSalary: 20000, salaryType: 'hybrid_skill', branchId: BRANCH, joinedDate: today(), defaultSkillRate: 1500,
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.salaryType).toBe('hybrid');
    const schema = readFileSync('src/db/schema.sql', 'utf8');
    expect(schema).toMatch(/'fixed','per_skill','per_session','hybrid','per_level'/);
    expect(schema).not.toMatch(/hybrid_skill|hybrid_level/);
  });

  it('CLOSED-D4: hybrid payroll = base + skill component', async () => {
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate) VALUES ('tsk_hyb', 'Hybrid', 20000, 'hybrid', 100, 'active', ?, ?, 1500)`).run(BRANCH, today());
    seedClass('tsk_hyb', 'tsk_hcls');
    await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({ classId: 'tsk_hcls', teacherId: 'tsk_hyb', skillId: 'tsk_skill', monthlyRate: 1500 });
    const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id='tsk_hyb'`).get() as any;
    const due = computeTeacherDueAmount(db, teacher);
    expect(due.model).toBe('hybrid');
    expect(due.base).toBe(20000);
    expect(due.skillsTotal).toBe(1500);
    expect(due.due).toBe(21500);
  });

  it('CLOSED-D6: fixed teacher with 15 skills — salary fixed at 30,000, skills counted', async () => {
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate) VALUES ('tsk_fixed15', 'Fixed15', 30000, 'fixed', 100, 'active', ?, ?, 0)`).run(BRANCH, today());
    for (let i = 0; i < 15; i++) {
      seedClass('tsk_fixed15', `tsk_f15_${i}`);
      await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({ classId: `tsk_f15_${i}`, teacherId: 'tsk_fixed15', skillId: 'tsk_skill', monthlyRate: 0 });
    }
    const teacher = db.prepare(`SELECT id, branch_id, base_salary, salary_type, default_skill_rate, performance_score FROM teachers WHERE id='tsk_fixed15'`).get() as any;
    const due = computeTeacherDueAmount(db, teacher);
    expect(due.due).toBe(30000);
    expect(due.skillsTotal).toBe(0);
    const computed = await supertest(app).get('/api/teachers/tsk_fixed15/computed-salary').set(authHeader(manager));
    expect(computed.body.skillCount).toBe(15);
    expect(computed.body.due).toBe(30000);
  });
});
