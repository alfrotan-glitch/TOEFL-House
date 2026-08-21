/**
 * Academic Module Refactor — Phase 8: Teacher Assignment Engine
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-7.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today, id as makeId } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { classTeacherSkillsRouter, skillsRouter } from '../../../routes/skills.routes.js';
import sessionsRouter from '../../../routes/sessions.routes.js';
import classesRouter from '../../../routes/classes.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../../../core/academic/class-lifecycle-service.js';
import { computeTeacherDueAmount } from '../../../core/payroll/class-payroll.js';

const BRANCH = 'ta_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/class-teacher-skills', classTeacherSkillsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH, fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, branchId, await hashPassword('testpass123'));
  assignRole(userId, role, branchId);
}
function seedTeacher(teacherId: string, branchId: string, name: string, salaryType = 'per_skill') {
  db.prepare(
    `INSERT OR IGNORE INTO teachers (id, full_name, branch_id, status, salary_type, base_salary, default_skill_rate, joined_date) VALUES (?, ?, ?, 'active', ?, 5000, 1500, ?)`
  ).run(teacherId, name, branchId, salaryType, today());
}
function seedSkill(skillId: string, name: string) {
  db.prepare(`INSERT OR IGNORE INTO skills (id, name) VALUES (?, ?)`).run(skillId, name);
}

let app: express.Express;
let manager: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'TA Branch', 'Loc');
  await seedUser('u_ta_manager', 'manager', BRANCH, 'ta_manager');

  manager = makeUser({ userId: 'u_ta_manager', branchId: BRANCH });
  app = createApp();
});

async function createActivatedClass(name: string): Promise<string> {
  const res = await supertest(app).post('/api/classes').set(authHeader(manager)).send({ name, level: 'A1', branchId: BRANCH, capacity: 10 });
  const classId = res.body.id;
  const svc = getClassLifecycleService(db);
  svc.activate(classId);
  db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
    .run(`${classId}-teaching-session`, classId, today(), BRANCH);
  svc.startTeaching(classId);
  return classId;
}

describe('Teacher Assignment Engine — assignment types', () => {
  it('accepts every blueprint assignment type', async () => {
    const classId = await createActivatedClass('All Types Class');
    for (const type of ['primary', 'assistant', 'substitute', 'guest', 'examiner']) {
      const teacherId = `ta_teacher_${type}`;
      const skillId = `ta_skill_${type}`;
      seedTeacher(teacherId, BRANCH, `${type} Teacher`);
      seedSkill(skillId, `${type} Skill`);
      const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
        classId, teacherId, skillId, assignmentType: type, monthlyRate: type === 'guest' ? 0 : 1000,
      });
      expect(res.status, `type "${type}" should be accepted`).toBe(201);
      expect(res.body.assignmentType).toBe(type);
    }
  });

  it('rejects an invalid assignment type', async () => {
    const classId = await createActivatedClass('Invalid Type Class');
    const teacherId = 'ta_teacher_invalid';
    seedTeacher(teacherId, BRANCH, 'Invalid Type Teacher');
    seedSkill('ta_skill_invalid', 'Invalid Skill');
    const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId, skillId: 'ta_skill_invalid', assignmentType: 'bogus',
    });
    expect(res.status).toBe(400);
  });

  it('defaults to primary when assignmentType is omitted (backward compatible)', async () => {
    const classId = await createActivatedClass('Default Type Class');
    const teacherId = 'ta_teacher_default';
    seedTeacher(teacherId, BRANCH, 'Default Type Teacher');
    seedSkill('ta_skill_default', 'Default Skill');
    const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId, skillId: 'ta_skill_default', monthlyRate: 1200,
    });
    expect(res.status).toBe(201);
    expect(res.body.assignmentType).toBe('primary');
  });
});

describe('Teacher Assignment Engine — business rules scoped to ongoing roles only', () => {
  it('the max-3-skills cap applies to primary/assistant but not substitute/guest/examiner', async () => {
    const classId = await createActivatedClass('Skill Cap Class');
    for (let i = 1; i <= 3; i++) {
      seedTeacher(`ta_cap_primary_${i}`, BRANCH, `Cap Primary ${i}`);
      seedSkill(`ta_cap_skill_${i}`, `Cap Skill ${i}`);
      const res = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
        classId, teacherId: `ta_cap_primary_${i}`, skillId: `ta_cap_skill_${i}`, monthlyRate: 1000,
      });
      expect(res.status).toBe(201);
    }
    seedTeacher('ta_cap_primary_4', BRANCH, 'Cap Primary 4');
    seedSkill('ta_cap_skill_4', 'Cap Skill 4');
    const blocked = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_cap_primary_4', skillId: 'ta_cap_skill_4', monthlyRate: 1000,
    });
    expect(blocked.status).toBe(409);

    seedTeacher('ta_cap_guest', BRANCH, 'Cap Guest');
    const guestOk = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_cap_guest', skillId: 'ta_cap_skill_4', assignmentType: 'guest', monthlyRate: 0,
    });
    expect(guestOk.status).toBe(201);

    // Updating that fourth, non-ongoing skill into an ongoing role reaches the
    // same storage limit and must be a business conflict, never an HTTP 500.
    const blockedUpdate = await supertest(app)
      .put(`/api/class-teacher-skills/${guestOk.body.id}`)
      .set(authHeader(manager))
      .send({ assignmentType: 'primary', monthlyRate: 1000 });
    expect(blockedUpdate.status).toBe(409);
    expect(blockedUpdate.body.error).toMatch(/three distinct/i);
  });

  it('a rate is required for primary/assistant but optional for substitute/guest/examiner', async () => {
    const classId = await createActivatedClass('Rate Requirement Class');
    seedTeacher('ta_rate_primary', BRANCH, 'Rate Primary', 'per_skill');
    db.prepare(`UPDATE teachers SET default_skill_rate = 0, base_salary = 0 WHERE id = ?`).run('ta_rate_primary');
    seedSkill('ta_rate_skill', 'Rate Skill');
    const blocked = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_rate_primary', skillId: 'ta_rate_skill', monthlyRate: 0,
    });
    expect(blocked.status).toBe(400);

    seedTeacher('ta_rate_examiner', BRANCH, 'Rate Examiner');
    const examinerOk = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_rate_examiner', skillId: 'ta_rate_skill', assignmentType: 'examiner', monthlyRate: 0,
    });
    expect(examinerOk.status).toBe(201);
  });
});

describe('Teacher Assignment Engine — class vs session scoping', () => {
  it('rejects a second class-scoped assignment for the same class+teacher+skill (app-level enforcement)', async () => {
    const classId = await createActivatedClass('Duplicate Class Scope Class');
    seedTeacher('ta_dup_teacher', BRANCH, 'Dup Teacher');
    seedSkill('ta_dup_skill', 'Dup Skill');
    await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({ classId, teacherId: 'ta_dup_teacher', skillId: 'ta_dup_skill', monthlyRate: 1000 });
    const dup = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({ classId, teacherId: 'ta_dup_teacher', skillId: 'ta_dup_skill', monthlyRate: 1000 });
    expect(dup.status).toBe(409);
  });

  it('allows the SAME teacher to have session-scoped assignments for the same class+skill across different sessions', async () => {
    const classId = await createActivatedClass('Multi Session Scope Class');
    seedTeacher('ta_multi_sub', BRANCH, 'Multi Sub Teacher');
    seedSkill('ta_multi_skill', 'Multi Skill');

    const s1 = await supertest(app).post('/api/sessions').set(authHeader(manager)).send({ classId, date: today(), startTime: '09:00', endTime: '10:00' });
    const s2 = await supertest(app).post('/api/sessions').set(authHeader(manager)).send({ classId, date: today(), startTime: '11:00', endTime: '12:00' });

    const a1 = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_multi_sub', skillId: 'ta_multi_skill', assignmentType: 'substitute', sessionId: s1.body.id,
    });
    expect(a1.status).toBe(201);
    const a2 = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_multi_sub', skillId: 'ta_multi_skill', assignmentType: 'substitute', sessionId: s2.body.id,
    });
    expect(a2.status).toBe(201);
  });
});

describe('Teacher Assignment Engine — teacher replacement convenience endpoint', () => {
  it('creates a session-scoped substitute assignment covering an existing one', async () => {
    const classId = await createActivatedClass('Replacement Class');
    seedTeacher('ta_repl_primary', BRANCH, 'Replacement Primary');
    seedTeacher('ta_repl_sub', BRANCH, 'Replacement Sub');
    seedSkill('ta_repl_skill', 'Replacement Skill');
    const original = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_repl_primary', skillId: 'ta_repl_skill', monthlyRate: 1500,
    });
    const session = await supertest(app).post('/api/sessions').set(authHeader(manager)).send({ classId, date: today(), startTime: '09:00', endTime: '10:00' });

    const res = await supertest(app).post(`/api/class-teacher-skills/${original.body.id}/substitute`).set(authHeader(manager)).send({
      substituteTeacherId: 'ta_repl_sub', sessionId: session.body.id, reason: 'Primary teacher on sick leave',
    });
    expect(res.status).toBe(201);

    const list = await supertest(app).get(`/api/class-teacher-skills?classId=${classId}`).set(authHeader(manager));
    const sub = list.body.find((a: any) => a.teacherId === 'ta_repl_sub');
    expect(sub.assignmentType).toBe('substitute');
    expect(sub.sessionId).toBe(session.body.id);
    expect(sub.reason).toMatch(/sick leave/);
  });

  it('requires a reason', async () => {
    const classId = await createActivatedClass('Replacement No Reason Class');
    seedTeacher('ta_repl2_primary', BRANCH, 'Replacement2 Primary');
    seedTeacher('ta_repl2_sub', BRANCH, 'Replacement2 Sub');
    seedSkill('ta_repl2_skill', 'Replacement2 Skill');
    const original = await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId: 'ta_repl2_primary', skillId: 'ta_repl2_skill', monthlyRate: 1500,
    });
    const session = await supertest(app).post('/api/sessions').set(authHeader(manager)).send({ classId, date: today(), startTime: '09:00', endTime: '10:00' });

    const res = await supertest(app).post(`/api/class-teacher-skills/${original.body.id}/substitute`).set(authHeader(manager)).send({
      substituteTeacherId: 'ta_repl2_sub', sessionId: session.body.id,
    });
    expect(res.status).toBe(400);
  });
});

describe('Teacher Assignment Engine — payroll distribution excludes one-off roles', () => {
  it('only primary/assistant assignments feed the automatic monthly payroll calculation', async () => {
    const classId = await createActivatedClass('Payroll Exclusion Class');
    const teacherId = 'ta_payroll_teacher';
    seedTeacher(teacherId, BRANCH, 'Payroll Teacher', 'per_skill');
    seedSkill('ta_payroll_skill_primary', 'Payroll Skill Primary');
    seedSkill('ta_payroll_skill_guest', 'Payroll Skill Guest');

    await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId, skillId: 'ta_payroll_skill_primary', assignmentType: 'primary', monthlyRate: 2000,
    });
    await supertest(app).post('/api/class-teacher-skills').set(authHeader(manager)).send({
      classId, teacherId, skillId: 'ta_payroll_skill_guest', assignmentType: 'guest', monthlyRate: 5000,
    });

    const teacherRow = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId) as any;
    const result = computeTeacherDueAmount(db, {
      id: teacherRow.id, branch_id: teacherRow.branch_id, base_salary: teacherRow.base_salary,
      salary_type: teacherRow.salary_type, default_skill_rate: teacherRow.default_skill_rate, performance_score: 100,
    });

    expect(result.skillsTotal).toBeLessThan(5000);
    const breakdown = result.breakdown as any[];
    expect(breakdown.some((b: any) => b.skillName === 'Payroll Skill Guest')).toBe(false);
  });
});
