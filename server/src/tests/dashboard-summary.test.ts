/**
 * Dashboard Summary — authoritative KPI invariants (behavioral + adversarial).
 * ============================================================================
 * Every test here fails against the pre-fix implementation, in which the
 * frontend counted records out of a paginated page
 * (docs/DASHBOARD_AUDIT_2026-08-17.md):
 *
 *   D-1  conversion rate divided by the 100-row visitor page → 50% vs true 20%
 *   D-2  7-day cash flow reduced a 500-row transaction page → today understated
 *        by 39,540 AFN (45%)
 *   D-3  pending leads counted from that page → 50 vs true 200
 *   D-4  client derived "today" in UTC while the server used local time
 *   D-5  active students counted from a 2,000-row page → 1,970 vs true 2,220
 *
 * The fixtures deliberately exceed every page limit in the system, because a
 * fixture that fits inside one page cannot detect the defect class at all.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { dashboardRouter } from '../routes/dashboard.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { periodBoundaries, buildDashboardSummary } from '../core/dashboard/dashboard-summary.js';
import { today } from '../utils/ids.js';

const BRANCH = 'ds_branch_a';
const BRANCH_B = 'ds_branch_b';

// Fixture sizes chosen to break every page ceiling in the system.
const VISITORS_A = 250;        // visitors MAX_PAGE_SIZE = 100
const REGISTERED_A = 50;       // → true conversion 20%
const PENDING_A = 200;         // → true pending leads 200
const STUDENTS_A = 2250;       // students MAX_PAGE_SIZE = 2000
const INACTIVE_A = 30;         // → true active 2220
const TX_TODAY_A = 700;        // transactions default page = 500

let owner: TokenPayload;
let managerB: TokenPayload;
let teacher: TokenPayload;
let app: express.Express;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let expectedTodayIncome = 0;
let expectedTodayExpense = 0;
const TODAY = today();

function createApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/dashboard', dashboardRouter);
  a.use(errorHandler);
  return a;
}

const getSummary = (as: TokenPayload, query = '') =>
  supertest(app).get(`/api/dashboard/summary${query}`).set(authHeader(as));

beforeAll(async () => {
  initSchema();
  app = createApp();
  bootstrapRbacCatalog(db);

  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'DS A', 'T')`).run(BRANCH);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'DS B', 'T')`).run(BRANCH_B);

  const insV = db.prepare(`INSERT INTO visitors (id,serial_no,full_name,phone,gender,source,visit_date,status,branch_id,placement_status)
    VALUES (?,?,?,?,'male','walk_in',?,?,?, 'not_started')`);
  const insS = db.prepare(`INSERT INTO students (id,student_code,full_name,phone,gender,status,registration_date,branch_id,discount_percent)
    VALUES (?,?,?,?,'male',?,?,?,0)`);
  const insT = db.prepare(`INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id)
    VALUES (?,?,?,?,?,?,?)`);

  db.transaction(() => {
    for (let i = 0; i < VISITORS_A; i += 1) {
      // Pending leads span BOTH pending states; a fixture with only 'visited'
      // cannot detect a rule that silently drops 'follow_up'.
      const status = i < REGISTERED_A ? 'registered' : (i % 2 === 0 ? 'visited' : 'follow_up');
      insV.run(`ds_v_${i}`, `DSV-${i}`, `Visitor ${i}`, `0730${String(i).padStart(6, '0')}`, TODAY, status, BRANCH);
    }
    // Branch B population must never appear in a branch-A summary.
    for (let i = 0; i < 40; i += 1) {
      insV.run(`ds_vb_${i}`, `DSVB-${i}`, `B Visitor ${i}`, `0731${String(i).padStart(6, '0')}`, TODAY, 'registered', BRANCH_B);
    }
    for (let i = 0; i < STUDENTS_A; i += 1) {
      const status = i < STUDENTS_A - INACTIVE_A ? 'active' : 'inactive';
      insS.run(`ds_s_${i}`, `DSS-${i}`, `Student ${i}`, `0740${String(i).padStart(6, '0')}`, status, TODAY, BRANCH);
    }
    for (let i = 0; i < 25; i += 1) {
      insS.run(`ds_sb_${i}`, `DSSB-${i}`, `B Student ${i}`, `0741${String(i).padStart(6, '0')}`, 'active', TODAY, BRANCH_B);
    }
    for (let i = 0; i < TX_TODAY_A; i += 1) {
      const amt = 100 + (i % 50);
      expectedTodayIncome += amt;
      insT.run(`ds_t_${i}`, 'income', 'fee', amt, TODAY, `inc ${i}`, BRANCH);
    }
    for (let i = 0; i < 120; i += 1) {
      const amt = 50 + (i % 20);
      expectedTodayExpense += amt;
      insT.run(`ds_te_${i}`, 'expense', 'operational', amt, TODAY, `exp ${i}`, BRANCH);
    }
    for (let i = 0; i < 60; i += 1) {
      insT.run(`ds_tb_${i}`, 'income', 'fee', 1000, TODAY, `B inc ${i}`, BRANCH_B);
    }
    // teachers.status is NOT NULL DEFAULT 'active' CHECK IN
    // ('active','inactive','on_leave'). 'on_leave' is a distinct state that
    // must NOT be counted as active — this mirrors the pre-fix client rule
    // ((t.status || 'active') === 'active') exactly, so the migration to
    // server-side counting changes no business meaning.
    const insTeach = db.prepare(`INSERT INTO teachers (id,full_name,joined_date,status,branch_id) VALUES (?,?,?,?,?)`);
    for (let i = 0; i < 6; i += 1) insTeach.run(`ds_th_a_${i}`, `Teacher A${i}`, TODAY, 'active', BRANCH);
    // Rows that omit status take the column default ('active').
    const insTeachDefault = db.prepare(`INSERT INTO teachers (id,full_name,joined_date,branch_id) VALUES (?,?,?,?)`);
    for (let i = 0; i < 4; i += 1) insTeachDefault.run(`ds_th_n_${i}`, `Teacher D${i}`, TODAY, BRANCH);
    for (let i = 0; i < 3; i += 1) insTeach.run(`ds_th_i_${i}`, `Teacher I${i}`, TODAY, 'inactive', BRANCH);
    for (let i = 0; i < 2; i += 1) insTeach.run(`ds_th_l_${i}`, `Teacher L${i}`, TODAY, 'on_leave', BRANCH);
    const insC = db.prepare(`INSERT INTO classes (id,name,level,status,lifecycle_stage,branch_id) VALUES (?,?,?,?,?,?)`);
    for (let i = 0; i < 9; i += 1) insC.run(`ds_c_a_${i}`, `Class A${i}`, 'beginner', 'active', 'activated', BRANCH);
    for (let i = 0; i < 2; i += 1) insC.run(`ds_c_f_${i}`, `Class F${i}`, 'beginner', 'completed', 'completed', BRANCH);
  })();

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insU = db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,branch_id,must_change_password) VALUES (?,?,?,?,?,0)`);
  insU.run('ds_owner', 'ds_owner', pwd, 'Owner', BRANCH);
  assignRole('ds_owner', 'owner', BRANCH);
  insU.run('ds_mgr_b', 'ds_mgr_b', pwd, 'Mgr B', BRANCH_B);
  assignRole('ds_mgr_b', 'manager', BRANCH_B);
  insU.run('ds_teach', 'ds_teach', pwd, 'Teach', BRANCH);
  assignRole('ds_teach', 'teacher', BRANCH);

  owner = { userId: 'ds_owner', username: 'ds_owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
  managerB = { userId: 'ds_mgr_b', username: 'ds_mgr_b', branchId: BRANCH_B, fullName: 'Mgr B' } as TokenPayload;
  teacher = { userId: 'ds_teach', username: 'ds_teach', branchId: BRANCH, fullName: 'Teach' } as TokenPayload;
});

describe('D-1 — conversion rate is computed over the whole population', () => {
  it('reports the true rate, not the rate within one page', async () => {
    const res = await getSummary(owner);
    expect(res.status).toBe(200);
    const p = res.body.population;
    expect(p.totalVisitors).toBe(VISITORS_A);
    expect(p.convertedLeads).toBe(REGISTERED_A);
    // The pre-fix Dashboard divided by the 100-row page and reported 50%.
    expect(p.conversionRate).toBe(Math.round((REGISTERED_A / VISITORS_A) * 100));
    expect(p.conversionRate).toBe(20);
    expect(p.conversionRate).not.toBe(50);
  });

  it('matches a direct SQL count of the same scope', () => {
    const total = (db.prepare(`SELECT COUNT(*) c FROM visitors WHERE branch_id=?`).get(BRANCH) as any).c;
    const reg = (db.prepare(`SELECT COUNT(*) c FROM visitors WHERE branch_id=? AND status='registered'`).get(BRANCH) as any).c;
    const s = buildDashboardSummary(db, { branchId: BRANCH, isAll: false });
    expect(s.population.totalVisitors).toBe(total);
    expect(s.population.conversionRate).toBe(Math.round((reg / total) * 100));
  });
});

describe('D-3 — pending leads reflect the whole population', () => {
  it('counts every pending lead, not the first page', async () => {
    const res = await getSummary(owner);
    expect(res.body.population.pendingLeads).toBe(PENDING_A);
    expect(res.body.population.pendingLeads).not.toBe(50);
  });

  it('includes BOTH pending states (visited and follow_up)', async () => {
    const res = await getSummary(owner);
    const visited = (db.prepare(`SELECT COUNT(*) c FROM visitors WHERE branch_id=? AND status='visited'`).get(BRANCH) as any).c;
    const followUp = (db.prepare(`SELECT COUNT(*) c FROM visitors WHERE branch_id=? AND status='follow_up'`).get(BRANCH) as any).c;
    expect(visited).toBeGreaterThan(0);
    expect(followUp).toBeGreaterThan(0);
    expect(res.body.population.pendingLeads).toBe(visited + followUp);
  });

  it('does not count registered leads as pending', async () => {
    const res = await getSummary(owner);
    const p = res.body.population;
    expect(p.pendingLeads + p.convertedLeads).toBe(p.totalVisitors);
  });
});

describe('D-5 — active students survive beyond the 2,000-row page', () => {
  it('counts all active students in scope', async () => {
    const res = await getSummary(owner);
    const trueActive = (db.prepare(`SELECT COUNT(*) c FROM students WHERE branch_id=? AND status='active'`).get(BRANCH) as any).c;
    expect(res.body.population.activeStudents).toBe(trueActive);
    expect(res.body.population.activeStudents).toBe(STUDENTS_A - INACTIVE_A);
    // A page-derived count would cap at 2000 and report 1970.
    expect(res.body.population.activeStudents).toBeGreaterThan(2000);
  });

  it('totalStudents is the full population too', async () => {
    const res = await getSummary(owner);
    expect(res.body.population.totalStudents).toBe(STUDENTS_A);
  });
});

describe('Staffing and class population metrics (same defect class)', () => {
  it('counts active teachers, treating a legacy NULL status as active', async () => {
    const res = await getSummary(owner);
    // 6 explicit active + 4 defaulted to active; 3 inactive and 2 on_leave excluded.
    expect(res.body.population.activeTeachers).toBe(10);
    const truth = (db.prepare(
      `SELECT COUNT(*) c FROM teachers WHERE branch_id=? AND COALESCE(status,'active')='active'`
    ).get(BRANCH) as any).c;
    expect(res.body.population.activeTeachers).toBe(truth);
  });

  it('excludes inactive and on_leave teachers', async () => {
    const res = await getSummary(owner);
    const all = (db.prepare(`SELECT COUNT(*) c FROM teachers WHERE branch_id=?`).get(BRANCH) as any).c;
    expect(all).toBe(15);
    expect(res.body.population.activeTeachers).toBe(10);
    expect(res.body.population.activeTeachers).toBeLessThan(all);
  });

  it('counts only active classes', async () => {
    const res = await getSummary(owner);
    expect(res.body.population.activeClasses).toBe(9);
    const truth = (db.prepare(`SELECT COUNT(*) c FROM classes WHERE branch_id=? AND status='active'`).get(BRANCH) as any).c;
    expect(res.body.population.activeClasses).toBe(truth);
  });
});

describe('D-2 — cash flow reconciles exactly with the ledger', () => {
  it("today's income and expense match a direct SQL SUM", async () => {
    const res = await getSummary(owner);
    const todayRow = res.body.cashFlow[res.body.cashFlow.length - 1];
    expect(todayRow.date).toBe(TODAY);
    expect(todayRow.income).toBe(expectedTodayIncome);
    expect(todayRow.expense).toBe(expectedTodayExpense);
    // The pre-fix chart summed a 500-row page and understated this materially.
    expect(todayRow.income).toBeGreaterThan(0);
  });

  it('reconciles against the authoritative ledger query for the same scope', async () => {
    const res = await getSummary(owner);
    for (const row of res.body.cashFlow) {
      const truth = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) inc,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) exp
           FROM financial_transactions WHERE date=? AND branch_id=?`
      ).get(row.date, BRANCH) as any;
      expect(row.income).toBe(truth.inc);
      expect(row.expense).toBe(truth.exp);
    }
  });

  it('returns a continuous series with explicit zeros for inactive days', async () => {
    const res = await getSummary(owner, '?days=14');
    expect(res.body.cashFlow).toHaveLength(14);
    const zeros = res.body.cashFlow.filter((r: any) => r.income === 0 && r.expense === 0);
    expect(zeros.length).toBeGreaterThan(0); // only today has activity
    for (const r of res.body.cashFlow) {
      expect(typeof r.income).toBe('number');
      expect(Number.isNaN(r.income)).toBe(false);
    }
  });

  it('excludes another branch\'s money from the series', async () => {
    const res = await getSummary(owner);
    const todayRow = res.body.cashFlow[res.body.cashFlow.length - 1];
    // Branch B booked 60,000 today; it must not appear in branch A's chart.
    expect(todayRow.income).toBe(expectedTodayIncome);
    expect(todayRow.income).not.toBe(expectedTodayIncome + 60000);
  });
});

describe('D-4 — one date authority, server local time', () => {
  it('returns the server local date, not a UTC date', async () => {
    const res = await getSummary(owner);
    expect(res.body.today).toBe(today());
    expect(res.body.today).toBe(new Date().toLocaleDateString('en-CA'));
  });

  it('exposes explicit period boundaries so the client never derives them', async () => {
    const res = await getSummary(owner);
    const b = res.body.boundaries;
    expect(b.today.from).toBe(TODAY);
    expect(b.today.to).toBe(TODAY);
    // Month/year are SHAMSI periods (D-6), so they must equal the calendar
    // authority rather than a `YYYY-MM-01` string slice.
    const expectedMonth = periodBoundaries('month', TODAY);
    const expectedYear = periodBoundaries('year', TODAY);
    expect(b.month.from).toBe(expectedMonth.from);
    expect(b.month.to).toBe(expectedMonth.to);
    expect(b.year.from).toBe(expectedYear.from);
    // The window must never run past today.
    expect(b.month.to <= TODAY).toBe(true);
    expect(b.year.to <= TODAY).toBe(true);
  });

  it('period boundaries are pure and correct for a known date', () => {
    // 2026-08-17 is 26 Asad 1405. Asad 1405 spans 2026-07-23 .. 2026-08-22,
    // and the Jalali year 1405 opens on Nawruz, 2026-03-21.
    expect(periodBoundaries('today', '2026-08-17')).toMatchObject({ period: 'today', from: '2026-08-17', to: '2026-08-17' });
    expect(periodBoundaries('month', '2026-08-17')).toMatchObject({
      period: 'month', from: '2026-07-23', to: '2026-08-17', periodKey: '1405-05', periodEnd: '2026-08-22',
    });
    expect(periodBoundaries('year', '2026-08-17')).toMatchObject({
      period: 'year', from: '2026-03-21', to: '2026-08-17', periodKey: '1405',
    });
  });

  it('a Gregorian month start is NOT used as the month boundary (D-6)', () => {
    const b = periodBoundaries('month', '2026-08-17');
    expect(b.from).not.toBe('2026-08-01');
    // The nine days the Gregorian window wrongly excluded are inside the period.
    expect(b.from < '2026-08-01').toBe(true);
    expect('2026-07-25' >= b.from && '2026-07-25' <= b.to).toBe(true);
  });

  it('per-period intake counts respect those boundaries', async () => {
    const res = await getSummary(owner);
    expect(res.body.periods.today.newVisitors).toBe(VISITORS_A);
    expect(res.body.periods.today.newStudents).toBe(STUDENTS_A);
    // Everything seeded today also falls inside this month and year.
    expect(res.body.periods.month.newVisitors).toBe(VISITORS_A);
    expect(res.body.periods.year.newVisitors).toBe(VISITORS_A);
  });
});

describe('RBAC, branch isolation and parameter manipulation', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await supertest(app).get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('scopes a branch manager to their own branch', async () => {
    const res = await getSummary(managerB);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('branch');
    expect(res.body.branchId).toBe(BRANCH_B);
    expect(res.body.population.totalVisitors).toBe(40);
    expect(res.body.population.activeStudents).toBe(25);
  });

  it('silently re-scopes a forged ?branchId= to the caller\'s own branch', async () => {
    const res = await getSummary(managerB, `?branchId=${BRANCH}`);
    expect(res.body.branchId).toBe(BRANCH_B);
    expect(res.body.population.totalVisitors).toBe(40);
    expect(res.body.population.totalVisitors).not.toBe(VISITORS_A);
  });

  it('refuses to widen scope via ?branchId=all for a single-branch manager', async () => {
    const res = await getSummary(managerB, '?branchId=all');
    expect(res.body.scope).toBe('branch');
    expect(res.body.branchId).toBe(BRANCH_B);
  });

  it('lets the owner aggregate the organization, and the totals add up', async () => {
    const res = await getSummary(owner, '?branchId=all');
    expect(res.body.scope).toBe('organization');
    expect(res.body.population.totalVisitors).toBe(VISITORS_A + 40);
    expect(res.body.population.activeStudents).toBe(STUDENTS_A - INACTIVE_A + 25);
    const todayRow = res.body.cashFlow[res.body.cashFlow.length - 1];
    expect(todayRow.income).toBe(expectedTodayIncome + 60000);
  });

  it('a teacher holding Dashboard.View is still branch-scoped', async () => {
    const res = await getSummary(teacher);
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(BRANCH);
  });
});

describe('Robustness — empty state, bounds and hostile input', () => {
  it('an empty branch returns zeros, never NaN or a divide-by-zero', () => {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES ('ds_empty','Empty','T')`).run();
    const s = buildDashboardSummary(db, { branchId: 'ds_empty', isAll: false });
    expect(s.population.conversionRate).toBe(0);
    expect(s.population.totalVisitors).toBe(0);
    expect(s.population.activeStudents).toBe(0);
    expect(Number.isNaN(s.population.conversionRate)).toBe(false);
    expect(s.cashFlow.every((r) => r.income === 0 && r.expense === 0)).toBe(true);
  });

  it('clamps a hostile ?days= value instead of trusting it', async () => {
    for (const bad of ['99999', '-5', '0', 'abc', '1e9']) {
      const res = await getSummary(owner, `?days=${bad}`);
      expect(res.status).toBe(200);
      expect(res.body.cashFlow.length).toBeGreaterThanOrEqual(1);
      expect(res.body.cashFlow.length).toBeLessThanOrEqual(90);
    }
  });

  it('stays consistent while money is written concurrently', async () => {
    const insT = db.prepare(`INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,?,?,?,?,?,?)`);
    const reads = Array.from({ length: 8 }, () => getSummary(owner));
    for (let i = 0; i < 25; i += 1) insT.run(`ds_cc_${i}`, 'income', 'fee', 10, TODAY, 'cc', BRANCH);
    const results = await Promise.all(reads);
    for (const r of results) {
      expect(r.status).toBe(200);
      const row = r.body.cashFlow[r.body.cashFlow.length - 1];
      // Every snapshot must be a real ledger state, never a partial sum.
      expect(Number.isFinite(row.income)).toBe(true);
      expect(row.income).toBeGreaterThanOrEqual(expectedTodayIncome);
    }
    // Final read reconciles exactly with the ledger.
    const after = await getSummary(owner);
    const truth = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income' AND date=? AND branch_id=?`
    ).get(TODAY, BRANCH) as any).v;
    expect(after.body.cashFlow[after.body.cashFlow.length - 1].income).toBe(truth);
  });

  it('handles a large dataset within a sane time budget', async () => {
    const start = Date.now();
    const res = await getSummary(owner);
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
