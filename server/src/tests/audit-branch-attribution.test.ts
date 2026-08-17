/**
 * Audit events must be filed against the branch they HAPPENED IN.
 * ============================================================================
 * DEFECT CLASS: branch misattribution in cross-branch operations.
 *
 * Owners and managers act across branches. The target branch travels in the
 * request (body `branchId`, or an explicit `?branchId=`), while the JWT keeps
 * carrying the operator's own home branch. `writeAudit` fell straight back to
 * `user.branchId`, so a student created in West Branch produced an audit row
 * stamped with the operator's Main Branch.
 *
 * Reproduced against the live API before the fix: two students were created in
 * West Branch, and `GET /api/audit-logs?branchId=<west>` returned them under
 * Main Branch instead — the branch's own audit trail was wrong, and only 5 of
 * 213 writeAudit call sites passed an explicit branchId.
 *
 * The fix resolves the target branch centrally in writeAudit, and only when the
 * caller is authorized for it, so attribution cannot be forged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Request } from 'express';
import { writeAudit } from '../middleware/audit.js';
import { db } from '../db/connection.js';

/** A request shaped like the ones Express hands the route handlers. */
function fakeRequest(over: Partial<Request> & { user?: unknown }): Request {
  return {
    body: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...over,
  } as unknown as Request;
}

const OWNER = { userId: 'u_owner', username: 'owner', fullName: 'Owner', role: 'owner' as const, branchId: 'home_branch' };

function lastAuditBranch(action: string): string | null {
  const row = db.prepare('SELECT branch_id FROM audit_logs WHERE action = ? ORDER BY rowid DESC LIMIT 1')
    .get(action) as { branch_id: string | null } | undefined;
  return row ? row.branch_id : null;
}

beforeAll(() => {
  db.prepare("INSERT OR IGNORE INTO branches (id, name, code, is_active) VALUES ('home_branch','Home','H-1',1)").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name, code, is_active) VALUES ('west_branch','West','W-1',1)").run();
});

describe('audit rows are attributed to the branch the action targets', () => {
  it('uses the target branch from the request body, not the operator home branch', () => {
    const action = `test-body-branch-${Date.now()}`;
    writeAudit(fakeRequest({ user: OWNER, body: { branchId: 'west_branch' } }), action);
    // The event happened in West Branch; filing it under the operator's home
    // branch makes West Branch's audit trail silently incomplete.
    expect(lastAuditBranch(action)).toBe('west_branch');
  });

  it('uses an explicit ?branchId= query when present', () => {
    const action = `test-query-branch-${Date.now()}`;
    writeAudit(fakeRequest({ user: OWNER, query: { branchId: 'west_branch' } as never }), action);
    expect(lastAuditBranch(action)).toBe('west_branch');
  });

  it('falls back to the operator branch when the request names no branch', () => {
    const action = `test-fallback-${Date.now()}`;
    writeAudit(fakeRequest({ user: OWNER }), action);
    expect(lastAuditBranch(action)).toBe('home_branch');
  });

  it('an explicit opts.branchId still wins over the request', () => {
    const action = `test-explicit-wins-${Date.now()}`;
    writeAudit(fakeRequest({ user: OWNER, body: { branchId: 'west_branch' } }), action, { branchId: 'home_branch' });
    expect(lastAuditBranch(action)).toBe('home_branch');
  });

  it('ignores branchId=all rather than storing it as a branch', () => {
    const action = `test-all-${Date.now()}`;
    writeAudit(fakeRequest({ user: OWNER, query: { branchId: 'all' } as never }), action);
    // 'all' is a scope selector, not a branch id.
    expect(lastAuditBranch(action)).toBe('home_branch');
  });

  it('does not let an unauthorized branch forge attribution', () => {
    const action = `test-forge-${Date.now()}`;
    const registrar = { userId: 'u_reg', username: 'reg', fullName: 'Reg', role: 'registrar' as const, branchId: 'home_branch' };
    writeAudit(fakeRequest({ user: registrar, body: { branchId: 'west_branch' } }), action);
    // A branch-scoped user cannot file events against a branch they cannot access.
    expect(lastAuditBranch(action)).toBe('home_branch');
  });
});
