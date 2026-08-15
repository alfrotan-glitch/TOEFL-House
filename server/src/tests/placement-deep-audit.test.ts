/**
 * Placement Exam — deep evidence audit.
 * ============================================================================
 * Verifies the ACTUAL placement lifecycle against the running implementation:
 * fee booking traceability, double-booking, level-rule boundaries (gaps),
 * attempt isolation (IDOR), cross-branch, duplicate submission, completed
 * immutability, score boundaries, retake policy, concurrency, reporting
 * integration, conversion gate and permission matrix.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import visitorsRouter from '../routes/visitors.routes.js';
import placementRouter from '../routes/placement.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';

const BRANCH_A = 'pda_branch_a';
const BRANCH_B = 'pda_branch_b';
const PROGRAM = 'pda_program';
const VERSION = 'pda_version';
const LEVEL_A = 'pda_level_a1';
const LEVEL_B = 'pda_level_b1';
const USER = 'pda_owner';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(user: TokenPayload) { return { Authorization: `Bearer ${signToken(user)}` }; }

function seedVisitor(visitorId: string, name: string, branch: string, version: string, gender = 'male') {
  db.prepare(`INSERT OR IGNORE INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status)
    VALUES (?, ?, ?, ?, ?, 'social', ?, 'visited', ?, 'Placement Program', ?, 'not_started')`)
    .run(visitorId, `V-${visitorId.slice(-4)}`, name, `0700${visitorId.slice(-6)}`, gender, today(), branch, version);
}

describe('Placement Exam deep audit', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let registrar: TokenPayload;
  let finance: TokenPayload;
  let teacher: TokenPayload;
  let studentTok: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'PDA Branch A', 'A');
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'PDA Branch B', 'B');
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, 'PDA Program', 12, ?, 1)`).run(PROGRAM, BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1', 1, ?, 'A1', 1)`).run(LEVEL_A, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 2, ?, 'B1', 1)`).run(LEVEL_B, PROGRAM, VERSION);
    db.prepare(`INSERT OR REPLACE INTO placement_assessment_profiles (id, program_version_id, branch_id, enabled, required, method, components_json, scoring_model, allow_retake, max_score, pass_score, instructions)
      VALUES (?, ?, ?, 1, 1, 'hybrid', ?, 'weighted_average', 0, 100, 60, 'Required')`)
      .run(id('pap'), VERSION, BRANCH_A, JSON.stringify([
        { key: 'skills', type: 'skill_scores', label: 'Skills', required: true, weight: 60, maxScore: 100, skills: ['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking'] },
        { key: 'written', type: 'written_test', label: 'Written', required: true, weight: 20, maxScore: 100 },
        { key: 'interview', type: 'interview', label: 'Interview', required: true, weight: 20, maxScore: 100 },
      ]));
    // Branch B program + version + profile: cross-branch isolation test needs a
    // visitor whose program legitimately belongs to branch B.
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES ('pda_program_b', 'PDA Program B', 12, ?, 1)`).run(BRANCH_B);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES ('pda_version_b', 'pda_program_b', 'v1', 1, 'published', 0)`).run();
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES ('pda_level_b_b1', 'pda_program_b', 'B1', 1, 'pda_version_b', 'B1', 1)`).run();
    db.prepare(`INSERT OR REPLACE INTO placement_assessment_profiles (id, program_version_id, branch_id, enabled, required, method, components_json, scoring_model, allow_retake, max_score, pass_score, instructions)
      VALUES (?, 'pda_version_b', ?, 1, 1, 'hybrid', ?, 'weighted_average', 0, 100, 60, 'Branch B')`)
      .run(id('pap_b'), BRANCH_B, JSON.stringify([
        { key: 'skills', type: 'skill_scores', label: 'Skills', required: true, weight: 100, maxScore: 100, skills: ['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking'] },
      ]));
    // Level rules: A1 0–49, B1 51–100 → score 50 falls in the GAP.
    db.prepare(`INSERT OR IGNORE INTO placement_rules (id, program_version_id, name, min_score, max_score, recommended_level_id, recommended_level_code, branch_id, sort_order, is_active)
      VALUES (?, ?, 'A1 range', 0, 49, ?, 'A1', ?, 1, 1)`).run(id('rule_a'), VERSION, LEVEL_A, BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO placement_rules (id, program_version_id, name, min_score, max_score, recommended_level_id, recommended_level_code, branch_id, sort_order, is_active)
      VALUES (?, ?, 'B1 range', 51, 100, ?, 'B1', ?, 2, 1)`).run(id('rule_b'), VERSION, LEVEL_B, BRANCH_A);

    // Fee: branch academic profile drives placementTestFee (default 300).
    db.prepare(`INSERT OR IGNORE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, 300)`).run(BRANCH_A);

    for (const [uid, uname, role] of [[USER, 'pda_owner', 'owner'], ['pda_reg', 'pda_reg', 'registrar'], ['pda_fin', 'pda_fin', 'finance'], ['pda_tea', 'pda_tea', 'teacher']] as const) {
      await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(uid, uname, 'PDA ' + role, role, BRANCH_A, await hashPassword('x'));
    }
    syncLegacyUserRoles(db);
    owner = { userId: USER, username: 'pda_owner', role: 'owner', branchId: BRANCH_A, fullName: 'PDA Owner' };
    registrar = { userId: 'pda_reg', username: 'pda_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'PDA Registrar' };
    finance = { userId: 'pda_fin', username: 'pda_fin', role: 'finance', branchId: BRANCH_A, fullName: 'PDA Finance' };
    teacher = { userId: 'pda_tea', username: 'pda_tea', role: 'teacher', branchId: BRANCH_A, fullName: 'PDA Teacher' };
    await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES ('pda_stu', 'pda_stu', 'PDA Student', 'student', ?, ?, 1, 0)`).run(BRANCH_A, await hashPassword('x'));
    const stuRole = db.prepare("SELECT id FROM roles WHERE code='student'").get() as { id: string };
    db.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by) VALUES (?, 'pda_stu', ?, 'branch', ?, 1, 'system')`).run(id('ur'), stuRole.id, BRANCH_A);
    syncLegacyUserRoles(db);
    studentTok = { userId: 'pda_stu', username: 'pda_stu', role: 'student', branchId: BRANCH_A, fullName: 'PDA Student' };

    app = createApp();
  });

  function completeAttempt(visitorId: string, attemptId: string, tok: TokenPayload) {
    return (async () => {
      const skills = { grammar: 20, vocabulary: 20, reading: 20, listening: 20, writing: 20, speaking: 20 }; // 80/100 → 80%
      await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/skills`).set(authHeader(tok)).send({ skills });
      await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/written`).set(authHeader(tok)).send({ score: 80 });
      await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/interview`).set(authHeader(tok)).send({ score: 80 });
      return supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(tok)).send({});
    })();
  }

  it('permission matrix: registrar can start+score+complete; finance and teacher cannot', async () => {
    seedVisitor('pda_v_perm', 'Perm Candidate', BRANCH_A, VERSION);
    const deniedFinance = await supertest(app).post('/api/placement/visitors/pda_v_perm/placement/attempts').set(authHeader(finance)).send({});
    expect(deniedFinance.status).toBe(403);
    const deniedTeacher = await supertest(app).post('/api/placement/visitors/pda_v_perm/placement/attempts').set(authHeader(teacher)).send({});
    expect(deniedTeacher.status).toBe(403);
    const deniedStudent = await supertest(app).get('/api/placement/visitors/pda_v_perm/placement').set(authHeader(studentTok));
    expect(deniedStudent.status).toBe(403);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_perm/placement/attempts').set(authHeader(registrar)).send({});
    expect(start.status).toBe(201);
    // Registrar (Reception) can score components.
    const put = await supertest(app).put(`/api/placement/visitors/pda_v_perm/placement/attempts/${start.body.id}/components/written`).set(authHeader(registrar)).send({ score: 75 });
    expect(put.status).toBe(200);
  });

  it('fee is booked at completion WITHOUT a payment row or receipt (financial traceability gap)', async () => {
    seedVisitor('pda_v_fee', 'Fee Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_fee/placement/attempts').set(authHeader(owner)).send({});
    const complete = await completeAttempt('pda_v_fee', start.body.id, owner);
    expect(complete.status).toBe(200);
    expect(complete.body.feeCharged).toBe(300);
    const tx = db.prepare(`SELECT category, amount, payment_id, reference_id FROM financial_transactions
      WHERE category='placement' AND reference_id = ? ORDER BY rowid DESC LIMIT 1`).get(start.body.id) as any;
    expect(tx).toBeTruthy();
    // FIXED: the fee is now payment-backed (payment_id set) with a receipt row.
    expect(tx.payment_id).not.toBeNull();
    const payRow = db.prepare('SELECT id, receipt_number, amount, idempotency_key FROM payments WHERE id = ?').get(tx.payment_id) as any;
    expect(payRow).toBeTruthy();
    expect(payRow.receipt_number).toMatch(/^R-/);
    expect(payRow.amount).toBe(300);
    expect(payRow.idempotency_key).toBe(`placement:${start.body.id}`);
    console.log(`[EVIDENCE] placement fee now payment-backed: receipt=${payRow.receipt_number} idem=${payRow.idempotency_key}`);
  });

  it('double-booking FIXED: converted student paying category placement is rejected (409) — no duplicate income', async () => {
    const before = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='placement'`).get() as { s: number }).s;
    seedVisitor('pda_v_conv', 'Convert Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_conv/placement/attempts').set(authHeader(owner)).send({});
    await completeAttempt('pda_v_conv', start.body.id, owner);
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id, placement_score)
      VALUES ('pda_stu_conv', 'TH-PDA-1', 'Convert Candidate', 'active', ?, ?, 'male', 'pda_v_conv', '{}')`).run(today(), BRANCH_A);
    const semId = id('sem');
    db.prepare(`INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, 'pda_stu_conv', 'S1', ?, 0, 0, 'active')`).run(semId, today());
    const pay = await supertest(app).post('/api/students/pda_stu_conv/payments').set(authHeader(owner)).send({ amount: 300, category: 'placement' });
    expect(pay.status).toBe(409);
    const after = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='placement'`).get() as { s: number }).s;
    expect(after).toBe(before + 300); // only the auto-booked completion fee
  });

  it('level-rule gap: score 50 (between 49 and 51) yields NO recommendation', async () => {
    seedVisitor('pda_v_gap', 'Gap Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_gap/placement/attempts').set(authHeader(owner)).send({});
    const id = start.body.id;
    await supertest(app).put(`/api/placement/visitors/pda_v_gap/placement/attempts/${id}/components/skills`).set(authHeader(owner)).send({
      skills: { grammar: 12, vocabulary: 13, reading: 12, listening: 13, writing: 12, speaking: 13 }, // 75/150 → 50%
    });
    await supertest(app).put(`/api/placement/visitors/pda_v_gap/placement/attempts/${id}/components/written`).set(authHeader(owner)).send({ score: 50 });
    await supertest(app).put(`/api/placement/visitors/pda_v_gap/placement/attempts/${id}/components/interview`).set(authHeader(owner)).send({ score: 50 });
    const complete = await supertest(app).post(`/api/placement/visitors/pda_v_gap/placement/attempts/${id}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(200);
    console.log(`[EVIDENCE] gap score=50 → percentage=${complete.body.attempt.percentage} recommended_level_id=${complete.body.attempt.recommended_level_id}`);
    expect(complete.body.attempt.recommended_level_id).toBeNull();
  });

  it('attempt isolation: another visitor/exam ID cannot be substituted; completed attempts immutable', async () => {
    seedVisitor('pda_v_a', 'Candidate A', BRANCH_A, VERSION);
    seedVisitor('pda_v_b', 'Candidate B', BRANCH_A, VERSION);
    const a = await supertest(app).post('/api/placement/visitors/pda_v_a/placement/attempts').set(authHeader(owner)).send({});
    await completeAttempt('pda_v_a', a.body.id, owner);
    // B tries to write into A's completed attempt → 404 or 409 (never 200).
    const tamper = await supertest(app).put(`/api/placement/visitors/pda_v_b/placement/attempts/${a.body.id}/components/written`).set(authHeader(owner)).send({ score: 99 });
    expect([404, 409]).toContain(tamper.status);
    // A's own completed attempt is immutable.
    const reedit = await supertest(app).put(`/api/placement/visitors/pda_v_a/placement/attempts/${a.body.id}/components/written`).set(authHeader(owner)).send({ score: 99 });
    expect(reedit.status).toBe(409);
    // Duplicate submit → 409.
    const resubmit = await supertest(app).post(`/api/placement/visitors/pda_v_a/placement/attempts/${a.body.id}/complete`).set(authHeader(owner)).send({});
    expect(resubmit.status).toBe(409);
  });

  it('cross-branch: a branch-A registrar cannot start/read a branch-B candidate; owner (org-scoped) can', async () => {
    seedVisitor('pda_v_branchb', 'Branch B Candidate', BRANCH_B, 'pda_version_b');
    // Branch-A registrar must be denied branch-B candidate data.
    const denied = await supertest(app).post('/api/placement/visitors/pda_v_branchb/placement/attempts').set(authHeader(registrar)).send({});
    expect(denied.status).toBe(403);
    const readDenied = await supertest(app).get('/api/placement/visitors/pda_v_branchb/placement').set(authHeader(registrar));
    expect(readDenied.status).toBe(403);
    // Owner is organization-scoped and legitimately reaches the branch-B candidate.
    const ownerOk = await supertest(app).get('/api/placement/visitors/pda_v_branchb/placement').set(authHeader(owner));
    expect(ownerOk.status).toBe(200);
    expect(ownerOk.body.profile.programName).toBe('PDA Program B');
  });

  it('score boundary: score above max rejected; negative rejected', async () => {
    seedVisitor('pda_v_bound', 'Boundary Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_bound/placement/attempts').set(authHeader(owner)).send({});
    const tooHigh = await supertest(app).put(`/api/placement/visitors/pda_v_bound/placement/attempts/${start.body.id}/components/written`).set(authHeader(owner)).send({ score: 101 });
    expect(tooHigh.status).toBe(400);
    const negative = await supertest(app).put(`/api/placement/visitors/pda_v_bound/placement/attempts/${start.body.id}/components/written`).set(authHeader(owner)).send({ score: -1 });
    expect(negative.status).toBe(400);
  });

  it('retake: allow_retake=0 blocks a second attempt; the first stays immutable', async () => {
    seedVisitor('pda_v_retake', 'Retake Candidate', BRANCH_A, VERSION);
    const first = await supertest(app).post('/api/placement/visitors/pda_v_retake/placement/attempts').set(authHeader(owner)).send({});
    await completeAttempt('pda_v_retake', first.body.id, owner);
    const second = await supertest(app).post('/api/placement/visitors/pda_v_retake/placement/attempts').set(authHeader(owner)).send({});
    expect(second.status).toBe(409); // allow_retake=0
  });

  it('reporting: placement income appears by category; completed count present; no avg-score/level metrics', async () => {
    const rep = await supertest(app).get('/api/reports/overview?period=month').set(authHeader(owner));
    expect(rep.status).toBe(200);
    const cats = rep.body.financial.income.byCategory.map((c: { category: string }) => c.category);
    expect(cats).toContain('placement');
    expect(rep.body.operational.placementCompleted).toBeDefined();
    console.log('[EVIDENCE] report placement income categories:', cats.filter((c: string) => c === 'placement'));
    // FIXED: placement metrics are now present and derived from authoritative data.
    expect(rep.body.operational.placement).toBeDefined();
    expect(typeof rep.body.operational.placement.attempts).toBe('number');
    expect(typeof rep.body.operational.placement.avgScore).toBe('number');
    expect(Array.isArray(rep.body.operational.placement.levelDistribution)).toBe(true);
    console.log(`[EVIDENCE] report placement block:`, JSON.stringify(rep.body.operational.placement));
  });

  it('duplicate completion cannot double-book the fee (status-guarded update)', async () => {
    seedVisitor('pda_v_double', 'Double Submit Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_double/placement/attempts').set(authHeader(owner)).send({});
    await completeAttempt('pda_v_double', start.body.id, owner);
    const incomeBefore = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='placement' AND reference_id=?`).get(start.body.id) as { s: number }).s;
    expect(incomeBefore).toBe(300);
    // Duplicate completion is rejected and books nothing more.
    const dup = await supertest(app).post(`/api/placement/visitors/pda_v_double/placement/attempts/${start.body.id}/complete`).set(authHeader(owner)).send({});
    expect(dup.status).toBe(409);
    const incomeAfter = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='placement' AND reference_id=?`).get(start.body.id) as { s: number }).s;
    expect(incomeAfter).toBe(300);
    const payments = (db.prepare(`SELECT COUNT(*) c FROM payments WHERE idempotency_key=?`).get(`placement:${start.body.id}`) as { c: number }).c;
    expect(payments).toBe(1);
  });

  it('conversion gate: a required-but-incomplete placement blocks conversion', async () => {
    seedVisitor('pda_v_gate', 'Gate Candidate', BRANCH_A, VERSION);
    const start = await supertest(app).post('/api/placement/visitors/pda_v_gate/placement/attempts').set(authHeader(owner)).send({});
    // Add a class to convert into.
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee, program_id) VALUES ('pda_class', 'PDA Class', ?, 10, 'active', 'A1', 5000, ?)`).run(BRANCH_A, PROGRAM);
    const conv = await supertest(app).post('/api/visitors/pda_v_gate/convert').set(authHeader(owner)).send({
      classId: 'pda_class', amountPaid: 0, branchId: BRANCH_A, programVersionId: VERSION,
    });
    console.log(`[EVIDENCE] convert with incomplete placement (attempt ${start.body.id} in_progress) → ${conv.status} ${conv.body.error || ''}`);
    expect(conv.status).toBe(400);
  });
});
