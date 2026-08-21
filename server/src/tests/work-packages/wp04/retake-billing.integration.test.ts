import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { putProfile, scoreAndComplete, seedContext, startAttempt } from './fixtures.js';

function paymentFor(attemptId: string) {
  return db.prepare("SELECT * FROM payments WHERE idempotency_key=?").get(`placement:${attemptId}`) as any;
}

describe('WP-04 retake eligibility and placement billing', () => {
  it('creates one idempotent payment and linked income entry for a billable first sitting', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: true })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, 80);
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(100);
    const payment = paymentFor(started.body.id);
    expect(payment).toMatchObject({ amount: 100, category: 'placement', branch_id: context.branchA });
    const income = db.prepare("SELECT * FROM financial_transactions WHERE type='income' AND category='placement' AND reference_id=?").get(started.body.id) as any;
    expect(income).toMatchObject({ amount: 100, payment_id: payment.id, branch_id: context.branchA });

    const repeated = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA).send({});
    expect(repeated.status).toBe(409);
    expect((db.prepare("SELECT COUNT(*) c FROM payments WHERE idempotency_key=?").get(`placement:${started.body.id}`) as any).c).toBe(1);
  });

  it('does not create money records when the first sitting is configured as non-billable', async () => {
    const context = seedContext();
    expect((await putProfile(context, { firstAttemptBillable: false })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, 80);
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(0);
    expect(paymentFor(started.body.id)).toBeUndefined();
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
    expect((await scoreAndComplete(context, first.body.id, 80)).completed.status).toBe(200);
    const second = await startAttempt(context);
    expect(second.status).toBe(201);
    const snapshot = JSON.parse((db.prepare('SELECT snapshot_json FROM placement_assessment_attempts WHERE id=?').get(second.body.id) as any).snapshot_json);
    expect(snapshot.billingTerms).toEqual({ baseFee: 100, priorCompletedAttempts: 1 });
    expect(snapshot.profile.retakeFeeAmount).toBe(55);

    expect((await putProfile(context, { firstAttemptBillable: false, allowRetake: true, maxAttempts: 2, retakeBillable: true, retakeFeeAmount: 77 })).status).toBe(200);
    expect((await supertest(context.app).put(`/api/catalog/branch-profile/${context.branchA}`).set(context.owner).send({ placementTestFee: 999 })).status).toBe(200);
    const { completed } = await scoreAndComplete(context, second.body.id, 80);
    expect(completed.status).toBe(200);
    expect(completed.body.feeCharged).toBe(55);
    expect(paymentFor(second.body.id).amount).toBe(55);
    expect((await startAttempt(context)).status).toBe(409);
  });

  it('blocks a retake when disabled and enforces the maximum completed-attempt cap', async () => {
    const disabled = seedContext();
    expect((await putProfile(disabled, { allowRetake: false })).status).toBe(200);
    const first = await startAttempt(disabled);
    expect((await scoreAndComplete(disabled, first.body.id, 20)).completed.status).toBe(200);
    expect((await startAttempt(disabled)).status).toBe(409);

    const capped = seedContext();
    expect((await putProfile(capped, { allowRetake: true, maxAttempts: 1 })).status).toBe(200);
    const only = await startAttempt(capped);
    expect((await scoreAndComplete(capped, only.body.id, 20)).completed.status).toBe(200);
    expect((await startAttempt(capped)).status).toBe(409);
  });

  it('keeps a failed sitting billable and auditable without making it enrollment-eligible', async () => {
    const context = seedContext();
    expect((await putProfile(context, { passScore: 90, firstAttemptBillable: true })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, 10);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'failed', feeCharged: 100 });
    expect(paymentFor(started.body.id).amount).toBe(100);
    expect(db.prepare('SELECT outcome,status FROM placement_assessment_attempts WHERE id=?').get(started.body.id)).toMatchObject({ outcome: 'failed', status: 'completed' });
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(context.visitorId) as any).placement_status).toBe('scheduled');
  });

  it('delegates fee validation to canonical money rules before any placement policy can snapshot it', async () => {
    const context = seedContext();
    for (const placementTestFee of [-1, 0.5, 'abc', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await supertest(context.app)
        .put(`/api/catalog/branch-profile/${context.branchA}`)
        .set(context.owner).send({ placementTestFee });
      expect(response.status, String(placementTestFee)).toBe(400);
    }
    expect((db.prepare('SELECT placement_test_fee FROM branch_academic_profiles WHERE branch_id=?').get(context.branchA) as any).placement_test_fee).toBe(100);
  });
});
