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
import { TUITION_NET_SQL, AID_SOURCE_KINDS_SQL, CASH_ALLOCATION_SQL } from '../../utils/studentBalance.js';
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
  /**
   * Settled by AID — scholarship and sponsorship allocations that are still
   * active. Named for what it counts: after owner decision D-131 a sponsorship
   * settles tuition too, and a field called `settledScholarship` would report
   * a donor's sponsorship as scholarship money.
   */
  settledAid: number;
  settled: number;
  outstanding: number;
}

/**
 * What this obligation still owes, counting every instrument.
 *
 * Cash tuition is read through `getObligationCashSettled` — the obligation's
 * own settlement authority — rather than re-derived here, so there is one
 * definition of "paid in cash for this obligation" and one of "settled in
 * total".
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
  // Keyed on the obligation itself, never on the term's NAME: the name is not
  // unique over time and this is the figure the payment desk trusts.
  const settledCash = getObligationCashSettled(db, obligationId);
  const settledAid = getObligationAidSettled(db, obligationId);
  const settled = settledCash + settledAid;
  return {
    obligation,
    settledCash,
    settledAid,
    settled,
    outstanding: Math.max(0, obligation.netAmount - settled),
  };
}

/** Aid money currently applied to one obligation, whatever the instrument. */
export function getObligationAidSettled(db: Database, obligationId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM obligation_allocations
        WHERE obligation_id = ? AND source_kind IN ${AID_SOURCE_KINDS_SQL} AND status = 'active'`,
    )
    .get(obligationId) as { total: number };
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
  /** W16: money returned to funders via clawbacks attributed to this fund. */
  clawedBack: number;
}

export function getFundPosition(db: Database, scholarshipId: string): FundPosition {
  const received = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM scholarship_fundings WHERE scholarship_id = ?`)
      .get(scholarshipId) as { t: number }).t,
  ) || 0;
  // An active award reserves its full amount. Once an award closes, only the
  // amount actually applied remains consumed; its unused remainder returns to
  // the fund. Excluding a closed award wholesale would re-award money already
  // applied to tuition.
  const activeAwardCommitments = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM scholarship_awards WHERE scholarship_id = ? AND status = 'active'`)
      .get(scholarshipId) as { t: number }).t,
  ) || 0;
  const closedAwardApplications = Number(
    (db.prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS t
         FROM obligation_allocations a
         JOIN scholarship_awards aw ON aw.id = a.scholarship_award_id
        WHERE aw.scholarship_id = ? AND aw.status = 'closed'
          AND a.source_kind = 'scholarship' AND a.status = 'active'`,
    ).get(scholarshipId) as { t: number }).t,
  ) || 0;
  const committed = activeAwardCommitments + closedAwardApplications;
  // W16: clawed-back money (returned to the funder) no longer funds this
  // scholarship's capacity. Attribution is unique per donation (enforced at
  // declaration), so the subtraction is exact, never an allocation choice.
  const clawedBack = Number((db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS t FROM donation_clawbacks c
      WHERE c.donation_id IN (
        SELECT sf.donation_id FROM scholarship_fundings sf WHERE sf.scholarship_id = :s AND sf.donation_id IS NOT NULL
        UNION
        SELECT e.source_donation_id FROM scholarship_fundings sf
          JOIN campaign_funding_entries e ON e.id = sf.campaign_funding_entry_id
         WHERE sf.scholarship_id = :s AND e.source_donation_id IS NOT NULL)`,
  ).get({ s: scholarshipId }) as { t: number }).t) || 0;
  return { scholarshipId, received, committed, clawedBack, available: Math.max(0, received - committed - clawedBack) };
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
  // A direct donation may enter one scholarship fund, one sponsorship receipt,
  // or a restricted campaign entry. A later sponsorship return changes the
  // destination of an already-consumed receipt; it does not make the original
  // donation newly free money.
  const allocated = Number(
    (db.prepare(
      `SELECT COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE donation_id = ?), 0)
            + COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE donation_id = ?), 0)
            + COALESCE((SELECT SUM(amount) FROM campaign_funding_entries
                         WHERE source_donation_id = ? AND origin_kind = 'restricted_donation'), 0) AS t`,
    ).get(donationId, donationId, donationId) as { t: number }).t,
  ) || 0;
  const amount = Number(donation.amount) || 0;
  return { amount, allocated, unallocated: Math.max(0, amount - allocated) };
}

export interface FundingSourcePosition {
  id: string;
  amount: number;
  applied: number;
  /** W16: money returned to funders via clawbacks attributed to this source. */
  clawedBack: number;
  returned: number;
  available: number;
}

export function getScholarshipFundingPosition(db: Database, fundingId: string): FundingSourcePosition {
  const row = db.prepare('SELECT amount FROM scholarship_fundings WHERE id = ?').get(fundingId) as { amount: number } | undefined;
  if (!row) throw new HttpError(404, 'Scholarship funding source not found.');
  const applied = Number((db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM obligation_allocations
      WHERE scholarship_funding_id = ? AND status = 'active'`,
  ).get(fundingId) as { t: number }).t) || 0;
  const amount = Number(row.amount) || 0;
  // W16/W18: clawbacks attributed to THIS funding source reduce its capacity.
  // Declaration fixes attribution (D-187); pre-W18 rows carry NULL attribution
  // and keep the original chain-wide behaviour.
  const clawedBack = Number((db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS t FROM donation_clawbacks c
      WHERE (c.attributed_kind = 'scholarship_funding' AND c.attributed_id = :f)
         OR (c.attributed_id IS NULL AND (
               c.donation_id = (SELECT donation_id FROM scholarship_fundings WHERE id = :f)
            OR c.donation_id IN (SELECT e.source_donation_id FROM scholarship_fundings sf
                                 JOIN campaign_funding_entries e ON e.id = sf.campaign_funding_entry_id
                                 WHERE sf.id = :f AND e.source_donation_id IS NOT NULL)))`,
  ).get({ f: fundingId }) as { t: number }).t) || 0;
  return { id: fundingId, amount, applied, returned: 0, clawedBack, available: Math.max(0, amount - applied - clawedBack) };
}

export function getSponsorshipReceiptPosition(db: Database, receiptId: string): FundingSourcePosition {
  const row = db.prepare('SELECT amount FROM sponsorship_receipts WHERE id = ?').get(receiptId) as { amount: number } | undefined;
  if (!row) throw new HttpError(404, 'Sponsorship receipt source not found.');
  const applied = Number((db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM obligation_allocations
      WHERE sponsorship_receipt_id = ? AND status = 'active'`,
  ).get(receiptId) as { t: number }).t) || 0;
  const returned = Number((db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM campaign_funding_entries
      WHERE source_sponsorship_receipt_id = ?`,
  ).get(receiptId) as { t: number }).t) || 0;
  const amount = Number(row.amount) || 0;
  // W16/W18: clawbacks attributed to THIS receipt reduce its capacity
  // (D-187 fixed-at-declaration attribution; NULL rows keep chain behaviour).
  const clawedBack = Number((db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS t FROM donation_clawbacks c
      WHERE (c.attributed_kind = 'sponsorship_receipt' AND c.attributed_id = :r)
         OR (c.attributed_id IS NULL AND (
               c.donation_id = (SELECT donation_id FROM sponsorship_receipts WHERE id = :r)
            OR c.donation_id IN (SELECT e.source_donation_id FROM sponsorship_receipts sr
                                 JOIN campaign_funding_entries e ON e.id = sr.campaign_funding_entry_id
                                 WHERE sr.id = :r AND e.source_donation_id IS NOT NULL)))`,
  ).get({ r: receiptId }) as { t: number }).t) || 0;
  return { id: receiptId, amount, applied, returned, clawedBack, available: Math.max(0, amount - applied - returned - clawedBack) };
}

export function getCampaignFundingEntryPosition(db: Database, entryId: string): FundingSourcePosition {
  const row = db.prepare('SELECT amount FROM campaign_funding_entries WHERE id = ?').get(entryId) as { amount: number } | undefined;
  if (!row) throw new HttpError(404, 'Campaign funding entry not found.');
  const applied = Number((db.prepare(
    `SELECT COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE campaign_funding_entry_id = ?), 0)
          + COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE campaign_funding_entry_id = ?), 0) AS t`,
  ).get(entryId, entryId) as { t: number }).t) || 0;
  const amount = Number(row.amount) || 0;
  // W16/W18: clawbacks attributed to THIS entry reduce its capacity — W18
  // extends this to sponsorship_return entries that uniquely hold unconsumed
  // money (D-187). Pre-W18 NULL rows keep the direct-entry-only behaviour.
  const clawedBack = Number((db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS t FROM donation_clawbacks c
       JOIN campaign_funding_entries e ON e.id = :e
      WHERE (c.attributed_kind = 'campaign_funding_entry' AND c.attributed_id = :e)
         OR (c.attributed_id IS NULL AND c.donation_id = e.source_donation_id
             AND e.origin_kind = 'restricted_donation')`,
  ).get({ e: entryId }) as { t: number }).t) || 0;
  return { id: entryId, amount, applied, returned: 0, clawedBack, available: Math.max(0, amount - applied - clawedBack) };
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
  params: { awardId: string; scholarshipFundingId: string; obligationId: string; amount: number; operatorName: string; date?: string },
): { allocationId: string } {
  if (!db.inTransaction) {
    throw new Error('allocateScholarshipToObligation() called outside a transaction.');
  }
  const amount = assertMoney(params.amount, 'Allocation amount');
  if (amount <= 0) throw new HttpError(400, 'An allocation must be greater than zero.');

  const award = getAwardPosition(db, params.awardId);
  if (award.status !== 'active') throw new HttpError(409, 'This award is closed and can no longer be applied.');
  const funding = db.prepare('SELECT scholarship_id FROM scholarship_fundings WHERE id = ?').get(params.scholarshipFundingId) as
    | { scholarship_id: string }
    | undefined;
  if (!funding) throw new HttpError(404, 'Scholarship funding source not found.');
  if (funding.scholarship_id !== award.scholarshipId) {
    throw new HttpError(400, 'The selected funding source belongs to another scholarship.');
  }
  const fundingPosition = getScholarshipFundingPosition(db, params.scholarshipFundingId);
  if (amount > fundingPosition.available) {
    throw new HttpError(400, `Only ${fundingPosition.available} AFN remains in the selected funding source.`);
  }
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
       (id, obligation_id, amount, source_kind, scholarship_award_id, scholarship_funding_id, status, operator_name, date)
     VALUES (?, ?, ?, 'scholarship', ?, ?, 'active', ?, ?)`,
  ).run(allocationId, params.obligationId, amount, params.awardId, params.scholarshipFundingId, params.operatorName, params.date ?? today());
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
    .prepare(
      `SELECT a.id, a.status, a.source_kind, aw.status AS award_status
         FROM obligation_allocations a
         JOIN scholarship_awards aw ON aw.id = a.scholarship_award_id
        WHERE a.id = ?`,
    )
    .get(params.allocationId) as { id: string; status: string; source_kind: string; award_status: 'active' | 'closed' } | undefined;
  if (!row) throw new HttpError(404, 'Allocation not found.');
  if (row.source_kind !== 'scholarship') throw new HttpError(400, 'Only a scholarship allocation is reversed here.');
  if (row.status !== 'active') throw new HttpError(409, 'This allocation is already reversed.');
  if (row.award_status !== 'active') throw new HttpError(409, 'A closed scholarship award cannot reverse an application.');

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

/** Allocates one explicit received source into a scholarship fund. */
export function fundScholarshipFromSource(
  db: Database,
  params: {
    scholarshipId: string;
    source: { kind: 'donation'; id: string } | { kind: 'campaignFundingEntry'; id: string };
    amount: number;
    branchId: string;
    operatorName: string;
    date?: string;
  },
): { fundingId: string } {
  if (!db.inTransaction) throw new Error('fundScholarshipFromSource() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Funding amount');
  if (amount <= 0) throw new HttpError(400, 'A funding amount must be greater than zero.');

  const scholarship = db.prepare('SELECT branch_id, campaign_id FROM scholarships WHERE id = ?').get(params.scholarshipId) as
    | { branch_id: string; campaign_id: string | null }
    | undefined;
  if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
  if (scholarship.branch_id !== params.branchId) throw new HttpError(400, 'Scholarship belongs to another branch.');
  if (params.source.kind === 'donation') {
    const donation = db.prepare('SELECT branch_id FROM donations WHERE id = ?').get(params.source.id) as { branch_id: string } | undefined;
    if (!donation) throw new HttpError(404, 'Donation source not found.');
    if (donation.branch_id !== params.branchId) throw new HttpError(400, 'Donation source belongs to another branch.');
    const restriction = db.prepare('SELECT target_kind, scholarship_id FROM donation_restrictions WHERE donation_id = ?').get(params.source.id) as
      | { target_kind: string; scholarship_id: string | null }
      | undefined;
    if (restriction && (restriction.target_kind !== 'scholarship' || restriction.scholarship_id !== params.scholarshipId)) {
      throw new HttpError(400, 'This restricted donation cannot fund the selected scholarship.');
    }
  } else {
    const entry = db.prepare('SELECT branch_id, campaign_id FROM campaign_funding_entries WHERE id = ?').get(params.source.id) as
      | { branch_id: string; campaign_id: string }
      | undefined;
    if (!entry) throw new HttpError(404, 'Campaign funding source not found.');
    if (entry.branch_id !== params.branchId || scholarship.campaign_id !== entry.campaign_id) {
      throw new HttpError(400, 'Campaign funding source does not match the selected scholarship.');
    }
  }
  const available = params.source.kind === 'donation'
    ? getDonationUnallocated(db, params.source.id).unallocated
    : getCampaignFundingEntryPosition(db, params.source.id).available;
  if (amount > available) {
    throw new HttpError(400, `Only ${available} AFN remains in the selected funding source.`);
  }

  const fundingId = id('schf');
  if (params.source.kind === 'donation') {
    db.prepare(
      `INSERT INTO scholarship_fundings
         (id, scholarship_id, donation_id, amount, branch_id, operator_name, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fundingId, params.scholarshipId, params.source.id, amount, params.branchId, params.operatorName, params.date ?? today());
  } else {
    db.prepare(
      `INSERT INTO scholarship_fundings
         (id, scholarship_id, campaign_funding_entry_id, amount, branch_id, operator_name, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fundingId, params.scholarshipId, params.source.id, amount, params.branchId, params.operatorName, params.date ?? today());
  }
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

  db.prepare(`DELETE FROM student_installments WHERE obligation_id = ?`).run(params.obligationId);  const insert = db.prepare(
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
  campaignId: string | null;
  /** Promised per month. It is not a received balance. */
  monthlyAmount: number;
  /** Donation money explicitly received into the agreement. */
  received: number;
  /** Applied to tuition obligations by active allocations. */
  applied: number;
  /** Moved back to the linked campaign on a terminal transition. */
  returned: number;
  /** Still applicable while the agreement is active. */
  available: number;
  status: 'active' | 'completed' | 'terminated';
  /** W16: money returned to funders via clawbacks attributed to this agreement. */
  clawedBack: number;
}

export function getSponsorshipPosition(db: Database, agreementId: string): SponsorshipPosition {
  const agreement = db
    .prepare(`SELECT id, donor_id, student_id, campaign_id, monthly_amount, status FROM sponsorship_agreements WHERE id = ?`)
    .get(agreementId) as
    | { id: string; donor_id: string; student_id: string | null; campaign_id: string | null; monthly_amount: number; status: SponsorshipPosition['status'] }
    | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');

  const received = Number(
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM sponsorship_receipts WHERE agreement_id = ?`)
      .get(agreementId) as { t: number }).t,
  ) || 0;
  const applied = Number(
    (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM obligation_allocations
        WHERE sponsorship_agreement_id = ? AND source_kind = 'sponsorship' AND status = 'active'`,
    ).get(agreementId) as { t: number }).t,
  ) || 0;
  const returned = Number(
    (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM campaign_funding_entries
        WHERE sponsorship_agreement_id = ? AND origin_kind = 'sponsorship_return'`,
    ).get(agreementId) as { t: number }).t,
  ) || 0;

  // W16: clawbacks on donations that funded this agreement reduce capacity.
  const clawedBack = Number((db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS t FROM donation_clawbacks c
      WHERE c.donation_id IN (
        SELECT sr.donation_id FROM sponsorship_receipts sr WHERE sr.agreement_id = :a AND sr.donation_id IS NOT NULL
        UNION
        SELECT e.source_donation_id FROM sponsorship_receipts sr
          JOIN campaign_funding_entries e ON e.id = sr.campaign_funding_entry_id
         WHERE sr.agreement_id = :a AND e.source_donation_id IS NOT NULL)`,
  ).get({ a: agreementId }) as { t: number }).t) || 0;
  return {
    agreementId,
    donorId: agreement.donor_id,
    studentId: agreement.student_id,
    campaignId: agreement.campaign_id,
    monthlyAmount: Number(agreement.monthly_amount) || 0,
    received,
    applied,
    returned,
    clawedBack,
    available: Math.max(0, received - applied - returned - clawedBack),
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
  params: {
    agreementId: string;
    source: { kind: 'donation'; id: string } | { kind: 'campaignFundingEntry'; id: string };
    amount: number;
    branchId: string;
    operatorName: string;
    date?: string;
  },
): { receiptId: string } {
  if (!db.inTransaction) throw new Error('recordSponsorshipReceipt() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Receipt amount');
  if (amount <= 0) throw new HttpError(400, 'A receipt amount must be greater than zero.');

  const position = getSponsorshipPosition(db, params.agreementId);
  if (position.status !== 'active') throw new HttpError(409, 'This sponsorship is no longer active.');

  const agreement = db.prepare('SELECT branch_id, donor_id, campaign_id FROM sponsorship_agreements WHERE id = ?').get(params.agreementId) as
    | { branch_id: string; donor_id: string; campaign_id: string | null }
    | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  if (agreement.branch_id !== params.branchId) throw new HttpError(400, 'Sponsorship belongs to another branch.');
  if (params.source.kind === 'donation') {
    const donation = db.prepare('SELECT branch_id, donor_id FROM donations WHERE id = ?').get(params.source.id) as
      | { branch_id: string; donor_id: string }
      | undefined;
    if (!donation) throw new HttpError(404, 'Donation source not found.');
    if (donation.branch_id !== params.branchId || donation.donor_id !== agreement.donor_id) {
      throw new HttpError(400, 'Donation source does not match the sponsorship agreement.');
    }
    const restriction = db.prepare('SELECT target_kind, sponsorship_agreement_id FROM donation_restrictions WHERE donation_id = ?').get(params.source.id) as
      | { target_kind: string; sponsorship_agreement_id: string | null }
      | undefined;
    if (restriction && (restriction.target_kind !== 'sponsorship' || restriction.sponsorship_agreement_id !== params.agreementId)) {
      throw new HttpError(400, 'This restricted donation cannot fund the selected sponsorship.');
    }
  } else {
    const entry = db.prepare(
      `SELECT cfe.branch_id, cfe.campaign_id, d.donor_id
         FROM campaign_funding_entries cfe JOIN donations d ON d.id = cfe.source_donation_id
        WHERE cfe.id = ?`,
    ).get(params.source.id) as { branch_id: string; campaign_id: string; donor_id: string } | undefined;
    if (!entry) throw new HttpError(404, 'Campaign funding source not found.');
    if (entry.branch_id !== params.branchId || entry.campaign_id !== agreement.campaign_id || entry.donor_id !== agreement.donor_id) {
      throw new HttpError(400, 'Campaign funding source does not match the selected sponsorship.');
    }
  }
  const available = params.source.kind === 'donation'
    ? getDonationUnallocated(db, params.source.id).unallocated
    : getCampaignFundingEntryPosition(db, params.source.id).available;
  if (amount > available) {
    throw new HttpError(400, `Only ${available} AFN remains in the selected funding source.`);
  }

  const receiptId = id('sprc');
  if (params.source.kind === 'donation') {
    db.prepare(
      `INSERT INTO sponsorship_receipts (id, agreement_id, donation_id, amount, branch_id, operator_name, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(receiptId, params.agreementId, params.source.id, amount, params.branchId, params.operatorName, params.date ?? today());
  } else {
    db.prepare(
      `INSERT INTO sponsorship_receipts (id, agreement_id, campaign_funding_entry_id, amount, branch_id, operator_name, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(receiptId, params.agreementId, params.source.id, amount, params.branchId, params.operatorName, params.date ?? today());
  }
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
  params: { agreementId: string; sponsorshipReceiptId: string; obligationId: string; amount: number; operatorName: string; date?: string },
): { allocationId: string } {
  if (!db.inTransaction) throw new Error('allocateSponsorshipToObligation() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Allocation amount');
  if (amount <= 0) throw new HttpError(400, 'An allocation must be greater than zero.');

  const sponsorship = getSponsorshipPosition(db, params.agreementId);
  if (sponsorship.status !== 'active') throw new HttpError(409, 'This sponsorship is no longer active.');
  const receipt = db.prepare('SELECT agreement_id FROM sponsorship_receipts WHERE id = ?').get(params.sponsorshipReceiptId) as
    | { agreement_id: string }
    | undefined;
  if (!receipt) throw new HttpError(404, 'Sponsorship receipt source not found.');
  if (receipt.agreement_id !== params.agreementId) {
    throw new HttpError(400, 'The selected receipt belongs to another sponsorship agreement.');
  }
  const receiptPosition = getSponsorshipReceiptPosition(db, params.sponsorshipReceiptId);
  if (amount > receiptPosition.available) {
    throw new HttpError(400, `Only ${receiptPosition.available} AFN remains in the selected sponsorship receipt.`);
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
       (id, obligation_id, amount, source_kind, sponsorship_agreement_id, sponsorship_receipt_id, status, operator_name, date)
     VALUES (?, ?, ?, 'sponsorship', ?, ?, 'active', ?, ?)`,
  ).run(allocationId, params.obligationId, amount, params.agreementId, params.sponsorshipReceiptId, params.operatorName, params.date ?? today());
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

// ── Cash allocation (owner decision on E1b) ────────────────────────────────
//
// Cash settles a term the same way every other instrument does: by naming the
// obligation it pays. `payments.semester` is a free-text column, and
// `uq_student_semester_active` makes a term NAME unique only among ACTIVE terms
// — not over time. A student who takes "Term One" twice has two terms with one
// name, and a string cannot say which one was paid. An allocation names the
// obligation, so it always can.
//
// Unlike scholarship and sponsorship money, a cash allocation is the shadow of
// a real ledger movement: `recordIncome` already moved branch cash when the
// payment was written. Allocating it moves no further money — it only records
// WHAT the money settled.

/** Cash currently applied to one obligation. */
export function getObligationCashSettled(db: Database, obligationId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS total FROM obligation_allocations a
        WHERE a.obligation_id = ? AND ${CASH_ALLOCATION_SQL}`,
    )
    .get(obligationId) as { total: number };
  return Number(row.total) || 0;
}

/** Applies a cash payment to one tuition obligation. */
export function allocatePaymentToObligation(
  db: Database,
  params: { paymentId: string; obligationId: string; amount: number; operatorName?: string | null; date?: string },
): { allocationId: string } {
  if (!db.inTransaction) throw new Error('allocatePaymentToObligation() called outside a transaction.');
  const amount = assertMoney(params.amount, 'Allocation amount');
  if (amount <= 0) throw new HttpError(400, 'An allocation must be greater than zero.');

  // ENGINE-LEVEL CAP, not caller discipline. The allocation is the settlement
  // truth for the obligation engine and for the payment desk's outstanding
  // figure; if one payment could be allocated beyond what it actually paid —
  // across several obligations or in one oversized row — the books would show
  // tuition settled by money that never arrived. Every caller today writes
  // exactly one allocation equal to the payment, but "every caller is careful"
  // is not an invariant, it is a hope. The payment row is the cash authority;
  // its unallocated remainder is the ceiling.
  const payment = db
    .prepare(`SELECT amount FROM payments WHERE id = ?`)
    .get(params.paymentId) as { amount: number } | undefined;
  if (!payment) throw new HttpError(404, 'The payment being allocated was not found.');
  const alreadyAllocated = Number(
    (db
      .prepare(
        `SELECT COALESCE(SUM(a.amount), 0) AS t FROM obligation_allocations a
          WHERE a.payment_id = ? AND ${CASH_ALLOCATION_SQL}`,
      )
      .get(params.paymentId) as { t: number }).t,
  ) || 0;
  const unallocated = Number(payment.amount) - alreadyAllocated;
  if (amount > unallocated) {
    throw new HttpError(
      409,
      `Only ${unallocated} AFN of payment ${params.paymentId} is still unallocated (${Number(payment.amount)} paid, ${alreadyAllocated} already settling a term).`,
    );
  }

  const allocationId = id('alloc');
  db.prepare(
    `INSERT INTO obligation_allocations
       (id, obligation_id, amount, source_kind, payment_id, status, operator_name, date)
     VALUES (?, ?, ?, 'payment', ?, 'active', ?, ?)`,
  ).run(allocationId, params.obligationId, amount, params.paymentId, params.operatorName ?? null, params.date ?? today());
  return { allocationId };
}

/**
 * Reduces a payment's settlement when it is refunded (owner decision on E1b).
 *
 * The refund reverses the payment's active allocations through the mechanism
 * every other instrument uses — LIFO across ALL of them when the payment was
 * split across obligations — and, when only part of the settlement is
 * returned, writes a fresh allocation for the amount the student keeps
 * settled, against the same obligation it came from. There is therefore
 * exactly ONE way to undo an allocation, and `CHECK (amount > 0)` keeps
 * protecting the table.
 *
 * A payment that settled no obligation (a book, exam or card charge) has
 * nothing to reverse, and this is a no-op for it.
 */
export function refundPaymentAllocation(
  db: Database,
  params: { targetPaymentId: string; refundAmount: number; reason: string; operatorName: string; date?: string },
): { reversedAllocationId: string | null; retainedAllocationId: string | null } {
  if (!db.inTransaction) throw new Error('refundPaymentAllocation() called outside a transaction.');
  const refundAmount = assertMoney(params.refundAmount, 'Refund amount');

  // A payment may hold SEVERAL active allocations — the allocation cap exists
  // precisely because a split across obligations is legal. Reversal walks them
  // LIFO (latest settlement first, the natural accounting direction for a
  // refund) until the refunded amount is consumed, re-allocating whatever the
  // student keeps settled on the SAME obligation it came from. The old
  // implementation read ONE arbitrary allocation row, so a split payment could
  // be refunded against the wrong term — and the amount guard compared against
  // that single row instead of the payment's whole remaining settlement.
  const activeRows = db
    .prepare(
      `SELECT a.id, a.obligation_id, a.amount FROM obligation_allocations a
        WHERE a.payment_id = ? AND ${CASH_ALLOCATION_SQL}
        ORDER BY a.date DESC, a.rowid DESC`,
    )
    .all(params.targetPaymentId) as Array<{ id: string; obligation_id: string; amount: number }>;
  if (activeRows.length === 0) return { reversedAllocationId: null, retainedAllocationId: null };

  const totalActive = activeRows.reduce((sum, row) => sum + Number(row.amount), 0);
  if (refundAmount > totalActive) {
    throw new HttpError(409, `Only ${totalActive} AFN of that payment is still settling a term.`);
  }

  const reverse = db.prepare(
    `UPDATE obligation_allocations
        SET status = 'reversed', reversed_at = datetime('now'), reversed_by = ?, reversal_reason = ?
      WHERE id = ? AND status = 'active'`,
  );
  let firstReversed: string | null = null;
  let lastRetained: string | null = null;
  let remaining = refundAmount;
  for (const row of activeRows) {
    const rowAmount = Number(row.amount);
    if (remaining <= 0) break;
    reverse.run(params.operatorName, String(params.reason ?? '').trim() || 'refund', row.id);
    if (!firstReversed) firstReversed = row.id;
    remaining -= rowAmount;
    if (remaining < 0) {
      // This row settled more than the refund returns: the student keeps the
      // difference settled against the SAME obligation it was paying.
      const { allocationId } = allocatePaymentToObligation(db, {
        paymentId: params.targetPaymentId,
        obligationId: row.obligation_id,
        amount: -remaining,
        operatorName: params.operatorName,
        date: params.date,
      });
      lastRetained = allocationId;
      remaining = 0;
    }
  }

  // W10-1 (forensic wave 11): an instalment's 'paid' flag is a CACHE of "this
  // payment is actively settling my obligation" — the settlement truth itself
  // lives in the (append-only) allocations. When a refund leaves the payment
  // with NO remaining active allocation, every instalment it marked paid must
  // re-open, or the instalment memo contradicts the obligation ("term owed,
  // instalment paid forever") and the instalment payment path 409s on a
  // legitimate re-payment. A PARTIAL refund re-allocates the retained amount
  // above, so the payment still settles and the flag correctly stays 'paid'.
  // Guarded on the payment's remaining ACTIVE allocations — never on amounts —
  // so this can only ever mirror allocation truth, never invent state.
  if (firstReversed) {
    db.prepare(`
      UPDATE student_installments
         SET status = 'pending', paid_payment_id = NULL
       WHERE paid_payment_id = ?
         AND status = 'paid'
         AND NOT EXISTS (
           SELECT 1 FROM obligation_allocations a
            WHERE a.payment_id = ? AND a.status = 'active'
         )
    `).run(params.targetPaymentId, params.targetPaymentId);
  }

  return { reversedAllocationId: firstReversed, retainedAllocationId: lastRetained };
}
