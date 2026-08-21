import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db } from '../../../db/connection.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { createActiveClass, enroll, seedContext, seedStudent } from './fixtures.js';

const API_STORE = fileURLToPath(new URL('../../../../../src/apiStore.ts', import.meta.url));

function sourceOf(path: string) {
  return readFileSync(path, 'utf8');
}

describe('WP-05 adversarial integrity boundary', () => {
  it('refuses a class whose curriculum belongs to another branch', async () => {
    const c = seedContext();
    const response = await supertest(c.app)
      .post('/api/classes')
      .set(c.owner)
      .send({
        name: `${c.key} mixed graph`,
        branchId: c.branchA,
        programId: c.programB,
        levelId: c.levelB,
        capacity: 10,
      });

    expect(response.status).toBe(400);
    expect(db.prepare('SELECT id FROM classes WHERE name = ?').get(`${c.key} mixed graph`)).toBeUndefined();

    const partial = await supertest(c.app)
      .post('/api/classes')
      .set(c.owner)
      .send({ name: `${c.key} partial graph`, branchId: c.branchA, programId: c.programA, level: 'Ad hoc' });
    expect(partial.status).toBe(400);
    expect(() => db.prepare(`
      INSERT INTO classes (id,name,program_id,level,branch_id)
      VALUES (?,?,?,'Ad hoc',?)
    `).run(`${c.key}_partial`, `${c.key} partial direct`, c.programA, c.branchA)).toThrow(/academic integrity/i);
  });

  it('refuses invalid academic planning scalars instead of storing them', async () => {
    const c = seedContext();
    const negativeProgram = await supertest(c.app)
      .post('/api/academic/programs')
      .set(c.owner)
      .send({ name: `${c.key} negative`, branchId: c.branchA, durationMonths: -1 });
    const reversedSlot = await supertest(c.app)
      .post('/api/academic/time-slots')
      .set(c.owner)
      .send({ code: `${c.key}_slot`, label: 'Reversed', branchId: c.branchA, startTime: '18:00', endTime: '08:00' });
    const negativeRoom = await supertest(c.app)
      .post('/api/academic/rooms')
      .set(c.owner)
      .send({ code: `${c.key}_room`, name: 'Negative', branchId: c.branchA, capacity: -1 });
    const coercedBoolean = await supertest(c.app)
      .post('/api/academic/programs')
      .set(c.owner)
      .send({ name: `${c.key} coerced boolean`, branchId: c.branchA, isActive: 'false' });

    expect(negativeProgram.status).toBe(400);
    expect(reversedSlot.status).toBe(400);
    expect(negativeRoom.status).toBe(400);
    expect(coercedBoolean.status).toBe(400);
  });

  it('keeps course offering identity correlated with linked classes and derives capacity', async () => {
    const c = seedContext();
    const offering = await supertest(c.app)
      .post('/api/offerings')
      .set(c.owner)
      .send({
        name: `${c.key} Offering`,
        branchId: c.branchA,
        programId: c.programA,
        programVersionId: c.versionA,
        levelId: c.levelA,
        academicTermId: c.termA,
        status: 'open',
      });
    expect(offering.status).toBe(201);

    const matchingClass = await createActiveClass(c, {
      name: `${c.key} matching`, capacity: 7, programId: c.programA, levelId: c.levelA, termId: c.termA,
    });
    const mismatchedClass = await createActiveClass(c, {
      name: `${c.key} mismatch`, capacity: 5, programId: c.programA2, levelId: c.levelA2, termId: c.termA,
    });

    const mismatch = await supertest(c.app)
      .post(`/api/offerings/${offering.body.id}/link-class`)
      .set(c.owner)
      .send({ classId: mismatchedClass });
    expect(mismatch.status).toBe(400);

    const linked = await supertest(c.app)
      .post(`/api/offerings/${offering.body.id}/link-class`)
      .set(c.owner)
      .send({ classId: matchingClass });
    expect(linked.status).toBe(200);

    const read = await supertest(c.app).get(`/api/offerings/${offering.body.id}`).set(c.owner);
    expect(read.status).toBe(200);
    expect(read.body.capacityTotal).toBe(7);
  });

  it('rejects malformed class and offering identity, status and date facts', async () => {
    const c = seedContext();
    const reversedClass = await supertest(c.app)
      .post('/api/classes')
      .set(c.owner)
      .send({
        name: `${c.key} reversed dates`,
        branchId: c.branchA,
        programId: c.programA,
        levelId: c.levelA,
        startDate: '2026-09-02',
        endDate: '2026-09-01',
      });
    const malformedClassDate = await supertest(c.app)
      .post('/api/classes')
      .set(c.owner)
      .send({ name: `${c.key} malformed date`, branchId: c.branchA, level: 'Ad hoc', startDate: '09/01/2026' });
    const invalidOfferingStatus = await supertest(c.app)
      .post('/api/offerings')
      .set(c.owner)
      .send({
        name: `${c.key} invalid offering`,
        branchId: c.branchA,
        programId: c.programA,
        programVersionId: c.versionA,
        levelId: c.levelA,
        academicTermId: c.termA,
        status: 'OPEN',
      });
    db.prepare("UPDATE program_versions SET status='archived' WHERE id=?").run(c.versionA);
    const archivedOffering = await supertest(c.app)
      .post('/api/offerings')
      .set(c.owner)
      .send({
        name: `${c.key} archived offering`,
        branchId: c.branchA,
        programId: c.programA,
        programVersionId: c.versionA,
        levelId: c.levelA,
        academicTermId: c.termA,
      });

    expect(reversedClass.status).toBe(400);
    expect(malformedClassDate.status).toBe(400);
    expect(invalidOfferingStatus.status).toBe(400);
    expect(archivedOffering.status).toBe(400);
  });

  it('does not transfer an unrelated live enrollment through a terminal source id', async () => {
    const c = seedContext();
    const fromClass = await createActiveClass(c, { name: `${c.key} from` });
    const toClass = await createActiveClass(c, { name: `${c.key} to` });
    const studentId = seedStudent(c, 'terminal-source');
    const liveId = enroll(c, studentId, fromClass, { semesterName: `${c.key} live` });
    const terminalId = `${c.key}_terminal`;
    db.prepare(`
      INSERT INTO enrollments
        (id,student_id,class_id,branch_id,enrollment_type,status,started_at,semester_name)
      VALUES (?,?,?,?,'new','dropped',date('now'),?)
    `).run(terminalId, studentId, fromClass, c.branchA, `${c.key} old`);

    const response = await supertest(c.app)
      .post(`/api/enrollments/${terminalId}/transfer-requests`)
      .set(c.owner)
      .send({ toClassId: toClass, reason: 'stale request' });

    expect(response.status).toBe(409);
    expect((db.prepare('SELECT status,class_id FROM enrollments WHERE id=?').get(liveId) as any)).toMatchObject({ status: 'active', class_id: fromClass });
  });

  it('rolls back the enrollment move if transfer-request persistence fails', async () => {
    const c = seedContext();
    const fromClass = await createActiveClass(c, { name: `${c.key} atomic from` });
    const toClass = await createActiveClass(c, { name: `${c.key} atomic to` });
    const studentId = seedStudent(c, 'atomic-transfer');
    const liveId = enroll(c, studentId, fromClass, { semesterName: `${c.key} atomic` });
    const trigger = `${c.key}_fail_transfer_request`.replace(/-/g, '_');
    db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON enrollment_transfer_requests BEGIN SELECT RAISE(ABORT, 'forced transfer request failure'); END;`);
    try {
      const response = await supertest(c.app)
        .post(`/api/enrollments/${liveId}/transfer-requests`)
        .set(c.owner)
        .send({ toClassId: toClass, reason: 'atomicity attack' });
      expect(response.status).toBe(500);
      expect((db.prepare('SELECT status,class_id FROM enrollments WHERE id=?').get(liveId) as any)).toMatchObject({ status: 'active', class_id: fromClass });
      expect((db.prepare("SELECT COUNT(*) c FROM enrollments WHERE student_id=? AND class_id=? AND status='active'").get(studentId, toClass) as any).c).toBe(0);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it('transfers only the source semester and preserves concurrent extra study', async () => {
    const c = seedContext();
    const fromClass = await createActiveClass(c, { name: `${c.key} main` });
    const extraClass = await createActiveClass(c, { name: `${c.key} extra` });
    const toClass = await createActiveClass(c, { name: `${c.key} destination` });
    const studentId = seedStudent(c, 'semester-scope');
    const sourceEnrollmentId = enroll(c, studentId, fromClass, { semesterName: `${c.key} Main`, enrollmentType: 'new' });
    enroll(c, studentId, extraClass, { semesterName: `${c.key} Extra`, enrollmentType: 'extra' });

    getEnrollmentService(db).transfer({ sourceEnrollmentId, toClassId: toClass, notes: 'move main only' });

    const extraSemester = db.prepare('SELECT status,class_id FROM student_semesters WHERE student_id=? AND semester_name=?')
      .get(studentId, `${c.key} Extra`) as any;
    expect(extraSemester).toMatchObject({ status: 'active', class_id: extraClass });
  });

  it('rolls back an enrollment freeze if freeze-history persistence fails', async () => {
    const c = seedContext();
    const classId = await createActiveClass(c, { name: `${c.key} freeze` });
    const studentId = seedStudent(c, 'atomic-freeze');
    const enrollmentId = enroll(c, studentId, classId, { semesterName: `${c.key} Freeze` });
    const trigger = `${c.key}_fail_freeze`.replace(/-/g, '_');
    db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON enrollment_freezes BEGIN SELECT RAISE(ABORT, 'forced freeze failure'); END;`);
    try {
      const response = await supertest(c.app)
        .post(`/api/enrollments/${enrollmentId}/freeze-requests`)
        .set(c.owner)
        .send({ reason: 'atomicity attack', days: 2 });
      expect(response.status).toBe(500);
      expect((db.prepare('SELECT status FROM enrollments WHERE id=?').get(enrollmentId) as any).status).toBe('active');
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it('correlates freeze, transfer-request and waitlist history at the storage boundary', async () => {
    const c = seedContext();
    const sourceClass = await createActiveClass(c, { name: `${c.key} history source` });
    const targetClass = await createActiveClass(c, { name: `${c.key} history target` });
    const studentId = seedStudent(c, 'history-scope');
    const otherStudentId = seedStudent(c, 'history-other');
    const enrollmentId = enroll(c, studentId, sourceClass, { semesterName: `${c.key} History` });
    const rejects = (write: () => unknown) => expect(write).toThrow();

    rejects(() => db.prepare(`INSERT INTO enrollment_freezes
      (id,enrollment_id,student_id,branch_id,reason,start_date,status)
      VALUES (?,?,?,?,?,'2026-09-01','active')`)
      .run(`${c.key}_freeze_active_drift`, enrollmentId, studentId, c.branchA, 'drift'));

    getEnrollmentService(db).freeze(enrollmentId, { reason: 'storage attack fixture' });
    rejects(() => db.prepare(`INSERT INTO enrollment_freezes
      (id,enrollment_id,student_id,branch_id,reason,start_date,status)
      VALUES (?,?,?,?,?,'2026-09-01','active')`)
      .run(`${c.key}_freeze_scope`, enrollmentId, otherStudentId, c.branchA, 'scope'));
    db.prepare(`INSERT INTO enrollment_freezes
      (id,enrollment_id,student_id,branch_id,reason,start_date,planned_end_date,status)
      VALUES (?,?,?,?,?,'2026-09-01','2026-09-02','active')`)
      .run(`${c.key}_freeze_valid`, enrollmentId, studentId, c.branchA, 'valid');
    rejects(() => db.prepare(`INSERT INTO enrollment_freezes
      (id,enrollment_id,student_id,branch_id,reason,start_date,status)
      VALUES (?,?,?,?,?,'2026-09-03','active')`)
      .run(`${c.key}_freeze_duplicate`, enrollmentId, studentId, c.branchA, 'duplicate'));
    rejects(() => db.prepare(`INSERT INTO enrollment_freezes
      (id,enrollment_id,student_id,branch_id,reason,start_date,planned_end_date,status)
      VALUES (?,?,?,?,?,'not-a-date','2026-09-01','completed')`)
      .run(`${c.key}_freeze_date`, enrollmentId, studentId, c.branchA, 'date'));

    db.prepare("UPDATE enrollment_freezes SET status='completed' WHERE id=?")
      .run(`${c.key}_freeze_valid`);
    getEnrollmentService(db).unfreeze(enrollmentId, { reason: 'prepare transfer request attack' });
    const insertTransfer = db.prepare(`INSERT INTO enrollment_transfer_requests
      (id,enrollment_id,student_id,from_class_id,to_class_id,branch_id,reason,status)
      VALUES (?,?,?,?,?,?,?,'pending')`);
    rejects(() => insertTransfer.run(
      `${c.key}_transfer_scope`, enrollmentId, otherStudentId, sourceClass, targetClass, c.branchA, 'scope',
    ));
    insertTransfer.run(
      `${c.key}_transfer_valid`, enrollmentId, studentId, sourceClass, targetClass, c.branchA, 'valid',
    );
    rejects(() => insertTransfer.run(
      `${c.key}_transfer_duplicate`, enrollmentId, studentId, sourceClass, targetClass, c.branchA, 'duplicate',
    ));

    rejects(() => db.prepare(`INSERT INTO class_waitlist
      (id,class_id,student_id,branch_id,status,position)
      VALUES (?,?,?,?,'waiting',0)`)
      .run(`${c.key}_waitlist_position`, targetClass, otherStudentId, c.branchA));
  });

  it('offers only a real open seat and preserves FIFO order', async () => {
    const c = seedContext();
    const classId = await createActiveClass(c, { name: `${c.key} queue`, capacity: 1 });
    const filler = seedStudent(c, 'filler');
    const fillerEnrollment = enroll(c, filler, classId, { semesterName: `${c.key} Fill` });
    const first = seedStudent(c, 'first');
    const second = seedStudent(c, 'second');
    const firstJoin = await supertest(c.app).post(`/api/classes/${classId}/waitlist`).set(c.owner).send({ studentId: first });
    const secondJoin = await supertest(c.app).post(`/api/classes/${classId}/waitlist`).set(c.owner).send({ studentId: second });
    expect(firstJoin.status).toBe(201);
    expect(secondJoin.status).toBe(201);

    const fullOffer = await supertest(c.app)
      .post(`/api/classes/${classId}/waitlist/${firstJoin.body.id}/offer`)
      .set(c.owner)
      .send({});
    expect(fullOffer.status).toBe(409);

    getEnrollmentService(db).complete(fillerEnrollment);
    const outOfOrder = await supertest(c.app)
      .post(`/api/classes/${classId}/waitlist/${secondJoin.body.id}/offer`)
      .set(c.owner)
      .send({});
    expect(outOfOrder.status).toBe(409);
    const inOrder = await supertest(c.app)
      .post(`/api/classes/${classId}/waitlist/${firstJoin.body.id}/offer`)
      .set(c.owner)
      .send({});
    expect(inOrder.status).toBe(200);
  });

  it('keeps performance scores behind the evaluation audit command', async () => {
    const c = seedContext();
    const created = await supertest(c.app)
      .post('/api/teachers')
      .set(c.owner)
      .send({ fullName: `${c.key} Teacher`, branchId: c.branchA, baseSalary: 1000, salaryType: 'fixed' });
    expect(created.status).toBe(201);

    const bypass = await supertest(c.app)
      .put(`/api/teachers/${created.body.id}`)
      .set(c.owner)
      .send({ performanceScore: 88 });
    expect(bypass.status).toBe(400);
    expect((db.prepare('SELECT performance_score FROM teachers WHERE id=?').get(created.body.id) as any).performance_score).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM teacher_evaluations WHERE teacher_id=?').get(created.body.id) as any).c).toBe(0);
  });

  it('does not deactivate a teacher while active teaching work remains', async () => {
    const c = seedContext();
    const teacher = await supertest(c.app)
      .post('/api/teachers')
      .set(c.owner)
      .send({ fullName: `${c.key} Active Teacher`, branchId: c.branchA, baseSalary: 1000, salaryType: 'fixed' });
    expect(teacher.status).toBe(201);
    await createActiveClass(c, { name: `${c.key} taught`, teacherId: teacher.body.id });

    const response = await supertest(c.app)
      .put(`/api/teachers/${teacher.body.id}`)
      .set(c.owner)
      .send({ status: 'inactive' });
    expect(response.status).toBe(409);
    expect((db.prepare('SELECT status FROM teachers WHERE id=?').get(teacher.body.id) as any).status).toBe('active');
  });

  it('forwards edited default skill rates from the UI store to the API', () => {
    const source = sourceOf(API_STORE);
    const editTeacher = source.slice(source.indexOf('const editTeacher = async'), source.indexOf('const deleteTeacher = async'));
    expect(editTeacher).toContain('defaultSkillRate?: number');
    expect(editTeacher).toMatch(/api\.put\(`\/teachers\/\$\{id\}`,[\s\S]*defaultSkillRate/);
  });
});

describe('WP-05 database backstop attacks', () => {
  it('rejects class lifecycle/status drift at the database boundary', () => {
    const c = seedContext();
    expect(() => db.prepare(`
      INSERT INTO classes (id,name,level,capacity,status,lifecycle_stage,fee,branch_id)
      VALUES (?,?, 'A1',10,'completed','scheduled',0,?)
    `).run(`${c.key}_drift`, `${c.key} Drift`, c.branchA)).toThrow();
  });

  it('rejects a subject linked to a level from another program version', () => {
    const c = seedContext();
    expect(() => db.prepare(`
      INSERT INTO subjects (id,program_version_id,level_id,code,name)
      VALUES (?,?,?,?,?)
    `).run(`${c.key}_subject`, c.versionA, c.levelA2, 'MIX', 'Mixed subject')).toThrow();
  });

  it('rejects offering and class rows that drift from the curriculum graph', () => {
    const c = seedContext();
    expect(() => db.prepare(`
      INSERT INTO course_offerings
        (id,program_id,program_version_id,level_id,branch_id,academic_term_id,name,status,fee_snapshot)
      VALUES (?,?,?,?,?,?,?,'draft',0)
    `).run(`${c.key}_bad_offering`, c.programA, c.versionA, c.levelA, c.branchB, c.termB, `${c.key} Bad Offering`)).toThrow();

    expect(() => db.prepare(`
      INSERT INTO classes
        (id,name,program_id,level_id,level,capacity,min_viable_size,status,lifecycle_stage,fee,branch_id)
      VALUES (?,?,?,?,?,10,1,'active','activated',0,?)
    `).run(`${c.key}_bad_class`, `${c.key} Bad Class`, c.programA, c.levelA, 'A', c.branchB)).toThrow();
  });

  it('enforces assignment branch, rate, date, session, uniqueness and workload limits in storage', async () => {
    const c = seedContext();
    const classId = await createActiveClass(c, { name: `${c.key} assignment class` });
    const otherClassId = await createActiveClass(c, { name: `${c.key} assignment other` });
    const teacherA = `${c.key}_teacher_a`;
    const teacherB = `${c.key}_teacher_b`;
    db.prepare(`INSERT INTO teachers (id,full_name,base_salary,salary_type,status,branch_id,joined_date)
      VALUES (?,?,0,'fixed','active',?,date('now'))`).run(teacherA, `${c.key} Teacher A`, c.branchA);
    db.prepare(`INSERT INTO teachers (id,full_name,base_salary,salary_type,status,branch_id,joined_date)
      VALUES (?,?,0,'fixed','active',?,date('now'))`).run(teacherB, `${c.key} Teacher B`, c.branchB);
    const skills = Array.from({ length: 7 }, (_, index) => `${c.key}_skill_${index}`);
    for (const [index, skillId] of skills.entries()) {
      db.prepare('INSERT INTO skills (id,name) VALUES (?,?)').run(skillId, `${c.key} Skill ${index}`);
    }
    const sessionId = `${c.key}_session`;
    const datedSessionId = `${c.key}_dated_session`;
    db.prepare(`INSERT INTO sessions (id,class_id,date,start_time,end_time,status,branch_id)
      VALUES (?,?,date('now'),'08:00','09:00','scheduled',?)`).run(sessionId, otherClassId, c.branchA);
    db.prepare(`INSERT INTO sessions (id,class_id,date,start_time,end_time,status,branch_id)
      VALUES (?,?,'2026-09-01','08:00','09:00','scheduled',?)`).run(datedSessionId, classId, c.branchA);

    const rejected = (write: () => unknown) => {
      try { write(); return false; } catch { return true; }
    };
    const insert = db.prepare(`INSERT INTO class_teacher_skills
      (id,class_id,teacher_id,skill_id,monthly_rate,branch_id,assignment_type,start_date,end_date,session_id)
      VALUES (?,?,?,?,?,?,'primary',?,?,?)`);

    const outcomes = [
      rejected(() => insert.run(`${c.key}_neg`, classId, teacherA, skills[0], -1, c.branchA, null, null, null)),
      rejected(() => insert.run(`${c.key}_dates`, classId, teacherA, skills[1], 0, c.branchA, '2026-09-02', '2026-09-01', null)),
      rejected(() => insert.run(`${c.key}_branch`, classId, teacherB, skills[2], 0, c.branchA, null, null, null)),
      rejected(() => insert.run(`${c.key}_session_bad`, classId, teacherA, skills[3], 0, c.branchA, null, null, sessionId)),
      rejected(() => insert.run(`${c.key}_session_date`, classId, teacherA, skills[3], 0, c.branchA, '2026-09-02', null, datedSessionId)),
    ];

    insert.run(`${c.key}_first`, classId, teacherA, skills[4], 0, c.branchA, null, null, null);
    outcomes.push(rejected(() => insert.run(`${c.key}_duplicate`, classId, teacherA, skills[4], 0, c.branchA, null, null, null)));
    insert.run(`${c.key}_second`, classId, teacherA, skills[5], 0, c.branchA, null, null, null);
    insert.run(`${c.key}_third`, classId, teacherA, skills[6], 0, c.branchA, null, null, null);
    outcomes.push(rejected(() => db.prepare(`INSERT INTO class_teacher_skills
      (id,class_id,teacher_id,skill_id,monthly_rate,branch_id,assignment_type)
      VALUES (?,?,?,?,0,?,'primary')`).run(`${c.key}_fourth`, classId, teacherA, skills[0], c.branchA)));

    expect(outcomes).toEqual([true, true, true, true, true, true, true]);
  });
});
