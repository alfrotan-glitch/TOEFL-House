/**
 * Visitor UX remediation — regression suite for UX-1 … UX-5.
 * ============================================================================
 * Each defect below was REPRODUCED against a live server during the visitor UX
 * audit (docs/VISITOR_UX_AUDIT_2026-08-17.md). These tests encode the corrected
 * behaviour and are written so that reverting the fix makes them fail.
 *
 * The frontend stays a thin rendering layer (pass-24 rule D-7), so the tests
 * live where the authority now lives: the server. What the UI must not do —
 * count a page, filter locally, present a form that cannot succeed — is
 * expressed here as "the server hands the UI a correct answer directly".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { visitorsRouter } from '../routes/visitors.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH_A = 'vux_a';
const BRANCH_B = 'vux_b';

let owner: TokenPayload;
let registrarA: TokenPayload;
let counselorA: TokenPayload;
let registrarB: TokenPayload;
let teacherA: TokenPayload;
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

/** Create a visitor through the real route, so server-side defaults apply. */
const createVisitor = (as: TokenPayload, body: Record<string, unknown> = {}) =>
  supertest(app).post('/api/visitors').set(authHeader(as)).send({
    fullName: 'UX Subject', gender: 'male', source: 'walk_in', ...body,
  });

/** Deterministic dates so "overdue" is unambiguous. */
const PAST = '2020-01-01';
const FUTURE = '2099-01-01';

function seedPrograms() {
  db.prepare(`INSERT OR IGNORE INTO programs (id,name,branch_id) VALUES ('vux_prog','UX Program',?)`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id,program_id,version_label,version_number,status,is_default)
              VALUES ('vux_pv','vux_prog','v1',1,'published',1)`).run();
  db.prepare(`INSERT OR IGNORE INTO levels (id,program_id,name,"order",program_version_id)
              VALUES ('vux_lvl','vux_prog','Level 1',1,'vux_pv')`).run();
  // Class governed by a placement-REQUIRED program version.
  db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,capacity,fee,program_id,level_id,gender_policy)
              VALUES ('vux_cls','UX Class','Level 1',?, 'active',50,6000,'vux_prog','vux_lvl','mixed')`).run(BRANCH_A);
  // Class with no level → governed by no placement policy.
  db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,capacity,fee,gender_policy)
              VALUES ('vux_open','UX Open Class','Open',?, 'active',50,6000,'mixed')`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO placement_assessment_profiles
      (id, program_version_id, branch_id, enabled, required, method, sections_json, components_json,
       scoring_model, allow_retake, max_score, pass_score, requirement_mode, first_level_exempt, max_attempts)
      VALUES ('vux_pap','vux_pv',?,1,1,'written_test','[]',?, 'weighted_average',1,100,50,'required',0,2)`)
    .run(BRANCH_A, JSON.stringify([{ key: 'writing', type: 'written_test', label: 'Writing', weight: 100, maxScore: 100, enabled: true, required: true, order: 0 }]));
}

/**
 * Insert visitors directly so the population is exact and independent of the
 * create route's defaults.
 */
function seedVisitors(spec: Array<{
  id: string; name: string; phone: string; branch: string; status?: string;
  stage?: string | null; source?: string; interest?: string | null;
  nextContact?: string | null; placement?: string; notes?: string;
}>) {
  const ins = db.prepare(`INSERT OR REPLACE INTO visitors
    (id, serial_no, full_name, phone, gender, source, status, stage, branch_id, visit_date,
     follow_up_status, next_contact_date, placement_status, notes)
    VALUES (?,?,?,?,'male',?,?,?,?,?,?,?,?,?)`);
  for (const v of spec) {
    ins.run(
      v.id, `S-${v.id}`, v.name, v.phone, v.source ?? 'walk_in', v.status ?? 'visited',
      v.stage === undefined ? 'lead' : v.stage, v.branch, '2026-01-01',
      v.interest ?? null, v.nextContact ?? null, v.placement ?? 'not_started', v.notes ?? null
    );
  }
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'UX A', 'T')`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'UX B', 'T')`).run(BRANCH_B);
  seedPrograms();

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insU = db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
                           VALUES (?,?,?,?,?,?,0)`);
  insU.run('vux_own', 'vux_own', pwd, 'Owner', 'owner', BRANCH_A);
  insU.run('vux_reg', 'vux_reg', pwd, 'Registrar A', 'registrar', BRANCH_A);
  insU.run('vux_cou', 'vux_cou', pwd, 'Counselor A', 'counselor', BRANCH_A);
  insU.run('vux_regb', 'vux_regb', pwd, 'Registrar B', 'registrar', BRANCH_B);
  insU.run('vux_tea', 'vux_tea', pwd, 'Teacher A', 'teacher', BRANCH_A);
  syncLegacyUserRoles(db);

  owner = { userId: 'vux_own', username: 'vux_own', role: 'owner', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;
  registrarA = { userId: 'vux_reg', username: 'vux_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'Registrar A' } as TokenPayload;
  counselorA = { userId: 'vux_cou', username: 'vux_cou', role: 'counselor', branchId: BRANCH_A, fullName: 'Counselor A' } as TokenPayload;
  registrarB = { userId: 'vux_regb', username: 'vux_regb', role: 'registrar', branchId: BRANCH_B, fullName: 'Registrar B' } as TokenPayload;
  teacherA = { userId: 'vux_tea', username: 'vux_tea', role: 'teacher', branchId: BRANCH_A, fullName: 'Teacher A' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare(`DELETE FROM students WHERE lead_id LIKE 'vux_%'`).run();
  db.prepare(`DELETE FROM visitors WHERE id LIKE 'vux_v%'`).run();
});

// ===========================================================================
// UX-1 — the 100-row truncation: totals, search, filtering and pagination
// ===========================================================================
describe('UX-1 — visitor totals are server-computed, never counted from a page', () => {
  /**
   * The audit's exact shape: a population far larger than one page, with a
   * conversion rate that differs sharply between "counted over the page" and
   * "counted over the population". 120 leads, 12 registered = 10%. A UI that
   * counted a 50-row page would report something else entirely.
   */
  beforeEach(() => {
    const spec = [];
    for (let i = 1; i <= 120; i++) {
      spec.push({
        id: `vux_v${i}`, name: `UX Lead ${i}`, phone: `07001${String(i).padStart(5, '0')}`,
        branch: BRANCH_A,
        status: i <= 12 ? 'registered' : 'visited',
        stage: i <= 12 ? 'enrollment' : 'lead',
        source: i % 2 === 0 ? 'walk_in' : 'referral',
      });
    }
    seedVisitors(spec);
  });

  it('reports the FULL population and a conversion rate over it, not over a page', async () => {
    const res = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(120);
    expect(res.body.registered).toBe(12);
    // 12/120 = 10%. Counting a 50-row page would give a different answer.
    expect(res.body.conversionRate).toBe(10);
  });

  it('a page never changes the reported totals', async () => {
    const page = await supertest(app).get('/api/visitors?limit=25&offset=0').set(authHeader(registrarA));
    expect(page.body).toHaveLength(25);
    // The row payload is a page, but the count headers describe the population.
    expect(page.headers['x-total-count']).toBe('120');
    expect(page.headers['x-unfiltered-count']).toBe('120');
  });

  it('finds a lead that falls outside the first page (the duplicate-creating bug)', async () => {
    // UX Lead 119 sorts well past a 25-row page. Client-side search over the
    // loaded page reported "No visitors match this search" for this person.
    const res = await supertest(app)
      .get('/api/visitors?search=UX%20Lead%20119&limit=25')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].fullName).toBe('UX Lead 119');
    expect(res.headers['x-total-count']).toBe('1');
    // …while still telling the UI how big the real population is.
    expect(res.headers['x-unfiltered-count']).toBe('120');
  });

  it('paginates the FILTERED set, so page 2 of a filter is page 2 of the matches', async () => {
    const q = 'source=walk_in';
    const p1 = await supertest(app).get(`/api/visitors?${q}&limit=25&offset=0`).set(authHeader(registrarA));
    const p2 = await supertest(app).get(`/api/visitors?${q}&limit=25&offset=25`).set(authHeader(registrarA));
    expect(p1.headers['x-total-count']).toBe('60'); // 60 of 120 are walk_in
    expect(p1.body).toHaveLength(25);
    expect(p2.body).toHaveLength(25);
    // Every row on both pages honours the filter…
    for (const v of [...p1.body, ...p2.body]) expect(v.source).toBe('walk_in');
    // …and the pages do not overlap (a stable ORDER BY with a tiebreak).
    const ids = new Set([...p1.body, ...p2.body].map((v: any) => v.id));
    expect(ids.size).toBe(50);
  });

  it('search matches name, phone and notes', async () => {
    seedVisitors([{ id: 'vux_vN', name: 'Notes Subject', phone: '0777000111', branch: BRANCH_A, notes: 'referred by Karim' }]);
    for (const q of ['Notes Subject', '0777000111', 'Karim']) {
      const res = await supertest(app).get(`/api/visitors?search=${encodeURIComponent(q)}`).set(authHeader(registrarA));
      expect(res.body.some((v: any) => v.id === 'vux_vN')).toBe(true);
    }
  });

  it('treats LIKE metacharacters in a search as literal text', async () => {
    seedVisitors([{ id: 'vux_vP', name: '100% Scholarship Case', phone: '0777222333', branch: BRANCH_A }]);
    // A bare '%' must not behave as "match everything".
    const wildcard = await supertest(app).get('/api/visitors?search=%25').set(authHeader(registrarA));
    expect(wildcard.body.every((v: any) => v.fullName.includes('%'))).toBe(true);
    const literal = await supertest(app).get('/api/visitors?search=100%25').set(authHeader(registrarA));
    expect(literal.body).toHaveLength(1);
    expect(literal.body[0].id).toBe('vux_vP');
  });

  it('does not let a search string reach SQL as code', async () => {
    const res = await supertest(app)
      .get(`/api/visitors?search=${encodeURIComponent("'; DROP TABLE visitors;--")}`)
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
    // The table is still there and still full.
    const after = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(after.body.total).toBe(120);
  });

  it('keeps the summary inside the caller\u2019s branch and ignores a forged branchId', async () => {
    seedVisitors([{ id: 'vux_vB1', name: 'Branch B Lead', phone: '0788000001', branch: BRANCH_B }]);
    const asA = await supertest(app).get('/api/visitors/summary?branchId=' + BRANCH_B).set(authHeader(registrarA));
    // Re-scoped to the caller's own branch: B's lead is not counted.
    expect(asA.body.branchId).toBe(BRANCH_A);
    expect(asA.body.total).toBe(120);

    const asB = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarB));
    expect(asB.body.total).toBe(1);
  });

  it('gives the owner an organization-wide total when they ask for it', async () => {
    seedVisitors([{ id: 'vux_vB2', name: 'Branch B Lead 2', phone: '0788000002', branch: BRANCH_B }]);
    const res = await supertest(app).get('/api/visitors/summary?branchId=all').set(authHeader(owner));
    expect(res.body.scope).toBe('organization');
    expect(res.body.total).toBe(121);
  });
});

describe('UX-1/UX-8 — pipeline buckets exclude closed-lost leads', () => {
  beforeEach(() => {
    seedVisitors([
      { id: 'vux_v1', name: 'Open Lead', phone: '0701000001', branch: BRANCH_A, stage: 'lead' },
      { id: 'vux_v2', name: 'Null Stage Lead', phone: '0701000002', branch: BRANCH_A, stage: null },
      { id: 'vux_v3', name: 'Lost Lead', phone: '0701000003', branch: BRANCH_A, stage: 'lost' },
      { id: 'vux_v4', name: 'Converted Lead', phone: '0701000004', branch: BRANCH_A, status: 'registered', stage: 'enrollment' },
    ]);
  });

  it('counts a lost lead as lost, not as open pipeline', async () => {
    const res = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(res.body.total).toBe(4);
    expect(res.body.lost).toBe(1);
    expect(res.body.registered).toBe(1);
    // Open = the two live leads only. A lost lead used to inflate this,
    // because stage='lost' leaves status='visited' untouched.
    expect(res.body.pipeline).toBe(2);
  });

  it('counts a NULL-stage lead as open pipeline', async () => {
    // Regression guard: `stage = 'lost' = 0` silently drops NULL rows in
    // SQLite, which would undercount the pipeline. COALESCE keeps them.
    const res = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(res.body.pipeline).toBe(2);
    const page = await supertest(app).get('/api/visitors?status=pending').set(authHeader(registrarA));
    expect(page.body.map((v: any) => v.id).sort()).toEqual(['vux_v1', 'vux_v2']);
  });

  it('filters by lost and registered explicitly', async () => {
    const lost = await supertest(app).get('/api/visitors?status=lost').set(authHeader(registrarA));
    expect(lost.body.map((v: any) => v.id)).toEqual(['vux_v3']);
    const reg = await supertest(app).get('/api/visitors?status=registered').set(authHeader(registrarA));
    expect(reg.body.map((v: any) => v.id)).toEqual(['vux_v4']);
  });

  it('excludes converted and lost leads from the overdue count', async () => {
    seedVisitors([
      { id: 'vux_v5', name: 'Overdue Open', phone: '0701000005', branch: BRANCH_A, nextContact: PAST },
      { id: 'vux_v6', name: 'Overdue Lost', phone: '0701000006', branch: BRANCH_A, stage: 'lost', nextContact: PAST },
      { id: 'vux_v7', name: 'Overdue Converted', phone: '0701000007', branch: BRANCH_A, status: 'registered', stage: 'enrollment', nextContact: PAST },
      { id: 'vux_v8', name: 'Future Contact', phone: '0701000008', branch: BRANCH_A, nextContact: FUTURE },
    ]);
    const res = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(res.body.overdue).toBe(1); // only vux_v5
    expect(res.body.today).toBe(today());
  });

  it('reports the per-source distribution over the whole population', async () => {
    seedVisitors([
      { id: 'vux_v9', name: 'Event One', phone: '0701000009', branch: BRANCH_A, source: 'event' },
      { id: 'vux_v10', name: 'Event Two', phone: '0701000010', branch: BRANCH_A, source: 'event' },
      { id: 'vux_v11', name: 'Organic One', phone: '0701000011', branch: BRANCH_A, source: 'organic' },
    ]);
    const res = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    const bySource = Object.fromEntries(res.body.bySource.map((r: any) => [r.source, r.count]));
    // event and organic are real, first-class channels — the old UI could
    // neither filter them nor label them, showing both as "Other".
    expect(bySource.event).toBe(2);
    expect(bySource.organic).toBe(1);
    // …and the default-seeded walk_in leads are still counted alongside them.
    expect(bySource.walk_in).toBe(4);
  });
});

// ===========================================================================
// UX-3 — placement eligibility is knowable BEFORE the payment form
// ===========================================================================
describe('UX-3 — conversion eligibility can be checked without attempting a write', () => {
  beforeEach(() => {
    seedVisitors([
      { id: 'vux_vE', name: 'Eligibility Subject', phone: '0702000001', branch: BRANCH_A },
    ]);
    db.prepare(`UPDATE visitors SET program_version_id='vux_pv' WHERE id='vux_vE'`).run();
  });

  it('reports ineligible for a placement-governed class before any payment data', async () => {
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_cls')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.code).toBe('placement_required');
    expect(res.body.requirementMode).toBe('required');
    expect(res.body.placementActionable).toBe(true);
    expect(String(res.body.reason)).toMatch(/placement/i);
  });

  /**
   * The preview must never disagree with the write path. If it did, it would be
   * a second implementation of the placement invariant — the V-1 defect class.
   */
  it('agrees with what POST /convert actually does', async () => {
    const preview = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_cls')
      .set(authHeader(registrarA));
    const write = await supertest(app)
      .post('/api/visitors/vux_vE/convert')
      .set(authHeader(registrarA))
      .send({ classId: 'vux_cls', amountPaid: 6000 });

    expect(preview.body.eligible).toBe(false);
    expect(write.status).toBe(400);
    // Same rule, same words.
    expect(String(write.body.error)).toBe(preview.body.reason);
  });

  it('reports eligible for a class governed by no placement policy, and the write then succeeds', async () => {
    // Detach the visitor program so nothing governs the ungoverned class.
    db.prepare(`UPDATE visitors SET program_version_id=NULL WHERE id='vux_vE'`).run();
    const preview = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_open')
      .set(authHeader(registrarA));
    expect(preview.body.eligible).toBe(true);
    expect(preview.body.requirementMode).toBe('not_required');

    const write = await supertest(app)
      .post('/api/visitors/vux_vE/convert')
      .set(authHeader(registrarA))
      .send({ classId: 'vux_open', amountPaid: 0 });
    expect(write.status).toBe(201);
  });

  /**
   * Mutation M7 exposed this gap: every earlier case had the visitor carrying
   * the governed program, so a preview that read ONLY `visitors.program_version_id`
   * and ignored the class's level still produced the right answer by accident.
   * That is precisely the V-1 defect shape — the class must govern.
   */
  it('resolves the requirement from the CLASS level even when the visitor has no program', async () => {
    db.prepare(`UPDATE visitors SET program_version_id=NULL WHERE id='vux_vE'`).run();
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_cls')
      .set(authHeader(registrarA));
    expect(res.body.eligible).toBe(false);
    expect(res.body.code).toBe('placement_required');
    expect(res.body.requirementMode).toBe('required');

    // And the write path refuses on the same grounds, as it must.
    const write = await supertest(app)
      .post('/api/visitors/vux_vE/convert')
      .set(authHeader(registrarA))
      .send({ classId: 'vux_cls', amountPaid: 6000 });
    expect(write.status).toBe(400);
    expect(String(write.body.error)).toBe(res.body.reason);
  });

  it('reports an already-converted lead as blocked outright', async () => {
    db.prepare(`UPDATE visitors SET status='registered' WHERE id='vux_vE'`).run();
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_cls')
      .set(authHeader(registrarA));
    expect(res.body.eligible).toBe(false);
    expect(res.body.code).toBe('already_converted');
    expect(res.body.placementActionable).toBe(false);
  });

  it('reports a closed-lost lead as blocked outright', async () => {
    db.prepare(`UPDATE visitors SET stage='lost' WHERE id='vux_vE'`).run();
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_cls')
      .set(authHeader(registrarA));
    expect(res.body.eligible).toBe(false);
    expect(res.body.code).toBe('lead_lost');
  });

  it('reports an inactive class as blocked', async () => {
    db.prepare(`INSERT OR REPLACE INTO classes (id,name,level,branch_id,status,capacity,fee,gender_policy)
                VALUES ('vux_dead','Dead Class','Open',?, 'cancelled',50,6000,'mixed')`).run(BRANCH_A);
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility?classId=vux_dead')
      .set(authHeader(registrarA));
    expect(res.body.eligible).toBe(false);
    expect(res.body.code).toBe('class_inactive');
  });

  it('answers lead-level questions with no class selected', async () => {
    const res = await supertest(app)
      .get('/api/visitors/vux_vE/conversion-eligibility')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true); // lead itself is convertible
  });
});

// ===========================================================================
// UX-4 — the preview is permission- and branch-guarded like the action itself
// ===========================================================================
describe('UX-4 — eligibility preview enforces the same authorization as convert', () => {
  beforeEach(() => {
    seedVisitors([{ id: 'vux_vP1', name: 'Perm Subject', phone: '0703000001', branch: BRANCH_A }]);
  });

  /**
   * REVISED (audit N-2). The preview was originally gated on `Lead.Convert`,
   * on the reasoning that previewing an action should require the right to
   * perform it. That was wrong for this domain: counselors hold Lead.View/Edit
   * and are authorized to RUN the placement assessment that unblocks the lead,
   * but not Lead.Convert. Hiding the blocker from them meant the only role who
   * could read "placement assessment required" was the one who could not act
   * on it.
   *
   * The preview is therefore readable at `Lead.View` while the WRITE stays at
   * `Lead.Convert`. Reading a blocker is information; enrolling is authority.
   */
  it('lets a counselor READ eligibility but still refuses the conversion', async () => {
    const preview = await supertest(app)
      .get('/api/visitors/vux_vP1/conversion-eligibility?classId=vux_open')
      .set(authHeader(counselorA));
    expect(preview.status).toBe(200);
    expect(preview.body).toHaveProperty('eligible');

    // The capability boundary is unmoved: the action itself is still refused.
    const write = await supertest(app)
      .post('/api/visitors/vux_vP1/convert')
      .set(authHeader(counselorA))
      .send({ classId: 'vux_open', amountPaid: 0 });
    expect(write.status).toBe(403);
  });

  it('the preview grants no capability and leaks no financial data', async () => {
    const preview = await supertest(app)
      .get('/api/visitors/vux_vP1/conversion-eligibility?classId=vux_open')
      .set(authHeader(counselorA));
    expect(preview.status).toBe(200);
    // Whitelist the payload: only lifecycle/placement facts a Lead.View holder
    // can already read. No fee, discount, invoice or payment field may appear.
    expect(Object.keys(preview.body).sort()).toEqual([
      'code', 'eligible', 'placementActionable', 'placementStatus', 'reason', 'requirementMode',
    ]);
  });

  it('still refuses a role without Lead.View entirely', async () => {
    const preview = await supertest(app)
      .get('/api/visitors/vux_vP1/conversion-eligibility?classId=vux_open')
      .set(authHeader(teacherA));
    expect(preview.status).toBe(403);
  });

  it('allows a registrar', async () => {
    const res = await supertest(app)
      .get('/api/visitors/vux_vP1/conversion-eligibility?classId=vux_open')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
  });

  it('refuses to preview a visitor in another branch', async () => {
    seedVisitors([{ id: 'vux_vB9', name: 'Other Branch', phone: '0788000009', branch: BRANCH_B }]);
    const res = await supertest(app)
      .get('/api/visitors/vux_vB9/conversion-eligibility?classId=vux_open')
      .set(authHeader(registrarA));
    expect(res.status).toBe(403);
  });

  it('404s an unknown visitor rather than leaking a default verdict', async () => {
    const res = await supertest(app)
      .get('/api/visitors/vux_nope/conversion-eligibility?classId=vux_open')
      .set(authHeader(registrarA));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// UX-5 — the date-of-birth contract the form must advertise
// ===========================================================================
describe('UX-5 — date of birth accepts exactly what the form now offers', () => {
  it('rejects the bare age the old placeholder suggested', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'DOB Subject', phone: '0704000001', gender: 'male', source: 'walk_in', dob: '24' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/YYYY-MM-DD/);
  });

  it('accepts an ISO date, which is what the date input produces', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'DOB Subject 2', phone: '0704000002', gender: 'male', source: 'walk_in', dob: '2002-07-15' });
    expect(res.status).toBe(201);
    const stored = db.prepare('SELECT dob FROM visitors WHERE id = ?').get(res.body.id) as { dob: string };
    expect(stored.dob).toBe('2002-07-15');
  });
});

// ===========================================================================
// UX-2 — the server sends actionable messages; the client must not swallow them
// ===========================================================================
describe('UX-2 — server error messages are specific enough to act on', () => {
  it('names the duplicate field rather than failing generically', async () => {
    const first = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'Dup One', phone: '0705000001', gender: 'male', source: 'walk_in', tazkiraNo: 'TZK-UX-1' });
    expect(first.status).toBe(201);

    const second = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'Dup Two', phone: '0705000002', gender: 'male', source: 'walk_in', tazkiraNo: 'TZK-UX-1' });
    expect(second.status).toBe(409);
    // The UI reads `error`; ApiError carries it to `err.message`. This is the
    // sentence the receptionist must see instead of "Could not save visitor."
    expect(String(second.body.error)).toMatch(/Tazkira/i);
  });

  it('names the offending field when a name exceeds the limit', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'x'.repeat(5000), phone: '0705000003', gender: 'male', source: 'walk_in' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Full name/i);
  });

  it('accepts every source the UI now offers', async () => {
    // The dropdown and the server enum must not drift apart again.
    const sources = ['walk_in', 'referral', 'friend', 'social', 'facebook', 'ads', 'event', 'organic', 'other'];
    for (const [i, source] of sources.entries()) {
      const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
        .send({ fullName: `Source ${source}`, phone: `07060000${String(i).padStart(2, '0')}`, gender: 'male', source });
      expect(res.status, `source ${source} should be accepted`).toBe(201);
    }
  });
});

// ===========================================================================
// UX-9 — advisory duplicate lookup
// ===========================================================================
describe('UX-9 — possible-duplicate lookup warns without blocking', () => {
  beforeEach(async () => {
    await createVisitor(registrarA, { fullName: 'Ahmad Zia', phone: '0700123456', tazkiraNo: 'TZK-DUP-A' });
  });

  it('finds an existing lead by phone before a duplicate is created', async () => {
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0700123456')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].fullName).toBe('Ahmad Zia');
    expect(res.body.candidates[0].matchedOn).toBe('phone');
  });

  it('is not defeated by phone formatting', async () => {
    for (const p of ['0700 123 456', '0700-123-456', '+93700123456', '(0700)123456']) {
      const res = await supertest(app)
        .get(`/api/visitors/duplicate-check?phone=${encodeURIComponent(p)}`)
        .set(authHeader(registrarA));
      expect(res.body.candidates.length, `format ${p}`).toBe(1);
    }
  });

  it('reports a Tazkira hit as an identity match', async () => {
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?tazkiraNo=TZK-DUP-A')
      .set(authHeader(registrarA));
    expect(res.body.candidates[0].matchedOn).toBe('tazkira');
  });

  it('returns nothing for a genuinely new contact', async () => {
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0788000123')
      .set(authHeader(registrarA));
    expect(res.body.candidates).toHaveLength(0);
  });

  /**
   * The whole point of ADVISORY: a shared household or office line is normal in
   * this market, so the lookup must warn while the write still succeeds. A hard
   * unique index on phone would block real enrolments at the front desk.
   */
  it('still allows the registration it warned about', async () => {
    const warn = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0700123456')
      .set(authHeader(registrarA));
    expect(warn.body.candidates).toHaveLength(1);

    const created = await createVisitor(registrarA, { fullName: 'Ahmad Zia Sibling', phone: '0700123456' });
    expect(created.status).toBe(201);
  });

  it('never leaks leads from another branch', async () => {
    await createVisitor(registrarB, { fullName: 'Branch B Person', phone: '0700999888' });
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0700999888')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(0);
  });

  it('refuses a role with no lead permissions at all', async () => {
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0700123456')
      .set(authHeader(teacherA));
    expect(res.status).toBe(403);
  });

  /**
   * Pins the exact permission, not merely "some lead permission".
   *
   * Every built-in lead-facing role happens to hold BOTH Lead.View and
   * Lead.Create, so a test using those roles cannot tell the two apart — a
   * mutation swapping Lead.Create for Lead.View survived until this case
   * existed. A purpose-built role with View but not Create makes the boundary
   * observable: the lookup assists REGISTRATION, so it must require Lead.Create.
   */
  it('requires Lead.Create specifically, not merely Lead.View', async () => {
    const roleId = 'vux_role_viewonly';
    db.prepare(`INSERT OR IGNORE INTO roles (id, code, name, description, is_system)
                VALUES (?, 'vux_view_only', 'UX View Only', 'Lead.View but not Lead.Create', 0)`).run(roleId);
    const viewPerm = db.prepare(`SELECT id FROM permissions WHERE code = 'Lead.View'`).get() as { id: string } | undefined;
    expect(viewPerm, 'Lead.View must exist in the catalogue').toBeTruthy();
    db.prepare(`INSERT OR IGNORE INTO role_permissions (id, role_id, permission_id, default_scope)
                VALUES ('vux_rp_view', ?, ?, 'branch')`).run(roleId, viewPerm!.id);

    const pwd = await hashPassword('Str0ng!Pass2026');
    db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
                VALUES ('vux_vo','vux_vo',?,'View Only','registrar',?,0)`).run(pwd, BRANCH_A);
    db.prepare(`DELETE FROM user_roles WHERE user_id = 'vux_vo'`).run();
    db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, assigned_at)
                VALUES ('vux_ur_vo','vux_vo',?, 'branch', ?, 1, 'vux_own', datetime('now'))`).run(roleId, BRANCH_A);

    const viewOnly = { userId: 'vux_vo', username: 'vux_vo', role: 'registrar', branchId: BRANCH_A, fullName: 'View Only' } as TokenPayload;

    // Can read the list (Lead.View)…
    const list = await supertest(app).get('/api/visitors?limit=1').set(authHeader(viewOnly));
    expect(list.status).toBe(200);
    // …but cannot use the registration-assist lookup (needs Lead.Create).
    const dup = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=0700123456')
      .set(authHeader(viewOnly));
    expect(dup.status).toBe(403);
  });

  it('treats a lookup value as data, never as SQL or a LIKE pattern', async () => {
    for (const probe of ["'; DROP TABLE visitors;--", '%', '_', '%%%']) {
      const res = await supertest(app)
        .get(`/api/visitors/duplicate-check?tazkiraNo=${encodeURIComponent(probe)}`)
        .set(authHeader(registrarA));
      expect(res.status).toBe(200);
      expect(res.body.candidates, `probe ${probe}`).toHaveLength(0);
    }
    // The table is intact.
    const after = await supertest(app).get('/api/visitors/summary').set(authHeader(registrarA));
    expect(after.body.total).toBeGreaterThan(0);
  });

  /**
   * A short fragment must not become a wildcard.
   *
   * The suffix match is `LIKE '%<key>'`, so without a minimum length '070'
   * would match every phone ENDING in 070 and bury the operator in false
   * positives — which trains them to ignore the warning entirely, defeating the
   * feature. The fixture below makes that observable rather than incidental.
   */
  it('ignores a phone fragment too short to be meaningful', async () => {
    // A lead whose number ENDS in the fragment: it must not be suggested.
    await createVisitor(registrarA, { fullName: 'Ends With Fragment', phone: '0733444070' });
    const res = await supertest(app)
      .get('/api/visitors/duplicate-check?phone=070')
      .set(authHeader(registrarA));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(0);
  });
});

// ===========================================================================
// UX-10 — placement state is filterable (the server filter now has a UI)
// ===========================================================================
describe('UX-10 — placement state can be isolated', () => {
  beforeEach(() => {
    const ins = db.prepare(`INSERT OR REPLACE INTO visitors
      (id, serial_no, full_name, phone, gender, source, status, stage, branch_id, visit_date, placement_status)
      VALUES (?,?,?,?,'male','walk_in','visited','lead',?,?,?)`);
    ins.run('vux_p1', 'P-1', 'Needs One', '0700310001', BRANCH_A, today(), 'not_started');
    ins.run('vux_p2', 'P-2', 'Needs Two', '0700310002', BRANCH_A, today(), 'scheduled');
    ins.run('vux_p3', 'P-3', 'Needs Three', '0700310003', BRANCH_A, today(), 'in_progress');
    ins.run('vux_p4', 'P-4', 'Assessed', '0700310004', BRANCH_A, today(), 'completed');
    ins.run('vux_p5', 'P-5', 'Waived', '0700310005', BRANCH_A, today(), 'waived');
  });

  it('needs_assessment covers exactly the unfinished states', async () => {
    const res = await supertest(app)
      .get('/api/visitors?placement=needs_assessment&limit=100')
      .set(authHeader(registrarA));
    const ids = res.body.map((v: any) => v.id).filter((i: string) => i.startsWith('vux_p'));
    expect(ids.sort()).toEqual(['vux_p1', 'vux_p2', 'vux_p3']);
  });

  it('completed and waived are separately filterable', async () => {
    const done = await supertest(app).get('/api/visitors?placement=completed&limit=100').set(authHeader(registrarA));
    expect(done.body.map((v: any) => v.id)).toContain('vux_p4');
    expect(done.body.map((v: any) => v.id)).not.toContain('vux_p5');

    const waived = await supertest(app).get('/api/visitors?placement=waived&limit=100').set(authHeader(registrarA));
    expect(waived.body.map((v: any) => v.id)).toContain('vux_p5');
  });

  it('the placement filter narrows the reported total, not just the page', async () => {
    const res = await supertest(app)
      .get('/api/visitors/summary?placement=needs_assessment')
      .set(authHeader(registrarA));
    // `filtered` reflects the filter; `total` remains the honest population.
    expect(res.body.filtered).toBeLessThan(res.body.total);
    expect(res.body.filtered).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
// UX-14 — validation messages name the field that is actually missing
// ===========================================================================
describe('UX-14 — required-field errors are actionable', () => {
  it('names gender when only gender is missing', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'Has A Name', phone: '0700320001', source: 'walk_in' });
    expect(res.status).toBe(400);
    // Previously: "Full name, gender, and source are required." — which accused
    // a field the caller had supplied.
    expect(String(res.body.error)).toMatch(/gender/i);
    expect(String(res.body.error)).not.toMatch(/full name/i);
  });

  it('names the source when only the source is missing', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ fullName: 'Has A Name', phone: '0700320002', gender: 'male' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/source/i);
    expect(String(res.body.error)).not.toMatch(/full name/i);
  });

  it('still names the full name when the full name really is missing', async () => {
    const res = await supertest(app).post('/api/visitors').set(authHeader(registrarA))
      .send({ phone: '0700320003', gender: 'male', source: 'walk_in' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/full name/i);
  });
});
