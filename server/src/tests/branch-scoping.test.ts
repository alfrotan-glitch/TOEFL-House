/**
Integration test: Branch Scoping (Audit §6.3)
Verifies that resolveBranchScope locks branch-scoped users and only permits cross-branch access through explicit RBAC scope.
*/
import { describe, it, expect } from 'vitest';
import { resolveBranchScope } from '../middleware/auth.js';

function mockReq(role: string, branchId: string, queryBranchId?: string) {
  return {
    user: {
      userId: 'u1',
      username: 'test',
      role,
      branchId,
      fullName: 'Test User',
    },
    query: queryBranchId ? { branchId: queryBranchId } : {},
  } as any;
}

describe('Branch Scoping', () => {
  it('locks registrar to their own branch regardless of query param', () => {
    const scope = resolveBranchScope(mockReq('registrar', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('locks teacher to their own branch regardless of query param', () => {
    const scope = resolveBranchScope(mockReq('teacher', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('allows owner to request all branches', () => {
    const scope = resolveBranchScope(mockReq('owner', 'b1', 'all'));
    expect(scope.branchId).toBeNull();
    expect(scope.isAll).toBe(true);
  });

  it('denies a branch-scoped manager from requesting another branch', () => {
    const scope = resolveBranchScope(mockReq('manager', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('defaults to user branch when no query param is provided', () => {
    const scope = resolveBranchScope(mockReq('finance', 'b1'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('does not allow registrar to request all branches', () => {
    const scope = resolveBranchScope(mockReq('registrar', 'b1', 'all'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });
});