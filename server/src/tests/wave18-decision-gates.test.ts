/**
 * WAVE 18 · DECISION-GATE REDUCTION — adversarial verification.
 * ============================================================================
 *   A. D-DC-3 narrowed to genuine ambiguity (D-187): a clawback's attribution
 *      is resolved from FACTS whenever exactly ONE instrument in the donation's
 *      provenance chain holds unconsumed capacity — including after onward
 *      movement. Attribution is fixed at declaration on the clawback row;
 *      per-instrument positions subtract only their own attribution (with the
 *      pre-W18 NULL rows keeping chain behaviour). Two or more holders is a
 *      real ordering choice and still refuses with POLICY REQUIRED.
 *   B. Fixed-asset custody loss (D-188): a lost/stolen/destroyed asset is a
 *      custody FACT, financially invisible in the cash model (the certified
 *      books-adjustment precedent). Append-only event + status flip in one
 *      transaction; zero ledger writes; proceeds/disposal/depreciation remain
 *      POLICY REQUIRED and unrepresentable.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import financeRouter from '../routes/finance.routes.js';
import fundingRouter from '../routes/funding.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { ensureTuitionObligation, getScholarshipFundingPosition, getSponsorshipReceiptPosition, getCampaignFundingEntryPosition } from '../core/finance/obligations.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w18_sa';
const TEACHER = 'user_w18_t';
const BRANCH = 'branch_w18_sa';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacher = () => bearerFor(TEACHER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0792${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
};
const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);

const createStudentReady = async (label: string) => {
  const st = await request(app).post('/api/students/manual').set(owner())
    .send({ fullName: unique(label), phone: phone(), branchId: BRANCH, gender: 'female' });
  assertOk('student', st, 201);
  const sid = st.body.student?.id ?? st.body.id;
  const list = await request(app).get(`/api/invoices?studentId=${sid}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  assertOk('reg settled', await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'cash' }), 200, 201);
  return sid;
};

const enrolledObligation = async (label: string) => {
  const sid = await createStudentReady(label);
  const cls = await request(app).post('/api/classes').set(owner())
    .send({ name: unique(`${label} Class`), level: 'B1', capacity: 20, fee: 60000, startDate: '2026-09-01', branchId: BRANCH });
  assertOk('class', cls, 201);
  const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner())
    .send({ classId: cls.body.id, semesterName: unique(`${label} Term`), startDate: '2026-09-01', endDate: '2026-12-20' });
  assertOk('enroll', enrolled, 201);
  return { sid, obligationId: ensureTuitionObligation(db, enrolled.body.semesterId as string).id };
};

const newDonor = async () => (await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W18 Donor'), type: 'ngo' })).body.id;

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W18') ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });
  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W18 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
  assertOk('sweep off', await request(app).put('/api/invoices/config/settings').set(owner()).send({ dailySavingPercent: 0 }), 200, 201);
});

describe('W18 · A. clawback attribution resolved from facts (D-187)', () => {
  it('attributes a direct donation clawback to its single root instrument', async () => {
    const sch = await request(app).post('/api/funding/scholarships').set(owner()).send({ name: unique('W18 Scholarship'), totalBudget: 80000, branchId: BRANCH });
    assertOk('scholarship', sch, 201);
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: await newDonor(), amount: 60000, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: sch.body.id } });
    assertOk('donation', don, 201);
    const fundingId = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(don.body.id) as { id: string }).id;

    const decl = await request(app).post(`/api/funding/donations/${don.body.id}/clawback`).set(owner())
      .send({ amount: 15000, reason: 'W18 direct donation clawback probe' });
    assertOk('declare direct', decl, 201);

    const row = db.prepare('SELECT attributed_kind, attributed_id FROM donation_clawbacks WHERE id = ?').get(decl.body.id) as { attributed_kind: string; attributed_id: string };
    expect(row.attributed_kind).toBe('scholarship_funding');
    expect(row.attributed_id).toBe(fundingId);
    const pos = getScholarshipFundingPosition(db, fundingId);
    expect(pos.clawedBack).toBe(15000);
    expect(pos.available).toBe(45000);
    checkerClean();
  });

  it('resolves onward movement when ONE instrument uniquely holds the remainder', async () => {
    // World: donation → sponsorship receipt (root), part allocated, remainder
    // returned onward into the campaign on termination. Root is then drained
    // and the campaign entry is the UNIQUE holder ⇒ clawback is a fact, not a
    // policy choice.
    const campaign = await request(app).post('/api/funding/campaigns').set(owner()).send({ name: unique('W18 Campaign'), targetAmount: 100000, branchId: BRANCH });
    assertOk('campaign', campaign, 201);
    const { obligationId } = await enrolledObligation('W18 Sponsored');
    const agreementDonor = await newDonor();
    const agreement = await request(app).post('/api/funding/sponsorships').set(owner())
      .send({ donorId: agreementDonor, monthlyAmount: 5000, startDate: '2026-09-01', endDate: '2027-06-30', campaignId: campaign.body.id, branchId: BRANCH });
    assertOk('agreement', agreement, 201);
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: agreementDonor, amount: 50000, branchId: BRANCH, restriction: { kind: 'sponsorship', targetId: agreement.body.id } });
    assertOk('donation', don, 201);
    const receiptId = (db.prepare('SELECT id FROM sponsorship_receipts WHERE donation_id = ?').get(don.body.id) as { id: string }).id;

    assertOk('allocate at root', await request(app).post(`/api/funding/sponsorships/${agreement.body.id}/allocations`).set(owner())
      .send({ obligationId, sponsorshipReceiptId: receiptId, amount: 30000 }), 201);

    const term = await request(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(owner())
      .send({ status: 'terminated', reason: 'W18 sponsor exited the program early' });
    assertOk('terminate', term, 200);
    expect((term.body as { returned: number }).returned).toBe(20000);

    const entryId = (db.prepare(`SELECT id FROM campaign_funding_entries WHERE source_sponsorship_receipt_id = ?`).get(receiptId) as { id: string }).id;
    expect(getSponsorshipReceiptPosition(db, receiptId).available).toBe(0);
    expect(getCampaignFundingEntryPosition(db, entryId).available).toBe(20000);

    // The W16 guard would have refused this outright; the facts make it unique.
    const decl = await request(app).post(`/api/funding/donations/${don.body.id}/clawback`).set(owner())
      .send({ amount: 20000, reason: 'W18 funder reallocated the grant' });
    assertOk('declare after onward movement (unique holder)', decl, 201);

    const row = db.prepare('SELECT attributed_kind, attributed_id FROM donation_clawbacks WHERE id = ?').get(decl.body.id) as { attributed_kind: string; attributed_id: string };
    expect(row.attributed_kind).toBe('campaign_funding_entry');
    expect(row.attributed_id).toBe(entryId);

    const entryPos = getCampaignFundingEntryPosition(db, entryId);
    expect(entryPos.clawedBack).toBe(20000);
    expect(entryPos.available).toBe(0);
    // The drained root is NOT double-reduced: its capacity was already spent by
    // the return, and the clawback is attributed to the entry that held the money.
    const rootPos = getSponsorshipReceiptPosition(db, receiptId);
    expect(rootPos.clawedBack).toBe(0);
    expect(rootPos.available).toBe(0);
    checkerClean();
  });

  it('still refuses when TWO instruments hold unconsumed money (D-DC-3)', async () => {
    const campaign = await request(app).post('/api/funding/campaigns').set(owner()).send({ name: unique('W18 Ambiguous Campaign'), targetAmount: 100000, branchId: BRANCH });
    assertOk('campaign', campaign, 201);
    const { obligationId } = await enrolledObligation('W18 Ambiguous');
    const agreementDonor = await newDonor();
    const agreement = await request(app).post('/api/funding/sponsorships').set(owner())
      .send({ donorId: agreementDonor, monthlyAmount: 5000, startDate: '2026-09-01', endDate: '2027-06-30', campaignId: campaign.body.id, branchId: BRANCH });
    assertOk('agreement', agreement, 201);
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: agreementDonor, amount: 50000, branchId: BRANCH, restriction: { kind: 'sponsorship', targetId: agreement.body.id } });
    assertOk('donation', don, 201);
    const receiptId = (db.prepare('SELECT id FROM sponsorship_receipts WHERE donation_id = ?').get(don.body.id) as { id: string }).id;
    assertOk('allocate at root', await request(app).post(`/api/funding/sponsorships/${agreement.body.id}/allocations`).set(owner())
      .send({ obligationId, sponsorshipReceiptId: receiptId, amount: 10000 }), 201);
    assertOk('terminate', await request(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(owner())
      .send({ status: 'terminated', reason: 'W18 ambiguous chain termination' }), 200);
    const entryId = (db.prepare(`SELECT id FROM campaign_funding_entries WHERE source_sponsorship_receipt_id = ?`).get(receiptId) as { id: string }).id;
    expect(getCampaignFundingEntryPosition(db, entryId).available).toBe(40000);

    // Route 30k of the entry into a scholarship funding, unallocated: the
    // remainder now sits in TWO instruments (entry 10k + funding 30k).
    const sch = await request(app).post('/api/funding/scholarships').set(owner())
      .send({ name: unique('W18 Campaign Scholarship'), totalBudget: 80000, branchId: BRANCH, campaignId: campaign.body.id });
    assertOk('scholarship', sch, 201);
    assertOk('fund from entry', await request(app).post(`/api/funding/scholarships/${sch.body.id}/fundings`).set(owner())
      .send({ campaignFundingEntryId: entryId, amount: 30000 }), 201);
    const fundingId = (db.prepare('SELECT id FROM scholarship_fundings WHERE campaign_funding_entry_id = ?').get(entryId) as { id: string }).id;
    expect(getCampaignFundingEntryPosition(db, entryId).available).toBe(10000);
    expect(getScholarshipFundingPosition(db, fundingId).available).toBe(30000);

    const refused = await request(app).post(`/api/funding/donations/${don.body.id}/clawback`).set(owner())
      .send({ amount: 5000, reason: 'W18 ambiguous attribution probe' });
    assertOk('ambiguous chain still refused', refused, 409);
    expect(String((refused.body as { error: string }).error)).toContain('POLICY REQUIRED');
    expect(String((refused.body as { error: string }).error)).toContain('2 funding instruments');
    checkerClean();
  });

  it('keeps pre-W18 (NULL-attribution) clawbacks on the chain-wide behaviour', async () => {
    // Simulate a legacy row: attributed columns NULL on the first donation.
    const donationId = (db.prepare('SELECT donation_id FROM scholarship_fundings WHERE id = (SELECT attributed_id FROM donation_clawbacks ORDER BY created_at LIMIT 1)').get() as { donation_id: string }).donation_id;
    db.prepare(`INSERT INTO donation_clawbacks (id, donation_id, amount, reason, attributed_kind, attributed_id, status, declared_on)
                VALUES ('claw_legacy_probe', ?, 5000, 'legacy NULL attribution probe', NULL, NULL, 'open', '2026-09-05')`).run(donationId);
    const fundingId = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(donationId) as { id: string }).id;
    const pos = getScholarshipFundingPosition(db, fundingId);
    expect(pos.clawedBack).toBe(20000); // 15000 attributed + 5000 legacy NULL
    db.prepare(`DELETE FROM donation_clawbacks WHERE id = 'claw_legacy_probe'`).run();
    expect(getScholarshipFundingPosition(db, fundingId).clawedBack).toBe(15000);
    checkerClean();
  });

  it('exposes attribution on the clawback register, consistently with exposure', async () => {
    const reg = await request(app).get(`/api/funding/donation-clawbacks?branchId=${BRANCH}`).set(owner());
    assertOk('register', reg, 200);
    const body = reg.body as { clawbacks: Array<{ id: string; attributedKind: string | null; attributedId: string | null; status: string }>; totals: { open: number; repaid: number } };
    for (const c of body.clawbacks) {
      expect(c.attributedKind).not.toBeNull();
      expect(c.attributedId).not.toBeNull();
    }
    const exposure = await request(app).get(`/api/funding/restricted-exposure?branchId=${BRANCH}`).set(owner());
    const exp = exposure.body as { restrictedReclaimed: number };
    expect(exp.restrictedReclaimed).toBe(body.totals.open + body.totals.repaid);
    checkerClean();
  });
});

describe('W18 · B. fixed-asset custody loss (D-188)', () => {
  it('declares a loss as a custody fact with ZERO financial writes', async () => {
    const asset = await request(app).post('/api/finance/assets').set(owner())
      .send({ name: unique('W18 Generator'), branchId: BRANCH, categoryId: 'sub_furniture_fixtures', cost: 45000, notes: 'courtyard generator' });
    assertOk('asset', asset, 201);

    const shortReason = await request(app).post(`/api/finance/assets/${asset.body.id}/declare-loss`).set(owner()).send({ reason: 'gone' });
    assertOk('reason length enforced', shortReason, 400);

    const ftBefore = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    const loss = await request(app).post(`/api/finance/assets/${asset.body.id}/declare-loss`).set(owner())
      .send({ reason: 'Stolen from the courtyard over the weekend', evidenceRef: 'Police report 2026-0881' });
    assertOk('declare loss', loss, 201);
    expect((db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c).toBe(ftBefore); // no ledger write, ever

    const list = await request(app).get(`/api/finance/assets?branchId=${BRANCH}`).set(owner());
    const row = ((list.body as Array<{ id: string; custodyStatus: string; loss: { reason: string; evidenceRef: string | null } | null }>).find((a) => a.id === asset.body.id));
    expect(row?.custodyStatus).toBe('lost');
    expect(row?.loss?.reason).toBe('Stolen from the courtyard over the weekend');
    expect(row?.loss?.evidenceRef).toBe('Police report 2026-0881');

    // One loss per asset; a lost asset has no custody to transfer.
    assertOk('double loss refused', await request(app).post(`/api/finance/assets/${asset.body.id}/declare-loss`).set(owner()).send({ reason: 'Declared lost a second time' }), 409);
    assertOk('lost asset cannot transfer', await request(app).post(`/api/finance/assets/${asset.body.id}/transfer`).set(owner()).send({ toBranchId: BRANCH, reason: 'Cannot move a lost asset' }), 400, 409);
    assertOk('teacher cannot declare', await request(app).post(`/api/finance/assets/${asset.body.id}/declare-loss`).set(teacher()).send({ reason: 'Unauthorized loss declaration' }), 403);
    checkerClean();
  });
});
