/**
 * Donation clawbacks — WAVE 16 (owner-authorized standard semantics).
 * ============================================================================
 * A clawback is restricted money RETURNED TO THE FUNDER. Economically it is a
 * repayment obligation (a liability from declaration until repayment), never
 * negative operating revenue and never an expense: the donation was funding
 * income when received, and returning uncommitted restricted money undoes the
 * funder's position without touching the trading result.
 *
 * Declaration  → donation_clawbacks row (status 'open' = the liability).
 * Repayment    → branch cash out through a dedicated P&L-neutral ledger type
 *                `restricted_reclaim` (the same pattern as saving_transfer and
 *                budget movements: stores move, the P&L does not), the clawback
 *                transitions open → repaid, and the row is linked to its
 *                ledger evidence.
 *
 * Conservative guard (D-DC-3 remains POLICY REQUIRED): only a donation's
 * UNCOMMITTED restricted remainder may be reclaimed — enforced by
 * trg_donation_clawbacks_uncommitted_only using the same committed-money
 * derivation as getDonationUnallocated(). Committed money (already sitting in
 * a scholarship fund / sponsorship receipt / campaign entry) cannot be clawed
 * back until fund-level reduction semantics are decided.
 *
 * No approval thresholds, no partial repayments, no interest: those are
 * business policy and are deliberately absent.
 */
import type Database from 'better-sqlite3';
import { db as defaultDb } from '../../db/connection.js';
import { assertMoney } from '../../utils/money.js';
import { today } from '../../utils/ids.js';
import { decrementMainBalanceIfSufficient } from '../../utils/financeAccounts.js';
import {
  getScholarshipFundingPosition,
  getSponsorshipReceiptPosition,
  getCampaignFundingEntryPosition,
} from '../finance/obligations.js';
import { id } from '../../utils/ids.js';
import { HttpError } from '../../middleware/errorHandler.js';

type Db = Database.Database;

const stmtInsertClawback = (database: Db) => database.prepare(
  `INSERT INTO donation_clawbacks (id, donation_id, amount, reason, attributed_kind, attributed_id, status, declared_on, declared_by)
   VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
);

const stmtGetClawback = (database: Db) => database.prepare('SELECT * FROM donation_clawbacks WHERE id = ?');

const stmtInsertReclaimTx = (database: Db) => database.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, amount, date, description, reference_id, operator_name, operator_role, branch_id)
   VALUES (?, 'restricted_reclaim', 'donation_reclaim', ?, ?, ?, ?, ?, ?, ?)`,
);

export interface ClawbackDeclaration {
  donationId: string;
  amount: number;
  reason: string;
  declaredOn?: string;
  operator: { name: string; role?: string | null };
}

export function declareDonationClawback(database: Db = defaultDb, command: ClawbackDeclaration): { clawbackId: string } {
  if (!database.inTransaction) throw new Error('declareDonationClawback() must run inside a transaction.');
  const amount = assertMoney(command.amount, 'clawback amount');
  if (amount <= 0) throw new HttpError(400, 'A clawback amount must be greater than zero.');
  const reason = String(command.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A clawback reason of at least 8 characters is required.');

  const donation = database.prepare(
    `SELECT d.id, d.branch_id, d.amount,
            EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = d.id) AS restricted
       FROM donations d WHERE d.id = ?`,
  ).get(command.donationId) as { id: string; branch_id: string; amount: number; restricted: number } | undefined;
  if (!donation) throw new HttpError(404, 'Donation not found.');
  if (!donation.restricted) {
    throw new HttpError(409, 'Only a restricted donation can be clawed back: an unrestricted gift has no purpose condition to revoke.');
  }

  // ── W18 attribution resolution (D-187): D-DC-3 is narrowed to genuine
  //    ambiguity. A restricted donation delivers its whole amount to ONE
  //    instrument at registration; money may move onward through sponsorship
  //    returns, but attribution is only AMBIGUOUS when TWO OR MORE instruments
  //    in the provenance chain still hold unconsumed capacity — only then is
  //    "which loses first" an ordering choice (owner policy). When exactly ONE
  //    instrument holds unconsumed money, the facts force the attribution and
  //    no policy is needed. The attribution is FIXED AT DECLARATION on the
  //    clawback row, so later consumption cannot re-write history.
  type InstrumentKind = 'scholarship_funding' | 'sponsorship_receipt' | 'campaign_funding_entry';
  const instruments = database.prepare(
    `SELECT 'scholarship_funding' AS kind, id FROM scholarship_fundings WHERE donation_id = :d
      UNION ALL
     SELECT 'sponsorship_receipt', id FROM sponsorship_receipts WHERE donation_id = :d
      UNION ALL
     SELECT 'campaign_funding_entry', e.id FROM campaign_funding_entries e WHERE e.source_donation_id = :d
      UNION ALL
     SELECT 'scholarship_funding', sf.id FROM scholarship_fundings sf
      WHERE sf.campaign_funding_entry_id IN (SELECT id FROM campaign_funding_entries WHERE source_donation_id = :d)
      UNION ALL
     SELECT 'sponsorship_receipt', sr.id FROM sponsorship_receipts sr
      WHERE sr.campaign_funding_entry_id IN (SELECT id FROM campaign_funding_entries WHERE source_donation_id = :d)`,
  ).all({ d: command.donationId }) as Array<{ kind: InstrumentKind; id: string }>;

  const availableOf = (kind: InstrumentKind, instrumentId: string): number => {
    if (kind === 'scholarship_funding') return getScholarshipFundingPosition(database, instrumentId).available;
    if (kind === 'sponsorship_receipt') return getSponsorshipReceiptPosition(database, instrumentId).available;
    return getCampaignFundingEntryPosition(database, instrumentId).available;
  };
  const holders = instruments
    .map((i) => ({ ...i, available: availableOf(i.kind, i.id) }))
    .filter((i) => i.available > 0);
  let attributed: { kind: InstrumentKind; id: string } | null = null;
  if (holders.length > 1) {
    const names = holders.map((h) => `${h.kind} ${h.id} (${h.available} AFN)`).join('; ');
    throw new HttpError(
      409,
      `Unconsumed money of this donation now sits in ${holders.length} funding instruments (${names}). Which instrument loses capacity first is an owner decision (D-DC-3) that has not been made. POLICY REQUIRED.`,
    );
  }
  if (holders.length === 1) attributed = { kind: holders[0].kind, id: holders[0].id };
  // holders.length === 0 ⇒ reclaimable is exhausted; the bound check below
  // refuses with the exact remaining figure.

  // Consumption: ACTIVE aid allocations reachable from this donation\'s root
  // instruments (its own fundings/receipts/entry, and instruments funded from
  // its campaign entry). Reversals already restore capacity.
  const consumed = Number((database.prepare(
    `SELECT
      COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a
         WHERE a.status = 'active' AND a.source_kind = 'scholarship'
           AND a.scholarship_funding_id IN (SELECT id FROM scholarship_fundings WHERE donation_id = :d)), 0)
    + COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a
         WHERE a.status = 'active' AND a.source_kind = 'scholarship'
           AND a.scholarship_funding_id IN (SELECT sf.id FROM scholarship_fundings sf
              WHERE sf.campaign_funding_entry_id IN (SELECT id FROM campaign_funding_entries WHERE source_donation_id = :d))), 0)
    + COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a
         WHERE a.status = 'active' AND a.source_kind = 'sponsorship'
           AND a.sponsorship_receipt_id IN (SELECT id FROM sponsorship_receipts WHERE donation_id = :d)), 0)
    + COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a
         WHERE a.status = 'active' AND a.source_kind = 'sponsorship'
           AND a.sponsorship_receipt_id IN (SELECT sr.id FROM sponsorship_receipts sr
              WHERE sr.campaign_funding_entry_id IN (SELECT id FROM campaign_funding_entries WHERE source_donation_id = :d))), 0) AS t`,
  ).get({ d: command.donationId }) as { t: number }).t) || 0;
  const priorClawbacks = Number((database.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM donation_clawbacks WHERE donation_id = ?',
  ).get(command.donationId) as { t: number }).t) || 0;
  const reclaimable = Number(donation.amount) - consumed - priorClawbacks;
  if (amount > reclaimable) {
    throw new HttpError(
      409,
      `Only the donation's unconsumed remainder may be reclaimed: ${reclaimable} AFN of ${donation.amount} AFN remains (consumed ${consumed}, already clawed back ${priorClawbacks}).`,
    );
  }

  const clawbackId = id('claw');
  try {
    stmtInsertClawback(database).run(
      clawbackId, command.donationId, amount, reason,
      attributed?.kind ?? null, attributed?.id ?? null,
      command.declaredOn ?? today(), command.operator.name,
    );
  } catch (error) {
    const message = String((error as { message?: string })?.message ?? '');
    if (message.includes('Cumulative clawbacks')) {
      throw new HttpError(409, 'Cumulative clawbacks cannot exceed the donation amount.');
    }
    throw error;
  }
  return { clawbackId };
}

export function repayDonationClawback(database: Db = defaultDb, clawbackId: string, operator: { name: string; role?: string | null }): { transactionId: string } {
  if (!database.inTransaction) throw new Error('repayDonationClawback() must run inside a transaction.');
  const clawback = stmtGetClawback(database).get(clawbackId) as
    | { id: string; donation_id: string; amount: number; status: string }
    | undefined;
  if (!clawback) throw new HttpError(404, 'Clawback not found.');
  if (clawback.status === 'repaid') throw new HttpError(409, 'This clawback has already been repaid.');

  const donation = database.prepare('SELECT branch_id FROM donations WHERE id = ?')
    .get(clawback.donation_id) as { branch_id: string };

  // Cash out of the branch store, conditionally — the same-statement balance
  // check that every cash-debiting writer here uses (ensure-then-debit so a
  // branch whose store row was never materialized is refused, not crashed).
  const debited = decrementMainBalanceIfSufficient('branch', donation.branch_id, clawback.amount);
  if (!debited) {
    throw new HttpError(409, `Insufficient branch main balance to repay the clawback (${clawback.amount} AFN).`);
  }

  const transactionId = id('tx');
  stmtInsertReclaimTx(database).run(
    transactionId,
    -clawback.amount, // signed: cash OUT of the branch store
    today(),
    `Donation clawback repaid to the funder (clawback ${clawback.id})`,
    clawback.donation_id,
    operator.name,
    operator.role ?? null,
    donation.branch_id,
  );

  const updated = database.prepare(
    `UPDATE donation_clawbacks SET status = 'repaid', repaid_on = ?, repaid_transaction_id = ?
      WHERE id = ? AND status = 'open'`,
  ).run(today(), transactionId, clawbackId);
  if (updated.changes !== 1) throw new HttpError(409, 'This clawback has already been repaid.');

  return { transactionId };
}
