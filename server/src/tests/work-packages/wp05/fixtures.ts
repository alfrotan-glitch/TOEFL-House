import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { academicRouter } from '../../../routes/academic.routes.js';
import classesRouter from '../../../routes/classes.routes.js';
import { offeringsRouter } from '../../../routes/offerings.routes.js';
import { enrollmentRouter } from '../../../routes/enrollment.routes.js';
import { waitlistRouter } from '../../../routes/waitlist.routes.js';
import { teachersRouter } from '../../../routes/teachers.routes.js';
import { skillsRouter, classTeacherSkillsRouter } from '../../../routes/skills.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { getClassLifecycleService } from '../../../core/academic/class-lifecycle-service.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { today } from '../../../utils/ids.js';

export interface Wp05Context {
  key: string;
  branchA: string;
  branchB: string;
  ownerId: string;
  app: express.Express;
  owner: { Authorization: string };
  programA: string;
  versionA: string;
  levelA: string;
  programA2: string;
  versionA2: string;
  levelA2: string;
  programB: string;
  versionB: string;
  levelB: string;
  termA: string;
  termB: string;
}

let sequence = 0;
function nextKey() {
  sequence += 1;
  return `w5_${process.pid}_${sequence}_${randomUUID().slice(0, 6)}`;
}

export function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/academic', academicRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/offerings', offeringsRouter);
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/classes/:id/waitlist', waitlistRouter);
  app.use('/api/teachers', teachersRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/class-teacher-skills', classTeacherSkillsRouter);
  app.use(errorHandler);
  return app;
}

export function seedContext(): Wp05Context {
  initSchema();
  const key = nextKey();
  const branchA = `${key}_ba`;
  const branchB = `${key}_bb`;
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'A')").run(branchA, `${key} A`);
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'B')").run(branchB, `${key} B`);

  const ownerId = `${key}_owner`;
  seedUser({ id: ownerId, role: 'owner', branchId: branchA, username: ownerId });

  const programA = `${key}_pa`;
  const versionA = `${key}_pva`;
  const levelA = `${key}_la`;
  const programA2 = `${key}_pa2`;
  const versionA2 = `${key}_pva2`;
  const levelA2 = `${key}_la2`;
  const programB = `${key}_pb`;
  const versionB = `${key}_pvb`;
  const levelB = `${key}_lb`;
  for (const [programId, versionId, levelId, branchId, suffix] of [
    [programA, versionA, levelA, branchA, 'A'],
    [programA2, versionA2, levelA2, branchA, 'A2'],
    [programB, versionB, levelB, branchB, 'B'],
  ] as const) {
    db.prepare('INSERT INTO programs (id,name,branch_id,duration_months) VALUES (?,?,?,3)').run(programId, `${key} Program ${suffix}`, branchId);
    db.prepare("INSERT INTO program_versions (id,program_id,version_label,status,is_default) VALUES (?,?,?,'published',1)").run(versionId, programId, 'v1');
    db.prepare('INSERT INTO levels (id,program_id,program_version_id,name,code,"order",is_active,default_fee,min_viable_size) VALUES (?,?,?,?,?,1,1,1000,1)')
      .run(levelId, programId, versionId, `Level ${suffix}`, `L${suffix}`);
  }

  const termA = `${key}_ta`;
  const termB = `${key}_tb`;
  db.prepare("INSERT INTO academic_terms (id,branch_id,year,code,name,start_date,end_date) VALUES (?,?,1405,'T1',?,'2026-08-01','2026-12-01')")
    .run(termA, branchA, `${key} Term A`);
  db.prepare("INSERT INTO academic_terms (id,branch_id,year,code,name,start_date,end_date) VALUES (?,?,1405,'T1',?,'2026-08-01','2026-12-01')")
    .run(termB, branchB, `${key} Term B`);

  return {
    key,
    branchA,
    branchB,
    ownerId,
    app: makeApp(),
    owner: bearerFor(ownerId),
    programA,
    versionA,
    levelA,
    programA2,
    versionA2,
    levelA2,
    programB,
    versionB,
    levelB,
    termA,
    termB,
  };
}

export async function createActiveClass(
  context: Wp05Context,
  options: { name?: string; capacity?: number; programId?: string; levelId?: string; branchId?: string; termId?: string; teacherId?: string } = {},
) {
  const response = await supertest(context.app)
    .post('/api/classes')
    .set(context.owner)
    .send({
      name: options.name ?? `${context.key} Class`,
      branchId: options.branchId ?? context.branchA,
      programId: options.programId,
      levelId: options.levelId,
      academicTermId: options.termId,
      level: options.levelId ? undefined : 'Ad hoc',
      capacity: options.capacity ?? 10,
      teacherId: options.teacherId,
    });
  if (response.status !== 201) throw new Error(`Unable to create class fixture: ${response.status} ${JSON.stringify(response.body)}`);
  getClassLifecycleService(db).activate(response.body.id);
  return response.body.id as string;
}

export function seedStudent(context: Wp05Context, suffix: string, branchId = context.branchA) {
  const studentId = `${context.key}_student_${suffix}`;
  db.prepare(`
    INSERT INTO students (id,student_code,full_name,branch_id,status,registration_date,gender)
    VALUES (?,?,?,?,'active',?,'male')
  `).run(studentId, `${context.key}-${suffix}`, `${context.key} Student ${suffix}`, branchId, today());
  return studentId;
}

export function enroll(
  context: Wp05Context,
  studentId: string,
  classId: string,
  options: { semesterName?: string; enrollmentType?: 'new' | 'extra'; startedAt?: string } = {},
) {
  return getEnrollmentService(db).enroll({
    studentId,
    branchId: context.branchA,
    classId,
    semesterName: options.semesterName ?? `${context.key} Term`,
    enrollmentType: options.enrollmentType ?? 'new',
    startedAt: options.startedAt ?? today(),
  }).enrollmentId;
}
