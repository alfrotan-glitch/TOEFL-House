import type { Database } from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { id, today } from '../../utils/ids.js';
import { assertMoney } from '../../utils/money.js';
import { assertOptionalIsoDate } from '../../utils/isoDate.js';
import { nextScopedDocumentNumber } from '../../utils/documentNumbers.js';
import { recordIncome } from '../../utils/income.js';
import {
  fundScholarshipFromSource,
  getFundPosition,
  getSponsorshipReceiptPosition,
  getSponsorshipPosition,
  recordSponsorshipReceipt,
} from '../finance/obligations.js';

export type RestrictionTargetKind = 'campaign' | 'scholarship' | 'sponsorship';
export type FundingSourceInput =
  | { kind: 'donation'; id: string }
  | { kind: 'campaignFundingEntry'; id: string };

export interface RestrictionInput {
  kind: RestrictionTargetKind;
  targetId: string;
}

export interface DonationCommand {
  donorId: string;
  amount: unknown;
  date?: unknown;
  branchId: string;
  campaignId?: string | null;
  restriction?: RestrictionInput | null;
  idempotencyKey: string;
  operator: { userId: string; fullName: string; role: string | null };
}

export interface DonationResult {
  id: string;
  receiptNo: string;
  transactionId: string;
  restriction: RestrictionInput | null;
}

interface FundingTargetRow {
  id: string;
  branch_id: string;
  donor_id?: string | null;
  campaign_id?: string | null;
  status?: string;
}

function requireTrimmedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`);
  return value.trim();
}

function parseRestriction(value: unknown): RestrictionInput | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'restriction must name a structured target.');
  }
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (kind !== 'campaign' && kind !== 'scholarship' && kind !== 'sponsorship') {
    throw new HttpError(400, 'restriction.kind must be campaign, scholarship, or sponsorship.');
  }
  return { kind, targetId: requireTrimmedId(row.targetId, 'restriction.targetId') };
}

function getTarget(db: Database, kind: RestrictionTargetKind, targetId: string): FundingTargetRow {
  const table = kind === 'campaign'
    ? 'funding_campaigns'
    : kind === 'scholarship'
      ? 'scholarships'
      : 'sponsorship_agreements';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId) as FundingTargetRow | undefined;
  if (!row) throw new HttpError(404, `Restricted ${kind} target not found.`);
  return row;
}

function createCampaignFundingEntry(
  db: Database,
  params: {
    campaignId: string;
    donationId: string;
    branchId: string;
    amount: number;
    operator: DonationCommand['operator'];
    date: string;
    origin: 'restricted_donation' | 'sponsorship_return';
    sponsorshipReceiptId?: string;
    sponsorshipAgreementId?: string;
    reason?: string;
  },
): string {
  const entryId = id('cfe');
  db.prepare(
    `INSERT INTO campaign_funding_entries
       (id, campaign_id, source_donation_id, source_sponsorship_receipt_id,
        sponsorship_agreement_id, origin_kind, amount, reason, actor_user_id,
        operator_name, branch_id, date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entryId,
    params.campaignId,
    params.donationId,
    params.sponsorshipReceiptId ?? null,
    params.sponsorshipAgreementId ?? null,
    params.origin,
    params.amount,
    params.reason ?? null,
    params.operator.userId,
    params.operator.fullName,
    params.branchId,
    params.date,
  );
  return entryId;
}

/**
 * Records the only cash fact for a donation and, where required, its first
 * immutable restricted allocation. Call inside a transaction.
 */
export function registerDonation(db: Database, command: DonationCommand): DonationResult {
  if (!db.inTransaction) throw new Error('registerDonation() must run inside a transaction.');
  const donorId = requireTrimmedId(command.donorId, 'donorId');
  const amount = assertMoney(command.amount, 'donation amount');
  if (amount <= 0) throw new HttpError(400, 'donation amount must be greater than zero.');
  const date = assertOptionalIsoDate(command.date, 'donation date') ?? today();
  const restriction = parseRestriction(command.restriction);

  const donor = db.prepare('SELECT id, full_name FROM donors WHERE id = ?').get(donorId) as
    | { id: string; full_name: string }
    | undefined;
  if (!donor) throw new HttpError(404, 'Donor not found.');

  let campaignId = command.campaignId ? requireTrimmedId(command.campaignId, 'campaignId') : null;
  if (campaignId) {
    const campaign = getTarget(db, 'campaign', campaignId);
    if (campaign.branch_id !== command.branchId) throw new HttpError(400, 'Campaign belongs to another branch.');
  }

  if (restriction) {
    const target = getTarget(db, restriction.kind, restriction.targetId);
    if (target.branch_id !== command.branchId) throw new HttpError(400, 'Restricted target belongs to another branch.');
    if (restriction.kind === 'campaign') {
      if (campaignId && campaignId !== target.id) {
        throw new HttpError(400, 'A campaign restriction must match campaignId.');
      }
      campaignId = target.id;
    }
    if (restriction.kind === 'sponsorship') {
      if (target.status !== 'active') throw new HttpError(409, 'Restricted sponsorship target is no longer active.');
      if (target.donor_id !== donorId) {
        throw new HttpError(400, 'A restricted sponsorship donation must come from the agreement donor.');
      }
      if (campaignId && target.campaign_id && campaignId !== target.campaign_id) {
        throw new HttpError(400, 'Donation campaign does not match the sponsorship target campaign.');
      }
      if (!campaignId && target.campaign_id) campaignId = target.campaign_id;
    }
    if (restriction.kind === 'scholarship') {
      if (target.status !== 'active') throw new HttpError(409, 'Restricted scholarship target is closed.');
      if (campaignId && target.campaign_id && campaignId !== target.campaign_id) {
        throw new HttpError(400, 'Donation campaign does not match the scholarship target campaign.');
      }
      if (!campaignId && target.campaign_id) campaignId = target.campaign_id;
    }
  }

  const donationId = id('dn');
  const transactionId = id('tx');
  const receiptNo = nextScopedDocumentNumber('donation_receipt', command.branchId, 'DON');

  // `financial_transactions.donation_id` uses a deferred FK: the cash fact can
  // be inserted first, then the donation validates the complete pair before the
  // surrounding transaction commits.
  recordIncome({
    category: 'donation',
    amount,
    date,
    description: `Donation received from ${donor.full_name}`,
    referenceId: donationId,
    donationId,
    transactionId,
    operatorName: command.operator.fullName,
    operatorRole: command.operator.role,
    branchId: command.branchId,
  });

  db.prepare(
    `INSERT INTO donations
       (id, campaign_id, donor_id, amount, date, receipt_no, branch_id, transaction_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(donationId, campaignId, donorId, amount, date, receiptNo, command.branchId, transactionId, command.idempotencyKey);

  if (restriction) {
    db.prepare(
      `INSERT INTO donation_restrictions
         (donation_id, target_kind, campaign_id, scholarship_id, sponsorship_agreement_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      donationId,
      restriction.kind,
      restriction.kind === 'campaign' ? restriction.targetId : null,
      restriction.kind === 'scholarship' ? restriction.targetId : null,
      restriction.kind === 'sponsorship' ? restriction.targetId : null,
    );

    if (restriction.kind === 'campaign') {
      createCampaignFundingEntry(db, {
        campaignId: restriction.targetId,
        donationId,
        branchId: command.branchId,
        amount,
        operator: command.operator,
        date,
        origin: 'restricted_donation',
      });
    } else if (restriction.kind === 'scholarship') {
      fundScholarshipFromSource(db, {
        scholarshipId: restriction.targetId,
        source: { kind: 'donation', id: donationId },
        amount,
        branchId: command.branchId,
        operatorName: command.operator.fullName,
        date,
      });
    } else {
      recordSponsorshipReceipt(db, {
        agreementId: restriction.targetId,
        source: { kind: 'donation', id: donationId },
        amount,
        branchId: command.branchId,
        operatorName: command.operator.fullName,
        date,
      });
    }
  }

  return { id: donationId, receiptNo, transactionId, restriction };
}

export interface SponsorshipTerminalCommand {
  agreementId: string;
  status: 'completed' | 'terminated';
  reason: string;
  operator: DonationCommand['operator'];
}

/**
 * Terminates/completes an agreement without hiding any unspent donor money.
 * Every receipt remainder moves to one immutable restricted campaign entry.
 */
export function terminalizeSponsorship(db: Database, command: SponsorshipTerminalCommand): {
  returned: number;
  campaignId: string | null;
  position: ReturnType<typeof getSponsorshipPosition>;
} {
  if (!db.inTransaction) throw new Error('terminalizeSponsorship() must run inside a transaction.');
  const reason = command.reason.trim();
  if (reason.length < 8) throw new HttpError(400, 'A terminal reason of at least 8 characters is required.');

  const agreement = db.prepare(
    `SELECT id, campaign_id, branch_id, status
       FROM sponsorship_agreements WHERE id = ?`,
  ).get(command.agreementId) as { id: string; campaign_id: string | null; branch_id: string; status: string } | undefined;
  if (!agreement) throw new HttpError(404, 'Sponsorship agreement not found.');
  if (agreement.status !== 'active') throw new HttpError(409, 'This sponsorship agreement is already terminal.');

  const receiptRows = db.prepare(
    `SELECT r.id,
            COALESCE(r.donation_id, cfe.source_donation_id) AS source_donation_id
       FROM sponsorship_receipts r
       LEFT JOIN campaign_funding_entries cfe ON cfe.id = r.campaign_funding_entry_id
      WHERE r.agreement_id = ?`,
  ).all(agreement.id) as Array<{ id: string; source_donation_id: string }>;

  let returned = 0;
  if (receiptRows.length > 0 && !agreement.campaign_id) {
    const available = getSponsorshipPosition(db, agreement.id).available;
    if (available > 0) {
      throw new HttpError(409, 'This sponsorship has an unspent balance but no valid linked campaign for its restricted return.');
    }
  }

  for (const receipt of receiptRows) {
    const position = getSponsorshipReceiptPosition(db, receipt.id);
    if (position.available <= 0) continue;
    if (!agreement.campaign_id) {
      throw new HttpError(409, 'This sponsorship has an unspent balance but no valid linked campaign for its restricted return.');
    }
    createCampaignFundingEntry(db, {
      campaignId: agreement.campaign_id,
      donationId: receipt.source_donation_id,
      sponsorshipReceiptId: receipt.id,
      sponsorshipAgreementId: agreement.id,
      branchId: agreement.branch_id,
      amount: position.available,
      operator: command.operator,
      date: today(),
      reason,
      origin: 'sponsorship_return',
    });
    returned += position.available;
  }

  const updated = db.prepare(
    `UPDATE sponsorship_agreements
        SET status = ?, terminal_at = datetime('now'), terminal_by = ?, terminal_reason = ?
      WHERE id = ? AND status = 'active'`,
  ).run(command.status, command.operator.fullName, reason, agreement.id);
  if (updated.changes !== 1) throw new HttpError(409, 'This sponsorship agreement was closed concurrently.');

  return { returned, campaignId: agreement.campaign_id, position: getSponsorshipPosition(db, agreement.id) };
}

export interface FundingSummary {
  donationsReceived: number;
  restrictedDonations: number;
  campaignTarget: number;
  campaignRaised: number;
  scholarshipDeclaredTarget: number;
  scholarshipReceived: number;
  scholarshipCommitted: number;
  activeCampaigns: number;
  activeSponsorships: number;
}

export function getFundingSummary(db: Database, branchId: string | null): FundingSummary {
  const scoped = branchId ? ' WHERE branch_id = ?' : '';
  const arg = branchId ? [branchId] : [];
  const scalar = (sql: string): number => Number((db.prepare(sql).get(...arg) as { value: number }).value) || 0;
  const donationsReceived = scalar(`SELECT COALESCE(SUM(amount), 0) AS value FROM donations${scoped}`);
  const restrictedDonations = scalar(
    `SELECT COALESCE(SUM(d.amount), 0) AS value
       FROM donations d JOIN donation_restrictions r ON r.donation_id = d.id${branchId ? ' WHERE d.branch_id = ?' : ''}`,
  );
  const campaignTarget = scalar(`SELECT COALESCE(SUM(target_amount), 0) AS value FROM funding_campaigns${scoped}`);
  const campaignRaised = scalar(`SELECT COALESCE(SUM(amount), 0) AS value FROM donations WHERE campaign_id IS NOT NULL${branchId ? ' AND branch_id = ?' : ''}`);
  const scholarshipDeclaredTarget = scalar(`SELECT COALESCE(SUM(total_budget), 0) AS value FROM scholarships${scoped}`);
  const scholarshipRows = (branchId
    ? db.prepare('SELECT id FROM scholarships WHERE branch_id = ?').all(branchId)
    : db.prepare('SELECT id FROM scholarships').all()) as Array<{ id: string }>;
  const positions = scholarshipRows.map((row) => getFundPosition(db, row.id));
  const activeCampaigns = scalar(`SELECT COUNT(*) AS value FROM funding_campaigns${branchId ? " WHERE branch_id = ? AND status = 'active'" : " WHERE status = 'active'"}`);
  const activeSponsorships = scalar(`SELECT COUNT(*) AS value FROM sponsorship_agreements${branchId ? " WHERE branch_id = ? AND status = 'active'" : " WHERE status = 'active'"}`);
  return {
    donationsReceived,
    restrictedDonations,
    campaignTarget,
    campaignRaised,
    scholarshipDeclaredTarget,
    scholarshipReceived: positions.reduce((sum, position) => sum + position.received, 0),
    scholarshipCommitted: positions.reduce((sum, position) => sum + position.committed, 0),
    activeCampaigns,
    activeSponsorships,
  };
}
