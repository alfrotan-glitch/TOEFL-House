import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { signToken, verifyToken } from '../../../utils/auth.js';

describe('high-assurance security invariants', () => {
  it('issues and verifies a session-versioned token', () => {
    const token = signToken({ userId: 'u1', username: 'test', branchId: 'b1', fullName: 'Test' });
    expect(verifyToken(token)?.sessionVersion).toBe(1);
  });

  it('has high-assurance branch guards installed', () => {
    // Asserted by the PROPERTY the tables must have, not by trigger name. The
    // guarantee is "a cross-branch write to this table is refused by the
    // database on insert and on update"; which object provides it is a schema
    // detail, and pinning names here made a schema consolidation look like a
    // security regression when the guarantee was untouched.
    const guarded = ['enrollments', 'invoices', 'payments', 'book_sales', 'class_waitlist'];
    for (const table of guarded) {
      const triggers = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
        .all(table) as { name: string; sql: string }[];
      const branchGuards = triggers.filter((t) => /branch/i.test(t.sql) && /RAISE\(ABORT/i.test(t.sql));
      expect(branchGuards.some((t) => /BEFORE INSERT/i.test(t.sql)), `${table} insert guard`).toBe(true);
      // Book sales are immutable after creation, which is stronger than a
      // branch-correlation update guard: no update can move a sale anywhere.
      const updateGuards = table === 'book_sales'
        ? triggers.filter((t) => /RAISE\(ABORT/i.test(t.sql))
        : branchGuards;
      expect(updateGuards.some((t) => /BEFORE UPDATE/i.test(t.sql)), `${table} update guard`).toBe(true);
    }
  });
});
