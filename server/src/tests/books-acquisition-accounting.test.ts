import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from './support/identity.js';
import { createBooksTestApp, ensureBookBranch } from './support/books.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { getFinanceAccount, incrementMainBalance } from '../utils/financeAccounts.js';
import { postBudgetMovement } from '../core/finance/budget-movements.js';
import { id, today } from '../utils/ids.js';

/**
 * W6-1 — acquisition accounting for Book stock (forensic wave 6).
 *
 * Before this, a receipt carrying unit_cost was financially invisible: no
 * expense, no cash movement, while the eventual sale booked full-price income.
 * The P&L therefore reported a 100% book margin forever, and no invariant
 * could see it because conservation compares the ledger to itself. These
 * tests pin the new boundary: costly stock cannot arrive silently.
 */
const BRANCH = 'wp_w6_books';
const OWNER = 'wp_w6_books_owner';
const app = createBooksTestApp();
const owner = () => bearerFor(OWNER);
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/**
 * A funded budget line for book purchases, funded through the PRODUCTION
 * writer sequence (capital injection row + treasury credit + guarded
 * allocation movement) — never a direct balance INSERT, which I16 exists to
 * catch as unexplained money.
 */
function fundedBookLine(current: number): string {
  const lineId = unique('bl');
  const lineName = `Books ${lineId.slice(-6)}`;
  db.prepare(`
    INSERT INTO budget_lines
      (id, name, cost_type, category_id, branch_id, is_active, current_amount, allocated_amount, payroll_target, sort_order)
    VALUES (?, ?, 'variable', 'sub_books_educational', ?, 1, 0, 0, NULL, 50)
  `).run(lineId, lineName, BRANCH);
  if (current > 0) {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO financial_transactions
          (id, type, category, amount, date, description, operator_name, branch_id)
        VALUES (?, 'income', 'capital_injection', ?, ?, 'W6 test capital', 'audit harness', ?)
      `).run(id('tx'), current, today(), BRANCH);
      incrementMainBalance('organization', 'global', current);
      const debited = db.prepare("UPDATE finance_accounts SET main_balance = main_balance - ? WHERE scope_type = 'organization' AND scope_id = 'global' AND main_balance >= ?")
        .run(current, current);
      if (debited.changes !== 1) throw new Error('test harness: org treasury underfunded');
      postBudgetMovement({
        line: { id: lineId, name: lineName, branch_id: BRANCH },
        kind: 'allocation', amount: current, date: today(),
        description: 'W6 test allocation', operatorName: 'audit harness',
      });
    })();
  }
  return lineId;
}

function budgetLineBalance(lineId: string): number {
  return Number((db.prepare('SELECT current_amount AS c FROM budget_lines WHERE id = ?').get(lineId) as { c: number }).c);
}

async function createCostlyCatalog(input: { unitCost: number; quantity: number; purchase?: unknown }) {
  return supertest(app)
    .post('/api/books/catalog')
    .set(owner())
    .set('Idempotency-Key', unique('catalog'))
    .send({
      title: unique('W6 Book'),
      itemKind: 'book',
      saleEnabled: true,
      salePrice: 900,
      lendingEnabled: true,
      initialQuantity: input.quantity,
      unitCost: input.unitCost,
      branchId: BRANCH,
      purchase: input.purchase,
    });
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  ensureBookBranch(db, { campusId: 'wp_w6_campus', branchId: BRANCH });
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });
});

describe('W6-1 · Book acquisition accounting', () => {
  it('refuses a costly receipt that does not declare how the purchase is paid', async () => {
    const silent = await createCostlyCatalog({ unitCost: 300, quantity: 10, purchase: undefined });
    expect(silent.status).toBe(400);
    expect(String(silent.body.error)).toContain('acquisition cost');
    // Nothing may exist from the refused command — neither book nor receipt.
    expect(db.prepare('SELECT COUNT(*) AS n FROM books WHERE branch_id = ?').get(BRANCH)).toMatchObject({ n: 0 });
  });

  it('pays from a budget line atomically: guarded debit, expense row, receipt — or nothing', async () => {
    const lineId = fundedBookLine(5_000);
    const created = await createCostlyCatalog({ unitCost: 300, quantity: 10, purchase: { paidFromBudgetLineId: lineId } });
    expect(created.status).toBe(201);
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));

    // The envelope was debited by exactly the acquisition cost.
    expect(budgetLineBalance(lineId)).toBe(5_000 - 3_000);

    // The receipt carries its paying transaction, and that transaction is a
    // classified operating expense referencing the receipt.
    const receipt = db.prepare('SELECT id, purchase_declaration, purchase_transaction_id FROM book_stock_receipts WHERE branch_id = ?').get(BRANCH) as { id: string; purchase_declaration: string | null; purchase_transaction_id: string | null };
    expect(receipt.purchase_declaration).toBeNull();
    expect(receipt.purchase_transaction_id).not.toBeNull();
    const tx = db.prepare('SELECT type, category, finance_category_id, amount, reference_id FROM financial_transactions WHERE id = ?').get(receipt.purchase_transaction_id) as { type: string; category: string; finance_category_id: string; amount: number; reference_id: string };
    expect(tx).toMatchObject({ type: 'expense', category: 'book_purchase', finance_category_id: 'sub_books_educational', amount: 3_000, reference_id: receipt.id });

    // Insufficient envelope: refused, and NOTHING committed (book, receipt,
    // transaction — the whole atomic fact or none of it).
    const before = (db.prepare('SELECT COUNT(*) AS n FROM book_stock_receipts WHERE branch_id = ?').get(BRANCH) as { n: number }).n;
    const tooPoor = await createCostlyCatalog({ unitCost: 300, quantity: 50, purchase: { paidFromBudgetLineId: lineId } });
    expect(tooPoor.status).toBe(409);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM book_stock_receipts WHERE branch_id = ?').get(BRANCH) as { n: number }).n;
    expect(after).toBe(before);
    expect(budgetLineBalance(lineId)).toBe(2_000);

    // A retried identical command replays idempotently and never double-charges.
    const replayKey = unique('replay');
    const replayTitle = unique('W6 Replay');
    const replayBody = { title: replayTitle, itemKind: 'book', saleEnabled: true, salePrice: 900, lendingEnabled: true, initialQuantity: 5, unitCost: 100, branchId: BRANCH, purchase: { paidFromBudgetLineId: lineId } };
    const first = await supertest(app).post('/api/books/catalog').set(owner()).set('Idempotency-Key', replayKey).send(replayBody);
    expect(first.status).toBe(201);
    const balanceAfterFirst = budgetLineBalance(lineId);
    const second = await supertest(app).post('/api/books/catalog').set(owner()).set('Idempotency-Key', replayKey).send(replayBody);
    expect(second.status).toBe(200);
    expect(budgetLineBalance(lineId)).toBe(balanceAfterFirst);
  });

  it('accepts explicit declarations without moving money, and persists them', async () => {
    const lineId = fundedBookLine(1_000);
    const before = budgetLineBalance(lineId);
    const separate = await createCostlyCatalog({ unitCost: 250, quantity: 2, purchase: { declaration: 'separate' } });
    expect(separate.status).toBe(201);
    const notApplicable = await createCostlyCatalog({ unitCost: 250, quantity: 4, purchase: { declaration: 'not-applicable' } });
    expect(notApplicable.status).toBe(201);
    expect(budgetLineBalance(lineId)).toBe(before); // no money moved
    const declarations = db.prepare("SELECT purchase_declaration FROM book_stock_receipts WHERE branch_id = ? AND purchase_declaration IS NOT NULL ORDER BY created_at").all(BRANCH) as Array<{ purchase_declaration: string }>;
    expect(declarations.map((d) => d.purchase_declaration)).toContain('separate');
    expect(declarations.map((d) => d.purchase_declaration)).toContain('not-applicable');
    // Contradictory input is refused.
    const both = await createCostlyCatalog({ unitCost: 100, quantity: 1, purchase: { paidFromBudgetLineId: lineId, declaration: 'separate' } });
    expect(both.status).toBe(400);
  });

  it('free stock needs no declaration', async () => {
    const free = await createCostlyCatalog({ unitCost: 0, quantity: 3, purchase: undefined });
    expect(free.status).toBe(201);
  });

  it('I16 conservation sees a store/ledger divergence even along agreed classifications', async () => {
    // Ensure this branch actually has an account row to tamper with.
    getFinanceAccount('branch', BRANCH);
    // Baseline: the world above is internally consistent.
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I16')).toEqual([]);

    // Direct tamper: credit a branch account without a ledger row. Every
    // category in sight stays perfectly classified — only raw flows disagree.
    db.prepare("UPDATE finance_accounts SET main_balance = main_balance + 500 WHERE scope_type = 'branch' AND scope_id = ?").run(BRANCH);
    const findings = runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I16');
    expect(findings).toHaveLength(1);
    expect(String(findings[0].sample)).toContain('external flows explain');

    // Restore: the checker returns to silence.
    db.prepare("UPDATE finance_accounts SET main_balance = main_balance - 500 WHERE scope_type = 'branch' AND scope_id = ?").run(BRANCH);
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I16')).toEqual([]);
  });
});
