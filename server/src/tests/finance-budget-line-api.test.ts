/**
 * Budget-line API — authorization boundary and server-side validation.
 * ============================================================================
 * Raised by INDEPENDENT REVIEW of WP-07 (Engineering Protocol §5): the
 * create/update endpoints were proven working by hand against the live API, but
 * nothing asserted the boundary. A happy path that works tells you nothing about
 * what happens when somebody aims the endpoint at another branch, at a category
 * instead of a subcategory, or at the payroll envelope the whole payroll run
 * depends on.
 *
 * The rule these tests encode: the browser proposes, the server decides.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const HOME = 'bla_home';
const FOREIGN = 'bla_foreign';

let owner: TokenPayload;
let manager: TokenPayload;
let financeDesk: TokenPayload;
let app: express.Express;
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [id, name] of [[HOME, 'BLA Home'], [FOREIGN, 'BLA Foreign']]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location,is_active) VALUES (?,?, 'Kabul',1)`).run(id, name);
    ensureBranchBudgetLines(db, id);
  }
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    `INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
     VALUES ('bla_own','bla_own',?,'Owner','owner',?,0)`,
  ).run(pwd, HOME);
  db.prepare(
    `INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
     VALUES ('bla_mgr','bla_mgr',?,'Manager','manager',?,0)`,
  ).run(pwd, HOME);
  db.prepare(
    `INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
     VALUES ('bla_fin','bla_fin',?,'Finance Desk','finance',?,0)`,
  ).run(pwd, HOME);
  syncLegacyUserRoles(db);
  owner = { userId: 'bla_own', username: 'bla_own', role: 'owner', branchId: HOME, fullName: 'Owner' } as TokenPayload;
  // Branch-scoped, WITH allocation authority.
  manager = { userId: 'bla_mgr', username: 'bla_mgr', role: 'manager', branchId: HOME, fullName: 'Manager' } as TokenPayload;
  // Branch-scoped, WITHOUT allocation authority — the finance desk is explicitly
  // "payments & ledger; no treasury allocation" in the permission catalogue.
  financeDesk = { userId: 'bla_fin', username: 'bla_fin', role: 'finance', branchId: HOME, fullName: 'Finance Desk' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
});

const create = (actor: TokenPayload, body: Record<string, unknown>) =>
  supertest(app).post('/api/finance/budget-lines').set(auth(actor)).send(body);

describe('POST /finance/budget-lines validates against the taxonomy, server-side', () => {
  it('creates an envelope under a canonical subcategory', async () => {
    const res = await create(owner, { subcategoryId: 'sub_rent', name: 'Home branch rent', costType: 'fixed' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      categoryName: 'Premises & Facilities',
      subcategoryName: 'Rent Expense',
      classification: 'operating_expense',
      payrollTarget: null,
      isActive: true,
    });
    // A new envelope is never born funded.
    expect(res.body.allocatedAmount).toBe(0);
    expect(res.body.currentAmount).toBe(0);
  });

  it('refuses a CATEGORY where a subcategory is required', async () => {
    const res = await create(owner, { subcategoryId: 'cat_premises_facilities', name: 'Wrong level' });
    expect(res.status).toBe(400);
  });

  it('refuses an id that is not in the taxonomy at all', async () => {
    for (const bogus of ['sub_does_not_exist', '', null, 42, 'DROP TABLE budget_lines']) {
      const res = await create(owner, { subcategoryId: bogus, name: 'Invented' });
      expect(res.status, String(bogus)).toBe(400);
    }
  });

  it('refuses a blank or whitespace-only name', async () => {
    for (const name of ['', '   ', null]) {
      const res = await create(owner, { subcategoryId: 'sub_utilities', name });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
  });

  it('refuses a duplicate name under the same subcategory, but allows a second envelope', async () => {
    expect((await create(owner, { subcategoryId: 'sub_utilities', name: 'Electricity' })).status).toBe(201);
    // A second envelope under one subcategory is legitimate — a second meter.
    expect((await create(owner, { subcategoryId: 'sub_utilities', name: 'Water' })).status).toBe(201);
    // The same name twice is a data-entry error.
    expect((await create(owner, { subcategoryId: 'sub_utilities', name: 'electricity' })).status).toBe(409);
  });

  it('refuses a channel that belongs to a different subcategory', async () => {
    const res = await create(owner, {
      subcategoryId: 'sub_rent', name: 'Rent with a marketing channel', channelId: 'chn_facebook',
    });
    expect(res.status).toBe(400);
  });

  it('accepts a channel that belongs to the chosen subcategory', async () => {
    const res = await create(owner, {
      subcategoryId: 'sub_digital_advertising', name: 'Facebook campaigns', channelId: 'chn_facebook',
    });
    expect(res.status).toBe(201);
    expect(res.body.channelId).toBe('chn_facebook');
  });

  it('never lets the caller invent a payroll envelope', async () => {
    // `payroll_target` is set by provisioning, never by a request body — otherwise
    // a second teacher envelope could be created and payroll would debit an
    // arbitrary one of them.
    const res = await create(owner, { subcategoryId: 'sub_staff_benefits', name: 'Sneaky payroll', payrollTarget: 'teacher' });
    expect(res.status).toBe(201);
    expect(res.body.payrollTarget).toBeNull();
  });
});

describe('the budget-line API respects branch scope', () => {
  it('refuses a branch-scoped user creating a line in another branch', async () => {
    const res = await create(manager, { subcategoryId: 'sub_rent', name: 'Cross-branch rent', branchId: FOREIGN });
    expect(res.status).toBe(403);
  });

  it('defaults to the caller’s own branch when none is given', async () => {
    const res = await create(manager, { subcategoryId: 'sub_security', name: 'Night guard' });
    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(HOME);
  });

  it('refuses the finance desk, which has no treasury-allocation authority', async () => {
    // Separation of duties: the finance desk records payments and reads the
    // ledger. Deciding that a branch should carry a new budget envelope is an
    // allocation decision, and the permission catalogue withholds it
    // ("Finance desk — payments & ledger; no treasury allocation").
    const res = await create(financeDesk, { subcategoryId: 'sub_stationery', name: 'Desk stationery' });
    expect(res.status).toBe(403);
  });

  it('refuses an unknown or inactive branch', async () => {
    const res = await create(owner, { subcategoryId: 'sub_rent', name: 'Ghost branch rent', branchId: 'no_such_branch' });
    expect([403, 404]).toContain(res.status);
  });

  it('refuses a branch-scoped user patching another branch’s line', async () => {
    const foreignLine = db.prepare(
      `SELECT id FROM budget_lines WHERE branch_id = ? AND payroll_target = 'teacher'`,
    ).get(FOREIGN) as { id: string };
    const res = await supertest(app)
      .patch(`/api/finance/budget-lines/${foreignLine.id}`)
      .set(auth(manager))
      .send({ name: 'Renamed from another branch' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /finance/budget-lines/:id', () => {
  it('renames and reclassifies cost type', async () => {
    const created = await create(owner, { subcategoryId: 'sub_telephone', name: 'Landline', costType: 'variable' });
    const res = await supertest(app)
      .patch(`/api/finance/budget-lines/${created.body.id}`)
      .set(auth(owner))
      .send({ name: 'Office landline', costType: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Office landline', costType: 'fixed' });
  });

  it('cannot change the accounting treatment', async () => {
    // The treatment belongs to the subcategory, so there is exactly one authority
    // for it. Nothing in the patch body can move a line between classifications.
    const created = await create(owner, { subcategoryId: 'sub_fuel', name: 'Generator fuel' });
    await supertest(app)
      .patch(`/api/finance/budget-lines/${created.body.id}`)
      .set(auth(owner))
      .send({ subcategoryId: 'sub_vehicles', categoryId: 'cat_capital_expenditure', classification: 'capital_expenditure' });
    const after = db.prepare('SELECT category_id FROM budget_lines WHERE id = ?').get(created.body.id) as { category_id: string };
    expect(after.category_id).toBe('sub_fuel');
  });

  it('refuses to retire a payroll envelope', async () => {
    const payroll = db.prepare(
      `SELECT id FROM budget_lines WHERE branch_id = ? AND payroll_target = 'teacher'`,
    ).get(HOME) as { id: string };
    const res = await supertest(app)
      .patch(`/api/finance/budget-lines/${payroll.id}`)
      .set(auth(owner))
      .send({ isActive: false });
    // Retiring it would make the next salary run answer 500 with no way back
    // through the UI.
    expect(res.status).toBe(409);
  });

  it('retires an ordinary line without deleting it', async () => {
    const created = await create(owner, { subcategoryId: 'sub_postage_courier', name: 'Courier' });
    const res = await supertest(app)
      .patch(`/api/finance/budget-lines/${created.body.id}`)
      .set(auth(owner))
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    // Still present, so history and expense requests keep resolving.
    expect(db.prepare('SELECT id FROM budget_lines WHERE id = ?').get(created.body.id)).toBeDefined();
  });

  it('404s on a line that does not exist', async () => {
    const res = await supertest(app)
      .patch('/api/finance/budget-lines/bl_nope')
      .set(auth(owner))
      .send({ name: 'Nothing' });
    expect(res.status).toBe(404);
  });
});
