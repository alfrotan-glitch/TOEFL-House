/**
 * WP-03 adversarial authority tests.
 *
 * These cases were first executed against the recoverable WP-03 baseline
 * a215d495b27eb222d0d1f533aac710b61b3bbd9d. Each expectation describes the
 * intended invariant and initially failed, reproducing the defect before the
 * implementation changed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { assignRole, bearerFor, seedUser } from '../../support/identity.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import { journeyRouter } from '../../../routes/journey.routes.js';
import { id, today } from '../../../utils/ids.js';

const BRANCH_A = 'wp03_attack_a';
const BRANCH_B = 'wp03_attack_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students/:id/journey', journeyRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/visitors', visitorsRouter);
  app.use(errorHandler);
  return app;
}

function insertStudent(studentId: string, phone: string, status = 'active', branchId = BRANCH_A) {
  db.prepare(
    `INSERT INTO students
       (id, student_code, full_name, phone, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'male')`,
  ).run(studentId, `TH-${studentId}`, `Student ${studentId}`, phone, status, today(), branchId);
}

function insertClass(classId: string, branchId = BRANCH_A, fee = 5000) {
  db.prepare(
    `INSERT INTO classes
       (id, name, branch_id, status, lifecycle_stage, level, fee, capacity, gender_policy)
     VALUES (?, ?, ?, 'active', 'activated', 'A1', ?, 30, 'mixed')`,
  ).run(classId, `Class ${classId}`, branchId, fee);
}

function insertVisitor(visitorId: string, branchId = BRANCH_A, extra: Record<string, unknown> = {}) {
  const row = {
    phone: `079${String(Math.abs(visitorId.split('').reduce((n, c) => n + c.charCodeAt(0), 0))).padStart(7, '0').slice(-7)}`,
    tazkira: null,
    ...extra,
  } as { phone: string; tazkira: string | null };
  db.prepare(
    `INSERT INTO visitors
       (id, serial_no, full_name, phone, gender, source, stage, visit_date, status,
        branch_id, placement_status, tazkira_no)
     VALUES (?, ?, ?, ?, 'male', 'walk_in', 'lead', ?, 'visited', ?, 'not_started', ?)`,
  ).run(visitorId, `V-${visitorId}`, `Visitor ${visitorId}`, row.phone, today(), branchId, row.tazkira);
}

let app: express.Express;

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)')
    .run(BRANCH_A, 'WP03 Attack A', 'A');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)')
    .run(BRANCH_B, 'WP03 Attack B', 'B');
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('wp03_attack_registration_fee_a', ?, 'registration', 'Registration fee', 1500, 1, 1)
  `).run(BRANCH_A);
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('wp03_attack_registration_fee_b', ?, 'registration', 'Registration fee', 1500, 1, 1)
  `).run(BRANCH_B);

  seedUser({ id: 'wp03_gm', role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: 'wp03_data', role: 'data_entry', branchId: BRANCH_A });
  seedUser({ id: 'wp03_finance', role: 'finance_manager', branchId: BRANCH_A });
  seedUser({ id: 'wp03_split_finance', role: 'head_of_department', branchId: BRANCH_A });
  assignRole('wp03_split_finance', 'finance_manager', BRANCH_B, { isPrimary: false });
  seedUser({ id: 'wp03_owner', role: 'owner', branchId: BRANCH_A });
  db.prepare(`INSERT INTO teachers (id, full_name, branch_id, joined_date) VALUES ('wp03_teacher', 'WP03 Teacher', ?, ?)`).run(BRANCH_A, today());
  seedUser({ id: 'wp03_teacher_user', role: 'teacher', branchId: BRANCH_A, linkedTeacherId: 'wp03_teacher' });
  seedUser({
    id: 'wp03_misaligned', role: 'counselor', branchId: BRANCH_A,
    scopeType: 'branch', scopeId: BRANCH_B,
  });
  app = createApp();
});

describe('student admission and lifecycle attacks', () => {
  it('rejects non-money coercions and overpayment against a zero-fee semester', async () => {
    insertStudent('wp03_money', '0700003101');
    const coerced = await supertest(app)
      .post('/api/students/wp03_money/enroll-semester')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Coercion', tuitionAmount: true, amountPaidNow: true });
    expect(coerced.status).toBe(400);

    const zeroOverpay = await supertest(app)
      .post('/api/students/wp03_money/enroll-semester')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Zero Fee', tuitionAmount: 0, amountPaidNow: 500 });
    expect(zeroOverpay.status).toBe(400);

    const nonTextClass = await supertest(app)
      .post('/api/students/wp03_money/enroll-semester')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Bad class', classId: { nested: true }, tuitionAmount: 0 });
    expect(nonTextClass.status).toBe(400);
  });

  it('allows a legitimate paid repeat after the prior semester is completed', async () => {
    insertStudent('wp03_repeat', '0700003102');
    const first = await supertest(app)
      .post('/api/students/wp03_repeat/enroll-semester')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Repeatable', tuitionAmount: 1000, amountPaidNow: 1000 });
    expect(first.status).toBe(201);
    db.prepare("UPDATE student_semesters SET status='completed' WHERE id=?").run(first.body.semesterId);

    const second = await supertest(app)
      .post('/api/students/wp03_repeat/enroll-semester')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Repeatable', tuitionAmount: 1000, amountPaidNow: 1000 });
    expect(second.status).toBe(201);
  });

  it('refuses every enrollment entry point for a graduated student', async () => {
    insertStudent('wp03_graduate', '0700003103', 'graduated');
    const result = await supertest(app)
      .post('/api/students/wp03_graduate/journey/enrollments')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'After Graduation', enrollmentType: 'new', autoInvoice: false });
    expect(result.status).toBe(409);
  });

  it('suspends all active enrollments atomically with the student profile', async () => {
    insertStudent('wp03_multi', '0700003104');
    insertClass('wp03_multi_c1');
    insertClass('wp03_multi_c2');
    for (const classId of ['wp03_multi_c1', 'wp03_multi_c2']) {
      db.prepare(
        `INSERT INTO enrollments
           (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
         VALUES (?, 'wp03_multi', ?, ?, 'extra', 'active', ?)`,
      ).run(id('enr'), classId, BRANCH_A, today());
    }

    const result = await supertest(app)
      .post('/api/students/wp03_multi/suspend')
      .set(bearerFor('wp03_gm'))
      .send({ notes: 'whole-student hold' });
    expect(result.status).toBe(200);
    const statuses = db.prepare('SELECT status FROM enrollments WHERE student_id=? ORDER BY id')
      .all('wp03_multi') as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual(['suspended', 'suspended']);
    expect((db.prepare('SELECT status FROM students WHERE id=?').get('wp03_multi') as { status: string }).status)
      .toBe('suspended');

    const alternateResume = await supertest(app)
      .post('/api/students/wp03_multi/journey/enrollments')
      .set(bearerFor('wp03_gm'))
      .send({ semesterName: 'Bypass', enrollmentType: 'resume', autoInvoice: false });
    expect(alternateResume.status).toBe(409);

    const bypass = await supertest(app)
      .patch('/api/students/wp03_multi/status')
      .set(bearerFor('wp03_gm'))
      .send({ status: 'inactive' });
    expect(bypass.status).toBe(409);
    expect((db.prepare('SELECT status FROM students WHERE id=?').get('wp03_multi') as { status: string }).status)
      .toBe('suspended');
    const preservedEnrollments = db.prepare('SELECT status FROM enrollments WHERE student_id=? ORDER BY id')
      .all('wp03_multi') as Array<{ status: string }>;
    expect(preservedEnrollments.map((row) => row.status)).toEqual(['suspended', 'suspended']);
  });

  it('prevents profile editing from bypassing placement and ID-card workflows', async () => {
    insertStudent('wp03_shadow', '0700003105');
    const result = await supertest(app)
      .patch('/api/students/wp03_shadow')
      .set(bearerFor('wp03_data'))
      .send({ placementScore: { passed: true }, cardDesign: { primaryColor: 'free-card' } });
    expect(result.status).toBe(400);
    const row = db.prepare('SELECT placement_score, card_design FROM students WHERE id=?')
      .get('wp03_shadow') as { placement_score: string | null; card_design: string | null };
    expect(row).toEqual({ placement_score: null, card_design: null });
  });

  it('does not expose financial journey state under Student.View alone', async () => {
    insertStudent('wp03_private_finance', '0700003106');
    db.prepare(
      `INSERT INTO student_journey_events
         (id, student_id, event_type, occurred_at, branch_id, payload)
       VALUES (?, 'wp03_private_finance', 'journey.invoice_issued', ?, ?, ?)`,
    ).run(id('sje'), today(), BRANCH_A, JSON.stringify({ amount: 987654 }));

    const result = await supertest(app)
      .get('/api/students/wp03_private_finance/journey')
      .set(bearerFor('wp03_data'));
    expect(result.status).toBe(200);
    expect(result.body.state).not.toHaveProperty('finance');
    expect(result.body).not.toHaveProperty('financeSummary');
    expect(result.body.financialTimeline).toEqual([]);
  });

  it('does not let finance authority from another branch unredact this student journey', async () => {
    insertStudent('wp03_split_finance_student', '0700003120');
    db.prepare(
      `INSERT INTO student_journey_events
         (id, student_id, event_type, occurred_at, branch_id, payload)
       VALUES (?, 'wp03_split_finance_student', 'journey.enrollment_created', ?, ?, ?),
              (?, 'wp03_split_finance_student', 'journey.invoice_issued', ?, ?, ?)`,
    ).run(
      id('sje'), today(), BRANCH_A, JSON.stringify({ classId: 'safe', tuitionAmount: 456789 }),
      id('sje'), today(), BRANCH_A, JSON.stringify({ invoiceNumber: 'CROSS-BRANCH-SECRET', amount: 456789 }),
    );

    const result = await supertest(app)
      .get('/api/students/wp03_split_finance_student/journey')
      .set(bearerFor('wp03_split_finance'));
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty('financeSummary');
    expect(result.body.financialTimeline).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('456789');
    expect(JSON.stringify(result.body)).not.toContain('CROSS-BRANCH-SECRET');

    const directFinance = await supertest(app)
      .get('/api/students/wp03_split_finance_student/journey/finance-timeline')
      .set(bearerFor('wp03_split_finance'));
    expect(directFinance.status).toBe(403);

    const profile = await supertest(app)
      .get('/api/students/wp03_split_finance_student')
      .set(bearerFor('wp03_split_finance'));
    expect(profile.status).toBe(200);
    expect(profile.body).not.toHaveProperty('discountPercent');
    expect(profile.body).not.toHaveProperty('installmentPlan');
    expect(profile.body).not.toHaveProperty('balance');

    const exported = await supertest(app)
      .get('/api/students/export')
      .set(bearerFor('wp03_split_finance'));
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain('Total Fee');
    expect(exported.text).not.toContain('Debt');

    db.prepare(
      `INSERT INTO student_semesters
         (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, 'wp03_split_finance_student', 'Debt term', ?, 1000, 1000, 'active')`,
    ).run(id('sem'), today());
    const heldEnrollment = await supertest(app)
      .post('/api/students/wp03_split_finance_student/enroll-semester')
      .set(bearerFor('wp03_split_finance'))
      .send({ semesterName: 'Cross-branch override attempt', tuitionAmount: 0, amountPaidNow: 0 });
    expect(heldEnrollment.status).toBe(403);
  });

  it('refuses a journey event linked to another student enrollment', async () => {
    insertStudent('wp03_event_a', '0700003107');
    insertStudent('wp03_event_b', '0700003108');
    db.prepare(
      `INSERT INTO enrollments
         (id, student_id, branch_id, enrollment_type, status, started_at)
       VALUES ('wp03_foreign_enrollment', 'wp03_event_b', ?, 'new', 'active', ?)`,
    ).run(BRANCH_A, today());

    const result = await supertest(app)
      .post('/api/students/wp03_event_a/journey/events')
      .set(bearerFor('wp03_gm'))
      .send({ eventType: 'journey.note_added', enrollmentId: 'wp03_foreign_enrollment', payload: { note: 'wrong student' } });
    expect(result.status).toBe(409);
  });

  it('normalizes every non-digit phone separator before enforcing student identity', async () => {
    insertStudent('wp03_phone_existing', '0700.111.001');
    const result = await supertest(app)
      .post('/api/students/manual')
      .set(bearerFor('wp03_gm'))
      .send({ fullName: 'Duplicate Phone', phone: '+93 700111001', gender: 'male', branchId: BRANCH_A });
    expect(result.status).toBe(409);
  });

  it('does not create a manual student over an existing visitor Tazkira identity', async () => {
    insertVisitor('wp03_taz_visitor', BRANCH_A, { phone: '0700003199', tazkira: 'WP03-TAZ-1' });
    const result = await supertest(app)
      .post('/api/students/manual')
      .set(bearerFor('wp03_gm'))
      .send({ fullName: 'Duplicate Tazkira', phone: '0700003109', gender: 'male', tazkiraNo: 'WP03-TAZ-1', branchId: BRANCH_A });
    expect(result.status).toBe(409);
  });

  it('enforces phone syntax and cross-table Tazkira identity behind HTTP routes', () => {
    expect(() => insertStudent('wp03_bad_phone', '---...///')).toThrow(/invalid student phone/i);
    insertVisitor('wp03_schema_taz', BRANCH_A, { phone: '0700003110', tazkira: 'WP03-TAZ-SCHEMA' });
    expect(() => db.prepare(
      `INSERT INTO students (id, student_code, full_name, phone, status, registration_date, branch_id, gender, tazkira_no)
       VALUES ('wp03_schema_taz_student', 'TH-WP03-SCHEMA', 'Schema clash', '0700003111', 'active', ?, ?, 'male', 'WP03-TAZ-SCHEMA')`
    ).run(today(), BRANCH_A)).toThrow(/Tazkira conflicts with visitor/i);
  });

  it('requires the workflow permission itself instead of accepting a neighboring permission', async () => {
    insertStudent('wp03_exact_guard', '0700003112');
    insertClass('wp03_exact_guard_class');
    const assignWithEditOnly = await supertest(app)
      .post('/api/students/wp03_exact_guard/enroll-class')
      .set(bearerFor('wp03_data'))
      .send({ classId: 'wp03_exact_guard_class' });
    expect(assignWithEditOnly.status).toBe(403);

    const printWithPaymentOnly = await supertest(app)
      .post('/api/students/wp03_exact_guard/issue-card')
      .set(bearerFor('wp03_finance'))
      .send({ cardDesign: { primaryColor: '#000000', bgStyle: 'solid' } });
    expect(printWithPaymentOnly.status).toBe(403);
  });

  it('resumes every enrollment and its matching semester as one student lifecycle operation', async () => {
    insertStudent('wp03_resume_all', '0700003113');
    for (const classId of ['wp03_resume_c1', 'wp03_resume_c2']) {
      insertClass(classId);
      const enrollmentId = id('enr');
      db.prepare(
        `INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
         VALUES (?, 'wp03_resume_all', ?, ?, 'extra', 'active', ?)`
      ).run(enrollmentId, classId, BRANCH_A, today());
      db.prepare(
        `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
         VALUES (?, 'wp03_resume_all', ?, ?, ?, 5000, 'active')`
      ).run(id('sem'), `Term ${classId}`, classId, today());
    }
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
       VALUES ('wp03_old_deferred_sem', 'wp03_resume_all', 'Historical deferred', 'wp03_resume_c1', ?, 5000, 'deferred')`
    ).run(today());

    const suspended = await supertest(app)
      .post('/api/students/wp03_resume_all/suspend')
      .set(bearerFor('wp03_gm')).send({ notes: 'temporary hold' });
    expect(suspended.status).toBe(200);

    const resumed = await supertest(app)
      .post('/api/students/wp03_resume_all/resume')
      .set(bearerFor('wp03_gm')).send({ notes: 'return' });
    expect(resumed.status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) c FROM enrollments WHERE student_id='wp03_resume_all' AND status='active'").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM student_semesters WHERE student_id='wp03_resume_all' AND status='active'").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT status FROM student_semesters WHERE id='wp03_old_deferred_sem'").get() as { status: string }).status).toBe('deferred');
    expect((db.prepare("SELECT status FROM students WHERE id='wp03_resume_all'").get() as { status: string }).status).toBe('active');

    // Historical rows without a suspension batch are ambiguous: a deferred
    // semester in the same class may predate the suspension. Fail closed rather
    // than reviving it by class alone.
    insertStudent('wp03_resume_unmapped', '0700003121', 'suspended');
    db.prepare(
      `INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
       VALUES ('wp03_unmapped_enrollment', 'wp03_resume_unmapped', 'wp03_resume_c1', ?, 'resume', 'suspended', ?)`,
    ).run(BRANCH_A, today());
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
       VALUES ('wp03_unmapped_semester', 'wp03_resume_unmapped', 'Unmapped history', 'wp03_resume_c1', ?, 5000, 'deferred')`,
    ).run(today());

    const unmapped = await supertest(app)
      .post('/api/students/wp03_resume_unmapped/resume')
      .set(bearerFor('wp03_gm')).send({ notes: 'ambiguous return' });
    expect(unmapped.status).toBe(409);
    expect((db.prepare("SELECT status FROM students WHERE id='wp03_resume_unmapped'").get() as { status: string }).status).toBe('suspended');
    expect((db.prepare("SELECT status FROM enrollments WHERE id='wp03_unmapped_enrollment'").get() as { status: string }).status).toBe('suspended');
    expect((db.prepare("SELECT status FROM student_semesters WHERE id='wp03_unmapped_semester'").get() as { status: string }).status).toBe('deferred');
  });

  it('bounds supplemental student workflow payloads at their write boundaries', async () => {
    insertStudent('wp03_bounded_student', '0700003115');

    const badManualForeignId = await supertest(app)
      .post('/api/students/manual')
      .set(bearerFor('wp03_gm'))
      .send({ fullName: 'Bad class id', phone: '0700003117', gender: 'male', classId: { nested: true } });
    expect(badManualForeignId.status).toBe(400);

    const badPaymentReference = await supertest(app)
      .post('/api/students/wp03_bounded_student/payments')
      .set(bearerFor('wp03_gm'))
      .send({ category: 'other', paymentMethod: 'cash', amount: 10, semesterId: { nested: 'not-an-id' } });
    expect(badPaymentReference.status).toBe(400);

    const badPaymentMethod = await supertest(app)
      .post('/api/students/wp03_bounded_student/payments')
      .set(bearerFor('wp03_gm'))
      .send({ category: 'other', paymentMethod: 'crypto', amount: 10, notes: 'unsupported tender' });
    expect(badPaymentMethod.status).toBe(400);

    const badCardDesign = await supertest(app)
      .post('/api/students/wp03_bounded_student/issue-card')
      .set(bearerFor('wp03_gm'))
      .send({ cardDesign: ['not', 'an', 'object'] });
    expect(badCardDesign.status).toBe(400);

    const nonTextIdentity = await supertest(app)
      .patch('/api/students/wp03_bounded_student')
      .set(bearerFor('wp03_data'))
      .send({ fullName: true });
    expect(nonTextIdentity.status).toBe(400);

    const oversizedPlan = await supertest(app)
      .patch('/api/students/wp03_bounded_student')
      .set(bearerFor('wp03_data'))
      .send({ installmentPlan: Array.from({ length: 101 }, (_, i) => ({ id: `i-${i}`, amount: 1 })) });
    expect(oversizedPlan.status).toBe(400);
  });

  it('overlays the canonical student placement snapshot instead of stale journey events', async () => {
    insertStudent('wp03_placement_state', '0700003116');
    db.prepare('UPDATE students SET placement_score=? WHERE id=?')
      .run(JSON.stringify({
        percentage: 88,
        totalScore: 88,
        outcome: 'passed',
        recommendation: { levelId: 'level-b2', text: 'B2 recommended' },
        results: [{ component_key: 'reading', score: 90 }],
      }), 'wp03_placement_state');
    db.prepare(
      `INSERT INTO student_journey_events (id, student_id, event_type, occurred_at, branch_id, payload)
       VALUES (?, 'wp03_placement_state', 'journey.placement_test_recorded', ?, ?, ?)`,
    ).run(id('sje'), today(), BRANCH_A, JSON.stringify({ overall: 10, recommendedLevel: 'A1' }));

    const result = await supertest(app)
      .get('/api/students/wp03_placement_state/journey')
      .set(bearerFor('wp03_data'));
    expect(result.status).toBe(200);
    expect(result.body.state.placement).toMatchObject({
      overall: 88,
      recommendedLevel: 'B2 recommended',
      passed: true,
      scores: { reading: 90 },
    });
  });

  it('keeps CSV export inside the same class-object scope as the student roster', async () => {
    insertStudent('wp03_teacher_visible', '0700003118');
    insertStudent('wp03_teacher_hidden', '0700003119');
    insertClass('wp03_teacher_class');
    db.prepare("UPDATE classes SET teacher_id='wp03_teacher' WHERE id='wp03_teacher_class'").run();
    db.prepare(
      `INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
       VALUES (?, 'wp03_teacher_visible', 'wp03_teacher_class', ?, 'new', 'active', ?)`,
    ).run(id('enr'), BRANCH_A, today());

    const result = await supertest(app)
      .get('/api/students/export')
      .set(bearerFor('wp03_teacher_user'));
    expect(result.status).toBe(200);
    expect(result.text).toContain('TH-wp03_teacher_visible');
    expect(result.text).not.toContain('TH-wp03_teacher_hidden');
  });

  it('redacts financial event rows and lifecycle money fields from Student.View-only journeys', async () => {
    insertStudent('wp03_timeline_redact', '0700003114');
    db.prepare(
      `INSERT INTO student_journey_events (id, student_id, event_type, occurred_at, branch_id, payload)
       VALUES (?, 'wp03_timeline_redact', 'journey.enrollment_created', ?, ?, ?),
              (?, 'wp03_timeline_redact', 'journey.invoice_issued', ?, ?, ?)`
    ).run(
      id('sje'), today(), BRANCH_A, JSON.stringify({
        classId: 'safe-class',
        fee: 12345,
        details: { tuitionBalance: 54321, label: 'safe-label' },
      }),
      id('sje'), today(), BRANCH_A, JSON.stringify({ amount: 12345, invoiceNumber: 'SECRET' }),
    );
    const result = await supertest(app)
      .get('/api/students/wp03_timeline_redact/journey')
      .set(bearerFor('wp03_data'));
    expect(result.status).toBe(200);
    expect(result.body.timeline).toHaveLength(1);
    expect(result.body.timeline[0].payload).toEqual({ classId: 'safe-class', details: { label: 'safe-label' } });
    expect(JSON.stringify(result.body)).not.toContain('12345');
    expect(JSON.stringify(result.body)).not.toContain('54321');
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
  });
});

describe('visitor admission and conversion attacks', () => {
  it('does not treat the account home branch as an authorization grant', async () => {
    const result = await supertest(app)
      .post('/api/visitors')
      .set(bearerFor('wp03_misaligned'))
      .send({ fullName: 'Unauthorized Home Lead', phone: '0700003201', gender: 'male', source: 'walk_in', branchId: BRANCH_A });
    expect(result.status).toBe(403);
  });

  it('keeps a converted student in the originating visitor branch', async () => {
    insertVisitor('wp03_cross_convert', BRANCH_A, { phone: '0700003202' });
    insertClass('wp03_cross_class', BRANCH_B, 5000);
    const result = await supertest(app)
      .post('/api/visitors/wp03_cross_convert/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: 'wp03_cross_class', branchId: BRANCH_B });
    expect(result.status).toBe(400);
    expect(db.prepare('SELECT id FROM students WHERE lead_id=?').get('wp03_cross_convert')).toBeUndefined();
  });

  it('rejects legacy client fee overrides on conversion; pricing belongs to later enrollment', async () => {
    insertVisitor('wp03_fee_override', BRANCH_A, { phone: '0700003203' });
    insertClass('wp03_fee_class', BRANCH_A, 5000);
    const result = await supertest(app)
      .post('/api/visitors/wp03_fee_override/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: 'wp03_fee_class', branchId: BRANCH_A, semesterFee: 1, amountPaid: 1 });
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/no longer collects payment|creates enrollment directly/i);
    expect(db.prepare('SELECT id FROM students WHERE lead_id=?').get('wp03_fee_override')).toBeUndefined();
  });

  it('applies create-grade validation to the CRM update path', async () => {
    insertVisitor('wp03_crm_validation', BRANCH_A, { phone: '0700003204' });
    const result = await supertest(app)
      .patch('/api/visitors/wp03_crm_validation/crm')
      .set(bearerFor('wp03_gm'))
      .send({ nextContactDate: '9999-99-99', notes: 'x'.repeat(100_000) });
    expect(result.status).toBe(400);
  });

  it('requires and persists the next contact date for callback follow-ups', async () => {
    insertVisitor('wp03_callback', BRANCH_A, { phone: '0700003205' });
    const missing = await supertest(app)
      .post('/api/visitors/wp03_callback/followups')
      .set(bearerFor('wp03_gm'))
      .send({ notes: 'Call again', outcome: 'callback' });
    expect(missing.status).toBe(400);

    const callbackDate = new Date();
    callbackDate.setDate(callbackDate.getDate() + 2);
    const callbackDateIso = callbackDate.toLocaleDateString('en-CA');
    const accepted = await supertest(app)
      .post('/api/visitors/wp03_callback/followups')
      .set(bearerFor('wp03_gm'))
      .send({ notes: 'Call again', outcome: 'callback', nextContactDate: callbackDateIso });
    expect(accepted.status).toBe(201);
    expect((db.prepare("SELECT next_contact_date FROM visitors WHERE id='wp03_callback'").get() as { next_contact_date: string }).next_contact_date).toBe(callbackDateIso);
  });

  it('rejects non-text visitor foreign IDs and unauthorized discount transformations', async () => {
    const invalidPhoneCreate = await supertest(app)
      .post('/api/visitors')
      .set(bearerFor('wp03_owner'))
      .send({ fullName: 'Invalid Phone', phone: 'not-a-phone', gender: 'male', source: 'walk_in' });
    expect(invalidPhoneCreate.status).toBe(400);

    const invalidCreate = await supertest(app)
      .post('/api/visitors')
      .set(bearerFor('wp03_owner'))
      .send({ fullName: 'Invalid Campaign', phone: '0700003207', gender: 'male', source: 'walk_in', campaignId: { id: 'nested' } });
    expect(invalidCreate.status).toBe(400);

    insertVisitor('wp03_invalid_foreign_id', BRANCH_A, { phone: '0700003208' });
    const invalidPhonePatch = await supertest(app)
      .patch('/api/visitors/wp03_invalid_foreign_id')
      .set(bearerFor('wp03_owner'))
      .send({ phone: 'not-a-phone' });
    expect(invalidPhonePatch.status).toBe(400);

    const invalidPatch = await supertest(app)
      .patch('/api/visitors/wp03_invalid_foreign_id')
      .set(bearerFor('wp03_owner'))
      .send({ assignedTo: ['not-an-id'] });
    expect(invalidPatch.status).toBe(400);

    const invalidConversionId = await supertest(app)
      .post('/api/visitors/wp03_invalid_foreign_id/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: { nested: true } });
    expect(invalidConversionId.status).toBe(400);

    insertVisitor('wp03_invalid_phone_convert', BRANCH_A, { phone: 'not-a-phone' });
    insertClass('wp03_invalid_phone_class', BRANCH_A, 5000);
    const invalidPhoneConversion = await supertest(app)
      .post('/api/visitors/wp03_invalid_phone_convert/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: 'wp03_invalid_phone_class' });
    expect(invalidPhoneConversion.status).toBe(400);
    expect(db.prepare("SELECT id FROM students WHERE lead_id='wp03_invalid_phone_convert'").get()).toBeUndefined();

    insertVisitor('wp03_discount_transform', BRANCH_A, { phone: '0700003209' });
    insertClass('wp03_discount_class', BRANCH_A, 5000);
    const unauthorizedDiscount = await supertest(app)
      .post('/api/visitors/wp03_discount_transform/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: 'wp03_discount_class', semesterFee: 5000, discountPercent: 30, amountPaid: 0 });
    expect(unauthorizedDiscount.status).toBe(409);
    expect(db.prepare("SELECT id FROM students WHERE lead_id='wp03_discount_transform'").get()).toBeUndefined();
  });

  it('keeps visitor conversion admission-only so late enrollment eligibility is deferred to the student workspace', async () => {
    db.prepare("INSERT INTO programs (id, name, branch_id) VALUES ('wp03_atomic_program', 'Atomic Program', ?)").run(BRANCH_A);
    db.prepare("INSERT INTO program_versions (id, program_id, version_label, version_number, status) VALUES ('wp03_atomic_version', 'wp03_atomic_program', 'v1', 1, 'published')").run();
    db.prepare(`INSERT INTO levels (id, program_id, name, "order", program_version_id, code, default_fee)
                VALUES ('wp03_atomic_level', 'wp03_atomic_program', 'Level 2', 2, 'wp03_atomic_version', 'L2', 5000)`).run();
    db.prepare(`INSERT INTO placement_assessment_profiles
                (id, program_version_id, branch_id, requirement_mode, first_level_exempt, components_json)
                VALUES ('wp03_atomic_profile', 'wp03_atomic_version', ?, 'required', 0, ?)`)
      .run(BRANCH_A, JSON.stringify([{ key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, bankIds: ['gate-grammar'], blueprintBuckets: [{ count: 30, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },{ key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, bankIds: ['gate-reading'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },{ key: 'listening', type: 'listening', label: 'Listening', required: true, weight: 16.67, maxScore: 20, bankIds: ['gate-listening'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },{ key: 'writing', type: 'writing', label: 'Writing', required: true, weight: 20.83, maxScore: 25, bankIds: ['gate-writing'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['essay'] }] },{ key: 'speaking', type: 'speaking', label: 'Speaking', required: true, weight: 20.83, maxScore: 25, bankIds: ['gate-speaking'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['speaking'] }] }]));
    insertVisitor('wp03_atomic_visitor', BRANCH_A, { phone: '0700003206' });
    insertClass('wp03_atomic_class', BRANCH_A, 5000);
    db.prepare("UPDATE classes SET level_id='wp03_atomic_level', program_id='wp03_atomic_program' WHERE id='wp03_atomic_class'").run();

    const result = await supertest(app)
      .post('/api/visitors/wp03_atomic_visitor/convert')
      .set(bearerFor('wp03_owner'))
      .send({ classId: 'wp03_atomic_class', branchId: BRANCH_A });
    expect(result.status).toBe(201);
    const student = db.prepare("SELECT id FROM students WHERE lead_id='wp03_atomic_visitor'").get() as { id: string } | undefined;
    expect(student).toBeDefined();
    expect((db.prepare("SELECT status, stage, placement_requirement_mode FROM visitors WHERE id='wp03_atomic_visitor'").get() as Record<string, unknown>))
      .toMatchObject({ status: 'registered', stage: 'placement_booking', placement_requirement_mode: null });
    expect((db.prepare('SELECT COUNT(*) c FROM enrollments WHERE student_id = ?').get(student!.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM student_semesters WHERE student_id = ?').get(student!.id) as { c: number }).c).toBe(0);
  });
});
