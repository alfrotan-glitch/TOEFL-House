import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { signToken, verifyToken } from '../../../utils/auth.js';

describe('high-assurance security invariants', () => {
  it('issues and verifies a session-versioned token', () => {
    const token = signToken({ userId: 'u1', username: 'test', branchId: 'b1', fullName: 'Test' });
    expect(verifyToken(token)?.sessionVersion).toBe(1);
  });

  it('has high-assurance branch guards installed', () => {
    const names = [
      'trg_enrollments_branch_guard',
      'trg_invoices_branch_guard',
      'trg_payments_branch_guard',
      'trg_book_sales_branch_guard',
      'trg_waitlist_branch_guard',
    ];
    const placeholders = names.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`).all(...names) as {name:string}[];
    expect(rows).toHaveLength(names.length);
  });
});
