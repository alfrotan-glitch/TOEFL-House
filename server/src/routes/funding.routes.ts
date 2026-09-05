import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, canAccessBranchResource, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { assertMoney } from '../utils/money.js';
import { assertDateRange, assertOptionalIsoDate } from '../utils/isoDate.js';
import { isUniqueViolation, resolveIdempotency } from '../utils/idempotency.js';
import { eventBus } from '../core/events/event-bus.js';
import { repriceTuitionInvoicesAfterAid } from '../core/finance/invoicing.js';
import { getRestrictedExposure } from '../core/funding/restricted-exposure.js';
import { declareDonationClawback, repayDonationClawback } from '../core/funding/clawbacks.js';
import {
  allocateScholarshipToObligation,
  allocateSponsorshipToObligation,
  closeAward,
  fundScholarshipFromSource,
  getAwardPosition,
  getCampaignFundingEntryPosition,
  getDonationUnallocated,
  getFundPosition,
  getObligationPosition,
  getScholarshipFundingPosition,
  getSponsorshipPosition,
  getSponsorshipReceiptPosition,
  listTuitionObligations,
  recordSponsorshipReceipt,
  reverseScholarshipAllocation,
  reverseSponsorshipAllocation,
} from '../core/finance/obligations.js';
import {
  getFundingSummary,
  registerDonation,
  terminalizeSponsorship,
  type FundingSourceInput,
  type RestrictionInput,
} from '../core/funding/funding-service.js';

export const fundingRouter = Router();
fundingRouter.use(authenticate);

type RequestUser = { userId: string; branchId: string; fullName: string };

function userContext(req: import('express').Request): RequestUser {
  const user = req.user;
  if (!user?.userId || !user.branchId || !user.fullName) {
    throw new HttpError(403, 'User context is missing for this funding operation.');
  }
  return { userId: user.userId, branchId: user.branchId, fullName: user.fullName };
}

function trimmedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`);
  return value.trim();
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return trimmedId(value, field);
}

function mutationBranch(req: import('express').Request, body: Record<string, unknown>): string {
  const user = userContext(req);
  const requested = optionalId(body.branchId, 'branchId') ?? user.branchId;
  if (!canAccessBranchResource(req, requested)) {
    throw new HttpError(403, 'You are not authorized for the selected branch.');
  }
  return requested;
}

function requireBranchResource(req: import('express').Request, branchId: string): void {
  if (!canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Funding resource belongs to another branch.');
  }
}

function parseSource(body: Record<string, unknown>): FundingSourceInput {
  const donationId = optionalId(body.donationId, 'donationId');
  const campaignFundingEntryId = optionalId(body.campaignFundingEntryId, 'campaignFundingEntryId');
  if ((donationId ? 1 : 0) + (campaignFundingEntryId ? 1 : 0) !== 1) {
    throw new HttpError(400, 'Name exactly one funding source: donationId or campaignFundingEntryId.');
  }
  return donationId
    ? { kind: 'donation', id: donationId }
    : { kind: 'campaignFundingEntry', id: campaignFundingEntryId! };
}

interface DonationReplayCandidate {
  id: string;
  receipt_no: string;
  donor_id: string;
  campaign_id: string | null;
  amount: number;
  branch_id: string;
  restriction_kind: RestrictionInput['kind'] | null;
  restriction_target_id: string | null;
}

function assertSameDonation(
  candidate: DonationReplayCandidate,
  expected: { donorId: string; campaignId: string | null; amount: number; branchId: string; restriction: RestrictionInput | null },
): void {
  const sameRestriction = candidate.restriction_kind === (expected.restriction?.kind ?? null)
    && candidate.restriction_target_id === (expected.restriction?.targetId ?? null);
  // Scholarship/sponsorship targets may carry an explicit campaign provenance
  // selected by the authoritative donation command. A retry that repeats that
  // same structured target may omit the redundant campaign field.
  const sameCampaign = (candidate.campaign_id ?? null) === expected.campaignId
    || (expected.campaignId === null && expected.restriction !== null && sameRestriction);
  if (candidate.donor_id !== expected.donorId
    || !sameCampaign
    || !sameRestriction
    || Number(candidate.amount) !== expected.amount
    || candidate.branch_id !== expected.branchId) {
    throw new HttpError(409, 'This idempotency key belongs to a different donation.');
  }
}

function parseRestriction(body: Record<string, unknown>): RestrictionInput | null {
  if (body.restricted !== undefined || body.restrictionNote !== undefined) {
    throw new HttpError(400, 'Use restriction.kind and restriction.targetId; free-text restrictions are not accepted.');
  }
  if (body.restriction === undefined || body.restriction === null) return null;
  if (!body.restriction || typeof body.restriction !== 'object' || Array.isArray(body.restriction)) {
    throw new HttpError(400, 'restriction must name a structured target.');
  }
  const restriction = body.restriction as Record<string, unknown>;
  const kind = restriction.kind;
  if (kind !== 'campaign' && kind !== 'scholarship' && kind !== 'sponsorship') {
    throw new HttpError(400, 'restriction.kind must be campaign, scholarship, or sponsorship.');
  }
  return { kind, targetId: trimmedId(restriction.targetId, 'restriction.targetId') };
}

function listDonors() {
  // Donor identity is organization-global. Branch scope applies to monetary
  // relations and totals, not to the minimum reference data a permitted
  // donation recorder needs in order to name a donor.
  return db.prepare('SELECT * FROM donors ORDER BY created_at DESC').all();
}

function listCampaigns(branchId: string | null, isAll: boolean) {
  const rows = (isAll
    ? db.prepare(
      `SELECT c.*, COALESCE(SUM(d.amount), 0) AS raised_amount,
              CASE WHEN c.target_amount > 0 THEN CAST(ROUND(COALESCE(SUM(d.amount), 0) * 100.0 / c.target_amount) AS INTEGER) ELSE 0 END AS progress_percent
         FROM funding_campaigns c LEFT JOIN donations d ON d.campaign_id = c.id
        GROUP BY c.id ORDER BY c.start_date DESC, c.id`,
    ).all()
    : db.prepare(
      `SELECT c.*, COALESCE(SUM(d.amount), 0) AS raised_amount,
              CASE WHEN c.target_amount > 0 THEN CAST(ROUND(COALESCE(SUM(d.amount), 0) * 100.0 / c.target_amount) AS INTEGER) ELSE 0 END AS progress_percent
         FROM funding_campaigns c LEFT JOIN donations d ON d.campaign_id = c.id
        WHERE c.branch_id = ?
        GROUP BY c.id ORDER BY c.start_date DESC, c.id`,
    ).all(branchId)) as Array<Record<string, unknown>>;
  return rows;
}

function listScholarships(branchId: string | null, isAll: boolean) {
  const rows = (isAll
    ? db.prepare('SELECT * FROM scholarships ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM scholarships WHERE branch_id = ? ORDER BY created_at DESC').all(branchId)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, ...getFundPosition(db, String(row.id)) }));
}

function listSponsorships(branchId: string | null, isAll: boolean) {
  const rows = (isAll
    ? db.prepare('SELECT * FROM sponsorship_agreements ORDER BY start_date DESC, id').all()
    : db.prepare('SELECT * FROM sponsorship_agreements WHERE branch_id = ? ORDER BY start_date DESC, id').all(branchId)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, ...getSponsorshipPosition(db, String(row.id)) }));
}

function donationSourceForFunding(donationId: string): { id: string; amount: number; unallocated: number } {
  const position = getDonationUnallocated(db, donationId);
  return { id: donationId, amount: position.amount, unallocated: position.unallocated };
}

// Donor master
fundingRouter.get('/donors', requirePermission('Funding.View'), ah(async (req, res) => {
  resolveBranchScope(req);
  res.json(listDonors());
}));

fundingRouter.get('/donors/:id', requirePermission('Funding.View'), ah(async (req, res) => {
  const donor = db.prepare('SELECT * FROM donors WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!donor) throw new HttpError(404, 'Donor not found.');
  const { branchId, isAll } = resolveBranchScope(req);
  const donorId = String(donor.id);
  const donationTotalRow = (isAll
    ? db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM donations WHERE donor_id = ?').get(donorId)
    : db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM donations WHERE donor_id = ? AND branch_id = ?').get(donorId, branchId)) as { total: number };
  const totalDonated = Number(donationTotalRow.total) || 0;
  res.json({ ...donor, totalDonated });
}));

fundingRouter.post('/donors', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = userContext(req);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const type = body.type;
  if (!fullName) throw new HttpError(400, 'Donor full name is required.');
  if (type !== 'individual' && type !== 'organization' && type !== 'ngo' && type !== 'government') {
    throw new HttpError(400, 'Invalid donor type.');
  }
  const donorId = id('donor');
  let createdEvent: ReturnType<typeof eventBus.emit> | undefined;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO donors (id, full_name, type, phone, email, country, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(donorId, fullName, type, optionalId(body.phone, 'phone'), optionalId(body.email, 'email'), optionalId(body.country, 'country'), optionalId(body.notes, 'notes'));
    createdEvent = eventBus.emit('donor.created', 'donor', donorId, { fullName, type }, { operatorId: user.userId, branchId: user.branchId });
  })();
  if (createdEvent) void eventBus.dispatch(createdEvent);
  writeAudit(req, `Created donor ${donorId}`, { newValue: JSON.stringify({ fullName, type }) });
  res.status(201).json({ id: donorId });
}));

fundingRouter.put('/donors/:id', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const existing = db.prepare('SELECT * FROM donors WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, 'Donor not found.');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fullName = body.fullName === undefined ? String(existing.full_name) : (typeof body.fullName === 'string' ? body.fullName.trim() : '');
  const type = body.type === undefined ? existing.type : body.type;
  if (!fullName) throw new HttpError(400, 'Donor full name is required.');
  if (type !== 'individual' && type !== 'organization' && type !== 'ngo' && type !== 'government') throw new HttpError(400, 'Invalid donor type.');
  db.prepare(
    `UPDATE donors SET full_name = ?, type = ?, phone = ?, email = ?, country = ?, notes = ? WHERE id = ?`,
  ).run(fullName, type, body.phone ?? existing.phone ?? null, body.email ?? existing.email ?? null, body.country ?? existing.country ?? null, body.notes ?? existing.notes ?? null, req.params.id);
  writeAudit(req, `Updated donor ${req.params.id}`);
  res.json({ ok: true });
}));

// Campaigns
fundingRouter.get('/campaigns', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  res.json(listCampaigns(branchId, isAll));
}));

fundingRouter.post('/campaigns', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = userContext(req);
  const branchId = mutationBranch(req, body);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(400, 'Campaign name is required.');
  const targetAmount = assertMoney(body.targetAmount, 'campaign target amount');
  const startDate = assertOptionalIsoDate(body.startDate, 'campaign startDate') ?? today();
  const endDate = assertOptionalIsoDate(body.endDate, 'campaign endDate');
  assertDateRange(startDate, endDate, 'campaign startDate', 'campaign endDate');
  const donorId = optionalId(body.donorId, 'donorId');
  if (donorId && !db.prepare('SELECT 1 FROM donors WHERE id = ?').get(donorId)) throw new HttpError(404, 'Donor not found.');
  const campaignId = id('camp');
  let campaignEvent: ReturnType<typeof eventBus.emit> | undefined;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO funding_campaigns (id, name, description, donor_id, target_amount, start_date, end_date, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(campaignId, name, typeof body.description === 'string' ? body.description.trim() || null : null, donorId, targetAmount, startDate, endDate, branchId);
    campaignEvent = eventBus.emit('campaign.created', 'campaign', campaignId, { name, targetAmount }, { operatorId: user.userId, branchId });
  })();
  if (campaignEvent) void eventBus.dispatch(campaignEvent);
  writeAudit(req, `Created funding campaign ${campaignId}`, { branchId, newValue: JSON.stringify({ name, targetAmount }) });
  res.status(201).json({ id: campaignId });
}));

fundingRouter.patch('/campaigns/:id', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const existing = db.prepare('SELECT * FROM funding_campaigns WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, 'Campaign not found.');
  requireBranchResource(req, String(existing.branch_id));
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = body.name === undefined ? String(existing.name) : (typeof body.name === 'string' ? body.name.trim() : '');
  if (!name) throw new HttpError(400, 'Campaign name is required.');
  const targetAmount = body.targetAmount === undefined ? Number(existing.target_amount) : assertMoney(body.targetAmount, 'campaign target amount');
  const endDate = body.endDate === undefined ? (existing.end_date as string | null) : assertOptionalIsoDate(body.endDate, 'campaign endDate');
  const status = body.status === undefined ? existing.status : body.status;
  if (status !== 'active' && status !== 'completed' && status !== 'cancelled') throw new HttpError(400, 'Invalid campaign status.');
  assertDateRange(String(existing.start_date), endDate, 'campaign startDate', 'campaign endDate');
  db.prepare(
    `UPDATE funding_campaigns SET name = ?, description = ?, target_amount = ?, end_date = ?, status = ? WHERE id = ?`,
  ).run(name, body.description ?? existing.description ?? null, targetAmount, endDate, status, req.params.id);
  writeAudit(req, `Updated funding campaign ${req.params.id}`, { branchId: String(existing.branch_id) });
  res.json({ ok: true });
}));

// Donations and funding sources
fundingRouter.get('/donations', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const rows = (isAll
    ? db.prepare(
      `SELECT d.*, r.target_kind AS restriction_kind, r.campaign_id AS restriction_campaign_id,
              r.scholarship_id AS restriction_scholarship_id, r.sponsorship_agreement_id AS restriction_sponsorship_agreement_id
         FROM donations d LEFT JOIN donation_restrictions r ON r.donation_id = d.id
        ORDER BY d.date DESC, d.created_at DESC`,
    ).all()
    : db.prepare(
      `SELECT d.*, r.target_kind AS restriction_kind, r.campaign_id AS restriction_campaign_id,
              r.scholarship_id AS restriction_scholarship_id, r.sponsorship_agreement_id AS restriction_sponsorship_agreement_id
         FROM donations d LEFT JOIN donation_restrictions r ON r.donation_id = d.id
        WHERE d.branch_id = ? ORDER BY d.date DESC, d.created_at DESC`,
    ).all(branchId)) as Array<Record<string, unknown>>;
  res.json(rows.map((row) => ({ ...row, allocation: getDonationUnallocated(db, String(row.id)) })));
}));

fundingRouter.post('/donations', requirePermission('Funding.RecordDonation', 'Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = userContext(req);
  const branchId = mutationBranch(req, body);
  const donorId = trimmedId(body.donorId, 'donorId');
  const campaignId = optionalId(body.campaignId, 'campaignId');
  const amount = assertMoney(body.amount, 'donation amount');
  if (amount <= 0) throw new HttpError(400, 'donation amount must be greater than zero.');
  const date = assertOptionalIsoDate(body.date, 'donation date') ?? today();
  const restriction = parseRestriction(body);
  const { candidates } = resolveIdempotency(req, {
    route: 'funding-donation', donorId, campaignId, amount, date,
    restrictionKind: restriction?.kind ?? null, restrictionTargetId: restriction?.targetId ?? null,
    branchId, actorUserId: user.userId,
  });
  const findPrior = () => db.prepare(
    `SELECT d.id, d.receipt_no, d.donor_id, d.campaign_id, d.amount, d.branch_id,
            r.target_kind AS restriction_kind,
            COALESCE(r.campaign_id, r.scholarship_id, r.sponsorship_agreement_id) AS restriction_target_id
       FROM donations d LEFT JOIN donation_restrictions r ON r.donation_id = d.id
      WHERE d.idempotency_key IN (${candidates.map(() => '?').join(',')}) LIMIT 1`,
  ).get(...candidates) as DonationReplayCandidate | undefined;
  const prior = findPrior();
  if (prior) {
    assertSameDonation(prior, { donorId, campaignId, amount, branchId, restriction });
    return res.status(200).json({ id: prior.id, receiptNo: prior.receipt_no, idempotentReplay: true });
  }

  let result: ReturnType<typeof registerDonation>;
  let event: ReturnType<typeof eventBus.emit> | undefined;
  try {
    db.transaction(() => {
      result = registerDonation(db, {
        donorId, campaignId, amount, date, branchId, restriction,
        idempotencyKey: candidates[0],
        operator: { userId: user.userId, fullName: user.fullName, role: req.rbac?.primaryRole ?? null },
      });
      event = eventBus.emit('donation.received', 'donation', result.id, {
        donorId, amount, campaignId, restrictionKind: restriction?.kind ?? null,
      }, { operatorId: user.userId, branchId });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = findPrior();
      if (winner) {
        assertSameDonation(winner, { donorId, campaignId, amount, branchId, restriction });
        return res.status(200).json({ id: winner.id, receiptNo: winner.receipt_no, idempotentReplay: true });
      }
      throw new HttpError(409, 'This idempotency key belongs to a different donation.');
    }
    throw error;
  }
  if (event) void eventBus.dispatch(event);
  writeAudit(req, `Recorded donation ${result!.id}`, { branchId, newValue: JSON.stringify({ amount, donorId, campaignId, restriction }) });
  res.status(201).json(result!);
}));

fundingRouter.get('/donations/:id/allocation', requirePermission('Funding.View'), ah(async (req, res) => {
  const donation = db.prepare('SELECT branch_id FROM donations WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!donation) throw new HttpError(404, 'Donation not found.');
  requireBranchResource(req, donation.branch_id);
  res.json(getDonationUnallocated(db, req.params.id));
}));

// Scholarships and award settlement
fundingRouter.get('/scholarships', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  res.json(listScholarships(branchId, isAll));
}));

fundingRouter.post('/scholarships', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branchId = mutationBranch(req, body);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(400, 'Scholarship name is required.');
  const totalBudget = assertMoney(body.totalBudget, 'scholarship declared target');
  const donorId = optionalId(body.donorId, 'donorId');
  const campaignId = optionalId(body.campaignId, 'campaignId');
  if (donorId && !db.prepare('SELECT 1 FROM donors WHERE id = ?').get(donorId)) throw new HttpError(404, 'Donor not found.');
  if (campaignId) {
    const campaign = db.prepare('SELECT branch_id FROM funding_campaigns WHERE id = ?').get(campaignId) as { branch_id: string } | undefined;
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    if (campaign.branch_id !== branchId) throw new HttpError(400, 'Campaign belongs to another branch.');
  }
  const scholarshipId = id('sch');
  db.prepare(
    `INSERT INTO scholarships (id, name, donor_id, campaign_id, total_budget, criteria, status, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(scholarshipId, name, donorId, campaignId, totalBudget, typeof body.criteria === 'string' ? body.criteria.trim() || null : null, branchId);
  writeAudit(req, `Created scholarship ${scholarshipId}`, { branchId });
  res.status(201).json({ id: scholarshipId });
}));

fundingRouter.get('/scholarships/awards', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const rows = isAll
    ? db.prepare('SELECT * FROM scholarship_awards ORDER BY award_date DESC, id').all()
    : db.prepare('SELECT * FROM scholarship_awards WHERE branch_id = ? ORDER BY award_date DESC, id').all(branchId);
  res.json(rows);
}));

fundingRouter.post('/scholarships/award', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branchId = mutationBranch(req, body);
  const scholarshipId = trimmedId(body.scholarshipId, 'scholarshipId');
  const studentId = trimmedId(body.studentId, 'studentId');
  const amount = assertMoney(body.amount, 'award amount');
  if (amount <= 0) throw new HttpError(400, 'award amount must be greater than zero.');
  const scholarship = db.prepare('SELECT branch_id, status FROM scholarships WHERE id = ?').get(scholarshipId) as { branch_id: string; status: string } | undefined;
  if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
  if (scholarship.branch_id !== branchId) throw new HttpError(400, 'Scholarship belongs to another branch.');
  if (scholarship.status !== 'active') throw new HttpError(409, 'Scholarship is closed.');
  const student = db.prepare('SELECT branch_id FROM students WHERE id = ?').get(studentId) as { branch_id: string } | undefined;
  if (!student) throw new HttpError(404, 'Student not found.');
  if (student.branch_id !== branchId) throw new HttpError(400, 'Student belongs to another branch.');
  const fund = getFundPosition(db, scholarshipId);
  if (amount > fund.available) throw new HttpError(409, `Only ${fund.available} AFN is available in this scholarship fund.`);
  const awardId = id('scha');
  const awardDate = assertOptionalIsoDate(body.awardDate, 'awardDate') ?? today();
  const studentName = (db.prepare('SELECT full_name FROM students WHERE id = ?').get(studentId) as { full_name: string } | undefined)?.full_name ?? null;
  // Row and event commit together (audit F-A2: the scholarship.awarded
  // notification handler existed with no emitter).
  const { awardEvent } = db.transaction(() => {
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, award_date, notes, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(awardId, scholarshipId, studentId, amount, awardDate, typeof body.notes === 'string' ? body.notes.trim() || null : null, branchId);
    return {
      awardEvent: eventBus.emit(
        'scholarship.awarded', 'scholarship', awardId,
        { studentName, studentId, scholarshipId, amount, branchId },
        { operatorId: req.user?.userId ?? null, branchId },
      ),
    };
  })();
  if (awardEvent) void eventBus.dispatch(awardEvent);
  writeAudit(req, `Created scholarship award ${awardId}`, { branchId, newValue: JSON.stringify({ scholarshipId, studentId, amount }) });
  res.status(201).json({ id: awardId, fund: getFundPosition(db, scholarshipId) });
}));

fundingRouter.get('/scholarships/:id/position', requirePermission('Funding.View'), ah(async (req, res) => {
  const scholarship = db.prepare('SELECT * FROM scholarships WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
  requireBranchResource(req, String(scholarship.branch_id));
  const fundings = db.prepare(
    `SELECT sf.*, COALESCE(sf.donation_id, cfe.source_donation_id) AS source_donation_id,
            COALESCE(cfe.campaign_id, d.campaign_id) AS source_campaign_id
       FROM scholarship_fundings sf
       LEFT JOIN campaign_funding_entries cfe ON cfe.id = sf.campaign_funding_entry_id
       LEFT JOIN donations d ON d.id = sf.donation_id
      WHERE sf.scholarship_id = ? ORDER BY sf.date DESC, sf.id DESC`,
  ).all(req.params.id) as Array<Record<string, unknown>>;
  res.json({ ...getFundPosition(db, req.params.id), declaredTarget: Number(scholarship.total_budget), fundings: fundings.map((row) => ({ ...row, source: getScholarshipFundingPosition(db, String(row.id)) })) });
}));

fundingRouter.get('/scholarships/:id/funding-sources', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const scholarship = db.prepare('SELECT branch_id, campaign_id FROM scholarships WHERE id = ?').get(req.params.id) as { branch_id: string; campaign_id: string | null } | undefined;
  if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
  requireBranchResource(req, scholarship.branch_id);
  const donations = db.prepare(
    `SELECT d.id FROM donations d
      WHERE d.branch_id = ? AND NOT EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = d.id)
      ORDER BY d.date DESC`,
  ).all(scholarship.branch_id) as Array<{ id: string }>;
  const campaignEntries = scholarship.campaign_id
    ? db.prepare('SELECT id FROM campaign_funding_entries WHERE campaign_id = ? ORDER BY date DESC').all(scholarship.campaign_id) as Array<{ id: string }>
    : [];
  res.json({
    donations: donations.map((row) => donationSourceForFunding(row.id)).filter((row) => row.unallocated > 0),
    campaignFundingEntries: campaignEntries.map((row) => ({ ...getCampaignFundingEntryPosition(db, row.id), id: row.id })).filter((row) => row.available > 0),
  });
}));

fundingRouter.post('/scholarships/:id/fundings', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const scholarship = db.prepare('SELECT branch_id FROM scholarships WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
  requireBranchResource(req, scholarship.branch_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const source = parseSource(body);
  const amount = assertMoney(body.amount, 'funding amount');
  const user = userContext(req);
  let fundingId = '';
  db.transaction(() => {
    fundingId = fundScholarshipFromSource(db, {
      scholarshipId: req.params.id, source, amount, branchId: scholarship.branch_id,
      operatorName: user.fullName, date: assertOptionalIsoDate(body.date, 'funding date') ?? today(),
    }).fundingId;
  })();
  writeAudit(req, `Funded scholarship ${req.params.id}`, { branchId: scholarship.branch_id, newValue: JSON.stringify({ fundingId, source, amount }) });
  res.status(201).json({ id: fundingId, fund: getFundPosition(db, req.params.id) });
}));

fundingRouter.get('/students/:studentId/tuition-obligations', requirePermission('Funding.View'), ah(async (req, res) => {
  const student = db.prepare('SELECT branch_id FROM students WHERE id = ?').get(req.params.studentId) as { branch_id: string } | undefined;
  if (!student) throw new HttpError(404, 'Student not found.');
  requireBranchResource(req, student.branch_id);
  res.json(listTuitionObligations(db, req.params.studentId).map((obligation) => {
    const position = getObligationPosition(db, obligation.id);
    return { id: obligation.id, semesterId: obligation.semesterId, semesterName: obligation.semesterName, netAmount: obligation.netAmount, settledCash: position.settledCash, settledAid: position.settledAid, outstanding: position.outstanding, status: obligation.status };
  }));
}));

fundingRouter.get('/scholarship-awards/:id', requirePermission('Funding.View'), ah(async (req, res) => {
  const award = db.prepare('SELECT branch_id FROM scholarship_awards WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!award) throw new HttpError(404, 'Scholarship award not found.');
  requireBranchResource(req, award.branch_id);
  const allocations = db.prepare(
    `SELECT a.*, ss.semester_name
       FROM obligation_allocations a
       JOIN student_obligations o ON o.id = a.obligation_id
       LEFT JOIN student_semesters ss ON ss.id = o.semester_id
      WHERE a.scholarship_award_id = ? ORDER BY a.date DESC, a.id DESC`,
  ).all(req.params.id);
  res.json({ ...getAwardPosition(db, req.params.id), allocations });
}));

fundingRouter.post('/scholarship-awards/:id/allocations', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const award = db.prepare('SELECT branch_id FROM scholarship_awards WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!award) throw new HttpError(404, 'Scholarship award not found.');
  requireBranchResource(req, award.branch_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obligationId = trimmedId(body.obligationId, 'obligationId');
  const scholarshipFundingId = trimmedId(body.scholarshipFundingId ?? body.sourceId, 'scholarshipFundingId');
  const amount = assertMoney(body.amount, 'allocation amount');
  const user = userContext(req);
  let allocationId = '';
  let repriced: ReturnType<typeof repriceTuitionInvoicesAfterAid> | undefined;
  db.transaction(() => {
    allocationId = allocateScholarshipToObligation(db, { awardId: req.params.id, scholarshipFundingId, obligationId, amount, operatorName: user.fullName }).allocationId;
    // Aid settles the TERM; the tuition invoices billing it must not keep
    // promising what is no longer collectable. Unpaid ones are cancelled and
    // one replacement is issued for the residual, in this same transaction.
    repriced = repriceTuitionInvoicesAfterAid(db, { obligationId, operatorName: user.fullName, note: `scholarship allocation ${allocationId} (${amount} AFN)` });
  })();
  writeAudit(req, `Applied scholarship award ${req.params.id}`, { branchId: award.branch_id, newValue: JSON.stringify({ allocationId, obligationId, scholarshipFundingId, amount, cancelledInvoices: repriced?.cancelled ?? [], reissuedInvoiceId: repriced?.reissuedInvoiceId ?? null }) });
  res.status(201).json({ id: allocationId, award: getAwardPosition(db, req.params.id), obligation: getObligationPosition(db, obligationId) });
}));

fundingRouter.post('/scholarship-awards/:id/allocations/:allocationId/reverse', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const award = db.prepare('SELECT branch_id FROM scholarship_awards WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!award) throw new HttpError(404, 'Scholarship award not found.');
  requireBranchResource(req, award.branch_id);
  const allocation = db.prepare('SELECT obligation_id, scholarship_award_id FROM obligation_allocations WHERE id = ?').get(req.params.allocationId) as { obligation_id: string; scholarship_award_id: string | null } | undefined;
  if (!allocation) throw new HttpError(404, 'Allocation not found.');
  if (allocation.scholarship_award_id !== req.params.id) throw new HttpError(400, 'Allocation belongs to another award.');
  const reason = typeof (req.body as any)?.reason === 'string' ? (req.body as any).reason : '';
  db.transaction(() => {
    reverseScholarshipAllocation(db, { allocationId: req.params.allocationId, reason, operatorName: userContext(req).fullName });
    // The obligation re-opens by the reversed amount, so its collection
    // documents are re-priced to the new collectable figure — the mirror of
    // the re-pricing the allocation performed.
    repriceTuitionInvoicesAfterAid(db, { obligationId: allocation.obligation_id, operatorName: userContext(req).fullName, note: `scholarship allocation ${req.params.allocationId} reversed` });
  })();
  writeAudit(req, `Reversed scholarship allocation ${req.params.allocationId}`, { branchId: award.branch_id });
  res.json({ ok: true, award: getAwardPosition(db, req.params.id), obligation: getObligationPosition(db, allocation.obligation_id) });
}));

fundingRouter.post('/scholarship-awards/:id/close', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const award = db.prepare('SELECT branch_id, scholarship_id FROM scholarship_awards WHERE id = ?').get(req.params.id) as { branch_id: string; scholarship_id: string } | undefined;
  if (!award) throw new HttpError(404, 'Scholarship award not found.');
  requireBranchResource(req, award.branch_id);
  const reason = typeof (req.body as any)?.reason === 'string' ? (req.body as any).reason : '';
  let returnedToFund = 0;
  db.transaction(() => { returnedToFund = closeAward(db, { awardId: req.params.id, reason, operatorName: userContext(req).fullName }).returnedToFund; })();
  writeAudit(req, `Closed scholarship award ${req.params.id}`, { branchId: award.branch_id, newValue: JSON.stringify({ returnedToFund }) });
  res.json({ ok: true, returnedToFund, fund: getFundPosition(db, award.scholarship_id) });
}));

// Sponsorships
fundingRouter.get('/sponsorships', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  res.json(listSponsorships(branchId, isAll));
}));

fundingRouter.post('/sponsorships', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const branchId = mutationBranch(req, body);
  const donorId = trimmedId(body.donorId, 'donorId');
  const monthlyAmount = assertMoney(body.monthlyAmount, 'monthly sponsorship amount');
  const startDate = assertOptionalIsoDate(body.startDate, 'startDate') ?? today();
  const endDate = assertOptionalIsoDate(body.endDate, 'endDate');
  if (!endDate) throw new HttpError(400, 'endDate is required for a sponsorship agreement.');
  assertDateRange(startDate, endDate, 'startDate', 'endDate');
  if (!db.prepare('SELECT 1 FROM donors WHERE id = ?').get(donorId)) throw new HttpError(404, 'Donor not found.');
  const studentId = optionalId(body.studentId, 'studentId');
  const programId = optionalId(body.programId, 'programId');
  const campaignId = optionalId(body.campaignId, 'campaignId');
  if (studentId) {
    const student = db.prepare('SELECT branch_id FROM students WHERE id = ?').get(studentId) as { branch_id: string } | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.branch_id !== branchId) throw new HttpError(400, 'Student belongs to another branch.');
  }
  if (programId) {
    const program = db.prepare('SELECT branch_id FROM programs WHERE id = ?').get(programId) as { branch_id: string } | undefined;
    if (!program) throw new HttpError(404, 'Program not found.');
    if (program.branch_id !== branchId) throw new HttpError(400, 'Program belongs to another branch.');
  }
  if (campaignId) {
    const campaign = db.prepare('SELECT branch_id FROM funding_campaigns WHERE id = ?').get(campaignId) as { branch_id: string } | undefined;
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    if (campaign.branch_id !== branchId) throw new HttpError(400, 'Campaign belongs to another branch.');
  }
  const agreementId = id('spon');
  db.prepare(
    `INSERT INTO sponsorship_agreements
       (id, donor_id, student_id, program_id, campaign_id, monthly_amount, start_date, end_date, status, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(agreementId, donorId, studentId, programId, campaignId, monthlyAmount, startDate, endDate, branchId);
  writeAudit(req, `Created sponsorship agreement ${agreementId}`, { branchId });
  res.status(201).json({ id: agreementId });
}));

fundingRouter.get('/sponsorships/:id/position', requirePermission('Funding.View'), ah(async (req, res) => {
  const agreement = db.prepare('SELECT branch_id FROM sponsorship_agreements WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  requireBranchResource(req, agreement.branch_id);
  const receipts = db.prepare(
    `SELECT r.*, COALESCE(r.donation_id, cfe.source_donation_id) AS source_donation_id
       FROM sponsorship_receipts r LEFT JOIN campaign_funding_entries cfe ON cfe.id = r.campaign_funding_entry_id
      WHERE r.agreement_id = ? ORDER BY r.date DESC, r.id DESC`,
  ).all(req.params.id) as Array<Record<string, unknown>>;
  const allocations = db.prepare(
    `SELECT a.*, ss.semester_name, o.student_id
       FROM obligation_allocations a
       JOIN student_obligations o ON o.id = a.obligation_id
       LEFT JOIN student_semesters ss ON ss.id = o.semester_id
      WHERE a.sponsorship_agreement_id = ? ORDER BY a.date DESC, a.id DESC`,
  ).all(req.params.id);
  res.json({ ...getSponsorshipPosition(db, req.params.id), receipts: receipts.map((row) => ({ ...row, source: getSponsorshipReceiptPosition(db, String(row.id)) })), allocations });
}));

fundingRouter.get('/sponsorships/:id/funding-sources', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const agreement = db.prepare('SELECT branch_id, donor_id, campaign_id FROM sponsorship_agreements WHERE id = ?').get(req.params.id) as { branch_id: string; donor_id: string; campaign_id: string | null } | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  requireBranchResource(req, agreement.branch_id);
  const donations = db.prepare(
    `SELECT d.id FROM donations d
      WHERE d.branch_id = ? AND d.donor_id = ?
        AND NOT EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = d.id)
      ORDER BY d.date DESC`,
  ).all(agreement.branch_id, agreement.donor_id) as Array<{ id: string }>;
  const campaignEntries = agreement.campaign_id
    ? db.prepare(
      `SELECT cfe.id FROM campaign_funding_entries cfe
       JOIN donations d ON d.id = cfe.source_donation_id
       WHERE cfe.campaign_id = ? AND d.donor_id = ? ORDER BY cfe.date DESC`,
    ).all(agreement.campaign_id, agreement.donor_id) as Array<{ id: string }>
    : [];
  res.json({
    donations: donations.map((row) => donationSourceForFunding(row.id)).filter((row) => row.unallocated > 0),
    campaignFundingEntries: campaignEntries.map((row) => ({ ...getCampaignFundingEntryPosition(db, row.id), id: row.id })).filter((row) => row.available > 0),
  });
}));

fundingRouter.post('/sponsorships/:id/receipts', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const agreement = db.prepare('SELECT branch_id FROM sponsorship_agreements WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  requireBranchResource(req, agreement.branch_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const source = parseSource(body);
  const amount = assertMoney(body.amount, 'receipt amount');
  const user = userContext(req);
  let receiptId = '';
  db.transaction(() => {
    receiptId = recordSponsorshipReceipt(db, {
      agreementId: req.params.id, source, amount, branchId: agreement.branch_id,
      operatorName: user.fullName, date: assertOptionalIsoDate(body.date, 'receipt date') ?? today(),
    }).receiptId;
  })();
  writeAudit(req, `Recorded sponsorship receipt ${receiptId}`, { branchId: agreement.branch_id, newValue: JSON.stringify({ source, amount }) });
  res.status(201).json({ id: receiptId, sponsorship: getSponsorshipPosition(db, req.params.id) });
}));

fundingRouter.post('/sponsorships/:id/allocations', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const agreement = db.prepare('SELECT branch_id FROM sponsorship_agreements WHERE id = ?').get(req.params.id) as { branch_id: string } | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  requireBranchResource(req, agreement.branch_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obligationId = trimmedId(body.obligationId, 'obligationId');
  const sponsorshipReceiptId = trimmedId(body.sponsorshipReceiptId ?? body.sourceId, 'sponsorshipReceiptId');
  const amount = assertMoney(body.amount, 'allocation amount');
  let allocationId = '';
  let repriced: ReturnType<typeof repriceTuitionInvoicesAfterAid> | undefined;
  db.transaction(() => {
    allocationId = allocateSponsorshipToObligation(db, { agreementId: req.params.id, sponsorshipReceiptId, obligationId, amount, operatorName: userContext(req).fullName }).allocationId;
    repriced = repriceTuitionInvoicesAfterAid(db, { obligationId, operatorName: userContext(req).fullName, note: `sponsorship allocation ${allocationId} (${amount} AFN)` });
  })();
  writeAudit(req, `Applied sponsorship ${req.params.id}`, { branchId: agreement.branch_id, newValue: JSON.stringify({ allocationId, obligationId, sponsorshipReceiptId, amount, cancelledInvoices: repriced?.cancelled ?? [], reissuedInvoiceId: repriced?.reissuedInvoiceId ?? null }) });
  res.status(201).json({ id: allocationId, sponsorship: getSponsorshipPosition(db, req.params.id), obligation: getObligationPosition(db, obligationId) });
}));

fundingRouter.post('/sponsorship-allocations/:id/reverse', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const allocation = db.prepare(
    `SELECT a.obligation_id, a.sponsorship_agreement_id, s.branch_id
       FROM obligation_allocations a JOIN sponsorship_agreements s ON s.id = a.sponsorship_agreement_id
      WHERE a.id = ?`,
  ).get(req.params.id) as { obligation_id: string; sponsorship_agreement_id: string; branch_id: string } | undefined;
  if (!allocation) throw new HttpError(404, 'Sponsorship allocation not found.');
  requireBranchResource(req, allocation.branch_id);
  const reason = typeof (req.body as any)?.reason === 'string' ? (req.body as any).reason : '';
  db.transaction(() => {
    reverseSponsorshipAllocation(db, { allocationId: req.params.id, reason, operatorName: userContext(req).fullName });
    repriceTuitionInvoicesAfterAid(db, { obligationId: allocation.obligation_id, operatorName: userContext(req).fullName, note: `sponsorship allocation ${req.params.id} reversed` });
  })();
  writeAudit(req, `Reversed sponsorship allocation ${req.params.id}`, { branchId: allocation.branch_id });
  res.json({ ok: true, sponsorship: getSponsorshipPosition(db, allocation.sponsorship_agreement_id), obligation: getObligationPosition(db, allocation.obligation_id) });
}));

fundingRouter.patch('/sponsorships/:id', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const existing = db.prepare('SELECT * FROM sponsorship_agreements WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, 'Sponsorship agreement not found.');
  requireBranchResource(req, String(existing.branch_id));
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestedStatus = body.status;
  if (requestedStatus === 'completed' || requestedStatus === 'terminated') {
    if (body.monthlyAmount !== undefined || body.endDate !== undefined) throw new HttpError(400, 'A terminal transition cannot alter agreement terms.');
    const reason = typeof body.reason === 'string' ? body.reason : '';
    let result: ReturnType<typeof terminalizeSponsorship>;
    db.transaction(() => {
      result = terminalizeSponsorship(db, { agreementId: req.params.id, status: requestedStatus, reason, operator: { userId: userContext(req).userId, fullName: userContext(req).fullName, role: req.rbac?.primaryRole ?? null } });
    })();
    writeAudit(req, `Terminalized sponsorship ${req.params.id}`, { branchId: String(existing.branch_id), newValue: JSON.stringify({ status: requestedStatus, returned: result!.returned, campaignId: result!.campaignId }) });
    return res.json({ ok: true, ...result! });
  }
  if (requestedStatus !== undefined && requestedStatus !== 'active') throw new HttpError(400, 'Invalid sponsorship status.');
  if (existing.status !== 'active') throw new HttpError(409, 'A terminal sponsorship agreement cannot be modified.');
  const monthlyAmount = body.monthlyAmount === undefined ? Number(existing.monthly_amount) : assertMoney(body.monthlyAmount, 'monthly sponsorship amount');
  const endDate = body.endDate === undefined ? String(existing.end_date) : assertOptionalIsoDate(body.endDate, 'endDate');
  if (!endDate) throw new HttpError(400, 'endDate is required for a sponsorship agreement.');
  assertDateRange(String(existing.start_date), endDate, 'startDate', 'endDate');
  db.prepare('UPDATE sponsorship_agreements SET monthly_amount = ?, end_date = ? WHERE id = ? AND status = \'active\'').run(monthlyAmount, endDate, req.params.id);
  writeAudit(req, `Updated sponsorship ${req.params.id}`, { branchId: String(existing.branch_id) });
  res.json({ ok: true });
}));

fundingRouter.get('/summary', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  res.json(getFundingSummary(db, isAll ? null : branchId));
}));

// ── RESTRICTED-FUND EXPOSURE (W12 / W9 §3 model 2 — authorized, view-only) ──
// A DERIVED VIEW of the authoritative funding subledger + store conservation
// figure: who restricted what, what it settled, what remains, and how much of
// the cash in stores is economically the donors'. No enforcement (P11); no
// second ledger — every number traces to donations/allocation facts or the
// same held-total invariant I16 reconciles.
fundingRouter.get('/restricted-exposure', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  res.json(getRestrictedExposure(db, isAll ? null : branchId));
}));

// ── WAVE 16 · Donation clawbacks (restricted money returned to the funder) ──
// Standard semantics (owner-authorized): a clawback is a repayment obligation,
// never negative operating revenue. Declaration opens the liability; repayment
// moves branch cash out through the P&L-neutral 'restricted_reclaim' ledger
// type. Only a donation's UNCOMMITTED restricted remainder is reclaimable
// (D-DC-3 partial-clawback ordering remains POLICY REQUIRED).
fundingRouter.post('/donations/:id/clawback', requirePermission('Funding.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = userContext(req);
  let clawbackId = '';
  db.transaction(() => {
    clawbackId = declareDonationClawback(db, {
      donationId: req.params.id,
      amount: assertMoney(body.amount, 'clawback amount'),
      reason: String(body.reason ?? ''),
      operator: { name: user.fullName, role: req.rbac?.primaryRole ?? null },
    }).clawbackId;
  })();
  writeAudit(req, `Declared donation clawback ${clawbackId} on donation ${req.params.id}`, { newValue: JSON.stringify({ amount: body.amount }) });
  res.status(201).json({ id: clawbackId, status: 'open' });
}));

// ── WAVE 17 · Clawback register (read) ──
// The exposure view aggregates; this lists the individual repayment
// obligations with their status and cash evidence. Pure observability over
// the W16 authority: no mutation surface is added, and every figure traces to
// donation_clawbacks/donations/donors rows.
fundingRouter.get('/donation-clawbacks', requirePermission('Funding.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const scope = isAll ? '' : 'AND d.branch_id = ?';
  const params = isAll ? [] : [branchId];
  const rows = db.prepare(
    `SELECT c.id, c.amount, c.reason, c.status, c.declared_on, c.repaid_on,
            c.repaid_transaction_id, c.declared_by, c.created_at,
            c.attributed_kind, c.attributed_id,
            c.donation_id, d.amount AS donation_amount, d.donor_id,
            dn.full_name AS donor_name, d.branch_id
       FROM donation_clawbacks c
       JOIN donations d ON d.id = c.donation_id
       LEFT JOIN donors dn ON dn.id = d.donor_id
      WHERE 1=1 ${scope}
      ORDER BY datetime(c.created_at) DESC, c.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
  const openTotal = rows.filter((r) => r.status === 'open').reduce((s, r) => s + Number(r.amount), 0);
  const repaidTotal = rows.filter((r) => r.status === 'repaid').reduce((s, r) => s + Number(r.amount), 0);
  res.json({
    scope: isAll ? 'organization' : 'branch',
    branchId: branchId ?? null,
    counts: { open: rows.filter((r) => r.status === 'open').length, repaid: rows.filter((r) => r.status === 'repaid').length },
    totals: { open: openTotal, repaid: repaidTotal },
    clawbacks: rows.map((r) => ({
      id: r.id, donationId: r.donation_id, donationAmount: r.donation_amount,
      attributedKind: r.attributed_kind ?? null, attributedId: r.attributed_id ?? null,
      donorId: r.donor_id ?? null, donorName: r.donor_name ?? null,
      amount: r.amount, reason: r.reason, status: r.status,
      declaredOn: r.declared_on, declaredBy: r.declared_by ?? null,
      repaidOn: r.repaid_on ?? null, repaidTransactionId: r.repaid_transaction_id ?? null,
      recordedAt: r.created_at,
    })),
  });
}));

fundingRouter.post('/donation-clawbacks/:id/repay'
, requirePermission('Funding.Edit'), ah(async (req, res) => {
  const user = userContext(req);
  let transactionId = '';
  db.transaction(() => {
    transactionId = repayDonationClawback(db, req.params.id, { name: user.fullName, role: req.rbac?.primaryRole ?? null }).transactionId;
  })();
  writeAudit(req, `Repaid donation clawback ${req.params.id}`, { newValue: JSON.stringify({ transactionId }) });
  res.json({ ok: true, id: req.params.id, status: 'repaid', transactionId });
}));

export default fundingRouter;
