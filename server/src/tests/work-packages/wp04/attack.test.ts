import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { createActiveTest, putProfile, scoreComponent, seedContext, startAttempt } from './fixtures.js';

describe('WP-04 adversarial authorization and integrity attacks', () => {
  it('rejects unauthenticated placement reads, writes, authoring, reports, and maintenance', async () => {
    const context = seedContext();
    const probes: Array<Promise<supertest.Response>> = [
      supertest(context.app).get(`/api/placement/visitors/${context.visitorId}/placement`),
      supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts`).send({}),
      supertest(context.app).get('/api/placement/test-bank'),
      supertest(context.app).post('/api/placement/test-bank').send({}),
      supertest(context.app).get('/api/placement/report?from=2000-01-01&to=2100-01-01'),
      supertest(context.app).post('/api/placement/maintenance/expire').send({}),
    ];
    for (const probe of probes) expect((await probe).status).toBe(401);
  });

  it('rejects cross-branch visitor ids across view, start, scoring, and cancellation boundaries', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    const urls = [
      supertest(context.app).get(`/api/placement/visitors/${context.visitorId}/placement`).set(context.managerB),
      supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts`).set(context.managerB).send({}),
      supertest(context.app).put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/main`).set(context.managerB).send({ score: 90 }),
      supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/cancel`).set(context.managerB).send({}),
    ];
    for (const probe of urls) expect((await probe).status).toBe(403);
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).status).toBe('in_progress');
  });

  it('correlates attempt ids to their visitor instead of authorizing a forged parent/id pair', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const otherVisitor = `${context.key}_other_visitor`;
    db.prepare(`INSERT INTO visitors
      (id,serial_no,full_name,phone,gender,source,status,stage,branch_id,visit_date,program_version_id,placement_status)
      VALUES (?,?,?,?, 'male','walk_in','visited','placement_booking',?,date('now'),?,'not_started')`)
      .run(otherVisitor, `${context.key}-OTHER`, 'Other', `${context.key}-phone`, context.branchA, context.versionA);
    const forged = await supertest(context.app)
      .put(`/api/placement/visitors/${otherVisitor}/placement/attempts/${started.body.id}/components/main`)
      .set(context.receptionistA).send({ score: 100 });
    expect(forged.status).toBe(404);
    expect((db.prepare("SELECT status FROM placement_assessment_results WHERE attempt_id=? AND component_key='main'").get(started.body.id) as any).status).toBe('pending');
  });

  it('fails closed on structurally valid JSON that contains corrupted stored policy facts', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const corrupt = scoreComponent({ required: 'false' });
    db.prepare('UPDATE placement_assessment_profiles SET components_json=? WHERE program_version_id=? AND branch_id=?')
      .run(JSON.stringify([corrupt]), context.versionA, context.branchA);
    const denied = await startAttempt(context);
    expect(denied.status).toBe(409);
    expect(db.prepare('SELECT id FROM placement_assessment_attempts WHERE visitor_id=?').get(context.visitorId)).toBeUndefined();
  });

  it('enforces attempt branch, program, and profile correlation in database triggers', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const profile = db.prepare('SELECT id FROM placement_assessment_profiles WHERE program_version_id=? AND branch_id=?').get(context.versionA, context.branchA) as any;
    expect(() => db.prepare(`INSERT INTO placement_assessment_attempts
      (id,visitor_id,program_version_id,profile_id,branch_id,attempt_number,snapshot_json)
      VALUES (?,?,?,?,?,1,'{"components":[],"tests":[]}')`)
      .run(`${context.key}_bad_branch`, context.visitorId, context.versionA, profile.id, context.branchB))
      .toThrow(/scope mismatch/i);
    expect(() => db.prepare(`INSERT INTO placement_assessment_attempts
      (id,visitor_id,program_version_id,profile_id,branch_id,attempt_number,snapshot_json)
      VALUES (?,?,?,?,?,1,'{"components":[],"tests":[]}')`)
      .run(`${context.key}_bad_version`, context.visitorId, context.versionB, profile.id, context.branchA))
      .toThrow(/scope mismatch/i);
  });

  it('enforces one open attempt under direct concurrent-style database writes', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const profile = db.prepare('SELECT id FROM placement_assessment_profiles WHERE program_version_id=? AND branch_id=?').get(context.versionA, context.branchA) as any;
    expect(() => db.prepare(`INSERT INTO placement_assessment_attempts
      (id,visitor_id,program_version_id,profile_id,branch_id,attempt_number,snapshot_json)
      VALUES (?,?,?,?,?,2,'{"components":[],"tests":[]}')`)
      .run(`${context.key}_second_open`, context.visitorId, context.versionA, profile.id, context.branchA))
      .toThrow(/UNIQUE constraint failed/i);
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).status).toBe('in_progress');
  });

  it('rejects forged response and result rows not present in the immutable attempt snapshot', async () => {
    const context = seedContext();
    const test = await createActiveTest(context);
    expect((await putProfile(context, { components: [{
      key: 'content', type: 'content_test', label: 'Content', required: true,
      weight: 100, maxScore: 10, scoringMethod: 'auto', testType: 'listening', testId: test.id,
    }] })).status).toBe(200);
    const started = await startAttempt(context);
    expect(() => db.prepare(`INSERT INTO placement_assessment_responses
      (id,attempt_id,test_id,question_id,question_key,response_json,max_points)
      VALUES (?,?,?,?,?,'"A"',1)`)
      .run(`${context.key}_response`, started.body.id, 'forged-test', 'forged-question', 'q1'))
      .toThrow(/not in the attempt snapshot/i);
    expect(() => db.prepare(`INSERT INTO placement_assessment_results
      (id,attempt_id,component_key,component_type,label,status,max_score,weight)
      VALUES (?,?,?,'custom_score','Forged','pending',100,0)`)
      .run(`${context.key}_result`, started.body.id, 'forged-component'))
      .toThrow(/not in the attempt snapshot/i);
  });

  it('prevents branch managers from turning all-scope maintenance into a cross-branch mutation', async () => {
    const context = seedContext();
    expect((await putProfile(context, { expiresMinutes: 30 })).status).toBe(200);
    const attemptA = await startAttempt(context);
    db.prepare("UPDATE placement_assessment_attempts SET expires_at=datetime('now','-1 minute') WHERE id=?").run(attemptA.body.id);

    const visitorB = `${context.key}_visitor_b`;
    db.prepare(`INSERT INTO visitors
      (id,serial_no,full_name,phone,gender,source,status,stage,branch_id,visit_date,program_version_id,placement_status,current_placement_attempt_id)
      VALUES (?,?,?,?, 'male','walk_in','visited','placement_booking',?,date('now'),?,'in_progress',NULL)`)
      .run(visitorB, `${context.key}-B`, 'Branch B candidate', `${context.key}-b-phone`, context.branchB, context.versionB);
    const profileB = `${context.key}_profile_b`;
    db.prepare(`INSERT INTO placement_assessment_profiles
      (id,program_version_id,branch_id,requirement_mode,components_json,scoring_model,pass_score)
      VALUES (?,?,?,?,?,'weighted_average',60)`)
      .run(profileB, context.versionB, context.branchB, 'required', JSON.stringify([scoreComponent()]));
    const attemptB = `${context.key}_attempt_b`;
    db.prepare(`INSERT INTO placement_assessment_attempts
      (id,visitor_id,program_version_id,profile_id,branch_id,attempt_number,snapshot_json,expires_at)
      VALUES (?,?,?,?,?,1,?,datetime('now','-1 minute'))`)
      .run(attemptB, visitorB, context.versionB, profileB, context.branchB, JSON.stringify({ components: [scoreComponent()], tests: [] }));
    db.prepare('UPDATE visitors SET current_placement_attempt_id=? WHERE id=?').run(attemptB, visitorB);

    const swept = await supertest(context.app).post('/api/placement/maintenance/expire?branchId=all').set(context.managerA).send({});
    expect(swept.status).toBe(200);
    expect(swept.body.expired).toBe(1);
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(attemptA.body.id) as any).status).toBe('expired');
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(attemptB) as any).status).toBe('in_progress');
  });

  it('rejects cross-branch content references even when the caller can manage both branches', async () => {
    const context = seedContext();
    const foreignTest = await createActiveTest(context, { branchId: context.branchB }, context.owner);
    const response = await putProfile(context, { components: [{
      key: 'foreign', type: 'content_test', label: 'Foreign', required: true,
      weight: 100, maxScore: 10, scoringMethod: 'auto', testType: 'listening', testId: foreignTest.id,
    }] }, context.owner);
    expect(response.status).toBe(400);
  });
});
