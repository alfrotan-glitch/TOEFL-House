import { assertMoney } from './money.js';
import type Database from 'better-sqlite3';

let financeDb: Database.Database | null = null;

export function setFinanceAccountsDatabase(database: Database.Database): void {
  financeDb = database;
}

function getDb(): Database.Database {
  if (!financeDb) throw new Error('Finance account database has not been initialized.');
  return financeDb;
}

export type FinanceAccountScope = 'organization' | 'branch';

function statements(database: Database.Database) {
  return {
    stmtEnsure: database.prepare(`INSERT INTO finance_accounts (id, scope_type, scope_id, main_balance, saving_balance)
      VALUES (?, ?, ?, 0, 0)
      ON CONFLICT(scope_type, scope_id) DO NOTHING`),
    stmtGet: database.prepare(`SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type = ? AND scope_id = ?`),
    stmtIncrementMain: database.prepare(`UPDATE finance_accounts SET main_balance = main_balance + ?, updated_at = datetime('now')
      WHERE scope_type = ? AND scope_id = ?`),
    stmtIncrementSaving: database.prepare(`UPDATE finance_accounts SET saving_balance = saving_balance + ?, updated_at = datetime('now')
      WHERE scope_type = ? AND scope_id = ?`),
    stmtDecrementMainIfSufficient: database.prepare(`UPDATE finance_accounts SET main_balance = main_balance - ?, updated_at = datetime('now')
      WHERE scope_type = ? AND scope_id = ? AND main_balance >= ?`),
    stmtDecrementSavingIfSufficient: database.prepare(`UPDATE finance_accounts SET saving_balance = saving_balance - ?, updated_at = datetime('now')
      WHERE scope_type = ? AND scope_id = ? AND saving_balance >= ?`)
  };
}

function keyFor(scope: FinanceAccountScope, scopeId: string) {
  return `${scope}:${scopeId}`;
}

export function ensureFinanceAccount(scope: FinanceAccountScope, scopeId: string): void {
  const { stmtEnsure } = statements(getDb());
  stmtEnsure.run(keyFor(scope, scopeId), scope, scopeId);
}

export function getFinanceAccount(scope: FinanceAccountScope, scopeId: string) {
  ensureFinanceAccount(scope, scopeId);
  const { stmtGet } = statements(getDb());
  const row = stmtGet.get(scope, scopeId) as { main_balance: number; saving_balance: number };
  return {
    mainBalance: Number(row.main_balance || 0),
    savingBalance: Number(row.saving_balance || 0),
  };
}

export function incrementMainBalance(scope: FinanceAccountScope, scopeId: string, amount: number): void {
  amount = assertMoney(amount, 'main account adjustment');
  ensureFinanceAccount(scope, scopeId);
  const { stmtIncrementMain } = statements(getDb());
  const result = stmtIncrementMain.run(amount, scope, scopeId);
  if (result.changes !== 1) throw new Error('Finance account not found.');
}

export function incrementSavingBalance(scope: FinanceAccountScope, scopeId: string, amount: number): void {
  amount = assertMoney(amount, 'saving account adjustment');
  ensureFinanceAccount(scope, scopeId);
  const { stmtIncrementSaving } = statements(getDb());
  const result = stmtIncrementSaving.run(amount, scope, scopeId);
  if (result.changes !== 1) throw new Error('Finance account not found.');
}

export function decrementMainBalanceIfSufficient(scope: FinanceAccountScope, scopeId: string, amount: number): boolean {
  amount = assertMoney(amount, 'main account debit');
  if (amount <= 0) return false;
  ensureFinanceAccount(scope, scopeId);
  const { stmtDecrementMainIfSufficient } = statements(getDb());
  return stmtDecrementMainIfSufficient.run(amount, scope, scopeId, amount).changes === 1;
}

/**
 * Debits the saving account only if it fully covers the amount, in one
 * conditional UPDATE. Used when a reversal must reclaim money that the
 * automatic savings sweep moved out of main — see recordIncome().
 */
export function decrementSavingBalanceIfSufficient(scope: FinanceAccountScope, scopeId: string, amount: number): boolean {
  amount = assertMoney(amount, 'saving account debit');
  if (amount <= 0) return false;
  ensureFinanceAccount(scope, scopeId);
  const { stmtDecrementSavingIfSufficient } = statements(getDb());
  return stmtDecrementSavingIfSufficient.run(amount, scope, scopeId, amount).changes === 1;
}

