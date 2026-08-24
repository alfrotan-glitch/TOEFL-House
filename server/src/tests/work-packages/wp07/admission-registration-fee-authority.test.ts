import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';

const OWNER_BRANCH = 'wp07_reg_fee_owner_branch';
const OWNER = 'wp07_reg_fee_owner';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/visitors', visitorsRouter);
  app.use(errorHandler);
  return app;
}

const auth = () => bearerFor(OWNER);
let phoneSeq = 0;
const nextPhone = () => `079${String(1_000_000 + (phoneSeq += 1)).slice(-7)}`;

function setupAcademicContext(opts: { registrationFee?: number | null } = {}) {
  const key = `w7reg_${randomUUID().slice(0, 8)}`;
  const branchId = `${key}_branch`;
  const programId = `${key}_program`;
  const versionId = `${key}_version`;
  const levelId = `${key}_level`;
  const classId = `${key}_class`;
  const classFee = 6000;
  const registrationFee = Object.prototype.hasOwnProperty.call(opts, 'registrationFee') ? opts.registrationFee : 1500;

  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(branchId, branchId);
  db.prepare(`INSERT INTO programs (id, name, branch_id) VALUES (?, 'WP07 Registration Program', ?)`)
    .run(programId, branchId);
  db.prepare(
    `INSERT INTO program_versions (id, program_id, version_label, version_number, status)
     VALUES (?, ?, 'v1', 1, 'draft')`,
  ).run(versionId, programId);
  db.prepare(
    `INSERT INTO levels (id, program_id, program_version_id, name, code, "order", default_fee)
     VALUES (?, ?, ?, 'Level One', 'L1', 1, ?)`,
  ).run(levelId, programId, versionId, classFee);
  db.prepare(
    `INSERT INTO classes (id, name, level, capacity, fee, branch_id, status, lifecycle_stage, program_id, level_id)
     VALUES (?, 'Authority Class', 'Level One', 30, ?, ?, 'active', 'enrollment_open', ?, ?)`,
  ).run(classId, classFee, branchId, programId, levelId);

  if (registrationFee != null) {
    db.prepare(
      `INSERT INTO fee_rules
         (id, branch_id, program_version_id, level_id, fee_type, name, amount, version, is_active)
       VALUES (?, ?, ?, ?, 'registration', 'Canonical registration fee', ?, 1, 1)`,
    ).run(`${key}_registration_fee`, branchId, versionId, levelId, registrationFee);
  }

  return { key, branchId, programId, versionId, levelId, classId, classFee, registrationFee };
}

function insertVisitor(input: {
  id: string;
  serialNo: string;
  branchId: string;
  programVersionId: string;
  gender?: 'male' | 'female';
  phone?: string;
}) {
  db.prepare(
    `INSERT INTO visitors (
      id, serial_no, full_name, phone, email, gender, source, campaign_id, stage, assigned_to,
      visit_date, status, notes, branch_id, interested_course, follow_up_status, next_contact_date,
      father_name, address_region, tazkira_no, whatsapp, dob, school_or_university,
      emergency_contact_name, emergency_contact_phone, program_version_id
    ) VALUES (?, ?, ?, ?, NULL, ?, 'walk_in', NULL, 'lead', NULL, ?, 'visited', NULL, ?, 'TOEFL', 'medium_interest', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    input.id,
    input.serialNo,
    `Visitor ${input.serialNo}`,
    input.phone ?? nextPhone(),
    input.gender ?? 'male',
    today(),
    input.branchId,
    input.programVersionId,
  );
}

function invoicesOf(studentId: string) {
  return db.prepare(
    `SELECT purpose, charge_kind, total_amount, net_amount, status, notes
       FROM invoices WHERE student_id = ? ORDER BY charge_kind, purpose, rowid`,
  ).all(studentId) as Array<{
    purpose: string;
    charge_kind: string | null;
    total_amount: number;
    net_amount: number;
    status: string;
    notes: string | null;
  }>;
}

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(OWNER_BRANCH, OWNER_BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: OWNER_BRANCH, fullName: 'WP07 Fee Owner', db });
});

describe('WP-14 registration fee authority across admission writers', () => {
  const app = makeApp();

  it('manual student admission bills the canonical registration fee as a separate registration-classified invoice without collecting payment or enrolling', async () => {
    const ctx = setupAcademicContext();

    const response = await supertest(app)
      .post('/api/students/manual')
      .set(auth())
      .send({
        branchId: ctx.branchId,
        classId: ctx.classId,
        fullName: 'Manual Admission',
        phone: nextPhone(),
        gender: 'male',
      });

    expect(response.status).toBe(201);

    const studentId = response.body.id as string;
    const invoices = invoicesOf(studentId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      purpose: 'other',
      charge_kind: 'registration',
      total_amount: ctx.registrationFee,
      net_amount: ctx.registrationFee,
      status: 'issued',
      notes: 'Canonical registration fee',
    });
    expect((db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(studentId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ?').get(studentId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM student_semesters WHERE student_id = ?').get(studentId) as { c: number }).c).toBe(0);
  });

  it('manual student admission fails closed when the required canonical registration fee is missing', async () => {
    const ctx = setupAcademicContext({ registrationFee: null });
    const phone = nextPhone();

    const response = await supertest(app)
      .post('/api/students/manual')
      .set(auth())
      .send({
        branchId: ctx.branchId,
        classId: ctx.classId,
        fullName: 'Blocked Manual Admission',
        phone,
        gender: 'female',
      });

    expect(response.status).toBe(409);
    expect(String(response.body.error || '')).toMatch(/registration fee/i);
    const student = db.prepare('SELECT id FROM students WHERE phone = ?').get(phone);
    expect(student).toBeUndefined();
  });

  it('visitor admission bills registration from canonical fee rules and creates no tuition invoice, payment, or enrollment', async () => {
    const ctx = setupAcademicContext();
    const visitorId = `${ctx.key}_visitor`;
    insertVisitor({ id: visitorId, serialNo: `V-${ctx.key.slice(-4)}`, branchId: ctx.branchId, programVersionId: ctx.versionId, gender: 'female' });

    const response = await supertest(app)
      .post(`/api/visitors/${visitorId}/convert`)
      .set(auth())
      .send({
        branchId: ctx.branchId,
        classId: ctx.classId,
        programVersionId: ctx.versionId,
        levelId: ctx.levelId,
      });

    expect(response.status).toBe(201);
    const studentId = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(visitorId) as { id: string } | undefined;
    expect(studentId?.id).toBeTruthy();

    const invoices = invoicesOf(studentId!.id);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      purpose: 'other',
      charge_kind: 'registration',
      total_amount: ctx.registrationFee,
      net_amount: ctx.registrationFee,
      status: 'issued',
      notes: 'Canonical registration fee',
    });
    expect((db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(studentId!.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ?').get(studentId!.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM student_semesters WHERE student_id = ?').get(studentId!.id) as { c: number }).c).toBe(0);
  });

  it('visitor conversion fails closed when no canonical registration fee applies', async () => {
    const ctx = setupAcademicContext({ registrationFee: null });
    const visitorId = `${ctx.key}_visitor_missing_fee`;
    insertVisitor({ id: visitorId, serialNo: `V-${ctx.key.slice(-3)}X`, branchId: ctx.branchId, programVersionId: ctx.versionId });

    const response = await supertest(app)
      .post(`/api/visitors/${visitorId}/convert`)
      .set(auth())
      .send({
        branchId: ctx.branchId,
        classId: ctx.classId,
        programVersionId: ctx.versionId,
        levelId: ctx.levelId,
      });

    expect(response.status).toBe(409);
    expect(String(response.body.error || '')).toMatch(/registration fee/i);
    const student = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(visitorId);
    expect(student).toBeUndefined();
  });
});
