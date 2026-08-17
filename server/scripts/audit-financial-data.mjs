#!/usr/bin/env node
/**
 * Read-only audit of stored financial values.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several money fields reached the database before they were validated, so an
 * existing installation can hold values that the current code would refuse:
 * the literal string 'abc' in a price column, NULL where an amount is
 * required, negatives, sub-cent fractions, and figures beyond safe monetary
 * precision. The entry points are now closed (every financial input goes
 * through `assertMoney`) and migration 069 adds database-level sign guards,
 * but neither of those rewrites history — deliberately. Silently "correcting"
 * a financial record destroys the evidence of what actually happened.
 *
 * This script therefore only LOOKS. It never writes, never migrates, and never
 * deletes. Run it against a production copy before go-live to find out whether
 * any repair is needed and, if so, exactly which rows a human must decide on.
 *
 *   node scripts/audit-financial-data.mjs [path/to/erp.sqlite]
 *
 * Exit code 0 = clean, 1 = suspect rows found (so CI or a deploy script can
 * gate on it).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';

const dbPath = process.argv[2] || process.env.DB_PATH || path.join('data', 'erp.sqlite');

/** table -> columns that hold money and must never be corrupt. */
const MONEY_COLUMNS = {
  payments: ['amount'],
  financial_transactions: ['amount'],
  finance_accounts: ['main_balance', 'saving_balance'],
  invoices: ['total_amount', 'discount_amount', 'net_amount'],
  invoice_items: ['unit_price', 'amount'],
  book_sales: ['total_amount', 'discount_amount', 'net_amount'],
  books: ['price', 'purchase_price'],
  book_restock_history: ['price', 'purchase_price'],
  student_semesters: ['fee_amount', 'net_fee_amount'],
  teacher_salary_ledger: ['due_amount', 'paid_amount'],
  teachers: ['base_salary', 'default_skill_rate'],
  employees: ['base_salary'],
  budget_lines: ['current_amount', 'allocated_amount'],
  levels: ['default_fee'],
  classes: ['fee'],
  exams: ['fee'],
  scholarships: ['total_budget', 'allocated_amount'],
  scholarship_awards: ['amount'],
  funding_campaigns: ['target_amount'],
  donations: ['amount'],
  sponsorship_agreements: ['monthly_amount'],
  expense_requests: ['amount'],
};

/** Columns where a negative value is legitimate (contra rows, adjustments). */
const NEGATIVE_ALLOWED = new Set(['payments.amount', 'financial_transactions.amount']);

const db = new Database(dbPath, { readonly: true });
const tableExists = (t) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
const columnExists = (t, c) =>
  db.prepare(`PRAGMA table_info("${t}")`).all().some((r) => r.name === c);

const findings = [];
let checkedColumns = 0;
let checkedRows = 0;

for (const [table, columns] of Object.entries(MONEY_COLUMNS)) {
  if (!tableExists(table)) continue;
  const rowCount = db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c;
  for (const col of columns) {
    if (!columnExists(table, col)) continue;
    checkedColumns += 1;
    checkedRows += rowCount;
    const key = `${table}.${col}`;

    // Non-numeric storage: SQLite is dynamically typed, so a TEXT price is
    // possible even in a REAL column. This is the 'abc' case.
    const nonNumeric = db.prepare(
      `SELECT COUNT(*) c FROM "${table}" WHERE "${col}" IS NOT NULL AND typeof("${col}") NOT IN ('integer','real')`
    ).get().c;
    if (nonNumeric) findings.push({ key, issue: 'non-numeric value stored', count: nonNumeric, severity: 'CRITICAL' });

    const nulls = db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" IS NULL`).get().c;
    if (nulls) findings.push({ key, issue: 'NULL amount', count: nulls, severity: 'HIGH' });

    if (!NEGATIVE_ALLOWED.has(key)) {
      const negative = db.prepare(
        `SELECT COUNT(*) c FROM "${table}" WHERE typeof("${col}") IN ('integer','real') AND "${col}" < 0`
      ).get().c;
      if (negative) findings.push({ key, issue: 'negative amount', count: negative, severity: 'HIGH' });
    }

    // Sub-cent precision: a value that is not equal to itself rounded to 2dp.
    const subCent = db.prepare(
      `SELECT COUNT(*) c FROM "${table}"
       WHERE typeof("${col}") IN ('integer','real') AND ABS("${col}" - ROUND("${col}", 2)) > 0.0000001`
    ).get().c;
    if (subCent) findings.push({ key, issue: 'more than two decimal places', count: subCent, severity: 'MEDIUM' });

    // Beyond safe monetary precision (cents must stay a safe integer).
    const tooLarge = db.prepare(
      `SELECT COUNT(*) c FROM "${table}"
       WHERE typeof("${col}") IN ('integer','real') AND ABS("${col}") > 90000000000`
    ).get().c;
    if (tooLarge) findings.push({ key, issue: 'exceeds supported monetary precision', count: tooLarge, severity: 'HIGH' });
  }
}

console.log('Financial data audit (READ-ONLY — nothing was modified)');
console.log(`  database : ${dbPath}`);
console.log(`  columns  : ${checkedColumns} money columns inspected`);
console.log(`  rows     : ${checkedRows} column-rows scanned`);
console.log('');

if (findings.length === 0) {
  console.log('  RESULT: clean — no corrupt monetary values found.');
  db.close();
  process.exit(0);
}

const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
console.log(`  RESULT: ${findings.length} issue group(s) found. A HUMAN must decide on each —`);
console.log('  this script does not repair anything, by design.');
console.log('');
for (const f of findings) {
  console.log(`  [${f.severity.padEnd(8)}] ${f.key.padEnd(42)} ${String(f.count).padStart(6)} row(s)  ${f.issue}`);
}
db.close();
process.exit(1);
