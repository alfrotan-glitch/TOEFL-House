import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { resolvePlacementRequirement } from '../../../core/placement/policy-engine.js';
import { seedContext, putProfile, scoreComponent } from './fixtures.js';

describe('WP-04 canonical placement profile and policy resolution', () => {
  it('persists canonical facts once and derives requirement/method/sections projections', async () => {
    const context = seedContext();
    const saved = await putProfile(context, {
      components: [scoreComponent({ key: 'oral', label: 'Oral', maxScore: 40 })],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.requirementMode).toBe('required');
    expect(saved.body.required).toBe(true);
    expect(saved.body.enabled).toBe(true);
    expect(saved.body.method).toBe('custom_score');
    expect(saved.body.sections).toEqual([]);
    expect(saved.body.maxScore).toBeUndefined();

    const columns = (db.prepare("PRAGMA table_info('placement_assessment_profiles')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).not.toEqual(expect.arrayContaining(['enabled', 'required', 'method', 'sections_json', 'max_score']));
  });

  it('requires exact CAS versions and rejects stale or missing profile updates', async () => {
    const context = seedContext();
    const created = await putProfile(context);
    expect(created.status).toBe(200);

    const missing = await supertest(context.app)
      .put(`/api/academic/program-versions/${context.versionA}/placement-profile`)
      .set(context.managerA)
      .send({ requirementMode: 'optional', components: [scoreComponent()] });
    expect(missing.status).toBe(409);

    const stale = await supertest(context.app)
      .put(`/api/academic/program-versions/${context.versionA}/placement-profile`)
      .set(context.managerA)
      .send({
        version: created.body.version - 1,
        requirementMode: 'optional',
        components: [scoreComponent()],
        scoringModel: 'weighted_average',
        allowRetake: true,
        passScore: 60,
      });
    expect(stale.status).toBe(409);
  });

  it('rejects obsolete maxima and invalid component, scoring, timing, retake, and decision facts', async () => {
    const context = seedContext();
    const invalidPayloads = [
      { maxScore: 100 },
      { passScore: 101 },
      { components: [scoreComponent({ maxScore: 0 })] },
      { components: [scoreComponent({ weight: 0 })] },
      { components: [scoreComponent({ scoringMethod: 'automatic' })] },
      { components: [scoreComponent({ required: 'false' })] },
      { components: [scoreComponent({ order: 1.5 })] },
      { expiresMinutes: 0 },
      { expiresMinutes: 525601 },
      { allowRetake: 0 },
      { firstAttemptBillable: 'false' },
      { instructions: { forged: true } },
      { maxAttempts: 0 },
      { maxAttempts: 101 },
      { retakeFeeAmount: -1 },
      { decisionRules: [{ id: 'r', priority: 1, conditions: [{ componentKey: 'main', field: 'score', op: 'gte', value: 101 }], outcome: 'pass' }] },
    ];
    for (const invalid of invalidPayloads) {
      const response = await putProfile(context, invalid);
      expect(response.status, JSON.stringify({ invalid, body: response.body })).toBe(400);
    }
  });

  it('uses candidate branch, then program-owning branch, then global policy without treating unrelated policy as applicable', async () => {
    const context = seedContext();
    const none = resolvePlacementRequirement(context.versionA, context.branchA);
    expect(none.decision).toBe('NOT_REQUIRED');
    expect(none.policySource).toBe('none');

    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score)
      VALUES (?,?,?,?,?,'weighted_average',60)`)
      .run(`${context.key}_unrelated`, context.versionA, context.branchB, 'required', JSON.stringify([scoreComponent()]));
    const unrelated = resolvePlacementRequirement(context.versionA, `${context.key}_unknown-branch`);
    expect(unrelated.decision).toBe('CONFIGURATION_ERROR');

    const programOwner = resolvePlacementRequirement(context.versionA, context.branchB);
    expect(programOwner.policySource).toBe('branch');

    db.prepare('DELETE FROM placement_assessment_profiles WHERE id=?').run(`${context.key}_unrelated`);
    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score)
      VALUES (?,?,?,?,?,'weighted_average',60)`)
      .run(`${context.key}_owner`, context.versionA, context.branchA, 'required', JSON.stringify([scoreComponent()]));
    const fallback = resolvePlacementRequirement(context.versionA, context.branchB);
    expect(fallback.policySource).toBe('program_branch');
  });

  it('can instantiate the program-owning-branch fallback without violating attempt scope integrity', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const visitorB = `${context.key}_fallback_visitor`;
    db.prepare(`INSERT INTO visitors
      (id,serial_no,full_name,phone,gender,source,status,stage,branch_id,visit_date,program_version_id,placement_status)
      VALUES (?,?,?,?, 'male','walk_in','visited','placement_booking',?,date('now'),?,'not_started')`)
      .run(visitorB, `${context.key}-FALLBACK`, 'Fallback candidate', `${context.key}-fallback-phone`, context.branchB, context.versionA);
    const started = await supertest(context.app)
      .post(`/api/placement/visitors/${visitorB}/placement/attempts`)
      .set(context.owner).send({});
    expect(started.status).toBe(201);
    const attempt = db.prepare('SELECT branch_id,profile_id FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any;
    expect(attempt.branch_id).toBe(context.branchB);
    expect((db.prepare('SELECT branch_id FROM placement_assessment_profiles WHERE id=?').get(attempt.profile_id) as any).branch_id).toBe(context.branchA);
  });

  it('applies first-level exemption only to the first active level', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { firstLevelExempt: true });
    expect(saved.status).toBe(200);
    expect(resolvePlacementRequirement(context.versionA, context.branchA, context.levelA1).decision).toBe('EXEMPT');
    expect(resolvePlacementRequirement(context.versionA, context.branchA, context.levelA2).decision).toBe('REQUIRED');
    db.prepare('UPDATE levels SET is_active=0 WHERE id=?').run(context.levelA1);
    expect(resolvePlacementRequirement(context.versionA, context.branchA, context.levelA2).decision).toBe('EXEMPT');
  });

  it('enforces object-correlated branch authority for profile access', async () => {
    const context = seedContext();
    const deniedRead = await supertest(context.app)
      .get(`/api/academic/program-versions/${context.versionA}/placement-profile`)
      .set(context.managerB);
    expect(deniedRead.status).toBe(403);
    const deniedWrite = await putProfile(context, {}, context.managerB);
    expect(deniedWrite.status).toBe(403);
  });

  it('correlates placement rules to their version and level and rejects overlapping ranges', async () => {
    const context = seedContext();
    const wrongLevel = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'wrong', minScore: 0, maxScore: 50, recommendedLevelId: context.levelB1 });
    expect(wrongLevel.status).toBe(400);

    const first = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'A1', minScore: 0, maxScore: 49.99, recommendedLevelId: context.levelA1 });
    expect(first.status).toBe(201);
    const overlap = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'overlap', minScore: 49, maxScore: 80, recommendedLevelId: context.levelA2 });
    expect(overlap.status).toBe(409);
    const second = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'A2', minScore: 50, maxScore: 100, recommendedLevelId: context.levelA2 });
    expect(second.status).toBe(201);
  });

  it('soft-retires placement rules and rejects a repeated retirement', async () => {
    const context = seedContext();
    const created = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'A1', minScore: 0, maxScore: 100, recommendedLevelId: context.levelA1 });
    expect(created.status).toBe(201);
    const retired = await supertest(context.app).delete(`/api/catalog/placement-rules/${created.body.id}`).set(context.managerA);
    expect(retired.status).toBe(200);
    const repeated = await supertest(context.app).delete(`/api/catalog/placement-rules/${created.body.id}`).set(context.managerA);
    expect(repeated.status).toBe(409);
    expect((db.prepare('SELECT is_active FROM placement_rules WHERE id=?').get(created.body.id) as any).is_active).toBe(0);
  });
});
