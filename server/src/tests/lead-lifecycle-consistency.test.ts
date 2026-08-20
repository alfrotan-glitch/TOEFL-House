/**
 * Lead lifecycle — cross-module consistency suite.
 * ============================================================================
 * The second UX audit found the question "how many leads are still open?"
 * answered differently by different endpoints on identical data: the Visitors
 * screen said 225 while the Dashboard said 226, because only one of them
 * treated a closed-lost lead as terminal.
 *
 * These tests do not check a single module. They assert that every consumer of
 * the lead lifecycle AGREES, which is the property that actually matters and
 * the one that silently rotted. A future contributor who adds a sixth private
 * predicate will fail here rather than in production.
 *
 * They also pin the domain rule itself, because the rule is subtle:
 * `stage` and `status` are independent axes and must not be collapsed.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { visitorsRouter } from '../routes/visitors.routes.js';
import { dashboardRouter } from '../routes/dashboard.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { buildVisitorSummary, queryVisitorPage } from '../core/visitors/visitor-query.js';
import { buildDashboardSummary } from '../core/dashboard/dashboard-summary.js';
import {
  leadLifecycleBucket,
  isLeadOpen,
  isLeadConverted,
  isLeadClosed,
  LEAD_OPEN_SQL,
  LEAD_CONVERTED_SQL,
  LEAD_CLOSED_SQL,
} from '../core/visitors/lead-lifecycle.js';
import { today } from '../utils/ids.js';

const BRANCH = 'llc_a';
const BRANCH_B = 'llc_b';
let owner: TokenPayload;
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let serial = 0;
function seedVisitor(o: { status?: string; stage?: string | null; branch?: string } = {}): string {
  const vid = `llc_v${++serial}`;
  db.prepare(
    `INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, status, stage, branch_id, visit_date)
     VALUES (?,?,?,?,'male','walk_in',?,?,?,?)`
  ).run(
    vid, `LLC-${serial}`, `LLC Lead ${serial}`, `07005${String(serial).padStart(5, '0')}`,
    o.status ?? 'visited',
    o.stage === undefined ? 'lead' : o.stage,
    o.branch ?? BRANCH,
    today()
  );
  return vid;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'LLC A', 'T')`).run(BRANCH);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'LLC B', 'T')`).run(BRANCH_B);
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(`INSERT OR IGNORE INTO users ( id, username, password_hash, full_name, branch_id, must_change_password )
              VALUES ('llc_own', 'llc_own', ?, 'Owner', ?, 0)`).run(pwd, BRANCH);
  assignRole('llc_own', 'owner', BRANCH);

  owner = { userId: 'llc_own', username: 'llc_own', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare(`DELETE FROM visitors WHERE id LIKE 'llc_v%'`).run();
});

// ===========================================================================
// The domain rule itself
// ===========================================================================
describe('the lifecycle rule: stage and status are independent axes', () => {
  it('classifies a converted lead as converted regardless of stage', () => {
    // Conversion writes status='registered' AND stage='enrollment'.
    expect(leadLifecycleBucket({ status: 'registered', stage: 'enrollment' })).toBe('converted');
    // Even if some later workflow moved the stage, the commercial fact stands.
    expect(leadLifecycleBucket({ status: 'registered', stage: 'lost' })).toBe('converted');
    expect(leadLifecycleBucket({ status: 'registered', stage: 'active' })).toBe('converted');
  });

  /**
   * This is the case that forbids deriving `status` from `stage`.
   * `POST /:id/advance-stage` never writes `status`, so a lead can be walked
   * all the way to stage='enrollment' with no student record and no payment.
   * Treating that as converted would invent revenue.
   */
  it('does NOT treat stage=enrollment as converted when status says otherwise', () => {
    expect(leadLifecycleBucket({ status: 'visited', stage: 'enrollment' })).toBe('open');
    expect(isLeadConverted({ status: 'visited', stage: 'enrollment' })).toBe(false);
    expect(isLeadOpen({ status: 'visited', stage: 'enrollment' })).toBe(true);
  });

  it('classifies a closed-lost lead as closed, not open', () => {
    expect(leadLifecycleBucket({ status: 'visited', stage: 'lost' })).toBe('closed');
    expect(isLeadClosed({ status: 'visited', stage: 'lost' })).toBe(true);
    expect(isLeadOpen({ status: 'visited', stage: 'lost' })).toBe(false);
  });

  it('treats a NULL stage as open, never as lost', () => {
    // stage is NULLable; a NULL-unsafe predicate silently drops these rows.
    expect(leadLifecycleBucket({ status: 'visited', stage: null })).toBe('open');
    expect(leadLifecycleBucket({ status: 'visited' })).toBe('open');
  });

  it('treats an unknown status as open rather than dropping it', () => {
    // The old Dashboard allow-list (status IN ('visited','follow_up')) would
    // have counted this row in NO bucket at all.
    expect(leadLifecycleBucket({ status: 'some_future_state', stage: 'lead' })).toBe('open');
  });

  it('the JS helper and the SQL predicates classify identically', () => {
    const cases = [
      { status: 'registered', stage: 'enrollment' },
      { status: 'registered', stage: 'lost' },
      { status: 'visited', stage: 'lost' },
      { status: 'visited', stage: 'enrollment' },
      { status: 'visited', stage: null },
      { status: 'follow_up', stage: 'follow_up' },
      { status: 'some_future_state', stage: 'lead' },
    ];
    for (const c of cases) {
      const vid = seedVisitor(c);
      const inSql = (sql: string) =>
        Number((db.prepare(`SELECT COUNT(*) c FROM visitors WHERE id=? AND ${sql}`).get(vid) as any).c) === 1;
      const bucket = leadLifecycleBucket(c);
      expect(inSql(LEAD_CONVERTED_SQL), `converted ${JSON.stringify(c)}`).toBe(bucket === 'converted');
      expect(inSql(LEAD_CLOSED_SQL), `closed ${JSON.stringify(c)}`).toBe(bucket === 'closed');
      expect(inSql(LEAD_OPEN_SQL), `open ${JSON.stringify(c)}`).toBe(bucket === 'open');
    }
  });
});

// ===========================================================================
// Exhaustiveness — the property that makes the buckets trustworthy
// ===========================================================================
describe('the three buckets are mutually exclusive and collectively exhaustive', () => {
  beforeEach(() => {
    seedVisitor({ status: 'visited', stage: 'lead' });
    seedVisitor({ status: 'visited', stage: null });
    seedVisitor({ status: 'follow_up', stage: 'follow_up' });
    seedVisitor({ status: 'visited', stage: 'enrollment' }); // advanced, NOT converted
    seedVisitor({ status: 'visited', stage: 'lost' });
    seedVisitor({ status: 'registered', stage: 'enrollment' });
    seedVisitor({ status: 'registered', stage: 'lost' }); // won then annotated lost
    seedVisitor({ status: 'weird_new_value', stage: 'inquiry' });
  });

  it('every row lands in exactly one bucket', () => {
    const scoped = ` AND branch_id='${BRANCH}'`;
    const c = (sql: string) =>
      Number((db.prepare(`SELECT COUNT(*) c FROM visitors WHERE ${sql}${scoped}`).get() as any).c);
    const total = c('1=1');
    expect(c(LEAD_CONVERTED_SQL) + c(LEAD_CLOSED_SQL) + c(LEAD_OPEN_SQL)).toBe(total);
    // and no row is double-counted
    expect(c(`(${LEAD_CONVERTED_SQL}) AND (${LEAD_CLOSED_SQL})`)).toBe(0);
    expect(c(`(${LEAD_CONVERTED_SQL}) AND (${LEAD_OPEN_SQL})`)).toBe(0);
    expect(c(`(${LEAD_CLOSED_SQL}) AND (${LEAD_OPEN_SQL})`)).toBe(0);
  });

  it('a won-then-lost lead counts as converted, never as closed', () => {
    // Conversion is backed by money and a student record; a stage annotation
    // must not be able to un-win it.
    const scoped = ` AND branch_id='${BRANCH}'`;
    const closed = Number(
      (db.prepare(`SELECT COUNT(*) c FROM visitors WHERE ${LEAD_CLOSED_SQL}${scoped}`).get() as any).c
    );
    expect(closed).toBe(1); // only the visited+lost row
  });
});

// ===========================================================================
// Cross-module agreement — the regression that actually happened
// ===========================================================================
describe('every consumer reports the same lead buckets', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) seedVisitor({ status: 'visited', stage: 'lead' });
    seedVisitor({ status: 'visited', stage: 'lost' });
    seedVisitor({ status: 'visited', stage: 'lost' });
    for (let i = 0; i < 3; i++) seedVisitor({ status: 'registered', stage: 'enrollment' });
    seedVisitor({ status: 'visited', stage: 'enrollment' }); // advanced, not converted
  });

  it('the visitor summary and the dashboard summary agree exactly', () => {
    const scope = { branchId: BRANCH, isAll: false };
    const v = buildVisitorSummary(db, scope, {}, today());
    const d = buildDashboardSummary(db, scope);

    expect(v.total).toBe(d.population.totalVisitors);
    expect(v.registered).toBe(d.population.convertedLeads);
    // The exact divergence the audit caught live (225 vs 226).
    expect(v.pipeline).toBe(d.population.pendingLeads);
    expect(v.lost).toBe(d.population.closedLeads);
    expect(v.conversionRate).toBe(d.population.conversionRate);
  });

  it('the dashboard buckets are exhaustive', () => {
    const d = buildDashboardSummary(db, { branchId: BRANCH, isAll: false });
    const p = d.population;
    expect(p.pendingLeads + p.convertedLeads + p.closedLeads).toBe(p.totalVisitors);
  });

  it('a closed-lost lead is excluded from open pipeline on BOTH surfaces', () => {
    const scope = { branchId: BRANCH, isAll: false };
    const v = buildVisitorSummary(db, scope, {}, today());
    const d = buildDashboardSummary(db, scope);
    expect(v.lost).toBe(2);
    expect(v.pipeline).toBe(6); // 5 leads + 1 advanced-but-unconverted
    expect(d.population.pendingLeads).toBe(6);
  });

  it('/visitors/pipeline agrees with /visitors/summary on conversions', async () => {
    const pipe = await supertest(app).get('/api/visitors/pipeline').set(authHeader(owner));
    const summ = await supertest(app).get('/api/visitors/summary').set(authHeader(owner));
    expect(pipe.status).toBe(200);
    // Previously /pipeline counted stage='registration' and reported 0
    // conversions while /summary correctly reported 3.
    expect(pipe.body.totalRegistrations).toBe(summ.body.registered);
    expect(pipe.body.totalLeads).toBe(summ.body.total);
  });

  it('/visitors/pipeline does not credit a lead merely parked in the registration stage', async () => {
    seedVisitor({ status: 'visited', stage: 'registration' });
    const pipe = await supertest(app).get('/api/visitors/pipeline').set(authHeader(owner));
    // Still 3 real conversions; the parked lead is not one of them.
    expect(pipe.body.totalRegistrations).toBe(3);
    // …but it does appear in the per-stage funnel, which is a different question.
    const regStage = pipe.body.stages.find((s: any) => s.stage === 'registration');
    expect(regStage.count).toBe(1);
  });
});

// ===========================================================================
// byStage — the kanban's authoritative column counts (audit N-1)
// ===========================================================================
describe('byStage counts the whole population, not a page', () => {
  beforeEach(() => {
    for (let i = 0; i < 30; i++) seedVisitor({ status: 'visited', stage: 'lead' });
    seedVisitor({ status: 'visited', stage: 'inquiry' });
    seedVisitor({ status: 'visited', stage: 'lost' });
    for (let i = 0; i < 4; i++) seedVisitor({ status: 'registered', stage: 'enrollment' });
    seedVisitor({ status: 'visited', stage: null });
  });

  it('reports every stage over the full scoped population', () => {
    const v = buildVisitorSummary(db, { branchId: BRANCH, isAll: false }, {}, today());
    const byStage = Object.fromEntries(v.byStage.map((r) => [r.stage, r.count]));
    // The board previously derived these from a 25-row page and showed 21.
    expect(byStage.lead).toBe(31); // 30 explicit + 1 NULL normalised to 'lead'
    expect(byStage.inquiry).toBe(1);
    expect(byStage.lost).toBe(1);
    expect(byStage.enrollment).toBe(4);
  });

  it('byStage sums to the population total, so no lead is invisible on the board', () => {
    const v = buildVisitorSummary(db, { branchId: BRANCH, isAll: false }, {}, today());
    expect(v.byStage.reduce((n, r) => n + r.count, 0)).toBe(v.total);
  });

  it('is unaffected by the page window', () => {
    const scope = { branchId: BRANCH, isAll: false };
    const a = buildVisitorSummary(db, scope, {}, today());
    // Summary is page-independent by construction; assert it explicitly so a
    // future refactor cannot quietly reintroduce page-derived counts.
    const page = queryVisitorPage(db, scope, {}, { limit: 5, offset: 0 }, today());
    expect(page.rows).toHaveLength(5);
    const b = buildVisitorSummary(db, scope, {}, today());
    expect(b.byStage).toEqual(a.byStage);
    expect(b.total).toBe(a.total);
  });

  it('normalises a NULL stage to lead rather than dropping the row', () => {
    const v = buildVisitorSummary(db, { branchId: BRANCH, isAll: false }, {}, today());
    expect(v.byStage.some((r) => r.stage === null as unknown as string)).toBe(false);
    expect(v.byStage.reduce((n, r) => n + r.count, 0)).toBe(v.total);
  });
});

// ===========================================================================
// Branch isolation must survive the refactor
// ===========================================================================
describe('lifecycle counting respects branch scope', () => {
  beforeEach(() => {
    seedVisitor({ status: 'visited', stage: 'lead', branch: BRANCH });
    seedVisitor({ status: 'registered', stage: 'enrollment', branch: BRANCH });
    seedVisitor({ status: 'visited', stage: 'lost', branch: BRANCH_B });
    seedVisitor({ status: 'registered', stage: 'enrollment', branch: BRANCH_B });
  });

  it('counts only the caller\u2019s branch', () => {
    const v = buildVisitorSummary(db, { branchId: BRANCH, isAll: false }, {}, today());
    expect(v.total).toBe(2);
    expect(v.registered).toBe(1);
    expect(v.lost).toBe(0);
    const d = buildDashboardSummary(db, { branchId: BRANCH, isAll: false });
    expect(d.population.totalVisitors).toBe(2);
    expect(d.population.closedLeads).toBe(0);
  });

  it('organization scope sees every branch and still agrees across modules', () => {
    const v = buildVisitorSummary(db, { branchId: null, isAll: true }, {}, today());
    const d = buildDashboardSummary(db, { branchId: null, isAll: true });
    expect(v.total).toBe(d.population.totalVisitors);
    expect(v.pipeline).toBe(d.population.pendingLeads);
    expect(v.lost).toBe(d.population.closedLeads);
    expect(v.registered).toBe(2);
  });
});
