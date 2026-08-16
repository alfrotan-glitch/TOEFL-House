/**
 * Authorization must use the caller's RESOLVED SCOPE, not their home branch.
 * ============================================================================
 * F-7 (proven live over HTTP, 2026-08-16 third audit pass):
 *
 *   Thirteen sites compared a resource's branch against `user.branchId` — the
 *   single branch stored on the user row — instead of asking whether the
 *   caller is authorized for that branch. The organization owner has home
 *   branch "1", so:
 *
 *     POST /api/impact/stories        (student in another branch) -> 400
 *     POST /api/class-teacher-skills  (teacher/class in another branch) -> 403
 *
 *   In the skills case the owner had just created BOTH the teacher and the
 *   class in that branch through the API, and was then refused permission to
 *   link them. class_teacher_skills drives teacher payroll, so this blocked a
 *   real money-affecting workflow for every multi-branch user.
 *
 * Two distinct bugs shared the root cause:
 *
 *   1. AUTHORIZATION — home-branch equality is not an authorization check.
 *      It is simultaneously too strict (denies authorized multi-branch users)
 *      and unrelated to the RBAC scope model the rest of the codebase uses.
 *      Fixed by calling canAccessBranchResource / resolveBranchScope.
 *
 *   2. DATA ATTRIBUTION — the created rows stored `user.branchId` as their own
 *      branch. A story about a branch-B student, or a skill assignment for a
 *      branch-B class, was filed under the operator's branch A. Fixed by
 *      deriving the branch from the SUBJECT (the student / the class).
 *
 * The direction of the fix matters: it GRANTS access that scope already
 * allows, so the tests below must also prove no new cross-branch leak.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import impactRouter from '../routes/impact.routes.js';
import { classTeacherSkillsRouter } from '../routes/skills.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const HOME = 'f7_home';      // the operator's home branch
const OTHER = 'f7_other';    // a different branch, same organization
const OUTSIDE = 'f7_outside'; // a branch the restricted user cannot reach

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/impact', impactRouter);
  app.use('/api/class-teacher-skills', classTeacherSkillsRouter);
  app.use(errorHandler);
  return app;
}
const auth = (userId: string, role: string, branchId: string) =>
  `Bearer ${signToken({ userId, username: userId, role, branchId, fullName: userId } as TokenPayload)}`;

let app: express.Express;

beforeEach(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);

  for (const b of [HOME, OTHER, OUTSIDE]) {
    db.prepare(
      `INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)`,
    ).run(`c_${b}`, FIXED_ORG_ID, `Campus ${b}`, `C-${b}`);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, 'Loc', ?)`)
      .run(b, b, `c_${b}`);
  }

  const pw = await hashPassword('x');
  const mkUser = (id: string, role: string, branch: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    ).run(id, id, id, role, branch, pw);
  mkUser('f7_owner', 'owner', HOME);       // organization-wide authority
  mkUser('f7_manager', 'manager', HOME);   // branch-limited authority
  syncLegacyUserRoles(db);

  const mkStudent = (id: string, branch: string, phone: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
       VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
    ).run(id, `F7-${id}`, `Student ${id}`, phone, today(), branch);
  mkStudent('f7_stu_home', HOME, '0700220001');
  mkStudent('f7_stu_other', OTHER, '0700220002');

  const mkTeacher = (id: string, branch: string, phone: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO teachers (id, full_name, phone, branch_id, status, joined_date, salary_type)
       VALUES (?, ?, ?, ?, 'active', ?, 'fixed')`,
    ).run(id, id, phone, branch, today());
  mkTeacher('f7_t_other', OTHER, '0700220011');

  db.prepare(
    `INSERT OR REPLACE INTO classes (id, name, teacher_id, branch_id, level, capacity, schedule_time, start_date, end_date, fee, status)
     VALUES ('f7_cls_other', 'F7 Other Class', 'f7_t_other', ?, 'A1', 10, '08:00', ?, '2026-12-01', 5000, 'active')`,
  ).run(OTHER, today());

  db.prepare(`INSERT OR REPLACE INTO skills (id, name) VALUES ('f7_skill', 'F7 Skill')`).run();
  db.prepare(`DELETE FROM class_teacher_skills WHERE id LIKE 'cts_%'`).run();
  db.prepare(`DELETE FROM success_stories WHERE student_id LIKE 'f7_stu_%'`).run();

  app = createApp();
});

describe('F-7: scope authorizes, home branch does not', () => {
  it('an owner can publish a story about a student in another branch', async () => {
    const res = await supertest(app)
      .post('/api/impact/stories')
      .set('Authorization', auth('f7_owner', 'owner', HOME))
      .send({ studentId: 'f7_stu_other', title: 'Cross-branch story', content: 'body' });

    expect(res.status).toBe(201);

    // Attribution: the story belongs to the STUDENT's branch, not the author's.
    const row = db.prepare('SELECT branch_id FROM success_stories WHERE id = ?').get(res.body.id) as
      | { branch_id: string } | undefined;
    expect(row?.branch_id).toBe(OTHER);
  });

  it('an owner can assign a skill for a class in another branch, filed under that branch', async () => {
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set('Authorization', auth('f7_owner', 'owner', HOME))
      .send({ teacherId: 'f7_t_other', classId: 'f7_cls_other', skillId: 'f7_skill', assignmentType: 'primary', monthlyRate: 5000 });

    expect(res.status).toBe(201);

    const row = db.prepare('SELECT branch_id FROM class_teacher_skills WHERE id = ?').get(res.body.id) as
      | { branch_id: string } | undefined;
    // Payroll aggregates by branch, so a misfiled assignment misstates a
    // branch's salary cost. It must follow the class, not the operator.
    expect(row?.branch_id).toBe(OTHER);
  });

  it('a branch-limited manager still cannot reach another branch (no new leak)', async () => {
    const story = await supertest(app)
      .post('/api/impact/stories')
      .set('Authorization', auth('f7_manager', 'manager', HOME))
      .send({ studentId: 'f7_stu_other', title: 'should fail', content: 'body' });
    expect(story.status).toBe(403);

    const skill = await supertest(app)
      .post('/api/class-teacher-skills')
      .set('Authorization', auth('f7_manager', 'manager', HOME))
      .send({ teacherId: 'f7_t_other', classId: 'f7_cls_other', skillId: 'f7_skill', assignmentType: 'primary', monthlyRate: 5000 });
    expect(skill.status).toBe(403);

    expect(
      db.prepare(`SELECT COUNT(*) c FROM class_teacher_skills WHERE class_id = 'f7_cls_other'`).get(),
    ).toEqual({ c: 0 });
  });

  it('a teacher and class in DIFFERENT branches can never be linked', async () => {
    db.prepare(
      `INSERT OR REPLACE INTO teachers (id, full_name, phone, branch_id, status, joined_date, salary_type)
       VALUES ('f7_t_home', 'Home Teacher', '0700220022', ?, 'active', ?, 'fixed')`,
    ).run(HOME, today());

    // Even the owner, who is authorized for both branches, must be refused:
    // this is a data-integrity rule, not an authorization one.
    const res = await supertest(app)
      .post('/api/class-teacher-skills')
      .set('Authorization', auth('f7_owner', 'owner', HOME))
      .send({ teacherId: 'f7_t_home', classId: 'f7_cls_other', skillId: 'f7_skill', assignmentType: 'primary', monthlyRate: 5000 });
    expect(res.status).toBe(400);
  });

  it('the assignment list is scope-aware, not home-branch-only', async () => {
    await supertest(app)
      .post('/api/class-teacher-skills')
      .set('Authorization', auth('f7_owner', 'owner', HOME))
      .send({ teacherId: 'f7_t_other', classId: 'f7_cls_other', skillId: 'f7_skill', assignmentType: 'primary', monthlyRate: 5000 });

    // The owner's home branch is HOME; the only assignment lives in OTHER.
    // A home-branch-only query returns nothing here.
    const all = await supertest(app)
      .get('/api/class-teacher-skills?branchId=all')
      .set('Authorization', auth('f7_owner', 'owner', HOME));
    expect(all.status).toBe(200);
    expect(all.body.length).toBe(1);

    // The branch-limited manager sees none of it.
    const limited = await supertest(app)
      .get('/api/class-teacher-skills')
      .set('Authorization', auth('f7_manager', 'manager', HOME));
    expect(limited.status).toBe(200);
    expect(limited.body).toEqual([]);
  });
});
