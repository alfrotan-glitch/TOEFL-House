/**
 * A newly created branch must be operational immediately — no restart.
 * ============================================================================
 * DEFECT CLASS: setup work that only happens at boot, while the thing it sets
 * up can be created at runtime.
 *
 * Default budget lines were provisioned solely by `ensureBudgetLineCatalog()`,
 * which runs during application bootstrap. A branch created through
 * `POST /api/branches` therefore got its finance account and savings account
 * but **no budget lines at all** until someone restarted the server.
 *
 * Reproduced against the live API on a greenfield database:
 *
 *     POST /api/branches            -> 201, finance_accounts row created
 *     GET  /finance/budget-lines    -> 0 lines
 *     POST /teachers/:id/pay-salary -> 409 "Teacher salary budget line is not configured."
 *     (restart the server)
 *     GET  /finance/budget-lines    -> 17 lines
 *
 * The branch looked healthy — it accepted students and payments — but payroll
 * and every expense were silently impossible. On a greenfield deployment,
 * where creating the second branch is a day-one action, that is a live
 * blocker rather than a theoretical one.
 *
 * Fixed at the correct layer: the single-branch provisioning step is exported
 * and called by branch creation, rather than duplicating the catalogue or
 * asking operators to restart.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';

const routesDir = path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes');
const branchRouteSource = fs.readFileSync(path.join(routesDir, 'branches.routes.ts'), 'utf8');

const PURPOSES_REQUIRED = ['teacher_salary', 'employee_salary', 'rent'];

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
  it('provisioning creates the full default budget-line catalogue', () => {
    const branchId = 'br_test_provision';
    createBranchRow(branchId);
    expect(lineCount(branchId)).toBe(0);

    ensureBranchBudgetLines(db, branchId);

    // The exact count is the catalogue size; asserting > 0 would pass even if
    // only one line were created.
    expect(lineCount(branchId)).toBeGreaterThanOrEqual(17);
  });

  it('provisions the purposes payroll and expenses actually look up', () => {
    const branchId = 'br_test_purposes';
    createBranchRow(branchId);
    ensureBranchBudgetLines(db, branchId);

    for (const purpose of PURPOSES_REQUIRED) {
      const row = db.prepare('SELECT id FROM budget_lines WHERE branch_id = ? AND purpose = ?')
        .get(branchId, purpose);
      // teacher_salary is the one whose absence produced
      // "Teacher salary budget line is not configured."
      expect(row, `missing budget line for purpose ${purpose}`).toBeDefined();
    }
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
