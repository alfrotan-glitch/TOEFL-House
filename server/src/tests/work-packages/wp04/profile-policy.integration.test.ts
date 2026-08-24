import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { resolvePlacementRequirement } from '../../../core/placement/policy-engine.js';
import { canonicalComponents, canonicalDecisionRules, putProfile, seedContext } from './fixtures.js';

describe('WP-04 canonical placement profile and policy resolution', () => {
  it('persists canonical facts once and derives canonical requirement, method, delivery, and component projections', async () => {
    const context = seedContext();
    const saved = await putProfile(context);
    expect(saved.status).toBe(200);
    expect(saved.body.requirementMode).toBe('required');
    expect(saved.body.required).toBe(true);
    expect(saved.body.enabled).toBe(true);
    expect(saved.body.method).toBe('canonical_v1');
    expect(saved.body.deliveryModes).toEqual(['DIGITAL', 'PHYSICAL']);
    expect(saved.body.maxScore).toBeUndefined();
    expect(saved.body.components.map((component: any) => component.key)).toEqual(['grammar', 'reading', 'listening', 'writing', 'speaking']);

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
      .send({
        requirementMode: 'optional',
        components: canonicalComponents(context),
        scoringModel: 'canonical',
        allowRetake: true,
        passScore: 60,
        decisionRules: canonicalDecisionRules(context),
      });
    expect(missing.status).toBe(409);

    const stale = await putProfile(context, { version: created.body.version - 1, requirementMode: 'optional' });
    expect(stale.status).toBe(409);
  });

  it('rejects obsolete maxima and invalid canonical component, scoring, timing, retake, and decision facts', async () => {
    const context = seedContext();
    const maxScoreResponse = await supertest(context.app)
      .put(`/api/academic/program-versions/${context.versionA}/placement-profile`)
      .set(context.managerA)
      .send({
        version: null,
        requirementMode: 'required',
        components: canonicalComponents(context),
        scoringModel: 'canonical',
        allowRetake: true,
        passScore: 60,
        decisionRules: canonicalDecisionRules(context),
        maxScore: 100,
      });
    expect(maxScoreResponse.status).toBe(400);

    const invalidPayloads = [
      { passScore: 121 },
      { scoringModel: 'weighted_average' as any },
      { components: canonicalComponents(context).slice(0, 4) },
      { components: canonicalComponents(context, { grammar: { key: 'wrong' as any } }) },
      { components: canonicalComponents(context, { grammar: { bankIds: [] } }) },
      { components: canonicalComponents(context, { grammar: { blueprintBuckets: [{ count: 29, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] as any } }) },
      { expiresMinutes: 0 },
      { expiresMinutes: 525601 },
      { allowRetake: 0 as any },
      { firstAttemptBillable: 'false' as any },
      { instructions: { forged: true } as any },
      { maxAttempts: 0 },
      { maxAttempts: 101 },
      { retakeFeeAmount: -1 },
      { retakeFeeAmount: 1e15 },
      { retakeFeeAmount: 1e20 },
      { retakeFeeAmount: 'abc' as any },
      { requirementMode: 'optional', firstLevelExempt: true },
      { decisionRules: canonicalDecisionRules(context).slice(0, 4) },
      { decisionRules: canonicalDecisionRules(context).map((rule) => rule.cefrLevel === 'B1' ? { ...rule, minimumScores: { ...rule.minimumScores, grammar: 1 } } : rule) },
    ];
    for (const invalid of invalidPayloads) {
      const response = await putProfile(context, invalid as any);
      expect(response.status, JSON.stringify({ invalid, body: response.body })).toBe(400);
    }
  });

  it('uses candidate branch, then program-owning branch, then global policy without treating unrelated policy as applicable', async () => {
    const context = seedContext();
    const none = resolvePlacementRequirement(context.versionA, context.branchA);
    expect(none.decision).toBe('NOT_REQUIRED');
    expect(none.policySource).toBe('none');

    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score,decision_rules_json)
      VALUES (?,?,?,?,?,'canonical',60,?)`)
      .run(
        `${context.key}_unrelated`,
        context.versionA,
        context.branchB,
        'required',
        JSON.stringify(canonicalComponents(context)),
        JSON.stringify(canonicalDecisionRules(context)),
      );
    const unrelated = resolvePlacementRequirement(context.versionA, `${context.key}_unknown-branch`);
    expect(unrelated.decision).toBe('CONFIGURATION_ERROR');

    const programOwner = resolvePlacementRequirement(context.versionA, context.branchB);
    expect(programOwner.policySource).toBe('branch');

    db.prepare('DELETE FROM placement_assessment_profiles WHERE id=?').run(`${context.key}_unrelated`);
    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score,decision_rules_json)
      VALUES (?,?,?,?,?,'canonical',60,?)`)
      .run(
        `${context.key}_owner`,
        context.versionA,
        context.branchA,
        'required',
        JSON.stringify(canonicalComponents(context)),
        JSON.stringify(canonicalDecisionRules(context)),
      );
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
    db.prepare(`
      INSERT INTO students (id, student_code, full_name, phone, qr_code, status, registration_date, branch_id, discount_percent, lead_id, gender)
      VALUES (?, ?, ?, ?, ?, 'active', date('now'), ?, 0, ?, 'male')
    `).run(`${context.key}_fallback_student`, `${context.key}-fallback-student`, 'Fallback candidate', '0700004321', `${context.key}-fallback-student`, context.branchB, visitorB);
    const started = await supertest(context.app)
      .post(`/api/placement/visitors/${visitorB}/placement/attempts`)
      .set(context.owner)
      .send({ deliveryMode: 'PHYSICAL' });
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

  it('copies the canonical placement profile when a program version is duplicated and remaps decision levels', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);

    const copied = await supertest(context.app)
      .post('/api/catalog/program-versions')
      .set(context.managerA)
      .send({
        programId: context.programA,
        versionLabel: 'v2',
        copyFromVersionId: context.versionA,
      });
    expect(copied.status).toBe(201);

    const copiedVersionId = copied.body.version.id as string;
    const copiedLevels = copied.body.levels as Array<{ id: string; code?: string; name?: string }>;
    const copiedByCode = new Map(copiedLevels.map((level) => [String(level.code || level.name), level.id]));

    const profile = await supertest(context.app)
      .get(`/api/academic/program-versions/${copiedVersionId}/placement-profile`)
      .set(context.managerA);
    expect(profile.status).toBe(200);
    expect(profile.body.configured).toBe(true);
    expect(profile.body.components.map((component: any) => component.key)).toEqual(['grammar', 'reading', 'listening', 'writing', 'speaking']);
    expect(profile.body.decisionRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ cefrLevel: 'A1', recommendedLevelId: copiedByCode.get('A1') }),
      expect.objectContaining({ cefrLevel: 'A2', recommendedLevelId: copiedByCode.get('A2') }),
      expect.objectContaining({ cefrLevel: 'B1', recommendedLevelId: copiedByCode.get('A2') }),
      expect.objectContaining({ cefrLevel: 'B2', recommendedLevelId: copiedByCode.get('A2') }),
      expect.objectContaining({ cefrLevel: 'C1', recommendedLevelId: copiedByCode.get('A2') }),
    ]));
  });

  it('retires the legacy placement-rules catalog surface completely', async () => {
    const context = seedContext();
    const createLegacy = await supertest(context.app)
      .post('/api/catalog/placement-rules')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, name: 'legacy', minScore: 0, maxScore: 100, recommendedLevelId: context.levelA1 });
    expect(createLegacy.status).toBe(404);

    const deleteLegacy = await supertest(context.app)
      .delete('/api/catalog/placement-rules/nonexistent')
      .set(context.managerA);
    expect(deleteLegacy.status).toBe(404);

    const recommendLegacy = await supertest(context.app)
      .post('/api/catalog/placement/recommend')
      .set(context.managerA)
      .send({ programVersionId: context.versionA, totalScore: 100, branchId: context.branchA });
    expect(recommendLegacy.status).toBe(404);
  });
});
