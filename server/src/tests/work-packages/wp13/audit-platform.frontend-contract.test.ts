import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('WP-13 frontend consumers share the canonical audit contract', () => {
  it('the audit workspace consumes shared camelCase types and the failures feed', () => {
    const source = read('src/components/audit/AuditLogView.tsx');
    expect(source).toContain("type { AuditFailure, AuditLog, PaginatedRows }");
    expect(source).toContain("api.get<PaginatedRows<AuditLog>>('/audit-logs'");
    expect(source).toContain("api.get<PaginatedRows<AuditFailure>>('/audit-logs/failures'");
    expect(source).toContain('log.operatorName');
    expect(source).toContain('log.branchId');
    expect(source).toContain('failure.occurredAt');
    expect(source).toContain('prettySnapshot(log.oldValue)');
    expect(source).not.toMatch(/operator_name|branch_id|old_value|new_value|occurred_at|request_id/);
  });

  it('shared types and the dashboard store use one paginated audit shape', () => {
    const types = read('src/types.ts');
    const store = read('src/apiStore.ts');
    expect(types).toContain('export interface AuditLog');
    expect(types).toContain('operatorRole: string | null;');
    expect(types).toContain('export interface AuditFailure');
    expect(types).toContain('occurredAt: string;');
    expect(types).toContain('export interface PaginatedRows<T>');
    expect(store).toContain("api.get<PaginatedRows<AuditLog>>('/audit-logs', { ...bq, limit: '50' }).then((page) => setAuditLogs(page.rows))");
  });
});
