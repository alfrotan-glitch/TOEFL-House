import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { putFixedFeeRule, putProfile, scoreAndComplete, seedContext, startAttempt } from './fixtures.js';

function invoiceFor(attemptId: string) {
  return db.prepare("SELECT * FROM invoices WHERE charge_kind='placement' AND notes=?").get(`Placement assessment fee — attempt ${attemptId}`) as any;
}

describe('WP-04 retake eligibility and placement billing', () => {
  it('creates one idempotent canonical placement invoice for a billable first sitting without fabricating payment records', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: true })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 });
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(100);
    const invoice = invoiceFor(started.body.id);
    expect(invoice).toMatchObject({ total_amount: 100, charge_kind: 'placement', purpose: 'other', branch_id: context.branchA, status: 'issued' });
    expect(db.prepare("SELECT * FROM financial_transactions WHERE type='income' AND category='placement' AND reference_id=?").get(started.body.id)).toBeUndefined();

    const repeated = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA)
      .send({});
    expect(repeated.status).toBe(409);
    expect((db.prepare("SELECT COUNT(*) c FROM invoices WHERE charge_kind='placement' AND notes=?").get(`Placement assessment fee — attempt ${started.body.id}`) as any).c).toBe(1);
    const student = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(context.visitorId) as { id: string } | undefined;
    expect(student?.id).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(student!.id) as { c: number }).c).toBe(0);
  });

  it('does not create invoices, payments, or money movements when the first sitting is configured as non-billable', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: false })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 });
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(0);
    expect(invoiceFor(started.body.id)).toBeUndefined();
    expect(db.prepare("SELECT id FROM financial_transactions WHERE type='income' AND reference_id=?").get(started.body.id)).toBeUndefined();
  });

  it('uses start-time snapshotted retake fee and prior-attempt facts despite later configuration changes', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      firstAttemptBillable: false,
      allowRetake: true,
      maxAttempts: 2,
      retakeBillable: true,
      retakeFeeAmount: 55,
    })).status).toBe(200);
    const first = await startAttempt(context);
    expect((await scoreAndComplete(context, first.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 })).completed.status).toBe(200);
    const second = await startAttempt(context);
    expect(second.status).toBe(201);
    const snapshot = JSON.parse((db.prepare('SELECT snapshot_json FROM placement_assessment_attempts WHERE id=?').get(second.body.id) as any).snapshot_json);
    expect(snapshot.billingTerms).toEqual({ baseFee: 100, priorCompletedAttempts: 1 });
    expect(snapshot.profile.retakeFeeAmount).toBe(55);

    expect((await putProfile(context, { firstAttemptBillable: false, allowRetake: true, maxAttempts: 2, retakeBillable: true, retakeFeeAmount: 77 })).status).toBe(200);
    expect([200, 201]).toContain((await putFixedFeeRule(context, { feeType: 'placement', amount: 999, programVersionId: context.versionA })).status);
    const { completed } = await scoreAndComplete(context, second.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 });
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(55);
    expect(invoiceFor(second.body.id)).toMatchObject({ total_amount: 55, charge_kind: 'placement', purpose: 'other' });
    expect((await startAttempt(context)).status).toBe(409);
  });

  it('an unconfigured retake fee falls back to the base fee, never to zero', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      firstAttemptBillable: false,
      allowRetake: true,
      maxAttempts: 2,
      retakeBillable: true,
      retakeFeeAmount: null,
    })).status).toBe(200);
    const first = await startAttempt(context);
    expect((await scoreAndComplete(context, first.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 })).completed.status).toBe(200);
    const second = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, second.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 });
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(100);
    expect(invoiceFor(second.body.id)).toMatchObject({ total_amount: 100, charge_kind: 'placement', purpose: 'other' });
  });

  it('the first sitting is billed the base fee even when a retake fee is configured', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: true, retakeBillable: true, retakeFeeAmount: 55 })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, { grammar: 20, reading: 16, listening: 16, writing: 18, speaking: 18 });
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(100);
    expect(invoiceFor(started.body.id)).toMatchObject({ total_amount: 100, charge_kind: 'placement', purpose: 'other' });
  });

  it('blocks a retake when disabled and enforces the maximum completed-attempt cap', async () => {
    const disabled = seedContext();
    expect((await putProfile(disabled, { allowRetake: false })).status).toBe(200);
    const first = await startAttempt(disabled);
    expect((await scoreAndComplete(disabled, first.body.id, { grammar: 0, reading: 0, listening: 0, writing: 0, speaking: 0 })).completed.status).toBe(200);
    expect((await startAttempt(disabled)).status).toBe(409);

    const capped = seedContext();
    expect((await putProfile(capped, { allowRetake: true, maxAttempts: 1 })).status).toBe(200);
    const only = await startAttempt(capped);
    expect((await scoreAndComplete(capped, only.body.id, { grammar: 0, reading: 0, listening: 0, writing: 0, speaking: 0 })).completed.status).toBe(200);
    expect((await startAttempt(capped)).status).toBe(409);
  });

  it('keeps a failed sitting billable and auditable without making it enrollment-eligible', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: true })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, { grammar: 0, reading: 0, listening: 0, writing: 0, speaking: 0 });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'failed', feeCharged: 100 });
    expect(invoiceFor(started.body.id)).toMatchObject({ total_amount: 100, charge_kind: 'placement', purpose: 'other' });
    expect(db.prepare('SELECT outcome,status FROM placement_assessment_attempts WHERE id=?').get(started.body.id)).toMatchObject({ outcome: 'failed', status: 'completed' });
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(context.visitorId) as any).placement_status).toBe('scheduled');
  });

  it('blocks a billable start when the required placement fee is not configured', async () => {
    const context = seedContext();
    db.prepare("DELETE FROM fee_rules WHERE branch_id = ? AND fee_type = 'placement'").run(context.branchA);
    expect((await putProfile(context, { firstAttemptBillable: true })).status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(409);
    expect(started.body.error).toMatch(/No active placement fee is configured/i);
  });

  it('delegates fee validation to canonical money rules before any placement policy can snapshot it', async () => {
    const context = seedContext();
    for (const placementTestFee of [-1, 0.5, 'abc', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await supertest(context.app)
        .post('/api/catalog/fee-rules')
        .set(context.owner)
        .send({ branchId: context.branchA, programVersionId: context.versionA, feeType: 'placement', amount: placementTestFee });
      expect(response.status, String(placementTestFee)).toBe(400);
    }
    expect((db.prepare("SELECT amount FROM fee_rules WHERE branch_id=? AND fee_type='placement' ORDER BY version DESC LIMIT 1").get(context.branchA) as any).amount).toBe(100);
  });
});
