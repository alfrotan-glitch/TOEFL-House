import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import { getFinanceAccount, incrementMainBalance, incrementSavingBalance, decrementMainBalanceIfSufficient } from '../utils/financeAccounts.js';

describe('Finance Grand Audit invariants', () => {
  it('keeps branch cash isolated', () => {
    const a = 'finance_audit_branch_a';
    const b = 'finance_audit_branch_b';
    db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)").run(a, 'Finance Audit A', 'A');
    db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)").run(b, 'Finance Audit B', 'B');
    incrementMainBalance('branch', a, 1000);
    incrementSavingBalance('branch', a, 100);
    expect(getFinanceAccount('branch', a).mainBalance).toBe(1000);
    expect(getFinanceAccount('branch', b).mainBalance).toBe(0);
    expect(getFinanceAccount('branch', b).savingBalance).toBe(0);
  });

  it('prevents branch cash from going negative', () => {
    const a = 'finance_audit_branch_cash';
    db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)").run(a, 'Finance Cash A', 'A');
    expect(decrementMainBalanceIfSufficient('branch', a, 1)).toBe(false);
  });
});
