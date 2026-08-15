import { nextScopedDocumentNumber } from '../utils/documentNumbers.js';
/**
TOEFL House ERP — Funding Routes (BC #11)
============================================================
REST endpoints for the Funding Bounded Context: donors, funding
campaigns, donations, scholarships, scholarship awards, and
sponsorship agreements.

Access control:
  donor_manager, manager, owner: full CRUD on all entities
  finance: read-only + record donations (financial reconciliation)
  registrar: read-only (view scholarships for student enrollment)

Every mutation publishes a Domain Event via the Event Bus and
writes an audit log entry.

@module routes/funding.routes
@version 2.0.0
@license Apache-2.0
*/
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';
import { resolveIdempotency } from '../utils/idempotency.js';
import { eventBus } from '../core/events/event-bus.js';

export const fundingRouter = Router();
fundingRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
// Donors
const stmtGetAllDonors = db.prepare('SELECT * FROM donors ORDER BY created_at DESC');
const stmtGetDonorById = db.prepare('SELECT * FROM donors WHERE id = ?');
const stmtInsertDonor = db.prepare(
  `INSERT INTO donors (id, full_name, type, phone, email, country, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
);
const stmtUpdateDonor = db.prepare(
  `UPDATE donors SET full_name = ?, type = ?, phone = ?, email = ?, country = ?, notes = ? WHERE id = ?`
);
const stmtGetDonorTotalDonated = db.prepare('SELECT COALESCE(SUM(amount), 0) as totalDonated FROM donations WHERE donor_id = ?');
const stmtGetDonorActiveSponsorships = db.prepare("SELECT COUNT(*) as activeSponsorships FROM sponsorship_agreements WHERE donor_id = ? AND status = 'active'");
const stmtGetDonorCampaigns = db.prepare('SELECT * FROM funding_campaigns WHERE donor_id = ? ORDER BY start_date DESC');

// Campaigns
const stmtGetAllCampaigns = db.prepare('SELECT * FROM funding_campaigns ORDER BY start_date DESC');
const stmtGetCampaignsByBranch = db.prepare('SELECT * FROM funding_campaigns WHERE branch_id = ? ORDER BY start_date DESC');
const stmtGetCampaignById = db.prepare('SELECT * FROM funding_campaigns WHERE id = ?');
const stmtInsertCampaign = db.prepare(
  `INSERT INTO funding_campaigns (id, name, description, donor_id, target_amount, raised_amount, start_date, end_date, status, branch_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?)`
);
const stmtUpdateCampaign = db.prepare(
  `UPDATE funding_campaigns SET name = ?, description = ?, target_amount = ?, end_date = ?, status = ? WHERE id = ?`
);
const stmtUpdateCampaignRaisedAmount = db.prepare('UPDATE funding_campaigns SET raised_amount = raised_amount + ? WHERE id = ?');

// Donations
const stmtGetAllDonations = db.prepare(
  `SELECT d.*, dn.full_name as donor_name, fc.name as campaign_name FROM donations d LEFT JOIN donors dn ON dn.id = d.donor_id LEFT JOIN funding_campaigns fc ON fc.id = d.campaign_id ORDER BY d.date DESC`
);
const stmtGetDonationsByBranch = db.prepare(
  `SELECT d.*, dn.full_name as donor_name, fc.name as campaign_name FROM donations d LEFT JOIN donors dn ON dn.id = d.donor_id LEFT JOIN funding_campaigns fc ON fc.id = d.campaign_id WHERE d.branch_id = ? ORDER BY d.date DESC`
);
const stmtInsertDonation = db.prepare(
  `INSERT INTO donations (id, campaign_id, donor_id, amount, date, restricted, restriction_note, receipt_no, branch_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Scholarships
const stmtGetAllScholarships = db.prepare(
  `SELECT s.*, d.full_name as donor_name, fc.name as campaign_name FROM scholarships s LEFT JOIN donors d ON d.id = s.donor_id LEFT JOIN funding_campaigns fc ON fc.id = s.campaign_id ORDER BY s.created_at DESC`
);
const stmtGetScholarshipsByBranch = db.prepare(
  `SELECT s.*, d.full_name as donor_name, fc.name as campaign_name FROM scholarships s LEFT JOIN donors d ON d.id = s.donor_id LEFT JOIN funding_campaigns fc ON fc.id = s.campaign_id WHERE s.branch_id = ? ORDER BY s.created_at DESC`
);
const stmtInsertScholarship = db.prepare(
  `INSERT INTO scholarships (id, name, donor_id, campaign_id, total_budget, allocated_amount, criteria, status, branch_id) VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)`
);
const stmtGetScholarshipById = db.prepare('SELECT * FROM scholarships WHERE id = ?');
const stmtUpdateScholarshipAllocation = db.prepare('UPDATE scholarships SET allocated_amount = ?, status = ? WHERE id = ?');

// Scholarship Awards
const stmtGetAllAwards = db.prepare(
  `SELECT sa.*, s.name as scholarship_name, st.full_name as student_name, st.student_code FROM scholarship_awards sa JOIN scholarships s ON s.id = sa.scholarship_id JOIN students st ON st.id = sa.student_id ORDER BY sa.award_date DESC`
);
const stmtGetAwardsByBranch = db.prepare(
  `SELECT sa.*, s.name as scholarship_name, st.full_name as student_name, st.student_code FROM scholarship_awards sa JOIN scholarships s ON s.id = sa.scholarship_id JOIN students st ON st.id = sa.student_id WHERE sa.branch_id = ? ORDER BY sa.award_date DESC`
);
const stmtInsertAward = db.prepare(
  `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, award_date, semester, notes, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetStudentById = db.prepare('SELECT * FROM students WHERE id = ?');

// Sponsorships
const stmtGetAllSponsorships = db.prepare(
  `SELECT sp.*, d.full_name as donor_name, st.full_name as student_name, st.student_code FROM sponsorship_agreements sp LEFT JOIN donors d ON d.id = sp.donor_id LEFT JOIN students st ON st.id = sp.student_id ORDER BY sp.start_date DESC`
);
const stmtGetSponsorshipsByBranch = db.prepare(
  `SELECT sp.*, d.full_name as donor_name, st.full_name as student_name, st.student_code FROM sponsorship_agreements sp LEFT JOIN donors d ON d.id = sp.donor_id LEFT JOIN students st ON st.id = sp.student_id WHERE sp.branch_id = ? ORDER BY sp.start_date DESC`
);
const stmtInsertSponsorship = db.prepare(
  `INSERT INTO sponsorship_agreements (id, donor_id, student_id, program_id, monthly_amount, start_date, end_date, status, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
);
const stmtGetSponsorshipById = db.prepare('SELECT * FROM sponsorship_agreements WHERE id = ?');
const stmtUpdateSponsorship = db.prepare(
  `UPDATE sponsorship_agreements SET monthly_amount = ?, end_date = ?, status = ? WHERE id = ?`
);

// Summary
const stmtGetTotalDonationsAll = db.prepare('SELECT COALESCE(SUM(amount), 0) as totalDonations FROM donations');
const stmtGetTotalDonationsByBranch = db.prepare('SELECT COALESCE(SUM(amount), 0) as totalDonations FROM donations WHERE branch_id = ?');
const stmtGetTotalScholarshipBudgetAll = db.prepare('SELECT COALESCE(SUM(total_budget), 0) as totalScholarshipBudget FROM scholarships');
const stmtGetTotalScholarshipBudgetByBranch = db.prepare('SELECT COALESCE(SUM(total_budget), 0) as totalScholarshipBudget FROM scholarships WHERE branch_id = ?');
const stmtGetTotalScholarshipAllocatedAll = db.prepare('SELECT COALESCE(SUM(allocated_amount), 0) as totalScholarshipAllocated FROM scholarships');
const stmtGetTotalScholarshipAllocatedByBranch = db.prepare('SELECT COALESCE(SUM(allocated_amount), 0) as totalScholarshipAllocated FROM scholarships WHERE branch_id = ?');
const stmtGetActiveSponsorshipsAll = db.prepare("SELECT COUNT(*) as activeSponsorships FROM sponsorship_agreements WHERE status = 'active'");
const stmtGetActiveSponsorshipsByBranch = db.prepare("SELECT COUNT(*) as activeSponsorships FROM sponsorship_agreements WHERE branch_id = ? AND status = 'active'");
const stmtGetActiveCampaignsAll = db.prepare("SELECT COUNT(*) as activeCampaigns FROM funding_campaigns WHERE status = 'active'");
const stmtGetActiveCampaignsByBranch = db.prepare("SELECT COUNT(*) as activeCampaigns FROM funding_campaigns WHERE branch_id = ? AND status = 'active'");
const stmtGetDonorCount = db.prepare('SELECT COUNT(*) as donorCount FROM donors');
const stmtGetStudentsSponsoredAll = db.prepare("SELECT COUNT(DISTINCT student_id) as studentsSponsored FROM sponsorship_agreements WHERE status = 'active' AND student_id IS NOT NULL");
const stmtGetStudentsSponsoredByBranch = db.prepare("SELECT COUNT(DISTINCT student_id) as studentsSponsored FROM sponsorship_agreements WHERE branch_id = ? AND status = 'active' AND student_id IS NOT NULL");

/** Safely extracts user context required for mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for funding operation.');
  }
  return user;
}

function requireFundingBranchAccess(req: import('express').Request, branchId: string | null | undefined) {
  if (!branchId || !canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Funding resource belongs to another branch.');
  }
}

// ============================================================================
// §1 — DONORS
// ============================================================================

fundingRouter.get(
  '/donors',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (_req, res) => {
    res.json(stmtGetAllDonors.all());
  })
);

fundingRouter.get(
  '/donors/:id',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const donor = stmtGetDonorById.get(req.params.id) as any;
    if (!donor) throw new HttpError(404, 'Donor not found.');

    const totalDonated = (stmtGetDonorTotalDonated.get(req.params.id) as any).totalDonated;
    const activeSponsorships = (stmtGetDonorActiveSponsorships.get(req.params.id) as any).activeSponsorships;
    const campaigns = stmtGetDonorCampaigns.all(req.params.id);

    res.json({ ...donor, totalDonated, activeSponsorships, campaigns });
  })
);

fundingRouter.post(
  '/donors',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { fullName, type, phone, email, country, notes } = req.body;
    
    if (!fullName) throw new HttpError(400, 'Donor full name is required.');
    if (!type || !['individual', 'organization', 'ngo', 'government'].includes(type)) {
      throw new HttpError(400, 'Invalid donor type.');
    }

    const newId = id('donor');
    const tx = db.transaction(() => {
      stmtInsertDonor.run(newId, fullName, type, phone || null, email || null, country || null, notes || null);
      return eventBus.emit('donor.created', 'donor', newId, { fullName, type, country }, { operatorId: user.userId, branchId: user.branchId });
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Created new donor: ${fullName} (${type})`);
    res.status(201).json({ id: newId });
  })
);

fundingRouter.put(
  '/donors/:id',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const existing = stmtGetDonorById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Donor not found.');

    const { fullName, type, phone, email, country, notes } = req.body;
    stmtUpdateDonor.run(
      fullName ?? existing.full_name, type ?? existing.type, phone ?? existing.phone,
      email ?? existing.email, country ?? existing.country, notes ?? existing.notes, req.params.id
    );

    writeAudit(req, `Updated donor: ${existing.full_name}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §2 — FUNDING CAMPAIGNS
// ============================================================================

fundingRouter.get(
  '/campaigns',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllCampaigns.all() : stmtGetCampaignsByBranch.all(branchId);
    res.json(rows);
  })
);

fundingRouter.post(
  '/campaigns',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { name, description, donorId, targetAmount, startDate, endDate } = req.body;
    
    if (!name || !targetAmount) throw new HttpError(400, 'Campaign name and target amount are required.');

    const newId = id('camp');
    const tx = db.transaction(() => {
      stmtInsertCampaign.run(
        newId, name, description || null, donorId || null, targetAmount,
        startDate || today(), endDate || null, user.branchId
      );
      return eventBus.emit('campaign.created', 'campaign', newId, { name, targetAmount }, { operatorId: user.userId, branchId: user.branchId });
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Created funding campaign: ${name} (target: ${targetAmount} AFN)`);
    res.status(201).json({ id: newId });
  })
);

fundingRouter.patch(
  '/campaigns/:id',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const existing = stmtGetCampaignById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Campaign not found.');
    requireFundingBranchAccess(req, existing.branch_id);

    const { name, description, targetAmount, endDate, status } = req.body;
    if (status && !['active', 'completed', 'cancelled'].includes(status)) {
      throw new HttpError(400, 'Invalid campaign status.');
    }

    stmtUpdateCampaign.run(
      name ?? existing.name, description ?? existing.description, targetAmount ?? existing.target_amount,
      endDate ?? existing.end_date, status ?? existing.status, req.params.id
    );

    writeAudit(req, `Updated campaign: ${existing.name}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §3 — DONATIONS
// ============================================================================

fundingRouter.get(
  '/donations',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllDonations.all() : stmtGetDonationsByBranch.all(branchId);
    res.json(rows);
  })
);

fundingRouter.post(
  '/donations',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { campaignId, donorId, amount, date, restricted, restrictionNote } = req.body;
    
    if (!donorId || !amount || amount <= 0) throw new HttpError(400, 'Donor and a positive amount are required.');

    const donor = stmtGetDonorById.get(donorId) as any;
    if (!donor) throw new HttpError(404, 'Donor not found.');
    if (campaignId) {
      const campaign = stmtGetCampaignById.get(campaignId) as any;
      if (!campaign) throw new HttpError(404, 'Campaign not found.');
      requireFundingBranchAccess(req, campaign.branch_id);
    }

    const donationDate = date || today();
    const newId = id('dn');

    // Duplicate protection: a double-click / retry previously recorded one
    // donation and one income row per click. Explicit client key wins;
    // otherwise a fingerprint of the donation intent within a short window
    // collapses retries. A genuinely repeated gift (later, or explicitly
    // keyed) still succeeds.
    const { candidates: donationIdemCandidates } = resolveIdempotency(req, {
      route: 'donation',
      donorId,
      campaignId: campaignId || null,
      amount: Number(amount),
      date: donationDate,
      actorUserId: user.userId ?? null,
    });
    const priorDonation = db.prepare(
      `SELECT id, receipt_no FROM donations WHERE idempotency_key IN (${donationIdemCandidates.map(() => '?').join(',')}) LIMIT 1`
    ).get(...donationIdemCandidates) as { id?: string; receipt_no?: string } | undefined;
    if (priorDonation?.id) return res.status(200).json({ id: priorDonation.id, receiptNo: priorDonation.receipt_no, idempotentReplay: true });
    const donationIdemKey = donationIdemCandidates[0];

    const receiptNo = nextScopedDocumentNumber('donation_receipt', user.branchId, 'DON');

    const tx = db.transaction(() => {
      stmtInsertDonation.run(
        newId, campaignId || null, donorId, amount, donationDate, 
        restricted ? 1 : 0, restrictionNote || null, receiptNo, user.branchId, donationIdemKey
      );

      if (campaignId) {
        stmtUpdateCampaignRaisedAmount.run(amount, campaignId);
      }

      recordIncome({
        category: 'donation', amount, date: donationDate,
        description: `Donation received from ${donor.full_name}${campaignId ? ' (campaign)' : ''}${restricted ? ' [RESTRICTED]' : ''}`,
        referenceId: newId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: user.branchId,
      });
      return eventBus.emit('donation.received', 'donation', newId, 
      { donorId, donorName: donor.full_name, amount, campaignId, restricted: !!restricted }, 
      { operatorId: user.userId, branchId: user.branchId }
      );
    });
    let event;
    try {
      event = tx();
    } catch (err) {
      // Atomic backstop: several concurrent requests can pass the check
      // above, but only one wins the unique index. Losers replay the
      // winner's donation instead of recording the gift twice.
      if (String((err as { message?: string })?.message ?? '').includes('UNIQUE constraint failed')) {
        const winner = db.prepare('SELECT id, receipt_no FROM donations WHERE idempotency_key = ?').get(donationIdemKey) as { id?: string; receipt_no?: string } | undefined;
        if (winner?.id) return res.status(200).json({ id: winner.id, receiptNo: winner.receipt_no, idempotentReplay: true });
      }
      throw err;
    }
    void eventBus.dispatch(event);

    addNotification('Donation Received', `A donation of ${amount.toLocaleString()} AFN was received from ${donor.full_name}. Receipt: ${receiptNo}`, 'success', user.branchId);
    writeAudit(req, `Recorded donation: ${amount} AFN from ${donor.full_name} (receipt: ${receiptNo})`);
    res.status(201).json({ id: newId, receiptNo });
  })
);

// ============================================================================
// §4 — SCHOLARSHIPS
// ============================================================================

fundingRouter.get(
  '/scholarships',
  authorize('owner', 'manager', 'finance', 'donor_manager', 'registrar'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllScholarships.all() : stmtGetScholarshipsByBranch.all(branchId);
    res.json(rows);
  })
);

fundingRouter.post(
  '/scholarships',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { name, donorId, campaignId, totalBudget, criteria } = req.body;
    
    if (!name || !totalBudget) throw new HttpError(400, 'Scholarship name and total budget are required.');

    const newId = id('sch');
    stmtInsertScholarship.run(newId, name, donorId || null, campaignId || null, totalBudget, criteria || null, user.branchId);

    writeAudit(req, `Created scholarship fund: ${name} (budget: ${totalBudget} AFN)`);
    res.status(201).json({ id: newId });
  })
);

fundingRouter.get(
  '/scholarships/awards',
  authorize('owner', 'manager', 'finance', 'donor_manager', 'registrar'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllAwards.all() : stmtGetAwardsByBranch.all(branchId);
    res.json(rows);
  })
);

fundingRouter.post(
  '/scholarships/award',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { scholarshipId, studentId, amount, awardDate, semester, notes } = req.body;
    
    if (!scholarshipId || !studentId || !amount || amount <= 0) {
      throw new HttpError(400, 'Scholarship, student, and a positive amount are required.');
    }

    const scholarship = stmtGetScholarshipById.get(scholarshipId) as any;
    if (!scholarship) throw new HttpError(404, 'Scholarship not found.');
    requireFundingBranchAccess(req, scholarship.branch_id);
    if (scholarship.status !== 'active') throw new HttpError(409, 'This scholarship is no longer active.');

    const remaining = scholarship.total_budget - scholarship.allocated_amount;
    if (amount > remaining) {
      throw new HttpError(409, `Insufficient scholarship budget. Remaining: ${remaining.toLocaleString()} AFN.`);
    }

    const student = stmtGetStudentById.get(studentId) as any;
    if (!student) throw new HttpError(404, 'Student not found.');
    requireFundingBranchAccess(req, student.branch_id);
    if (student.branch_id !== scholarship.branch_id) {
      throw new HttpError(400, 'Student and scholarship must belong to the same branch.');
    }

    const newId = id('scha');
    const date = awardDate || today();

    const tx = db.transaction(() => {
      stmtInsertAward.run(newId, scholarshipId, studentId, amount, date, semester || null, notes || null, student.branch_id);
      const newAllocated = scholarship.allocated_amount + amount;
      const newStatus = newAllocated >= scholarship.total_budget ? 'exhausted' : 'active';
      stmtUpdateScholarshipAllocation.run(newAllocated, newStatus, scholarshipId);
      return eventBus.emit('scholarship.awarded', 'scholarship', newId, 
      { scholarshipId, studentId, studentName: student.full_name, amount }, 
      { operatorId: user.userId, branchId: student.branch_id }
      );
    });
    const event = tx();
    void eventBus.dispatch(event);

    addNotification('Scholarship Awarded', `${student.full_name} was awarded ${amount.toLocaleString()} AFN from "${scholarship.name}".`, 'success', student.branch_id);
    writeAudit(req, `Awarded scholarship: ${amount} AFN to ${student.full_name} from "${scholarship.name}"`);
    res.status(201).json({ id: newId });
  })
);

// ============================================================================
// §5 — SPONSORSHIP AGREEMENTS
// ============================================================================

fundingRouter.get(
  '/sponsorships',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllSponsorships.all() : stmtGetSponsorshipsByBranch.all(branchId);
    res.json(rows);
  })
);

fundingRouter.post(
  '/sponsorships',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { donorId, studentId, programId, monthlyAmount, startDate, endDate } = req.body;
    
    if (!donorId || !monthlyAmount) throw new HttpError(400, 'Donor and monthly amount are required.');

    const donor = stmtGetDonorById.get(donorId) as any;
    if (!donor) throw new HttpError(404, 'Donor not found.');

    const newId = id('spon');
    const tx = db.transaction(() => {
      stmtInsertSponsorship.run(
        newId, donorId, studentId || null, programId || null, monthlyAmount,
        startDate || today(), endDate || null, user.branchId
      );
      return eventBus.emit('sponsorship.created', 'sponsorship', newId,
        { donorId, donorName: donor.full_name, studentId, monthlyAmount },
        { operatorId: user.userId, branchId: user.branchId }
      );
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Created sponsorship agreement: ${donor.full_name} → ${monthlyAmount} AFN/month`);
    res.status(201).json({ id: newId });
  })
);

fundingRouter.patch(
  '/sponsorships/:id',
  authorize('owner', 'manager', 'donor_manager'),
  ah(async (req, res) => {
    const existing = stmtGetSponsorshipById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Sponsorship agreement not found.');
    requireFundingBranchAccess(req, existing.branch_id);

    const { monthlyAmount, endDate, status } = req.body;
    if (status && !['active', 'completed', 'terminated'].includes(status)) {
      throw new HttpError(400, 'Invalid sponsorship status.');
    }

    stmtUpdateSponsorship.run(
      monthlyAmount ?? existing.monthly_amount, endDate ?? existing.end_date, 
      status ?? existing.status, req.params.id
    );

    writeAudit(req, `Updated sponsorship agreement: ${req.params.id}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §6 — FUNDING SUMMARY (Dashboard Widget)
// ============================================================================

fundingRouter.get(
  '/summary',
  authorize('owner', 'manager', 'finance', 'donor_manager'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);

    const totalDonations = isAll 
      ? (stmtGetTotalDonationsAll.get() as any).totalDonations 
      : (stmtGetTotalDonationsByBranch.get(branchId) as any).totalDonations;

    const totalScholarshipBudget = isAll 
      ? (stmtGetTotalScholarshipBudgetAll.get() as any).totalScholarshipBudget 
      : (stmtGetTotalScholarshipBudgetByBranch.get(branchId) as any).totalScholarshipBudget;

    const totalScholarshipAllocated = isAll 
      ? (stmtGetTotalScholarshipAllocatedAll.get() as any).totalScholarshipAllocated 
      : (stmtGetTotalScholarshipAllocatedByBranch.get(branchId) as any).totalScholarshipAllocated;

    const activeSponsorships = isAll 
      ? (stmtGetActiveSponsorshipsAll.get() as any).activeSponsorships 
      : (stmtGetActiveSponsorshipsByBranch.get(branchId) as any).activeSponsorships;

    const activeCampaigns = isAll 
      ? (stmtGetActiveCampaignsAll.get() as any).activeCampaigns 
      : (stmtGetActiveCampaignsByBranch.get(branchId) as any).activeCampaigns;

    const donorCount = (stmtGetDonorCount.get() as any).donorCount;

    const studentsSponsored = isAll 
      ? (stmtGetStudentsSponsoredAll.get() as any).studentsSponsored 
      : (stmtGetStudentsSponsoredByBranch.get(branchId) as any).studentsSponsored;

    res.json({
      totalDonations,
      totalScholarshipBudget,
      totalScholarshipAllocated,
      scholarshipUtilization: totalScholarshipBudget > 0 ? Math.round((totalScholarshipAllocated / totalScholarshipBudget) * 100) : 0,
      activeSponsorships,
      activeCampaigns,
      donorCount,
      studentsSponsored,
    });
  })
);

export default fundingRouter;
