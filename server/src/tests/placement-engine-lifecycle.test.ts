import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { putProfile, seedContext, startAttempt } from './work-packages/wp04/fixtures.js';

describe('Placement engine lifecycle', () => {
  it('supports optional-placement waiver on the canonical attempt entrypoint', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { requirementMode: 'optional' });
    expect(saved.status).toBe(200);

    const skipped = await startAttempt(context, context.receptionistA, {
      deliveryMode: 'DIGITAL',
      skip: true,
      reason: 'Candidate already has external evidence',
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body.skipped).toBe(true);
    expect(skipped.body.mode).toBe('optional');

    const visitor = db.prepare('SELECT placement_status, current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId) as { placement_status: string; current_placement_attempt_id: string | null };
    expect(visitor.placement_status).toBe('waived');
    expect(visitor.current_placement_attempt_id).toBeNull();
  });

  it('applies first-level exemption through the canonical CEFR requirement resolver', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { firstLevelExempt: true });
    expect(saved.status).toBe(200);

    const view = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .query({ targetLevelId: context.levelA1 })
      .set(context.receptionistA);
    expect(view.status).toBe(200);
    expect(view.body.requirement.mode).toBe('not_required');
    expect(view.body.requirement.decision).toBe('EXEMPT');
    expect(view.body.requirement.firstLevelExemptApplied).toBe(true);
  });

  it('supports pause/resume and branch-scoped expiry maintenance on the same attempt table', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { expiresMinutes: 1 });
    expect(saved.status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    const paused = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/pause`)
      .set(context.managerA)
      .send({ reason: 'Power outage' });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');

    const resumed = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/resume`)
      .set(context.managerA)
      .send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('in_progress');

    db.prepare(`UPDATE placement_assessment_attempts SET expires_at='2000-01-01T00:00:00.000Z', status='paused' WHERE id=?`).run(started.body.id);

    const wrongBranchSweep = await supertest(context.app)
      .post('/api/placement/maintenance/expire')
      .set(context.managerB)
      .send({});
    expect(wrongBranchSweep.status).toBe(200);
    expect(wrongBranchSweep.body.expired).toBe(0);

    const correctBranchSweep = await supertest(context.app)
      .post('/api/placement/maintenance/expire')
      .set(context.managerA)
      .send({});
    expect(correctBranchSweep.status).toBe(200);
    expect(correctBranchSweep.body.expired).toBe(1);

    const attempt = db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as { status: string };
    expect(attempt.status).toBe('expired');
  });
});
