import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { putProfile, scoreAndComplete, seedContext, startAttempt } from './work-packages/wp04/fixtures.js';

describe('Placement retake fee integrity', () => {
  it('rejects invalid canonical retake fee values at profile save time', async () => {
    const context = seedContext();

    const negative = await putProfile(context, { retakeFeeAmount: -1 });
    expect(negative.status).toBe(400);

    const fractional = await putProfile(context, { retakeFeeAmount: 12.5 });
    expect(fractional.status).toBe(400);

    const nonsensical = await putProfile(context, { retakeFeeAmount: 'abc' as any });
    expect(nonsensical.status).toBe(400);
  });

  it('charges the branch fee for the first attempt and the configured retake fee for later attempts via canonical placement invoices', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { retakeBillable: true, retakeFeeAmount: 250 });
    expect(saved.status).toBe(200);

    const firstAttempt = await startAttempt(context);
    expect(firstAttempt.status).toBe(201);
    const firstComplete = await scoreAndComplete(context, firstAttempt.body.id, 30);
    expect(firstComplete.completed.status).toBe(200);
    expect(firstComplete.completed.body.feeCharged).toBe(100);

    const secondAttempt = await startAttempt(context);
    expect(secondAttempt.status).toBe(201);
    const secondComplete = await scoreAndComplete(context, secondAttempt.body.id, 30);
    expect(secondComplete.completed.status).toBe(200);
    expect(secondComplete.completed.body.feeCharged).toBe(250);

    const invoices = db.prepare(`
      SELECT total_amount, charge_kind, purpose, notes
      FROM invoices
      WHERE branch_id = ? AND charge_kind = 'placement'
      ORDER BY rowid
    `).all(context.branchA) as Array<{ total_amount: number; charge_kind: string; purpose: string; notes: string | null }>;
    expect(invoices.slice(-2).map((row) => row.total_amount).sort((a, b) => a - b)).toEqual([100, 250]);
    expect(invoices.slice(-2)).toEqual([
      expect.objectContaining({ charge_kind: 'placement', purpose: 'other', notes: `Placement assessment fee — attempt ${firstAttempt.body.id}` }),
      expect.objectContaining({ charge_kind: 'placement', purpose: 'other', notes: `Placement assessment fee — attempt ${secondAttempt.body.id}` }),
    ]);
    const student = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(context.visitorId) as { id: string } | undefined;
    expect(student?.id).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(student!.id) as { c: number }).c).toBe(0);
  });

  it('marks the last completed attempt as the visitor’s authoritative placement snapshot', async () => {
    const context = seedContext();
    const saved = await putProfile(context);
    expect(saved.status).toBe(200);

    const attempt = await startAttempt(context);
    expect(attempt.status).toBe(201);
    const complete = await scoreAndComplete(context, attempt.body.id, 30);
    expect(complete.completed.status).toBe(200);

    const visitor = db.prepare('SELECT placement_status, current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId) as { placement_status: string; current_placement_attempt_id: string | null };
    expect(visitor.placement_status).toBe('completed');
    expect(visitor.current_placement_attempt_id).toBe(attempt.body.id);
  });
});
