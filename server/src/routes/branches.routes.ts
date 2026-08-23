/**
 * Organization → Campus → Branch configuration API.
 * Branch code is unique system-wide. Active flag gates operational availability.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';
import { authenticate, authorize, denyPermissionless, canAccessBranchResource, requireGlobalOwner } from '../middleware/auth.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { ensureFinanceAccount } from '../utils/financeAccounts.js';

const FIXED_ORG_NAME = 'The TOEFL House';
const FIXED_ORG_ID = 'org_toefl_house';

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetOrg = db.prepare('SELECT * FROM organizations WHERE id = ?');
const stmtInsertOrg = db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)');
const stmtUpdateOrgName = db.prepare('UPDATE organizations SET name = ? WHERE id = ?');
const stmtCountCampusesByOrg = db.prepare('SELECT COUNT(*) as c FROM campuses WHERE organization_id = ?');
const stmtCountAllBranches = db.prepare('SELECT COUNT(*) as c FROM branches');

const stmtCountCampusBranches = db.prepare('SELECT COUNT(*) as c FROM branches WHERE campus_id = ?');
const stmtCountActiveCampusBranches = db.prepare('SELECT COUNT(*) as c FROM branches WHERE campus_id = ? AND is_active = 1');

const stmtGetAllCampuses = db.prepare('SELECT * FROM campuses ORDER BY name');
const stmtGetActiveCampuses = db.prepare('SELECT * FROM campuses WHERE is_active = 1 ORDER BY name');
const stmtGetCampusById = db.prepare('SELECT * FROM campuses WHERE id = ?');
const stmtInsertCampus = db.prepare(
  `INSERT INTO campuses (id, organization_id, name, code, address, postal_code, phone, email, description, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateCampus = db.prepare(
  `UPDATE campuses SET name = ?, code = ?, address = ?, postal_code = ?, phone = ?, email = ?, description = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtDeactivateCampus = db.prepare(`UPDATE campuses SET is_active = 0, updated_at = datetime('now') WHERE id = ?`);
const stmtDeactivateBranchesByCampus = db.prepare(`UPDATE branches SET is_active = 0, updated_at = datetime('now') WHERE campus_id = ?`);
const stmtGetBranchIdsByCampus = db.prepare('SELECT id FROM branches WHERE campus_id = ?');
const stmtDeleteBranch = db.prepare('DELETE FROM branches WHERE id = ?');
const stmtDeleteCampus = db.prepare('DELETE FROM campuses WHERE id = ?');
const stmtDeleteBranchBudgetLines = db.prepare('DELETE FROM budget_lines WHERE branch_id = ?');
const stmtDeleteBranchFinanceAccount = db.prepare("DELETE FROM finance_accounts WHERE scope_type = 'branch' AND scope_id = ?");
const stmtGetBranchFinanceAccount = db.prepare(
  "SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type = 'branch' AND scope_id = ?",
);
const stmtGetBranchBudgetBalance = db.prepare(
  'SELECT COALESCE(SUM(current_amount), 0) AS current_total FROM budget_lines WHERE branch_id = ?',
);

const stmtGetAllBranches = db.prepare('SELECT * FROM branches ORDER BY name');
const stmtGetBranchById = db.prepare('SELECT * FROM branches WHERE id = ?');
const stmtInsertBranch = db.prepare(
  `INSERT INTO branches (id, campus_id, name, code, location, address, postal_code, phone, email, description, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateBranch = db.prepare(
  `UPDATE branches SET campus_id = ?, name = ?, code = ?, location = ?, address = ?, postal_code = ?, phone = ?, email = ?, description = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtDeactivateBranch = db.prepare(`UPDATE branches SET is_active = 0, updated_at = datetime('now') WHERE id = ?`);

const stmtCheckCampusCode = db.prepare('SELECT id FROM campuses WHERE UPPER(code) = ? AND id != ?');
const stmtCheckCampusCodeInsert = db.prepare('SELECT id FROM campuses WHERE UPPER(code) = ?');
const stmtCheckBranchCode = db.prepare('SELECT id FROM branches WHERE UPPER(code) = ? AND id != ?');
const stmtCheckBranchCodeInsert = db.prepare('SELECT id FROM branches WHERE UPPER(code) = ?');
const stmtGetCampusActiveState = db.prepare('SELECT id, is_active FROM campuses WHERE id = ?');

const stmtGetAllPartners = db.prepare('SELECT * FROM partners ORDER BY share_percent DESC');
const stmtInsertPartner = db.prepare(
  `INSERT INTO partners (id, full_name, phone, email, share_percent, role_description) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtGetPartnerById = db.prepare('SELECT * FROM partners WHERE id = ?');
const stmtUpdatePartner = db.prepare(
  `UPDATE partners SET full_name = ?, phone = ?, email = ?, share_percent = ?, role_description = ? WHERE id = ?`
);
const stmtDeletePartner = db.prepare('DELETE FROM partners WHERE id = ?');

/** Pre-compile dependency checks to avoid dynamic SQL preparation in a loop */
const BRANCH_DEPENDENT_TABLES = [
  'users', 'students', 'teachers', 'employees', 'classes', 'sessions', 'visitors',
  'payments', 'invoices', 'expense_requests', 'financial_transactions',
  'books', 'book_stock_receipts', 'book_sales', 'book_sale_refunds', 'book_loans', 'book_loan_returns', 'exams', 'exam_results', 'attendance', 'notifications',
  'audit_logs', 'programs', 'campaigns'
] as const;

const stmtCountBranchDependents = BRANCH_DEPENDENT_TABLES.map(table => ({
  table,
  stmt: db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE branch_id = ?`)
}));

function ensureOrganization(): void {
  const existing = stmtGetOrg.get(FIXED_ORG_ID) as { id: string } | undefined;
  if (!existing) {
    stmtInsertOrg.run(FIXED_ORG_ID, FIXED_ORG_NAME);
  } else {
    stmtUpdateOrgName.run(FIXED_ORG_NAME, FIXED_ORG_ID);
  }
}

function mapCampus(row: any, req?: import('express').Request) {
  if (!row) return null;
  let branchTotal: number;
  let branchActive: number;
  if (!req || (req.rbac && isGlobalOwner(req.rbac))) {
    branchTotal = (stmtCountCampusBranches.get(row.id) as { c: number }).c;
    branchActive = (stmtCountActiveCampusBranches.get(row.id) as { c: number }).c;
  } else {
    const visible = (db.prepare('SELECT id, is_active FROM branches WHERE campus_id = ?').all(row.id) as Array<{ id: string; is_active: number }>)
      .filter((branch) => canAccessBranchResource(req, branch.id));
    branchTotal = visible.length;
    branchActive = visible.filter((branch) => branch.is_active === 1).length;
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    code: row.code,
    address: row.address ?? null,
    postalCode: row.postal_code ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    description: row.description ?? null,
    isActive: !!row.is_active,
    branchCount: branchTotal,
    activeBranchCount: branchActive,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function countBranchDependents(branchId: string): { table: string; count: number }[] {
  const results: { table: string; count: number }[] = [];
  for (const { table, stmt } of stmtCountBranchDependents) {
    try {
      const row = stmt.get(branchId) as { c: number };
      if (row.c > 0) results.push({ table, count: row.c });
    } catch {
      // table may not exist in partial DBs
    }
  }
  return results;
}

function countCampusBranchDependents(campusId: string): number {
  const branches = stmtGetBranchIdsByCampus.all(campusId) as Array<{ id: string }>;
  let total = 0;
  for (const b of branches) {
    total += countBranchDependents(b.id).reduce((s, x) => s + x.count, 0);
  }
  return total;
}

function requireEmptyBranchProvisioning(branchId: string): void {
  const account = stmtGetBranchFinanceAccount.get(branchId) as
    | { main_balance: number; saving_balance: number }
    | undefined;
  const budget = stmtGetBranchBudgetBalance.get(branchId) as { current_total: number };
  const main = Number(account?.main_balance ?? 0);
  const saving = Number(account?.saving_balance ?? 0);
  const envelopes = Number(budget.current_total ?? 0);
  if (!Number.isFinite(main) || !Number.isFinite(saving) || !Number.isFinite(envelopes) ||
      main !== 0 || saving !== 0 || envelopes !== 0) {
    throw new HttpError(409, 'Cannot permanently delete a branch while its cash account or budget envelopes hold funds.');
  }
}

function deleteEmptyBranch(branchId: string): void {
  // Finance accounts are polymorphic and deliberately have no branch foreign
  // key; budget lines use RESTRICT. Remove only zero-balance provisioning in
  // the same transaction as the empty branch so no orphan account survives.
  stmtDeleteBranchBudgetLines.run(branchId);
  stmtDeleteBranchFinanceAccount.run(branchId);
  stmtDeleteBranch.run(branchId);
}

function mapBranch(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    campusId: row.campus_id ?? null,
    name: row.name,
    code: row.code ?? null,
    location: row.location ?? row.address ?? '',
    address: row.address ?? row.location ?? null,
    postalCode: row.postal_code ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    description: row.description ?? null,
    isActive: row.is_active === undefined || row.is_active === null ? true : !!row.is_active,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function assertUniqueBranchCode(code: string, excludeId?: string): void {
  const normalized = code.trim().toUpperCase();
  const row = excludeId
    ? stmtCheckBranchCode.get(normalized, excludeId)
    : stmtCheckBranchCodeInsert.get(normalized);
  if (row) {
    throw new HttpError(409, `Branch code "${code.trim()}" is already in use.`);
  }
}

function assertUniqueCampusCode(code: string, excludeId?: string): void {
  const normalized = code.trim().toUpperCase();
  const row = excludeId
    ? stmtCheckCampusCode.get(normalized, excludeId)
    : stmtCheckCampusCodeInsert.get(normalized);
  if (row) {
    throw new HttpError(409, `Campus code "${code.trim()}" is already in use.`);
  }
}

function canAccessCampusResource(req: import('express').Request, campusId: string): boolean {
  const context = req.rbac;
  if (!context) return false;
  if (isGlobalOwner(context)) return true;
  if (context.roles.some((role) =>
    role.scopeType === 'organization' || (role.scopeType === 'campus' && role.scopeId === campusId)
  )) return true;

  // A branch assignment also reaches its parent campus. Checking children is
  // necessary for that narrower assignment, but cannot be the only campus
  // test: a directly assigned, newly created campus has no branch yet.
  const branches = db.prepare('SELECT id FROM branches WHERE campus_id = ?').all(campusId) as Array<{ id: string }>;
  return branches.some((branch) => canAccessBranchResource(req, branch.id));
}

function requireCampusAccess(req: import('express').Request, campusId: string): void {
  if (!canAccessCampusResource(req, campusId)) {
    throw new HttpError(403, 'Campus is outside your access scope.');
  }
}

function requireBranchAccess(req: import('express').Request, branchId: string): void {
  if (!canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Branch is outside your access scope.');
  }
}

function requireActiveCampus(campusId: string): void {
  const campus = stmtGetCampusActiveState.get(campusId) as { id: string; is_active: number } | undefined;
  if (!campus) throw new HttpError(400, 'Campus not found.');
  if (!campus.is_active) {
    throw new HttpError(400, 'Cannot assign a branch to an inactive campus.');
  }
}

function assertPartnerName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'Partner name is required.');
  }
  return value.trim();
}

function assertPartnerShare(value: unknown): number {
  const share = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 100) {
    throw new HttpError(400, 'Partner share percent must be a finite number between 0 and 100.');
  }
  return share;
}

function assertPartnerShareTotal(share: number, excludeId?: string): void {
  const row = excludeId
    ? db.prepare('SELECT COALESCE(SUM(share_percent), 0) AS total FROM partners WHERE id <> ?').get(excludeId)
    : db.prepare('SELECT COALESCE(SUM(share_percent), 0) AS total FROM partners').get();
  const total = Number((row as { total: number }).total) + share;
  if (!Number.isFinite(total) || total > 100) {
    throw new HttpError(409, `Total partner shares cannot exceed 100% (proposed total: ${total}%).`);
  }
}

// ── Organization ───────────────────────────────────────────────────────────

export const organizationRouter = Router();
organizationRouter.use(authenticate);

organizationRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    ensureOrganization();
    const org = stmtGetOrg.get(FIXED_ORG_ID) as any;
    const global = !!req.rbac && isGlobalOwner(req.rbac);
    const visibleBranches = global
      ? (stmtGetAllBranches.all() as any[])
      : (stmtGetAllBranches.all() as any[]).filter((branch) => canAccessBranchResource(req, branch.id));
    const campusCount = global
      ? (stmtCountCampusesByOrg.get(FIXED_ORG_ID) as { c: number }).c
      : (stmtGetAllCampuses.all() as any[]).filter((campus) => canAccessCampusResource(req, campus.id)).length;
    const branchCount = global
      ? (stmtCountAllBranches.get() as { c: number }).c
      : visibleBranches.length;
    res.json({
      id: org.id,
      name: FIXED_ORG_NAME,
      campusCount,
      branchCount,
      createdAt: org.created_at,
    });
  })
);

// ── Campuses ───────────────────────────────────────────────────────────────

export const campusesRouter = Router();
campusesRouter.use(authenticate);

campusesRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    ensureOrganization();
    const activeOnly = req.query.active === 'true' || req.query.active === '1';
    let rows = (activeOnly ? stmtGetActiveCampuses.all() : stmtGetAllCampuses.all()) as any[];
    if (!req.rbac || !isGlobalOwner(req.rbac)) {
      rows = rows.filter((row) => canAccessCampusResource(req, row.id));
    }
    res.json(rows.map((row) => mapCampus(row, req)));
  })
);

campusesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const row = stmtGetCampusById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Campus not found.');
    requireCampusAccess(req, row.id);
    res.json(mapCampus(row, req));
  })
);

campusesRouter.post(
  '/',
  requireGlobalOwner,
  ah(async (req, res) => {
    ensureOrganization();
    const { name, code, address, postalCode, phone, email, description, isActive } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Campus name is required.');
    if (!code || typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'Campus code is required.');
    assertUniqueCampusCode(code);

    const newId = id('campus');
    stmtInsertCampus.run(
      newId, FIXED_ORG_ID, name.trim(), code.trim().toUpperCase(),
      address?.trim() || null, postalCode?.trim() || null, phone?.trim() || null,
      email?.trim() || null, description?.trim() || null,
      isActive === false || isActive === 0 ? 0 : 1
    );

    writeAudit(req, `Created campus: ${name.trim()} (${code.trim().toUpperCase()})`);
    const created = stmtGetCampusById.get(newId);
    res.status(201).json(mapCampus(created));
  })
);

campusesRouter.put(
  '/:id',
  requireGlobalOwner,
  ah(async (req, res) => {
    const existing = stmtGetCampusById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Campus not found.');

    const { name, code, address, postalCode, phone, email, description, isActive } = req.body ?? {};

    if (code !== undefined && code !== null) {
      if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'Campus code cannot be empty.');
      assertUniqueCampusCode(code, req.params.id);
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      throw new HttpError(400, 'Campus name cannot be empty.');
    }

    const nextActive = isActive === undefined ? existing.is_active : isActive === false || isActive === 0 ? 0 : 1;

    const updateCampus = db.transaction(() => {
      if (existing.is_active && !nextActive) {
        stmtDeactivateBranchesByCampus.run(req.params.id);
      }

      stmtUpdateCampus.run(
        name !== undefined ? name.trim() : existing.name,
        code !== undefined ? code.trim().toUpperCase() : existing.code,
        address !== undefined ? address?.trim() || null : existing.address,
        postalCode !== undefined ? postalCode?.trim() || null : existing.postal_code,
        phone !== undefined ? phone?.trim() || null : existing.phone,
        email !== undefined ? email?.trim() || null : existing.email,
        description !== undefined ? description?.trim() || null : existing.description,
        nextActive, req.params.id
      );
    });
    updateCampus();

    writeAudit(req, `Updated campus: ${existing.name}`);
    const updated = stmtGetCampusById.get(req.params.id);
    res.json(mapCampus(updated));
  })
);

campusesRouter.delete(
  '/:id',
  requireGlobalOwner,
  ah(async (req, res) => {
    const existing = stmtGetCampusById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Campus not found.');

    const permanent = req.query.permanent === 'true' || req.query.permanent === '1';

    if (!permanent) {
      db.transaction(() => {
        stmtDeactivateCampus.run(req.params.id);
        stmtDeactivateBranchesByCampus.run(req.params.id);
      })();
      writeAudit(req, `Deactivated campus: ${existing.name}`);
      res.json({ ok: true, deleted: false, isActive: false });
      return;
    }

    const depCount = countCampusBranchDependents(req.params.id);
    const childBranches = stmtGetBranchIdsByCampus.all(req.params.id) as Array<{ id: string }>;
    const branchCount = childBranches.length;

    if (depCount > 0) {
      throw new HttpError(409, `Cannot permanently delete campus "${existing.name}": ${depCount} operational record(s) still reference its branches. Deactivate it instead, or remove/reassign the related data first.`);
    }
    for (const branch of childBranches) requireEmptyBranchProvisioning(branch.id);

    // Safe permanent delete: empty branches and their zero-balance provisioning,
    // then the campus, all in one transaction.
    const deleteTx = db.transaction(() => {
      for (const branch of childBranches) deleteEmptyBranch(branch.id);
      stmtDeleteCampus.run(req.params.id);
    });
    
    deleteTx();
    writeAudit(req, `Permanently deleted campus: ${existing.name} (removed ${branchCount} empty branch(es))`);
    res.json({ ok: true, deleted: true, removedBranches: branchCount });
  })
);

// ── Branches ───────────────────────────────────────────────────────────────

export const branchesRouter = Router();
branchesRouter.use(authenticate);

branchesRouter.get(
  '/',
  denyPermissionless,
  ah(async (req, res) => {
    const activeOnly = req.query.active === 'true' || req.query.active === '1';
    const campusId = typeof req.query.campusId === 'string' ? req.query.campusId : null;
    
    // Fetch all and filter in JS (branches table is small, avoids dynamic SQL preparation)
    let rows = stmtGetAllBranches.all() as any[];
    if (!req.rbac || !isGlobalOwner(req.rbac)) {
      rows = rows.filter((r) => canAccessBranchResource(req, r.id));
    }
    
    if (activeOnly) {
      rows = rows.filter(r => r.is_active === 1);
    }
    if (campusId) {
      rows = rows.filter(r => r.campus_id === campusId);
    }
    
    res.json(rows.map(mapBranch));
  })
);

branchesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const row = stmtGetBranchById.get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Branch not found.');
    requireBranchAccess(req, row.id);
    res.json(mapBranch(row));
  })
);

branchesRouter.post(
  '/',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const { name, code, campusId, address, location, postalCode, phone, email, description, isActive } = req.body ?? {};

    if (!name || typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Branch name is required.');
    if (!code || typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'Branch code is required and must be unique.');
    if (!campusId || typeof campusId !== 'string') throw new HttpError(400, 'Campus is required.');

    assertUniqueBranchCode(code);
    requireActiveCampus(campusId);
    requireCampusAccess(req, campusId);

    const resolvedAddress = (address || location || '').trim();
    if (!resolvedAddress) throw new HttpError(400, 'Branch address is required.');

    const newId = id('br');
    // A branch is not operational without its cash account and required payroll
    // envelopes. Commit all three authorities together so a provisioning error
    // cannot leave a visible but unusable branch behind.
    db.transaction(() => {
      stmtInsertBranch.run(
        newId, campusId, name.trim(), code.trim().toUpperCase(), resolvedAddress, resolvedAddress,
        postalCode?.trim() || null, phone?.trim() || null, email?.trim() || null,
        description?.trim() || null, isActive === false || isActive === 0 ? 0 : 1
      );
      ensureFinanceAccount('branch', newId);
      ensureBranchBudgetLines(db, newId);
    })();

    writeAudit(req, `Created branch: ${name.trim()} (${code.trim().toUpperCase()})`);
    const created = stmtGetBranchById.get(newId);
    res.status(201).json(mapBranch(created));
  })
);

branchesRouter.put(
  '/:id',
  authorize('owner', 'general_manager'),
  ah(async (req, res) => {
    const existing = stmtGetBranchById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Branch not found.');
    requireBranchAccess(req, existing.id);

    const { name, code, campusId, address, location, postalCode, phone, email, description, isActive } = req.body ?? {};

    if (code !== undefined && code !== null) {
      if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'Branch code cannot be empty.');
      assertUniqueBranchCode(code, req.params.id);
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new HttpError(400, 'Branch name cannot be empty.');
    if (campusId !== undefined && campusId !== null) { requireActiveCampus(campusId); requireCampusAccess(req, campusId); }

    const resolvedAddress = address !== undefined
      ? address?.trim() || null
      : location !== undefined
        ? location?.trim() || null
        : existing.address ?? existing.location;

    stmtUpdateBranch.run(
      campusId !== undefined ? campusId : existing.campus_id,
      name !== undefined ? name.trim() : existing.name,
      code !== undefined ? code.trim().toUpperCase() : existing.code,
      resolvedAddress || existing.location || '',
      resolvedAddress,
      postalCode !== undefined ? postalCode?.trim() || null : existing.postal_code,
      phone !== undefined ? phone?.trim() || null : existing.phone,
      email !== undefined ? email?.trim() || null : existing.email,
      description !== undefined ? description?.trim() || null : existing.description,
      isActive === undefined ? existing.is_active : isActive === false || isActive === 0 ? 0 : 1,
      req.params.id
    );

    writeAudit(req, `Updated branch: ${existing.name}`);
    const updated = stmtGetBranchById.get(req.params.id);
    res.json(mapBranch(updated));
  })
);

branchesRouter.delete(
  '/:id',
  authorize('owner'),
  ah(async (req, res) => {
    const existing = stmtGetBranchById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Branch not found.');
    requireBranchAccess(req, existing.id);

    const permanent = req.query.permanent === 'true' || req.query.permanent === '1';

    if (!permanent) {
      stmtDeactivateBranch.run(req.params.id);
      writeAudit(req, `Deactivated branch: ${existing.name}`);
      res.json({ ok: true, deleted: false, isActive: false });
      return;
    }

    const deps = countBranchDependents(req.params.id);
    if (deps.length > 0) {
      const summary = deps.map((d) => `${d.table}: ${d.count}`).join(', ');
      throw new HttpError(409, `Cannot permanently delete branch "${existing.name}": operational data still references it (${summary}). Deactivate it instead, or reassign/remove the related records first.`);
    }

    requireEmptyBranchProvisioning(req.params.id);
    db.transaction(() => deleteEmptyBranch(req.params.id))();

    writeAudit(req, `Permanently deleted branch: ${existing.name}`);
    res.json({ ok: true, deleted: true });
  })
);

export const partnersRouter = Router();
partnersRouter.use(authenticate);

partnersRouter.get(
  '/',
  authorize('general_manager'),
  ah(async (_req, res) => {
    res.json(stmtGetAllPartners.all());
  })
);

partnersRouter.post(
  '/',
  requireGlobalOwner,
  ah(async (req, res) => {
    const { fullName, phone, email, sharePercent, roleDescription } = req.body ?? {};
    const normalizedName = assertPartnerName(fullName);
    const normalizedShare = assertPartnerShare(sharePercent);
    assertPartnerShareTotal(normalizedShare);

    const newId = id('ptn');
    stmtInsertPartner.run(newId, normalizedName, phone || null, email || null, normalizedShare, roleDescription || null);
    writeAudit(req, `Added partner: ${normalizedName} (${normalizedShare}%)`);
    res.status(201).json({ id: newId });
  })
);

partnersRouter.put(
  '/:id',
  requireGlobalOwner,
  ah(async (req, res) => {
    const existing = stmtGetPartnerById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Partner not found.');

    const { fullName, phone, email, sharePercent, roleDescription } = req.body ?? {};
    const normalizedName = fullName === undefined ? existing.full_name : assertPartnerName(fullName);
    const normalizedShare = sharePercent === undefined ? existing.share_percent : assertPartnerShare(sharePercent);
    assertPartnerShareTotal(normalizedShare, req.params.id);
    stmtUpdatePartner.run(
      normalizedName,
      phone ?? existing.phone,
      email ?? existing.email,
      normalizedShare,
      roleDescription ?? existing.role_description,
      req.params.id
    );
    writeAudit(req, `Updated partner: ${existing.full_name}`);
    res.json({ ok: true });
  })
);

partnersRouter.delete(
  '/:id',
  requireGlobalOwner,
  ah(async (req, res) => {
    const existing = stmtGetPartnerById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Partner not found.');
    
    stmtDeletePartner.run(req.params.id);
    writeAudit(req, `Deleted partner: ${existing.full_name}`);
    res.json({ ok: true });
  })
);

export default branchesRouter;