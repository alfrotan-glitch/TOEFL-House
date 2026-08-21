/**
 * WP-07 · One receivable, derived from the authorities (WP07-F18b).
 * ============================================================================
 * Two figures were both called "outstanding" and gave opposite answers about
 * the same money:
 *
 *   BOS "Student Arrears"        getBranchOutstanding — tuition from
 *                                `student_semesters`, aid-aware
 *   Operations "Outstanding"     unpaid net on open invoices
 *
 * Aid settles an OBLIGATION and never touches the invoice, so a term paid in
 * full by a donor left its invoice `issued` and the operations report showed
 * the whole term as outstanding — forever. The owner was told, on two screens,
 * that the same student owed nothing and owed 10,000 AFN.
 *
 * The owner's model: the report publishes ONE receivable, composed of tuition
 * outstanding taken from the balance authority (already aid-aware) plus the
 * unpaid non-tuition invoices. Tuition is counted once, from the tuition
 * authority; nothing else is counted twice.
 *
 * The owner also ruled the figure is a POSITION AS AT TODAY, not a flow over
 * the reporting window, so it carries no date filter and no longer claims one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { reportsRouter } from '../../../routes/reports.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { ensureTuitionObligation } from '../../../core/finance/obligations.js';
import { getBranchOutstanding } from '../../../utils/studentBalance.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let studentId: string;
let semesterId: string;
let obligationId: string;
let owner: { Authorization: string };
let seq = 0;

const overview = () =>
  supertest(app).get('/api/reports/overview?period=year&key=1405').set(owner);

const seedInvoice = (id: string, purpose: string, net: number, obligation: string | null) => {
  db.prepare(
    `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, purpose, obligation_id, invoice_number)
     VALUES (?, ?, ?, 0, ?, 'issued', ?, ?, ?, ?, ?)`,
  ).run(id, studentId, net, net, today(), branch, purpose, obligation, `INV-${id.slice(-8)}`);
  db.prepare(
    `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Line', 1, ?, ?)`,
  ).run(`${id}_it`, id, net, net);
};

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7r8_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);
  studentId = `${key}_s`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Receivable Probe', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-R8${(seq += 1)}-${key.slice(-6)}`, today(), branch, `0777${String(200000 + seq).slice(-6)}`);
  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term One', ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, today());
  obligationId = ensureTuitionObligation(db, semesterId).id;

  seedUser({ id: `${key}_own`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_own`);
});

describe('WP-07 · WP07-F18b — the report and the dashboard cannot disagree', () => {
  it('a term settled by a donor is owed by nobody, on either surface', async () => {
    seedInvoice(`${key}_inv`, 'tuition', 10000, obligationId);

    // The approved scholarship lifecycle settles the whole term.
    const scholarshipId = `${key}_sch`;
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, branch_id) VALUES (?, 'F', 0, ?)`).run(scholarshipId, branch);
    const awardId = `${key}_awd`;
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, status, branch_id, award_date)
       VALUES (?, ?, ?, 10000, 'active', ?, ?)`,
    ).run(awardId, scholarshipId, studentId, branch, today());
    db.prepare(
      `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, scholarship_award_id, status, date)
       VALUES (?, ?, 10000, 'scholarship', ?, 'active', ?)`,
    ).run(`${key}_al`, obligationId, awardId, today());

    const res = await overview().expect(200);
    const o = res.body.financial.outstanding;

    // THE defect: this read 10,000 while the dashboard read 0.
    expect(o.tuition).toBe(0);
    expect(o.total).toBe(0);
    expect(getBranchOutstanding(db, branch)).toBe(0);
  });

  it('tuition is counted once, from the tuition authority — never from its invoice', async () => {
    // A tuition invoice for the whole term, unpaid.
    seedInvoice(`${key}_invt`, 'tuition', 10000, obligationId);

    const o = (await overview().expect(200)).body.financial.outstanding;
    expect(o.tuition).toBe(10000);
    expect(o.nonTuition).toBe(0);
    // If the invoice were counted too, this would read 20,000.
    expect(o.total).toBe(10000);
  });

  it('non-tuition receivable is reported, and is not tuition', async () => {
    seedInvoice(`${key}_invb`, 'books', 3000, null);
    seedInvoice(`${key}_invo`, 'other', 1500, null);

    const o = (await overview().expect(200)).body.financial.outstanding;
    expect(o.tuition).toBe(10000);
    expect(o.nonTuition).toBe(4500);
    expect(o.total).toBe(14500);
  });

  it('the open-invoice count stays an operational metric across every purpose', async () => {
    seedInvoice(`${key}_i1`, 'tuition', 10000, obligationId);
    seedInvoice(`${key}_i2`, 'books', 3000, null);

    const o = (await overview().expect(200)).body.financial.outstanding;
    expect(o.openInvoices).toBe(2);
  });

  it('the total receivable always contains the dashboard arrears figure', async () => {
    seedInvoice(`${key}_i3`, 'books', 2000, null);
    const o = (await overview().expect(200)).body.financial.outstanding;
    expect(o.total).toBeGreaterThanOrEqual(getBranchOutstanding(db, branch));
    expect(o.tuition).toBe(getBranchOutstanding(db, branch));
  });
});

// ── WP07-F23, found while implementing F-18b ───────────────────────────────
//
// `getBranchOutstanding` — the executive dashboard's "Student Arrears" — did
// not subtract aid, while `getStudentBalance` (the profile and roster figure)
// did. Two implementations of "outstanding tuition" inside ONE module gave
// different answers for the same student: the profile said settled, the
// dashboard said owing. Every scholarship- or sponsorship-settled student
// overstated branch arrears by the full settled amount.
describe('WP-07 · WP07-F23 — one definition of outstanding tuition, per student and per branch', () => {
  const settleByAid = (amount: number) => {
    const scholarshipId = `${key}_sch2`;
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, branch_id) VALUES (?, 'F', 0, ?)`).run(scholarshipId, branch);
    const awardId = `${key}_awd2`;
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, status, branch_id, award_date)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(awardId, scholarshipId, studentId, amount, branch, today());
    db.prepare(
      `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, scholarship_award_id, status, date)
       VALUES (?, ?, ?, 'scholarship', ?, 'active', ?)`,
    ).run(`${key}_al2`, obligationId, amount, awardId, today());
  };

  it('the branch figure equals the sum of the per-student figures, aid included', async () => {
    settleByAid(6000);

    const { getStudentBalance } = await import('../../../utils/studentBalance.js');
    const perStudent = getStudentBalance(db, studentId).outstanding;

    expect(perStudent).toBe(4000);
    // Before the repair this read 10,000 — the dashboard ignored the donor.
    expect(getBranchOutstanding(db, branch)).toBe(4000);
  });

  it('a fully aid-settled branch reports no arrears anywhere', async () => {
    settleByAid(10000);
    expect(getBranchOutstanding(db, branch)).toBe(0);
    expect((await overview().expect(200)).body.financial.outstanding.tuition).toBe(0);
  });

  it('the organization-wide figure is the same definition, not a second one', () => {
    // The test database is shared across cases, so the unscoped total legitimately
    // includes other students. What must hold is that BOTH scopes respond
    // identically to the same settlement — one definition, two filters.
    const scopedBefore = getBranchOutstanding(db, branch);
    const allBefore = getBranchOutstanding(db, null);

    settleByAid(6000);

    expect(scopedBefore - getBranchOutstanding(db, branch)).toBe(6000);
    expect(allBefore - getBranchOutstanding(db, null)).toBe(6000);
    expect(getBranchOutstanding(db, null)).toBeGreaterThanOrEqual(getBranchOutstanding(db, branch));
  });
});
