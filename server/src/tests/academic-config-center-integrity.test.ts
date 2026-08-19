/**
 * Academic Configuration Center + Placement Policy — integrity regressions.
 * ============================================================================
 * Locks closed the defects found while auditing the Academic Setup screen and
 * the placement policy engine that screen configures. Every academic-term test
 * drives the real HTTP route (auth middleware, validation, persistence) and
 * then asserts the DATABASE row, because the whole class of bug being fixed
 * here was "the API answered 200 while silently destroying stored data".
 *
 * Covered invariants:
 *   1. Term dates survive ordinary edits (the empty-string overwrite bug).
 *   2. Term date ranges are validated server-side.
 *   3. Placement policy resolution is deterministic and never fails open.
 *   4. A missing policy is distinguishable from an explicit waiver, and the
 *      enrollment gate refuses to admit a student on a configuration fault.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import academicRouter from '../routes/academic.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  resolvePlacementRequirement,
  isAuthoritativeDecision,
} from '../core/placement/policy-engine.js';
import { assertPlacementEligibleForClass } from '../core/placement/enrollment-gate.js';

const BRANCH_MAIN = 'acc_branch_main';
const BRANCH_OTHER = 'acc_branch_other';
const BRANCH_UNRELATED = 'acc_branch_unrelated';
const PROGRAM = 'acc_program';
const VERSION = 'acc_version';
const LEVEL_FIRST = 'acc_level_first';
const LEVEL_SECOND = 'acc_level_second';
const MANAGER = 'acc_manager';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  return app;
}

function tokenFor(userId: string, role: string, branchId: string) {
  return signToken({
    userId,
    username: userId,
    role,
    branchId,
    fullName: userId,
    sessionVersion: 1,
  } as unknown as TokenPayload);
}

/** Replace the placement profile for a (version, branch) pair. */
function setProfile(branchId: string | null, mode: string, firstLevelExempt = 0) {
  db.prepare(
    `DELETE FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id IS ?`
  ).run(VERSION, branchId);
  db.prepare(
    `INSERT INTO placement_assessment_profiles
       (id, program_version_id, branch_id, enabled, required, requirement_mode, first_level_exempt, version, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 1, datetime('now'))`
  ).run(
    `acc_pf_${branchId ?? 'global'}_${mode}`,
    VERSION,
    branchId,
    mode === 'required' ? 1 : 0,
    mode,
    firstLevelExempt
  );
}

function clearProfiles() {
  db.prepare('DELETE FROM placement_assessment_profiles WHERE program_version_id = ?').run(VERSION);
}

let app: express.Express;
let managerToken: string;

beforeAll(() => {
  initSchema();
  for (const b of [BRANCH_MAIN, BRANCH_OTHER, BRANCH_UNRELATED]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, b, 'loc');
  }
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, is_active, session_version, must_change_password)
     VALUES (?, ?, 'x', 'Manager', 'manager', ?, 1, 1, 0)`
  ).run(MANAGER, MANAGER, BRANCH_MAIN);
  bootstrapRbacCatalog(db);
  syncLegacyUserRoles(db);

  db.prepare('INSERT OR IGNORE INTO programs (id, name, branch_id) VALUES (?, ?, ?)').run(
    PROGRAM, 'Acc Program', BRANCH_MAIN
  );
  db.prepare(
    `INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status)
     VALUES (?, ?, 'v1', 1, 'published')`
  ).run(VERSION, PROGRAM);
  db.prepare(
    `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, "order", is_active)
     VALUES (?, ?, ?, 'First', 1, 1)`
  ).run(LEVEL_FIRST, PROGRAM, VERSION);
  db.prepare(
    `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, "order", is_active)
     VALUES (?, ?, ?, 'Second', 2, 1)`
  ).run(LEVEL_SECOND, PROGRAM, VERSION);

  app = createApp();
  managerToken = tokenFor(MANAGER, 'manager', BRANCH_MAIN);
});

describe('Academic terms — date lifecycle', () => {
  async function createTerm(code: string, body: Record<string, unknown> = {}) {
    return supertest(app)
      .post('/api/academic/terms')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ year: 2026, code, name: `Term ${code}`, startDate: '2026-03-21', endDate: '2026-06-21', ...body });
  }

  it('persists both start and end dates supplied by the UI', async () => {
    const res = await createTerm('T_BOTH');
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT start_date, end_date FROM academic_terms WHERE id = ?').get(res.body.id) as any;
    expect(row.start_date).toBe('2026-03-21');
    expect(row.end_date).toBe('2026-06-21');
  });

  it('rejects an end date earlier than the start date', async () => {
    const res = await createTerm('T_REV', { startDate: '2026-06-21', endDate: '2026-03-21' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/earlier than/i);
  });

  it('rejects a date that is not a real calendar day', async () => {
    const res = await createTerm('T_BAD', { startDate: '2026-02-30', endDate: null });
    expect(res.status).toBe(400);
  });

  it('accepts a single-day term (session generation treats the range as inclusive)', async () => {
    const res = await createTerm('T_ONE', { startDate: '2026-05-01', endDate: '2026-05-01' });
    expect(res.status).toBe(201);
  });

  // The core regression. The edit form sends its whole state object, and its
  // date inputs hold '' when they were never hydrated. Before the fix, '' beat
  // the stored value and editing a NAME erased the term's calendar.
  it.each([
    ['name', { name: 'Renamed' }],
    ['code', { code: 'RECODED' }],
    ['year', { year: 2027 }],
  ])('editing %s does not erase the stored dates even when the form sends empty date strings', async (_field, patch) => {
    const created = await createTerm(`T_KEEP_${_field}`);
    expect(created.status).toBe(201);
    const termId = created.body.id;

    const res = await supertest(app)
      .put(`/api/academic/terms/${termId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ...patch, startDate: '', endDate: '' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT start_date, end_date FROM academic_terms WHERE id = ?').get(termId) as any;
    expect(row.start_date).toBe('2026-03-21');
    expect(row.end_date).toBe('2026-06-21');
  });

  it('omitting the date fields entirely leaves them unchanged', async () => {
    const created = await createTerm('T_OMIT');
    const termId = created.body.id;
    const res = await supertest(app)
      .put(`/api/academic/terms/${termId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Only the name' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT start_date, end_date FROM academic_terms WHERE id = ?').get(termId) as any;
    expect(row.start_date).toBe('2026-03-21');
    expect(row.end_date).toBe('2026-06-21');
  });

  it('an explicit date change is still applied', async () => {
    const created = await createTerm('T_CHANGE');
    const termId = created.body.id;
    const res = await supertest(app)
      .put(`/api/academic/terms/${termId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ endDate: '2026-07-15' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT start_date, end_date FROM academic_terms WHERE id = ?').get(termId) as any;
    expect(row.start_date).toBe('2026-03-21');
    expect(row.end_date).toBe('2026-07-15');
  });

  it('an edit cannot install a reversed range', async () => {
    const created = await createTerm('T_EDITREV');
    const res = await supertest(app)
      .put(`/api/academic/terms/${created.body.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ endDate: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('term identity (branch, year, code) is unique', async () => {
    const first = await createTerm('T_UNIQUE');
    expect(first.status).toBe(201);
    const second = await createTerm('T_UNIQUE');
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});

// Second-order finding from the same audit: the cross-branch guard for session
// generation read `term.branch_id`, but the statement feeding it selected only
// the two date columns, so the check was structurally dead.
describe('Session generation — academic term branch guard is live', () => {
  it('the term lookup selects branch_id so the cross-branch check can fire', () => {
    const row = db
      .prepare('SELECT branch_id, start_date, end_date FROM academic_terms WHERE branch_id = ? LIMIT 1')
      .get(BRANCH_MAIN) as any;
    expect(row).toBeTruthy();
    expect(row.branch_id).toBe(BRANCH_MAIN);
    const src = readFileSync(
      new URL('../routes/sessions.routes.ts', import.meta.url),
      'utf8'
    );
    const stmt = src.match(/const stmtGetAcademicTerm = db\.prepare\('([^']+)'\)/);
    expect(stmt).toBeTruthy();
    // The guard compares term.branch_id; the query must therefore provide it.
    expect(stmt![1]).toMatch(/branch_id/);
    expect(src).toMatch(/term\.branch_id !== cls\.branch_id/);
  });
});

describe('Placement policy — deterministic resolution', () => {
  it('an explicit "required" policy on the candidate branch is honoured', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'required');
    const r = resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_SECOND);
    expect(r.mode).toBe('required');
    expect(r.decision).toBe('REQUIRED');
    expect(r.policySource).toBe('branch');
  });

  it('an explicit "not_required" policy is an authoritative waiver', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'not_required');
    const r = resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_SECOND);
    expect(r.decision).toBe('NOT_REQUIRED');
    expect(isAuthoritativeDecision(r)).toBe(true);
  });

  // The fail-open bug: the profile writer always stores the program's OWNING
  // branch, so a candidate attached to any other branch missed the lookup and
  // the required policy silently evaporated.
  it('a policy stored against the program-owning branch still applies to a candidate from another branch', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'required');
    const r = resolvePlacementRequirement(VERSION, BRANCH_OTHER, LEVEL_SECOND);
    expect(r.mode).toBe('required');
    expect(r.decision).toBe('REQUIRED');
    expect(r.policySource).toBe('program_branch');
  });

  it('a branch-specific policy overrides a global one', () => {
    clearProfiles();
    setProfile(null, 'not_required');
    setProfile(BRANCH_MAIN, 'required');
    const r = resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_SECOND);
    expect(r.decision).toBe('REQUIRED');
    expect(r.policySource).toBe('branch');
  });

  it('a global policy applies when no more specific one exists', () => {
    clearProfiles();
    setProfile(null, 'required');
    const r = resolvePlacementRequirement(VERSION, BRANCH_OTHER, LEVEL_SECOND);
    expect(r.decision).toBe('REQUIRED');
    expect(r.policySource).toBe('global');
  });

  // A program version that was never given a placement profile is a normal
  // configuration: most programs do not assess. That must stay enrollable.
  it('a program version with no placement profile anywhere is an ordinary NOT_REQUIRED', () => {
    clearProfiles();
    const r = resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_SECOND);
    expect(r.decision).toBe('NOT_REQUIRED');
    expect(r.reason).toBe('no_policy_configured');
    expect(isAuthoritativeDecision(r)).toBe(true);
  });

  // The dangerous case: placement WAS configured for this version, but nothing
  // resolved for this candidate. The administrator believes a policy is in
  // force, so this must never be silently downgraded to "not required".
  it('a configured policy that does not resolve for the candidate is a CONFIGURATION_ERROR', () => {
    clearProfiles();
    // A profile exists for an unrelated branch only.
    db.prepare(
      `INSERT INTO placement_assessment_profiles
         (id, program_version_id, branch_id, enabled, required, requirement_mode, first_level_exempt, version, updated_at)
       VALUES ('acc_pf_unrelated', ?, ?, 1, 1, 'required', 0, 1, datetime('now'))`
    ).run(VERSION, BRANCH_UNRELATED);
    const r = resolvePlacementRequirement(VERSION, BRANCH_OTHER, LEVEL_SECOND);
    expect(r.decision).toBe('CONFIGURATION_ERROR');
    expect(r.reason).toBe('policy_not_applicable_to_branch');
    expect(isAuthoritativeDecision(r)).toBe(false);
  });

  it('a structurally invalid context is INVALID_CONTEXT', () => {
    expect(resolvePlacementRequirement(null, BRANCH_MAIN, null).decision).toBe('INVALID_CONTEXT');
    expect(resolvePlacementRequirement('acc_missing_version', BRANCH_MAIN, null).decision).toBe('INVALID_CONTEXT');
  });

  // INVALID_CONTEXT stays authoritative on purpose: with no program version
  // there is no policy to bypass, and ad-hoc classes must remain enrollable.
  // CONFIGURATION_ERROR must NOT be, because a real policy failed to resolve.
  it('only CONFIGURATION_ERROR is treated as non-authoritative', () => {
    expect(isAuthoritativeDecision(resolvePlacementRequirement(null, BRANCH_MAIN, null))).toBe(true);
    clearProfiles();
    db.prepare(
      `INSERT INTO placement_assessment_profiles
         (id, program_version_id, branch_id, enabled, required, requirement_mode, first_level_exempt, version, updated_at)
       VALUES ('acc_pf_auth_check', ?, ?, 1, 1, 'required', 0, 1, datetime('now'))`
    ).run(VERSION, BRANCH_UNRELATED);
    expect(isAuthoritativeDecision(resolvePlacementRequirement(VERSION, BRANCH_OTHER, LEVEL_SECOND))).toBe(false);
  });

  it('a first-level exemption is EXEMPT, semantically distinct from an explicit waiver', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'required', 1);
    const exempt = resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_FIRST);
    expect(exempt.decision).toBe('EXEMPT');
    expect(exempt.firstLevelExemptApplied).toBe(true);
    // ...and it must not leak to later levels.
    expect(resolvePlacementRequirement(VERSION, BRANCH_MAIN, LEVEL_SECOND).decision).toBe('REQUIRED');
  });
});

describe('Placement policy — enrollment gate fails closed', () => {
  const STUDENT = 'acc_student';
  const CLASS_OTHER = 'acc_class_other';

  beforeAll(() => {
    db.prepare(
      `INSERT OR IGNORE INTO classes (id, name, level_id, level, branch_id, status)
       VALUES (?, 'Other branch class', ?, 'First', ?, 'active')`
    ).run(CLASS_OTHER, LEVEL_SECOND, BRANCH_OTHER);
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, registration_date, branch_id, gender, status)
       VALUES (?, 'ACC-1', 'Acc Student', '2026-01-01', ?, 'male', 'active')`
    ).run(STUDENT, BRANCH_OTHER);
  });

  it('admits enrollment when placement was never configured for the program at all', () => {
    clearProfiles();
    expect(() => assertPlacementEligibleForClass(db, STUDENT, CLASS_OTHER, BRANCH_OTHER)).not.toThrow();
  });

  it('refuses enrollment when a configured policy fails to resolve, rather than admitting silently', () => {
    clearProfiles();
    db.prepare(
      `INSERT INTO placement_assessment_profiles
         (id, program_version_id, branch_id, enabled, required, requirement_mode, first_level_exempt, version, updated_at)
       VALUES ('acc_pf_gate_unrelated', ?, ?, 1, 1, 'required', 0, 1, datetime('now'))`
    ).run(VERSION, BRANCH_UNRELATED);
    expect(() => assertPlacementEligibleForClass(db, STUDENT, CLASS_OTHER, BRANCH_OTHER)).toThrow(
      /not configured/i
    );
  });

  it('still enforces a required policy reached through the program-owning branch', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'required');
    expect(() => assertPlacementEligibleForClass(db, STUDENT, CLASS_OTHER, BRANCH_OTHER)).toThrow(
      /placement assessment/i
    );
  });

  it('allows enrollment when the policy is an explicit waiver', () => {
    clearProfiles();
    setProfile(BRANCH_MAIN, 'not_required');
    expect(() => assertPlacementEligibleForClass(db, STUDENT, CLASS_OTHER, BRANCH_OTHER)).not.toThrow();
  });
});
