import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { putProfile, scoreAndComplete, seedContext, startAttempt, startTimer, enterManualScore } from './work-packages/wp04/fixtures.js';

describe('Placement hardening', () => {
  it('rejects parallel attempt creation for the same visitor', async () => {
    const context = seedContext();
    await putProfile(context);

    const first = await startAttempt(context);
    expect(first.status).toBe(201);

    const second = await startAttempt(context);
    expect(second.status).toBe(409);
    expect(String(second.body.error || '')).toContain('already has an open placement attempt');

    const open = db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id=? AND status IN ('in_progress','paused')`).get(context.visitorId) as { c: number };
    expect(open.c).toBe(1);
  });

  it('prevents duplicate completion from generating duplicate placement invoices', async () => {
    const context = seedContext();
    await putProfile(context);

    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    const firstComplete = await scoreAndComplete(context, started.body.id, 30);
    expect(firstComplete.completed.status).toBe(200);

    const secondComplete = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA)
      .send({});
    expect(secondComplete.status).toBe(409);

    const invoices = db.prepare(`
      SELECT COUNT(*) AS c
        FROM invoices i
        JOIN students s ON s.id = i.student_id
       WHERE s.lead_id = ? AND i.charge_kind = 'placement' AND i.notes = ?
    `).get(context.visitorId, `Placement assessment fee — attempt ${started.body.id}`) as { c: number };
    expect(invoices.c).toBe(1);
  });

  it('enforces canonical score bounds on manual entry', async () => {
    const context = seedContext();
    await putProfile(context);

    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    await startTimer(context, started.body.id, 'grammar');
    const invalidGrammar = await enterManualScore(context, started.body.id, 'grammar', { score: 31 });
    expect(invalidGrammar.status).toBe(400);
    expect(String(invalidGrammar.body.error || '')).toContain('between 0 and 30');

    await startTimer(context, started.body.id, 'writing');
    const invalidWriting = await enterManualScore(context, started.body.id, 'writing', { score: 26 });
    expect(invalidWriting.status).toBe(400);
    expect(String(invalidWriting.body.error || '')).toContain('between 0 and 25');
  });
});
