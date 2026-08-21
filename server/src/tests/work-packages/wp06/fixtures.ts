import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { sessionsRouter } from '../../../routes/sessions.routes.js';
import { examsRouter } from '../../../routes/exams.routes.js';
import classesRouter, { attendanceRouter } from '../../../routes/classes.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';

export interface Wp06Context {
  key: string;
  branchA: string;
  branchB: string;
  app: express.Express;
  owner: { Authorization: string };
  manager: { Authorization: string };
  receptionist: { Authorization: string };
  teacher: { Authorization: string };
  teacherId: string;
  classId: string;
  studentA: string;
  studentB: string;
}

let sequence = 0;
function nextKey() {
  sequence += 1;
  return `w6_${process.pid}_${sequence}_${randomUUID().slice(0, 6)}`;
}

export function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/exams', examsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use(errorHandler);
  return app;
}

/**
 * Seeds a branch pair, the four operational roles, one activated class with a
 * teacher, and two enrolled students. Session rosters are built from active
 * student_semesters rows, so students are inserted there directly.
 */
export function seedContext(): Wp06Context {
  initSchema();
  bootstrapRbacCatalog(db);
  const key = nextKey();
  const branchA = `${key}_ba`;
  const branchB = `${key}_bb`;
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'A')").run(branchA, `${key} A`);
  db.prepare("INSERT INTO branches (id,name,location) VALUES (?,?, 'B')").run(branchB, `${key} B`);

  const ownerId = `${key}_owner`;
  const managerId = `${key}_manager`;
  const receptionistId = `${key}_recep`;
  const teacherUserId = `${key}_teachuser`;
  const teacherId = `${key}_teach`;
  db.prepare(
    `INSERT INTO teachers (id, full_name, branch_id, joined_date, status) VALUES (?,?,?,?,'active')`,
  ).run(teacherId, `${key} Teacher`, branchA, today());
  seedUser({ id: ownerId, role: 'owner', branchId: branchA, username: ownerId, fullName: 'Owner' });
  seedUser({ id: managerId, role: 'general_manager', branchId: branchA, username: managerId, fullName: 'Manager' });
  seedUser({ id: receptionistId, role: 'receptionist', branchId: branchA, username: receptionistId, fullName: 'Receptionist' });
  seedUser({ id: teacherUserId, role: 'teacher', branchId: branchA, username: teacherUserId, fullName: 'Teacher', linkedTeacherId: teacherId });

  const classId = `${key}_class`;
  db.prepare(
    `INSERT INTO classes (id, name, level, capacity, status, lifecycle_stage, teacher_id, branch_id)
     VALUES (?,?,?,10,'active','activated',?,?)`,
  ).run(classId, `${key} Class`, 'Ad hoc', teacherId, branchA);

  const studentA = `${key}_stu_a`;
  const studentB = `${key}_stu_b`;
  for (const sid of [studentA, studentB]) {
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, branch_id, status, registration_date, gender)
       VALUES (?,?,?,?,'active',?,'male')`,
    ).run(sid, `${sid}-code`, `${sid} Name`, branchA, today());
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
       VALUES (?,?,?,?,?,1000,'active')`,
    ).run(`${sid}_sem`, sid, `${key} Term`, classId, today());
  }

  return {
    key,
    branchA,
    branchB,
    app: makeApp(),
    owner: bearerFor(ownerId),
    manager: bearerFor(managerId),
    receptionist: bearerFor(receptionistId),
    teacher: bearerFor(teacherUserId),
    teacherId,
    classId,
    studentA,
    studentB,
  };
}

/** Creates one scheduled session for the context class and returns its id. */
export async function createSession(
  context: Wp06Context,
  options: { date?: string; start?: string; end?: string; branchId?: string } = {},
) {
  const response = await supertest(context.app)
    .post('/api/sessions')
    .set(context.receptionist)
    .send({
      classId: context.classId,
      date: options.date ?? '2026-09-01',
      startTime: options.start ?? '08:00',
      endTime: options.end ?? '09:30',
    });
  if (response.status !== 201) {
    throw new Error(`Unable to create session fixture: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.id as string;
}
