import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import visitorsRouter from '../routes/visitors.routes.js';
import placementRouter from '../routes/placement.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';

const BRANCH = 'placement_workspace_branch';
const PROGRAM = 'placement_workspace_program';
const VERSION = 'placement_workspace_version';
const LEVEL_A = 'placement_workspace_a1';
const LEVEL_B = 'placement_workspace_b1';
const USER = 'placement_workspace_owner';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(user: TokenPayload) {
  return { Authorization: `Bearer ${signToken(user)}` };
}

describe('Unified Placement Assessment Workspace', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let visitorId: string;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'Placement Branch', 'Test');
    db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`)
      .run(USER, 'placement-owner', 'Placement Owner', BRANCH, await hashPassword('testpass123'));
    syncLegacyUserRoles(db);

    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`)
      .run(PROGRAM, 'Placement Program', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`)
      .run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1 Beginner', 1, ?, 'A1', 1)`)
      .run(LEVEL_A, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1 Intermediate', 2, ?, 'B1', 1)`)
      .run(LEVEL_B, PROGRAM, VERSION);
    db.prepare(`INSERT OR REPLACE INTO placement_assessment_profiles (id, program_version_id, branch_id, enabled, required, method, components_json, scoring_model, allow_retake, max_score, pass_score, instructions) VALUES (?, ?, ?, 1, 1, 'hybrid', ?, 'weighted_average', 1, 100, 60, 'Complete every configured section.')`)
      .run(id('pap'), VERSION, BRANCH, JSON.stringify([
        { key: 'skills', type: 'skill_scores', label: 'Skills Assessment', required: true, weight: 60, maxScore: 100, skills: ['grammar','vocabulary','reading','listening','writing','speaking'] },
        { key: 'written', type: 'written_test', label: 'Written Test', required: true, weight: 20, maxScore: 100 },
        { key: 'interview', type: 'interview', label: 'Interview', required: true, weight: 20, maxScore: 100 },
      ]));
    db.prepare(`DELETE FROM visitors WHERE id = 'placement_workspace_visitor'`);
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Placement Candidate', '0700000000', 'male', 'social', ?, 'visited', ?, 'Placement Program', ?, 'not_started')`)
      .run('placement_workspace_visitor', 'V-9988', today(), BRANCH, VERSION);
    visitorId = 'placement_workspace_visitor';
    owner = { userId: USER, username: 'placement-owner', role: 'owner', branchId: BRANCH, fullName: 'Placement Owner' };
    app = createApp();
  });

  it('starts one candidate workspace with all configured sections', async () => {
    const res = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({});
    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.map((r: any) => r.component_key)).toEqual(['skills', 'written', 'interview']);
  });

  it('prevents completion until all required sections are completed', async () => {
    const current = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    const attemptId = current.body.current.id;
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/skills`).set(authHeader(owner)).send({
      skills: { grammar: 20, vocabulary: 20, reading: 20, listening: 20, writing: 20, speaking: 20 },
    });
    const complete = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(400);
    expect(complete.body.error).toContain('Complete all required');
  });

  it('completes the entire assessment and stores one recommendation across all sections', async () => {
    const current = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    const attemptId = current.body.current.id;
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/skills`).set(authHeader(owner)).send({
      skills: { grammar: 24, vocabulary: 23, reading: 22, listening: 24, writing: 23, speaking: 22 },
    });
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/written`).set(authHeader(owner)).send({ score: 90, resultText: 'Strong written control.' });
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/interview`).set(authHeader(owner)).send({ score: 85, resultText: 'Strong conversational control.' });
    const complete = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(200);
    expect(complete.body.attempt.status).toBe('completed');
    expect(complete.body.attempt.percentage).toBeGreaterThan(80);
    const visitor = db.prepare(`SELECT placement_status, current_placement_attempt_id, placement_score FROM visitors WHERE id = ?`).get(visitorId) as any;
    expect(visitor.placement_status).toBe('completed');
    expect(visitor.current_placement_attempt_id).toBe(attemptId);
    expect(JSON.parse(visitor.placement_score).recommendation).toBeDefined();
  });

  it('allows an explicit level-only assessment without a numeric score', async () => {
    // Use a dedicated program version + profile so the shared skills-based
    // profile (used by the other tests in this suite) is left untouched.
    const levelProgram = 'placement_workspace_level_program';
    const levelVersion = 'placement_workspace_level_version';
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, 'Level Program', 12, ?, 1)`)
      .run(levelProgram, BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'lv1', 1, 'published', 0)`)
      .run(levelVersion, levelProgram);
    const levelOnlyLevel = 'placement_workspace_level_b1';
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1 Intermediate', 2, ?, 'B1', 1)`)
      .run(levelOnlyLevel, levelProgram, levelVersion);
    db.prepare(`INSERT OR REPLACE INTO placement_assessment_profiles (id, program_version_id, branch_id, enabled, required, method, components_json, scoring_model, allow_retake, max_score, pass_score, instructions) VALUES (?, ?, ?, 1, 1, 'level_assessment', ?, 'weighted_average', 1, 100, 60, 'Level interview only.')`)
      .run(id('pap_level'), levelVersion, BRANCH, JSON.stringify([{ key: 'level', type: 'level_assessment', label: 'Level Interview', required: true, weight: 100, maxScore: 100 }]));
    const id2 = 'placement_workspace_level_only';
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Level Candidate', '0700000001', 'female', 'social', ?, 'visited', ?, 'Placement Program', ?, 'not_started')`)
      .run(id2, 'V-9989', today(), BRANCH, levelVersion);
    const start = await supertest(app).post(`/api/placement/visitors/${id2}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${id2}/placement/attempts/${attemptId}/components/level`).set(authHeader(owner)).send({ selectedLevelId: levelOnlyLevel, resultText: 'Level confirmed after interview.' });
    const complete = await supertest(app).post(`/api/placement/visitors/${id2}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(200);
    expect(complete.body.attempt.recommended_level_id).toBe(levelOnlyLevel);
  });
});


describe('Placement integrity hardening', () => {
  let integrityApp: express.Express;
  let integrityOwner: TokenPayload;

  beforeAll(() => {
    integrityApp = createApp();
    integrityOwner = { userId: USER, username: 'placement-owner', role: 'owner', branchId: BRANCH, fullName: 'Placement Owner' };
  });

  it('rejects incomplete skill scoring instead of silently recording zeros', async () => {
    const id2 = 'placement_missing_skill';
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, program_version_id, placement_status) VALUES (?, ?, 'Missing Skill Candidate', '0700000011', 'male', 'social', ?, 'visited', ?, ?, 'not_started')`).run(id2, 'V-MISSING-1', new Date().toISOString().slice(0,10), BRANCH, VERSION);
    const start = await supertest(integrityApp).post(`/api/placement/visitors/${id2}/placement/attempts`).set(authHeader(integrityOwner)).send({});
    const attemptId = start.body.id;
    const res = await supertest(integrityApp).put(`/api/placement/visitors/${id2}/placement/attempts/${attemptId}/components/skills`).set(authHeader(integrityOwner)).send({ skills: { grammar: 20 } });
    expect(res.status).toBe(400);
  });
});
