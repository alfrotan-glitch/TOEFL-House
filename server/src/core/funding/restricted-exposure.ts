/**
 * Restricted-fund exposure report (Wave 12 / W9 §3 model 2 — AUTHORIZED).
 * ============================================================================
 * Wave 9 established what "restricted" means in this system and what the
 * architecture can honestly answer:
 *
 *  · Restrictions are structured at intake (donation_restrictions naming a
 *    campaign / scholarship / sponsorship target) and flow through a guarded
 *    allocation subledger. Spending enforcement is POLICY-BLOCKED (P11) — this
 *    module does NOT enforce anything.
 *  · Restricted cash pools with operating cash in one store. The honest,
 *    policy-free question is EXPOSURE: of the money in stores, how much is
 *    economically the donors'? That is truth made visible from the existing
 *    subledger — a VIEW, never a second source of truth.
 *
 * THE DERIVATION (every number's authority named)
 * ------------------------------------------------
 *  restrictedReceived  = Σ donations that carry a restriction row
 *                        (donations ⋈ donation_restrictions)
 *  restrictedSettled   = Σ ACTIVE aid allocations (source_kind scholarship |
 *                        sponsorship). Every aid allocation is rooted in a
 *                        restricted donation: scholarship fundings come only
 *                        from donations or campaign entries, campaign entries
 *                        come only from restricted donations or sponsorship
 *                        returns, and sponsorship receipts come only from
 *                        donations or campaign entries (registerDonation /
 *                        recordSponsorshipReceipt are the only writers).
 *                        A REVERSED allocation settles nothing — reversals
 *                        restore exposure without rewriting history, and a
 *                        closed award/campaign/sponsorship status can NEVER
 *                        change these numbers: only allocation status does.
 *  sponsorshipReturned = Σ sponsorship_return campaign entries — a REALLOCATION
 *                        inside the restricted pool (the entry keeps the source
 *                        donation's provenance), displayed for visibility and
 *                        deliberately NOT subtracted from the pool.
 *  restrictedRemaining = restrictedReceived − restrictedSettled
 *  storesHeld          = the SAME store-conservation authority as invariant
 *                        I16 (accounts + envelopes) — the report can never
 *                        disagree with the reconciler about what is held.
 *  unrestrictedHeld    = max(0, storesHeld − restrictedRemaining)
 *  restrictedExposure  = max(0, restrictedRemaining − storesHeld) — operating
 *                        spending has consumed cash that is economically the
 *                        donors'. This is the number Model 2 exists to publish.
 *
 * Internal transfers (treasury → budget, budget → budget, savings sweeps) move
 * money between stores and are therefore invisible here BY CONSTRUCTION: the
 * derivation reads only donation/allocation facts, never store balances, for
 * the pool side — and the store side is the same total I16 reconciles.
 */
import type Database from 'better-sqlite3';
import { getFundPosition, getSponsorshipPosition } from '../finance/obligations.js';

export interface RestrictedInstrumentRow {
  kind: 'scholarship' | 'sponsorship';
  id: string;
  name: string;
  received: number;
  applied: number;
  returned: number;
  remaining: number;
  status: string;
}

export interface RestrictedExposureReport {
  scope: 'all' | 'branch';
  branchId: string | null;
  restrictedReceived: number;
  /** Σ clawbacks (open + repaid): restricted money returned to funders (W16). */
  restrictedReclaimed: number;
  /** Σ OPEN clawbacks: repayment obligations still outstanding (a liability). */
  openClawbackLiability: number;
  restrictedSettled: number;
  sponsorshipReturnedToCampaign: number;
  restrictedRemaining: number;
  /** Memo commitments — NOT cash, never mixed into the exposure math. */
  activeAwardCommitments: number;
  /** Σ monthly_amount over ACTIVE agreements. A per-month promise; total
   *  duration is not recorded anywhere and is NOT invented. */
  sponsorshipPromisedMonthly: number;
  /** Cash actually held in stores — the I16 conservation authority. */
  storesHeld: number;
  unrestrictedHeld: number;
  /** Donor money that operating spending has already consumed. */
  restrictedExposure: number;
  instruments: RestrictedInstrumentRow[];
}

const AID_SETTLED_SQL = `
  SELECT COALESCE(SUM(a.amount), 0) AS v
    FROM obligation_allocations a
    LEFT JOIN scholarship_fundings sf ON sf.id = a.scholarship_funding_id
    LEFT JOIN sponsorship_receipts sr ON sr.id = a.sponsorship_receipt_id
   WHERE a.status = 'active' AND a.source_kind IN ('scholarship', 'sponsorship')
     AND (sf.id IS NOT NULL OR sr.id IS NOT NULL)
`;

export function getRestrictedExposure(db: Database.Database, branchId: string | null): RestrictedExposureReport {
  const scopedDonation = branchId
    ? db.prepare(
        `SELECT COALESCE(SUM(d.amount), 0) AS v FROM donations d
           JOIN donation_restrictions r ON r.donation_id = d.id
          WHERE d.branch_id = ?`,
      )
    : db.prepare(
        `SELECT COALESCE(SUM(d.amount), 0) AS v FROM donations d
           JOIN donation_restrictions r ON r.donation_id = d.id`,
      );

  const scopedSettled = branchId
    ? db.prepare(`${AID_SETTLED_SQL} AND (sf.branch_id = ? OR sr.branch_id = ?)`)
    : db.prepare(AID_SETTLED_SQL);

  const scopedReturned = branchId
    ? db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM campaign_funding_entries WHERE origin_kind = 'sponsorship_return' AND branch_id = ?`)
    : db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM campaign_funding_entries WHERE origin_kind = 'sponsorship_return'`);

  const scopedAwardCommitments = branchId
    ? db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM scholarship_awards WHERE status = 'active' AND branch_id = ?`)
    : db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM scholarship_awards WHERE status = 'active'`);

  const scopedPromisedMonthly = branchId
    ? db.prepare(`SELECT COALESCE(SUM(monthly_amount), 0) AS v FROM sponsorship_agreements WHERE status = 'active' AND branch_id = ?`)
    : db.prepare(`SELECT COALESCE(SUM(monthly_amount), 0) AS v FROM sponsorship_agreements WHERE status = 'active'`);

  // The store side — EXACTLY the I16 'held' figure when unscoped; the branch
  // analog (branch accounts + branch envelopes) when scoped. Same tables, same
  // meaning, so the reconciler and this report cannot disagree.
  const scopedHeld = branchId
    ? db.prepare(
        `SELECT
           COALESCE((SELECT SUM(main_balance + saving_balance) FROM finance_accounts WHERE scope_type = 'branch' AND scope_id = ?), 0)
         + COALESCE((SELECT SUM(current_amount) FROM budget_lines WHERE branch_id = ?), 0) AS v`,
      )
    : db.prepare(
        `SELECT
           COALESCE((SELECT SUM(main_balance + saving_balance) FROM finance_accounts), 0)
         + COALESCE((SELECT SUM(current_amount) FROM budget_lines), 0) AS v`,
      );

  const num = (row: unknown): number => Number((row as { v: number }).v) || 0;

  const restrictedReceived = num(scopedDonation.get(...(branchId ? [branchId] : [])));
  const restrictedSettled = num(scopedSettled.get(...(branchId ? [branchId, branchId] : [])));
  const scopedReclaimed = db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS v FROM donation_clawbacks c ${branchId ? 'JOIN donations d ON d.id = c.donation_id WHERE d.branch_id = ?' : ''}`,
  );
  const scopedOpenLiability = db.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS v FROM donation_clawbacks c ${branchId ? "JOIN donations d ON d.id = c.donation_id WHERE d.branch_id = ? AND c.status = 'open'" : "WHERE c.status = 'open'"}`,
  );
  const restrictedReclaimed = num(scopedReclaimed.get(...(branchId ? [branchId] : [])));
  const openClawbackLiability = num(scopedOpenLiability.get(...(branchId ? [branchId] : [])));
  const sponsorshipReturnedToCampaign = num(scopedReturned.get(...(branchId ? [branchId] : [])));
  // W16: reclaimed money (declared or repaid) is no longer part of the
  // restricted pool — the funder is taking it back.
  const restrictedRemaining = Math.max(0, restrictedReceived - restrictedSettled - restrictedReclaimed);

  const activeAwardCommitments = num(scopedAwardCommitments.get(...(branchId ? [branchId] : [])));
  const sponsorshipPromisedMonthly = num(scopedPromisedMonthly.get(...(branchId ? [branchId] : [])));
  const storesHeld = num(scopedHeld.get(...(branchId ? [branchId, branchId] : [])));

  // Where the restricted money lives, from the per-instrument position
  // authorities (getFundPosition / getSponsorshipPosition) — reused, not
  // restated, so this breakdown can never drift from the funding surfaces.
  const instruments: RestrictedInstrumentRow[] = [];
  const scholarships = (branchId
    ? db.prepare('SELECT id, name FROM scholarships WHERE branch_id = ?')
    : db.prepare('SELECT id, name FROM scholarships')
  ).all(...(branchId ? [branchId] : [])) as Array<{ id: string; name: string }>;
  for (const s of scholarships) {
    const p = getFundPosition(db, s.id);
    if (p.received <= 0) continue;
    instruments.push({
      kind: 'scholarship', id: s.id, name: s.name,
      received: p.received, applied: p.committed, returned: 0,
      remaining: p.available, status: 'funded',
    });
  }
  const sponsorships = (branchId
    ? db.prepare('SELECT id FROM sponsorship_agreements WHERE branch_id = ?')
    : db.prepare('SELECT id FROM sponsorship_agreements')
  ).all(...(branchId ? [branchId] : [])) as Array<{ id: string }>;
  for (const s of sponsorships) {
    const p = getSponsorshipPosition(db, s.id);
    if (p.received <= 0) continue;
    instruments.push({
      kind: 'sponsorship', id: p.agreementId, name: p.donorId,
      received: p.received, applied: p.applied, returned: p.returned,
      remaining: p.available, status: p.status,
    });
  }

  return {
    scope: branchId ? 'branch' : 'all',
    branchId,
    restrictedReceived,
    restrictedReclaimed,
    openClawbackLiability,
    restrictedSettled,
    sponsorshipReturnedToCampaign,
    restrictedRemaining,
    activeAwardCommitments,
    sponsorshipPromisedMonthly,
    storesHeld,
    unrestrictedHeld: Math.max(0, storesHeld - restrictedRemaining),
    restrictedExposure: Math.max(0, restrictedRemaining - storesHeld),
    instruments,
  };
}
