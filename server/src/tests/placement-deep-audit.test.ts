import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { putProfile, scoreAndComplete, seedContext, startAttempt } from './work-packages/wp04/fixtures.js';

describe('Placement deep audit', () => {
  it('enforces branch access and management-only controls on the canonical placement surface', async () => {
    const context = seedContext();
    await putProfile(context);

    const branchDenied = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.managerB);
    expect(branchDenied.status).toBe(403);

    const expiryDenied = await supertest(context.app)
      .post('/api/placement/maintenance/expire')
      .set(context.receptionistA)
      .send({});
    expect(expiryDenied.status).toBe(403);
  });

  it('writes start and completion audit rows with branch attribution and fee evidence', async () => {
    const context = seedContext();
    await putProfile(context);

    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    const completed = await scoreAndComplete(context, started.body.id, 30);
    expect(completed.completed.status).toBe(200);

    const logs = db.prepare(`
      SELECT action, new_value, branch_id
      FROM audit_logs
      WHERE branch_id=? AND (action LIKE 'Started placement assessment%' OR action LIKE 'Completed placement assessment%')
      ORDER BY rowid DESC
      LIMIT 2
    `).all(context.branchA) as Array<{ action: string; new_value: string | null; branch_id: string | null }>;
    expect(logs.length).toBe(2);
    expect(logs.every((row) => row.branch_id === context.branchA)).toBe(true);
    expect(logs.some((row) => row.action.startsWith('Started placement assessment'))).toBe(true);
    expect(logs.some((row) => String(row.new_value || '').includes('"fee"'))).toBe(true);
  });

  it('persists audited manual overrides onto the completed attempt and visitor result snapshot', async () => {
    const context = seedContext();
    await putProfile(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    const completed = await scoreAndComplete(context, started.body.id, 30);
    expect(completed.completed.status).toBe(200);

    const overridden = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/override`)
      .set(context.managerA)
      .send({ levelId: context.levelA1, reason: 'Teacher interview evidence' });
    expect(overridden.status).toBe(200);
    expect(overridden.body.recommendedLevelId).toBe(context.levelA1);

    const attempt = db.prepare(`
      SELECT override_level_id, override_reason
      FROM placement_assessment_attempts
      WHERE id=?
    `).get(started.body.id) as { override_level_id: string | null; override_reason: string | null };
    expect(attempt.override_level_id).toBe(context.levelA1);
    expect(attempt.override_reason).toContain('Teacher interview evidence');

    const visitor = db.prepare('SELECT placement_score FROM visitors WHERE id=?').get(context.visitorId) as { placement_score: string };
    const score = JSON.parse(visitor.placement_score);
    expect(score.recommendation.levelId).toBe(context.levelA1);
    expect(score.recommendation.overridden).toBe(true);
  });
});
