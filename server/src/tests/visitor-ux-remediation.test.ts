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
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

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
  syncLegacyUserRoles(db);

  owner = { userId: 'vux_own', username: 'vux_own', role: 'owner', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;
  registrarA = { userId: 'vux_reg', username: 'vux_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'Registrar A' } as TokenPayload;
  counselorA = { userId: 'vux_cou', username: 'vux_cou', role: 'counselor', branchId: BRANCH_A, fullName: 'Counselor A' } as TokenPayload;
  registrarB = { userId: 'vux_regb', username: 'vux_regb', role: 'registrar', branchId: BRANCH_B, fullName: 'Registrar B' } as TokenPayload;

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

  it('refuses a counselor, who also cannot convert', async () => {
    const preview = await supertest(app)
      .get('/api/visitors/vux_vP1/conversion-eligibility?classId=vux_open')
      .set(authHeader(counselorA));
    expect(preview.status).toBe(403);

    // Same verdict on the action the preview describes — the UI hiding the
    // button is cosmetic; this is the enforcement.
    const write = await supertest(app)
      .post('/api/visitors/vux_vP1/convert')
      .set(authHeader(counselorA))
      .send({ classId: 'vux_open', amountPaid: 0 });
    expect(write.status).toBe(403);
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
