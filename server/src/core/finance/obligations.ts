/**
 * Obligations and allocations — THE settlement authority.
 * ============================================================================
 * An **obligation** is something a student owes. An **allocation** is money
 * applied to one obligation by one funding instrument. Both cash and
 * scholarship money settle through this one authority (owner decision D-120),
 * because the alternative — one settlement rule per instrument — is how the
 * same afghani ends up counted differently by the payment desk, the balance and
 * the reports.
 *
 * WHAT AN OBLIGATION DOES NOT DO
 * ------------------------------
 * It does not restate the amount owed. For tuition the amount lives on the
 * semester row and is already authoritative there; copying it here would create
 * a second store of one figure (§13). The obligation supplies IDENTITY — a
 * stable thing for money to point at — and the amount is derived.
 *
 * SCHOLARSHIP MONEY MOVES NO CASH
 * -------------------------------
 * A scholarship allocation settles an obligation and writes nothing to the
 * ledger. The donor's money was recognised as income when the donation was
 * received (`recordIncome({ category: 'donation' })`), so recognising it again
 * as tuition would count one afghani twice, and would break the branch cash
 * position, which is derived as operating income minus savings minus owner
 * drawings. The cash authority is therefore untouched by this module.
 *
 * FUND ARITHMETIC (all derived, nothing mirrored)
 * -----------------------------------------------
 *     fund.received   = SUM(scholarship_fundings.amount)
 *     fund.committed  = SUM(active awards.amount)
 *     fund.available  = received - committed              -- what may still be awarded
 *     award.allocated = SUM(active allocations of that award)
 *     award.remaining = amount - allocated                -- what may still be applied
 *     obligation.settled = cash settled + scholarship allocated
 */
import type { Database } from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertMoney } from '../../utils/money.js';
import { TUITION_NET_SQL, getSemesterTuitionPaid, AID_SOURCE_KINDS_SQL } from '../../utils/studentBalance.js';
import { id, today } from '../../utils/ids.js';
import { assertOptionalIsoDate } from '../../utils/isoDate.js';

export type ObligationKind = 'tuition';

export interface TuitionObligation {
  id: string;
  studentId: string;
  branchId: string;
  semesterId: string;
  semesterName: string;
  netAmount: number;
  status: 'open' | 'cancelled';
}

/**
 * The tuition obligation for a semester, created on first use.
 *
 * Lazily created rather than written by the enrolment service, so this slice
 * does not reach into WP-05's certified writers. `uq_obligation_tuition_semester`
 * makes the operation idempotent under concurrency: a losing race reads the
 * winner's row instead of creating a second one.
 */
export function ensureTuitionObligation(db: Database, semesterId: string): TuitionObligation {
  const semester = db
    .prepare(
      `SELECT ss.id, ss.student_id, ss.semester_name, ${TUITION_NET_SQL} AS net_amount, st.branch_id
         FROM student_semesters ss JOIN students st ON st.id = ss.student_id
        WHERE ss.id = ?`,
    )
    .get(semesterId) as
    | { id: string; student_id: string; semester_name: string; net_amount: number; branch_id: string }
    | undefined;
  if (!semester) throw new HttpError(404, 'Semester not found.');

  const existing = db
    .prepare(`SELECT id, status FROM student_obligations WHERE semester_id = ?`)
    .get(semesterId) as { id: string; status: 'open' | 'cancelled' } | undefined;

  let obligationId = existing?.id;
  let status: 'open' | 'cancelled' = existing?.status ?? 'open';
  if (!obligationId) {
    obligationId = id('obl');
    try {
      db.prepare(
        `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
         VALUES (?, ?, ?, 'tuition', ?, 'open')`,
      ).run(obligationId, semester.student_id, semester.branch_id, semesterId);
    } catch (err) {
      const winner = db.prepare(`SELECT id, status FROM student_obligations WHERE semester_id = ?`).get(semesterId) as
        | { id: string; status: 'open' | 'cancelled' }
        | undefined;
      if (!winner) throw err;
      obligationId = winner.id;
      status = winner.status;
    }
  }

  return {
    id: obligationId,
    studentId: semester.student_id,
    branchId: semester.branch_id,
    semesterId,
    semesterName: semester.semester_name,
    netAmount: Number(semester.net_amount) || 0,
    status,
  };
}

/** Every tuition obligation this student holds, created on first read. */
export function listTuitionObligations(db: Database, studentId: string): TuitionObligation[] {
  const semesters = db
    .prepare(`SELECT id FROM student_semesters WHERE student_id = ? ORDER BY enroll_date DESC, rowid DESC`)
    .all(studentId) as Array<{ id: string }>;
  return semesters.map((row) => ensureTuitionObligation(db, row.id));
}

export interface ObligationPosition {
  obligation: TuitionObligation;
  /** Settled by cash: tuition payments and the refunds that reverse them. */
  settledCash: number;
  /** Settled by scholarship allocations that are still active. */
  settledScholarship: number;
  settled: number;
  outstanding: number;
}

/**
 * What this obligation still owes, counting every instrument.
 *
 * Cash tuition is read through `getSemesterTuitionPaid` — the existing
 * settlement authority (D-116) — rather than re-derived here, so there is one
 * definition of "paid in cash for this term" and one of "settled in total".
 */
export function getObligationPosition(db: Database, obligationId: string): ObligationPosition {
  const row = db
    .prepare(
      `SELECT o.id, o.student_id, o.branch_id, o.semester_id, o.status,
              ss.semester_name, ${TUITION_NET_SQL} AS net_amount
         FROM student_obligations o JOIN student_semesters ss ON ss.id = o.semester_id
        WHERE o.id = ?`,
    )
    .get(obligationId) as
    | { id: string; student_id: string; branch_id: string; semester_id: string; status: 'open' | 'cancelled'; semester_name: string; net_amount: number }
    | undefined;
  if (!row) throw new HttpError(404, 'Obligation not found.');

  const obligation: TuitionObligation = {
    id: row.id,
    studentId: row.student_id,
    branchId: row.branch_id,
    semesterId: row.semester_id,
    semesterName: row.semester_name,
    netAmount: Number(row.net_amount) || 0,
    status: row.status,
  };
  const settledCash = getSemesterTuitionPaid(db, row.student_id, row.semester_name);
  const settledScholarship = getObligationScholarshipSettled(db, obligationId);
  const settled = settledCash + settledScholarship;
  return {
    obligation,
    settledCash,
    settledScholarship,
    settled,
    outstanding: Math.max(0, obligation.netAmount - settled),
  };
}

/** Aid money currently applied to one obligation, whatever the instrument. */
export function getObligationScholarshipSettled(db: Database, obligationId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM obligation_allocations
        WHERE obligation_id = ? AND source_kind IN ${AID_SOURCE_KINDS_SQL} AND status = 'active'`,
    )
    .get(obligationId) as { total: number };
  return Number(row.total) || 0;
}

/** Scholarship money applied to a student's tuition, across every obligation. */
export function getStudentScholarshipSettled(db: Database, studentId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
        WHERE o.student_id = ? AND o.kind = 'tuition'
          AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'`,
    )
    .get(studentId) as { total: number };
  return Number(row.total) || 0;
}

/** Scholarship money applied to one semester's tuition. */
export function getSemesterScholarshipSettled(db: Database, studentId: string, semesterName: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM obligation_allocations a
         JOIN student_obligations o ON o.id = a.obligation_id
         JOIN student_semesters ss ON ss.id = o.semester_id
        WHERE o.student_id = ? AND ss.semester_name = ?
          AND a.source_kind IN ${AID_SOURCE_KINDS_SQL} AND a.status = 'active'`,
    )
    .get(studentId, semesterName) as { total: number };
  return Number(row.total) || 0;
}

// ── Scholarship fund positions ─────────────────────────────────────────────

export interface FundPosition {
  scholarshipId: string;
  /** Donation money explicitly allocated into this fund. The only backing. */
  received: number;
  /** Committed to students by active awards. */
  committed: number;
  /** Still awardable. */
  available: number;
}

export function getFundPosition(db: Database, scholarshipId: string): FundPosition {
  const received = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM scholarship_fundings WHERE scholarship_id = ?`)
      .get(scholarshipId) as { t: number }).t,
  ) || 0;
  const committed = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM scholarship_awards WHERE scholarship_id = ? AND status = 'active'`)
      .get(scholarshipId) as { t: number }).t,
  ) || 0;
  return { scholarshipId, received, committed, available: received - committed };
}

export interface AwardPosition {
  awardId: string;
  scholarshipId: string;
  studentId: string;
  amount: number;
  allocated: number;
  remaining: number;
  status: 'active' | 'closed';
}

export function getAwardPosition(db: Database, awardId: string): AwardPosition {
  const award = db
    .prepare(`SELECT id, scholarship_id, student_id, amount, status FROM scholarship_awards WHERE id = ?`)
    .get(awardId) as
    | { id: string; scholarship_id: string; student_id: string; amount: number; status: 'active' | 'closed' }
    | undefined;
  if (!award) throw new HttpError(404, 'Scholarship award not found.');
  const allocated = Number(
    (db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS t FROM obligation_allocations
        WHERE scholarship_award_id = ? AND status = 'active'`,
    ).get(awardId) as { t: number }).t,
  ) || 0;
  return {
    awardId: award.id,
    scholarshipId: award.scholarship_id,
    studentId: award.student_id,
    amount: Number(award.amount) || 0,
    allocated,
    remaining: Math.max(0, Number(award.amount) - allocated),
    status: award.status,
  };
}

/** Donation money not yet allocated into any fund. */
export function getDonationUnallocated(db: Database, donationId: string): { amount: number; allocated: number; unallocated: number } {
  const donation = db.prepare(`SELECT amount FROM donations WHERE id = ?`).get(donationId) as { amount: number } | undefined;
  if (!donation) throw new HttpError(404, 'Donation not found.');
  // A donation may be earmarked to a scholarship fund OR to a sponsorship
  // agreement, and the two compete for the same money. Counting only one lets
  // the same afghani be committed twice.
  const allocated = Number(
    (db.prepare(
      `SELECT COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE donation_id = ?), 0)
            + COALESCE((SELECT SUM(amount) FROM sponsorship_receipts  WHERE donation_id = ?), 0) AS t`,
    ).get(donationId, donationId) as { t: number }).t,
  ) || 0;
  const amount = Number(donation.amount) || 0;
  return { amount, allocated, unallocated: Math.max(0, amount - allocated) };
}

// ── Commands ───────────────────────────────────────────────────────────────

/**
 * Applies scholarship money to one tuition obligation.
 *
 * Writes no cash and no ledger row: the donor's money was recognised when the
 * donation arrived. Must run inside a transaction, because the caller's checks
 * and this write have to succeed or fail together.
 */
export function allocateScholarshipToObligation(
  db: Database,
  params: { awardId: string; obligationId: string; amount: number; operatorName: string; date?: string },
): { allocationId: string } {
  if (!db.inTransaction) {
    throw new Error('allocateScholarshipToObligation() called outside a transaction.');
  }
  const amount = assertMoney(params.amount, 'Allocation amount');
  if (amount <= 0) throw new HttpError(400, 'An allocation must be greater than zero.');

  const award = getAwardPosition(db, params.awardId);
  if (award.status !== 'active') throw new HttpError(409, 'This award is closed and can no longer be applied.');
  if (amount > award.remaining) {
    throw new HttpError(400, `Only ${award.remaining} AFN of this award is still unapplied.`);
  }

  const position = getObligationPosition(db, params.obligationId);
  if (position.obligation.status !== 'open') throw new HttpError(409, 'This obligation is not open.');
  if (position.obligation.studentId !== award.studentId) {
    throw new HttpError(403, 'That obligation belongs to another student.');
  }
  if (amount > position.outstanding) {
    throw new HttpError(400, `Only ${position.outstanding} AFN is still outstanding on that obligation.`);
  }

  const allocationId = id('alloc');
  db.prepare(
    `INSERT INTO obligation_allocations
       (id, obligation_id, amount, source_kind, scholarship_award_id, status, operator_name, date)
     VALUES (?, ?, ?, 'scholarship', ?, 'active', ?, ?)`,
  ).run(allocationId, params.obligationId, amount, params.awardId, params.operatorName, params.date ?? today());
  return { allocationId };
}

/**
 * Reverses an allocation.
 *
 * The amount returns to its AWARD — still committed to that student and
 * immediately re-applicable — and the obligation re-opens by exactly that
 * amount. It never returns to the student: scholarship money is the donor's.
 * Returning it to the FUND is a separate, explicit act (`closeAward`), because
 * releasing it while the award stays active would let the fund's active
 * commitments exceed the money it has received.
 */
export function reverseScholarshipAllocation(
  db: Database,
  params: { allocationId: string; reason: string; operatorName: string },
): void {
  if (!db.inTransaction) throw new Error('reverseScholarshipAllocation() called outside a transaction.');
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A reversal reason of at least 8 characters is required.');

  const row = db
    .prepare(`SELECT id, status, source_kind FROM obligation_allocations WHERE id = ?`)
    .get(params.allocationId) as { id: string; status: string; source_kind: string } | undefined;
  if (!row) throw new HttpError(404, 'Allocation not found.');
  if (row.source_kind !== 'scholarship') throw new HttpError(400, 'Only a scholarship allocation is reversed here.');
  if (row.status !== 'active') throw new HttpError(409, 'This allocation is already reversed.');

  const updated = db
    .prepare(
      `UPDATE obligation_allocations
          SET status = 'reversed', reversed_at = datetime('now'), reversed_by = ?, reversal_reason = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(params.operatorName, reason, params.allocationId);
  if (updated.changes !== 1) throw new HttpError(409, 'This allocation is already reversed.');
}

/**
 * Closes an award, returning whatever it never applied to the fund.
 *
 * Applied money stays where it was applied: an obligation that was settled by
 * this award remains settled, and its allocation is untouched.
 */
export function closeAward(
  db: Database,
  params: { awardId: string; reason: string; operatorName: string },
): { returnedToFund: number } {
  if (!db.inTransaction) throw new Error('closeAward() called outside a transaction.');
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A close reason of at least 8 characters is required.');

  const award = getAwardPosition(db, params.awardId);
  if (award.status !== 'active') throw new HttpError(409, 'This award is already closed.');

  const updated = db
    .prepare(
      `UPDATE scholarship_awards
          SET status = 'closed', closed_at = datetime('now'), closed_by = ?, close_reason = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(params.operatorName, reason, params.awardId);
  if (updated.changes !== 1) throw new HttpError(409, 'This award is already closed.');
  return { returnedToFund: award.remaining };
}

/** Allocates donation money into a scholarship fund — the only way a fund is backed. */
export function fundScholarshipFromDonation(
  db: Database,
  params: { scholarshipId: string; donationId: string; amount: number; branchId: string; operatorName: string; date?: string },
): { fundingId: string } {
  if (!db.inTransaction) throw new Error('fundScholarshipFromDonation() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Funding amount');
  if (amount <= 0) throw new HttpError(400, 'A funding amount must be greater than zero.');

  const donation = getDonationUnallocated(db, params.donationId);
  if (amount > donation.unallocated) {
    throw new HttpError(400, `Only ${donation.unallocated} AFN of that donation is still unallocated.`);
  }

  const fundingId = id('schf');
  db.prepare(
    `INSERT INTO scholarship_fundings (id, scholarship_id, donation_id, amount, branch_id, operator_name, date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(fundingId, params.scholarshipId, params.donationId, amount, params.branchId, params.operatorName, params.date ?? today());
  return { fundingId };
}

// ── Instalment plans (owner decision D-125) ────────────────────────────────
//
// A plan is the instalments of ONE tuition obligation. Because the plan hangs
// off the obligation, paying an instalment settles the term that obligation
// bills and the operator never picks a semester — which is what D-117 requires.

export interface InstallmentRow {
  id: string;
  obligationId: string;
  sequence: number;
  amount: number;
  dueDate: string | null;
  status: 'pending' | 'paid';
  paidPaymentId: string | null;
}

const mapInstallment = (row: {
  id: string; obligation_id: string; sequence: number; amount: number;
  due_date: string | null; status: 'pending' | 'paid'; paid_payment_id: string | null;
}): InstallmentRow => ({
  id: row.id,
  obligationId: row.obligation_id,
  sequence: Number(row.sequence),
  amount: Number(row.amount),
  dueDate: row.due_date,
  status: row.status,
  paidPaymentId: row.paid_payment_id,
});

/** The plan of one obligation, in schedule order. */
export function listInstallments(db: Database, obligationId: string): InstallmentRow[] {
  return (db
    .prepare(
      `SELECT id, obligation_id, sequence, amount, due_date, status, paid_payment_id
         FROM student_installments WHERE obligation_id = ? ORDER BY sequence`,
    )
    .all(obligationId) as Parameters<typeof mapInstallment>[0][]).map(mapInstallment);
}

/** Every instalment this student holds, with the term each one pays. */
export function listStudentInstallments(
  db: Database,
  studentId: string,
): Array<InstallmentRow & { semesterName: string; semesterId: string }> {
  return (db
    .prepare(
      `SELECT i.id, i.obligation_id, i.sequence, i.amount, i.due_date, i.status, i.paid_payment_id,
              ss.semester_name, ss.id AS semester_id
         FROM student_installments i
         JOIN student_obligations o ON o.id = i.obligation_id
         JOIN student_semesters ss ON ss.id = o.semester_id
        WHERE o.student_id = ?
        ORDER BY ss.enroll_date DESC, i.sequence`,
    )
    .all(studentId) as Array<Parameters<typeof mapInstallment>[0] & { semester_name: string; semester_id: string }>).map((row) => ({
      ...mapInstallment(row),
      semesterName: row.semester_name,
      semesterId: row.semester_id,
    }));
}

/**
 * Replaces the plan of one obligation.
 *
 * The plan may not promise more than the obligation bills, and a paid
 * instalment is history: once any instalment is paid the schedule is fixed,
 * because rewriting it would silently move money that has already been taken.
 */
export function setInstallmentPlan(
  db: Database,
  params: { obligationId: string; installments: Array<{ amount: unknown; dueDate?: unknown }> },
): InstallmentRow[] {
  if (!db.inTransaction) throw new Error('setInstallmentPlan() called outside a transaction.');
  const position = getObligationPosition(db, params.obligationId);
  if (position.obligation.status !== 'open') throw new HttpError(409, 'This obligation is not open.');

  const existing = listInstallments(db, params.obligationId);
  if (existing.some((row) => row.status === 'paid')) {
    throw new HttpError(409, 'This plan has a paid instalment and can no longer be rewritten.');
  }
  if (!Array.isArray(params.installments) || params.installments.length === 0) {
    throw new HttpError(400, 'A plan needs at least one instalment.');
  }
  if (params.installments.length > 60) throw new HttpError(400, 'A plan may not exceed 60 instalments.');

  const parsed = params.installments.map((item, index) => {
    const amount = assertMoney(item?.amount, `Instalment ${index + 1} amount`);
    if (amount <= 0) throw new HttpError(400, `Instalment ${index + 1} must be greater than zero.`);
    const dueDate = assertOptionalIsoDate(item?.dueDate, `Instalment ${index + 1} due date`);
    return { amount, dueDate };
  });

  const planned = parsed.reduce((sum, row) => sum + row.amount, 0);
  if (planned > position.obligation.netAmount) {
    throw new HttpError(
      400,
      `The plan totals ${planned} AFN but the term bills ${position.obligation.netAmount} AFN.`,
    );
  }

  db.prepare(`DELETE FROM student_installments WHERE obligation_id = ?`).run(params.obligationId);
  const insert = db.prepare(
    `INSERT INTO student_installments (id, obligation_id, sequence, amount, due_date, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  );
  parsed.forEach((row, index) => insert.run(id('inst'), params.obligationId, index + 1, row.amount, row.dueDate));
  return listInstallments(db, params.obligationId);
}

export interface PayableInstallment {
  installment: InstallmentRow;
  obligation: TuitionObligation;
  outstanding: number;
}

/** The instalment a payment names, with the term it settles. */
export function getPayableInstallment(db: Database, studentId: string, installmentId: string): PayableInstallment {
  const row = db
    .prepare(
      `SELECT i.id, i.obligation_id, i.sequence, i.amount, i.due_date, i.status, i.paid_payment_id, o.student_id
         FROM student_installments i JOIN student_obligations o ON o.id = i.obligation_id
        WHERE i.id = ?`,
    )
    .get(installmentId) as (Parameters<typeof mapInstallment>[0] & { student_id: string }) | undefined;
  if (!row) throw new HttpError(404, 'Instalment not found.');
  if (row.student_id !== studentId) throw new HttpError(403, 'That instalment belongs to another student.');
  if (row.status === 'paid') throw new HttpError(409, 'This instalment is already paid.');

  const position = getObligationPosition(db, row.obligation_id);
  return { installment: mapInstallment(row), obligation: position.obligation, outstanding: position.outstanding };
}

/** Marks an instalment paid by a specific payment. */
export function markInstallmentPaid(db: Database, installmentId: string, paymentId: string): void {
  if (!db.inTransaction) throw new Error('markInstallmentPaid() called outside a transaction.');
  const updated = db
    .prepare(`UPDATE student_installments SET status = 'paid', paid_payment_id = ? WHERE id = ? AND status = 'pending'`)
    .run(paymentId, installmentId);
  if (updated.changes !== 1) throw new HttpError(409, 'This instalment is no longer payable.');
}

// ── Sponsorships (owner decision S6) ───────────────────────────────────────
//
// A sponsorship agreement is a PROMISE: `monthly_amount` says what a donor
// intends to give. It settles nothing, because a promise is not money. What
// settles tuition is a RECEIPT — a donation from the sponsoring donor,
// earmarked to the agreement — applied to a named tuition obligation.
//
// The instrument is separate from a scholarship (they are different concepts),
// but the settlement is not: both land in `obligation_allocations`, because
// there is exactly one place where money meets an obligation.

export interface SponsorshipPosition {
  agreementId: string;
  donorId: string;
  studentId: string | null;
  /** Promised per month. Bounds nothing — the same role `total_budget` plays. */
  monthlyAmount: number;
  /** Donation money actually earmarked to this agreement. The only backing. */
  received: number;
  /** Applied to tuition obligations by active allocations. */
  applied: number;
  /** Still applicable. */
  available: number;
  status: 'active' | 'completed' | 'terminated';
}

export function getSponsorshipPosition(db: Database, agreementId: string): SponsorshipPosition {
  const agreement = db
    .prepare(`SELECT id, donor_id, student_id, monthly_amount, status FROM sponsorship_agreements WHERE id = ?`)
    .get(agreementId) as
    | { id: string; donor_id: string; student_id: string | null; monthly_amount: number; status: SponsorshipPosition['status'] }
    | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');

  const received = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM sponsorship_receipts WHERE agreement_id = ?`)
      .get(agreementId) as { t: number }).t,
  ) || 0;
  const applied = Number(
    (db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS t FROM obligation_allocations
        WHERE sponsorship_agreement_id = ? AND source_kind = 'sponsorship' AND status = 'active'`,
    ).get(agreementId) as { t: number }).t,
  ) || 0;

  return {
    agreementId,
    donorId: agreement.donor_id,
    studentId: agreement.student_id,
    monthlyAmount: Number(agreement.monthly_amount) || 0,
    received,
    applied,
    available: received - applied,
    status: agreement.status,
  };
}

/**
 * Earmarks donation money to a sponsorship agreement — the only way an
 * agreement is backed.
 *
 * Bounded by what is left of the donation, which the scholarship funds compete
 * for too, so one afghani can never back two commitments.
 */
export function recordSponsorshipReceipt(
  db: Database,
  params: { agreementId: string; donationId: string; amount: number; branchId: string; operatorName: string; date?: string },
): { receiptId: string } {
  if (!db.inTransaction) throw new Error('recordSponsorshipReceipt() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Receipt amount');
  if (amount <= 0) throw new HttpError(400, 'A receipt amount must be greater than zero.');

  const position = getSponsorshipPosition(db, params.agreementId);
  if (position.status !== 'active') throw new HttpError(409, 'This sponsorship is no longer active.');

  const donation = getDonationUnallocated(db, params.donationId);
  if (amount > donation.unallocated) {
    throw new HttpError(400, `Only ${donation.unallocated} AFN of that donation is still unallocated.`);
  }

  const receiptId = id('sprc');
  db.prepare(
    `INSERT INTO sponsorship_receipts (id, agreement_id, donation_id, amount, branch_id, operator_name, date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(receiptId, params.agreementId, params.donationId, amount, params.branchId, params.operatorName, params.date ?? today());
  return { receiptId };
}

/**
 * Applies sponsorship money to one tuition obligation.
 *
 * Writes no cash and no ledger row, for the same reason a scholarship does not:
 * the donor's money was recognised when the donation arrived, and recognising
 * it again as tuition would count one afghani twice and break the derived
 * branch cash position.
 *
 * An agreement that names a student may only settle that student's tuition.
 * An agreement that names none may settle any student's — the donor sponsored
 * a programme rather than a person.
 */
export function allocateSponsorshipToObligation(
  db: Database,
  params: { agreementId: string; obligationId: string; amount: number; operatorName: string; date?: string },
): { allocationId: string } {
  if (!db.inTransaction) throw new Error('allocateSponsorshipToObligation() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Allocation amount');
  if (amount <= 0) throw new HttpError(400, 'An allocation must be greater than zero.');

  const sponsorship = getSponsorshipPosition(db, params.agreementId);
  if (sponsorship.status !== 'active') throw new HttpError(409, 'This sponsorship is no longer active.');
  if (amount > sponsorship.available) {
    throw new HttpError(
      400,
      sponsorship.received === 0
        ? 'This sponsorship has received no money yet, so it can settle nothing.'
        : `Only ${sponsorship.available} AFN of this sponsorship is still unapplied.`,
    );
  }

  const position = getObligationPosition(db, params.obligationId);
  if (position.obligation.status !== 'open') throw new HttpError(409, 'This obligation is not open.');
  if (sponsorship.studentId && position.obligation.studentId !== sponsorship.studentId) {
    throw new HttpError(403, 'That obligation belongs to a student this sponsorship does not name.');
  }
  if (amount > position.outstanding) {
    throw new HttpError(400, `Only ${position.outstanding} AFN is still outstanding on that obligation.`);
  }

  const allocationId = id('alloc');
  db.prepare(
    `INSERT INTO obligation_allocations
       (id, obligation_id, amount, source_kind, sponsorship_agreement_id, status, operator_name, date)
     VALUES (?, ?, ?, 'sponsorship', ?, 'active', ?, ?)`,
  ).run(allocationId, params.obligationId, amount, params.agreementId, params.operatorName, params.date ?? today());
  return { allocationId };
}

/**
 * Reverses a sponsorship allocation.
 *
 * The amount returns to its AGREEMENT — still the donor's money, still
 * earmarked, immediately re-applicable — and the obligation re-opens by exactly
 * that amount. It never returns to the student and never becomes cash.
 */
export function reverseSponsorshipAllocation(
  db: Database,
  params: { allocationId: string; reason: string; operatorName: string },
): void {
  if (!db.inTransaction) throw new Error('reverseSponsorshipAllocation() called outside a transaction.');
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A reversal reason of at least 8 characters is required.');

  const row = db
    .prepare(`SELECT id, status, source_kind FROM obligation_allocations WHERE id = ?`)
    .get(params.allocationId) as { id: string; status: string; source_kind: string } | undefined;
  if (!row) throw new HttpError(404, 'Allocation not found.');
  if (row.source_kind !== 'sponsorship') throw new HttpError(400, 'Only a sponsorship allocation is reversed here.');
  if (row.status !== 'active') throw new HttpError(409, 'This allocation is already reversed.');

  const updated = db
    .prepare(
      `UPDATE obligation_allocations
          SET status = 'reversed', reversed_at = datetime('now'), reversed_by = ?, reversal_reason = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(params.operatorName, reason, params.allocationId);
  if (updated.changes !== 1) throw new HttpError(409, 'This allocation is already reversed.');
}
