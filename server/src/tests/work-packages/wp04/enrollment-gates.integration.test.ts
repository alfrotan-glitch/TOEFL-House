import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { assertPlacementEligibleForClass, resolveGoverningProgramVersionId } from '../../../core/placement/enrollment-gate.js';
import { evaluateConversionEligibility, evaluateEnrollmentEligibility } from '../../../core/placement/placement-policy.js';
import { canonicalComponents, canonicalDecisionRules, putProfile, scoreAndComplete, seedContext, startAttempt } from './fixtures.js';
import { id, today } from '../../../utils/ids.js';

function seedStudentAndClass(context: ReturnType<typeof seedContext>, leadId: string | null = context.visitorId) {
  const existing = leadId
    ? (db.prepare('SELECT id FROM students WHERE lead_id = ? LIMIT 1').get(leadId) as { id: string } | undefined)
    : undefined;
  const studentId = existing?.id ?? `${context.key}_student`;
  const classId = `${context.key}_class`;
  if (!existing) {
    db.prepare(`INSERT INTO students
      (id,student_code,full_name,registration_date,branch_id,gender,lead_id)
      VALUES (?,?,?,date('now'),?,'male',?)`)
      .run(studentId, `${context.key}-STU`, `${context.key} Student`, context.branchA, leadId);
  }
  db.prepare(`INSERT OR IGNORE INTO classes
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
    expect((await putProfile(context, { allowRetake: true, firstAttemptBillable: false })).status).toBe(200);
    const first = await startAttempt(context);
    expect((await scoreAndComplete(context, first.body.id, { grammar: 0, reading: 0, listening: 0, writing: 0, speaking: 0 })).completed.body.outcome).toBe('failed');
    const { studentId, classId } = seedStudentAndClass(context);
    db.prepare('UPDATE visitors SET program_version_id=NULL WHERE id=?').run(context.visitorId);
    const denied = await enrollExtra(context, studentId, classId);
    expect(denied.status).toBe(400);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();

    db.prepare('UPDATE visitors SET program_version_id=? WHERE id=?').run(context.versionA, context.visitorId);
    const second = await startAttempt(context);
    expect((await scoreAndComplete(context, second.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 })).completed.body.outcome).toBe('passed');
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
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score,decision_rules_json)
      VALUES (?,?,?,?,?,'canonical',60,?)`)
      .run(
        `${context.key}_outside`,
        context.versionA,
        context.branchB,
        'required',
        JSON.stringify(canonicalComponents(context)),
        JSON.stringify(canonicalDecisionRules(context)),
      );
    const { studentId, classId } = seedStudentAndClass(context, null);
    expect(() => assertPlacementEligibleForClass(db, studentId, classId, context.branchA)).toThrow(/not configured/i);
    const response = await enrollExtra(context, studentId, classId);
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();
  });

  it('blocks extra-class enrollment when required non-tuition invoices remain unpaid', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const { studentId, classId } = seedStudentAndClass(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    expect((await scoreAndComplete(context, started.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 })).completed.body.outcome).toBe('passed');

    db.prepare(`
      INSERT INTO invoices
        (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, charge_kind, purpose)
      VALUES (?, ?, 1000, 0, 1000, 'issued', ?, ?, ?, 'Registration fee', ?, 'Tester', 'registration', 'other')
    `).run(id('inv'), studentId, today(), today(), context.branchA, `${context.key}-INV-HOLD`);

    const blocked = await enrollExtra(context, studentId, classId);
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toContain('Academic Hold');
    expect(String(blocked.body.error)).toContain('1100');
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();
  });

  it('blocks enrollment above the placement-recommended level', async () => {
    const context = seedContext();
    expect((await putProfile(context, { passScore: 10 })).status).toBe(200);
    const { studentId, classId } = seedStudentAndClass(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    expect((await scoreAndComplete(context, started.body.id, { grammar: 5, reading: 3, listening: 3, writing: 8, speaking: 8 })).completed.body.outcome).toBe('passed');

    const blocked = await enrollExtra(context, studentId, classId);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.error)).toContain('authorized level');
    expect(String(blocked.body.error)).toContain('A1');
    expect(String(blocked.body.error)).toContain('A2');
    expect(db.prepare('SELECT id FROM enrollments WHERE student_id=? AND class_id=?').get(studentId, classId)).toBeUndefined();
  });
});
