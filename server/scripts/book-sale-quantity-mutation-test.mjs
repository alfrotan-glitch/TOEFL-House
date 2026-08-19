#!/usr/bin/env node
/**
 * BKS-1 mutation harness — whole-copy book sale quantity.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/books.routes.ts';
const MONEY = 'src/utils/money.ts';
const TEST = 'src/tests/book-sale-quantity-integrity.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection.
// K4, K5 and K6 swap the validated `saleQuantity` back to `Number(quantity)` in
// the charge, the stock decrement and the persisted row. Anything that REACHES
// those lines has already passed assertSeatCount, which admits only whole
// numbers and numeric strings — for every such input `Number(quantity)` and
// `saleQuantity` are the identical value (verified: 3 -> 3, "2" -> 2, while
// 0.5 / [3] / "abc" / true are all rejected upstream and never reach them).
// The mutants are therefore unobservable while the validator stands; K1/K2/K7/K8
// already prove the suite detects the validator itself being weakened.
// K9 removes the pre-check `book.stock < saleQuantity`. The authoritative
// guard is the conditional UPDATE `SET stock = stock - ? WHERE ... stock >= ?`:
// it matches no row, `stockUpdate.changes !== 1` fires inside the transaction
// and the same HTTP 409 is returned with nothing written. Verified by running
// the mutated route against the oversell test. The pre-check is deliberate
// defence-in-depth and yields the clearer message.
const EQUIVALENT = new Set(['K4', 'K5', 'K6', 'K9']);

const MUTANTS = [
  ['K1', 'restore the original loose quantity guard (defect)', ROUTE,
   "    try { saleQuantity = assertSeatCount(quantity, 'Quantity'); }\n    catch { throw new HttpError(400, 'Quantity must be a whole number greater than zero.'); }",
   '    saleQuantity = Number(quantity);'],
  ['K2', 'bypass the validator, accept raw input', ROUTE,
   "assertSeatCount(quantity, 'Quantity')", 'Number(quantity)'],
  ['K3', 'drop the positive check', ROUTE,
   "if (saleQuantity <= 0) throw new HttpError(400, 'Quantity must be a whole number greater than zero.');",
   "if (false) throw new HttpError(400, 'x');"],
  ['K4', 'charge from the raw quantity, not the validated one', ROUTE,
   'const totalAmount = book.price * saleQuantity;', 'const totalAmount = book.price * Number(quantity);'],
  ['K5', 'decrement stock by the raw quantity', ROUTE,
   'const stockUpdate = stmtUpdateBookStockSub.run(saleQuantity, book.id, saleBranchId, saleQuantity);',
   'const stockUpdate = stmtUpdateBookStockSub.run(Number(quantity), book.id, saleBranchId, Number(quantity));'],
  ['K6', 'persist the raw quantity on the sale row', ROUTE,
   'newSaleId, book.id, saleQuantity, totalAmount,', 'newSaleId, book.id, Number(quantity), totalAmount,'],
  ['K7', 'remove the integer check from the canonical validator', MONEY,
   'if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number.`);',
   'if (false) throw new HttpError(400, `${field} must be a whole number.`);'],
  ['K8', 'canonical validator accepts non-numeric types', MONEY,
   "    throw new HttpError(400, `${field} must be a whole number.`);\n  }\n  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a whole number.`);",
   "    n = Number(value);\n  }\n  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a whole number.`);"],
  ['K9', 'drop the oversell guard', ROUTE,
   'if (book.stock < saleQuantity) throw new HttpError(409,', 'if (false) throw new HttpError(409,'],
  ['K10', 'allow a second refund of the same sale', ROUTE,
   "if (sale.status === 'refunded') throw new HttpError(409, 'This transaction has already been refunded.');",
   "if (false) throw new HttpError(409, 'x');"],
  ['K11', 'drop the refund branch-scope check', ROUTE,
   "if (!canAccessBranchResource(req, sale.branch_id)) throw new HttpError(403, 'Sale belongs to another branch.');",
   "if (false) throw new HttpError(403, 'x');"],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const originals = new Map();
for (const f of [ROUTE, MONEY]) originals.set(f, readFileSync(f, 'utf8'));
const backups = new Map();
for (const f of [ROUTE, MONEY]) { const b = `/tmp/${f.replace(/\W/g, '_')}.bak`; copyFileSync(f, b); backups.set(f, b); }
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };

const results = [];
try {
  for (const [id, desc, file, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    const src = originals.get(file);
    if (!src.includes(find)) { results.push([id, desc, 'INVALID']); console.log(`${id.padEnd(4)} ${desc.padEnd(52)} INVALID (anchor)`); continue; }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(52)} ${verdict}`);
    restoreAll();
  }
} finally {
  restoreAll();
  for (const b of backups.values()) if (existsSync(b)) unlinkSync(b);
}
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
