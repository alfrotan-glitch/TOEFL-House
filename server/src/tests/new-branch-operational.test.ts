/**
 * A newly created branch must be operational immediately — no restart.
 * ============================================================================
 * DEFECT CLASS: setup work that only happens at boot, while the thing it sets
 * up can be created at runtime.
 *
 * Budget lines were provisioned solely by `ensureBudgetLineCatalog()`, which
 * runs during application bootstrap. A branch created through
 * `POST /api/branches` therefore got its finance account and savings account
 * but **no budget lines at all** until someone restarted the server, and
 * payroll answered 500 "…budget line is not configured".
 *
 * Fixed at the correct layer: the single-branch provisioning step is exported
 * and called by branch creation.
 *
 * WHAT PROVISIONING MEANS NOW
 * ---------------------------
 * Exactly TWO envelopes: the teacher and employee payroll budgets. They are a
 * structural requirement — payroll cannot debit an envelope that does not
 * exist. Everything else is created deliberately through
 * `POST /finance/budget-lines`, because the taxonomy being complete does not
 * mean every branch funds all forty-five subcategories.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';

const routesDir = path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes');
const branchRouteSource = fs.readFileSync(path.join(routesDir, 'branches.routes.ts'), 'utf8');

const PAYROLL_TARGETS_REQUIRED = ['teacher', 'employee'];

function createBranchRow(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO branches (id, campus_id, name, code, location, address, is_active)
     VALUES (?, (SELECT id FROM campuses LIMIT 1), ?, ?, 'Kabul', 'Kabul', 1)`
  ).run(id, `Branch ${id}`, `C-${id.slice(-6)}`);
}

const lineCount = (branchId: string) =>
  (db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get(branchId) as { c: number }).c;

beforeAll(() => {
  db.prepare("INSERT OR IGNORE INTO campuses (id, name, code) VALUES ('camp_t','T','C-T')").run();
});

describe('a new branch is financially operational without a restart', () => {
  it('provisioning creates the payroll envelopes and NOTHING else', () => {
    const branchId = 'br_test_provision';
    createBranchRow(branchId);
    expect(lineCount(branchId)).toBe(0);

    ensureBranchBudgetLines(db, branchId);

    // Exactly two. A branch must not be born owning forty-five zero-value
    // envelopes for spend it may never make.
    expect(lineCount(branchId)).toBe(2);
  });

  it('provisions the envelopes payroll actually resolves against', () => {
    const branchId = 'br_test_payroll_targets';
    createBranchRow(branchId);
    ensureBranchBudgetLines(db, branchId);

    for (const target of PAYROLL_TARGETS_REQUIRED) {
      const row = db.prepare(
        'SELECT id, category_id FROM budget_lines WHERE branch_id = ? AND payroll_target = ?',
      ).get(branchId, target) as { id: string; category_id: string } | undefined;
      // Absence of the teacher envelope is what produced
      // "Teacher payroll budget line is not configured for this branch."
      expect(row, `missing payroll envelope for ${target}`).toBeDefined();
      // Both sit under Salaries & Wages while remaining separate budgets.
      expect(row!.category_id).toBe('sub_salaries_wages');
    }
  });

  it('keeps teacher and employee payroll budgets separate', () => {
    const branchId = 'br_test_separate_payroll';
    createBranchRow(branchId);
    ensureBranchBudgetLines(db, branchId);
    const ids = (db.prepare('SELECT id FROM budget_lines WHERE branch_id = ?').all(branchId) as Array<{ id: string }>)
      .map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a second payroll envelope of the same kind for one branch', () => {
    const branchId = 'br_test_payroll_unique';
    createBranchRow(branchId);
    ensureBranchBudgetLines(db, branchId);
    expect(() =>
      db.prepare(
        `INSERT INTO budget_lines (id, name, branch_id, category_id, payroll_target)
         VALUES ('bl_dupe_payroll', 'Second teacher payroll', ?, 'sub_salaries_wages', 'teacher')`,
      ).run(branchId),
    ).toThrow();
  });

  it('is idempotent — provisioning twice does not duplicate lines', () => {
    const branchId = 'br_test_idempotent';
    createBranchRow(branchId);
    ensureBranchBudgetLines(db, branchId);
    const first = lineCount(branchId);
    ensureBranchBudgetLines(db, branchId);
    expect(lineCount(branchId)).toBe(first);
  });

  it('provisions each branch independently, with zero balances', () => {
    const a = 'br_test_iso_a';
    const b = 'br_test_iso_b';
    createBranchRow(a);
    createBranchRow(b);
    ensureBranchBudgetLines(db, a);

    // Provisioning A must not create lines for B.
    expect(lineCount(b)).toBe(0);
    ensureBranchBudgetLines(db, b);
    expect(lineCount(b)).toBe(lineCount(a));

    // A brand-new branch starts with no money allocated anywhere.
    const funded = db.prepare(
      'SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND (current_amount <> 0 OR allocated_amount <> 0)'
    ).get(a) as { c: number };
    expect(funded.c).toBe(0);
  });

  it('the branch creation route provisions budget lines itself', () => {
    // Pins the wiring: without this call the route regresses to boot-only
    // provisioning and the branch is unusable until a restart.
    expect(branchRouteSource).toContain('ensureBranchBudgetLines(db, newId)');
  });
});
