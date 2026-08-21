import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { assertPlacementEligibleForClass, resolveGoverningProgramVersionId } from '../../../core/placement/enrollment-gate.js';
import { evaluateConversionEligibility, evaluateEnrollmentEligibility } from '../../../core/placement/placement-policy.js';
import { putProfile, scoreAndComplete, scoreComponent, seedContext, startAttempt } from './fixtures.js';

function seedStudentAndClass(context: ReturnType<typeof seedContext>, leadId: string | null = context.visitorId) {
  const studentId = `${context.key}_student`;
  const classId = `${context.key}_class`;
  db.prepare(`INSERT INTO students
    (id,student_code,full_name,registration_date,branch_id,gender,lead_id)
    VALUES (?,?,?,date('now'),?,'male',?)`)
    .run(studentId, `${context.key}-STU`, `${context.key} Student`, context.branchA, leadId);
  db.prepare(`INSERT INTO classes
    (id,name,program_id,level_id,level,status,lifecycle_stage,fee,branch_id,gender_policy,capacity)
    VALUES (?,?,?,?,?,'active','enrollment_open',0,?,'mixed',20)`)
    .run(classId, `${context.key} Class`, context.programA, context.levelA2, 'A2', context.branchA);
  return { studentId, classId };
}

async function enrollExtra(context: ReturnType<typeof seedContext>, studentId: string, classId: string) {
  return supertest(context.app)
    .post(`/api/students/${studentId}/enroll-class`)
    .set(context.receptionistA)
    .send({ classId, amountPaidNow: 0 });
}

describe('WP-04 conversion and enrollment placement gates', () => {
  it('makes completed failure outrank optional policy while preserving explicit waiver as a distinct state', () => {
    expect(evaluateConversionEligibility('optional', 'completed', { status: 'completed', outcome: 'failed' }).eligible).toBe(false);
    expect(evaluateConversionEligibility('optional', 'waived', { status: 'completed', outcome: 'failed' })).toMatchObject({ eligible: true, reason: 'waived' });
    expect(evaluateEnrollmentEligibility('required', { placementStatus: 'completed', attempt: { status: 'completed', outcome: 'failed' }, hasVisitorRecord: true }).eligible).toBe(false);
    expect(evaluateEnrollmentEligibility('required', { placementStatus: 'completed', attempt: { status: 'completed', outcome: 'passed' }, hasVisitorRecord: true }).eligible).toBe(true);
  });

  it('resolves the governing program from the class level before any caller-supplied fallback', () => {
    const resolved = resolveGoverningProgramVersionId(
      { level_id: 'class-level', program_version_id: 'class-hint' },
      'visitor-program',
      (levelId) => levelId === 'class-level' ? 'level-program' : null,
    );
    expect(resolved).toBe('level-program');
    expect(resolveGoverningProgramVersionId({ level_id: null }, 'visitor-program')).toBe('visitor-program');
  });

  it('blocks an unlinked student from a placement-required class through both shared enrollment consumers', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const { studentId, classId } = seedStudentAndClass(context, null);
    expect(() => assertPlacementEligibleForClass(db, studentId, classId, context.branchA)).toThrow(/placement assessment/i);
    const extra = await enrollExtra(context, studentId, classId);
    expect(extra.status).toBe(400);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();

    expect(() => getEnrollmentService(db).enroll({
      studentId,
      branchId: context.branchA,
      semesterName: 'Current',
      classId,
      enrollmentType: 'new',
      actorUserId: context.receptionistAId,
      actorName: 'Receptionist',
      autoInvoice: false,
    })).toThrow(/placement assessment/i);
  });

  it('blocks a failed candidate even if the visitor program link is detached, then admits the latest passing result', async () => {
    const context = seedContext();
    expect((await putProfile(context, { passScore: 60, allowRetake: true, firstAttemptBillable: false })).status).toBe(200);
    const first = await startAttempt(context);
    expect((await scoreAndComplete(context, first.body.id, 20)).completed.body.outcome).toBe('failed');
    const { studentId, classId } = seedStudentAndClass(context);
    db.prepare('UPDATE visitors SET program_version_id=NULL WHERE id=?').run(context.visitorId);
    const denied = await enrollExtra(context, studentId, classId);
    expect(denied.status).toBe(400);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();

    db.prepare('UPDATE visitors SET program_version_id=? WHERE id=?').run(context.versionA, context.visitorId);
    const second = await startAttempt(context);
    expect((await scoreAndComplete(context, second.body.id, 90)).completed.body.outcome).toBe('passed');
    const enrolled = await enrollExtra(context, studentId, classId);
    expect(enrolled.status).toBe(201);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeDefined();
  });

  it('allows a class whose canonical requirement mode is not_required without fabricating a waiver', async () => {
    const context = seedContext();
    expect((await putProfile(context, { requirementMode: 'not_required', components: [] })).status).toBe(200);
    const { studentId, classId } = seedStudentAndClass(context, null);
    const enrolled = await enrollExtra(context, studentId, classId);
    expect(enrolled.status).toBe(201);
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(context.visitorId) as any).placement_status).toBe('not_started');
  });

  it('fails closed when placement policy exists only outside the applicable branch hierarchy', async () => {
    const context = seedContext();
    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score)
      VALUES (?,?,?,?,?,'weighted_average',60)`)
      .run(`${context.key}_outside`, context.versionA, context.branchB, 'required', JSON.stringify([scoreComponent()]));
    const { studentId, classId } = seedStudentAndClass(context, null);
    expect(() => assertPlacementEligibleForClass(db, studentId, classId, context.branchA)).toThrow(/not configured/i);
    const response = await enrollExtra(context, studentId, classId);
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();
  });
});
